import { createHash } from "node:crypto";
import {
  type EvaluationRecordKind,
  encodeEvaluationCanonicalJson,
  MAX_POLICY_EVALUATION_ACQUISITION_RECORD_BYTES,
  MAX_POLICY_EVALUATION_ACQUISITION_RECORDS,
  PolicyEvaluationSourceReferenceSchema,
} from "@proofstack/contracts";
import { beforeAll, describe, expect, it } from "vitest";
import { CreateModelAssuranceAssessment } from "../evaluation/create-model-assurance-assessment.js";
import {
  digestEvaluationRecordDefinition,
  evaluationRecordDescriptors,
} from "../evaluation/evaluation-record-validation.js";
import { digestModelAssuranceRecordDefinition } from "../evaluation/model-assurance-record-validation.js";
import type { ModelAssuranceRecordKind } from "../evaluation/model-assurance-repository.js";
import { FixedClock } from "../testing/fixed-clock.js";
import {
  createModelAssuranceRepositoryTestHarness,
  type ModelAssuranceRepositoryTestHarness,
} from "../testing/model-assurance-repository-fixtures.js";
import {
  inspectPolicyEvaluationEvidenceRecord,
  type PolicyEvaluationEvidenceRead,
  type PolicyEvaluationEvidenceReaderDependencies,
  type PolicyEvaluationEvidenceSource,
  type PolicyEvaluationEvidenceSourceKind,
  type ReadPolicyEvaluationEvidenceInput,
  readPolicyEvaluationEvidence,
} from "./policy-evaluation-evidence-reader.js";
import {
  enumeratePolicyEvaluationEvidenceReferences,
  type PolicyEvaluationEvidenceReferenceError,
  type PolicyEvaluationEvidenceReferenceLimits,
} from "./policy-evaluation-evidence-references.js";

type Kind = PolicyEvaluationEvidenceSourceKind;
type Fields = Record<string, unknown>;
type FixtureRecord = NonNullable<PolicyEvaluationEvidenceRead["record"]>;
const limits = { maxReferenceBytes: 4_000_000, maxReferences: 10_000 };
const evaluationTime = "2026-10-01T00:00:00.000Z";
let records: { kind: Kind; record: FixtureRecord }[];
let repositories: PolicyEvaluationEvidenceReaderDependencies;

