import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  executeSimulationBoundary,
  type ReplaySimulatorInvocation,
  type ReplaySimulatorRegistry,
  type ReplaySimulatorRegistryQuery,
  type ResolvedReplaySimulator,
} from "./simulation-boundary.js";

const sha = (digit: string): string => digit.repeat(64);
const responseBytes = Buffer.from("{}", "utf8");
const responseSha256 = createHash("sha256").update(responseBytes).digest("hex");

function declaration() {
  return {
    boundaryId: "bnd_simulation",
    configurationSha256: sha("1"),
    kind: "model" as const,
    mode: "simulation" as const,
    qualification: {
      artifactId: "art_simulator_qualification",
      classification: "internal" as const,
      mediaType: "application/json",
      sha256: sha("2"),
      sizeBytes: 128,
    },
    seedHex: sha("3"),
    simulatorRelease: {
      definitionSha256: sha("4"),
      targetAdapter: {
        name: "proofstack.simulator",
        protocolVersion: "1.0.0",
        version: "1.0.0",
      },
      targetId: "simulator_reference",
      targetReleaseId: "simulator_release_001",
      workerProtocol: { name: "proofstack.replay-worker", version: "2.0.0" },
    },
  };
}

function request(kind: "data" | "model" | "retrieval" | "tool" = "model") {
  return {
    boundaryRequestId: "req_simulation_001",
    kind,
    normalizedRequest: {
      adapter: { name: "proofstack.target.model", version: "1.0.0" },
      bytes: Buffer.from("request", "utf8").toString("base64url"),
      encoding: "base64url" as const,
    },
    schemaVersion: "0.1" as const,
  };
}

function outcome(
  overrides: Partial<{
    readonly response: Readonly<Record<string, unknown>>;
    readonly usage: readonly unknown[];
  }> = {},
) {
  return {
    response: {
      adapter: request().normalizedRequest.adapter,
      bytes: responseBytes.toString("base64url"),
      encoding: "base64url" as const,
      normalizedResponseSha256: responseSha256,
      sizeBytes: responseBytes.byteLength,
      ...overrides.response,
    },
    usage: overrides.usage ?? [
      {
        dimension: "modelRequests" as const,
        usage: { amount: 1, source: "measured" as const, status: "observed" as const },
      },
    ],
  };
}

function registry(
  options: {
    readonly mutateResolved?: (resolved: ResolvedReplaySimulator) => ResolvedReplaySimulator | null;
    readonly onResolve?: (query: ReplaySimulatorRegistryQuery, signal: AbortSignal) => void;
    readonly simulate?: (input: ReplaySimulatorInvocation) => Promise<unknown>;
  } = {},
): ReplaySimulatorRegistry {
  return {
    resolve: async (query, signal) => {
      options.onResolve?.(query, signal);
      const resolved: ResolvedReplaySimulator = {
        ...query,
        simulate: options.simulate ?? (async () => outcome()),
      };
      return options.mutateResolved?.(resolved) ?? resolved;
    },
  };
}

async function expectCode(
  options: Parameters<typeof executeSimulationBoundary>[0],
  code: string,
): Promise<void> {
  await expect(executeSimulationBoundary(options)).rejects.toMatchObject({
    code,
    name: "ReplaySimulationBoundaryError",
  });
}

