import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_POLICY_EVALUATION_REQUEST_BYTES,
  PrincipalContextSchema,
  ReadPolicyEvaluationJobResponseSchema,
  ReadPolicyEvaluationSnapshotResponseSchema,
  ReadPolicyEvaluationSnapshotPageResponseSchema,
  ReadPolicyEvaluationResponseSchema,
  type PolicyEvaluationJobSnapshot,
} from "@proofstack/contracts";
import {
  MemoryPolicyEvaluationJobRepository,
  policySnapshotRepositoryFixture,
} from "@proofstack/core/testing";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { AuthenticationRequiredError } from "./auth.js";

const apps: Awaited<ReturnType<typeof createApp>>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
async function harness() {
  const f = policySnapshotRepositoryFixture();
  let now = f.request.createdAt;
  const store = new MemoryPolicyEvaluationJobRepository({ now: () => now });
  let principal: unknown = PrincipalContextSchema.parse({
    principalId: "principal_public_api",
    principalType: "user",
    tenantId: f.scope.tenantId,
    capabilities: ["policy:read", "policy:evaluate", "policy:evaluation:cancel"],
    roles: ["member"],
    authentication: { method: "development", authenticatedAt: now },
    requestId: "request_public_api",
    resourceScope: {
      mode: "restricted",
      projects: [{ projectId: f.scope.projectId, environmentIds: [f.scope.environmentId] }],
    },
  });
  let rejectAuthentication = false;
  const authenticator = {
    authenticate: vi.fn(async () => {
      if (rejectAuthentication) throw new AuthenticationRequiredError();
      return structuredClone(principal) as ReturnType<typeof PrincipalContextSchema.parse>;
    }),
  };
  const app = await createApp(
    loadConfig({ PROOFSTACK_ENV: "test", PROOFSTACK_LOG_LEVEL: "silent" }),
    {
      authenticator,
      clock: { now: () => new Date(now) },
      policyEvaluationStorage: { control: store, snapshots: store, results: store },
    },
  );
  apps.push(app);
  const root = `/v1/projects/${f.scope.projectId}/environments/${f.scope.environmentId}/policy-evaluation-jobs`;
  const {
    scope: _scope,
    schemaVersion: _version,
    createdAt: _at,
    createdByPrincipalId: _by,
    definitionSha256: _sha,
    ...input
  } = structuredClone(f.request);
  async function seal() {
    await store.createJob({ request: f.request, jobId: f.jobId });
    const claimed = await store.claimJob({
      scope: f.scope,
      jobId: f.jobId,
      workerId: f.workerId,
      attemptId: "attempt_public_api",
      leaseId: "lease_public_api",
    });
    now = f.publicationAt;
    const fence = claimed.job.currentLease!.mutationFence;
    const sealed = await store.publishSnapshot({
      scope: f.scope,
      fence,
      pageSet: f.pageSet,
      principalId: f.workerId,
    });
    return { fence, sealed };
  }
  async function complete() {
    const { fence, sealed } = await seal();
    await store.startComputation({ scope: f.scope, fence });
    await store.reserveWork({
      scope: f.scope,
      fence,
      reservationId: "reservation_public_api_rules",
      delta: {
        reads: 0,
        records: 0,
        recordBytes: 0,
        references: 0,
        referenceBytes: 0,
        artifactReadBytes: 0,
        ruleEvaluations: f.inputs.rules.ruleCount,
      },
    });
    const result = await store.publishResult({
      scope: f.scope,
      fence,
      evaluationId: f.evaluationId,
      pageSet: f.pageSet,
    });
    return { result, sealed };
  }
  return {
    app,
    f,
    store,
    root,
    input,
    authenticator,
    seal,
    complete,
    setPrincipal(value: unknown) {
      principal = value;
    },
    denyCapability() {
      principal = { ...(principal as object), capabilities: [] };
    },
    denyAuthentication() {
      rejectAuthentication = true;
    },
  };
}
function uncached(response: { headers: Record<string, unknown> }) {
  expect(response.headers["cache-control"]).toBe("no-store");
}

