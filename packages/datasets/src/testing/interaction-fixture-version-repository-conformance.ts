import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type {
  ArtifactMetadata,
  ArtifactTombstone,
  EvidenceScope,
  InteractionArtifactBinding,
  InteractionCaptureManifest,
  InteractionFixtureContentRevocation,
  RecordedInteractionFixtureVersion,
  RecordedInteractionFixtureVersionDefinition,
  RegressionDatasetVersionDefinition,
  RegressionFixtureVersion,
  RegressionFixtureVersionDefinition,
} from "@proofstack/contracts";
import {
  RecordedInteractionFixtureVersionDefinitionSchema,
  RecordedInteractionFixtureVersionSchema,
  RegressionDatasetVersionSchema,
  RegressionFixtureVersionSchema,
} from "@proofstack/contracts";
import {
  RegressionArtifactBindingError,
  RegressionFixtureContentRevocationConflictError,
  RegressionRepositoryContractError,
  RegressionVersionConflictError,
  RegressionVersionLineageError,
  RegressionVersionNotFoundError,
} from "../errors.js";
import { digestRecordedInteractionFixtureVersionDefinition } from "../interaction-fixture-definition-digest.js";
import {
  digestRegressionDatasetVersionDefinition,
  digestRegressionFixtureVersionDefinition,
} from "../regression-definition-digest.js";
import {
  buildRecordedInteractionFixtureVersionPublishedOutboxIntent,
  buildRegressionFixtureVersionPublishedOutboxIntent,
  type RegressionVersionPublishedOutboxIntent,
} from "../regression-publication-outbox.js";
import type { InteractionFixtureVersionRepository } from "../regression-version-repository.js";
import type { RegressionVersionPublicationKind } from "./regression-version-repository-test-control.js";

const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";

const vectorDocument = JSON.parse(
  readFileSync(
    new URL("../../vectors/interaction-fixture-definition-v2.json", import.meta.url),
    "utf8",
  ),
) as {
  readonly vectors: readonly {
    readonly input: RecordedInteractionFixtureVersionDefinition;
  }[];
};

const vectorDefinition = RecordedInteractionFixtureVersionDefinitionSchema.parse(
  vectorDocument.vectors[0]?.input,
);

function capture(): InteractionCaptureManifest {
  return structuredClone(vectorDefinition.interactionCapture);
}

function scope(namespace: string, overrides: Partial<EvidenceScope> = {}): EvidenceScope {
  return {
    environmentId: `env_${namespace}`,
    projectId: `prj_${namespace}`,
    tenantId: `ten_${namespace}`,
    ...overrides,
  };
}

function evidenceFixture(
  namespace: string,
  overrides: Partial<RegressionFixtureVersionDefinition> = {},
): RegressionFixtureVersion {
  const definition: RegressionFixtureVersionDefinition = {
    fixtureId: `fix_${namespace}`,
    fixtureVersionId: `fixv_${namespace}_evidence`,
    name: `Evidence fixture ${namespace}`,
    replayability: "evidence_only",
    schemaVersion: "0.1",
    scope: scope(namespace),
    source: {
      eventIds: [`evt_${namespace}_failure`],
      kind: "trace_snapshot",
      observedEventCount: 1,
      sourceCompleteness: "observed_snapshot",
      traceId: TRACE_ID,
    },
    ...overrides,
  };
  return RegressionFixtureVersionSchema.parse({
    ...definition,
    createdAt: "2026-08-29T05:00:30.000Z",
    createdByPrincipalId: `usr_${namespace}_observer`,
    definitionSha256: digestRegressionFixtureVersionDefinition(definition),
    source: { ...definition.source, capturedAt: "2026-08-29T05:00:00.000Z" },
  });
}

