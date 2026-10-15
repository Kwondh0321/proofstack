import { createHash } from "node:crypto";
import {
  EvidenceScopeSchema,
  PolicyEvaluationJobReferenceSchema,
  PolicyEvaluationRequestReferenceSchema,
  PolicyEvaluationSnapshotReferenceSchema,
  PolicyEvaluationSnapshotSchema,
  PolicyEvaluationSnapshotPageSchema,
  encodePolicyEvaluationSnapshotDefinition,
  encodePolicyEvaluationSnapshotPageDefinition,
  serializeEvaluationCanonicalJson,
  MAX_POLICY_EVALUATION_SNAPSHOT_PAGES,
  policyEvaluationTimestampOrderKey,
  type EvidenceScope,
  type PolicyEvaluationJobReference,
  type PolicyEvaluationRequestReference,
  type PolicyEvaluationSnapshotReference,
  type PolicyEvaluationSnapshot,
  type PolicyEvaluationSnapshotPage,
  type PolicyEvaluationSnapshotPageSet,
  type PolicyEvaluationWorkerMutationFence,
  type PolicyEvaluationJobSnapshot,
} from "@proofstack/contracts";
import { PolicyEvaluationSnapshotIntegrityError } from "./policy-evaluation-snapshot.js";
import { validatePolicyEvaluationSnapshotRecord } from "./policy-evaluation-snapshot-record-validation.js";
import {
  digestPolicyEvaluationJobDefinition,
  validatePolicyEvaluationJobSnapshotRecord,
} from "./policy-evaluation-job-record-validation.js";

/** Exact immutable identity comes from the owning job, never an unbound latest lookup. */
export interface PolicyEvaluationSnapshotReadIdentity {
  readonly scope: EvidenceScope;
  readonly job: PolicyEvaluationJobReference;
  readonly request: PolicyEvaluationRequestReference;
  readonly snapshot: PolicyEvaluationSnapshotReference;
}
export interface PolicyEvaluationSnapshotReader {
  findSnapshot(
    expected: PolicyEvaluationSnapshotReadIdentity,
  ): Promise<PolicyEvaluationSnapshot | null>;
  readSnapshotPage(
    expected: PolicyEvaluationSnapshotReadIdentity,
    pageIndex: number,
  ): Promise<PolicyEvaluationSnapshotPage | null>;
}
/** Trusted persistence boundary. The server composition must own final source reinspection. */
export interface PolicyEvaluationSnapshotPublisher {
  publishSnapshot(command: {
    readonly scope: EvidenceScope;
    readonly fence: PolicyEvaluationWorkerMutationFence;
    readonly pageSet: PolicyEvaluationSnapshotPageSet;
    readonly principalId: string;
  }): Promise<{
    readonly snapshot: PolicyEvaluationSnapshot;
    readonly job: PolicyEvaluationJobSnapshot;
  }>;
}
export function policyEvaluationSnapshotReadIdentity(
  input: PolicyEvaluationSnapshotReadIdentity,
): PolicyEvaluationSnapshotReadIdentity {
  const expected = {
    scope: EvidenceScopeSchema.parse(input.scope),
    job: PolicyEvaluationJobReferenceSchema.parse(input.job),
    request: PolicyEvaluationRequestReferenceSchema.parse(input.request),
    snapshot: PolicyEvaluationSnapshotReferenceSchema.parse(input.snapshot),
  };
  if (
    digestPolicyEvaluationJobDefinition(expected.scope, {
      jobId: expected.job.jobId,
      request: expected.request,
    }) !== expected.job.definitionSha256
  )
    throw new PolicyEvaluationSnapshotIntegrityError("reference_mismatch");
  return expected;
}
export function requirePolicyEvaluationSnapshotPageIndex(index: number): number {
  if (!Number.isSafeInteger(index) || index < 0 || index >= MAX_POLICY_EVALUATION_SNAPSHOT_PAGES)
    throw new PolicyEvaluationSnapshotIntegrityError("reference_mismatch");
  return index;
}
const same = (a: unknown, b: unknown) =>
  serializeEvaluationCanonicalJson(a) === serializeEvaluationCanonicalJson(b);
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Header integrity only. Full semantic evidence is validated after every retained page is read. */
export function validatePolicyEvaluationStoredSnapshotHeader(
  inputExpected: PolicyEvaluationSnapshotReadIdentity,
  input: unknown,
) {
  const expected = policyEvaluationSnapshotReadIdentity(inputExpected);
  const parsed = PolicyEvaluationSnapshotSchema.safeParse(input);
  if (!parsed.success)
    throw new PolicyEvaluationSnapshotIntegrityError("invalid_snapshot", { cause: parsed.error });
  const record = parsed.data;
  if (
    !same(record.scope, expected.scope) ||
    record.jobId !== expected.job.jobId ||
    !same(record.request, expected.request) ||
    record.snapshotId !== expected.snapshot.snapshotId ||
    record.definitionSha256 !== expected.snapshot.definitionSha256 ||
    record.sealedByPrincipalId !== record.workerId
  )
    throw new PolicyEvaluationSnapshotIntegrityError("reference_mismatch");
  const {
    scope: _scope,
    schemaVersion: _version,
    definitionSha256: _sha,
    sealedAt: _sealed,
    sealedByPrincipalId: _by,
    jobId: _job,
    attemptId: _attempt,
    workerId: _worker,
    leaseId: _lease,
    fencingToken: _fence,
    recoveryEpoch: _epoch,
    recordedAt: _at,
    ...definition
  } = record;
  if (
    digest(encodePolicyEvaluationSnapshotDefinition({ scope: expected.scope, definition })) !==
    record.definitionSha256
  )
    throw new PolicyEvaluationSnapshotIntegrityError("digest_mismatch");
  return { record, definition };
}
export function validatePolicyEvaluationStoredSnapshotPage(
  expected: PolicyEvaluationSnapshotReadIdentity,
  root: PolicyEvaluationSnapshot,
  index: number,
  input: unknown,
) {
  requirePolicyEvaluationSnapshotPageIndex(index);
  validatePolicyEvaluationStoredSnapshotHeader(expected, root);
  const parsed = PolicyEvaluationSnapshotPageSchema.safeParse(input);
  if (!parsed.success)
    throw new PolicyEvaluationSnapshotIntegrityError("invalid_snapshot", { cause: parsed.error });
  const page = parsed.data,
    descriptor = root.pages[index];
  if (
    !descriptor ||
    page.pageIndex !== index ||
    page.snapshotId !== root.snapshotId ||
    !same(page.scope, expected.scope) ||
    !same(page.request, expected.request) ||
    page.inputSha256 !== root.inputSha256 ||
    page.inputByteLength !== root.inputByteLength ||
    page.frameCount !== root.frameCount ||
    page.frames.length !== descriptor.frameCount ||
    page.frames[0]?.frameIndex !== descriptor.firstFrameIndex ||
    page.definitionSha256 !== descriptor.definitionSha256
  )
    throw new PolicyEvaluationSnapshotIntegrityError("reference_mismatch");
  const { scope: _scope, schemaVersion: _version, definitionSha256: _sha, ...definition } = page;
  if (
    digest(encodePolicyEvaluationSnapshotPageDefinition({ scope: expected.scope, definition })) !==
    page.definitionSha256
  )
    throw new PolicyEvaluationSnapshotIntegrityError("digest_mismatch");
  return page;
}

