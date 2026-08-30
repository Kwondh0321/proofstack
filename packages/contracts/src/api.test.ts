import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BrowserLoginQuerySchema,
  BrowserLogoutResponseSchema,
  BrowserReturnPathSchema,
  BrowserSessionResponseSchema,
  CreateReplayJobResponseSchema,
  ExportRecordedInteractionFixtureContentResponseSchema,
  ExportRecordedInteractionFixtureMetadataResponseSchema,
  IngestEvidenceResponseSchema,
  LivenessResponseSchema,
  MAX_TRACE_PAGE_SIZE,
  OidcCallbackQuerySchema,
  ProblemDocumentSchema,
  PublishRecordedInteractionFixtureVersionResponseSchema,
  PublishRegressionDatasetVersionResponseSchema,
  PublishRegressionFixtureVersionResponseSchema,
  PublishReplayPlanResponseSchema,
  PublishTargetReleaseResponseSchema,
  ReadArtifactMetadataResponseSchema,
  ReadinessResponseSchema,
  ReadRecordedInteractionFixtureMetadataResponseSchema,
  ReadRegressionDatasetVersionResponseSchema,
  ReadRegressionFixtureVersionResponseSchema,
  ReadReplayJobResponseSchema,
  ReadReplayPlanResponseSchema,
  ReadTargetReleaseResponseSchema,
  RequestReplayCancellationResponseSchema,
  ReserveArtifactResponseSchema,
  RevokeRecordedInteractionFixtureContentResponseSchema,
  TombstoneArtifactResponseSchema,
  TraceResponseSchema,
  UploadArtifactResponseSchema,
} from "./api.js";
import { RecordedInteractionFixtureVersionDefinitionSchema } from "./dataset.js";
import {
  RecordedInteractionFixtureContentExportSchema,
  RecordedInteractionFixtureMetadataExportSchema,
} from "./interaction-export.js";
import {
  ReplayPlanDefinitionSchema,
  ReplayPlanSchema,
  TargetReleaseDefinitionSchema,
  TargetReleaseSchema,
} from "./replay-plan.js";

