import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  COMPARISON_EVIDENCE_SNAPSHOT_SCHEMA_VERSION,
  type ComparisonEvidenceSnapshotDefinition,
} from "./evaluation-comparison.js";
import {
  COMPARISON_RESULT_SCHEMA_VERSION,
  type ComparisonResultDefinition,
} from "./evaluation-comparison-result.js";
import {
  COMPARISON_EVIDENCE_SNAPSHOT_DEFINITION_DOMAIN,
  COMPARISON_RESULT_DEFINITION_DOMAIN,
  encodeComparisonEvidenceSnapshotDefinition,
  encodeComparisonResultDefinition,
  type ScopedEvaluationDefinition,
} from "./evaluation-definition-encoding.js";

interface Vector<Kind extends string, Definition> {
  readonly encodedByteLength: number;
  readonly input: ScopedEvaluationDefinition<Definition>;
  readonly kind: Kind;
  readonly name: string;
  readonly sha256: string;
}

interface VectorDocument<VectorType> {
  readonly format: string;
  readonly vectors: readonly VectorType[];
}

type SnapshotVector = Vector<"comparison_evidence_snapshot", ComparisonEvidenceSnapshotDefinition>;
type ResultVector = Vector<"comparison_result", ComparisonResultDefinition>;

const snapshotDocument = JSON.parse(
  readFileSync(
    new URL("../vectors/evaluation-comparison-snapshot-definition-v1.json", import.meta.url),
    "utf8",
  ),
) as VectorDocument<SnapshotVector>;

const resultDocument = JSON.parse(
  readFileSync(
    new URL("../vectors/evaluation-comparison-result-definition-v1.json", import.meta.url),
    "utf8",
  ),
) as VectorDocument<ResultVector>;

