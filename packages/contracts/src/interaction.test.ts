import { describe, expect, it } from "vitest";
import {
  InteractionArtifactBindingSchema,
  InteractionCaptureManifestSchema,
  MAX_CAPTURE_ATTEMPTS,
} from "./interaction.js";

const SHA = {
  config: "1".repeat(64),
  input: "2".repeat(64),
  modelNormalized: "3".repeat(64),
  output: "4".repeat(64),
  prompt: "5".repeat(64),
  promptVariables: "6".repeat(64),
  request: "7".repeat(64),
  response: "8".repeat(64),
  stream: "9".repeat(64),
  system: "a".repeat(64),
  toolArguments: "b".repeat(64),
  toolContract: "c".repeat(64),
  toolNormalized: "d".repeat(64),
  toolResult: "e".repeat(64),
} as const;

function artifact(
  artifactId: string,
  role:
    | "model.input_messages"
    | "model.normalized_request"
    | "model.output_messages"
    | "model.provider_configuration"
    | "model.provider_request"
    | "model.provider_response"
    | "model.streaming_frames"
    | "model.system_instructions"
    | "prompt.template"
    | "prompt.variables"
    | "tool.arguments"
    | "tool.contract"
    | "tool.normalized_request"
    | "tool.result",
  sha256: string,
) {
  return {
    contentReference: {
      artifactId,
      classification: "confidential",
      mediaType: "application/json",
      sha256,
      sizeBytes: 128,
    },
    redaction: { status: "not_required" },
    retention: { mode: "retain" },
    role,
  } as const;
}

function validManifest() {
  return {
    artifacts: [
      artifact("art_model_config", "model.provider_configuration", SHA.config),
      artifact("art_model_input", "model.input_messages", SHA.input),
      artifact("art_model_normalized", "model.normalized_request", SHA.modelNormalized),
      artifact("art_model_output", "model.output_messages", SHA.output),
      artifact("art_model_prompt", "prompt.template", SHA.prompt),
      artifact("art_model_prompt_vars", "prompt.variables", SHA.promptVariables),
      artifact("art_model_request", "model.provider_request", SHA.request),
      artifact("art_model_response", "model.provider_response", SHA.response),
      artifact("art_model_stream", "model.streaming_frames", SHA.stream),
      artifact("art_model_system", "model.system_instructions", SHA.system),
      artifact("art_tool_args", "tool.arguments", SHA.toolArguments),
      artifact("art_tool_contract", "tool.contract", SHA.toolContract),
      artifact("art_tool_normalized", "tool.normalized_request", SHA.toolNormalized),
      artifact("art_tool_result", "tool.result", SHA.toolResult),
    ],
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
            attemptId: "att_model_one",
            endedAt: "2026-08-29T01:00:02.000Z",
            normalizedRequest: {
              adapterName: "openai.responses",
              adapterVersion: "1.0.0",
              artifactId: "art_model_normalized",
              sha256: SHA.modelNormalized,
            },
            outcome: "succeeded",
            provider: {
              endpointProfileId: "end_openai_prod",
              endpointProfileVersion: "2026-08-01",
              name: "openai",
              operation: "chat",
              requestedModel: "gpt-5.6",
              returnedModel: "gpt-5.6-2026-08-15",
            },
            providerMayHaveProcessed: true,
            providerRequestId: "req_123",
            sequence: 0,
            startedAt: "2026-08-29T01:00:00.000Z",
            streaming: true,
          },
        ],
        interactionId: "int_model_one",
        kind: "model",
        prompt: {
          artifactId: "art_model_prompt",
          definitionSha256: SHA.prompt,
          promptId: "prm_checkout",
          promptVersion: "2026.08.29",
        },
        sequence: 0,
        terminalOutcome: "succeeded",
        toolContracts: [
          {
            artifactId: "art_tool_contract",
            definitionSha256: SHA.toolContract,
            toolId: "tool_charge_card",
            toolVersion: "2.1.0",
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
            attemptId: "att_tool_one",
            effectMayHaveOccurred: true,
            endedAt: "2026-08-29T01:00:04.000Z",
            normalizedRequest: {
              adapterName: "json-schema.tool",
              adapterVersion: "1.0.0",
              artifactId: "art_tool_normalized",
              sha256: SHA.toolNormalized,
            },
            outcome: "succeeded",
            sequence: 0,
            sideEffect: "idempotent_write",
            startedAt: "2026-08-29T01:00:03.000Z",
          },
        ],
        callId: "call_abc",
        interactionId: "int_tool_one",
        kind: "tool",
        sequence: 1,
        terminalOutcome: "succeeded",
        tool: {
          artifactId: "art_tool_contract",
          definitionSha256: SHA.toolContract,
          toolId: "tool_charge_card",
          toolVersion: "2.1.0",
        },
      },
    ],
    schemaVersion: "0.1",
    source: {
      boundary: "application_provider_and_tool",
      captureAdapter: { name: "proofstack.capture", version: "1.0.0" },
      completeness: {
        limitations: [
          "transport_metadata_excluded",
          "provider_internal_state_unobserved",
          "hidden_reasoning_excluded",
        ],
        status: "complete_for_declared_boundary",
      },
      sourceFormat: { name: "proofstack.interaction", version: "1.0.0" },
    },
  } as const;
}

