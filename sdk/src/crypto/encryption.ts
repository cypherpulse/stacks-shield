// =============================================================================
// @stx-shield/sdk -- note encryption (re-export of the proven scheme)
// =============================================================================
// X25519 ECDH + XChaCha20-Poly1305, with viewing keys separate from spending
// keys. A note's contents (amount, blinding, owner secret) are encrypted to the
// owner's viewing key and stored as opaque ciphertext by the API; the owner
// trial-decrypts to recover spendable notes. The server never learns amounts.

export {
  NOTE_PAYLOAD_VERSION,
  generateViewingKeyPair,
  encryptNote,
  tryDecryptNote,
  encodeEncryptedNote,
  decodeEncryptedNote,
  toHex,
  fromHex as bytesFromHex,
} from "../../encryption/index.js";
export type { NotePayload, ViewingKeyPair, EncryptedNote } from "../../encryption/index.js";
