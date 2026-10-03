/** Best-effort evidence from this disposable project only; never replace the acceptance error. */
export async function collectWorkflowAcceptanceDiagnostics(run, context) {
  const compose = [
    "compose",
    "--file",
    context.composeFile,
    "--project-name",
    context.projectName,
    "--profile",
    "object-storage",
  ];
  const failures = [];
  for (const [kind, arguments_] of [
    ["status", ["ps", "--all"]],
    ["logs", ["logs", "--no-color", "--tail", "160", "postgres", "seaweedfs"]],
  ]) {
    try {
      await run("docker", [...compose, ...arguments_], {
        env: context.environment,
        timeout: 10_000,
        killSignal: "SIGKILL",
      });
    } catch (error) {
      failures.push({ kind, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return failures;
}
