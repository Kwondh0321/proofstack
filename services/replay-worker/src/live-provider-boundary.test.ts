import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ReplayLiveProviderBoundaryError } from "./errors.js";
import {
  executeLiveProviderBoundary,
  type ReplayLiveProviderInvocation,
  ReplayLiveProviderPortError,
  type ReplayLiveProviderPortErrorCode,
  type ReplayLiveProviderRegistry,
  type ReplayLiveProviderRegistryQuery,
  type ResolvedReplayLiveProvider,
} from "./live-provider-boundary.js";

const sha = (digit: string): string => digit.repeat(64);
const scope = {
  environmentId: "env_live",
  projectId: "prj_live",
  tenantId: "ten_live",
} as const;
const fence = {
  attemptId: "att_live_001",
  fencingToken: 3,
  jobId: "job_live_001",
  leaseId: "lease_live_001",
  recoveryEpoch: 1,
  workerId: "worker_live_001",
} as const;

type SideEffect =
  | { readonly kind: "read_only" }
  | {
      readonly idempotencyKeyScheme: string;
      readonly kind: "idempotent_write";
      readonly sandboxDestination: true;
    }
  | {
      readonly automaticRetry: false;
      readonly kind: "non_idempotent_write";
      readonly riskAcceptance: ReturnType<typeof riskAcceptance>;
    };

function riskAcceptance() {
  return {
    artifactId: "art_risk_acceptance",
    classification: "restricted" as const,
    mediaType: "application/json",
    sha256: sha("1"),
    sizeBytes: 128,
  };
}

function declaration(
  sideEffect: SideEffect = { kind: "read_only" },
  options: {
    readonly requestBytes?: number;
    readonly responseBytes?: number;
    readonly usageSource?: "estimated" | "measured" | "provider_reported" | "unavailable";
  } = {},
) {
  return {
    boundaryId: "bnd_live",
    credential: {
      credentialId: "cred_provider",
      credentialVersionId: "crv_provider_001",
    },
    destination: { hostname: "api.example.com", port: 443 as const, scheme: "https" as const },
    endpointProfile: {
      definitionSha256: sha("2"),
      endpointProfileId: "end_provider",
      endpointProfileVersion: "1.0.0",
    },
    kind: "model" as const,
    mode: "live_provider" as const,
    operation: "chat",
    requestLimits: {
      requestBytes: options.requestBytes ?? 64,
      responseBytes: options.responseBytes ?? 64,
    },
    sideEffect,
    usageSource: options.usageSource ?? ("measured" as const),
  };
}

function request(bytes = "request", kind: "data" | "model" | "retrieval" | "tool" = "model") {
  return {
    boundaryRequestId: "req_live_001",
    kind,
    normalizedRequest: {
      adapter: { name: "proofstack.target.model", version: "1.0.0" },
      bytes: Buffer.from(bytes, "utf8").toString("base64url"),
      encoding: "base64url" as const,
    },
    schemaVersion: "0.1" as const,
  };
}

function outcome(
  options: {
    readonly responseBytes?: Buffer;
    readonly responsePatch?: Readonly<Record<string, unknown>>;
    readonly usage?: readonly unknown[];
  } = {},
) {
  const bytes = options.responseBytes ?? Buffer.from("{}", "utf8");
  return {
    response: {
      adapter: request().normalizedRequest.adapter,
      bytes: bytes.toString("base64url"),
      encoding: "base64url" as const,
      normalizedResponseSha256: createHash("sha256").update(bytes).digest("hex"),
      sizeBytes: bytes.byteLength,
      ...options.responsePatch,
    },
    usage: options.usage ?? [
      {
        dimension: "modelRequests" as const,
        usage: { amount: 1, source: "measured" as const, status: "observed" as const },
      },
    ],
  };
}

function registry(
  options: {
    readonly execute?: (input: ReplayLiveProviderInvocation) => Promise<unknown>;
    readonly mutate?: (resolved: ResolvedReplayLiveProvider) => ResolvedReplayLiveProvider | null;
    readonly onResolve?: (query: ReplayLiveProviderRegistryQuery, signal: AbortSignal) => void;
  } = {},
): ReplayLiveProviderRegistry {
  return {
    resolve: async (query, signal) => {
      options.onResolve?.(query, signal);
      const resolved: ResolvedReplayLiveProvider = {
        ...query,
        ...(query.sideEffect.kind === "idempotent_write"
          ? {
              destinationIdempotency: {
                evidenceSha256: sha("d"),
                idempotencyKeyScheme: query.sideEffect.idempotencyKeyScheme,
              },
            }
          : {}),
        execute: options.execute ?? (async () => outcome()),
      };
      return options.mutate?.(resolved) ?? resolved;
    },
  };
}

