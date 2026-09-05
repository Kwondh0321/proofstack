import { runComparisonExperiment } from "./workflow.js";

function nonNegativeInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) {
    throw new TypeError(`${name} must be a non-negative integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new TypeError(`${name} exceeds the safe integer range`);
  return value;
}

async function main(): Promise<void> {
  const summary = await runComparisonExperiment({
    baselineMilliseconds: nonNegativeInteger("PROOFSTACK_BASELINE_MS", 125),
    candidateMilliseconds: nonNegativeInteger("PROOFSTACK_CANDIDATE_MS", 100),
    namespace: process.env["PROOFSTACK_COMPARISON_NAMESPACE"] ?? "trial",
  });
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown comparison experiment failure";
  process.stderr.write(`Comparison experiment failed: ${message}\n`);
  process.exitCode = 1;
});
