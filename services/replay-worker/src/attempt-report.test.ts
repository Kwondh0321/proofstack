import { createHash } from "node:crypto";
import type {
  EvidenceScope,
  ReplayBoundaryExecutionResult,
  ReplayExecutionObservationPayload,
  ReplayWorkerMutationFence,
  ReplayWorkerStartTargetMessage,
  ReplayWorkerStartTargetV2Message,
} from "@proofstack/contracts";
import { ReplayBoundaryExecutionResultSchema } from "@proofstack/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  type PublishReplayAttemptReportCommand,
  publishSuccessfulReplayAttemptReport,
  REPLAY_ATTEMPT_REPORT_MEDIA_TYPE,
  type ReplayAttemptReportPublisher,
} from "./attempt-report.js";
import { BoundedReplayTargetOutput, type ReplayTargetOutputEvidence } from "./bounded-output.js";
import type {
  ReplayTargetProcessResult,
  ReplayTargetProcessV2Result,
} from "./target-process-supervisor.js";

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

const startMessageV2: ReplayWorkerStartTargetV2Message = {
  boundaries: [
    {
      boundaryId: "bnd_report_live",
      kind: "tool",
      mode: "live_provider",
    },
    {
      boundaryId: "bnd_report_recorded",
      invocation: startMessage.boundaries[0]?.invocation as NonNullable<
        (typeof startMessage.boundaries)[number]
      >["invocation"],
      invocationDefinitionSha256: sha("3"),
      kind: "model",
      mode: "recorded_stub",
    },
    {
      boundaryId: "bnd_report_simulation",
      kind: "retrieval",
      mode: "simulation",
    },
  ],
  schemaVersion: "0.2",
  sessionId: "rts_report_v2_001",
  targetRelease: {
    ...startMessage.targetRelease,
    workerProtocol: { name: "proofstack.replay-worker", version: "2.0.0" },
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

function v2BoundaryResult(boundaryId = "bnd_report_simulation"): ReplayBoundaryExecutionResult {
  const responseBytes = Buffer.from("sensitive simulated response", "utf8");
  const requestBytes = Buffer.from("retrieval request", "utf8");
  return ReplayBoundaryExecutionResultSchema.parse({
    actualRequest: {
      adapter: { name: "proofstack.retrieval", version: "1.0.0" },
      boundaryRequestId: `req_${boundaryId}`,
      kind: "retrieval",
      normalizedRequestSha256: createHash("sha256").update(requestBytes).digest("hex"),
      sizeBytes: requestBytes.byteLength,
    },
    boundaryId,
    declaration: {
      boundaryId,
      configurationSha256: sha("a"),
      kind: "retrieval",
      mode: "simulation",
      qualification: {
        artifactId: "art_report_qualification",
        classification: "internal",
        mediaType: "application/json",
        sha256: sha("b"),
        sizeBytes: 64,
      },
      seedHex: sha("c"),
      simulatorRelease: {
        definitionSha256: sha("d"),
        targetAdapter: {
          name: "proofstack.simulator",
          protocolVersion: "1.0.0",
          version: "1.0.0",
        },
        targetId: "tgt_report_simulator",
        targetReleaseId: "trg_report_simulator_001",
        workerProtocol: { name: "proofstack.replay-worker", version: "2.0.0" },
      },
    },
    effectCertainty: "none",
    executionOrigin: "simulated",
    mode: "simulation",
    output: {
      kind: "normalized_response",
      response: {
        adapter: { name: "proofstack.retrieval", version: "1.0.0" },
        bytes: responseBytes.toString("base64url"),
        encoding: "base64url",
        normalizedResponseSha256: createHash("sha256").update(responseBytes).digest("hex"),
        sizeBytes: responseBytes.byteLength,
      },
    },
    schemaVersion: "0.1",
    usage: [
      {
        dimension: "retrievedBytes",
        usage: { amount: responseBytes.byteLength, source: "measured", status: "observed" },
      },
    ],
  });
}

function v2LiveBoundaryResult(): ReplayBoundaryExecutionResult {
  const responseBytes = Buffer.from("live response", "utf8");
  const requestBytes = Buffer.from("live request", "utf8");
  return ReplayBoundaryExecutionResultSchema.parse({
    actualRequest: {
      adapter: { name: "proofstack.tool", version: "1.0.0" },
      boundaryRequestId: "req_report_live",
      kind: "tool",
      normalizedRequestSha256: createHash("sha256").update(requestBytes).digest("hex"),
      sizeBytes: requestBytes.byteLength,
    },
    boundaryId: "bnd_report_live",
    declaration: {
      boundaryId: "bnd_report_live",
      credential: {
        credentialId: "cred_report",
        credentialVersionId: "crv_report_001",
      },
      destination: { hostname: "api.example.com", port: 443, scheme: "https" },
      endpointProfile: {
        definitionSha256: sha("8"),
        endpointProfileId: "end_report",
        endpointProfileVersion: "1.0.0",
      },
      kind: "tool",
      mode: "live_provider",
      operation: "execute",
      requestLimits: { requestBytes: 4_096, responseBytes: 65_536 },
      sideEffect: {
        idempotencyKeyScheme: "proofstack.report.v1",
        kind: "idempotent_write",
        sandboxDestination: true,
      },
      usageSource: "measured",
    },
    effectCertainty: "confirmed",
    effectRetrySafety: {
      evidenceSha256: sha("9"),
      idempotencyKeySha256: sha("a"),
      kind: "destination_idempotency_verified",
    },
    executionOrigin: "live",
    mode: "live_provider",
    output: {
      kind: "normalized_response",
      response: {
        adapter: { name: "proofstack.tool", version: "1.0.0" },
        bytes: responseBytes.toString("base64url"),
        encoding: "base64url",
        normalizedResponseSha256: createHash("sha256").update(responseBytes).digest("hex"),
        sizeBytes: responseBytes.byteLength,
      },
    },
    schemaVersion: "0.1",
    usage: [
      {
        dimension: "toolCalls",
        usage: { amount: 1, source: "measured", status: "observed" },
      },
    ],
  });
}

function v2RecordedBoundaryResult(): ReplayBoundaryExecutionResult {
  const requestBytes = Buffer.from("recorded request", "utf8");
  const normalizedRequestSha256 = createHash("sha256").update(requestBytes).digest("hex");
  const invocation = startMessageV2.boundaries.find(
    (boundary) => boundary.boundaryId === "bnd_report_recorded",
  );
  if (invocation?.mode !== "recorded_stub") throw new Error("Missing recorded start fixture");
  const recordedRequest = {
    adapterName: "proofstack.model",
    adapterVersion: "1.0.0",
    boundaryRequestId: "req_report_recorded",
    kind: "model" as const,
    normalizedRequestSha256,
    sizeBytes: requestBytes.byteLength,
  };
  const expectedRequest = {
    adapterName: "proofstack.model",
    adapterVersion: "1.0.0",
    attemptId: "att_report_recorded",
    attemptSequence: 0,
    interactionId: "int_report_recorded",
    interactionSequence: 0,
    kind: "model" as const,
    normalizedRequestSha256,
  };
  return ReplayBoundaryExecutionResultSchema.parse({
    actualRequest: {
      adapter: { name: "proofstack.model", version: "1.0.0" },
      boundaryRequestId: recordedRequest.boundaryRequestId,
      kind: "model",
      normalizedRequestSha256,
      sizeBytes: requestBytes.byteLength,
    },
    boundaryId: "bnd_report_recorded",
    declaration: {
      boundaryId: "bnd_report_recorded",
      invocation: invocation.invocation,
      invocationDefinitionSha256: invocation.invocationDefinitionSha256,
      kind: "model",
      mode: "recorded_stub",
    },
    effectCertainty: "none",
    executionOrigin: "recorded",
    mode: "recorded_stub",
    output: {
      kind: "recorded_artifacts",
      response: {
        artifacts: [],
        resolution: {
          actualRequest: recordedRequest,
          expectedRequest,
          recordedAttempt: {
            attempt: {
              artifacts: {
                inputMessagesArtifactId: "art_report_input",
                providerConfigurationArtifactId: "art_report_configuration",
                providerRequestArtifactId: "art_report_request",
              },
              attemptId: expectedRequest.attemptId,
              endedAt: "2026-08-30T00:00:01.000Z",
              errorType: "recorded_failure",
              normalizedRequest: {
                adapterName: expectedRequest.adapterName,
                adapterVersion: expectedRequest.adapterVersion,
                artifactId: "art_report_normalized",
                sha256: normalizedRequestSha256,
              },
              outcome: "failed",
              provider: {
                endpointProfileId: "end_report_recorded",
                endpointProfileVersion: "1.0.0",
                name: "provider-neutral",
                operation: "chat",
                requestedModel: "reference-model",
                returnedModel: "reference-model",
              },
              providerMayHaveProcessed: false,
              sequence: 0,
              startedAt: "2026-08-30T00:00:00.000Z",
              streaming: false,
            },
            interactionId: expectedRequest.interactionId,
            interactionSequence: expectedRequest.interactionSequence,
            kind: "model",
          },
          returnedArtifacts: [],
        },
        schemaVersion: "0.1",
      },
    },
    schemaVersion: "0.1",
    usage: [
      {
        dimension: "modelRequests",
        usage: { amount: 1, source: "measured", status: "observed" },
      },
    ],
  });
}

function v2ExecutionObservations(
  candidate = v2BoundaryResult(),
): ReplayTargetProcessResult["executionObservations"] {
  return [
    {
      afterCancellationRequest: false,
      evidenceSha256: sha("5"),
      event: "started",
      kind: "target",
    },
    {
      afterCancellationRequest: false,
      boundaryId: candidate.boundaryId,
      boundaryKind: candidate.actualRequest.kind,
      effectCertainty: "none",
      evidenceSha256: sha("6"),
      executionOrigin: candidate.executionOrigin,
      kind: "boundary",
      mode: candidate.mode,
      phase: "request_started",
    },
    {
      afterCancellationRequest: false,
      boundaryId: candidate.boundaryId,
      boundaryKind: candidate.actualRequest.kind,
      effectCertainty: candidate.effectCertainty,
      evidenceSha256: sha("7"),
      executionOrigin: candidate.executionOrigin,
      kind: "boundary",
      mode: candidate.mode,
      phase: "response_observed",
    },
  ];
}

function processResultV2(
  overrides: Partial<ReplayTargetProcessV2Result> = {},
): ReplayTargetProcessV2Result {
  const boundaryResult = v2BoundaryResult();
  return {
    ...processResult({
      executionObservations: v2ExecutionObservations(boundaryResult),
      runtime: [
        {
          boundaryId: "bnd_report_recorded",
          evidence: { fixedClockReadCount: 0, randomByteCount: 0, randomRequestCount: 0 },
          violated: false,
        },
      ],
    }),
    boundaryResults: [boundaryResult],
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
    signal: new AbortController().signal,
    scope,
    startMessage,
    workerFence,
    ...overrides,
  };
}

function v2Options(
  targetPublisher: ReplayAttemptReportPublisher,
  overrides: Partial<Parameters<typeof publishSuccessfulReplayAttemptReport>[0]> = {},
) {
  return options(targetPublisher, {
    processResult: processResultV2(),
    startMessage: startMessageV2,
    ...overrides,
  });
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
    expect(firstCommand?.signal).toBeInstanceOf(AbortSignal);
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

  it("publishes a v2 summary without embedding normalized response plaintext", async () => {
    const targetPublisher = publisher();
    const published = await publishSuccessfulReplayAttemptReport(v2Options(targetPublisher));
    const command = targetPublisher.publish.mock.calls[0]?.[0];
    const text = Buffer.from(command?.content ?? []).toString("utf8");
    const report = JSON.parse(text) as Record<string, unknown>;
    const exactResult = processResultV2().boundaryResults[0];
    if (exactResult?.output.kind !== "normalized_response") {
      throw new Error("Missing normalized v2 result fixture");
    }
    expect(published.contentReference.artifactId).toMatch(/^art_[0-9a-f]{40}$/);
    expect(text).not.toContain("sensitive simulated response");
    expect(text).not.toContain(exactResult.output.response.bytes);
    expect(report).toMatchObject({
      attempt: workerFence,
      boundaryResults: {
        count: 1,
        entries: [
          {
            actualRequest: exactResult.actualRequest,
            boundaryId: "bnd_report_simulation",
            declarationSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
            effectCertainty: "none",
            executionOrigin: "simulated",
            mode: "simulation",
            output: {
              contentSha256: exactResult.output.response.normalizedResponseSha256,
              kind: "normalized_response",
              outputSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
            },
            usage: exactResult.usage,
          },
        ],
        fullResultsSha256: digest(processResultV2().boundaryResults),
        summarySha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
      budgetReservationId: `rsv_${"6".repeat(40)}`,
      process: {
        runtime: [expect.objectContaining({ boundaryId: "bnd_report_recorded" })],
        status: "completed",
      },
      schemaVersion: "0.2",
      scope,
      session: {
        boundaries: [
          { boundaryId: "bnd_report_live", kind: "tool", mode: "live_provider" },
          { boundaryId: "bnd_report_recorded", kind: "model", mode: "recorded_stub" },
          { boundaryId: "bnd_report_simulation", kind: "retrieval", mode: "simulation" },
        ],
        boundaryIds: ["bnd_report_live", "bnd_report_recorded", "bnd_report_simulation"],
        sessionId: startMessageV2.sessionId,
        targetRelease: startMessageV2.targetRelease,
      },
    });
  });

  it("summarizes confirmed effects and recorded lineage without publishing raw outputs", async () => {
    const candidates = [v2LiveBoundaryResult(), v2RecordedBoundaryResult()];
    const entries: Array<Record<string, unknown>> = [];
    for (const candidate of candidates) {
      const targetPublisher = publisher();
      await publishSuccessfulReplayAttemptReport(
        v2Options(targetPublisher, {
          processResult: processResultV2({
            boundaryResults: [candidate],
            executionObservations: v2ExecutionObservations(candidate),
          }),
        }),
      );
      const content = targetPublisher.publish.mock.calls[0]?.[0].content ?? [];
      const report = JSON.parse(Buffer.from(content).toString("utf8")) as {
        readonly boundaryResults: { readonly entries: Array<Record<string, unknown>> };
      };
      entries.push(report.boundaryResults.entries[0] ?? {});
    }
    expect(entries[0]).toMatchObject({
      boundaryId: "bnd_report_live",
      effectCertainty: "confirmed",
      effectRetrySafety: v2LiveBoundaryResult().effectRetrySafety,
      output: { kind: "normalized_response" },
    });
    expect(entries[1]).toMatchObject({
      boundaryId: "bnd_report_recorded",
      effectCertainty: "none",
      output: {
        artifactCount: 0,
        kind: "recorded_artifacts",
        outputSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        resolutionSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        returnedArtifactsSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    });
    expect(entries[1]).not.toHaveProperty("effectRetrySafety");
  });

  it("rejects incomplete or mismatched v2 process evidence", async () => {
    const valid = processResultV2();
    const otherResult = v2BoundaryResult("bnd_unprojected");
    const cases: ReplayTargetProcessResult[] = [
      processResult({ runtime: valid.runtime }),
      processResultV2({ boundaryResults: [{ ...valid.boundaryResults[0], extra: true } as never] }),
      processResultV2({
        boundaryResults: [otherResult],
        executionObservations: v2ExecutionObservations(otherResult),
      }),
      processResultV2({
        executionObservations: v2ExecutionObservations().slice(0, -1),
      }),
      processResultV2({
        runtime: [
          ...valid.runtime,
          {
            boundaryId: "bnd_report_simulation",
            evidence: { fixedClockReadCount: 0, randomByteCount: 0, randomRequestCount: 0 },
            violated: false,
          },
        ],
      }),
    ];
    for (const candidate of cases) {
      await expectCode(
        v2Options(publisher(), { processResult: candidate }),
        "invalid_process_result",
      );
    }
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

  it("never adopts publication after cancellation", async () => {
    const before = new AbortController();
    before.abort("cancelled before publication");
    const skippedPublisher = publisher();
    await expectCode(options(skippedPublisher, { signal: before.signal }), "publish_cancelled");
    expect(skippedPublisher.publish).not.toHaveBeenCalled();

    const during = new AbortController();
    const cancelledPublisher = publisher(async () => {
      during.abort("cancelled during publication");
      throw new Error("publication aborted");
    });
    await expectCode(options(cancelledPublisher, { signal: during.signal }), "publish_cancelled");

    const after = new AbortController();
    const latePublisher = publisher(async (command) => {
      after.abort("cancelled as publication completed");
      return command.contentReference;
    });
    await expectCode(options(latePublisher, { signal: after.signal }), "publish_cancelled");
  });
});
