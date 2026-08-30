import { createHash } from "node:crypto";
import { ReplayBoundaryExecutionResultSchema } from "@proofstack/contracts";
import { describe, expect, it } from "vitest";
import { dispatchReplayBoundary, type ReplayBoundaryExecutorPorts } from "./boundary-dispatch.js";
import { ReplayBoundaryDispatchError } from "./errors.js";

const sha = (digit: string): string => digit.repeat(64);
const adapter = { name: "proofstack.boundary", version: "1.0.0" } as const;
const scope = {
  environmentId: "env_dispatch",
  projectId: "prj_dispatch",
  tenantId: "ten_dispatch",
} as const;
const fence = {
  attemptId: "att_dispatch_001",
  fencingToken: 1,
  jobId: "job_dispatch_001",
  leaseId: "lease_dispatch_001",
  recoveryEpoch: 1,
  workerId: "worker_dispatch_001",
} as const;

function request(kind: "data" | "model" | "retrieval" | "tool" = "model") {
  return {
    boundaryRequestId: "req_dispatch_001",
    kind,
    normalizedRequest: {
      adapter,
      bytes: Buffer.from("{}", "utf8").toString("base64url"),
      encoding: "base64url" as const,
    },
    schemaVersion: "0.1" as const,
  };
}

function actualRequest(kind: "data" | "model" | "retrieval" | "tool" = "model") {
  const candidate = request(kind);
  const bytes = Buffer.from(candidate.normalizedRequest.bytes, "base64url");
  return {
    adapter,
    boundaryRequestId: candidate.boundaryRequestId,
    kind,
    normalizedRequestSha256: createHash("sha256").update(bytes).digest("hex"),
    sizeBytes: bytes.byteLength,
  };
}

function qualification() {
  return {
    artifactId: "art_dispatch_qualification",
    classification: "internal" as const,
    mediaType: "application/json",
    sha256: sha("1"),
    sizeBytes: 2,
  };
}

function recordedDeclaration() {
  return {
    boundaryId: "bnd_recorded",
    invocation: {
      fixture: {
        definitionSha256: sha("2"),
        fixtureId: "fix_dispatch",
        fixtureVersionId: "fiv_dispatch_001",
      },
      invocationId: "rpi_dispatch_001",
      runtime: {
        boundaryMode: "recorded_stub" as const,
        clock: { instant: "2026-08-30T00:00:00.000Z", mode: "fixed" as const },
        isolation: { mode: "cooperative_in_process" as const },
        locale: "en-US",
        network: { policy: "deny_fallback" as const },
        random: {
          algorithm: "hmac_sha256_counter_v1" as const,
          mode: "seeded" as const,
          seedHex: sha("3"),
        },
        timeZone: "UTC",
      },
      schemaVersion: "0.1" as const,
      targetAdapter: adapter,
    },
    invocationDefinitionSha256: sha("4"),
    kind: "model" as const,
    mode: "recorded_stub" as const,
  };
}

function simulationDeclaration() {
  return {
    boundaryId: "bnd_simulation",
    configurationSha256: sha("5"),
    kind: "model" as const,
    mode: "simulation" as const,
    qualification: qualification(),
    seedHex: sha("6"),
    simulatorRelease: {
      definitionSha256: sha("7"),
      targetAdapter: { ...adapter, protocolVersion: "1.0.0" },
      targetId: "target_simulator",
      targetReleaseId: "release_simulator_001",
      workerProtocol: { name: "proofstack.replay-worker", version: "2.0.0" },
    },
  };
}

function liveDeclaration() {
  return {
    boundaryId: "bnd_live",
    credential: {
      credentialId: "cred_dispatch",
      credentialVersionId: "crv_dispatch_001",
    },
    destination: { hostname: "api.example.com", port: 443 as const, scheme: "https" as const },
    endpointProfile: {
      definitionSha256: sha("8"),
      endpointProfileId: "end_dispatch",
      endpointProfileVersion: "1.0.0",
    },
    kind: "model" as const,
    mode: "live_provider" as const,
    operation: "chat",
    requestLimits: { requestBytes: 32, responseBytes: 32 },
    sideEffect: { kind: "read_only" as const },
    usageSource: "measured" as const,
  };
}

function normalizedResponse() {
  const bytes = Buffer.from("{}", "utf8");
  return {
    adapter,
    bytes: bytes.toString("base64url"),
    encoding: "base64url" as const,
    normalizedResponseSha256: createHash("sha256").update(bytes).digest("hex"),
    sizeBytes: bytes.byteLength,
  };
}

