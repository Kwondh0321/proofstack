import { z } from "zod";
import {
  encodeEvaluationCanonicalJson,
  serializeEvaluationCanonicalJson,
} from "./evaluation-definition-encoding.js";
import { PolicyEvaluationJobSnapshotSchema } from "./policy-evaluation-job-snapshot.js";
import {
  MAX_POLICY_EVALUATION_ACQUISITION_RECORDS,
  PolicyEvaluationRequestReferenceSchema,
} from "./policy-evaluation-request.js";
import { PolicyEvaluationSnapshotPageSetSchema } from "./policy-evaluation-snapshot.js";
import { policyEvaluationTimestampOrderKey } from "./policy-evaluation-time.js";
import { MAX_RELEASE_DECISION_APPROVAL_READS } from "./release-decision-input.js";
import {
  ReleaseDecisionAuthorityMaterialSchema,
  MAX_RELEASE_DECISION_AUTHORITY_MATERIAL_BYTES,
} from "./release-decision-authority-material.js";
import { ReleaseDecisionCredentialObservationSchema } from "./release-decision-credential-state.js";
import { ReleaseEvaluationActorProvenanceSchema } from "./release-evaluation-actor-provenance.js";
import { MAX_RELEASE_POLICY_SELECTION_POLICIES } from "./release-policy-selection.js";
import {
  ReleaseDecisionSelectionRootObservationSchema,
  ReleaseDecisionReviewerCensusObservationSchema,
  ReleaseDecisionControlObservationSchema,
} from "./release-decision-current-authority-sources.js";

export const RELEASE_DECISION_CURRENT_AUTHORITY_SCHEMA_VERSION = "0.2" as const;
export const MAX_RELEASE_DECISION_CONTROL_OBSERVATIONS = MAX_RELEASE_DECISION_APPROVAL_READS * 16;
const Original = z.discriminatedUnion("state", [
  z
    .object({
      state: z.literal("observed"),
      request: PolicyEvaluationRequestReferenceSchema,
      graph: PolicyEvaluationJobSnapshotSchema,
      pageSet: PolicyEvaluationSnapshotPageSetSchema,
      actors: ReleaseEvaluationActorProvenanceSchema,
    })
    .strict(),
  z
    .object({
      state: z.literal("unavailable"),
      request: PolicyEvaluationRequestReferenceSchema,
      reason: z.enum([
        "original_unresolved",
        "job_unavailable",
        "snapshot_unavailable",
        "pages_unavailable",
        "actors_unavailable",
        "invalid",
      ]),
    })
    .strict(),
]);
const same = (a: unknown, b: unknown) =>
  serializeEvaluationCanonicalJson(a) === serializeEvaluationCanonicalJson(b);
const key = (v: unknown) => serializeEvaluationCanonicalJson(v);
const ordered = (values: readonly string[]) =>
  values.every((v, i) => i === 0 || (values[i - 1] ?? "") < v);
const reviewerRoot = (reference: {
  installationId: string;
  gateTargetId: string;
  reviewerPrincipalId: string;
  authorityId: string;
}) => ({
  installationId: reference.installationId,
  gateTargetId: reference.gateTargetId,
  reviewerPrincipalId: reference.reviewerPrincipalId,
  authorityId: reference.authorityId,
});

