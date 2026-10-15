import { afterEach, describe, expect, it } from "vitest";
import { createApp, type ApiConfig } from "@proofstack/api/composition";
import { PrincipalContextSchema } from "@proofstack/contracts";
import {
  MemoryPolicyEvaluationJobRepository,
  policySnapshotRepositoryFixture,
} from "@proofstack/core/testing";
import { ProofStackPolicyEvaluationClient } from "@proofstack/sdk";

const apps: Awaited<ReturnType<typeof createApp>>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
async function harness() {
  const f = policySnapshotRepositoryFixture();
  let now = f.request.createdAt;
  const repository = new MemoryPolicyEvaluationJobRepository({ now: () => now });
  const principal = PrincipalContextSchema.parse({
    principalId: f.request.createdByPrincipalId,
    principalType: "user",
    tenantId: f.scope.tenantId,
    authentication: { method: "development", authenticatedAt: now },
    capabilities: ["policy:read", "policy:evaluate", "policy:evaluation:cancel"],
    roles: ["member"],
    requestId: "request_policy_sdk_api",
    resourceScope: {
      mode: "restricted",
      projects: [{ projectId: f.scope.projectId, environmentIds: [f.scope.environmentId] }],
    },
  });
  const config: ApiConfig = {
    authMode: "development",
    corsOrigin: undefined,
    environment: "test",
    host: "127.0.0.1",
    logLevel: "silent",
    port: 4318,
    oidc: undefined,
    identityDatabaseUrl: undefined,
    storage: { mode: "memory" },
    otlp: { compressedBodyLimitBytes: 1048576, decompressedBodyLimitBytes: 4194304 },
  };
  const app = await createApp(config, {
    clock: { now: () => new Date(now) },
    authenticator: { authenticate: async () => structuredClone(principal) },
    policyEvaluationStorage: { control: repository, snapshots: repository, results: repository },
  });
  apps.push(app);
  const fetch: typeof globalThis.fetch = async (input, init) => {
    init?.signal?.throwIfAborted();
    const url = new URL(String(input));
    if (init?.method !== "GET" && init?.method !== "POST") throw new Error("Unexpected SDK method");
    if (init.body !== undefined && typeof init.body !== "string")
      throw new Error("Unexpected SDK body");
    const response = await app.inject({
      method: init.method,
      url: url.pathname + url.search,
      headers: Object.fromEntries(new Headers(init.headers)),
      ...(init.body === undefined ? {} : { payload: init.body }),
    });
    init.signal?.throwIfAborted();
    const headers = new Headers();
    for (const [key, value] of Object.entries(response.headers)) {
      if (Array.isArray(value)) for (const item of value) headers.append(key, item);
      else if (value !== undefined) headers.set(key, String(value));
    }
    return new Response(response.body, { status: response.statusCode, headers });
  };
  const sdk = new ProofStackPolicyEvaluationClient({
    endpoint: "http://127.0.0.1:4318",
    authentication: { mode: "development" },
    scope: f.scope,
    fetch,
  });
  const {
    scope: _scope,
    schemaVersion: _version,
    createdAt: _at,
    createdByPrincipalId: _by,
    definitionSha256: _sha,
    ...request
  } = f.request;
  return {
    f,
    repository,
    sdk,
    request,
    setTime(value: string) {
      now = value;
    },
  };
}

describe("policy SDK through the actual API and shared memory records", () => {
  it("enqueues, seals through the owning worker port and verifies original complete material/result without new fees", async () => {
    const h = await harness();
    const created = await h.sdk.enqueue({ request: h.request });
    const job = {
      jobId: created.snapshot.job.jobId,
      definitionSha256: created.snapshot.job.definitionSha256,
    };
    expect((await h.sdk.readRequest({ job })).request).toEqual(created.snapshot.request);
    const claimed = await h.repository.claimJob({
      scope: h.f.scope,
      jobId: job.jobId,
      workerId: h.f.workerId,
      attemptId: "attempt_sdk_actual_api",
      leaseId: "lease_sdk_actual_api",
    });
    const fence = claimed.job.currentLease!.mutationFence;
    h.setTime(h.f.publicationAt);
    const sealed = await h.repository.publishSnapshot({
      scope: h.f.scope,
      fence,
      pageSet: h.f.pageSet,
      principalId: h.f.workerId,
    });
    await h.repository.startComputation({ scope: h.f.scope, fence });
    await h.repository.reserveWork({
      scope: h.f.scope,
      fence,
      reservationId: "reservation_sdk_actual_api",
      delta: {
        reads: 0,
        records: 0,
        recordBytes: 0,
        references: 0,
        referenceBytes: 0,
        artifactReadBytes: 0,
        ruleEvaluations: h.f.inputs.rules.ruleCount,
      },
    });
    const completed = await h.repository.publishResult({
      scope: h.f.scope,
      fence,
      evaluationId: h.f.evaluationId,
      pageSet: h.f.pageSet,
    });
    expect((await h.sdk.readSnapshot({ job })).snapshot).toEqual(sealed.snapshot);
    const material = await h.sdk.readCompleteSnapshot({ job });
    expect(material.pageSet.pages).toEqual(h.f.pageSet.pages);
    expect(material.inputs).toEqual(h.f.inputs);
    expect((await h.sdk.readResult({ job })).evaluation).toEqual(completed.evaluation);
    expect((await h.sdk.readResult({ job })).evaluation).toEqual(completed.evaluation);
    expect((await h.sdk.readJob({ job })).snapshot).toEqual(completed.snapshot);
    expect(await h.repository.findJob(h.f.scope, job.jobId)).toEqual(completed.snapshot);
  });
  it("retains an exact prior history head across explicit reason-only cancellation", async () => {
    const h = await harness(),
      created = await h.sdk.enqueue({ request: h.request });
    const job = {
      jobId: created.snapshot.job.jobId,
      definitionSha256: created.snapshot.job.definitionSha256,
    };
    const head = (await h.sdk.readHistoryHead({ job })).head;
    const original = await h.sdk.readHistoryPage({ job, head, pageIndex: 0 });
    const cancelled = await h.sdk.cancel({ job, request: { reason: "operator_requested" } });
    expect(cancelled.snapshot.job.status).toBe("cancelled");
    expect(
      (await h.sdk.cancel({ job, request: { reason: "operator_requested" } })).snapshot,
    ).toEqual(cancelled.snapshot);
    expect((await h.sdk.readHistoryPage({ job, head, pageIndex: 0 })).page).toEqual(original.page);
    expect((await h.sdk.enqueue({ request: h.request })).snapshot).toEqual(cancelled.snapshot);
  });
});
