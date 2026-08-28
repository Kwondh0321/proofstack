import type {
  ApiKeyPasswordHash,
  CreateApiKeyCredential,
  RotateApiKeyCredential,
} from "@proofstack/identity";
import {
  ApiKeyCredentialConflictError,
  ApiKeyCredentialNotActiveError,
  ApiKeyCredentialNotFoundError,
} from "@proofstack/identity";
import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import {
  PostgresApiKeyCredentialRepository,
  PostgresIdentityDataIntegrityError,
} from "./postgres-api-key-credential-repository.js";

const CREATED_AT = new Date("2026-08-28T08:00:00.000Z");
const EXPIRES_AT = "2026-08-29T08:00:00.000Z";
const PREFIX_A = ["AbCd", "Ef12", "3_-", "a"].join("");
const PREFIX_B = ["AbCd", "Ef12", "3_-", "b"].join("");
const PREFIX_Z = ["AbCd", "Ef12", "3_-", "z"].join("");
const HASH: ApiKeyPasswordHash = {
  algorithm: "scrypt-v1",
  blockSize: 8,
  cost: 32_768,
  digest: "A".repeat(43),
  keyLength: 32,
  parallelization: 1,
  salt: "B".repeat(22),
};

type QueryHandler = (
  text: string,
  values: readonly unknown[] | undefined,
) => Promise<{ readonly rows: readonly Record<string, unknown>[] }>;

class FakePool {
  readonly queries: Array<{
    readonly source: "client" | "pool";
    readonly text: string;
    readonly values?: readonly unknown[];
  }> = [];
  readonly releaseArguments: Array<boolean | undefined> = [];

  constructor(private readonly handler: QueryHandler) {}

  readonly client = {
    query: async (text: string, values?: readonly unknown[]) => {
      this.queries.push({ source: "client", text, ...(values ? { values } : {}) });
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(text) || text.includes("set_config")) {
        return { rows: [] };
      }
      return this.handler(text, values);
    },
    release: (argument?: boolean) => this.releaseArguments.push(argument),
  };

  async connect() {
    return this.client;
  }

  async query(text: string, values?: readonly unknown[]) {
    this.queries.push({ source: "pool", text, ...(values ? { values } : {}) });
    return this.handler(text, values);
  }
}

function repository(handler: QueryHandler): {
  readonly pool: FakePool;
  readonly repository: PostgresApiKeyCredentialRepository;
} {
  const pool = new FakePool(handler);
  return {
    pool,
    repository: new PostgresApiKeyCredentialRepository(pool as unknown as Pool),
  };
}

function activeRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    authenticated_at: CREATED_AT,
    capabilities: ["evidence:ingest", "evidence:read"],
    credential_id: "key_repository",
    hash_algorithm: HASH.algorithm,
    hash_block_size: HASH.blockSize,
    hash_cost: HASH.cost,
    hash_digest: HASH.digest,
    hash_key_length: HASH.keyLength,
    hash_parallelization: HASH.parallelization,
    hash_salt: HASH.salt,
    key_prefix: PREFIX_A,
    principal_id: "wrk_repository",
    resource_scope: { mode: "tenant" },
    tenant_id: "ten_repository",
    ...overrides,
  };
}

function managedRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    capabilities: ["evidence:ingest"],
    created_at: CREATED_AT,
    credential_id: "key_repository",
    display_name: "repository agent",
    expires_at: new Date(EXPIRES_AT),
    key_prefix: PREFIX_A,
    principal_id: "wrk_repository",
    resource_scope: { mode: "tenant" },
    revoked_at: null,
    rotated_from_credential_id: null,
    tenant_id: "ten_repository",
    ...overrides,
  };
}

function createInput(overrides: Partial<CreateApiKeyCredential> = {}): CreateApiKeyCredential {
  return {
    actorPrincipalId: "usr_repository_admin",
    capabilities: ["evidence:ingest"],
    credentialId: "key_repository",
    expiresAt: EXPIRES_AT,
    name: "repository agent",
    passwordHash: HASH,
    prefix: PREFIX_A,
    principalId: "wrk_repository",
    resourceScope: { mode: "tenant" },
    rotatedFromCredentialId: null,
    tenantId: "ten_repository",
    ...overrides,
  };
}

function databaseError(
  code: string,
  message = "database error",
): Error & { readonly code: string } {
  return Object.assign(new Error(message), { code });
}

