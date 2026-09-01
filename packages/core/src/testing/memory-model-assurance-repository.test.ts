import { readFileSync } from "node:fs";
import type {
  BlindedEvaluationResult,
  EvidenceScope,
  HumanReviewerIndependence,
  ModelEvaluatorProfile,
} from "@proofstack/contracts";
import { describe, expect, it } from "vitest";
import { digestModelAssuranceRecordDefinition } from "../evaluation/model-assurance-record-validation.js";
import {
  InvalidModelAssuranceRecordInputError,
  ModelAssuranceLineageError,
  ModelAssuranceRecordConflictError,
  type ModelAssuranceRecord,
  type ModelAssuranceRecordKind,
} from "../evaluation/model-assurance-repository.js";
import { MemoryModelAssuranceRepository } from "./memory-model-assurance-repository.js";

interface PublicVector {
  readonly input: { readonly definition: Record<string, unknown>; readonly scope: EvidenceScope };
  readonly sha256: string;
}

function vector(filename: string): PublicVector {
  const document = JSON.parse(
    readFileSync(new URL(`../../../contracts/vectors/${filename}`, import.meta.url), "utf8"),
  ) as { readonly vectors: readonly PublicVector[] };
  const value = document.vectors[0];
  if (!value) throw new Error(`Expected vector ${filename}`);
  return value;
}

function profile(): ModelEvaluatorProfile {
  const value = vector("evaluation-model-assurance-definition-v1.json");
  return {
    ...structuredClone(value.input.definition),
    definitionSha256: value.sha256,
    publishedAt: "2026-09-01T23:59:59.000Z",
    publishedByPrincipalId: "usr_model_profile_publisher",
    schemaVersion: "0.1",
    scope: structuredClone(value.input.scope),
  } as ModelEvaluatorProfile;
}

function reviewerIndependence(): HumanReviewerIndependence {
  const value = vector("evaluation-human-reviewer-independence-definition-v1.json");
  return {
    ...structuredClone(value.input.definition),
    definitionSha256: value.sha256,
    recordedAt: "2026-09-02T02:30:01.000Z",
    schemaVersion: "0.1",
    scope: structuredClone(value.input.scope),
  } as HumanReviewerIndependence;
}

function blindedResult(): BlindedEvaluationResult {
  const value = vector("evaluation-blinded-result-definition-v1.json");
  return {
    ...structuredClone(value.input.definition),
    definitionSha256: value.sha256,
    recordedAt: "2026-09-02T00:45:02.000Z",
    recordedByPrincipalId: "usr_blind_result_recorder",
    schemaVersion: "0.1",
    scope: structuredClone(value.input.scope),
  } as BlindedEvaluationResult;
}

const receiptKeys: Readonly<Record<ModelAssuranceRecordKind, readonly string[]>> = {
  blinded_evaluation_plan: [
    "definitionSha256",
    "publishedAt",
    "publishedByPrincipalId",
    "schemaVersion",
    "scope",
  ],
  blinded_evaluation_result: [
    "definitionSha256",
    "recordedAt",
    "recordedByPrincipalId",
    "schemaVersion",
    "scope",
  ],
  calibration_report: ["definitionSha256", "recordedAt", "schemaVersion", "scope"],
  human_review_protocol: [
    "definitionSha256",
    "publishedAt",
    "publishedByPrincipalId",
    "schemaVersion",
    "scope",
  ],
  human_review_record: ["definitionSha256", "recordedAt", "schemaVersion", "scope"],
  human_reviewer_independence: ["definitionSha256", "recordedAt", "schemaVersion", "scope"],
  independence_declaration: ["definitionSha256", "recordedAt", "schemaVersion", "scope"],
  independent_critique: [
    "definitionSha256",
    "recordedAt",
    "recordedByPrincipalId",
    "schemaVersion",
    "scope",
  ],
  model_assisted_evaluator: [
    "definitionSha256",
    "publishedAt",
    "publishedByPrincipalId",
    "schemaVersion",
    "scope",
  ],
  model_assurance_assessment: ["definitionSha256", "recordedAt", "schemaVersion", "scope"],
  model_evaluator_profile: [
    "definitionSha256",
    "publishedAt",
    "publishedByPrincipalId",
    "schemaVersion",
    "scope",
  ],
  model_qualification_report: ["definitionSha256", "recordedAt", "schemaVersion", "scope"],
  model_qualification_suite: [
    "definitionSha256",
    "publishedAt",
    "publishedByPrincipalId",
    "schemaVersion",
    "scope",
  ],
};

