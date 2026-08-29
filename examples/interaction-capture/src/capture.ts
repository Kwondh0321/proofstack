import { createHash } from "node:crypto";
import {
  type InteractionArtifactBinding,
  type InteractionArtifactRole,
  type InteractionCaptureManifest,
  InteractionCaptureManifestSchema,
} from "@proofstack/contracts";

const encoder = new TextEncoder();
const EXAMPLE_SUFFIX_PATTERN = /^[0-9a-f]{12}$/;

type ArtifactKey =
  | "model_config"
  | "model_input"
  | "model_normalized"
  | "model_output"
  | "model_prompt"
  | "model_request"
  | "model_response"
  | "tool_arguments"
  | "tool_contract"
  | "tool_normalized"
  | "tool_result";

interface ArtifactSource {
  readonly content: Uint8Array;
  readonly mediaType: "application/json" | "text/plain";
  readonly role: InteractionArtifactRole;
}

export interface ProviderNeutralCapture {
  readonly contentByArtifactId: ReadonlyMap<string, Uint8Array>;
  readonly manifest: InteractionCaptureManifest;
  readonly sensitiveMarkers: readonly string[];
}

function jsonContent(value: unknown): Uint8Array {
  return encoder.encode(`${JSON.stringify(value)}\n`);
}

function textContent(value: string): Uint8Array {
  return encoder.encode(value);
}

