import {
  type ArtifactMaintenanceCommandName,
  isArtifactMaintenanceCommand,
  loadArtifactMaintenanceConfig,
} from "./config.js";
import { type ArtifactMaintenanceRunResult, runArtifactMaintenance } from "./runtime.js";

export interface ArtifactMaintenanceCliDependencies {
  readonly loadConfig: typeof loadArtifactMaintenanceConfig;
  readonly run: typeof runArtifactMaintenance;
  readonly writeError: (value: string) => void;
  readonly writeOutput: (value: string) => void;
}

const DEFAULT_DEPENDENCIES: ArtifactMaintenanceCliDependencies = {
  loadConfig: loadArtifactMaintenanceConfig,
  run: runArtifactMaintenance,
  writeError: (value) => process.stderr.write(value),
  writeOutput: (value) => process.stdout.write(value),
};

function usage(): string {
  return "Usage: proofstack-artifacts <cleanup-abandoned|key-status|reconcile|retention|retry-purges>";
}

function exitCode(outcome: ArtifactMaintenanceRunResult): number {
  return outcome.status === "ok" ? 0 : 2;
}

export async function runArtifactMaintenanceCli(
  arguments_: readonly string[],
  overrides: Partial<ArtifactMaintenanceCliDependencies> = {},
): Promise<number> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };
  const command = arguments_[0];
  if (arguments_.length !== 1 || !isArtifactMaintenanceCommand(command)) {
    dependencies.writeError(`${usage()}\n`);
    return 64;
  }
  try {
    const config = dependencies.loadConfig(command as ArtifactMaintenanceCommandName);
    const outcome = await dependencies.run(config);
    dependencies.writeOutput(`${JSON.stringify(outcome)}\n`);
    return exitCode(outcome);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Artifact maintenance failed";
    dependencies.writeError(`Artifact maintenance failed: ${message}\n`);
    return 1;
  }
}
