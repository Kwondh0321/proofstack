import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createLocalReplayReportPublisher,
  loadDurableReplayWorkerCommand,
  MAX_DURABLE_REPLAY_WORKER_INPUT_BYTES,
  readLocalReplayReport,
} from "./worker-input.js";

const roots: string[] = [];
const scope = {
  environmentId: "env_worker_input",
  projectId: "prj_worker_input",
  tenantId: "ten_worker_input",
} as const;

function claimCommand() {
  return {
    claim: {
      attemptId: "att_worker_input",
      leaseId: "lea_worker_input",
      workerBuildSha256: "1".repeat(64),
      workerId: "wrk_worker_input",
      workerProtocol: { name: "proofstack.replay-worker", version: "2.0.0" },
    },
    command: "claim",
    databaseUrl: "postgresql://worker:secret@127.0.0.1:5432/proofstack",
    jobId: "job_worker_input",
    leaseDurationMilliseconds: 1_000,
    schemaVersion: "0.1",
    scope,
  } as const;
}

async function privateInput(value: unknown): Promise<{ path: string; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "proofstack-worker-input-test-"));
  roots.push(root);
  const path = join(root, "command.json");
  await writeFile(path, JSON.stringify(value), { mode: 0o600 });
  return { path, root };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe("durable replay worker input", () => {
  it("loads one strict private claim command", async () => {
    const input = await privateInput(claimCommand());
    await expect(loadDurableReplayWorkerCommand(input.path)).resolves.toEqual(claimCommand());
  });

  it("rejects relative, public, symlinked, malformed, empty, oversized, and unknown input", async () => {
    await expect(loadDurableReplayWorkerCommand("relative.json")).rejects.toThrow("absolute");
    await expect(loadDurableReplayWorkerCommand("/tmp/invalid\0path")).rejects.toThrow("absolute");
    const publicInput = await privateInput(claimCommand());
    await chmod(publicInput.path, 0o644);
    await expect(loadDurableReplayWorkerCommand(publicInput.path)).rejects.toThrow("private");
    await chmod(publicInput.path, 0o600);
    const link = join(publicInput.root, "link.json");
    await symlink(publicInput.path, link);
    await expect(loadDurableReplayWorkerCommand(link)).rejects.toThrow();
    const malformed = await privateInput("not-json");
    await writeFile(malformed.path, "{x", { mode: 0o600 });
    await expect(loadDurableReplayWorkerCommand(malformed.path)).rejects.toThrow("valid JSON");
    const empty = await privateInput(null);
    await writeFile(empty.path, "", { mode: 0o600 });
    await expect(loadDurableReplayWorkerCommand(empty.path)).rejects.toThrow("private");
    const oversized = await privateInput(null);
    await writeFile(oversized.path, Buffer.alloc(MAX_DURABLE_REPLAY_WORKER_INPUT_BYTES + 1), {
      mode: 0o600,
    });
    await expect(loadDurableReplayWorkerCommand(oversized.path)).rejects.toThrow("private");
    const unknown = await privateInput({ ...claimCommand(), unexpected: true });
    await expect(loadDurableReplayWorkerCommand(unknown.path)).rejects.toThrow();
  });
});

describe("local replay report publisher", () => {
  it("writes one exact private report and accepts only an identical retry", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofstack-report-publisher-test-"));
    roots.push(root);
    const directory = join(root, "reports");
    const publisher = await createLocalReplayReportPublisher(directory);
    const content = Buffer.from('{"status":"completed"}\n', "utf8");
    const contentReference = {
      artifactId: "art_worker_report",
      classification: "internal" as const,
      mediaType: "application/vnd.proofstack.replay-attempt-report+json",
      sha256: createHash("sha256").update(content).digest("hex"),
      sizeBytes: content.byteLength,
    };
    const command = {
      content,
      contentReference,
      scope,
      signal: new AbortController().signal,
    };
    await expect(publisher.publish(command)).resolves.toEqual(contentReference);
    await expect(publisher.publish(command)).resolves.toEqual(contentReference);
    await expect(readFile(join(directory, "art_worker_report.json"))).resolves.toEqual(content);
    await expect(readLocalReplayReport(directory, contentReference)).resolves.toEqual(
      Uint8Array.from(content),
    );
  });

  it("rejects non-absolute directories, mismatched bytes, cancellation, and conflicting retries", async () => {
    await expect(createLocalReplayReportPublisher("relative")).rejects.toThrow("absolute");
    await expect(createLocalReplayReportPublisher("/tmp/invalid\0path")).rejects.toThrow(
      "absolute",
    );
    const root = await mkdtemp(join(tmpdir(), "proofstack-report-rejection-test-"));
    roots.push(root);
    await chmod(root, 0o755);
    await expect(createLocalReplayReportPublisher(root)).rejects.toThrow("private");
    await chmod(root, 0o700);
    const publisher = await createLocalReplayReportPublisher(root);
    const content = Buffer.from("first");
    const reference = {
      artifactId: "art_worker_report_conflict",
      classification: "internal" as const,
      mediaType: "application/vnd.proofstack.replay-attempt-report+json",
      sha256: createHash("sha256").update(content).digest("hex"),
      sizeBytes: content.byteLength,
    };
    const signal = new AbortController();
    signal.abort();
    await expect(
      publisher.publish({ content, contentReference: reference, scope, signal: signal.signal }),
    ).rejects.toThrow("does not match");
    await expect(
      publisher.publish({
        content: Buffer.from("longer"),
        contentReference: reference,
        scope,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("does not match");
    await writeFile(join(root, `${reference.artifactId}.json`), "other", { mode: 0o600 });
    await expect(
      publisher.publish({
        content,
        contentReference: reference,
        scope,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("different bytes");
    await expect(readLocalReplayReport("relative", reference)).rejects.toThrow("absolute");
    await expect(readLocalReplayReport(root, { unknown: true })).rejects.toThrow();
    await expect(readLocalReplayReport(root, reference)).rejects.toThrow("immutable");
    await writeFile(join(root, `${reference.artifactId}.json`), content, {
      flag: "w",
      mode: 0o644,
    });
    await chmod(join(root, `${reference.artifactId}.json`), 0o644);
    await expect(readLocalReplayReport(root, reference)).rejects.toThrow("private regular");
    await unlink(join(root, `${reference.artifactId}.json`));
    const outside = join(root, "outside.json");
    await writeFile(outside, content, { mode: 0o600 });
    await symlink(outside, join(root, `${reference.artifactId}.json`));
    await expect(readLocalReplayReport(root, reference)).rejects.toThrow("private regular");
    const removedDirectory = join(root, "removed");
    const removedPublisher = await createLocalReplayReportPublisher(removedDirectory);
    await rm(removedDirectory, { recursive: true });
    await expect(
      removedPublisher.publish({
        content,
        contentReference: { ...reference, artifactId: "art_worker_report_missing_directory" },
        scope,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow();
  });
});
