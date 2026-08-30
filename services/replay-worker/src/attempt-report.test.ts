import { createHash } from "node:crypto";
import type {
  EvidenceScope,
  ReplayExecutionObservationPayload,
  ReplayWorkerMutationFence,
  ReplayWorkerStartTargetMessage,
} from "@proofstack/contracts";
import { describe, expect, it, vi } from "vitest";
import { BoundedReplayTargetOutput, type ReplayTargetOutputEvidence } from "./bounded-output.js";
import {
  publishSuccessfulReplayAttemptReport,
  type PublishReplayAttemptReportCommand,
  type ReplayAttemptReportPublisher,
  REPLAY_ATTEMPT_REPORT_MEDIA_TYPE,
} from "./attempt-report.js";
import type { ReplayTargetProcessResult } from "./target-process-supervisor.js";

const sha = (digit: string): string => digit.repeat(64);
const digest = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");

const scope: EvidenceScope = {
  environmentId: "env_report",
  projectId: "prj_report",
  tenantId: "ten_report",
};

const workerFence: ReplayWorkerMutationFence = {
  attemptId: "att_report_001",
  fencingToken: 19,
  jobId: "job_report_001",
  leaseId: "lea_report_001",
  recoveryEpoch: 0,
  workerId: "wrk_report_001",
};

const startMessage: ReplayWorkerStartTargetMessage = {
  boundaries: [
    {
      boundaryId: "bnd_report",
      invocation: {
        fixture: {
          definitionSha256: sha("1"),
          fixtureId: "fix_report",
          fixtureVersionId: "fiv_report_001",
        },
        invocationId: "rpi_report_001",
        runtime: {
          boundaryMode: "recorded_stub",
          clock: { instant: "2026-08-30T00:00:00.000Z", mode: "fixed" },
          isolation: { mode: "cooperative_in_process" },
          locale: "en-US",
          network: { policy: "deny_fallback" },
          random: {
            algorithm: "hmac_sha256_counter_v1",
            mode: "seeded",
            seedHex: sha("2"),
          },
          timeZone: "UTC",
        },
        schemaVersion: "0.1",
        targetAdapter: { name: "proofstack.report_target", version: "1.0.0" },
      },
      invocationDefinitionSha256: sha("3"),
    },
  ],
  schemaVersion: "0.1",
  sessionId: "rts_report_001",
  targetRelease: {
    definitionSha256: sha("4"),
    targetAdapter: {
      name: "proofstack.report_target",
      protocolVersion: "1.0.0",
      version: "1.0.0",
    },
    targetId: "tgt_report",
    targetReleaseId: "trg_report_001",
    workerProtocol: { name: "proofstack.replay-worker", version: "1.0.0" },
  },
  type: "start",
};

const isolationControls = [
  "environment_allowlist",
  "filesystem_mounts",
  "network_policy",
  "no_new_privileges",
  "output_limits",
  "process_boundary",
  "resource_limits",
  "subprocess_policy",
] as const;

function isolation(
  overrides: Readonly<Record<string, "failed" | "not_verified" | "verified">> = {},
): ReplayTargetProcessResult["isolation"] {
  return isolationControls.map((control) => {
    const verdict =
      overrides[control] ??
      (control === "environment_allowlist" ||
      control === "output_limits" ||
      control === "process_boundary"
        ? "verified"
        : "not_verified");
    return {
      control,
      evidenceSha256: digest({ control, verdict }),
      kind: "isolation",
      verdict,
    };
  });
}

function output(stream: "stderr" | "stdout"): ReplayTargetOutputEvidence {
  return new BoundedReplayTargetOutput(stream, 64).finish();
}

function truncatedOutput(stream: "stderr" | "stdout"): ReplayTargetOutputEvidence {
  const recorder = new BoundedReplayTargetOutput(stream, 1);
  recorder.write(Uint8Array.from([1, 2]));
  return recorder.finish();
}

