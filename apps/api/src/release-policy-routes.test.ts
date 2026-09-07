import { randomUUID } from "node:crypto";
import {
  MAX_RELEASE_POLICY_RESPONSE_BYTES,
  type PrincipalContext,
  PublishReleasePolicyLifecycleRequestSchema,
  PublishReleasePolicyRequestSchema,
  type ReleasePolicy,
  ReleasePolicySchema,
} from "@proofstack/contracts";
import { createReleasePolicyRepositoryTestHarness } from "@proofstack/core/testing";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Authenticator } from "./auth.js";
import {
  type ReleasePolicyRouteDependencies,
  registerReleasePolicyRoutes,
} from "./release-policy-routes.js";

const fixture = createReleasePolicyRepositoryTestHarness("policy_route");
const { policy, scope, withdrawal } = fixture;

function requestFor(record: ReleasePolicy) {
  const request = structuredClone(record) as unknown as Record<string, unknown>;
  for (const key of [
    "definitionSha256",
    "issuerPrincipalId",
    "policyId",
    "predecessor",
    "publishedAt",
    "publishedByPrincipalId",
    "schemaVersion",
    "scope",
  ]) {
    Reflect.deleteProperty(request, key);
  }
  if (record.predecessor) {
    Reflect.set(request, "predecessorVersionId", record.predecessor.policyVersionId);
  }
  return PublishReleasePolicyRequestSchema.parse(request);
}

const policyRequest = requestFor(policy);
const lifecycleRequest = PublishReleasePolicyLifecycleRequestSchema.parse({
  eventId: withdrawal.eventId,
  kind: withdrawal.kind,
  reason: withdrawal.reason,
});
const policyUrl = `/v1/projects/${scope.projectId}/environments/${scope.environmentId}/release-policies/${policy.policyId}/versions/${policy.policyVersionId}`;
const lifecycleUrl = `${policyUrl}/lifecycle-events`;
const exactLifecycleUrl = `${lifecycleUrl}/${withdrawal.eventId}`;

function principal(): PrincipalContext {
  return {
    authentication: { authenticatedAt: "2026-09-07T05:00:00.000Z", method: "development" },
    capabilities: ["policy:author", "policy:read"],
    principalId: "principal_policy_route",
    principalType: "user",
    requestId: "request_policy_route",
    resourceScope: { mode: "tenant" },
    roles: ["admin"],
    tenantId: scope.tenantId,
  };
}

function dependencies(
  overrides: Partial<ReleasePolicyRouteDependencies> = {},
): ReleasePolicyRouteDependencies {
  return {
    authenticator: { authenticate: vi.fn(async () => principal()) },
    publishLifecycle: {
      execute: vi.fn(async () => ({ created: true, event: withdrawal })),
    } as unknown as ReleasePolicyRouteDependencies["publishLifecycle"],
    publishPolicy: {
      execute: vi.fn(async () => ({ created: true, policy })),
    } as unknown as ReleasePolicyRouteDependencies["publishPolicy"],
    readLifecycle: {
      execute: vi.fn(async () => withdrawal),
    } as unknown as ReleasePolicyRouteDependencies["readLifecycle"],
    readPolicy: {
      execute: vi.fn(async () => policy),
    } as unknown as ReleasePolicyRouteDependencies["readPolicy"],
    ...overrides,
  };
}

const apps: ReturnType<typeof Fastify>[] = [];

