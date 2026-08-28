#!/usr/bin/env node

import { createPostgresPool, inspectVerifiedMigrationLedger } from "@proofstack/postgres";
import { runRecoveryCli } from "./cli.js";
import {
  createPostgresLogicalBackup,
  restorePostgresLogicalBackup,
} from "./postgres-logical-backup.js";

try {
  process.exitCode = await runRecoveryCli(
    process.argv.slice(2),
    process.env,
    {
      error: (message) => console.error(message),
      output: (message) => console.log(message),
    },
    {
      backup: createPostgresLogicalBackup,
      createPool: (connectionString, onIdleError) =>
        createPostgresPool({
          applicationName: "proofstack-recovery",
          connectionString,
          maxConnections: 1,
          onIdleError,
        }),
      inspectLedger: inspectVerifiedMigrationLedger,
      restore: restorePostgresLogicalBackup,
    },
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : "Recovery command failed");
  process.exitCode = 1;
}
