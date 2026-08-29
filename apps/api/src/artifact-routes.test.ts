import { ArtifactMetadataSchema, PrincipalContextSchema } from "@proofstack/contracts";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ArtifactRouteDependencies, registerArtifactRoutes } from "./artifact-routes.js";
import type { Authenticator } from "./auth.js";

const artifactUrl = "/v1/projects/prj_capture/environments/env_capture/artifacts/art_capture_001";
const reservedMetadata = ArtifactMetadataSchema.parse({
  contentReference: {
    artifactId: "art_capture_001",
    classification: "internal",
    mediaType: "application/json",
    sha256: "a".repeat(64),
    sizeBytes: 2,
  },
  createdAt: "2026-08-29T05:00:00.000Z",
  redaction: { status: "not_required" },
  retention: { mode: "retain" },
  schemaVersion: "0.1",
  scope: {
    environmentId: "env_capture",
    projectId: "prj_capture",
    tenantId: "ten_capture",
  },
  state: "reserved",
});
const availableMetadata = ArtifactMetadataSchema.parse({
  ...reservedMetadata,
  availableAt: "2026-08-29T05:00:01.000Z",
  state: "available",
});
const tombstonedMetadata = ArtifactMetadataSchema.parse({
  ...availableMetadata,
  state: "tombstoned",
  tombstonedAt: "2026-08-29T05:00:02.000Z",
});
const purgedMetadata = ArtifactMetadataSchema.parse({
  ...tombstonedMetadata,
  purgedAt: "2026-08-29T05:00:03.000Z",
  state: "purged",
});
const principal = PrincipalContextSchema.parse({
  authentication: { authenticatedAt: "2026-08-29T05:00:00.000Z", method: "development" },
  capabilities: ["artifact:write", "artifact:read", "artifact:read:restricted", "artifact:delete"],
  principalId: "usr_capture",
  principalType: "user",
  requestId: "req_capture",
  resourceScope: { mode: "tenant" },
  roles: ["owner"],
  tenantId: "ten_capture",
});

const apps: ReturnType<typeof Fastify>[] = [];

function dependencies(
  overrides: Partial<ArtifactRouteDependencies> = {},
): ArtifactRouteDependencies {
  return {
    authenticator: { authenticate: vi.fn(async () => principal) },
    purgeArtifact: { execute: vi.fn(async () => ({ metadata: purgedMetadata })) },
    readArtifact: {
      execute: vi.fn(async () => ({
        content: Uint8Array.from([123, 125]),
        metadata: availableMetadata,
      })),
    },
    readArtifactMetadata: {
      execute: vi.fn(async () => ({ metadata: availableMetadata })),
    },
    reserveArtifact: {
      execute: vi.fn(async () => ({ created: true, metadata: reservedMetadata })),
    },
    tombstoneArtifact: {
      execute: vi.fn(async () => ({
        created: true,
        metadata: tombstonedMetadata,
        tombstone: {
          actorPrincipalId: principal.principalId,
          artifactId: "art_capture_001",
          occurredAt: "2026-08-29T05:00:02.000Z",
          reason: "Remove capture",
          tombstoneId: "del_capture_001",
          trigger: "manual" as const,
        },
      })),
    },
    uploadArtifact: { execute: vi.fn(async () => ({ metadata: availableMetadata })) },
    ...overrides,
  };
}

