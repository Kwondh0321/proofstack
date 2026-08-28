import {
  type PrincipalContext,
  PrincipalContextSchema,
  type ResourceScope,
} from "@proofstack/contracts";
import { ForbiddenError } from "@proofstack/core";
import { describe, expect, it, vi } from "vitest";
import { type ApiKeyPasswordHash, generateApiKey } from "./api-key.js";
import {
  ApiKeyCredentialConflictError,
  ApiKeyCredentialNotActiveError,
  ApiKeyCredentialNotFoundError,
  type ApiKeyCredentialStore,
  ApiKeyGenerationError,
  ApiKeyLifecycle,
  type ApiKeyLifecycleDependencies,
  type CreateApiKeyCredential,
  type ManagedApiKeyCredential,
  type RotateApiKeyCredential,
} from "./api-key-lifecycle.js";

const NOW = new Date("2026-08-28T08:00:00.000Z");
const CREATED_AT = "2026-08-28T08:00:01.000Z";
const HASH: ApiKeyPasswordHash = {
  algorithm: "scrypt-v1",
  blockSize: 8,
  cost: 32_768,
  digest: "A".repeat(43),
  keyLength: 32,
  parallelization: 1,
  salt: "B".repeat(22),
};

function bytes(value: number): (size: number) => Uint8Array {
  return (size) => new Uint8Array(size).fill(value);
}

function issuer(overrides: Partial<PrincipalContext> = {}): PrincipalContext {
  return PrincipalContextSchema.parse({
    authentication: {
      authenticatedAt: NOW.toISOString(),
      credentialId: "ses_identity_manager",
      method: "oidc",
    },
    capabilities: ["identity:manage", "evidence:ingest", "evidence:read"],
    principalId: "usr_identity_manager",
    principalType: "user",
    requestId: "req_identity_manager",
    resourceScope: { mode: "tenant" },
    roles: ["admin"],
    tenantId: "ten_identity",
    ...overrides,
  });
}

function managed(input: CreateApiKeyCredential, revokedAt: string | null = null) {
  return {
    capabilities: input.capabilities,
    createdAt: CREATED_AT,
    credentialId: input.credentialId,
    expiresAt: input.expiresAt,
    name: input.name,
    prefix: input.prefix,
    principalId: input.principalId,
    resourceScope: input.resourceScope,
    revokedAt,
    rotatedFromCredentialId: input.rotatedFromCredentialId,
    tenantId: input.tenantId,
  } satisfies ManagedApiKeyCredential;
}

class MemoryStore implements ApiKeyCredentialStore {
  readonly records = new Map<string, ManagedApiKeyCredential>();
  readonly createInputs: CreateApiKeyCredential[] = [];
  readonly findInputs: Array<{ readonly credentialId: string; readonly tenantId: string }> = [];
  readonly rotateInputs: RotateApiKeyCredential[] = [];
  readonly revokeInputs: Array<{
    readonly actorPrincipalId: string;
    readonly credentialId: string;
    readonly reason: string;
    readonly tenantId: string;
  }> = [];
  createConflicts = 0;
  createError?: Error;
  rotateConflicts = 0;
  rotateError?: Error;

  async create(input: CreateApiKeyCredential) {
    this.createInputs.push(input);
    if (this.createError) throw this.createError;
    if (this.createConflicts > 0) {
      this.createConflicts -= 1;
      throw new ApiKeyCredentialConflictError();
    }
    this.records.set(input.credentialId, managed(input));
    return { createdAt: CREATED_AT };
  }

  async findById(tenantId: string, credentialId: string) {
    this.findInputs.push({ credentialId, tenantId });
    const record = this.records.get(credentialId);
    return record?.tenantId === tenantId ? record : null;
  }

  async revoke(tenantId: string, credentialId: string, actorPrincipalId: string, reason: string) {
    this.revokeInputs.push({ actorPrincipalId, credentialId, reason, tenantId });
    const record = await this.findById(tenantId, credentialId);
    if (!record || record.revokedAt) return false;
    this.records.set(credentialId, { ...record, revokedAt: CREATED_AT });
    return true;
  }

  async rotate(input: RotateApiKeyCredential) {
    this.rotateInputs.push(input);
    if (this.rotateError) throw this.rotateError;
    if (this.rotateConflicts > 0) {
      this.rotateConflicts -= 1;
      throw new ApiKeyCredentialConflictError();
    }
    const previous = this.records.get(input.previousCredentialId);
    if (!previous || previous.revokedAt) {
      throw new ApiKeyCredentialNotActiveError(input.previousCredentialId);
    }
    this.records.set(previous.credentialId, { ...previous, revokedAt: CREATED_AT });
    this.records.set(input.credential.credentialId, managed(input.credential));
    return { createdAt: CREATED_AT };
  }
}

