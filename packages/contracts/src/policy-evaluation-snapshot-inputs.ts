import {
  PolicyEvaluationSnapshotClosureSchema,
  type PolicyEvaluationSnapshotClosure,
} from "./policy-evaluation-snapshot-closure.js";
import { policyEvaluationSourceReferenceKey } from "./policy-evaluation-source-reference.js";
import { z } from "zod";
import { JsonPointerSchema } from "./artifact.js";
import {
  CriteriaTrustReasonSchema,
  CriteriaTrustStatusSchema,
  CRITERIA_TRUST_REASONS,
} from "./evaluation-criteria-trust.js";
import { serializeEvaluationCanonicalJson } from "./evaluation-definition-encoding.js";
import { ContentReferenceSchema } from "./evidence.js";
import {
  PolicyEvaluationAuthorityRequirementsSchema,
  PolicyEvaluationLifecycleInputsSchema,
} from "./policy-evaluation-authority.js";
import { PolicyEvaluationCandidateAuthorityInputsSchema } from "./policy-evaluation-candidate-authority.js";
import { PolicyEvaluationCriterionAuthorityInputsSchema } from "./policy-evaluation-criterion-authority.js";
import {
  PolicyEvaluationManifestPageSetSchema,
  PolicyEvaluationSourceObservationSchema,
} from "./policy-evaluation-manifest.js";
import {
  PolicyEvaluationRequestSchema,
  MAX_POLICY_EVALUATION_ACQUISITION_RECORDS,
} from "./policy-evaluation-request.js";
import { PolicyEvaluationSnapshotApplicabilitySchema } from "./policy-evaluation-snapshot-applicability.js";
import {
  PolicyEvaluationSnapshotArtifactCatalogSchema,
  PolicyEvaluationSnapshotArtifactSchema,
  PolicyEvaluationSnapshotFixtureBindingsSchema,
  PolicyEvaluationSnapshotTraceArtifactSchema,
  PolicyEvaluationSnapshotTraceSchema,
} from "./policy-evaluation-snapshot-content.js";
import {
  PolicyEvaluationSnapshotRuleInputsSchema,
  PolicyEvaluationArtifactObservationSchema,
} from "./policy-evaluation-snapshot-rules.js";
import { PolicyEvaluationSnapshotSourceInputsSchema } from "./policy-evaluation-snapshot-sources.js";
import { PolicyEvaluationSourceReferenceSchema } from "./policy-evaluation-source-reference.js";
import {
  PolicyEvaluationTimeSchema,
  policyEvaluationTimestampOrderKey,
} from "./policy-evaluation-time.js";
import { OpaqueIdSchema, Sha256Schema } from "./primitives.js";
import { ReleaseCandidateSchema } from "./release-candidate.js";
import { ReleasePolicySchema } from "./release-policy.js";

export const POLICY_EVALUATION_SNAPSHOT_INPUTS_SCHEMA_VERSION = "0.1" as const;
const Index = z
  .number()
  .int()
  .nonnegative()
  .max(MAX_POLICY_EVALUATION_ACQUISITION_RECORDS - 1);
const Indices = z.array(Index).max(MAX_POLICY_EVALUATION_ACQUISITION_RECORDS);
const Source = PolicyEvaluationSourceReferenceSchema;
const Unavailable = z.union([
  PolicyEvaluationSourceObservationSchema.options[1],
  PolicyEvaluationSourceObservationSchema.options[2],
]);
const TrustRequirements = z
  .object({
    evaluationTime: PolicyEvaluationTimeSchema,
    reasons: z.array(CriteriaTrustReasonSchema).max(CRITERIA_TRUST_REASONS.length),
    status: CriteriaTrustStatusSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (context.issues.length > 0) return;
    if (
      (value.status === "eligible") !== (value.reasons.length === 0) ||
      !value.reasons.every((reason, index) => index === 0 || reason > value.reasons[index - 1]!)
    )
      context.addIssue({
        code: "custom",
        message: "Trust requirements must preserve the original ordered reasons and status",
      });
  });