async function testApp(value = dependencies()) {
  const app = Fastify({ genReqId: () => randomUUID(), logger: false });
  app.setErrorHandler((error, _request, reply) => {
    const errorName = error instanceof Error ? error.name : "UnknownError";
    reply.status(errorName === "ZodError" ? 400 : 500).send({ error: errorName });
  });
  await registerReleasePolicyRoutes(app, value);
  apps.push(app);
  return { app, value };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("release policy routes", () => {
  it("returns a bounded non-cacheable error for an oversized internal policy response", async () => {
    const threshold = policy.rules.find(
      ({ predicate }) => predicate.kind === "comparison_threshold",
    );
    const approval = policy.rules.find(({ predicate }) => predicate.kind === "approval_required");
    if (!threshold || !approval) throw new Error("Expected threshold and approval rules");
    const oversized = ReleasePolicySchema.parse({
      ...policy,
      rules: [
        ...Array.from({ length: 100 }, (_, index) => ({
          ...threshold,
          rationale: "😀".repeat(4096),
          ruleId: `rule_${String(index).padStart(3, "0")}`,
        })),
        { ...approval, ruleId: "rule_999" },
      ],
    });
    expect(Buffer.byteLength(JSON.stringify(oversized))).toBeGreaterThan(
      MAX_RELEASE_POLICY_RESPONSE_BYTES,
    );
    const { app } = await testApp(dependencies({ readPolicy: { execute: async () => oversized } }));
    const response = await app.inject({ method: "GET", url: policyUrl });
    expect(response.statusCode).toBe(500);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(Buffer.byteLength(response.body)).toBeLessThan(1024);
    expect(response.body).not.toContain("😀");
  });

  it("authenticates once per request and isolates principals across concurrent reads", async () => {
    const authenticate = vi.fn<Authenticator["authenticate"]>(async (request) => ({
      ...principal(),
      principalId: `principal_${request.id.replaceAll("-", "_")}`,
      requestId: request.id,
    }));
    const { app, value } = await testApp(dependencies({ authenticator: { authenticate } }));
    const responses = await Promise.all(
      Array.from({ length: 8 }, () => app.inject({ method: "GET", url: policyUrl })),
    );

    expect(responses.map(({ statusCode }) => statusCode)).toEqual(Array(8).fill(200));
    expect(authenticate).toHaveBeenCalledTimes(8);
    const calls = vi.mocked(value.readPolicy.execute).mock.calls;
    expect(calls).toHaveLength(8);
    expect(new Set(calls.map(([command]) => command.principal.principalId)).size).toBe(8);
    expect(calls.map(([command]) => command.principal.requestId).sort()).toEqual(
      responses.map((response) => response.json().requestId).sort(),
    );
    for (const [command] of calls) {
      expect(command.principal.principalId).toBe(
        `principal_${command.principal.requestId.replaceAll("-", "_")}`,
      );
    }
  });

  it("publishes and reads exact immutable policy and lifecycle records", async () => {
    const { app, value } = await testApp();
    const responses = await Promise.all([
      app.inject({ body: policyRequest, method: "POST", url: policyUrl }),
      app.inject({ method: "GET", url: policyUrl }),
      app.inject({ body: lifecycleRequest, method: "POST", url: lifecycleUrl }),
      app.inject({ method: "GET", url: exactLifecycleUrl }),
    ]);

    expect(responses.map((response) => response.statusCode)).toEqual([201, 200, 201, 200]);
    for (const response of responses) {
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.json()).toMatchObject({ requestId: expect.any(String) });
    }
    expect(responses[0]?.json()).toMatchObject({
      created: true,
      policy: { policyVersionId: policy.policyVersionId },
    });
    expect(responses[1]?.json()).toMatchObject({
      policy: { policyVersionId: policy.policyVersionId },
    });
    expect(responses[2]?.json()).toMatchObject({
      created: true,
      event: { eventId: withdrawal.eventId },
    });
    expect(responses[3]?.json()).toMatchObject({ event: { eventId: withdrawal.eventId } });

    expect(value.publishPolicy.execute).toHaveBeenCalledWith({
      environmentId: scope.environmentId,
      input: policyRequest,
      policyId: policy.policyId,
      policyVersionId: policy.policyVersionId,
      principal: principal(),
      projectId: scope.projectId,
    });
    expect(value.readPolicy.execute).toHaveBeenCalledWith({
      environmentId: scope.environmentId,
      policyId: policy.policyId,
      policyVersionId: policy.policyVersionId,
      principal: principal(),
      projectId: scope.projectId,
    });
    expect(value.publishLifecycle.execute).toHaveBeenCalledWith({
      environmentId: scope.environmentId,
      input: lifecycleRequest,
      policyId: policy.policyId,
      policyVersionId: policy.policyVersionId,
      principal: principal(),
      projectId: scope.projectId,
    });
    expect(value.readLifecycle.execute).toHaveBeenCalledWith({
      environmentId: scope.environmentId,
      eventId: withdrawal.eventId,
      policyId: policy.policyId,
      policyVersionId: policy.policyVersionId,
      principal: principal(),
      projectId: scope.projectId,
    });
  });

  it("returns 200 for exact idempotent publication retries", async () => {
    const { app } = await testApp(
      dependencies({
        publishLifecycle: {
          execute: vi.fn(async () => ({ created: false, event: withdrawal })),
        } as unknown as ReleasePolicyRouteDependencies["publishLifecycle"],
        publishPolicy: {
          execute: vi.fn(async () => ({ created: false, policy })),
        } as unknown as ReleasePolicyRouteDependencies["publishPolicy"],
      }),
    );
    const responses = await Promise.all([
      app.inject({ body: policyRequest, method: "POST", url: policyUrl }),
      app.inject({ body: lifecycleRequest, method: "POST", url: lifecycleUrl }),
    ]);
    expect(responses.map((response) => response.statusCode)).toEqual([200, 200]);
    expect(responses.map((response) => response.json().created)).toEqual([false, false]);
  });

  it("authenticates before parsing every protected route", async () => {
    const authenticator: Authenticator = {
      authenticate: vi.fn(async () => {
        throw new Error("unauthenticated");
      }),
    };
    const { app, value } = await testApp(dependencies({ authenticator }));
    const malformedPolicyUrl =
      "/v1/projects/bad!/environments/bad!/release-policies/bad!/versions/bad!";
    const responses = await Promise.all([
      app.inject({ body: { secret: "not-parsed" }, method: "POST", url: malformedPolicyUrl }),
      app.inject({ method: "GET", url: malformedPolicyUrl }),
      app.inject({
        body: { secret: "not-parsed" },
        method: "POST",
        url: `${malformedPolicyUrl}/lifecycle-events`,
      }),
      app.inject({ method: "GET", url: `${malformedPolicyUrl}/lifecycle-events/bad!` }),
    ]);
    expect(responses.map((response) => response.statusCode)).toEqual([500, 500, 500, 500]);
    for (const response of responses) {
      expect(response.headers["cache-control"]).toBe("no-store");
    }
    expect(authenticator.authenticate).toHaveBeenCalledTimes(4);
    for (const useCase of [
      value.publishPolicy,
      value.readPolicy,
      value.publishLifecycle,
      value.readLifecycle,
    ]) {
      expect(useCase.execute).not.toHaveBeenCalled();
    }
  });

  it("rejects malformed paths and bodies before invoking use cases", async () => {
    const { app, value } = await testApp();
    const responses = await Promise.all([
      app.inject({
        body: policyRequest,
        method: "POST",
        url: `/v1/projects/${scope.projectId}/environments/${scope.environmentId}/release-policies/bad!/versions/bad!`,
      }),
      app.inject({
        body: { ...policyRequest, releaseDecision: "allow" },
        method: "POST",
        url: policyUrl,
      }),
      app.inject({
        body: { ...lifecycleRequest, enforcementAction: "deploy" },
        method: "POST",
        url: lifecycleUrl,
      }),
      app.inject({ method: "GET", url: `${lifecycleUrl}/bad!` }),
    ]);
    expect(responses.map((response) => response.statusCode)).toEqual([400, 400, 400, 400]);
    for (const response of responses) {
      expect(response.headers["cache-control"]).toBe("no-store");
    }
    for (const useCase of [
      value.publishPolicy,
      value.readPolicy,
      value.publishLifecycle,
      value.readLifecycle,
    ]) {
      expect(useCase.execute).not.toHaveBeenCalled();
    }
  });

  it("refuses to emit malformed use-case output from every route", async () => {
    const invalid = vi.fn(async () => ({ secret: "malformed" }));
    const { app } = await testApp(
      dependencies({
        publishLifecycle: {
          execute: invalid,
        } as unknown as ReleasePolicyRouteDependencies["publishLifecycle"],
        publishPolicy: {
          execute: invalid,
        } as unknown as ReleasePolicyRouteDependencies["publishPolicy"],
        readLifecycle: {
          execute: invalid,
        } as unknown as ReleasePolicyRouteDependencies["readLifecycle"],
        readPolicy: { execute: invalid } as unknown as ReleasePolicyRouteDependencies["readPolicy"],
      }),
    );
    const responses = await Promise.all([
      app.inject({ body: policyRequest, method: "POST", url: policyUrl }),
      app.inject({ method: "GET", url: policyUrl }),
      app.inject({ body: lifecycleRequest, method: "POST", url: lifecycleUrl }),
      app.inject({ method: "GET", url: exactLifecycleUrl }),
    ]);
    expect(responses.map((response) => response.statusCode)).toEqual([500, 500, 500, 500]);
    for (const response of responses) {
      expect(response.headers["cache-control"]).toBe("no-store");
    }
    expect(responses.map((response) => response.json())).toEqual([
      { error: "Error" },
      { error: "Error" },
      { error: "Error" },
      { error: "Error" },
    ]);
  });
});
