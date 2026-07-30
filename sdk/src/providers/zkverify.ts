// =============================================================================
// @stx-shield/sdk -- zkVerify submitter
// =============================================================================
// Submits a RawProof to zkVerify V3_0 (UltraHonk, ZK variant) and returns the
// aggregation inclusion the contracts re-check. zkverifyjs is imported lazily so
// it is never bundled unless proving is actually used.
//
// NOTE: submitting to zkVerify requires a funded zkVerify (Volta) account. For a
// smooth end-user experience, production apps should route proofs through a
// hosted submitter rather than asking each user to hold a zkVerify account; set
// `endpointUrl` to that service, or provide `seed` for direct submission
// (development / server-side).

import { ProofGenerationError } from "../errors/index.js";
import type { Inclusion, ProofSubmitter, RawProof } from "../proving/engine.js";
import type { Logger } from "../utils/logger.js";

export interface ZkVerifyOptions {
  /** Seed phrase for direct submission (dev/server). Omit to use a hosted submitter. */
  seed?: string;
  /** Hosted submitter URL that accepts { proof, publicSignals, vk } and returns an Inclusion. */
  endpointUrl?: string;
  /** Aggregation domain (protocol default 0). */
  domainId: number;
  logger: Logger;
}

export class ZkVerifySubmitter implements ProofSubmitter {
  constructor(private readonly opts: ZkVerifyOptions) {}

  async submit(proof: RawProof): Promise<Inclusion> {
    if (this.opts.endpointUrl) return this.submitViaService(proof);
    if (this.opts.seed) return this.submitDirect(proof);
    throw new ProofGenerationError(
      "No zkVerify submission path configured. Set `zkVerify.endpointUrl` (hosted submitter, recommended) " +
        "or `zkVerify.seed` (direct submission, dev/server).",
    );
  }

  /** POST the proof to a hosted submitter that returns the inclusion. */
  private async submitViaService(proof: RawProof): Promise<Inclusion> {
    const res = await fetch(`${this.opts.endpointUrl}/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...proof, domainId: this.opts.domainId }),
    });
    if (!res.ok) throw new ProofGenerationError(`zkVerify submitter -> ${res.status}`);
    return (await res.json()) as Inclusion;
  }

  /** Submit directly to zkVerify Volta and wait for aggregation. */
  private async submitDirect(proof: RawProof): Promise<Inclusion> {
    const zk = await import("zkverifyjs");
    const session = await zk.zkVerifySession.start().Volta().withAccount(this.opts.seed!);
    try {
      const { transactionResult } = await session
        .verify()
        .ultrahonk({ version: zk.UltrahonkVersion.V3_0, variant: zk.UltrahonkVariant.ZK })
        .execute({ proofData: { proof: proof.proof, publicSignals: proof.publicInputs, vk: proof.vk }, domainId: this.opts.domainId });
      const sub = await transactionResult;
      const aggregationId = Number(sub.aggregationId);
      const receipt = await session.waitForAggregationReceipt(this.opts.domainId, aggregationId, 480_000);
      const path = await session.getAggregateStatementPath(receipt.blockHash, this.opts.domainId, aggregationId, sub.statement ?? "");
      return {
        domainId: this.opts.domainId,
        aggregationId,
        root: path.root,
        leafCount: path.numberOfLeaves,
        merklePath: path.proof,
        leafIndex: path.leafIndex,
      };
    } finally {
      await session.close().catch(() => {});
    }
  }
}
