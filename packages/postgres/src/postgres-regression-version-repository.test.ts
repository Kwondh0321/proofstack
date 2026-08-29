import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import {
  type ArtifactMetadata,
  type ArtifactOwnership,
  type ArtifactTombstone,
  type EvidenceScope,
  type InteractionFixtureContentRevocation,
  RecordedInteractionFixtureVersionDefinitionSchema,
  RecordedInteractionFixtureVersionSchema,
  type RecordedInteractionFixtureVersion,
  RegressionDatasetVersionDefinitionSchema,
  RegressionDatasetVersionSchema,
  type RegressionDatasetVersion,
  RegressionFixtureVersionDefinitionSchema,
  RegressionFixtureVersionSchema,
  type RegressionFixtureVersion,
} from "@proofstack/contracts";
import {
  buildRecordedInteractionFixtureVersionPublishedOutboxIntent,
  buildRegressionFixtureVersionPublishedOutboxIntent,
  digestRecordedInteractionFixtureVersionDefinition,
  digestRegressionDatasetVersionDefinition,
  digestRegressionFixtureVersionDefinition,
  InvalidRegressionVersionInputError,
  RegressionArtifactBindingError,
  RegressionFixtureContentRevocationConflictError,
  RegressionRepositoryContractError,
  RegressionVersionConflictError,
  RegressionVersionLineageError,
} from "@proofstack/datasets";
import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { PostgresRegressionVersionRepository } from "./postgres-regression-version-repository.js";

type QueryHandler = (
  text: string,
  values: readonly unknown[] | undefined,
) => {
  readonly rowCount?: number;
  readonly rows: readonly Record<string, unknown>[];
};

class FakeClient {
  readonly queries: Array<{ readonly text: string; readonly values?: readonly unknown[] }> = [];
  readonly releaseArguments: Array<boolean | undefined> = [];

  constructor(private readonly handler: QueryHandler) {}

  async query(text: string, values?: readonly unknown[]) {
    this.queries.push({ text, ...(values ? { values } : {}) });
    if (
      text === "BEGIN" ||
      text === "COMMIT" ||
      text === "ROLLBACK" ||
      text.includes("set_config")
    ) {
      return { rows: [] };
    }
    return this.handler(text, values);
  }

  release(argument?: boolean): void {
    this.releaseArguments.push(argument);
  }
}

function harness(handler: QueryHandler): {
  readonly client: FakeClient;
  readonly connections: { count: number };
  readonly repository: PostgresRegressionVersionRepository;
} {
  const connections = { count: 0 };
  const client = new FakeClient(handler);
  const pool = {
    connect: async () => {
      connections.count += 1;
      return client;
    },
  } as unknown as Pick<Pool, "connect">;
  return {
    client,
    connections,
    repository: new PostgresRegressionVersionRepository(pool),
  };
}

const scope: EvidenceScope = {
  environmentId: "env_repository",
  projectId: "prj_repository",
  tenantId: "ten_repository",
};

const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";

function fixture(overrides: Partial<RegressionFixtureVersion> = {}): RegressionFixtureVersion {
  const fixtureId = overrides.fixtureId ?? "fix_repository";
  const fixtureVersionId = overrides.fixtureVersionId ?? "fixv_repository_001";
  const eventIds = overrides.source?.eventIds ?? ["evt_repository_a", "evt_repository_b"];
  const definition = RegressionFixtureVersionDefinitionSchema.parse({
    description: overrides.description ?? "Observed repository failure",
    fixtureId,
    fixtureVersionId,
    name: overrides.name ?? "Repository fixture",
    ...(overrides.predecessor ? { predecessor: overrides.predecessor } : {}),
    replayability: "evidence_only",
    schemaVersion: "0.1",
    scope: overrides.scope ?? scope,
    source: {
      eventIds: [...eventIds],
      kind: "trace_snapshot",
      observedEventCount: eventIds.length,
      sourceCompleteness: "observed_snapshot",
      traceId,
    },
  });
  return RegressionFixtureVersionSchema.parse({
    createdAt: overrides.createdAt ?? "2026-08-29T01:01:00.123Z",
    createdByPrincipalId: overrides.createdByPrincipalId ?? "usr_repository",
    definitionSha256: digestRegressionFixtureVersionDefinition(definition),
    ...definition,
    source: {
      capturedAt: overrides.source?.capturedAt ?? "2026-08-29T01:00:30.654321Z",
      ...definition.source,
    },
  });
}

const interactionVector = RecordedInteractionFixtureVersionDefinitionSchema.parse(
  (
    JSON.parse(
      readFileSync(
        new URL("../../datasets/vectors/interaction-fixture-definition-v2.json", import.meta.url),
        "utf8",
      ),
    ) as { readonly vectors: readonly { readonly input: unknown }[] }
  ).vectors[0]?.input,
);

