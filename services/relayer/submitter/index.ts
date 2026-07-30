// =============================================================================
// STX Shield relayer -- zkVerify proof submitter (POST /submit backend)
// =============================================================================
// Accepts a bb.js UltraHonk proof from the SDK, submits it to zkVerify (Volta,
// V3_0 / ZK) from the relayer's funded account, waits for the aggregation, and
// returns the aggregation inclusion the contracts re-check. This is the
// browser-safe alternative to shipping a zkVerify seed to end users.
//
// Security:
//   - The zkVerify variant/version are hard-coded here, never taken from the
//     caller.
//   - Submissions are serialized so the account's nonce sequence stays clean.
//   - The account seed lives only in the relayer's env; it is never returned.

import type { RelayerConfig } from "../config/index.js";
import type { TransactionManager } from "../transaction-manager/index.js";
import { publishRoot } from "../root-publisher/publish-root.js";

export interface SubmitRequest {
  proof: string;
  publicInputs: string[];
  vk: string;
  domainId?: number;
}

export interface Inclusion {
  domainId: number;
  aggregationId: number;
  root: string;
  leafCount: number;
  merklePath: string[];
  leafIndex: number;
}

type Logger = { info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void };

/* eslint-disable @typescript-eslint/no-explicit-any */
export class ProofSubmitter {
  private sessionP?: Promise<any>;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly cfg: RelayerConfig,
    private readonly log: Logger,
    private readonly timeoutMs = 300_000,
    // When provided, /submit publishes the aggregation root itself (idempotently)
    // instead of waiting for the background poller — so the exact aggregation a
    // user just proved into is guaranteed to reach the chain.
    private readonly txm?: TransactionManager,
  ) {}

  /** Whether the relayer holds the zkVerify account needed to submit. */
  isConfigured(): boolean {
    return Boolean(this.cfg.zkVerifySeed);
  }

  /** The domain the caller asked for, clamped to a domain this relayer serves. */
  private pickDomain(d?: number): number {
    const allowed = this.cfg.zkVerifyDomainIds;
    if (d != null && allowed.includes(d)) return d;
    return allowed[0] ?? 0;
  }

  private async session(): Promise<any> {
    if (!this.sessionP) {
      this.sessionP = (async () => {
        const zk = await import("zkverifyjs");
        const start = zk.zkVerifySession.start() as any;
        // Use the custom API endpoint only when ZKVERIFY_USE_API is on.
        const ep = this.cfg.zkVerifyUseApi ? this.cfg.zkVerifyEndpoint : undefined;
        const builder = ep ? start.Custom({ websocket: ep }) : start.Volta();
        return builder.withAccount(this.cfg.zkVerifySeed);
      })().catch((e) => {
        // Reset so a later request can retry a fresh session.
        this.sessionP = undefined;
        throw e;
      });
    }
    return this.sessionP;
  }

  /** Submit a proof and resolve once it is included in a finalized aggregation. */
  async submit(req: SubmitRequest): Promise<Inclusion> {
    if (!this.isConfigured()) {
      throw new Error("zkVerify submitter is not configured (no account seed)");
    }
    const domainId = this.pickDomain(req.domainId);
    // Serialize: one in-flight submission per account keeps the nonce clean.
    const run = this.chain.then(() => this.doSubmit(req, domainId));
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async doSubmit(req: SubmitRequest, domainId: number): Promise<Inclusion> {
    const zk = await import("zkverifyjs");
    const session = await this.session();

    const { transactionResult } = await session
      .verify()
      .ultrahonk({ version: zk.UltrahonkVersion.V3_0, variant: zk.UltrahonkVariant.ZK })
      .execute({
        proofData: { proof: req.proof, publicSignals: req.publicInputs, vk: req.vk },
        domainId,
      });

    const sub = await transactionResult;
    const aggregationId = Number(sub.aggregationId);
    const receipt = await session.waitForAggregationReceipt(domainId, aggregationId, this.timeoutMs);
    const path = await session.getAggregateStatementPath(
      receipt.blockHash,
      domainId,
      aggregationId,
      sub.statement ?? "",
    );

    this.log.info({ domainId, aggregationId, leafIndex: path.leafIndex }, "zkVerify: proof aggregated");

    // Publish this aggregation's root on-chain now (idempotent). This is what
    // the operation references, so doing it here guarantees it lands even if the
    // background poller is behind or its connection dropped.
    if (this.txm) {
      try {
        const res = await publishRoot(this.txm, this.cfg.apiUrl, this.cfg.deployer, {
          domainId,
          aggregationId,
          root: path.root,
          leafCount: path.numberOfLeaves,
        });
        if (res.published) this.log.info({ aggregationId, txid: res.txid }, "zkVerify: root published");
      } catch (e) {
        // Non-fatal: the poller (or a retry) can still publish it.
        this.log.warn({ aggregationId, err: String(e) }, "zkVerify: root publish from /submit failed");
      }
    }

    return {
      domainId,
      aggregationId,
      root: path.root,
      leafCount: path.numberOfLeaves,
      merklePath: path.proof,
      leafIndex: path.leafIndex,
    };
  }

  async stop(): Promise<void> {
    if (!this.sessionP) return;
    const s = await this.sessionP.catch(() => null);
    await s?.close?.().catch(() => {});
  }
}
