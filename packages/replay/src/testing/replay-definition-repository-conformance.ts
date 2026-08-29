import type {
  EvidenceScope,
  ReplayBoundaryDeclaration,
  ReplayPlan,
  ReplayPlanDefinition,
  TargetRelease,
  TargetReleaseDefinition,
  TargetReleaseReference,
} from "@proofstack/contracts";
import { ReplayPlanSchema, TargetReleaseSchema } from "@proofstack/contracts";
import {
  ReplayDefinitionConflictError,
  ReplayDefinitionLineageError,
  ReplayRepositoryContractError,
} from "../errors.js";
import {
  digestReplayPlanDefinition,
  digestTargetReleaseDefinition,
} from "../replay-definition-digest.js";
import type { PublishedReplayDefinitionOutboxIntent } from "../replay-definition-publication-outbox.js";
import type { ReplayDefinitionRepository } from "../replay-definition-repository.js";
import { digestRecordedBoundaryReplayInvocationDefinition } from "../replay-digest.js";
import type { ReplayDefinitionPublicationKind } from "./replay-definition-repository-test-control.js";

export interface ReplayDefinitionRepositoryTestHarness {
  readonly dispose?: () => Promise<void>;
  readonly failNextPublicationIntent: (
    kind: ReplayDefinitionPublicationKind,
  ) => Promise<void> | void;
  readonly publishedIntents: (
    tenantId: string,
  ) => Promise<readonly PublishedReplayDefinitionOutboxIntent[]>;
  readonly removePublicationIntent: (
    kind: ReplayDefinitionPublicationKind,
    tenantId: string,
    aggregateId: string,
  ) => Promise<void> | void;
  readonly repository: ReplayDefinitionRepository;
}

export type ReplayDefinitionRepositoryTestFactory = (
  namespace: string,
) => Promise<ReplayDefinitionRepositoryTestHarness> | ReplayDefinitionRepositoryTestHarness;

export interface ReplayDefinitionRepositoryConformanceCase {
  readonly name: string;
  readonly run: (factory: ReplayDefinitionRepositoryTestFactory) => Promise<void>;
}

