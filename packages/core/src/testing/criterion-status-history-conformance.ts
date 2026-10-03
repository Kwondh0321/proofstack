import assert from "node:assert/strict";
import {
  type CriterionSet,
  type CriterionSetStatusRecord,
  encodeEvaluationCanonicalJson,
} from "@proofstack/contracts";
import {
  CriterionStatusHistoryLimitError,
  type CriterionStatusHistoryRepository,
} from "../evaluation/criterion-status-history.js";
import { digestEvaluationRecordDefinition } from "../evaluation/evaluation-record-validation.js";
import type { EvaluationRepository } from "../evaluation/evaluation-repository.js";
import {
  type EvaluationRepositoryTestHarness,
  publishEvaluationFixture,
} from "./evaluation-repository-conformance.js";

type Harness = Omit<EvaluationRepositoryTestHarness, "repository"> & {
  readonly repository: EvaluationRepository & CriterionStatusHistoryRepository;
};
type Factory = (namespace: string) => Harness | Promise<Harness>;
const generous = { maxRecords: 100, maxRecordBytes: 1_000_000 };

export function criterionStatusHistoryFixture(
  base: CriterionSetStatusRecord,
  changes: Partial<CriterionSetStatusRecord>,
): CriterionSetStatusRecord {
  const changed = { ...base, ...changes };
  const {
    schemaVersion,
    scope,
    definitionSha256: _digest,
    recordedAt,
    recordedByPrincipalId,
    ...definition
  } = changed;
  const body = JSON.parse(JSON.stringify(definition)) as typeof definition;
  return {
    ...body,
    schemaVersion,
    scope,
    recordedAt,
    recordedByPrincipalId,
    definitionSha256: digestEvaluationRecordDefinition("criterion_set_status", scope, body),
  };
}

async function fixture(
  factory: Factory,
  namespace: string,
  run: (harness: Harness, statuses: readonly CriterionSetStatusRecord[]) => Promise<void>,
) {
  const harness = await factory(namespace);
  try {
    for (const record of harness.records)
      await publishEvaluationFixture(harness.repository, record);
    const statuses = harness.records
      .filter((record) => record.kind === "criterion_set_status")
      .map(({ record }) => record)
      .sort((a, b) => (a.statusRecordId < b.statusRecordId ? -1 : 1));
    assert.equal(statuses.length, 2);
    await run(harness, statuses);
  } finally {
    await harness.dispose?.();
  }
}

