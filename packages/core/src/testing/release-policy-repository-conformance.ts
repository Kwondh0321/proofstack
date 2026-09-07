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
    ...(["withdrawn", "superseded"] as const).flatMap((kind) =>
      [
        { character: "a", label: "ascii" },
        { character: "가", label: "bmp" },
        { character: "😀", label: "astral" },
      ].flatMap(({ character, label }) =>
        [0, 1, 2048, 2049, 4096, 4097].map((length) => ({
          name: `preserves ${kind} reason bounds at ${length} ${label} Unicode scalars`,
          async run(factory: ReleasePolicyRepositoryTestFactory) {
            await withHarness(factory, `reason_${kind}_${label}_${length}`, async (harness) => {
              await publishPolicyGraph(harness);
              const event = {
                ...(kind === "withdrawn" ? harness.withdrawal : harness.supersession),
                reason: character.repeat(length),
              };
              if (length === 0 || length > 4096) {
                await assert.rejects(
                  harness.repository.publishReleasePolicyLifecycleEvent(event),
                  InvalidReleasePolicyLifecycleInputError,
                );
                await assertEventAbsent(harness.repository, harness, event.eventId);
                assert.deepEqual(
                  await harness.repository.listReleasePolicyLifecycleEvents(
                    harness.scope,
                    harness.policy.policyVersionId,
                  ),
                  [],
                );
                return;
              }
              assert.deepEqual(await harness.repository.publishReleasePolicyLifecycleEvent(event), {
                created: true,
                event,
              });
              assert.deepEqual(await harness.repository.publishReleasePolicyLifecycleEvent(event), {
                created: false,
                event,
              });
              assert.deepEqual(
                await harness.repository.findReleasePolicyLifecycleEvent(
                  harness.scope,
                  event.eventId,
                ),
                event,
              );
              assert.deepEqual(
                await harness.repository.listReleasePolicyLifecycleEvents(
                  harness.scope,
                  harness.policy.policyVersionId,
                ),
                [event],
              );
            });
          },
        })),
      ),
    ),
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
      name: "isolates colliding policy and lifecycle identities across three tenants",
      async run(factory) {
        await withHarness(factory, "policy_tenant_collision", async (harness) => {
          const repository = harness.repository;
          const graphs = ["alpha", "beta", "gamma"].map((label) => {
            const scope = { ...harness.scope, tenantId: `${harness.scope.tenantId}_${label}` };
            const policy = releasePolicyRepositoryFixture("shared_collision", scope);
            const successor = releasePolicyRepositoryFixture("shared_collision", scope, {
              predecessor: reference(policy),
              publishedAt: "2026-09-07T02:00:00.000Z",
              semanticVersion: "1.0.1",
            });
            const event = releasePolicyLifecycleFixture("shared_collision", policy, {
              kind: "superseded",
              successor,
            });
            return { event, policy, scope, successor };
          });
          assert.equal(new Set(graphs.map(({ policy }) => policy.policyId)).size, 1);
          assert.equal(new Set(graphs.map(({ policy }) => policy.policyVersionId)).size, 1);
          assert.equal(new Set(graphs.map(({ event }) => event.eventId)).size, 1);
          assert.equal(new Set(graphs.map(({ policy }) => policy.definitionSha256)).size, 3);

          for (const { policy, successor } of graphs) {
            assert.deepEqual(await repository.publishReleasePolicy(policy), {
              created: true,
              policy,
            });
            assert.deepEqual(await repository.publishReleasePolicy(successor), {
              created: true,
              policy: successor,
            });
          }

          for (const graph of graphs) {
            const { event, policy, scope, successor } = graph;
            for (const foreign of graphs.filter((value) => value !== graph)) {
              const forgedPredecessor = releasePolicyRepositoryFixture("shared_collision", scope, {
                predecessor: reference(foreign.policy),
                semanticVersion: "1.0.2",
              });
              await assert.rejects(
                repository.publishReleasePolicy(forgedPredecessor),
                ReleasePolicyLineageError,
              );
              assert.equal(
                await repository.findReleasePolicy(scope, forgedPredecessor.policyVersionId),
                null,
              );

              const forgedTarget = {
                ...event,
                eventId: "policy_collision_foreign_target",
                policy: reference(foreign.policy),
              };
              const forgedSuccessor = releasePolicyLifecycleFixture("foreign_successor", policy, {
                kind: "superseded",
                successor: foreign.successor,
              });
              for (const forged of [forgedTarget, forgedSuccessor]) {
                await assert.rejects(
                  repository.publishReleasePolicyLifecycleEvent(forged),
                  ReleasePolicyLineageError,
                );
                assert.equal(
                  await repository.findReleasePolicyLifecycleEvent(scope, forged.eventId),
                  null,
                );
              }
            }
            assert.deepEqual(
              await repository.listReleasePolicyLifecycleEvents(scope, policy.policyVersionId),
              [],
            );
            assert.deepEqual(await repository.publishReleasePolicyLifecycleEvent(event), {
              created: true,
              event,
            });
            assert.deepEqual(await repository.publishReleasePolicy(successor), {
              created: false,
              policy: successor,
            });
          }

          for (const { event, policy, scope, successor } of [...graphs].reverse()) {
            assert.deepEqual(
              await repository.findReleasePolicy(scope, policy.policyVersionId),
              policy,
            );
            assert.deepEqual(
              await repository.findReleasePolicy(scope, successor.policyVersionId),
              successor,
            );
            assert.deepEqual(
              await repository.findReleasePolicyLifecycleEvent(scope, event.eventId),
              event,
            );
            assert.deepEqual(
              await repository.listReleasePolicyLifecycleEvents(scope, policy.policyVersionId),
              [event],
            );
            assert.deepEqual(await repository.publishReleasePolicyLifecycleEvent(event), {
              created: false,
              event,
            });
            for (const hiddenScope of [
              { ...scope, tenantId: `${harness.scope.tenantId}_absent` },
              { ...scope, projectId: `${scope.projectId}_absent` },
              { ...scope, environmentId: `${scope.environmentId}_absent` },
            ]) {
              assert.equal(
                await repository.findReleasePolicy(hiddenScope, policy.policyVersionId),
                null,
              );
              assert.equal(
                await repository.findReleasePolicyLifecycleEvent(hiddenScope, event.eventId),
                null,
              );
              assert.deepEqual(
                await repository.listReleasePolicyLifecycleEvents(
                  hiddenScope,
                  policy.policyVersionId,
                ),
                [],
              );
            }
          }
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
          const offsets = [1, 2, 16, 1_024, 65_536, 86_400_000];
          for (const offset of offsets) {
            const early = releasePolicyLifecycleFixture(
              `timeline_early_${offset}`,
              harness.policy,
              {
                occurredAt: new Date(Date.parse(harness.policy.publishedAt) - offset).toISOString(),
              },
            );
            await assert.rejects(
              harness.repository.publishReleasePolicyLifecycleEvent(early),
              InvalidReleasePolicyLifecycleInputError,
            );
            await assertEventAbsent(harness.repository, harness, early.eventId);
          }

          await harness.repository.publishReleasePolicy(harness.successor);
          for (const offset of offsets) {
            const earlySupersession = releasePolicyLifecycleFixture(
              `timeline_successor_${offset}`,
              harness.policy,
              {
                kind: "superseded",
                occurredAt: new Date(
                  Date.parse(harness.successor.publishedAt) - offset,
                ).toISOString(),
                successor: harness.successor,
              },
            );
            await assert.rejects(
              harness.repository.publishReleasePolicyLifecycleEvent(earlySupersession),
              InvalidReleasePolicyLifecycleInputError,
            );
            await assertEventAbsent(harness.repository, harness, earlySupersession.eventId);
          }
          assert.deepEqual(
            await harness.repository.listReleasePolicyLifecycleEvents(
              harness.scope,
              harness.policy.policyVersionId,
            ),
            [],
          );
          const boundary = releasePolicyLifecycleFixture("timeline_inclusive", harness.policy, {
            kind: "superseded",
            occurredAt: harness.successor.publishedAt,
            successor: harness.successor,
          });
          assert.deepEqual(await harness.repository.publishReleasePolicyLifecycleEvent(boundary), {
            created: true,
            event: boundary,
          });
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
