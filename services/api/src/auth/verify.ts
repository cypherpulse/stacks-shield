// =============================================================================
// STX Shield API -- Stacks message-signature verification
// =============================================================================
// Verifies that `signature` over `message` was produced by the private key
// behind `publicKey`, AND that `publicKey` corresponds to the claimed wallet
// address. No email/password/OAuth -- wallet ownership is the only credential.

import { verifyMessageSignatureRsv } from "@stacks/encryption";
import { getAddressFromPublicKey } from "@stacks/transactions";
import { config } from "../config.js";

export interface SignatureCheck {
  message: string;
  signature: string;
  publicKey: string;
  wallet: string;
}

/** True iff the signature is valid AND the public key maps to `wallet`. */
export const verifyWalletSignature = (c: SignatureCheck): boolean => {
  let derived: string;
  try {
    derived = getAddressFromPublicKey(c.publicKey, config.network);
  } catch {
    return false;
  }
  if (derived !== c.wallet) return false;

  try {
    return verifyMessageSignatureRsv({
      message: c.message,
      signature: c.signature,
      publicKey: c.publicKey,
    });
  } catch {
    return false;
  }
};
