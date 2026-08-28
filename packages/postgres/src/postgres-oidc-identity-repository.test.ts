import {
  BrowserSessionConflictError,
  type CreateBrowserSession,
  type CreateOidcLoginTransaction,
  OidcBindingNotActiveError,
  oidcIdentityDigest,
  OidcLoginTransactionConflictError,
} from "@proofstack/identity";
import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { PostgresIdentityDataIntegrityError } from "./postgres-api-key-credential-repository.js";
import { PostgresOidcIdentityRepository } from "./postgres-oidc-identity-repository.js";

const ISSUER = "https://identity.example.test/tenant";
const SUBJECT = "provider-subject-001";
const CREATED_AT = new Date("2026-08-28T09:00:00.000Z");
const EXPIRES_AT = new Date("2026-08-28T09:10:00.000Z");
const ABSOLUTE_EXPIRES_AT = new Date("2026-08-28T21:00:00.000Z");
const IDLE_EXPIRES_AT = new Date("2026-08-28T09:30:00.000Z");
const STATE_DIGEST = "a".repeat(64);
const SESSION_DIGEST = "b".repeat(64);
const CSRF_DIGEST = "c".repeat(64);
const PROTECTED_PAYLOAD = `otx_v1_${"A".repeat(16)}_B_${"C".repeat(22)}`;

type QueryHandler = (
  text: string,
  values: readonly unknown[] | undefined,
) => Promise<{ readonly rows: readonly Record<string, unknown>[] }>;

class FakePool {
  readonly queries: Array<{ readonly text: string; readonly values?: readonly unknown[] }> = [];

  constructor(private readonly handler: QueryHandler) {}

  async query(text: string, values?: readonly unknown[]) {
    this.queries.push({ text, ...(values ? { values } : {}) });
    return this.handler(text, values);
  }
}

function repository(handler: QueryHandler): {
  readonly pool: FakePool;
  readonly repository: PostgresOidcIdentityRepository;
} {
  const pool = new FakePool(handler);
  return {
    pool,
    repository: new PostgresOidcIdentityRepository(pool as unknown as Pool),
  };
}

function bindingRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    binding_id: "oidc_binding_001",
    capabilities: ["project:read", "evidence:read", "identity:manage"],
    issuer: ISSUER,
    principal_id: "usr_operator_001",
    resource_scope: { mode: "tenant" },
    roles: ["admin"],
    subject: SUBJECT,
    tenant_id: "ten_identity_001",
    ...overrides,
  };
}

function sessionRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    capabilities: ["project:read", "evidence:read"],
    created_at: CREATED_AT,
    csrf_digest: CSRF_DIGEST,
    principal_id: "usr_operator_001",
    resource_scope: { mode: "tenant" },
    roles: ["admin"],
    session_digest: SESSION_DIGEST,
    session_id: "ses_browser_001",
    tenant_id: "ten_identity_001",
    ...overrides,
  };
}

function transactionInput(): CreateOidcLoginTransaction {
  return {
    lifetimeSeconds: 600,
    protectedPayload: PROTECTED_PAYLOAD,
    stateDigest: STATE_DIGEST,
  };
}

function sessionInput(): CreateBrowserSession {
  return {
    absoluteLifetimeSeconds: 43_200,
    bindingId: "oidc_binding_001",
    csrfDigest: CSRF_DIGEST,
    idleLifetimeSeconds: 1_800,
    sessionDigest: SESSION_DIGEST,
    sessionId: "ses_browser_001",
  };
}

function databaseError(code: string): Error & { readonly code: string } {
  return Object.assign(new Error("database error"), { code });
}

