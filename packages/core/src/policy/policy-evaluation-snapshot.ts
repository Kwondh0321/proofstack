import { createHash } from "node:crypto";
import {
  encodePolicyEvaluationSnapshotDefinition,
  encodePolicyEvaluationSnapshotInputs,
  encodePolicyEvaluationSnapshotPageDefinition,
  MAX_POLICY_EVALUATION_SNAPSHOT_INPUT_BYTES,
  POLICY_EVALUATION_SNAPSHOT_FRAME_BYTES,
  POLICY_EVALUATION_SNAPSHOT_INPUTS_DOMAIN,
  POLICY_EVALUATION_SNAPSHOT_INPUTS_ENCODING_VERSION,
  POLICY_EVALUATION_SNAPSHOT_INPUTS_DOMAIN_V2,
  POLICY_EVALUATION_SNAPSHOT_INPUTS_ENCODING_VERSION_V2,
  POLICY_EVALUATION_SNAPSHOT_PAGE_SIZE,
  POLICY_EVALUATION_SNAPSHOT_SCHEMA_VERSION,
  PolicyEvaluationSnapshotInputsSchema,
  PolicyEvaluationSnapshotPageSetSchema,
  type EvidenceScope,
  type PolicyEvaluationRequestReference,
  type PolicyEvaluationSnapshotInputs,
  type PolicyEvaluationSnapshotPage,
  type PolicyEvaluationSnapshotPageSet,
  type PolicyEvaluationSnapshotReference,
  serializeEvaluationCanonicalJson,
} from "@proofstack/contracts";
import { validatePolicyEvaluationRequestRecord } from "./policy-evaluation-request-record-validation.js";
import { validatePolicyEvaluationSnapshotSources } from "./policy-evaluation-snapshot-sources.js";
import { validateReleaseCandidateRecord } from "../release/release-candidate-record-validation.js";
import { validateReleasePolicyRecord } from "./release-policy-record-validation.js";

export class PolicyEvaluationSnapshotIntegrityError extends Error {
  constructor(
    readonly code:
      | "invalid_snapshot"
      | "reference_mismatch"
      | "digest_mismatch"
      | "input_limit"
      | "invalid_inputs",
    options?: ErrorOptions,
  ) {
    super(`Invalid policy evaluation snapshot: ${code}`, options);
    this.name = "PolicyEvaluationSnapshotIntegrityError";
  }
}
function digest(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}
function same(left: unknown, right: unknown) {
  return serializeEvaluationCanonicalJson(left) === serializeEvaluationCanonicalJson(right);
}
function validateRoots(inputs: PolicyEvaluationSnapshotInputs): void {
  try {
    validateReleaseCandidateRecord(inputs.roots.candidate);
    validateReleasePolicyRecord(inputs.roots.policy);
    if (
      digest(new TextEncoder().encode(serializeEvaluationCanonicalJson(inputs.roots.candidate))) !==
        inputs.rules.candidate.recordSha256 ||
      digest(new TextEncoder().encode(serializeEvaluationCanonicalJson(inputs.roots.policy))) !==
        inputs.rules.policy.recordSha256
    )
      throw new Error("Original root body witnesses do not match full retained definitions");
  } catch (cause) {
    throw new PolicyEvaluationSnapshotIntegrityError("invalid_inputs", { cause });
  }
}

/** Fixed canonical storage pages. This assembles definitions, not a sealed publication receipt. */
export function assemblePolicyEvaluationSnapshot(input: {
  snapshotId: string;
  inputs: PolicyEvaluationSnapshotInputs;
}): PolicyEvaluationSnapshotPageSet {
  const inputs = PolicyEvaluationSnapshotInputsSchema.parse(input.inputs);
  validatePolicyEvaluationRequestRecord(inputs.request);
  validateRoots(inputs);
  const bytes = encodePolicyEvaluationSnapshotInputs(inputs);
  if (bytes.byteLength > MAX_POLICY_EVALUATION_SNAPSHOT_INPUT_BYTES)
    throw new PolicyEvaluationSnapshotIntegrityError("input_limit");
  const inputSha256 = digest(bytes);
  const frameCount = Math.ceil(bytes.byteLength / POLICY_EVALUATION_SNAPSHOT_FRAME_BYTES);
  const request = {
    evaluationRequestId: inputs.request.evaluationRequestId,
    definitionSha256: inputs.request.definitionSha256,
  };
  const scope = inputs.request.scope;
  validatePolicyEvaluationSnapshotSources({
    expected: {
      request,
      scope,
      evaluationTime: inputs.request.evaluationTime,
      manifest: {
        manifestId: inputs.manifest.manifest.manifestId,
        definitionSha256: inputs.manifest.manifest.definitionSha256,
      },
    },
    sources: inputs.sources,
    pageSet: inputs.manifest,
  });
  const pages: PolicyEvaluationSnapshotPage[] = [];
  for (let first = 0; first < frameCount; first += POLICY_EVALUATION_SNAPSHOT_PAGE_SIZE) {
    const frames = [];
    for (
      let index = first;
      index < Math.min(first + POLICY_EVALUATION_SNAPSHOT_PAGE_SIZE, frameCount);
      index++
    )
      frames.push({
        frameIndex: index,
        dataBase64url: Buffer.from(
          bytes.subarray(
            index * POLICY_EVALUATION_SNAPSHOT_FRAME_BYTES,
            Math.min((index + 1) * POLICY_EVALUATION_SNAPSHOT_FRAME_BYTES, bytes.byteLength),
          ),
        ).toString("base64url"),
      });
    const definition = {
      snapshotId: input.snapshotId,
      request,
      inputSha256,
      inputByteLength: bytes.byteLength,
      frameCount,
      pageIndex: pages.length,
      frames,
    };
    pages.push({
      ...definition,
      scope,
      schemaVersion: POLICY_EVALUATION_SNAPSHOT_SCHEMA_VERSION,
      definitionSha256: digest(encodePolicyEvaluationSnapshotPageDefinition({ definition, scope })),
    });
  }
  const definition = {
    snapshotId: input.snapshotId,
    request,
    candidate: inputs.request.candidate,
    policy: inputs.request.policy,
    algorithm: inputs.request.algorithm,
    evaluationTime: inputs.request.evaluationTime,
    capturedAt: inputs.capturedAt,
    manifest: {
      manifestId: inputs.manifest.manifest.manifestId,
      definitionSha256: inputs.manifest.manifest.definitionSha256,
    },
    inputSha256,
    inputByteLength: bytes.byteLength,
    frameCount,
    pages: pages.map((page) => ({
      pageIndex: page.pageIndex,
      definitionSha256: page.definitionSha256,
      firstFrameIndex: page.frames[0]!.frameIndex,
      frameCount: page.frames.length,
    })),
  };
  return PolicyEvaluationSnapshotPageSetSchema.parse({
    definition,
    scope,
    definitionSha256: digest(encodePolicyEvaluationSnapshotDefinition({ definition, scope })),
    pages,
  });
}