const Trust = z
  .object({
    parents: z
      .array(
        z
          .object({
            source: Source.refine((source) => source.kind === "evaluation_run"),
            recordSha256: Sha256Schema,
            evaluationTime: PolicyEvaluationTimeSchema,
            dependencyEdgeIndexes: Indices,
            artifactCaptureIndexes: Indices,
            observation: z.discriminatedUnion("status", [
              z
                .object({
                  status: z.literal("unavailable"),
                  reason: z.literal("criterion_set_unavailable"),
                })
                .strict(),
              z
                .object({ status: z.literal("inspected"), requirements: TrustRequirements })
                .strict(),
            ]),
          })
          .strict(),
      )
      .max(MAX_POLICY_EVALUATION_ACQUISITION_RECORDS),
    unavailableParents: z
      .array(
        z
          .object({
            source: Source.refine((source) => source.kind === "evaluation_run"),
            observation: Unavailable,
          })
          .strict(),
      )
      .max(MAX_POLICY_EVALUATION_ACQUISITION_RECORDS),
  })
  .strict();
const StoredArtifact = z
  .object({
    origin: z
      .object({
        edgeIndex: Index,
        parent: Source,
        parentRecordSha256: Sha256Schema,
        path: JsonPointerSchema,
      })
      .strict(),
    scope: PolicyEvaluationRequestSchema.shape.scope,
    reference: ContentReferenceSchema,
    evaluationTime: PolicyEvaluationTimeSchema,
    observedAt: PolicyEvaluationTimeSchema,
    catalog: PolicyEvaluationSnapshotArtifactCatalogSchema.nullable(),
    observation: z.union([
      z.object({ status: z.literal("content_pending") }).strict(),
      PolicyEvaluationArtifactObservationSchema.options[1],
      PolicyEvaluationArtifactObservationSchema.options[2],
    ]),
  })
  .strict();
const GuardOrigin = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("artifact_capture"), captureIndex: Index }).strict(),
  z.object({ kind: z.literal("policy_node"), nodeIndex: Index }).strict(),
  z.object({ kind: z.literal("storage_policy_node"), nodeIndex: Index }).strict(),
  z.object({ kind: z.literal("stored_artifact_capture"), captureIndex: Index }).strict(),
  z.object({ kind: z.literal("storage_artifact_identity"), edgeIndex: Index }).strict(),
  z.object({ kind: z.literal("policy_successor"), historyIndex: Index }).strict(),
]);
const BaseObjectSchema = z
  .object({
    schemaVersion: z.literal(POLICY_EVALUATION_SNAPSHOT_INPUTS_SCHEMA_VERSION),
    request: PolicyEvaluationRequestSchema,
    capturedAt: PolicyEvaluationTimeSchema,
    roots: z.object({ candidate: ReleaseCandidateSchema, policy: ReleasePolicySchema }).strict(),
    sources: PolicyEvaluationSnapshotSourceInputsSchema,
    rules: PolicyEvaluationSnapshotRuleInputsSchema,
    manifest: PolicyEvaluationManifestPageSetSchema,
    policyAuthority: z
      .object({
        source: Source.refine((source) => source.kind === "release_policy"),
        recordSha256: Sha256Schema,
        evaluationTime: PolicyEvaluationTimeSchema,
        requirements: PolicyEvaluationAuthorityRequirementsSchema,
        dependencyEdgeIndexes: Indices,
        artifactCaptureIndexes: Indices,
      })
      .strict(),
    policyLifecycle: z
      .object({
        beforeArtifacts: PolicyEvaluationLifecycleInputsSchema,
        afterArtifacts: PolicyEvaluationLifecycleInputsSchema,
      })
      .strict(),
    candidateAuthority: z
      .object({
        beforeArtifacts: PolicyEvaluationCandidateAuthorityInputsSchema,
        afterArtifacts: PolicyEvaluationCandidateAuthorityInputsSchema,
      })
      .strict(),
    criterionAuthority: z
      .object({
        beforeArtifacts: PolicyEvaluationCriterionAuthorityInputsSchema,
        afterArtifacts: PolicyEvaluationCriterionAuthorityInputsSchema,
        underGuards: PolicyEvaluationCriterionAuthorityInputsSchema.optional(),
      })
      .strict(),
    applicability: PolicyEvaluationSnapshotApplicabilitySchema,
    evaluationTrust: Trust,
    traces: z
      .array(PolicyEvaluationSnapshotTraceSchema)
      .max(MAX_POLICY_EVALUATION_ACQUISITION_RECORDS),
    traceArtifactReferences: z
      .array(PolicyEvaluationSnapshotTraceArtifactSchema)
      .max(MAX_POLICY_EVALUATION_ACQUISITION_RECORDS),
    artifacts: z
      .array(PolicyEvaluationSnapshotArtifactSchema)
      .max(MAX_POLICY_EVALUATION_ACQUISITION_RECORDS),
    storedArtifacts: z.array(StoredArtifact).max(MAX_POLICY_EVALUATION_ACQUISITION_RECORDS),
    fixtureBindings: z
      .array(PolicyEvaluationSnapshotFixtureBindingsSchema)
      .max(MAX_POLICY_EVALUATION_ACQUISITION_RECORDS),
    sourceGuards: z
      .array(
        z
          .object({
            kind: z.enum(["artifact", "release_policy"]),
            id: OpaqueIdSchema,
            origins: z.array(GuardOrigin).min(1).max(MAX_POLICY_EVALUATION_ACQUISITION_RECORDS),
          })
          .strict(),
      )
      .max(MAX_POLICY_EVALUATION_ACQUISITION_RECORDS),
  })
  .strict();
