import {
  EvidenceScopeSchema,
  PolicyEvaluationTimeSchema,
  ReleaseApprovalSubjectSchema,
  policyEvaluationTimestampOrderKey,
  serializeEvaluationCanonicalJson,
  type EvidenceScope,
  type ReleaseApprovalSubject,
} from "@proofstack/contracts";
import type { PolicyEvaluationRequestJobReader } from "../policy/policy-evaluation-job-repository.js";
import { validatePolicyEvaluationJobSnapshotRecord } from "../policy/policy-evaluation-job-record-validation.js";
import type { PolicyEvaluationResultReader } from "../policy/policy-evaluation-result-repository.js";
import {
  readCompletePolicyEvaluationSnapshot,
  type PolicyEvaluationSnapshotReader,
} from "../policy/policy-evaluation-snapshot-repository.js";
import { inspectOwnedPolicyEvaluation } from "./owned-policy-evaluation.js";
import { ReleaseDecisionVerificationBudget } from "./release-decision-verification-budget.js";

/** Fixed server-installed owning read ports. They expose no publication, SQL, client or keys. */
export interface OwnedReleaseApprovalSubjectReaders
  extends PolicyEvaluationRequestJobReader,
    PolicyEvaluationSnapshotReader,
    PolicyEvaluationResultReader {}

export class InvalidOwnedReleaseApprovalSubjectError extends Error {
  readonly code = "owned_release_approval_subject_invalid";
  constructor(
    readonly reason:
      | "scope_mismatch"
      | "original_unavailable"
      | "subject_mismatch"
      | "rule_missing"
      | "source_invalid",
    options?: ErrorOptions,
  ) {
    super(`Original owning approval subject was rejected: ${reason}`, options);
    this.name = "InvalidOwnedReleaseApprovalSubjectError";
  }
}
const same = (a: unknown, b: unknown) =>
  serializeEvaluationCanonicalJson(a) === serializeEvaluationCanonicalJson(b);

/**
 * Acquire the C3-owned part of one exact approval subject, then recompute its original result.
 * The owning request selector supplies job identity FIRST. Caller job IDs never select a store
 * record. Selection/current policy/reviewer/basis/actor authority and actual authentication are
 * separate required service boundaries; this historical read cannot authorize publication.
 * One original meter retains failed attempts and repeated metadata inspections. Native readers
 * additionally admit their actual normalized wire observations to that same server-owned meter.
 */
export async function readOwnedReleaseApprovalSubject(input: {
  readonly scope: EvidenceScope;
  readonly subject: ReleaseApprovalSubject;
  readonly capturedAt: string;
  readonly readers: OwnedReleaseApprovalSubjectReaders;
  readonly budget: ReleaseDecisionVerificationBudget;
}) {
  if (!(input.budget instanceof ReleaseDecisionVerificationBudget))
    throw new InvalidOwnedReleaseApprovalSubjectError("source_invalid");
  const budget = input.budget;
  budget.snapshot();
  try {
    budget.observe({ scope: input.scope, subject: input.subject, capturedAt: input.capturedAt });
    const scope = EvidenceScopeSchema.parse(input.scope),
      subject = ReleaseApprovalSubjectSchema.parse(input.subject),
      capturedAt = PolicyEvaluationTimeSchema.parse(input.capturedAt);
    const fail = (reason: InvalidOwnedReleaseApprovalSubjectError["reason"]): never => {
      throw new InvalidOwnedReleaseApprovalSubjectError(reason);
    };
    if (!same(scope, subject.scope)) fail("scope_mismatch");
    budget.observe({ kind: "original_approval_job_read", scope, request: subject.request });
    const raw = await input.readers.findJobForRequest(scope, subject.request);
    budget.observe(raw);
    if (!raw) return fail("original_unavailable");
    const jobReference = { jobId: raw.job.jobId, definitionSha256: raw.job.definitionSha256 };
    const graph = validatePolicyEvaluationJobSnapshotRecord({
      expected: { scope, job: jobReference },
      snapshot: raw,
    });
    const job = graph.job;
    if (
      job.status !== "completed" ||
      !job.snapshot ||
      !job.result ||
      !job.terminal ||
      policyEvaluationTimestampOrderKey(job.terminal.committedAt) >
        policyEvaluationTimestampOrderKey(capturedAt)
    )
      return fail("original_unavailable");
    if (
      job.jobId !== subject.jobId ||
      !same(job.request, subject.request) ||
      !same(job.snapshot, subject.snapshot) ||
      !same(job.result, subject.evaluation) ||
      !same(graph.request.candidate, subject.candidate) ||
      !same(graph.request.policy, subject.policy)
    )
      fail("subject_mismatch");
    const expected = { scope, job: jobReference, request: job.request, snapshot: job.snapshot };
    const sealed = await readCompletePolicyEvaluationSnapshot(
      {
        async findSnapshot(identity) {
          budget.observe({ kind: "original_approval_snapshot_read", expected: identity });
          const value = await input.readers.findSnapshot(identity);
          budget.observe(value);
          return value;
        },
        async readSnapshotPage(identity, pageIndex) {
          budget.observe({
            kind: "original_approval_snapshot_page_read",
            expected: identity,
            pageIndex,
          });
          const value = await input.readers.readSnapshotPage(identity, pageIndex);
          budget.observe(value);
          return value;
        },
      },
      expected,
    );
    if (!sealed) return fail("original_unavailable");
    budget.observe({
      kind: "original_approval_result_read",
      scope,
      job: jobReference,
      snapshot: job.snapshot,
    });
    const evaluation = await input.readers.findResult(scope, job.jobId, sealed.pageSet);
    budget.observe(evaluation);
    if (!evaluation) return fail("original_unavailable");
    const original = {
      expected: { scope, request: job.request, job: jobReference },
      jobGraph: graph,
      snapshot: sealed.snapshot,
      pageSet: sealed.pageSet,
      evaluation,
      capturedAt,
    };
    const owned = inspectOwnedPolicyEvaluation({ ...original, budget });
    const rule = owned.policy.rules.find(({ ruleId }) => ruleId === subject.ruleId),
      ruleResult = owned.evaluation.rules.find(({ ruleId }) => ruleId === subject.ruleId);
    if (!rule || !ruleResult) return fail("rule_missing");
    return {
      authorityBoundary: "original_evaluation_subject_only" as const,
      subject,
      original: structuredClone(original),
      candidate: owned.candidate,
      policy: owned.policy,
      prerequisites: owned.prerequisites,
      rule,
      ruleResult,
    };
  } catch (cause) {
    return budget.rejectSourceRead(
      cause instanceof InvalidOwnedReleaseApprovalSubjectError
        ? cause
        : new InvalidOwnedReleaseApprovalSubjectError("source_invalid", { cause }),
    );
  }
}

export type OwnedReleaseApprovalEvaluationSubject = Awaited<
  ReturnType<typeof readOwnedReleaseApprovalSubject>
>;