function recordedFixture(
  predecessor: RegressionFixtureVersion,
  overrides: Partial<RecordedInteractionFixtureVersion> = {},
): RecordedInteractionFixtureVersion {
  const definition = RecordedInteractionFixtureVersionDefinitionSchema.parse({
    fixtureId: overrides.fixtureId ?? predecessor.fixtureId,
    fixtureVersionId: overrides.fixtureVersionId ?? "fixv_repository_recorded_002",
    interactionCapture:
      overrides.interactionCapture ?? structuredClone(interactionVector.interactionCapture),
    name: overrides.name ?? "Recorded repository fixture",
    predecessor: overrides.predecessor ?? {
      definitionSha256: predecessor.definitionSha256,
      fixtureVersionId: predecessor.fixtureVersionId,
    },
    replayability: "recorded_interactions",
    schemaVersion: "0.2",
    scope: overrides.scope ?? predecessor.scope,
    source: {
      eventIds: overrides.source?.eventIds ?? predecessor.source.eventIds,
      kind: overrides.source?.kind ?? predecessor.source.kind,
      observedEventCount:
        overrides.source?.observedEventCount ?? predecessor.source.observedEventCount,
      sourceCompleteness:
        overrides.source?.sourceCompleteness ?? predecessor.source.sourceCompleteness,
      traceId: overrides.source?.traceId ?? predecessor.source.traceId,
    },
  });
  return RecordedInteractionFixtureVersionSchema.parse({
    createdAt: overrides.createdAt ?? "2026-08-29T01:03:00.000Z",
    createdByPrincipalId: overrides.createdByPrincipalId ?? "usr_repository_manager",
    definitionSha256: digestRecordedInteractionFixtureVersionDefinition(definition),
    ...definition,
    source: {
      capturedAt: overrides.source?.capturedAt ?? predecessor.source.capturedAt,
      ...definition.source,
    },
  });
}

function interactionArtifactMetadata(
  version: RecordedInteractionFixtureVersion,
): readonly ArtifactMetadata[] {
  return version.interactionCapture.artifacts.map((binding) => ({
    availableAt: "2026-08-29T01:02:30.000Z",
    contentReference: binding.contentReference,
    createdAt: "2026-08-29T01:02:00.000Z",
    redaction: binding.redaction,
    retention: binding.retention,
    schemaVersion: "0.1",
    scope: version.scope,
    state: "available",
  }));
}

function expectedInteractionOwnerships(
  version: RecordedInteractionFixtureVersion,
): readonly ArtifactOwnership[] {
  return version.interactionCapture.artifacts.map(({ contentReference }) => ({
    artifactId: contentReference.artifactId,
    boundAt: version.createdAt,
    boundByPrincipalId: version.createdByPrincipalId,
    owner: {
      fixtureId: version.fixtureId,
      fixtureVersionId: version.fixtureVersionId,
      kind: "regression_fixture_version",
    },
    schemaVersion: "0.1",
    scope: version.scope,
  }));
}

function fixtureRevocation(version: RecordedInteractionFixtureVersion): {
  readonly revocation: InteractionFixtureContentRevocation;
  readonly tombstones: readonly ArtifactTombstone[];
} {
  const revocation: InteractionFixtureContentRevocation = {
    fixtureId: version.fixtureId,
    fixtureVersionId: version.fixtureVersionId,
    reason: "Remove the complete recorded content set",
    revocationId: `rev_${version.fixtureVersionId}`,
    revokedAt: "2026-08-29T01:05:00.000Z",
    revokedByPrincipalId: "usr_repository_privacy",
    schemaVersion: "0.1",
    scope: version.scope,
  };
  return {
    revocation,
    tombstones: version.interactionCapture.artifacts.map(({ contentReference }, index) => ({
      actorPrincipalId: revocation.revokedByPrincipalId,
      artifactId: contentReference.artifactId,
      occurredAt: revocation.revokedAt,
      reason: revocation.reason,
      tombstoneId: `del_repository_${index}`,
      trigger: "fixture_revocation",
    })),
  };
}

function dataset(
  member: RegressionFixtureVersion,
  overrides: Partial<RegressionDatasetVersion> = {},
): RegressionDatasetVersion {
  const fixtureVersions = overrides.fixtureVersions ?? [
    {
      definitionSha256: member.definitionSha256,
      fixtureId: member.fixtureId,
      fixtureVersionId: member.fixtureVersionId,
    },
  ];
  const definition = RegressionDatasetVersionDefinitionSchema.parse({
    datasetId: overrides.datasetId ?? "dat_repository",
    datasetVersionId: overrides.datasetVersionId ?? "datv_repository_001",
    description: overrides.description ?? "Observed repository dataset",
    fixtureVersions: [...fixtureVersions],
    name: overrides.name ?? "Repository dataset",
    ...(overrides.predecessor ? { predecessor: overrides.predecessor } : {}),
    schemaVersion: "0.1",
    scope: overrides.scope ?? scope,
  });
  return RegressionDatasetVersionSchema.parse({
    createdAt: overrides.createdAt ?? "2026-08-29T01:02:00.987Z",
    createdByPrincipalId: overrides.createdByPrincipalId ?? "usr_repository",
    definitionSha256: digestRegressionDatasetVersionDefinition(definition),
    ...definition,
  });
}

function fixtureHeader(
  value: RecordedInteractionFixtureVersion | RegressionFixtureVersion,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    created_at_lexical: value.createdAt,
    created_at_matches: true,
    created_by_principal_id: value.createdByPrincipalId,
    definition_sha256: value.definitionSha256,
    description: value.description ?? null,
    environment_id: value.scope.environmentId,
    fixture_id: value.fixtureId,
    fixture_version_id: value.fixtureVersionId,
    name: value.name,
    predecessor_definition_sha256: value.predecessor?.definitionSha256 ?? null,
    predecessor_fixture_version_id: value.predecessor?.fixtureVersionId ?? null,
    project_id: value.scope.projectId,
    replayability: value.replayability,
    root_definition_sha256: value.predecessor?.definitionSha256 ?? value.definitionSha256,
    root_fixture_version_id: value.predecessor?.fixtureVersionId ?? value.fixtureVersionId,
    schema_version: value.schemaVersion,
    source_captured_at_lexical: value.source.capturedAt,
    source_captured_at_matches: true,
    source_completeness: value.source.sourceCompleteness,
    source_event_count: value.source.observedEventCount,
    source_kind: value.source.kind,
    source_trace_id: value.source.traceId,
    tenant_id: value.scope.tenantId,
    ...overrides,
  };
}

