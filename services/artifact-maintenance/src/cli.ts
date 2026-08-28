import { isArtifactMaintenanceCommand, loadArtifactMaintenanceConfig } from "./config.js";
import { runArtifactMaintenance } from "./runtime.js";

function usage(): string {
  return "Usage: proofstack-artifacts <cleanup-abandoned|key-status|reconcile|retention|retry-purges>";
}

async function main(arguments_: readonly string[]): Promise<number> {
  const command = arguments_[0];
  if (arguments_.length !== 1 || !isArtifactMaintenanceCommand(command)) {
    process.stderr.write(`${usage()}\n`);
    return 64;
  }
  try {
    const outcome = await runArtifactMaintenance(loadArtifactMaintenanceConfig(command));
    process.stdout.write(`${JSON.stringify(outcome)}\n`);
    return outcome.status === "ok" ? 0 : 2;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Artifact maintenance failed";
    process.stderr.write(`Artifact maintenance failed: ${message}\n`);
    return 1;
  }
}

void main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});