interface RecordedOptions {
  readonly createdAt?: string;
  readonly createdByPrincipalId?: string;
  readonly fixtureId?: string;
  readonly fixtureVersionId?: string;
  readonly interactionCapture?: InteractionCaptureManifest;
  readonly name?: string;
  readonly predecessor: RegressionFixtureVersion;
  readonly predecessorDigest?: string;
  readonly scope?: EvidenceScope;
  readonly source?: RegressionFixtureVersion["source"];
}

function recordedFixture(namespace: string, options: RecordedOptions) {
  const predecessor = options.predecessor;
  const source = options.source ?? predecessor.source;
  const definition = RecordedInteractionFixtureVersionDefinitionSchema.parse({
    fixtureId: options.fixtureId ?? predecessor.fixtureId,
    fixtureVersionId: options.fixtureVersionId ?? `fixv_${namespace}_recorded`,
    interactionCapture: options.interactionCapture ?? capture(),
    name: options.name ?? `Recorded fixture ${namespace}`,
    predecessor: {
      definitionSha256: options.predecessorDigest ?? predecessor.definitionSha256,
      fixtureVersionId: predecessor.fixtureVersionId,
    },
    replayability: "recorded_interactions",
    schemaVersion: "0.2",
    scope: options.scope ?? predecessor.scope,
    source: {
      eventIds: source.eventIds,
      kind: source.kind,
      observedEventCount: source.observedEventCount,
      sourceCompleteness: source.sourceCompleteness,
      traceId: source.traceId,
    },
  });
  return RecordedInteractionFixtureVersionSchema.parse({
    ...definition,
    createdAt: options.createdAt ?? "2026-08-29T05:01:00.000Z",
    createdByPrincipalId: options.createdByPrincipalId ?? `usr_${namespace}_manager`,
    definitionSha256: digestRecordedInteractionFixtureVersionDefinition(definition),
    source,
  });
}

function artifactMetadata(
  version: RecordedInteractionFixtureVersion,
  binding: InteractionArtifactBinding,
): ArtifactMetadata {
  return {
    availableAt: "2026-08-29T05:00:50.000Z",
    contentReference: binding.contentReference,
    createdAt: "2026-08-29T05:00:40.000Z",
    redaction: binding.redaction,
    retention: binding.retention,
    schemaVersion: "0.1",
    scope: version.scope,
    state: "available",
  };
}

function reference(version: RecordedInteractionFixtureVersion) {
  return {
    definitionSha256: version.definitionSha256,
    fixtureId: version.fixtureId,
    fixtureVersionId: version.fixtureVersionId,
  };
}

function revocationCandidate(
  version: RecordedInteractionFixtureVersion,
  ownerships: readonly { readonly artifactId: string }[],
  overrides: {
    readonly reason?: string;
    readonly revocationId?: string;
    readonly revokedAt?: string;
    readonly revokedByPrincipalId?: string;
  } = {},
): {
  readonly revocation: InteractionFixtureContentRevocation;
  readonly tombstones: readonly ArtifactTombstone[];
} {
  const revocation: InteractionFixtureContentRevocation = {
    fixtureId: version.fixtureId,
    fixtureVersionId: version.fixtureVersionId,
    reason: overrides.reason ?? "Revoke the complete captured interaction content set",
    revocationId: overrides.revocationId ?? `rev_${version.fixtureVersionId}`,
    revokedAt: overrides.revokedAt ?? "2026-08-29T05:03:00.000Z",
    revokedByPrincipalId: overrides.revokedByPrincipalId ?? "usr_privacy_operator",
    schemaVersion: "0.1",
    scope: version.scope,
  };
  return {
    revocation,
    tombstones: ownerships.map(({ artifactId }, index) => ({
      actorPrincipalId: revocation.revokedByPrincipalId,
      artifactId,
      occurredAt: revocation.revokedAt,
      reason: revocation.reason,
      tombstoneId: `del_${version.fixtureVersionId}_${index}`,
      trigger: "fixture_revocation",
    })),
  };
}

