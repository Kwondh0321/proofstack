import { readFileSync } from "node:fs";
import {
  COMPARISON_DEFINITION_SCHEMA_VERSION,
  COMPARISON_EVIDENCE_SNAPSHOT_SCHEMA_VERSION,
  COMPARISON_RESULT_SCHEMA_VERSION,
  type ComparisonDefinition,
  type ComparisonDefinitionInput,
  type ComparisonDefinitionReference,
  type ComparisonEvidenceSnapshot,
  type ComparisonEvidenceSnapshotDefinition,
  type ComparisonEvidenceSnapshotReference,
  type ComparisonResult,
  type ComparisonResultDefinition,
  type EvidenceScope,
} from "@proofstack/contracts";
import { describe, expect, it } from "vitest";
import { digestComparisonRecordDefinition } from "../evaluation/comparison-record-validation.js";
import {
  ComparisonLineageError,
  ComparisonRecordConflictError,
  ComparisonResourceConflictError,
  InvalidComparisonRecordInputError,
} from "../evaluation/comparison-repository-errors.js";
import { MemoryComparisonRepository } from "./memory-comparison-repository.js";

interface Vector<Definition> {
  readonly input: {
    readonly definition: Definition;
    readonly scope: EvidenceScope;
  };
}

function vector<Definition>(filename: string): Vector<Definition> {
  const document = JSON.parse(
    readFileSync(new URL(`../../../contracts/vectors/${filename}`, import.meta.url), "utf8"),
  ) as { readonly vectors: readonly Vector<Definition>[] };
  const first = document.vectors[0];
  if (!first) throw new Error(`Expected a vector in ${filename}`);
  return first;
}

const definitionVector = vector<ComparisonDefinitionInput>(
  "evaluation-comparison-definition-v1.json",
);
const snapshotVector = vector<ComparisonEvidenceSnapshotDefinition>(
  "evaluation-comparison-snapshot-definition-v1.json",
);
const resultVector = vector<ComparisonResultDefinition>(
  "evaluation-comparison-result-definition-v1.json",
);

function scope(namespace: string, suffix = "primary"): EvidenceScope {
  return {
    environmentId: `env_${namespace}_${suffix}`,
    projectId: `prj_${namespace}_${suffix}`,
    tenantId: `ten_${namespace}`,
  };
}

function definition(
  namespace: string,
  recordScope: EvidenceScope,
  options: {
    readonly comparisonId?: string;
    readonly description?: string;
    readonly predecessor?: ComparisonDefinition["predecessor"];
    readonly version?: string;
  } = {},
): ComparisonDefinition {
  const body = {
    ...structuredClone(definitionVector.input.definition),
    comparisonId: options.comparisonId ?? `comparison_${namespace}`,
    comparisonVersionId: `comparison_${namespace}_${options.version ?? "v1"}`,
    description: options.description ?? "Repository conformance comparison",
    ...(options.predecessor ? { predecessor: options.predecessor } : {}),
  } satisfies ComparisonDefinitionInput;
  return {
    ...body,
    createdAt: "2026-09-02T03:00:00.000Z",
    createdByPrincipalId: `principal_${namespace}`,
    definitionSha256: digestComparisonRecordDefinition("comparison_definition", recordScope, body),
    schemaVersion: COMPARISON_DEFINITION_SCHEMA_VERSION,
    scope: structuredClone(recordScope),
  };
}

function reference(value: ComparisonDefinition): ComparisonDefinitionReference {
  return {
    comparisonId: value.comparisonId,
    comparisonVersionId: value.comparisonVersionId,
    definitionSha256: value.definitionSha256,
  };
}

function snapshot(
  namespace: string,
  recordScope: EvidenceScope,
  source: ComparisonDefinition,
  role: "baseline" | "candidate",
): ComparisonEvidenceSnapshot {
  const body = {
    ...structuredClone(snapshotVector.input.definition),
    comparison: reference(source),
    role,
    snapshotId: `snapshot_${namespace}_${role}`,
  } satisfies ComparisonEvidenceSnapshotDefinition;
  return {
    ...body,
    createdAt: "2026-09-02T03:00:00.000Z",
    createdByPrincipalId: `principal_${namespace}`,
    definitionSha256: digestComparisonRecordDefinition(
      "comparison_evidence_snapshot",
      recordScope,
      body,
    ),
    schemaVersion: COMPARISON_EVIDENCE_SNAPSHOT_SCHEMA_VERSION,
    scope: structuredClone(recordScope),
  };
}

function snapshotReference(value: ComparisonEvidenceSnapshot): ComparisonEvidenceSnapshotReference {
  return {
    definitionSha256: value.definitionSha256,
    role: value.role,
    snapshotId: value.snapshotId,
  };
}

function result(
  namespace: string,
  recordScope: EvidenceScope,
  source: ComparisonDefinition,
  baseline: ComparisonEvidenceSnapshot,
  candidate: ComparisonEvidenceSnapshot,
): ComparisonResult {
  const body = {
    ...structuredClone(resultVector.input.definition),
    baselineSnapshot: snapshotReference(baseline),
    candidateSnapshot: snapshotReference(candidate),
    comparison: reference(source),
    resultId: `result_${namespace}`,
  } satisfies ComparisonResultDefinition;
  return {
    ...body,
    createdAt: "2026-09-02T03:00:00.000Z",
    createdByPrincipalId: `principal_${namespace}`,
    definitionSha256: digestComparisonRecordDefinition("comparison_result", recordScope, body),
    schemaVersion: COMPARISON_RESULT_SCHEMA_VERSION,
    scope: structuredClone(recordScope),
  };
}

