import { createHash } from "node:crypto";
import type { ArtifactCatalogRepository } from "@proofstack/artifacts";
import {
  ArtifactMetadataSchema,
  type ComparisonEvidenceFixtureSnapshot,
  type ComparisonOmission,
  type EvidenceEnvelope,
  EvidenceEnvelopeSchema,
  type EvidenceScope,
  evidenceTimestampOrderKey,
  REPLAY_BUDGET_DIMENSIONS,
  RecordedInteractionFixtureVersionSchema,
  RegressionDatasetVersionSchema,
  RegressionFixtureVersionSchema,
  ReplayJobSnapshotSchema,
} from "@proofstack/contracts";
import {
  type ComparisonEvidenceResolution,
  type ComparisonEvidenceResolver,
  ComparisonSourceUnavailableError,
  type EvidenceRepository,
  type ExactEvidenceRepository,
} from "@proofstack/core";
import type { InteractionFixtureVersionRepository } from "@proofstack/datasets";
import type { ReplayJobControlRepository } from "@proofstack/replay";

type SubjectFixture = Parameters<
  ComparisonEvidenceResolver["resolve"]
>[0]["comparison"]["baseline"]["fixtures"][number];
type ResolvedFixture = ComparisonEvidenceFixtureSnapshot;
type ArtifactState = ResolvedFixture["artifacts"][number];
type SafetyEvent = ResolvedFixture["safetyEvents"][number];
type UsageDimension = ResolvedFixture["usage"][number];

interface RepositoryComparisonEvidenceResolverDependencies {
  readonly artifactCatalog?: ArtifactCatalogRepository;
  readonly evidenceRepository: ExactEvidenceRepository;
  readonly interactionRepository: InteractionFixtureVersionRepository;
  readonly replayRepository: ReplayJobControlRepository;
}

interface SourceFixture {
  readonly contentAvailability?: "available" | "revoked" | "unavailable";
  readonly version:
    | ReturnType<typeof RegressionFixtureVersionSchema.parse>
    | ReturnType<typeof RecordedInteractionFixtureVersionSchema.parse>;
}

interface UsageAccumulator {
  amount: number;
  observedCount: number;
  readonly sources: Set<"estimated" | "measured" | "provider_reported">;
  unavailableCount: number;
  readonly unavailableReasons: Set<
    "measurement_failed" | "provider_did_not_report" | "source_unavailable"
  >;
}

const SNAPSHOT_LIMITATIONS = [
  "Artifact availability is a point-in-time catalog state and can change after this snapshot.",
  "Snapshot projections exclude classified content and retain metadata only.",
  "Trace completeness is bounded to the exact event identifiers captured by each fixture.",
] as const;

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function sameScope(left: EvidenceScope, right: EvidenceScope): boolean {
  return (
    left.tenantId === right.tenantId &&
    left.projectId === right.projectId &&
    left.environmentId === right.environmentId
  );
}

function unavailable(sourceKind: string, sourceId: string): never {
  throw new ComparisonSourceUnavailableError(sourceKind, sourceId);
}

