import { createComparisonDemoApp, seedComparisonDemo } from "./service.js";

function integer(name: string, fallback: number, maximum: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) throw new TypeError(`${name} must be an integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > maximum) {
    throw new TypeError(`${name} must not exceed ${maximum}`);
  }
  return value;
}

async function main(): Promise<void> {
  const port = integer("PROOFSTACK_PORT", 4318, 65_535);
  if (port === 0) throw new TypeError("PROOFSTACK_PORT must be at least 1");
  const webPort = integer("PROOFSTACK_WEB_PORT", 3000, 65_535);
  if (webPort === 0) throw new TypeError("PROOFSTACK_WEB_PORT must be at least 1");
  const demo = await createComparisonDemoApp({
    baselineMilliseconds: integer("PROOFSTACK_BASELINE_MS", 125, Number.MAX_SAFE_INTEGER),
    candidateMilliseconds: integer("PROOFSTACK_CANDIDATE_MS", 100, Number.MAX_SAFE_INTEGER),
    namespace: process.env["PROOFSTACK_COMPARISON_NAMESPACE"] ?? "service",
  });
  const seeded = await seedComparisonDemo(demo);
  const shutdown = async (): Promise<void> => {
    await demo.app.close();
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
  await demo.app.listen({ host: "127.0.0.1", port });
  process.stdout.write(
    `${[
      `ProofStack synthetic comparison API: http://127.0.0.1:${port}`,
      `Result ID: ${seeded.resultId}`,
      `Operator view: http://127.0.0.1:${webPort}/comparisons/${seeded.resultId}`,
      "Development-only: in-memory storage, synthetic evidence, and no production-readiness claim.",
    ].join("\n")}\n`,
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown comparison API failure";
  process.stderr.write(`Comparison API failed: ${message}\n`);
  process.exitCode = 1;
});