function validateOriginalInputBindings(
  value: z.infer<typeof BaseObjectSchema>,
  context: z.RefinementCtx,
): void {
  if (context.issues.length > 0) return;
  const same = (left: unknown, right: unknown) =>
    serializeEvaluationCanonicalJson(left) === serializeEvaluationCanonicalJson(right);
  const issue = (message: string) => context.addIssue({ code: "custom", message });
  const request = {
    evaluationRequestId: value.request.evaluationRequestId,
    definitionSha256: value.request.definitionSha256,
  };
  const cut = policyEvaluationTimestampOrderKey(value.capturedAt);
  if (
    cut < policyEvaluationTimestampOrderKey(value.request.createdAt) ||
    cut < policyEvaluationTimestampOrderKey(value.request.evaluationTime)
  )
    issue("Snapshot capture cannot precede its immutable request or semantic cut");
  for (const component of [value.sources.records, value.rules])
    if (
      !same(component.request, request) ||
      !same(component.scope, value.request.scope) ||
      component.evaluationTime !== value.request.evaluationTime
    )
      issue(
        "Every input component must bind one exact immutable request, scope and evaluation time",
      );
  if (
    !same(value.roots.candidate.scope, value.request.scope) ||
    !same(value.roots.policy.scope, value.request.scope) ||
    !same(
      {
        candidateId: value.roots.candidate.candidateId,
        candidateVersionId: value.roots.candidate.candidateVersionId,
        definitionSha256: value.roots.candidate.definitionSha256,
      },
      value.request.candidate,
    ) ||
    !same(
      {
        policyId: value.roots.policy.policyId,
        policyVersionId: value.roots.policy.policyVersionId,
        definitionSha256: value.roots.policy.definitionSha256,
      },
      value.request.policy,
    )
  )
    issue("Snapshot root definitions cannot replace the original candidate or policy");
  if (
    value.rules.ruleCount !== value.roots.policy.rules.length ||
    !same(
      value.rules.rules.map(({ rule }) => rule),
      value.roots.policy.rules,
    )
  )
    issue("Snapshot rule inputs must retain the complete original policy definitions");
  for (const component of [
    value.applicability,
    ...Object.values(value.policyLifecycle),
    ...Object.values(value.candidateAuthority),
    ...Object.values(value.criterionAuthority),
  ]) {
    if (!component || !("scope" in component)) continue;
    if (
      !same(component.scope, value.request.scope) ||
      component.evaluationTime !== value.request.evaluationTime
    )
      issue("Authority/applicability observations cannot change scope or semantic cut");
    if (
      "completedAt" in component &&
      policyEvaluationTimestampOrderKey(component.completedAt) > cut
    )
      issue("Snapshot capture must follow every contained authority observation");
  }
  for (const artifact of [...value.artifacts, ...value.storedArtifacts]) {
    if (
      !same(artifact.scope, value.request.scope) ||
      artifact.evaluationTime !== value.request.evaluationTime
    )
      issue("Content observations cannot change exact scope or semantic cut");
    const observed = "completedAt" in artifact ? artifact.completedAt : artifact.observedAt;
    if (policyEvaluationTimestampOrderKey(observed) > cut)
      issue("Snapshot capture must follow every contained content observation");
  }
  for (const trace of value.traces)
    if (!same(trace.scope, value.request.scope))
      issue("Trace observations must retain exact scope");
  for (const occurrence of value.traceArtifactReferences) {
    const trace = value.traces[occurrence.traceCaptureIndex];
    const index = trace?.selector.eventIds.indexOf(occurrence.eventId) ?? -1;
    if (
      !trace ||
      trace.observation.status !== "verified" ||
      index < 0 ||
      trace.observation.eventSha256[index] !== occurrence.eventRecordSha256
    )
      issue(
        "Trace content references must join their original event coordinates and complete-envelope hashes",
      );
  }
}
const ObjectSchema = BaseObjectSchema.superRefine(validateOriginalInputBindings);
const ObjectSchemaV2 = z
  .object({
    ...BaseObjectSchema.shape,
    schemaVersion: z.literal("0.2"),
    closure: PolicyEvaluationSnapshotClosureSchema,
  })
  .strict()
  .superRefine((value, context) => {
    validateOriginalInputBindings({ ...value, schemaVersion: "0.1" }, context);
    if (context.issues.length > 0) return;
    const records = value.sources.records.records;
    const bySource = new Map(
      records.map((record) => [policyEvaluationSourceReferenceKey(record.entry.source), record]),
    );
    const issue = (message: string) => context.addIssue({ code: "custom", message });
    const exactSource = (source: (typeof value.closure.checks)[number]["parent"]) => {
      const record = bySource.get(policyEvaluationSourceReferenceKey(source));
      return (
        record !== undefined &&
        serializeEvaluationCanonicalJson(record.entry.source) ===
          serializeEvaluationCanonicalJson(source)
      );
    };
    for (const check of value.closure.checks) {
      const parent = bySource.get(policyEvaluationSourceReferenceKey(check.parent));
      if (
        !parent ||
        !exactSource(check.parent) ||
        !exactSource(check.owner) ||
        (check.relatedSource !== null && !exactSource(check.relatedSource))
      )
        issue("Closure check omitted its exact original parent/owner/dependency witness");
      if (
        check.parentRecordSha256 !== null &&
        parent?.storage?.recordSha256 !== check.parentRecordSha256
      )
        issue("Closure check substituted its full original parent body hash");
      if (check.parentRecordSha256 === null && parent?.storage !== null)
        issue("Unavailable closure parent cannot discard a retained body");
    }
    if (value.closure.rules.length !== value.rules.rules.length)
      issue("Closure must retain every original ordered rule");
    for (const [index, row] of [value.closure.rootContext, ...value.closure.rules].entries()) {
      if (row.sourceIndexes.some((source) => source >= records.length))
        issue("Closure coordinates omitted a source witness");
      const own = new Set(row.sourceIndexes);
      const byIndex = new Map(
        records.map((record, sourceIndex) => [
          policyEvaluationSourceReferenceKey(record.entry.source),
          sourceIndex,
        ]),
      );
      const expectedChecks = value.closure.checks.flatMap((check, checkIndex) =>
        check.context === "semantic" &&
        own.has(byIndex.get(policyEvaluationSourceReferenceKey(check.parent)) ?? -1) &&
        own.has(byIndex.get(policyEvaluationSourceReferenceKey(check.owner)) ?? -1)
          ? [checkIndex]
          : [],
      );
      if (
        serializeEvaluationCanonicalJson(expectedChecks) !==
        serializeEvaluationCanonicalJson(row.checkIndexes)
      )
        issue("Closure cannot omit, add or substitute a relevant semantic check");
      if (
        index > 0 &&
        value.closure.rules[index - 1]?.ruleId !== value.rules.rules[index - 1]?.rule.ruleId
      )
        issue("Closure changed original rule identity");
    }
  });

