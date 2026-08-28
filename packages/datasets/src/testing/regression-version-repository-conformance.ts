import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import type {
  EvidenceScope,
  RegressionDatasetPredecessor,
  RegressionDatasetVersion,
  RegressionDatasetVersionDefinition,
  RegressionFixturePredecessor,
  RegressionFixtureVersion,
  RegressionFixtureVersionDefinition,
  RegressionFixtureVersionReference,
} from "@proofstack/contracts";
import {
  RegressionDatasetVersionDefinitionSchema,
  RegressionDatasetVersionSchema,
  RegressionFixtureVersionDefinitionSchema,
  RegressionFixtureVersionSchema,
} from "@proofstack/contracts";
import {
  InvalidRegressionVersionInputError,
  RegressionVersionConflictError,
  RegressionVersionLineageError,
} from "../errors.js";
import {
  buildRegressionDatasetVersionPublishedOutboxIntent,
  buildRegressionFixtureVersionPublishedOutboxIntent,
  REGRESSION_DATASET_VERSION_PUBLISHED_EVENT_TYPE,
  REGRESSION_FIXTURE_VERSION_PUBLISHED_EVENT_TYPE,
  type RegressionVersionPublishedOutboxIntent,
} from "../regression-publication-outbox.js";
import {
  digestRegressionDatasetVersionDefinition,
  digestRegressionFixtureVersionDefinition,
} from "../regression-definition-digest.js";
import type { RegressionVersionRepository } from "../regression-version-repository.js";
import type { RegressionVersionPublicationKind } from "./regression-version-repository-test-control.js";

const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";

export interface RegressionVersionRepositoryTestHarness {
  readonly dispose?: () => Promise<void>;
  readonly failNextPublicationIntent: (
    kind: RegressionVersionPublicationKind,
  ) => Promise<void> | void;
  readonly publishedIntents: (
    tenantId: string,
  ) => Promise<readonly RegressionVersionPublishedOutboxIntent[]>;
  readonly repository: RegressionVersionRepository;
}

export type RegressionVersionRepositoryTestFactory = (
  namespace: string,
) => Promise<RegressionVersionRepositoryTestHarness> | RegressionVersionRepositoryTestHarness;

export interface RegressionVersionRepositoryConformanceCase {
  readonly name: string;
  readonly run: (factory: RegressionVersionRepositoryTestFactory) => Promise<void>;
}

interface FixtureOptions {
  readonly capturedAt?: string;
  readonly createdAt?: string;
  readonly createdByPrincipalId?: string;
  readonly description?: string;
  readonly eventIds?: readonly string[];
  readonly fixtureId?: string;
  readonly fixtureVersionId?: string;
  readonly name?: string;
  readonly predecessor?: RegressionFixturePredecessor;
  readonly scope?: EvidenceScope;
}

interface DatasetOptions {
  readonly createdAt?: string;
  readonly createdByPrincipalId?: string;
  readonly datasetId?: string;
  readonly datasetVersionId?: string;
  readonly description?: string;
  readonly fixtureVersions: readonly RegressionFixtureVersionReference[];
  readonly name?: string;
  readonly predecessor?: RegressionDatasetPredecessor;
  readonly scope?: EvidenceScope;
}

function scope(namespace: string, overrides: Partial<EvidenceScope> = {}): EvidenceScope {
  return {
    environmentId: `env_${namespace}`,
    projectId: `prj_${namespace}`,
    tenantId: `ten_${namespace}`,
    ...overrides,
  };
}

function fixture(namespace: string, options: FixtureOptions = {}): RegressionFixtureVersion {
  const eventIds = options.eventIds ?? [`evt_${namespace}_start`, `evt_${namespace}_failure`];
  const definition = RegressionFixtureVersionDefinitionSchema.parse({
    description: options.description ?? `Observed regression fixture ${namespace}`,
    fixtureId: options.fixtureId ?? `fix_${namespace}`,
    fixtureVersionId: options.fixtureVersionId ?? `fixv_${namespace}_001`,
    name: options.name ?? `Fixture ${namespace}`,
    ...(options.predecessor ? { predecessor: options.predecessor } : {}),
    replayability: "evidence_only",
    schemaVersion: "0.1",
    scope: options.scope ?? scope(namespace),
    source: {
      eventIds: [...eventIds],
      kind: "trace_snapshot",
      observedEventCount: eventIds.length,
      sourceCompleteness: "observed_snapshot",
      traceId: TRACE_ID,
    },
  } satisfies RegressionFixtureVersionDefinition);

  return RegressionFixtureVersionSchema.parse({
    createdAt: options.createdAt ?? "2026-08-29T01:01:00.123Z",
    createdByPrincipalId: options.createdByPrincipalId ?? `usr_${namespace}`,
    definitionSha256: digestRegressionFixtureVersionDefinition(definition),
    ...definition,
    source: {
      capturedAt: options.capturedAt ?? "2026-08-29T01:00:30.000Z",
      ...definition.source,
    },
  });
}

function reference(version: RegressionFixtureVersion): RegressionFixtureVersionReference {
  return {
    definitionSha256: version.definitionSha256,
    fixtureId: version.fixtureId,
    fixtureVersionId: version.fixtureVersionId,
  };
}

function dataset(namespace: string, options: DatasetOptions): RegressionDatasetVersion {
  const definition = RegressionDatasetVersionDefinitionSchema.parse({
    datasetId: options.datasetId ?? `dat_${namespace}`,
    datasetVersionId: options.datasetVersionId ?? `datv_${namespace}_001`,
    description: options.description ?? `Observed regression dataset ${namespace}`,
    fixtureVersions: [...options.fixtureVersions],
    name: options.name ?? `Dataset ${namespace}`,
    ...(options.predecessor ? { predecessor: options.predecessor } : {}),
    schemaVersion: "0.1",
    scope: options.scope ?? scope(namespace),
  } satisfies RegressionDatasetVersionDefinition);

  return RegressionDatasetVersionSchema.parse({
    createdAt: options.createdAt ?? "2026-08-29T01:02:00.987Z",
    createdByPrincipalId: options.createdByPrincipalId ?? `usr_${namespace}`,
    definitionSha256: digestRegressionDatasetVersionDefinition(definition),
    ...definition,
  });
}

async function withHarness(
  factory: RegressionVersionRepositoryTestFactory,
  namespace: string,
  test: (harness: RegressionVersionRepositoryTestHarness) => Promise<void>,
): Promise<void> {
  const harness = await factory(namespace);
  try {
    await test(harness);
  } finally {
    await harness.dispose?.();
  }
}

function eventCount(
  intents: readonly RegressionVersionPublishedOutboxIntent[],
  eventType: RegressionVersionPublishedOutboxIntent["eventType"],
): number {
  return intents.filter((intent) => intent.eventType === eventType).length;
}

function assertCanonicalRaceIntents(
  intents: readonly RegressionVersionPublishedOutboxIntent[],
  eventType: RegressionVersionPublishedOutboxIntent["eventType"],
  winnerIntent: RegressionVersionPublishedOutboxIntent,
  loserIntent: RegressionVersionPublishedOutboxIntent,
  expectedIntentCount: number,
): void {
  const sameKind = intents.filter((intent) => intent.eventType === eventType);
  assert.equal(sameKind.length, expectedIntentCount);
  assert.equal(sameKind.filter((intent) => isDeepStrictEqual(intent, winnerIntent)).length, 1);
  assert.equal(sameKind.filter((intent) => isDeepStrictEqual(intent, loserIntent)).length, 0);
}

function assertOneFailure(
  results: readonly PromiseSettledResult<unknown>[],
  ErrorType: new () => Error,
): {
  readonly loserIndex: number;
  readonly winnerIndex: number;
} {
  assert.equal(results.length, 2);
  const winnerIndex = results.findIndex(({ status }) => status === "fulfilled");
  const loserIndex = results.findIndex(({ status }) => status === "rejected");
  assert.equal(results.filter(({ status }) => status === "fulfilled").length, 1);
  const failure = results[loserIndex];
  assert.ok(failure?.status === "rejected");
  assert.ok(failure.reason instanceof ErrorType);
  assert.notEqual(winnerIndex, -1);
  assert.notEqual(loserIndex, -1);
  return { loserIndex, winnerIndex };
}

function assertOneConflict(results: readonly PromiseSettledResult<unknown>[]): {
  readonly loserIndex: number;
  readonly winnerIndex: number;
} {
  return assertOneFailure(results, RegressionVersionConflictError);
}

async function assertFixtureRaceEffects(
  repository: RegressionVersionRepository,
  publishedIntents: RegressionVersionRepositoryTestHarness["publishedIntents"],
  candidates: readonly RegressionFixtureVersion[],
  results: readonly PromiseSettledResult<unknown>[],
  expectedIntentCount: number,
): Promise<void> {
  const { loserIndex, winnerIndex } = assertOneConflict(results);
  const winner = candidates[winnerIndex];
  const loser = candidates[loserIndex];
  assert.ok(winner);
  assert.ok(loser);
  assert.deepEqual(
    await repository.findFixtureVersion(winner.scope, winner.fixtureVersionId),
    winner,
  );
  assert.equal(await repository.fixtureResourceExists(winner.scope, winner.fixtureId), true);
  assert.equal(await repository.findFixtureVersion(loser.scope, loser.fixtureVersionId), null);
  assert.equal(await repository.fixtureResourceExists(loser.scope, loser.fixtureId), false);

  assertCanonicalRaceIntents(
    await publishedIntents(winner.scope.tenantId),
    REGRESSION_FIXTURE_VERSION_PUBLISHED_EVENT_TYPE,
    buildRegressionFixtureVersionPublishedOutboxIntent(winner),
    buildRegressionFixtureVersionPublishedOutboxIntent(loser),
    expectedIntentCount,
  );
}

