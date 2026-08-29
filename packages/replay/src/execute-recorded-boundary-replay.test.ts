import { createHash } from "node:crypto";
import {
  type RecordedBoundaryReplayInvocationDefinition,
  type RecordedBoundaryRequest,
  type RecordedInteractionFixtureContentExport,
  type ReplayAttemptOutcome,
  RecordedInteractionFixtureContentExportSchema,
  RecordedInteractionFixtureVersionSchema,
} from "@proofstack/contracts";
import { digestRecordedInteractionFixtureVersionDefinition } from "@proofstack/datasets";
import { describe, expect, it, vi } from "vitest";
import {
  RecordedBoundaryMismatchError,
  RecordedBoundaryReplayPreflightError,
  RecordedBoundaryRuntimeControlError,
  RecordedBoundaryTargetContractError,
} from "./errors.js";
import { executeRecordedBoundaryReplay } from "./execute-recorded-boundary-replay.js";
import { prepareRecordedBoundaryReplay } from "./preflight.js";
import type {
  RecordedBoundaryReplayContext,
  RecordedBoundaryReplayTargetAdapter,
} from "./target-adapter.js";

const scope = {
  environmentId: "env_replay",
  projectId: "prj_replay",
  tenantId: "ten_replay",
} as const;
const targetReference = { name: "proofstack.reference_agent", version: "1.0.0" } as const;

const artifactDefinitions = [
  ["art_model_config", "model.provider_configuration"],
  ["art_model_input", "model.input_messages"],
  ["art_model_normalized", "model.normalized_request"],
  ["art_model_output", "model.output_messages"],
  ["art_model_prompt", "prompt.template"],
  ["art_model_prompt_vars", "prompt.variables"],
  ["art_model_request", "model.provider_request"],
  ["art_model_response", "model.provider_response"],
  ["art_model_stream", "model.streaming_frames"],
  ["art_model_system", "model.system_instructions"],
  ["art_tool_args", "tool.arguments"],
  ["art_tool_contract", "tool.contract"],
  ["art_tool_normalized", "tool.normalized_request"],
  ["art_tool_result", "tool.result"],
] as const;