function redigest(kind: ModelAssuranceRecordKind, record: ModelAssuranceRecord): void {
  const definition = structuredClone(record) as unknown as Record<string, unknown>;
  for (const key of receiptKeys[kind]) delete definition[key];
  record.definitionSha256 = digestModelAssuranceRecordDefinition(kind, record.scope, definition);
}

describe("MemoryModelAssuranceRepository", () => {
  it("owns values, returns exact-scope reads, and preserves idempotent originals", async () => {
    const repository = new MemoryModelAssuranceRepository();
    const candidate = profile();
    const originalEnvironment = candidate.scope.environmentId;
    const created = await repository.publish("model_evaluator_profile", candidate);
    expect(created.created).toBe(true);
    candidate.scope.environmentId = "env_mutated_after_publish";
    expect(created.record.scope.environmentId).toBe(originalEnvironment);

    const retry = await repository.publish("model_evaluator_profile", created.record);
    expect(retry).toEqual({ created: false, record: created.record });
    retry.record.scope.environmentId = "env_mutated_after_read";
    await expect(
      repository.find(
        created.record.scope,
        "model_evaluator_profile",
        created.record.modelProfileVersionId,
      ),
    ).resolves.toEqual(created.record);

    const otherScope = { ...created.record.scope, environmentId: "env_other" };
    await expect(
      repository.find(otherScope, "model_evaluator_profile", created.record.modelProfileVersionId),
    ).resolves.toBeNull();
  });

  it("rejects a different immutable meaning for the same tenant kind and id", async () => {
    const repository = new MemoryModelAssuranceRepository();
    const first = profile();
    await repository.publish("model_evaluator_profile", first);
    const conflict = structuredClone(first);
    conflict.validUntil = "2026-11-30T00:00:00.000Z";
    redigest("model_evaluator_profile", conflict);
    await expect(repository.publish("model_evaluator_profile", conflict)).rejects.toBeInstanceOf(
      ModelAssuranceRecordConflictError,
    );
  });

  it("enforces exact predecessor lineage before making a record visible", async () => {
    const repository = new MemoryModelAssuranceRepository();
    const predecessor = reviewerIndependence();
    await repository.publish("human_reviewer_independence", predecessor);

    const successor = structuredClone(predecessor);
    successor.declarationId = "hri_reviewer_v2";
    successor.predecessor = {
      declarationId: predecessor.declarationId,
      definitionSha256: predecessor.definitionSha256,
    };
    successor.reviewedAt = "2026-09-03T02:30:00.000Z";
    successor.validFrom = successor.reviewedAt;
    successor.validUntil = "2026-12-02T00:00:00.000Z";
    successor.recordedAt = "2026-09-03T02:30:01.000Z";
    redigest("human_reviewer_independence", successor);
    await expect(
      repository.publish("human_reviewer_independence", successor),
    ).resolves.toMatchObject({
      created: true,
    });

    const broken = structuredClone(successor);
    broken.declarationId = "hri_reviewer_v3";
    broken.predecessor = {
      declarationId: predecessor.declarationId,
      definitionSha256: "f".repeat(64),
    };
    redigest("human_reviewer_independence", broken);
    await expect(repository.publish("human_reviewer_independence", broken)).rejects.toBeInstanceOf(
      ModelAssuranceLineageError,
    );
    await expect(
      repository.find(broken.scope, "human_reviewer_independence", broken.declarationId),
    ).resolves.toBeNull();
  });

  it("rejects missing plan lineage and forged canonical digests", async () => {
    const repository = new MemoryModelAssuranceRepository();
    const result = blindedResult();
    await expect(repository.publish("blinded_evaluation_result", result)).rejects.toBeInstanceOf(
      ModelAssuranceLineageError,
    );
    await expect(
      repository.find(result.scope, "blinded_evaluation_result", result.resultId),
    ).resolves.toBeNull();

    const forged = profile();
    forged.definitionSha256 = "0".repeat(64);
    await expect(repository.publish("model_evaluator_profile", forged)).rejects.toBeInstanceOf(
      InvalidModelAssuranceRecordInputError,
    );
  });
});