describe("PostgresOidcIdentityRepository bindings", () => {
  it("derives the exact identity digest and validates active authorization", async () => {
    const harness = repository(async () => ({ rows: [bindingRow()] }));

    await expect(harness.repository.findActiveByIssuerSubject(ISSUER, SUBJECT)).resolves.toEqual({
      bindingId: "oidc_binding_001",
      capabilities: ["project:read", "evidence:read", "identity:manage"],
      issuer: ISSUER,
      principalId: "usr_operator_001",
      resourceScope: { mode: "tenant" },
      roles: ["admin"],
      subject: SUBJECT,
      tenantId: "ten_identity_001",
    });
    expect(harness.pool.queries[0]?.values).toEqual([
      oidcIdentityDigest(ISSUER, SUBJECT),
      ISSUER,
      SUBJECT,
    ]);
  });

  it("returns null for an unbound identity", async () => {
    const harness = repository(async () => ({ rows: [] }));
    await expect(harness.repository.findActiveByIssuerSubject(ISSUER, SUBJECT)).resolves.toBeNull();
  });

  it.each([
    ["duplicate rows", [bindingRow(), bindingRow()]],
    ["invalid binding identifier", [bindingRow({ binding_id: "INVALID" })]],
    ["non-string issuer", [bindingRow({ issuer: 1 })]],
    ["unsafe issuer", [bindingRow({ issuer: "http://identity.example.test" })]],
    ["non-string subject", [bindingRow({ subject: 1 })]],
    ["unsafe subject", [bindingRow({ subject: "bad\nsubject" })]],
    ["invalid authorization", [bindingRow({ roles: ["unknown"] })]],
  ])("fails closed for %s", async (_label, rows) => {
    const harness = repository(async () => ({ rows }));
    await expect(
      harness.repository.findActiveByIssuerSubject(ISSUER, SUBJECT),
    ).rejects.toBeInstanceOf(PostgresIdentityDataIntegrityError);
  });
});

describe("PostgresOidcIdentityRepository login transactions", () => {
  it("creates and consumes an encrypted single-use transaction", async () => {
    const harness = repository(async (text) => {
      if (text.includes("create_oidc_login_transaction")) {
        return { rows: [{ created_at: CREATED_AT, expires_at: EXPIRES_AT }] };
      }
      return { rows: [{ protected_payload: PROTECTED_PAYLOAD, state_digest: STATE_DIGEST }] };
    });

    await expect(harness.repository.create(transactionInput())).resolves.toEqual({
      createdAt: CREATED_AT.toISOString(),
      expiresAt: EXPIRES_AT.toISOString(),
    });
    await expect(harness.repository.consumeActive(STATE_DIGEST)).resolves.toEqual({
      protectedPayload: PROTECTED_PAYLOAD,
      stateDigest: STATE_DIGEST,
    });
    expect(harness.pool.queries[0]?.values).toEqual([STATE_DIGEST, PROTECTED_PAYLOAD, 600]);
    expect(harness.pool.queries[1]?.values).toEqual([STATE_DIGEST]);
  });

  it("returns null when a transaction is absent or already consumed", async () => {
    const harness = repository(async () => ({ rows: [] }));
    await expect(harness.repository.consumeActive(STATE_DIGEST)).resolves.toBeNull();
  });

  it("maps transaction identity conflicts and preserves storage failures", async () => {
    const conflict = repository(async () => {
      throw databaseError("23505");
    });
    await expect(conflict.repository.create(transactionInput())).rejects.toBeInstanceOf(
      OidcLoginTransactionConflictError,
    );

    const unavailable = new Error("unavailable");
    const failed = repository(async () => {
      throw unavailable;
    });
    await expect(failed.repository.create(transactionInput())).rejects.toBe(unavailable);

    const nonErrorFailure = repository(async () => {
      throw "non-error failure";
    });
    await expect(nonErrorFailure.repository.create(transactionInput())).rejects.toBe(
      "non-error failure",
    );
  });

  it.each([
    ["missing creation row", []],
    ["duplicate creation rows", [{ created_at: CREATED_AT }, { created_at: CREATED_AT }]],
    ["invalid creation time", [{ created_at: "invalid", expires_at: EXPIRES_AT }]],
    ["invalid expiration time", [{ created_at: CREATED_AT, expires_at: "invalid" }]],
  ])("rejects %s", async (_label, rows) => {
    const harness = repository(async () => ({ rows }));
    await expect(harness.repository.create(transactionInput())).rejects.toBeInstanceOf(
      PostgresIdentityDataIntegrityError,
    );
  });

  it.each([
    ["duplicate consumption rows", [{}, {}]],
    ["invalid payload type", [{ protected_payload: 1, state_digest: STATE_DIGEST }]],
    ["short payload", [{ protected_payload: "otx_v1_invalid", state_digest: STATE_DIGEST }]],
    [
      "oversized payload",
      [
        {
          protected_payload: `otx_v1_${"A".repeat(16)}_${"B".repeat(4097)}_${"C".repeat(22)}`,
          state_digest: STATE_DIGEST,
        },
      ],
    ],
    [
      "invalid payload alphabet",
      [{ protected_payload: PROTECTED_PAYLOAD.replace("_B_", "_!_"), state_digest: STATE_DIGEST }],
    ],
    ["invalid state digest", [{ protected_payload: PROTECTED_PAYLOAD, state_digest: "invalid" }]],
  ])("rejects %s", async (_label, rows) => {
    const harness = repository(async () => ({ rows }));
    await expect(harness.repository.consumeActive(STATE_DIGEST)).rejects.toBeInstanceOf(
      PostgresIdentityDataIntegrityError,
    );
  });

  it("purges bounded retained transactions and rejects malformed counts", async () => {
    const valid = repository(async () => ({ rows: [{ result: 7 }] }));
    await expect(valid.repository.purgeExpiredTransactions()).resolves.toBe(7);
    expect(valid.pool.queries[0]?.values).toBeUndefined();

    for (const rows of [
      [],
      [{ result: -1 }],
      [{ result: 1_001 }],
      [{ result: 1.5 }],
      [{ result: "1" }],
      [{ result: 1 }, { result: 2 }],
    ]) {
      const malformed = repository(async () => ({ rows }));
      await expect(malformed.repository.purgeExpiredTransactions()).rejects.toBeInstanceOf(
        PostgresIdentityDataIntegrityError,
      );
    }
  });
});

