// =============================================================================
// STX Shield API -- standalone indexer entry point
// =============================================================================
//   npm run indexer
// Runs the block indexer without the HTTP server (for separate scaling).

import { startBlockIndexer } from "./block-indexer.js";
import { closeDb } from "../db/client.js";
import { logger } from "../utils/logger.js";

const stop = startBlockIndexer();

const shutdown = async (sig: string) => {
  logger.info({ sig }, "indexer runner: shutting down");
  stop();
  await closeDb();
  process.exit(0);
};

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
