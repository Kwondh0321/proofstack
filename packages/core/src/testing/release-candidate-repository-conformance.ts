import assert from "node:assert/strict";
import {
  InvalidReleaseCandidateRecordInputError,
  ReleaseCandidateLineageError,
  ReleaseCandidateResourceConflictError,
  ReleaseCandidateVersionConflictError,
} from "../release/release-candidate-errors.js";
import type {
  PublishReleaseCandidateResult,
  ReleaseCandidateRepository,
} from "../release/release-candidate-repository.js";
import type { ReleaseCandidateRepositoryTestHarness } from "./release-candidate-repository-fixtures.js";

export type ReleaseCandidateRepositoryTestFactory = (
  namespace: string,
) => Promise<ReleaseCandidateRepositoryTestHarness> | ReleaseCandidateRepositoryTestHarness;

export interface ReleaseCandidateRepositoryConformanceCase {
  readonly name: string;
  readonly run: (factory: ReleaseCandidateRepositoryTestFactory) => Promise<void>;
}

async function withHarness(
  factory: ReleaseCandidateRepositoryTestFactory,
  namespace: string,
  test: (harness: ReleaseCandidateRepositoryTestHarness) => Promise<void>,
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
