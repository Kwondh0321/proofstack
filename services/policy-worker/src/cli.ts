#!/usr/bin/env node
import { runPolicyWorkerCli } from "./cli-command.js";
void runPolicyWorkerCli(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});