describe("executeSimulationBoundary", () => {
  it("resolves and executes one exact deterministic simulator", async () => {
    let resolvedQuery: ReplaySimulatorRegistryQuery | undefined;
    let invocation: ReplaySimulatorInvocation | undefined;
    const candidateRequest = request();
    const result = await executeSimulationBoundary({
      declaration: declaration(),
      registry: registry({
        onResolve: (query) => {
          resolvedQuery = query;
        },
        simulate: async (input) => {
          invocation = input;
          return outcome();
        },
      }),
      request: candidateRequest,
    });

    expect(resolvedQuery).toEqual({
      configurationSha256: declaration().configurationSha256,
      qualification: declaration().qualification,
      simulatorRelease: declaration().simulatorRelease,
    });
    expect(Object.isFrozen(resolvedQuery)).toBe(true);
    expect(Object.isFrozen(resolvedQuery?.qualification)).toBe(true);
    expect(Object.isFrozen(resolvedQuery?.simulatorRelease.targetAdapter)).toBe(true);
    expect(invocation).toMatchObject({
      configurationSha256: declaration().configurationSha256,
      request: candidateRequest,
      seedHex: declaration().seedHex,
    });
    expect(Object.isFrozen(invocation?.request)).toBe(true);
    expect(Object.isFrozen(invocation?.request.normalizedRequest.adapter)).toBe(true);
    expect(result).toMatchObject({
      actualRequest: {
        adapter: candidateRequest.normalizedRequest.adapter,
        boundaryRequestId: candidateRequest.boundaryRequestId,
        kind: "model",
        normalizedRequestSha256: createHash("sha256")
          .update(Buffer.from(candidateRequest.normalizedRequest.bytes, "base64url"))
          .digest("hex"),
        sizeBytes: 7,
      },
      boundaryId: declaration().boundaryId,
      declaration: declaration(),
      effectCertainty: "none",
      executionOrigin: "simulated",
      mode: "simulation",
      output: { kind: "normalized_response", response: outcome().response },
      usage: outcome().usage,
    });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it.each([
    ["non-object", "invalid"],
    ["null", null],
    ["array", []],
    [
      "wrong mode",
      {
        boundaryId: "bnd_live",
        credential: {
          credentialId: "cred_reference",
          credentialVersionId: "crv_reference_001",
        },
        destination: { hostname: "api.example.com", port: 443, scheme: "https" },
        endpointProfile: {
          definitionSha256: sha("5"),
          endpointProfileId: "end_reference",
          endpointProfileVersion: "1.0.0",
        },
        kind: "model",
        mode: "live_provider",
        operation: "chat",
        requestLimits: { requestBytes: 4_096, responseBytes: 65_536 },
        sideEffect: { kind: "read_only" },
        usageSource: "measured",
      },
    ],
  ])("rejects an invalid %s declaration", async (_name, candidate) => {
    await expectCode(
      { declaration: candidate, registry: registry(), request: request() },
      "invalid_declaration",
    );
  });

  it.each([
    ["non-object", "invalid"],
    ["unknown field", { ...request(), fallback: "live" }],
  ])("rejects an invalid %s request", async (_name, candidate) => {
    await expectCode(
      { declaration: declaration(), registry: registry(), request: candidate },
      "invalid_request",
    );
  });

  it("rejects a request kind that differs from the immutable declaration", async () => {
    await expectCode(
      { declaration: declaration(), registry: registry(), request: request("tool") },
      "request_kind_mismatch",
    );
  });

  it("honors cancellation before registry resolution", async () => {
    const controller = new AbortController();
    controller.abort(new Error("shutdown"));
    await expectCode(
      {
        declaration: declaration(),
        registry: {
          resolve: async () => {
            throw new Error("registry must not run");
          },
        },
        request: request(),
        signal: controller.signal,
      },
      "cancelled",
    );
  });

  it("maps registry failure and absence without changing boundary mode", async () => {
    await expectCode(
      {
        declaration: declaration(),
        registry: { resolve: async () => null },
        request: request(),
      },
      "simulator_unavailable",
    );
    await expectCode(
      {
        declaration: declaration(),
        registry: {
          resolve: async () => {
            throw new Error("registry offline");
          },
        },
        request: request(),
      },
      "simulator_unavailable",
    );
  });

  it("honors cancellation committed during registry resolution", async () => {
    const controller = new AbortController();
    await expectCode(
      {
        declaration: declaration(),
        registry: registry({ onResolve: () => controller.abort("shutdown") }),
        request: request(),
        signal: controller.signal,
      },
      "cancelled",
    );
  });

  it.each([
    [
      "configuration",
      (resolved: ResolvedReplaySimulator) => ({
        ...resolved,
        configurationSha256: sha("f"),
      }),
    ],
    [
      "qualification",
      (resolved: ResolvedReplaySimulator) => ({
        ...resolved,
        qualification: { ...resolved.qualification, artifactId: "art_wrong" },
      }),
    ],
    [
      "release",
      (resolved: ResolvedReplaySimulator) => ({
        ...resolved,
        simulatorRelease: { ...resolved.simulatorRelease, targetReleaseId: "release_wrong" },
      }),
    ],
    ["implementation", (resolved: ResolvedReplaySimulator) => ({ ...resolved, simulate: null })],
  ])("rejects a mismatched simulator %s", async (_name, mutate) => {
    await expectCode(
      {
        declaration: declaration(),
        registry: registry({
          mutateResolved: (resolved) => mutate(resolved) as ResolvedReplaySimulator,
        }),
        request: request(),
      },
      "simulator_identity_mismatch",
    );
  });

  it("maps simulator failures and cancellation separately", async () => {
    await expectCode(
      {
        declaration: declaration(),
        registry: registry({
          simulate: async () => {
            throw new Error("simulation failed");
          },
        }),
        request: request(),
      },
      "simulator_failed",
    );

    const controller = new AbortController();
    await expectCode(
      {
        declaration: declaration(),
        registry: registry({
          simulate: async () => {
            controller.abort("shutdown");
            throw new Error("cancelled simulator");
          },
        }),
        request: request(),
        signal: controller.signal,
      },
      "cancelled",
    );
  });

  it("discards a late simulator result after cancellation", async () => {
    const controller = new AbortController();
    await expectCode(
      {
        declaration: declaration(),
        registry: registry({
          simulate: async () => {
            controller.abort("shutdown");
            return outcome();
          },
        }),
        request: request(),
        signal: controller.signal,
      },
      "cancelled",
    );
  });

  it.each([
    ["non-object", "invalid"],
    ["null", null],
    ["array", []],
    ["extra field", { ...outcome(), extra: true }],
    ["missing response", { usage: [] }],
    ["missing usage", { response: outcome().response }],
    [
      "response adapter",
      outcome({ response: { adapter: { name: "wrong.adapter", version: "1.0.0" } } }),
    ],
    ["response size", outcome({ response: { sizeBytes: 3 } })],
    ["response digest", outcome({ response: { normalizedResponseSha256: sha("e") } })],
    [
      "provider-reported usage",
      outcome({
        usage: [
          {
            dimension: "modelRequests",
            usage: { amount: 1, source: "provider_reported", status: "observed" },
          },
        ],
      }),
    ],
    ["invalid response schema", outcome({ response: { bytes: "not base64" } })],
    ["invalid usage schema", outcome({ usage: [{ dimension: "unknown", usage: {} }] })],
  ])("rejects an inconsistent %s simulator result", async (_name, candidate) => {
    await expectCode(
      {
        declaration: declaration(),
        registry: registry({ simulate: async () => candidate }),
        request: request(),
      },
      "invalid_simulator_result",
    );
  });

  it("accepts unavailable and estimated simulator usage without provider claims", async () => {
    const result = await executeSimulationBoundary({
      declaration: declaration(),
      registry: registry({
        simulate: async () =>
          outcome({
            usage: [
              {
                dimension: "inputTokens",
                usage: { amount: 2, source: "estimated", status: "observed" },
              },
              {
                dimension: "outputTokens",
                usage: { reason: "measurement_failed", status: "unavailable" },
              },
            ],
          }),
      }),
      request: request(),
    });
    expect(result.usage).toHaveLength(2);
  });

  it("does not expose caller request objects for simulator mutation", async () => {
    const callerRequest = request();
    await executeSimulationBoundary({
      declaration: declaration(),
      registry: registry({
        simulate: async ({ request: parsed }) => {
          expect(parsed).not.toBe(callerRequest);
          expect(() => {
            (parsed as { kind: string }).kind = "tool";
          }).toThrow();
          return outcome();
        },
      }),
      request: callerRequest,
    });
    expect(callerRequest.kind).toBe("model");
  });
});
