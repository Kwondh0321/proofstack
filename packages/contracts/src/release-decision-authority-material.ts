import { z } from "zod";
import {
  encodeEvaluationCanonicalJson,
  serializeEvaluationCanonicalJson,
} from "./evaluation-definition-encoding.js";
import { EvidenceScopeSchema } from "./evidence.js";
import { CapabilitySchema, ResourceScopeSchema, RoleSchema } from "./identity.js";
import { PolicyEvaluationAttemptSchema } from "./policy-evaluation-attempt.js";
import { PolicyEvaluationJobSchema } from "./policy-evaluation-job.js";
import {
  PolicyEvaluationRequestReferenceSchema,
  PolicyEvaluationRequestSchema,
  MAX_POLICY_EVALUATION_ACQUISITION_RECORDS,
  MAX_POLICY_EVALUATION_ACQUISITION_RECORD_BYTES,
} from "./policy-evaluation-request.js";
import { PolicyEvaluationSchema } from "./policy-evaluation-result.js";
import { PolicyEvaluationSnapshotSchema } from "./policy-evaluation-snapshot.js";
import {
  PolicyEvaluationTimeSchema,
  policyEvaluationTimestampOrderKey,
} from "./policy-evaluation-time.js";
import { OpaqueIdSchema, Sha256Schema } from "./primitives.js";
import {
  ReleaseApprovalReferenceSchema,
  ReleaseApprovalRevocationSchema,
  ReleaseApprovalSchema,
} from "./release-approval.js";
import { ReleaseCandidateReferenceSchema, ReleaseCandidateSchema } from "./release-candidate.js";
import {
  MAX_RELEASE_DECISION_APPROVAL_READS,
  ReleaseDecisionInputSchema,
  ReleaseDecisionPublisherReceiptSchema,
} from "./release-decision-input.js";
import {
  ReleasePolicyLifecycleEventSchema,
  ReleasePolicyReferenceSchema,
  ReleasePolicySchema,
} from "./release-policy.js";
import {
  MAX_RELEASE_POLICY_SELECTION_POLICIES,
  ReleasePolicySelectionLifecycleEventSchema,
  ReleasePolicySelectionSchema,
} from "./release-policy-selection.js";
import {
  ReleaseReviewerAuthorityLifecycleEventSchema,
  ReleaseReviewerAuthorityReferenceSchema,
  ReleaseReviewerAuthoritySchema,
} from "./release-reviewer-authority.js";

export const RELEASE_DECISION_AUTHORITY_MATERIAL_SCHEMA_VERSION = "0.1" as const;
export const MAX_RELEASE_DECISION_AUTHORITY_MATERIAL_BYTES =
  MAX_POLICY_EVALUATION_ACQUISITION_RECORD_BYTES;
export const MAX_RELEASE_DECISION_IDENTITY_OBSERVATIONS = MAX_RELEASE_DECISION_APPROVAL_READS + 1;

function ordered(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || (values[index - 1] ?? "") < value);
}
function equal(left: unknown, right: unknown): boolean {
  return serializeEvaluationCanonicalJson(left) === serializeEvaluationCanonicalJson(right);
}
function source<Reference extends z.ZodType, RecordValue extends z.ZodType>(
  reference: Reference,
  record: RecordValue,
) {
  return z.discriminatedUnion("state", [
    z.object({ state: z.literal("observed"), reference, record }).strict(),
    z.object({ state: z.enum(["missing", "unavailable"]), reference }).strict(),
    z
      .object({ state: z.literal("invalid"), reference, observedRecordSha256: Sha256Schema })
      .strict(),
  ]);
}

/** Public source identity only. A reference, current-state label or digest cannot authenticate. */
export const ReleaseDecisionUserIdentityReferenceSchema = z
  .object({
    kind: z.literal("oidc_binding"),
    principalId: OpaqueIdSchema,
    bindingId: OpaqueIdSchema,
  })
  .strict();
export const ReleaseDecisionServiceIdentityReferenceSchema = z
  .object({
    kind: z.literal("service_credential"),
    principalId: OpaqueIdSchema,
    credentialId: OpaqueIdSchema,
  })
  .strict();
