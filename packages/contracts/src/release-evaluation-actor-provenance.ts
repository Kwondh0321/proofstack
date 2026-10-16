import { z } from "zod";
import {
  encodeEvaluationCanonicalJson,
  serializeEvaluationCanonicalJson,
} from "./evaluation-definition-encoding.js";
import { EvidenceScopeSchema } from "./evidence.js";
import {
  PolicyEvaluationRequestReferenceSchema,
  MAX_POLICY_EVALUATION_ACQUISITION_RECORDS,
  MAX_POLICY_EVALUATION_ACQUISITION_RECORD_BYTES,
} from "./policy-evaluation-request.js";
import { PolicyEvaluationSnapshotReferenceSchema } from "./policy-evaluation-snapshot.js";
import { PolicyEvaluationResultReferenceSchema } from "./policy-evaluation-result.js";
import { PolicyEvaluationRecordWitnessSchema } from "./policy-evaluation-snapshot-records.js";
import {
  policyEvaluationSourceReferenceKey,
  type PolicyEvaluationSourceReference,
} from "./policy-evaluation-source-reference.js";
import { PolicyEvaluationTimeSchema } from "./policy-evaluation-time.js";
import { OpaqueIdSchema } from "./primitives.js";
import { ReleaseCandidateReferenceSchema } from "./release-candidate.js";
import { ReleasePolicyReferenceSchema } from "./release-policy.js";

export const RELEASE_EVALUATION_ACTOR_PROVENANCE_SCHEMA_VERSION = "0.1" as const;
export const MAX_RELEASE_EVALUATION_ACTOR_PRINCIPALS =
  2 * MAX_POLICY_EVALUATION_ACQUISITION_RECORDS + 1;
export const ReleaseEvaluationActorRoleSchema = z.enum([
  "source_author",
  "evaluation_requester",
  "workflow_requester",
  "evaluation_actor",
  "declared_principal",
]);
export const ReleaseEvaluationActorFieldSchema = z.enum([
  "/createdByPrincipalId",
  "/publishedByPrincipalId",
  "/registeredByPrincipalId",
  "/recordedByPrincipalId",
  "/requestedByPrincipalId",
  "/executedByPrincipalId",
  "/reviewedByPrincipalId",
  "/verifiedByPrincipalId",
  "/reviewerPrincipalId",
  "/reviewer/principalId",
  "/job/createdByPrincipalId",
]);
type Field = {
  readonly field: z.infer<typeof ReleaseEvaluationActorFieldSchema>;
  readonly role: z.infer<typeof ReleaseEvaluationActorRoleSchema>;
};
const author = (field: Field["field"]): Field => Object.freeze({ field, role: "source_author" });
const actor = (field: Field["field"]): Field => Object.freeze({ field, role: "evaluation_actor" });
const requester = (field: Field["field"]): Field =>
  Object.freeze({ field, role: "evaluation_requester" });
const declared = (field: Field["field"]): Field =>
  Object.freeze({ field, role: "declared_principal" });

/** Fixed owning-field semantics for all installed kinds, never a caller-selected actor registry.
 * Model/provider labels and a declared profile subject are not authenticated evaluation actors.
 * An enqueue/definition/upload action is distinct from execution, assessment or assurance review.
 */