async function assertDatasetRaceEffects(
  repository: RegressionVersionRepository,
  publishedIntents: RegressionVersionRepositoryTestHarness["publishedIntents"],
  candidates: readonly RegressionDatasetVersion[],
  results: readonly PromiseSettledResult<unknown>[],
  expectedIntentCount: number,
): Promise<void> {
  const { loserIndex, winnerIndex } = assertOneConflict(results);
  const winner = candidates[winnerIndex];
  const loser = candidates[loserIndex];
  assert.ok(winner);
  assert.ok(loser);
  assert.deepEqual(
    await repository.findDatasetVersion(winner.scope, winner.datasetVersionId),
    winner,
  );
  assert.equal(await repository.datasetResourceExists(winner.scope, winner.datasetId), true);
  assert.equal(await repository.findDatasetVersion(loser.scope, loser.datasetVersionId), null);
  assert.equal(await repository.datasetResourceExists(loser.scope, loser.datasetId), false);

  assertCanonicalRaceIntents(
    await publishedIntents(winner.scope.tenantId),
    REGRESSION_DATASET_VERSION_PUBLISHED_EVENT_TYPE,
    buildRegressionDatasetVersionPublishedOutboxIntent(winner),
    buildRegressionDatasetVersionPublishedOutboxIntent(loser),
    expectedIntentCount,
  );
}

