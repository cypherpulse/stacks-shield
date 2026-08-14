// =============================================================================
// STX Shield relayer -- service
// =============================================================================
// Wires validation, queueing, and submission together. The API layer is a thin
// shell over this; the worker is its `run` method.

import { FeeManager, DEFAULT_POLICY, type FeePolicy } from "../fee-manager/index.js";
import { NodeReader, ProofValidator, type ChainReader } from "../proof-validator/index.js";
import { MemoryQueue, type QueueDriver } from "../queue/index.js";
import { TransactionManager, type TxManagerConfig } from "../transaction-manager/index.js";
import { metrics, M } from "../metrics/index.js";
import {
  RelayError,
  SCHEMAS,
  type Operation,
  type RelayAccepted,
  type RelayJob,
  type RelayRequest,
  type RelayerInfo,
} from "../types/index.js";

export interface RelayerServiceConfig extends TxManagerConfig {
  queue?: QueueDriver;
  reader?: ChainReader;
  policy?: FeePolicy;
  /** Submitter used in tests to avoid touching a real chain. */
  submitter?: (op: Operation, r: RelayRequest) => Promise<string>;
}

export class RelayerService {
  readonly queue: QueueDriver;
  private readonly validator: ProofValidator;
  private readonly fees: FeeManager;
  private readonly txm: TransactionManager;
  private readonly cfg: RelayerServiceConfig;
  private readonly submit: (op: Operation, r: RelayRequest) => Promise<string>;
  private accepting = true;

  constructor(cfg: RelayerServiceConfig) {
    this.cfg = cfg;
    this.queue = cfg.queue ?? new MemoryQueue();
    this.validator = new ProofValidator(
      cfg.reader ?? new NodeReader(cfg.apiUrl, cfg.deployer),
    );
    this.fees = new FeeManager(cfg.policy ?? DEFAULT_POLICY);
    this.txm = new TransactionManager(cfg);
    this.submit = cfg.submitter ?? ((op, r) => this.txm.submit(op, r));
    this.queue.process((job) => this.run(job));
  }

  /** The shared transaction manager (ops + root publication share its nonce). */
  get transactionManager(): TransactionManager {
    return this.txm;
  }

  /** Readiness snapshot for GET /ready. */
  async ready(): Promise<{ ready: boolean; accepting: boolean; queue: string; fundedMicroStx?: string }> {
    if (this.cfg.submitter) return { ready: this.accepting, accepting: this.accepting, queue: this.queue.name };
    let funded = 0n;
    try {
      funded = await this.txm.balance();
    } catch {
      /* ignore */
    }
    metrics.set(M.relayerBalanceMicroStx, Number(funded));
    return {
      ready: this.accepting && funded > 0n,
      accepting: this.accepting,
      queue: this.queue.name,
      fundedMicroStx: funded.toString(),
    };
  }

  info(): RelayerInfo {
    return {
      address: this.cfg.address,
      network: this.cfg.network,
      operations: ["transfer", "withdraw", "split", "merge"],
      relayFeeMicroStx: String(this.fees.txFee),
      minRelayFeeMicroStx: String(this.fees.txFee),
      accepting: this.accepting,
      contracts: {
        pool: `${this.cfg.deployer}.privacy-pool`,
        splitMerge: `${this.cfg.deployer}.split-merge-manager`,
        verifier: `${this.cfg.deployer}.zk-verifier`,
        sip10Pool: `${this.cfg.deployer}.sip10-pool`,
        sip10Verifier: `${this.cfg.deployer}.sip10-zk-verifier`,
      },
    };
  }

  setAccepting(v: boolean): void {
    this.accepting = v;
  }

  /**
   * Accept an operation: validate the shape, validate it against chain state,
   * then queue it. Rejecting here is cheap; rejecting after broadcast costs
   * the relayer a fee.
   */
  async accept(
    operation: Operation,
    body: unknown,
    clientKey = "anonymous",
  ): Promise<RelayAccepted> {
    if (!this.accepting) {
      throw new RelayError("not_accepting", "relayer is not accepting work", 503);
    }
    const schema = SCHEMAS[operation];
    if (!schema) throw new RelayError("unknown_operation", `unknown operation ${operation}`, 404);

    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new RelayError("invalid_request", parsed.error.issues[0]?.message ?? "invalid", 400);
    }
    const request = parsed.data as RelayRequest;

    this.fees.assertWithinRate(clientKey);
    if (!this.cfg.submitter) this.fees.assertFunded(await this.txm.balance());
    await this.validator.validate(operation, request);

    const job = await this.queue.add(operation, request);
    metrics.inc(M.jobsAccepted);
    return { jobId: job.id, operation, state: job.state };
  }

  /** Worker body: submit, then track to confirmation. */
  async run(job: RelayJob): Promise<void> {
    await this.queue.update(job.id, { state: "submitting" });
    const txid = await this.submit(job.operation, job.request);
    metrics.inc(M.txSubmitted);
    await this.queue.update(job.id, { txid });

    if (this.cfg.submitter) {
      await this.queue.update(job.id, { state: "confirmed" });
      metrics.inc(M.jobsConfirmed);
      return;
    }
    const status = await this.txm.waitForConfirmation(txid);
    await this.queue.update(job.id, {
      state: status === "success" ? "confirmed" : "failed",
      error: status === "success" ? undefined : "transaction aborted on chain",
    });
    metrics.inc(status === "success" ? M.jobsConfirmed : M.jobsFailed);
  }

  status(jobId: string): Promise<RelayJob | undefined> {
    return this.queue.get(jobId);
  }
}
