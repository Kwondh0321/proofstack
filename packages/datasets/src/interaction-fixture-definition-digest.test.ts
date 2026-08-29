import { readFileSync } from "node:fs";
import {
  type InteractionArtifactBinding,
  type RecordedInteractionFixtureVersionDefinition,
  RecordedInteractionFixtureVersionDefinitionSchema,
} from "@proofstack/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  digestRecordedInteractionFixtureVersionDefinition,
  encodeRecordedInteractionFixtureVersionDefinition,
  RECORDED_INTERACTION_FIXTURE_DEFINITION_DOMAIN,
} from "./interaction-fixture-definition-digest.js";

interface InteractionFixtureVector {
  readonly encodedByteLength: number;
  readonly encodedHex: string;
  readonly input: RecordedInteractionFixtureVersionDefinition;
  readonly kind: "recorded_interaction_fixture";
  readonly name: string;
  readonly sha256: string;
}

const vectorsDocument = JSON.parse(
  readFileSync(
    new URL("../vectors/interaction-fixture-definition-v2.json", import.meta.url),
    "utf8",
  ),
) as {
  readonly format: string;
  readonly vectors: readonly InteractionFixtureVector[];
};

function requireMinimalVector(): InteractionFixtureVector {
  const vector = vectorsDocument.vectors[0];
  if (!vector) throw new Error("The interaction fixture vector is missing");
  return vector;
}

const minimalVector = requireMinimalVector();

const hex = (value: Uint8Array): string => Buffer.from(value).toString("hex");

function minimalDefinition(): RecordedInteractionFixtureVersionDefinition {
  return RecordedInteractionFixtureVersionDefinitionSchema.parse(
    structuredClone(minimalVector.input),
  );
}

function extraArtifact(
  artifactId: string,
  role: InteractionArtifactBinding["role"],
  shaDigit: string,
): InteractionArtifactBinding {
  return {
    contentReference: {
      artifactId,
      classification: "restricted",
      mediaType: "application/json",
      sha256: shaDigit.repeat(64),
      sizeBytes: 96,
    },
    redaction: { status: "not_performed" },
    retention: { mode: "retain" },
    role,
  };
}

