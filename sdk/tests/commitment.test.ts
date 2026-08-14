// =============================================================================
// @stx-shield/sdk -- Phase 3: asset-aware commitment tests
// =============================================================================
// Verifies the SDK commitment matches the deployed circuits:
//   native  = Poseidon4(amount, pkX, pkY, blinding)                 (unchanged)
//   SIP-10  = Poseidon2(Poseidon4(...), assetField)                 (asset-bound)
// asset_id = 777 mirrors zk/circuits/sip10/*/src/main.nr test vectors.

import { describe, it, expect } from "vitest";
import { poseidon2, poseidon4 } from "poseidon-lite";
import { commitmentOf, assetFieldOf, ownerCommitmentOf, nullifierOf } from "../src/crypto/commitments.js";
import { fePrincipal, bytesToBig } from "../src/crypto/field.js";

const SBTC = "ST1F7QA2MDF17S807EPA36TSS8AMEFY4KA9TVGWXT.sbtc-token";
const USDCX = "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.usdcx";
const base = { amount: 100n, ownerPkX: 1n, ownerPkY: 2n, blinding: 7n };

describe("asset-aware commitments", () => {
  it("native STX commitment is unchanged (Poseidon4)", () => {
    expect(commitmentOf(base)).toBe(BigInt(poseidon4([100n, 1n, 2n, 7n])));
    // assetField 0/undefined both take the native path
    expect(commitmentOf({ ...base, assetField: 0n })).toBe(commitmentOf(base));
  });

  it("SIP-10 commitment = Poseidon2(Poseidon4(...), assetField) — matches the circuit", () => {
    const assetField = 777n; // matches the circuit unit-test asset_id
    const inner = BigInt(poseidon4([100n, 1n, 2n, 7n]));
    expect(commitmentOf({ ...base, assetField })).toBe(BigInt(poseidon2([inner, assetField])));
  });

  it("assetFieldOf(token) equals fePrincipal(token)", () => {
    expect(assetFieldOf(SBTC)).toBe(bytesToBig(fePrincipal(SBTC)));
  });

  it("binds the asset: STX, sBTC and USDCx commitments all differ", () => {
    const stx = commitmentOf(base);
    const sbtc = commitmentOf({ ...base, assetField: assetFieldOf(SBTC) });
    const usdcx = commitmentOf({ ...base, assetField: assetFieldOf(USDCX) });
    expect(new Set([stx, sbtc, usdcx].map(String)).size).toBe(3);
  });

  it("owner commitment is asset-agnostic; nullifier is asset-distinct via the commitment", () => {
    expect(ownerCommitmentOf(base)).toBe(BigInt(poseidon2([1n, 2n])));
    const cSbtc = commitmentOf({ ...base, assetField: assetFieldOf(SBTC) });
    const cStx = commitmentOf(base);
    expect(nullifierOf(cSbtc, 9n)).not.toBe(nullifierOf(cStx, 9n));
  });
});
