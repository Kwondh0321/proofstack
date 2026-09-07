import {
  PrincipalContextSchema,
  type PublishReleasePolicyRequest,
  PublishReleasePolicyRequestSchema,
  type ReleasePolicy,
} from "@proofstack/contracts";
import {
  MemoryReleasePolicyRepository,
  type ReleasePolicyAuthorityEvidenceResolver,
  ReleasePolicyAuthorityResolutionError,
} from "@proofstack/core";
import { policyAuthorityFixture } from "@proofstack/core/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type AppDependencies, createApp } from "./app.js";
import { AuthenticationRequiredError, type Authenticator } from "./auth.js";
import { loadConfig } from "./config.js";

const fixture = policyAuthorityFixture();
const scope = fixture.input.scope;
const policyUrl =
  `/v1/projects/${scope.projectId}/environments/${scope.environmentId}` +
  `/release-policies/${fixture.policy.policyId}/versions/${fixture.policy.policyVersionId}`;
const lifecycleUrl = `${policyUrl}/lifecycle-events`;
const config = loadConfig({ PROOFSTACK_ENV: "test", PROOFSTACK_LOG_LEVEL: "silent" });
const apps: Awaited<ReturnType<typeof createApp>>[] = [];

function requestFor(policy: ReleasePolicy): PublishReleasePolicyRequest {
  const {
    definitionSha256: _definitionSha256,
    issuerPrincipalId: _issuerPrincipalId,
    policyId: _policyId,
    predecessor,
    publishedAt: _publishedAt,
    publishedByPrincipalId: _publishedByPrincipalId,
    schemaVersion: _schemaVersion,
    scope: _scope,
    ...definition
  } = structuredClone(policy);
  return PublishReleasePolicyRequestSchema.parse({
    ...definition,
    ...(predecessor ? { predecessorVersionId: predecessor.policyVersionId } : {}),
  });
}

const request = requestFor(fixture.policy);

function authenticator(
  principalType: "user" | "workload" = "user",
  capabilities: readonly ("policy:author" | "policy:read")[] = ["policy:author", "policy:read"],
): Authenticator {
  return {
    authenticate: async (fastifyRequest) =>
      PrincipalContextSchema.parse({
        authentication: {
          authenticatedAt: "2026-09-06T22:00:00.000Z",
          method: "development",
        },
        capabilities,
        principalId: fixture.policy.issuerPrincipalId,
        principalType,
        requestId: fastifyRequest.id,
        resourceScope: { mode: "tenant" },
        roles: ["admin"],
        tenantId: scope.tenantId,
      }),
  };
}

function authorityResolver() {
  const resolve = vi.fn<ReleasePolicyAuthorityEvidenceResolver["resolve"]>(async () => ({
    artifacts: structuredClone(fixture.input.artifacts),
    installationBinding: structuredClone(fixture.binding),
    sources: structuredClone(fixture.input.sources),
  }));
  return { resolve };
}