export const RELEASE_EVALUATION_SOURCE_ACTOR_FIELDS = {
  protocol_definition: [author("/registeredByPrincipalId")],
  endpoint_profile: [author("/registeredByPrincipalId")],
  aggregation_policy: [author("/publishedByPrincipalId")],
  assessment: [actor("/createdByPrincipalId")],
  discovery_record: [author("/recordedByPrincipalId")],
  evaluation_run_rejection: [requester("/requestedByPrincipalId")],
  model_assisted_evaluator_spec: [author("/publishedByPrincipalId")],
  blinded_plan: [author("/publishedByPrincipalId")],
  blinded_result: [actor("/recordedByPrincipalId")],
  calibration_report: [actor("/executedByPrincipalId")],
  comparison_definition: [author("/createdByPrincipalId")],
  comparison_result: [actor("/createdByPrincipalId")],
  comparison_snapshot: [author("/createdByPrincipalId")],
  criterion_set: [author("/publishedByPrincipalId")],
  criterion_set_status: [author("/recordedByPrincipalId")],
  dataset_version: [author("/createdByPrincipalId")],
  evaluation_aggregate: [actor("/createdByPrincipalId")],
  evaluation_implementation_registration: [author("/registeredByPrincipalId")],
  evaluation_run: [requester("/createdByPrincipalId")],
  evaluation_run_result: [actor("/recordedByPrincipalId")],
  evaluator_spec: [author("/publishedByPrincipalId")],
  human_review_protocol: [author("/publishedByPrincipalId")],
  human_review_record: [actor("/reviewer/principalId")],
  human_reviewer_independence: [actor("/reviewedByPrincipalId"), declared("/reviewerPrincipalId")],
  independence_declaration: [actor("/reviewedByPrincipalId")],
  independent_critique: [actor("/recordedByPrincipalId")],
  model_assurance_assessment: [],
  model_evaluator_profile: [author("/publishedByPrincipalId")],
  model_qualification_report: [actor("/executedByPrincipalId")],
  model_qualification_suite: [author("/publishedByPrincipalId")],
  oracle_spec: [author("/publishedByPrincipalId")],
  policy_installation_binding: [author("/registeredByPrincipalId")],
  qualification_fixture_set: [author("/publishedByPrincipalId")],
  qualification_report: [actor("/executedByPrincipalId")],
  qualification_policy: [author("/publishedByPrincipalId")],
  raw_observation: [actor("/executedByPrincipalId")],
  regression_fixture_version: [author("/createdByPrincipalId")],
  release_candidate: [author("/createdByPrincipalId")],
  release_policy: [author("/publishedByPrincipalId")],
  replay_isolation_profile: [author("/registeredByPrincipalId")],
  replay_plan: [author("/createdByPrincipalId")],
  replay_result: [
    Object.freeze({ field: "/job/createdByPrincipalId", role: "workflow_requester" }),
  ],
  replay_runtime_profile: [author("/registeredByPrincipalId")],
  runtime_adapter: [author("/registeredByPrincipalId")],
  source_review: [actor("/reviewedByPrincipalId")],
  source_reviewer_qualification: [
    declared("/reviewerPrincipalId"),
    actor("/verifiedByPrincipalId"),
  ],
  source_snapshot: [author("/publishedByPrincipalId")],
  target_release: [author("/createdByPrincipalId")],
} as const satisfies Record<PolicyEvaluationSourceReference["kind"], readonly Field[]>;
for (const fields of Object.values(RELEASE_EVALUATION_SOURCE_ACTOR_FIELDS)) Object.freeze(fields);
Object.freeze(RELEASE_EVALUATION_SOURCE_ACTOR_FIELDS);

export const ReleaseEvaluationSourceActorSchema = z
  .object({
    field: ReleaseEvaluationActorFieldSchema,
    role: ReleaseEvaluationActorRoleSchema,
    principalId: OpaqueIdSchema,
  })
  .strict();
export const ReleaseEvaluationActorSourceSchema = z
  .discriminatedUnion("state", [
    z
      .object({
        state: z.literal("observed"),
        witness: PolicyEvaluationRecordWitnessSchema,
        actors: z.array(ReleaseEvaluationSourceActorSchema).max(2),
      })
      .strict(),
    z
      .object({
        state: z.literal("unavailable"),
        witness: PolicyEvaluationRecordWitnessSchema,
        reason: z.enum([
          "original_body_unavailable",
          "owning_source_unavailable",
          "original_body_mismatch",
        ]),
      })
      .strict(),
  ])
  .superRefine((value, context) => {
    if (context.issues.length > 0 || value.state !== "observed") return;
    const fields: readonly Field[] =
      RELEASE_EVALUATION_SOURCE_ACTOR_FIELDS[value.witness.entry.source.kind];
    if (
      value.witness.storage === null ||
      value.actors.length !== fields.length ||
      value.actors.some(
        (entry, index) =>
          entry.field !== fields[index]?.field || entry.role !== fields[index]?.role,
      )
    )
      context.addIssue({
        code: "custom",
        message:
          "Observed actor projections require the exact owning full-body witness and fixed source fields",
      });
  });
const ordered = (values: readonly string[]) =>
  values.every((value, index) => index === 0 || (values[index - 1] ?? "") < value);

