import { execFileSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runDurableReplayExample } from "./workflow.js";

try {
  const {
    PROOFSTACK_API_URL,
    PROOFSTACK_ENVIRONMENT_ID,
    PROOFSTACK_PROJECT_ID,
    PROOFSTACK_REPLAY_WORKER_DATABASE_URL: workerDatabaseUrl,
    PROOFSTACK_SOURCE_REVISION,
  } = process.env;
  if (!workerDatabaseUrl) {
    throw new Error(
      "PROOFSTACK_REPLAY_WORKER_DATABASE_URL is required and must use the provisioned replay-worker role",
    );
  }
  const sourceRevision =
    PROOFSTACK_SOURCE_REVISION ??
    execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: fileURLToPath(new URL("../../..", import.meta.url)),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  const outputRoot = await mkdtemp(join(tmpdir(), "proofstack-durable-replay-"));
  const summary = await runDurableReplayExample({
    apiUrl: PROOFSTACK_API_URL ?? "http://127.0.0.1:4318",
    environmentId: PROOFSTACK_ENVIRONMENT_ID ?? "env_local",
    outputRoot,
    projectId: PROOFSTACK_PROJECT_ID ?? "prj_local",
    sourceRevision,
    tenantId: "ten_local",
    workerDatabaseUrl,
    workerEntryPointPath: fileURLToPath(new URL("./worker.js", import.meta.url)),
  });
  process.stdout.write(`${JSON.stringify({ outputRoot, ...summary }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : "The durable replay example failed closed"}\n`,
  );
  process.exitCode = 1;
}