export const ReleaseDecisionIdentityReferenceSchema = z.discriminatedUnion("kind", [
  ReleaseDecisionUserIdentityReferenceSchema,
  ReleaseDecisionServiceIdentityReferenceSchema,
]);

/** Sanitized retained grant preimage. No token, cookie, CSRF, salt, hash verifier or private proof. */
export const ReleaseDecisionIdentityGrantSchema = z
  .object({
    identity: ReleaseDecisionIdentityReferenceSchema,
    tenantId: OpaqueIdSchema,
    state: z.enum(["active", "inactive"]),
    capabilities: z
      .array(CapabilitySchema)
      .max(CapabilitySchema.options.length)
      .refine(ordered, "Captured capabilities must be unique and ordered"),
    roles: z
      .array(RoleSchema)
      .min(1)
      .max(RoleSchema.options.length)
      .refine(ordered, "Captured roles must be unique and ordered"),
    resourceScope: ResourceScopeSchema,
    revision: z.number().int().positive().safe(),
    updatedAt: PolicyEvaluationTimeSchema,
  })
  .strict();

export const ReleaseDecisionIdentityObservationSchema = source(
  ReleaseDecisionIdentityReferenceSchema,
  ReleaseDecisionIdentityGrantSchema,
);
export const ReleaseDecisionCandidateObservationSchema = source(
  ReleaseCandidateReferenceSchema,
  ReleaseCandidateSchema,
);
export const ReleaseDecisionPolicyObservationSchema = source(
  ReleasePolicyReferenceSchema,
  ReleasePolicySchema,
);
export const ReleaseDecisionReviewerObservationSchema = source(
  ReleaseReviewerAuthorityReferenceSchema,
  ReleaseReviewerAuthoritySchema,
);

export const ReleaseDecisionOriginalEvaluationSchema = z.discriminatedUnion("state", [
  z
    .object({
      state: z.literal("complete"),
      request: PolicyEvaluationRequestSchema,
      job: PolicyEvaluationJobSchema,
      attempt: PolicyEvaluationAttemptSchema,
      snapshot: PolicyEvaluationSnapshotSchema,
      evaluation: PolicyEvaluationSchema,
    })
    .strict(),
  z
    .object({
      state: z.literal("unresolved"),
      reason: z.enum([
        "request_missing",
        "job_missing",
        "pending",
        "result_missing",
        "source_unavailable",
        "ambiguous",
        "invalid",
      ]),
      knownRequest: PolicyEvaluationRequestSchema.optional(),
      knownJob: PolicyEvaluationJobSchema.optional(),
      knownSnapshot: PolicyEvaluationSnapshotSchema.optional(),
      observedRecordSha256: Sha256Schema.optional(),
    })
    .strict(),
]);

const PolicySource = z
  .object({
    policy: ReleaseDecisionPolicyObservationSchema,
    request: PolicyEvaluationRequestReferenceSchema,
    original: ReleaseDecisionOriginalEvaluationSchema,
    lifecycle: z
      .array(ReleasePolicyLifecycleEventSchema)
      .max(MAX_POLICY_EVALUATION_ACQUISITION_RECORDS),
  })
  .strict();

const ApprovalActor = z
  .object({
    approval: ReleaseApprovalReferenceSchema,
    identity: ReleaseDecisionUserIdentityReferenceSchema,
  })
  .strict();