function exactTimestampEqual(left: string, right: string): boolean {
  return evidenceTimestampOrderKey(left) === evidenceTimestampOrderKey(right);
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
    .join(",")}}`;
}

function safetyEvent(
  kind: SafetyEvent["kind"],
  sourceId: string,
  occurredAt: string,
  source: unknown,
): SafetyEvent {
  const sourceSha256 = createHash("sha256")
    .update(`proofstack.comparison.safety-source.v1\0${kind}\0${canonicalJson(source)}`)
    .digest("hex");
  return {
    eventId: `sev_${sourceSha256.slice(0, 40)}`,
    kind,
    occurredAt: new Date(occurredAt).toISOString(),
    sourceId,
    sourceSha256,
  };
}

function traceStructure(events: readonly EvidenceEnvelope[]): ResolvedFixture["trace"] {
  const kindCounts = new Map<string, number>();
  const statusCounts = new Map<string, number>();
  const jointCounts = new Map<string, number>();
  for (const { evidence } of events) {
    kindCounts.set(evidence.kind, (kindCounts.get(evidence.kind) ?? 0) + 1);
    statusCounts.set(evidence.status, (statusCounts.get(evidence.status) ?? 0) + 1);
    const joint = `${evidence.kind}:${evidence.status}`;
    jointCounts.set(joint, (jointCounts.get(joint) ?? 0) + 1);
  }
  return {
    eventCount: events.length,
    eventKinds: [...kindCounts]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([kind, count]) => ({
        count,
        kind: kind as ResolvedFixture["trace"]["eventKinds"][number]["kind"],
      })),
    eventKindStatuses: [...jointCounts]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, count]) => {
        const separator = key.lastIndexOf(":");
        return {
          count,
          kind: key.slice(0, separator) as ResolvedFixture["trace"]["eventKinds"][number]["kind"],
          status: key.slice(
            separator + 1,
          ) as ResolvedFixture["trace"]["eventStatuses"][number]["status"],
        };
      }),
    eventStatuses: [...statusCounts]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([status, count]) => ({
        count,
        status: status as ResolvedFixture["trace"]["eventStatuses"][number]["status"],
      })),
  };
}

function emptyUsage(): UsageAccumulator {
  return {
    amount: 0,
    observedCount: 0,
    sources: new Set(),
    unavailableCount: 0,
    unavailableReasons: new Set(),
  };
}

function usageProjection(
  snapshot: ReturnType<typeof ReplayJobSnapshotSchema.parse>,
): UsageDimension[] {
  const accumulators = new Map(
    REPLAY_BUDGET_DIMENSIONS.map((dimension) => [dimension, emptyUsage()]),
  );
  for (const observation of snapshot.usageObservations) {
    for (const { dimension, usage } of observation.measurements) {
      if (dimension === "jobAttempts") continue;
      const accumulator = accumulators.get(dimension);
      if (!accumulator) unavailable("replay_usage_dimension", dimension);
      if (usage.status === "observed") {
        const next = accumulator.amount + usage.amount;
        if (!Number.isSafeInteger(next)) unavailable("replay_usage_overflow", dimension);
        accumulator.amount = next;
        accumulator.observedCount += 1;
        accumulator.sources.add(usage.source);
      } else {
        accumulator.unavailableCount += 1;
        accumulator.unavailableReasons.add(usage.reason);
      }
    }
  }

  const jobAttempts = accumulators.get("jobAttempts");
  if (!jobAttempts) unavailable("replay_usage_dimension", "jobAttempts");
  jobAttempts.amount = snapshot.attempts.length;
  jobAttempts.observedCount = 1;
  jobAttempts.sources.add("measured");

  return REPLAY_BUDGET_DIMENSIONS.map((dimension) => {
    const accumulator = accumulators.get(dimension);
    if (!accumulator) unavailable("replay_usage_dimension", dimension);
    const sources = [...accumulator.sources].sort();
    const unavailableReasons = [...accumulator.unavailableReasons].sort();
    if (accumulator.observedCount === 0) {
      return {
        dimension,
        value: {
          observedCount: 0,
          status: "unavailable",
          unavailableCount: Math.max(1, accumulator.unavailableCount),
          unavailableReasons:
            unavailableReasons.length === 0 ? ["source_unavailable"] : unavailableReasons,
        },
      } satisfies UsageDimension;
    }
    if (accumulator.unavailableCount > 0) {
      return {
        dimension,
        value: {
          amount: accumulator.amount,
          observedCount: accumulator.observedCount,
          sources,
          status: "partial",
          unavailableCount: accumulator.unavailableCount,
          unavailableReasons,
        },
      } satisfies UsageDimension;
    }
    return {
      dimension,
      value: {
        amount: accumulator.amount,
        observedCount: accumulator.observedCount,
        sources,
        status: "available",
        unavailableCount: 0,
      },
    } satisfies UsageDimension;
  });
}

function newestTimestamp(values: readonly string[]): string {
  let newest: bigint | undefined;
  for (const value of values) {
    const key = evidenceTimestampOrderKey(value);
    if (newest === undefined || key > newest) newest = key;
  }
  if (newest === undefined) unavailable("comparison_source_cutoff", "empty");
  const ceilingMilliseconds = (newest + 999n) / 1_000n;
  const numeric = Number(ceilingMilliseconds);
  if (!Number.isSafeInteger(numeric)) unavailable("comparison_source_cutoff", "out_of_range");
  return new Date(numeric).toISOString();
}

function sourceTimestamps(
  fixture: SourceFixture["version"],
  events: readonly EvidenceEnvelope[],
  replay: ReturnType<typeof ReplayJobSnapshotSchema.parse>,
): readonly string[] {
  return [
    fixture.createdAt,
    fixture.source.capturedAt,
    ...events.flatMap(({ evidence, receivedAt }) => [
      evidence.startedAt,
      ...(evidence.endedAt ? [evidence.endedAt] : []),
      receivedAt,
    ]),
    replay.job.createdAt,
    ...(replay.job.startedAt ? [replay.job.startedAt] : []),
    ...(replay.job.terminal ? [replay.job.terminal.committedAt] : []),
    ...replay.attempts.flatMap((attempt) => [
      attempt.startedAt,
      ...(attempt.endedAt ? [attempt.endedAt] : []),
    ]),
    ...replay.usageObservations.map(({ observedAt }) => observedAt),
    ...replay.executionObservations.map(({ observedAt }) => observedAt),
    ...(replay.cancellationRequest ? [replay.cancellationRequest.requestedAt] : []),
    ...replay.cancellationAcknowledgements.map(({ acknowledgedAt }) => acknowledgedAt),
  ];
}

export function isExactEvidenceRepository(
  repository: EvidenceRepository,
): repository is ExactEvidenceRepository {
  return "resolveExactEvents" in repository && typeof repository.resolveExactEvents === "function";
}

export class RepositoryComparisonEvidenceResolver implements ComparisonEvidenceResolver {
  constructor(private readonly dependencies: RepositoryComparisonEvidenceResolverDependencies) {}

  async resolve(
    command: Parameters<ComparisonEvidenceResolver["resolve"]>[0],
  ): Promise<ComparisonEvidenceResolution> {
    const subject = command.comparison[command.role];
    const datasetInput = await this.dependencies.interactionRepository.findDatasetVersion(
      structuredClone(command.scope),
      subject.dataset.datasetVersionId,
    );
    if (datasetInput === null) {
      unavailable("regression_dataset_version", subject.dataset.datasetVersionId);
    }
    const parsedDataset = RegressionDatasetVersionSchema.safeParse(datasetInput);
    if (!parsedDataset.success) {
      unavailable("regression_dataset_version", subject.dataset.datasetVersionId);
    }
    const dataset = parsedDataset.data;
    if (
      !sameScope(dataset.scope, command.scope) ||
      dataset.datasetId !== subject.dataset.datasetId ||
      dataset.definitionSha256 !== subject.dataset.definitionSha256
    ) {
      unavailable("regression_dataset_version", subject.dataset.datasetVersionId);
    }
    const datasetMembership = [...dataset.fixtureVersions]
      .map(
        ({ definitionSha256, fixtureId, fixtureVersionId }) =>
          `${fixtureId}:${fixtureVersionId}:${definitionSha256}`,
      )
      .sort();
    const subjectMembership = subject.fixtures
      .map(
        ({ fixture: { definitionSha256, fixtureId, fixtureVersionId } }) =>
          `${fixtureId}:${fixtureVersionId}:${definitionSha256}`,
      )
      .sort();
    if (!sameJson(datasetMembership, subjectMembership)) {
      unavailable("regression_dataset_membership", subject.dataset.datasetVersionId);
    }

    const omissions: ComparisonOmission[] = [];
    const limitations = new Set<string>(SNAPSHOT_LIMITATIONS);
    const sourceTimes = [dataset.createdAt];
    const fixtures: ResolvedFixture[] = [];
    const artifactOwners = new Map<string, string>();
    for (const fixture of subject.fixtures) {
      const resolved = await this.resolveFixture(command.scope, fixture, omissions, limitations);
      for (const { artifact } of resolved.fixture.artifacts) {
        const owner = artifactOwners.get(artifact.artifactId);
        if (owner !== undefined) {
          unavailable("comparison_artifact_owner", `${artifact.artifactId}:${owner}`);
        }
        artifactOwners.set(artifact.artifactId, fixture.fixture.fixtureId);
      }
      fixtures.push(resolved.fixture);
      sourceTimes.push(...resolved.sourceTimes);
    }

    return {
      dataset: structuredClone(subject.dataset),
      fixtures,
      integrity: "verified",
      knownLimitations: [...limitations].sort(),
      omissions: omissions.sort((left, right) => {
        const leftKey = `${left.fixtureId}:${left.sourceKind}:${"artifactId" in left ? left.artifactId : "projectionKey" in left ? left.projectionKey : ""}`;
        const rightKey = `${right.fixtureId}:${right.sourceKind}:${"artifactId" in right ? right.artifactId : "projectionKey" in right ? right.projectionKey : ""}`;
        return leftKey.localeCompare(rightKey);
      }),
      sourceCutoff: newestTimestamp(sourceTimes),
    };
  }

  private async resolveFixture(
    scope: EvidenceScope,
    subject: SubjectFixture,
    omissions: ComparisonOmission[],
    limitations: Set<string>,
  ): Promise<{ readonly fixture: ResolvedFixture; readonly sourceTimes: readonly string[] }> {
    if (subject.assessments.length > 0 || subject.modelAssuranceAssessments.length > 0) {
      unavailable("evaluation_projection", subject.fixture.fixtureVersionId);
    }
    const source = await this.findFixture(scope, subject);
    const eventsInput = await this.dependencies.evidenceRepository.resolveExactEvents(
      structuredClone(scope),
      source.version.source.traceId,
      [...source.version.source.eventIds],
    );
    if (eventsInput === null) {
      unavailable("trace_snapshot", source.version.source.traceId);
    }
    const events = eventsInput.map((event) => {
      const parsed = EvidenceEnvelopeSchema.safeParse(event);
      if (!parsed.success) unavailable("trace_event", source.version.source.traceId);
      return parsed.data;
    });
    if (
      events.length !== source.version.source.eventIds.length ||
      events.some(
        ({ evidence }, index) =>
          evidence.eventId !== source.version.source.eventIds[index] ||
          evidence.traceId !== source.version.source.traceId ||
          !sameScope(events[index]?.scope ?? scope, scope),
      )
    ) {
      unavailable("trace_snapshot", source.version.source.traceId);
    }

    const replayInput = await this.dependencies.replayRepository.findJob(
      structuredClone(scope),
      subject.replay.jobId,
    );
    if (replayInput === null) unavailable("replay_job", subject.replay.jobId);
    const parsedReplay = ReplayJobSnapshotSchema.safeParse(replayInput);
    if (!parsedReplay.success) unavailable("replay_job", subject.replay.jobId);
    const replay = parsedReplay.data;
    const attempt = replay.attempts.find(({ attemptId }) => attemptId === subject.replay.attemptId);
    if (
      !sameScope(replay.job.scope, scope) ||
      replay.job.jobId !== subject.replay.jobId ||
      replay.job.status !== "succeeded" ||
      replay.job.terminal?.status !== "succeeded" ||
      replay.job.terminal.code !== "completed" ||
      replay.job.terminal.attemptId !== subject.replay.attemptId ||
      !sameJson(replay.job.plan, subject.replay.plan) ||
      !attempt ||
      attempt.status !== "succeeded" ||
      attempt.endedAt === undefined ||
      !exactTimestampEqual(attempt.endedAt, subject.replay.completedAt) ||
      !sameJson(attempt.plan, subject.replay.plan) ||
      !sameJson(attempt.result, subject.replay.result) ||
      !sameJson(attempt.targetRelease, subject.replay.targetRelease)
    ) {
      unavailable("replay_result", `${subject.replay.jobId}:${subject.replay.attemptId}`);
    }

    const artifacts = await this.artifacts(
      scope,
      source,
      subject.replay.result,
      subject.fixture.fixtureId,
      omissions,
    );
    omissions.push({
      fixtureId: subject.fixture.fixtureId,
      projectionKey: "classified_content",
      reason: "classified_content_excluded",
      sourceKind: "classified_content",
    });
    if (source.version.replayability === "evidence_only") {
      limitations.add("Evidence-only fixtures do not include captured interaction payloads.");
    } else {
      limitations.add(
        `Interaction capture limitations: ${source.version.interactionCapture.source.completeness.limitations.join(", ")}.`,
      );
    }

    const safetyEvents = events
      .filter(({ evidence }) => evidence.kind === "guardrail.check")
      .map(({ evidence }) =>
        safetyEvent("guardrail_check", evidence.eventId, evidence.startedAt, evidence),
      );
    if (replay.cancellationRequest?.reasonCode === "safety_intervention") {
      safetyEvents.push(
        safetyEvent(
          "replay_safety_intervention",
          replay.cancellationRequest.cancellationId,
          replay.cancellationRequest.requestedAt,
          replay.cancellationRequest,
        ),
      );
    }
    for (const candidate of replay.attempts) {
      if (candidate.error?.effectCertainty === "may_have_occurred") {
        safetyEvents.push(
          safetyEvent(
            "uncertain_side_effect",
            candidate.attemptId,
            candidate.endedAt ?? candidate.startedAt,
            candidate,
          ),
        );
      }
    }
    safetyEvents.sort((left, right) => left.eventId.localeCompare(right.eventId));
    if (new Set(safetyEvents.map(({ eventId }) => eventId)).size !== safetyEvents.length) {
      unavailable("comparison_safety_event", subject.fixture.fixtureVersionId);
    }

    return {
      fixture: {
        artifacts,
        assurance: [],
        evaluationOutcomes: [],
        fixture: structuredClone(subject.fixture),
        numericObservations: [],
        replay: structuredClone(subject.replay),
        safetyEvents,
        trace: traceStructure(events),
        usage: usageProjection(replay),
      },
      sourceTimes: sourceTimestamps(source.version, events, replay),
    };
  }

  private async findFixture(scope: EvidenceScope, subject: SubjectFixture): Promise<SourceFixture> {
    const recorded =
      await this.dependencies.interactionRepository.findRecordedInteractionFixtureContent(
        structuredClone(scope),
        subject.fixture.fixtureVersionId,
      );
    if (recorded !== null) {
      const parsed = RecordedInteractionFixtureVersionSchema.safeParse(recorded.version);
      if (!parsed.success) {
        unavailable("regression_fixture_version", subject.fixture.fixtureVersionId);
      }
      const version = parsed.data;
      if (
        !sameScope(version.scope, scope) ||
        version.fixtureId !== subject.fixture.fixtureId ||
        version.definitionSha256 !== subject.fixture.definitionSha256
      ) {
        unavailable("regression_fixture_version", subject.fixture.fixtureVersionId);
      }
      return { contentAvailability: recorded.contentAvailability, version };
    }
    const input = await this.dependencies.interactionRepository.findFixtureVersion(
      structuredClone(scope),
      subject.fixture.fixtureVersionId,
    );
    if (input === null) unavailable("regression_fixture_version", subject.fixture.fixtureVersionId);
    const parsed = RegressionFixtureVersionSchema.safeParse(input);
    if (!parsed.success) {
      unavailable("regression_fixture_version", subject.fixture.fixtureVersionId);
    }
    const version = parsed.data;
    if (
      !sameScope(version.scope, scope) ||
      version.fixtureId !== subject.fixture.fixtureId ||
      version.definitionSha256 !== subject.fixture.definitionSha256
    ) {
      unavailable("regression_fixture_version", subject.fixture.fixtureVersionId);
    }
    return { version };
  }

  private async artifacts(
    scope: EvidenceScope,
    source: SourceFixture,
    replayResult: SubjectFixture["replay"]["result"],
    fixtureId: string,
    omissions: ComparisonOmission[],
  ): Promise<ArtifactState[]> {
    const references = [
      ...(source.version.replayability === "recorded_interactions"
        ? source.version.interactionCapture.artifacts.map(
            ({ contentReference }) => contentReference,
          )
        : []),
      replayResult,
    ];
    const unique = new Map<string, (typeof references)[number]>();
    for (const reference of references) {
      const existing = unique.get(reference.artifactId);
      if (existing && !sameJson(existing, reference)) {
        unavailable("artifact_content_reference", reference.artifactId);
      }
      unique.set(reference.artifactId, reference);
    }
    const states: ArtifactState[] = [];
    for (const artifact of [...unique.values()].sort((left, right) =>
      left.artifactId.localeCompare(right.artifactId),
    )) {
      let availability: ArtifactState["availability"];
      if (
        source.version.replayability === "recorded_interactions" &&
        source.version.interactionCapture.artifacts.some(
          ({ contentReference }) => contentReference.artifactId === artifact.artifactId,
        ) &&
        source.contentAvailability !== "available"
      ) {
        availability = source.contentAvailability === "revoked" ? "revoked" : "unavailable";
      } else if (!this.dependencies.artifactCatalog) {
        availability = "unavailable";
      } else {
        const entry = await this.dependencies.artifactCatalog.find(
          structuredClone(scope),
          artifact.artifactId,
        );
        const metadata = ArtifactMetadataSchema.safeParse(entry?.metadata);
        if (!metadata.success || !sameJson(metadata.data.contentReference, artifact)) {
          availability = "unavailable";
        } else if (metadata.data.state === "available") {
          availability = "available";
        } else if (metadata.data.state === "tombstoned" || metadata.data.state === "purged") {
          availability = "revoked";
        } else {
          availability = "unavailable";
        }
      }
      states.push({ artifact: structuredClone(artifact), availability });
      if (availability !== "available") {
        omissions.push({
          artifactId: artifact.artifactId,
          fixtureId,
          reason: availability === "revoked" ? "artifact_revoked" : "artifact_unavailable",
          sourceKind: "artifact",
        });
      }
    }
    return states;
  }
}