export interface InteractionFixtureVersionRepositoryTestHarness {
  readonly dispose?: () => Promise<void>;
  readonly failNextPublicationIntent: (
    kind: RegressionVersionPublicationKind,
  ) => Promise<void> | void;
  readonly publishedIntents: (
    tenantId: string,
  ) => Promise<readonly RegressionVersionPublishedOutboxIntent[]>;
  readonly repository: InteractionFixtureVersionRepository;
  readonly seedInteractionArtifact: (metadata: ArtifactMetadata) => Promise<void> | void;
}

export type InteractionFixtureVersionRepositoryTestFactory = (
  namespace: string,
) =>
  | Promise<InteractionFixtureVersionRepositoryTestHarness>
  | InteractionFixtureVersionRepositoryTestHarness;

export interface InteractionFixtureVersionRepositoryConformanceCase {
  readonly name: string;
  readonly run: (factory: InteractionFixtureVersionRepositoryTestFactory) => Promise<void>;
}

async function withHarness(
  factory: InteractionFixtureVersionRepositoryTestFactory,
  namespace: string,
  test: (harness: InteractionFixtureVersionRepositoryTestHarness) => Promise<void>,
): Promise<void> {
  const harness = await factory(namespace);
  try {
    await test(harness);
  } finally {
    await harness.dispose?.();
  }
}

async function publishPrerequisites(
  harness: InteractionFixtureVersionRepositoryTestHarness,
  predecessor: RegressionFixtureVersion,
  candidate: RecordedInteractionFixtureVersion,
): Promise<void> {
  for (const binding of candidate.interactionCapture.artifacts) {
    await harness.seedInteractionArtifact(artifactMetadata(candidate, binding));
  }
  await harness.repository.publishFixtureVersion(predecessor);
}

