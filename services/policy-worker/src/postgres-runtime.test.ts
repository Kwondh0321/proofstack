import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  PrincipalContextSchema,
  type PolicyEvaluationWorkerMutationFence,
} from "@proofstack/contracts";
import { policySnapshotRepositoryFixture } from "@proofstack/core/testing";
import {
  createPostgresPolicyInitialSources,
  PostgresPolicyEvaluationJobWorkerRepository,
  PostgresPolicySnapshotRepository,
  PostgresPolicyEvaluationResultRepository,
  PostgresPolicySnapshotTransactions,
} from "@proofstack/postgres";
import * as s3 from "@proofstack/s3";
import {
  createPostgresPolicyWorkerRuntime,
  createS3PolicyWorkerArtifacts,
  type PostgresPolicyWorkerRuntimeOptions,
} from "./postgres-runtime.js";

let f: ReturnType<typeof policySnapshotRepositoryFixture>;
beforeAll(() => {
  f = policySnapshotRepositoryFixture();
});
function setup() {
  const principal = PrincipalContextSchema.parse({
    principalType: "service",
    principalId: f.workerId,
    tenantId: f.scope.tenantId,
    authentication: {
      method: "service_token",
      credentialId: "credential_runtime",
      authenticatedAt: "2026-10-15T00:00:00.000Z",
    },
    capabilities: ["policy:evaluation:execute", "artifact:read"],
    resourceScope: {
      mode: "restricted",
      projects: [{ projectId: f.scope.projectId, environmentIds: [f.scope.environmentId] }],
    },
    roles: ["member"],
    requestId: "request_runtime",
  });
  const fence: PolicyEvaluationWorkerMutationFence = {
    jobId: f.jobId,
    workerId: f.workerId,
    attemptId: "attempt_runtime",
    leaseId: "lease_runtime",
    fencingToken: 1,
    recoveryEpoch: 0,
  };
  const end = vi.fn(async () => {});
  const connect = vi.fn(async () => {
    throw new Error("database_unavailable");
  });
  const pool = { end, connect } as never;
  const createPool = vi.fn(() => pool);
  const assertCurrent = vi.fn(async () => {});
  const resources = {
    reader: { get: vi.fn(async () => new Uint8Array([1])) },
    encryption: { decrypt: vi.fn(async () => new Uint8Array([2])) },
    close: vi.fn(async () => {}),
  };
  const openArtifacts = vi.fn(async () => resources);
  const initial = vi.fn(createPostgresPolicyInitialSources);
  const receipt = { deliberatelyOnlyACompositionStub: true } as never;
  const seal = vi.fn(async () => receipt);
  const options: PostgresPolicyWorkerRuntimeOptions = {
    databaseUrl: "postgresql://proofstack_policy_evaluator@127.0.0.1/proofstack_test",
    allowPlaintextLoopback: true,
    onIdleError: vi.fn(),
    openArtifacts,
    nextId: vi.fn((kind) => `runtime_${kind}`),
  };
  const input = { scope: structuredClone(f.scope), principal };
  const dependencies = { createPool, assertCurrent, createInitialSources: initial, seal };
  const open = () => createPostgresPolicyWorkerRuntime(input, options, dependencies);
  const command = { principal, request: f.request, fence };
  return {
    input,
    options,
    dependencies,
    open,
    command,
    principal,
    fence,
    pool,
    createPool,
    assertCurrent,
    connect,
    end,
    resources,
    openArtifacts,
    initial,
    seal,
    receipt,
  };
}