describe("InteractionCaptureManifestSchema", () => {
  it("accepts one exact ordered model and tool capture", () => {
    const value = validManifest();
    expect(InteractionCaptureManifestSchema.parse(value)).toEqual(value);
  });

  it.each([
    { unknown: true },
    { schemaVersion: "0.2" },
    { source: { ...validManifest().source, unknown: true } },
    {
      source: {
        ...validManifest().source,
        completeness: {
          ...validManifest().source.completeness,
          limitations: ["provider_internal_state_unobserved", "transport_metadata_excluded"],
        },
      },
    },
    {
      source: {
        ...validManifest().source,
        completeness: {
          ...validManifest().source.completeness,
          limitations: ["transport_metadata_excluded", "transport_metadata_excluded"],
        },
      },
    },
  ])("rejects an invalid top-level or source contract %#", (override) => {
    expect(
      InteractionCaptureManifestSchema.safeParse({ ...validManifest(), ...override }).success,
    ).toBe(false);
  });

  it("requires artifact identifiers to be unique and canonically ordered", () => {
    const value = validManifest();
    expect(
      InteractionCaptureManifestSchema.safeParse({
        ...value,
        artifacts: [value.artifacts[1], value.artifacts[0], ...value.artifacts.slice(2)],
      }).success,
    ).toBe(false);
    expect(
      InteractionCaptureManifestSchema.safeParse({
        ...value,
        artifacts: [value.artifacts[0], value.artifacts[0], ...value.artifacts.slice(1)],
      }).success,
    ).toBe(false);
  });

  it("rejects unreferenced, missing, and incorrectly typed artifacts", () => {
    const value = validManifest();
    const extra = artifact("art_unused", "tool.result", "f".repeat(64));
    expect(
      InteractionCaptureManifestSchema.safeParse({
        ...value,
        artifacts: [...value.artifacts, extra],
      }).success,
    ).toBe(false);

    const model = value.interactions[0];
    const attempt = model.attempts[0];
    expect(
      InteractionCaptureManifestSchema.safeParse({
        ...value,
        interactions: [
          {
            ...model,
            attempts: [
              {
                ...attempt,
                artifacts: {
                  ...attempt.artifacts,
                  providerRequestArtifactId: "art_missing_request",
                },
              },
            ],
          },
          value.interactions[1],
        ],
      }).success,
    ).toBe(false);

    expect(
      InteractionCaptureManifestSchema.safeParse({
        ...value,
        artifacts: value.artifacts.map((binding) =>
          binding.contentReference.artifactId === "art_model_request"
            ? { ...binding, role: "tool.arguments" }
            : binding,
        ),
      }).success,
    ).toBe(false);
  });

  it("binds prompt, tool-contract, and normalized-request digests", () => {
    const value = validManifest();
    const model = value.interactions[0];
    const tool = value.interactions[1];
    expect(
      InteractionCaptureManifestSchema.safeParse({
        ...value,
        interactions: [
          { ...model, prompt: { ...model.prompt, definitionSha256: SHA.output } },
          tool,
        ],
      }).success,
    ).toBe(false);
    expect(
      InteractionCaptureManifestSchema.safeParse({
        ...value,
        interactions: [
          {
            ...model,
            toolContracts: [{ ...model.toolContracts[0], definitionSha256: SHA.output }],
          },
          tool,
        ],
      }).success,
    ).toBe(false);
    expect(
      InteractionCaptureManifestSchema.safeParse({
        ...value,
        interactions: [
          {
            ...model,
            attempts: [
              {
                ...model.attempts[0],
                normalizedRequest: {
                  ...model.attempts[0].normalizedRequest,
                  sha256: SHA.output,
                },
              },
            ],
          },
          tool,
        ],
      }).success,
    ).toBe(false);
    expect(
      InteractionCaptureManifestSchema.safeParse({
        ...value,
        interactions: [
          model,
          {
            ...tool,
            attempts: [
              {
                ...tool.attempts[0],
                normalizedRequest: {
                  ...tool.attempts[0].normalizedRequest,
                  sha256: SHA.output,
                },
              },
            ],
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("requires offered tools to be unique and canonically ordered", () => {
    const value = validManifest();
    const model = value.interactions[0];
    const offered = model.toolContracts[0];
    expect(
      InteractionCaptureManifestSchema.safeParse({
        ...value,
        interactions: [
          {
            ...model,
            toolContracts: [
              { ...offered, toolId: "tool_zeta" },
              { ...offered, toolId: "tool_alpha" },
            ],
          },
          value.interactions[1],
        ],
      }).success,
    ).toBe(false);
    expect(
      InteractionCaptureManifestSchema.safeParse({
        ...value,
        interactions: [{ ...model, toolContracts: [offered, offered] }, value.interactions[1]],
      }).success,
    ).toBe(false);
  });

  it("requires one semantic identity per prompt, tool contract, and normalized artifact", () => {
    const value = validManifest();
    const model = value.interactions[0];
    const tool = value.interactions[1];
    expect(
      InteractionCaptureManifestSchema.safeParse({
        ...value,
        interactions: [model, { ...tool, tool: { ...tool.tool, toolVersion: "9.9.9" } }],
      }).success,
    ).toBe(false);

    const secondModel = {
      ...model,
      attempts: [
        {
          ...model.attempts[0],
          attemptId: "att_model_two",
          normalizedRequest: {
            ...model.attempts[0].normalizedRequest,
            adapterVersion: "9.9.9",
          },
        },
      ],
      interactionId: "int_model_two",
      sequence: 2,
    } as const;
    expect(
      InteractionCaptureManifestSchema.safeParse({
        ...value,
        interactions: [model, tool, secondModel],
      }).success,
    ).toBe(false);
    expect(
      InteractionCaptureManifestSchema.safeParse({
        ...value,
        interactions: [
          model,
          tool,
          {
            ...secondModel,
            attempts: [
              {
                ...secondModel.attempts[0],
                normalizedRequest: model.attempts[0].normalizedRequest,
              },
            ],
            prompt: { ...model.prompt, promptVersion: "9.9.9" },
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("requires contiguous unique interaction and attempt identities", () => {
    const value = validManifest();
    const model = value.interactions[0];
    const tool = value.interactions[1];
    expect(
      InteractionCaptureManifestSchema.safeParse({
        ...value,
        interactions: [model, { ...tool, sequence: 2 }],
      }).success,
    ).toBe(false);
    expect(
      InteractionCaptureManifestSchema.safeParse({
        ...value,
        interactions: [model, { ...tool, interactionId: model.interactionId }],
      }).success,
    ).toBe(false);
    expect(
      InteractionCaptureManifestSchema.safeParse({
        ...value,
        interactions: [
          model,
          {
            ...tool,
            attempts: [{ ...tool.attempts[0], attemptId: model.attempts[0].attemptId }],
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      InteractionCaptureManifestSchema.safeParse({
        ...value,
        interactions: [model, { ...tool, attempts: [{ ...tool.attempts[0], sequence: 1 }] }],
      }).success,
    ).toBe(false);
    expect(
      InteractionCaptureManifestSchema.safeParse({
        ...value,
        interactions: [model, { ...tool, terminalOutcome: "failed" }],
      }).success,
    ).toBe(false);
  });

  it("requires unique tool call identifiers", () => {
    const value = validManifest();
    const second = value.interactions[1];
    expect(
      InteractionCaptureManifestSchema.safeParse({
        ...value,
        interactions: [
          value.interactions[0],
          second,
          {
            ...second,
            attempts: [{ ...second.attempts[0], attemptId: "att_tool_two" }],
            interactionId: "int_tool_two",
            sequence: 2,
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects captures over the total physical-attempt limit", () => {
    const value = validManifest();
    const tool = value.interactions[1];
    const interactions = Array.from({ length: MAX_CAPTURE_ATTEMPTS / 8 + 1 }, (_, index) => ({
      ...tool,
      attempts: Array.from({ length: 8 }, (_unused, attemptIndex) => ({
        ...tool.attempts[0],
        attemptId: `att_${index}_${attemptIndex}`,
        sequence: attemptIndex,
      })),
      callId: `call_${index}`,
      interactionId: `int_${index}`,
      sequence: index,
    }));
    const usedArtifactIds = new Set([
      "art_tool_args",
      "art_tool_contract",
      "art_tool_normalized",
      "art_tool_result",
    ]);
    expect(
      InteractionCaptureManifestSchema.safeParse({
        ...value,
        artifacts: value.artifacts.filter(({ contentReference }) =>
          usedArtifactIds.has(contentReference.artifactId),
        ),
        interactions,
      }).success,
    ).toBe(false);
  });
});

describe("interaction attempt invariants", () => {
  it.each([
    {
      endedAt: "2026-08-29T00:59:59.000Z",
    },
    {
      errorType: "provider_error",
    },
    {
      errorType: undefined,
      outcome: "failed",
    },
    {
      artifacts: {
        ...validManifest().interactions[0].attempts[0].artifacts,
        providerResponseArtifactId: undefined,
      },
    },
    {
      artifacts: {
        ...validManifest().interactions[0].attempts[0].artifacts,
        outputMessagesArtifactId: undefined,
      },
    },
    {
      artifacts: {
        ...validManifest().interactions[0].attempts[0].artifacts,
        streamingFramesArtifactId: undefined,
      },
    },
    {
      streaming: false,
    },
  ])("rejects invalid model attempt semantics %#", (override) => {
    const value = validManifest();
    const model = value.interactions[0];
    expect(
      InteractionCaptureManifestSchema.safeParse({
        ...value,
        interactions: [
          { ...model, attempts: [{ ...model.attempts[0], ...override }] },
          value.interactions[1],
        ],
      }).success,
    ).toBe(false);
  });

  it.each([
    {
      artifacts: {
        argumentsArtifactId: "art_tool_args",
        resultArtifactId: undefined,
      },
    },
    {
      effectMayHaveOccurred: true,
      sideEffect: "read_only",
    },
    {
      effectMayHaveOccurred: false,
      sideEffect: "idempotent_write",
    },
    {
      errorType: "tool_error",
    },
    {
      errorType: undefined,
      outcome: "timed_out",
    },
  ])("rejects invalid tool attempt semantics %#", (override) => {
    const value = validManifest();
    const tool = value.interactions[1];
    expect(
      InteractionCaptureManifestSchema.safeParse({
        ...value,
        interactions: [
          value.interactions[0],
          { ...tool, attempts: [{ ...tool.attempts[0], ...override }] },
        ],
      }).success,
    ).toBe(false);
  });
});

describe("InteractionArtifactBindingSchema", () => {
  it("accepts source-stage redaction with matching protected metadata", () => {
    const value = artifact("art_redacted", "tool.result", "f".repeat(64));
    expect(
      InteractionArtifactBindingSchema.safeParse({
        ...value,
        contentReference: { ...value.contentReference, redactedAt: "source" },
        redaction: {
          records: [
            {
              changedPaths: ["/token"],
              matchCount: 1,
              rulesetId: "red_capture",
              rulesetVersion: "1.0.0",
              stage: "source",
            },
          ],
          status: "applied",
        },
      }).success,
    ).toBe(true);
  });

  it.each([
    { contentReference: { classification: "metadata" } },
    { contentReference: { redactedAt: "source" } },
    { retention: { expiresAt: "2026-08-30T00:00:00.000Z", mode: "expire" } },
    { unknown: true },
  ])("rejects an unsafe ownership binding %#", (override) => {
    const value = artifact("art_invalid", "tool.result", "f".repeat(64));
    expect(
      InteractionArtifactBindingSchema.safeParse({
        ...value,
        ...override,
        ...(override.contentReference
          ? { contentReference: { ...value.contentReference, ...override.contentReference } }
          : {}),
      }).success,
    ).toBe(false);
  });
});
