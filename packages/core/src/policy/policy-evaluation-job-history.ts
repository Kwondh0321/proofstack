import { createHash } from "node:crypto";
import {
  encodeEvaluationCanonicalJson,
  encodePolicyEvaluationJobHistoryEntry,
  PolicyEvaluationJobHistoryEntrySchema,
  PolicyEvaluationJobHistoryHeadSchema,
  PolicyEvaluationJobHistoryPageSchema,
  MAX_POLICY_EVALUATION_JOB_HISTORY_ENTRY_BYTES,
  MAX_POLICY_EVALUATION_JOB_HISTORY_PAGE_BYTES,
  type PolicyEvaluationJobSnapshot,
  type PolicyEvaluationJobHistoryEntryDefinition,
  type PolicyEvaluationJobHistoryEntry,
  type PolicyEvaluationJobHistoryHead,
} from "@proofstack/contracts";
import { validatePolicyEvaluationJobSnapshotRecord } from "./policy-evaluation-job-record-validation.js";

export class PolicyEvaluationJobHistoryError extends Error {
  readonly code = "policy_evaluation_job_history_invalid";
  constructor(message: string) {
    super(message);
    this.name = "PolicyEvaluationJobHistoryError";
  }
}
function sha(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}
export function digestPolicyEvaluationJobGraph(snapshot: PolicyEvaluationJobSnapshot): string {
  const admitted = validatePolicyEvaluationJobSnapshotRecord({
    expected: {
      scope: snapshot.job.scope,
      job: { jobId: snapshot.job.jobId, definitionSha256: snapshot.job.definitionSha256 },
    },
    snapshot,
  });
  return sha(
    encodeEvaluationCanonicalJson({
      definitionDomain: "proofstack.policy-evaluation-job-graph.v1",
      schemaVersion: "0.1",
      snapshot: admitted,
    }),
  );
}
export function validatePolicyEvaluationJobHistoryEntry(
  raw: unknown,
): PolicyEvaluationJobHistoryEntry {
  const entry = PolicyEvaluationJobHistoryEntrySchema.parse(raw);
  if (entry.entrySha256 !== sha(encodePolicyEvaluationJobHistoryEntry(entry.definition)))
    throw new PolicyEvaluationJobHistoryError("History entry canonical digest mismatch");
  if (
    encodeEvaluationCanonicalJson(entry).byteLength > MAX_POLICY_EVALUATION_JOB_HISTORY_ENTRY_BYTES
  )
    throw new PolicyEvaluationJobHistoryError("History entry exceeds its exact UTF-8 ceiling");
  return entry;
}
/** Append metadata only. Source/publication authority and transition derivation remain separate. */
export function createPolicyEvaluationJobHistoryEntry(input: {
  readonly previous: PolicyEvaluationJobSnapshot | null;
  readonly previousEntry: PolicyEvaluationJobHistoryEntry | null;
  readonly next: PolicyEvaluationJobSnapshot;
  readonly operation: PolicyEvaluationJobHistoryEntryDefinition["operation"];
}): PolicyEvaluationJobHistoryEntry {
  const { previous, next, operation } = input;
  const graphSha256 = digestPolicyEvaluationJobGraph(next);
  const previousGraphSha256 = previous === null ? null : digestPolicyEvaluationJobGraph(previous);
  const predecessor =
    input.previousEntry === null
      ? null
      : validatePolicyEvaluationJobHistoryEntry(input.previousEntry);
  if ((previous === null) !== (predecessor === null))
    throw new PolicyEvaluationJobHistoryError("History predecessor is missing");
  if (
    previous !== null &&
    predecessor !== null &&
    (predecessor.definition.graphSha256 !== previousGraphSha256 ||
      predecessor.definition.stateVersion !== previous.job.stateVersion ||
      predecessor.definition.job.jobId !== next.job.jobId ||
      predecessor.definition.job.definitionSha256 !== next.job.definitionSha256 ||
      predecessor.definition.scope.tenantId !== next.job.scope.tenantId ||
      predecessor.definition.scope.projectId !== next.job.scope.projectId ||
      predecessor.definition.scope.environmentId !== next.job.scope.environmentId ||
      next.job.stateVersion !== previous.job.stateVersion + 1)
  )
    throw new PolicyEvaluationJobHistoryError("History does not continue its exact previous graph");
  const definition: PolicyEvaluationJobHistoryEntryDefinition = {
    scope: next.job.scope,
    job: { jobId: next.job.jobId, definitionSha256: next.job.definitionSha256 },
    sequence: next.job.stateVersion - 1,
    stateVersion: next.job.stateVersion,
    predecessorEntrySha256: predecessor?.entrySha256 ?? null,
    previousGraphSha256,
    graphSha256,
    previousStatus: previous?.job.status ?? null,
    status: next.job.status,
    committedAt: next.job.updatedAt,
    operation,
  };
  return validatePolicyEvaluationJobHistoryEntry({
    schemaVersion: "0.1",
    definition,
    entrySha256: sha(encodePolicyEvaluationJobHistoryEntry(definition)),
  });
}
export function policyEvaluationJobHistoryHead(
  entryInput: PolicyEvaluationJobHistoryEntry,
): PolicyEvaluationJobHistoryHead {
  const entry = validatePolicyEvaluationJobHistoryEntry(entryInput);
  return PolicyEvaluationJobHistoryHeadSchema.parse({
    scope: entry.definition.scope,
    job: entry.definition.job,
    sequence: entry.definition.sequence,
    entrySha256: entry.entrySha256,
    graphSha256: entry.definition.graphSha256,
  });
}
/** Exact independently retained head, bounded page bytes and original per-entry hashes. */
export function validatePolicyEvaluationJobHistoryPage(input: {
  readonly expected: PolicyEvaluationJobHistoryHead;
  readonly page: unknown;
}) {
  const expected = PolicyEvaluationJobHistoryHeadSchema.parse(input.expected);
  const page = PolicyEvaluationJobHistoryPageSchema.parse(input.page);
  if (
    sha(encodeEvaluationCanonicalJson(expected)) !== sha(encodeEvaluationCanonicalJson(page.head))
  )
    throw new PolicyEvaluationJobHistoryError(
      "History page head differs from the exact requested head",
    );
  for (const entry of page.entries) validatePolicyEvaluationJobHistoryEntry(entry);
  if (encodeEvaluationCanonicalJson(page).byteLength > MAX_POLICY_EVALUATION_JOB_HISTORY_PAGE_BYTES)
    throw new PolicyEvaluationJobHistoryError("History page exceeds its exact UTF-8 ceiling");
  return page;
}