export const interactionFixtureVersionRepositoryConformanceCases: readonly InteractionFixtureVersionRepositoryConformanceCase[] =
  [
    {
      name: "atomically publishes canonical fixture ownership and retries without new provenance",
      run: async (factory) =>
        withHarness(factory, "interaction_publish", async (harness) => {
          const predecessor = evidenceFixture("interaction_publish");
          const candidate = recordedFixture("interaction_publish", { predecessor });
          await publishPrerequisites(harness, predecessor, candidate);
          const firstMetadata = artifactMetadata(
            candidate,
            candidate.interactionCapture.artifacts[0] as InteractionArtifactBinding,
          );
          await harness.seedInteractionArtifact(firstMetadata);
          await assert.rejects(
            Promise.resolve().then(() =>
              harness.seedInteractionArtifact({
                ...firstMetadata,
                contentReference: { ...firstMetadata.contentReference, sha256: "e".repeat(64) },
              }),
            ),
            RegressionArtifactBindingError,
          );

          const first =
            await harness.repository.publishRecordedInteractionFixtureVersion(candidate);
          const retry = await harness.repository.publishRecordedInteractionFixtureVersion({
            ...candidate,
            createdAt: "2026-08-29T05:02:00.000Z",
            createdByPrincipalId: "usr_retry",
          });

          assert.equal(first.created, true);
          assert.equal(retry.created, false);
          assert.deepEqual(retry.version, first.version);
          assert.deepEqual(retry.ownerships, first.ownerships);
          const conflicting = recordedFixture("interaction_publish", {
            name: "Conflicting recorded fixture",
            predecessor,
          });
          await assert.rejects(
            harness.repository.publishRecordedInteractionFixtureVersion(conflicting),
            RegressionVersionConflictError,
          );
          assert.deepEqual(
            await harness.repository.findRecordedInteractionFixtureVersion(
              candidate.scope,
              candidate.fixtureVersionId,
            ),
            { ownerships: first.ownerships, version: first.version },
          );
          assert.deepEqual(
            await harness.repository.resolveFixtureVersionReferences(candidate.scope, [
              {
                fixtureId: candidate.fixtureId,
                fixtureVersionId: candidate.fixtureVersionId,
              },
            ]),
            [reference(candidate)],
          );
          assert.deepEqual(
            await harness.publishedIntents(candidate.scope.tenantId),
            [
              expectIntentForEvidence(predecessor),
              buildRecordedInteractionFixtureVersionPublishedOutboxIntent(candidate),
            ].sort(compareIntent),
          );
        }),
    },
    {
      name: "rejects unavailable, expiring, mismatched, cross-scope, and missing artifacts",
      run: async (factory) => {
        const variants = [
          "missing",
          "reserved",
          "tombstoned",
          "expire",
          "scope",
          "descriptor",
          "redaction",
        ] as const;
        const mutation: Record<
          (typeof variants)[number],
          (metadata: ArtifactMetadata) => ArtifactMetadata | null
        > = {
          descriptor: (metadata) => ({
            ...metadata,
            contentReference: { ...metadata.contentReference, sha256: "f".repeat(64) },
          }),
          expire: (metadata) => ({
            ...metadata,
            retention: { expiresAt: "2026-09-29T00:00:00.000Z", mode: "expire" },
          }),
          missing: () => null,
          redaction: (metadata) => ({ ...metadata, redaction: { status: "not_performed" } }),
          reserved: (metadata) => {
            const { availableAt: _availableAt, ...reserved } = metadata;
            return { ...reserved, state: "reserved" };
          },
          scope: (metadata) => ({
            ...metadata,
            scope: { ...metadata.scope, projectId: `${metadata.scope.projectId}_other` },
          }),
          tombstoned: (metadata) => ({
            ...metadata,
            state: "tombstoned",
            tombstonedAt: "2026-08-29T05:00:55.000Z",
          }),
        };
        for (const variant of variants) {
          const namespace = `interaction_artifact_${variant}`;
          await withHarness(factory, namespace, async (harness) => {
            const predecessor = evidenceFixture(namespace);
            const candidate = recordedFixture(namespace, { predecessor });
            await harness.repository.publishFixtureVersion(predecessor);
            const firstArtifactId =
              candidate.interactionCapture.artifacts[0]?.contentReference.artifactId;
            assert.ok(firstArtifactId);
            for (const binding of candidate.interactionCapture.artifacts) {
              const metadata = artifactMetadata(candidate, binding);
              const variantMetadata =
                binding.contentReference.artifactId === firstArtifactId
                  ? mutation[variant](metadata)
                  : metadata;
              if (variantMetadata === null) continue;
              await harness.seedInteractionArtifact(variantMetadata);
            }

            await assert.rejects(
              harness.repository.publishRecordedInteractionFixtureVersion(candidate),
              RegressionArtifactBindingError,
            );
            assert.equal(
              await harness.repository.findRecordedInteractionFixtureVersion(
                candidate.scope,
                candidate.fixtureVersionId,
              ),
              null,
            );
          });
        }
      },
    },
    {
      name: "makes artifact ownership exclusive across immutable fixture versions",
      run: async (factory) =>
        withHarness(factory, "interaction_ownership", async (harness) => {
          const predecessor = evidenceFixture("interaction_ownership");
          const first = recordedFixture("interaction_ownership", { predecessor });
          const second = recordedFixture("interaction_ownership", {
            fixtureVersionId: "fixv_interaction_ownership_recorded_002",
            predecessor,
          });
          await publishPrerequisites(harness, predecessor, first);
          await harness.repository.publishRecordedInteractionFixtureVersion(first);

          await assert.rejects(
            harness.repository.publishRecordedInteractionFixtureVersion(second),
            RegressionArtifactBindingError,
          );
          assert.equal(
            await harness.repository.findRecordedInteractionFixtureVersion(
              second.scope,
              second.fixtureVersionId,
            ),
            null,
          );
        }),
    },
    {
      name: "requires exact evidence lineage, scope, digest, and source provenance",
      run: async (factory) => {
        const variants = [
          "missing",
          "predecessor",
          "fixture",
          "digest",
          "source",
          "scope",
        ] as const;
        for (const variant of variants) {
          const namespace = `interaction_lineage_${variant}`;
          await withHarness(factory, namespace, async (harness) => {
            const predecessor = evidenceFixture(namespace);
            if (variant !== "missing") await harness.repository.publishFixtureVersion(predecessor);
            let candidate = recordedFixture(namespace, { predecessor });
            if (variant === "predecessor") {
              candidate = recordedFixture(namespace, {
                predecessor: evidenceFixture(namespace, {
                  fixtureVersionId: `fixv_${namespace}_unpublished`,
                }),
              });
            } else if (variant === "fixture") {
              candidate = recordedFixture(namespace, {
                fixtureId: `fix_${namespace}_other`,
                predecessor,
              });
            } else if (variant === "digest") {
              candidate = recordedFixture(namespace, {
                predecessor,
                predecessorDigest: "f".repeat(64),
              });
            } else if (variant === "source") {
              candidate = recordedFixture(namespace, {
                predecessor,
                source: {
                  ...predecessor.source,
                  capturedAt: "2026-08-29T04:59:59.000Z",
                },
              });
            } else if (variant === "scope") {
              candidate = recordedFixture(namespace, {
                predecessor,
                scope: { ...predecessor.scope, projectId: `prj_${namespace}_other` },
              });
            }
            if (variant !== "missing") {
              for (const binding of candidate.interactionCapture.artifacts) {
                await harness.seedInteractionArtifact(artifactMetadata(candidate, binding));
              }
            }

            await assert.rejects(
              harness.repository.publishRecordedInteractionFixtureVersion(candidate),
              variant === "scope" ? RegressionVersionConflictError : RegressionVersionLineageError,
            );
          });
        }
      },
    },
    {
      name: "keeps evidence and recorded identifiers globally exclusive and admits recorded dataset members",
      run: async (factory) =>
        withHarness(factory, "interaction_identity", async (harness) => {
          const predecessor = evidenceFixture("interaction_identity");
          const candidate = recordedFixture("interaction_identity", { predecessor });
          await publishPrerequisites(harness, predecessor, candidate);
          const evidenceCollision = evidenceFixture("interaction_identity", {
            fixtureVersionId: "fixv_interaction_identity_evidence_collision",
            predecessor: {
              definitionSha256: predecessor.definitionSha256,
              fixtureVersionId: predecessor.fixtureVersionId,
            },
          });
          const recordedCollision = recordedFixture("interaction_identity", {
            fixtureVersionId: evidenceCollision.fixtureVersionId,
            predecessor,
          });
          await harness.repository.publishFixtureVersion(evidenceCollision);
          await assert.rejects(
            harness.repository.publishRecordedInteractionFixtureVersion(recordedCollision),
            RegressionVersionConflictError,
          );
          await harness.repository.publishRecordedInteractionFixtureVersion(candidate);
          const evidenceAfterRecorded = evidenceFixture("interaction_identity", {
            fixtureVersionId: candidate.fixtureVersionId,
            predecessor: {
              definitionSha256: evidenceCollision.definitionSha256,
              fixtureVersionId: evidenceCollision.fixtureVersionId,
            },
          });
          await assert.rejects(
            harness.repository.publishFixtureVersion(evidenceAfterRecorded),
            RegressionVersionConflictError,
          );

          const datasetDefinition: RegressionDatasetVersionDefinition = {
            datasetId: "dat_interaction_identity",
            datasetVersionId: "datv_interaction_identity_001",
            fixtureVersions: [reference(candidate)],
            name: "Recorded interaction dataset",
            schemaVersion: "0.1",
            scope: candidate.scope,
          };
          const dataset = RegressionDatasetVersionSchema.parse({
            ...datasetDefinition,
            createdAt: "2026-08-29T05:02:00.000Z",
            createdByPrincipalId: "usr_interaction_identity_manager",
            definitionSha256: digestRegressionDatasetVersionDefinition(datasetDefinition),
          });
          await assert.doesNotReject(harness.repository.publishDatasetVersion(dataset));
        }),
    },
    {
      name: "rolls back version, ownership, and outbox when the publication intent fails",
      run: async (factory) =>
        withHarness(factory, "interaction_atomic", async (harness) => {
          const predecessor = evidenceFixture("interaction_atomic");
          const candidate = recordedFixture("interaction_atomic", { predecessor });
          await publishPrerequisites(harness, predecessor, candidate);
          await harness.failNextPublicationIntent("interaction_fixture");

          await assert.rejects(
            harness.repository.publishRecordedInteractionFixtureVersion(candidate),
            /Injected interaction_fixture regression publication intent failure/,
          );
          assert.equal(
            await harness.repository.findRecordedInteractionFixtureVersion(
              candidate.scope,
              candidate.fixtureVersionId,
            ),
            null,
          );
          const afterFailure = await harness.publishedIntents(candidate.scope.tenantId);
          assert.equal(afterFailure.length, 1);

          const recovered =
            await harness.repository.publishRecordedInteractionFixtureVersion(candidate);
          assert.equal(recovered.created, true);
          assert.equal((await harness.publishedIntents(candidate.scope.tenantId)).length, 2);
        }),
    },
    {
      name: "atomically revokes the complete owned content set and preserves first attribution",
      run: async (factory) =>
        withHarness(factory, "interaction_revoke", async (harness) => {
          const predecessor = evidenceFixture("interaction_revoke");
          const candidate = recordedFixture("interaction_revoke", { predecessor });
          await publishPrerequisites(harness, predecessor, candidate);
          const published =
            await harness.repository.publishRecordedInteractionFixtureVersion(candidate);
          const revocation = revocationCandidate(candidate, published.ownerships);

          assert.equal(
            (
              await harness.repository.findRecordedInteractionFixtureContent(
                candidate.scope,
                candidate.fixtureVersionId,
              )
            )?.contentAvailability,
            "available",
          );
          const first =
            await harness.repository.revokeRecordedInteractionFixtureContent(revocation);
          assert.equal(first.created, true);
          assert.equal(first.contentAvailability, "revoked");
          assert.deepEqual(first.revocation, revocation.revocation);
          assert.deepEqual(first.tombstones, revocation.tombstones);

          const retryCandidate = revocationCandidate(candidate, published.ownerships, {
            revocationId: "rev_retry",
            revokedAt: "2026-08-29T05:04:00.000Z",
            revokedByPrincipalId: "usr_retry",
          });
          const retry =
            await harness.repository.revokeRecordedInteractionFixtureContent(retryCandidate);
          assert.equal(retry.created, false);
          assert.deepEqual(retry.revocation, first.revocation);
          assert.deepEqual(retry.tombstones, first.tombstones);

          await assert.rejects(
            harness.repository.revokeRecordedInteractionFixtureContent(
              revocationCandidate(candidate, published.ownerships, {
                reason: "A different immutable decision",
              }),
            ),
            RegressionFixtureContentRevocationConflictError,
          );
        }),
    },
    {
      name: "rolls back every content tombstone when revocation commit fails",
      run: async (factory) =>
        withHarness(factory, "interaction_revoke_atomic", async (harness) => {
          const predecessor = evidenceFixture("interaction_revoke_atomic");
          const candidate = recordedFixture("interaction_revoke_atomic", { predecessor });
          await publishPrerequisites(harness, predecessor, candidate);
          const published =
            await harness.repository.publishRecordedInteractionFixtureVersion(candidate);
          const revocation = revocationCandidate(candidate, published.ownerships);
          await harness.failNextPublicationIntent("interaction_revocation");

          await assert.rejects(
            harness.repository.revokeRecordedInteractionFixtureContent(revocation),
            /Injected interaction_revocation regression publication intent failure/,
          );
          assert.deepEqual(
            await harness.repository.findRecordedInteractionFixtureContent(
              candidate.scope,
              candidate.fixtureVersionId,
            ),
            {
              contentAvailability: "available",
              ownerships: published.ownerships,
              revocation: null,
              tombstones: [],
              version: candidate,
            },
          );
          assert.equal(
            (await harness.repository.revokeRecordedInteractionFixtureContent(revocation))
              .contentAvailability,
            "revoked",
          );
        }),
    },
    {
      name: "rejects missing, partial, and non-canonical fixture revocation candidates",
      run: async (factory) =>
        withHarness(factory, "interaction_revoke_contract", async (harness) => {
          const predecessor = evidenceFixture("interaction_revoke_contract");
          const candidate = recordedFixture("interaction_revoke_contract", { predecessor });
          const unboundOwnerships = candidate.interactionCapture.artifacts.map(
            ({ contentReference }) => ({ artifactId: contentReference.artifactId }),
          );
          await assert.rejects(
            harness.repository.revokeRecordedInteractionFixtureContent(
              revocationCandidate(candidate, unboundOwnerships),
            ),
            RegressionVersionNotFoundError,
          );

          await publishPrerequisites(harness, predecessor, candidate);
          const published =
            await harness.repository.publishRecordedInteractionFixtureVersion(candidate);
          const valid = revocationCandidate(candidate, published.ownerships);
          const firstTombstone = valid.tombstones[0];
          assert.ok(firstTombstone);
          await assert.rejects(
            harness.repository.revokeRecordedInteractionFixtureContent({
              ...valid,
              tombstones: valid.tombstones.slice(1),
            }),
            RegressionRepositoryContractError,
          );
          await assert.rejects(
            harness.repository.revokeRecordedInteractionFixtureContent({
              ...valid,
              tombstones: [
                { ...firstTombstone, actorPrincipalId: "usr_wrong_actor" },
                ...valid.tombstones.slice(1),
              ],
            }),
            RegressionRepositoryContractError,
          );
          assert.equal(
            (
              await harness.repository.findRecordedInteractionFixtureContent(
                candidate.scope,
                candidate.fixtureVersionId,
              )
            )?.contentAvailability,
            "available",
          );
        }),
    },
    {
      name: "hides recorded fixture metadata outside the exact project and environment",
      run: async (factory) =>
        withHarness(factory, "interaction_scope", async (harness) => {
          const predecessor = evidenceFixture("interaction_scope");
          const candidate = recordedFixture("interaction_scope", { predecessor });
          await publishPrerequisites(harness, predecessor, candidate);
          await harness.repository.publishRecordedInteractionFixtureVersion(candidate);

          for (const hidden of [
            { ...candidate.scope, projectId: "prj_hidden" },
            { ...candidate.scope, environmentId: "env_hidden" },
            { ...candidate.scope, tenantId: "ten_hidden" },
          ]) {
            assert.equal(
              await harness.repository.findRecordedInteractionFixtureVersion(
                hidden,
                candidate.fixtureVersionId,
              ),
              null,
            );
            assert.equal(
              await harness.repository.findRecordedInteractionFixtureContent(
                hidden,
                candidate.fixtureVersionId,
              ),
              null,
            );
          }
        }),
    },
  ];

function expectIntentForEvidence(
  version: RegressionFixtureVersion,
): RegressionVersionPublishedOutboxIntent {
  return buildRegressionFixtureVersionPublishedOutboxIntent(version);
}

function compareIntent(
  left: RegressionVersionPublishedOutboxIntent,
  right: RegressionVersionPublishedOutboxIntent,
): number {
  return `${left.eventType}\u0000${left.aggregateType}\u0000${left.aggregateId}`.localeCompare(
    `${right.eventType}\u0000${right.aggregateType}\u0000${right.aggregateId}`,
  );
}
