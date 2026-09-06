import assert from "node:assert/strict";
import type { ReleasePolicy, ReleasePolicyReference } from "@proofstack/contracts";
import {
  InvalidReleasePolicyLifecycleInputError,
  InvalidReleasePolicyRecordInputError,
  ReleasePolicyLifecycleEventConflictError,
  ReleasePolicyLifecycleStateConflictError,
  ReleasePolicyLineageError,
  ReleasePolicyResourceConflictError,
  ReleasePolicyVersionConflictError,
} from "../policy/release-policy-errors.js";
import type { ReleasePolicyRepository } from "../policy/release-policy-repository.js";
import {
  type ReleasePolicyRepositoryTestHarness,
  releasePolicyLifecycleFixture,
  releasePolicyRepositoryFixture,
} from "./release-policy-repository-fixtures.js";

export type ReleasePolicyRepositoryTestFactory = (
  namespace: string,
) => Promise<ReleasePolicyRepositoryTestHarness> | ReleasePolicyRepositoryTestHarness;

export interface ReleasePolicyRepositoryConformanceCase {
  readonly name: string;
  readonly run: (factory: ReleasePolicyRepositoryTestFactory) => Promise<void>;
}

async function withHarness(
  factory: ReleasePolicyRepositoryTestFactory,
  namespace: string,
  test: (harness: ReleasePolicyRepositoryTestHarness) => Promise<void>,
): Promise<void> {
  const harness = await factory(namespace);
  try {
    await test(harness);
  } finally {
    await harness.dispose?.();
  }
}

function reference(policy: ReleasePolicy): ReleasePolicyReference {
  return {
    definitionSha256: policy.definitionSha256,
    policyId: policy.policyId,
    policyVersionId: policy.policyVersionId,
  };
}

async function assertPolicyAbsent(
  repository: ReleasePolicyRepository,
  harness: ReleasePolicyRepositoryTestHarness,
  policyVersionId: string,
): Promise<void> {
  assert.equal(await repository.findReleasePolicy(harness.scope, policyVersionId), null);
}

async function assertEventAbsent(
  repository: ReleasePolicyRepository,
  harness: ReleasePolicyRepositoryTestHarness,
  eventId: string,
): Promise<void> {
  assert.equal(await repository.findReleasePolicyLifecycleEvent(harness.scope, eventId), null);
}

async function publishPolicyGraph(harness: ReleasePolicyRepositoryTestHarness): Promise<void> {
  await harness.repository.publishReleasePolicy(harness.policy);
  await harness.repository.publishReleasePolicy(harness.successor);
}

