import {
  type PrincipalContext,
  PublishReleaseCandidateRequestSchema,
  type ReleaseCandidate,
} from "@proofstack/contracts";
import { releaseCandidateFixture } from "@proofstack/core/testing";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Authenticator } from "./auth.js";
import {
  type ReleaseCandidateRouteDependencies,
  registerReleaseCandidateRoutes,
} from "./release-candidate-routes.js";

const scope = {
  environmentId: "env_release_route",
  projectId: "prj_release_route",
  tenantId: "ten_release_route",
} as const;
const candidate = releaseCandidateFixture("release_route", scope);

function requestFor(record: ReleaseCandidate) {
  const {
    candidateId: _candidateId,
    createdAt: _createdAt,
    createdByPrincipalId: _createdByPrincipalId,
    definitionSha256: _definitionSha256,
    predecessor,
    schemaVersion: _schemaVersion,
    scope: _scope,
    ...definition
  } = record;
  return PublishReleaseCandidateRequestSchema.parse({
    ...definition,
    ...(predecessor ? { predecessorVersionId: predecessor.candidateVersionId } : {}),
  });
}

const request = requestFor(candidate);
const url = `/v1/projects/${scope.projectId}/environments/${scope.environmentId}/release-candidates/${candidate.candidateId}/versions/${candidate.candidateVersionId}`;

function principal(): PrincipalContext {
  return {
    authentication: { authenticatedAt: "2026-09-06T15:00:00.000Z", method: "development" },
    capabilities: ["release:manage", "release:read"],
    principalId: "usr_release_route",
    principalType: "user",
    requestId: "req_release_route",
    resourceScope: { mode: "tenant" },
    roles: ["owner"],
    tenantId: scope.tenantId,
  };
}

function dependencies(
  overrides: Partial<ReleaseCandidateRouteDependencies> = {},
): ReleaseCandidateRouteDependencies {
  return {
    authenticator: { authenticate: vi.fn(async () => principal()) },
    publishCandidate: {
      execute: vi.fn(async () => ({ candidate, created: true })),
    } as unknown as ReleaseCandidateRouteDependencies["publishCandidate"],
    readCandidate: {
      execute: vi.fn(async () => candidate),
    } as unknown as ReleaseCandidateRouteDependencies["readCandidate"],
    ...overrides,
  };
}

const apps: ReturnType<typeof Fastify>[] = [];

async function testApp(value = dependencies()) {
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, _request, reply) => {
    const errorName = error instanceof Error ? error.name : "UnknownError";
    reply.status(errorName === "ZodError" ? 400 : 500).send({ error: errorName });
  });
  await registerReleaseCandidateRoutes(app, value);
  apps.push(app);
  return { app, value };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("release candidate routes", () => {
  it("publishes and reads one exact immutable candidate", async () => {
    const { app, value } = await testApp();
    const publication = await app.inject({ body: request, method: "POST", url });
    const read = await app.inject({ method: "GET", url });

    expect(publication.statusCode).toBe(201);
    expect(read.statusCode).toBe(200);
    for (const response of [publication, read]) {
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.json()).toMatchObject({
        candidate: { candidateVersionId: candidate.candidateVersionId },
        requestId: expect.any(String),
      });
    }
    expect(value.publishCandidate.execute).toHaveBeenCalledWith({
      candidateId: candidate.candidateId,
      candidateVersionId: candidate.candidateVersionId,
      environmentId: scope.environmentId,
      input: request,
      principal: principal(),
      projectId: scope.projectId,
    });
    expect(value.readCandidate.execute).toHaveBeenCalledWith({
      candidateId: candidate.candidateId,
      candidateVersionId: candidate.candidateVersionId,
      environmentId: scope.environmentId,
      principal: principal(),
      projectId: scope.projectId,
    });
  });

  it("returns 200 for an exact idempotent retry", async () => {
    const { app } = await testApp(
      dependencies({
        publishCandidate: {
          execute: vi.fn(async () => ({ candidate, created: false })),
        } as unknown as ReleaseCandidateRouteDependencies["publishCandidate"],
      }),
    );
    const response = await app.inject({ body: request, method: "POST", url });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ created: false });
  });

  it("authenticates before parsing protected path and body values", async () => {
    const authenticator: Authenticator = {
      authenticate: vi.fn(async () => {
        throw new Error("unauthenticated");
      }),
    };
    const { app, value } = await testApp(dependencies({ authenticator }));
    const response = await app.inject({
      body: { secret: "must-not-be-parsed" },
      method: "POST",
      url: `/v1/projects/bad!/environments/bad!/release-candidates/bad!/versions/bad!`,
    });
    expect(response.statusCode).toBe(500);
    expect(authenticator.authenticate).toHaveBeenCalledOnce();
    expect(value.publishCandidate.execute).not.toHaveBeenCalled();
  });

  it("rejects malformed paths and bodies before invoking use cases", async () => {
    const { app, value } = await testApp();
    const [pathResponse, bodyResponse] = await Promise.all([
      app.inject({
        body: request,
        method: "POST",
        url: `/v1/projects/${scope.projectId}/environments/${scope.environmentId}/release-candidates/bad!/versions/bad!`,
      }),
      app.inject({
        body: { ...request, releaseDecision: "allow" },
        method: "POST",
        url,
      }),
    ]);
    expect([pathResponse.statusCode, bodyResponse.statusCode]).toEqual([400, 400]);
    expect(value.publishCandidate.execute).not.toHaveBeenCalled();
  });

  it("refuses to emit malformed use-case output", async () => {
    const { app } = await testApp(
      dependencies({
        readCandidate: {
          execute: vi.fn(async () => ({ secret: "malformed" })),
        } as unknown as ReleaseCandidateRouteDependencies["readCandidate"],
      }),
    );
    const response = await app.inject({ method: "GET", url });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: "Error" });
  });
});
