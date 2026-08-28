import { runArtifactMaintenanceCli } from "./cli-command.js";

void runArtifactMaintenanceCli(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});