function sha256(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function addMilliseconds(instant: Date, milliseconds: number): string {
  return new Date(instant.getTime() + milliseconds).toISOString();
}

export function createProviderNeutralCapture(
  suffix: string,
  startedAt = new Date(),
): ProviderNeutralCapture {
  if (!EXAMPLE_SUFFIX_PATTERN.test(suffix)) {
    throw new TypeError("Capture suffix must contain exactly 12 lowercase hexadecimal characters");
  }

  const customerMarker = `customer-sensitive-${suffix}`;
  const failureMarker = `warehouse-failure-${suffix}`;
  const callId = `call_${suffix}`;
  const promptText =
    "Resolve the checkout request using only the offered inventory lookup tool. Do not invent stock.\n";
  const toolContract = {
    description: "Read the current stock count for one SKU.",
    inputSchema: {
      additionalProperties: false,
      properties: { sku: { type: "string" } },
      required: ["sku"],
      type: "object",
    },
    name: "inventory.lookup",
    sideEffect: "read_only",
    version: "1.0.0",
  };
  const toolArguments = { customerReference: customerMarker, sku: "SKU-42" };
  const artifactSources: Readonly<Record<ArtifactKey, ArtifactSource>> = {
    model_config: {
      content: jsonContent({
        endpointProfile: "reference-local",
        operation: "chat",
        provider: "provider-neutral",
        requestedModel: "reference-model-v1",
      }),
      mediaType: "application/json",
      role: "model.provider_configuration",
    },
    model_input: {
      content: jsonContent([
        {
          content: `Check whether SKU-42 can be ordered for ${customerMarker}.`,
          role: "user",
        },
      ]),
      mediaType: "application/json",
      role: "model.input_messages",
    },
    model_normalized: {
      content: jsonContent({
        messages: [
          {
            content: `Check whether SKU-42 can be ordered for ${customerMarker}.`,
            role: "user",
          },
        ],
        model: "reference-model-v1",
        operation: "chat",
        tools: [{ name: toolContract.name, version: toolContract.version }],
      }),
      mediaType: "application/json",
      role: "model.normalized_request",
    },
    model_output: {
      content: jsonContent([
        {
          callId,
          name: toolContract.name,
          role: "assistant",
          toolArguments,
        },
      ]),
      mediaType: "application/json",
      role: "model.output_messages",
    },
    model_prompt: {
      content: textContent(promptText),
      mediaType: "text/plain",
      role: "prompt.template",
    },
    model_request: {
      content: jsonContent({
        input: [
          {
            content: `Check whether SKU-42 can be ordered for ${customerMarker}.`,
            role: "user",
          },
        ],
        model: "reference-model-v1",
        tools: [toolContract],
      }),
      mediaType: "application/json",
      role: "model.provider_request",
    },
    model_response: {
      content: jsonContent({
        id: `response_${suffix}`,
        model: "reference-model-v1",
        output: [{ arguments: toolArguments, callId, name: toolContract.name, type: "tool_call" }],
      }),
      mediaType: "application/json",
      role: "model.provider_response",
    },
    tool_arguments: {
      content: jsonContent(toolArguments),
      mediaType: "application/json",
      role: "tool.arguments",
    },
    tool_contract: {
      content: jsonContent(toolContract),
      mediaType: "application/json",
      role: "tool.contract",
    },
    tool_normalized: {
      content: jsonContent({
        arguments: toolArguments,
        name: toolContract.name,
        version: toolContract.version,
      }),
      mediaType: "application/json",
      role: "tool.normalized_request",
    },
    tool_result: {
      content: jsonContent({
        error: { code: "warehouse_unavailable", reference: failureMarker },
        ok: false,
      }),
      mediaType: "application/json",
      role: "tool.result",
    },
  };
  const artifactEntries = Object.entries(artifactSources) as [ArtifactKey, ArtifactSource][];

  const artifactId = (key: ArtifactKey): string => `art_${suffix}_${key}`;
  const contentByArtifactId = new Map(
    artifactEntries.map(([key, source]) => [artifactId(key), source.content] as const),
  );
  const bindings: InteractionArtifactBinding[] = artifactEntries
    .map(([key, source]) => ({
      contentReference: {
        artifactId: artifactId(key),
        classification: "confidential" as const,
        mediaType: source.mediaType,
        sha256: sha256(source.content),
        sizeBytes: source.content.byteLength,
      },
      redaction: { status: "not_required" as const },
      retention: { mode: "retain" as const },
      role: source.role,
    }))
    .sort((left, right) =>
      left.contentReference.artifactId.localeCompare(right.contentReference.artifactId),
    );
  const digestFor = (key: ArtifactKey): string => sha256(artifactSources[key].content);

  const toolReference = {
    artifactId: artifactId("tool_contract"),
    definitionSha256: digestFor("tool_contract"),
    toolId: "tool_inventory_lookup",
    toolVersion: "1.0.0",
  } as const;
  const manifest = InteractionCaptureManifestSchema.parse({
    artifacts: bindings,
    interactions: [
      {
        attempts: [
          {
            artifacts: {
              inputMessagesArtifactId: artifactId("model_input"),
              outputMessagesArtifactId: artifactId("model_output"),
              providerConfigurationArtifactId: artifactId("model_config"),
              providerRequestArtifactId: artifactId("model_request"),
              providerResponseArtifactId: artifactId("model_response"),
            },
            attemptId: `att_${suffix}_model_0`,
            endedAt: addMilliseconds(startedAt, 900),
            normalizedRequest: {
              adapterName: "proofstack.reference.model",
              adapterVersion: "1.0.0",
              artifactId: artifactId("model_normalized"),
              sha256: digestFor("model_normalized"),
            },
            outcome: "succeeded",
            provider: {
              endpointProfileId: `end_${suffix}`,
              endpointProfileVersion: "1.0.0",
              name: "provider-neutral",
              operation: "chat",
              requestedModel: "reference-model-v1",
              returnedModel: "reference-model-v1",
            },
            providerMayHaveProcessed: true,
            providerRequestId: `request_${suffix}`,
            sequence: 0,
            startedAt: addMilliseconds(startedAt, 100),
            streaming: false,
          },
        ],
        interactionId: `int_${suffix}_model`,
        kind: "model",
        prompt: {
          artifactId: artifactId("model_prompt"),
          definitionSha256: digestFor("model_prompt"),
          promptId: "prompt_checkout_inventory",
          promptVersion: "1.0.0",
        },
        sequence: 0,
        terminalOutcome: "succeeded",
        toolContracts: [toolReference],
      },
      {
        attempts: [
          {
            artifacts: {
              argumentsArtifactId: artifactId("tool_arguments"),
              resultArtifactId: artifactId("tool_result"),
            },
            attemptId: `att_${suffix}_tool_0`,
            effectMayHaveOccurred: false,
            endedAt: addMilliseconds(startedAt, 1_500),
            errorType: "warehouse_unavailable",
            normalizedRequest: {
              adapterName: "proofstack.reference.tool",
              adapterVersion: "1.0.0",
              artifactId: artifactId("tool_normalized"),
              sha256: digestFor("tool_normalized"),
            },
            outcome: "failed",
            sequence: 0,
            sideEffect: "read_only",
            startedAt: addMilliseconds(startedAt, 1_000),
          },
        ],
        callId,
        interactionId: `int_${suffix}_tool`,
        kind: "tool",
        sequence: 1,
        terminalOutcome: "failed",
        tool: toolReference,
      },
    ],
    schemaVersion: "0.1",
    source: {
      boundary: "application_provider_and_tool",
      captureAdapter: { name: "proofstack.reference_capture", version: "1.0.0" },
      completeness: {
        limitations: [
          "transport_metadata_excluded",
          "provider_internal_state_unobserved",
          "hidden_reasoning_excluded",
          "uninstrumented_subprocesses_unobserved",
          "undeclared_side_effects_unobserved",
        ],
        status: "complete_for_declared_boundary",
      },
      sourceFormat: { name: "proofstack.interaction", version: "1.0.0" },
    },
  });

  return {
    contentByArtifactId,
    manifest,
    sensitiveMarkers: [customerMarker, failureMarker],
  };
}