function artifactBytes(artifactId: string): Uint8Array {
  return Buffer.from(JSON.stringify({ artifactId, value: `classified:${artifactId}` }), "utf8");
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function buildFixture(): {
  contentExport: RecordedInteractionFixtureContentExport;
  invocation: RecordedBoundaryReplayInvocationDefinition;
  modelRequest: RecordedBoundaryRequest;
  toolRequest: RecordedBoundaryRequest;
} {
  const bindings = artifactDefinitions.map(([artifactId, role]) => {
    const bytes = artifactBytes(artifactId);
    return {
      contentReference: {
        artifactId,
        classification: "confidential" as const,
        mediaType: "application/json",
        sha256: sha256(bytes),
        sizeBytes: bytes.byteLength,
      },
      redaction: { status: "not_required" as const },
      retention: { mode: "retain" as const },
      role,
    };
  });
  const binding = (artifactId: string) => {
    const found = bindings.find(
      (candidate) => candidate.contentReference.artifactId === artifactId,
    );
    if (!found) throw new Error(`Test artifact not found: ${artifactId}`);
    return found;
  };
  const manifest = {
    artifacts: bindings,
    interactions: [
      {
        attempts: [
          {
            artifacts: {
              inputMessagesArtifactId: "art_model_input",
              outputMessagesArtifactId: "art_model_output",
              promptVariablesArtifactId: "art_model_prompt_vars",
              providerConfigurationArtifactId: "art_model_config",
              providerRequestArtifactId: "art_model_request",
              providerResponseArtifactId: "art_model_response",
              streamingFramesArtifactId: "art_model_stream",
              systemInstructionsArtifactId: "art_model_system",
            },
            attemptId: "att_model_replay",
            endedAt: "2026-08-29T00:00:02.000Z",
            normalizedRequest: {
              adapterName: "openai.responses",
              adapterVersion: "1.0.0",
              artifactId: "art_model_normalized",
              sha256: binding("art_model_normalized").contentReference.sha256,
            },
            outcome: "succeeded" as const,
            provider: {
              endpointProfileId: "end_recorded",
              endpointProfileVersion: "2026-08-29",
              name: "openai",
              operation: "chat" as const,
              requestedModel: "gpt-5.6",
              returnedModel: "gpt-5.6-2026-08-15",
            },
            providerMayHaveProcessed: true,
            providerRequestId: "provider_req_recorded",
            sequence: 0,
            startedAt: "2026-08-29T00:00:00.000Z",
            streaming: true,
          },
        ],
        interactionId: "int_model_replay",
        kind: "model" as const,
        prompt: {
          artifactId: "art_model_prompt",
          definitionSha256: binding("art_model_prompt").contentReference.sha256,
          promptId: "prm_replay",
          promptVersion: "1.0.0",
        },
        sequence: 0,
        terminalOutcome: "succeeded" as const,
        toolContracts: [
          {
            artifactId: "art_tool_contract",
            definitionSha256: binding("art_tool_contract").contentReference.sha256,
            toolId: "tool_lookup",
            toolVersion: "1.0.0",
          },
        ],
      },
      {
        attempts: [
          {
            artifacts: {
              argumentsArtifactId: "art_tool_args",
              resultArtifactId: "art_tool_result",
            },
            attemptId: "att_tool_replay",
            effectMayHaveOccurred: false,
            endedAt: "2026-08-29T00:00:04.000Z",
            normalizedRequest: {
              adapterName: "json-schema.tool",
              adapterVersion: "1.0.0",
              artifactId: "art_tool_normalized",
              sha256: binding("art_tool_normalized").contentReference.sha256,
            },
            outcome: "succeeded" as const,
            sequence: 0,
            sideEffect: "read_only" as const,
            startedAt: "2026-08-29T00:00:03.000Z",
          },
        ],
        callId: "call_lookup_replay",
        interactionId: "int_tool_replay",
        kind: "tool" as const,
        sequence: 1,
        terminalOutcome: "succeeded" as const,
        tool: {
          artifactId: "art_tool_contract",
          definitionSha256: binding("art_tool_contract").contentReference.sha256,
          toolId: "tool_lookup",
          toolVersion: "1.0.0",
        },
      },
    ],
    schemaVersion: "0.1" as const,
    source: {
      boundary: "application_provider_and_tool" as const,
      captureAdapter: { name: "proofstack.capture", version: "1.0.0" },
      completeness: {
        limitations: [
          "transport_metadata_excluded" as const,
          "provider_internal_state_unobserved" as const,
        ],
        status: "complete_for_declared_boundary" as const,
      },
      sourceFormat: { name: "proofstack.interaction", version: "1.0.0" },
    },
  };
  const definition = {
    fixtureId: "fix_recorded_replay",
    fixtureVersionId: "fiv_recorded_replay_002",
    interactionCapture: manifest,
    name: "Recorded replay fixture",
    predecessor: {
      definitionSha256: "a".repeat(64),
      fixtureVersionId: "fiv_recorded_replay_001",
    },
    replayability: "recorded_interactions" as const,
    schemaVersion: "0.2" as const,
    scope,
    source: {
      eventIds: ["evt_recorded_replay"],
      kind: "trace_snapshot" as const,
      observedEventCount: 1,
      sourceCompleteness: "observed_snapshot" as const,
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
    },
  };
  const version = RecordedInteractionFixtureVersionSchema.parse({
    ...definition,
    createdAt: "2026-08-29T00:00:11.000Z",
    createdByPrincipalId: "usr_replay_manager",
    definitionSha256: digestRecordedInteractionFixtureVersionDefinition(definition),
    source: { ...definition.source, capturedAt: "2026-08-29T00:00:10.000Z" },
  });
  const contentExport = RecordedInteractionFixtureContentExportSchema.parse({
    artifacts: bindings.map((item) => ({
      artifact: {
        binding: item,
        lifecycleStatus: "available",
        metadata: {
          availableAt: "2026-08-29T00:00:09.000Z",
          contentReference: item.contentReference,
          createdAt: "2026-08-29T00:00:08.000Z",
          redaction: item.redaction,
          retention: item.retention,
          schemaVersion: "0.1",
          scope,
          state: "available",
        },
        ownership: {
          artifactId: item.contentReference.artifactId,
          boundAt: version.createdAt,
          boundByPrincipalId: version.createdByPrincipalId,
          owner: {
            fixtureId: version.fixtureId,
            fixtureVersionId: version.fixtureVersionId,
            kind: "regression_fixture_version",
          },
          schemaVersion: "0.1",
          scope,
        },
        purgeReceipt: null,
        tombstone: null,
      },
      content: {
        bytes: Buffer.from(artifactBytes(item.contentReference.artifactId)).toString("base64url"),
        encoding: "base64url",
        status: "available",
      },
    })),
    contentAvailability: "available",
    mode: "content",
    revocation: null,
    schemaVersion: "0.1",
    version,
  });
  const invocation: RecordedBoundaryReplayInvocationDefinition = {
    fixture: {
      definitionSha256: version.definitionSha256,
      fixtureId: version.fixtureId,
      fixtureVersionId: version.fixtureVersionId,
    },
    invocationId: "rpi_recorded_replay",
    runtime: {
      boundaryMode: "recorded_stub",
      clock: { instant: "2026-08-29T00:00:00.000Z", mode: "fixed" },
      isolation: { mode: "cooperative_in_process" },
      locale: "en-US",
      network: { policy: "deny_fallback" },
      random: {
        algorithm: "hmac_sha256_counter_v1",
        mode: "seeded",
        seedHex: "b".repeat(64),
      },
      timeZone: "UTC",
    },
    schemaVersion: "0.1",
    targetAdapter: targetReference,
  };
  const request = (
    boundaryRequestId: string,
    kind: "model" | "tool",
    artifactId: string,
    adapterName: string,
  ): RecordedBoundaryRequest => ({
    boundaryRequestId,
    kind,
    normalizedRequest: {
      adapterName,
      adapterVersion: "1.0.0",
      bytes: Buffer.from(artifactBytes(artifactId)).toString("base64url"),
      encoding: "base64url",
    },
    schemaVersion: "0.1",
  });
  return {
    contentExport,
    invocation,
    modelRequest: request("brr_model_replay", "model", "art_model_normalized", "openai.responses"),
    toolRequest: request("brr_tool_replay", "tool", "art_tool_normalized", "json-schema.tool"),
  };
}

function refreshFixtureDefinitionDigest(fixture: ReturnType<typeof buildFixture>): void {
  const version = fixture.contentExport.version;
  const definitionSha256 = digestRecordedInteractionFixtureVersionDefinition({
    ...(version.description === undefined ? {} : { description: version.description }),
    fixtureId: version.fixtureId,
    fixtureVersionId: version.fixtureVersionId,
    interactionCapture: version.interactionCapture,
    name: version.name,
    predecessor: version.predecessor,
    replayability: version.replayability,
    schemaVersion: version.schemaVersion,
    scope: version.scope,
    source: {
      eventIds: version.source.eventIds,
      kind: version.source.kind,
      observedEventCount: version.source.observedEventCount,
      sourceCompleteness: version.source.sourceCompleteness,
      traceId: version.source.traceId,
    },
  });
  version.definitionSha256 = definitionSha256;
  fixture.invocation = {
    ...fixture.invocation,
    fixture: { ...fixture.invocation.fixture, definitionSha256 },
  };
}

function revokeFixtureContent(
  fixture: ReturnType<typeof buildFixture>,
  lifecycleStatus: "revoked" | "purged",
): void {
  const revokedAt = "2026-08-29T00:00:12.000Z";
  const purgedAt = "2026-08-29T00:00:13.000Z";
  const reason = "Recorded replay preflight test";
  const revokedByPrincipalId = "usr_replay_revoker";
  fixture.contentExport.contentAvailability = "revoked";
  fixture.contentExport.revocation = {
    fixtureId: fixture.contentExport.version.fixtureId,
    fixtureVersionId: fixture.contentExport.version.fixtureVersionId,
    reason,
    revocationId: "rev_replay_preflight",
    revokedAt,
    revokedByPrincipalId,
    schemaVersion: "0.1",
    scope,
  };
  fixture.contentExport.artifacts = fixture.contentExport.artifacts.map((item, index) => {
    if (item.artifact.metadata === null) throw new Error("Expected available artifact metadata");
    const artifactId = item.artifact.binding.contentReference.artifactId;
    const tombstone = {
      actorPrincipalId: revokedByPrincipalId,
      artifactId,
      occurredAt: revokedAt,
      reason,
      tombstoneId: `tom_replay_${index}`,
      trigger: "fixture_revocation" as const,
    };
    if (lifecycleStatus === "purged") {
      return {
        artifact: {
          ...item.artifact,
          lifecycleStatus,
          metadata: {
            ...item.artifact.metadata,
            purgedAt,
            state: "purged" as const,
            tombstonedAt: revokedAt,
          },
          purgeReceipt: {
            artifactId,
            objectWasPresent: true,
            occurredAt: purgedAt,
            purgeId: `pur_replay_${index}`,
            schemaVersion: "0.1" as const,
          },
          tombstone,
        },
        content: { status: "purged" as const },
      };
    }
    return {
      artifact: {
        ...item.artifact,
        lifecycleStatus,
        metadata: {
          ...item.artifact.metadata,
          state: "tombstoned" as const,
          tombstonedAt: revokedAt,
        },
        purgeReceipt: null,
        tombstone,
      },
      content: { status: "revoked" as const },
    };
  });
}

function target(
  run: (context: RecordedBoundaryReplayContext) => Promise<void> | void,
  reference = targetReference,
): RecordedBoundaryReplayTargetAdapter {
  return { reference, run };
}

function expectPreflightCode(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error("Expected replay preflight to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(RecordedBoundaryReplayPreflightError);
    expect(error).toMatchObject({ code });
  }
}

describe("recorded boundary replay preflight", () => {
  it("verifies the immutable fixture, exact artifact bytes, and ordered physical attempts", () => {
    const fixture = buildFixture();
    const prepared = prepareRecordedBoundaryReplay({
      contentExport: fixture.contentExport,
      invocation: fixture.invocation,
      targetAdapter: targetReference,
    });
    expect(prepared.invocation).toEqual(fixture.invocation);
    expect(prepared.invocationDefinitionSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(prepared.attempts).toHaveLength(2);
    expect(prepared.attempts.map(({ expectedRequest }) => expectedRequest.kind)).toEqual([
      "model",
      "tool",
    ]);
    expect(prepared.attempts[0]?.returnedArtifacts.map(({ binding }) => binding.role)).toEqual([
      "model.output_messages",
      "model.provider_response",
      "model.streaming_frames",
    ]);
    expect(prepared.attempts[1]?.returnedArtifacts.map(({ binding }) => binding.role)).toEqual([
      "tool.result",
    ]);
  });

  it("rejects malformed invocation, target, and content contracts", () => {
    const fixture = buildFixture();
    expectPreflightCode(
      () =>
        prepareRecordedBoundaryReplay({
          contentExport: fixture.contentExport,
          invocation: {},
          targetAdapter: targetReference,
        }),
      "invalid_invocation",
    );
    expectPreflightCode(
      () =>
        prepareRecordedBoundaryReplay({
          contentExport: fixture.contentExport,
          invocation: fixture.invocation,
          targetAdapter: {},
        }),
      "invalid_target_adapter",
    );
    expectPreflightCode(
      () =>
        prepareRecordedBoundaryReplay({
          contentExport: {},
          invocation: fixture.invocation,
          targetAdapter: targetReference,
        }),
      "invalid_content_export",
    );
  });

  it("rejects target, fixture lineage, and recomputed definition mismatches", () => {
    const fixture = buildFixture();
    expectPreflightCode(
      () =>
        prepareRecordedBoundaryReplay({
          contentExport: fixture.contentExport,
          invocation: fixture.invocation,
          targetAdapter: { ...targetReference, version: "2.0.0" },
        }),
      "target_adapter_mismatch",
    );
    expectPreflightCode(
      () =>
        prepareRecordedBoundaryReplay({
          contentExport: fixture.contentExport,
          invocation: {
            ...fixture.invocation,
            fixture: { ...fixture.invocation.fixture, fixtureId: "fix_other" },
          },
          targetAdapter: targetReference,
        }),
      "fixture_identity_mismatch",
    );
    const mutatedExport = structuredClone(fixture.contentExport);
    mutatedExport.version.name = "Definition changed without a new digest";
    expectPreflightCode(
      () =>
        prepareRecordedBoundaryReplay({
          contentExport: mutatedExport,
          invocation: fixture.invocation,
          targetAdapter: targetReference,
        }),
      "fixture_definition_invalid",
    );
  });

  it("rejects unavailable, missing, or digest-invalid fixture content", () => {
    const fixture = buildFixture();
    const unavailable = structuredClone(fixture.contentExport);
    unavailable.contentAvailability = "unavailable";
    unavailable.artifacts[0] = {
      ...unavailable.artifacts[0],
      content: { status: "unavailable" },
      artifact: {
        ...unavailable.artifacts[0]?.artifact,
        lifecycleStatus: "unavailable",
        metadata: null,
      },
    } as (typeof unavailable.artifacts)[number];
    expectPreflightCode(
      () =>
        prepareRecordedBoundaryReplay({
          contentExport: unavailable,
          invocation: fixture.invocation,
          targetAdapter: targetReference,
        }),
      "fixture_content_unavailable",
    );

    const missing = structuredClone(fixture.contentExport);
    missing.artifacts[0] = {
      ...missing.artifacts[0],
      content: { status: "missing" },
    } as (typeof missing.artifacts)[number];
    expectPreflightCode(
      () =>
        prepareRecordedBoundaryReplay({
          contentExport: missing,
          invocation: fixture.invocation,
          targetAdapter: targetReference,
        }),
      "fixture_content_unavailable",
    );

    const corrupt = structuredClone(fixture.contentExport);
    const original = corrupt.artifacts[0];
    if (original?.content.status !== "available") throw new Error("Invalid test fixture");
    const bytes = Buffer.from(original.content.bytes, "base64url");
    bytes[0] = (bytes[0] ?? 0) ^ 1;
    original.content.bytes = bytes.toString("base64url");
    expectPreflightCode(
      () =>
        prepareRecordedBoundaryReplay({
          contentExport: corrupt,
          invocation: fixture.invocation,
          targetAdapter: targetReference,
        }),
      "artifact_content_invalid",
    );
  });

  it("rejects non-executable export modes, lifecycle states, roles, and byte sizes", () => {
    const metadataFixture = buildFixture();
    const metadataOnly = {
      ...metadataFixture.contentExport,
      artifacts: metadataFixture.contentExport.artifacts.map(({ artifact }) => artifact),
      mode: "metadata",
    };
    expectPreflightCode(
      () =>
        prepareRecordedBoundaryReplay({
          contentExport: metadataOnly,
          invocation: metadataFixture.invocation,
          targetAdapter: targetReference,
        }),
      "invalid_content_export",
    );

    const evidenceOnly = structuredClone(buildFixture());
    Object.assign(evidenceOnly.contentExport.version, {
      replayability: "evidence_only",
      schemaVersion: "0.1",
    });
    expectPreflightCode(
      () =>
        prepareRecordedBoundaryReplay({
          contentExport: evidenceOnly.contentExport,
          invocation: evidenceOnly.invocation,
          targetAdapter: targetReference,
        }),
      "invalid_content_export",
    );

    for (const lifecycleStatus of ["revoked", "purged"] as const) {
      const fixture = buildFixture();
      revokeFixtureContent(fixture, lifecycleStatus);
      expectPreflightCode(
        () =>
          prepareRecordedBoundaryReplay({
            contentExport: fixture.contentExport,
            invocation: fixture.invocation,
            targetAdapter: targetReference,
          }),
        "fixture_content_unavailable",
      );
    }

    const wrongRole = structuredClone(buildFixture());
    const wronglyBoundArtifact = wrongRole.contentExport.artifacts[0];
    if (!wronglyBoundArtifact) throw new Error("Expected exported artifact");
    wronglyBoundArtifact.artifact.binding.role = "tool.result";
    expectPreflightCode(
      () =>
        prepareRecordedBoundaryReplay({
          contentExport: wrongRole.contentExport,
          invocation: wrongRole.invocation,
          targetAdapter: targetReference,
        }),
      "invalid_content_export",
    );

    const wrongSize = structuredClone(buildFixture());
    const sizedContent = wrongSize.contentExport.artifacts[0]?.content;
    if (!sizedContent) throw new Error("Expected exported artifact content");
    if (sizedContent.status !== "available") throw new Error("Expected available content");
    sizedContent.bytes = Buffer.from("wrong-size", "utf8").toString("base64url");
    expectPreflightCode(
      () =>
        prepareRecordedBoundaryReplay({
          contentExport: wrongSize.contentExport,
          invocation: wrongSize.invocation,
          targetAdapter: targetReference,
        }),
      "invalid_content_export",
    );
  });

  it("requires runtime locale and time-zone identifiers to be canonical and supported", () => {
    const fixture = buildFixture();
    expectPreflightCode(
      () =>
        prepareRecordedBoundaryReplay({
          contentExport: fixture.contentExport,
          invocation: {
            ...fixture.invocation,
            runtime: { ...fixture.invocation.runtime, locale: "EN-us" },
          },
          targetAdapter: targetReference,
        }),
      "runtime_profile_unsupported",
    );
  });
});

describe("recorded boundary replay execution", () => {
  it("returns bounded evidence only after consuming every exact boundary in order", async () => {
    const fixture = buildFixture();
    const result = await executeRecordedBoundaryReplay({
      contentExport: fixture.contentExport,
      invocation: fixture.invocation,
      target: target(async (context) => {
        expect(context.locale).toBe("en-US");
        expect(context.timeZone).toBe("UTC");
        expect(context.now()).toBe("2026-08-29T00:00:00.000Z");
        expect(context.randomBytes(7)).toHaveLength(7);
        const model = await context.resolveBoundary(fixture.modelRequest);
        expect(model.artifacts.map(({ binding }) => binding.role)).toEqual([
          "model.output_messages",
          "model.provider_response",
          "model.streaming_frames",
        ]);
        const tool = await context.resolveBoundary(fixture.toolRequest);
        expect(tool.artifacts.map(({ binding }) => binding.role)).toEqual(["tool.result"]);
      }),
    });

    expect(result).toMatchObject({
      consumedAttemptCount: 2,
      expectedAttemptCount: 2,
      reproducibility: {
        classification: "bounded",
        limitations: [
          "target_runtime_not_isolated",
          "ambient_filesystem_not_controlled",
          "process_egress_not_enforced",
          "dependency_snapshot_not_verified",
          "runtime_controls_are_cooperative",
        ],
        verifiedControls: [
          "artifact_bytes_verified",
          "normalized_requests_matched",
          "recorded_attempt_order_consumed",
          "resolver_has_no_live_fallback",
          "runtime_interfaces_supplied",
        ],
      },
      runtimeEvidence: { fixedClockReadCount: 1, randomByteCount: 7, randomRequestCount: 1 },
      status: "completed",
    });
    expect(result.observations.map(({ status }) => status)).toEqual(["matched", "matched"]);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("classified:");
    expect(serialized).not.toContain('"bytes":');
  });

  it.each([
    "succeeded",
    "failed",
    "timed_out",
    "cancelled",
    "indeterminate",
  ] satisfies readonly ReplayAttemptOutcome[])(
    "preserves the recorded %s model outcome and provider uncertainty",
    async (outcome) => {
      const fixture = buildFixture();
      const interaction = fixture.contentExport.version.interactionCapture.interactions[0];
      if (interaction?.kind !== "model") throw new Error("Expected model interaction");
      const attempt = interaction.attempts[0];
      if (!attempt) throw new Error("Expected model attempt");
      attempt.outcome = outcome;
      interaction.terminalOutcome = outcome;
      if (outcome === "succeeded") {
        delete attempt.errorType;
      } else {
        attempt.errorType = `recorded_${outcome}`;
      }
      refreshFixtureDefinitionDigest(fixture);

      const result = await executeRecordedBoundaryReplay({
        contentExport: fixture.contentExport,
        invocation: fixture.invocation,
        target: target(async (context) => {
          await context.resolveBoundary(fixture.modelRequest);
          await context.resolveBoundary(fixture.toolRequest);
        }),
      });
      expect(result.status).toBe("completed");
      const observation = result.observations[0];
      expect(observation?.status).toBe("matched");
      if (observation?.status !== "matched") throw new Error("Expected matched observation");
      expect(observation.resolution.recordedAttempt).toMatchObject({
        attempt: {
          outcome,
          providerMayHaveProcessed: true,
          ...(outcome === "succeeded" ? {} : { errorType: `recorded_${outcome}` }),
        },
        kind: "model",
      });
    },
  );

  it("preserves uncertain tool-side-effect evidence without executing the tool", async () => {
    const fixture = buildFixture();
    const interaction = fixture.contentExport.version.interactionCapture.interactions[1];
    if (interaction?.kind !== "tool") throw new Error("Expected tool interaction");
    const attempt = interaction.attempts[0];
    if (!attempt) throw new Error("Expected tool attempt");
    attempt.sideEffect = "unknown";
    attempt.effectMayHaveOccurred = true;
    refreshFixtureDefinitionDigest(fixture);

    const result = await executeRecordedBoundaryReplay({
      contentExport: fixture.contentExport,
      invocation: fixture.invocation,
      target: target(async (context) => {
        await context.resolveBoundary(fixture.modelRequest);
        const recorded = await context.resolveBoundary(fixture.toolRequest);
        const recordedAttempt = recorded.resolution.recordedAttempt;
        expect(recordedAttempt).toMatchObject({
          attempt: { effectMayHaveOccurred: true, sideEffect: "unknown" },
          kind: "tool",
        });
      }),
    });
    expect(result.status).toBe("completed");
  });

  it.each([
    ["wrong_boundary_kind", (request: RecordedBoundaryRequest) => ({ ...request, kind: "tool" })],
    [
      "wrong_adapter_name",
      (request: RecordedBoundaryRequest) => ({
        ...request,
        normalizedRequest: { ...request.normalizedRequest, adapterName: "openai.changed" },
      }),
    ],
    [
      "wrong_adapter_version",
      (request: RecordedBoundaryRequest) => ({
        ...request,
        normalizedRequest: { ...request.normalizedRequest, adapterVersion: "2.0.0" },
      }),
    ],
    [
      "normalized_request_digest_mismatch",
      (request: RecordedBoundaryRequest) => ({
        ...request,
        normalizedRequest: {
          ...request.normalizedRequest,
          bytes: Buffer.from("different normalized request", "utf8").toString("base64url"),
        },
      }),
    ],
  ] as const)("fails closed with %s", async (code, mutate) => {
    const fixture = buildFixture();
    const result = await executeRecordedBoundaryReplay({
      contentExport: fixture.contentExport,
      invocation: fixture.invocation,
      target: target(async (context) => {
        await context.resolveBoundary(mutate(fixture.modelRequest) as RecordedBoundaryRequest);
      }),
    });
    expect(result).toMatchObject({
      consumedAttemptCount: 0,
      reproducibility: {
        classification: "unknown",
        limitations: expect.arrayContaining(["boundary_request_mismatch"]),
      },
      status: "mismatch",
    });
    expect(result.observations).toEqual([
      expect.objectContaining({ code, sequence: 0, status: "mismatch" }),
    ]);
  });

  it("reports an extra request after consuming the recording", async () => {
    const fixture = buildFixture();
    const extra = {
      ...fixture.toolRequest,
      boundaryRequestId: "brr_extra_replay",
    };
    const result = await executeRecordedBoundaryReplay({
      contentExport: fixture.contentExport,
      invocation: fixture.invocation,
      target: target(async (context) => {
        await context.resolveBoundary(fixture.modelRequest);
        await context.resolveBoundary(fixture.toolRequest);
        await context.resolveBoundary(extra);
      }),
    });
    expect(result.status).toBe("mismatch");
    expect(result.consumedAttemptCount).toBe(2);
    expect(result.observations.at(-1)).toMatchObject({
      code: "extra_boundary_request",
      expectedRequest: null,
      status: "mismatch",
    });
  });

  it("does not let a target catch a mismatch and resume with fallback requests", async () => {
    const fixture = buildFixture();
    const errors: unknown[] = [];
    const result = await executeRecordedBoundaryReplay({
      contentExport: fixture.contentExport,
      invocation: fixture.invocation,
      target: target(async (context) => {
        try {
          await context.resolveBoundary({ ...fixture.modelRequest, kind: "tool" });
        } catch (error) {
          errors.push(error);
        }
        try {
          await context.resolveBoundary(fixture.modelRequest);
        } catch (error) {
          errors.push(error);
        }
      }),
    });
    expect(errors).toHaveLength(2);
    expect(errors[0]).toBeInstanceOf(RecordedBoundaryMismatchError);
    expect(errors[1]).toBe(errors[0]);
    expect(result.status).toBe("mismatch");
    expect(result.observations).toHaveLength(1);
  });

  it("reports incomplete when the target returns before every attempt is consumed", async () => {
    const fixture = buildFixture();
    const result = await executeRecordedBoundaryReplay({
      contentExport: fixture.contentExport,
      invocation: fixture.invocation,
      target: target(async (context) => {
        await context.resolveBoundary(fixture.modelRequest);
      }),
    });
    expect(result).toMatchObject({
      consumedAttemptCount: 1,
      reproducibility: {
        classification: "unknown",
        limitations: expect.arrayContaining(["recorded_attempts_unconsumed"]),
      },
      status: "incomplete",
    });
  });

  it("reports thrown, malformed, duplicate, and runtime-control target failures", async () => {
    const fixture = buildFixture();
    const runners = [
      target(() => {
        throw new Error("target failure");
      }),
      target(async (context) => {
        let firstFailure: unknown;
        try {
          await context.resolveBoundary({} as RecordedBoundaryRequest);
        } catch (error) {
          firstFailure = error;
          expect(error).toBeInstanceOf(RecordedBoundaryTargetContractError);
          expect(error).toMatchObject({ code: "invalid_boundary_request" });
        }
        await expect(context.resolveBoundary(fixture.modelRequest)).rejects.toBe(firstFailure);
      }),
      target(async (context) => {
        await context.resolveBoundary(fixture.modelRequest);
        try {
          await context.resolveBoundary(fixture.modelRequest);
        } catch (error) {
          expect(error).toBeInstanceOf(RecordedBoundaryTargetContractError);
          expect(error).toMatchObject({ code: "duplicate_boundary_request_id" });
        }
      }),
      target((context) => {
        try {
          context.randomBytes(0);
        } catch (error) {
          expect(error).toBeInstanceOf(RecordedBoundaryRuntimeControlError);
        }
      }),
    ];
    for (const replayTarget of runners) {
      const result = await executeRecordedBoundaryReplay({
        contentExport: fixture.contentExport,
        invocation: fixture.invocation,
        target: replayTarget,
      });
      expect(result.status).toBe("target_failed");
      expect(result.reproducibility).toMatchObject({
        classification: "unknown",
        limitations: expect.arrayContaining(["target_adapter_failed"]),
      });
    }
  });

  it("closes retained target capabilities after the invocation", async () => {
    const fixture = buildFixture();
    let retained: RecordedBoundaryReplayContext | undefined;
    const result = await executeRecordedBoundaryReplay({
      contentExport: fixture.contentExport,
      invocation: fixture.invocation,
      target: target((context) => {
        retained = context;
      }),
    });
    expect(result.status).toBe("incomplete");
    if (!retained) throw new Error("Target context was not retained");
    expect(() => retained?.now()).toThrowError(
      expect.objectContaining({ code: "runtime_controls_closed" }),
    );
    await expect(retained.resolveBoundary(fixture.modelRequest)).rejects.toMatchObject({
      code: "resolver_closed",
    });
  });

  it("runs no target code when adapter shape or preflight evidence is invalid", async () => {
    const fixture = buildFixture();
    const run = vi.fn();
    await expect(
      executeRecordedBoundaryReplay({
        contentExport: fixture.contentExport,
        invocation: fixture.invocation,
        target: { reference: targetReference } as RecordedBoundaryReplayTargetAdapter,
      }),
    ).rejects.toMatchObject({ code: "invalid_target_adapter" });
    for (const invalidTarget of [
      null,
      "not-an-adapter",
      { reference: targetReference, run: "not-a-function" },
      { run },
    ]) {
      await expect(
        executeRecordedBoundaryReplay({
          contentExport: fixture.contentExport,
          invocation: fixture.invocation,
          target: invalidTarget as never,
        }),
      ).rejects.toMatchObject({ code: "invalid_target_adapter" });
    }
    await expect(
      executeRecordedBoundaryReplay({
        contentExport: {},
        invocation: fixture.invocation,
        target: target(run),
      }),
    ).rejects.toMatchObject({ code: "invalid_content_export" });
    expect(run).not.toHaveBeenCalled();
  });
});
