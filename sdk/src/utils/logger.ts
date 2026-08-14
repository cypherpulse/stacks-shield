// =============================================================================
// @stacks-shield/sdk -- logger
// =============================================================================
// Minimal, dependency-free, and SECRET-SAFE. The SDK only ever passes public
// data here; secrets, keys, nullifiers and Merkle paths are never logged.

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

const ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3, silent: 4 };

export const createLogger = (level: LogLevel = "warn"): Logger => {
  const at = (l: LogLevel) => ORDER[l] >= ORDER[level];
  const line = (l: string, msg: string, meta?: Record<string, unknown>) =>
    // eslint-disable-next-line no-console
    console[l === "error" ? "error" : l === "warn" ? "warn" : "log"](
      `[stx-shield] ${msg}`,
      meta ?? "",
    );
  return {
    debug: (m, meta) => at("debug") && line("debug", m, meta),
    info: (m, meta) => at("info") && line("info", m, meta),
    warn: (m, meta) => at("warn") && line("warn", m, meta),
    error: (m, meta) => at("error") && line("error", m, meta),
  };
};

export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};