function fixtureEvents(
  value: RecordedInteractionFixtureVersion | RegressionFixtureVersion,
  overrides: Record<string, unknown> = {},
): readonly Record<string, unknown>[] {
  return value.source.eventIds.map((eventId, eventPosition) => ({
    environment_id: value.scope.environmentId,
    event_id: eventId,
    event_position: eventPosition,
    fixture_id: value.fixtureId,
    fixture_version_id: value.fixtureVersionId,
    project_id: value.scope.projectId,
    source_event_count: value.source.observedEventCount,
    source_trace_id: value.source.traceId,
    tenant_id: value.scope.tenantId,
    ...overrides,
  }));
}

function fixtureIdentity(
  value: RecordedInteractionFixtureVersion | RegressionFixtureVersion,
): Record<string, unknown> {
  return {
    environment_id: value.scope.environmentId,
    fixture_id: value.fixtureId,
    fixture_version_id: value.fixtureVersionId,
    project_id: value.scope.projectId,
    tenant_id: value.scope.tenantId,
  };
}

function recordedManifest(value: RecordedInteractionFixtureVersion): Record<string, unknown> {
  return {
    environment_id: value.scope.environmentId,
    fixture_id: value.fixtureId,
    fixture_version_id: value.fixtureVersionId,
    interaction_capture: value.interactionCapture,
    project_id: value.scope.projectId,
    tenant_id: value.scope.tenantId,
  };
}

function recordedOwnershipRows(
  value: RecordedInteractionFixtureVersion,
): readonly Record<string, unknown>[] {
  return expectedInteractionOwnerships(value).map((ownership, artifactPosition) => ({
    artifact_id: ownership.artifactId,
    artifact_position: artifactPosition,
    bound_at_lexical: ownership.boundAt,
    bound_at_matches: true,
    bound_by_principal_id: ownership.boundByPrincipalId,
    environment_id: ownership.scope.environmentId,
    fixture_id: ownership.owner.fixtureId,
    fixture_version_id: ownership.owner.fixtureVersionId,
    project_id: ownership.scope.projectId,
    schema_version: ownership.schemaVersion,
    tenant_id: ownership.scope.tenantId,
  }));
}

function artifactBindingRows(
  value: RecordedInteractionFixtureVersion,
): readonly Record<string, unknown>[] {
  return interactionArtifactMetadata(value).map((metadata) => ({
    artifact_id: metadata.contentReference.artifactId,
    classification: metadata.contentReference.classification,
    content_sha256: metadata.contentReference.sha256,
    content_size_bytes: metadata.contentReference.sizeBytes,
    environment_id: metadata.scope.environmentId,
    media_type: metadata.contentReference.mediaType,
    project_id: metadata.scope.projectId,
    redaction: metadata.redaction,
    retention_mode: metadata.retention.mode,
    state: metadata.state,
    tenant_id: metadata.scope.tenantId,
  }));
}

function availabilityRows(
  value: RecordedInteractionFixtureVersion,
  state: "available" | "purged" | "tombstoned" = "available",
  tombstonedAt: string | null = null,
): readonly Record<string, unknown>[] {
  return value.interactionCapture.artifacts.map(({ contentReference }) => ({
    artifact_id: contentReference.artifactId,
    state,
    tombstoned_at_lexical: tombstonedAt,
  }));
}

function revocationRow(value: InteractionFixtureContentRevocation): Record<string, unknown> {
  return {
    environment_id: value.scope.environmentId,
    fixture_id: value.fixtureId,
    fixture_version_id: value.fixtureVersionId,
    project_id: value.scope.projectId,
    reason: value.reason,
    revocation_id: value.revocationId,
    revoked_at_lexical: value.revokedAt,
    revoked_at_matches: true,
    revoked_by_principal_id: value.revokedByPrincipalId,
    schema_version: value.schemaVersion,
    tenant_id: value.scope.tenantId,
  };
}

function tombstoneRows(values: readonly ArtifactTombstone[]): readonly Record<string, unknown>[] {
  return values.map((value) => ({
    actor_principal_id: value.actorPrincipalId,
    artifact_id: value.artifactId,
    occurred_at_lexical: value.occurredAt,
    reason: value.reason,
    tombstone_id: value.tombstoneId,
    tombstone_trigger: value.trigger,
  }));
}

function datasetHeader(
  value: RegressionDatasetVersion,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    created_at_lexical: value.createdAt,
    created_at_matches: true,
    created_by_principal_id: value.createdByPrincipalId,
    dataset_id: value.datasetId,
    dataset_version_id: value.datasetVersionId,
    definition_sha256: value.definitionSha256,
    description: value.description ?? null,
    environment_id: value.scope.environmentId,
    fixture_version_count: value.fixtureVersions.length,
    name: value.name,
    predecessor_dataset_version_id: value.predecessor?.datasetVersionId ?? null,
    predecessor_definition_sha256: value.predecessor?.definitionSha256 ?? null,
    project_id: value.scope.projectId,
    root_dataset_version_id: value.predecessor?.datasetVersionId ?? value.datasetVersionId,
    root_definition_sha256: value.predecessor?.definitionSha256 ?? value.definitionSha256,
    schema_version: value.schemaVersion,
    tenant_id: value.scope.tenantId,
    ...overrides,
  };
}

function datasetMembers(
  value: RegressionDatasetVersion,
  overrides: Record<string, unknown> = {},
): readonly Record<string, unknown>[] {
  return value.fixtureVersions.map((reference, memberPosition) => ({
    dataset_id: value.datasetId,
    dataset_version_id: value.datasetVersionId,
    environment_id: value.scope.environmentId,
    fixture_definition_sha256: reference.definitionSha256,
    fixture_id: reference.fixtureId,
    fixture_version_count: value.fixtureVersions.length,
    fixture_version_id: reference.fixtureVersionId,
    member_position: memberPosition,
    project_id: value.scope.projectId,
    tenant_id: value.scope.tenantId,
    ...overrides,
  }));
}