const sha = (digit: string): string => digit.repeat(64);
const workerProtocol = { name: "proofstack.replay-worker", version: "1.0.0" };
const targetAdapter = {
  name: "proofstack.reference_target",
  protocolVersion: "1.0.0",
  version: "1.0.0",
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function equal(actual: unknown, expected: unknown, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, received ${String(actual)}`);
  }
}

function deepEqual(actual: unknown, expected: unknown, message: string): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`${message}: expected ${expectedJson}, received ${actualJson}`);
  }
}

async function rejectsWith(
  operation: Promise<unknown>,
  ErrorType: abstract new (...arguments_: never[]) => Error,
): Promise<void> {
  try {
    await operation;
  } catch (error) {
    assert(error instanceof ErrorType, `Expected ${ErrorType.name}`);
    return;
  }
  throw new Error(`Expected ${ErrorType.name}`);
}

function scope(namespace: string, suffix = "primary"): EvidenceScope {
  return {
    environmentId: `env_${namespace}_${suffix}`,
    projectId: `prj_${namespace}_${suffix}`,
    tenantId: `ten_${namespace}`,
  };
}

function targetDefinition(
  namespace: string,
  targetScope: EvidenceScope,
  targetId: string,
  targetReleaseId: string,
  revisionDigit: string,
): TargetReleaseDefinition {
  return {
    build: {
      builderId: "proofstack.reference_builder",
      dependencySnapshotSha256: sha("1"),
      executableSha256: sha("2"),
      invocationSha256: sha("3"),
      provenance: {
        artifactId: `art_${namespace}_provenance`,
        classification: "internal",
        mediaType: "application/json",
        sha256: sha("4"),
        sizeBytes: 128,
      },
    },
    environmentVariableNames: [],
    execution: {
      implementationId: `impl_${namespace}_target`,
      implementationSha256: sha("5"),
      kind: "preinstalled",
    },
    mounts: [],
    outputLimits: {
      emittedArtifactBytes: 1_048_576,
      stderrBytes: 65_536,
      stdoutBytes: 65_536,
    },
    runtime: {
      architecture: "x64",
      entryPoint: "dist/target.js",
      family: "node",
      platform: "linux",
      version: "24.7.0",
    },
    schemaVersion: "0.1",
    scope: targetScope,
    source: {
      repositoryUrl: "https://github.com/Kwondh0321/proofstack",
      revision: revisionDigit.repeat(40),
    },
    subprocessPolicy: { mode: "denied" },
    supportedBoundaryKinds: ["model"],
    supportedBoundaryModes: ["recorded_stub"],
    targetAdapter,
    targetId,
    targetReleaseId,
    workerProtocol,
  };
}

function targetRelease(
  namespace: string,
  targetScope: EvidenceScope,
  targetId: string,
  targetReleaseId: string,
  revisionDigit = "6",
  createdAt = "2026-08-29T11:00:00.000Z",
  createdByPrincipalId = `usr_${namespace}`,
): TargetRelease {
  const definition = targetDefinition(
    namespace,
    targetScope,
    targetId,
    targetReleaseId,
    revisionDigit,
  );
  return TargetReleaseSchema.parse({
    createdAt,
    createdByPrincipalId,
    definitionSha256: digestTargetReleaseDefinition(definition),
    ...definition,
  });
}

function reference(release: TargetRelease): TargetReleaseReference {
  return {
    definitionSha256: release.definitionSha256,
    targetAdapter: release.targetAdapter,
    targetId: release.targetId,
    targetReleaseId: release.targetReleaseId,
    workerProtocol: release.workerProtocol,
  };
}

function recordedBoundary(namespace: string, release: TargetRelease): ReplayBoundaryDeclaration {
  const invocation = {
    fixture: {
      definitionSha256: sha("7"),
      fixtureId: `fix_${namespace}`,
      fixtureVersionId: `fiv_${namespace}_001`,
    },
    invocationId: `rpi_${namespace}_001`,
    runtime: {
      boundaryMode: "recorded_stub" as const,
      clock: { instant: "2026-08-29T00:00:00.000Z", mode: "fixed" as const },
      isolation: { mode: "cooperative_in_process" as const },
      locale: "en-US",
      network: { policy: "deny_fallback" as const },
      random: {
        algorithm: "hmac_sha256_counter_v1" as const,
        mode: "seeded" as const,
        seedHex: sha("8"),
      },
      timeZone: "UTC",
    },
    schemaVersion: "0.1" as const,
    targetAdapter: {
      name: release.targetAdapter.name,
      version: release.targetAdapter.version,
    },
  };
  return {
    boundaryId: `bnd_${namespace}_model`,
    invocation,
    invocationDefinitionSha256: digestRecordedBoundaryReplayInvocationDefinition(invocation),
    kind: "model",
    mode: "recorded_stub",
  };
}

function simulationBoundary(
  namespace: string,
  simulatorRelease: TargetReleaseReference,
): ReplayBoundaryDeclaration {
  return {
    boundaryId: `bnd_${namespace}_simulation`,
    configurationSha256: sha("c"),
    kind: "model",
    mode: "simulation",
    qualification: {
      artifactId: `art_${namespace}_qualification`,
      classification: "internal",
      mediaType: "application/json",
      sha256: sha("d"),
      sizeBytes: 256,
    },
    seedHex: sha("e"),
    simulatorRelease,
  };
}

function planDefinition(
  namespace: string,
  planScope: EvidenceScope,
  release: TargetRelease,
  planId: string,
  planVersionId: string,
  datasetDigest: string,
  boundaries: readonly ReplayBoundaryDeclaration[] = [recordedBoundary(namespace, release)],
  targetReleaseReference: TargetReleaseReference = reference(release),
): ReplayPlanDefinition {
  return {
    boundaries: [...boundaries],
    budget: {
      concurrentInteractions: { limit: 1, measurement: "measured" },
      elapsedMilliseconds: { limit: 10_000, measurement: "measured" },
      emittedArtifactBytes: { limit: 1_048_576, measurement: "measured" },
      inputTokens: { limit: 4_096, measurement: "provider_reported" },
      jobAttempts: { limit: 1, measurement: "measured" },
      modelRequests: { limit: 4, measurement: "measured" },
      outputTokens: { limit: 4_096, measurement: "provider_reported" },
      providerCostMicrounits: { limit: 1_000_000, measurement: "unavailable" },
      retrievedBytes: { limit: 1_048_576, measurement: "measured" },
      toolCalls: { limit: 1, measurement: "measured" },
    },
    dataset: {
      datasetId: `dat_${namespace}`,
      datasetVersionId: `dsv_${namespace}_001`,
      definitionSha256: datasetDigest,
    },
    isolationProfile: {
      definitionSha256: sha("a"),
      id: "iso_local_child",
      kind: "local_child_process",
      version: "1.0.0",
    },
    planId,
    planVersionId,
    retryPolicy: {
      automatic: false,
      backoff: { kind: "none" },
      idempotencyRequirement: "no_external_effect",
      maxAttempts: 1,
      perAttemptTimeoutMilliseconds: 2_000,
      retryableErrors: [],
      totalDeadlineMilliseconds: 5_000,
    },
    runtimeProfile: {
      definitionSha256: sha("b"),
      family: "node",
      id: "run_node_24",
      version: "1.0.0",
    },
    schemaVersion: "0.1",
    scope: planScope,
    targetRelease: targetReleaseReference,
    workerProtocol: targetReleaseReference.workerProtocol,
  };
}

function replayPlan(
  namespace: string,
  planScope: EvidenceScope,
  release: TargetRelease,
  planId: string,
  planVersionId: string,
  datasetDigest = sha("9"),
  boundaries?: readonly ReplayBoundaryDeclaration[],
  targetReleaseReference?: TargetReleaseReference,
  createdAt = "2026-08-29T11:01:00.000Z",
  createdByPrincipalId = `usr_${namespace}`,
): ReplayPlan {
  const definition = planDefinition(
    namespace,
    planScope,
    release,
    planId,
    planVersionId,
    datasetDigest,
    boundaries,
    targetReleaseReference,
  );
  return ReplayPlanSchema.parse({
    createdAt,
    createdByPrincipalId,
    definitionSha256: digestReplayPlanDefinition(definition),
    ...definition,
  });
}

async function withHarness(
  factory: ReplayDefinitionRepositoryTestFactory,
  namespace: string,
  test: (harness: ReplayDefinitionRepositoryTestHarness) => Promise<void>,
): Promise<void> {
  const harness = await factory(namespace);
  try {
    await test(harness);
  } finally {
    await harness.dispose?.();
  }
}

function winnerAndLoser(results: readonly PromiseSettledResult<unknown>[]): {
  readonly loser: PromiseRejectedResult;
  readonly winner: PromiseFulfilledResult<unknown>;
} {
  const winner = results.find(
    (result): result is PromiseFulfilledResult<unknown> => result.status === "fulfilled",
  );
  const loser = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  assert(winner && loser, "Expected exactly one publication winner and one loser");
  equal(results.filter(({ status }) => status === "fulfilled").length, 1, "winner count");
  equal(results.filter(({ status }) => status === "rejected").length, 1, "loser count");
  return { loser, winner };
}

export const replayDefinitionRepositoryConformanceCases: readonly ReplayDefinitionRepositoryConformanceCase[] =
  [
    {
      name: "publishes immutable target releases idempotently with one canonical intent",
      async run(factory) {
        await withHarness(factory, "target_retry", async ({ publishedIntents, repository }) => {
          const authorizedScope = scope("target_retry");
          const release = targetRelease(
            "target_retry",
            authorizedScope,
            "target_retry",
            "trg_target_retry_001",
          );
          const first = await repository.publishTargetRelease(release);
          const retry = targetRelease(
            "target_retry",
            authorizedScope,
            release.targetId,
            release.targetReleaseId,
            "6",
            "2026-08-29T12:00:00.000Z",
            "usr_retry",
          );
          const second = await repository.publishTargetRelease(retry);
          equal(first.created, true, "first target publication");
          equal(second.created, false, "target retry");
          deepEqual(second.definition, release, "authoritative target provenance");
          equal(
            (await publishedIntents(authorizedScope.tenantId)).length,
            1,
            "target intent count",
          );

          const successor = targetRelease(
            "target_retry",
            authorizedScope,
            release.targetId,
            "trg_target_retry_002",
          );
          equal(
            (await repository.publishTargetRelease(successor)).created,
            true,
            "target successor",
          );
          deepEqual(
            (await publishedIntents(authorizedScope.tenantId)).map(
              ({ aggregateId }) => aggregateId,
            ),
            [release.targetReleaseId, successor.targetReleaseId],
            "bytewise target intent order",
          );
        });
      },
    },
    {
      name: "rejects target version and tenant-wide resource rebinding without scope leaks",
      async run(factory) {
        await withHarness(factory, "target_conflict", async ({ repository }) => {
          const authorizedScope = scope("target_conflict");
          const release = targetRelease(
            "target_conflict",
            authorizedScope,
            "target_conflict",
            "trg_target_conflict_001",
          );
          await repository.publishTargetRelease(release);
          await rejectsWith(
            repository.publishTargetRelease(
              targetRelease(
                "target_conflict",
                authorizedScope,
                release.targetId,
                release.targetReleaseId,
                "7",
              ),
            ),
            ReplayDefinitionConflictError,
          );
          const otherScope = scope("target_conflict", "other");
          await rejectsWith(
            repository.publishTargetRelease(
              targetRelease(
                "target_conflict_other",
                otherScope,
                release.targetId,
                "trg_target_conflict_002",
              ),
            ),
            ReplayDefinitionConflictError,
          );
          equal(
            await repository.findTargetRelease(otherScope, release.targetReleaseId),
            null,
            "scope hide",
          );
          equal(
            await repository.findTargetRelease(
              { ...authorizedScope, tenantId: "ten_target_conflict_other" },
              release.targetReleaseId,
            ),
            null,
            "tenant hide",
          );
        });
      },
    },
    {
      name: "publishes exact replay plans idempotently after resolving all target lineage",
      async run(factory) {
        await withHarness(factory, "plan_retry", async ({ publishedIntents, repository }) => {
          const authorizedScope = scope("plan_retry");
          const release = targetRelease(
            "plan_retry",
            authorizedScope,
            "target_plan_retry",
            "trg_plan_retry_001",
          );
          await repository.publishTargetRelease(release);
          const plan = replayPlan(
            "plan_retry",
            authorizedScope,
            release,
            "plan_retry",
            "plv_plan_retry_001",
          );
          equal((await repository.publishReplayPlan(plan)).created, true, "first plan publication");
          const retry = replayPlan(
            "plan_retry",
            authorizedScope,
            release,
            plan.planId,
            plan.planVersionId,
            sha("9"),
            undefined,
            undefined,
            "2026-08-29T12:01:00.000Z",
            "usr_retry",
          );
          const result = await repository.publishReplayPlan(retry);
          equal(result.created, false, "plan retry");
          deepEqual(result.definition, plan, "authoritative plan provenance");
          equal((await publishedIntents(authorizedScope.tenantId)).length, 2, "definition intents");

          const successor = replayPlan(
            "plan_retry",
            authorizedScope,
            release,
            plan.planId,
            "plv_plan_retry_002",
          );
          equal((await repository.publishReplayPlan(successor)).created, true, "plan successor");
        });
      },
    },
    {
      name: "rejects missing, cross-scope, mismatched, and simulator target lineage",
      async run(factory) {
        await withHarness(factory, "plan_lineage", async ({ repository }) => {
          const authorizedScope = scope("plan_lineage");
          const release = targetRelease(
            "plan_lineage",
            authorizedScope,
            "target_plan_lineage",
            "trg_plan_lineage_001",
          );
          const missing = replayPlan(
            "plan_lineage_missing",
            authorizedScope,
            release,
            "plan_lineage_missing",
            "plv_plan_lineage_missing",
          );
          await rejectsWith(repository.publishReplayPlan(missing), ReplayDefinitionLineageError);
          await repository.publishTargetRelease(release);

          const mismatches: TargetReleaseReference[] = [
            { ...reference(release), targetId: "target_other" },
            { ...reference(release), targetReleaseId: "trg_other" },
            { ...reference(release), definitionSha256: sha("f") },
            {
              ...reference(release),
              targetAdapter: { ...release.targetAdapter, name: "proofstack.other_target" },
            },
            {
              ...reference(release),
              targetAdapter: { ...release.targetAdapter, version: "1.0.1" },
            },
            {
              ...reference(release),
              targetAdapter: { ...release.targetAdapter, protocolVersion: "1.0.1" },
            },
            {
              ...reference(release),
              workerProtocol: { ...release.workerProtocol, name: "proofstack.other-worker" },
            },
            {
              ...reference(release),
              workerProtocol: { ...release.workerProtocol, version: "1.0.1" },
            },
          ];
          for (const [index, mismatch] of mismatches.entries()) {
            const plan = replayPlan(
              `plan_lineage_mismatch_${index}`,
              authorizedScope,
              release,
              `plan_lineage_mismatch_${index}`,
              `plv_plan_lineage_mismatch_${index}`,
              sha("9"),
              [simulationBoundary(`plan_lineage_mismatch_${index}`, reference(release))],
              mismatch,
            );
            await rejectsWith(repository.publishReplayPlan(plan), ReplayDefinitionLineageError);
          }

          const crossScope = replayPlan(
            "plan_lineage_cross_scope",
            scope("plan_lineage", "other"),
            release,
            "plan_lineage_cross_scope",
            "plv_plan_lineage_cross_scope",
            sha("9"),
            [simulationBoundary("plan_lineage_cross_scope", reference(release))],
          );
          await rejectsWith(repository.publishReplayPlan(crossScope), ReplayDefinitionLineageError);

          const simulator = targetRelease(
            "plan_lineage_simulator",
            authorizedScope,
            "target_plan_lineage_simulator",
            "trg_plan_lineage_simulator_001",
          );
          const simulated = replayPlan(
            "plan_lineage_simulated",
            authorizedScope,
            release,
            "plan_lineage_simulated",
            "plv_plan_lineage_simulated_001",
            sha("9"),
            [simulationBoundary("plan_lineage_simulated", reference(simulator))],
          );
          await rejectsWith(repository.publishReplayPlan(simulated), ReplayDefinitionLineageError);
          await repository.publishTargetRelease(simulator);
          equal((await repository.publishReplayPlan(simulated)).created, true, "simulated plan");
        });
      },
    },
    {
      name: "rejects replay plan version and tenant-wide resource rebinding",
      async run(factory) {
        await withHarness(factory, "plan_conflict", async ({ repository }) => {
          const authorizedScope = scope("plan_conflict");
          const release = targetRelease(
            "plan_conflict",
            authorizedScope,
            "target_plan_conflict",
            "trg_plan_conflict_001",
          );
          await repository.publishTargetRelease(release);
          const plan = replayPlan(
            "plan_conflict",
            authorizedScope,
            release,
            "plan_conflict",
            "plv_plan_conflict_001",
          );
          await repository.publishReplayPlan(plan);
          await rejectsWith(
            repository.publishReplayPlan(
              replayPlan(
                "plan_conflict",
                authorizedScope,
                release,
                plan.planId,
                plan.planVersionId,
                sha("f"),
              ),
            ),
            ReplayDefinitionConflictError,
          );
          const otherScope = scope("plan_conflict", "other");
          const otherRelease = targetRelease(
            "plan_conflict_other",
            otherScope,
            "target_plan_conflict_other",
            "trg_plan_conflict_other_001",
          );
          await repository.publishTargetRelease(otherRelease);
          await rejectsWith(
            repository.publishReplayPlan(
              replayPlan(
                "plan_conflict_other",
                otherScope,
                otherRelease,
                plan.planId,
                "plv_plan_conflict_002",
              ),
            ),
            ReplayDefinitionConflictError,
          );
          equal(
            await repository.findReplayPlan(otherScope, plan.planVersionId),
            null,
            "plan scope hide",
          );
        });
      },
    },
    {
      name: "owns published values across caller and reader mutation",
      async run(factory) {
        await withHarness(factory, "ownership", async ({ repository }) => {
          const authorizedScope = scope("ownership");
          const release = targetRelease(
            "ownership",
            authorizedScope,
            "target_ownership",
            "trg_ownership_001",
          );
          await repository.publishTargetRelease(release);
          release.runtime.entryPoint = "mutated.js";
          const firstRelease = await repository.findTargetRelease(
            authorizedScope,
            release.targetReleaseId,
          );
          assert(firstRelease, "stored target release");
          equal(firstRelease.runtime.entryPoint, "dist/target.js", "target write ownership");
          firstRelease.runtime.entryPoint = "read-mutated.js";
          equal(
            (await repository.findTargetRelease(authorizedScope, release.targetReleaseId))?.runtime
              .entryPoint,
            "dist/target.js",
            "target read ownership",
          );

          const authoritativeRelease = await repository.findTargetRelease(
            authorizedScope,
            release.targetReleaseId,
          );
          assert(authoritativeRelease, "authoritative target release");
          const plan = replayPlan(
            "ownership",
            authorizedScope,
            authoritativeRelease,
            "plan_ownership",
            "plv_ownership_001",
          );
          await repository.publishReplayPlan(plan);
          plan.dataset.datasetId = "dat_mutated";
          const firstPlan = await repository.findReplayPlan(authorizedScope, plan.planVersionId);
          assert(firstPlan, "stored replay plan");
          equal(firstPlan.dataset.datasetId, "dat_ownership", "plan write ownership");
          firstPlan.dataset.datasetId = "dat_read_mutated";
          equal(
            (await repository.findReplayPlan(authorizedScope, plan.planVersionId))?.dataset
              .datasetId,
            "dat_ownership",
            "plan read ownership",
          );
        });
      },
    },
    {
      name: "rolls back definition and outbox state when intent insertion fails",
      async run(factory) {
        await withHarness(
          factory,
          "intent_failure",
          async ({ failNextPublicationIntent, publishedIntents, repository }) => {
            const authorizedScope = scope("intent_failure");
            const release = targetRelease(
              "intent_failure",
              authorizedScope,
              "target_intent_failure",
              "trg_intent_failure_001",
            );
            await failNextPublicationIntent("target_release");
            await rejectsWith(repository.publishTargetRelease(release), Error);
            equal(
              await repository.findTargetRelease(authorizedScope, release.targetReleaseId),
              null,
              "rolled back target",
            );
            equal(
              (await publishedIntents(authorizedScope.tenantId)).length,
              0,
              "rolled back target intent",
            );
            await repository.publishTargetRelease(release);

            const plan = replayPlan(
              "intent_failure",
              authorizedScope,
              release,
              "plan_intent_failure",
              "plv_intent_failure_001",
            );
            await failNextPublicationIntent("replay_plan");
            await rejectsWith(repository.publishReplayPlan(plan), Error);
            equal(
              await repository.findReplayPlan(authorizedScope, plan.planVersionId),
              null,
              "rolled back plan",
            );
            equal(
              (await publishedIntents(authorizedScope.tenantId)).length,
              1,
              "rolled back plan intent",
            );
            await repository.publishReplayPlan(plan);
          },
        );
      },
    },
    {
      name: "detects a missing canonical publication intent on idempotent retry",
      async run(factory) {
        await withHarness(
          factory,
          "missing_target_intent",
          async ({ removePublicationIntent, repository }) => {
            const authorizedScope = scope("missing_target_intent");
            const release = targetRelease(
              "missing_target_intent",
              authorizedScope,
              "target_missing_target_intent",
              "trg_missing_target_intent_001",
            );
            await repository.publishTargetRelease(release);
            await removePublicationIntent(
              "target_release",
              authorizedScope.tenantId,
              release.targetReleaseId,
            );
            await rejectsWith(
              repository.publishTargetRelease(release),
              ReplayRepositoryContractError,
            );
          },
        );
        await withHarness(
          factory,
          "missing_plan_intent",
          async ({ removePublicationIntent, repository }) => {
            const authorizedScope = scope("missing_plan_intent");
            const release = targetRelease(
              "missing_plan_intent",
              authorizedScope,
              "target_missing_plan_intent",
              "trg_missing_plan_intent_001",
            );
            await repository.publishTargetRelease(release);
            const plan = replayPlan(
              "missing_plan_intent",
              authorizedScope,
              release,
              "plan_missing_plan_intent",
              "plv_missing_plan_intent_001",
            );
            await repository.publishReplayPlan(plan);
            await removePublicationIntent(
              "replay_plan",
              authorizedScope.tenantId,
              plan.planVersionId,
            );
            await rejectsWith(repository.publishReplayPlan(plan), ReplayRepositoryContractError);
          },
        );
      },
    },
    {
      name: "linearizes conflicting target and replay plan publication races",
      async run(factory) {
        await withHarness(factory, "races", async ({ publishedIntents, repository }) => {
          const authorizedScope = scope("races");
          const firstRelease = targetRelease(
            "races",
            authorizedScope,
            "target_races",
            "trg_races_001",
            "6",
          );
          const secondRelease = targetRelease(
            "races",
            authorizedScope,
            firstRelease.targetId,
            firstRelease.targetReleaseId,
            "7",
          );
          const releaseRace = winnerAndLoser(
            await Promise.allSettled([
              repository.publishTargetRelease(firstRelease),
              repository.publishTargetRelease(secondRelease),
            ]),
          );
          assert(
            releaseRace.loser.reason instanceof ReplayDefinitionConflictError,
            "target conflict",
          );
          const storedRelease = await repository.findTargetRelease(
            authorizedScope,
            firstRelease.targetReleaseId,
          );
          assert(storedRelease, "target race winner");

          const firstPlan = replayPlan(
            "races",
            authorizedScope,
            storedRelease,
            "plan_races",
            "plv_races_001",
            sha("9"),
          );
          const secondPlan = replayPlan(
            "races",
            authorizedScope,
            storedRelease,
            firstPlan.planId,
            firstPlan.planVersionId,
            sha("f"),
          );
          const planRace = winnerAndLoser(
            await Promise.allSettled([
              repository.publishReplayPlan(firstPlan),
              repository.publishReplayPlan(secondPlan),
            ]),
          );
          assert(planRace.loser.reason instanceof ReplayDefinitionConflictError, "plan conflict");
          equal((await publishedIntents(authorizedScope.tenantId)).length, 2, "race intent count");
        });
      },
    },
  ];