describe("policy evaluation public API", () => {
  it("distinguishes a real immutable request conflict and a completed cancellation conflict", async () => {
    const h = await harness();
    const created = await h.app.inject({ method: "POST", url: h.root, payload: h.input });
    expect(created.statusCode).toBe(201);
    const conflict = await h.app.inject({
      method: "POST",
      url: h.root,
      payload: { ...h.input, evaluationTime: "2026-09-07T11:59:59.999Z" },
    });
    expect(conflict.statusCode).toBe(409);
    uncached(conflict);
    const completed = await harness(),
      { result } = await completed.complete();
    const cancelled = await completed.app.inject({
      method: "POST",
      url: `${completed.root}/${completed.f.jobId}/cancellation`,
      payload: { reason: "operator_requested" },
    });
    expect(cancelled.statusCode).toBe(409);
    uncached(cancelled);
    expect(await completed.store.findJob(completed.f.scope, completed.f.jobId)).toEqual(
      result.snapshot,
    );
  });
  it("classifies malformed retained history as storage failure without exposing internals", async () => {
    const h = await harness();
    await h.seal();
    vi.spyOn(h.store, "findHistoryHead").mockResolvedValue({
      privateDiagnostic: "test-private-detail",
    } as never);
    const read = await h.app.inject(`${h.root}/${h.f.jobId}/history`);
    expect(read.statusCode).toBe(503);
    uncached(read);
    expect(read.body).not.toContain("test-private-detail");
    expect(read.json().code).toBe("policy_evaluation_storage_unavailable");
  });
  it("creates one original immutable request/job and preserves it on an exact retry", async () => {
    const h = await harness();
    const first = await h.app.inject({ method: "POST", url: h.root, payload: h.input });
    expect(first.statusCode).toBe(201);
    uncached(first);
    const created = first.json();
    const second = await h.app.inject({ method: "POST", url: h.root, payload: h.input });
    expect(second.statusCode).toBe(200);
    uncached(second);
    expect(second.json().snapshot).toEqual(created.snapshot);
    const graph = created.snapshot as PolicyEvaluationJobSnapshot;
    expect(graph.job.status).toBe("queued");
    expect(graph.job.scope).toEqual(h.f.scope);
    expect(graph.request.createdByPrincipalId).toBe("principal_public_api");
    const read = await h.app.inject(`${h.root}/${graph.job.jobId}`);
    expect(read.statusCode).toBe(200);
    uncached(read);
    expect(ReadPolicyEvaluationJobResponseSchema.parse(read.json()).snapshot).toEqual(graph);
    const request = await h.app.inject(`${h.root}/${graph.job.jobId}/request`);
    expect(request.statusCode).toBe(200);
    uncached(request);
    expect(request.json().request).toEqual(graph.request);
  });
  it("reads all original pages and the immutable result without charging or publishing again", async () => {
    const h = await harness(),
      { result, sealed } = await h.complete();
    const job = `${h.root}/${h.f.jobId}`;
    const header = await h.app.inject(`${job}/snapshot`);
    expect(header.statusCode).toBe(200);
    uncached(header);
    expect(ReadPolicyEvaluationSnapshotResponseSchema.parse(header.json()).snapshot).toEqual(
      sealed.snapshot,
    );
    const query = new URLSearchParams({
      snapshotId: sealed.snapshot.snapshotId,
      definitionSha256: sealed.snapshot.definitionSha256,
    });
    for (const original of h.f.pageSet.pages) {
      const page = await h.app.inject(`${job}/snapshot/pages/${original.pageIndex}?${query}`);
      expect(page.statusCode).toBe(200);
      uncached(page);
      expect(ReadPolicyEvaluationSnapshotPageResponseSchema.parse(page.json()).page).toEqual(
        original,
      );
    }
    const read = await h.app.inject(`${job}/result`);
    expect(read.statusCode).toBe(200);
    uncached(read);
    expect(ReadPolicyEvaluationResponseSchema.parse(read.json()).evaluation).toEqual(
      result.evaluation,
    );
    expect(await h.store.findJob(h.f.scope, h.f.jobId)).toEqual(result.snapshot);
  });
  it("reads pages at an original history head after a later cancellation", async () => {
    const h = await harness();
    const created = await h.app.inject({ method: "POST", url: h.root, payload: h.input });
    const graph = created.json().snapshot as PolicyEvaluationJobSnapshot,
      job = `${h.root}/${graph.job.jobId}`;
    const headRead = await h.app.inject(`${job}/history`);
    expect(headRead.statusCode).toBe(200);
    uncached(headRead);
    const head = headRead.json().head;
    const original = await h.store.readHistoryPage(head, 0);
    const cancellation = await h.app.inject({
      method: "POST",
      url: `${job}/cancellation`,
      payload: { reason: "operator_requested" },
    });
    expect(cancellation.statusCode).toBe(200);
    uncached(cancellation);
    const repeated = await h.app.inject({
      method: "POST",
      url: `${job}/cancellation`,
      payload: { reason: "operator_requested" },
    });
    expect(repeated.statusCode).toBe(200);
    expect(repeated.json().snapshot).toEqual(cancellation.json().snapshot);
    const query = new URLSearchParams({
      jobDefinitionSha256: head.job.definitionSha256,
      sequence: String(head.sequence),
      entrySha256: head.entrySha256,
      graphSha256: head.graphSha256,
    });
    const page = await h.app.inject(`${job}/history/pages/0?${query}`);
    expect(page.statusCode).toBe(200);
    uncached(page);
    expect(page.json().page).toEqual(original);
    const changed = await h.app.inject({
      method: "POST",
      url: `${job}/cancellation`,
      payload: { reason: "incident_response" },
    });
    expect(changed.statusCode).toBe(409);
    uncached(changed);
  });
  it.each([-1, 0, 1])(
    "enforces actual UTF-8 request bytes at the boundary offset %s",
    async (offset) => {
      const h = await harness(),
        text = JSON.stringify(h.input);
      const payload =
        text + " ".repeat(MAX_POLICY_EVALUATION_REQUEST_BYTES - Buffer.byteLength(text) + offset);
      expect(Buffer.byteLength(payload)).toBe(MAX_POLICY_EVALUATION_REQUEST_BYTES + offset);
      const read = await h.app.inject({
        method: "POST",
        url: h.root,
        headers: { "content-type": "application/json" },
        payload,
      });
      expect(read.statusCode).toBe(offset > 0 ? 413 : 201);
      uncached(read);
    },
  );
  it.each(["bad JSON", "oversized", "caller worker"])(
    "authorizes before %s or any repository access",
    async (kind) => {
      const h = await harness();
      h.denyCapability();
      const create = vi.spyOn(h.store, "createJob");
      const payload =
        kind === "bad JSON"
          ? "{"
          : kind === "oversized"
            ? " ".repeat(MAX_POLICY_EVALUATION_REQUEST_BYTES + 1)
            : JSON.stringify({ workerId: "caller", result: {} });
      const read = await h.app.inject({
        method: "POST",
        url: h.root,
        headers: { "content-type": "application/json" },
        payload,
      });
      expect(read.statusCode).toBe(403);
      uncached(read);
      expect(create).not.toHaveBeenCalled();
    },
  );
  it("rejects authentication before malformed input and rejects a malformed authenticator as server failure", async () => {
    const h = await harness();
    h.denyAuthentication();
    const read = await h.app.inject({
      method: "POST",
      url: h.root,
      headers: { "content-type": "application/json" },
      payload: "{",
    });
    expect(read.statusCode).toBe(401);
    uncached(read);
    const other = await harness();
    other.setPrincipal({});
    const invalid = await other.app.inject(`${other.root}/job_absent`);
    expect(invalid.statusCode).toBe(500);
    uncached(invalid);
  });
  it("rejects caller-supplied job, scope, receipt, worker and computed result fields", async () => {
    const h = await harness();
    for (const extra of [
      { jobId: "caller" },
      { scope: h.f.scope },
      { createdAt: h.f.request.createdAt },
      { workerId: "caller" },
      { result: {} },
    ]) {
      const read = await h.app.inject({
        method: "POST",
        url: h.root,
        payload: { ...h.input, ...extra },
      });
      expect(read.statusCode).toBe(400);
      uncached(read);
    }
    expect(
      (await h.app.inject({ method: "POST", url: `${h.root}/job_absent/result`, payload: {} }))
        .statusCode,
    ).toBe(404);
  });
  it("returns exact scoped absence without exposing another tenant's job", async () => {
    const h = await harness();
    await h.seal();
    h.setPrincipal({
      principalId: "principal_other",
      principalType: "user",
      tenantId: "tenant_other",
      capabilities: ["policy:read"],
      roles: ["member"],
      authentication: { method: "development", authenticatedAt: h.f.request.createdAt },
      requestId: "request_other",
      resourceScope: {
        mode: "restricted",
        projects: [{ projectId: h.f.scope.projectId, environmentIds: [h.f.scope.environmentId] }],
      },
    });
    for (const suffix of ["", "/request", "/snapshot", "/result", "/history"]) {
      const read = await h.app.inject(`${h.root}/${h.f.jobId}${suffix}`);
      expect(read.statusCode).toBe(404);
      uncached(read);
    }
  });
  it("keeps pending snapshot/result absent and distinguishes stored corruption from bad input", async () => {
    const h = await harness();
    const created = await h.app.inject({ method: "POST", url: h.root, payload: h.input });
    const job = `${h.root}/${created.json().snapshot.job.jobId}`;
    for (const suffix of ["/snapshot", "/result"])
      expect((await h.app.inject(job + suffix)).statusCode).toBe(404);
    vi.spyOn(h.store, "findJob").mockResolvedValue({} as never);
    const corrupt = await h.app.inject(job);
    expect(corrupt.statusCode).toBe(503);
    uncached(corrupt);
    expect(corrupt.json().code).toBe("policy_evaluation_storage_unavailable");
  });
  it("rejects malformed or nondecimal page selectors and never substitutes another snapshot", async () => {
    const h = await harness(),
      { sealed } = await h.seal(),
      job = `${h.root}/${h.f.jobId}`;
    const query = new URLSearchParams({
      snapshotId: sealed.snapshot.snapshotId,
      definitionSha256: sealed.snapshot.definitionSha256,
    });
    for (const index of ["-1", "01", "0x0", "1.5", "9999"]) {
      const read = await h.app.inject(`${job}/snapshot/pages/${index}?${query}`);
      expect(read.statusCode).toBe(400);
      uncached(read);
    }
    const bad = await h.app.inject(
      `${job}/snapshot/pages/0?snapshotId=${sealed.snapshot.snapshotId}&definitionSha256=${"f".repeat(64)}`,
    );
    expect(bad.statusCode).toBe(404);
    uncached(bad);
    const extra = await h.app.inject(`${job}/snapshot?latest=true`);
    expect(extra.statusCode).toBe(400);
    uncached(extra);
  });
});
