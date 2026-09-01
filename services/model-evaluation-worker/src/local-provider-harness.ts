import { createHash } from "node:crypto";
import {
  ArtifactContentReferenceSchema,
  type ModelEvaluatorProfile,
  ModelEvaluatorProfileSchema,
  OpaqueIdSchema,
  UtcMillisecondTimestampSchema,
} from "@proofstack/contracts";

export type LocalModelOperation = "blinded_evaluation" | "independent_critique" | "qualification";

export interface LocalModelInput {
  readonly bytes: Uint8Array;
  readonly reference: unknown;
}

export interface LocalModelUsage {
  readonly costMicrousd: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface LocalModelCompletedFixture {
  readonly expectedRequestSha256: string;
  readonly modelProfileDefinitionSha256: string;
  readonly operation: LocalModelOperation;
  readonly responseBytes: Uint8Array;
  readonly status: "completed";
  readonly usage: LocalModelUsage;
}

export interface LocalModelFailedFixture {
  readonly code: "deadline_exceeded" | "provider_refusal" | "provider_unavailable";
  readonly expectedRequestSha256: string;
  readonly modelProfileDefinitionSha256: string;
  readonly operation: LocalModelOperation;
  readonly status: "failed";
}

export type LocalModelFixture = LocalModelCompletedFixture | LocalModelFailedFixture;

export interface LocalModelHarnessRequest {
  readonly attemptId: string;
  readonly executedAt: string;
  readonly inputs: readonly LocalModelInput[];
  readonly modelProfile: unknown;
  readonly operation: LocalModelOperation;
  readonly requestOrdinal: number;
}

export interface LocalModelCompletedResult {
  readonly attemptId: string;
  readonly modelProfileDefinitionSha256: string;
  readonly operation: LocalModelOperation;
  readonly output: unknown;
  readonly recordedToolRequests: readonly unknown[];
  readonly requestSha256: string;
  readonly responseBytes: Uint8Array;
  readonly responseSha256: string;
  readonly status: "completed";
  readonly usage: LocalModelUsage;
}

export interface LocalModelFailedResult {
  readonly attemptId: string;
  readonly code: LocalModelFailedFixture["code"];
  readonly modelProfileDefinitionSha256: string;
  readonly operation: LocalModelOperation;
  readonly requestSha256: string;
  readonly status: "failed";
}

export type LocalModelHarnessResult = LocalModelCompletedResult | LocalModelFailedResult;

export type LocalModelHarnessErrorCode =
  | "artifact_content_mismatch"
  | "fixture_mismatch"
  | "input_budget_exceeded"
  | "invalid_fixture"
  | "invalid_profile"
  | "invalid_request"
  | "output_budget_exceeded"
  | "output_malformed"
  | "plaintext_denied"
  | "profile_inactive"
  | "usage_budget_exceeded";

export class LocalModelHarnessError extends Error {
  readonly code: LocalModelHarnessErrorCode;

