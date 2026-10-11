import assert from "node:assert/strict";
import type { EvidenceScope } from "@proofstack/contracts";
import type { ComparisonLogicalRootReader } from "../evaluation/comparison-logical-root.js";
import { comparisonRecordId } from "../evaluation/comparison-record-validation.js";
import type {
  ComparisonRecord,
  ComparisonRepository,
  PublishComparisonRecordResult,
} from "../evaluation/comparison-repository.js";
import {
  ComparisonLineageError,
  ComparisonRecordConflictError,
  ComparisonResourceConflictError,
  InvalidComparisonRecordInputError,
} from "../evaluation/comparison-repository-errors.js";
import {
  type ComparisonRepositoryFixtureRecord,
  type ComparisonRepositoryTestHarness,
  comparisonDefinitionFixture,
  comparisonResultFixture,
  comparisonSnapshotFixture,
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

async function withHarness<Harness extends ComparisonRepositoryTestHarness>(
  factory: (namespace: string) => Harness | Promise<Harness>,
  namespace: string,
  test: (harness: Harness) => Promise<void>,
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
            const retriedRecord = structuredClone(fixture.record);
            retriedRecord.createdAt = "2026-09-02T03:00:01.000Z";
            retriedRecord.createdByPrincipalId = "principal_retry_attempt";
            const retry = await publishComparisonFixture(harness.repository, {
              kind: fixture.kind,
              record: retriedRecord,
            } as typeof fixture);
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

type RootHarness = Omit<ComparisonRepositoryTestHarness, "repository"> & {
  readonly repository: ComparisonRepository & ComparisonLogicalRootReader;
};
type RootFactory = (namespace: string) => RootHarness | Promise<RootHarness>;
export const comparisonLogicalRootConformanceCases: readonly {
  readonly name: string;
  readonly run: (factory: RootFactory) => Promise<void>;
}[] = [
  {
    name: "observes the original comparison definition for every child kind with exact scope",
    async run(factory) {
      await withHarness(factory, "cmp_root_scope", async (h) => {
        for (const f of h.records)
          assert.equal(
            await h.repository.findComparisonLogicalRoot(
              h.scope,
              f.kind,
              comparisonRecordId(f.kind, f.record),
            ),
            null,
          );
        await publishGraph(h);
        const root = h.records[0];
        assert.equal(root?.kind, "comparison_definition");
        assert.ok(root);
        for (const f of h.records) {
          const id = comparisonRecordId(f.kind, f.record);
          assert.deepEqual(
            await h.repository.findComparisonLogicalRoot(h.scope, f.kind, id),
            root.record,
          );
          for (const field of ["tenantId", "projectId", "environmentId"] as const)
            assert.equal(
              await h.repository.findComparisonLogicalRoot(
                { ...h.scope, [field]: `${h.scope[field]}_other` },
                f.kind,
                id,
              ),
              null,
            );
          assert.equal(
            await h.repository.findComparisonLogicalRoot(
              h.scope,
              f.kind,
              "comparison_absent_child",
            ),
            null,
          );
        }
      });
    },
  },
  {
    name: "retains the comparison original through independent versions, predecessor chains and result lineage",
    async run(factory) {
      await withHarness(factory, "cmp_root_binding", async (h) => {
        await publishGraph(h);
        const original = h.records[0];
        assert.ok(original?.kind === "comparison_definition");
        const independent = comparisonDefinitionFixture("cmp_independent", h.scope, {
          comparisonId: original.record.comparisonId,
        });
        independent.createdAt = "2026-09-01T00:00:00.000Z";
        await h.repository.publishComparisonDefinition(independent);
        const successor = comparisonDefinitionFixture("cmp_successor", h.scope, {
          comparisonId: original.record.comparisonId,
          predecessor: {
            comparisonVersionId: independent.comparisonVersionId,
            definitionSha256: independent.definitionSha256,
          },
        });
        const baseline = comparisonSnapshotFixture("cmp_successor", h.scope, successor, "baseline");
        const candidate = comparisonSnapshotFixture(
          "cmp_successor",
          h.scope,
          successor,
          "candidate",
        );
        const result = comparisonResultFixture(
          "cmp_successor",
          h.scope,
          successor,
          baseline,
          candidate,
        );
        const later: ComparisonRepositoryFixtureRecord[] = [
          { kind: "comparison_definition", record: successor },
          { kind: "comparison_evidence_snapshot", record: baseline },
          { kind: "comparison_evidence_snapshot", record: candidate },
          { kind: "comparison_result", record: result },
        ];
        for (const f of later) {
          await publishComparisonFixture(h.repository, f);
          assert.deepEqual(
            await h.repository.findComparisonLogicalRoot(
              h.scope,
              f.kind,
              comparisonRecordId(f.kind, f.record),
            ),
            original.record,
          );
        }
        await h.repository.publishComparisonDefinition({
          ...original.record,
          createdAt: "2026-09-04T00:00:00.000Z",
        });
        const root = await h.repository.findComparisonLogicalRoot(
          h.scope,
          "comparison_result",
          result.resultId,
        );
        assert.deepEqual(root, original.record);
        assert.ok(root);
        root.description = "Caller mutation.";
        assert.deepEqual(
          await h.repository.findComparisonLogicalRoot(
            h.scope,
            "comparison_definition",
            independent.comparisonVersionId,
          ),
          original.record,
        );
      });
    },
  },
  {
    name: "isolates colliding comparison child and root identities across three tenants",
    async run(factory) {
      await withHarness(factory, "cmp_root_tenants", async (h) => {
        const roots = ["a", "b", "c"].map((label) =>
          comparisonDefinitionFixture("cmp_collision", {
            ...h.scope,
            tenantId: `${h.scope.tenantId}_${label}`,
          }),
        );
        for (const root of roots) {
          await h.repository.publishComparisonDefinition(root);
          const baseline = comparisonSnapshotFixture("cmp_collision", root.scope, root, "baseline");
          const candidate = comparisonSnapshotFixture(
            "cmp_collision",
            root.scope,
            root,
            "candidate",
          );
          await h.repository.publishComparisonEvidenceSnapshot(baseline);
          await h.repository.publishComparisonEvidenceSnapshot(candidate);
          await h.repository.publishComparisonResult(
            comparisonResultFixture("cmp_collision", root.scope, root, baseline, candidate),
          );
        }
        for (const root of roots)
          assert.deepEqual(
            await h.repository.findComparisonLogicalRoot(
              root.scope,
              "comparison_result",
              "result_cmp_collision",
            ),
            root,
          );
      });
    },
  },
  {
    name: "retains one comparison original under competing first definition publication",
    async run(factory) {
      await withHarness(factory, "cmp_root_race", async (h) => {
        const original = h.records[0];
        assert.ok(original?.kind === "comparison_definition");
        const other = comparisonDefinitionFixture("cmp_racing", h.scope, {
          comparisonId: original.record.comparisonId,
        });
        await Promise.all([
          h.repository.publishComparisonDefinition(original.record),
          h.repository.publishComparisonDefinition(other),
        ]);
        const left = await h.repository.findComparisonLogicalRoot(
          h.scope,
          "comparison_definition",
          original.record.comparisonVersionId,
        );
        const right = await h.repository.findComparisonLogicalRoot(
          h.scope,
          "comparison_definition",
          other.comparisonVersionId,
        );
        assert.deepEqual(left, right);
        assert.ok(left);
        assert.deepEqual(
          left,
          left.comparisonVersionId === original.record.comparisonVersionId
            ? original.record
            : other,
        );
      });
    },
  },
];