export const regressionVersionRepositoryConformanceCases: readonly RegressionVersionRepositoryConformanceCase[] =
  [
    {
      name: "publishes one fixture root with exact scoped reads and one locator intent",
      async run(factory) {
        await withHarness(factory, "fx_scope", async ({ publishedIntents, repository }) => {
          const candidate = fixture("fx_scope");
          const published = await repository.publishFixtureVersion(candidate);

          assert.equal(published.created, true);
          assert.deepEqual(published.version, candidate);
          assert.deepEqual(
            await repository.findFixtureVersion(candidate.scope, candidate.fixtureVersionId),
            candidate,
          );
          assert.equal(
            await repository.fixtureResourceExists(candidate.scope, candidate.fixtureId),
            true,
          );
          for (const hiddenScope of [
            { ...candidate.scope, tenantId: "ten_hidden" },
            { ...candidate.scope, projectId: "prj_hidden" },
            { ...candidate.scope, environmentId: "env_hidden" },
          ]) {
            assert.equal(
              await repository.findFixtureVersion(hiddenScope, candidate.fixtureVersionId),
              null,
            );
            assert.equal(
              await repository.fixtureResourceExists(hiddenScope, candidate.fixtureId),
              false,
            );
          }
          assert.deepEqual(await publishedIntents(candidate.scope.tenantId), [
            buildRegressionFixtureVersionPublishedOutboxIntent(candidate),
          ]);
          assert.deepEqual(await publishedIntents("ten_missing"), []);
        });
      },
    },
    {
      name: "resolves authoritative fixture references in order and publishes one dataset root",
      async run(factory) {
        await withHarness(factory, "ds_order", async ({ publishedIntents, repository }) => {
          const sharedScope = scope("ds_order");
          const first = fixture("ds_order_a", { scope: sharedScope });
          const second = fixture("ds_order_b", { scope: sharedScope });
          await repository.publishFixtureVersion(first);
          await repository.publishFixtureVersion(second);

          const requested = [
            { fixtureId: second.fixtureId, fixtureVersionId: second.fixtureVersionId },
            { fixtureId: first.fixtureId, fixtureVersionId: first.fixtureVersionId },
          ];
          const resolved = await repository.resolveFixtureVersionReferences(sharedScope, requested);
          assert.deepEqual(resolved, [reference(second), reference(first)]);
          assert.ok(resolved);

          const candidate = dataset("ds_order", {
            fixtureVersions: resolved,
          });
          const published = await repository.publishDatasetVersion(candidate);
          assert.equal(published.created, true);
          assert.deepEqual(published.version.fixtureVersions, [
            reference(second),
            reference(first),
          ]);
          assert.deepEqual(
            await repository.findDatasetVersion(sharedScope, candidate.datasetVersionId),
            candidate,
          );
          assert.equal(
            await repository.datasetResourceExists(sharedScope, candidate.datasetId),
            true,
          );
          for (const hiddenScope of [
            { ...sharedScope, tenantId: "ten_hidden" },
            { ...sharedScope, projectId: "prj_hidden" },
            { ...sharedScope, environmentId: "env_hidden" },
          ]) {
            assert.equal(
              await repository.findDatasetVersion(hiddenScope, candidate.datasetVersionId),
              null,
            );
            assert.equal(
              await repository.datasetResourceExists(hiddenScope, candidate.datasetId),
              false,
            );
          }
          await assert.rejects(
            repository.publishDatasetVersion(
              dataset("ds_order", {
                fixtureVersions: [reference(first), reference(second)],
              }),
            ),
            RegressionVersionConflictError,
          );
          assert.deepEqual(
            await repository.findDatasetVersion(sharedScope, candidate.datasetVersionId),
            candidate,
          );
          assert.equal(
            eventCount(
              await publishedIntents(sharedScope.tenantId),
              REGRESSION_DATASET_VERSION_PUBLISHED_EVENT_TYPE,
            ),
            1,
          );
          assert.deepEqual(
            (await publishedIntents(sharedScope.tenantId)).find(
              ({ eventType }) => eventType === REGRESSION_DATASET_VERSION_PUBLISHED_EVENT_TYPE,
            ),
            buildRegressionDatasetVersionPublishedOutboxIntent(candidate),
          );
        });
      },
    },
    {
      name: "returns original fixture and dataset provenance for canonical-byte retries",
      async run(factory) {
        await withHarness(factory, "retry", async ({ publishedIntents, repository }) => {
          const sharedScope = scope("retry");
          const originalFixture = fixture("retry_fixture", { scope: sharedScope });
          const fixtureRetry = fixture("retry_fixture", {
            capturedAt: "2026-08-29T01:00:45.000Z",
            createdAt: "2026-08-29T01:03:00.000Z",
            createdByPrincipalId: "usr_retry_fixture",
            scope: sharedScope,
          });
          const fixtureFirst = await repository.publishFixtureVersion(originalFixture);
          await assert.rejects(
            repository.publishFixtureVersion({
              ...originalFixture,
              createdAt: "not-a-timestamp",
              unknown: true,
            } as RegressionFixtureVersion),
            InvalidRegressionVersionInputError,
          );
          const fixtureSecond = await repository.publishFixtureVersion(fixtureRetry);
          assert.equal(fixtureFirst.created, true);
          assert.deepEqual(fixtureSecond, { created: false, version: originalFixture });
          fixtureSecond.version.scope.projectId = "prj_mutated_retry_result";
          fixtureSecond.version.source.eventIds[0] = "evt_mutated_retry_result";
          assert.deepEqual(
            await repository.findFixtureVersion(sharedScope, originalFixture.fixtureVersionId),
            originalFixture,
          );

          const fixtureChildPredecessor = {
            definitionSha256: originalFixture.definitionSha256,
            fixtureVersionId: originalFixture.fixtureVersionId,
          };
          const originalFixtureChild = fixture("retry_fixture_child", {
            fixtureId: originalFixture.fixtureId,
            fixtureVersionId: "fixv_retry_fixture_child",
            predecessor: fixtureChildPredecessor,
            scope: sharedScope,
          });
          const fixtureChildRetry = fixture("retry_fixture_child", {
            capturedAt: "2026-08-29T01:00:50.000Z",
            createdAt: "2026-08-29T01:03:30.000Z",
            createdByPrincipalId: "usr_retry_fixture_child",
            fixtureId: originalFixture.fixtureId,
            fixtureVersionId: originalFixtureChild.fixtureVersionId,
            predecessor: fixtureChildPredecessor,
            scope: sharedScope,
          });
          assert.equal(
            (await repository.publishFixtureVersion(originalFixtureChild)).created,
            true,
          );
          const fixtureChildResult = await repository.publishFixtureVersion(fixtureChildRetry);
          assert.deepEqual(fixtureChildResult, {
            created: false,
            version: originalFixtureChild,
          });
          assert.ok(fixtureChildResult.version.predecessor);
          fixtureChildResult.version.scope.environmentId = "env_mutated_retry_result";
          fixtureChildResult.version.predecessor.fixtureVersionId = "fixv_mutated_retry_result";
          assert.deepEqual(
            await repository.findFixtureVersion(sharedScope, originalFixtureChild.fixtureVersionId),
            originalFixtureChild,
          );

          const originalDataset = dataset("retry_dataset", {
            fixtureVersions: [reference(originalFixture)],
            scope: sharedScope,
          });
          const datasetRetry = dataset("retry_dataset", {
            createdAt: "2026-08-29T01:04:00.000Z",
            createdByPrincipalId: "usr_retry_dataset",
            fixtureVersions: [reference(originalFixture)],
            scope: sharedScope,
          });
          const datasetFirst = await repository.publishDatasetVersion(originalDataset);
          await assert.rejects(
            repository.publishDatasetVersion({
              ...originalDataset,
              createdAt: "not-a-timestamp",
              unknown: true,
            } as RegressionDatasetVersion),
            InvalidRegressionVersionInputError,
          );
          const datasetSecond = await repository.publishDatasetVersion(datasetRetry);
          assert.equal(datasetFirst.created, true);
          assert.deepEqual(datasetSecond, { created: false, version: originalDataset });
          const retryMember = datasetSecond.version.fixtureVersions[0];
          assert.ok(retryMember);
          retryMember.fixtureId = "fix_mutated_retry_result";
          datasetSecond.version.scope.environmentId = "env_mutated_retry_result";
          assert.deepEqual(
            await repository.findDatasetVersion(sharedScope, originalDataset.datasetVersionId),
            originalDataset,
          );

          const datasetChildPredecessor = {
            datasetVersionId: originalDataset.datasetVersionId,
            definitionSha256: originalDataset.definitionSha256,
          };
          const originalDatasetChild = dataset("retry_dataset_child", {
            datasetId: originalDataset.datasetId,
            datasetVersionId: "datv_retry_dataset_child",
            fixtureVersions: [reference(originalFixture)],
            predecessor: datasetChildPredecessor,
            scope: sharedScope,
          });
          const datasetChildRetry = dataset("retry_dataset_child", {
            createdAt: "2026-08-29T01:04:30.000Z",
            createdByPrincipalId: "usr_retry_dataset_child",
            datasetId: originalDataset.datasetId,
            datasetVersionId: originalDatasetChild.datasetVersionId,
            fixtureVersions: [reference(originalFixture)],
            predecessor: datasetChildPredecessor,
            scope: sharedScope,
          });
          assert.equal(
            (await repository.publishDatasetVersion(originalDatasetChild)).created,
            true,
          );
          const datasetChildResult = await repository.publishDatasetVersion(datasetChildRetry);
          assert.deepEqual(datasetChildResult, {
            created: false,
            version: originalDatasetChild,
          });
          const childRetryMember = datasetChildResult.version.fixtureVersions[0];
          assert.ok(childRetryMember);
          assert.ok(datasetChildResult.version.predecessor);
          childRetryMember.fixtureVersionId = "fixv_mutated_retry_result";
          datasetChildResult.version.scope.projectId = "prj_mutated_retry_result";
          datasetChildResult.version.predecessor.datasetVersionId = "datv_mutated_retry_result";
          assert.deepEqual(
            await repository.findDatasetVersion(sharedScope, originalDatasetChild.datasetVersionId),
            originalDatasetChild,
          );

          const intents = await publishedIntents(sharedScope.tenantId);
          assert.equal(eventCount(intents, REGRESSION_FIXTURE_VERSION_PUBLISHED_EVENT_TYPE), 2);
          assert.equal(eventCount(intents, REGRESSION_DATASET_VERSION_PUBLISHED_EVENT_TYPE), 2);
          for (const expected of [
            buildRegressionFixtureVersionPublishedOutboxIntent(originalFixture),
            buildRegressionFixtureVersionPublishedOutboxIntent(originalFixtureChild),
            buildRegressionDatasetVersionPublishedOutboxIntent(originalDataset),
            buildRegressionDatasetVersionPublishedOutboxIntent(originalDatasetChild),
          ]) {
            assert.equal(intents.filter((intent) => isDeepStrictEqual(intent, expected)).length, 1);
          }
        });
      },
    },
    {
      name: "binds logical and version identities tenant-wide while allowing other tenants",
      async run(factory) {
        await withHarness(factory, "identity", async ({ publishedIntents, repository }) => {
          const originalScope = scope("identity");
          const otherProject = { ...originalScope, projectId: "prj_other" };
          const root = fixture("identity_fixture", { scope: originalScope });
          await repository.publishFixtureVersion(root);
          await assert.rejects(
            repository.publishFixtureVersion(
              fixture("identity_fixture", { name: "Different semantics", scope: originalScope }),
            ),
            RegressionVersionConflictError,
          );
          await assert.rejects(
            repository.publishFixtureVersion(
              fixture("identity_other_fixture", {
                fixtureVersionId: root.fixtureVersionId,
                scope: originalScope,
              }),
            ),
            RegressionVersionConflictError,
          );
          await assert.rejects(
            repository.publishFixtureVersion(
              fixture("identity_fixture", {
                fixtureVersionId: "fixv_identity_fixture_002",
                scope: originalScope,
              }),
            ),
            RegressionVersionLineageError,
          );
          await assert.rejects(
            repository.publishFixtureVersion(
              fixture("identity_fixture", {
                fixtureVersionId: "fixv_identity_fixture_003",
                scope: otherProject,
              }),
            ),
            RegressionVersionConflictError,
          );
          await assert.rejects(
            repository.publishFixtureVersion(fixture("identity_fixture", { scope: otherProject })),
            RegressionVersionConflictError,
          );

          const otherTenantScope = { ...originalScope, tenantId: "ten_other" };
          const otherTenantRoot = fixture("identity_fixture", { scope: otherTenantScope });
          assert.equal((await repository.publishFixtureVersion(otherTenantRoot)).created, true);

          const member = fixture("identity_member", { scope: originalScope });
          await repository.publishFixtureVersion(member);
          const originalDataset = dataset("identity_dataset", {
            fixtureVersions: [reference(member)],
            scope: originalScope,
          });
          await repository.publishDatasetVersion(originalDataset);
          await assert.rejects(
            repository.publishDatasetVersion(
              dataset("identity_dataset", {
                fixtureVersions: [reference(member)],
                name: "Different dataset semantics",
                scope: originalScope,
              }),
            ),
            RegressionVersionConflictError,
          );
          await assert.rejects(
            repository.publishDatasetVersion(
              dataset("identity_other_dataset", {
                datasetVersionId: originalDataset.datasetVersionId,
                fixtureVersions: [reference(member)],
                scope: originalScope,
              }),
            ),
            RegressionVersionConflictError,
          );
          await assert.rejects(
            repository.publishDatasetVersion(
              dataset("identity_dataset", {
                datasetVersionId: "datv_identity_dataset_002",
                fixtureVersions: [reference(member)],
                scope: originalScope,
              }),
            ),
            RegressionVersionLineageError,
          );
          await assert.rejects(
            repository.publishDatasetVersion(
              dataset("identity_dataset", {
                datasetVersionId: "datv_identity_dataset_003",
                fixtureVersions: [reference(member)],
                scope: otherProject,
              }),
            ),
            RegressionVersionConflictError,
          );

          const otherTenantMember = fixture("identity_member", { scope: otherTenantScope });
          await repository.publishFixtureVersion(otherTenantMember);
          const otherTenantDataset = dataset("identity_dataset", {
            fixtureVersions: [reference(otherTenantMember)],
            scope: otherTenantScope,
          });
          assert.equal((await repository.publishDatasetVersion(otherTenantDataset)).created, true);

          const originalTenantIntents = await publishedIntents(originalScope.tenantId);
          const otherTenantIntents = await publishedIntents(otherTenantScope.tenantId);
          const expectedOriginalIntents = [
            buildRegressionFixtureVersionPublishedOutboxIntent(root),
            buildRegressionFixtureVersionPublishedOutboxIntent(member),
            buildRegressionDatasetVersionPublishedOutboxIntent(originalDataset),
          ];
          const expectedOtherTenantIntents = [
            buildRegressionFixtureVersionPublishedOutboxIntent(otherTenantRoot),
            buildRegressionFixtureVersionPublishedOutboxIntent(otherTenantMember),
            buildRegressionDatasetVersionPublishedOutboxIntent(otherTenantDataset),
          ];
          assert.equal(originalTenantIntents.length, expectedOriginalIntents.length);
          assert.equal(otherTenantIntents.length, expectedOtherTenantIntents.length);
          for (const expected of expectedOriginalIntents) {
            assert.equal(
              originalTenantIntents.filter((intent) => isDeepStrictEqual(intent, expected)).length,
              1,
            );
          }
          for (const expected of expectedOtherTenantIntents) {
            assert.equal(
              otherTenantIntents.filter((intent) => isDeepStrictEqual(intent, expected)).length,
              1,
            );
          }
        });
      },
    },
    {
      name: "enforces exact fixture lineage while allowing sibling branches",
      async run(factory) {
        await withHarness(factory, "fx_lineage", async ({ publishedIntents, repository }) => {
          const sharedScope = scope("fx_lineage");
          const root = fixture("fx_lineage_root", {
            fixtureId: "fix_lineage",
            fixtureVersionId: "fixv_lineage_root",
            scope: sharedScope,
          });
          const otherRoot = fixture("fx_lineage_other", { scope: sharedScope });
          const otherScopeRoot = fixture("fx_lineage_remote", {
            scope: { ...sharedScope, projectId: "prj_remote" },
          });
          await repository.publishFixtureVersion(root);
          await repository.publishFixtureVersion(otherRoot);
          await repository.publishFixtureVersion(otherScopeRoot);

          const missingResourceCandidate = fixture("fx_lineage_missing_resource", {
            predecessor: {
              definitionSha256: root.definitionSha256,
              fixtureVersionId: root.fixtureVersionId,
            },
            scope: sharedScope,
          });
          await assert.rejects(
            repository.publishFixtureVersion(missingResourceCandidate),
            RegressionVersionLineageError,
          );
          assert.equal(
            await repository.fixtureResourceExists(sharedScope, missingResourceCandidate.fixtureId),
            false,
          );
          assert.equal(
            await repository.findFixtureVersion(
              sharedScope,
              missingResourceCandidate.fixtureVersionId,
            ),
            null,
          );
          assert.equal(
            eventCount(
              await publishedIntents(sharedScope.tenantId),
              REGRESSION_FIXTURE_VERSION_PUBLISHED_EVENT_TYPE,
            ),
            3,
          );
          for (const predecessor of [
            { definitionSha256: "f".repeat(64), fixtureVersionId: root.fixtureVersionId },
            {
              definitionSha256: otherRoot.definitionSha256,
              fixtureVersionId: otherRoot.fixtureVersionId,
            },
            {
              definitionSha256: otherScopeRoot.definitionSha256,
              fixtureVersionId: otherScopeRoot.fixtureVersionId,
            },
            { definitionSha256: root.definitionSha256, fixtureVersionId: "fixv_missing" },
          ]) {
            await assert.rejects(
              repository.publishFixtureVersion(
                fixture("fx_lineage_child", {
                  fixtureId: root.fixtureId,
                  fixtureVersionId: `fixv_lineage_bad_${predecessor.fixtureVersionId}`.slice(0, 63),
                  predecessor,
                  scope: sharedScope,
                }),
              ),
              RegressionVersionLineageError,
            );
          }

          const predecessor = {
            definitionSha256: root.definitionSha256,
            fixtureVersionId: root.fixtureVersionId,
          };
          const firstChild = fixture("fx_lineage_child_a", {
            fixtureId: root.fixtureId,
            fixtureVersionId: "fixv_lineage_child_a",
            predecessor,
            scope: sharedScope,
          });
          const secondChild = fixture("fx_lineage_child_b", {
            fixtureId: root.fixtureId,
            fixtureVersionId: "fixv_lineage_child_b",
            predecessor,
            scope: sharedScope,
          });
          assert.equal((await repository.publishFixtureVersion(firstChild)).created, true);
          assert.equal((await repository.publishFixtureVersion(secondChild)).created, true);
          assert.deepEqual(
            await repository.findFixtureVersion(sharedScope, root.fixtureVersionId),
            root,
          );
        });
      },
    },
    {
      name: "leaves no version, resource, or intent after identity and lineage failures",
      async run(factory) {
        await withHarness(
          factory,
          "failure_atomicity",
          async ({ publishedIntents, repository }) => {
            const sharedScope = scope("failure_atomicity");
            const fixtureRoot = fixture("failure_atomicity_fixture", { scope: sharedScope });
            await repository.publishFixtureVersion(fixtureRoot);

            const reusedFixtureVersion = fixture("failure_atomicity_other_fixture", {
              fixtureVersionId: fixtureRoot.fixtureVersionId,
              scope: sharedScope,
            });
            await assert.rejects(
              repository.publishFixtureVersion(reusedFixtureVersion),
              RegressionVersionConflictError,
            );
            assert.equal(
              await repository.fixtureResourceExists(sharedScope, reusedFixtureVersion.fixtureId),
              false,
            );

            const fixtureSecondRoot = fixture("failure_atomicity_second_root", {
              fixtureId: fixtureRoot.fixtureId,
              fixtureVersionId: "fixv_failure_atomicity_second_root",
              scope: sharedScope,
            });
            await assert.rejects(
              repository.publishFixtureVersion(fixtureSecondRoot),
              RegressionVersionLineageError,
            );
            assert.equal(
              await repository.findFixtureVersion(sharedScope, fixtureSecondRoot.fixtureVersionId),
              null,
            );

            const fixtureBadPredecessor = fixture("failure_atomicity_bad_predecessor", {
              fixtureId: fixtureRoot.fixtureId,
              fixtureVersionId: "fixv_failure_atomicity_bad_predecessor",
              predecessor: {
                definitionSha256: "f".repeat(64),
                fixtureVersionId: fixtureRoot.fixtureVersionId,
              },
              scope: sharedScope,
            });
            await assert.rejects(
              repository.publishFixtureVersion(fixtureBadPredecessor),
              RegressionVersionLineageError,
            );
            assert.equal(
              await repository.findFixtureVersion(
                sharedScope,
                fixtureBadPredecessor.fixtureVersionId,
              ),
              null,
            );
            assert.equal(
              eventCount(
                await publishedIntents(sharedScope.tenantId),
                REGRESSION_FIXTURE_VERSION_PUBLISHED_EVENT_TYPE,
              ),
              1,
            );

            const datasetRoot = dataset("failure_atomicity_dataset", {
              fixtureVersions: [reference(fixtureRoot)],
              scope: sharedScope,
            });
            await repository.publishDatasetVersion(datasetRoot);

            const reusedDatasetVersion = dataset("failure_atomicity_other_dataset", {
              datasetVersionId: datasetRoot.datasetVersionId,
              fixtureVersions: [reference(fixtureRoot)],
              scope: sharedScope,
            });
            await assert.rejects(
              repository.publishDatasetVersion(reusedDatasetVersion),
              RegressionVersionConflictError,
            );
            assert.equal(
              await repository.datasetResourceExists(sharedScope, reusedDatasetVersion.datasetId),
              false,
            );

            const datasetSecondRoot = dataset("failure_atomicity_dataset_second_root", {
              datasetId: datasetRoot.datasetId,
              datasetVersionId: "datv_failure_atomicity_second_root",
              fixtureVersions: [reference(fixtureRoot)],
              scope: sharedScope,
            });
            await assert.rejects(
              repository.publishDatasetVersion(datasetSecondRoot),
              RegressionVersionLineageError,
            );
            assert.equal(
              await repository.findDatasetVersion(sharedScope, datasetSecondRoot.datasetVersionId),
              null,
            );

            const datasetBadPredecessor = dataset("failure_atomicity_dataset_bad_predecessor", {
              datasetId: datasetRoot.datasetId,
              datasetVersionId: "datv_failure_atomicity_bad_predecessor",
              fixtureVersions: [reference(fixtureRoot)],
              predecessor: {
                datasetVersionId: datasetRoot.datasetVersionId,
                definitionSha256: "f".repeat(64),
              },
              scope: sharedScope,
            });
            await assert.rejects(
              repository.publishDatasetVersion(datasetBadPredecessor),
              RegressionVersionLineageError,
            );
            assert.equal(
              await repository.findDatasetVersion(
                sharedScope,
                datasetBadPredecessor.datasetVersionId,
              ),
              null,
            );
            assert.equal(
              eventCount(
                await publishedIntents(sharedScope.tenantId),
                REGRESSION_DATASET_VERSION_PUBLISHED_EVENT_TYPE,
              ),
              1,
            );
          },
        );
      },
    },
    {
      name: "enforces exact dataset lineage while allowing sibling branches",
      async run(factory) {
        await withHarness(factory, "ds_lineage", async ({ publishedIntents, repository }) => {
          const sharedScope = scope("ds_lineage");
          const member = fixture("ds_lineage_member", { scope: sharedScope });
          await repository.publishFixtureVersion(member);
          const root = dataset("ds_lineage_root", {
            datasetId: "dat_lineage",
            datasetVersionId: "datv_lineage_root",
            fixtureVersions: [reference(member)],
            scope: sharedScope,
          });
          const otherRoot = dataset("ds_lineage_other", {
            fixtureVersions: [reference(member)],
            scope: sharedScope,
          });
          await repository.publishDatasetVersion(root);
          await repository.publishDatasetVersion(otherRoot);

          const missingResourceCandidate = dataset("ds_lineage_missing_resource", {
            fixtureVersions: [reference(member)],
            predecessor: {
              datasetVersionId: root.datasetVersionId,
              definitionSha256: root.definitionSha256,
            },
            scope: sharedScope,
          });
          await assert.rejects(
            repository.publishDatasetVersion(missingResourceCandidate),
            RegressionVersionLineageError,
          );
          assert.equal(
            await repository.datasetResourceExists(sharedScope, missingResourceCandidate.datasetId),
            false,
          );
          assert.equal(
            await repository.findDatasetVersion(
              sharedScope,
              missingResourceCandidate.datasetVersionId,
            ),
            null,
          );
          assert.equal(
            eventCount(
              await publishedIntents(sharedScope.tenantId),
              REGRESSION_DATASET_VERSION_PUBLISHED_EVENT_TYPE,
            ),
            2,
          );
          for (const predecessor of [
            { datasetVersionId: root.datasetVersionId, definitionSha256: "f".repeat(64) },
            {
              datasetVersionId: otherRoot.datasetVersionId,
              definitionSha256: otherRoot.definitionSha256,
            },
            { datasetVersionId: "datv_missing", definitionSha256: root.definitionSha256 },
          ]) {
            await assert.rejects(
              repository.publishDatasetVersion(
                dataset("ds_lineage_child", {
                  datasetId: root.datasetId,
                  datasetVersionId: `datv_lineage_bad_${predecessor.datasetVersionId}`.slice(0, 63),
                  fixtureVersions: [reference(member)],
                  predecessor,
                  scope: sharedScope,
                }),
              ),
              RegressionVersionLineageError,
            );
          }

          const predecessor = {
            datasetVersionId: root.datasetVersionId,
            definitionSha256: root.definitionSha256,
          };
          const firstChild = dataset("ds_lineage_child_a", {
            datasetId: root.datasetId,
            datasetVersionId: "datv_lineage_child_a",
            fixtureVersions: [reference(member)],
            predecessor,
            scope: sharedScope,
          });
          const secondChild = dataset("ds_lineage_child_b", {
            datasetId: root.datasetId,
            datasetVersionId: "datv_lineage_child_b",
            fixtureVersions: [reference(member)],
            predecessor,
            scope: sharedScope,
          });
          assert.equal((await repository.publishDatasetVersion(firstChild)).created, true);
          assert.equal((await repository.publishDatasetVersion(secondChild)).created, true);
          assert.deepEqual(
            await repository.findDatasetVersion(sharedScope, root.datasetVersionId),
            root,
          );
        });
      },
    },
    {
      name: "resolves fixture references all-or-nothing without leaking scope or position",
      async run(factory) {
        await withHarness(factory, "resolve", async ({ repository }) => {
          const sharedScope = scope("resolve");
          assert.deepEqual(
            await repository.resolveFixtureVersionReferences(scope("resolve_empty"), []),
            [],
          );
          const first = fixture("resolve_a", { scope: sharedScope });
          const second = fixture("resolve_b", { scope: sharedScope });
          await repository.publishFixtureVersion(first);
          await repository.publishFixtureVersion(second);
          const requested = [
            { fixtureId: second.fixtureId, fixtureVersionId: second.fixtureVersionId },
            { fixtureId: first.fixtureId, fixtureVersionId: first.fixtureVersionId },
          ];
          const resolved = await repository.resolveFixtureVersionReferences(sharedScope, requested);
          assert.deepEqual(resolved, [reference(second), reference(first)]);
          assert.ok(resolved);
          const firstResolved = resolved[0];
          assert.ok(firstResolved);
          firstResolved.definitionSha256 = "f".repeat(64);
          assert.deepEqual(
            await repository.resolveFixtureVersionReferences(sharedScope, requested),
            [reference(second), reference(first)],
          );
          assert.deepEqual(await repository.resolveFixtureVersionReferences(sharedScope, []), []);

          for (const missing of [
            [{ fixtureId: first.fixtureId, fixtureVersionId: "fixv_missing" }],
            [{ fixtureId: "fix_wrong", fixtureVersionId: first.fixtureVersionId }],
          ]) {
            assert.equal(
              await repository.resolveFixtureVersionReferences(sharedScope, missing),
              null,
            );
          }
          for (const hiddenScope of [
            { ...sharedScope, projectId: "prj_hidden" },
            { ...sharedScope, environmentId: "env_hidden" },
            { ...sharedScope, tenantId: "ten_hidden" },
          ]) {
            assert.equal(
              await repository.resolveFixtureVersionReferences(hiddenScope, requested),
              null,
            );
          }
        });
      },
    },
    {
      name: "revalidates every dataset member and leaves no partial dataset or intent",
      async run(factory) {
        await withHarness(factory, "members", async ({ publishedIntents, repository }) => {
          const sharedScope = scope("members");
          const local = fixture("members_local", { scope: sharedScope });
          const remote = fixture("members_remote", {
            scope: { ...sharedScope, projectId: "prj_remote" },
          });
          await repository.publishFixtureVersion(local);
          await repository.publishFixtureVersion(remote);

          const freshScope = scope("members_fresh");
          const freshDataset = dataset("members_fresh", {
            fixtureVersions: [reference(local)],
          });
          await assert.rejects(
            repository.publishDatasetVersion(freshDataset),
            RegressionVersionConflictError,
          );
          assert.equal(
            await repository.datasetResourceExists(freshScope, freshDataset.datasetId),
            false,
          );

          const invalidReferences: readonly RegressionFixtureVersionReference[][] = [
            [
              {
                definitionSha256: local.definitionSha256,
                fixtureId: local.fixtureId,
                fixtureVersionId: "fixv_missing",
              },
            ],
            [{ ...reference(local), fixtureId: "fix_wrong" }],
            [{ ...reference(local), definitionSha256: "f".repeat(64) }],
            [reference(remote)],
          ];
          for (const [index, fixtureVersions] of invalidReferences.entries()) {
            const candidate = dataset(`members_bad_${index}`, {
              datasetId: "dat_members",
              datasetVersionId: `datv_members_bad_${index}`,
              fixtureVersions,
              scope: sharedScope,
            });
            await assert.rejects(
              repository.publishDatasetVersion(candidate),
              RegressionVersionConflictError,
            );
            assert.equal(
              await repository.datasetResourceExists(sharedScope, candidate.datasetId),
              false,
            );
            assert.equal(
              await repository.findDatasetVersion(sharedScope, candidate.datasetVersionId),
              null,
            );
          }
          assert.equal(
            eventCount(
              await publishedIntents(sharedScope.tenantId),
              REGRESSION_DATASET_VERSION_PUBLISHED_EVENT_TYPE,
            ),
            0,
          );

          const valid = dataset("members_valid", {
            datasetId: "dat_members",
            datasetVersionId: "datv_members_valid",
            fixtureVersions: [reference(local)],
            scope: sharedScope,
          });
          assert.equal((await repository.publishDatasetVersion(valid)).created, true);
        });
      },
    },
    {
      name: "strictly rejects malformed or self-digest-mismatched candidates before mutation",
      async run(factory) {
        await withHarness(factory, "invalid", async ({ publishedIntents, repository }) => {
          const sharedScope = scope("invalid");
          const validFixture = fixture("invalid_fixture", { scope: sharedScope });
          await assert.rejects(
            repository.publishFixtureVersion({
              ...validFixture,
              unknown: true,
            } as RegressionFixtureVersion),
            InvalidRegressionVersionInputError,
          );
          await assert.rejects(
            repository.publishFixtureVersion({
              ...validFixture,
              definitionSha256: "f".repeat(64),
            }),
            InvalidRegressionVersionInputError,
          );
          const validDataset = dataset("invalid_dataset", {
            fixtureVersions: [reference(validFixture)],
            scope: sharedScope,
          });
          await assert.rejects(
            repository.publishDatasetVersion({
              ...validDataset,
              unknown: true,
            } as RegressionDatasetVersion),
            InvalidRegressionVersionInputError,
          );
          await assert.rejects(
            repository.publishDatasetVersion({
              ...validDataset,
              definitionSha256: "f".repeat(64),
            }),
            InvalidRegressionVersionInputError,
          );
          assert.equal(
            await repository.fixtureResourceExists(sharedScope, validFixture.fixtureId),
            false,
          );
          assert.equal(
            await repository.datasetResourceExists(sharedScope, validDataset.datasetId),
            false,
          );
          assert.deepEqual(await publishedIntents(sharedScope.tenantId), []);
        });
      },
    },
    {
      name: "owns publication inputs and returns defensive version, resolution, and intent copies",
      async run(factory) {
        await withHarness(factory, "copies", async ({ publishedIntents, repository }) => {
          const sharedScope = scope("copies");
          const originalScope = { ...sharedScope };
          const candidate = fixture("copies_fixture", { scope: sharedScope });
          const published = await repository.publishFixtureVersion(candidate);
          candidate.scope.projectId = "prj_mutated_input";
          candidate.source.eventIds[0] = "evt_mutated_input";
          published.version.scope.projectId = "prj_mutated_output";
          published.version.source.eventIds[0] = "evt_mutated_output";

          const storedFixture = await repository.findFixtureVersion(
            originalScope,
            candidate.fixtureVersionId,
          );
          assert.equal(storedFixture?.scope.projectId, originalScope.projectId);
          assert.equal(storedFixture?.source.eventIds[0], "evt_copies_fixture_start");
          assert.equal(
            await repository.fixtureResourceExists(originalScope, candidate.fixtureId),
            true,
          );
          assert.equal(
            await repository.fixtureResourceExists(candidate.scope, candidate.fixtureId),
            false,
          );
          assert.ok(storedFixture);
          storedFixture.source.eventIds[0] = "evt_mutated_read";
          assert.equal(
            (await repository.findFixtureVersion(originalScope, candidate.fixtureVersionId))?.source
              .eventIds[0],
            "evt_copies_fixture_start",
          );

          const fixturePredecessor = {
            definitionSha256: storedFixture.definitionSha256,
            fixtureVersionId: storedFixture.fixtureVersionId,
          };
          const fixtureChildCandidate = fixture("copies_fixture_child", {
            fixtureId: storedFixture.fixtureId,
            fixtureVersionId: "fixv_copies_fixture_child",
            predecessor: fixturePredecessor,
            scope: originalScope,
          });
          const fixtureChildPublished =
            await repository.publishFixtureVersion(fixtureChildCandidate);
          assert.ok(fixtureChildCandidate.predecessor);
          assert.ok(fixtureChildPublished.version.predecessor);
          fixtureChildCandidate.predecessor.definitionSha256 = "f".repeat(64);
          fixtureChildPublished.version.predecessor.fixtureVersionId = "fixv_mutated_output";
          const storedFixtureChild = await repository.findFixtureVersion(
            originalScope,
            fixtureChildCandidate.fixtureVersionId,
          );
          assert.deepEqual(storedFixtureChild?.predecessor, fixturePredecessor);
          assert.ok(storedFixtureChild?.predecessor);
          storedFixtureChild.predecessor.fixtureVersionId = "fixv_mutated_read";
          assert.deepEqual(
            (
              await repository.findFixtureVersion(
                originalScope,
                fixtureChildCandidate.fixtureVersionId,
              )
            )?.predecessor,
            fixturePredecessor,
          );

          const datasetCandidate = dataset("copies_dataset", {
            fixtureVersions: [reference(storedFixture)],
            scope: originalScope,
          });
          const datasetPublished = await repository.publishDatasetVersion(datasetCandidate);
          const inputMember = datasetCandidate.fixtureVersions[0];
          const outputMember = datasetPublished.version.fixtureVersions[0];
          assert.ok(inputMember);
          assert.ok(outputMember);
          inputMember.definitionSha256 = "f".repeat(64);
          outputMember.fixtureId = "fix_mutated_output";
          datasetCandidate.scope.environmentId = "env_mutated_input";
          datasetPublished.version.scope.projectId = "prj_mutated_output";
          const storedDataset = await repository.findDatasetVersion(
            originalScope,
            datasetCandidate.datasetVersionId,
          );
          assert.deepEqual(storedDataset?.fixtureVersions, [reference(storedFixture)]);
          assert.deepEqual(storedDataset?.scope, originalScope);
          assert.equal(
            await repository.datasetResourceExists(originalScope, datasetCandidate.datasetId),
            true,
          );
          assert.equal(
            await repository.datasetResourceExists(
              datasetCandidate.scope,
              datasetCandidate.datasetId,
            ),
            false,
          );
          assert.ok(storedDataset);
          const storedMember = storedDataset.fixtureVersions[0];
          assert.ok(storedMember);
          storedMember.fixtureVersionId = "fixv_mutated_dataset_read";
          storedDataset.scope.environmentId = "env_mutated_read";
          const rereadDataset = await repository.findDatasetVersion(
            originalScope,
            datasetCandidate.datasetVersionId,
          );
          assert.deepEqual(rereadDataset?.fixtureVersions, [reference(storedFixture)]);
          assert.deepEqual(rereadDataset?.scope, originalScope);
          assert.ok(rereadDataset);

          const datasetPredecessor = {
            datasetVersionId: rereadDataset.datasetVersionId,
            definitionSha256: rereadDataset.definitionSha256,
          };
          const datasetChildCandidate = dataset("copies_dataset_child", {
            datasetId: datasetCandidate.datasetId,
            datasetVersionId: "datv_copies_dataset_child",
            fixtureVersions: [reference(storedFixture)],
            predecessor: datasetPredecessor,
            scope: originalScope,
          });
          const datasetChildPublished =
            await repository.publishDatasetVersion(datasetChildCandidate);
          assert.ok(datasetChildCandidate.predecessor);
          assert.ok(datasetChildPublished.version.predecessor);
          datasetChildCandidate.predecessor.definitionSha256 = "f".repeat(64);
          datasetChildPublished.version.predecessor.datasetVersionId = "datv_mutated_output";
          const storedDatasetChild = await repository.findDatasetVersion(
            originalScope,
            datasetChildCandidate.datasetVersionId,
          );
          assert.deepEqual(storedDatasetChild?.predecessor, datasetPredecessor);
          assert.ok(storedDatasetChild?.predecessor);
          storedDatasetChild.predecessor.datasetVersionId = "datv_mutated_read";
          assert.deepEqual(
            (
              await repository.findDatasetVersion(
                originalScope,
                datasetChildCandidate.datasetVersionId,
              )
            )?.predecessor,
            datasetPredecessor,
          );

          const firstProbe = await publishedIntents(originalScope.tenantId);
          const firstIntent = firstProbe[0];
          assert.ok(firstIntent);
          (firstIntent.payload as { projectId: string }).projectId = "prj_mutated_probe";
          assert.equal(
            (await publishedIntents(originalScope.tenantId))[0]?.payload.projectId,
            originalScope.projectId,
          );
        });
      },
    },
    {
      name: "returns publication intents in deterministic bytewise event and aggregate order",
      async run(factory) {
        await withHarness(factory, "intent_order", async ({ publishedIntents, repository }) => {
          const sharedScope = scope("intent_order");
          const zFixture = fixture("intent_order_z", {
            fixtureVersionId: "fixv_z_order",
            scope: sharedScope,
          });
          const aFixture = fixture("intent_order_a", {
            fixtureVersionId: "fixv_a_order",
            scope: sharedScope,
          });
          await repository.publishFixtureVersion(zFixture);
          await repository.publishFixtureVersion(aFixture);
          const datasetVersion = dataset("intent_order", {
            fixtureVersions: [reference(zFixture), reference(aFixture)],
            scope: sharedScope,
          });
          await repository.publishDatasetVersion(datasetVersion);

          assert.deepEqual(
            (await publishedIntents(sharedScope.tenantId)).map(
              ({ aggregateId, eventType }) => `${eventType}:${aggregateId}`,
            ),
            [
              `${REGRESSION_DATASET_VERSION_PUBLISHED_EVENT_TYPE}:${datasetVersion.datasetVersionId}`,
              `${REGRESSION_FIXTURE_VERSION_PUBLISHED_EVENT_TYPE}:${aFixture.fixtureVersionId}`,
              `${REGRESSION_FIXTURE_VERSION_PUBLISHED_EVENT_TYPE}:${zFixture.fixtureVersionId}`,
            ],
          );
        });
      },
    },
    {
      name: "linearizes concurrent retries, conflicts, roots, and sibling branches",
      async run(factory) {
        await withHarness(factory, "concurrency", async ({ publishedIntents, repository }) => {
          const sharedScope = scope("concurrency");
          const original = fixture("concurrency_retry", { scope: sharedScope });
          const retry = fixture("concurrency_retry", {
            capturedAt: "2026-08-29T01:00:45.000Z",
            createdAt: "2026-08-29T01:03:00.000Z",
            createdByPrincipalId: "usr_concurrent_retry",
            scope: sharedScope,
          });
          const identicalCandidates = [original, retry];
          const identicalResults = await Promise.all(
            identicalCandidates.map((candidate) => repository.publishFixtureVersion(candidate)),
          );
          assert.deepEqual(identicalResults.map(({ created }) => created).sort(), [false, true]);
          const firstResult = identicalResults[0];
          const secondResult = identicalResults[1];
          assert.ok(firstResult);
          assert.ok(secondResult);
          assert.deepEqual(firstResult.version, secondResult.version);
          const identicalWinnerIndex = identicalResults.findIndex(({ created }) => created);
          const identicalLoserIndex = identicalResults.findIndex(({ created }) => !created);
          const identicalWinner = identicalCandidates[identicalWinnerIndex];
          const identicalLoser = identicalCandidates[identicalLoserIndex];
          assert.ok(identicalWinner);
          assert.ok(identicalLoser);
          assert.deepEqual(
            await repository.findFixtureVersion(sharedScope, original.fixtureVersionId),
            identicalWinner,
          );
          assertCanonicalRaceIntents(
            await publishedIntents(sharedScope.tenantId),
            REGRESSION_FIXTURE_VERSION_PUBLISHED_EVENT_TYPE,
            buildRegressionFixtureVersionPublishedOutboxIntent(identicalWinner),
            buildRegressionFixtureVersionPublishedOutboxIntent(identicalLoser),
            1,
          );

          const conflictA = fixture("concurrency_conflict", { scope: sharedScope });
          const conflictB = fixture("concurrency_conflict", {
            name: "Conflicting concurrent fixture",
            scope: sharedScope,
          });
          const conflictCandidates = [conflictA, conflictB];
          const conflictResults = await Promise.allSettled(
            conflictCandidates.map((candidate) => repository.publishFixtureVersion(candidate)),
          );
          const { loserIndex: conflictLoserIndex, winnerIndex: conflictWinnerIndex } =
            assertOneConflict(conflictResults);
          const conflictWinner = conflictCandidates[conflictWinnerIndex];
          const conflictLoser = conflictCandidates[conflictLoserIndex];
          assert.ok(conflictWinner);
          assert.ok(conflictLoser);
          assert.deepEqual(
            await repository.findFixtureVersion(sharedScope, conflictWinner.fixtureVersionId),
            conflictWinner,
          );
          assertCanonicalRaceIntents(
            await publishedIntents(sharedScope.tenantId),
            REGRESSION_FIXTURE_VERSION_PUBLISHED_EVENT_TYPE,
            buildRegressionFixtureVersionPublishedOutboxIntent(conflictWinner),
            buildRegressionFixtureVersionPublishedOutboxIntent(conflictLoser),
            2,
          );

          const rootA = fixture("concurrency_root_a", {
            fixtureId: "fix_concurrent_root",
            fixtureVersionId: "fixv_concurrent_root_a",
            scope: sharedScope,
          });
          const rootB = fixture("concurrency_root_b", {
            fixtureId: "fix_concurrent_root",
            fixtureVersionId: "fixv_concurrent_root_b",
            scope: sharedScope,
          });
          const rootCandidates = [rootB, rootA];
          const rootResults = await Promise.allSettled(
            rootCandidates.map((candidate) => repository.publishFixtureVersion(candidate)),
          );
          const { loserIndex: rootLoserIndex, winnerIndex: rootWinnerIndex } = assertOneFailure(
            rootResults,
            RegressionVersionLineageError,
          );
          const storedRoot = rootCandidates[rootWinnerIndex];
          const rejectedRoot = rootCandidates[rootLoserIndex];
          assert.ok(storedRoot);
          assert.ok(rejectedRoot);
          assert.deepEqual(
            await repository.findFixtureVersion(sharedScope, storedRoot.fixtureVersionId),
            storedRoot,
          );
          assert.equal(
            await repository.findFixtureVersion(sharedScope, rejectedRoot.fixtureVersionId),
            null,
          );
          assertCanonicalRaceIntents(
            await publishedIntents(sharedScope.tenantId),
            REGRESSION_FIXTURE_VERSION_PUBLISHED_EVENT_TYPE,
            buildRegressionFixtureVersionPublishedOutboxIntent(storedRoot),
            buildRegressionFixtureVersionPublishedOutboxIntent(rejectedRoot),
            3,
          );

          const predecessor = {
            definitionSha256: storedRoot.definitionSha256,
            fixtureVersionId: storedRoot.fixtureVersionId,
          };
          const siblingCandidates = [
            fixture("concurrency_sibling_a", {
              fixtureId: storedRoot.fixtureId,
              fixtureVersionId: "fixv_concurrent_sibling_a",
              predecessor,
              scope: sharedScope,
            }),
            fixture("concurrency_sibling_b", {
              fixtureId: storedRoot.fixtureId,
              fixtureVersionId: "fixv_concurrent_sibling_b",
              predecessor,
              scope: sharedScope,
            }),
          ];
          const siblings = await Promise.all(
            siblingCandidates.map((candidate) => repository.publishFixtureVersion(candidate)),
          );
          assert.deepEqual(
            siblings.map(({ created }) => created),
            [true, true],
          );
          for (const candidate of siblingCandidates) {
            assert.deepEqual(
              await repository.findFixtureVersion(sharedScope, candidate.fixtureVersionId),
              candidate,
            );
          }
          const fixtureIntentsAfterSiblings = await publishedIntents(sharedScope.tenantId);
          assert.equal(
            eventCount(
              fixtureIntentsAfterSiblings,
              REGRESSION_FIXTURE_VERSION_PUBLISHED_EVENT_TYPE,
            ),
            5,
          );
          for (const candidate of siblingCandidates) {
            const expectedIntent = buildRegressionFixtureVersionPublishedOutboxIntent(candidate);
            assert.equal(
              fixtureIntentsAfterSiblings.filter((intent) =>
                isDeepStrictEqual(intent, expectedIntent),
              ).length,
              1,
            );
          }

          const datasetOriginal = dataset("concurrency_dataset", {
            fixtureVersions: [reference(original)],
            scope: sharedScope,
          });
          const datasetRetry = dataset("concurrency_dataset", {
            createdAt: "2026-08-29T01:04:00.000Z",
            createdByPrincipalId: "usr_concurrent_dataset",
            fixtureVersions: [reference(original)],
            scope: sharedScope,
          });
          const datasetRetryCandidates = [datasetOriginal, datasetRetry];
          const datasetResults = await Promise.all(
            datasetRetryCandidates.map((candidate) => repository.publishDatasetVersion(candidate)),
          );
          assert.deepEqual(datasetResults.map(({ created }) => created).sort(), [false, true]);
          const datasetRetryWinnerIndex = datasetResults.findIndex(({ created }) => created);
          const datasetRetryLoserIndex = datasetResults.findIndex(({ created }) => !created);
          const datasetRetryWinner = datasetRetryCandidates[datasetRetryWinnerIndex];
          const datasetRetryLoser = datasetRetryCandidates[datasetRetryLoserIndex];
          assert.ok(datasetRetryWinner);
          assert.ok(datasetRetryLoser);
          assert.deepEqual(
            await repository.findDatasetVersion(sharedScope, datasetRetryWinner.datasetVersionId),
            datasetRetryWinner,
          );
          assertCanonicalRaceIntents(
            await publishedIntents(sharedScope.tenantId),
            REGRESSION_DATASET_VERSION_PUBLISHED_EVENT_TYPE,
            buildRegressionDatasetVersionPublishedOutboxIntent(datasetRetryWinner),
            buildRegressionDatasetVersionPublishedOutboxIntent(datasetRetryLoser),
            1,
          );

          const datasetConflictA = dataset("concurrency_dataset_conflict", {
            fixtureVersions: [reference(original)],
            scope: sharedScope,
          });
          const datasetConflictB = dataset("concurrency_dataset_conflict", {
            fixtureVersions: [reference(original)],
            name: "Conflicting concurrent dataset",
            scope: sharedScope,
          });
          const datasetConflictCandidates = [datasetConflictA, datasetConflictB];
          const datasetConflictResults = await Promise.allSettled(
            datasetConflictCandidates.map((candidate) =>
              repository.publishDatasetVersion(candidate),
            ),
          );
          const { loserIndex: datasetConflictLoserIndex, winnerIndex: datasetConflictWinnerIndex } =
            assertOneConflict(datasetConflictResults);
          const datasetConflictWinner = datasetConflictCandidates[datasetConflictWinnerIndex];
          const datasetConflictLoser = datasetConflictCandidates[datasetConflictLoserIndex];
          assert.ok(datasetConflictWinner);
          assert.ok(datasetConflictLoser);
          assert.deepEqual(
            await repository.findDatasetVersion(
              sharedScope,
              datasetConflictWinner.datasetVersionId,
            ),
            datasetConflictWinner,
          );
          assertCanonicalRaceIntents(
            await publishedIntents(sharedScope.tenantId),
            REGRESSION_DATASET_VERSION_PUBLISHED_EVENT_TYPE,
            buildRegressionDatasetVersionPublishedOutboxIntent(datasetConflictWinner),
            buildRegressionDatasetVersionPublishedOutboxIntent(datasetConflictLoser),
            2,
          );

          const datasetRootA = dataset("concurrency_dataset_root_a", {
            datasetId: "dat_concurrent_root",
            datasetVersionId: "datv_concurrent_root_a",
            fixtureVersions: [reference(original)],
            scope: sharedScope,
          });
          const datasetRootB = dataset("concurrency_dataset_root_b", {
            datasetId: "dat_concurrent_root",
            datasetVersionId: "datv_concurrent_root_b",
            fixtureVersions: [reference(original)],
            scope: sharedScope,
          });
          const datasetRootCandidates = [datasetRootB, datasetRootA];
          const datasetRootResults = await Promise.allSettled(
            datasetRootCandidates.map((candidate) => repository.publishDatasetVersion(candidate)),
          );
          const { loserIndex: datasetRootLoserIndex, winnerIndex: datasetRootWinnerIndex } =
            assertOneFailure(datasetRootResults, RegressionVersionLineageError);
          const storedDatasetRoot = datasetRootCandidates[datasetRootWinnerIndex];
          const rejectedDatasetRoot = datasetRootCandidates[datasetRootLoserIndex];
          assert.ok(storedDatasetRoot);
          assert.ok(rejectedDatasetRoot);
          assert.deepEqual(
            await repository.findDatasetVersion(sharedScope, storedDatasetRoot.datasetVersionId),
            storedDatasetRoot,
          );
          assert.equal(
            await repository.findDatasetVersion(sharedScope, rejectedDatasetRoot.datasetVersionId),
            null,
          );
          assertCanonicalRaceIntents(
            await publishedIntents(sharedScope.tenantId),
            REGRESSION_DATASET_VERSION_PUBLISHED_EVENT_TYPE,
            buildRegressionDatasetVersionPublishedOutboxIntent(storedDatasetRoot),
            buildRegressionDatasetVersionPublishedOutboxIntent(rejectedDatasetRoot),
            3,
          );

          const datasetPredecessor = {
            datasetVersionId: storedDatasetRoot.datasetVersionId,
            definitionSha256: storedDatasetRoot.definitionSha256,
          };
          const datasetSiblingCandidates = [
            dataset("concurrency_dataset_sibling_a", {
              datasetId: storedDatasetRoot.datasetId,
              datasetVersionId: "datv_concurrent_sibling_a",
              fixtureVersions: [reference(original)],
              predecessor: datasetPredecessor,
              scope: sharedScope,
            }),
            dataset("concurrency_dataset_sibling_b", {
              datasetId: storedDatasetRoot.datasetId,
              datasetVersionId: "datv_concurrent_sibling_b",
              fixtureVersions: [reference(original)],
              predecessor: datasetPredecessor,
              scope: sharedScope,
            }),
          ];
          const datasetSiblings = await Promise.all(
            datasetSiblingCandidates.map((candidate) =>
              repository.publishDatasetVersion(candidate),
            ),
          );
          assert.deepEqual(
            datasetSiblings.map(({ created }) => created),
            [true, true],
          );
          for (const candidate of datasetSiblingCandidates) {
            assert.deepEqual(
              await repository.findDatasetVersion(sharedScope, candidate.datasetVersionId),
              candidate,
            );
          }
          const datasetIntentsAfterSiblings = await publishedIntents(sharedScope.tenantId);
          assert.equal(
            eventCount(
              datasetIntentsAfterSiblings,
              REGRESSION_DATASET_VERSION_PUBLISHED_EVENT_TYPE,
            ),
            5,
          );
          for (const candidate of datasetSiblingCandidates) {
            const expectedIntent = buildRegressionDatasetVersionPublishedOutboxIntent(candidate);
            assert.equal(
              datasetIntentsAfterSiblings.filter((intent) =>
                isDeepStrictEqual(intent, expectedIntent),
              ).length,
              1,
            );
          }
        });
      },
    },
    {
      name: "linearizes tenant-wide target and root races across scopes",
      async run(factory) {
        await withHarness(factory, "scope_races", async ({ publishedIntents, repository }) => {
          const primaryScope = scope("scope_races");
          const otherProjectScope = {
            ...primaryScope,
            projectId: "prj_scope_races_other",
          };
          const otherEnvironmentScope = {
            ...primaryScope,
            environmentId: "env_scope_races_other",
          };

          const fixtureTargetCandidates = [
            fixture("scope_races_fixture_target_a", {
              fixtureVersionId: "fixv_scope_races_shared_target",
              scope: primaryScope,
            }),
            fixture("scope_races_fixture_target_b", {
              fixtureVersionId: "fixv_scope_races_shared_target",
              scope: otherProjectScope,
            }),
          ];
          const fixtureTargetResults = await Promise.allSettled(
            fixtureTargetCandidates.map((candidate) => repository.publishFixtureVersion(candidate)),
          );
          await assertFixtureRaceEffects(
            repository,
            publishedIntents,
            fixtureTargetCandidates,
            fixtureTargetResults,
            1,
          );

          const fixtureEnvironmentTargetCandidates = [
            fixture("scope_races_fixture_environment_target_a", {
              fixtureVersionId: "fixv_scope_races_shared_environment_target",
              scope: primaryScope,
            }),
            fixture("scope_races_fixture_environment_target_b", {
              fixtureVersionId: "fixv_scope_races_shared_environment_target",
              scope: otherEnvironmentScope,
            }),
          ];
          const fixtureEnvironmentTargetResults = await Promise.allSettled(
            fixtureEnvironmentTargetCandidates.map((candidate) =>
              repository.publishFixtureVersion(candidate),
            ),
          );
          await assertFixtureRaceEffects(
            repository,
            publishedIntents,
            fixtureEnvironmentTargetCandidates,
            fixtureEnvironmentTargetResults,
            2,
          );

          const fixtureRootCandidates = [
            fixture("scope_races_fixture_root_a", {
              fixtureId: "fix_scope_races_shared_root",
              fixtureVersionId: "fixv_scope_races_root_a",
              scope: primaryScope,
            }),
            fixture("scope_races_fixture_root_b", {
              fixtureId: "fix_scope_races_shared_root",
              fixtureVersionId: "fixv_scope_races_root_b",
              scope: otherEnvironmentScope,
            }),
          ];
          const fixtureRootResults = await Promise.allSettled(
            fixtureRootCandidates.map((candidate) => repository.publishFixtureVersion(candidate)),
          );
          await assertFixtureRaceEffects(
            repository,
            publishedIntents,
            fixtureRootCandidates,
            fixtureRootResults,
            3,
          );

          const fixtureProjectRootCandidates = [
            fixture("scope_races_fixture_project_root_a", {
              fixtureId: "fix_scope_races_shared_project_root",
              fixtureVersionId: "fixv_scope_races_project_root_a",
              scope: primaryScope,
            }),
            fixture("scope_races_fixture_project_root_b", {
              fixtureId: "fix_scope_races_shared_project_root",
              fixtureVersionId: "fixv_scope_races_project_root_b",
              scope: otherProjectScope,
            }),
          ];
          const fixtureProjectRootResults = await Promise.allSettled(
            fixtureProjectRootCandidates.map((candidate) =>
              repository.publishFixtureVersion(candidate),
            ),
          );
          await assertFixtureRaceEffects(
            repository,
            publishedIntents,
            fixtureProjectRootCandidates,
            fixtureProjectRootResults,
            4,
          );

          const primaryMember = fixture("scope_races_primary_member", {
            scope: primaryScope,
          });
          const projectMember = fixture("scope_races_project_member", {
            scope: otherProjectScope,
          });
          const environmentMember = fixture("scope_races_environment_member", {
            scope: otherEnvironmentScope,
          });
          await repository.publishFixtureVersion(primaryMember);
          await repository.publishFixtureVersion(projectMember);
          await repository.publishFixtureVersion(environmentMember);

          const datasetTargetCandidates = [
            dataset("scope_races_dataset_target_a", {
              datasetVersionId: "datv_scope_races_shared_target",
              fixtureVersions: [reference(primaryMember)],
              scope: primaryScope,
            }),
            dataset("scope_races_dataset_target_b", {
              datasetVersionId: "datv_scope_races_shared_target",
              fixtureVersions: [reference(projectMember)],
              scope: otherProjectScope,
            }),
          ];
          const datasetTargetResults = await Promise.allSettled(
            datasetTargetCandidates.map((candidate) => repository.publishDatasetVersion(candidate)),
          );
          await assertDatasetRaceEffects(
            repository,
            publishedIntents,
            datasetTargetCandidates,
            datasetTargetResults,
            1,
          );

          const datasetEnvironmentTargetCandidates = [
            dataset("scope_races_dataset_environment_target_a", {
              datasetVersionId: "datv_scope_races_shared_environment_target",
              fixtureVersions: [reference(primaryMember)],
              scope: primaryScope,
            }),
            dataset("scope_races_dataset_environment_target_b", {
              datasetVersionId: "datv_scope_races_shared_environment_target",
              fixtureVersions: [reference(environmentMember)],
              scope: otherEnvironmentScope,
            }),
          ];
          const datasetEnvironmentTargetResults = await Promise.allSettled(
            datasetEnvironmentTargetCandidates.map((candidate) =>
              repository.publishDatasetVersion(candidate),
            ),
          );
          await assertDatasetRaceEffects(
            repository,
            publishedIntents,
            datasetEnvironmentTargetCandidates,
            datasetEnvironmentTargetResults,
            2,
          );

          const datasetRootCandidates = [
            dataset("scope_races_dataset_root_a", {
              datasetId: "dat_scope_races_shared_root",
              datasetVersionId: "datv_scope_races_root_a",
              fixtureVersions: [reference(primaryMember)],
              scope: primaryScope,
            }),
            dataset("scope_races_dataset_root_b", {
              datasetId: "dat_scope_races_shared_root",
              datasetVersionId: "datv_scope_races_root_b",
              fixtureVersions: [reference(environmentMember)],
              scope: otherEnvironmentScope,
            }),
          ];
          const datasetRootResults = await Promise.allSettled(
            datasetRootCandidates.map((candidate) => repository.publishDatasetVersion(candidate)),
          );
          await assertDatasetRaceEffects(
            repository,
            publishedIntents,
            datasetRootCandidates,
            datasetRootResults,
            3,
          );

          const datasetProjectRootCandidates = [
            dataset("scope_races_dataset_project_root_a", {
              datasetId: "dat_scope_races_shared_project_root",
              datasetVersionId: "datv_scope_races_project_root_a",
              fixtureVersions: [reference(primaryMember)],
              scope: primaryScope,
            }),
            dataset("scope_races_dataset_project_root_b", {
              datasetId: "dat_scope_races_shared_project_root",
              datasetVersionId: "datv_scope_races_project_root_b",
              fixtureVersions: [reference(projectMember)],
              scope: otherProjectScope,
            }),
          ];
          const datasetProjectRootResults = await Promise.allSettled(
            datasetProjectRootCandidates.map((candidate) =>
              repository.publishDatasetVersion(candidate),
            ),
          );
          await assertDatasetRaceEffects(
            repository,
            publishedIntents,
            datasetProjectRootCandidates,
            datasetProjectRootResults,
            4,
          );
        });
      },
    },
    {
      name: "rolls back every fixture and dataset effect on injected outbox failure",
      async run(factory) {
        await withHarness(
          factory,
          "faults",
          async ({ failNextPublicationIntent, publishedIntents, repository }) => {
            const sharedScope = scope("faults");
            const fixtureRoot = fixture("faults_fixture", { scope: sharedScope });
            await failNextPublicationIntent("fixture");
            await assert.rejects(repository.publishFixtureVersion(fixtureRoot));
            assert.equal(
              await repository.fixtureResourceExists(sharedScope, fixtureRoot.fixtureId),
              false,
            );
            assert.equal(
              await repository.findFixtureVersion(sharedScope, fixtureRoot.fixtureVersionId),
              null,
            );
            assert.deepEqual(await publishedIntents(sharedScope.tenantId), []);
            assert.equal((await repository.publishFixtureVersion(fixtureRoot)).created, true);

            await failNextPublicationIntent("fixture");
            assert.equal((await repository.publishFixtureVersion(fixtureRoot)).created, false);
            const fixtureChild = fixture("faults_child", {
              fixtureId: fixtureRoot.fixtureId,
              fixtureVersionId: "fixv_faults_child",
              predecessor: {
                definitionSha256: fixtureRoot.definitionSha256,
                fixtureVersionId: fixtureRoot.fixtureVersionId,
              },
              scope: sharedScope,
            });
            await assert.rejects(repository.publishFixtureVersion(fixtureChild));
            assert.equal(
              await repository.findFixtureVersion(sharedScope, fixtureChild.fixtureVersionId),
              null,
            );
            assert.equal(
              eventCount(
                await publishedIntents(sharedScope.tenantId),
                REGRESSION_FIXTURE_VERSION_PUBLISHED_EVENT_TYPE,
              ),
              1,
            );
            assert.equal((await repository.publishFixtureVersion(fixtureChild)).created, true);

            const datasetRoot = dataset("faults_dataset", {
              fixtureVersions: [reference(fixtureRoot)],
              scope: sharedScope,
            });
            await failNextPublicationIntent("dataset");
            await assert.rejects(repository.publishDatasetVersion(datasetRoot));
            assert.equal(
              await repository.datasetResourceExists(sharedScope, datasetRoot.datasetId),
              false,
            );
            assert.equal(
              await repository.findDatasetVersion(sharedScope, datasetRoot.datasetVersionId),
              null,
            );
            assert.equal(
              eventCount(
                await publishedIntents(sharedScope.tenantId),
                REGRESSION_DATASET_VERSION_PUBLISHED_EVENT_TYPE,
              ),
              0,
            );
            assert.equal((await repository.publishDatasetVersion(datasetRoot)).created, true);

            await failNextPublicationIntent("dataset");
            assert.equal((await repository.publishDatasetVersion(datasetRoot)).created, false);
            const datasetChild = dataset("faults_dataset_child", {
              datasetId: datasetRoot.datasetId,
              datasetVersionId: "datv_faults_dataset_child",
              fixtureVersions: [reference(fixtureRoot)],
              predecessor: {
                datasetVersionId: datasetRoot.datasetVersionId,
                definitionSha256: datasetRoot.definitionSha256,
              },
              scope: sharedScope,
            });
            await assert.rejects(repository.publishDatasetVersion(datasetChild));
            assert.equal(
              await repository.findDatasetVersion(sharedScope, datasetChild.datasetVersionId),
              null,
            );
            assert.equal(
              eventCount(
                await publishedIntents(sharedScope.tenantId),
                REGRESSION_DATASET_VERSION_PUBLISHED_EVENT_TYPE,
              ),
              1,
            );
            assert.equal((await repository.publishDatasetVersion(datasetChild)).created, true);
          },
        );
      },
    },
  ];