/** Historical original-actor provenance only. No current grants, private authentication or publication authority. */
export const ReleaseEvaluationActorProvenanceSchema = z
  .object({
    schemaVersion: z.literal(RELEASE_EVALUATION_ACTOR_PROVENANCE_SCHEMA_VERSION),
    authorityBoundary: z.literal("original_evaluation_actors_only"),
    scope: EvidenceScopeSchema,
    original: z
      .object({
        request: PolicyEvaluationRequestReferenceSchema,
        jobId: OpaqueIdSchema,
        snapshot: PolicyEvaluationSnapshotReferenceSchema,
        evaluation: PolicyEvaluationResultReferenceSchema,
        evaluationTime: PolicyEvaluationTimeSchema,
        evaluatorPrincipalId: OpaqueIdSchema,
        requesterPrincipalId: OpaqueIdSchema,
      })
      .strict(),
    candidate: z
      .object({ reference: ReleaseCandidateReferenceSchema, authorPrincipalId: OpaqueIdSchema })
      .strict(),
    policy: z
      .object({ reference: ReleasePolicyReferenceSchema, authorPrincipalId: OpaqueIdSchema })
      .strict(),
    sources: z
      .array(ReleaseEvaluationActorSourceSchema)
      .min(2)
      .max(MAX_POLICY_EVALUATION_ACQUISITION_RECORDS),
    sourceState: z.enum(["complete", "unavailable"]),
    evaluationActorState: z.enum(["complete", "unavailable"]),
    evaluatorPrincipalIds: z
      .array(OpaqueIdSchema)
      .min(1)
      .max(MAX_RELEASE_EVALUATION_ACTOR_PRINCIPALS)
      .refine(ordered, "Original evaluation principals must be unique and ordered"),
  })
  .strict()
  .superRefine((value, context) => {
    if (context.issues.length > 0) return;
    const issue = (message: string) => context.addIssue({ code: "custom", message });
    if (
      !ordered(
        value.sources.map((source) =>
          policyEvaluationSourceReferenceKey(source.witness.entry.source),
        ),
      )
    )
      issue("Actor provenance must retain unique ordered original source identities");
    for (const [kind, root, field] of [
      ["release_candidate", value.candidate, "/createdByPrincipalId"],
      ["release_policy", value.policy, "/publishedByPrincipalId"],
    ] as const) {
      const source = value.sources.find(
        (item) =>
          item.witness.entry.source.kind === kind &&
          serializeEvaluationCanonicalJson(item.witness.entry.source.reference) ===
            serializeEvaluationCanonicalJson(root.reference),
      );
      if (
        source?.state !== "observed" ||
        !source.actors.some(
          (entry) => entry.field === field && entry.principalId === root.authorPrincipalId,
        )
      )
        issue("Actor provenance must retain both original owning subject-author root witnesses");
    }
    const ids = new Set([value.original.evaluatorPrincipalId]);
    let complete = true;
    for (const source of value.sources) {
      const fields: readonly Field[] =
        RELEASE_EVALUATION_SOURCE_ACTOR_FIELDS[source.witness.entry.source.kind];
      if (source.state === "observed") {
        for (const entry of source.actors)
          if (entry.role === "evaluation_actor") ids.add(entry.principalId);
      } else if (fields.some(({ role }) => role === "evaluation_actor")) complete = false;
    }
    if (
      value.sourceState !==
        (value.sources.every(({ state }) => state === "observed") ? "complete" : "unavailable") ||
      value.evaluationActorState !== (complete ? "complete" : "unavailable") ||
      JSON.stringify([...ids].sort()) !== JSON.stringify(value.evaluatorPrincipalIds)
    )
      issue(
        "Original actor completeness and principal inventory must be derived from every retained source",
      );
    if (
      encodeEvaluationCanonicalJson(value).byteLength >
      MAX_POLICY_EVALUATION_ACQUISITION_RECORD_BYTES
    )
      issue("Original actor provenance exceeds its aggregate canonical UTF-8 byte admission");
  });

export type ReleaseEvaluationSourceActor = z.infer<typeof ReleaseEvaluationSourceActorSchema>;
export type ReleaseEvaluationActorSource = z.infer<typeof ReleaseEvaluationActorSourceSchema>;
export type ReleaseEvaluationActorProvenance = z.infer<
  typeof ReleaseEvaluationActorProvenanceSchema
>;