/** Server-owned retained inputs. A valid parse is not current authority or an atomic seal. */
export interface PolicyEvaluationSnapshotInputsV1 {
  schemaVersion: typeof POLICY_EVALUATION_SNAPSHOT_INPUTS_SCHEMA_VERSION;
  request: z.infer<typeof PolicyEvaluationRequestSchema>;
  capturedAt: string;
  roots: {
    candidate: z.infer<typeof ReleaseCandidateSchema>;
    policy: z.infer<typeof ReleasePolicySchema>;
  };
  sources: z.infer<typeof PolicyEvaluationSnapshotSourceInputsSchema>;
  rules: z.infer<typeof PolicyEvaluationSnapshotRuleInputsSchema>;
  manifest: z.infer<typeof PolicyEvaluationManifestPageSetSchema>;
  policyAuthority: {
    source: Extract<z.infer<typeof Source>, { kind: "release_policy" }>;
    recordSha256: string;
    evaluationTime: string;
    requirements: z.infer<typeof PolicyEvaluationAuthorityRequirementsSchema>;
    dependencyEdgeIndexes: number[];
    artifactCaptureIndexes: number[];
  };
  policyLifecycle: {
    beforeArtifacts: z.infer<typeof PolicyEvaluationLifecycleInputsSchema>;
    afterArtifacts: z.infer<typeof PolicyEvaluationLifecycleInputsSchema>;
  };
  candidateAuthority: {
    beforeArtifacts: z.infer<typeof PolicyEvaluationCandidateAuthorityInputsSchema>;
    afterArtifacts: z.infer<typeof PolicyEvaluationCandidateAuthorityInputsSchema>;
  };
  criterionAuthority: {
    beforeArtifacts: z.infer<typeof PolicyEvaluationCriterionAuthorityInputsSchema>;
    afterArtifacts: z.infer<typeof PolicyEvaluationCriterionAuthorityInputsSchema>;
    underGuards?: z.infer<typeof PolicyEvaluationCriterionAuthorityInputsSchema> | undefined;
  };
  applicability: z.infer<typeof PolicyEvaluationSnapshotApplicabilitySchema>;
  evaluationTrust: z.infer<typeof Trust>;
  traces: z.infer<typeof PolicyEvaluationSnapshotTraceSchema>[];
  traceArtifactReferences: z.infer<typeof PolicyEvaluationSnapshotTraceArtifactSchema>[];
  artifacts: z.infer<typeof PolicyEvaluationSnapshotArtifactSchema>[];
  storedArtifacts: z.infer<typeof StoredArtifact>[];
  fixtureBindings: z.infer<typeof PolicyEvaluationSnapshotFixtureBindingsSchema>[];
  sourceGuards: {
    kind: "artifact" | "release_policy";
    id: string;
    origins: z.infer<typeof GuardOrigin>[];
  }[];
}