function processResult(
  overrides: Partial<ReplayTargetProcessResult> = {},
): ReplayTargetProcessResult {
  return {
    executionObservations: [
      {
        afterCancellationRequest: false,
        evidenceSha256: sha("5"),
        event: "started",
        kind: "target",
      },
    ],
    exitCode: 0,
    failureCode: null,
    isolation: isolation(),
    runtime: [
      {
        boundaryId: "bnd_report",
        evidence: { fixedClockReadCount: 0, randomByteCount: 0, randomRequestCount: 0 },
        violated: false,
      },
    ],
    signal: null,
    status: "completed",
    stderr: output("stderr"),
    stdout: output("stdout"),
    ...overrides,
  };
}

function publisher(
  implementation: (command: PublishReplayAttemptReportCommand) => Promise<unknown> = async (
    command,
  ) => command.contentReference,
) {
  const publish = vi.fn(implementation);
  return { publish } as { readonly publish: typeof publish } & ReplayAttemptReportPublisher;
}

function options(
  targetPublisher: ReplayAttemptReportPublisher,
  overrides: Partial<Parameters<typeof publishSuccessfulReplayAttemptReport>[0]> = {},
) {
  return {
    maximumBytes: 64 * 1024,
    processResult: processResult(),
    publisher: targetPublisher,
    reservationId: `rsv_${"6".repeat(40)}`,
    scope,
    startMessage,
    workerFence,
    ...overrides,
  };
}

async function expectCode(
  input: Parameters<typeof publishSuccessfulReplayAttemptReport>[0],
  code: string,
): Promise<void> {
  await expect(publishSuccessfulReplayAttemptReport(input)).rejects.toMatchObject({
    code,
    name: "ReplayAttemptReportError",
  });
}