// Independent schema-path oracle. No production enumerator, collector, or lineage helper is used.
// Optional/union fields contribute only when present. Numeric pointer segments preserve array order.
const paths = {
  aggregation_policy: ["dataset_version /dataset"],
  assessment: [
    "evaluation_aggregate /aggregate",
    "aggregation_policy /aggregationPolicy",
    "artifact /counterevidence/*/artifact",
    "source_snapshot /counterevidence/*/source",
    "replay_result /counterevidence/*/replay",
    "replay_plan /counterevidence/*/replay/plan",
    "artifact /counterevidence/*/replay/result",
    "target_release /counterevidence/*/replay/targetRelease",
    "criterion_set /criterion/criterionSet",
    "criterion_set_status /criterionStatus",
    "raw_observation /observations/*",
    "qualification_report /qualifications/*",
    "evaluation_run /runs/*",
    "source_review /sourceReviews/*",
  ],
  criterion_set: [
    "source_snapshot /criteria/*/counterevidence/*",
    "evaluator_spec /criteria/*/evaluator",
    "oracle_spec /criteria/*/oracle",
    "regression_fixture_version /criteria/*/qualificationFixtures/*/fixture",
    "criterion_set /predecessor",
    "source_review /sources/*/review",
    "source_snapshot /sources/*/source",
  ],
  criterion_set_status: [
    "criterion_set /criterionSet",
    "criterion_set_status /previousStatus",
    "criterion_set /supersededBy",
  ],
  discovery_record: [],
  evaluation_aggregate: [
    "aggregation_policy /aggregationPolicy",
    "criterion_set /criterion/criterionSet",
    "evaluation_run_result /members/*/result",
    "evaluation_run /members/*/run",
    "artifact /samplingAssumption/evidence/*",
  ],
  evaluation_run: [
    "aggregation_policy /aggregationPolicy",
    "registered_implementation /applicability/interpreter",
    "criterion_set /criterion/criterionSet",
    "criterion_set_status /criterionStatus",
    "dataset_version /dataset",
    "artifact /environmentEvidence/*",
    "evaluator_spec /evaluator",
    "qualification_report /evaluatorQualification",
    "regression_fixture_version /fixture",
    "artifact /inputEvidence/*",
    "oracle_spec /oracle",
    "qualification_report /oracleQualification",
    "replay_result /replay",
    "replay_plan /replay/plan",
    "artifact /replay/result",
    "target_release /replay/targetRelease",
    "source_review /sourceReviews/*",
  ],
  evaluation_run_rejection: [
    "registered_implementation /applicability/interpreter",
    "criterion_set /criterion/criterionSet",
    "criterion_set_status /criterionStatus",
    "source_review /sourceReviews/*",
  ],
  evaluation_run_result: [
    "evaluation_run_identity /evaluationRunId",
    "raw_observation /observations/*",
  ],
  evaluator_spec: [
    "registered_implementation /implementation",
    "artifact /inputSchema",
    "evaluator_spec /kindDeclaration/components/*",
    "oracle_spec /oracles/*",
    "artifact /outputSchema",
    "evaluator_spec /predecessor",
    "qualification_fixture_set /qualificationFixtureSet",
    "criterion_selector /supportedCriteria/*",
  ],
  oracle_spec: [
    "registered_implementation /implementation",
    "artifact /inputSchema",
    "artifact /outputSchema",
    "oracle_spec /predecessor",
    "qualification_fixture_set /qualificationFixtureSet",
    "criterion_selector /supportedCriteria/*",
  ],
  qualification_fixture_set: [
    "criterion_selector /cases/*/criterion",
    "regression_fixture_version /cases/*/fixture",
    "qualification_fixture_set /predecessor",
  ],
  qualification_report: [
    "artifact /caseResults/*/rawEvidence/*",
    "artifact /environmentEvidence/*",
    "qualification_fixture_set /fixtureSet",
    "qualification_policy /policy",
    "oracle_spec /subject/oracle",
    "evaluator_spec /subject/evaluator",
  ],
  raw_observation: [
    "artifact /counterevidence/*/artifact",
    "source_snapshot /counterevidence/*/source",
    "replay_result /counterevidence/*/replay",
    "replay_plan /counterevidence/*/replay/plan",
    "artifact /counterevidence/*/replay/result",
    "target_release /counterevidence/*/replay/targetRelease",
    "artifact /evidence/*/artifact",
    "source_snapshot /evidence/*/source",
    "replay_result /evidence/*/replay",
    "replay_plan /evidence/*/replay/plan",
    "artifact /evidence/*/replay/result",
    "target_release /evidence/*/replay/targetRelease",
    "artifact /output/artifact",
    "evaluation_run /run",
  ],
  source_review: [
    "artifact /reviewBasis/*",
    "source_snapshot /reviewedConflicts/*",
    "source_reviewer_qualification /reviewerQualification",
    "source_snapshot /source",
    "source_review /supersedesReview",
  ],
  source_reviewer_qualification: [
    "artifact /credentialEvidence/*",
    "source_reviewer_qualification /predecessor",
  ],
  source_snapshot: [
    "source_snapshot /conflictsWith/*",
    "artifact /content",
    "discovery_record /discovery",
    "artifact /identityVerification/evidence/*",
    "source_snapshot /supersedes/*",
  ],
  blinded_plan: [
    "artifact /blindMap",
    "calibration_report /calibrationReport",
    "criterion_set /criteria/*/criterionSet",
    "model_assisted_evaluator_spec /evaluator",
    "independence_declaration /independenceDeclaration",
    "artifact /leakageChecks/*/evidence",
    "model_evaluator_profile /modelProfile",
    "blinded_plan /predecessor",
    "artifact /redactionReport",
    "artifact /subjectArtifacts/*",
  ],
  blinded_result: [
    "artifact /attempts/*/errorEvidence/*",
    "raw_observation /attempts/*/observation",
    "artifact /attempts/*/providerResponse",
    "artifact /attempts/*/rationale",
    "artifact /blindMapAccessEvidence",
    "artifact /disagreementEvidence/*",
    "artifact /orderComparison",
    "blinded_plan /plan",
  ],
  calibration_report: [
    "artifact /calibrationEvidence/*",
    "criterion_set /criteria/*/criterionSet",
    "dataset_version /dataset",
    "artifact /distributionShift/evidence/*",
    "model_assisted_evaluator_spec /evaluator",
    "artifact /labelSources/*",
    "model_evaluator_profile /modelProfile",
    "calibration_report /predecessor",
    "qualification_report /qualificationReport",
  ],
  human_review_protocol: [
    "artifact /accessibility/accommodationProcess",
    "criterion_set /claim/criteria/*/criterionSet",
    "artifact /claim/evidenceBundle/*",
    "artifact /dissentPolicy/adjudicationRules",
    "human_review_protocol /predecessor",
    "artifact /reviewerRoles/*/credentialRequirements/*",
    "artifact /reviewerRoles/*/trainingRequirements/*",
  ],
  human_review_record: [
    "assessment /assessment",
    "artifact /counterevidence/*",
    "artifact /credentialEvidence/*",
    "independent_critique /critiques/*",
    "artifact /evidenceAccessManifest",
    "artifact /expertiseEvidence/*",
    "human_reviewer_independence /independenceDeclaration",
    "raw_observation /observations/*",
    "human_review_protocol /protocol",
    "artifact /rationale",
    "artifact /reviewedArtifacts/*",
    "artifact /reviewer/sessionEvidence",
    "artifact /sourceCitations/*",
    "human_review_record /supersedes",
    "artifact /trainingEvidence/*",
  ],
  human_reviewer_independence: [
    "human_reviewer_independence /predecessor",
    "artifact /reviewBasis/*",
  ],
  independence_declaration: [
    "independence_declaration /predecessor",
    "artifact /reviewBasis/*",
    "model_assisted_evaluator_spec /subject/evaluator",
    "model_evaluator_profile /subject/modelProfile",
  ],
  independent_critique: [
    "artifact /accessAttestation/evidence",
    "artifact /allowedEvidence/*",
    "calibration_report /calibrationReport",
    "criterion_set /criterion/criterionSet",
    "model_assisted_evaluator_spec /evaluator",
    "artifact /evidenceAccessManifest",
    "independence_declaration /independenceDeclaration",
    "model_evaluator_profile /modelProfile",
    "model_qualification_report /modelQualificationReport",
    "raw_observation /observation",
    "artifact /outcome/evidence/*",
    "artifact /outcome/findings/*/evidence/*",
    "artifact /outcome/output",
    "qualification_report /qualificationReport",
    "artifact /question",
  ],
  model_assisted_evaluator_spec: [
    "artifact /inputSchema",
    "model_evaluator_profile /modelProfile",
    "artifact /outputSchema",
    "model_assisted_evaluator_spec /predecessor",
    "qualification_fixture_set /qualificationFixtureSet",
    "criterion_selector /supportedCriteria/*",
  ],
  model_assurance_assessment: [
    "assessment /baseAssessment",
    "blinded_plan /blindedPlan",
    "blinded_result /blindedResult",
    "calibration_report /calibrationReport",
    "artifact /counterevidence/*",
    "independent_critique /critiques/*",
    "artifact /disagreementEvidence/*",
    "human_review_protocol /humanReviewProtocol",
    "human_review_record /humanReviews/*",
    "independence_declaration /independenceDeclarations/*",
    "model_qualification_report /modelQualificationReport",
    "raw_observation /nonModelEvidence/observations/*",
    "oracle_spec /nonModelEvidence/oracles/*",
    "artifact /policy",
  ],
  model_evaluator_profile: [
    "model_evaluator_selector /evaluator",
    "artifact /outputSchema",
    "model_evaluator_profile /predecessor",
    "artifact /prompts/*/template",
    "artifact /provider/modelResolution/resolutionEvidence",
    "criterion_selector /supportedCriteria/*",
    "artifact /toolContracts/*",
  ],
  model_qualification_report: [
    "qualification_report /baseQualificationReport",
    "calibration_report /calibrationReport",
    "artifact /environmentEvidence/*",
    "model_assisted_evaluator_spec /evaluator",
    "independence_declaration /independenceDeclaration",
    "model_evaluator_profile /modelProfile",
    "model_qualification_report /predecessor",
    "artifact /resultManifest",
    "artifact /resultManifestSchema",
    "model_qualification_suite /suite",
    "artifact /validationEvidence/*",
  ],
  model_qualification_suite: [
    "qualification_fixture_set /baseQualificationFixtureSet",
    "blinded_plan /blindedPlan",
    "artifact /caseManifest",
    "artifact /caseManifestSchema",
    "criterion_selector /criteria/*",
    "dataset_version /dataset",
    "model_assisted_evaluator_spec /evaluator",
    "artifact /executionPolicy/fixedSeeds",
    "artifact /manifestValidationEvidence",
    "model_evaluator_profile /modelProfile",
    "model_qualification_suite /predecessor",
  ],
} as const satisfies Record<Kind, readonly string[]>;
const kinds = Object.keys(paths) as Kind[];

