import {
  ProofStackClient,
  ProofStackRegressionClient,
  createSpanId,
  createTraceId,
} from "@proofstack/sdk";
import { executeRecordedBoundaryReplay } from "@proofstack/replay";
import { createProviderNeutralCapture } from "./capture.js";
import {
  createProviderNeutralRecordedTarget,
  PROVIDER_NEUTRAL_RECORDED_TARGET_REFERENCE,
} from "./reference-recorded-target.js";

const { PROOFSTACK_API_URL, PROOFSTACK_ENVIRONMENT_ID, PROOFSTACK_PROJECT_ID } = process.env;

const endpoint = PROOFSTACK_API_URL ?? "http://127.0.0.1:4318";
const environmentId = PROOFSTACK_ENVIRONMENT_ID ?? "env_local";
const projectId = PROOFSTACK_PROJECT_ID ?? "prj_local";
const traceId = createTraceId();
const suffix = traceId.slice(0, 12);
const fixtureId = `fix_${suffix}_capture`;
const predecessorVersionId = `fixv_${suffix}_evidence`;
const recordedVersionId = `fixv_${suffix}_recorded`;
const captureStartedAt = new Date(Date.now() - 2_000);
const capture = createProviderNeutralCapture(suffix, captureStartedAt);

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function addMilliseconds(instant: Date, milliseconds: number): string {
  return new Date(instant.getTime() + milliseconds).toISOString();
}

function hasOwnContentField(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasOwnContentField);
  if (typeof value !== "object" || value === null) return false;
  if (Object.hasOwn(value, "content")) return true;
  return Object.values(value).some(hasOwnContentField);
}

const telemetry = new ProofStackClient({
  endpoint,
  environmentId,
  failOpen: false,
  flushIntervalMs: 0,
  projectId,
  source: {
    frameworkName: "provider-neutral-reference",
    frameworkVersion: "1.0.0",
    serviceName: "interaction-capture-example",
    serviceVersion: "0.0.0",
  },
});

const runSpanId = createSpanId();
telemetry.emit({
  attributes: {
    "capture.boundary": "application_provider_and_tool",
    "capture.content_in_telemetry": false,
    "example.failure_class": "inventory_backend_unavailable",
  },
  endedAt: addMilliseconds(captureStartedAt, 1_700),
  kind: "agent.run",
  name: "checkout-agent.failed-run",
  sequence: 0,
  spanId: runSpanId,
  startedAt: addMilliseconds(captureStartedAt, 0),
  status: "error",
  traceId,
});
telemetry.emit({
  attributes: {
    "capture.adapter": "proofstack.reference.model",
    "capture.attempt": 0,
    "capture.outcome": "succeeded",
  },
  endedAt: addMilliseconds(captureStartedAt, 900),
  kind: "model.generate",
  name: "reference-model.chat",
  parentSpanId: runSpanId,
  sequence: 1,
  startedAt: addMilliseconds(captureStartedAt, 100),
  status: "ok",
  traceId,
});
telemetry.emit({
  attributes: {
    "capture.adapter": "proofstack.reference.tool",
    "capture.attempt": 0,
    "capture.outcome": "failed",
    "capture.side_effect": "read_only",
  },
  endedAt: addMilliseconds(captureStartedAt, 1_500),
  kind: "tool.execute",
  name: "inventory.lookup",
  parentSpanId: runSpanId,
  sequence: 2,
  startedAt: addMilliseconds(captureStartedAt, 1_000),
  status: "error",
  traceId,
});

const delivery = await telemetry.close();
assert(delivery.success, `Evidence delivery left ${delivery.pendingCount} event(s) pending`);

const regression = new ProofStackRegressionClient({
  authentication: { mode: "development" },
  endpoint,
  environmentId,
  projectId,
});

const predecessor = await regression.publishFixtureVersion({
  fixtureId,
  request: {
    description: "Observed failure evidence before classified interaction capture was attached.",
    fixtureVersionId: predecessorVersionId,
    name: "Inventory lookup failure evidence",
    source: { kind: "trace_snapshot", traceId },
  },
});
assert(
  predecessor.version.replayability === "evidence_only",
  "Predecessor must remain evidence-only",
);

for (const binding of capture.manifest.artifacts) {
  const { contentReference, redaction, retention } = binding;
  const content = capture.contentByArtifactId.get(contentReference.artifactId);
  assert(content, `Missing local content for ${contentReference.artifactId}`);
  const reserved = await regression.reserveArtifact({
    request: {
      artifactId: contentReference.artifactId,
      classification: contentReference.classification,
      mediaType: contentReference.mediaType,
      redaction,
      retention,
      sha256: contentReference.sha256,
      sizeBytes: contentReference.sizeBytes,
    },
  });
  assert(reserved.metadata.state === "reserved", "New artifact reservation must be reserved");
  const uploaded = await regression.uploadArtifactContent({
    artifactId: contentReference.artifactId,
    content,
  });
  assert(uploaded.metadata.state === "available", "Uploaded artifact must become available");
}

