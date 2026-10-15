import {
  encodePolicyEvaluationDefinition,
  encodePolicyEvaluationJobDefinition,
  encodePolicyEvaluationJobHistoryEntry,
  encodePolicyEvaluationRequestDefinition,
  encodePolicyEvaluationSnapshotDefinition,
  encodePolicyEvaluationSnapshotInputs,
  encodePolicyEvaluationSnapshotPageDefinition,
  EvidenceScopeSchema,
  PolicyEvaluationDefinitionSchema,
  PolicyEvaluationJobHistoryHeadSchema,
  PolicyEvaluationJobHistoryPageSchema,
  PolicyEvaluationJobReferenceSchema,
  PolicyEvaluationJobSnapshotSchema,
  PolicyEvaluationRequestDefinitionSchema,
  PolicyEvaluationRequestSchema,
  PolicyEvaluationSchema,
  PolicyEvaluationSnapshotDefinitionSchema,
  PolicyEvaluationSnapshotInputsSchema,
  PolicyEvaluationSnapshotPageDefinitionSchema,
  PolicyEvaluationSnapshotPageSchema,
  PolicyEvaluationSnapshotSchema,
  POLICY_EVALUATION_SNAPSHOT_FRAME_BYTES,
  POLICY_EVALUATION_SNAPSHOT_INPUTS_DOMAIN,
  POLICY_EVALUATION_SNAPSHOT_INPUTS_DOMAIN_V2,
  POLICY_EVALUATION_SNAPSHOT_INPUTS_ENCODING_VERSION,
  POLICY_EVALUATION_SNAPSHOT_INPUTS_ENCODING_VERSION_V2,
  serializeEvaluationCanonicalJson,
  policyEvaluationTimestampOrderKey,
  type EvidenceScope,
  type PolicyEvaluationJobReference,
  type PolicyEvaluationJobSnapshot,
  type PolicyEvaluationSnapshot,
  type PolicyEvaluationSnapshotInputs,
  type PolicyEvaluationSnapshotPage,
  type PolicyEvaluationSnapshotPageSet,
} from "@proofstack/contracts";
import { ProofStackApiError } from "./regression-client.js";

interface Schema<T> {
  safeParse(input: unknown): { success: true; data: T } | { success: false; error: unknown };
}
export function policyParsed<T>(schema: Schema<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success)
    throw new ProofStackApiError("Policy evaluation data violates its strict contract", undefined, {
      cause: result.error,
    });
  return result.data;
}
export const policySame = (left: unknown, right: unknown) =>
  serializeEvaluationCanonicalJson(left) === serializeEvaluationCanonicalJson(right);
function requireSame(left: unknown, right: unknown) {
  if (!policySame(left, right))
    throw new ProofStackApiError(
      "Policy evaluation data substituted an exact identity or original binding",
    );
}
export async function policySha256(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle)
    throw new ProofStackApiError("Web Crypto is required to verify policy evaluation integrity");
  try {
    const digest = await subtle.digest("SHA-256", Uint8Array.from(bytes).buffer);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  } catch (cause) {
    throw new ProofStackApiError("Policy evaluation digest calculation failed", undefined, {
      cause,
    });
  }
}
async function requireDigest(bytes: Uint8Array, expected: string) {
  if ((await policySha256(bytes)) !== expected)
    throw new ProofStackApiError(
      "Policy evaluation canonical digest does not match its original record",
    );
}
function omitted(record: object, keys: readonly string[]) {
  return Object.fromEntries(Object.entries(record).filter(([key]) => !keys.includes(key)));
}
const requestReceipts = [
  "scope",
  "schemaVersion",
  "createdAt",
  "createdByPrincipalId",
  "definitionSha256",
] as const;
const publicationReceipts = [
  "scope",
  "schemaVersion",
  "definitionSha256",
  "jobId",
  "attemptId",
  "workerId",
  "leaseId",
  "fencingToken",
  "recoveryEpoch",
] as const;

