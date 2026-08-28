import { spawn } from "node:child_process";
import { RecoveryOperationError } from "./errors.js";

const DEFAULT_COMMAND_TIMEOUT_MS = 15 * 60 * 1_000;
const MAX_COMMAND_OUTPUT_BYTES = 64 * 1_024;

export interface PostgresCommand {
  readonly arguments: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly executable: string;
  readonly timeoutMs?: number;
}

export interface PostgresCommandResult {
  readonly stderr: string;
  readonly stdout: string;
}

export interface PostgresCommandRunner {
  readonly run: (command: PostgresCommand) => Promise<PostgresCommandResult>;
}

function commandError(reason: string, cause?: unknown): RecoveryOperationError {
  return new RecoveryOperationError(
    "postgres-tool",
    reason,
    cause === undefined ? undefined : { cause },
  );
}

function boundedAppend(
  current: Buffer<ArrayBufferLike>,
  chunk: Buffer<ArrayBufferLike>,
): Buffer<ArrayBufferLike> {
  if (current.byteLength + chunk.byteLength > MAX_COMMAND_OUTPUT_BYTES) {
    throw commandError("command output exceeded the safety limit");
  }
  return Buffer.concat([current, chunk]);
}

export class NativePostgresCommandRunner implements PostgresCommandRunner {
  run(command: PostgresCommand): Promise<PostgresCommandResult> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
      let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
      const child = spawn(command.executable, [...command.arguments], {
        env: { ...command.environment },
        stdio: ["ignore", "pipe", "pipe"],
      });

      const settle = (action: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        action();
      };
      const terminateForOutput = (error: unknown): void => {
        child.kill("SIGKILL");
        settle(() => reject(error));
      };

      child.stdout.on("data", (chunk: Buffer) => {
        try {
          stdout = boundedAppend(stdout, chunk);
        } catch (error) {
          terminateForOutput(error);
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        try {
          stderr = boundedAppend(stderr, chunk);
        } catch (error) {
          terminateForOutput(error);
        }
      });
      child.once("error", (error) => {
        settle(() => reject(commandError("command could not be started", error)));
      });
      child.once("close", (code, signal) => {
        settle(() => {
          if (code !== 0) {
            reject(
              commandError(
                signal === null
                  ? `command exited with status ${code ?? "unknown"}`
                  : `command terminated by signal ${signal}`,
              ),
            );
            return;
          }
          resolve({ stderr: stderr.toString("utf8"), stdout: stdout.toString("utf8") });
        });
      });

      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        settle(() => reject(commandError("command timed out")));
      }, command.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS);
      timeout.unref();
    });
  }
}
