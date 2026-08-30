import { readFileSync } from "node:fs";
import {
  type ReplayPlanDefinition,
  ReplayPlanDefinitionSchema,
  type TargetReleaseDefinition,
  TargetReleaseDefinitionSchema,
} from "@proofstack/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  digestReplayPlanDefinition,
  digestTargetReleaseDefinition,
  encodeReplayPlanDefinition,
  encodeTargetReleaseDefinition,
  ReplayDefinitionDigestError,
} from "./replay-definition-digest.js";

interface DefinitionVector<Input> {
  readonly encodedByteLength: number;
  readonly encodedHex: string;
  readonly input: Input;
  readonly kind: "replay_plan" | "target_release";
  readonly sha256: string;
}

const vectors = (
  JSON.parse(
    readFileSync(
      new URL("../../../packages/replay/vectors/replay-definition-v1.json", import.meta.url),
      "utf8",
    ),
  ) as { readonly vectors: readonly DefinitionVector<unknown>[] }
).vectors;

const targetVector = vectors.find(({ kind }) => kind === "target_release");
const planVector = vectors.find(({ kind }) => kind === "replay_plan");
if (!targetVector || !planVector) throw new Error("Replay definition vectors are incomplete");

const targetDefinition = TargetReleaseDefinitionSchema.parse(targetVector.input);
const planDefinition = ReplayPlanDefinitionSchema.parse(planVector.input);

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

describe("independent replay definition digests", () => {
  it("matches the complete public target-release vector", async () => {
    const vector = targetVector;
    const definition: TargetReleaseDefinition = targetDefinition;
    const encoded = encodeTargetReleaseDefinition(definition);

    expect(encoded.byteLength).toBe(vector.encodedByteLength);
    expect(hex(encoded)).toBe(vector.encodedHex);
    await expect(digestTargetReleaseDefinition(definition)).resolves.toBe(vector.sha256);
  });

  it("matches the complete public replay-plan vector", async () => {
    const vector = planVector;
    const definition: ReplayPlanDefinition = planDefinition;
    const encoded = encodeReplayPlanDefinition(definition);

    expect(encoded.byteLength).toBe(vector.encodedByteLength);
    expect(hex(encoded)).toBe(vector.encodedHex);
    await expect(digestReplayPlanDefinition(definition)).resolves.toBe(vector.sha256);
  });

  it("rejects unknown fields before encoding", () => {
    expect(() =>
      encodeTargetReleaseDefinition({ ...(targetVector.input as object), latest: true } as never),
    ).toThrow();
  });

  it("encodes every target execution and subprocess shape", () => {
    const encoded = encodeTargetReleaseDefinition({
      ...targetDefinition,
      build: {
        ...targetDefinition.build,
        provenance: {
          ...targetDefinition.build.provenance,
          redactedAt: "source",
        },
      },
      environmentVariableNames: ["PROOFSTACK_INPUT"],
      execution: {
        artifact: {
          ...targetDefinition.build.provenance,
          artifactId: "art_vector_executable",
        },
        bundleFormat: "zip",
        kind: "artifact",
      },
      mounts: [
        {
          access: "read_write",
          mountId: "mnt_vector_output",
          targetPath: "/proofstack/outputs/result",
        },
      ],
      subprocessPolicy: {
        allowedImplementations: [
          {
            executableSha256: "c".repeat(64),
            implementationId: "impl_vector_child",
          },
        ],
        mode: "allowlisted",
      },
    });

    expect(encoded.byteLength).toBeGreaterThan(targetVector.encodedByteLength);
  });

  it("encodes simulation and every live-provider side-effect shape", () => {
    const qualification = {
      ...targetDefinition.build.provenance,
      artifactId: "art_vector_qualification",
    };
    const liveBoundary = {
      boundaryId: "bnd_vector_live_read",
      credential: {
        credentialId: "cred_vector",
        credentialVersionId: "crv_vector_001",
      },
      destination: { hostname: "api.example.com", port: 443 as const, scheme: "https" as const },
      endpointProfile: {
        definitionSha256: "d".repeat(64),
        endpointProfileId: "epp_vector",
        endpointProfileVersion: "1.0.0",
      },
      kind: "model" as const,
      mode: "live_provider" as const,
      operation: "responses.create",
      requestLimits: { requestBytes: 4096, responseBytes: 8192 },
      sideEffect: { kind: "read_only" as const },
      usageSource: "measured" as const,
    };
    const definition = ReplayPlanDefinitionSchema.parse({
      ...planDefinition,
      boundaries: [
        {
          ...liveBoundary,
          boundaryId: "bnd_vector_live_idempotent",
          sideEffect: {
            idempotencyKeyScheme: "proofstack.job_attempt",
            kind: "idempotent_write",
            sandboxDestination: true,
          },
        },
        liveBoundary,
        {
          ...liveBoundary,
          boundaryId: "bnd_vector_live_write",
          sideEffect: {
            automaticRetry: false,
            kind: "non_idempotent_write",
            riskAcceptance: qualification,
          },
        },
        {
          boundaryId: "bnd_vector_simulation",
          configurationSha256: "e".repeat(64),
          kind: "retrieval",
          mode: "simulation",
          qualification,
          seedHex: "f".repeat(64),
          simulatorRelease: planDefinition.targetRelease,
        },
      ],
    });

    expect(encodeReplayPlanDefinition(definition).byteLength).toBeGreaterThan(
      planVector.encodedByteLength,
    );
  });

  it.each([
    { delayMilliseconds: 100, kind: "fixed" as const },
    {
      initialDelayMilliseconds: 100,
      kind: "exponential" as const,
      maximumDelayMilliseconds: 1_000,
      multiplier: 2,
    },
  ])("encodes $kind retry backoff", (backoff) => {
    const definition = ReplayPlanDefinitionSchema.parse({
      ...planDefinition,
      budget: {
        ...planDefinition.budget,
        jobAttempts: { ...planDefinition.budget.jobAttempts, limit: 2 },
      },
      retryPolicy: {
        ...planDefinition.retryPolicy,
        automatic: true,
        backoff,
        maxAttempts: 2,
        retryableErrors: ["target_temporary_failure"],
      },
    });

    expect(encodeReplayPlanDefinition(definition).byteLength).toBeGreaterThan(0);
  });

  it("fails closed when Web Crypto is unavailable", async () => {
    vi.stubGlobal("crypto", undefined);

    await expect(digestTargetReleaseDefinition(targetDefinition)).rejects.toBeInstanceOf(
      ReplayDefinitionDigestError,
    );
    vi.unstubAllGlobals();
  });

  it("wraps Web Crypto failures without returning an unverified digest", async () => {
    vi.stubGlobal("crypto", {
      subtle: { digest: vi.fn().mockRejectedValue(new Error("crypto unavailable")) },
    });

    await expect(digestReplayPlanDefinition(planDefinition)).rejects.toBeInstanceOf(
      ReplayDefinitionDigestError,
    );
    vi.unstubAllGlobals();
  });
});