export const releasePolicyRepositoryConformanceCases: readonly ReleasePolicyRepositoryConformanceCase[] =
  [
    {
      name: "publishes and reads exact immutable policy lineage",
      async run(factory) {
        await withHarness(factory, "policy_lineage", async (harness) => {
          const first = await harness.repository.publishReleasePolicy(harness.policy);
          const successor = await harness.repository.publishReleasePolicy(harness.successor);
          assert.equal(first.created, true);
          assert.equal(successor.created, true);
          assert.deepEqual(
            await harness.repository.findReleasePolicy(
              harness.scope,
              harness.policy.policyVersionId,
            ),
            harness.policy,
          );
          assert.deepEqual(
            await harness.repository.findReleasePolicy(
              harness.scope,
              harness.successor.policyVersionId,
            ),
            harness.successor,
          );
          assert.equal(
            await harness.repository.findReleasePolicy(
              harness.otherScope,
              harness.policy.policyVersionId,
            ),
            null,
          );
        });
      },
    },
    {
      name: "preserves the first policy receipt and isolates returned values",
      async run(factory) {
        await withHarness(factory, "policy_retry", async (harness) => {
          const first = await harness.repository.publishReleasePolicy(harness.policy);
          assert.equal(first.created, true);
          const retryInput = structuredClone(harness.policy);
          retryInput.publishedAt = "2026-09-07T01:01:00.000Z";
          const retry = await harness.repository.publishReleasePolicy(retryInput);
          assert.equal(retry.created, false);
          assert.deepEqual(retry.policy, harness.policy);

          retry.policy.changeRationale = "Caller mutation must not enter stored state.";
          const read = await harness.repository.findReleasePolicy(
            harness.scope,
            harness.policy.policyVersionId,
          );
          assert.deepEqual(read, harness.policy);
          if (read) read.changeRationale = "A read result must also be isolated.";
          assert.deepEqual(
            await harness.repository.findReleasePolicy(
              harness.scope,
              harness.policy.policyVersionId,
            ),
            harness.policy,
          );
        });
      },
    },
    {
      name: "rejects malformed policies, semantic rebinding, and tenant resource rebinding atomically",
      async run(factory) {
        await withHarness(factory, "policy_conflicts", async (harness) => {
          const forged = { ...harness.policy, definitionSha256: "0".repeat(64) };
          await assert.rejects(
            harness.repository.publishReleasePolicy(forged),
            InvalidReleasePolicyRecordInputError,
          );
          await assertPolicyAbsent(harness.repository, harness, harness.policy.policyVersionId);

          await harness.repository.publishReleasePolicy(harness.policy);
          await assert.rejects(
            harness.repository.publishReleasePolicy(harness.recordConflict),
            ReleasePolicyVersionConflictError,
          );
          await assert.rejects(
            harness.repository.publishReleasePolicy(harness.resourceConflict),
            ReleasePolicyResourceConflictError,
          );
          assert.equal(
            await harness.repository.findReleasePolicy(
              harness.otherScope,
              harness.resourceConflict.policyVersionId,
            ),
            null,
          );
        });
      },
    },
    {
      name: "rejects unavailable and semantically disguised predecessors without partial visibility",
      async run(factory) {
        await withHarness(factory, "policy_invalid_lineage", async (harness) => {
          await assert.rejects(
            harness.repository.publishReleasePolicy(harness.lineageProbe),
            ReleasePolicyLineageError,
          );
          await assertPolicyAbsent(
            harness.repository,
            harness,
            harness.lineageProbe.policyVersionId,
          );

          await harness.repository.publishReleasePolicy(harness.policy);
          await harness.repository.publishReleasePolicy(harness.unrelatedPolicy);
          await assert.rejects(
            harness.repository.publishReleasePolicy(harness.conflictingPredecessor),
            ReleasePolicyLineageError,
          );
          await assertPolicyAbsent(
            harness.repository,
            harness,
            harness.conflictingPredecessor.policyVersionId,
          );
        });
      },
    },
    {
      name: "linearizes concurrent identical and conflicting policy publication",
      async run(factory) {
        await withHarness(factory, "policy_concurrency", async (harness) => {
          const identical = await Promise.all(
            Array.from({ length: 16 }, () =>
              harness.repository.publishReleasePolicy(structuredClone(harness.policy)),
            ),
          );
          assert.equal(identical.filter(({ created }) => created).length, 1);

          const conflictHarness = await factory("policy_concurrency_conflict");
          try {
            const outcomes = await Promise.allSettled([
              conflictHarness.repository.publishReleasePolicy(conflictHarness.policy),
              conflictHarness.repository.publishReleasePolicy(conflictHarness.recordConflict),
            ]);
            assert.equal(outcomes.filter(({ status }) => status === "fulfilled").length, 1);
            const rejected = outcomes.find(({ status }) => status === "rejected");
            assert.equal(rejected?.status, "rejected");
            if (rejected?.status === "rejected") {
              assert.ok(rejected.reason instanceof ReleasePolicyVersionConflictError);
            }
          } finally {
            await conflictHarness.dispose?.();
          }
        });
      },
    },
    {
      name: "publishes, reads, and lists an exact terminal lifecycle event",
      async run(factory) {
        await withHarness(factory, "policy_lifecycle", async (harness) => {
          await harness.repository.publishReleasePolicy(harness.policy);
          const result = await harness.repository.publishReleasePolicyLifecycleEvent(
            harness.withdrawal,
          );
          assert.equal(result.created, true);
          assert.deepEqual(result.event, harness.withdrawal);
          assert.deepEqual(
            await harness.repository.findReleasePolicyLifecycleEvent(
              harness.scope,
              harness.withdrawal.eventId,
            ),
            harness.withdrawal,
          );
          assert.deepEqual(
            await harness.repository.listReleasePolicyLifecycleEvents(
              harness.scope,
              harness.policy.policyVersionId,
            ),
            [harness.withdrawal],
          );
          assert.equal(
            await harness.repository.findReleasePolicyLifecycleEvent(
              harness.otherScope,
              harness.withdrawal.eventId,
            ),
            null,
          );
          assert.deepEqual(
            await harness.repository.listReleasePolicyLifecycleEvents(
              harness.otherScope,
              harness.policy.policyVersionId,
            ),
            [],
          );

          result.event.reason = "Caller mutation must not enter lifecycle state.";
          const listed = await harness.repository.listReleasePolicyLifecycleEvents(
            harness.scope,
            harness.policy.policyVersionId,
          );
          if (listed[0]) listed[0].reason = "Listed values must be isolated too.";
          assert.deepEqual(
            await harness.repository.findReleasePolicyLifecycleEvent(
              harness.scope,
              harness.withdrawal.eventId,
            ),
            harness.withdrawal,
          );
        });
      },
    },
    {
      name: "preserves the first lifecycle receipt and rejects event identifier rebinding",
      async run(factory) {
        await withHarness(factory, "policy_lifecycle_retry", async (harness) => {
          await harness.repository.publishReleasePolicy(harness.policy);
          await harness.repository.publishReleasePolicyLifecycleEvent(harness.withdrawal);
          const retryInput = structuredClone(harness.withdrawal);
          retryInput.actorPrincipalId = "principal_lifecycle_retry";
          retryInput.occurredAt = "2026-09-07T04:00:00.000Z";
          const retry = await harness.repository.publishReleasePolicyLifecycleEvent(retryInput);
          assert.equal(retry.created, false);
          assert.deepEqual(retry.event, harness.withdrawal);

          await assert.rejects(
            harness.repository.publishReleasePolicyLifecycleEvent(harness.eventConflict),
            ReleasePolicyLifecycleEventConflictError,
          );
          assert.deepEqual(
            await harness.repository.findReleasePolicyLifecycleEvent(
              harness.scope,
              harness.withdrawal.eventId,
            ),
            harness.withdrawal,
          );
        });
      },
    },
    {
      name: "rejects malformed, unavailable, and forged lifecycle targets without partial visibility",
      async run(factory) {
        await withHarness(factory, "policy_lifecycle_invalid", async (harness) => {
          await assert.rejects(
            harness.repository.publishReleasePolicyLifecycleEvent({
              ...harness.withdrawal,
              unexpected: true,
            } as never),
            InvalidReleasePolicyLifecycleInputError,
          );
          await assertEventAbsent(harness.repository, harness, harness.withdrawal.eventId);

          await assert.rejects(
            harness.repository.publishReleasePolicyLifecycleEvent(harness.withdrawal),
            ReleasePolicyLineageError,
          );
          await assertEventAbsent(harness.repository, harness, harness.withdrawal.eventId);

          await harness.repository.publishReleasePolicy(harness.policy);
          const forgedTarget = structuredClone(harness.withdrawal);
          forgedTarget.eventId = `${harness.withdrawal.eventId}_forged`;
          forgedTarget.policy.definitionSha256 = "a".repeat(64);
          await assert.rejects(
            harness.repository.publishReleasePolicyLifecycleEvent(forgedTarget),
            ReleasePolicyLineageError,
          );
          await assertEventAbsent(harness.repository, harness, forgedTarget.eventId);
        });
      },
    },
    {
      name: "accepts only an exact successor lineage and one terminal state",
      async run(factory) {
        await withHarness(factory, "policy_supersession", async (harness) => {
          await publishPolicyGraph(harness);
          const result = await harness.repository.publishReleasePolicyLifecycleEvent(
            harness.supersession,
          );
          assert.equal(result.created, true);
          assert.deepEqual(result.event, harness.supersession);
          await assert.rejects(
            harness.repository.publishReleasePolicyLifecycleEvent(harness.withdrawal),
            ReleasePolicyLifecycleStateConflictError,
          );
          await assertEventAbsent(harness.repository, harness, harness.withdrawal.eventId);

          const invalidHarness = await factory("policy_supersession_invalid");
          try {
            await invalidHarness.repository.publishReleasePolicy(invalidHarness.policy);
            await invalidHarness.repository.publishReleasePolicy(invalidHarness.unrelatedPolicy);
            const disguisedSuccessor = structuredClone(invalidHarness.supersession);
            disguisedSuccessor.successor = {
              ...reference(invalidHarness.unrelatedPolicy),
              policyId: invalidHarness.policy.policyId,
            };
            await assert.rejects(
              invalidHarness.repository.publishReleasePolicyLifecycleEvent(disguisedSuccessor),
              ReleasePolicyLineageError,
            );
            await assertEventAbsent(
              invalidHarness.repository,
              invalidHarness,
              disguisedSuccessor.eventId,
            );

            const detached = releasePolicyRepositoryFixture(
              "policy_supersession_invalid",
              invalidHarness.scope,
              {
                changeRationale: "Create a detached version that cannot supersede the target.",
                semanticVersion: "1.0.9",
              },
            );
            await invalidHarness.repository.publishReleasePolicy(detached);
            const detachedEvent = releasePolicyLifecycleFixture(
              "policy_supersession_detached",
              invalidHarness.policy,
              { kind: "superseded", successor: detached },
            );
            await assert.rejects(
              invalidHarness.repository.publishReleasePolicyLifecycleEvent(detachedEvent),
              ReleasePolicyLineageError,
            );
          } finally {
            await invalidHarness.dispose?.();
          }
        });
      },
    },
    {
      name: "rejects lifecycle timestamps before authoritative policy receipts",
      async run(factory) {
        await withHarness(factory, "policy_lifecycle_timeline", async (harness) => {
          await harness.repository.publishReleasePolicy(harness.policy);
          const early = releasePolicyLifecycleFixture("policy_lifecycle_early", harness.policy, {
            occurredAt: "2026-09-07T00:59:59.999Z",
          });
          await assert.rejects(
            harness.repository.publishReleasePolicyLifecycleEvent(early),
            InvalidReleasePolicyLifecycleInputError,
          );
          await assertEventAbsent(harness.repository, harness, early.eventId);

          await harness.repository.publishReleasePolicy(harness.successor);
          const earlySupersession = releasePolicyLifecycleFixture(
            "policy_lifecycle_early_successor",
            harness.policy,
            {
              kind: "superseded",
              occurredAt: "2026-09-07T01:30:00.000Z",
              successor: harness.successor,
            },
          );
          await assert.rejects(
            harness.repository.publishReleasePolicyLifecycleEvent(earlySupersession),
            InvalidReleasePolicyLifecycleInputError,
          );
          await assertEventAbsent(harness.repository, harness, earlySupersession.eventId);
        });
      },
    },
    {
      name: "linearizes concurrent identical and competing terminal lifecycle events",
      async run(factory) {
        await withHarness(factory, "policy_lifecycle_concurrency", async (harness) => {
          await harness.repository.publishReleasePolicy(harness.policy);
          const identical = await Promise.all(
            Array.from({ length: 16 }, () =>
              harness.repository.publishReleasePolicyLifecycleEvent(
                structuredClone(harness.withdrawal),
              ),
            ),
          );
          assert.equal(identical.filter(({ created }) => created).length, 1);

          const competingHarness = await factory("policy_lifecycle_competing");
          try {
            await publishPolicyGraph(competingHarness);
            const outcomes = await Promise.allSettled([
              competingHarness.repository.publishReleasePolicyLifecycleEvent(
                competingHarness.withdrawal,
              ),
              competingHarness.repository.publishReleasePolicyLifecycleEvent(
                competingHarness.supersession,
              ),
            ]);
            assert.equal(outcomes.filter(({ status }) => status === "fulfilled").length, 1);
            const rejected = outcomes.find(({ status }) => status === "rejected");
            assert.equal(rejected?.status, "rejected");
            if (rejected?.status === "rejected") {
              assert.ok(rejected.reason instanceof ReleasePolicyLifecycleStateConflictError);
            }
          } finally {
            await competingHarness.dispose?.();
          }
        });
      },
    },
  ];