const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
const browserPrincipal = {
  authentication: {
    authenticatedAt: "2026-08-28T05:00:00.000Z",
    credentialId: "ses_contract_test",
    method: "oidc",
  },
  capabilities: ["evidence:read"],
  principalId: "usr_contract_test",
  principalType: "user",
  requestId: "req_test_001",
  resourceScope: { mode: "tenant" },
  roles: ["viewer"],
  tenantId: "ten_contract_test",
} as const;
const traceEnvelope = {
  evidence: {
    eventId: "evt_contract_test",
    kind: "custom",
    name: "contract-test",
    source: {
      sdkName: "@proofstack/sdk",
      sdkVersion: "0.0.0",
      serviceName: "test-agent",
    },
    spanId: "00f067aa0ba902b7",
    startedAt: "2026-08-28T05:00:00.000Z",
    traceId,
  },
  receivedAt: "2026-08-28T05:00:00.100Z",
  schemaVersion: "0.1",
  scope: {
    environmentId: "env_local",
    projectId: "prj_local",
    tenantId: "ten_local",
  },
};
const fixtureVersion = {
  createdAt: "2026-08-28T05:00:00.200Z",
  createdByPrincipalId: "usr_contract_test",
  definitionSha256: "a".repeat(64),
  fixtureId: "fix_contract_test",
  fixtureVersionId: "fixv_contract_test_001",
  name: "Contract test fixture",
  replayability: "evidence_only",
  schemaVersion: "0.1",
  scope: traceEnvelope.scope,
  source: {
    capturedAt: "2026-08-28T05:00:00.100Z",
    eventIds: [traceEnvelope.evidence.eventId],
    kind: "trace_snapshot",
    observedEventCount: 1,
    sourceCompleteness: "observed_snapshot",
    traceId,
  },
} as const;
const datasetVersion = {
  createdAt: "2026-08-28T05:00:00.300Z",
  createdByPrincipalId: "usr_contract_test",
  datasetId: "dat_contract_test",
  datasetVersionId: "datv_contract_test_001",
  definitionSha256: "b".repeat(64),
  fixtureVersions: [
    {
      definitionSha256: fixtureVersion.definitionSha256,
      fixtureId: fixtureVersion.fixtureId,
      fixtureVersionId: fixtureVersion.fixtureVersionId,
    },
  ],
  name: "Contract test dataset",
  schemaVersion: "0.1",
  scope: traceEnvelope.scope,
} as const;
const interactionDefinition = RecordedInteractionFixtureVersionDefinitionSchema.parse(
  (
    JSON.parse(
      readFileSync(
        new URL("../../datasets/vectors/interaction-fixture-definition-v2.json", import.meta.url),
        "utf8",
      ),
    ) as { readonly vectors: readonly { readonly input: unknown }[] }
  ).vectors[0]?.input,
);
const recordedVersion = {
  ...interactionDefinition,
  createdAt: "2026-08-29T00:01:00.000Z",
  createdByPrincipalId: "usr_contract_test",
  definitionSha256: "c".repeat(64),
  source: {
    ...interactionDefinition.source,
    capturedAt: "2026-08-29T00:00:30.000Z",
  },
} as const;
const ownerships = recordedVersion.interactionCapture.artifacts.map(({ contentReference }) => ({
  artifactId: contentReference.artifactId,
  boundAt: recordedVersion.createdAt,
  boundByPrincipalId: recordedVersion.createdByPrincipalId,
  owner: {
    fixtureId: recordedVersion.fixtureId,
    fixtureVersionId: recordedVersion.fixtureVersionId,
    kind: "regression_fixture_version" as const,
  },
  schemaVersion: "0.1" as const,
  scope: recordedVersion.scope,
}));
const artifactMetadata = {
  availableAt: "2026-08-29T00:00:45.000Z",
  contentReference: recordedVersion.interactionCapture.artifacts[0]?.contentReference,
  createdAt: "2026-08-29T00:00:40.000Z",
  redaction: recordedVersion.interactionCapture.artifacts[0]?.redaction,
  retention: recordedVersion.interactionCapture.artifacts[0]?.retention,
  schemaVersion: "0.1" as const,
  scope: recordedVersion.scope,
  state: "available" as const,
};
const revocation = {
  fixtureId: recordedVersion.fixtureId,
  fixtureVersionId: recordedVersion.fixtureVersionId,
  reason: "Remove the complete captured content set",
  revocationId: "rev_contract_test",
  revokedAt: "2026-08-29T00:02:00.000Z",
  revokedByPrincipalId: "usr_contract_test",
  schemaVersion: "0.1" as const,
  scope: recordedVersion.scope,
};
const tombstones = ownerships.map(({ artifactId }, index) => ({
  actorPrincipalId: revocation.revokedByPrincipalId,
  artifactId,
  occurredAt: revocation.revokedAt,
  reason: revocation.reason,
  tombstoneId: `del_contract_test_${index}`,
  trigger: "fixture_revocation" as const,
}));
const replayDefinitionVectors = (
  JSON.parse(
    readFileSync(
      new URL("../../replay/vectors/replay-definition-v1.json", import.meta.url),
      "utf8",
    ),
  ) as {
    readonly vectors: readonly {
      readonly input: unknown;
      readonly kind: "replay_plan" | "target_release";
      readonly sha256: string;
    }[];
  }
).vectors;
const targetReleaseVector = replayDefinitionVectors.find(({ kind }) => kind === "target_release");
const replayPlanVector = replayDefinitionVectors.find(({ kind }) => kind === "replay_plan");
if (!targetReleaseVector || !replayPlanVector) {
  throw new Error("Replay definition vectors are incomplete");
}
const targetRelease = TargetReleaseSchema.parse({
  ...TargetReleaseDefinitionSchema.parse(targetReleaseVector.input),
  createdAt: "2026-08-30T02:00:00.000Z",
  createdByPrincipalId: "usr_contract_test",
  definitionSha256: targetReleaseVector.sha256,
});
const replayPlan = ReplayPlanSchema.parse({
  ...ReplayPlanDefinitionSchema.parse(replayPlanVector.input),
  createdAt: "2026-08-30T02:00:01.000Z",
  createdByPrincipalId: "usr_contract_test",
  definitionSha256: replayPlanVector.sha256,
});
const replayJobSnapshot = {
  attempts: [],
  budgetLedger: [],
  cancellationAcknowledgements: [],
  cancellationRequest: null,
  executionObservations: [],
  job: {
    createdAt: "2026-08-30T02:00:02.000Z",
    createdByPrincipalId: "usr_contract_test",
    jobId: "job_contract_test",
    lastFencingToken: 0,
    plan: {
      definitionSha256: replayPlan.definitionSha256,
      planId: replayPlan.planId,
      planVersionId: replayPlan.planVersionId,
    },
    recoveryEpoch: 0,
    schemaVersion: "0.1",
    scope: replayPlan.scope,
    stateVersion: 1,
    status: "queued",
  },
  usageObservations: [],
} as const;

