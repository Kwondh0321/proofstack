import {
  ProofStackClient,
  ProofStackRegressionClient,
  createSpanId,
  createTraceId,
} from "@proofstack/sdk";
import { createProviderNeutralCapture } from "./capture.js";

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
      revocation: {
        contentAvailability: finalMetadata.contentAvailability,
        purgeReceipts: finalExport.export.artifacts.length,
        tombstones: revoked.tombstones.length,
      },
      traceId,
      warning:
        "This example records and revokes an exact declared interaction boundary; it never executes replay or grants model, network, tool, or policy authority.",
    },
    null,
    2,
  ),
);
