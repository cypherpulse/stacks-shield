// =============================================================================
// STX Shield API -- structured logger (pino)
// =============================================================================

import { pino } from "pino";
import { config } from "../config.js";

export const logger = pino({
  level: config.isProd ? "info" : "debug",
  base: { service: "stx-shield-api" },
  transport: config.isProd
    ? undefined
    : { target: "pino-pretty", options: { colorize: true, translateTime: "SYS:HH:MM:ss" } },
});

export type Logger = typeof logger;
