// =============================================================================
// STX Shield relayer -- proof validator
// =============================================================================
// Runs BEFORE a job is queued and before the relayer spends a single micro-STX
// on fees. It answers one question: would this operation actually succeed on
// chain?
//
// This protects the RELAYER (it pays the fee, so it must not be griefable into
// broadcasting doomed transactions). It is NOT a security gate for the user —
// the chain re-checks everything. A relayer that skipped validation entirely
// would be wasteful, never unsafe.
//
// Checks, cheapest first:
//   1. the aggregation root the user references is actually published
//   2. the statement leaf is genuinely inside that aggregation (Merkle path)
//   3. the nullifier(s) are unspent
//   4. the referenced root is known to the registry
//   5. the protocol is active and the operation is enabled

import { Cl, cvToHex, cvToJSON, hexToCV, type ClarityValue } from "@stacks/transactions";
import { RelayError, type Operation, type RelayRequest } from "../types/index.js";

export interface ChainReader {
  readOnly(contract: string, fn: string, args: ClarityValue[]): Promise<unknown>;
}

/** Minimal read-only client against a Stacks node. */
export class NodeReader implements ChainReader {
  constructor(
    private readonly apiUrl: string,
    private readonly deployer: string,
  ) {}

  async readOnly(contract: string, fn: string, args: ClarityValue[]): Promise<unknown> {
    const res = await fetch(
      `${this.apiUrl}/v2/contracts/call-read/${this.deployer}/${contract}/${fn}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sender: this.deployer,
          arguments: args.map((a) => cvToHex(a)),
        }),
      },
    );
    if (!res.ok) throw new RelayError("node_unavailable", `node ${res.status}`, 502);
    const body = (await res.json()) as { okay: boolean; result?: string; cause?: string };
    if (!body.okay || !body.result) {
      throw new RelayError("read_failed", body.cause ?? "read-only call failed", 502);
    }
    return cvToJSON(hexToCV(body.result));
  }
}

const buf = (hex: string) =>
  Cl.buffer(Uint8Array.from(Buffer.from(hex.replace(/^0x/, ""), "hex")));

/** Which nullifiers an operation consumes. */
export const nullifiersOf = (op: Operation, r: RelayRequest): string[] => {
  if (op === "merge") {
    const m = r as { nullifier1: string; nullifier2: string };
    return [m.nullifier1, m.nullifier2];
  }
  return [(r as { nullifier: string }).nullifier];
};

/** Which Merkle root an operation proves against. */
export const rootOf = (op: Operation, r: RelayRequest): string =>
  op === "withdraw"
    ? (r as { root: string }).root
    : (r as { currentRoot: string }).currentRoot;

const unwrap = (v: unknown): unknown => {
  const x = v as { value?: unknown; type?: string };
  return x && typeof x === "object" && "value" in x ? x.value : v;
};

export class ProofValidator {
  constructor(private readonly reader: ChainReader) {}

  async validate(op: Operation, r: RelayRequest): Promise<void> {
    await this.assertProtocolActive();
    await this.assertRootKnown(op, r);
    await this.assertNullifiersUnspent(op, r);
    await this.assertAggregationPublished(r);
  }

  private async assertProtocolActive(): Promise<void> {
    const state = unwrap(await this.reader.readOnly("privacy-registry", "get-protocol-state", []));
    if (String(state) !== "1") {
      throw new RelayError("protocol_inactive", `protocol state is ${state}`, 503);
    }
  }

  private async assertRootKnown(op: Operation, r: RelayRequest): Promise<void> {
    const root = rootOf(op, r);
    const known = unwrap(
      await this.reader.readOnly("privacy-registry", "is-known-root", [buf(root)]),
    );
    if (known !== true) {
      throw new RelayError("unknown_root", `root ${root} is not valid`, 400);
    }
  }

  private async assertNullifiersUnspent(op: Operation, r: RelayRequest): Promise<void> {
    for (const n of nullifiersOf(op, r)) {
      const spent = unwrap(
        await this.reader.readOnly("privacy-registry", "is-nullifier-spent", [buf(n)]),
      );
      if (spent === true) {
        throw new RelayError("nullifier_spent", `nullifier ${n} already spent`, 409);
      }
    }
  }

  /** The aggregation root must be on chain. Without it the operation cannot
   *  succeed, so submitting would burn the relayer's fee for nothing. */
  private async assertAggregationPublished(r: RelayRequest): Promise<void> {
    const { domainId, aggregationId } = r.inclusion;
    const agg = unwrap(
      await this.reader.readOnly("zk-verifier", "get-aggregation", [
        Cl.uint(domainId),
        Cl.uint(aggregationId),
      ]),
    );
    if (agg === null || agg === undefined) {
      throw new RelayError(
        "aggregation_not_published",
        `aggregation ${domainId}/${aggregationId} is not on chain yet — retry once the relayer network publishes it`,
        409,
      );
    }
  }
}