/** Validate complete pages, canonical bytes and typed inputs against an independently known root. */
export function validatePolicyEvaluationSnapshot(input: {
  expected: {
    snapshot: PolicyEvaluationSnapshotReference;
    request: PolicyEvaluationRequestReference;
    scope: EvidenceScope;
  };
  pageSet: PolicyEvaluationSnapshotPageSet;
}): PolicyEvaluationSnapshotInputs {
  const parsed = PolicyEvaluationSnapshotPageSetSchema.safeParse(input.pageSet);
  if (!parsed.success)
    throw new PolicyEvaluationSnapshotIntegrityError("invalid_snapshot", { cause: parsed.error });
  const { definition, scope, definitionSha256, pages } = parsed.data;
  if (
    definition.snapshotId !== input.expected.snapshot.snapshotId ||
    definitionSha256 !== input.expected.snapshot.definitionSha256 ||
    !same(definition.request, input.expected.request) ||
    !same(scope, input.expected.scope)
  )
    throw new PolicyEvaluationSnapshotIntegrityError("reference_mismatch");
  if (digest(encodePolicyEvaluationSnapshotDefinition({ definition, scope })) !== definitionSha256)
    throw new PolicyEvaluationSnapshotIntegrityError("digest_mismatch");
  const bytes = Buffer.alloc(definition.inputByteLength);
  let offset = 0;
  for (const page of pages) {
    const {
      scope: pageScope,
      schemaVersion: _version,
      definitionSha256: pageSha256,
      ...pageDefinition
    } = page;
    if (
      digest(
        encodePolicyEvaluationSnapshotPageDefinition({
          definition: pageDefinition,
          scope: pageScope,
        }),
      ) !== pageSha256
    )
      throw new PolicyEvaluationSnapshotIntegrityError("digest_mismatch");
    for (const frame of page.frames) {
      const chunk = Buffer.from(frame.dataBase64url, "base64url");
      chunk.copy(bytes, offset);
      offset += chunk.byteLength;
    }
  }
  if (offset !== definition.inputByteLength || digest(bytes) !== definition.inputSha256)
    throw new PolicyEvaluationSnapshotIntegrityError("digest_mismatch");
  let inputs: PolicyEvaluationSnapshotInputs;
  try {
    const data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as Record<
      string,
      unknown
    >;
    const { definitionDomain, encodingVersion, ...material } = data;
    if (
      definitionDomain !==
        (material["schemaVersion"] === "0.2"
          ? POLICY_EVALUATION_SNAPSHOT_INPUTS_DOMAIN_V2
          : POLICY_EVALUATION_SNAPSHOT_INPUTS_DOMAIN) ||
      encodingVersion !==
        (material["schemaVersion"] === "0.2"
          ? POLICY_EVALUATION_SNAPSHOT_INPUTS_ENCODING_VERSION_V2
          : POLICY_EVALUATION_SNAPSHOT_INPUTS_ENCODING_VERSION)
    )
      throw new Error("Unexpected snapshot input encoding domain/version");
    inputs = PolicyEvaluationSnapshotInputsSchema.parse(material);
    if (!Buffer.from(encodePolicyEvaluationSnapshotInputs(inputs)).equals(bytes))
      throw new Error("Snapshot inputs must preserve exact canonical original bytes");
    validatePolicyEvaluationRequestRecord(inputs.request);
    validateRoots(inputs);
  } catch (cause) {
    throw new PolicyEvaluationSnapshotIntegrityError("invalid_inputs", { cause });
  }
  if (
    !same(inputs.request.scope, scope) ||
    !same(
      {
        evaluationRequestId: inputs.request.evaluationRequestId,
        definitionSha256: inputs.request.definitionSha256,
      },
      definition.request,
    ) ||
    !same(inputs.request.candidate, definition.candidate) ||
    !same(inputs.request.policy, definition.policy) ||
    !same(inputs.request.algorithm, definition.algorithm) ||
    inputs.request.evaluationTime !== definition.evaluationTime ||
    inputs.capturedAt !== definition.capturedAt
  )
    throw new PolicyEvaluationSnapshotIntegrityError("reference_mismatch");
  validatePolicyEvaluationSnapshotSources({
    expected: {
      request: definition.request,
      scope,
      evaluationTime: definition.evaluationTime,
      manifest: definition.manifest,
    },
    sources: inputs.sources,
    pageSet: inputs.manifest,
  });
  return inputs;
}