function fixtureResource(value: RegressionFixtureVersion): Record<string, unknown> {
  return {
    environment_id: value.scope.environmentId,
    fixture_id: value.fixtureId,
    project_id: value.scope.projectId,
    root_definition_sha256: value.definitionSha256,
    root_fixture_version_id: value.fixtureVersionId,
    tenant_id: value.scope.tenantId,
  };
}

function rowsForFixtureReads(
  text: string,
  values: readonly unknown[] | undefined,
  valuesById: ReadonlyMap<string, RegressionFixtureVersion>,
): readonly Record<string, unknown>[] | undefined {
  const ids = values?.[1];
  const requested = Array.isArray(ids) ? ids : [];
  if (text.includes("FROM public.proofstack_regression_fixture_versions")) {
    if (text.includes("replayability = 'recorded_interactions'")) return [];
    return requested.flatMap((id) => {
      const value = typeof id === "string" ? valuesById.get(id) : undefined;
      return value ? [fixtureHeader(value)] : [];
    });
  }
  if (text.includes("FROM public.proofstack_regression_fixture_events")) {
    return requested.flatMap((id) => {
      const value = typeof id === "string" ? valuesById.get(id) : undefined;
      return value ? [...fixtureEvents(value)] : [];
    });
  }
  return undefined;
}

interface RecordedReadState {
  readonly candidate: RecordedInteractionFixtureVersion;
  readonly candidateStored?: boolean;
  readonly contentState?: "available" | "purged" | "tombstoned";
  readonly predecessor: RegressionFixtureVersion;
  readonly publicationStatus?: "absent" | "canonical" | "conflict";
  readonly revocation?: InteractionFixtureContentRevocation;
  readonly tombstones?: readonly ArtifactTombstone[];
}

function rowsForRecordedReads(
  text: string,
  values: readonly unknown[] | undefined,
  state: RecordedReadState,
): { readonly rowCount?: number; readonly rows: readonly Record<string, unknown>[] } | undefined {
  const requested = Array.isArray(values?.[1]) ? values[1] : [];
  const includes = (versionId: string) => requested.includes(versionId);
  if (
    text.includes("FROM public.proofstack_regression_fixture_versions") &&
    text.includes("replayability = 'recorded_interactions'")
  ) {
    return {
      rows:
        state.candidateStored && includes(state.candidate.fixtureVersionId)
          ? [fixtureHeader(state.candidate)]
          : [],
    };
  }
  if (
    text.includes("FROM public.proofstack_regression_fixture_versions") &&
    text.includes("replayability = 'evidence_only'")
  ) {
    return {
      rows: includes(state.predecessor.fixtureVersionId) ? [fixtureHeader(state.predecessor)] : [],
    };
  }
  if (text.includes("FROM public.proofstack_regression_fixture_versions")) {
    const versions: Array<RecordedInteractionFixtureVersion | RegressionFixtureVersion> = [
      state.predecessor,
      ...(state.candidateStored ? [state.candidate] : []),
    ];
    return {
      rows: versions.filter((value) => includes(value.fixtureVersionId)).map(fixtureIdentity),
    };
  }
  if (text.includes("FROM public.proofstack_regression_fixture_events")) {
    const versions: Array<RecordedInteractionFixtureVersion | RegressionFixtureVersion> = [
      state.predecessor,
      ...(state.candidateStored ? [state.candidate] : []),
    ];
    return {
      rows: versions
        .filter((value) => includes(value.fixtureVersionId))
        .flatMap((value) => fixtureEvents(value)),
    };
  }
  if (text.includes("FROM public.proofstack_recorded_interaction_fixture_versions")) {
    return {
      rows:
        state.candidateStored && includes(state.candidate.fixtureVersionId)
          ? [recordedManifest(state.candidate)]
          : [],
    };
  }
  if (
    text.includes("FROM public.proofstack_interaction_fixture_artifact_ownerships") &&
    text.includes("artifact_position")
  ) {
    return {
      rows:
        state.candidateStored && includes(state.candidate.fixtureVersionId)
          ? recordedOwnershipRows(state.candidate)
          : [],
    };
  }
  if (
    text.includes("FROM public.proofstack_interaction_fixture_artifact_ownerships") &&
    text.includes("SELECT artifact_id")
  ) {
    return { rows: [] };
  }
  if (text.includes("FROM public.proofstack_regression_fixtures")) {
    return { rows: [fixtureResource(state.predecessor)] };
  }
  if (text.includes("proofstack_regression_publication_intent_status")) {
    return { rows: [{ status: state.publicationStatus ?? "canonical" }] };
  }
  if (text.includes("FROM public.proofstack_artifact_catalog") && text.includes("classification")) {
    return { rows: artifactBindingRows(state.candidate) };
  }
  if (text.includes("FROM public.proofstack_artifact_catalog") && text.includes("tombstoned_at")) {
    return {
      rows: availabilityRows(
        state.candidate,
        state.contentState ?? "available",
        state.revocation?.revokedAt ?? null,
      ),
    };
  }
  if (text.includes("FROM public.proofstack_interaction_fixture_content_revocations")) {
    return { rows: state.revocation ? [revocationRow(state.revocation)] : [] };
  }
  if (text.includes("FROM public.proofstack_artifact_tombstones")) {
    return { rows: tombstoneRows(state.tombstones ?? []) };
  }
  return undefined;
}

