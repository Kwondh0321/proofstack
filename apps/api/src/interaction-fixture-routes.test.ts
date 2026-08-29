import { readFileSync } from "node:fs";
import {
  PrincipalContextSchema,
  type RecordedInteractionFixtureVersionDefinition,
  RecordedInteractionFixtureVersionDefinitionSchema,
  RecordedInteractionFixtureVersionSchema,
} from "@proofstack/contracts";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Authenticator } from "./auth.js";
import {
  type InteractionFixtureRouteDependencies,
  registerInteractionFixtureRoutes,
} from "./regression-routes.js";

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

const principal = PrincipalContextSchema.parse({
  authentication: { authenticatedAt: "2026-08-29T05:00:00.000Z", method: "development" },
  capabilities: ["dataset:manage", "dataset:read", "artifact:delete"],
  principalId: "usr_fixture_manager",
  principalType: "user",
  requestId: "req_fixture_manager",
  resourceScope: { mode: "tenant" },
  roles: ["owner"],
  tenantId: vector.scope.tenantId,
});
const version = RecordedInteractionFixtureVersionSchema.parse({
  ...vector,
  createdAt: "2026-08-29T05:01:00.000Z",
  createdByPrincipalId: principal.principalId,
  definitionSha256: "b".repeat(64),
  source: { ...vector.source, capturedAt: "2026-08-29T05:00:30.000Z" },
});
const ownerships = version.interactionCapture.artifacts.map(({ contentReference }) => ({
  artifactId: contentReference.artifactId,
  boundAt: version.createdAt,
  boundByPrincipalId: version.createdByPrincipalId,
  owner: {
    fixtureId: version.fixtureId,
    fixtureVersionId: version.fixtureVersionId,
    kind: "regression_fixture_version" as const,
  },
  schemaVersion: "0.1" as const,
  scope: version.scope,
}));
const revocation = {
  fixtureId: version.fixtureId,
  fixtureVersionId: version.fixtureVersionId,
  reason: "Remove the captured content set",
  revocationId: "rev_capture_001",
  revokedAt: "2026-08-29T05:02:00.000Z",
  revokedByPrincipalId: principal.principalId,
  schemaVersion: "0.1" as const,
  scope: version.scope,
};
const tombstones = ownerships.map((ownership, index) => ({
  actorPrincipalId: principal.principalId,
  artifactId: ownership.artifactId,
  occurredAt: revocation.revokedAt,
  reason: revocation.reason,
  tombstoneId: `del_capture_${index}`,
  trigger: "fixture_revocation" as const,
}));
const collectionUrl = `/v1/projects/${version.scope.projectId}/environments/${version.scope.environmentId}/regression-fixtures/${version.fixtureId}/interaction-versions`;
const versionUrl = `${collectionUrl}/${version.fixtureVersionId}`;
const apps: ReturnType<typeof Fastify>[] = [];

function dependencies(
  overrides: Partial<InteractionFixtureRouteDependencies> = {},
): InteractionFixtureRouteDependencies {
  return {
    authenticator: { authenticate: vi.fn(async () => principal) },
    publishRecordedFixtureVersion: {
      execute: vi.fn(async () => ({ created: true, ownerships, version })),
    },
    readRecordedFixtureMetadata: {
      execute: vi.fn(async () => ({
        contentAvailability: "available" as const,
        ownerships,
        revocation: null,
        tombstones: [],
        version,
      })),
    },
    revokeRecordedFixtureContent: {
      execute: vi.fn(async () => ({
        contentAvailability: "revoked" as const,
        created: true,
        ownerships,
        revocation,
        tombstones,
        version,
      })),
    },
    ...overrides,
  };
}

async function testApp(value = dependencies()) {
  const app = Fastify({ logger: false });
  await registerInteractionFixtureRoutes(app, value);
  apps.push(app);
  return { app, value };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("recorded interaction fixture routes", () => {
  it("publishes, reads metadata, and revokes a complete captured content set", async () => {
    const { app, value } = await testApp();
    const publish = await app.inject({
      body: {
        fixtureVersionId: version.fixtureVersionId,
        interactionCapture: version.interactionCapture,
        name: version.name,
        predecessorVersionId: version.predecessor.fixtureVersionId,
      },
      method: "POST",
      url: collectionUrl,
    });
    const read = await app.inject({ method: "GET", url: versionUrl });
    const revoke = await app.inject({
      body: { reason: revocation.reason },
      method: "POST",
      url: `${versionUrl}/revocation`,
    });

    expect(publish.statusCode).toBe(201);
    expect(publish.json()).toMatchObject({ created: true, ownerships, version });
    expect(value.publishRecordedFixtureVersion.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        environmentId: version.scope.environmentId,
        fixtureId: version.fixtureId,
        principal,
        projectId: version.scope.projectId,
      }),
    );
    expect(read.statusCode).toBe(200);
    expect(read.headers["cache-control"]).toBe("no-store");
    expect(read.json()).toMatchObject({
      contentAvailability: "available",
      ownerships,
      revocation: null,
      tombstones: [],
      version,
    });
    expect(revoke.statusCode).toBe(201);
    expect(revoke.json()).toMatchObject({
      contentAvailability: "revoked",
      created: true,
      revocation,
      tombstones,
    });
  });

  it("uses 200 for idempotent publication and revocation retries", async () => {
    const { app } = await testApp(
      dependencies({
        publishRecordedFixtureVersion: {
          execute: vi.fn(async () => ({ created: false, ownerships, version })),
        },
        revokeRecordedFixtureContent: {
          execute: vi.fn(async () => ({
            contentAvailability: "revoked" as const,
            created: false,
            ownerships,
            revocation,
            tombstones,
            version,
          })),
        },
      }),
    );
    const publish = await app.inject({
      body: {
        fixtureVersionId: version.fixtureVersionId,
        interactionCapture: version.interactionCapture,
        name: version.name,
        predecessorVersionId: version.predecessor.fixtureVersionId,
      },
      method: "POST",
      url: collectionUrl,
    });
    const revoke = await app.inject({
      body: { reason: revocation.reason },
      method: "POST",
      url: `${versionUrl}/revocation`,
    });

    expect(publish.statusCode).toBe(200);
    expect(publish.json()).toMatchObject({ created: false });
    expect(revoke.statusCode).toBe(200);
    expect(revoke.json()).toMatchObject({ created: false });
  });

  it("authenticates before route and body validation", async () => {
    const unavailable: Authenticator = {
      authenticate: vi.fn(async () => {
        throw Object.assign(new Error("missing credentials"), { statusCode: 401 });
      }),
    };
    const value = dependencies({ authenticator: unavailable });
    const { app } = await testApp(value);
    const response = await app.inject({
      body: {},
      method: "POST",
      url: "/v1/projects/INVALID/environments/INVALID/regression-fixtures/INVALID/interaction-versions",
    });

    expect(response.statusCode).toBe(401);
    expect(value.publishRecordedFixtureVersion.execute).not.toHaveBeenCalled();
  });
});