function executionOptions(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    declaration: declaration(),
    registry: registry(),
    request: request(),
    scope,
    workerFence: fence,
    ...overrides,
  };
}

async function captureError(overrides: Readonly<Record<string, unknown>>) {
  try {
    await executeLiveProviderBoundary(executionOptions(overrides));
    throw new Error("Expected live boundary failure");
  } catch (error) {
    expect(error).toBeInstanceOf(ReplayLiveProviderBoundaryError);
    return error as ReplayLiveProviderBoundaryError;
  }
}

async function expectCode(
  overrides: Readonly<Record<string, unknown>>,
  code: string,
): Promise<ReplayLiveProviderBoundaryError> {
  const error = await captureError(overrides);
  expect(error).toMatchObject({ code, effectCertainty: expect.any(String) });
  return error;
}

const idempotent = {
  idempotencyKeyScheme: "proofstack.boundary.v1",
  kind: "idempotent_write" as const,
  sandboxDestination: true as const,
};

describe("executeLiveProviderBoundary", () => {
  it("executes one exact read-only provider without credential plaintext", async () => {
    let resolvedQuery: ReplayLiveProviderRegistryQuery | undefined;
    let invocation: ReplayLiveProviderInvocation | undefined;
    const result = await executeLiveProviderBoundary(
      executionOptions({
        registry: registry({
          execute: async (input) => {
            invocation = input;
            return outcome();
          },
          onResolve: (query) => {
            resolvedQuery = query;
          },
        }),
      }),
    );

    expect(resolvedQuery).toEqual({
      destination: declaration().destination,
      endpointProfile: declaration().endpointProfile,
      operation: declaration().operation,
      sideEffect: declaration().sideEffect,
    });
    expect(Object.isFrozen(resolvedQuery)).toBe(true);
    expect(Object.isFrozen(resolvedQuery?.destination)).toBe(true);
    expect(Object.isFrozen(resolvedQuery?.endpointProfile)).toBe(true);
    expect(Object.isFrozen(resolvedQuery?.sideEffect)).toBe(true);
    expect(invocation).toMatchObject({
      credential: declaration().credential,
      request: request(),
      scope,
    });
    expect(invocation).not.toHaveProperty("idempotencyKey");
    expect(Object.keys(invocation?.credential ?? {})).toEqual([
      "credentialId",
      "credentialVersionId",
    ]);
    expect(JSON.stringify(invocation)).not.toContain("secret");
    expect(Object.isFrozen(invocation?.credential)).toBe(true);
    expect(Object.isFrozen(invocation?.request)).toBe(true);
    expect(Object.isFrozen(invocation?.scope)).toBe(true);
    expect(result).toMatchObject({
      boundaryId: declaration().boundaryId,
      declaration: declaration(),
      effectCertainty: "none",
      executionOrigin: "live",
      mode: "live_provider",
      output: { kind: "normalized_response", response: outcome().response },
      usage: outcome().usage,
    });
    expect(result).not.toHaveProperty("effectRetrySafety");
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("derives a stable job-scoped destination idempotency key", async () => {
    const keys: string[] = [];
    const execute = async (input: ReplayLiveProviderInvocation) => {
      keys.push(input.idempotencyKey ?? "");
      return outcome();
    };
    const writeDeclaration = declaration(idempotent);
    const first = await executeLiveProviderBoundary(
      executionOptions({ declaration: writeDeclaration, registry: registry({ execute }) }),
    );
    await executeLiveProviderBoundary(
      executionOptions({
        declaration: writeDeclaration,
        registry: registry({ execute }),
        workerFence: { ...fence, attemptId: "att_live_002", fencingToken: 4 },
      }),
    );
    await executeLiveProviderBoundary(
      executionOptions({
        declaration: writeDeclaration,
        registry: registry({ execute }),
        scope: {
          tenantId: scope.tenantId,
          environmentId: scope.environmentId,
          projectId: scope.projectId,
        },
      }),
    );
    await executeLiveProviderBoundary(
      executionOptions({
        declaration: writeDeclaration,
        registry: registry({ execute }),
        workerFence: { ...fence, jobId: "job_live_002" },
      }),
    );
    expect(keys[0]).toMatch(/^psk_[0-9a-f]{64}$/);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).toBe(keys[0]);
    expect(keys[3]).not.toBe(keys[0]);
    expect(first).toMatchObject({
      effectCertainty: "confirmed",
      effectRetrySafety: {
        evidenceSha256: sha("d"),
        idempotencyKeySha256: createHash("sha256")
          .update(keys[0] ?? "")
          .digest("hex"),
        kind: "destination_idempotency_verified",
      },
    });
  });

  it.each([
    ["non-object", "invalid"],
    ["null", null],
    ["array", []],
    [
      "simulation",
      {
        boundaryId: "bnd_sim",
        configurationSha256: sha("3"),
        kind: "model",
        mode: "simulation",
        qualification: riskAcceptance(),
        seedHex: sha("4"),
        simulatorRelease: {
          definitionSha256: sha("5"),
          targetAdapter: {
            name: "proofstack.simulator",
            protocolVersion: "1.0.0",
            version: "1.0.0",
          },
          targetId: "target_simulator",
          targetReleaseId: "release_simulator",
          workerProtocol: { name: "proofstack.replay-worker", version: "2.0.0" },
        },
      },
    ],
  ])("rejects an invalid %s declaration", async (_name, candidate) => {
    await expectCode({ declaration: candidate }, "invalid_declaration");
  });

  it("denies non-idempotent writes before registry resolution", async () => {
    let resolved = false;
    const error = await expectCode(
      {
        declaration: declaration({
          automaticRetry: false,
          kind: "non_idempotent_write",
          riskAcceptance: riskAcceptance(),
        }),
        registry: registry({ onResolve: () => (resolved = true) }),
      },
      "non_idempotent_write_denied",
    );
    expect(resolved).toBe(false);
    expect(error.effectCertainty).toBe("none");
  });

  it.each([
    ["non-object", "invalid"],
    ["unknown field", { ...request(), credential: "secret" }],
  ])("rejects an invalid %s request", async (_name, candidate) => {
    await expectCode({ request: candidate }, "invalid_request");
  });

  it("requires exact scope and worker-fence context", async () => {
    await expectCode({ scope: { ...scope, extra: true } }, "invalid_context");
    await expectCode({ workerFence: { ...fence, fencingToken: 0 } }, "invalid_context");
  });

  it("rejects request kind mismatch and oversized normalized requests", async () => {
    await expectCode({ request: request("request", "tool") }, "request_kind_mismatch");
    await expectCode(
      { declaration: declaration({ kind: "read_only" }, { requestBytes: 2 }) },
      "request_too_large",
    );
  });

  it("honors cancellation before and during registry resolution", async () => {
    const before = new AbortController();
    before.abort("shutdown");
    await expectCode({ signal: before.signal }, "cancelled");

    const during = new AbortController();
    await expectCode(
      {
        registry: registry({ onResolve: () => during.abort("shutdown") }),
        signal: during.signal,
      },
      "cancelled",
    );
  });

  it("maps registry failure and absence without provider execution", async () => {
    await expectCode({ registry: { resolve: async () => null } }, "provider_unavailable");
    await expectCode(
      {
        registry: {
          resolve: async () => {
            throw new Error("registry failed with secret-token");
          },
        },
      },
      "provider_unavailable",
    );
  });

  it.each([
    [
      "destination",
      (value: ResolvedReplayLiveProvider) => ({
        ...value,
        destination: { ...value.destination, hostname: "other.example.com" },
      }),
    ],
    [
      "endpoint profile",
      (value: ResolvedReplayLiveProvider) => ({
        ...value,
        endpointProfile: { ...value.endpointProfile, endpointProfileId: "end_other" },
      }),
    ],
    ["operation", (value: ResolvedReplayLiveProvider) => ({ ...value, operation: "other" })],
    [
      "side effect",
      (value: ResolvedReplayLiveProvider) => ({
        ...value,
        sideEffect: idempotent,
      }),
    ],
    ["implementation", (value: ResolvedReplayLiveProvider) => ({ ...value, execute: null })],
  ])("rejects a mismatched provider %s", async (_name, mutate) => {
    await expectCode(
      {
        registry: registry({
          mutate: (value) => mutate(value) as ResolvedReplayLiveProvider,
        }),
      },
      "provider_identity_mismatch",
    );
  });

  it.each([
    [
      "missing",
      (value: ResolvedReplayLiveProvider) => ({
        ...value,
        destinationIdempotency: undefined,
      }),
    ],
    [
      "scheme",
      (value: ResolvedReplayLiveProvider) => ({
        ...value,
        destinationIdempotency: {
          evidenceSha256: sha("d"),
          idempotencyKeyScheme: "wrong.scheme",
        },
      }),
    ],
    [
      "digest",
      (value: ResolvedReplayLiveProvider) => ({
        ...value,
        destinationIdempotency: {
          evidenceSha256: "invalid",
          idempotencyKeyScheme: idempotent.idempotencyKeyScheme,
        },
      }),
    ],
  ])("requires exact destination idempotency %s evidence", async (_name, mutate) => {
    await expectCode(
      {
        declaration: declaration(idempotent),
        registry: registry({
          mutate: (value) => mutate(value) as ResolvedReplayLiveProvider,
        }),
      },
      "provider_identity_mismatch",
    );
  });

  it("rejects destination idempotency evidence on a read-only provider", async () => {
    await expectCode(
      {
        registry: registry({
          mutate: (value) => ({
            ...value,
            destinationIdempotency: {
              evidenceSha256: sha("d"),
              idempotencyKeyScheme: idempotent.idempotencyKeyScheme,
            },
          }),
        }),
      },
      "provider_identity_mismatch",
    );
  });

  it.each([
    ["credential_unavailable", "credential_unavailable"],
    ["provider_failed", "provider_failed"],
    ["rate_limited", "provider_rate_limited"],
    ["request_rejected", "request_rejected"],
    ["temporarily_unavailable", "provider_temporarily_unavailable"],
  ] as const)("maps a pre-request %s port failure", async (portCode, boundaryCode) => {
    const error = await expectCode(
      {
        registry: registry({
          execute: async () => {
            throw new ReplayLiveProviderPortError(portCode, false);
          },
        }),
      },
      boundaryCode,
    );
    expect(error.effectCertainty).toBe("none");
    expect(error).not.toHaveProperty("cause");
  });

  it("rejects a credential-unavailable claim made after a request started", async () => {
    const error = await expectCode(
      {
        declaration: declaration(idempotent),
        registry: registry({
          execute: async () => {
            throw new ReplayLiveProviderPortError("credential_unavailable", true);
          },
        }),
      },
      "provider_contract_failed",
    );
    expect(error).toMatchObject({
      effectCertainty: "may_have_occurred",
      effectRetrySafety: { kind: "destination_idempotency_verified" },
    });
  });

  it.each([
    "provider_failed",
    "rate_limited",
    "request_rejected",
    "temporarily_unavailable",
  ] as const)("preserves possible idempotent effects for %s", async (portCode) => {
    const error = await expectCode(
      {
        declaration: declaration(idempotent),
        registry: registry({
          execute: async () => {
            throw new ReplayLiveProviderPortError(portCode, true);
          },
        }),
      },
      {
        provider_failed: "provider_failed",
        rate_limited: "provider_rate_limited",
        request_rejected: "request_rejected",
        temporarily_unavailable: "provider_temporarily_unavailable",
      }[portCode],
    );
    expect(error).toMatchObject({
      effectCertainty: "may_have_occurred",
      effectRetrySafety: { kind: "destination_idempotency_verified" },
    });
  });

  it("sanitizes unknown provider errors and preserves conservative effects", async () => {
    const secret = "provider-secret-value";
    const readError = await expectCode(
      {
        registry: registry({
          execute: async () => {
            throw new Error(secret);
          },
        }),
      },
      "provider_failed",
    );
    expect(readError.effectCertainty).toBe("none");
    expect(JSON.stringify(readError)).not.toContain(secret);
    expect(readError).not.toHaveProperty("cause");

    const writeError = await expectCode(
      {
        declaration: declaration(idempotent),
        registry: registry({
          execute: async () => {
            throw new Error(secret);
          },
        }),
      },
      "provider_failed",
    );
    expect(writeError.effectCertainty).toBe("may_have_occurred");
  });

  it("maps cancellation during a provider call without losing effect uncertainty", async () => {
    const readController = new AbortController();
    const readError = await expectCode(
      {
        registry: registry({
          execute: async () => {
            readController.abort("shutdown");
            throw new ReplayLiveProviderPortError("provider_failed", true);
          },
        }),
        signal: readController.signal,
      },
      "cancelled",
    );
    expect(readError.effectCertainty).toBe("none");

    const writeController = new AbortController();
    const writeError = await expectCode(
      {
        declaration: declaration(idempotent),
        registry: registry({
          execute: async () => {
            writeController.abort("shutdown");
            throw new Error("uninterruptible write");
          },
        }),
        signal: writeController.signal,
      },
      "cancelled",
    );
    expect(writeError).toMatchObject({
      effectCertainty: "may_have_occurred",
      effectRetrySafety: { kind: "destination_idempotency_verified" },
    });
  });

  it("preserves a successful late response after cancellation", async () => {
    const controller = new AbortController();
    const result = await executeLiveProviderBoundary(
      executionOptions({
        declaration: declaration(idempotent),
        registry: registry({
          execute: async () => {
            controller.abort("shutdown");
            return outcome();
          },
        }),
        signal: controller.signal,
      }),
    );
    expect(result.effectCertainty).toBe("confirmed");
  });

  it.each([
    ["non-object", "invalid"],
    ["null", null],
    ["array", []],
    ["extra field", { ...outcome(), credential: "secret" }],
    ["missing response", { usage: [] }],
    ["missing usage", { response: outcome().response }],
    ["response schema", outcome({ responsePatch: { bytes: "not base64" } })],
    ["usage schema", outcome({ usage: [{ dimension: "unknown", usage: {} }] })],
    [
      "response adapter",
      outcome({
        responsePatch: { adapter: { name: "wrong.adapter", version: "1.0.0" } },
      }),
    ],
    ["response size", outcome({ responsePatch: { sizeBytes: 3 } })],
    ["response limit", outcome({ responseBytes: Buffer.alloc(65, 1) })],
    ["response digest", outcome({ responsePatch: { normalizedResponseSha256: sha("f") } })],
    [
      "usage source",
      outcome({
        usage: [
          {
            dimension: "modelRequests",
            usage: { amount: 1, source: "estimated", status: "observed" },
          },
        ],
      }),
    ],
  ])("rejects an inconsistent %s provider result", async (_name, candidate) => {
    await expectCode(
      { registry: registry({ execute: async () => candidate }) },
      "invalid_provider_result",
    );
  });

  it("accepts exact provider-reported and unavailable usage", async () => {
    const reported = await executeLiveProviderBoundary(
      executionOptions({
        declaration: declaration({ kind: "read_only" }, { usageSource: "provider_reported" }),
        registry: registry({
          execute: async () =>
            outcome({
              usage: [
                {
                  dimension: "providerCostMicrounits",
                  usage: { amount: 3, source: "provider_reported", status: "observed" },
                },
              ],
            }),
        }),
      }),
    );
    const unavailable = await executeLiveProviderBoundary(
      executionOptions({
        declaration: declaration({ kind: "read_only" }, { usageSource: "unavailable" }),
        registry: registry({
          execute: async () =>
            outcome({
              usage: [
                {
                  dimension: "providerCostMicrounits",
                  usage: { reason: "provider_did_not_report", status: "unavailable" },
                },
              ],
            }),
        }),
      }),
    );
    expect(reported.usage[0]?.usage).toMatchObject({ source: "provider_reported" });
    expect(unavailable.usage[0]?.usage).toMatchObject({ status: "unavailable" });

    await expectCode(
      {
        declaration: declaration({ kind: "read_only" }, { usageSource: "unavailable" }),
        registry: registry({ execute: async () => outcome() }),
      },
      "invalid_provider_result",
    );
  });

  it("does not expose mutable caller request or scope objects", async () => {
    const callerRequest = request();
    const callerScope = { ...scope };
    await executeLiveProviderBoundary(
      executionOptions({
        registry: registry({
          execute: async (input) => {
            expect(input.request).not.toBe(callerRequest);
            expect(input.scope).not.toBe(callerScope);
            expect(() => {
              (input.request as { kind: string }).kind = "tool";
            }).toThrow();
            expect(() => {
              (input.scope as { tenantId: string }).tenantId = "ten_other";
            }).toThrow();
            return outcome();
          },
        }),
        request: callerRequest,
        scope: callerScope,
      }),
    );
    expect(callerRequest.kind).toBe("model");
    expect(callerScope.tenantId).toBe(scope.tenantId);
  });

  it("constructs generic port errors without retaining provider details", () => {
    for (const code of [
      "credential_unavailable",
      "provider_failed",
      "rate_limited",
      "request_rejected",
      "temporarily_unavailable",
    ] satisfies ReplayLiveProviderPortErrorCode[]) {
      const error = new ReplayLiveProviderPortError(code, false);
      expect(error).toMatchObject({ code, requestStarted: false });
      expect(error.message).toBe(`Replay live-provider port failed: ${code}`);
    }
  });
});
