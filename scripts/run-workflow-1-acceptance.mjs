#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");
const composeFile = resolve(repositoryRoot, "compose.yaml");
const arguments_ = process.argv.slice(2);
const unknownArguments = arguments_.filter((argument) => argument !== "--release-candidate");
if (unknownArguments.length > 0) {
  throw new TypeError(`Unknown acceptance argument: ${unknownArguments.join(", ")}`);
}
const releaseCandidateMode = arguments_.includes("--release-candidate");
const workflowLabel = releaseCandidateMode ? "Workflow 2 candidate" : "Workflow 1";
const projectName = `proofstack-${releaseCandidateMode ? "workflow-2-candidate" : "workflow-1"}-${process.pid}-${randomBytes(4).toString("hex")}`;
const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
let activeChild;
let receivedSignal;

function availableLoopbackPort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Unable to allocate a loopback port"));
        return;
      }
      server.close((error) => {
        if (error) reject(error);
        else resolvePort(address.port);
      });
    });
  });
}

function run(command, args, options = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd: repositoryRoot,
      env: options.env,
      stdio: "inherit",
    });
    activeChild = child;
    child.once("error", (error) => {
      if (activeChild === child) activeChild = undefined;
      reject(error);
    });
    child.once("exit", (code, signal) => {
      if (activeChild === child) activeChild = undefined;
      if (code === 0) resolveRun();
      else {
        reject(
          new Error(
            `${command} ${args.join(" ")} ${signal ? `was stopped by ${signal}` : `exited with ${code}`}`,
          ),
        );
      }
    });
  });
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    receivedSignal = signal;
    activeChild?.kill(signal);
  });
}

let composeEnvironment;
let primaryError;
let cleanupError;

try {
  await run("docker", ["compose", "version"], { env: process.env });
  const postgresPort = await availableLoopbackPort();
  let s3Port = await availableLoopbackPort();
  while (s3Port === postgresPort) s3Port = await availableLoopbackPort();

  composeEnvironment = {
    ...process.env,
    COMPOSE_DISABLE_ENV_FILE: "true",
    PROOFSTACK_POSTGRES_PORT: String(postgresPort),
    PROOFSTACK_S3_PORT: String(s3Port),
  };
  delete composeEnvironment.COMPOSE_ENV_FILES;
  delete composeEnvironment.COMPOSE_FILE;
  delete composeEnvironment.COMPOSE_PROFILES;
  const testEnvironment = {
    ...composeEnvironment,
    AWS_ACCESS_KEY_ID: "proofstack-local",
    AWS_SECRET_ACCESS_KEY: "proofstack-local-secret",
    AWS_SESSION_TOKEN: "",
    CI: "true",
    PROOFSTACK_TEST_DATABASE_URL: `postgresql://postgres:proofstack-local-admin@127.0.0.1:${postgresPort}/proofstack`,
    PROOFSTACK_TEST_S3_ACCESS_KEY_ID: "proofstack-local",
    PROOFSTACK_TEST_S3_ENDPOINT: `http://127.0.0.1:${s3Port}`,
    PROOFSTACK_TEST_S3_REGION: "us-east-1",
    PROOFSTACK_TEST_S3_SECRET_ACCESS_KEY: "proofstack-local-secret",
    PROOFSTACK_ACCEPT_RELEASE_CANDIDATE: releaseCandidateMode ? "true" : "false",
  };

  console.log(`Starting isolated ${workflowLabel} services as ${projectName}.`);
  console.log(`PostgreSQL uses loopback port ${postgresPort}; object storage uses ${s3Port}.`);
  await run(
    "docker",
    [
      "compose",
      "--file",
      composeFile,
      "--project-name",
      projectName,
      "--profile",
      "object-storage",
      "up",
      "--detach",
      "--wait",
      "postgres",
      "seaweedfs",
    ],
    { env: composeEnvironment },
  );

  await run(
    pnpmCommand,
    [
      "exec",
      "turbo",
      "run",
      "test:integration",
      "--concurrency=1",
      "--filter=@proofstack/example-workflow-1-acceptance",
    ],
    { env: testEnvironment },
  );
  console.log(`${workflowLabel} acceptance passed. Removing the isolated services and volumes.`);
} catch (error) {
  primaryError = error;
} finally {
  if (composeEnvironment) {
    try {
      await run(
        "docker",
        [
          "compose",
          "--file",
          composeFile,
          "--project-name",
          projectName,
          "--profile",
          "object-storage",
          "down",
          "--volumes",
          "--remove-orphans",
        ],
        { env: composeEnvironment },
      );
    } catch (error) {
      cleanupError = error;
    }
  }
}

if (cleanupError) {
  console.error(`${workflowLabel} cleanup failed: ${cleanupError.message}`);
}
if (primaryError) {
  console.error(`${workflowLabel} acceptance failed: ${primaryError.message}`);
}
if (receivedSignal) {
  process.kill(process.pid, receivedSignal);
} else if (primaryError || cleanupError) {
  process.exitCode = 1;
}