function richDefinition(): RecordedInteractionFixtureVersionDefinition {
  const definition = minimalDefinition();
  const originalModel = definition.interactionCapture.interactions[0];
  if (originalModel?.kind !== "model") {
    throw new Error("The interaction fixture vector requires one model interaction");
  }
  const originalAttempt = originalModel.attempts[0];
  if (!originalAttempt) throw new Error("The interaction fixture vector requires one attempt");

  const artifacts = [
    ...definition.interactionCapture.artifacts.map((binding) =>
      binding.contentReference.artifactId === "art_model_request"
        ? {
            ...binding,
            contentReference: { ...binding.contentReference, redactedAt: "source" as const },
            redaction: {
              records: [
                {
                  changedPaths: ["/authorization"],
                  matchCount: 1,
                  rulesetId: "red_capture",
                  rulesetVersion: "1.0.0",
                  stage: "source" as const,
                },
              ],
              status: "applied" as const,
            },
          }
        : binding,
    ),
    extraArtifact("art_model_prompt_vars", "prompt.variables", "8"),
    extraArtifact("art_model_stream", "model.streaming_frames", "9"),
    extraArtifact("art_model_system", "model.system_instructions", "a"),
    extraArtifact("art_tool_args", "tool.arguments", "b"),
    extraArtifact("art_tool_contract", "tool.contract", "c"),
    extraArtifact("art_tool_normalized", "tool.normalized_request", "d"),
    extraArtifact("art_tool_result", "tool.result", "e"),
  ].sort((left, right) =>
    left.contentReference.artifactId < right.contentReference.artifactId ? -1 : 1,
  );

  const tool = {
    artifactId: "art_tool_contract",
    definitionSha256: "c".repeat(64),
    toolId: "tool_charge_card",
    toolVersion: "2.1.0",
  } as const;

  return RecordedInteractionFixtureVersionDefinitionSchema.parse({
    ...definition,
    description: "Recorded checkout interaction 🧪",
    interactionCapture: {
      ...definition.interactionCapture,
      artifacts,
      interactions: [
        {
          ...originalModel,
          attempts: [
            {
              ...originalAttempt,
              artifacts: {
                inputMessagesArtifactId: "art_model_input",
                providerConfigurationArtifactId: "art_model_config",
                providerRequestArtifactId: "art_model_request",
              },
              attemptId: "att_model_failed",
              endedAt: "2026-08-29T00:00:01.000Z",
              errorType: "provider_timeout",
              outcome: "timed_out",
              provider: { ...originalAttempt.provider, returnedModel: undefined },
              providerMayHaveProcessed: true,
              providerRequestId: undefined,
              sequence: 0,
              streaming: false,
            },
            {
              ...originalAttempt,
              artifacts: {
                ...originalAttempt.artifacts,
                promptVariablesArtifactId: "art_model_prompt_vars",
                streamingFramesArtifactId: "art_model_stream",
                systemInstructionsArtifactId: "art_model_system",
              },
              attemptId: "att_model_success",
              endedAt: "2026-08-29T00:00:04.000Z",
              provider: {
                ...originalAttempt.provider,
                returnedModel: "gpt-5.6-2026-08-15",
              },
              providerRequestId: "req_success_123",
              sequence: 1,
              startedAt: "2026-08-29T00:00:02.000Z",
              streaming: true,
            },
          ],
          toolContracts: [tool],
        },
        {
          attempts: [
            {
              artifacts: { argumentsArtifactId: "art_tool_args" },
              attemptId: "att_tool_timeout",
              effectMayHaveOccurred: true,
              endedAt: "2026-08-29T00:00:06.000Z",
              errorType: "tool_timeout",
              normalizedRequest: {
                adapterName: "json-schema.tool",
                adapterVersion: "1.0.0",
                artifactId: "art_tool_normalized",
                sha256: "d".repeat(64),
              },
              outcome: "timed_out",
              sequence: 0,
              sideEffect: "unknown",
              startedAt: "2026-08-29T00:00:05.000Z",
            },
            {
              artifacts: {
                argumentsArtifactId: "art_tool_args",
                resultArtifactId: "art_tool_result",
              },
              attemptId: "att_tool_success",
              effectMayHaveOccurred: true,
              endedAt: "2026-08-29T00:00:08.000Z",
              normalizedRequest: {
                adapterName: "json-schema.tool",
                adapterVersion: "1.0.0",
                artifactId: "art_tool_normalized",
                sha256: "d".repeat(64),
              },
              outcome: "succeeded",
              sequence: 1,
              sideEffect: "idempotent_write",
              startedAt: "2026-08-29T00:00:07.000Z",
            },
          ],
          callId: "call_charge_123",
          interactionId: "int_tool_001",
          kind: "tool",
          sequence: 1,
          terminalOutcome: "succeeded",
          tool,
        },
      ],
      source: {
        ...definition.interactionCapture.source,
        completeness: {
          ...definition.interactionCapture.source.completeness,
          limitations: [
            "transport_metadata_excluded",
            "provider_internal_state_unobserved",
            "hidden_reasoning_excluded",
          ],
        },
      },
    },
    name: "Checkout interaction 🧪",
  });
}

function mutateArtifact(
  definition: RecordedInteractionFixtureVersionDefinition,
  artifactId: string,
  mutate: (artifact: InteractionArtifactBinding) => InteractionArtifactBinding,
): RecordedInteractionFixtureVersionDefinition {
  return {
    ...definition,
    interactionCapture: {
      ...definition.interactionCapture,
      artifacts: definition.interactionCapture.artifacts.map((artifact) =>
        artifact.contentReference.artifactId === artifactId ? mutate(artifact) : artifact,
      ),
    },
  };
}

describe("public recorded interaction fixture v2 vector", () => {
  it("publishes one immutable fixed-binary anchor", () => {
    expect(vectorsDocument.format).toBe("proofstack.interaction-fixture-definition-vectors.v2");
    expect(minimalVector.name).toBe("minimal recorded interaction fixture");
    expect(minimalVector.kind).toBe("recorded_interaction_fixture");
    expect(RECORDED_INTERACTION_FIXTURE_DEFINITION_DOMAIN).toBe("proofstack.fixture-version.v2");
    expect(minimalVector).toMatchObject({
      encodedByteLength: 2_392,
      sha256: "e1060b30c512cabb1916c42682109180bedc7576c76971cf6682174ac6c5e844",
    });
  });

  it("matches the static encoded bytes and SHA-256", () => {
    const encoded = encodeRecordedInteractionFixtureVersionDefinition(minimalVector.input);
    expect(encoded.byteLength).toBe(minimalVector.encodedByteLength);
    expect(hex(encoded)).toBe(minimalVector.encodedHex);
    expect(digestRecordedInteractionFixtureVersionDefinition(minimalVector.input)).toBe(
      minimalVector.sha256,
    );
  });
});

