import assert from "node:assert/strict";
import type { EvidenceScope } from "@proofstack/contracts";
import { comparisonRecordId } from "../evaluation/comparison-record-validation.js";
import {
  ComparisonLineageError,
  ComparisonRecordConflictError,
  ComparisonResourceConflictError,
  InvalidComparisonRecordInputError,
} from "../evaluation/comparison-repository-errors.js";
import type {
  ComparisonRecord,
  ComparisonRepository,
  PublishComparisonRecordResult,
} from "../evaluation/comparison-repository.js";
import type {
  ComparisonRepositoryFixtureRecord,
  ComparisonRepositoryTestHarness,
} from "./comparison-repository-fixtures.js";

export type ComparisonRepositoryTestFactory = (
  namespace: string,
) => Promise<ComparisonRepositoryTestHarness> | ComparisonRepositoryTestHarness;

export interface ComparisonRepositoryConformanceCase {
  readonly name: string;
  readonly run: (factory: ComparisonRepositoryTestFactory) => Promise<void>;
}

export async function publishComparisonFixture(
  repository: ComparisonRepository,
  fixture: ComparisonRepositoryFixtureRecord,
): Promise<PublishComparisonRecordResult<ComparisonRecord>> {
  switch (fixture.kind) {
    case "comparison_definition":
      return repository.publishComparisonDefinition(fixture.record);
    case "comparison_evidence_snapshot":
      return repository.publishComparisonEvidenceSnapshot(fixture.record);
    case "comparison_result":
      return repository.publishComparisonResult(fixture.record);
  }
}

async function findFixture(
  repository: ComparisonRepository,
  scope: EvidenceScope,
  fixture: ComparisonRepositoryFixtureRecord,
) {
  const id = comparisonRecordId(fixture.kind, fixture.record);
  switch (fixture.kind) {
    case "comparison_definition":
      return repository.findComparisonDefinition(scope, id);
    case "comparison_evidence_snapshot":
      return repository.findComparisonEvidenceSnapshot(scope, id);
    case "comparison_result":
      return repository.findComparisonResult(scope, id);
  }
}

async function withHarness(
  factory: ComparisonRepositoryTestFactory,
  namespace: string,
  test: (harness: ComparisonRepositoryTestHarness) => Promise<void>,
): Promise<void> {
  const harness = await factory(namespace);
  try {
    await test(harness);
  } finally {
    await harness.dispose?.();
  }
}

async function publishGraph(harness: ComparisonRepositoryTestHarness): Promise<void> {
  for (const fixture of harness.records) {
    const published = await publishComparisonFixture(harness.repository, fixture);
    assert.equal(published.created, true, `${fixture.kind} must be created once`);
    assert.deepEqual(published.record, fixture.record);
  }
}