describe("PostgresApiKeyCredentialRepository authentication", () => {
  it("validates an exact active credential returned by PostgreSQL", async () => {
    const harness = repository(async () => ({ rows: [activeRow()] }));

    await expect(harness.repository.findActiveByPrefix(PREFIX_A)).resolves.toEqual({
      authenticatedAt: CREATED_AT.toISOString(),
      capabilities: ["evidence:ingest", "evidence:read"],
      credentialId: "key_repository",
      passwordHash: HASH,
      prefix: PREFIX_A,
      principalId: "wrk_repository",
      resourceScope: { mode: "tenant" },
      tenantId: "ten_repository",
    });
    expect(harness.pool.queries[0]).toMatchObject({
      source: "pool",
      values: [PREFIX_A],
    });
  });

  it("returns null for an unknown prefix", async () => {
    const harness = repository(async () => ({ rows: [] }));
    await expect(harness.repository.findActiveByPrefix(PREFIX_Z)).resolves.toBeNull();
  });

  it.each([
    ["duplicate lookup rows", [activeRow(), activeRow()]],
    ["invalid capabilities", [activeRow({ capabilities: ["identity:manage"] })]],
    ["duplicate capabilities", [activeRow({ capabilities: ["evidence:read", "evidence:read"] })]],
    ["empty capabilities", [activeRow({ capabilities: [] })]],
    ["invalid hash profile", [activeRow({ hash_cost: 1 })]],
    ["invalid prefix", [activeRow({ key_prefix: "invalid" })]],
    ["invalid timestamp", [activeRow({ authenticated_at: new Date(Number.NaN) })]],
    ["invalid scope", [activeRow({ resource_scope: { mode: "unknown" } })]],
  ])("fails closed for %s", async (_label, rows) => {
    const harness = repository(async () => ({ rows }));
    await expect(harness.repository.findActiveByPrefix(PREFIX_A)).rejects.toBeInstanceOf(
      PostgresIdentityDataIntegrityError,
    );
  });

  it("confirms active use and rejects malformed database results", async () => {
    const accepted = repository(async () => ({ rows: [{ result: true }] }));
    await expect(
      accepted.repository.confirmActiveUse({
        credentialId: "key_repository",
        prefix: PREFIX_A,
        tenantId: "ten_repository",
      }),
    ).resolves.toBe(true);

    const malformed = repository(async () => ({ rows: [{ result: "yes" }] }));
    await expect(
      malformed.repository.confirmActiveUse({
        credentialId: "key_repository",
        prefix: PREFIX_A,
        tenantId: "ten_repository",
      }),
    ).rejects.toBeInstanceOf(PostgresIdentityDataIntegrityError);
  });
});