describe("recorded interaction fixture definition encoding", () => {
  it("ignores JavaScript property insertion order across the fixture and capture source", () => {
    const original = minimalDefinition();
    const reordered: RecordedInteractionFixtureVersionDefinition = {
      interactionCapture: {
        source: {
          sourceFormat: original.interactionCapture.source.sourceFormat,
          completeness: original.interactionCapture.source.completeness,
          captureAdapter: original.interactionCapture.source.captureAdapter,
          boundary: original.interactionCapture.source.boundary,
        },
        schemaVersion: original.interactionCapture.schemaVersion,
        interactions: original.interactionCapture.interactions,
        artifacts: original.interactionCapture.artifacts,
      },
      source: {
        traceId: original.source.traceId,
        sourceCompleteness: original.source.sourceCompleteness,
        observedEventCount: original.source.observedEventCount,
        kind: original.source.kind,
        eventIds: original.source.eventIds,
      },
      scope: {
        tenantId: original.scope.tenantId,
        environmentId: original.scope.environmentId,
        projectId: original.scope.projectId,
      },
      schemaVersion: original.schemaVersion,
      replayability: original.replayability,
      predecessor: original.predecessor,
      name: original.name,
      fixtureVersionId: original.fixtureVersionId,
      fixtureId: original.fixtureId,
    };
    expect(encodeRecordedInteractionFixtureVersionDefinition(reordered)).toEqual(
      encodeRecordedInteractionFixtureVersionDefinition(original),
    );
  });

  it("encodes model and tool attempts, optional fields, redaction, and Unicode", () => {
    const definition = richDefinition();
    const encoded = encodeRecordedInteractionFixtureVersionDefinition(definition);
    expect(encoded).toBeInstanceOf(Uint8Array);
    expect(encoded.byteLength).toBeGreaterThan(minimalVector.encodedByteLength);
    expect(digestRecordedInteractionFixtureVersionDefinition(definition)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("makes fixture, source, ownership, and interaction semantics digest-significant", () => {
    const base = richDefinition();
    const model = base.interactionCapture.interactions[0];
    const tool = base.interactionCapture.interactions[1];
    if (model?.kind !== "model" || tool?.kind !== "tool") {
      throw new Error("The rich definition requires model and tool interactions");
    }
    const baseDigest = digestRecordedInteractionFixtureVersionDefinition(base);
    const mutations: RecordedInteractionFixtureVersionDefinition[] = [
      { ...base, scope: { ...base.scope, tenantId: "ten_other" } },
      { ...base, scope: { ...base.scope, projectId: "prj_other" } },
      { ...base, scope: { ...base.scope, environmentId: "env_other" } },
      { ...base, fixtureId: "fix_other" },
      { ...base, fixtureVersionId: "fiv_other_002" },
      { ...base, name: "Different interaction" },
      { ...base, description: undefined },
      {
        ...base,
        predecessor: { ...base.predecessor, fixtureVersionId: "fiv_other_001" },
      },
      {
        ...base,
        predecessor: { ...base.predecessor, definitionSha256: "f".repeat(64) },
      },
      { ...base, source: { ...base.source, traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } },
      {
        ...base,
        source: { ...base.source, eventIds: ["evt_other_001"], observedEventCount: 1 },
      },
      {
        ...base,
        interactionCapture: {
          ...base.interactionCapture,
          source: {
            ...base.interactionCapture.source,
            captureAdapter: {
              ...base.interactionCapture.source.captureAdapter,
              version: "2.0.0",
            },
          },
        },
      },
      {
        ...base,
        interactionCapture: {
          ...base.interactionCapture,
          source: {
            ...base.interactionCapture.source,
            sourceFormat: { ...base.interactionCapture.source.sourceFormat, version: "2.0.0" },
          },
        },
      },
      {
        ...base,
        interactionCapture: {
          ...base.interactionCapture,
          source: {
            ...base.interactionCapture.source,
            completeness: {
              ...base.interactionCapture.source.completeness,
              limitations: [
                ...base.interactionCapture.source.completeness.limitations,
                "uninstrumented_subprocesses_unobserved",
              ],
            },
          },
        },
      },
      mutateArtifact(base, "art_model_config", (artifact) => ({
        ...artifact,
        contentReference: { ...artifact.contentReference, sizeBytes: 97 },
      })),
      mutateArtifact(base, "art_model_request", (artifact) => {
        if (artifact.redaction.status !== "applied") throw new Error("Expected redaction record");
        const record = artifact.redaction.records[0];
        if (!record) throw new Error("Expected one redaction record");
        return {
          ...artifact,
          redaction: {
            ...artifact.redaction,
            records: [{ ...record, changedPaths: ["/credential"], matchCount: 2 }],
          },
        };
      }),
      {
        ...base,
        interactionCapture: {
          ...base.interactionCapture,
          interactions: [
            { ...tool, sequence: 0 },
            { ...model, sequence: 1 },
          ],
        },
      },
      {
        ...base,
        interactionCapture: {
          ...base.interactionCapture,
          interactions: [{ ...model, prompt: { ...model.prompt, promptVersion: "9.9.9" } }, tool],
        },
      },
      {
        ...base,
        interactionCapture: {
          ...base.interactionCapture,
          interactions: [model, { ...tool, callId: "call_other_123" }],
        },
      },
      {
        ...base,
        interactionCapture: {
          ...base.interactionCapture,
          interactions: [
            model,
            {
              ...tool,
              attempts: tool.attempts.map((attempt, index) =>
                index === 0 ? { ...attempt, effectMayHaveOccurred: false } : attempt,
              ),
            },
          ],
        },
      },
      {
        ...base,
        interactionCapture: {
          ...base.interactionCapture,
          interactions: [
            model,
            {
              ...tool,
              attempts: tool.attempts.map((attempt, index) =>
                index === 1 ? { ...attempt, sideEffect: "non_idempotent_write" as const } : attempt,
              ),
            },
          ],
        },
      },
    ];

    for (const mutation of mutations) {
      expect(digestRecordedInteractionFixtureVersionDefinition(mutation)).not.toBe(baseDigest);
    }
  });

  it("preserves physical-attempt order without sorting", () => {
    const base = richDefinition();
    const model = base.interactionCapture.interactions[0];
    if (model?.kind !== "model") throw new Error("Expected model interaction");
    const reversedAttempts = [...model.attempts]
      .reverse()
      .map((attempt, sequence) => ({ ...attempt, sequence }));
    const reordered = RecordedInteractionFixtureVersionDefinitionSchema.parse({
      ...base,
      interactionCapture: {
        ...base.interactionCapture,
        interactions: [
          {
            ...model,
            attempts: reversedAttempts,
            terminalOutcome: reversedAttempts.at(-1)?.outcome,
          },
          base.interactionCapture.interactions[1],
        ],
      },
    });
    expect(digestRecordedInteractionFixtureVersionDefinition(reordered)).not.toBe(
      digestRecordedInteractionFixtureVersionDefinition(base),
    );
  });
});

describe("recorded interaction definition validation", () => {
  it.each([
    null,
    { ...minimalDefinition(), unknown: true },
    { ...minimalDefinition(), schemaVersion: "0.1" },
    { ...minimalDefinition(), replayability: "evidence_only" },
    {
      ...minimalDefinition(),
      interactionCapture: {
        ...minimalDefinition().interactionCapture,
        interactions: [],
      },
    },
  ])("rejects malformed or extended definitions before encoding %#", (value) => {
    const utf8 = vi.spyOn(TextEncoder.prototype, "encode");
    expect(() =>
      encodeRecordedInteractionFixtureVersionDefinition(
        value as unknown as RecordedInteractionFixtureVersionDefinition,
      ),
    ).toThrow();
    expect(utf8).not.toHaveBeenCalled();
    utf8.mockRestore();
  });
});