  constructor(code: LocalModelHarnessErrorCode) {
    super(`Local model provider harness rejected execution: ${code}`);
    this.name = "LocalModelHarnessError";
    this.code = code;
  }
}

interface ValidatedInput {
  readonly bytes: Uint8Array;
  readonly reference: ReturnType<typeof ArtifactContentReferenceSchema.parse>;
}

function reject(code: LocalModelHarnessErrorCode): never {
  throw new LocalModelHarnessError(code);
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function validateProfile(candidate: unknown): ModelEvaluatorProfile {
  const profile = ModelEvaluatorProfileSchema.safeParse(candidate);
  if (!profile.success) reject("invalid_profile");
  return profile.data;
}

function validateInputs(
  profile: ModelEvaluatorProfile,
  inputs: readonly LocalModelInput[],
): readonly ValidatedInput[] {
  if (inputs.length < 1 || inputs.length > 64) reject("invalid_request");
  if (
    profile.dataPolicy.artifactPlaintext === "denied" ||
    profile.dataPolicy.dataEgress === "metadata_only"
  ) {
    reject("plaintext_denied");
  }
  const validated = inputs.map(({ bytes, reference }) => {
    const parsed = ArtifactContentReferenceSchema.safeParse(reference);
    if (!parsed.success || !(bytes instanceof Uint8Array)) reject("invalid_request");
    const cloned = Uint8Array.from(bytes);
    if (cloned.byteLength !== parsed.data.sizeBytes || sha256(cloned) !== parsed.data.sha256) {
      reject("artifact_content_mismatch");
    }
    return { bytes: cloned, reference: parsed.data };
  });
  const keys = validated.map(({ reference }) => `${reference.artifactId}:${reference.sha256}`);
  if (keys.slice(1).some((key, index) => key <= (keys[index] as string))) {
    reject("invalid_request");
  }
  const totalBytes = validated.reduce((total, { bytes }) => total + bytes.byteLength, 0);
  if (totalBytes > profile.budgets.inputBytes) reject("input_budget_exceeded");
  return validated;
}

function validateRequest(request: LocalModelHarnessRequest): {
  readonly inputs: readonly ValidatedInput[];
  readonly profile: ModelEvaluatorProfile;
} {
  const profile = validateProfile(request.modelProfile);
  if (
    !OpaqueIdSchema.safeParse(request.attemptId).success ||
    !Number.isInteger(request.requestOrdinal) ||
    request.requestOrdinal < 1 ||
    request.requestOrdinal > profile.budgets.requests
  ) {
    reject("invalid_request");
  }
  if (!UtcMillisecondTimestampSchema.safeParse(request.executedAt).success) {
    reject("invalid_request");
  }
  const executed = Date.parse(request.executedAt);
  if (executed < Date.parse(profile.validFrom) || executed > Date.parse(profile.validUntil)) {
    reject("profile_inactive");
  }
  return { inputs: validateInputs(profile, request.inputs), profile };
}

function requestSha256(
  request: LocalModelHarnessRequest,
  profile: ModelEvaluatorProfile,
  inputs: readonly ValidatedInput[],
): string {
  const hash = createHash("sha256");
  hash.update("proofstack.local-model-request.v1\0", "utf8");
  hash.update(request.operation, "utf8");
  hash.update("\0", "utf8");
  hash.update(request.attemptId, "utf8");
  hash.update("\0", "utf8");
  hash.update(String(request.requestOrdinal), "utf8");
  hash.update("\0", "utf8");
  hash.update(profile.definitionSha256, "utf8");
  for (const { bytes, reference } of inputs) {
    hash.update("\0", "utf8");
    hash.update(reference.artifactId, "utf8");
    hash.update("\0", "utf8");
    hash.update(reference.sha256, "utf8");
    hash.update("\0", "utf8");
    hash.update(bytes);
  }
  return hash.digest("hex");
}

function validateUsage(profile: ModelEvaluatorProfile, usage: LocalModelUsage): LocalModelUsage {
  const values = [usage.costMicrousd, usage.inputTokens, usage.outputTokens];
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    reject("invalid_fixture");
  }
  if (
    usage.costMicrousd > profile.budgets.maximumCostMicrousd ||
    usage.inputTokens > profile.budgets.inputTokens ||
    usage.outputTokens > profile.budgets.outputTokens
  ) {
    reject("usage_budget_exceeded");
  }
  return Object.freeze({ ...usage });
}

function parseOutput(responseBytes: Uint8Array): {
  readonly output: unknown;
  readonly recordedToolRequests: readonly unknown[];
} {
  let output: unknown;
  try {
    output = JSON.parse(Buffer.from(responseBytes).toString("utf8"));
  } catch {
    reject("output_malformed");
  }
  const toolRequests =
    typeof output === "object" && output !== null && "toolRequests" in output
      ? (output as { readonly toolRequests?: unknown }).toolRequests
      : undefined;
  if (toolRequests !== undefined && (!Array.isArray(toolRequests) || toolRequests.length > 32)) {
    reject("output_malformed");
  }
  return {
    output,
    recordedToolRequests: Object.freeze(
      Array.isArray(toolRequests) ? structuredClone(toolRequests) : [],
    ),
  };
}

export function computeLocalModelRequestSha256(request: LocalModelHarnessRequest): string {
  const { inputs, profile } = validateRequest(request);
  return requestSha256(request, profile, inputs);
}

export function runBoundedLocalModelProvider(
  request: LocalModelHarnessRequest,
  fixture: LocalModelFixture,
): LocalModelHarnessResult {
  const { inputs, profile } = validateRequest(request);
  const exactRequestSha256 = requestSha256(request, profile, inputs);
  if (
    fixture.expectedRequestSha256 !== exactRequestSha256 ||
    fixture.modelProfileDefinitionSha256 !== profile.definitionSha256 ||
    fixture.operation !== request.operation
  ) {
    reject("fixture_mismatch");
  }
  if (fixture.status === "failed") {
    return Object.freeze({
      attemptId: request.attemptId,
      code: fixture.code,
      modelProfileDefinitionSha256: profile.definitionSha256,
      operation: request.operation,
      requestSha256: exactRequestSha256,
      status: "failed",
    });
  }
  const responseBytes = Uint8Array.from(fixture.responseBytes);
  if (responseBytes.byteLength > profile.budgets.outputBytes) {
    reject("output_budget_exceeded");
  }
  const { output, recordedToolRequests } = parseOutput(responseBytes);
  return Object.freeze({
    attemptId: request.attemptId,
    modelProfileDefinitionSha256: profile.definitionSha256,
    operation: request.operation,
    output,
    recordedToolRequests,
    requestSha256: exactRequestSha256,
    responseBytes,
    responseSha256: sha256(responseBytes),
    status: "completed",
    usage: validateUsage(profile, fixture.usage),
  });
}