function dependencies(): ApiKeyLifecycleDependencies & {
  readonly hashSecret: ReturnType<typeof vi.fn>;
} {
  let credentialSequence = 0;
  let keySequence = 20;
  let workloadSequence = 0;
  return {
    clock: { now: () => new Date(NOW) },
    generateId: (kind) => {
      if (kind === "credential") {
        credentialSequence += 1;
        return `key_generated_${credentialSequence}`;
      }
      workloadSequence += 1;
      return `wrk_generated_${workloadSequence}`;
    },
    generateKey: () => {
      keySequence += 1;
      return generateApiKey(bytes(keySequence));
    },
    hashSecret: vi.fn(async () => HASH),
  };
}

const tenantScope: ResourceScope = { mode: "tenant" };

async function issuedFixture(
  store: MemoryStore,
  customDependencies = dependencies(),
): Promise<{
  readonly dependencies: ApiKeyLifecycleDependencies;
  readonly lifecycle: ApiKeyLifecycle;
  readonly record: ManagedApiKeyCredential;
}> {
  const lifecycle = new ApiKeyLifecycle(store, customDependencies);
  const issued = await lifecycle.issue({
    capabilities: ["evidence:ingest"],
    issuer: issuer(),
    name: "production agent",
    resourceScope: tenantScope,
  });
  return { dependencies: customDependencies, lifecycle, record: issued.credential };
}