describe("PostgresRegressionVersionRepository scoped reads", () => {
  it("implements resource presence reads with exact scope and validates the scalar result", async () => {
    const testHarness = harness((text) => {
      if (text.includes("proofstack_regression_fixtures")) return { rows: [{ present: true }] };
      if (text.includes("proofstack_regression_datasets")) return { rows: [{ present: false }] };
      return { rows: [] };
    });

    await expect(
      testHarness.repository.fixtureResourceExists(scope, "fix_repository"),
    ).resolves.toBe(true);
    await expect(
      testHarness.repository.datasetResourceExists(scope, "dat_repository"),
    ).resolves.toBe(false);
    const presenceQueries = testHarness.client.queries.filter(({ text }) =>
      text.includes("SELECT EXISTS"),
    );
    expect(presenceQueries).toHaveLength(2);
    expect(presenceQueries[0]?.values).toEqual([
      scope.tenantId,
      scope.projectId,
      scope.environmentId,
      "fix_repository",
    ]);
  });

  it("strictly reconstructs exact fixture and dataset versions and preserves lexical times", async () => {
    const baselineFixture = fixture();
    const storedFixture = fixture({
      createdAt: "2026-08-29T01:01:00.123Z",
      source: {
        ...baselineFixture.source,
        capturedAt: "2026-08-29T16:59:30.65432109876543210987+15:59",
      },
    });
    const storedDataset = dataset(storedFixture, {
      createdAt: "2026-08-29T01:02:00.987Z",
    });
    const testHarness = harness((text) => {
      if (text.includes("proofstack_regression_fixture_versions")) {
        return { rows: [fixtureHeader(storedFixture)] };
      }
      if (text.includes("proofstack_regression_fixture_events")) {
        return { rows: fixtureEvents(storedFixture) };
      }
      if (text.includes("proofstack_regression_dataset_versions")) {
        return { rows: [datasetHeader(storedDataset)] };
      }
      if (text.includes("proofstack_regression_dataset_members")) {
        return { rows: datasetMembers(storedDataset) };
      }
      return { rows: [] };
    });

    await expect(
      testHarness.repository.findFixtureVersion(scope, storedFixture.fixtureVersionId),
    ).resolves.toEqual(storedFixture);
    await expect(
      testHarness.repository.findDatasetVersion(scope, storedDataset.datasetVersionId),
    ).resolves.toEqual(storedDataset);
    await expect(
      testHarness.repository.findFixtureVersion(
        { ...scope, projectId: "prj_hidden" },
        storedFixture.fixtureVersionId,
      ),
    ).resolves.toBeNull();
  });

  it("resolves exact fixture references in caller order and returns null all-or-nothing", async () => {
    const first = fixture();
    const second = fixture({
      fixtureId: "fix_repository_second",
      fixtureVersionId: "fixv_repository_second",
    });
    const stored = new Map([
      [first.fixtureVersionId, first],
      [second.fixtureVersionId, second],
    ]);
    const testHarness = harness((text, values) => ({
      rows: rowsForFixtureReads(text, values, stored) ?? [],
    }));

    await expect(
      testHarness.repository.resolveFixtureVersionReferences(scope, [
        { fixtureId: second.fixtureId, fixtureVersionId: second.fixtureVersionId },
        { fixtureId: first.fixtureId, fixtureVersionId: first.fixtureVersionId },
      ]),
    ).resolves.toEqual([
      {
        definitionSha256: second.definitionSha256,
        fixtureId: second.fixtureId,
        fixtureVersionId: second.fixtureVersionId,
      },
      {
        definitionSha256: first.definitionSha256,
        fixtureId: first.fixtureId,
        fixtureVersionId: first.fixtureVersionId,
      },
    ]);
    await expect(
      testHarness.repository.resolveFixtureVersionReferences(scope, [
        { fixtureId: first.fixtureId, fixtureVersionId: first.fixtureVersionId },
        { fixtureId: "fix_missing", fixtureVersionId: "fixv_missing" },
      ]),
    ).resolves.toBeNull();
    const emptyHarness = harness(() => {
      throw new Error("empty resolution must not connect");
    });
    await expect(
      emptyHarness.repository.resolveFixtureVersionReferences(scope, []),
    ).resolves.toEqual([]);
    expect(emptyHarness.connections.count).toBe(0);
  });

  it("fails closed for incomplete or misordered stored children", async () => {
    const stored = fixture();
    const testHarness = harness((text) => {
      if (text.includes("proofstack_regression_fixture_versions")) {
        return { rows: [fixtureHeader(stored)] };
      }
      if (text.includes("proofstack_regression_fixture_events")) {
        return { rows: fixtureEvents(stored, { event_position: 1 }) };
      }
      return { rows: [] };
    });

    await expect(
      testHarness.repository.findFixtureVersion(scope, stored.fixtureVersionId),
    ).rejects.toBeInstanceOf(RegressionRepositoryContractError);
    expect(testHarness.client.queries.map(({ text }) => text.trim())).toContain("ROLLBACK");
  });
});