function recordedResponse() {
  const actual = actualRequest();
  const recordedActual = {
    adapterName: actual.adapter.name,
    adapterVersion: actual.adapter.version,
    boundaryRequestId: actual.boundaryRequestId,
    kind: "model" as const,
    normalizedRequestSha256: actual.normalizedRequestSha256,
    sizeBytes: actual.sizeBytes,
  };
  const expected = {
    adapterName: actual.adapter.name,
    adapterVersion: actual.adapter.version,
    attemptId: "att_recorded_001",
    attemptSequence: 0,
    interactionId: "int_recorded_001",
    interactionSequence: 0,
    kind: "model" as const,
    normalizedRequestSha256: actual.normalizedRequestSha256,
  };
  return {
    artifacts: [],
    resolution: {
      actualRequest: recordedActual,
      expectedRequest: expected,
      recordedAttempt: {
        attempt: {
          artifacts: {
            inputMessagesArtifactId: "art_input",
            providerConfigurationArtifactId: "art_provider_configuration",
            providerRequestArtifactId: "art_provider_request",
          },
          attemptId: expected.attemptId,
          endedAt: "2026-08-30T00:00:01.000Z",
          errorType: "recorded_failure",
          normalizedRequest: {
            adapterName: actual.adapter.name,
            adapterVersion: actual.adapter.version,
            artifactId: "art_normalized",
            sha256: actual.normalizedRequestSha256,
          },
          outcome: "failed" as const,
          provider: {
            endpointProfileId: "end_recorded",
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
        interactionId: expected.interactionId,
        interactionSequence: expected.interactionSequence,
        kind: "model" as const,
      },
      returnedArtifacts: [],
    },
    schemaVersion: "0.1" as const,
  };
}

function recordedResult() {
  const declaration = recordedDeclaration();
  return {
    actualRequest: actualRequest(),
    boundaryId: declaration.boundaryId,
    declaration,
    effectCertainty: "none" as const,
    executionOrigin: "recorded" as const,
    mode: "recorded_stub" as const,
    output: { kind: "recorded_artifacts" as const, response: recordedResponse() },
    schemaVersion: "0.1" as const,
    usage: [
      {
        dimension: "modelRequests" as const,
        usage: { amount: 1, source: "measured" as const, status: "observed" as const },
      },
    ],
  };
}

function simulationRegistry(counter: { calls: number }) {
  return {
    resolve: async (
      query: Parameters<NonNullable<ReplayBoundaryExecutorPorts["simulation"]>["resolve"]>[0],
    ) => ({
      ...query,
      simulate: async () => {
        counter.calls += 1;
        return {
          response: normalizedResponse(),
          usage: [
            {
              dimension: "modelRequests" as const,
              usage: { amount: 1, source: "measured" as const, status: "observed" as const },
            },
          ],
        };
      },
    }),
  };
}

function liveRegistry(counter: { calls: number }) {
  return {
    resolve: async (
      query: Parameters<NonNullable<ReplayBoundaryExecutorPorts["liveProvider"]>["resolve"]>[0],
    ) => ({
      ...query,
      execute: async () => {
        counter.calls += 1;
        return {
          response: normalizedResponse(),
          usage: [
            {
              dimension: "modelRequests" as const,
              usage: { amount: 1, source: "measured" as const, status: "observed" as const },
            },
          ],
        };
      },
    }),
  };
}

async function expectDispatchCode(
  options: Parameters<typeof dispatchReplayBoundary>[0],
  code: string,
) {
  await expect(dispatchReplayBoundary(options)).rejects.toMatchObject({
    code,
    name: "ReplayBoundaryDispatchError",
  });
}

describe("dispatchReplayBoundary", () => {
  it("dispatches an exact recorded boundary only to the recorded executor", async () => {
    const calls = { live: 0, recorded: 0, simulation: 0 };
    const recordedCandidate = recordedResult();
    const parsedCandidate = ReplayBoundaryExecutionResultSchema.safeParse(recordedCandidate);
    expect(
      parsedCandidate.success,
      parsedCandidate.success ? undefined : parsedCandidate.error.message,
    ).toBe(true);
    const result = await dispatchReplayBoundary({
      declaration: recordedDeclaration(),
      ports: {
        liveProvider: liveRegistry({
          get calls() {
            return calls.live;
          },
          set calls(value) {
            calls.live = value;
          },
        }),
        recordedStub: {
          execute: async () => {
            calls.recorded += 1;
            return recordedCandidate;
          },
        },
        simulation: simulationRegistry({
          get calls() {
            return calls.simulation;
          },
          set calls(value) {
            calls.simulation = value;
          },
        }),
      },
      request: request(),
    });
    expect(calls).toEqual({ live: 0, recorded: 1, simulation: 0 });
    expect(result.mode).toBe("recorded_stub");
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("dispatches simulation and live modes through their exact registries", async () => {
    const simulationCalls = { calls: 0 };
    const liveCalls = { calls: 0 };
    const simulation = await dispatchReplayBoundary({
      declaration: simulationDeclaration(),
      ports: { simulation: simulationRegistry(simulationCalls) },
      request: request(),
    });
    const live = await dispatchReplayBoundary({
      declaration: liveDeclaration(),
      ports: { liveProvider: liveRegistry(liveCalls) },
      request: request(),
      scope,
      workerFence: fence,
    });
    expect({ liveCalls: liveCalls.calls, simulationCalls: simulationCalls.calls }).toEqual({
      liveCalls: 1,
      simulationCalls: 1,
    });
    expect(simulation.mode).toBe("simulation");
    expect(live.mode).toBe("live_provider");
  });

  it("never falls through to another mode when the selected executor is absent", async () => {
    let recordedCalls = 0;
    for (const declaration of [recordedDeclaration(), simulationDeclaration(), liveDeclaration()]) {
      await expectDispatchCode(
        {
          declaration,
          ports:
            declaration.mode === "recorded_stub"
              ? {}
              : {
                  recordedStub: {
                    execute: async () => {
                      recordedCalls += 1;
                      return recordedResult();
                    },
                  },
                },
          request: request(),
          scope,
          workerFence: fence,
        },
        "selected_executor_unavailable",
      );
    }
    expect(recordedCalls).toBe(0);
  });

  it("preserves selected-executor failures without attempting fallback", async () => {
    const selectedFailure = new Error("selected simulator failed");
    let recordedCalls = 0;
    await expect(
      dispatchReplayBoundary({
        declaration: simulationDeclaration(),
        ports: {
          recordedStub: {
            execute: async () => {
              recordedCalls += 1;
              return recordedResult();
            },
          },
          simulation: {
            resolve: async () => {
              throw selectedFailure;
            },
          },
        },
        request: request(),
      }),
    ).rejects.toMatchObject({ code: "simulator_unavailable" });
    expect(recordedCalls).toBe(0);
  });

  it("rejects invalid input and cancellation before any executor is selected", async () => {
    let calls = 0;
    const ports: ReplayBoundaryExecutorPorts = {
      recordedStub: {
        execute: async () => {
          calls += 1;
          return recordedResult();
        },
      },
    };
    await expectDispatchCode(
      { declaration: { ...recordedDeclaration(), fallback: "live" }, ports, request: request() },
      "invalid_declaration",
    );
    await expectDispatchCode(
      { declaration: recordedDeclaration(), ports, request: { ...request(), retry: true } },
      "invalid_request",
    );
    const controller = new AbortController();
    controller.abort("shutdown");
    await expectDispatchCode(
      { declaration: recordedDeclaration(), ports, request: request(), signal: controller.signal },
      "cancelled",
    );
    expect(calls).toBe(0);
  });

  it("rejects selected-executor results that change declaration or request identity", async () => {
    for (const candidate of [
      { ...recordedResult(), boundaryId: "bnd_wrong" },
      { ...recordedResult(), actualRequest: { ...actualRequest(), sizeBytes: 3 } },
      { ...recordedResult(), extra: true },
    ]) {
      await expectDispatchCode(
        {
          declaration: recordedDeclaration(),
          ports: { recordedStub: { execute: async () => candidate } },
          request: request(),
        },
        "result_mismatch",
      );
    }
  });

  it("returns a dedicated typed dispatch error without retaining a cause", () => {
    const error = new ReplayBoundaryDispatchError("result_mismatch");
    expect(error).toMatchObject({
      code: "result_mismatch",
      message: "Replay boundary dispatch failed: result_mismatch",
      name: "ReplayBoundaryDispatchError",
    });
    expect(error).not.toHaveProperty("cause");
  });
});