export const criterionStatusHistoryConformanceCases: readonly {
  readonly name: string;
  readonly run: (factory: Factory) => Promise<void>;
}[] = [
  {
    name: "reads complete status history in exact scope and owns returned records",
    run: (factory) =>
      fixture(factory, "history_scope", async ({ repository, scope }, statuses) => {
        const actual = await repository.listCriterionSetStatuses(scope, generous);
        assert.deepEqual(actual, statuses);
        assert.ok(actual[0]);
        Reflect.set(actual[0], "rationale", "Caller changed its returned copy");
        assert.deepEqual(await repository.listCriterionSetStatuses(scope, generous), statuses);
        for (const key of ["tenantId", "projectId", "environmentId"]) {
          assert.deepEqual(
            await repository.listCriterionSetStatuses(
              { ...scope, [key]: "other_scope" },
              { maxRecords: 0, maxRecordBytes: 2 },
            ),
            [],
          );
        }
      }),
  },
  {
    name: "never chooses a latest approved row or drops future, terminal and branching statuses",
    run: (factory) =>
      fixture(factory, "history_branches", async ({ repository, scope }, statuses) => {
        const approved = statuses.find(({ status }) => status === "approved");
        const draft = statuses.find(({ status }) => status === "draft");
        assert.ok(approved && draft);
        const future = criterionStatusHistoryFixture(approved, {
          statusRecordId: "csr_aaa_future",
          status: "withdrawn",
          previousStatus: {
            statusRecordId: approved.statusRecordId,
            definitionSha256: approved.definitionSha256,
          },
          effectiveAt: "2026-10-03T00:00:00.123456Z",
          recordedAt: "2026-10-03T00:00:00.124Z",
          expiresAt: undefined,
          rationale: "철회 이력 — future control observation",
        });
        const branch = criterionStatusHistoryFixture(future, {
          statusRecordId: "csr_zzz_branch",
          status: "contested",
        });
        const anotherRoot = criterionStatusHistoryFixture(draft, {
          statusRecordId: "csr_another_draft",
        });
        for (const record of [future, branch, anotherRoot])
          await repository.publishCriterionSetStatus(record);
        const expected = JSON.parse(
          JSON.stringify([...statuses, future, branch, anotherRoot]),
        ).sort((a: CriterionSetStatusRecord, b: CriterionSetStatusRecord) =>
          a.statusRecordId < b.statusRecordId ? -1 : 1,
        );
        assert.deepEqual(await repository.listCriterionSetStatuses(scope, generous), expected);
      }),
  },
  {
    name: "fails the complete read at count and canonical UTF-8 byte limits instead of truncating",
    run: (factory) =>
      fixture(factory, "history_limits", async ({ repository, scope }, statuses) => {
        const maxRecordBytes = encodeEvaluationCanonicalJson(statuses).byteLength;
        assert.deepEqual(
          await repository.listCriterionSetStatuses(scope, {
            maxRecords: statuses.length,
            maxRecordBytes,
          }),
          statuses,
        );
        await assert.rejects(
          repository.listCriterionSetStatuses(scope, {
            maxRecords: statuses.length - 1,
            maxRecordBytes,
          }),
          (error: unknown) =>
            error instanceof CriterionStatusHistoryLimitError && error.limit === "records",
        );
        await assert.rejects(
          repository.listCriterionSetStatuses(scope, {
            maxRecords: statuses.length,
            maxRecordBytes: maxRecordBytes - 1,
          }),
          (error: unknown) =>
            error instanceof CriterionStatusHistoryLimitError && error.limit === "bytes",
        );
        await assert.rejects(
          repository.listCriterionSetStatuses(scope, { maxRecords: 0, maxRecordBytes }),
          CriterionStatusHistoryLimitError,
        );
        assert.deepEqual(await repository.listCriterionSetStatuses(scope, generous), statuses);
      }),
  },
  {
    name: "includes other criterion roots in the same scope so a JSON selector cannot hide a status",
    run: (factory) =>
      fixture(factory, "history_roots", async ({ repository, scope, records }, statuses) => {
        const criterion = records.find((record) => record.kind === "criterion_set")?.record;
        const draft = statuses.find(({ status }) => status === "draft");
        assert.ok(criterion && draft);
        const {
          schemaVersion,
          definitionSha256: _digest,
          publishedAt,
          publishedByPrincipalId,
          scope: _scope,
          ...original
        } = criterion;
        const definition = {
          ...original,
          criterionSetId: "criteria_history_other",
          criterionSetVersionId: "criteria_history_other_v1",
        };
        const other: CriterionSet = {
          ...definition,
          scope,
          schemaVersion,
          publishedAt,
          publishedByPrincipalId,
          definitionSha256: digestEvaluationRecordDefinition("criterion_set", scope, definition),
        };
        await repository.publishCriterionSet(other);
        const otherStatus = criterionStatusHistoryFixture(draft, {
          statusRecordId: "csr_other_root",
          criterionSet: {
            criterionSetId: other.criterionSetId,
            criterionSetVersionId: other.criterionSetVersionId,
            definitionSha256: other.definitionSha256,
          },
        });
        await repository.publishCriterionSetStatus(otherStatus);
        const actual = await repository.listCriterionSetStatuses(scope, generous);
        assert.equal(actual.length, 3);
        assert.ok(
          actual.some(({ statusRecordId }) => statusRecordId === otherStatus.statusRecordId),
        );
        await assert.rejects(
          repository.listCriterionSetStatuses(scope, { ...generous, maxRecords: 2 }),
          CriterionStatusHistoryLimitError,
        );
      }),
  },
];