function fields(value: unknown): Fields {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected object fixture");
  return value as Fields;
}

function repositoryKind(kind: Kind): EvaluationRecordKind | ModelAssuranceRecordKind {
  if (kind === "blinded_plan") return "blinded_evaluation_plan";
  if (kind === "blinded_result") return "blinded_evaluation_result";
  if (kind === "model_assisted_evaluator_spec") return "model_assisted_evaluator";
  return kind;
}

function sourceFor(kind: Kind, record: FixtureRecord): PolicyEvaluationEvidenceSource {
  const schema = PolicyEvaluationSourceReferenceSchema.options.find(
    ({ shape }) => shape.kind.value === kind,
  );
  if (!schema) throw new Error(`Expected source kind ${kind}`);
  return PolicyEvaluationSourceReferenceSchema.parse({
    kind,
    reference: Object.fromEntries(
      Object.keys(schema.shape.reference.shape).map((key) => [key, fields(record)[key]]),
    ),
  }) as PolicyEvaluationEvidenceSource;
}

function prepare(kind: Kind, record: FixtureRecord) {
  const input = {
    evaluationTime,
    scope: structuredClone(record.scope),
    source: sourceFor(kind, record),
  };
  const evidence = inspectPolicyEvaluationEvidenceRecord(input, record);
  expect(evidence.observation.status).toBe("verified");
  return { evidence, input, record };
}

function fixture(kind: Kind, edit?: (body: Fields) => void) {
  const found = records.find((record) => record.kind === kind);
  if (!found) throw new Error(`Expected fixture ${kind}`);
  const record = structuredClone(found.record);
  if (edit) {
    const definition = fields(structuredClone(record));
    const key = repositoryKind(kind);
    const receiptKeys = Object.hasOwn(evaluationRecordDescriptors, key)
      ? evaluationRecordDescriptors[key as EvaluationRecordKind].receiptKeys
      : [
          "definitionSha256",
          "schemaVersion",
          "scope",
          "publishedAt",
          "publishedByPrincipalId",
          "recordedAt",
          ...(key === "blinded_evaluation_result" || key === "independent_critique"
            ? ["recordedByPrincipalId"]
            : []),
        ];
    for (const field of receiptKeys) delete definition[field];
    edit(definition);
    const digest = Object.hasOwn(evaluationRecordDescriptors, key)
      ? digestEvaluationRecordDefinition(key as EvaluationRecordKind, record.scope, definition)
      : digestModelAssuranceRecordDefinition(
          key as ModelAssuranceRecordKind,
          record.scope,
          definition,
        );
    for (const field of Object.keys(record))
      if (!receiptKeys.includes(field)) delete fields(record)[field];
    Object.assign(record, definition, { definitionSha256: digest });
  }
  return prepare(kind, record);
}

function matches(value: unknown, pattern: string): { path: string; value: unknown }[] {
  function visit(
    current: unknown,
    segments: readonly string[],
    path: string,
  ): { path: string; value: unknown }[] {
    if (current === undefined) return [];
    const [head, ...tail] = segments;
    if (head === undefined) return [{ path, value: current }];
    if (head === "*") {
      if (!Array.isArray(current)) throw new Error(`Expected array ${path}`);
      return current.flatMap((child, index) => visit(child, tail, `${path}/${index}`));
    }
    return visit(fields(current)[head], tail, `${path}/${head}`);
  }
  return visit(value, pattern.split("/").slice(1), "");
}

function pointerOrder(a: { path: string }, b: { path: string }): number {
  const left = a.path.split("/");
  const right = b.path.split("/");
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const x = left[index];
    const y = right[index];
    if (x === y) continue;
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (/^\d+$/.test(x) && /^\d+$/.test(y)) return Number(x) - Number(y);
    return x < y ? -1 : 1;
  }
  return 0;
}

