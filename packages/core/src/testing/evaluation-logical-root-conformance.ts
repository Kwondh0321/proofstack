import assert from "node:assert/strict";
import type { EvidenceScope } from "@proofstack/contracts";
import type {
  EvaluationLogicalRootKind,
  EvaluationLogicalRootReader,
} from "../evaluation/evaluation-logical-root.js";
import {
  digestEvaluationRecordDefinition,
  evaluationRecordDescriptors,
  evaluationRecordId,
  validateEvaluationRecord,
} from "../evaluation/evaluation-record-validation.js";
import { EvaluationResourceConflictError } from "../evaluation/evaluation-repository-errors.js";
import type {
  EvaluationRepositoryFixtureRecord,
  EvaluationRepositoryTestHarness,
} from "./evaluation-repository-conformance.js";
import { publishEvaluationFixture } from "./evaluation-repository-conformance.js";
import { createEvaluationRepositoryTestHarness } from "./evaluation-repository-fixtures.js";

type Harness = Omit<EvaluationRepositoryTestHarness, "repository"> & {
  readonly repository: EvaluationRepositoryTestHarness["repository"] & EvaluationLogicalRootReader;
};
type Factory = (namespace: string) => Harness | Promise<Harness>;
type RootFixture = Extract<EvaluationRepositoryFixtureRecord, { kind: EvaluationLogicalRootKind }>;

const fields = {
  aggregation_policy: ["policyId", "policyVersionId"],
  criterion_set: ["criterionSetId", "criterionSetVersionId"],
  evaluator_spec: ["evaluatorId", "evaluatorVersionId"],
  oracle_spec: ["oracleId", "oracleVersionId"],
  qualification_fixture_set: ["fixtureSetId", "fixtureSetVersionId"],
} as const;
const kinds = Object.keys(fields) as EvaluationLogicalRootKind[];
function namespace(kind: EvaluationLogicalRootKind, scenario: string): string {
  return `lr_${kinds.indexOf(kind)}_${scenario}`;
}

function fixture(h: EvaluationRepositoryTestHarness, kind: EvaluationLogicalRootKind): RootFixture {
  const found = h.records.find((f) => f.kind === kind);
  assert.ok(found);
  return found as RootFixture;
}

function version(
  original: RootFixture,
  suffix: string,
  predecessor?: RootFixture,
  scope: EvidenceScope = original.record.scope,
): RootFixture {
  const [logicalId, versionId] = fields[original.kind];
  const record = structuredClone(original.record) as unknown as Record<string, unknown>;
  record[versionId] = `${evaluationRecordId(original.kind, original.record)}_${suffix}`;
  record["scope"] = structuredClone(scope);
  delete record["predecessor"];
  if (predecessor)
    record["predecessor"] = {
      [logicalId]: record[logicalId],
      [versionId]: evaluationRecordId(predecessor.kind, predecessor.record),
      definitionSha256: predecessor.record.definitionSha256,
    };
  const definition = structuredClone(record);
  for (const key of evaluationRecordDescriptors[original.kind].receiptKeys) delete definition[key];
  record["definitionSha256"] = digestEvaluationRecordDefinition(original.kind, scope, definition);
  return {
    kind: original.kind,
    record: validateEvaluationRecord(original.kind, record),
  } as RootFixture;
}

async function graph(h: Harness): Promise<void> {
  for (const record of h.records) await publishEvaluationFixture(h.repository, record);
}

async function withHarness(
  factory: Factory,
  namespace: string,
  test: (h: Harness) => Promise<void>,
) {
  const h = await factory(namespace);
  try {
    await test(h);
  } finally {
    await h.dispose?.();
  }
}

export interface EvaluationLogicalRootConformanceCase {
  readonly name: string;
  readonly run: (factory: Factory) => Promise<void>;
}