async function testApp(value = dependencies()) {
  const app = Fastify({ logger: false });
  await registerArtifactRoutes(app, value);
  apps.push(app);
  return { app, value };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("artifact routes", () => {
  it("maps the complete artifact lifecycle without exposing storage coordinates", async () => {
    const { app, value } = await testApp();
    const reservationBody = {
      artifactId: "art_capture_001",
      classification: "internal",
      mediaType: "application/json",
      redaction: { status: "not_required" },
      retention: { mode: "retain" },
      sha256: "a".repeat(64),
      sizeBytes: 2,
    };

    const reserve = await app.inject({
      body: reservationBody,
      method: "POST",
      url: `${artifactUrl.slice(0, artifactUrl.lastIndexOf("/"))}`,
    });
    const upload = await app.inject({
      body: Buffer.from("{}"),
      headers: { "content-type": "application/octet-stream" },
      method: "PUT",
      url: `${artifactUrl}/content`,
    });
    const status = await app.inject({ method: "GET", url: artifactUrl });
    const content = await app.inject({ method: "GET", url: `${artifactUrl}/content` });
    const tombstone = await app.inject({
      body: { reason: "Remove capture" },
      method: "DELETE",
      url: artifactUrl,
    });
    const purge = await app.inject({ method: "POST", url: `${artifactUrl}/purge` });

    expect(reserve.statusCode).toBe(201);
    expect(reserve.json()).toMatchObject({ created: true, metadata: reservedMetadata });
    expect(upload.statusCode).toBe(200);
    expect(upload.json()).toMatchObject({ metadata: availableMetadata });
    expect(value.uploadArtifact.execute).toHaveBeenCalledWith(
      expect.objectContaining({ content: Uint8Array.from([123, 125]), principal }),
    );
    expect(status.statusCode).toBe(200);
    expect(status.headers["cache-control"]).toBe("no-store");
    expect(status.json()).toMatchObject({ metadata: availableMetadata });
    expect(JSON.stringify(status.json())).not.toMatch(/objectKey|encryption|receipt/);
    expect(content.statusCode).toBe(200);
    expect(content.rawPayload).toEqual(Buffer.from("{}"));
    expect(content.headers).toMatchObject({
      "cache-control": "no-store",
      "content-type": "application/json",
      "x-proofstack-artifact-classification": "internal",
      "x-proofstack-artifact-redaction-status": "not_required",
      "x-proofstack-artifact-sha256": "a".repeat(64),
      "x-proofstack-request-id": expect.any(String),
    });
    expect(tombstone.statusCode).toBe(201);
    expect(tombstone.json()).toMatchObject({ created: true, metadata: tombstonedMetadata });
    expect(purge.statusCode).toBe(200);
    expect(purge.json()).toMatchObject({ metadata: purgedMetadata });
  });

  it("returns 200 for idempotent reservation and tombstone retries", async () => {
    const value = dependencies({
      reserveArtifact: {
        execute: vi.fn(async () => ({ created: false, metadata: reservedMetadata })),
      },
      tombstoneArtifact: {
        execute: vi.fn(async () => ({
          created: false,
          metadata: tombstonedMetadata,
          tombstone: {
            actorPrincipalId: principal.principalId,
            artifactId: "art_capture_001",
            occurredAt: "2026-08-29T05:00:02.000Z",
            reason: "Remove capture",
            tombstoneId: "del_capture_001",
            trigger: "manual" as const,
          },
        })),
      },
    });
    const { app } = await testApp(value);

    const reserve = await app.inject({
      body: {
        artifactId: "art_capture_001",
        classification: "internal",
        mediaType: "application/json",
        redaction: { status: "not_required" },
        retention: { mode: "retain" },
        sha256: "a".repeat(64),
        sizeBytes: 2,
      },
      method: "POST",
      url: `${artifactUrl.slice(0, artifactUrl.lastIndexOf("/"))}`,
    });
    const tombstone = await app.inject({
      body: { reason: "Remove capture" },
      method: "DELETE",
      url: artifactUrl,
    });

    expect(reserve.statusCode).toBe(200);
    expect(reserve.json()).toMatchObject({ created: false });
    expect(tombstone.statusCode).toBe(200);
    expect(tombstone.json()).toMatchObject({ created: false });
  });

  it("authenticates binary uploads before parsing or invoking storage", async () => {
    const unavailable: Authenticator = {
      authenticate: vi.fn(async () => {
        throw Object.assign(new Error("missing credentials"), { statusCode: 401 });
      }),
    };
    const value = dependencies({ authenticator: unavailable });
    const { app } = await testApp(value);

    const response = await app.inject({
      body: Buffer.alloc(16 * 1024 * 1024 + 1),
      headers: { "content-type": "application/octet-stream" },
      method: "PUT",
      url: "/v1/projects/INVALID/environments/INVALID/artifacts/INVALID/content",
    });

    expect(response.statusCode).toBe(401);
    expect(unavailable.authenticate).toHaveBeenCalledOnce();
    expect(value.uploadArtifact.execute).not.toHaveBeenCalled();
  });

  it("rejects empty binary content without invoking storage", async () => {
    const value = dependencies();
    const { app } = await testApp(value);

    const response = await app.inject({
      body: Buffer.alloc(0),
      headers: { "content-type": "application/octet-stream" },
      method: "PUT",
      url: `${artifactUrl}/content`,
    });

    expect(response.statusCode).toBe(500);
    expect(value.uploadArtifact.execute).not.toHaveBeenCalled();
  });
});
