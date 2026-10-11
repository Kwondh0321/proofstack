import assert from "node:assert/strict";
import {
  InvalidReleaseCandidateRecordInputError,
  ReleaseCandidateLineageError,
  ReleaseCandidateResourceConflictError,
  ReleaseCandidateVersionConflictError,
} from "../release/release-candidate-errors.js";
import type {
  PublishReleaseCandidateResult,
  ReleaseCandidateLogicalRootReader,
  ReleaseCandidateRepository,
} from "../release/release-candidate-repository.js";
import {
  type ReleaseCandidateRepositoryTestHarness,
  releaseCandidateFixture,
} from "./release-candidate-repository-fixtures.js";

export type ReleaseCandidateRepositoryTestFactory = (
  namespace: string,
) => Promise<ReleaseCandidateRepositoryTestHarness> | ReleaseCandidateRepositoryTestHarness;

export interface ReleaseCandidateRepositoryConformanceCase {
  readonly name: string;
  readonly run: (factory: ReleaseCandidateRepositoryTestFactory) => Promise<void>;
}

async function withHarness<Harness extends ReleaseCandidateRepositoryTestHarness>(
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

async function publishGraph(
  harness: ReleaseCandidateRepositoryTestHarness,
): Promise<readonly PublishReleaseCandidateResult[]> {
  return [
    await harness.repository.publishReleaseCandidate(harness.candidate),
    await harness.repository.publishReleaseCandidate(harness.successor),
  ];
}

async function assertAbsent(
  repository: ReleaseCandidateRepository,
  harness: ReleaseCandidateRepositoryTestHarness,
  candidateVersionId: string,
): Promise<void> {
  assert.equal(await repository.findReleaseCandidate(harness.scope, candidateVersionId), null);
}

export const releaseCandidateRepositoryConformanceCases: readonly ReleaseCandidateRepositoryConformanceCase[] =
  [
    {
      name: "publishes and reads an exact immutable candidate lineage",
      async run(factory) {
        await withHarness(factory, "candidate_lineage", async (harness) => {
          const results = await publishGraph(harness);
          assert.deepEqual(
            results.map(({ created }) => created),
            [true, true],
          );
          assert.deepEqual(
            await harness.repository.findReleaseCandidate(
              harness.scope,
              harness.candidate.candidateVersionId,
            ),
            harness.candidate,
          );
          assert.deepEqual(
            await harness.repository.findReleaseCandidate(
              harness.scope,
              harness.successor.candidateVersionId,
            ),
            harness.successor,
          );
        });
      },
    },
    {
      name: "returns the authoritative original for retries and isolates returned values",
      async run(factory) {
        await withHarness(factory, "candidate_retry", async (harness) => {
          const first = await harness.repository.publishReleaseCandidate(harness.candidate);
          assert.equal(first.created, true);
          const retryInput = structuredClone(harness.candidate);
          retryInput.createdAt = "2026-09-06T15:00:01.000Z";
          retryInput.createdByPrincipalId = "principal_retry";
          const retry = await harness.repository.publishReleaseCandidate(retryInput);
          assert.equal(retry.created, false);
          assert.deepEqual(retry.candidate, harness.candidate);
          retry.candidate.target.purpose = "Caller mutation.";
          assert.deepEqual(
            await harness.repository.findReleaseCandidate(
              harness.scope,
              harness.candidate.candidateVersionId,
            ),
            harness.candidate,
          );
          assert.equal(
            await harness.repository.findReleaseCandidate(
              harness.otherScope,
              harness.candidate.candidateVersionId,
            ),
            null,
          );
        });
      },
    },
    {
      name: "rejects forged digests and unavailable predecessors without partial visibility",
      async run(factory) {
        await withHarness(factory, "candidate_invalid", async (harness) => {
          const forged = { ...harness.candidate, definitionSha256: "0".repeat(64) };
          await assert.rejects(
            harness.repository.publishReleaseCandidate(forged),
            InvalidReleaseCandidateRecordInputError,
          );
          await assertAbsent(harness.repository, harness, harness.candidate.candidateVersionId);
          await assert.rejects(
            harness.repository.publishReleaseCandidate(harness.lineageProbe),
            ReleaseCandidateLineageError,
          );
          await assertAbsent(harness.repository, harness, harness.lineageProbe.candidateVersionId);
        });
      },
    },
    {
      name: "rejects semantic and tenant-resource rebinding atomically",
      async run(factory) {
        await withHarness(factory, "candidate_conflicts", async (harness) => {
          await harness.repository.publishReleaseCandidate(harness.candidate);
          await assert.rejects(
            harness.repository.publishReleaseCandidate(harness.recordConflict),
            ReleaseCandidateVersionConflictError,
          );
          await assert.rejects(
            harness.repository.publishReleaseCandidate(harness.resourceConflict),
            ReleaseCandidateResourceConflictError,
          );
          await assertAbsent(
            harness.repository,
            harness,
            harness.resourceConflict.candidateVersionId,
          );
          assert.equal(
            await harness.repository.findReleaseCandidate(
              harness.otherScope,
              harness.resourceConflict.candidateVersionId,
            ),
            null,
          );
        });
      },
    },
    {
      name: "rejects a predecessor reference that disguises another candidate identity",
      async run(factory) {
        await withHarness(factory, "candidate_semantic_lineage", async (harness) => {
          await harness.repository.publishReleaseCandidate(harness.candidate);
          await harness.repository.publishReleaseCandidate(harness.unrelatedCandidate);
          await assert.rejects(
            harness.repository.publishReleaseCandidate(harness.conflictingPredecessor),
            ReleaseCandidateLineageError,
          );
          await assertAbsent(
            harness.repository,
            harness,
            harness.conflictingPredecessor.candidateVersionId,
          );
        });
      },
    },
    {
      name: "linearizes concurrent identical and conflicting candidate publication",
      async run(factory) {
        await withHarness(factory, "candidate_concurrency", async (harness) => {
          const identical = await Promise.all(
            Array.from({ length: 16 }, () =>
              harness.repository.publishReleaseCandidate(structuredClone(harness.candidate)),
            ),
          );
          assert.equal(identical.filter(({ created }) => created).length, 1);

          const conflictHarness = await factory("candidate_concurrency_conflict");
          try {
            const outcomes = await Promise.allSettled([
              conflictHarness.repository.publishReleaseCandidate(conflictHarness.candidate),
              conflictHarness.repository.publishReleaseCandidate(conflictHarness.recordConflict),
            ]);
            assert.equal(outcomes.filter(({ status }) => status === "fulfilled").length, 1);
            const rejected = outcomes.find(({ status }) => status === "rejected");
            assert.equal(rejected?.status, "rejected");
            if (rejected?.status === "rejected") {
              assert.ok(rejected.reason instanceof ReleaseCandidateVersionConflictError);
            }
          } finally {
            await conflictHarness.dispose?.();
          }
        });
      },
    },
  ];

type RootHarness = Omit<ReleaseCandidateRepositoryTestHarness, "repository"> & {
  readonly repository: ReleaseCandidateRepository & ReleaseCandidateLogicalRootReader;
};
type RootFactory = (namespace: string) => RootHarness | Promise<RootHarness>;
export const releaseCandidateLogicalRootConformanceCases: readonly {
  readonly name: string;
  readonly run: (factory: RootFactory) => Promise<void>;
}[] = [
  {
    name: "observes candidate original roots through exact scoped child presence",
    async run(factory) {
      await withHarness(factory, "cr_scope", async (h) => {
        assert.equal(
          await h.repository.findReleaseCandidateLogicalRoot(
            h.scope,
            h.candidate.candidateVersionId,
          ),
          null,
        );
        await publishGraph(h);
        for (const child of [h.candidate, h.successor]) {
          assert.deepEqual(
            await h.repository.findReleaseCandidateLogicalRoot(h.scope, child.candidateVersionId),
            h.candidate,
          );
          for (const field of ["tenantId", "projectId", "environmentId"] as const)
            assert.equal(
              await h.repository.findReleaseCandidateLogicalRoot(
                { ...h.scope, [field]: `${h.scope[field]}_other` },
                child.candidateVersionId,
              ),
              null,
            );
        }
        assert.equal(
          await h.repository.findReleaseCandidateLogicalRoot(h.scope, "candidate_absent"),
          null,
        );
      });
    },
  },
  {
    name: "retains the candidate original binding across independent backdated versions and retry receipts",
    async run(factory) {
      await withHarness(factory, "cr_binding", async (h) => {
        await publishGraph(h);
        const independent = releaseCandidateFixture("cr_later", h.scope, {
          candidateId: h.candidate.candidateId,
          candidateVersionId: "candidate_cr_later_v1",
        });
        assert.notEqual(independent.candidateVersionId, h.candidate.candidateVersionId);
        independent.createdAt = "2026-09-01T00:00:00.000Z";
        await h.repository.publishReleaseCandidate(independent);
        await h.repository.publishReleaseCandidate({
          ...h.candidate,
          createdAt: "2026-09-07T00:00:00.000Z",
        });
        const root = await h.repository.findReleaseCandidateLogicalRoot(
          h.scope,
          independent.candidateVersionId,
        );
        assert.deepEqual(root, h.candidate);
        assert.ok(root);
        root.target.purpose = "Caller mutation.";
        assert.deepEqual(
          await h.repository.findReleaseCandidateLogicalRoot(
            h.scope,
            h.successor.candidateVersionId,
          ),
          h.candidate,
        );
        await assert.rejects(
          h.repository.publishReleaseCandidate(h.resourceConflict),
          ReleaseCandidateResourceConflictError,
        );
        assert.deepEqual(
          await h.repository.findReleaseCandidateLogicalRoot(
            h.scope,
            independent.candidateVersionId,
          ),
          h.candidate,
        );
      });
    },
  },
  {
    name: "isolates colliding candidate root and successor identities across three tenants",
    async run(factory) {
      await withHarness(factory, "cr_tenants", async (h) => {
        const roots = ["a", "b", "c"].map((label) =>
          releaseCandidateFixture("cr_collision", {
            ...h.scope,
            tenantId: `${h.scope.tenantId}_${label}`,
          }),
        );
        for (const root of roots) {
          await h.repository.publishReleaseCandidate(root);
          const child = releaseCandidateFixture("cr_collision", root.scope, {
            version: "v2",
            predecessor: {
              candidateId: root.candidateId,
              candidateVersionId: root.candidateVersionId,
              definitionSha256: root.definitionSha256,
            },
          });
          await h.repository.publishReleaseCandidate(child);
        }
        for (const root of roots)
          assert.deepEqual(
            await h.repository.findReleaseCandidateLogicalRoot(
              root.scope,
              "candidate_cr_collision_v2",
            ),
            root,
          );
      });
    },
  },
  {
    name: "retains one candidate original root under competing independent first publications",
    async run(factory) {
      await withHarness(factory, "cr_race", async (h) => {
        const other = releaseCandidateFixture("cr_racing", h.scope, {
          candidateId: h.candidate.candidateId,
          candidateVersionId: "candidate_cr_racing_v1",
        });
        assert.notEqual(other.candidateVersionId, h.candidate.candidateVersionId);
        await Promise.all([
          h.repository.publishReleaseCandidate(h.candidate),
          h.repository.publishReleaseCandidate(other),
        ]);
        const left = await h.repository.findReleaseCandidateLogicalRoot(
          h.scope,
          h.candidate.candidateVersionId,
        );
        const right = await h.repository.findReleaseCandidateLogicalRoot(
          h.scope,
          other.candidateVersionId,
        );
        assert.deepEqual(left, right);
        assert.ok(left);
        assert.deepEqual(
          left,
          left.candidateVersionId === h.candidate.candidateVersionId ? h.candidate : other,
        );
      });
    },
  },
];
