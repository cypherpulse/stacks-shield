// =============================================================================
// STX Shield API -- database client (Drizzle + postgres.js)
// =============================================================================

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";
import { config } from "../config.js";

// A single shared connection pool for the process. postgres.js pools by default.
const queryClient = postgres(config.databaseUrl, {
  max: config.dbPoolSize,
  onnotice: () => {}, // silence NOTICE spam
});

export const db = drizzle(queryClient, { schema });
export { schema };

/** Close the pool on shutdown. */
export const closeDb = async (): Promise<void> => {
  await queryClient.end({ timeout: 5 });
};

/** Liveness probe for /ready. */
export const dbHealthy = async (): Promise<boolean> => {
  try {
    await queryClient`select 1`;
    return true;
  } catch {
    return false;
  }
};
