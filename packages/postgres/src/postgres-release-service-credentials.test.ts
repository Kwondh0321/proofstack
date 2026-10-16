import { policyEvaluationTimestampOrderKey } from "@proofstack/contracts";
import {
  ReleaseDecisionVerificationBudget,
  ReleaseDecisionVerificationBudgetError,
} from "@proofstack/core";
import {
  generateServiceToken,
  hashServiceTokenSecret,
  OidcSessionAuthenticator,
  ReleaseMutationAuthenticator,
  ServiceTokenAuthenticator,
} from "@proofstack/identity";
import type { Pool, PoolClient } from "pg";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  PostgresReleaseServiceCredentialRepository,
  PostgresReleaseServiceCredentialError,
  readPostgresReleaseServiceCredentialOnClient,
  recheckPostgresReleaseServicePublisherOnClient,
} from "./postgres-release-service-credentials.js";

const scope = {
  tenantId: "tenant_private_service",
  projectId: "project_private_service",
  environmentId: "environment_private_service",
};
const token = generateServiceToken();
let passwordHash: Awaited<ReturnType<typeof hashServiceTokenSecret>>;
beforeAll(async () => {
  passwordHash = await hashServiceTokenSecret(token.secret);
});
const resourceScope = {
  mode: "restricted" as const,
  projects: [{ projectId: scope.projectId, environmentIds: [scope.environmentId] }],
};
const limits = {
  maxAcquisitionRecords: 1000,
  maxAcquisitionRecordBytes: 1024 * 1024,
  maxApprovalRecords: 0,
};
const meter = () => new ReleaseDecisionVerificationBudget(limits);
function authRow() {
  return {
    kind: "service_token" as const,
    authenticatedAt: "2026-10-16T10:00:00.000Z",
    credentialId: "credential_private_service",
    principalId: "principal_private_service",
    tenantId: scope.tenantId,
    prefix: token.prefix,
    passwordHash,
    capabilities: ["release:decision:publish" as const],
    resourceScope,
  };
}
function nativeRow() {
  return {
    tenant_id: scope.tenantId,
    credential_id: "credential_private_service",
    principal_id: "principal_private_service",
    resource_scope: resourceScope,
    created_at_lexical: "2026-10-16T09:00:00.000123Z",
    expires_at_lexical: "2026-10-16T11:00:00.000123Z",
    created_at_key: policyEvaluationTimestampOrderKey("2026-10-16T09:00:00.000123Z").toString(),
    expires_at_key: policyEvaluationTimestampOrderKey("2026-10-16T11:00:00.000123Z").toString(),
    revoked_at_lexical: null as string | null,
    revoked_at_key: null as string | null,
    revocation_reason: null as string | null,
  };
}
function pool(rows: unknown[]) {
  const query = vi.fn(async (_sql: string, _values?: unknown[]) => ({ rows }));
  return { query, pool: { query } as unknown as Pick<Pool, "query"> };
}
async function proof() {
  const f = pool([{ value: authRow() }]);
  let n = 0;
  f.query.mockImplementation(async () => ({ rows: [{ value: ++n === 1 ? authRow() : true }] }));
  const service = new ServiceTokenAuthenticator(
    new PostgresReleaseServiceCredentialRepository(f.pool),
  );
  const auth = new ReleaseMutationAuthenticator(
    new OidcSessionAuthenticator({
      async findAndTouchActive() {
        throw new Error("Browser path must remain unused");
      },
    }),
    service,
  );
  return auth.authenticateServiceDecisionPublisher({
    serviceToken: token.value,
    requestId: "private_request",
    scope,
  });
}
async function native(patch: Partial<ReturnType<typeof nativeRow>> = {}) {
  const authentication = await proof(),
    row = { ...nativeRow(), ...patch };
  const state: { context: unknown[]; guard: unknown[]; sources: unknown[]; clock: unknown[] } = {
    context: [
      {
        tenant_id: scope.tenantId,
        project_id: scope.projectId,
        environment_id: scope.environmentId,
        isolation: "read committed",
      },
    ],
    guard: [{ acquired: true }],
    sources: [row],
    clock: [{ captured_at: "2026-10-16T10:00:01.000123Z" }],
  };
  const query = vi.fn(async (sql: string) => {
    if (sql.startsWith("SELECT current_setting")) return { rows: state.context };
    if (sql.includes("try_lock")) return { rows: state.guard };
    if (sql.includes("FROM public.proofstack_release_service_credentials"))
      return { rows: state.sources };
    if (sql.includes("clock_timestamp")) return { rows: state.clock };
    throw new Error("Unexpected fixed native query");
  });
  const client = { query } as unknown as Pick<PoolClient, "query">;
  const input = { authentication, scope, requestId: "private_request", budget: meter() };
  return { state, client, input, query, row };
}
describe("private native service authentication transport", () => {
  it("returns only the exact native authentication contract", async () => {
    const f = pool([{ value: authRow() }]);
    const repository = new PostgresReleaseServiceCredentialRepository(f.pool);
    expect(await repository.findActiveServiceByPrefix(token.prefix)).toEqual(authRow());
    expect(f.query).toHaveBeenCalledExactlyOnceWith(
      "SELECT public.proofstack_find_active_release_service_credential($1) AS value",
      [token.prefix],
    );
  });
  it("keeps absence distinct from malformed rows", async () => {
    expect(
      await new PostgresReleaseServiceCredentialRepository(
        pool([{ value: null }]).pool,
      ).findActiveServiceByPrefix(token.prefix),
    ).toBeNull();
  });
  it.for([
    [],
    [{ value: authRow() }, { value: authRow() }],
    [{}],
    [{ value: [] }],
    [{ value: false }],
  ])("rejects invalid lookup rows %#", async (rows) => {
    await expect(
      new PostgresReleaseServiceCredentialRepository(pool(rows).pool).findActiveServiceByPrefix(
        token.prefix,
      ),
    ).rejects.toBeInstanceOf(PostgresReleaseServiceCredentialError);
  });
  it.each([
    "kind",
    "prefix",
    "principalId",
    "tenantId",
    "credentialId",
    "authenticatedAt",
    "capabilities",
    "resourceScope",
    "passwordHash",
    "unknown",
  ])("rejects altered original %s without exposing secret material", async (field) => {
    const row: Record<string, unknown> = {
      ...authRow(),
      [field]:
        field === "capabilities"
          ? ["approval:decide"]
          : field === "resourceScope"
            ? { mode: "tenant" }
            : field === "passwordHash"
              ? { ...passwordHash, cost: 16384 }
              : "bad-id",
    };
    await expect(
      new PostgresReleaseServiceCredentialRepository(
        pool([{ value: row }]).pool,
      ).findActiveServiceByPrefix(token.prefix),
    ).rejects.toMatchObject({
      name: "PostgresReleaseServiceCredentialError",
      message: "Private release service credential was rejected",
    });
  });
  it.each(["", token.prefix + "a", "!".repeat(22), "B".repeat(22)])(
    "rejects malformed/noncanonical prefix before I/O %#",
    async (prefix) => {
      const f = pool([]);
      await expect(
        new PostgresReleaseServiceCredentialRepository(f.pool).findActiveServiceByPrefix(prefix),
      ).rejects.toBeInstanceOf(PostgresReleaseServiceCredentialError);
      expect(f.query).not.toHaveBeenCalled();
    },
  );
  it.each([
    "salt",
    "digest",
    "algorithm",
    "cost",
    "blockSize",
    "keyLength",
    "parallelization",
    "unknown",
  ])("rejects invalid fixed scrypt %s before confirmation", async (field) => {
    const row = authRow(),
      { authenticatedAt: _at, ...expected } = row;
    const f = pool([{ value: true }]);
    const invalid = {
      ...expected,
      passwordHash: {
        ...passwordHash,
        [field]:
          field === "salt" || field === "digest" ? "B".repeat(field === "salt" ? 22 : 43) : 0,
      },
    };
    await expect(
      new PostgresReleaseServiceCredentialRepository(f.pool).confirmActiveServiceUse(invalid),
    ).rejects.toBeInstanceOf(PostgresReleaseServiceCredentialError);
    expect(f.query).not.toHaveBeenCalled();
  });
  it.each([true, false])("preserves strict native confirmation %s", async (value) => {
    const { authenticatedAt: _at, ...expected } = authRow();
    const f = pool([{ value }]);
    expect(
      await new PostgresReleaseServiceCredentialRepository(f.pool).confirmActiveServiceUse(
        expected,
      ),
    ).toBe(value);
    expect(f.query).toHaveBeenCalledTimes(1);
    expect(f.query.mock.calls[0]?.[0]).toBe(
      "SELECT public.proofstack_confirm_release_service_use($1::jsonb) AS value",
    );
    const values = f.query.mock.calls[0]?.[1];
    expect(values).toHaveLength(1);
    expect(JSON.parse(String(values?.[0]))).toEqual(expected);
  });
  it.for([[], [{ value: 1 }], [{ value: "true" }], [{ value: true }, { value: true }]])(
    "refuses malformed native confirmation %#",
    async (rows) => {
      const { authenticatedAt: _at, ...expected } = authRow();
      await expect(
        new PostgresReleaseServiceCredentialRepository(pool(rows).pool).confirmActiveServiceUse(
          expected,
        ),
      ).rejects.toBeInstanceOf(PostgresReleaseServiceCredentialError);
    },
  );
  it("scrubs lookup/confirmation failures without secret-bearing causes", async () => {
    const f = pool([]);
    f.query.mockRejectedValue(new Error("private verifier diagnostic must be scrubbed"));
    const repository = new PostgresReleaseServiceCredentialRepository(f.pool);
    const { authenticatedAt: _at, ...expected } = authRow();
    for (const operation of [
      () => repository.findActiveServiceByPrefix(token.prefix),
      () => repository.confirmActiveServiceUse(expected),
    ]) {
      try {
        await operation();
        throw new Error("Expected failure");
      } catch (error) {
        expect(error).toBeInstanceOf(PostgresReleaseServiceCredentialError);
        expect(error).not.toHaveProperty("cause");
      }
    }
  });
});
describe("same-client actual private service publisher reinspection", () => {
  it("joins actual authentication with native original precision and no verifier output", async () => {
    const f = await native();
    const result = await recheckPostgresReleaseServicePublisherOnClient(f.client, f.input);
    expect(result.receipt).toMatchObject({
      principalType: "service",
      authenticationMethod: "service_token",
      requestId: "private_request",
    });
    expect(result.credentialLimit).toBe(f.row.expires_at_lexical);
    const encoded = JSON.stringify(result);
    for (const secret of [token.value, token.prefix, passwordHash.salt, passwordHash.digest])
      expect(encoded.includes(secret)).toBe(false);
    expect(f.query).toHaveBeenCalledTimes(4);
    expect(
      f.query.mock.calls.every(([sql]) => !/\bBEGIN\b|\bCOMMIT\b|\bINSERT\b|\bUPDATE\b/.test(sql)),
    ).toBe(true);
  });
  it.each(["tenant_id", "project_id", "environment_id", "isolation"])(
    "rejects substituted native %s",
    async (field) => {
      const f = await native();
      f.state.context = [{ ...objectContext(), [field]: "foreign" }];
      await expect(
        recheckPostgresReleaseServicePublisherOnClient(f.client, f.input),
      ).rejects.toBeInstanceOf(ReleaseDecisionVerificationBudgetError);
      expect(() => f.input.budget.snapshot()).toThrow(ReleaseDecisionVerificationBudgetError);
      expect(f.query).toHaveBeenCalledTimes(1);
    },
  );
  it.for([
    [],
    [{ acquired: false }],
    [{ acquired: "true" }],
    [{ acquired: true }, { acquired: true }],
  ])("refuses a missing/contended/malformed guard %#", async (rows) => {
    const f = await native();
    f.state.guard = rows;
    await expect(
      recheckPostgresReleaseServicePublisherOnClient(f.client, f.input),
    ).rejects.toBeInstanceOf(ReleaseDecisionVerificationBudgetError);
    expect(f.query).toHaveBeenCalledTimes(2);
  });
  it.each([
    "tenant_id",
    "credential_id",
    "principal_id",
    "created_at_key",
    "expires_at_key",
    "revoked_at_key",
    "created_at_lexical",
    "expires_at_lexical",
    "revoked_at_lexical",
    "revocation_reason",
    "resource_scope",
  ])("rejects damaged native %s and keeps failure sticky", async (field) => {
    const f = await native();
    f.state.sources = [
      { ...f.row, [field]: field === "resource_scope" ? { mode: "tenant" } : "damaged" },
    ];
    await expect(
      recheckPostgresReleaseServicePublisherOnClient(f.client, f.input),
    ).rejects.toBeInstanceOf(ReleaseDecisionVerificationBudgetError);
    expect(() => f.input.budget.snapshot()).toThrow(ReleaseDecisionVerificationBudgetError);
  });
  it.for([[], [nativeRow(), nativeRow()]])(
    "refuses source absence or multiplicity %#",
    async (rows) => {
      const f = await native();
      f.state.sources = rows;
      await expect(
        recheckPostgresReleaseServicePublisherOnClient(f.client, f.input),
      ).rejects.toBeInstanceOf(ReleaseDecisionVerificationBudgetError);
    },
  );
  it.for([
    [],
    [{ captured_at: "2026-10-16T10:00:01.000Z" }],
    [{ captured_at: "invalid" }],
    [
      { captured_at: "2026-10-16T10:00:01.000123Z" },
      { captured_at: "2026-10-16T10:00:01.000123Z" },
    ],
  ])("rejects a malformed native cut %#", async (rows) => {
    const f = await native();
    f.state.clock = rows;
    await expect(
      recheckPostgresReleaseServicePublisherOnClient(f.client, f.input),
    ).rejects.toBeInstanceOf(ReleaseDecisionVerificationBudgetError);
  });
  it("rejects expired credentials at the exact native cut", async () => {
    const f = await native();
    f.state.clock = [{ captured_at: f.row.expires_at_lexical }];
    await expect(
      recheckPostgresReleaseServicePublisherOnClient(f.client, f.input),
    ).rejects.toBeInstanceOf(ReleaseDecisionVerificationBudgetError);
  });
  it("retains revoked state for owning reads and rejects new publication", async () => {
    const at = "2026-10-16T10:00:00.500123Z";
    const f = await native({
      revoked_at_lexical: at,
      revoked_at_key: policyEvaluationTimestampOrderKey(at).toString(),
      revocation_reason: "administrative",
    });
    const read = await readPostgresReleaseServiceCredentialOnClient(
      f.client,
      scope,
      f.row.credential_id,
      meter(),
    );
    expect(read?.grant.state).toBe("inactive");
    await expect(
      recheckPostgresReleaseServicePublisherOnClient(f.client, f.input),
    ).rejects.toBeInstanceOf(ReleaseDecisionVerificationBudgetError);
  });
  it("taints source failures and refuses failed/fake meters before I/O", async () => {
    const f = await native();
    f.query.mockRejectedValue(new Error("unavailable"));
    await expect(
      recheckPostgresReleaseServicePublisherOnClient(f.client, f.input),
    ).rejects.toBeInstanceOf(ReleaseDecisionVerificationBudgetError);
    f.query.mockClear();
    await expect(
      recheckPostgresReleaseServicePublisherOnClient(f.client, f.input),
    ).rejects.toBeInstanceOf(ReleaseDecisionVerificationBudgetError);
    expect(f.query).not.toHaveBeenCalled();
    await expect(
      readPostgresReleaseServiceCredentialOnClient(
        f.client,
        scope,
        f.row.credential_id,
        {} as ReleaseDecisionVerificationBudget,
      ),
    ).rejects.toBeInstanceOf(PostgresReleaseServiceCredentialError);
  });
  it("preserves exact aggregate limits and fails one record/byte below", async () => {
    const f = await native();
    await recheckPostgresReleaseServicePublisherOnClient(f.client, f.input);
    const used = f.input.budget.snapshot();
    for (const selected of [
      { maxAcquisitionRecords: used.records - 1 },
      { maxAcquisitionRecordBytes: used.recordBytes - 1 },
    ])
      await expect(
        recheckPostgresReleaseServicePublisherOnClient(f.client, {
          ...f.input,
          budget: new ReleaseDecisionVerificationBudget({ ...limits, ...selected }),
        }),
      ).rejects.toBeInstanceOf(ReleaseDecisionVerificationBudgetError);
    await expect(
      recheckPostgresReleaseServicePublisherOnClient(f.client, {
        ...f.input,
        budget: new ReleaseDecisionVerificationBudget({
          ...limits,
          maxAcquisitionRecords: used.records,
          maxAcquisitionRecordBytes: used.recordBytes,
        }),
      }),
    ).resolves.toHaveProperty("credentialLimit");
  });
});
function objectContext() {
  return {
    tenant_id: scope.tenantId,
    project_id: scope.projectId,
    environment_id: scope.environmentId,
    isolation: "read committed",
  };
}