const publicationRequest = {
  description: "Exact provider-neutral model and failed tool interaction capture.",
  fixtureVersionId: recordedVersionId,
  interactionCapture: capture.manifest,
  name: "Inventory lookup failure interaction capture",
  predecessorVersionId,
} as const;
const published = await regression.publishRecordedInteractionFixtureVersion({
  fixtureId,
  request: publicationRequest,
});
const publicationRetry = await regression.publishRecordedInteractionFixtureVersion({
  fixtureId,
  request: publicationRequest,
});
assert(published.created, "First recorded interaction publication must create a version");
assert(!publicationRetry.created, "Exact publication retry must be idempotent");
assert(
  publicationRetry.version.definitionSha256 === published.version.definitionSha256,
  "Idempotent publication must preserve the immutable definition digest",
);
assert(
  published.version.predecessor.fixtureVersionId === predecessorVersionId,
  "Recorded capture must name the exact evidence-only predecessor",
);
assert(
  published.version.replayability === "recorded_interactions",
  "Recorded capture must not claim executable replay",
);

const exactMetadata = await regression.readRecordedInteractionFixtureMetadata({
  fixtureId,
  fixtureVersionId: recordedVersionId,
});
assert(exactMetadata.contentAvailability === "available", "Captured content must be available");
assert(
  exactMetadata.version.definitionSha256 === published.version.definitionSha256,
  "Exact metadata read must preserve the immutable definition digest",
);

const metadataExport = await regression.exportRecordedInteractionFixtureMetadata({
  fixtureId,
  fixtureVersionId: recordedVersionId,
});
const serializedMetadata = JSON.stringify(metadataExport.export);
assert(
  !hasOwnContentField(metadataExport.export),
  "Metadata export must not contain plaintext fields",
);
for (const marker of capture.sensitiveMarkers) {
  assert(!serializedMetadata.includes(marker), `Metadata export leaked sensitive marker ${marker}`);
}

const contentExport = await regression.exportRecordedInteractionFixtureContent({
  acknowledgeSensitiveContent: true,
  fixtureId,
  fixtureVersionId: recordedVersionId,
});
for (const item of contentExport.export.artifacts) {
  const artifactId = item.artifact.binding.contentReference.artifactId;
  const expected = capture.contentByArtifactId.get(artifactId);
  assert(expected, `Content export returned unknown artifact ${artifactId}`);
  assert(
    item.content.status === "available",
    `Content export omitted available artifact ${artifactId}`,
  );
  const actual = Buffer.from(item.content.bytes, "base64url");
  assert(
    actual.equals(Buffer.from(expected)),
    `Content export changed exact bytes for ${artifactId}`,
  );
}

const modelNormalizedRequest = capture.contentByArtifactId.get(`art_${suffix}_model_normalized`);
const toolNormalizedRequest = capture.contentByArtifactId.get(`art_${suffix}_tool_normalized`);
assert(modelNormalizedRequest, "Reference replay requires the captured normalized model request");
assert(toolNormalizedRequest, "Reference replay requires the captured normalized tool request");
const replayInvocation = {
  fixture: {
    definitionSha256: published.version.definitionSha256,
    fixtureId,
    fixtureVersionId: recordedVersionId,
  },
  invocationId: `rpi_${suffix}_exact`,
  runtime: {
    boundaryMode: "recorded_stub" as const,
    clock: { instant: captureStartedAt.toISOString(), mode: "fixed" as const },
    isolation: { mode: "cooperative_in_process" as const },
    locale: "en-US",
    network: { policy: "deny_fallback" as const },
    random: {
      algorithm: "hmac_sha256_counter_v1" as const,
      mode: "seeded" as const,
      seedHex: traceId.repeat(2),
    },
    timeZone: "UTC",
  },
  schemaVersion: "0.1" as const,
  targetAdapter: PROVIDER_NEUTRAL_RECORDED_TARGET_REFERENCE,
};
const replay = await executeRecordedBoundaryReplay({
  contentExport: contentExport.export,
  invocation: replayInvocation,
  target: createProviderNeutralRecordedTarget({
    modelNormalizedRequest,
    toolNormalizedRequest,
  }),
});
assert(replay.status === "completed", "Exact recorded requests must complete replay");
assert(
  replay.reproducibility.classification === "bounded",
  "In-process recorded replay must not claim exact reproducibility",
);
assert(replay.consumedAttemptCount === 2, "Replay must consume the model and failed tool attempts");
const recordedToolObservation = replay.observations[1];
assert(
  recordedToolObservation?.status === "matched" &&
    recordedToolObservation.resolution.recordedAttempt.kind === "tool" &&
    recordedToolObservation.resolution.recordedAttempt.attempt.outcome === "failed",
  "Replay must preserve the recorded tool failure",
);

