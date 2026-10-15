import {
  EvidenceScopeSchema,
  PolicyEvaluationSnapshotPageIndexSchema,
  OpaqueIdSchema,
  PolicyEvaluationSnapshotReferenceSchema,
  PrincipalContextSchema,
  serializeEvaluationCanonicalJson,
  type PrincipalContext,
} from "@proofstack/contracts";
import { requireCapability, requireEnvironmentAccess } from "../auth/authorization.js";
import type { PolicyEvaluationJobReader } from "./policy-evaluation-job-repository.js";
import { readPolicyEvaluationJob } from "./policy-evaluation-job-use-cases.js";
import type { PolicyEvaluationResultReader } from "./policy-evaluation-result-repository.js";
import {
  PolicyEvaluationResultIntegrityError,
  validatePolicyEvaluationResultRecord,
} from "./policy-evaluation-result-record-validation.js";
import {
  readCompletePolicyEvaluationSnapshot,
  validatePolicyEvaluationStoredSnapshotJob,
  validatePolicyEvaluationStoredSnapshotPage,
  type PolicyEvaluationSnapshotReader,
} from "./policy-evaluation-snapshot-repository.js";
import { PolicyEvaluationSnapshotIntegrityError } from "./policy-evaluation-snapshot.js";

interface ReadCommand {
  readonly principal: PrincipalContext;
  readonly projectId: string;
  readonly environmentId: string;
  readonly jobId: string;
}
export interface PolicyEvaluationPublicReadRepositories {
  readonly jobs: PolicyEvaluationJobReader;
  readonly snapshots: PolicyEvaluationSnapshotReader;
  readonly results: PolicyEvaluationResultReader;
}
function authorize(command: ReadCommand) {
  const principal = PrincipalContextSchema.parse(command.principal);
  requireCapability(principal, "policy:read");
  requireEnvironmentAccess(principal, command.projectId, command.environmentId);
  const scope = EvidenceScopeSchema.parse({
    tenantId: principal.tenantId,
    projectId: command.projectId,
    environmentId: command.environmentId,
  });
  return { scope, jobId: OpaqueIdSchema.parse(command.jobId) };
}
async function originalHeader(
  command: ReadCommand,
  repositories: Pick<PolicyEvaluationPublicReadRepositories, "jobs" | "snapshots">,
) {
  const { scope, jobId } = authorize(command);
  const job = await readPolicyEvaluationJob(command, repositories.jobs);
  if (!job?.job.snapshot) return null;
  const expected = {
    scope,
    job: { jobId, definitionSha256: job.job.definitionSha256 },
    request: job.job.request,
    snapshot: job.job.snapshot,
  };
  const raw = await repositories.snapshots.findSnapshot(expected);
  // An owning job advertises this exact immutable record. Its disappearance is corruption,
  // distinct from a job that has not sealed or an unknown authorized job.
  if (raw === null) throw new PolicyEvaluationSnapshotIntegrityError("invalid_snapshot");
  const { root } = validatePolicyEvaluationStoredSnapshotJob(expected, raw, job);
  return { expected, root, job };
}

/** Historical exact reads never grant source freshness or permission to execute/publish. */
export async function readPolicyEvaluationSnapshotHeaderRequest(
  command: ReadCommand,
  repositories: Pick<PolicyEvaluationPublicReadRepositories, "jobs" | "snapshots">,
) {
  const original = await originalHeader(command, repositories);
  return original?.root ?? null;
}

/** A page is requested against the caller's retained exact header reference, never latest. */
export async function readPolicyEvaluationSnapshotPageRequest(
  command: ReadCommand & { readonly snapshot: unknown; readonly pageIndex: unknown },
  repositories: Pick<PolicyEvaluationPublicReadRepositories, "jobs" | "snapshots">,
) {
  authorize(command);
  const reference = PolicyEvaluationSnapshotReferenceSchema.parse(command.snapshot);
  const pageIndex = PolicyEvaluationSnapshotPageIndexSchema.parse(command.pageIndex);
  const original = await originalHeader(command, repositories);
  if (
    original === null ||
    serializeEvaluationCanonicalJson(original.expected.snapshot) !==
      serializeEvaluationCanonicalJson(reference) ||
    !original.root.pages[pageIndex]
  )
    return null;
  const raw = await repositories.snapshots.readSnapshotPage(original.expected, pageIndex);
  if (raw === null) throw new PolicyEvaluationSnapshotIntegrityError("invalid_snapshot");
  return {
    snapshot: reference,
    page: validatePolicyEvaluationStoredSnapshotPage(
      original.expected,
      original.root,
      pageIndex,
      raw,
    ),
  };
}

/** Revalidate complete original sealed evidence independently of the supplied result port. */
export async function readPolicyEvaluationResultRequest(
  command: ReadCommand,
  repositories: PolicyEvaluationPublicReadRepositories,
) {
  authorize(command);
  const original = await originalHeader(command, repositories);
  if (original === null || original.job.job.result === null) return null;
  // The owning job validator binds any retained result to a completed terminal and its latest
  // closed deciding attempt. Reuse that validated fence; do not select a caller's worker identity.
  const terminal = original.job.job.terminal!;
  const attempt = original.job.attempts.at(-1)!;
  const material = await readCompletePolicyEvaluationSnapshot(
    repositories.snapshots,
    original.expected,
  );
  if (material === null) throw new PolicyEvaluationSnapshotIntegrityError("invalid_snapshot");
  if (
    serializeEvaluationCanonicalJson(material.snapshot) !==
    serializeEvaluationCanonicalJson(original.root)
  )
    throw new PolicyEvaluationSnapshotIntegrityError("reference_mismatch");
  const raw = await repositories.results.findResult(
    original.expected.scope,
    original.expected.job.jobId,
    material.pageSet,
  );
  if (raw === null)
    throw new PolicyEvaluationResultIntegrityError("Owning completed result is missing");
  return validatePolicyEvaluationResultRecord({
    expected: {
      scope: original.expected.scope,
      jobId: original.expected.job.jobId,
      request: original.expected.request,
      snapshot: original.expected.snapshot,
      result: original.job.job.result,
      fence: attempt.mutationFence,
      completedAt: terminal.committedAt,
    },
    record: raw,
    snapshotRecord: material.snapshot,
    pageSet: material.pageSet,
  });
}