describe("MemoryComparisonRepository", () => {
  it("owns one exact graph and preserves original records across retries and reads", async () => {
    const repository = new MemoryComparisonRepository();
    const recordScope = scope("complete_graph");
    const comparison = definition("complete_graph", recordScope);
    const baseline = snapshot("complete_graph", recordScope, comparison, "baseline");
    const candidate = snapshot("complete_graph", recordScope, comparison, "candidate");
    const comparisonResult = result("complete_graph", recordScope, comparison, baseline, candidate);

    await expect(repository.publishComparisonDefinition(comparison)).resolves.toEqual({
      created: true,
      record: comparison,
    });
    await repository.publishComparisonEvidenceSnapshot(baseline);
    await repository.publishComparisonEvidenceSnapshot(candidate);
    await repository.publishComparisonResult(comparisonResult);

    comparison.scope.environmentId = "env_mutated_after_publish";
    const stored = await repository.findComparisonDefinition(
      recordScope,
      comparison.comparisonVersionId,
    );
    expect(stored?.scope).toEqual(recordScope);

    const retry = await repository.publishComparisonResult(comparisonResult);
    expect(retry).toEqual({ created: false, record: comparisonResult });
    retry.record.scope.environmentId = "env_mutated_after_retry";
    await expect(
      repository.findComparisonResult(recordScope, comparisonResult.resultId),
    ).resolves.toEqual(comparisonResult);
    await expect(
      repository.findComparisonResult(
        { ...recordScope, environmentId: "env_inaccessible" },
        comparisonResult.resultId,
      ),
    ).resolves.toBeNull();
  });

  it("rejects invalid records and unavailable exact lineage before visibility", async () => {
    const repository = new MemoryComparisonRepository();
    const recordScope = scope("invalid_lineage");
    const comparison = definition("invalid_lineage", recordScope);
    const baseline = snapshot("invalid_lineage", recordScope, comparison, "baseline");

    await expect(repository.publishComparisonEvidenceSnapshot(baseline)).rejects.toBeInstanceOf(
      ComparisonLineageError,
    );
    await expect(
      repository.findComparisonEvidenceSnapshot(recordScope, baseline.snapshotId),
    ).resolves.toBeNull();

    const forged = { ...comparison, definitionSha256: "0".repeat(64) };
    await expect(repository.publishComparisonDefinition(forged)).rejects.toBeInstanceOf(
      InvalidComparisonRecordInputError,
    );
    await expect(
      repository.findComparisonDefinition(recordScope, comparison.comparisonVersionId),
    ).resolves.toBeNull();
  });

  it("rejects semantic, scope-resource, and predecessor rebinding atomically", async () => {
    const repository = new MemoryComparisonRepository();
    const recordScope = scope("conflicts");
    const first = definition("conflicts", recordScope);
    await repository.publishComparisonDefinition(first);

    const semanticConflict = definition("conflicts", recordScope, {
      description: "Different immutable comparison semantics",
    });
    await expect(repository.publishComparisonDefinition(semanticConflict)).rejects.toBeInstanceOf(
      ComparisonRecordConflictError,
    );

    const otherScope = { ...recordScope, environmentId: "env_conflicts_other" };
    const resourceConflict = definition("conflicts_other", otherScope, {
      comparisonId: first.comparisonId,
    });
    await expect(repository.publishComparisonDefinition(resourceConflict)).rejects.toBeInstanceOf(
      ComparisonResourceConflictError,
    );
    await expect(
      repository.findComparisonDefinition(otherScope, resourceConflict.comparisonVersionId),
    ).resolves.toBeNull();

    const missingPredecessor = definition("conflicts", recordScope, {
      predecessor: {
        comparisonVersionId: "comparison_conflicts_missing",
        definitionSha256: "f".repeat(64),
      },
      version: "v2",
    });
    await expect(repository.publishComparisonDefinition(missingPredecessor)).rejects.toBeInstanceOf(
      ComparisonLineageError,
    );
  });

  it("rejects cross-comparison predecessor and result graphs despite valid exact references", async () => {
    const repository = new MemoryComparisonRepository();
    const recordScope = scope("semantic_lineage");
    const first = definition("semantic_lineage", recordScope);
    const other = definition("other_lineage", recordScope);
    await repository.publishComparisonDefinition(first);
    await repository.publishComparisonDefinition(other);

    const crossResourceSuccessor = definition("semantic_lineage", recordScope, {
      predecessor: {
        comparisonVersionId: other.comparisonVersionId,
        definitionSha256: other.definitionSha256,
      },
      version: "v2",
    });
    await expect(
      repository.publishComparisonDefinition(crossResourceSuccessor),
    ).rejects.toBeInstanceOf(ComparisonLineageError);

    const baseline = snapshot("semantic_lineage", recordScope, first, "baseline");
    const foreignCandidate = snapshot("foreign_lineage", recordScope, other, "candidate");
    await repository.publishComparisonEvidenceSnapshot(baseline);
    await repository.publishComparisonEvidenceSnapshot(foreignCandidate);
    const mixedResult = result("semantic_lineage", recordScope, first, baseline, foreignCandidate);
    await expect(repository.publishComparisonResult(mixedResult)).rejects.toBeInstanceOf(
      ComparisonLineageError,
    );
    await expect(
      repository.findComparisonResult(recordScope, mixedResult.resultId),
    ).resolves.toBeNull();
  });
});