describe("ApiKeyLifecycle.issue", () => {
  it("issues one time-bounded credential without returning its stored hash", async () => {
    const store = new MemoryStore();
    const injected = dependencies();
    const result = await new ApiKeyLifecycle(store, injected).issue({
      capabilities: ["evidence:ingest", "evidence:read"],
      issuer: issuer(),
      name: "운영 에이전트",
      resourceScope: {
        mode: "restricted",
        projects: [{ environmentIds: ["env_prod"], projectId: "prj_agent" }],
      },
    });

    expect(result.value).toMatch(/^psk_v1_/);
    expect(result.credential).toEqual({
      capabilities: ["evidence:ingest", "evidence:read"],
      createdAt: CREATED_AT,
      credentialId: "key_generated_1",
      expiresAt: new Date(NOW.getTime() + 90 * 24 * 60 * 60 * 1_000).toISOString(),
      name: "운영 에이전트",
      prefix: expect.any(String),
      principalId: "wrk_generated_1",
      resourceScope: {
        mode: "restricted",
        projects: [{ environmentIds: ["env_prod"], projectId: "prj_agent" }],
      },
      revokedAt: null,
      rotatedFromCredentialId: null,
      tenantId: "ten_identity",
    });
    expect(result.credential).not.toHaveProperty("passwordHash");
    expect(result.credential).not.toHaveProperty("actorPrincipalId");
    expect(store.createInputs[0]).toMatchObject({
      actorPrincipalId: "usr_identity_manager",
      passwordHash: HASH,
    });
    expect(injected.hashSecret).toHaveBeenCalledTimes(1);
  });

  it("normalizes an explicit offset expiration to UTC", async () => {
    const result = await new ApiKeyLifecycle(new MemoryStore(), dependencies()).issue({
      capabilities: ["evidence:ingest"],
      expiresAt: "2026-08-29T17:00:00+09:00",
      issuer: issuer(),
      name: "offset expiration",
      resourceScope: tenantScope,
    });
    expect(result.credential.expiresAt).toBe("2026-08-29T08:00:00.000Z");
  });

  it.each(["", " leading", "trailing ", "bad\nname", "x".repeat(129)])(
    "rejects invalid name %j",
    async (name) => {
      await expect(
        new ApiKeyLifecycle(new MemoryStore(), dependencies()).issue({
          capabilities: ["evidence:ingest"],
          issuer: issuer(),
          name,
          resourceScope: tenantScope,
        }),
      ).rejects.toBeInstanceOf(TypeError);
    },
  );

  it.each([
    "not-a-time",
    new Date(NOW.getTime() + 59_999).toISOString(),
    new Date(NOW.getTime() + 365 * 24 * 60 * 60 * 1_000 + 1).toISOString(),
  ])("rejects invalid expiration %s", async (expiresAt) => {
    await expect(
      new ApiKeyLifecycle(new MemoryStore(), dependencies()).issue({
        capabilities: ["evidence:ingest"],
        expiresAt,
        issuer: issuer(),
        name: "invalid expiration",
        resourceScope: tenantScope,
      }),
    ).rejects.toBeInstanceOf(Error);
  });

  it("enforces issuer capability and scope bounds", async () => {
    const lifecycle = new ApiKeyLifecycle(new MemoryStore(), dependencies());
    await expect(
      lifecycle.issue({
        capabilities: ["evaluation:run"],
        issuer: issuer(),
        name: "excess capability",
        resourceScope: tenantScope,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("retries generated identity conflicts but preserves one workload principal", async () => {
    const store = new MemoryStore();
    store.createConflicts = 2;
    const result = await new ApiKeyLifecycle(store, dependencies()).issue({
      capabilities: ["evidence:ingest"],
      issuer: issuer(),
      name: "collision recovery",
      resourceScope: tenantScope,
    });

    expect(store.createInputs).toHaveLength(3);
    expect(new Set(store.createInputs.map(({ credentialId }) => credentialId)).size).toBe(3);
    expect(new Set(store.createInputs.map(({ principalId }) => principalId))).toEqual(
      new Set([result.credential.principalId]),
    );
  });

  it("fails closed after bounded collision retries", async () => {
    const store = new MemoryStore();
    store.createConflicts = 3;
    await expect(
      new ApiKeyLifecycle(store, dependencies()).issue({
        capabilities: ["evidence:ingest"],
        issuer: issuer(),
        name: "collision exhaustion",
        resourceScope: tenantScope,
      }),
    ).rejects.toBeInstanceOf(ApiKeyGenerationError);
    expect(store.createInputs).toHaveLength(3);
  });

  it("rejects invalid generated identifiers and preserves store failures", async () => {
    const invalidWorkload = { ...dependencies(), generateId: () => "INVALID" };
    await expect(
      new ApiKeyLifecycle(new MemoryStore(), invalidWorkload).issue({
        capabilities: ["evidence:ingest"],
        issuer: issuer(),
        name: "invalid generator",
        resourceScope: tenantScope,
      }),
    ).rejects.toBeInstanceOf(ApiKeyGenerationError);

    const invalidCredential = {
      ...dependencies(),
      generateId: (kind: "credential" | "workload") =>
        kind === "workload" ? "wrk_valid" : "INVALID",
    };
    await expect(
      new ApiKeyLifecycle(new MemoryStore(), invalidCredential).issue({
        capabilities: ["evidence:ingest"],
        issuer: issuer(),
        name: "invalid generator",
        resourceScope: tenantScope,
      }),
    ).rejects.toBeInstanceOf(ApiKeyGenerationError);

    const store = new MemoryStore();
    const unavailable = new Error("store unavailable");
    store.createError = unavailable;
    await expect(
      new ApiKeyLifecycle(store, dependencies()).issue({
        capabilities: ["evidence:ingest"],
        issuer: issuer(),
        name: "store failure",
        resourceScope: tenantScope,
      }),
    ).rejects.toBe(unavailable);
  });

  it("can use production randomness, IDs, hashing, and clock defaults", async () => {
    const result = await new ApiKeyLifecycle(new MemoryStore()).issue({
      capabilities: ["evidence:ingest"],
      issuer: issuer(),
      name: "default dependencies",
      resourceScope: tenantScope,
    });
    expect(result.credential.credentialId).toMatch(/^key_[0-9a-f]{32}$/);
    expect(result.credential.principalId).toMatch(/^wrk_[0-9a-f]{32}$/);
  });
});

describe("ApiKeyLifecycle.rotate", () => {
  it("preserves authorization and atomically replaces credential identity", async () => {
    const store = new MemoryStore();
    const { lifecycle, record } = await issuedFixture(store);
    const result = await lifecycle.rotate({ credentialId: record.credentialId, issuer: issuer() });

    expect(result.credential).toMatchObject({
      capabilities: record.capabilities,
      name: record.name,
      principalId: record.principalId,
      resourceScope: record.resourceScope,
      rotatedFromCredentialId: record.credentialId,
      tenantId: record.tenantId,
    });
    expect(result.credential.credentialId).not.toBe(record.credentialId);
    expect(result.credential.prefix).not.toBe(record.prefix);
    expect(store.records.get(record.credentialId)?.revokedAt).toBe(CREATED_AT);
    expect(store.rotateInputs).toHaveLength(1);
  });

  it("rejects missing, revoked, and expired credentials", async () => {
    const store = new MemoryStore();
    const lifecycle = new ApiKeyLifecycle(store, dependencies());
    await expect(
      lifecycle.rotate({ credentialId: "key_missing", issuer: issuer() }),
    ).rejects.toBeInstanceOf(ApiKeyCredentialNotFoundError);

    const fixture = await issuedFixture(store);
    store.records.set(fixture.record.credentialId, {
      ...fixture.record,
      revokedAt: CREATED_AT,
    });
    await expect(
      fixture.lifecycle.rotate({ credentialId: fixture.record.credentialId, issuer: issuer() }),
    ).rejects.toBeInstanceOf(ApiKeyCredentialNotActiveError);

    store.records.set(fixture.record.credentialId, {
      ...fixture.record,
      expiresAt: NOW.toISOString(),
      revokedAt: null,
    });
    await expect(
      fixture.lifecycle.rotate({ credentialId: fixture.record.credentialId, issuer: issuer() }),
    ).rejects.toBeInstanceOf(ApiKeyCredentialNotActiveError);
  });

  it("rechecks delegation and bounds collision retries", async () => {
    const store = new MemoryStore();
    const fixture = await issuedFixture(store);
    await expect(
      fixture.lifecycle.rotate({
        credentialId: fixture.record.credentialId,
        issuer: issuer({ capabilities: ["evidence:ingest"] }),
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(store.findInputs).toHaveLength(0);

    await expect(
      fixture.lifecycle.rotate({
        credentialId: fixture.record.credentialId,
        issuer: issuer({ capabilities: ["identity:manage"] }),
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(store.findInputs).toHaveLength(1);

    store.rotateConflicts = 3;
    await expect(
      fixture.lifecycle.rotate({ credentialId: fixture.record.credentialId, issuer: issuer() }),
    ).rejects.toBeInstanceOf(ApiKeyGenerationError);
    expect(store.rotateInputs).toHaveLength(3);
  });

  it("preserves unexpected rotation failures", async () => {
    const store = new MemoryStore();
    const fixture = await issuedFixture(store);
    const unavailable = new Error("rotation unavailable");
    store.rotateError = unavailable;
    await expect(
      fixture.lifecycle.rotate({ credentialId: fixture.record.credentialId, issuer: issuer() }),
    ).rejects.toBe(unavailable);
  });
});

describe("ApiKeyLifecycle.revoke", () => {
  it("records an attributed reason and is idempotent at the store boundary", async () => {
    const store = new MemoryStore();
    const { lifecycle, record } = await issuedFixture(store);

    await expect(
      lifecycle.revoke({
        credentialId: record.credentialId,
        issuer: issuer(),
        reason: "workload retired",
      }),
    ).resolves.toBe(true);
    await expect(
      lifecycle.revoke({
        credentialId: record.credentialId,
        issuer: issuer(),
        reason: "already retired",
      }),
    ).resolves.toBe(false);
    expect(store.revokeInputs[0]).toEqual({
      actorPrincipalId: "usr_identity_manager",
      credentialId: record.credentialId,
      reason: "workload retired",
      tenantId: "ten_identity",
    });
  });

  it("rejects unknown IDs, malformed IDs, and malformed reasons", async () => {
    const lifecycle = new ApiKeyLifecycle(new MemoryStore(), dependencies());
    await expect(
      lifecycle.revoke({ credentialId: "key_missing", issuer: issuer(), reason: "missing" }),
    ).rejects.toBeInstanceOf(ApiKeyCredentialNotFoundError);
    await expect(
      lifecycle.revoke({ credentialId: "INVALID", issuer: issuer(), reason: "invalid" }),
    ).rejects.toBeInstanceOf(TypeError);

    const store = new MemoryStore();
    const fixture = await issuedFixture(store);
    for (const reason of ["", " padded ", "bad\nreason", "x".repeat(513)]) {
      await expect(
        fixture.lifecycle.revoke({
          credentialId: fixture.record.credentialId,
          issuer: issuer(),
          reason,
        }),
      ).rejects.toBeInstanceOf(TypeError);
    }
  });

  it("requires a user manager whose scope contains the credential", async () => {
    const store = new MemoryStore();
    const { lifecycle, record } = await issuedFixture(store);
    await expect(
      lifecycle.revoke({
        credentialId: record.credentialId,
        issuer: issuer({ capabilities: ["evidence:ingest"] }),
        reason: "unauthorized",
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(store.findInputs).toHaveLength(0);
    await expect(
      lifecycle.revoke({
        credentialId: record.credentialId,
        issuer: issuer({ principalType: "service" }),
        reason: "unauthorized",
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(store.findInputs).toHaveLength(0);
    await expect(
      lifecycle.revoke({
        credentialId: record.credentialId,
        issuer: issuer({
          resourceScope: {
            mode: "restricted",
            projects: [{ projectId: "prj_other" }],
          },
        }),
        reason: "outside scope",
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});
