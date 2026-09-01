import { readFileSync } from "node:fs";
import type { EvidenceScope } from "@proofstack/contracts";
import { describe, it } from "vitest";
import type { EvaluationRecordKind } from "../evaluation/evaluation-repository-errors.js";
import type { EvaluationRecord } from "../evaluation/evaluation-repository.js";
import {
  digestEvaluationRecordDefinition,
  evaluationRecordId,
} from "../evaluation/evaluation-record-validation.js";
import {
  evaluationRepositoryConformanceCases,
  type EvaluationRepositoryFixtureRecord,
  type EvaluationRepositoryTestHarness,
} from "./evaluation-repository-conformance.js";
import { MemoryEvaluationRepository } from "./memory-evaluation-repository.js";

interface StoredVector {
  readonly input: { readonly definition: Record<string, unknown> };
  readonly kind: EvaluationRecordKind;
}

interface MutableObject {
  [key: string]: unknown;
  aggregationPolicy?: unknown;
  aggregateId?: unknown;
  canonicalUri?: unknown;
  conflictsWith?: unknown;
  counterevidence?: unknown;
  criteria?: unknown;
  criterionSet?: unknown;
  criterionSetId?: unknown;
  criticalConflictStatus?: unknown;
  definitionSha256?: unknown;
  discovery?: unknown;
  discoveryId?: unknown;
  evaluatorQualification?: unknown;
  evaluationRunId?: unknown;
  expiresAt?: unknown;
  fixtureSet?: unknown;
  measurement?: unknown;
  observationId?: unknown;
  observations?: unknown;
  oracleQualification?: unknown;
  oracles?: unknown;
  predecessor?: unknown;
  previousStatus?: unknown;
  policyVersionId?: unknown;
  qualificationFixtureSet?: unknown;
  qualificationReportId?: unknown;
  qualifications?: unknown;
  query?: unknown;
  resultId?: unknown;
  reviewedConflicts?: unknown;
  run?: unknown;
  source?: unknown;
  sourceReviewId?: unknown;
  sourceReviews?: unknown;
  sources?: unknown;
  sourceSnapshotId?: unknown;
  status?: unknown;
  statusRecordId?: unknown;
  subject?: unknown;
  supersedes?: unknown;
  supersedesReview?: unknown;
  value?: unknown;
  verdict?: unknown;
}

const vectorFiles = [
  "evaluation-source-definition-v1.json",
  "evaluation-criteria-definition-v1.json",
  "evaluation-spec-definition-v1.json",
  "evaluation-qualification-definition-v1.json",
  "evaluation-run-definition-v1.json",
  "evaluation-assessment-definition-v1.json",
] as const;

const vectors = vectorFiles.flatMap(
  (file) =>
    (
      JSON.parse(
        readFileSync(new URL(`../../../contracts/vectors/${file}`, import.meta.url), "utf8"),
      ) as { readonly vectors: readonly StoredVector[] }
    ).vectors,
);

function object(value: unknown, label: string): MutableObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as MutableObject;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  return value;
}

function template(kind: EvaluationRecordKind): MutableObject {
  const vector = vectors.find((candidate) => candidate.kind === kind);
  if (!vector) throw new Error(`Missing ${kind} vector`);
  return structuredClone(vector.input.definition) as MutableObject;
}

function scope(namespace: string, suffix = "primary"): EvidenceScope {
  return {
    environmentId: `env_${namespace}_${suffix}`,
    projectId: `prj_${namespace}_${suffix}`,
    tenantId: `ten_${namespace}`,
  };
}

function receipt(kind: EvaluationRecordKind): Record<string, unknown> {
  const principal = "usr_repository_conformance";
  const timestamp = "2026-09-02T00:00:00.000Z";
  switch (kind) {
    case "aggregation_policy":
    case "criterion_set":
    case "evaluator_spec":
    case "oracle_spec":
    case "qualification_fixture_set":
      return { publishedAt: timestamp, publishedByPrincipalId: principal };
    case "assessment":
    case "evaluation_aggregate":
    case "evaluation_run":
      return { createdAt: timestamp, createdByPrincipalId: principal };
    case "criterion_set_status":
    case "discovery_record":
    case "evaluation_run_result":
      return { recordedAt: timestamp, recordedByPrincipalId: principal };
    case "evaluation_run_rejection":
      return { recordedAt: timestamp, requestedByPrincipalId: principal };
    case "qualification_report":
      return { executedByPrincipalId: principal, recordedAt: timestamp };
    case "raw_observation":
      return { recordedAt: timestamp };
    case "source_review":
      return {
        reviewedAt: timestamp,
        reviewedByPrincipalId: principal,
        reviewerRole: "Independent repository conformance reviewer",
      };
    case "source_snapshot":
      return { publishedByPrincipalId: principal, recordedAt: timestamp };
  }
}