describe("publishSuccessfulReplayAttemptReport", () => {
  it("publishes one deterministic bounded report without target plaintext", async () => {
    const targetPublisher = publisher();
    const first = await publishSuccessfulReplayAttemptReport(options(targetPublisher));
    const second = await publishSuccessfulReplayAttemptReport(options(targetPublisher));
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      contentReference: {
        artifactId: expect.stringMatching(/^art_[0-9a-f]{40}$/),
        classification: "internal",
        mediaType: REPLAY_ATTEMPT_REPORT_MEDIA_TYPE,
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
      emittedArtifactBytes: expect.any(Number),
    });

    const firstCommand = targetPublisher.publish.mock.calls[0]?.[0];
    const secondCommand = targetPublisher.publish.mock.calls[1]?.[0];
    expect(firstCommand).toBeDefined();
    expect(secondCommand).toBeDefined();
    expect(firstCommand?.content).toEqual(secondCommand?.content);
    expect(firstCommand?.scope).toEqual(scope);
    expect(firstCommand?.contentReference.sizeBytes).toBe(firstCommand?.content.byteLength);
    const text = Buffer.from(firstCommand?.content ?? []).toString("utf8");
    expect(text).not.toContain("stdout plaintext");
    expect(JSON.parse(text)).toMatchObject({
      attempt: workerFence,
      budgetReservationId: `rsv_${"6".repeat(40)}`,
      process: {
        executionObservationCount: 1,
        executionObservationsSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        status: "completed",
        stderr: { capturedBytes: 0, stream: "stderr", truncated: false },
        stdout: { capturedBytes: 0, stream: "stdout", truncated: false },
      },
      schemaVersion: "0.1",
      scope,
      session: {
        boundaryIds: ["bnd_report"],
        sessionId: startMessage.sessionId,
        targetRelease: startMessage.targetRelease,
      },
    });
  });

  it("rejects invalid size and report identity before publication", async () => {
    for (const maximumBytes of [0, 1.5]) {
      const targetPublisher = publisher();
      await expectCode(options(targetPublisher, { maximumBytes }), "invalid_report_size");
      expect(targetPublisher.publish).not.toHaveBeenCalled();
    }
    for (const override of [
      { scope: { ...scope, tenantId: "x" } },
      { workerFence: { ...workerFence, fencingToken: 0 } },
      { startMessage: { ...startMessage, type: "wrong" } },
      { reservationId: "res_wrong" },
    ]) {
      const targetPublisher = publisher();
      await expectCode(options(targetPublisher, override), "invalid_report_context");
      expect(targetPublisher.publish).not.toHaveBeenCalled();
    }
  });

  it("requires one clean completed process envelope", async () => {
    const cases: readonly Partial<ReplayTargetProcessResult>[] = [
      { status: "failed" },
      { failureCode: "target_exit_failed" },
      { exitCode: 1 },
      { signal: "SIGTERM" },
    ];
    for (const processOverride of cases) {
      await expectCode(
        options(publisher(), { processResult: processResult(processOverride) }),
        "invalid_process_result",
      );
    }
  });

  it("rejects malformed, mismatched, and truncated output evidence", async () => {
    const validStderr = output("stderr");
    const invalidStderr: readonly ReplayTargetOutputEvidence[] = [
      { ...validStderr, capturedBytes: 1.5 },
      { ...validStderr, stream: "stdout" },
      { ...validStderr, truncated: undefined as never },
      { ...validStderr, contentSha256: "bad" },
      { ...validStderr, evidenceSha256: "bad" },
      { ...validStderr, capturedBytes: 65, observedAtLeastBytes: 65 },
      { ...validStderr, observedAtLeastBytes: 1 },
      { ...validStderr, evidenceSha256: sha("f") },
      truncatedOutput("stderr"),
    ];
    for (const stderr of invalidStderr) {
      await expectCode(
        options(publisher(), { processResult: processResult({ stderr }) }),
        "invalid_process_result",
      );
    }
    await expectCode(
      options(publisher(), {
        processResult: processResult({ stdout: truncatedOutput("stdout") }),
      }),
      "invalid_process_result",
    );
  });

  it("accepts only supervisor execution and complete isolation evidence", async () => {
    const cancellation: ReplayExecutionObservationPayload = {
      cancellationId: "can_report_001",
      event: "request_observed",
      evidenceSha256: sha("7"),
      kind: "cancellation",
    };
    const reservedIsolation = isolation()[0] as ReplayExecutionObservationPayload;
    for (const executionObservations of [[{}], [cancellation], [reservedIsolation]]) {
      await expectCode(
        options(publisher(), {
          processResult: processResult({ executionObservations: executionObservations as never }),
        }),
        "invalid_process_result",
      );
    }

    const valid = isolation();
    const wrongKind = {
      afterCancellationRequest: false,
      evidenceSha256: sha("8"),
      event: "started",
      kind: "target",
    } as const;
    const badDigest = { ...valid[0], evidenceSha256: sha("9") };
    const duplicate = [...valid.slice(0, -1), valid[0]];
    for (const isolationEvidence of [
      [wrongKind, ...valid.slice(1)],
      [badDigest, ...valid.slice(1)],
      valid.slice(0, -1),
      duplicate,
      isolation({ output_limits: "not_verified" }),
      isolation({ process_boundary: "failed" }),
    ]) {
      await expectCode(
        options(publisher(), {
          processResult: processResult({ isolation: isolationEvidence as never }),
        }),
        "invalid_process_result",
      );
    }
  });

  it("requires exact nonviolated runtime evidence for every declared boundary", async () => {
    const validRuntime = processResult().runtime[0];
    if (!validRuntime) throw new Error("Missing runtime fixture");
    const cases = [
      [{ ...validRuntime, evidence: {} }],
      [{ ...validRuntime, violated: "no" }],
      [validRuntime, validRuntime],
      [{ ...validRuntime, boundaryId: "bnd_other" }],
      [{ ...validRuntime, violated: true }],
    ];
    for (const runtime of cases) {
      await expectCode(
        options(publisher(), { processResult: processResult({ runtime: runtime as never }) }),
        "invalid_process_result",
      );
    }
  });

  it("caps content and rejects failed or dishonest publishers", async () => {
    await expectCode(options(publisher(), { maximumBytes: 1 }), "invalid_report_size");

    const failedPublisher = publisher(async () => {
      throw new Error("artifact service unavailable");
    });
    await expectCode(options(failedPublisher), "publish_failed");

    await expectCode(options(publisher(async () => ({}))), "publisher_mismatch");
    await expectCode(
      options(publisher(async (command) => ({ ...command.contentReference, sha256: sha("f") }))),
      "publisher_mismatch",
    );
  });
});