/** Complete captured preimages only. Parsing/canonical transport never supplies actual private authentication or retained guards. */
export const ReleaseDecisionCurrentAuthorityMaterialSchema = z
  .object({
    schemaVersion: z.literal(RELEASE_DECISION_CURRENT_AUTHORITY_SCHEMA_VERSION),
    // Preserve the strict historical 0.1 component and its complete validation, never reinterpret it.
    base: ReleaseDecisionAuthorityMaterialSchema,
    selectionRoot: ReleaseDecisionSelectionRootObservationSchema,
    reviewerCensuses: z
      .array(ReleaseDecisionReviewerCensusObservationSchema)
      .max(MAX_POLICY_EVALUATION_ACQUISITION_RECORDS),
    credentials: z
      .array(ReleaseDecisionCredentialObservationSchema)
      .min(1)
      .max(MAX_RELEASE_DECISION_APPROVAL_READS + 1),
    originals: z.array(Original).max(MAX_RELEASE_POLICY_SELECTION_POLICIES),
    controls: z
      .array(ReleaseDecisionControlObservationSchema)
      .max(MAX_RELEASE_DECISION_CONTROL_OBSERVATIONS),
  })
  .strict()
  .superRefine((value, context) => {
    if (context.issues.length > 0) return;
    const issue = (message: string) => context.addIssue({ code: "custom", message });
    const { base } = value;
    const cut = policyEvaluationTimestampOrderKey(base.capturedAt);
    const target = {
      installationId: base.input.selection.installationId,
      gateTargetId: base.input.selection.gateTargetId,
    };
    if (!same(value.selectionRoot.reference, target))
      issue("Current selection root must bind the original installation target");
    if (
      value.selectionRoot.state === "observed" &&
      (!same(value.selectionRoot.record.scope, base.scope) ||
        value.selectionRoot.record.installationId !== target.installationId ||
        value.selectionRoot.record.gateTargetId !== target.gateTargetId)
    )
      issue("Observed selection binding must retain its exact scope and target");
    // A changed logical root is retained for a hold, not relabelled as the original root.
    const roots = new Map<string, unknown>();
    for (const row of base.authorities.records)
      roots.set(key(reviewerRoot(row.reference)), reviewerRoot(row.reference));
    for (const event of base.authorities.lifecycle)
      roots.set(key(reviewerRoot(event.authority)), reviewerRoot(event.authority));
    if (
      !ordered(value.reviewerCensuses.map((row) => key(row.reference))) ||
      !same(
        [...roots.keys()].sort(),
        value.reviewerCensuses.map((row) => key(row.reference)),
      )
    )
      issue(
        "Every original and related reviewer root requires one unique ordered census, including missingness",
      );
    const bindings = new Map<string, string>();
    const physicalSources = new Map<string, string>();
    const retainPhysical = (identity: unknown, observation: unknown) => {
      const k = key(identity),
        fingerprint = key(observation);
      if (physicalSources.has(k) && physicalSources.get(k) !== fingerprint)
        issue(
          "Repeated physical credential/identity observations cannot acquire different owners or preimages",
        );
      physicalSources.set(k, fingerprint);
    };
    for (const source of base.identities)
      retainPhysical(
        [
          "identity",
          source.reference.kind,
          source.reference.kind === "oidc_binding"
            ? source.reference.bindingId
            : source.reference.credentialId,
        ],
        source,
      );
    for (const census of value.reviewerCensuses) {
      const { installationId, gateTargetId, reviewerPrincipalId } = census.reference;
      if (
        installationId !== target.installationId ||
        gateTargetId !== target.gateTargetId ||
        !same(census.binding.reference, { installationId, gateTargetId, reviewerPrincipalId })
      )
        issue("Reviewer census binding must retain the exact original logical target");
      if (
        census.binding.state === "observed" &&
        (!same(census.binding.record.scope, base.scope) ||
          census.binding.record.installationId !== installationId ||
          census.binding.record.gateTargetId !== gateTargetId ||
          census.binding.record.reviewerPrincipalId !== reviewerPrincipalId)
      )
        issue("Observed reviewer binding must retain its exact scope and principal");
      const physicalKey = key(census.binding.reference),
        fingerprint = key(census.binding);
      if (bindings.has(physicalKey) && bindings.get(physicalKey) !== fingerprint)
        issue("Repeated physical reviewer root observations must agree");
      bindings.set(physicalKey, fingerprint);
    }
    const expectedCredentials = new Map<string, Set<string>>();
    const expectCredential = (
      principalId: string,
      credentialId: string,
      kind: "oidc_session" | "service_credential",
      bindingId?: string,
    ) => {
      const k = key({ kind, principalId, credentialId }),
        known = expectedCredentials.get(k) ?? new Set<string>();
      if (bindingId !== undefined) known.add(bindingId);
      expectedCredentials.set(k, known);
    };
    expectCredential(
      base.publisher.principalId,
      base.publisher.credentialId,
      base.publisher.principalType === "user" ? "oidc_session" : "service_credential",
      base.publisherIdentity.kind === "oidc_binding" ? base.publisherIdentity.bindingId : undefined,
    );
    for (const [index, actor] of base.approvals.actors.entries()) {
      const approval = base.approvals.records[index];
      if (approval)
        expectCredential(
          approval.reviewer.principalId,
          approval.reviewer.credentialId,
          "oidc_session",
          actor.identity.bindingId,
        );
    }
    const credentialKeys = value.credentials.map((row) => key(row.reference));
    if (!ordered(credentialKeys) || !same([...expectedCredentials.keys()].sort(), credentialKeys))
      issue(
        "Every actual original publisher/reviewer credential requires one exact observation without a replacement login",
      );
    for (const row of value.credentials) {
      retainPhysical(["credential", row.reference.kind, row.reference.credentialId], row);
      const ownerBindings = expectedCredentials.get(key(row.reference));
      if (ownerBindings && ownerBindings.size > 1)
        issue("One physical credential cannot represent different original bindings");
      if (row.state !== "observed") continue;
      if (
        row.record.tenantId !== base.scope.tenantId ||
        policyEvaluationTimestampOrderKey(row.record.createdAt) > cut ||
        (row.record.kind === "oidc_session" &&
          ownerBindings &&
          !ownerBindings.has(row.record.bindingId))
      )
        issue(
          "Credential preimages must retain actual tenant, original binding and native creation cut",
        );
      for (const receipt of [
        row.record.revokedAt,
        ...(row.record.kind === "oidc_session" ? [row.record.lastUsedAt] : []),
      ])
        if (receipt !== null && policyEvaluationTimestampOrderKey(receipt) > cut)
          issue("Credential observations cannot contain future use or revocation receipts");
    }
    if (value.originals.length !== base.policies.length)
      issue(
        "Every planned original evaluation requires its complete graph/pages/actor observation or explicit unavailability",
      );
    for (const [index, original] of value.originals.entries()) {
      const source = base.policies[index];
      if (!source || !same(original.request, source.request)) {
        issue("Original source observations must retain complete planned order");
        continue;
      }
      if (original.state !== "observed") continue;
      if (source.original.state !== "complete") {
        issue("An unresolved original cannot acquire an observed completed graph");
        continue;
      }
      const prior = source.original,
        graph = original.graph,
        actors = original.actors;
      if (
        !same(graph.request, prior.request) ||
        !same(graph.job, prior.job) ||
        !graph.attempts.some((row) => same(row, prior.attempt)) ||
        !same(original.pageSet.scope, base.scope) ||
        original.pageSet.definitionSha256 !== prior.snapshot.definitionSha256 ||
        Object.entries(original.pageSet.definition).some(
          ([field, v]) => !same(Reflect.get(prior.snapshot, field), v),
        )
      )
        issue(
          "Complete original proof must retain the actual full owning graph and every original sealed page",
        );
      if (
        !same(actors.scope, base.scope) ||
        !same(actors.original.request, source.request) ||
        actors.original.jobId !== graph.job.jobId ||
        !same(actors.original.snapshot, prior.evaluation.snapshot) ||
        !same(actors.original.evaluation, {
          evaluationId: prior.evaluation.evaluationId,
          definitionSha256: prior.evaluation.definitionSha256,
        }) ||
        actors.original.evaluationTime !== prior.request.evaluationTime ||
        actors.original.evaluatorPrincipalId !== prior.evaluation.recordedByPrincipalId ||
        actors.original.requesterPrincipalId !== graph.request.createdByPrincipalId ||
        !same(actors.candidate.reference, prior.request.candidate) ||
        !same(actors.policy.reference, prior.request.policy)
      )
        issue(
          "Original actor provenance must bind the exact original request/job/seal/result and owning receipts",
        );
      if (
        (base.candidate.state === "observed" &&
          actors.candidate.authorPrincipalId !== base.candidate.record.createdByPrincipalId) ||
        (source.policy.state === "observed" &&
          actors.policy.authorPrincipalId !== source.policy.record.publishedByPrincipalId)
      )
        issue("Current and original immutable subject author receipts cannot disagree");
    }
    const expectedControls = new Map<
      string,
      { approval: (typeof base.approvals.records)[number]; index: number }
    >();
    for (const approval of base.approvals.records)
      for (const [index] of approval.compensatingControls.entries())
        expectedControls.set(key([approval.approvalId, index]), { approval, index });
    const controlKeys = value.controls.map((row) =>
      key([row.approval.approvalId, row.controlIndex]),
    );
    // Preserve original numeric occurrence order (0..15); JSON-key sorting would put 10 before 2.
    if (!same([...expectedControls.keys()], controlKeys))
      issue(
        "Every declared compensating-control occurrence must remain explicit, including expired and opposing actions",
      );
    const inactiveApprovals = new Set<string>();
    for (const approval of base.approvals.records) {
      if (policyEvaluationTimestampOrderKey(approval.expiresAt) <= cut)
        inactiveApprovals.add(
          key({ approvalId: approval.approvalId, definitionSha256: approval.definitionSha256 }),
        );
      if (approval.supersedes) inactiveApprovals.add(key(approval.supersedes));
    }
    for (const event of base.approvals.revocations)
      if (policyEvaluationTimestampOrderKey(event.occurredAt) <= cut)
        inactiveApprovals.add(key(event.approval));
    for (const control of value.controls) {
      const expected = expectedControls.get(
        key([control.approval.approvalId, control.controlIndex]),
      );
      if (
        !expected ||
        control.approval.definitionSha256 !== expected.approval.definitionSha256 ||
        !same(control.scope, base.scope) ||
        !same(control.reference, expected.approval.compensatingControls[expected.index])
      )
        issue(
          "Control observations must bind the exact original approval, scope and content occurrence",
        );
      if (
        control.content.state === "captured" &&
        (policyEvaluationTimestampOrderKey(control.content.startedAt) <
          policyEvaluationTimestampOrderKey(base.input.createdAt) ||
          policyEvaluationTimestampOrderKey(control.content.completedAt) > cut)
      )
        issue(
          "Control content must be captured inside original input lifetime before the native cut",
        );
      if (control.content.state === "not_inspected" && expected) {
        if (
          control.content.reason === "action_not_approval" &&
          expected.approval.action === "approve"
        )
          issue("A supporting approval cannot disguise its control as a non-approval action");
        if (control.content.reason === "approval_inactive") {
          if (!inactiveApprovals.has(key(control.approval)))
            issue(
              "Skipped inactive controls require the retained original expiry/revocation/supersession fact",
            );
        }
      }
    }
    // Source validation recomputes semantic/canonical integrity; this is only the retained-cost lower
    // bound. Every attempted/discarded/repeated owning read must additionally consume the same meter.
    const retained: unknown[] = [
      base.input,
      base.candidate,
      ...base.selections.records,
      ...base.selections.lifecycle,
      ...base.approvals.records,
      ...base.approvals.revocations,
      ...base.approvals.actors,
      ...base.authorities.records,
      ...base.authorities.lifecycle,
      ...base.identities,
      value.selectionRoot,
      ...value.credentials,
    ];
    for (const source of base.policies) {
      retained.push(source.policy, ...source.lifecycle);
      if (source.original.state === "complete")
        retained.push(
          source.original.request,
          source.original.job,
          source.original.attempt,
          source.original.snapshot,
          source.original.evaluation,
        );
      else {
        retained.push({
          state: source.original.state,
          reason: source.original.reason,
          request: source.request,
        });
        for (const row of [
          source.original.knownRequest,
          source.original.knownJob,
          source.original.knownSnapshot,
        ])
          if (row) retained.push(row);
      }
    }
    for (const census of value.reviewerCensuses)
      retained.push(census.binding, { reference: census.reference, state: census.state });
    for (const original of value.originals) {
      if (original.state !== "observed") {
        retained.push(original);
        continue;
      }
      retained.push(
        original.graph.request,
        original.graph.job,
        ...original.graph.attempts,
        ...original.pageSet.pages,
        original.actors.original,
        original.actors.candidate,
        original.actors.policy,
        ...original.actors.sources,
      );
      if (original.graph.cancellation !== null) retained.push(original.graph.cancellation);
      if (original.graph.acquisitionAllowance) retained.push(original.graph.acquisitionAllowance);
    }
    for (const control of value.controls) retained.push(control.content, control.underGuards);
    const bytes = retained.reduce<number>(
      (total, row) =>
        total + encodeEvaluationCanonicalJson(JSON.parse(JSON.stringify(row))).byteLength,
      0,
    );
    if (base.usage.records < retained.length || base.usage.recordBytes < bytes)
      issue(
        "Current material cannot omit any retained original/credential/root/control observation or byte cost",
      );
    if (
      encodeEvaluationCanonicalJson(JSON.parse(JSON.stringify(value))).byteLength >
      MAX_RELEASE_DECISION_AUTHORITY_MATERIAL_BYTES
    )
      issue(
        "Complete current authority material exceeds its original aggregate canonical UTF-8 ceiling",
      );
  });

export type ReleaseDecisionCurrentAuthorityMaterial = z.infer<
  typeof ReleaseDecisionCurrentAuthorityMaterialSchema
>;