/** Complete captured metadata is historical input, never a public current-authorization request. */
export const ReleaseDecisionAuthorityMaterialSchema = z
  .object({
    schemaVersion: z.literal(RELEASE_DECISION_AUTHORITY_MATERIAL_SCHEMA_VERSION),
    authoritySnapshotId: OpaqueIdSchema,
    decisionId: OpaqueIdSchema,
    scope: EvidenceScopeSchema,
    input: ReleaseDecisionInputSchema,
    publisher: ReleaseDecisionPublisherReceiptSchema,
    publisherIdentity: ReleaseDecisionIdentityReferenceSchema,
    capturedAt: PolicyEvaluationTimeSchema,
    recoveryEpoch: z.number().int().nonnegative().safe(),
    candidate: ReleaseDecisionCandidateObservationSchema,
    selections: z
      .object({
        state: z.enum(["complete", "unavailable", "invalid"]),
        records: z
          .array(ReleasePolicySelectionSchema)
          .max(MAX_POLICY_EVALUATION_ACQUISITION_RECORDS),
        lifecycle: z
          .array(ReleasePolicySelectionLifecycleEventSchema)
          .max(MAX_POLICY_EVALUATION_ACQUISITION_RECORDS),
      })
      .strict(),
    policies: z.array(PolicySource).max(MAX_RELEASE_POLICY_SELECTION_POLICIES),
    approvals: z
      .object({
        state: z.enum(["complete", "unavailable", "invalid"]),
        records: z.array(ReleaseApprovalSchema).max(MAX_RELEASE_DECISION_APPROVAL_READS),
        revocations: z
          .array(ReleaseApprovalRevocationSchema)
          .max(MAX_RELEASE_DECISION_APPROVAL_READS),
        actors: z.array(ApprovalActor).max(MAX_RELEASE_DECISION_APPROVAL_READS),
      })
      .strict(),
    authorities: z
      .object({
        records: z
          .array(ReleaseDecisionReviewerObservationSchema)
          .max(MAX_POLICY_EVALUATION_ACQUISITION_RECORDS),
        lifecycle: z
          .array(ReleaseReviewerAuthorityLifecycleEventSchema)
          .max(MAX_POLICY_EVALUATION_ACQUISITION_RECORDS),
      })
      .strict(),
    identities: z
      .array(ReleaseDecisionIdentityObservationSchema)
      .max(MAX_RELEASE_DECISION_IDENTITY_OBSERVATIONS),
    usage: z
      .object({
        records: z.number().int().nonnegative().max(MAX_POLICY_EVALUATION_ACQUISITION_RECORDS),
        recordBytes: z
          .number()
          .int()
          .nonnegative()
          .max(MAX_POLICY_EVALUATION_ACQUISITION_RECORD_BYTES),
        approvalRecords: z.number().int().nonnegative().max(MAX_RELEASE_DECISION_APPROVAL_READS),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    if (context.issues.length > 0) return;
    const issue = (message: string) => context.addIssue({ code: "custom", message });
    const cut = policyEvaluationTimestampOrderKey(value.capturedAt);
    if (!equal(value.scope, value.input.scope))
      issue("Captured input must belong to its exact snapshot scope");
    if (
      policyEvaluationTimestampOrderKey(value.input.createdAt) > cut ||
      cut >= policyEvaluationTimestampOrderKey(value.input.expiresAt) ||
      policyEvaluationTimestampOrderKey(value.publisher.authenticatedAt) > cut
    )
      issue("Capture must follow original input/authentication and precede exact input expiry");
    if (
      value.publisherIdentity.principalId !== value.publisher.principalId ||
      (value.publisher.principalType === "user") !==
        (value.publisherIdentity.kind === "oidc_binding") ||
      (value.publisherIdentity.kind === "service_credential" &&
        value.publisherIdentity.credentialId !== value.publisher.credentialId)
    )
      issue("Original publisher identity must match its actual receipt type and principal");
    if (!equal(value.candidate.reference, value.input.candidate))
      issue("Captured candidate must bind the exact original input");
    if (
      value.candidate.state === "observed" &&
      !equal(value.candidate.reference, {
        candidateId: value.candidate.record.candidateId,
        candidateVersionId: value.candidate.record.candidateVersionId,
        definitionSha256: value.candidate.record.definitionSha256,
      })
    )
      issue("Candidate observation must retain its actual owning reference");
    if (value.policies.length !== value.input.evaluations.length)
      issue("Capture must retain every original policy/request, including advisory members");
    const scoped: { scope: z.infer<typeof EvidenceScopeSchema> }[] = [value.input];
    if (value.candidate.state === "observed") scoped.push(value.candidate.record);
    for (const [index, policy] of value.policies.entries()) {
      const planned = value.input.evaluations[index];
      if (
        !planned ||
        !equal(policy.policy.reference, planned.request.policy) ||
        !equal(policy.request, {
          evaluationRequestId: planned.request.evaluationRequestId,
          definitionSha256: planned.requestSha256,
        })
      )
        issue("Policy observations must retain exact original order, versions and requests");
      if (policy.policy.state === "observed") scoped.push(policy.policy.record);
      if (
        policy.policy.state === "observed" &&
        !equal(policy.policy.reference, {
          policyId: policy.policy.record.policyId,
          policyVersionId: policy.policy.record.policyVersionId,
          definitionSha256: policy.policy.record.definitionSha256,
        })
      )
        issue("Policy observation must retain its actual owning reference");
      scoped.push(...policy.lifecycle);
      const original = policy.original;
      const requestMatches = (request: z.infer<typeof PolicyEvaluationRequestSchema>) => {
        const {
          schemaVersion: _schema,
          definitionSha256,
          scope: _scope,
          createdAt: _created,
          createdByPrincipalId: _creator,
          ...definition
        } = request;
        return (
          definitionSha256 === policy.request.definitionSha256 &&
          equal(definition, planned?.request)
        );
      };
      if (original.state === "complete") {
        scoped.push(
          original.request,
          original.job,
          original.attempt,
          original.snapshot,
          original.evaluation,
        );
        if (
          original.job.status !== "completed" ||
          original.job.jobId !== original.evaluation.jobId ||
          !requestMatches(original.request) ||
          !equal(original.job.request, policy.request) ||
          !equal(original.evaluation.request, policy.request) ||
          !equal(original.snapshot.request, policy.request) ||
          original.snapshot.jobId !== original.job.jobId
        )
          issue("A complete original graph requires its unique completed request/job/result");
        const snapshotReference = {
          snapshotId: original.snapshot.snapshotId,
          definitionSha256: original.snapshot.definitionSha256,
        };
        if (
          !equal(original.job.snapshot, snapshotReference) ||
          !equal(original.attempt.snapshot, snapshotReference) ||
          !equal(original.evaluation.snapshot, snapshotReference) ||
          !equal(original.job.result, {
            evaluationId: original.evaluation.evaluationId,
            definitionSha256: original.evaluation.definitionSha256,
          })
        )
          issue("Completed sources must retain the exact original seal and result references");
        const fence = original.attempt.mutationFence;
        if (
          original.attempt.closure?.status !== "completed" ||
          fence.jobId !== original.job.jobId ||
          fence.attemptId !== original.job.terminal?.attemptId ||
          fence.fencingToken !== original.job.lastFencingToken ||
          original.attempt.attemptSequence + 1 !== original.job.attemptCount ||
          original.snapshot.fencingToken > fence.fencingToken ||
          original.snapshot.sealedByPrincipalId !== original.snapshot.workerId ||
          original.evaluation.recordedByPrincipalId !== fence.workerId ||
          !equal(fence, {
            jobId: original.evaluation.jobId,
            attemptId: original.evaluation.attemptId,
            workerId: original.evaluation.workerId,
            leaseId: original.evaluation.leaseId,
            fencingToken: original.evaluation.fencingToken,
            recoveryEpoch: original.evaluation.recoveryEpoch,
          })
        )
          issue("Completion must retain its actual closed attempt and original publication fence");
        for (const record of [original.snapshot, original.evaluation])
          if (
            !equal(record.candidate, original.request.candidate) ||
            !equal(record.policy, original.request.policy) ||
            !equal(record.algorithm, original.request.algorithm) ||
            record.evaluationTime !== original.request.evaluationTime
          )
            issue("Original seal and result must retain the complete planned request subject");
        if (
          original.attempt.closure?.committedAt !== original.evaluation.recordedAt ||
          original.job.terminal?.committedAt !== original.evaluation.recordedAt ||
          policyEvaluationTimestampOrderKey(original.snapshot.sealedAt) >
            policyEvaluationTimestampOrderKey(original.evaluation.recordedAt) ||
          policyEvaluationTimestampOrderKey(original.evaluation.recordedAt) > cut ||
          policyEvaluationTimestampOrderKey(original.job.updatedAt) > cut
        )
          issue("Original completion and seal receipts must precede the retained native cut");
      } else {
        for (const record of [original.knownRequest, original.knownJob, original.knownSnapshot])
          if (record) scoped.push(record);
        if (
          original.reason === "request_missing" &&
          (original.knownRequest || original.knownJob || original.knownSnapshot)
        )
          issue("Missing request observations cannot invent an owning graph");
        if (original.knownRequest && !requestMatches(original.knownRequest))
          issue("Known requests must retain original identity");
        if (original.knownJob && !equal(original.knownJob.request, policy.request))
          issue("Known jobs must retain their original request");
        if (
          original.knownSnapshot &&
          (!equal(original.knownSnapshot.request, policy.request) ||
            (original.knownJob &&
              (original.knownSnapshot.jobId !== original.knownJob.jobId ||
                !equal(original.knownJob.snapshot, {
                  snapshotId: original.knownSnapshot.snapshotId,
                  definitionSha256: original.knownSnapshot.definitionSha256,
                }))))
        )
          issue("Known original seals must retain their exact request and owning job");
      }
    }
    scoped.push(
      ...value.selections.records,
      ...value.selections.lifecycle,
      ...value.approvals.records.map((approval) => ({ scope: approval.subject.scope })),
      ...value.approvals.revocations,
      ...value.authorities.lifecycle,
    );
    for (const authority of value.authorities.records) {
      if (
        authority.reference.installationId !== value.input.selection.installationId ||
        authority.reference.gateTargetId !== value.input.selection.gateTargetId
      )
        issue("Reviewer authority must retain the exact installation target");
      if (authority.state === "observed") {
        scoped.push(authority.record);
        if (
          !equal(authority.reference, {
            authorityId: authority.record.authorityId,
            authorityVersionId: authority.record.authorityVersionId,
            definitionSha256: authority.record.definitionSha256,
            installationId: authority.record.installationId,
            gateTargetId: authority.record.gateTargetId,
            reviewerPrincipalId: authority.record.reviewerPrincipalId,
          })
        )
          issue("Reviewer observation must retain its actual owning reference");
      }
    }
    if (scoped.some((record) => !equal(record.scope, value.scope)))
      issue("Every retained original and current record must belong to the exact capture scope");
    if (
      !ordered(value.approvals.records.map(({ approvalId }) => approvalId)) ||
      !ordered(value.approvals.actors.map(({ approval }) => approval.approvalId))
    )
      issue("Approval records and original actor bindings must be unique and ordered");
    if (value.approvals.actors.length !== value.approvals.records.length)
      issue("Every original approval requires its retained owning identity binding");
    const identities = new Set(
      value.identities.map((identity) => serializeEvaluationCanonicalJson(identity.reference)),
    );
    if (
      identities.size !== value.identities.length ||
      !identities.has(serializeEvaluationCanonicalJson(value.publisherIdentity))
    )
      issue("Identity observations must be unique and include the original publisher binding");
    const authorityReferences = new Set(
      value.authorities.records.map((authority) =>
        serializeEvaluationCanonicalJson(authority.reference),
      ),
    );
    if (authorityReferences.size !== value.authorities.records.length)
      issue("Reviewer authority observations must retain unique exact versions");
    for (const [index, approval] of value.approvals.records.entries()) {
      const actor = value.approvals.actors[index];
      if (
        !actor ||
        actor.approval.approvalId !== approval.approvalId ||
        actor.approval.definitionSha256 !== approval.definitionSha256 ||
        actor.identity.principalId !== approval.reviewer.principalId
      )
        issue("Approval provenance must bind the exact original reviewer, not a new login");
      if (policyEvaluationTimestampOrderKey(approval.recordedAt) > cut)
        issue("Capture cannot contain approval actions from after its original cut");
      if (actor && !identities.has(serializeEvaluationCanonicalJson(actor.identity)))
        issue(
          "Every original review identity requires an explicit observation, including missingness",
        );
      if (!authorityReferences.has(serializeEvaluationCanonicalJson(approval.authority)))
        issue(
          "Every original approval authority requires an explicit observation, including missingness",
        );
      if (
        !equal(approval.subject.candidate, value.input.candidate) ||
        !equal(approval.subject.selection, value.input.selection) ||
        !value.input.evaluations.some(
          (planned) =>
            equal(planned.request.policy, approval.subject.policy) &&
            equal(
              {
                evaluationRequestId: planned.request.evaluationRequestId,
                definitionSha256: planned.requestSha256,
              },
              approval.subject.request,
            ),
        )
      )
        issue(
          "Captured approvals must belong to the original input, selection and planned request",
        );
    }
    for (const identity of value.identities)
      if (
        identity.state === "observed" &&
        (identity.record.tenantId !== value.scope.tenantId ||
          !equal(identity.reference, identity.record.identity) ||
          policyEvaluationTimestampOrderKey(identity.record.updatedAt) > cut)
      )
        issue("Identity views must retain their exact original owner, tenant and cut");
    if (
      value.usage.records > value.input.verificationLimits.maxAcquisitionRecords ||
      value.usage.recordBytes > value.input.verificationLimits.maxAcquisitionRecordBytes ||
      value.usage.approvalRecords > value.input.verificationLimits.maxApprovalRecords ||
      value.usage.approvalRecords <
        value.approvals.records.length + value.approvals.revocations.length
    )
      issue("All observed and repeated metadata/approval rows consume the frozen aggregate budget");
    for (const selection of value.selections.records)
      if (
        selection.selectionId !== value.input.selection.selectionId ||
        selection.installationId !== value.input.selection.installationId ||
        selection.gateTargetId !== value.input.selection.gateTargetId
      )
        issue("Selection census must retain only the original logical installation target");
    if (!ordered(value.selections.records.map(({ selectionVersionId }) => selectionVersionId)))
      issue("Selection census versions must be unique and ordered");
    const retained: unknown[] = [
      value.input,
      value.candidate,
      ...value.selections.records,
      ...value.selections.lifecycle,
      ...value.approvals.records,
      ...value.approvals.revocations,
      ...value.approvals.actors,
      ...value.authorities.records,
      ...value.authorities.lifecycle,
      ...value.identities,
    ];
    for (const policy of value.policies) {
      retained.push(policy.policy, ...policy.lifecycle);
      if (policy.original.state === "complete")
        retained.push(
          policy.original.request,
          policy.original.job,
          policy.original.attempt,
          policy.original.snapshot,
          policy.original.evaluation,
        );
      else {
        retained.push({
          state: policy.original.state,
          reason: policy.original.reason,
          request: policy.request,
        });
        for (const record of [
          policy.original.knownRequest,
          policy.original.knownJob,
          policy.original.knownSnapshot,
        ])
          if (record) retained.push(record);
      }
    }
    const retainedBytes = retained.reduce<number>(
      (total, record) =>
        total + encodeEvaluationCanonicalJson(JSON.parse(JSON.stringify(record))).byteLength,
      0,
    );
    if (value.usage.records < retained.length || value.usage.recordBytes < retainedBytes)
      issue("Recorded usage cannot omit retained observations or their exact canonical bytes");
    if (
      encodeEvaluationCanonicalJson(JSON.parse(JSON.stringify(value))).byteLength >
      MAX_RELEASE_DECISION_AUTHORITY_MATERIAL_BYTES
    )
      issue("Authority material exceeds its fixed canonical UTF-8 ceiling");
  });

export type ReleaseDecisionAuthorityMaterial = z.infer<
  typeof ReleaseDecisionAuthorityMaterialSchema
>;
export type ReleaseDecisionIdentityReference = z.infer<
  typeof ReleaseDecisionIdentityReferenceSchema
>;
export type ReleaseDecisionIdentityGrant = z.infer<typeof ReleaseDecisionIdentityGrantSchema>;
export type ReleaseDecisionIdentityObservation = z.infer<
  typeof ReleaseDecisionIdentityObservationSchema
>;