describe("PostgresOidcIdentityRepository browser sessions", () => {
  it("creates and validates authoritative session metadata", async () => {
    const harness = repository(async () => ({
      rows: [
        {
          absolute_expires_at: ABSOLUTE_EXPIRES_AT,
          created_at: CREATED_AT,
          idle_expires_at: IDLE_EXPIRES_AT,
          session_id: "ses_browser_001",
        },
      ],
    }));

    await expect(harness.repository.create(sessionInput())).resolves.toEqual({
      absoluteExpiresAt: ABSOLUTE_EXPIRES_AT.toISOString(),
      createdAt: CREATED_AT.toISOString(),
      idleExpiresAt: IDLE_EXPIRES_AT.toISOString(),
      sessionId: "ses_browser_001",
    });
    expect(harness.pool.queries[0]?.values).toEqual([
      "ses_browser_001",
      SESSION_DIGEST,
      CSRF_DIGEST,
      "oidc_binding_001",
      43_200,
      1_800,
    ]);
  });

  it.each([
    ["duplicate session identity", "23505", BrowserSessionConflictError],
    ["inactive binding", "P0002", OidcBindingNotActiveError],
  ])("maps %s", async (_label, code, expected) => {
    const harness = repository(async () => {
      throw databaseError(code);
    });
    await expect(harness.repository.create(sessionInput())).rejects.toBeInstanceOf(expected);
  });

  it("preserves unexpected session creation failures", async () => {
    const unavailable = new Error("unavailable");
    const harness = repository(async () => {
      throw unavailable;
    });
    await expect(harness.repository.create(sessionInput())).rejects.toBe(unavailable);
  });

  it.each([
    ["missing row", []],
    ["duplicate rows", [{}, {}]],
    [
      "invalid absolute expiration",
      [
        {
          absolute_expires_at: "invalid",
          created_at: CREATED_AT,
          idle_expires_at: IDLE_EXPIRES_AT,
          session_id: "ses_browser_001",
        },
      ],
    ],
    [
      "invalid creation time",
      [
        {
          absolute_expires_at: ABSOLUTE_EXPIRES_AT,
          created_at: "invalid",
          idle_expires_at: IDLE_EXPIRES_AT,
          session_id: "ses_browser_001",
        },
      ],
    ],
    [
      "invalid idle expiration",
      [
        {
          absolute_expires_at: ABSOLUTE_EXPIRES_AT,
          created_at: CREATED_AT,
          idle_expires_at: "invalid",
          session_id: "ses_browser_001",
        },
      ],
    ],
    [
      "invalid session identifier",
      [
        {
          absolute_expires_at: ABSOLUTE_EXPIRES_AT,
          created_at: CREATED_AT,
          idle_expires_at: IDLE_EXPIRES_AT,
          session_id: "INVALID",
        },
      ],
    ],
  ])("rejects session creation with %s", async (_label, rows) => {
    const harness = repository(async () => ({ rows }));
    await expect(harness.repository.create(sessionInput())).rejects.toBeInstanceOf(
      PostgresIdentityDataIntegrityError,
    );
  });

  it("finds, touches, and validates a current browser session", async () => {
    const harness = repository(async () => ({ rows: [sessionRow()] }));
    await expect(harness.repository.findAndTouchActive(SESSION_DIGEST)).resolves.toEqual({
      capabilities: ["project:read", "evidence:read"],
      createdAt: CREATED_AT.toISOString(),
      csrfDigest: CSRF_DIGEST,
      principalId: "usr_operator_001",
      resourceScope: { mode: "tenant" },
      roles: ["admin"],
      sessionDigest: SESSION_DIGEST,
      sessionId: "ses_browser_001",
      tenantId: "ten_identity_001",
    });
    expect(harness.pool.queries[0]?.values).toEqual([SESSION_DIGEST]);
  });

  it("returns null for an inactive browser session", async () => {
    const harness = repository(async () => ({ rows: [] }));
    await expect(harness.repository.findAndTouchActive(SESSION_DIGEST)).resolves.toBeNull();
  });

  it.each([
    ["duplicate rows", [sessionRow(), sessionRow()]],
    ["invalid session identifier", [sessionRow({ session_id: "INVALID" })]],
    ["invalid creation time", [sessionRow({ created_at: new Date(Number.NaN) })]],
    ["invalid authorization", [sessionRow({ capabilities: ["unknown"] })]],
    ["invalid CSRF digest", [sessionRow({ csrf_digest: "invalid" })]],
    ["invalid session digest type", [sessionRow({ session_digest: 1 })]],
    ["invalid session digest", [sessionRow({ session_digest: "invalid" })]],
  ])("fails closed for %s", async (_label, rows) => {
    const harness = repository(async () => ({ rows }));
    await expect(harness.repository.findAndTouchActive(SESSION_DIGEST)).rejects.toBeInstanceOf(
      PostgresIdentityDataIntegrityError,
    );
  });

  it("revokes and purges sessions with exact result validation", async () => {
    const revoked = repository(async () => ({ rows: [{ result: true }] }));
    await expect(revoked.repository.revokeActive(SESSION_DIGEST)).resolves.toBe(true);
    expect(revoked.pool.queries[0]?.values).toEqual([SESSION_DIGEST]);

    const purged = repository(async () => ({ rows: [{ result: 1_000 }] }));
    await expect(purged.repository.purgeExpiredSessions()).resolves.toBe(1_000);

    for (const rows of [[], [{ result: "true" }], [{ result: true }, { result: false }]]) {
      const malformed = repository(async () => ({ rows }));
      await expect(malformed.repository.revokeActive(SESSION_DIGEST)).rejects.toBeInstanceOf(
        PostgresIdentityDataIntegrityError,
      );
    }
  });
});
