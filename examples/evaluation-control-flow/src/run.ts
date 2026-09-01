import { SystemClock } from "@proofstack/core";
import {
  createPostgresEvaluationWorker,
  loadEvaluationWorkerConfig,
} from "@proofstack/evaluation-worker";
import { ProofStackEvaluationClient } from "@proofstack/sdk";
import { runEvaluationControlFlow } from "./workflow.js";

function environment(name: string, fallback: string): string {
  const value = process.env[name] ?? fallback;
  if (value.length === 0 || value.trim() !== value) {
    throw new TypeError(`${name} must contain one value without surrounding space`);
  }
  return value;
}

async function main(): Promise<void> {
  const workerConfig = loadEvaluationWorkerConfig();
  const endpoint = environment("PROOFSTACK_API_URL", "http://127.0.0.1:4318");
  const environmentId = environment("PROOFSTACK_ENVIRONMENT_ID", "env_local");
  const namespace = environment("PROOFSTACK_EVALUATION_EXAMPLE_NAMESPACE", "reference");
  const projectId = environment("PROOFSTACK_PROJECT_ID", "prj_local");
  let idleError: Error | undefined;
  const worker = await createPostgresEvaluationWorker({
    clock: new SystemClock(),
    databaseUrl: workerConfig.databaseUrl,
    onIdleError: (error) => {
      idleError = error;
    },
  });

  try {
    const summary = await runEvaluationControlFlow({
      client: new ProofStackEvaluationClient({
        authentication: { mode: "development" },
        endpoint,
        environmentId,
        projectId,
      }),
      environmentId,
      namespace,
      projectId,
      worker,
    });
    if (idleError) throw new Error("The evaluation worker lost an idle database connection");
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } finally {
    await worker.close();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown evaluation example failure";
  process.stderr.write(`Evaluation control flow failed: ${message}\n`);
  process.exitCode = 1;
});
