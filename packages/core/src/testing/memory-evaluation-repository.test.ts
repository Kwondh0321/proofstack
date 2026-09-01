import { readFileSync } from "node:fs";
import type {
  DiscoveryRecord,
  DiscoveryRecordDefinition,
  EvaluationAggregationPolicy,
  EvaluationAggregationPolicyDefinition,
  EvidenceScope,
  SourceReviewDefinition,
  SourceReviewRecord,
  SourceSnapshot,
  SourceSnapshotDefinition,
} from "@proofstack/contracts";
import { describe, expect, it } from "vitest";
import {
  EvaluationLineageError,
  EvaluationRecordConflictError,
  EvaluationResourceConflictError,
  InvalidEvaluationRecordInputError,
} from "../evaluation/evaluation-repository-errors.js";
import { digestEvaluationRecordDefinition } from "../evaluation/evaluation-record-validation.js";
import { MemoryEvaluationRepository } from "./memory-evaluation-repository.js";

interface StoredVector {
  readonly input: { readonly definition: unknown };
  readonly kind: string;
}

function vectors(file: string): readonly StoredVector[] {
  return (
    JSON.parse(
      readFileSync(new URL(`../../../contracts/vectors/${file}`, import.meta.url), "utf8"),
    ) as { readonly vectors: readonly StoredVector[] }
  ).vectors;
}

const sourceVectors = vectors("evaluation-source-definition-v1.json");
const assessmentVectors = vectors("evaluation-assessment-definition-v1.json");

function definition<Definition>(kind: string, available: readonly StoredVector[]): Definition {
  const vector = available.find((candidate) => candidate.kind === kind);
  if (!vector) throw new Error(`Missing ${kind} vector`);
  return structuredClone(vector.input.definition) as Definition;
}

function scope(namespace: string, suffix = "primary"): EvidenceScope {
  return {
    environmentId: `env_${namespace}_${suffix}`,
    projectId: `prj_${namespace}_${suffix}`,
    tenantId: `ten_${namespace}`,
  };
}

function discoveryRecord(namespace: string, recordScope: EvidenceScope): DiscoveryRecord {
  const body = definition<DiscoveryRecordDefinition>("discovery_record", sourceVectors);
  body.discoveryId = `dsc_${namespace}`;
  return {
    ...body,
    definitionSha256: digestEvaluationRecordDefinition("discovery_record", recordScope, body),
    recordedAt: "2026-09-02T00:00:01.000Z",
    recordedByPrincipalId: `usr_${namespace}`,
    schemaVersion: "0.1",
    scope: recordScope,
  };
}

function sourceSnapshot(
  namespace: string,
  recordScope: EvidenceScope,
  discovery: DiscoveryRecord,
): SourceSnapshot {
  const body = definition<SourceSnapshotDefinition>("source_snapshot", sourceVectors);
  body.sourceSnapshotId = `src_${namespace}`;
  body.canonicalUri = `https://example.com/${namespace}`;
  body.conflictsWith = [];
  body.supersedes = [];
  body.discovery = {
    candidateRank: 1,
    definitionSha256: discovery.definitionSha256,
    discoveryId: discovery.discoveryId,
  };
  return {
    ...body,
    definitionSha256: digestEvaluationRecordDefinition("source_snapshot", recordScope, body),
    publishedByPrincipalId: `usr_${namespace}`,
    recordedAt: "2026-09-02T00:00:02.000Z",
    schemaVersion: "0.1",
    scope: recordScope,
  };
}

function sourceReview(
  namespace: string,
  recordScope: EvidenceScope,
  source: SourceSnapshot,
): SourceReviewRecord {
  const body = definition<SourceReviewDefinition>("source_review", sourceVectors);
  body.sourceReviewId = `srv_${namespace}`;
  body.source = {
    definitionSha256: source.definitionSha256,
    sourceSnapshotId: source.sourceSnapshotId,
  };
  body.reviewedConflicts = [];
  body.criticalConflictStatus = "none";
  return {
    ...body,
    definitionSha256: digestEvaluationRecordDefinition("source_review", recordScope, body),
    reviewedAt: "2026-09-02T00:00:03.000Z",
    reviewedByPrincipalId: `usr_${namespace}`,
    reviewerRole: "Repository conformance reviewer",
    schemaVersion: "0.1",
    scope: recordScope,
  };
}