export const evaluationLogicalRootConformanceCases: readonly EvaluationLogicalRootConformanceCase[] =
  kinds.flatMap((kind): EvaluationLogicalRootConformanceCase[] => [
    {
      name: `observes ${kind} original roots with exact scoped absence`,
      async run(factory) {
        await withHarness(factory, namespace(kind, "scope"), async (h) => {
          const root = fixture(h, kind);
          const id = evaluationRecordId(kind, root.record);
          assert.equal(await h.repository.findEvaluationLogicalRoot(h.scope, kind, id), null);
          await graph(h);
          assert.deepEqual(
            await h.repository.findEvaluationLogicalRoot(h.scope, kind, id),
            root.record,
          );
          assert.equal(
            await h.repository.findEvaluationLogicalRoot(h.scope, kind, "missing_root_child"),
            null,
          );
          for (const field of ["tenantId", "projectId", "environmentId"] as const)
            assert.equal(
              await h.repository.findEvaluationLogicalRoot(
                { ...h.scope, [field]: `${h.scope[field]}_other` },
                kind,
                id,
              ),
              null,
            );
        });
      },
    },
    {
      name: `retains ${kind} first binding across independent backdated versions and predecessors`,
      async run(factory) {
        await withHarness(factory, namespace(kind, "versions"), async (h) => {
          await graph(h);
          const root = fixture(h, kind);
          const independent = version(root, "independent");
          independent.record.publishedAt = "2026-09-01T00:00:00.000Z";
          await publishEvaluationFixture(h.repository, independent);
          const descendant = version(
            root,
            "descendant",
            kind === "aggregation_policy" ? undefined : independent,
          );
          await publishEvaluationFixture(h.repository, descendant);
          for (const child of [independent, descendant])
            assert.deepEqual(
              await h.repository.findEvaluationLogicalRoot(
                h.scope,
                kind,
                evaluationRecordId(kind, child.record),
              ),
              root.record,
            );
        });
      },
    },
    {
      name: `owns ${kind} roots and preserves original retry receipts and scope binding conflicts`,
      async run(factory) {
        await withHarness(factory, namespace(kind, "owned"), async (h) => {
          await graph(h);
          const root = fixture(h, kind);
          const id = evaluationRecordId(kind, root.record);
          const retry = structuredClone(root);
          retry.record.publishedAt = "2026-09-03T00:00:00.000Z";
          assert.equal((await publishEvaluationFixture(h.repository, retry)).created, false);
          const returned = await h.repository.findEvaluationLogicalRoot(h.scope, kind, id);
          assert.deepEqual(returned, root.record);
          assert.ok(returned);
          returned.scope.environmentId = "env_caller_changed";
          assert.deepEqual(
            await h.repository.findEvaluationLogicalRoot(h.scope, kind, id),
            root.record,
          );
          await assert.rejects(
            publishEvaluationFixture(
              h.repository,
              version(root, "foreign_scope", undefined, h.otherScope),
            ),
            EvaluationResourceConflictError,
          );
          assert.deepEqual(
            await h.repository.findEvaluationLogicalRoot(h.scope, kind, id),
            root.record,
          );
        });
      },
    },
    {
      name: `isolates colliding ${kind} version identities across three tenants`,
      async run(factory) {
        await withHarness(factory, namespace(kind, "tenants"), async (h) => {
          const fixtures = [
            h,
            createEvaluationRepositoryTestHarness(namespace(kind, "second")),
            createEvaluationRepositoryTestHarness(namespace(kind, "third")),
          ];
          const expected = new Map<string, { scope: EvidenceScope; root: RootFixture }>();
          for (const own of fixtures) {
            for (const f of own.records) await publishEvaluationFixture(h.repository, f);
            const root = fixture(own, kind);
            const child = version(root, "collision");
            await publishEvaluationFixture(h.repository, child);
            expected.set(own.scope.tenantId, { scope: own.scope, root });
          }
          assert.equal(
            new Set([...expected.values()].map(({ root }) => evaluationRecordId(kind, root.record)))
              .size,
            1,
          );
          for (const { scope, root } of expected.values())
            assert.deepEqual(
              await h.repository.findEvaluationLogicalRoot(
                scope,
                kind,
                evaluationRecordId(kind, version(root, "collision").record),
              ),
              root.record,
            );
        });
      },
    },
    {
      name: `retains one ${kind} original root under competing first publications`,
      async run(factory) {
        await withHarness(factory, namespace(kind, "competing"), async (h) => {
          const root = fixture(h, kind);
          for (const f of h.records) {
            if (f === root) break;
            await publishEvaluationFixture(h.repository, f);
          }
          const other = version(root, "competing");
          await Promise.all([
            publishEvaluationFixture(h.repository, root),
            publishEvaluationFixture(h.repository, other),
          ]);
          const left = await h.repository.findEvaluationLogicalRoot(
            h.scope,
            kind,
            evaluationRecordId(kind, root.record),
          );
          const right = await h.repository.findEvaluationLogicalRoot(
            h.scope,
            kind,
            evaluationRecordId(kind, other.record),
          );
          assert.deepEqual(left, right);
          assert.ok(left);
          assert.ok(
            evaluationRecordId(kind, left) === evaluationRecordId(kind, root.record) ||
              evaluationRecordId(kind, left) === evaluationRecordId(kind, other.record),
          );
          assert.deepEqual(
            left,
            evaluationRecordId(kind, left) === evaluationRecordId(kind, root.record)
              ? root.record
              : other.record,
          );
        });
      },
    },
  ]);
