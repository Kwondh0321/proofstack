import {
  PublishReleaseCandidateRequestSchema,
  type ReleaseCandidate,
  ReleaseCandidateDefinitionSchema,
} from "@proofstack/contracts";
import {
  MemoryReleaseCandidateRepository,
  type ReleaseCandidateSourceResolver,
  releaseCandidateSourceReferences,
} from "@proofstack/core";
import { releaseCandidateFixture } from "@proofstack/core/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

const scope = {
  environmentId: "env_release_api",
  projectId: "prj_release_api",
  tenantId: "ten_local",
} as const;
const candidate = releaseCandidateFixture("release_api", scope);

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
const { predecessorVersionId: _predecessorVersionId, ...requestDefinition } = request;
const candidateDefinition = ReleaseCandidateDefinitionSchema.parse({
  ...requestDefinition,
  candidateId: candidate.candidateId,
});
const url = `/v1/projects/${scope.projectId}/environments/${scope.environmentId}/release-candidates/${candidate.candidateId}/versions/${candidate.candidateVersionId}`;
const config = loadConfig({ PROOFSTACK_ENV: "test", PROOFSTACK_LOG_LEVEL: "silent" });
const apps: Awaited<ReturnType<typeof createApp>>[] = [];

async function testApp(dependencies: Parameters<typeof createApp>[1] = {}) {
  const app = await createApp(config, {
    clock: { now: () => new Date(candidate.createdAt) },
    ...dependencies,
  });
  apps.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("release candidate control-plane API", () => {
  it("resolves every source, publishes once, and reads the exact candidate", async () => {
    const isAvailable = vi.fn<ReleaseCandidateSourceResolver["isAvailable"]>(async () => true);
    const app = await testApp({ releaseCandidateSourceResolver: { isAvailable } });

    const publication = await app.inject({ body: request, method: "POST", url });
    const retry = await app.inject({ body: request, method: "POST", url });
    const read = await app.inject({ method: "GET", url });

    expect(publication.statusCode).toBe(201);
    expect(retry.statusCode).toBe(200);
    expect(read.statusCode).toBe(200);
    expect(publication.json()).toMatchObject({
      candidate: {
        candidateId: candidate.candidateId,
        candidateVersionId: candidate.candidateVersionId,
        definitionSha256: candidate.definitionSha256,
      },
      created: true,
    });
    expect(retry.json()).toMatchObject({ created: false });
    expect(read.json().candidate).toEqual(publication.json().candidate);
    for (const response of [publication, retry, read]) {
      expect(response.headers["cache-control"]).toBe("no-store");
    }
    expect(isAvailable).toHaveBeenCalledTimes(
      releaseCandidateSourceReferences(candidateDefinition).length,
    );
  });

  it("fails closed when no authoritative source resolver is installed", async () => {
    const app = await testApp();
    const response = await app.inject({ body: request, method: "POST", url });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      code: "release_candidate_source_unavailable",
      status: 409,
    });
  });

  it("maps route mismatches, absent candidates, and repository corruption", async () => {
    const app = await testApp({
      releaseCandidateSourceResolver: { isAvailable: () => Promise.resolve(true) },
    });
    const routeMismatch = await app.inject({
      body: request,
      method: "POST",
      url: `${url}_different`,
    });
    const missing = await app.inject({
      method: "GET",
      url: `${url}_missing`,
    });
    const wrongLogicalIdentity = await app.inject({
      method: "GET",
      url: `/v1/projects/${scope.projectId}/environments/${scope.environmentId}/release-candidates/candidate_wrong/versions/${candidate.candidateVersionId}`,
    });

    expect(routeMismatch.json()).toMatchObject({
      code: "release_candidate_command_invalid",
      status: 400,
    });
    expect(missing.json()).toMatchObject({ code: "release_candidate_not_found", status: 404 });
    expect(wrongLogicalIdentity.json()).toMatchObject({
      code: "release_candidate_not_found",
      status: 404,
    });

    const repository = new MemoryReleaseCandidateRepository();
    vi.spyOn(repository, "findReleaseCandidate").mockResolvedValue({ secret: "corrupt" } as never);
    const corrupted = await testApp({ releaseCandidateRepository: repository });
    const corruption = await corrupted.inject({ method: "GET", url });
    expect(corruption.json()).toMatchObject({
      code: "release_candidate_storage_unavailable",
      detail: "Release candidate storage is unavailable",
      status: 503,
    });
    expect(corruption.body).not.toContain("corrupt");
  });
});
