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
import { digestComparisonRecordDefinition } from "../evaluation/comparison-record-validation.js";
import type { ComparisonRepository } from "../evaluation/comparison-repository.js";
import { MemoryComparisonRepository } from "./memory-comparison-repository.js";

interface Vector<Definition> {
  readonly input: {
    readonly definition: Definition;
  };
}

function vector<Definition>(filename: string): Definition {
  const document = JSON.parse(
    readFileSync(new URL(`../../../contracts/vectors/${filename}`, import.meta.url), "utf8"),
  ) as { readonly vectors: readonly Vector<Definition>[] };
  const first = document.vectors[0];
  if (!first) throw new Error(`Expected a vector in ${filename}`);
  return first.input.definition;
}

const comparisonTemplate = vector<ComparisonDefinitionInput>(
  "evaluation-comparison-definition-v1.json",
);
const snapshotTemplate = vector<ComparisonEvidenceSnapshotDefinition>(
  "evaluation-comparison-snapshot-definition-v1.json",
);
const resultTemplate = vector<ComparisonResultDefinition>(
  "evaluation-comparison-result-definition-v1.json",
);

export function comparisonFixtureScope(namespace: string, suffix = "primary"): EvidenceScope {
  return {
    environmentId: `env_${namespace}_${suffix}`,
    projectId: `prj_${namespace}_${suffix}`,
    tenantId: `ten_${namespace}`,
  };
}

export function comparisonDefinitionFixture(
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
    ...structuredClone(comparisonTemplate),
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

function comparisonReference(value: ComparisonDefinition): ComparisonDefinitionReference {
  return {
    comparisonId: value.comparisonId,
    comparisonVersionId: value.comparisonVersionId,
    definitionSha256: value.definitionSha256,
  };
}

export function comparisonSnapshotFixture(
  namespace: string,
  recordScope: EvidenceScope,
  comparison: ComparisonDefinition,
  role: "baseline" | "candidate",
): ComparisonEvidenceSnapshot {
  const body = {
    ...structuredClone(snapshotTemplate),
    comparison: comparisonReference(comparison),
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

export function comparisonResultFixture(
  namespace: string,
  recordScope: EvidenceScope,
  comparison: ComparisonDefinition,
  baseline: ComparisonEvidenceSnapshot,
  candidate: ComparisonEvidenceSnapshot,
): ComparisonResult {
  const body = {
    ...structuredClone(resultTemplate),
    baselineSnapshot: snapshotReference(baseline),
    candidateSnapshot: snapshotReference(candidate),
    comparison: comparisonReference(comparison),
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

export type ComparisonRepositoryFixtureRecord =
  | { readonly kind: "comparison_definition"; readonly record: ComparisonDefinition }
  | {
      readonly kind: "comparison_evidence_snapshot";
      readonly record: ComparisonEvidenceSnapshot;
    }
  | { readonly kind: "comparison_result"; readonly record: ComparisonResult };

export interface ComparisonRepositoryTestHarness {
  readonly crossResourceSuccessor: ComparisonDefinition;
  readonly dispose?: () => Promise<void>;
  readonly foreignCandidate: ComparisonEvidenceSnapshot;
  readonly lineageProbe: ComparisonEvidenceSnapshot;
  readonly mixedResult: ComparisonResult;
  readonly otherDefinition: ComparisonDefinition;
  readonly otherScope: EvidenceScope;
  readonly recordConflict: ComparisonDefinition;
  readonly records: readonly ComparisonRepositoryFixtureRecord[];
  readonly repository: ComparisonRepository;
  readonly resourceConflict: ComparisonDefinition;
  readonly scope: EvidenceScope;
}

export function createComparisonRepositoryTestHarness(
  namespace: string,
): ComparisonRepositoryTestHarness {
  const recordScope = comparisonFixtureScope(namespace);
  const comparison = comparisonDefinitionFixture(namespace, recordScope);
  const baseline = comparisonSnapshotFixture(namespace, recordScope, comparison, "baseline");
  const candidate = comparisonSnapshotFixture(namespace, recordScope, comparison, "candidate");
  const result = comparisonResultFixture(namespace, recordScope, comparison, baseline, candidate);
  const otherScope = comparisonFixtureScope(namespace, "other");
  const otherDefinition = comparisonDefinitionFixture(`${namespace}_foreign`, recordScope);
  const foreignCandidate = comparisonSnapshotFixture(
    `${namespace}_foreign`,
    recordScope,
    otherDefinition,
    "candidate",
  );
  return {
    crossResourceSuccessor: comparisonDefinitionFixture(namespace, recordScope, {
      comparisonId: comparison.comparisonId,
      predecessor: {
        comparisonVersionId: otherDefinition.comparisonVersionId,
        definitionSha256: otherDefinition.definitionSha256,
      },
      version: "v2",
    }),
    foreignCandidate,
    lineageProbe: baseline,
    mixedResult: comparisonResultFixture(
      `${namespace}_mixed`,
      recordScope,
      comparison,
      baseline,
      foreignCandidate,
    ),
    otherDefinition,
    otherScope,
    recordConflict: comparisonDefinitionFixture(namespace, recordScope, {
      description: "Different immutable comparison semantics",
    }),
    records: [
      { kind: "comparison_definition", record: comparison },
      { kind: "comparison_evidence_snapshot", record: baseline },
      { kind: "comparison_evidence_snapshot", record: candidate },
      { kind: "comparison_result", record: result },
    ],
    repository: new MemoryComparisonRepository(),
    resourceConflict: comparisonDefinitionFixture(`${namespace}_resource`, otherScope, {
      comparisonId: comparison.comparisonId,
    }),
    scope: recordScope,
  };
}
