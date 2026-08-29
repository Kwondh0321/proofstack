import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { StrictArtifactContentInspector } from "@proofstack/artifacts";
import {
  EVIDENCE_SCHEMA_VERSION,
  InteractionCaptureManifestSchema,
  type RecordedInteractionFixtureVersionDefinition,
  RecordedInteractionFixtureVersionDefinitionSchema,
} from "@proofstack/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

const vector = RecordedInteractionFixtureVersionDefinitionSchema.parse(
  (
    JSON.parse(
      readFileSync(
        new URL(
          "../../../packages/datasets/vectors/interaction-fixture-definition-v2.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as {
      readonly vectors: readonly {
        readonly input: RecordedInteractionFixtureVersionDefinition;
      }[];
    }
  ).vectors[0]?.input,
);
const scope = { environmentId: "env_capture", projectId: "prj_capture" } as const;
const fixtureId = "fix_capture_api";
const predecessorVersionId = "fixv_capture_evidence";
const recordedVersionId = "fixv_capture_recorded";
const traceId = "9bf92f3577b34da6a3ce929d0e0e4736";
const fixtureCollectionUrl = `/v1/projects/${scope.projectId}/environments/${scope.environmentId}/regression-fixtures/${fixtureId}`;
const artifactCollectionUrl = `/v1/projects/${scope.projectId}/environments/${scope.environmentId}/artifacts`;
const apps: Awaited<ReturnType<typeof createApp>>[] = [];

function sha256(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function capturedInteraction() {
  const content = new Map(
    vector.interactionCapture.artifacts.map((binding) => {
      const value = Buffer.from(
        JSON.stringify({ artifactId: binding.contentReference.artifactId, captured: true }),
        "utf8",
      );
      return [binding.contentReference.artifactId, value] as const;
    }),
  );
  const digest = new Map([...content].map(([artifactId, value]) => [artifactId, sha256(value)]));
  const artifacts = vector.interactionCapture.artifacts.map((binding) => {
    const value = content.get(binding.contentReference.artifactId);
    if (!value) throw new Error("Missing test artifact content");
    return {
      ...binding,
      contentReference: {
        ...binding.contentReference,
        sha256: sha256(value),
        sizeBytes: value.byteLength,
      },
    };
  });
  const interactions = vector.interactionCapture.interactions.map((interaction) => {
    if (interaction.kind !== "model") return interaction;
    const attempts = interaction.attempts.map((attempt) => {
      const normalizedSha256 = digest.get(attempt.normalizedRequest.artifactId);
      if (!normalizedSha256) throw new Error("Missing normalized request digest");
      return {
        ...attempt,
        normalizedRequest: { ...attempt.normalizedRequest, sha256: normalizedSha256 },
      };
    });
    const promptSha256 = digest.get(interaction.prompt.artifactId);
    if (!promptSha256) throw new Error("Missing prompt digest");
    return {
      ...interaction,
      attempts,
      prompt: { ...interaction.prompt, definitionSha256: promptSha256 },
    };
  });
  return {
    content,
    manifest: InteractionCaptureManifestSchema.parse({
      ...vector.interactionCapture,
      artifacts,
      interactions,
    }),
  };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("interaction capture API", () => {
  it("rejects structured credentials and configured scanner findings before storage", async () => {
    const scan = vi.fn(async ({ content }: { readonly content: Uint8Array }) => {
      if (Buffer.from(content).includes(Buffer.from("configured-offline"))) {
        throw new Error("scanner offline");
      }
      return Buffer.from(content).includes(Buffer.from("configured-finding"))
        ? [{ ruleId: "configured-test-rule" }]
        : [];
    });
    const app = await createApp(
      loadConfig({ PROOFSTACK_ENV: "test", PROOFSTACK_LOG_LEVEL: "silent" }),
      {
        artifactContentInspector: new StrictArtifactContentInspector([
          { name: "configured-test-scanner", scan, version: "1.0.0" },
        ]),
      },
    );
    apps.push(app);
    const candidates = [
      {
        artifactId: "art_capture_credential_rejected",
        content: Buffer.from('{"authorization":"Bearer example"}', "utf8"),
        expectedCode: "artifact_content_rejected",
        expectedStatus: 422,
      },
      {
        artifactId: "art_capture_scanner_rejected",
        content: Buffer.from('{"note":"configured-finding"}', "utf8"),
        expectedCode: "artifact_content_rejected",
        expectedStatus: 422,
      },
      {
        artifactId: "art_capture_scanner_unavailable",
        content: Buffer.from('{"note":"configured-offline"}', "utf8"),
        expectedCode: "artifact_storage_unavailable",
        expectedStatus: 503,
      },
    ];

    for (const candidate of candidates) {
      const reserve = await app.inject({
        body: {
          artifactId: candidate.artifactId,
          classification: "confidential",
          mediaType: "application/json",
          redaction: { status: "not_required" },
          retention: { mode: "retain" },
          sha256: sha256(candidate.content),
          sizeBytes: candidate.content.byteLength,
        },
        method: "POST",
        url: artifactCollectionUrl,
      });
      const upload = await app.inject({
        body: candidate.content,
        headers: { "content-type": "application/octet-stream" },
        method: "PUT",
        url: `${artifactCollectionUrl}/${candidate.artifactId}/content`,
      });
      const status = await app.inject({
        method: "GET",
        url: `${artifactCollectionUrl}/${candidate.artifactId}`,
      });

      expect(reserve.statusCode).toBe(201);
      expect(upload.statusCode).toBe(candidate.expectedStatus);
      expect(upload.json()).toMatchObject({
        code: candidate.expectedCode,
        status: candidate.expectedStatus,
      });
      expect(status.statusCode).toBe(200);
      expect(status.json()).toMatchObject({ metadata: { state: "reserved" } });
    }
    expect(scan).toHaveBeenCalledTimes(2);
  });

  it("runs reserve, upload, publish, exact reads, revocation, and purge end to end", async () => {
    const app = await createApp(
      loadConfig({ PROOFSTACK_ENV: "test", PROOFSTACK_LOG_LEVEL: "silent" }),
    );
    apps.push(app);
    const captured = capturedInteraction();
    const ingest = await app.inject({
      body: {
        events: [
          {
            eventId: "evt_capture_api",
            kind: "agent.run",
            name: "capture-api-test",
            source: {
              sdkName: "@proofstack/sdk",
              sdkVersion: "0.0.0",
              serviceName: "capture-api-test",
            },
            spanId: "90f067aa0ba902b7",
            startedAt: "2026-08-29T04:00:00.000Z",
            traceId,
          },
        ],
        schemaVersion: EVIDENCE_SCHEMA_VERSION,
      },
      method: "POST",
      url: `/v1/projects/${scope.projectId}/environments/${scope.environmentId}/evidence`,
    });
    expect(ingest.statusCode).toBe(202);
    const predecessor = await app.inject({
      body: {
        fixtureVersionId: predecessorVersionId,
        name: "Capture API predecessor",
        source: { kind: "trace_snapshot", traceId },
      },
      method: "POST",
      url: `${fixtureCollectionUrl}/versions`,
    });
    expect(predecessor.statusCode).toBe(201);

    for (const binding of captured.manifest.artifacts) {
      const content = captured.content.get(binding.contentReference.artifactId);
      if (!content) throw new Error("Missing captured artifact content");
      const reserve = await app.inject({
        body: {
          artifactId: binding.contentReference.artifactId,
          classification: binding.contentReference.classification,
          mediaType: binding.contentReference.mediaType,
          redaction: binding.redaction,
          retention: binding.retention,
          sha256: binding.contentReference.sha256,
          sizeBytes: binding.contentReference.sizeBytes,
        },
        method: "POST",
        url: artifactCollectionUrl,
      });
      const upload = await app.inject({
        body: content,
        headers: { "content-type": "application/octet-stream" },
        method: "PUT",
        url: `${artifactCollectionUrl}/${binding.contentReference.artifactId}/content`,
      });
      expect(reserve.statusCode).toBe(201);
      expect(upload.statusCode).toBe(200);
    }

    const publicationBody = {
      fixtureVersionId: recordedVersionId,
      interactionCapture: captured.manifest,
      name: "Complete captured interaction",
      predecessorVersionId,
    };
    const publicationUrl = `${fixtureCollectionUrl}/interaction-versions`;
    const publish = await app.inject({
      body: publicationBody,
      method: "POST",
      url: publicationUrl,
    });
    const retry = await app.inject({ body: publicationBody, method: "POST", url: publicationUrl });
    expect(publish.statusCode).toBe(201);
    expect(publish.json()).toMatchObject({
      created: true,
      version: { fixtureVersionId: recordedVersionId, replayability: "recorded_interactions" },
    });
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toMatchObject({ created: false, version: publish.json().version });

    const firstBinding = captured.manifest.artifacts[0];
    if (!firstBinding) throw new Error("Expected captured artifact");
    const firstArtifactUrl = `${artifactCollectionUrl}/${firstBinding.contentReference.artifactId}`;
    const status = await app.inject({ method: "GET", url: firstArtifactUrl });
    const plaintext = await app.inject({ method: "GET", url: `${firstArtifactUrl}/content` });
    const bypass = await app.inject({
      body: { reason: "Attempt to bypass fixture authority" },
      method: "DELETE",
      url: firstArtifactUrl,
    });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({
      metadata: { state: "available" },
      ownership: {
        owner: { fixtureId, fixtureVersionId: recordedVersionId },
      },
    });
    expect(plaintext.statusCode).toBe(200);
    expect(plaintext.rawPayload).toEqual(
      captured.content.get(firstBinding.contentReference.artifactId),
    );
    expect(bypass.statusCode).toBe(409);
    expect(bypass.json()).toMatchObject({ code: "artifact_fixture_owned" });

    const versionUrl = `${publicationUrl}/${recordedVersionId}`;
    const metadata = await app.inject({ method: "GET", url: versionUrl });
    const metadataExport = await app.inject({ method: "GET", url: `${versionUrl}/export` });
    const invalidContentExport = await app.inject({
      body: {},
      method: "POST",
      url: `${versionUrl}/export/content`,
    });
    const contentExport = await app.inject({
      body: { acknowledgeSensitiveContent: true },
      method: "POST",
      url: `${versionUrl}/export/content`,
    });
    expect(metadataExport.statusCode).toBe(200);
    expect(metadataExport.headers["cache-control"]).toBe("no-store");
    expect(metadataExport.json()).toMatchObject({
      export: {
        artifacts: { length: captured.manifest.artifacts.length },
        contentAvailability: "available",
        mode: "metadata",
      },
    });
    expect(metadataExport.json().export.artifacts[0]).not.toHaveProperty("content");
    expect(invalidContentExport.statusCode).toBe(400);
    expect(invalidContentExport.json()).toMatchObject({ code: "invalid_request" });
    expect(contentExport.statusCode, contentExport.body).toBe(200);
    expect(contentExport.headers["cache-control"]).toBe("no-store");
    expect(contentExport.json()).toMatchObject({
      export: {
        artifacts: { length: captured.manifest.artifacts.length },
        contentAvailability: "available",
        mode: "content",
      },
    });
    for (const exported of contentExport.json().export.artifacts) {
      expect(exported.content).toMatchObject({ encoding: "base64url", status: "available" });
      expect(Buffer.from(exported.content.bytes, "base64url")).toEqual(
        captured.content.get(exported.artifact.binding.contentReference.artifactId),
      );
    }
    const revocationBody = { reason: "Remove the complete captured content set" };
    const revoke = await app.inject({
      body: revocationBody,
      method: "POST",
      url: `${versionUrl}/revocation`,
    });
    const revokeRetry = await app.inject({
      body: revocationBody,
      method: "POST",
      url: `${versionUrl}/revocation`,
    });
    expect(metadata.statusCode).toBe(200);
    expect(metadata.json()).toMatchObject({ contentAvailability: "available" });
    expect(revoke.statusCode, revoke.body).toBe(201);
    expect(revoke.json()).toMatchObject({
      contentAvailability: "revoked",
      created: true,
      tombstones: { length: captured.manifest.artifacts.length },
    });
    expect(revokeRetry.statusCode).toBe(200);
    expect(revokeRetry.json()).toMatchObject({ created: false });
    const revokedExport = await app.inject({ method: "GET", url: `${versionUrl}/export` });
    const revokedContentExport = await app.inject({
      body: { acknowledgeSensitiveContent: true },
      method: "POST",
      url: `${versionUrl}/export/content`,
    });
    expect(revokedExport.statusCode).toBe(200);
    expect(revokedExport.json().export.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ lifecycleStatus: "revoked", purgeReceipt: null }),
      ]),
    );
    expect(revokedContentExport.statusCode).toBe(200);
    expect(
      revokedContentExport
        .json()
        .export.artifacts.every(
          ({ content }: { readonly content: { readonly status: string } }) =>
            content.status === "revoked",
        ),
    ).toBe(true);
    const unavailable = await app.inject({ method: "GET", url: `${firstArtifactUrl}/content` });
    expect(unavailable.statusCode).toBe(409);
    expect(unavailable.json()).toMatchObject({ code: "artifact_unavailable" });

    for (const binding of captured.manifest.artifacts) {
      const purge = await app.inject({
        method: "POST",
        url: `${artifactCollectionUrl}/${binding.contentReference.artifactId}/purge`,
      });
      expect(purge.statusCode).toBe(200);
      expect(purge.json()).toMatchObject({ metadata: { state: "purged" } });
    }
    const revokedMetadata = await app.inject({ method: "GET", url: versionUrl });
    const purgedExport = await app.inject({ method: "GET", url: `${versionUrl}/export` });
    const purgedContentExport = await app.inject({
      body: { acknowledgeSensitiveContent: true },
      method: "POST",
      url: `${versionUrl}/export/content`,
    });
    expect(revokedMetadata.statusCode).toBe(200);
    expect(revokedMetadata.json()).toMatchObject({ contentAvailability: "revoked" });
    expect(purgedExport.statusCode).toBe(200);
    expect(
      purgedExport
        .json()
        .export.artifacts.every(
          (artifact: { readonly lifecycleStatus: string; readonly purgeReceipt: unknown }) =>
            artifact.lifecycleStatus === "purged" && artifact.purgeReceipt !== null,
        ),
    ).toBe(true);
    expect(purgedContentExport.statusCode).toBe(200);
    expect(
      purgedContentExport
        .json()
        .export.artifacts.every(
          ({ content }: { readonly content: { readonly status: string } }) =>
            content.status === "purged",
        ),
    ).toBe(true);
  });
});
