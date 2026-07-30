// =============================================================================
// STX Shield API -- authentication message + nonce
// =============================================================================

import { randomBytes } from "node:crypto";

/** A fresh 32-byte hex nonce. */
export const generateNonce = (): string => randomBytes(32).toString("hex");

/**
 * The canonical message a wallet signs to authenticate. It is deterministic in
 * (wallet, nonce, dateISO) so the server can reconstruct and verify it exactly.
 */
export const buildAuthMessage = (wallet: string, nonce: string, dateISO: string): string =>
  [
    "Sign this message to authenticate with STX Shield.",
    "",
    "Wallet:",
    wallet,
    "",
    "Nonce:",
    nonce,
    "",
    "Timestamp:",
    dateISO,
  ].join("\n");