function firstVector<VectorType>(document: VectorDocument<VectorType>): VectorType {
  const value = document.vectors[0];
  if (!value) throw new Error("Expected a fixed comparison-state vector");
  return value;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("canonical comparison state encoding", () => {
  it("matches the fixed public snapshot and result vectors", () => {
    const snapshot = firstVector(snapshotDocument);
    const snapshotBytes = encodeComparisonEvidenceSnapshotDefinition(snapshot.input);
    expect(snapshotDocument.format).toBe("proofstack.evaluation-comparison-snapshot-definition.v1");
    expect(snapshot.kind).toBe("comparison_evidence_snapshot");
    expect(snapshotBytes.byteLength).toBe(snapshot.encodedByteLength);
    expect(sha256(snapshotBytes)).toBe(snapshot.sha256);

    const result = firstVector(resultDocument);
    const resultBytes = encodeComparisonResultDefinition(result.input);
    expect(resultDocument.format).toBe("proofstack.evaluation-comparison-result-definition.v1");
    expect(result.kind).toBe("comparison_result");
    expect(resultBytes.byteLength).toBe(result.encodedByteLength);
    expect(sha256(resultBytes)).toBe(result.sha256);
  });

  it("binds every snapshot lineage, evidence, provenance, and missingness field", () => {
    const vector = firstVector(snapshotDocument);
    const original = encodeComparisonEvidenceSnapshotDefinition(vector.input);
    const mutations: ((candidate: SnapshotVector["input"]) => void)[] = [
      (candidate) => {
        candidate.scope.tenantId = "tenant_other";
      },
      (candidate) => {
        candidate.definition.comparison.definitionSha256 = "d".repeat(64);
      },
      (candidate) => {
        candidate.definition.dataset.definitionSha256 = "e".repeat(64);
      },
      (candidate) => {
        const fixture = candidate.definition.fixtures[0];
        if (!fixture) throw new Error("Expected snapshot fixture");
        const artifact = fixture.artifacts[0];
        if (!artifact) throw new Error("Expected snapshot artifact");
        artifact.availability = "revoked";
      },
      (candidate) => {
        const fixture = candidate.definition.fixtures[0];
        const observation = fixture?.numericObservations[0];
        if (!observation) throw new Error("Expected snapshot observation");
        observation.value = "126.5";
      },
      (candidate) => {
        const trace = candidate.definition.fixtures[0]?.trace;
        const agentRun = trace?.eventKindStatuses[0];
        const guardrail = trace?.eventKindStatuses[1];
        if (!agentRun || !guardrail) throw new Error("Expected joint trace counts");
        agentRun.status = "error";
        guardrail.status = "ok";
      },
      (candidate) => {
        const fixture = candidate.definition.fixtures[0];
        const usage = fixture?.usage[1];
        if (usage?.value.status !== "unavailable") {
          throw new Error("Expected unavailable usage");
        }
        usage.value.unavailableReasons = ["source_unavailable"];
      },
      (candidate) => {
        const fixture = candidate.definition.fixtures[0];
        if (!fixture) throw new Error("Expected snapshot fixture");
        fixture.artifacts = [
          {
            artifact: {
              artifactId: "artifact_missing",
              classification: "internal",
              mediaType: "application/json",
              sha256: "f".repeat(64),
              sizeBytes: 64,
            },
            availability: "unavailable",
          },
          ...fixture.artifacts,
        ];
        candidate.definition.knownLimitations = ["Changed bounded limitation"];
        candidate.definition.omissions = [
          {
            artifactId: "artifact_missing",
            fixtureId: "fixture_login",
            reason: "artifact_unavailable",
            sourceKind: "artifact",
          },
        ];
      },
      (candidate) => {
        candidate.definition.role = "candidate";
        candidate.definition.snapshotId = "snapshot_candidate";
        candidate.definition.sourceCutoff = "2026-09-02T01:00:02.000Z";
      },
    ];
    for (const mutate of mutations) {
      const changed = structuredClone(vector.input);
      mutate(changed);
      expect(encodeComparisonEvidenceSnapshotDefinition(changed)).not.toEqual(original);
    }
  });

  it("binds exact result pairing, deltas, denominators, transitions, and artifacts", () => {
    const vector = firstVector(resultDocument);
    const original = encodeComparisonResultDefinition(vector.input);
    const mutations: ((candidate: ResultVector["input"]) => void)[] = [
      (candidate) => {
        candidate.scope.projectId = "project_other";
      },
      (candidate) => {
        candidate.definition.candidateSnapshot.definitionSha256 = "9".repeat(64);
      },
      (candidate) => {
        const pairedCase = candidate.definition.cases[0];
        if (pairedCase?.state !== "paired") throw new Error("Expected paired case");
        pairedCase.candidate.definitionSha256 = "a".repeat(64);
      },
      (candidate) => {
        const metric = candidate.definition.metricResults[0];
        if (metric?.value.status !== "available") throw new Error("Expected metric");
        if (
          metric.value.candidate.representation !== "decimal" ||
          metric.value.delta.representation !== "decimal"
        ) {
          throw new Error("Expected decimal metric values");
        }
        metric.value.candidate.value = "109.5";
        metric.value.delta.value = "-16";
      },
      (candidate) => {
        const metric = candidate.definition.metricResults[0];
        if (metric?.value.status !== "available") throw new Error("Expected metric");
        metric.unit = "seconds";
        metric.value.baseline.unit = "seconds";
        metric.value.candidate.unit = "seconds";
        metric.value.delta.unit = "seconds";
      },
      (candidate) => {
        const metric = candidate.definition.metricResults[0];
        if (!metric) throw new Error("Expected metric");
        metric.samples.baselineInvalidCount = 1;
        metric.samples.baselineObservedCount = 0;
        metric.samples.candidateInvalidCount = 1;
        metric.samples.candidateObservedCount = 0;
        metric.samples.pairedInvalidCount = 1;
        metric.samples.pairedObservedCount = 0;
        metric.value = { reasons: ["invalid_observations"], status: "unavailable" };
      },
      (candidate) => {
        const metric = candidate.definition.metricResults[1];
        if (metric?.kind !== "replay_usage" || !metric.usageProvenance) {
          throw new Error("Expected replay usage provenance");
        }
        metric.usageProvenance.candidate.observedSources = ["estimated"];
      },
      (candidate) => {
        const safety = candidate.definition.safetyCounts[0];
        if (!safety) throw new Error("Expected safety count");
        safety.counts.candidate = 3;
        safety.counts.delta = 2;
      },
      (candidate) => {
        const artifact = candidate.definition.artifactChanges[0]?.candidate;
        if (!artifact) throw new Error("Expected candidate artifact");
        artifact.sha256 = "b".repeat(64);
      },
      (candidate) => {
        candidate.definition.comparability = {
          reasons: ["unsupported_statistical_assumptions"],
          status: "partially_comparable",
        };
        candidate.definition.knownLimitations = ["Changed statistical limitation"];
      },
      (candidate) => {
        candidate.definition.latestSourceCutoff = "2026-09-02T02:00:01.000Z";
      },
    ];
    for (const mutate of mutations) {
      const changed = structuredClone(vector.input);
      mutate(changed);
      expect(encodeComparisonResultDefinition(changed)).not.toEqual(original);
    }
  });

  it("normalizes property order and rejects server provenance or release semantics", () => {
    const snapshot = firstVector(snapshotDocument).input;
    const reorderedSnapshot = {
      definition: Object.fromEntries(Object.entries(snapshot.definition).reverse()),
      scope: Object.fromEntries(Object.entries(snapshot.scope).reverse()),
    } as unknown as typeof snapshot;
    expect(encodeComparisonEvidenceSnapshotDefinition(reorderedSnapshot)).toEqual(
      encodeComparisonEvidenceSnapshotDefinition(snapshot),
    );

    const result = firstVector(resultDocument).input;
    const reorderedResult = {
      definition: Object.fromEntries(Object.entries(result.definition).reverse()),
      scope: Object.fromEntries(Object.entries(result.scope).reverse()),
    } as unknown as typeof result;
    expect(encodeComparisonResultDefinition(reorderedResult)).toEqual(
      encodeComparisonResultDefinition(result),
    );

    expect(() =>
      encodeComparisonEvidenceSnapshotDefinition({
        ...snapshot,
        definition: { ...snapshot.definition, createdAt: "2026-09-02T01:00:02.000Z" },
      } as never),
    ).toThrow();
    for (const forbidden of [
      { approval: "approved" },
      { policyThreshold: "0.95" },
      { releaseDecision: "release" },
    ]) {
      expect(() =>
        encodeComparisonResultDefinition({
          ...result,
          definition: { ...result.definition, ...forbidden },
        } as never),
      ).toThrow();
    }
  });

  it("binds unique domains and schema versions", () => {
    const snapshotText = Buffer.from(
      encodeComparisonEvidenceSnapshotDefinition(firstVector(snapshotDocument).input),
    ).toString("utf8");
    const resultText = Buffer.from(
      encodeComparisonResultDefinition(firstVector(resultDocument).input),
    ).toString("utf8");
    expect(snapshotText).toContain(COMPARISON_EVIDENCE_SNAPSHOT_DEFINITION_DOMAIN);
    expect(snapshotText).toContain(
      `"schemaVersion":"${COMPARISON_EVIDENCE_SNAPSHOT_SCHEMA_VERSION}"`,
    );
    expect(resultText).toContain(COMPARISON_RESULT_DEFINITION_DOMAIN);
    expect(resultText).toContain(`"schemaVersion":"${COMPARISON_RESULT_SCHEMA_VERSION}"`);
  });
});