describe("HTTP response contracts", () => {
  it("validates health responses exactly", () => {
    expect(LivenessResponseSchema.safeParse({ status: "ok" }).success).toBe(true);
    expect(ReadinessResponseSchema.safeParse({ status: "ready" }).success).toBe(true);
    expect(LivenessResponseSchema.safeParse({ status: "ok", version: "unknown" }).success).toBe(
      false,
    );
  });

  it("validates browser session and logout responses", () => {
    expect(
      BrowserSessionResponseSchema.safeParse({
        principal: browserPrincipal,
        requestId: "req_test_001",
      }).success,
    ).toBe(true);
    expect(
      BrowserSessionResponseSchema.safeParse({
        principal: browserPrincipal,
        requestId: "req_different",
      }).success,
    ).toBe(false);
    expect(
      BrowserLogoutResponseSchema.safeParse({ requestId: "req_test_001", revoked: true }).success,
    ).toBe(true);
  });

  it("accepts only local browser redirects and canonical OIDC state", () => {
    expect(BrowserLoginQuerySchema.parse({})).toEqual({ returnTo: "/" });
    expect(BrowserReturnPathSchema.safeParse("/traces?filter=failed#latest").success).toBe(true);
    expect(
      OidcCallbackQuerySchema.safeParse({
        code: "provider-code",
        state: "A".repeat(43),
      }).success,
    ).toBe(true);

    for (const value of [
      "https://attacker.example",
      "//attacker.example",
      "/\\attacker",
      "/\nnext",
    ]) {
      expect(BrowserReturnPathSchema.safeParse(value).success).toBe(false);
    }
    expect(OidcCallbackQuerySchema.safeParse({ state: "A".repeat(42) }).success).toBe(false);
    expect(OidcCallbackQuerySchema.safeParse({ state: ["A".repeat(43)] }).success).toBe(false);
  });

  it("validates evidence acknowledgements", () => {
    expect(
      IngestEvidenceResponseSchema.safeParse({
        acceptedEventIds: ["evt_accepted"],
        duplicateEventIds: ["evt_duplicate"],
        requestId: "req_test_001",
        schemaVersion: "0.1",
      }).success,
    ).toBe(true);
  });

  it("rejects ambiguous evidence acknowledgements", () => {
    const acknowledgement = {
      acceptedEventIds: ["evt_shared"],
      duplicateEventIds: ["evt_shared"],
      requestId: "req_test_001",
      schemaVersion: "0.1",
    };

    expect(IngestEvidenceResponseSchema.safeParse(acknowledgement).success).toBe(false);
    expect(
      IngestEvidenceResponseSchema.safeParse({
        ...acknowledgement,
        acceptedEventIds: [],
        duplicateEventIds: [],
      }).success,
    ).toBe(false);
  });

  it("rejects empty trace responses", () => {
    expect(
      TraceResponseSchema.safeParse({
        events: [],
        requestId: "req_test_001",
        schemaVersion: "0.1",
        traceId,
      }).success,
    ).toBe(false);
  });

  it("validates exact regression publication and read responses", () => {
    const fixturePublication = {
      created: true,
      requestId: "req_test_001",
      version: fixtureVersion,
    };
    const datasetPublication = {
      created: false,
      requestId: "req_test_001",
      version: datasetVersion,
    };

    expect(PublishRegressionFixtureVersionResponseSchema.parse(fixturePublication)).toEqual(
      fixturePublication,
    );
    expect(PublishRegressionDatasetVersionResponseSchema.parse(datasetPublication)).toEqual(
      datasetPublication,
    );
    expect(
      ReadRegressionFixtureVersionResponseSchema.safeParse({
        requestId: "req_test_001",
        version: fixtureVersion,
      }).success,
    ).toBe(true);
    expect(
      ReadRegressionDatasetVersionResponseSchema.safeParse({
        requestId: "req_test_001",
        version: datasetVersion,
      }).success,
    ).toBe(true);
  });

  it("rejects ambiguous regression response shapes and invalid stored versions", () => {
    expect(
      PublishRegressionFixtureVersionResponseSchema.safeParse({
        created: true,
        requestId: "req_test_001",
        unexpected: true,
        version: fixtureVersion,
      }).success,
    ).toBe(false);
    expect(
      PublishRegressionDatasetVersionResponseSchema.safeParse({
        created: true,
        requestId: "req_test_001",
        version: { ...datasetVersion, definitionSha256: "invalid" },
      }).success,
    ).toBe(false);
  });

  it("validates exact replay definition and job response envelopes", () => {
    expect(
      PublishTargetReleaseResponseSchema.parse({
        created: true,
        release: targetRelease,
        requestId: "req_test_001",
      }),
    ).toEqual({ created: true, release: targetRelease, requestId: "req_test_001" });
    expect(
      ReadTargetReleaseResponseSchema.safeParse({
        release: targetRelease,
        requestId: "req_test_001",
      }).success,
    ).toBe(true);
    expect(
      PublishReplayPlanResponseSchema.safeParse({
        created: false,
        plan: replayPlan,
        requestId: "req_test_001",
      }).success,
    ).toBe(true);
    expect(
      ReadReplayPlanResponseSchema.safeParse({
        plan: replayPlan,
        requestId: "req_test_001",
      }).success,
    ).toBe(true);
    expect(
      CreateReplayJobResponseSchema.safeParse({
        created: true,
        requestId: "req_test_001",
        snapshot: replayJobSnapshot,
      }).success,
    ).toBe(true);
    expect(
      ReadReplayJobResponseSchema.safeParse({
        requestId: "req_test_001",
        snapshot: replayJobSnapshot,
      }).success,
    ).toBe(true);
    expect(
      RequestReplayCancellationResponseSchema.safeParse({
        created: false,
        requestId: "req_test_001",
        snapshot: replayJobSnapshot,
      }).success,
    ).toBe(true);
  });

  it("rejects ambiguous or internally inconsistent replay response envelopes", () => {
    expect(
      PublishTargetReleaseResponseSchema.safeParse({
        created: true,
        release: targetRelease,
        requestId: "req_test_001",
        result: "accepted",
      }).success,
    ).toBe(false);
    expect(
      ReadReplayPlanResponseSchema.safeParse({
        plan: { ...replayPlan, definitionSha256: "invalid" },
        requestId: "req_test_001",
      }).success,
    ).toBe(false);
    expect(
      ReadReplayJobResponseSchema.safeParse({
        requestId: "req_test_001",
        snapshot: {
          ...replayJobSnapshot,
          job: { ...replayJobSnapshot.job, latestAttemptSequence: 0 },
        },
      }).success,
    ).toBe(false);
    expect(
      RequestReplayCancellationResponseSchema.safeParse({
        created: false,
        requestId: "req_test_001",
        snapshot: replayJobSnapshot,
        synchronousResult: {},
      }).success,
    ).toBe(false);
  });

  it("validates exact artifact lifecycle response contracts", () => {
    const reserved = { ...artifactMetadata, availableAt: undefined, state: "reserved" as const };
    expect(
      ReserveArtifactResponseSchema.safeParse({
        created: true,
        metadata: reserved,
        requestId: "req_test_001",
      }).success,
    ).toBe(true);
    expect(
      UploadArtifactResponseSchema.safeParse({
        metadata: artifactMetadata,
        requestId: "req_test_001",
      }).success,
    ).toBe(true);
    expect(
      ReadArtifactMetadataResponseSchema.safeParse({
        metadata: artifactMetadata,
        ownership: ownerships[0],
        requestId: "req_test_001",
      }).success,
    ).toBe(true);
    expect(
      TombstoneArtifactResponseSchema.safeParse({
        created: true,
        metadata: {
          ...artifactMetadata,
          state: "tombstoned",
          tombstonedAt: revocation.revokedAt,
        },
        requestId: "req_test_001",
        tombstone: { ...tombstones[0], trigger: "manual" },
      }).success,
    ).toBe(true);
  });

  it("validates consistent recorded interaction publication and revocation responses", () => {
    expect(
      PublishRecordedInteractionFixtureVersionResponseSchema.safeParse({
        created: true,
        ownerships,
        requestId: "req_test_001",
        version: recordedVersion,
      }).success,
    ).toBe(true);
    expect(
      ReadRecordedInteractionFixtureMetadataResponseSchema.safeParse({
        contentAvailability: "available",
        ownerships,
        requestId: "req_test_001",
        revocation: null,
        tombstones: [],
        version: recordedVersion,
      }).success,
    ).toBe(true);
    expect(
      RevokeRecordedInteractionFixtureContentResponseSchema.safeParse({
        contentAvailability: "revoked",
        created: true,
        ownerships,
        requestId: "req_test_001",
        revocation,
        tombstones,
        version: recordedVersion,
      }).success,
    ).toBe(true);
  });

  it("rejects incomplete or ambiguous recorded interaction state", () => {
    expect(
      ReadRecordedInteractionFixtureMetadataResponseSchema.safeParse({
        contentAvailability: "available",
        ownerships: ownerships.slice(1),
        requestId: "req_test_001",
        revocation: null,
        tombstones: [],
        version: recordedVersion,
      }).success,
    ).toBe(false);
    expect(
      ReadRecordedInteractionFixtureMetadataResponseSchema.safeParse({
        contentAvailability: "revoked",
        ownerships,
        requestId: "req_test_001",
        revocation: null,
        tombstones: [],
        version: recordedVersion,
      }).success,
    ).toBe(false);
    expect(
      RevokeRecordedInteractionFixtureContentResponseSchema.safeParse({
        contentAvailability: "available",
        created: true,
        ownerships,
        requestId: "req_test_001",
        revocation: null,
        tombstones: [],
        version: recordedVersion,
      }).success,
    ).toBe(false);
  });

  it("wraps strict metadata and content exports with request provenance", () => {
    const metadataExport = RecordedInteractionFixtureMetadataExportSchema.parse({
      artifacts: recordedVersion.interactionCapture.artifacts.map((binding, index) => ({
        binding,
        lifecycleStatus: "available",
        metadata: {
          ...artifactMetadata,
          contentReference: binding.contentReference,
          redaction: binding.redaction,
          retention: binding.retention,
        },
        ownership: ownerships[index],
        purgeReceipt: null,
        tombstone: null,
      })),
      contentAvailability: "available",
      mode: "metadata",
      revocation: null,
      schemaVersion: "0.1",
      version: recordedVersion,
    });
    const contentExport = RecordedInteractionFixtureContentExportSchema.parse({
      ...metadataExport,
      artifacts: metadataExport.artifacts.map((artifact) => ({
        artifact,
        content: { status: "missing" },
      })),
      mode: "content",
    });

    expect(
      ExportRecordedInteractionFixtureMetadataResponseSchema.safeParse({
        export: metadataExport,
        requestId: "req_test_001",
      }).success,
    ).toBe(true);
    expect(
      ExportRecordedInteractionFixtureContentResponseSchema.safeParse({
        export: contentExport,
        requestId: "req_test_001",
      }).success,
    ).toBe(true);
    expect(
      ExportRecordedInteractionFixtureMetadataResponseSchema.safeParse({
        ...metadataExport,
        requestId: "req_test_001",
      }).success,
    ).toBe(false);
  });

  it("bounds trace response pages and cursors", () => {
    const oversized = TraceResponseSchema.safeParse({
      events: Array.from({ length: MAX_TRACE_PAGE_SIZE + 1 }, () => traceEnvelope),
      requestId: "req_test_001",
      schemaVersion: "0.1",
      traceId,
    });
    const malformedCursor = TraceResponseSchema.safeParse({
      events: [traceEnvelope],
      nextCursor: "not a cursor",
      requestId: "req_test_001",
      schemaVersion: "0.1",
      traceId,
    });

    expect(oversized.success).toBe(false);
    expect(malformedCursor.success).toBe(false);
  });

  it("validates problem documents without arbitrary fields", () => {
    const problem = {
      code: "invalid_request",
      detail: "The request does not match the required contract",
      requestId: "req_test_001",
      status: 400,
      title: "Invalid request",
      type: "https://proofstack.dev/problems/invalid-request",
    };

    expect(ProblemDocumentSchema.safeParse(problem).success).toBe(true);
    expect(ProblemDocumentSchema.safeParse({ ...problem, stack: "secret" }).success).toBe(false);
  });
});
