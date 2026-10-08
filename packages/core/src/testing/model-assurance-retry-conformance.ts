import assert from "node:assert/strict";
import {
  modelAssuranceRecordId,
  validateModelAssuranceRecord,
} from "../evaluation/model-assurance-record-validation.js";
import type {
  ModelAssuranceRecordKind,
  ModelAssuranceRepository,
} from "../evaluation/model-assurance-repository.js";
import type { ModelAssuranceRepositoryFixtureRecord } from "./model-assurance-repository-fixtures.js";

export interface ModelAssuranceRetryTestHarness {
  readonly repository: ModelAssuranceRepository;
  readonly records: readonly ModelAssuranceRepositoryFixtureRecord[];
}

const kinds: readonly ModelAssuranceRecordKind[] = [
  "blinded_evaluation_plan",
  "blinded_evaluation_result",
  "calibration_report",
  "human_review_protocol",
  "human_review_record",
  "human_reviewer_independence",
  "independence_declaration",
  "independent_critique",
  "model_assisted_evaluator",
  "model_assurance_assessment",
  "model_evaluator_profile",
  "model_qualification_report",
  "model_qualification_suite",
];

/** Both adapters must retain original immutable receipts on a same-definition retry. */
export const modelAssuranceRetryConformanceCases = kinds.map((kind) => ({
  name: `preserves original ${kind} receipts on a same-definition retry`,
  run: async (harness: ModelAssuranceRetryTestHarness): Promise<void> => {
    const fixture = harness.records.find((value) => value.kind === kind);
    assert.ok(fixture, `Missing ${kind} retry fixture`);
    const candidate = structuredClone(fixture.record);
    if ("publishedAt" in candidate) {
      candidate.publishedAt = new Date(Date.parse(candidate.publishedAt) + 1000).toISOString();
      candidate.publishedByPrincipalId = "usr_retry_publisher";
    } else {
      candidate.recordedAt = new Date(Date.parse(candidate.recordedAt) + 1000).toISOString();
      if ("recordedByPrincipalId" in candidate)
        candidate.recordedByPrincipalId = "wrk_retry_recorder";
    }
    const verified = validateModelAssuranceRecord(kind, candidate);
    assert.equal(verified.definitionSha256, fixture.record.definitionSha256);
    assert.notDeepEqual(verified, fixture.record);
    const before = structuredClone(candidate);
    const retry = await harness.repository.publish(kind, candidate);
    assert.equal(retry.created, false);
    assert.deepEqual(retry.record, fixture.record);
    assert.notEqual(retry.record, fixture.record);
    assert.deepEqual(candidate, before);
    assert.deepEqual(
      await harness.repository.find(
        fixture.record.scope,
        kind,
        modelAssuranceRecordId(kind, fixture.record),
      ),
      fixture.record,
    );
  },
}));