describe("actual native policy runtime composition", () => {
  it("retains admitted authority ports for capture and held reinspection despite later option mutation", async () => {
    const h = setup();
    const revision = { isAvailable: vi.fn(async () => true) };
    const referenceRuntime = { isAvailable: vi.fn(async () => false) };
    const authorities = { revision, runtime: referenceRuntime };
    Object.assign(h.options, { candidateAuthorities: authorities });
    const runtime = await h.open();
    authorities.revision = { isAvailable: vi.fn(async () => false) };
    await runtime.seal(h.command);
    const calls = h.seal.mock.calls as unknown as Parameters<
      typeof import("@proofstack/policy-evaluation").sealPolicyEvaluationSnapshot
    >[];
    const dependency = calls[0]![4];
    expect(dependency.candidateAuthorities).toEqual({ revision, runtime: referenceRuntime });
    expect(dependency.candidateAuthorities).not.toBe(authorities);
    expect(Object.isFrozen(dependency.candidateAuthorities)).toBe(true);
    await runtime.close();
  });
  it("uses only the dedicated native pool and owning repositories after readiness", async () => {
    const h = setup();
    const runtime = await h.open();
    expect(h.createPool).toHaveBeenCalledWith({
      applicationName: "proofstack-policy-worker",
      connectionString: h.options.databaseUrl,
      connectionTimeoutMilliseconds: 500,
      maxConnections: 4,
      onIdleError: h.options.onIdleError,
    });
    expect(h.assertCurrent).toHaveBeenCalledWith(h.pool);
    expect(h.openArtifacts).toHaveBeenCalledAfter(h.assertCurrent);
    expect(runtime.worker).toBeInstanceOf(PostgresPolicyEvaluationJobWorkerRepository);
    expect(runtime.snapshots).toBeInstanceOf(PostgresPolicySnapshotRepository);
    expect(runtime.results).toBeInstanceOf(PostgresPolicyEvaluationResultRepository);
    expect(Object.keys(runtime).sort()).toEqual([
      "close",
      "results",
      "seal",
      "snapshots",
      "worker",
    ]);
    await runtime.close();
    await runtime.close();
    expect(h.end).toHaveBeenCalledOnce();
    expect(h.resources.close).toHaveBeenCalledOnce();
  });
  it.each(["capability", "method", "tenant", "environment"])(
    "authorizes %s before resource construction",
    async (kind) => {
      const h = setup();
      if (kind === "capability") h.principal.capabilities = [];
      if (kind === "method") h.principal.authentication.method = "api_key";
      if (kind === "tenant") h.input.scope.tenantId = "tenant_other";
      if (kind === "environment") h.input.scope.environmentId = "environment_other";
      await expect(h.open()).rejects.toThrow();
      expect(h.createPool).not.toHaveBeenCalled();
      expect(h.openArtifacts).not.toHaveBeenCalled();
    },
  );
  it.each([
    { databaseRole: "invalid-role" },
    { databaseUrl: " postgresql://proofstack_policy_evaluator@127.0.0.1/proofstack_test" },
    { databaseUrl: "postgresql://api@127.0.0.1/proofstack_test" },
    { databaseUrl: "postgresql://%ZZ@127.0.0.1/proofstack_test" },
    { databaseUrl: "postgresql://proofstack_policy_evaluator@remote.invalid/proofstack_test" },
    { allowPlaintextLoopback: false },
  ])(
    "refuses invalid dedicated-role/transport configuration %# before opening resources",
    async (changes) => {
      const h = setup();
      Object.assign(h.options, changes);
      await expect(h.open()).rejects.toThrow();
      expect(h.createPool).not.toHaveBeenCalled();
    },
  );
  it("accepts an explicitly installed dedicated role over verified TLS", async () => {
    const h = setup();
    Object.assign(h.options, {
      databaseRole: "custom_policy_worker",
      databaseUrl:
        "postgresql://custom_policy_worker@db.invalid/proofstack_test?sslmode=verify-full",
      allowPlaintextLoopback: undefined,
    });
    const runtime = await h.open();
    await runtime.close();
  });
  it("installs one shared fresh acquisition nonce, final transactions and mandatory bounded artifact admission", async () => {
    const h = setup();
    const runtime = await h.open();
    expect(await runtime.seal(h.command)).toBe(h.receipt);
    const call = h.seal.mock.calls[0] as unknown as Parameters<
      typeof import("@proofstack/policy-evaluation").sealPolicyEvaluationSnapshot
    >;
    expect(h.initial).toHaveBeenCalledWith(
      h.pool,
      { scope: f.scope, fence: h.fence, allowanceId: "runtime_allowance" },
      {},
    );
    expect(call[0]).toEqual(f.request);
    expect(call[1]).toEqual(h.principal);
    expect(call[4].encryption).toBe(h.resources.encryption);
    expect(call[5].transactions).toBeInstanceOf(PostgresPolicySnapshotTransactions);
    expect(call[5]).toMatchObject({
      fence: h.fence,
      manifestId: "runtime_manifest",
      snapshotId: "runtime_snapshot",
      acquisitionAdmission: { allowanceId: "runtime_allowance" },
      artifactByteAdmission: { repository: runtime.worker, objectReader: h.resources.reader },
    });
    expect(call[5].artifactByteAdmission!.nextReservationId()).toBe("runtime_artifact_reservation");
    await expect(call[4].objects.get("forbidden")).rejects.toThrow("unreserved");
    await runtime.close();
  });
  it("copies installed catalogues and principal before asynchronous startup", async () => {
    const h = setup();
    const catalogue = { protocolDefinitions: [] as unknown[] };
    Object.assign(h.options, { catalogues: catalogue });
    const opening = h.open();
    catalogue.protocolDefinitions.push({ invalid: true });
    h.principal.capabilities.push("identity:manage");
    const runtime = await opening;
    const actor = {
      ...h.principal,
      capabilities: ["policy:evaluation:execute", "artifact:read"],
    } as typeof h.principal;
    await runtime.seal({ ...h.command, principal: actor });
    expect(h.initial.mock.calls[0]![2]).toEqual({ protocolDefinitions: [] });
    await runtime.close();
  });
  it.each(["actor", "scope", "worker"])(
    "rejects substituted seal %s before source or content work",
    async (kind) => {
      const h = setup();
      const runtime = await h.open();
      const command = structuredClone(h.command);
      if (kind === "actor") command.principal.requestId = "different_actor_receipt";
      if (kind === "scope") command.request.scope.tenantId = "tenant_other";
      if (kind === "worker") command.fence.workerId = "worker_other";
      expect(() => runtime.seal(command)).toThrow();
      expect(h.initial).not.toHaveBeenCalled();
      expect(h.seal).not.toHaveBeenCalled();
      await runtime.close();
    },
  );
  it("generates secure internal identities when no test ID source is installed", async () => {
    const h = setup();
    Object.assign(h.options, { nextId: undefined });
    const runtime = await h.open();
    await runtime.seal(h.command);
    await runtime.seal(h.command);
    const calls = h.seal.mock.calls as unknown as Parameters<
      typeof import("@proofstack/policy-evaluation").sealPolicyEvaluationSnapshot
    >[];
    const first = calls[0]![5],
      second = calls[1]![5];
    expect(first.manifestId).toMatch(/^policy_manifest_[0-9a-f]{32}$/);
    expect(first.snapshotId).not.toBe(second.snapshotId);
    expect(first.acquisitionAdmission!.allowanceId).not.toBe(
      second.acquisitionAdmission!.allowanceId,
    );
    await runtime.close();
  });
  it("closes the pool without opening artifacts after migration failure", async () => {
    const h = setup(),
      failure = new Error("migration_incomplete");
    h.assertCurrent.mockRejectedValue(failure);
    await expect(h.open()).rejects.toBe(failure);
    expect(h.openArtifacts).not.toHaveBeenCalled();
    expect(h.end).toHaveBeenCalledOnce();
  });
  it("closes the pool when artifact resource creation fails", async () => {
    const h = setup(),
      failure = new Error("key_provider_unavailable");
    h.openArtifacts.mockRejectedValue(failure);
    await expect(h.open()).rejects.toBe(failure);
    expect(h.end).toHaveBeenCalledOnce();
  });
  it("preserves initialization and cleanup failures", async () => {
    const h = setup(),
      failure = new Error("migration"),
      cleanup = new Error("pool_cleanup");
    h.assertCurrent.mockRejectedValue(failure);
    h.end.mockRejectedValue(cleanup);
    const error = await h.open().catch((error) => error);
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.errors[0]).toBe(failure);
    expect(error.errors[1].errors).toEqual([cleanup]);
  });
  it("drains both cleanups, including a synchronous artifact failure, and preserves both errors", async () => {
    const h = setup();
    const runtime = await h.open();
    const a = new Error("artifact_cleanup"),
      b = new Error("pool_cleanup");
    h.resources.close.mockImplementation(() => {
      throw a;
    });
    h.end.mockRejectedValue(b);
    const first = runtime.close(),
      second = runtime.close();
    expect(first).toBe(second);
    const error = await first.catch((error) => error);
    expect(error.errors).toEqual([a, b]);
    expect(h.resources.close).toHaveBeenCalledOnce();
    expect(h.end).toHaveBeenCalledOnce();
    expect(() => runtime.seal(h.command)).toThrow("closed");
  });
  it.each(["resolve", "reject"])(
    "drains an already-started seal before cleanup on %s",
    async (kind) => {
      const h = setup();
      let resolve!: (value: never) => void, reject!: (reason: Error) => void;
      h.seal.mockImplementation(
        () =>
          new Promise((yes, no) => {
            resolve = yes;
            reject = no;
          }),
      );
      const runtime = await h.open(),
        operation = runtime.seal(h.command);
      const observed = operation.catch((error) => error),
        closing = runtime.close();
      await Promise.resolve();
      expect(h.resources.close).not.toHaveBeenCalled();
      expect(() => runtime.seal(h.command)).toThrow("closed");
      const failure = new Error("capture_failed");
      if (kind === "resolve") resolve(h.receipt);
      else reject(failure);
      expect(await observed).toBe(kind === "resolve" ? h.receipt : failure);
      await closing;
      expect(h.end).toHaveBeenCalledOnce();
      expect(h.resources.close).toHaveBeenCalledOnce();
    },
  );
  it("uses the real sealing composition by default and closes after source admission failure", async () => {
    const h = setup();
    const runtime = await createPostgresPolicyWorkerRuntime(h.input, h.options, {
      createPool: h.createPool,
      assertCurrent: h.assertCurrent,
    });
    await expect(runtime.seal(h.command)).rejects.toThrow();
    await runtime.close();
    expect(h.end).toHaveBeenCalledOnce();
  });
  it("creates only a bounded S3 reader and forwards exact byte/abort constraints", async () => {
    const get = vi.fn(async () => new Uint8Array([9])),
      destroy = vi.fn();
    const create = vi.spyOn(s3, "createS3BoundedArtifactReader").mockReturnValue({ get, destroy });
    try {
      const h = setup(),
        options = { bucket: "policy-runtime-fixture", region: "us-east-1" };
      const resources = createS3PolicyWorkerArtifacts(options, h.resources.encryption);
      const bound = { expectedBytes: 1, signal: new AbortController().signal };
      expect(await resources.reader.get("test-object", bound)).toEqual(new Uint8Array([9]));
      expect(create).toHaveBeenCalledWith(options);
      expect(get).toHaveBeenCalledWith("test-object", bound);
      expect(Object.keys(resources).sort()).toEqual(["close", "encryption", "reader"]);
      await resources.close();
      expect(destroy).toHaveBeenCalledOnce();
    } finally {
      create.mockRestore();
    }
  });
});