export const comparisonRepositoryConformanceCases: readonly ComparisonRepositoryConformanceCase[] =
  [
    {
      name: "publishes and reads the exact immutable comparison graph in dependency order",
      async run(factory) {
        await withHarness(factory, "complete_graph", async (harness) => {
          assert.deepEqual([...new Set(harness.records.map(({ kind }) => kind))].sort(), [
            "comparison_definition",
            "comparison_evidence_snapshot",
            "comparison_result",
          ]);
          await publishGraph(harness);
          for (const fixture of harness.records) {
            assert.deepEqual(
              await findFixture(harness.repository, harness.scope, fixture),
              fixture.record,
            );
          }
        });
      },
    },
    {
      name: "returns owned originals for retries and hides every cross-scope record",
      async run(factory) {
        await withHarness(factory, "retry_isolation", async (harness) => {
          await publishGraph(harness);
          for (const fixture of harness.records) {
            const retry = await publishComparisonFixture(
              harness.repository,
              structuredClone(fixture),
            );
            assert.equal(retry.created, false);
            assert.deepEqual(retry.record, fixture.record);
            retry.record.scope.environmentId = "env_mutated_retry";
            assert.deepEqual(
              await findFixture(harness.repository, harness.scope, fixture),
              fixture.record,
            );
            assert.equal(await findFixture(harness.repository, harness.otherScope, fixture), null);
          }
        });
      },
    },
    {
      name: "rejects invalid digests and unavailable lineage without partial visibility",
      async run(factory) {
        await withHarness(factory, "invalid_lineage", async (harness) => {
          const first = structuredClone(harness.records[0]);
          assert.ok(first);
          first.record.definitionSha256 = "0".repeat(64);
          await assert.rejects(
            publishComparisonFixture(harness.repository, first),
            InvalidComparisonRecordInputError,
          );
          assert.equal(await findFixture(harness.repository, harness.scope, first), null);

          await assert.rejects(
            harness.repository.publishComparisonEvidenceSnapshot(harness.lineageProbe),
            ComparisonLineageError,
          );
          assert.equal(
            await harness.repository.findComparisonEvidenceSnapshot(
              harness.scope,
              harness.lineageProbe.snapshotId,
            ),
            null,
          );
        });
      },
    },
    {
      name: "rejects semantic and tenant-resource rebinding atomically",
      async run(factory) {
        await withHarness(factory, "conflicts", async (harness) => {
          const definition = harness.records[0];
          assert.equal(definition?.kind, "comparison_definition");
          if (definition?.kind !== "comparison_definition") return;
          await harness.repository.publishComparisonDefinition(definition.record);
          await assert.rejects(
            harness.repository.publishComparisonDefinition(harness.recordConflict),
            ComparisonRecordConflictError,
          );
          await assert.rejects(
            harness.repository.publishComparisonDefinition(harness.resourceConflict),
            ComparisonResourceConflictError,
          );
          assert.equal(
            await harness.repository.findComparisonDefinition(
              harness.otherScope,
              harness.resourceConflict.comparisonVersionId,
            ),
            null,
          );
        });
      },
    },
    {
      name: "rejects cross-comparison predecessor and result lineage",
      async run(factory) {
        await withHarness(factory, "semantic_lineage", async (harness) => {
          const definition = harness.records[0];
          const baseline = harness.records[1];
          assert.equal(definition?.kind, "comparison_definition");
          assert.equal(baseline?.kind, "comparison_evidence_snapshot");
          if (
            definition?.kind !== "comparison_definition" ||
            baseline?.kind !== "comparison_evidence_snapshot"
          ) {
            return;
          }
          await harness.repository.publishComparisonDefinition(definition.record);
          await harness.repository.publishComparisonDefinition(harness.otherDefinition);
          await assert.rejects(
            harness.repository.publishComparisonDefinition(harness.crossResourceSuccessor),
            ComparisonLineageError,
          );
          await harness.repository.publishComparisonEvidenceSnapshot(baseline.record);
          await harness.repository.publishComparisonEvidenceSnapshot(harness.foreignCandidate);
          await assert.rejects(
            harness.repository.publishComparisonResult(harness.mixedResult),
            ComparisonLineageError,
          );
          assert.equal(
            await harness.repository.findComparisonResult(
              harness.scope,
              harness.mixedResult.resultId,
            ),
            null,
          );
        });
      },
    },
    {
      name: "linearizes concurrent identical and conflicting definition publication",
      async run(factory) {
        await withHarness(factory, "concurrency", async (harness) => {
          const definition = harness.records[0];
          assert.equal(definition?.kind, "comparison_definition");
          if (definition?.kind !== "comparison_definition") return;
          const identical = await Promise.all(
            Array.from({ length: 16 }, () =>
              harness.repository.publishComparisonDefinition(structuredClone(definition.record)),
            ),
          );
          assert.equal(
            identical.filter(({ created }) => created).length,
            1,
            "exactly one identical concurrent write may create the record",
          );

          const conflictHarness = await factory("concurrency_conflict");
          try {
            const first = conflictHarness.records[0];
            assert.equal(first?.kind, "comparison_definition");
            if (first?.kind !== "comparison_definition") return;
            const outcomes = await Promise.allSettled([
              conflictHarness.repository.publishComparisonDefinition(first.record),
              conflictHarness.repository.publishComparisonDefinition(
                conflictHarness.recordConflict,
              ),
            ]);
            assert.equal(outcomes.filter(({ status }) => status === "fulfilled").length, 1);
            const rejected = outcomes.find(({ status }) => status === "rejected");
            assert.equal(rejected?.status, "rejected");
            if (rejected?.status === "rejected") {
              assert.ok(rejected.reason instanceof ComparisonRecordConflictError);
            }
          } finally {
            await conflictHarness.dispose?.();
          }
        });
      },
    },
  ];