function expectedReferences(kind: Kind, record: FixtureRecord): unknown[] {
  return paths[kind]
    .flatMap((entry) => {
      const [type, path] = entry.split(" ");
      if (!path) throw new Error("Expected oracle pointer");
      return matches(record, path).map(({ path: location, value }) => {
        if (type === "evaluation_run_identity")
          return { evaluationRunId: value, kind: type, path: location };
        if (type === "criterion_selector" || type === "model_evaluator_selector")
          return { kind: type, path: location, selector: value };
        if (
          type === "artifact" ||
          type === "registered_implementation" ||
          type === "qualification_policy"
        )
          return { kind: type, path: location, reference: value };
        const reference =
          type === "discovery_record"
            ? {
                definitionSha256: fields(value)["definitionSha256"],
                discoveryId: fields(value)["discoveryId"],
              }
            : value;
        return { kind: "record", path: location, source: { kind: type, reference } };
      });
    })
    .sort(pointerOrder);
}

// A second structural inventory catches reference-bearing fields absent from the manual matrix.
function markedPaths(value: unknown, path = ""): string[] {
  if (Array.isArray(value))
    return value.flatMap((child, index) => markedPaths(child, `${path}/${index}`));
  if (!value || typeof value !== "object") return [];
  const record = fields(value);
  // A calibration method's bare implementation/configuration hashes are parent metadata, not
  // registered implementation identities or resolvable artifact references.
  const marked =
    path &&
    ["definitionSha256", "implementationId", "artifactId"].some((key) =>
      Object.hasOwn(record, key),
    );
  return [
    ...(marked ? [path] : []),
    ...Object.entries(record).flatMap(([key, child]) => markedPaths(child, `${path}/${key}`)),
  ];
}

function verify(kind: Kind, record: FixtureRecord) {
  const { input, evidence } = prepare(kind, record);
  const result = enumeratePolicyEvaluationEvidenceReferences(input, evidence, limits);
  expect(result.references).toEqual(expectedReferences(kind, record));
  expect(result.referenceBytes).toBe(
    result.references.reduce(
      (sum, reference) => sum + encodeEvaluationCanonicalJson(reference).byteLength,
      0,
    ),
  );
  expect(result.recordSha256).toBe(
    createHash("sha256").update(encodeEvaluationCanonicalJson(record)).digest("hex"),
  );
  expect(result.source).toEqual(input.source);
  const actualPaths = result.references.map(({ path }) => path);
  expect(new Set(actualPaths).size).toBe(actualPaths.length);
  expect(markedPaths(record).filter((path) => !actualPaths.includes(path))).toEqual([]);
  return result;
}

function throwsReason(
  run: () => unknown,
  reason: PolicyEvaluationEvidenceReferenceError["reason"],
) {
  expect(run).toThrow(
    expect.objectContaining({ code: "policy_evaluation_evidence_references_invalid", reason }),
  );
}

beforeAll(async () => {
  const harness: ModelAssuranceRepositoryTestHarness =
    await createModelAssuranceRepositoryTestHarness("pol_refs");
  const assessment = await new CreateModelAssuranceAssessment({
    clock: new FixedClock(new Date("2026-09-02T06:00:00.000Z")),
    evaluationRepository: harness.evaluation.repository,
    modelAssuranceRepository: harness.repository,
  }).execute(harness.command);
  records = [
    ...harness.evaluation.records,
    ...harness.records,
    { kind: "model_assurance_assessment" as const, record: assessment.record },
  ].map(({ kind, record }) => ({
    kind:
      kind === "blinded_evaluation_plan"
        ? "blinded_plan"
        : kind === "blinded_evaluation_result"
          ? "blinded_result"
          : kind === "model_assisted_evaluator"
            ? "model_assisted_evaluator_spec"
            : kind,
    record,
  }));
  repositories = { evaluation: harness.evaluation.repository, modelAssurance: harness.repository };
});

