// =============================================================================
// STX Shield -- post-deployment verification script
// =============================================================================
// Reads on-chain state after deploy + wire and asserts the protocol is
// correctly configured before it is opened to users. Fails loudly on any
// mismatch. Run against testnet before every mainnet deploy, and against
// mainnet immediately after wiring.
//
// Checks:
//   - all six contracts are deployed
//   - the three protocol callers are authorized in the registry
//   - the current root is the genesis root (tree bootstrapped, not zero)
//   - a vkey is registered and enabled for each of the five proof types
//   - the committee size >= threshold and threshold matches config
//   - protocol state is ACTIVE
//   - ownership is the intended owner
//
// Usage: ts-node deployment/verify.ts <network>

import {
  AUTHORIZED_CALLERS,
  CIRCUITS,
  NETWORKS,
  CONTRACT_ORDER,
  type Network,
} from "./config.js";

export interface ReadOnlyClient {
  read(contract: string, fn: string, args: unknown[]): Promise<unknown>;
  isContractDeployed(contract: string): Promise<boolean>;
}

export interface VerifyResult {
  readonly ok: boolean;
  readonly checks: readonly { name: string; ok: boolean; detail?: string }[];
}

export async function verifyDeployment(
  network: Network,
  client: ReadOnlyClient,
): Promise<VerifyResult> {
  const cfg = NETWORKS[network];
  const checks: { name: string; ok: boolean; detail?: string }[] = [];
  const check = (name: string, ok: boolean, detail?: string) =>
    checks.push({ name, ok, detail });

  // contracts deployed
  for (const c of CONTRACT_ORDER) {
    check(`deployed:${c}`, await client.isContractDeployed(c));
  }

  // authorized callers
  for (const caller of AUTHORIZED_CALLERS) {
    const authed = (await client.read("privacy-registry", "is-authorized-caller", [
      caller,
    ])) as boolean;
    check(`authorized:${caller}`, authed === true);
  }

  // tree bootstrapped (current root == genesis, not the zero root)
  const root = (await client.read("privacy-registry", "get-current-root", [])) as {
    root: string;
  };
  check(
    "root:bootstrapped",
    root.root.toLowerCase() === cfg.genesisRootHex.toLowerCase(),
    `root=${root.root}`,
  );

  // vkeys for every circuit
  for (const circuit of CIRCUITS) {
    const vk = (await client.read("zk-verifier", "get-verification-key", [
      circuit.proofType,
      1,
    ])) as { enabled: boolean } | null;
    check(`vkey:${circuit.name}`, vk?.enabled === true);
  }

  // committee + threshold
  const count = Number(await client.read("zk-verifier", "get-attestor-count", []));
  const threshold = Number(await client.read("zk-verifier", "get-attestation-threshold", []));
  check("committee:size", count >= cfg.attestationThreshold, `count=${count}`);
  check(
    "committee:threshold",
    threshold === cfg.attestationThreshold,
    `threshold=${threshold}`,
  );

  // protocol ACTIVE
  const state = Number(await client.read("privacy-registry", "get-protocol-state", []));
  check("protocol:active", state === 1, `state=${state}`);

  // ownership (if a final owner is configured)
  if (cfg.finalOwner) {
    const owner = (await client.read("privacy-registry", "get-owner", [])) as string;
    check("owner:final", owner === cfg.finalOwner, `owner=${owner}`);
  }

  return { ok: checks.every((c) => c.ok), checks };
}