describe("PostgresRegressionVersionRepository publication", () => {
  it("publishes a fixture root with sorted locks, batched events, and one outbox intent", async () => {
    const candidate = fixture();
    const testHarness = harness((text) => {
      if (text.includes("proofstack_regression_publication_intent_status")) {
        return { rows: [{ status: "absent" }] };
      }
      if (text.includes("SELECT EXISTS")) return { rows: [{ present: false }] };
      return { rows: [] };
    });

    await expect(testHarness.repository.publishFixtureVersion(candidate)).resolves.toEqual({
      created: true,
      version: candidate,
    });
    const locks = testHarness.client.queries.filter(({ text }) =>
      text.includes("pg_advisory_xact_lock"),
    );
    expect(locks.map(({ values }) => values?.[0])).toEqual([
      `proofstack:regression:${scope.tenantId}:fixture-resource:${candidate.fixtureId}`,
      `proofstack:regression:${scope.tenantId}:fixture-version:${candidate.fixtureVersionId}`,
    ]);
    const childInsert = testHarness.client.queries.find(({ text }) =>
      text.includes("INSERT INTO public.proofstack_regression_fixture_events"),
    );
    expect(childInsert?.text).toContain("unnest($8::smallint[], $9::varchar[])");
    expect(childInsert?.values?.slice(-2)).toEqual([[0, 1], candidate.source.eventIds]);
    const outbox = testHarness.client.queries.find(({ text }) =>
      text.includes("INSERT INTO public.proofstack_outbox"),
    );
    expect(outbox?.values).toEqual([
      candidate.scope.tenantId,
      "regression.fixture-version.published",
      "regression.fixture-version",
      candidate.fixtureVersionId,
      "0.1",
      JSON.stringify(buildRegressionFixtureVersionPublishedOutboxIntent(candidate).payload),
      candidate.createdAt,
    ]);
    expect(testHarness.client.queries.map(({ text }) => text.trim()).at(-1)).toBe("COMMIT");
  });

  it("publishes a dataset root only after authoritative member revalidation", async () => {
    const member = fixture();
    const candidate = dataset(member);
    const storedFixtures = new Map([[member.fixtureVersionId, member]]);
    const testHarness = harness((text, values) => {
      if (text.includes("proofstack_regression_publication_intent_status")) {
        return { rows: [{ status: "absent" }] };
      }
      const fixtureRows = rowsForFixtureReads(text, values, storedFixtures);
      if (fixtureRows) return { rows: fixtureRows };
      if (text.includes("SELECT EXISTS")) return { rows: [{ present: false }] };
      return { rows: [] };
    });

    await expect(testHarness.repository.publishDatasetVersion(candidate)).resolves.toEqual({
      created: true,
      version: candidate,
    });
    const memberInsert = testHarness.client.queries.find(({ text }) =>
      text.includes("INSERT INTO public.proofstack_regression_dataset_members"),
    );
    expect(memberInsert?.text).toContain("$10::character(64)[]");
    expect(memberInsert?.values?.slice(-4)).toEqual([
      [0],
      [member.fixtureId],
      [member.fixtureVersionId],
      [member.definitionSha256],
    ]);
  });

  it("returns original fixture provenance only after canonical binding and outbox verification", async () => {
    const original = fixture();
    const retry = fixture({
      createdAt: "2026-08-29T01:04:00.000Z",
      createdByPrincipalId: "usr_retry",
      source: { ...original.source, capturedAt: "2026-08-29T01:00:45.000Z" },
    });
    const testHarness = harness((text) => {
      if (text.includes("proofstack_regression_fixture_versions")) {
        return { rows: [fixtureHeader(original)] };
      }
      if (text.includes("proofstack_regression_fixture_events")) {
        return { rows: fixtureEvents(original) };
      }
      if (text.includes("FROM public.proofstack_regression_fixtures")) {
        return { rows: [fixtureResource(original)] };
      }
      if (text.includes("proofstack_regression_publication_intent_status")) {
        return { rows: [{ status: "canonical" }] };
      }
      return { rows: [] };
    });

    await expect(testHarness.repository.publishFixtureVersion(retry)).resolves.toEqual({
      created: false,
      version: original,
    });
    expect(
      testHarness.client.queries.some(({ text }) =>
        text.includes("INSERT INTO public.proofstack_regression_fixture_versions"),
      ),
    ).toBe(false);
  });

  it("maps identity, lineage, and member failures to stable domain errors", async () => {
    const candidate = fixture();
    const otherScopeResource = {
      ...fixtureResource(candidate),
      project_id: "prj_other",
    };
    const conflictHarness = harness((text) => {
      if (text.includes("proofstack_regression_publication_intent_status")) {
        return { rows: [{ status: "absent" }] };
      }
      if (text.includes("SELECT EXISTS")) return { rows: [{ present: false }] };
      if (text.includes("FROM public.proofstack_regression_fixtures")) {
        return { rows: [otherScopeResource] };
      }
      return { rows: [] };
    });
    await expect(
      conflictHarness.repository.publishFixtureVersion(candidate),
    ).rejects.toBeInstanceOf(RegressionVersionConflictError);

    const lineageHarness = harness((text) => {
      if (text.includes("proofstack_regression_publication_intent_status")) {
        return { rows: [{ status: "absent" }] };
      }
      if (text.includes("SELECT EXISTS")) return { rows: [{ present: false }] };
      if (text.includes("FROM public.proofstack_regression_fixtures")) {
        return { rows: [fixtureResource(candidate)] };
      }
      return { rows: [] };
    });
    await expect(
      lineageHarness.repository.publishFixtureVersion(
        fixture({ fixtureVersionId: "fixv_repository_second" }),
      ),
    ).rejects.toBeInstanceOf(RegressionVersionLineageError);

    const member = fixture();
    const candidateDataset = dataset(member);
    const memberHarness = harness((text) => {
      if (text.includes("proofstack_regression_publication_intent_status")) {
        return { rows: [{ status: "absent" }] };
      }
      if (text.includes("SELECT EXISTS")) return { rows: [{ present: false }] };
      return { rows: [] };
    });
    await expect(
      memberHarness.repository.publishDatasetVersion(candidateDataset),
    ).rejects.toBeInstanceOf(RegressionVersionConflictError);
  });

  it("preflights tenant-wide target identity without reconstructing hidden corrupt data", async () => {
    const candidate = fixture();
    const testHarness = harness((text) => {
      if (
        text.includes(
          "SELECT tenant_id, project_id, environment_id, fixture_id, fixture_version_id",
        )
      ) {
        return {
          rows: [
            {
              environment_id: candidate.scope.environmentId,
              fixture_id: "fix_other_logical_identity",
              fixture_version_id: candidate.fixtureVersionId,
              project_id: candidate.scope.projectId,
              tenant_id: candidate.scope.tenantId,
            },
          ],
        };
      }
      if (text.includes("source_captured_at_lexical")) {
        throw new Error("hidden version must not be reconstructed");
      }
      return { rows: [] };
    });

    await expect(
      testHarness.repository.findFixtureVersion(
        { ...scope, projectId: "prj_hidden" },
        candidate.fixtureVersionId,
      ),
    ).resolves.toBeNull();
    await expect(testHarness.repository.publishFixtureVersion(candidate)).rejects.toBeInstanceOf(
      RegressionVersionConflictError,
    );
    expect(
      testHarness.client.queries.some(({ text }) => text.includes("source_captured_at_lexical")),
    ).toBe(false);
  });

  it("fails closed when a retry is missing its exact canonical publication intent", async () => {
    const original = fixture();
    const testHarness = harness((text) => {
      if (text.includes("proofstack_regression_fixture_versions")) {
        return { rows: [fixtureHeader(original)] };
      }
      if (text.includes("proofstack_regression_fixture_events")) {
        return { rows: fixtureEvents(original) };
      }
      if (text.includes("FROM public.proofstack_regression_fixtures")) {
        return { rows: [fixtureResource(original)] };
      }
      return { rows: [] };
    });

    await expect(testHarness.repository.publishFixtureVersion(original)).rejects.toBeInstanceOf(
      RegressionRepositoryContractError,
    );
  });

  it("rolls back every catalog write when the outbox insert fails", async () => {
    const candidate = fixture();
    const testHarness = harness((text) => {
      if (text.includes("proofstack_regression_publication_intent_status")) {
        return { rows: [{ status: "absent" }] };
      }
      if (text.includes("SELECT EXISTS")) return { rows: [{ present: false }] };
      if (text.includes("INSERT INTO public.proofstack_outbox")) {
        throw new Error("outbox unavailable");
      }
      return { rows: [] };
    });

    await expect(testHarness.repository.publishFixtureVersion(candidate)).rejects.toThrow(
      "outbox unavailable",
    );
    expect(testHarness.client.queries.map(({ text }) => text.trim())).toContain("ROLLBACK");
  });

  it("validates candidates before opening a database transaction", async () => {
    const candidate = fixture();
    const testHarness = harness(() => {
      throw new Error("must not connect");
    });
    await expect(
      testHarness.repository.publishFixtureVersion({
        ...candidate,
        definitionSha256: "f".repeat(64),
      }),
    ).rejects.toBeInstanceOf(InvalidRegressionVersionInputError);
    expect(testHarness.connections.count).toBe(0);
  });
});