function aggregationPolicy(
  namespace: string,
  recordScope: EvidenceScope,
  version = "v1",
): EvaluationAggregationPolicy {
  const body = definition<EvaluationAggregationPolicyDefinition>(
    "aggregation_policy",
    assessmentVectors,
  );
  body.policyId = `agp_${namespace}`;
  body.policyVersionId = `agv_${namespace}_${version}`;
  return {
    ...body,
    definitionSha256: digestEvaluationRecordDefinition("aggregation_policy", recordScope, body),
    publishedAt: "2026-09-02T00:00:04.000Z",
    publishedByPrincipalId: `usr_${namespace}`,
    schemaVersion: "0.1",
    scope: recordScope,
  };
}

describe("MemoryEvaluationRepository", () => {
  it("publishes source lineage atomically and owns values across retries and reads", async () => {
    const repository = new MemoryEvaluationRepository();
    const expectedScope = scope("source_graph");
    const discovery = discoveryRecord("source_graph", expectedScope);
    const source = sourceSnapshot("source_graph", expectedScope, discovery);
    const review = sourceReview("source_graph", expectedScope, source);

    await expect(repository.publishSourceSnapshot(source)).rejects.toBeInstanceOf(
      EvaluationLineageError,
    );
    expect(await repository.findSourceSnapshot(expectedScope, source.sourceSnapshotId)).toBeNull();

    expect(await repository.publishDiscoveryRecord(discovery)).toEqual({
      created: true,
      record: discovery,
    });
    await repository.publishSourceSnapshot(source);
    await repository.publishSourceReview(review);

    discovery.query = "mutated after write";
    const firstRead = await repository.findDiscoveryRecord(expectedScope, discovery.discoveryId);
    expect(firstRead?.query).not.toBe("mutated after write");
    if (!firstRead) throw new Error("Expected discovery record");
    firstRead.query = "mutated after read";
    expect(
      (await repository.findDiscoveryRecord(expectedScope, discovery.discoveryId))?.query,
    ).not.toBe("mutated after read");

    const retry = structuredClone(
      await repository.findSourceReview(expectedScope, review.sourceReviewId),
    );
    if (!retry) throw new Error("Expected source review");
    retry.reviewedAt = "2026-09-02T00:00:09.000Z";
    expect(await repository.publishSourceReview(retry)).toMatchObject({
      created: false,
      record: { reviewedAt: "2026-09-02T00:00:03.000Z" },
    });
  });

  it("hides exact-scope reads and rejects semantic, digest, and resource rebinding", async () => {
    const repository = new MemoryEvaluationRepository();
    const primary = scope("isolation");
    const otherScope = scope("isolation", "other");
    const discovery = discoveryRecord("isolation", primary);
    await repository.publishDiscoveryRecord(discovery);

    expect(await repository.findDiscoveryRecord(otherScope, discovery.discoveryId)).toBeNull();

    const conflictBody = definition<DiscoveryRecordDefinition>("discovery_record", sourceVectors);
    conflictBody.discoveryId = discovery.discoveryId;
    conflictBody.query = "different immutable query";
    const conflict: DiscoveryRecord = {
      ...conflictBody,
      definitionSha256: digestEvaluationRecordDefinition("discovery_record", primary, conflictBody),
      recordedAt: "2026-09-02T00:00:05.000Z",
      recordedByPrincipalId: "usr_isolation",
      schemaVersion: "0.1",
      scope: primary,
    };
    await expect(repository.publishDiscoveryRecord(conflict)).rejects.toBeInstanceOf(
      EvaluationRecordConflictError,
    );

    await expect(
      repository.publishDiscoveryRecord({
        ...conflict,
        discoveryId: "dsc_bad",
        definitionSha256: "0".repeat(64),
      }),
    ).rejects.toBeInstanceOf(InvalidEvaluationRecordInputError);

    await repository.publishAggregationPolicy(aggregationPolicy("isolation", primary));
    await expect(
      repository.publishAggregationPolicy(aggregationPolicy("isolation", otherScope, "v2")),
    ).rejects.toBeInstanceOf(EvaluationResourceConflictError);
    expect(await repository.findAggregationPolicy(otherScope, "agv_isolation_v2")).toBeNull();
  });
});