describe("exact policy evaluation evidence references", () => {
  it("covers all thirty source kinds and every retained fixture variant", () => {
    expect(kinds).toHaveLength(30);
    expect(new Set(records.map(({ kind }) => kind))).toEqual(new Set(kinds));
    for (const { kind, record } of records) verify(kind, record);
  });

  describe.each(kinds)("%s", (kind) => {
    it("enumerates exact references from the real read-only repository path", async () => {
      const { input, record } = fixture(kind);
      const evidence = await readPolicyEvaluationEvidence(input, repositories);
      expect(
        enumeratePolicyEvaluationEvidenceReferences(input, evidence, limits).references,
      ).toEqual(expectedReferences(kind, record));
    });

    it("preserves exact count and canonical-byte budget edges without truncation", () => {
      const { input, evidence, record } = fixture(kind);
      const output = verify(kind, record);
      const exact = {
        maxReferenceBytes: output.referenceBytes,
        maxReferences: output.references.length,
      };
      expect(enumeratePolicyEvaluationEvidenceReferences(input, evidence, exact)).toEqual(output);
      if (output.references.length > 0) {
        throwsReason(
          () =>
            enumeratePolicyEvaluationEvidenceReferences(input, evidence, {
              ...exact,
              maxReferences: exact.maxReferences - 1,
            }),
          "reference_limit_exceeded",
        );
        throwsReason(
          () =>
            enumeratePolicyEvaluationEvidenceReferences(input, evidence, {
              ...exact,
              maxReferenceBytes: exact.maxReferenceBytes - 1,
            }),
          "reference_bytes_exceeded",
        );
      }
    });

    it("rejects a substituted full-record observation or its claimed source", () => {
      const { input, evidence } = fixture(kind);
      const changedObservation = {
        ...evidence,
        observation: { recordSha256: "f".repeat(64), status: "verified" as const },
      };
      throwsReason(
        () =>
          enumeratePolicyEvaluationEvidenceReferences(
            input,
            changedObservation as PolicyEvaluationEvidenceRead,
            limits,
          ),
        "observation_mismatch",
      );
      const changedSource = structuredClone(evidence);
      changedSource.source.reference.definitionSha256 = "f".repeat(64);
      throwsReason(
        () => enumeratePolicyEvaluationEvidenceReferences(input, changedSource, limits),
        "observation_mismatch",
      );
    });

    it("revalidates the parent schema, semantic digest, scope, and evaluation time", () => {
      const { input, evidence, record } = fixture(kind);
      for (const change of [
        { schemaVersion: "future" },
        { definitionSha256: "f".repeat(64) },
        { approved: true },
      ]) {
        const bad = {
          ...evidence,
          record: { ...record, ...change },
        } as PolicyEvaluationEvidenceRead;
        throwsReason(
          () => enumeratePolicyEvaluationEvidenceReferences(input, bad, limits),
          "evidence_unverified",
        );
      }
      for (const key of ["tenantId", "projectId", "environmentId"] as const) {
        const foreign = { ...input, scope: { ...input.scope, [key]: "id_other" } };
        throwsReason(
          () => enumeratePolicyEvaluationEvidenceReferences(foreign, evidence, limits),
          "evidence_unverified",
        );
      }
      throwsReason(
        () =>
          enumeratePolicyEvaluationEvidenceReferences(
            { ...input, evaluationTime: "2020-01-01T00:00:00Z" },
            evidence,
            limits,
          ),
        "evidence_unverified",
      );
    });

    it("rejects receipt-only replacement despite the unchanged definition digest", () => {
      const { input, evidence, record } = fixture(kind);
      const receipt =
        kind === "source_snapshot"
          ? "recordedAt"
          : ["createdAt", "publishedAt", "recordedAt", "reviewedAt"].find((key) =>
              Object.hasOwn(record, key),
            );
      if (!receipt) throw new Error("Expected authoritative receipt");
      const replaced = {
        ...record,
        [receipt]: new Date(Date.parse(String(fields(record)[receipt])) + 1).toISOString(),
      };
      expect(inspectPolicyEvaluationEvidenceRecord(input, replaced).observation.status).toBe(
        "verified",
      );
      throwsReason(
        () =>
          enumeratePolicyEvaluationEvidenceReferences(
            input,
            { ...evidence, record: replaced } as PolicyEvaluationEvidenceRead,
            limits,
          ),
        "observation_mismatch",
      );
    });

    it("cannot turn missing or unavailable observations into an empty successful inventory", () => {
      const { input, record } = fixture(kind);
      for (const observation of [
        { status: "missing" },
        { status: "unavailable", reason: "record_invalid" },
      ]) {
        for (const body of [null, record]) {
          const bad = {
            observation,
            record: body,
            source: input.source,
          } as PolicyEvaluationEvidenceRead;
          throwsReason(
            () => enumeratePolicyEvaluationEvidenceReferences(input, bad, limits),
            "evidence_unverified",
          );
        }
      }
    });

    it("owns output data and is deterministic across object-key insertion order", () => {
      const { input, evidence, record } = fixture(kind);
      const saved = structuredClone({ input, evidence, record, limits });
      const original = enumeratePolicyEvaluationEvidenceReferences(input, evidence, limits);
      const reversed = Object.fromEntries(Object.entries(record).reverse()) as FixtureRecord;
      expect(verify(kind, reversed)).toEqual(original);
      fields(original.source.reference)["definitionSha256"] = "f".repeat(64);
      if (original.references[0]) fields(original.references[0])["path"] = "/changed";
      expect({ input, evidence, record, limits }).toEqual(saved);
      expect(enumeratePolicyEvaluationEvidenceReferences(input, evidence, limits)).toEqual(
        verify(kind, record),
      );
    });
  });

  it("preserves repeated artifact occurrences and full descriptors at different record locations", () => {
    const { record } = fixture("oracle_spec", (body) => {
      body["outputSchema"] = structuredClone(body["inputSchema"]);
    });
    const output = verify("oracle_spec", record);
    const input = output.references.find(({ path }) => path === "/inputSchema");
    const repeated = output.references.find(({ path }) => path === "/outputSchema");
    expect(input?.kind).toBe("artifact");
    expect({ ...input, path: "/outputSchema" }).toEqual(repeated);
  });

  it.each(["sha256", "sizeBytes", "mediaType", "classification", "redactedAt"])(
    "rejects one artifact identity with conflicting %s",
    (field) => {
      const { input, evidence } = fixture("oracle_spec", (body) => {
        const original = fields(body["inputSchema"]);
        const changes: Fields = {
          classification: original["classification"] === "internal" ? "confidential" : "internal",
          mediaType: "application/octet-stream",
          redactedAt: original["redactedAt"] === "source" ? "ingest" : "source",
          sha256: "f".repeat(64),
          sizeBytes: Number(original["sizeBytes"]) + 1,
        };
        body["outputSchema"] = { ...original, [field]: changes[field] };
      });
      throwsReason(
        () => enumeratePolicyEvaluationEvidenceReferences(input, evidence, limits),
        "reference_conflict",
      );
    },
  );

  it("rejects a repeated immutable record identity with a different digest", () => {
    const { input, evidence } = fixture("raw_observation", (body) => {
      body["evidence"] = [
        {
          kind: "source_snapshot",
          source: { definitionSha256: "a".repeat(64), sourceSnapshotId: "src_other" },
        },
      ];
      body["counterevidence"] = [
        {
          kind: "source_snapshot",
          source: { definitionSha256: "b".repeat(64), sourceSnapshotId: "src_other" },
        },
      ];
    });
    throwsReason(
      () => enumeratePolicyEvaluationEvidenceReferences(input, evidence, limits),
      "reference_conflict",
    );
  });

  it("retains identical record references at both evidence and counterevidence paths", () => {
    const { record } = fixture("raw_observation", (body) => {
      body["evidence"] = [
        {
          kind: "source_snapshot",
          source: { definitionSha256: "a".repeat(64), sourceSnapshotId: "src_other" },
        },
      ];
      body["counterevidence"] = structuredClone(body["evidence"]);
    });
    const output = verify("raw_observation", record);
    expect(
      output.references.filter(
        (ref) => ref.kind === "record" && ref.source.kind === "source_snapshot",
      ),
    ).toHaveLength(2);
  });

  it("rejects the former joined-vector conflict between reviewed bytes and counterevidence", () => {
    const { input, evidence } = fixture("human_review_record", (body) => {
      const counterevidence = matches(body, "/counterevidence/*")[0];
      if (!counterevidence) throw new Error("Expected counterevidence fixture");
      fields(counterevidence.value)["sha256"] = "2".repeat(64);
    });
    throwsReason(
      () => enumeratePolicyEvaluationEvidenceReferences(input, evidence, limits),
      "reference_conflict",
    );
  });

  it("preserves hashless selectors and qualified implementation claims without invented authority", () => {
    for (const kind of [
      "oracle_spec",
      "model_evaluator_profile",
      "qualification_report",
      "evaluation_run_result",
    ] as const) {
      const { record } = fixture(kind);
      const result = verify(kind, record);
      const pending = result.references.filter(
        ({ kind }) => kind !== "record" && kind !== "artifact",
      );
      expect(pending.length).toBeGreaterThan(0);
      for (const ref of pending) {
        if (ref.kind === "criterion_selector" || ref.kind === "model_evaluator_selector")
          expect(ref.selector).not.toHaveProperty("definitionSha256");
        if (ref.kind === "qualification_policy")
          expect(ref.reference).toEqual(fields(record)["policy"]);
      }
      expect(result).not.toHaveProperty("approved");
      expect(result).not.toHaveProperty("complete");
    }
  });

  it("uses UTF-8 bytes rather than string length for reference budgets", () => {
    const { input, evidence, record } = fixture("oracle_spec", (body) => {
      fields(fields(body["implementation"])["runtime"])["version"] = "한글-runtime";
    });
    const result = verify("oracle_spec", record);
    const characters = result.references.reduce(
      (sum, value) =>
        sum + Buffer.from(encodeEvaluationCanonicalJson(value)).toString("utf8").length,
      0,
    );
    expect(result.referenceBytes).toBeGreaterThan(characters);
    throwsReason(
      () =>
        enumeratePolicyEvaluationEvidenceReferences(input, evidence, {
          ...limits,
          maxReferenceBytes: characters,
        }),
      "reference_bytes_exceeded",
    );
  });

  it.each([
    null,
    undefined,
    {},
    { ...limits, extra: true },
    ...["maxReferences", "maxReferenceBytes"].flatMap((key) =>
      [-1, 0.5, NaN, Infinity, "100", Number.MAX_SAFE_INTEGER].map((value) => ({
        ...limits,
        [key]: value,
      })),
    ),
    { ...limits, maxReferences: MAX_POLICY_EVALUATION_ACQUISITION_RECORDS + 1 },
    { ...limits, maxReferenceBytes: MAX_POLICY_EVALUATION_ACQUISITION_RECORD_BYTES + 1 },
  ])("rejects malformed or excessive budgets %#", (budget) => {
    const { input, evidence } = fixture("discovery_record");
    throwsReason(
      () =>
        enumeratePolicyEvaluationEvidenceReferences(
          input,
          evidence,
          budget as PolicyEvaluationEvidenceReferenceLimits,
        ),
      "input_invalid",
    );
  });

  it("accepts maximum and zero budgets for a record with no retained reference, without fetching discovery URLs", () => {
    const { input, evidence } = fixture("discovery_record");
    for (const budget of [
      { maxReferences: 0, maxReferenceBytes: 0 },
      {
        maxReferences: MAX_POLICY_EVALUATION_ACQUISITION_RECORDS,
        maxReferenceBytes: MAX_POLICY_EVALUATION_ACQUISITION_RECORD_BYTES,
      },
    ]) {
      expect(
        enumeratePolicyEvaluationEvidenceReferences(input, evidence, budget).references,
      ).toEqual([]);
    }
  });

  it.each([null, undefined, {}, { approved: true }])(
    "rejects invalid evidence wrappers %#",
    (evidence) => {
      const { input } = fixture("discovery_record");
      throwsReason(
        () =>
          enumeratePolicyEvaluationEvidenceReferences(
            input,
            evidence as PolicyEvaluationEvidenceRead,
            limits,
          ),
        "input_invalid",
      );
    },
  );

  it("rejects a claimed verified observation without a record", () => {
    const { input, evidence } = fixture("discovery_record");
    throwsReason(
      () =>
        enumeratePolicyEvaluationEvidenceReferences(
          input,
          { ...evidence, record: null } as PolicyEvaluationEvidenceRead,
          limits,
        ),
      "evidence_unverified",
    );
  });

  it("holds the root context fixed before consulting evidence accessors", () => {
    const { input, evidence } = fixture("oracle_spec");
    const original = structuredClone(input);
    const wrapper = {
      ...evidence,
      get observation() {
        input.scope.tenantId = "ten_mutated";
        input.source.reference.definitionSha256 = "f".repeat(64);
        return evidence.observation;
      },
    } as PolicyEvaluationEvidenceRead;
    const result = enumeratePolicyEvaluationEvidenceReferences(input, wrapper, limits);
    expect(result.source).toEqual(original.source);
  });

  it.each([
    ["criterion_set", "predecessor", "criterionSetVersionId"],
    ["criterion_set_status", "previousStatus", "statusRecordId"],
    ["evaluator_spec", "predecessor", "evaluatorVersionId"],
    ["oracle_spec", "predecessor", "oracleVersionId"],
    ["qualification_fixture_set", "predecessor", "fixtureSetVersionId"],
    ["source_review", "supersedesReview", "sourceReviewId"],
    ["source_reviewer_qualification", "predecessor", "qualificationId"],
    ["blinded_plan", "predecessor", "blindedPlanVersionId"],
    ["calibration_report", "predecessor", "calibrationReportId"],
    ["human_review_protocol", "predecessor", "protocolVersionId"],
    ["human_review_record", "supersedes", "reviewId"],
    ["human_reviewer_independence", "predecessor", "declarationId"],
    ["independence_declaration", "predecessor", "independenceDeclarationId"],
    ["model_assisted_evaluator_spec", "predecessor", "evaluatorVersionId"],
    ["model_evaluator_profile", "predecessor", "modelProfileVersionId"],
    ["model_qualification_report", "predecessor", "reportId"],
    ["model_qualification_suite", "predecessor", "suiteVersionId"],
  ] as const)(
    "retains optional %s %s lineage without claiming the predecessor exists",
    (kind, path, idField) => {
      const { input } = fixture(kind);
      const { record } = fixture(kind, (body) => {
        body[path] = {
          ...input.source.reference,
          [idField]: "id_predecessor",
          definitionSha256: "a".repeat(64),
        };
        if (kind === "criterion_set_status") body["status"] = "qualified";
      });
      expect(
        verify(kind, record).references.some((reference) => reference.path === `/${path}`),
      ).toBe(true);
      const absent = fixture(kind, (body) => {
        delete body[path];
      });
      expect(
        verify(kind, absent.record).references.some((reference) => reference.path === `/${path}`),
      ).toBe(false);
    },
  );

  it("retains both previous status and exact successor for a superseded criterion set", () => {
    const { input } = fixture("criterion_set_status");
    const { record } = fixture("criterion_set_status", (body) => {
      body["status"] = "superseded";
      body["previousStatus"] = {
        ...input.source.reference,
        definitionSha256: "a".repeat(64),
        statusRecordId: "status_previous",
      };
      body["supersededBy"] = {
        ...fields(body["criterionSet"]),
        criterionSetVersionId: "version_successor",
        definitionSha256: "b".repeat(64),
      };
    });
    expect(verify("criterion_set_status", record).references.map(({ path }) => path)).toEqual([
      "/criterionSet",
      "/previousStatus",
      "/supersededBy",
    ]);
  });

  it.each(["unverified", "disputed", "verified"] as const)(
    "preserves the source identity %s branch",
    (status) => {
      const { record } = fixture("source_snapshot", (body) => {
        if (status === "unverified")
          body["identityVerification"] = { reason: "No retained identity proof", status };
        if (status === "disputed")
          body["identityVerification"] = {
            evidence: [body["content"]],
            reason: "Conflicting identity proof",
            status,
          };
      });
      const result = verify("source_snapshot", record);
      expect(
        result.references.some(({ path }) => path.startsWith("/identityVerification/evidence/")),
      ).toBe(status !== "unverified");
    },
  );

  it("handles absent discovery and reviewer qualification without manufacturing a reference", () => {
    for (const [kind, field] of [
      ["source_snapshot", "discovery"],
      ["source_review", "reviewerQualification"],
    ] as const) {
      const { record } = fixture(kind, (body) => {
        delete body[field];
      });
      expect(verify(kind, record).references.some(({ path }) => path === `/${field}`)).toBe(false);
    }
  });

  it("preserves composite evaluator components and rejects conflicting logical resource IDs", () => {
    const make = (conflict: boolean) =>
      fixture("evaluator_spec", (body) => {
        body["kindDeclaration"] = {
          kind: "composite",
          components: [
            {
              evaluatorId: "evl_other_a",
              evaluatorVersionId: "evv_component_a",
              definitionSha256: "a".repeat(64),
            },
            {
              evaluatorId: "evl_other_b",
              evaluatorVersionId: "evv_component_b",
              definitionSha256: "b".repeat(64),
            },
          ],
        };
        if (conflict)
          body["predecessor"] = {
            evaluatorId: body["evaluatorId"],
            evaluatorVersionId: "evv_component_a",
            definitionSha256: "a".repeat(64),
          };
      });
    expect(
      verify("evaluator_spec", make(false).record).references.filter(({ path }) =>
        path.startsWith("/kindDeclaration/components/"),
      ),
    ).toHaveLength(2);
    const { input, evidence } = make(true);
    throwsReason(
      () => enumeratePolicyEvaluationEvidenceReferences(input, evidence, limits),
      "reference_conflict",
    );
  });

  it.each(["supported", "unsupported", "not_required"] as const)(
    "enumerates only retained sampling evidence for %s",
    (status) => {
      const artifact = fields(fixture("oracle_spec").record)["inputSchema"];
      const { record } = fixture("evaluation_aggregate", (body) => {
        body["samplingAssumption"] =
          status === "supported"
            ? { evidence: [artifact], status }
            : status === "unsupported"
              ? { limitations: ["No independent sampling evidence"], status }
              : { status };
      });
      expect(
        verify("evaluation_aggregate", record).references.some(({ path }) =>
          path.startsWith("/samplingAssumption/evidence/"),
        ),
      ).toBe(status === "supported");
    },
  );

  it.each(["absent", "digest_only", "artifact"] as const)(
    "preserves raw output %s without converting hashes to artifact authority",
    (mode) => {
      const artifact = fields(fixture("oracle_spec").record)["inputSchema"];
      const { record } = fixture("raw_observation", (body) => {
        if (mode === "absent") {
          delete body["measurement"];
          body["verdict"] = "error";
          body["error"] = { code: "input_unavailable", message: "Synthetic missing input" };
          body["output"] = { produced: false };
        } else
          body["output"] = {
            produced: true,
            sha256: fields(artifact)["sha256"],
            ...(mode === "artifact" ? { artifact } : {}),
          };
      });
      expect(
        verify("raw_observation", record).references.some(
          ({ path }) => path === "/output/artifact",
        ),
      ).toBe(mode === "artifact");
    },
  );

  it("expands every evidence union, including nested replay plan, target and artifact", () => {
    const replay = fields(fixture("evaluation_run").record)["replay"];
    const artifact = fields(fixture("oracle_spec").record)["inputSchema"];
    for (const kind of ["raw_observation", "assessment"] as const) {
      const { record } = fixture(kind, (body) => {
        body["counterevidence"] = [
          { artifact, kind: "artifact" },
          { kind: "replay_result", replay },
          {
            kind: "source_snapshot",
            source: { definitionSha256: "a".repeat(64), sourceSnapshotId: "src_counter" },
          },
        ];
        if (kind === "raw_observation") body["evidence"] = structuredClone(body["counterevidence"]);
      });
      expect(
        verify(kind, record).references.filter(({ path }) => path.startsWith("/counterevidence/")),
      ).toHaveLength(6);
    }
  });

  it.each(["exact", "provider_alias_only"] as const)("preserves model resolution %s", (status) => {
    const { record } = fixture("model_evaluator_profile", (body) => {
      fields(body["provider"])["modelResolution"] =
        status === "exact"
          ? {
              resolutionEvidence: body["outputSchema"],
              resolvedModelVersion: "model-reference-1",
              status,
            }
          : { limitation: "Provider does not expose immutable revisions", status };
    });
    expect(
      verify("model_evaluator_profile", record).references.some(
        ({ path }) => path === "/provider/modelResolution/resolutionEvidence",
      ),
    ).toBe(status === "exact");
  });

  it.each(["no_shift_detected", "shift_detected", "not_assessed"] as const)(
    "preserves %s distribution evidence without inferring calibration authority",
    (status) => {
      const { record } = fixture("calibration_report", (body) => {
        body["distributionShift"] =
          status === "not_assessed"
            ? { reason: "No independent shift study", status }
            : {
                evidence: body["calibrationEvidence"],
                method: "Synthetic retained method",
                status,
              };
        if (status !== "no_shift_detected") {
          body["status"] = "unavailable";
          body["statusReasons"] = ["Distribution stability is not established"];
        }
      });
      expect(
        verify("calibration_report", record).references.some(({ path }) =>
          path.startsWith("/distributionShift/evidence/"),
        ),
      ).toBe(status !== "not_assessed");
    },
  );

  it.each([
    "budget_exhausted",
    "deadline_exceeded",
    "output_malformed",
    "provider_refusal",
    "provider_unavailable",
  ] as const)("retains blinded attempt failure evidence for %s", (errorCode) => {
    const { record } = fixture("blinded_result", (body) => {
      const attempts = body["attempts"] as unknown[];
      const first = fields(attempts[0]);
      const artifact = first["providerResponse"];
      attempts[0] = {
        attemptId: first["attemptId"],
        errorCode,
        errorEvidence: [artifact],
        presentationId: first["presentationId"],
        seed: first["seed"],
        status: "failed",
      };
      body["status"] = "invalid";
      body["disagreementReasons"] = ["attempt_missing"];
      body["disagreementEvidence"] = [artifact];
    });
    const result = verify("blinded_result", record);
    expect(
      result.references
        .filter(({ path }) => path.startsWith("/attempts/0/"))
        .map(({ path }) => path),
    ).toEqual(["/attempts/0/errorEvidence/0"]);
    expect(result.references.some(({ path }) => path === "/attempts/1/observation")).toBe(true);
  });

  it("captures budget values once instead of rereading changing accessors", () => {
    const { input, evidence, record } = fixture("oracle_spec");
    const expected = verify("oracle_spec", record);
    let countReads = 0;
    let byteReads = 0;
    const budget = {
      get maxReferences() {
        return ++countReads === 1 ? expected.references.length : 0;
      },
      get maxReferenceBytes() {
        return ++byteReads === 1 ? expected.referenceBytes : 0;
      },
    };
    expect(enumeratePolicyEvaluationEvidenceReferences(input, evidence, budget)).toEqual(expected);
    expect({ byteReads, countReads }).toEqual({ byteReads: 1, countReads: 1 });
  });

  it.each(["produced", "abstained", "error"] as const)(
    "preserves critique %s evidence",
    (status) => {
      const { record } = fixture("independent_critique", (body) => {
        if (status === "abstained")
          body["outcome"] = {
            evidence: body["allowedEvidence"],
            reasons: ["Insufficient independent evidence"],
            status,
          };
        if (status === "error")
          body["outcome"] = {
            code: "input_unavailable",
            evidence: body["allowedEvidence"],
            reason: "Synthetic unavailable input",
            status,
          };
      });
      const result = verify("independent_critique", record);
      expect(result.references.some(({ path }) => path === "/outcome/output")).toBe(
        status === "produced",
      );
      expect(result.references.some(({ path }) => path.startsWith("/outcome/evidence/"))).toBe(
        status !== "produced",
      );
    },
  );

  it("retains array occurrence order beyond single-digit positions", () => {
    const { record } = fixture("source_snapshot", (body) => {
      body["conflictsWith"] = Array.from({ length: 12 }, (_, index) => ({
        definitionSha256: "a".repeat(64),
        sourceSnapshotId: `src_other_${String(index).padStart(2, "0")}`,
      }));
    });
    expect(
      verify("source_snapshot", record)
        .references.slice(0, 12)
        .map(({ path }) => path),
    ).toEqual(Array.from({ length: 12 }, (_, index) => `/conflictsWith/${index}`));
  });

  it.each([
    null,
    undefined,
    { evaluationTime: "invalid" },
    { scope: {} },
    { source: {} },
    { extra: () => {} },
  ])("rejects malformed captured context %#", (change) => {
    const { input, evidence } = fixture("oracle_spec");
    const changed = change == null ? change : { ...input, ...change };
    throwsReason(
      () =>
        enumeratePolicyEvaluationEvidenceReferences(
          changed as ReadPolicyEvaluationEvidenceInput,
          evidence,
          limits,
        ),
      "input_invalid",
    );
  });
});