describe("PostgresRegressionVersionRepository recorded interaction fixtures", () => {
  it("publishes canonical recorded content and immutable artifact ownership", async () => {
    const predecessor = fixture();
    const candidate = recordedFixture(predecessor);
    const testHarness = harness((text, values) => {
      const routed = rowsForRecordedReads(text, values, {
        candidate,
        predecessor,
        publicationStatus: "absent",
      });
      return routed ?? { rows: [] };
    });

    await expect(
      testHarness.repository.publishRecordedInteractionFixtureVersion(candidate),
    ).resolves.toEqual({
      created: true,
      ownerships: expectedInteractionOwnerships(candidate),
      version: candidate,
    });

    const locks = testHarness.client.queries.filter(({ text }) =>
      text.includes("pg_advisory_xact_lock"),
    );
    expect(locks.map(({ values }) => values?.[0])).toEqual(
      [
        `proofstack:regression:${scope.tenantId}:fixture-resource:${candidate.fixtureId}`,
        `proofstack:regression:${scope.tenantId}:fixture-version:${candidate.fixtureVersionId}`,
        ...candidate.interactionCapture.artifacts.map(
          ({ contentReference }) =>
            `proofstack:regression:${scope.tenantId}:artifact:${contentReference.artifactId}`,
        ),
      ].sort((left, right) => Buffer.from(left).compare(Buffer.from(right))),
    );
    expect(
      testHarness.client.queries.some(({ text }) =>
        text.includes("INSERT INTO public.proofstack_recorded_interaction_fixture_versions"),
      ),
    ).toBe(true);
    const ownershipInsert = testHarness.client.queries.find(({ text }) =>
      text.includes("INSERT INTO public.proofstack_interaction_fixture_artifact_ownerships"),
    );
    expect(ownershipInsert?.values?.at(-2)).toEqual(
      candidate.interactionCapture.artifacts.map(
        ({ contentReference }) => contentReference.artifactId,
      ),
    );
    const outbox = testHarness.client.queries.find(({ text }) =>
      text.includes("INSERT INTO public.proofstack_outbox"),
    );
    expect(outbox?.values?.[5]).toBe(
      JSON.stringify(
        buildRecordedInteractionFixtureVersionPublishedOutboxIntent(candidate).payload,
      ),
    );
  });

  it("strictly reconstructs recorded fixtures, content state, and retry provenance", async () => {
    const predecessor = fixture();
    const stored = recordedFixture(predecessor);
    const testHarness = harness((text, values) => {
      const routed = rowsForRecordedReads(text, values, {
        candidate: stored,
        candidateStored: true,
        predecessor,
      });
      return routed ?? { rows: [] };
    });
    const expected = {
      ownerships: expectedInteractionOwnerships(stored),
      version: stored,
    };

    await expect(
      testHarness.repository.findRecordedInteractionFixtureVersion(
        stored.scope,
        stored.fixtureVersionId,
      ),
    ).resolves.toEqual(expected);
    await expect(
      testHarness.repository.findRecordedInteractionFixtureContent(
        stored.scope,
        stored.fixtureVersionId,
      ),
    ).resolves.toEqual({
      contentAvailability: "available",
      ...expected,
      revocation: null,
      tombstones: [],
    });
    await expect(
      testHarness.repository.publishRecordedInteractionFixtureVersion({
        ...stored,
        createdAt: "2026-08-29T01:04:00.000Z",
        createdByPrincipalId: "usr_repository_retry",
      }),
    ).resolves.toEqual({ created: false, ...expected });
    await expect(
      testHarness.repository.findRecordedInteractionFixtureVersion(
        { ...stored.scope, projectId: "prj_hidden" },
        stored.fixtureVersionId,
      ),
    ).resolves.toBeNull();

    const unavailableHarness = harness((text, values) => {
      const routed = rowsForRecordedReads(text, values, {
        candidate: stored,
        candidateStored: true,
        contentState: "tombstoned",
        predecessor,
      });
      return routed ?? { rows: [] };
    });
    await expect(
      unavailableHarness.repository.findRecordedInteractionFixtureContent(
        stored.scope,
        stored.fixtureVersionId,
      ),
    ).resolves.toMatchObject({ contentAvailability: "unavailable" });
  });

  it("atomically revokes the complete recorded content set and preserves first attribution", async () => {
    const predecessor = fixture();
    const candidate = recordedFixture(predecessor);
    const revocation = fixtureRevocation(candidate);
    let revoked = false;
    const testHarness = harness((text, values) => {
      if (text.includes("SELECT EXISTS")) return { rows: [{ present: false }] };
      if (text.includes("INSERT INTO public.proofstack_interaction_fixture_content_revocations")) {
        revoked = true;
        return { rows: [] };
      }
      if (text.includes("UPDATE public.proofstack_artifact_catalog")) {
        return { rowCount: 1, rows: [] };
      }
      const routed = rowsForRecordedReads(text, values, {
        candidate,
        candidateStored: true,
        contentState: revoked ? "tombstoned" : "available",
        predecessor,
        ...(revoked
          ? { revocation: revocation.revocation, tombstones: revocation.tombstones }
          : {}),
      });
      return routed ?? { rows: [] };
    });

    await expect(
      testHarness.repository.revokeRecordedInteractionFixtureContent(revocation),
    ).resolves.toEqual({
      contentAvailability: "revoked",
      created: true,
      ownerships: expectedInteractionOwnerships(candidate),
      revocation: revocation.revocation,
      tombstones: revocation.tombstones,
      version: candidate,
    });
    expect(
      testHarness.client.queries.filter(({ text }) =>
        text.includes("UPDATE public.proofstack_artifact_catalog"),
      ),
    ).toHaveLength(candidate.interactionCapture.artifacts.length);
  });

  it("returns the canonical revocation on retry and rejects a conflicting decision", async () => {
    const predecessor = fixture();
    const candidate = recordedFixture(predecessor);
    const storedRevocation = fixtureRevocation(candidate);
    const testHarness = harness((text, values) => {
      const routed = rowsForRecordedReads(text, values, {
        candidate,
        candidateStored: true,
        contentState: "tombstoned",
        predecessor,
        revocation: storedRevocation.revocation,
        tombstones: storedRevocation.tombstones,
      });
      return routed ?? { rows: [] };
    });

    await expect(
      testHarness.repository.revokeRecordedInteractionFixtureContent({
        ...storedRevocation,
        revocation: {
          ...storedRevocation.revocation,
          revocationId: "rev_repository_retry",
          revokedByPrincipalId: "usr_repository_retry",
        },
      }),
    ).resolves.toMatchObject({ created: false, revocation: storedRevocation.revocation });
    await expect(
      testHarness.repository.revokeRecordedInteractionFixtureContent({
        ...storedRevocation,
        revocation: {
          ...storedRevocation.revocation,
          reason: "A distinct immutable revocation decision",
        },
      }),
    ).rejects.toBeInstanceOf(RegressionFixtureContentRevocationConflictError);

    const purgedHarness = harness((text, values) => {
      const routed = rowsForRecordedReads(text, values, {
        candidate,
        candidateStored: true,
        contentState: "purged",
        predecessor,
        revocation: storedRevocation.revocation,
        tombstones: storedRevocation.tombstones,
      });
      return routed ?? { rows: [] };
    });
    await expect(
      purgedHarness.repository.findRecordedInteractionFixtureContent(
        candidate.scope,
        candidate.fixtureVersionId,
      ),
    ).resolves.toMatchObject({ contentAvailability: "revoked" });
  });

  it("rejects non-authoritative artifact descriptors before any recorded writes", async () => {
    const predecessor = fixture();
    const candidate = recordedFixture(predecessor);
    const testHarness = harness((text, values) => {
      const routed = rowsForRecordedReads(text, values, {
        candidate,
        predecessor,
        publicationStatus: "absent",
      });
      if (
        routed &&
        text.includes("FROM public.proofstack_artifact_catalog") &&
        text.includes("classification")
      ) {
        return {
          rows: routed.rows.map((row, index) =>
            index === 0 ? { ...row, content_sha256: "f".repeat(64) } : row,
          ),
        };
      }
      return routed ?? { rows: [] };
    });

    await expect(
      testHarness.repository.publishRecordedInteractionFixtureVersion(candidate),
    ).rejects.toBeInstanceOf(RegressionArtifactBindingError);
    expect(
      testHarness.client.queries.some(({ text }) =>
        text.includes("INSERT INTO public.proofstack_recorded_interaction_fixture_versions"),
      ),
    ).toBe(false);
  });
});