const changedModelRequest = Uint8Array.from(modelNormalizedRequest);
changedModelRequest[0] = (changedModelRequest[0] ?? 0) ^ 1;
const mismatch = await executeRecordedBoundaryReplay({
  contentExport: contentExport.export,
  invocation: { ...replayInvocation, invocationId: `rpi_${suffix}_mismatch` },
  target: createProviderNeutralRecordedTarget({
    modelNormalizedRequest: changedModelRequest,
    toolNormalizedRequest,
  }),
});
assert(mismatch.status === "mismatch", "Changed normalized bytes must fail closed as mismatch");
assert(
  mismatch.observations[0]?.status === "mismatch" &&
    mismatch.observations[0].code === "normalized_request_digest_mismatch",
  "Mismatch result must preserve the exact failure reason",
);

const revocationRequest = { reason: "Complete the reference revocation and purge lifecycle" };
const revoked = await regression.revokeRecordedInteractionFixtureContent({
  fixtureId,
  fixtureVersionId: recordedVersionId,
  request: revocationRequest,
});
const revocationRetry = await regression.revokeRecordedInteractionFixtureContent({
  fixtureId,
  fixtureVersionId: recordedVersionId,
  request: revocationRequest,
});
assert(revoked.created, "First fixture revocation must create an immutable record");
assert(!revocationRetry.created, "Exact fixture revocation retry must be idempotent");
assert(
  revoked.tombstones.length === capture.manifest.artifacts.length,
  "Fixture revocation must tombstone every owned artifact",
);

for (const binding of capture.manifest.artifacts) {
  const purged = await regression.purgeArtifact({
    artifactId: binding.contentReference.artifactId,
  });
  assert(purged.metadata.state === "purged", "Revoked artifact must reach purged state");
}

const finalMetadata = await regression.readRecordedInteractionFixtureMetadata({
  fixtureId,
  fixtureVersionId: recordedVersionId,
});
const finalExport = await regression.exportRecordedInteractionFixtureMetadata({
  fixtureId,
  fixtureVersionId: recordedVersionId,
});
const finalContentExport = await regression.exportRecordedInteractionFixtureContent({
  acknowledgeSensitiveContent: true,
  fixtureId,
  fixtureVersionId: recordedVersionId,
});
assert(finalMetadata.contentAvailability === "revoked", "Purged fixture must remain revoked");
assert(
  finalExport.export.artifacts.every(
    (artifact) => artifact.lifecycleStatus === "purged" && artifact.purgeReceipt !== null,
  ),
  "Metadata export must retain every purge receipt",
);
assert(
  finalContentExport.export.artifacts.every(({ content }) => content.status === "purged"),
  "Content export must report purged content without silently omitting it",
);

console.log(
  JSON.stringify(
    {
      artifactCount: capture.manifest.artifacts.length,
      contentExport: {
        acknowledgementRequired: true,
        exactDigestVerification: "passed",
        initialAvailability: contentExport.export.contentAvailability,
      },
      fixture: {
        definitionSha256: published.version.definitionSha256,
        fixtureId,
        predecessorReplayability: predecessor.version.replayability,
        predecessorVersionId,
        recordedReplayability: published.version.replayability,
        recordedVersionId,
      },
      metadataExport: {
        plaintextFieldsPresent: false,
        sensitiveMarkersPresent: false,
      },
      replay: {
        classification: replay.reproducibility.classification,
        consumedAttemptCount: replay.consumedAttemptCount,
        expectedAttemptCount: replay.expectedAttemptCount,
        isolationLimitations: replay.reproducibility.limitations,
        liveBoundaryInterfaces: 0,
        mismatchCode:
          mismatch.observations[0]?.status === "mismatch" ? mismatch.observations[0].code : null,
        mismatchStatus: mismatch.status,
        status: replay.status,
      },
      revocation: {
        contentAvailability: finalMetadata.contentAvailability,
        purgeReceipts: finalExport.export.artifacts.length,
        tombstones: revoked.tombstones.length,
      },
      traceId,
      warning:
        "This example replays only exact recorded boundaries in one cooperative process; it grants no live model, network, credential, search, evaluator, or policy authority and does not claim process isolation.",
    },
    null,
    2,
  ),
);