const referenceIdPriority = [
  "assessmentId",
  "aggregateId",
  "resultId",
  "observationId",
  "qualificationReportId",
  "statusRecordId",
  "sourceReviewId",
  "sourceSnapshotId",
  "discoveryId",
  "evaluatorVersionId",
  "oracleVersionId",
  "fixtureSetVersionId",
  "criterionSetVersionId",
  "policyVersionId",
  "evaluationRunId",
] as const;

function bindKnownReferences(
  value: unknown,
  recordsById: ReadonlyMap<string, EvaluationRecord>,
): void {
  if (Array.isArray(value)) {
    for (const item of value) bindKnownReferences(item, recordsById);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  const candidate = value as MutableObject;
  const bindsDefinition = Object.hasOwn(candidate, "definitionSha256");
  for (const idField of referenceIdPriority) {
    if (!bindsDefinition) break;
    const id = candidate[idField];
    if (typeof id !== "string") continue;
    const record = recordsById.get(id);
    if (!record) continue;
    candidate.definitionSha256 = record.definitionSha256;
    break;
  }
  for (const child of Object.values(candidate)) bindKnownReferences(child, recordsById);
}

function recordString(record: EvaluationRecord, field: string): string {
  const value = (record as unknown as Record<string, unknown>)[field];
  if (typeof value !== "string") throw new TypeError(`Record omitted ${field}`);
  return value;
}

function exactReference(record: EvaluationRecord, idField: string): MutableObject {
  const id = (record as unknown as Record<string, unknown>)[idField];
  if (typeof id !== "string") throw new TypeError(`Record omitted ${idField}`);
  return { definitionSha256: record.definitionSha256, [idField]: id };
}

function materialize(
  kind: EvaluationRecordKind,
  body: MutableObject,
  recordScope: EvidenceScope,
): EvaluationRecord {
  return {
    ...body,
    ...receipt(kind),
    definitionSha256: digestEvaluationRecordDefinition(kind, recordScope, body),
    schemaVersion: "0.1",
    scope: recordScope,
  } as EvaluationRecord;
}

function definitionFromRecord(kind: EvaluationRecordKind, record: EvaluationRecord): MutableObject {
  const body = structuredClone(record) as unknown as MutableObject;
  for (const key of ["definitionSha256", "schemaVersion", "scope", ...Object.keys(receipt(kind))]) {
    delete body[key];
  }
  return body;
}

function buildHarness(namespace: string): EvaluationRepositoryTestHarness {
  const graphScope = scope(namespace);
  const records: EvaluationRepositoryFixtureRecord[] = [];
  const recordsById = new Map<string, EvaluationRecord>();

  function add(kind: EvaluationRecordKind, body: Record<string, unknown>): EvaluationRecord {
    bindKnownReferences(body, recordsById);
    const record = materialize(kind, body, graphScope);
    const fixture = { kind, record } as EvaluationRepositoryFixtureRecord;
    records.push(fixture);
    recordsById.set(evaluationRecordId(kind, record), record);
    return record;
  }

  const discoveryBody = template("discovery_record");
  discoveryBody.discoveryId = `dsc_${namespace}`;
  const discovery = add("discovery_record", discoveryBody);

  const sourceBody = template("source_snapshot");
  sourceBody.sourceSnapshotId = "src_primary";
  sourceBody.canonicalUri = `https://example.com/${namespace}/primary`;
  sourceBody.conflictsWith = [];
  sourceBody.supersedes = [];
  sourceBody.discovery = {
    candidateRank: 1,
    ...exactReference(discovery, "discoveryId"),
  };
  const source = add("source_snapshot", sourceBody);

  const reviewBody = template("source_review");
  reviewBody.sourceReviewId = "srv_primary";
  reviewBody.source = exactReference(source, "sourceSnapshotId");
  reviewBody.reviewedConflicts = [];
  reviewBody.criticalConflictStatus = "none";
  delete reviewBody.supersedesReview;
  const review = add("source_review", reviewBody);

  const criterionBody = template("criterion_set");
  criterionBody.sources = [
    {
      review: exactReference(review, "sourceReviewId"),
      source: exactReference(source, "sourceSnapshotId"),
    },
  ];
  delete criterionBody.predecessor;
  for (const criterion of array(criterionBody.criteria, "criteria")) {
    object(criterion, "criterion").counterevidence = [];
  }
  const criterion = add("criterion_set", criterionBody);

  const draftStatusBody = template("criterion_set_status");
  draftStatusBody.status = "draft";
  draftStatusBody.statusRecordId = "csr_draft";
  draftStatusBody.criterionSet = exactReference(criterion, "criterionSetVersionId");
  object(draftStatusBody.criterionSet, "criterion set reference").criterionSetId = recordString(
    criterion,
    "criterionSetId",
  );
  delete draftStatusBody.previousStatus;
  delete draftStatusBody.expiresAt;
  const draftStatus = add("criterion_set_status", draftStatusBody);

  const statusBody = template("criterion_set_status");
  statusBody.criterionSet = exactReference(criterion, "criterionSetVersionId");
  object(statusBody.criterionSet, "criterion set reference").criterionSetId = recordString(
    criterion,
    "criterionSetId",
  );
  statusBody.previousStatus = exactReference(draftStatus, "statusRecordId");
  const status = add("criterion_set_status", statusBody);

  const fixtureSetBody = template("qualification_fixture_set");
  delete fixtureSetBody.predecessor;
  const fixtureSet = add("qualification_fixture_set", fixtureSetBody);

  const oracleBody = template("oracle_spec");
  oracleBody.qualificationFixtureSet = {
    fixtureSetId: recordString(fixtureSet, "fixtureSetId"),
    ...exactReference(fixtureSet, "fixtureSetVersionId"),
  };
  const oracle = add("oracle_spec", oracleBody);

  const evaluatorBody = template("evaluator_spec");
  evaluatorBody.qualificationFixtureSet = {
    fixtureSetId: recordString(fixtureSet, "fixtureSetId"),
    ...exactReference(fixtureSet, "fixtureSetVersionId"),
  };
  evaluatorBody.oracles = [
    {
      oracleId: recordString(oracle, "oracleId"),
      ...exactReference(oracle, "oracleVersionId"),
    },
  ];
  const evaluator = add("evaluator_spec", evaluatorBody);

  const policy = add("aggregation_policy", template("aggregation_policy"));

  const evaluatorReportBody = template("qualification_report");
  evaluatorReportBody.qualificationReportId = "qlr_evaluator";
  evaluatorReportBody.fixtureSet = {
    fixtureSetId: recordString(fixtureSet, "fixtureSetId"),
    ...exactReference(fixtureSet, "fixtureSetVersionId"),
  };
  evaluatorReportBody.subject = {
    evaluator: {
      evaluatorId: recordString(evaluator, "evaluatorId"),
      ...exactReference(evaluator, "evaluatorVersionId"),
    },
    kind: "evaluator",
  };
  const evaluatorReport = add("qualification_report", evaluatorReportBody);

  const oracleReportBody = template("qualification_report");
  oracleReportBody.qualificationReportId = "qlr_oracle";
  oracleReportBody.fixtureSet = {
    fixtureSetId: recordString(fixtureSet, "fixtureSetId"),
    ...exactReference(fixtureSet, "fixtureSetVersionId"),
  };
  oracleReportBody.subject = {
    kind: "oracle",
    oracle: {
      oracleId: recordString(oracle, "oracleId"),
      ...exactReference(oracle, "oracleVersionId"),
    },
  };
  const oracleReport = add("qualification_report", oracleReportBody);

  const rejectionBody = template("evaluation_run_rejection");
  rejectionBody.sourceReviews = [exactReference(review, "sourceReviewId")];
  const rejection = add("evaluation_run_rejection", rejectionBody);

  function buildRun(evaluationRunId: string): EvaluationRecord {
    const body = template("evaluation_run");
    body.evaluationRunId = evaluationRunId;
    body.aggregationPolicy = {
      policyId: recordString(policy, "policyId"),
      ...exactReference(policy, "policyVersionId"),
    };
    body.sourceReviews = [exactReference(review, "sourceReviewId")];
    body.evaluatorQualification = exactReference(evaluatorReport, "qualificationReportId");
    body.oracleQualification = exactReference(oracleReport, "qualificationReportId");
    return add("evaluation_run", body);
  }

  const run0 = buildRun("evr_0");
  const run1 = buildRun("evr_1");

  function buildObservation(
    observationId: string,
    run: EvaluationRecord,
    verdict: "fail" | "pass",
  ): EvaluationRecord {
    const body = template("raw_observation");
    body.observationId = observationId;
    body.run = exactReference(run, "evaluationRunId");
    body.verdict = verdict;
    object(body.measurement, "measurement").value = verdict === "pass";
    return add("raw_observation", body);
  }

  const observation0 = buildObservation("obs_0", run0, "pass");
  const observation1 = buildObservation("obs_1", run1, "fail");

  function buildResult(
    resultId: string,
    run: EvaluationRecord,
    observation: EvaluationRecord,
    verdict: "fail" | "pass",
  ): EvaluationRecord {
    const body = template("evaluation_run_result");
    body.resultId = resultId;
    body.evaluationRunId = recordString(run, "evaluationRunId");
    body.observations = [exactReference(observation, "observationId")];
    body.verdict = verdict;
    return add("evaluation_run_result", body);
  }

  const result0 = buildResult("evs_0", run0, observation0, "pass");
  buildResult("evs_1", run1, observation1, "fail");

  const aggregate = add("evaluation_aggregate", template("evaluation_aggregate"));

  const assessmentBody = template("assessment");
  assessmentBody.sourceReviews = [exactReference(review, "sourceReviewId")];
  assessmentBody.qualifications = [
    exactReference(evaluatorReport, "qualificationReportId"),
    exactReference(oracleReport, "qualificationReportId"),
  ].sort((left, right) =>
    String(left.qualificationReportId).localeCompare(String(right.qualificationReportId)),
  );
  add("assessment", assessmentBody);

  void policy;
  void status;
  void rejection;
  void aggregate;

  const lineageProbe = records.find(({ kind }) => kind === "source_snapshot");
  if (!lineageProbe) throw new Error("Expected source snapshot lineage probe");

  const conflictBody = definitionFromRecord("discovery_record", discovery);
  conflictBody.query = "A conflicting immutable discovery query";
  const recordConflict = {
    kind: "discovery_record",
    record: materialize("discovery_record", conflictBody, graphScope),
  } as unknown as EvaluationRepositoryFixtureRecord;

  const otherScope = scope(namespace, "other");
  const resourceBody = definitionFromRecord("aggregation_policy", policy);
  resourceBody.policyVersionId = `agv_${namespace}_other`;
  const resourceConflict = {
    kind: "aggregation_policy",
    record: materialize("aggregation_policy", resourceBody, otherScope),
  } as unknown as EvaluationRepositoryFixtureRecord;

  const observationConflictBody = definitionFromRecord("raw_observation", observation0);
  observationConflictBody.observationId = `obs_${namespace}_duplicate_attempt`;
  const resultConflictBody = definitionFromRecord("evaluation_run_result", result0);
  resultConflictBody.resultId = `evs_${namespace}_duplicate_terminal`;
  const uniquenessConflicts = [
    {
      kind: "raw_observation",
      record: materialize("raw_observation", observationConflictBody, graphScope),
    },
    {
      kind: "evaluation_run_result",
      record: materialize("evaluation_run_result", resultConflictBody, graphScope),
    },
  ] as unknown as readonly EvaluationRepositoryFixtureRecord[];
  return {
    lineageProbe,
    otherScope,
    recordConflict,
    records,
    repository: new MemoryEvaluationRepository(),
    resourceConflict,
    scope: graphScope,
    uniquenessConflicts,
  };
}

describe("MemoryEvaluationRepository conformance", () => {
  for (const conformanceCase of evaluationRepositoryConformanceCases) {
    it(conformanceCase.name, async () => {
      await conformanceCase.run(buildHarness);
    });
  }
});
