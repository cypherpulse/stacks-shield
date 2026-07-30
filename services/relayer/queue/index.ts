// =============================================================================
// STX Shield relayer -- job queue
// =============================================================================
// BullMQ/Redis in production; an in-process driver for tests and single-node
// deployments. The driver interface is deliberately tiny so the workers never
// know which one they are running on.

import type { Operation, RelayJob, RelayRequest, JobState } from "../types/index.js";
import { metrics, M } from "../metrics/index.js";

export interface QueueDriver {
  add(operation: Operation, request: RelayRequest): Promise<RelayJob>;
  get(id: string): Promise<RelayJob | undefined>;
  update(id: string, patch: Partial<RelayJob>): Promise<void>;
  /** Register the processor. Called once at startup. */
  process(handler: (job: RelayJob) => Promise<void>): void;
  /** Jobs that exhausted all retries (the dead-letter queue). */
  deadLetter(): Promise<RelayJob[]>;
  close(): Promise<void>;
  readonly name: string;
}

const newJob = (operation: Operation, request: RelayRequest): RelayJob => ({
  id: `${operation}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
  operation,
  request,
  state: "queued",
  attempts: 0,
  createdAt: Date.now(),
  updatedAt: Date.now(),
});

/**
 * In-memory driver. Jobs are processed sequentially with bounded retries.
 * Suitable for a single relayer node and for tests; state is lost on restart,
 * which is acceptable because an unsubmitted job costs the user nothing — they
 * simply resubmit, to this relayer or another.
 */
export class MemoryQueue implements QueueDriver {
  readonly name = "memory";
  private readonly jobs = new Map<string, RelayJob>();
  private readonly pending: string[] = [];
  private readonly dead: string[] = [];
  private handler?: (job: RelayJob) => Promise<void>;
  private draining = false;
  private closed = false;

  constructor(private readonly maxAttempts = 3) {}

  async deadLetter(): Promise<RelayJob[]> {
    return this.dead.map((id) => this.jobs.get(id)).filter((j): j is RelayJob => !!j);
  }

  async add(operation: Operation, request: RelayRequest): Promise<RelayJob> {
    const job = newJob(operation, request);
    this.jobs.set(job.id, job);
    this.pending.push(job.id);
    void this.drain();
    return job;
  }

  async get(id: string): Promise<RelayJob | undefined> {
    return this.jobs.get(id);
  }

  async update(id: string, patch: Partial<RelayJob>): Promise<void> {
    const job = this.jobs.get(id);
    if (job) this.jobs.set(id, { ...job, ...patch, updatedAt: Date.now() });
  }

  process(handler: (job: RelayJob) => Promise<void>): void {
    this.handler = handler;
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.draining || !this.handler || this.closed) return;
    this.draining = true;
    try {
      while (this.pending.length > 0 && !this.closed) {
        const id = this.pending.shift()!;
        const job = this.jobs.get(id);
        if (!job) continue;
        try {
          await this.handler(job);
        } catch (e) {
          const current = this.jobs.get(id)!;
          const attempts = current.attempts + 1;
          if (attempts < this.maxAttempts) {
            await this.update(id, { attempts, state: "queued" });
            this.pending.push(id);
          } else {
            await this.update(id, {
              attempts,
              state: "failed" as JobState,
              error: e instanceof Error ? e.message : String(e),
            });
            this.dead.push(id);
            metrics.inc(M.jobsDeadLettered);
          }
        }
      }
    } finally {
      this.draining = false;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

/**
 * BullMQ driver. Lazily imports bullmq/ioredis so the relayer runs without
 * Redis when configured for the memory driver.
 */
export const createBullQueue = async (redisUrl: string): Promise<QueueDriver> => {
  const { Queue, Worker } = (await import("bullmq")) as typeof import("bullmq");
  const IORedis = (await import("ioredis")).default;
  // Build a real ioredis connection from the URL STRING (ioredis has no `url`
  // option key -- passing an object with `url` silently connects to localhost).
  // The string form lets ioredis enable TLS for `rediss://` (e.g. Upstash), and
  // BullMQ's blocking (Worker) connection requires maxRetriesPerRequest: null.
  // Queue and Worker get separate connections so blocking calls can't stall the
  // queue's own commands.
  const makeConn = () =>
    new IORedis(redisUrl, { maxRetriesPerRequest: null, enableReadyCheck: false });
  const connection = makeConn();
  const queue = new Queue("stx-shield-relay", { connection: connection as never });
  const jobs = new Map<string, RelayJob>();

  return {
    name: "bullmq",
    async deadLetter() {
      // BullMQ retains failed jobs (removeOnFail: 1000) -- surface them as the DLQ.
      const failed = await queue.getFailed(0, 1000);
      return failed.map((j) => j.data as RelayJob).filter(Boolean);
    },
    async add(operation, request) {
      const job = newJob(operation, request);
      jobs.set(job.id, job);
      await queue.add(operation, job, {
        jobId: job.id,
        attempts: 3,
        backoff: { type: "exponential", delay: 5_000 },
        removeOnComplete: 1_000,
        removeOnFail: 1_000,
      });
      return job;
    },
    async get(id) {
      return jobs.get(id);
    },
    async update(id, patch) {
      const job = jobs.get(id);
      if (job) jobs.set(id, { ...job, ...patch, updatedAt: Date.now() });
    },
    process(handler) {
      new Worker(
        "stx-shield-relay",
        async (j) => {
          const job = j.data as RelayJob;
          jobs.set(job.id, job);
          await handler(job);
        },
        { connection: makeConn() as never },
      );
    },
    async close() {
      await queue.close();
    },
  };
};