async function testApp(dependencies: AppDependencies = {}) {
  const app = await createApp(config, {
    authenticator: authenticator(),
    clock: { now: () => new Date(fixture.input.at) },
    ...dependencies,
  });
  apps.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("release policy control-plane API", () => {
  it("publishes once, reads the exact policy, and preserves the retry receipt", async () => {
    const authority = authorityResolver();
    const app = await testApp({ releasePolicyAuthorityResolver: authority });

    const publication = await app.inject({ body: request, method: "POST", url: policyUrl });
    const retry = await app.inject({ body: request, method: "POST", url: policyUrl });
    const read = await app.inject({ method: "GET", url: policyUrl });

    expect(publication.statusCode).toBe(201);
    expect(retry.statusCode).toBe(200);
    expect(read.statusCode).toBe(200);
    expect(publication.json()).toMatchObject({
      created: true,
      policy: {
        issuerPrincipalId: fixture.policy.issuerPrincipalId,
        policyId: fixture.policy.policyId,
        policyVersionId: fixture.policy.policyVersionId,
        publishedByPrincipalId: fixture.policy.issuerPrincipalId,
        scope,
      },
    });
    expect(retry.json()).toMatchObject({ created: false, policy: publication.json().policy });
    expect(read.json()).toMatchObject({ policy: publication.json().policy });
    for (const response of [publication, retry, read]) {
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.json().requestId).toEqual(expect.any(String));
    }
    expect(authority.resolve).toHaveBeenCalledOnce();
  });

  it("records and reads one exact terminal lifecycle event idempotently", async () => {
    const app = await testApp({ releasePolicyAuthorityResolver: authorityResolver() });
    const publication = await app.inject({ body: request, method: "POST", url: policyUrl });
    expect(publication.statusCode).toBe(201);
    const lifecycleRequest = {
      eventId: "policy_event_api_withdrawal",
      kind: "withdrawn",
      reason: "The installation no longer authorizes this policy for release decisions.",
    } as const;

    const lifecycle = await app.inject({
      body: lifecycleRequest,
      method: "POST",
      url: lifecycleUrl,
    });
    const retry = await app.inject({
      body: lifecycleRequest,
      method: "POST",
      url: lifecycleUrl,
    });
    const read = await app.inject({
      method: "GET",
      url: `${lifecycleUrl}/${lifecycleRequest.eventId}`,
    });
    const missing = await app.inject({
      method: "GET",
      url: `${lifecycleUrl}/policy_event_api_missing`,
    });
    const conflict = await app.inject({
      body: { ...lifecycleRequest, reason: "A conflicting immutable lifecycle reason." },
      method: "POST",
      url: lifecycleUrl,
    });

    expect(lifecycle.statusCode).toBe(201);
    expect(retry.statusCode).toBe(200);
    expect(read.statusCode).toBe(200);
    expect(lifecycle.json()).toMatchObject({
      created: true,
      event: {
        actorPrincipalId: fixture.policy.issuerPrincipalId,
        eventId: lifecycleRequest.eventId,
        kind: lifecycleRequest.kind,
        policy: {
          definitionSha256: publication.json().policy.definitionSha256,
          policyId: fixture.policy.policyId,
          policyVersionId: fixture.policy.policyVersionId,
        },
      },
    });
    expect(retry.json()).toMatchObject({ created: false, event: lifecycle.json().event });
    expect(read.json()).toMatchObject({ event: lifecycle.json().event });
    expect(missing.json()).toMatchObject({
      code: "release_policy_lifecycle_event_not_found",
      status: 404,
    });
    expect(conflict.json()).toMatchObject({
      code: "release_policy_lifecycle_event_conflict",
      detail: "The release policy operation conflicts with existing immutable state",
      status: 409,
    });
    for (const response of [lifecycle, retry, read, missing, conflict]) {
      expect(response.headers["cache-control"]).toBe("no-store");
    }
  });

  it("fails closed without installation-owned authority and never exposes findings", async () => {
    const app = await testApp();
    const response = await app.inject({ body: request, method: "POST", url: policyUrl });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      code: "release_policy_authority_rejected",
      detail: "Release policy publication authority was rejected",
      status: 409,
    });
    expect(response.body).not.toContain("findings");
    expect(response.body).not.toContain("installation_binding_unavailable");
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("maps route mismatches, missing records, and semantic rebinding without leaking state", async () => {
    const authority = authorityResolver();
    const app = await testApp({ releasePolicyAuthorityResolver: authority });
    const routeMismatch = await app.inject({
      body: request,
      method: "POST",
      url: `${policyUrl}_different`,
    });
    const missing = await app.inject({ method: "GET", url: `${policyUrl}_missing` });

    expect(routeMismatch.json()).toMatchObject({
      code: "release_policy_command_invalid",
      status: 400,
    });
    expect(missing.json()).toMatchObject({ code: "release_policy_not_found", status: 404 });

    const publication = await app.inject({ body: request, method: "POST", url: policyUrl });
    expect(publication.statusCode).toBe(201);
    const changed = { ...request, changeRationale: "Different immutable policy semantics." };
    const conflict = await app.inject({ body: changed, method: "POST", url: policyUrl });
    expect(conflict.json()).toMatchObject({
      code: "release_policy_version_conflict",
      detail: "The release policy operation conflicts with existing immutable state",
      status: 409,
    });
    expect(conflict.body).not.toContain(fixture.policy.policyVersionId);
    for (const response of [routeMismatch, missing, conflict]) {
      expect(response.headers["cache-control"]).toBe("no-store");
    }
    expect(authority.resolve).toHaveBeenCalledOnce();
  });

  it("converts authority outages and repository corruption to stable unavailable problems", async () => {
    const unavailable = await testApp({
      releasePolicyAuthorityResolver: {
        resolve: async () => {
          throw new ReleasePolicyAuthorityResolutionError("sensitive authority backend detail");
        },
      },
    });
    const authorityFailure = await unavailable.inject({
      body: request,
      method: "POST",
      url: policyUrl,
    });
    expect(authorityFailure.json()).toMatchObject({
      code: "release_policy_authority_unavailable",
      detail: "Release policy authority resolution is unavailable",
      status: 503,
    });
    expect(authorityFailure.body).not.toContain("sensitive authority backend detail");

    const invalidAuthority = await testApp({
      releasePolicyAuthorityResolver: {
        resolve: async () => ({
          artifacts: "invalid",
          installationBinding: fixture.binding,
          sources: fixture.input.sources,
        }),
      } as never,
    });
    const contractFailure = await invalidAuthority.inject({
      body: request,
      method: "POST",
      url: policyUrl,
    });
    expect(contractFailure.json()).toMatchObject({
      code: "release_policy_authority_unavailable",
      detail: "Release policy authority resolution is unavailable",
      status: 503,
    });

    const repository = new MemoryReleasePolicyRepository();
    vi.spyOn(repository, "findReleasePolicy").mockResolvedValue({ secret: "corrupt" } as never);
    const corrupted = await testApp({ releasePolicyRepository: repository });
    const storageFailure = await corrupted.inject({ method: "GET", url: policyUrl });
    expect(storageFailure.json()).toMatchObject({
      code: "release_policy_storage_unavailable",
      detail: "Release policy storage is unavailable",
      status: 503,
    });
    expect(storageFailure.body).not.toContain("corrupt");
    for (const response of [authorityFailure, contractFailure, storageFailure]) {
      expect(response.headers["cache-control"]).toBe("no-store");
    }
  });

  it("prevents caching errors emitted before protected policy handlers complete", async () => {
    const authority = authorityResolver();
    const denied = await testApp({
      authenticator: {
        authenticate: async () => {
          throw new AuthenticationRequiredError();
        },
      },
      releasePolicyAuthorityResolver: authority,
    });
    for (const url of [policyUrl, `${lifecycleUrl}/policy_event_missing`]) {
      const response = await denied.inject({ method: "GET", url });
      expect(response.statusCode).toBe(401);
      expect(response.headers["cache-control"]).toBe("no-store");
    }
    for (const url of [policyUrl, lifecycleUrl]) {
      const response = await denied.inject({ body: {}, method: "POST", url });
      expect(response.statusCode).toBe(401);
      expect(response.headers["cache-control"]).toBe("no-store");
    }

    const app = await testApp({ releasePolicyAuthorityResolver: authority });
    for (const url of [policyUrl, lifecycleUrl]) {
      for (const invalidBody of [
        { body: "{", headers: { "content-type": "application/json" }, status: 400 },
        { body: "x", headers: { "content-type": "application/xml" }, status: 415 },
        {
          body: "x".repeat(1024 * 1024 + 1),
          headers: { "content-type": "application/json" },
          status: 413,
        },
      ]) {
        const { status, ...payload } = invalidBody;
        const response = await app.inject({ ...payload, method: "POST", url });
        expect(response.statusCode).toBe(status);
        expect(response.headers["cache-control"]).toBe("no-store");
        expect(response.headers["content-type"]).toContain("application/problem+json");
      }
    }
    expect(authority.resolve).not.toHaveBeenCalled();
  });

  it.each(["2025-01-01T00:00:00.000Z", "2026-09-06T23:00:00.001Z"])(
    "never exposes a successful first-publication receipt with substituted time %s",
    async (publishedAt) => {
      const repository = new MemoryReleasePolicyRepository();
      const publish = vi
        .spyOn(repository, "publishReleasePolicy")
        .mockImplementation(async (policy) => ({
          created: true,
          policy: { ...policy, publishedAt },
        }));
      const app = await testApp({
        releasePolicyAuthorityResolver: authorityResolver(),
        releasePolicyRepository: repository,
      });

      const response = await app.inject({ body: request, method: "POST", url: policyUrl });

      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({
        code: "release_policy_storage_unavailable",
        detail: "Release policy storage is unavailable",
        status: 503,
      });
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers["content-type"]).toContain("application/problem+json");
      expect(response.body).not.toContain(publishedAt);
      expect(response.body).not.toContain("substituted");
      expect(response.json()).not.toHaveProperty("policy");
      expect(publish).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ publishedAt: fixture.input.at }),
      );
    },
  );

  it("denies policy publication to workload identities before authority or storage mutation", async () => {
    const authority = authorityResolver();
    const repository = new MemoryReleasePolicyRepository();
    const find = vi.spyOn(repository, "findReleasePolicy");
    const publish = vi.spyOn(repository, "publishReleasePolicy");
    const app = await testApp({
      authenticator: authenticator("workload", ["policy:author", "policy:read"]),
      releasePolicyAuthorityResolver: authority,
      releasePolicyRepository: repository,
    });

    const response = await app.inject({ body: request, method: "POST", url: policyUrl });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: "forbidden", status: 403 });
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(find).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(authority.resolve).not.toHaveBeenCalled();
  });
});