export type PolicyEvaluationSnapshotInputs =
  | PolicyEvaluationSnapshotInputsV1
  | (Omit<PolicyEvaluationSnapshotInputsV1, "schemaVersion"> & {
      schemaVersion: "0.2";
      closure: PolicyEvaluationSnapshotClosure;
    });

export const PolicyEvaluationSnapshotInputsSchema: z.ZodType<PolicyEvaluationSnapshotInputs> =
  z.preprocess(
    (raw, context) => {
      if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
        let count = 1;
        const add = (value: unknown) => {
          if (Array.isArray(value)) count += value.length;
        };
        const get = (value: unknown, field: string): unknown =>
          value !== null && typeof value === "object" && !Array.isArray(value)
            ? Reflect.get(value, field)
            : undefined;
        const lists = (value: unknown, fields: readonly string[]) => {
          for (const field of fields) add(get(value, field));
        };
        for (const field of [
          "traces",
          "traceArtifactReferences",
          "artifacts",
          "storedArtifacts",
          "fixtureBindings",
          "sourceGuards",
        ] as const)
          add(Reflect.get(raw, field));
        // Admit every authority/history collection before walking any record/body material.
        for (const name of [
          "policyLifecycle",
          "candidateAuthority",
          "criterionAuthority",
        ] as const) {
          const group = get(raw, name);
          for (const phase of ["beforeArtifacts", "afterArtifacts", "underGuards"] as const) {
            const observation = get(group, phase);
            lists(observation, [
              "history",
              "successors",
              "criteria",
              "selections",
              "occurrences",
              "unavailableParents",
            ]);
            const criteria = get(observation, "criteria");
            if (Array.isArray(criteria) && count <= MAX_POLICY_EVALUATION_ACQUISITION_RECORDS)
              for (const criterion of criteria) {
                lists(criterion, ["historyIndexes", "issues"]);
                for (const projection of ["atEvaluation", "atCapture"] as const)
                  lists(get(criterion, projection), ["active", "heads", "inactivePredecessors"]);
                if (count > MAX_POLICY_EVALUATION_ACQUISITION_RECORDS) break;
              }
          }
        }
        const closure = get(raw, "closure");
        lists(closure, ["checks", "rules"]);
        const closureChecks = get(closure, "checks");
        if (Array.isArray(closureChecks) && count <= MAX_POLICY_EVALUATION_ACQUISITION_RECORDS)
          for (const check of closureChecks) {
            add(get(check, "reasons"));
            if (count > MAX_POLICY_EVALUATION_ACQUISITION_RECORDS) break;
          }
        const closureRules = get(closure, "rules");
        const coordinates = [
          get(closure, "rootContext"),
          ...(Array.isArray(closureRules) && count <= MAX_POLICY_EVALUATION_ACQUISITION_RECORDS
            ? closureRules
            : []),
        ];
        for (const coordinate of coordinates)
          lists(coordinate, [
            "sourceIndexes",
            "edgeIndexes",
            "frontierEdgeIndexes",
            "checkIndexes",
          ]);
        const trust = get(raw, "evaluationTrust");
        lists(trust, ["parents", "unavailableParents"]);
        const parents = get(trust, "parents");
        if (Array.isArray(parents) && count <= MAX_POLICY_EVALUATION_ACQUISITION_RECORDS)
          for (const parent of parents) {
            lists(parent, ["dependencyEdgeIndexes", "artifactCaptureIndexes"]);
            add(get(get(get(parent, "observation"), "requirements"), "reasons"));
            if (count > MAX_POLICY_EVALUATION_ACQUISITION_RECORDS) break;
          }
        const policy = get(raw, "policyAuthority");
        lists(policy, ["dependencyEdgeIndexes", "artifactCaptureIndexes"]);
        add(get(get(policy, "requirements"), "findings"));
        for (const field of ["fixtureBindings", "sourceGuards"] as const) {
          const rows = get(raw, field);
          if (Array.isArray(rows) && count <= MAX_POLICY_EVALUATION_ACQUISITION_RECORDS)
            for (const row of rows) {
              if (field === "sourceGuards") add(get(row, "origins"));
              else {
                const artifacts = get(row, "artifacts");
                add(artifacts);
                if (Array.isArray(artifacts) && count <= MAX_POLICY_EVALUATION_ACQUISITION_RECORDS)
                  for (const artifact of artifacts) {
                    add(get(artifact, "artifactCaptureIndexes"));
                    if (count > MAX_POLICY_EVALUATION_ACQUISITION_RECORDS) break;
                  }
              }
              if (count > MAX_POLICY_EVALUATION_ACQUISITION_RECORDS) break;
            }
        }
        const sources: unknown = Reflect.get(raw, "sources");
        if (sources !== null && typeof sources === "object" && !Array.isArray(sources)) {
          for (const field of ["semanticFrontier", "storedMappings"] as const)
            add(Reflect.get(sources, field));
          add(get(get(sources, "logicalRoots"), "mappings"));
          const mappings = get(sources, "storedMappings");
          if (Array.isArray(mappings) && count <= MAX_POLICY_EVALUATION_ACQUISITION_RECORDS)
            for (const mapping of mappings) {
              add(get(mapping, "targets"));
              if (count > MAX_POLICY_EVALUATION_ACQUISITION_RECORDS) break;
            }
          const recordInput: unknown = Reflect.get(sources, "records");
          if (
            recordInput !== null &&
            typeof recordInput === "object" &&
            !Array.isArray(recordInput)
          ) {
            const records: unknown = Reflect.get(recordInput, "records");
            add(records);
            if (Array.isArray(records) && count <= MAX_POLICY_EVALUATION_ACQUISITION_RECORDS)
              for (const record of records) {
                if (record !== null && typeof record === "object" && !Array.isArray(record))
                  add(Reflect.get(record, "origins"));
                if (count > MAX_POLICY_EVALUATION_ACQUISITION_RECORDS) break;
              }
          }
        }
        if (count > MAX_POLICY_EVALUATION_ACQUISITION_RECORDS) {
          context.addIssue({
            code: "custom",
            message: "Snapshot input occurrences exceed the fixed acquisition ceiling",
          });
          return z.NEVER;
        }
      }
      return raw;
    },
    z.union([ObjectSchema, ObjectSchemaV2]),
  );