export async function policyVerifiedRequest(
  raw: unknown,
  expectedScope: EvidenceScope,
  job?: PolicyEvaluationJobReference,
) {
  const request = policyParsed(PolicyEvaluationRequestSchema, raw);
  requireSame(request.scope, expectedScope);
  const definition = policyParsed(
    PolicyEvaluationRequestDefinitionSchema,
    omitted(request, requestReceipts),
  );
  await requireDigest(
    encodePolicyEvaluationRequestDefinition({ scope: request.scope, definition }),
    request.definitionSha256,
  );
  if (job)
    await requireDigest(
      encodePolicyEvaluationJobDefinition({
        scope: expectedScope,
        definition: {
          jobId: job.jobId,
          request: {
            evaluationRequestId: request.evaluationRequestId,
            definitionSha256: request.definitionSha256,
          },
        },
      }),
      job.definitionSha256,
    );
  return request;
}
export async function policyVerifiedJob(
  raw: unknown,
  expectedScope: EvidenceScope,
  expected?: PolicyEvaluationJobReference,
) {
  const graph = policyParsed(PolicyEvaluationJobSnapshotSchema, raw);
  await policyVerifiedRequest(graph.request, expectedScope);
  requireSame(graph.job.scope, expectedScope);
  if (expected)
    requireSame({ jobId: graph.job.jobId, definitionSha256: graph.job.definitionSha256 }, expected);
  await requireDigest(
    encodePolicyEvaluationJobDefinition({
      scope: expectedScope,
      definition: { jobId: graph.job.jobId, request: graph.job.request },
    }),
    graph.job.definitionSha256,
  );
  return graph;
}
export async function policyVerifiedHeader(
  raw: unknown,
  scope: EvidenceScope,
  job: PolicyEvaluationJobReference,
) {
  const snapshot = policyParsed(PolicyEvaluationSnapshotSchema, raw);
  requireSame(snapshot.scope, scope);
  if (snapshot.jobId !== job.jobId || snapshot.sealedByPrincipalId !== snapshot.workerId)
    throw new ProofStackApiError(
      "Policy snapshot substituted its original job or sealing identity",
    );
  await requireDigest(
    encodePolicyEvaluationJobDefinition({
      scope,
      definition: { jobId: job.jobId, request: snapshot.request },
    }),
    job.definitionSha256,
  );
  const definition = policyParsed(
    PolicyEvaluationSnapshotDefinitionSchema,
    omitted(snapshot, [...publicationReceipts, "sealedAt", "sealedByPrincipalId", "recordedAt"]),
  );
  await requireDigest(
    encodePolicyEvaluationSnapshotDefinition({ scope, definition }),
    snapshot.definitionSha256,
  );
  return { snapshot, definition };
}
export function policyVerifiedSealingAttempt(
  snapshot: PolicyEvaluationSnapshot,
  graph: PolicyEvaluationJobSnapshot,
) {
  requireSame(graph.job.snapshot, {
    snapshotId: snapshot.snapshotId,
    definitionSha256: snapshot.definitionSha256,
  });
  requireSame(graph.job.request, snapshot.request);
  const attempt = graph.attempts.find(
    (value) => value.mutationFence.attemptId === snapshot.attemptId,
  );
  const fence = {
    jobId: snapshot.jobId,
    attemptId: snapshot.attemptId,
    workerId: snapshot.workerId,
    leaseId: snapshot.leaseId,
    fencingToken: snapshot.fencingToken,
    recoveryEpoch: snapshot.recoveryEpoch,
  };
  const time = policyEvaluationTimestampOrderKey;
  if (
    !attempt ||
    !policySame(attempt.mutationFence, fence) ||
    !policySame(attempt.snapshot, graph.job.snapshot) ||
    time(snapshot.sealedAt) < time(attempt.startedAt) ||
    time(snapshot.recordedAt) >= time(attempt.deadlineAt) ||
    (attempt.closure !== null && time(snapshot.recordedAt) > time(attempt.closure.committedAt))
  )
    throw new ProofStackApiError(
      "Policy snapshot substituted its original sealing attempt or receipt",
    );
}
export async function policyVerifiedPage(
  raw: unknown,
  header: PolicyEvaluationSnapshot,
  pageIndex: number,
) {
  const page = policyParsed(PolicyEvaluationSnapshotPageSchema, raw),
    descriptor = header.pages[pageIndex];
  if (!descriptor) throw new ProofStackApiError("Policy snapshot page is outside its exact header");
  requireSame(page.scope, header.scope);
  requireSame(page.request, header.request);
  if (
    page.snapshotId !== header.snapshotId ||
    page.pageIndex !== pageIndex ||
    page.inputSha256 !== header.inputSha256 ||
    page.inputByteLength !== header.inputByteLength ||
    page.frameCount !== header.frameCount ||
    page.definitionSha256 !== descriptor.definitionSha256 ||
    page.frames.length !== descriptor.frameCount ||
    page.frames[0]!.frameIndex !== descriptor.firstFrameIndex
  )
    throw new ProofStackApiError(
      "Policy snapshot page substituted its advertised descriptor or frame inventory",
    );
  const definition = policyParsed(
    PolicyEvaluationSnapshotPageDefinitionSchema,
    omitted(page, ["scope", "schemaVersion", "definitionSha256"]),
  );
  await requireDigest(
    encodePolicyEvaluationSnapshotPageDefinition({ scope: page.scope, definition }),
    page.definitionSha256,
  );
  return page;
}
export interface PolicyEvaluationCompleteSnapshot {
  readonly snapshot: PolicyEvaluationSnapshot;
  readonly pageSet: PolicyEvaluationSnapshotPageSet;
  readonly inputs: PolicyEvaluationSnapshotInputs;
}
/** Reconstruct only bounded canonical bytes; this verifies original identity, not source truth. */
export async function policyCompleteSnapshot(
  rawHeader: unknown,
  pages: readonly PolicyEvaluationSnapshotPage[],
  scope: EvidenceScope,
  job: PolicyEvaluationJobReference,
  maximumBytes: number,
): Promise<PolicyEvaluationCompleteSnapshot> {
  const { snapshot, definition } = await policyVerifiedHeader(rawHeader, scope, job);
  if (snapshot.inputByteLength > maximumBytes || pages.length !== snapshot.pages.length)
    throw new ProofStackApiError(
      "Complete policy snapshot exceeds its admitted input budget or omits pages",
    );
  const bytes = new Uint8Array(snapshot.inputByteLength);
  let offset = 0;
  for (const [index, raw] of pages.entries()) {
    const page = await policyVerifiedPage(raw, snapshot, index);
    for (const frame of page.frames) {
      const decoded = atob(frame.dataBase64url.replaceAll("-", "+").replaceAll("_", "/"));
      if (
        frame.frameIndex * POLICY_EVALUATION_SNAPSHOT_FRAME_BYTES !== offset ||
        offset + decoded.length > bytes.byteLength
      )
        throw new ProofStackApiError(
          "Policy snapshot frame offsets exceed the exact input inventory",
        );
      for (let position = 0; position < decoded.length; position++)
        bytes[offset++] = decoded.charCodeAt(position);
    }
  }
  if (offset !== bytes.byteLength)
    throw new ProofStackApiError("Policy snapshot input was truncated");
  await requireDigest(bytes, snapshot.inputSha256);
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (cause) {
    throw new ProofStackApiError("Policy snapshot input is not complete UTF-8 JSON", undefined, {
      cause,
    });
  }
  if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded))
    throw new ProofStackApiError("Policy snapshot input must be a canonical object");
  const { definitionDomain, encodingVersion, ...material } = decoded as Record<string, unknown>;
  const version2 = material["schemaVersion"] === "0.2";
  if (
    definitionDomain !==
      (version2
        ? POLICY_EVALUATION_SNAPSHOT_INPUTS_DOMAIN_V2
        : POLICY_EVALUATION_SNAPSHOT_INPUTS_DOMAIN) ||
    encodingVersion !==
      (version2
        ? POLICY_EVALUATION_SNAPSHOT_INPUTS_ENCODING_VERSION_V2
        : POLICY_EVALUATION_SNAPSHOT_INPUTS_ENCODING_VERSION)
  )
    throw new ProofStackApiError(
      "Policy snapshot input substituted its versioned canonical domain",
    );
  const inputs = policyParsed(PolicyEvaluationSnapshotInputsSchema, material),
    canonical = encodePolicyEvaluationSnapshotInputs(inputs);
  if (
    canonical.byteLength !== bytes.byteLength ||
    !canonical.every((byte, index) => byte === bytes[index])
  )
    throw new ProofStackApiError(
      "Policy snapshot input does not preserve its exact canonical bytes",
    );
  await policyVerifiedRequest(inputs.request, scope, job);
  requireSame(snapshot.request, {
    evaluationRequestId: inputs.request.evaluationRequestId,
    definitionSha256: inputs.request.definitionSha256,
  });
  for (const key of ["candidate", "policy", "algorithm", "evaluationTime"] as const)
    requireSame(snapshot[key], inputs.request[key]);
  requireSame(snapshot.capturedAt, inputs.capturedAt);
  requireSame(snapshot.manifest, {
    manifestId: inputs.manifest.manifest.manifestId,
    definitionSha256: inputs.manifest.manifest.definitionSha256,
  });
  return {
    snapshot,
    pageSet: { scope, definition, definitionSha256: snapshot.definitionSha256, pages: [...pages] },
    inputs,
  };
}
export async function policyVerifiedResult(
  raw: unknown,
  material: PolicyEvaluationCompleteSnapshot,
  scope: EvidenceScope,
  job: PolicyEvaluationJobReference,
  graph: PolicyEvaluationJobSnapshot,
) {
  const evaluation = policyParsed(PolicyEvaluationSchema, raw);
  const definition = policyParsed(
    PolicyEvaluationDefinitionSchema,
    omitted(evaluation, [...publicationReceipts, "recordedAt", "recordedByPrincipalId"]),
  );
  requireSame(evaluation.scope, scope);
  if (evaluation.jobId !== job.jobId || evaluation.recordedByPrincipalId !== evaluation.workerId)
    throw new ProofStackApiError("Policy result substituted its original job or deciding identity");
  requireSame(evaluation.request, material.snapshot.request);
  requireSame(evaluation.snapshot, {
    snapshotId: material.snapshot.snapshotId,
    definitionSha256: material.snapshot.definitionSha256,
  });
  requireSame(graph.job.result, {
    evaluationId: evaluation.evaluationId,
    definitionSha256: evaluation.definitionSha256,
  });
  policyVerifiedSealingAttempt(material.snapshot, graph);
  const deciding = graph.attempts.at(-1),
    terminal = graph.job.terminal;
  const fence = {
    jobId: evaluation.jobId,
    attemptId: evaluation.attemptId,
    workerId: evaluation.workerId,
    leaseId: evaluation.leaseId,
    fencingToken: evaluation.fencingToken,
    recoveryEpoch: evaluation.recoveryEpoch,
  };
  if (
    graph.job.status !== "completed" ||
    !deciding ||
    deciding.closure?.status !== "completed" ||
    terminal?.status !== "completed" ||
    !policySame(deciding.mutationFence, fence) ||
    terminal.attemptId !== evaluation.attemptId ||
    terminal.committedAt !== evaluation.recordedAt ||
    policyEvaluationTimestampOrderKey(evaluation.recordedAt) <
      policyEvaluationTimestampOrderKey(material.snapshot.recordedAt)
  )
    throw new ProofStackApiError(
      "Policy result substituted its original deciding attempt or completion receipt",
    );
  for (const key of ["candidate", "policy", "algorithm", "evaluationTime"] as const)
    requireSame(evaluation[key], material.snapshot[key]);
  if (material.inputs.schemaVersion !== "0.2")
    throw new ProofStackApiError(
      "Policy result verification requires version 0.2 sealed rule inputs",
    );
  const rules = material.inputs.rules.rules;
  if (evaluation.ruleCount !== rules.length)
    throw new ProofStackApiError("Policy result omitted original sealed rules");
  for (const [index, expected] of rules.entries()) {
    const actual = evaluation.rules[index]!;
    if (
      actual.ruleIndex !== expected.ruleIndex ||
      actual.ruleId !== expected.rule.ruleId ||
      actual.predicateKind !== expected.rule.predicate.kind
    )
      throw new ProofStackApiError(
        "Policy result substituted original sealed rule order or predicate identity",
      );
  }
  await requireDigest(
    encodePolicyEvaluationDefinition({ scope, definition }),
    evaluation.definitionSha256,
  );
  return evaluation;
}
export function policyVerifiedHistoryHead(
  raw: unknown,
  scope: EvidenceScope,
  job: PolicyEvaluationJobReference,
) {
  const head = policyParsed(PolicyEvaluationJobHistoryHeadSchema, raw);
  requireSame(head.scope, scope);
  requireSame(head.job, job);
  return head;
}
export async function policyVerifiedHistoryPage(
  raw: unknown,
  expectedHead: unknown,
  pageIndex: number,
) {
  const page = policyParsed(PolicyEvaluationJobHistoryPageSchema, raw);
  const head = policyParsed(PolicyEvaluationJobHistoryHeadSchema, expectedHead);
  requireSame(page.head, head);
  if (page.pageIndex !== pageIndex)
    throw new ProofStackApiError("Policy history substituted the requested page index");
  for (const entry of page.entries)
    await requireDigest(encodePolicyEvaluationJobHistoryEntry(entry.definition), entry.entrySha256);
  const last = page.entries.at(-1)!;
  if (
    last.definition.sequence === head.sequence &&
    (last.entrySha256 !== head.entrySha256 || last.definition.graphSha256 !== head.graphSha256)
  )
    throw new ProofStackApiError("Policy history final entry differs from its retained exact head");
  return page;
}

export const policyScope = (raw: unknown) => policyParsed(EvidenceScopeSchema, raw);
export const policyJobReference = (raw: unknown) =>
  policyParsed(PolicyEvaluationJobReferenceSchema, raw);
