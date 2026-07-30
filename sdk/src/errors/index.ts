// =============================================================================
// @stx-shield/sdk -- typed errors
// =============================================================================
// Every error thrown by the SDK is an instance of STXShieldError, so callers
// can catch broadly or narrowly:
//
//   try { await shield.withdraw(note); }
//   catch (e) {
//     if (e instanceof InvalidNoteError) { ... }
//     else if (e instanceof STXShieldError) { ... }
//   }

export class STXShieldError extends Error {
  readonly code: string;
  readonly cause?: unknown;
  constructor(code: string, message: string, cause?: unknown) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.cause = cause;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** The note is malformed, already spent, or not owned by this wallet. */
export class InvalidNoteError extends STXShieldError {
  constructor(message: string, cause?: unknown) {
    super("INVALID_NOTE", message, cause);
  }
}

/** The referenced Merkle root is not (yet) known to the protocol. */
export class RootNotFoundError extends STXShieldError {
  constructor(message: string, cause?: unknown) {
    super("ROOT_NOT_FOUND", message, cause);
  }
}

/** Proof generation failed (bad witness, engine unavailable, ...). */
export class ProofGenerationError extends STXShieldError {
  constructor(message: string, cause?: unknown) {
    super("PROOF_GENERATION_FAILED", message, cause);
  }
}

/** A relayer rejected or failed the operation. */
export class RelayerError extends STXShieldError {
  readonly relayerCode?: string;
  constructor(message: string, relayerCode?: string, cause?: unknown) {
    super("RELAYER_ERROR", message, cause);
    this.relayerCode = relayerCode;
  }
}

/** Wallet authentication failed (bad signature, expired nonce, ...). */
export class AuthenticationError extends STXShieldError {
  constructor(message: string, cause?: unknown) {
    super("AUTHENTICATION_FAILED", message, cause);
  }
}

/** The public API returned an error or an unexpected response. */
export class ApiError extends STXShieldError {
  readonly status?: number;
  constructor(message: string, status?: number, cause?: unknown) {
    super("API_ERROR", message, cause);
    this.status = status;
  }
}

/** Invalid or missing SDK configuration. */
export class ConfigError extends STXShieldError {
  constructor(message: string) {
    super("CONFIG_ERROR", message);
  }
}