describe("PostgresApiKeyCredentialRepository lifecycle", () => {
  it("reads managed metadata inside a tenant transaction", async () => {
    const harness = repository(async (text) => ({
      rows: text.includes("proofstack_find_api_key") ? [managedRow()] : [],
    }));

    await expect(harness.repository.findById("ten_repository", "key_repository")).resolves.toEqual({
      capabilities: ["evidence:ingest"],
      createdAt: CREATED_AT.toISOString(),
      credentialId: "key_repository",
      expiresAt: EXPIRES_AT,
      name: "repository agent",
      prefix: PREFIX_A,
      principalId: "wrk_repository",
      resourceScope: { mode: "tenant" },
      revokedAt: null,
      rotatedFromCredentialId: null,
      tenantId: "ten_repository",
    });
    expect(harness.pool.queries.map(({ text }) => text.trim())).toEqual([
      "BEGIN",
      "SELECT set_config('proofstack.tenant_id', $1, true)",
      expect.stringContaining("proofstack_find_api_key"),
      "COMMIT",
    ]);
  });

  it("returns null for missing managed metadata", async () => {
    const harness = repository(async () => ({ rows: [] }));
    await expect(harness.repository.findById("ten_repository", "key_missing")).resolves.toBeNull();
  });

  it("validates managed revocation and rotation metadata", async () => {
    const harness = repository(async () => ({
      rows: [
        managedRow({
          created_at: CREATED_AT.toISOString(),
          revoked_at: CREATED_AT,
          rotated_from_credential_id: "key_repository_previous",
        }),
      ],
    }));
    await expect(
      harness.repository.findById("ten_repository", "key_repository"),
    ).resolves.toMatchObject({
      revokedAt: CREATED_AT.toISOString(),
      rotatedFromCredentialId: "key_repository_previous",
    });
  });

  it("rejects malformed managed display names", async () => {
    const harness = repository(async () => ({
      rows: [managedRow({ display_name: `agent${String.fromCodePoint(0x7f)}name` })],
    }));
    await expect(
      harness.repository.findById("ten_repository", "key_repository"),
    ).rejects.toBeInstanceOf(PostgresIdentityDataIntegrityError);
  });

  it("creates a credential without exposing its hash in the result", async () => {
    const harness = repository(async (text) => ({
      rows: text.includes("proofstack_create_api_key") ? [{ created_at: CREATED_AT }] : [],
    }));

    await expect(harness.repository.create(createInput())).resolves.toEqual({
      createdAt: CREATED_AT.toISOString(),
    });
    const call = harness.pool.queries.find(({ text }) =>
      text.includes("proofstack_create_api_key"),
    );
    expect(call?.values).toEqual([
      "ten_repository",
      "key_repository",
      PREFIX_A,
      "wrk_repository",
      "repository agent",
      ["evidence:ingest"],
      JSON.stringify({ mode: "tenant" }),
      "scrypt-v1",
      32_768,
      8,
      1,
      32,
      HASH.salt,
      HASH.digest,
      EXPIRES_AT,
      "usr_repository_admin",
    ]);
  });

  it("maps create collisions and preserves other failures", async () => {
    const conflict = repository(async () => {
      throw databaseError("23505");
    });
    await expect(conflict.repository.create(createInput())).rejects.toBeInstanceOf(
      ApiKeyCredentialConflictError,
    );

    const unavailable = databaseError("08006", "connection lost");
    const failed = repository(async () => {
      throw unavailable;
    });
    await expect(failed.repository.create(createInput())).rejects.toBe(unavailable);
  });

  it("rotates only credential material through the database transition", async () => {
    const harness = repository(async (text) => ({
      rows: text.includes("proofstack_rotate_api_key") ? [{ created_at: CREATED_AT }] : [],
    }));
    const input: RotateApiKeyCredential = {
      actorPrincipalId: "usr_repository_admin",
      credential: createInput({
        credentialId: "key_repository_rotated",
        prefix: PREFIX_B,
        rotatedFromCredentialId: "key_repository",
      }),
      previousCredentialId: "key_repository",
    };

    await expect(harness.repository.rotate(input)).resolves.toEqual({
      createdAt: CREATED_AT.toISOString(),
    });
    const call = harness.pool.queries.find(({ text }) =>
      text.includes("proofstack_rotate_api_key"),
    );
    expect(call?.values).toEqual([
      "ten_repository",
      "key_repository",
      "key_repository_rotated",
      PREFIX_B,
      "scrypt-v1",
      32_768,
      8,
      1,
      32,
      HASH.salt,
      HASH.digest,
      EXPIRES_AT,
      "usr_repository_admin",
    ]);
  });

  it.each([
    ["23505", "database error", ApiKeyCredentialConflictError],
    ["P0002", "database error", ApiKeyCredentialNotFoundError],
    ["55000", "ProofStack API key credential is not active", ApiKeyCredentialNotActiveError],
  ])("maps rotation SQLSTATE %s", async (code, message, expected) => {
    const harness = repository(async () => {
      throw databaseError(code, message);
    });
    await expect(
      harness.repository.rotate({
        actorPrincipalId: "usr_repository_admin",
        credential: createInput({ credentialId: "key_rotated" }),
        previousCredentialId: "key_repository",
      }),
    ).rejects.toBeInstanceOf(expected);
  });

  it("preserves unexpected rotation failures", async () => {
    const unavailable = databaseError("08006", "connection lost");
    const harness = repository(async () => {
      throw unavailable;
    });
    await expect(
      harness.repository.rotate({
        actorPrincipalId: "usr_repository_admin",
        credential: createInput({ credentialId: "key_rotated" }),
        previousCredentialId: "key_repository",
      }),
    ).rejects.toBe(unavailable);
  });

  it("revokes idempotently and maps missing credentials", async () => {
    const successful = repository(async () => ({ rows: [{ result: false }] }));
    await expect(
      successful.repository.revoke(
        "ten_repository",
        "key_repository",
        "usr_repository_admin",
        "retired",
      ),
    ).resolves.toBe(false);

    const missing = repository(async () => {
      throw databaseError("P0002");
    });
    await expect(
      missing.repository.revoke("ten_repository", "key_missing", "usr_repository_admin", "retired"),
    ).rejects.toBeInstanceOf(ApiKeyCredentialNotFoundError);

    const unavailable = databaseError("08006", "connection lost");
    const failed = repository(async () => {
      throw unavailable;
    });
    await expect(
      failed.repository.revoke(
        "ten_repository",
        "key_repository",
        "usr_repository_admin",
        "retired",
      ),
    ).rejects.toBe(unavailable);
  });
});