/** Match the original sealing attempt, which can differ from a later live/recovered attempt. */
export function validatePolicyEvaluationStoredSnapshotJob(
  inputExpected: PolicyEvaluationSnapshotReadIdentity,
  inputRoot: unknown,
  inputJob: unknown,
) {
  const expected = policyEvaluationSnapshotReadIdentity(inputExpected);
  const root = validatePolicyEvaluationStoredSnapshotHeader(expected, inputRoot).record;
  const job = validatePolicyEvaluationJobSnapshotRecord({
    expected: { scope: expected.scope, job: expected.job },
    snapshot: inputJob,
  });
  const attempt = job.attempts.find((value) => value.mutationFence.attemptId === root.attemptId);
  const fence = {
    jobId: root.jobId,
    attemptId: root.attemptId,
    workerId: root.workerId,
    leaseId: root.leaseId,
    fencingToken: root.fencingToken,
    recoveryEpoch: root.recoveryEpoch,
  };
  const time = policyEvaluationTimestampOrderKey;
  if (
    !same(job.job.request, expected.request) ||
    !same(job.job.snapshot, expected.snapshot) ||
    !attempt ||
    !same(attempt.mutationFence, fence) ||
    !same(attempt.snapshot, expected.snapshot) ||
    time(root.sealedAt) < time(attempt.startedAt) ||
    time(root.recordedAt) >= time(attempt.deadlineAt) ||
    (attempt.closure !== null && time(root.recordedAt) > time(attempt.closure.committedAt))
  )
    throw new PolicyEvaluationSnapshotIntegrityError("reference_mismatch");
  return { root, job };
}

/** Bounded sequential exact-page reads, then the existing complete owning semantic validator. */
export async function readCompletePolicyEvaluationSnapshot(
  reader: PolicyEvaluationSnapshotReader,
  input: PolicyEvaluationSnapshotReadIdentity,
): Promise<{
  snapshot: PolicyEvaluationSnapshot;
  pageSet: PolicyEvaluationSnapshotPageSet;
} | null> {
  const expected = policyEvaluationSnapshotReadIdentity(input);
  const raw = await reader.findSnapshot(expected);
  if (raw === null) return null;
  const { record: snapshot, definition } = validatePolicyEvaluationStoredSnapshotHeader(
    expected,
    raw,
  );
  const pages: PolicyEvaluationSnapshotPage[] = [];
  for (let index = 0; index < snapshot.pages.length; index++) {
    const page = await reader.readSnapshotPage(expected, index);
    if (page === null) throw new PolicyEvaluationSnapshotIntegrityError("invalid_snapshot");
    pages.push(validatePolicyEvaluationStoredSnapshotPage(expected, snapshot, index, page));
  }
  const pageSet: PolicyEvaluationSnapshotPageSet = {
    scope: expected.scope,
    definition,
    definitionSha256: snapshot.definitionSha256,
    pages,
  };
  validatePolicyEvaluationSnapshotRecord({
    expected: { ...expected, jobId: expected.job.jobId },
    record: snapshot,
    pageSet,
  });
  return { snapshot, pageSet };
}
