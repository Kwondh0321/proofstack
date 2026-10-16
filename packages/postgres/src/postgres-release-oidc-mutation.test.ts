import type { Capability, EvidenceScope } from "@proofstack/contracts";
import {
  ReleaseDecisionVerificationBudget,
  ReleaseDecisionVerificationBudgetError,
} from "@proofstack/core";
import {
  generateBrowserSessionCredentials,
  generateServiceToken,
  hashServiceTokenSecret,
  InvalidReleaseMutationAuthenticationError,
  OidcSessionAuthenticator,
  ReleaseMutationAuthenticator,
  ServiceTokenAuthenticator,
  type ReleaseMutationOperation,
} from "@proofstack/identity";
import type { PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  PostgresReleaseOidcMutationError,
  recheckPostgresReleaseOidcMutationOnClient,
} from "./postgres-release-oidc-mutation.js";

const scope: EvidenceScope = {
  tenantId: "tenant_native_mutation",
  projectId: "project_native_mutation",
  environmentId: "environment_native_mutation",
};
const capabilities: Capability[] = [
  "approval:decide",
  "approval:authority:manage",
  "release:selection:manage",
  "release:decision:publish",
];
const limits = {
  maxAcquisitionRecords: 100,
  maxAcquisitionRecordBytes: 65536,
  maxApprovalRecords: 0,
};
const context = {
  tenant_id: scope.tenantId,
  project_id: scope.projectId,
  environment_id: scope.environmentId,
  isolation: "read committed",
};
const binding = {
  tenant_id: scope.tenantId,
  binding_id: "binding_native_mutation",
  principal_id: "user_native_mutation",
  roles: ["member"],
  capabilities,
  resource_scope: { mode: "tenant" },
  authorization_version: 1,
  inactive: false,
  updated_at: "2026-10-16T09:00:00.000123Z",
};
const session = {
  tenant_id: scope.tenantId,
  binding_id: binding.binding_id,
  principal_id: binding.principal_id,
  session_id: "session_native_mutation",
  created_at: "2026-10-16T09:00:00.000123Z",
  absolute_expires_at: "2026-10-16T10:00:00.000123Z",
  idle_expires_at: "2026-10-16T09:30:00.000123Z",
  idle_lifetime_seconds: 1800,
  last_used_at: null,
  use_count: 0,
  revoked_at: null,
  revocation_reason: null,
};
type Row = Record<string, unknown>;
async function fixture(operation: ReleaseMutationOperation = "record_approval") {
  const credentials = generateBrowserSessionCredentials();
  const auth = new ReleaseMutationAuthenticator(
    new OidcSessionAuthenticator({
      async findAndTouchActive() {
        return {
          csrfDigest: credentials.csrfDigest,
          sessionDigest: credentials.sessionDigest,
          capabilities,
          createdAt: "2026-10-16T09:00:00.000Z",
          principalId: binding.principal_id,
          resourceScope: { mode: "tenant" },
          roles: ["member"],
          sessionId: session.session_id,
          tenantId: scope.tenantId,
        };
      },
    }),
  );
  const method = {
    record_approval: "authenticateApprovalReviewer",
    publish_decision: "authenticateDecisionPublisher",
    manage_selection: "authenticateSelectionInstaller",
    manage_reviewer_authority: "authenticateReviewerAuthorityAdministrator",
  } as const;
  const authentication = await auth[method[operation]]({
    sessionToken: credentials.sessionToken,
    csrfToken: credentials.csrfToken,
    scope,
    requestId: "request_native_mutation",
  });
  const state = {
    contexts: [structuredClone(context)] as Row[],
    sessionRows: [[structuredClone(session)], [structuredClone(session)]] as Row[][],
    bindings: [structuredClone(binding)] as Row[],
    sessionGuards: [{ acquired: true }] as Row[],
    bindingGuards: [{ acquired: true }] as Row[],
    clocks: [{ captured_at: "2026-10-16T09:10:00.123456Z" }] as Row[],
    failAt: "",
    failure: new Error("isolated owning database failure"),
    sessionReads: 0,
  };
  const query = vi.fn(async (sql: string, values?: readonly unknown[]) => {
    if (state.failAt && sql.includes(state.failAt)) throw state.failure;
    if (sql.includes("transaction_isolation")) return { rows: state.contexts };
    if (sql.includes("try_lock_release_oidc_source"))
      return { rows: values?.[0] === "oidc_session" ? state.sessionGuards : state.bindingGuards };
    if (sql.includes("FROM public.proofstack_browser_sessions"))
      return { rows: state.sessionRows[state.sessionReads++] ?? [] };
    if (sql.includes("FROM public.proofstack_oidc_bindings")) return { rows: state.bindings };
    if (sql.includes("clock_timestamp()")) return { rows: state.clocks };
    throw new Error("Unexpected native SQL");
  });
  const client = { query } as unknown as Pick<PoolClient, "query">;
  const input = {
    authentication,
    scope,
    operation,
    requestId: "request_native_mutation",
    budget: new ReleaseDecisionVerificationBudget(limits),
  };
  return {
    state,
    query,
    input,
    run: () => recheckPostgresReleaseOidcMutationOnClient(client, input),
    client,
  };
}
function tainted(value: Awaited<ReturnType<typeof fixture>>) {
  expect(() => value.input.budget.snapshot()).toThrow(ReleaseDecisionVerificationBudgetError);
}

describe("actual opaque OIDC proof and same-client native current mutation recheck", () => {
  it.each([
    "record_approval",
    "publish_decision",
    "manage_selection",
    "manage_reviewer_authority",
  ] as const)(
    "rechecks %s with all OIDC guards, repeated reads, native cut and original meter",
    async (operation) => {
      const value = await fixture(operation);
      const result = await value.run();
      expect(result.receipt).toMatchObject({
        principalId: binding.principal_id,
        principalType: "user",
        credentialId: session.session_id,
        requestId: value.input.requestId,
      });
      expect(result.capturedAt).toBe("2026-10-16T09:10:00.123456Z");
      expect(result.credentialExpiresAt).toBe(session.idle_expires_at);
      expect(result.identity).toEqual({
        kind: "oidc_binding",
        principalId: binding.principal_id,
        bindingId: binding.binding_id,
      });
      expect(value.query).toHaveBeenCalledTimes(7);
      const statements = value.query.mock.calls.map(([sql]) => sql);
      expect(statements[0]).toContain("transaction_isolation");
      expect(value.query.mock.calls[1]?.[1]).toEqual(["oidc_session", session.session_id]);
      expect(value.query.mock.calls[3]?.[1]).toEqual(["oidc_binding", binding.binding_id]);
      expect(statements[4]).toContain("FROM public.proofstack_browser_sessions");
      expect(statements[5]).toContain("FROM public.proofstack_oidc_bindings");
      expect(statements[6]).toContain("clock_timestamp()");
      expect(statements.join("\n")).not.toMatch(
        /\bBEGIN\b|\bCOMMIT\b|\bUPDATE\b|session_digest|csrf_digest|password/,
      );
      expect(value.input.budget.snapshot()).toMatchObject({ records: 9, approvalRecords: 0 });
      expect(result).not.toHaveProperty("client");
      expect(result).not.toHaveProperty("publicationAuthority");
    },
  );
  it.each(["tenant_id", "project_id", "environment_id", "isolation"])(
    "rejects wrong native %s before guards/reads",
    async (field) => {
      const value = await fixture();
      value.state.contexts[0] = { ...context, [field]: "wrong_context" };
      await expect(value.run()).rejects.toBeInstanceOf(ReleaseDecisionVerificationBudgetError);
      expect(value.query).toHaveBeenCalledTimes(1);
      tainted(value);
    },
  );
  it.each([{ rows: [] }, { rows: [context, context] }])(
    "rejects missing/ambiguous native context %#",
    async ({ rows }) => {
      const value = await fixture();
      value.state.contexts = rows;
      await expect(value.run()).rejects.toBeInstanceOf(ReleaseDecisionVerificationBudgetError);
      tainted(value);
    },
  );
  it.each(["sessionGuards", "bindingGuards"] as const)(
    "requires whole rollback after contended %s and taints the original meter",
    async (field) => {
      const value = await fixture();
      value.state[field] = [{ acquired: false }];
      await expect(value.run()).rejects.toMatchObject({
        cause: expect.any(PostgresReleaseOidcMutationError),
      });
      tainted(value);
      expect(value.query.mock.calls.some(([sql]) => sql.includes("clock_timestamp()"))).toBe(false);
    },
  );
  it.each(["sessionGuards", "bindingGuards"] as const)(
    "rejects nonboolean native %s",
    async (field) => {
      const value = await fixture();
      value.state[field] = [{ acquired: "true" }];
      await expect(value.run()).rejects.toBeInstanceOf(ReleaseDecisionVerificationBudgetError);
      tainted(value);
    },
  );
  it.each([
    "initial_missing",
    "foreign_actor",
    "later_missing",
    "later_changed",
    "binding_missing",
  ])("retains conservative source failure %s", async (kind) => {
    const value = await fixture();
    if (kind === "initial_missing") value.state.sessionRows[0] = [];
    if (kind === "foreign_actor")
      value.state.sessionRows[0] = [{ ...session, principal_id: "user_foreign" }];
    if (kind === "later_missing") value.state.sessionRows[1] = [];
    if (kind === "later_changed")
      value.state.sessionRows[1] = [
        {
          ...session,
          use_count: 1,
          last_used_at: "2026-10-16T09:01:00.000123Z",
          idle_expires_at: "2026-10-16T09:31:00.000123Z",
        },
      ];
    if (kind === "binding_missing") value.state.bindings = [];
    await expect(value.run()).rejects.toBeInstanceOf(ReleaseDecisionVerificationBudgetError);
    tainted(value);
  });
  it.each(["inactive", "capability", "scope", "revoked", "expired", "future", "receipt_changed"])(
    "refuses current %s after real authentication",
    async (kind) => {
      const value = await fixture();
      if (kind === "inactive") value.state.bindings = [{ ...binding, inactive: true }];
      if (kind === "capability")
        value.state.bindings = [{ ...binding, capabilities: ["release:read"] }];
      if (kind === "scope")
        value.state.bindings = [
          {
            ...binding,
            resource_scope: { mode: "restricted", projects: [{ projectId: "project_other" }] },
          },
        ];
      let changed = structuredClone(session) as Row;
      if (kind === "revoked")
        changed = {
          ...session,
          revoked_at: "2026-10-16T09:05:00.000123Z",
          revocation_reason: "logout",
        };
      if (kind === "expired") value.state.clocks = [{ captured_at: session.idle_expires_at }];
      if (kind === "future")
        value.state.bindings = [{ ...binding, updated_at: "2026-10-16T09:11:00.000123Z" }];
      if (kind === "receipt_changed")
        changed = { ...session, created_at: "2026-10-16T09:00:00.001123Z" };
      value.state.sessionRows = [[changed], [changed]];
      await expect(value.run()).rejects.toBeInstanceOf(ReleaseDecisionVerificationBudgetError);
      tainted(value);
    },
  );
  it.each([
    { rows: [] },
    { rows: [{ captured_at: null }] },
    { rows: [{ captured_at: "2026-10-16T09:10:00.123Z" }] },
    { rows: [{ captured_at: "2026-02-30T09:10:00.123456Z" }] },
    {
      rows: [
        { captured_at: "2026-10-16T09:10:00.123456Z" },
        { captured_at: "2026-10-16T09:10:00.123456Z" },
      ],
    },
  ])("rejects invalid/ambiguous native clock %#", async ({ rows }) => {
    const value = await fixture();
    value.state.clocks = rows;
    await expect(value.run()).rejects.toBeInstanceOf(ReleaseDecisionVerificationBudgetError);
    tainted(value);
  });
  it.each([
    "transaction_isolation",
    "try_lock_release_oidc_source",
    "FROM public.proofstack_browser_sessions",
    "FROM public.proofstack_oidc_bindings",
    "clock_timestamp()",
  ])("preserves and taints an actual failed SQL read %s", async (sql) => {
    const value = await fixture();
    value.state.failAt = sql;
    await expect(value.run()).rejects.toMatchObject({ cause: value.state.failure });
    tainted(value);
  });
  it("admits exact aggregate counts/bytes and rejects either one below without refreshing the original meter", async () => {
    const reference = await fixture();
    await reference.run();
    const usage = reference.input.budget.snapshot();
    for (const [records, bytes, accepted] of [
      [usage.records, usage.recordBytes, true],
      [usage.records - 1, usage.recordBytes, false],
      [usage.records, usage.recordBytes - 1, false],
    ] as const) {
      const value = await fixture();
      value.input.budget = new ReleaseDecisionVerificationBudget({
        ...limits,
        maxAcquisitionRecords: records,
        maxAcquisitionRecordBytes: bytes,
      });
      if (accepted) {
        await value.run();
        expect(value.input.budget.snapshot()).toEqual(usage);
      } else {
        await expect(value.run()).rejects.toBeInstanceOf(ReleaseDecisionVerificationBudgetError);
        tainted(value);
      }
    }
  });
  it("rejects a forged proof, foreign request and foreign operation before database I/O", async () => {
    const value = await fixture();
    await expect(
      recheckPostgresReleaseOidcMutationOnClient(value.client, {
        ...value.input,
        authentication: {} as never,
      }),
    ).rejects.toBeInstanceOf(InvalidReleaseMutationAuthenticationError);
    await expect(
      recheckPostgresReleaseOidcMutationOnClient(value.client, {
        ...value.input,
        requestId: "request_foreign",
      }),
    ).rejects.toBeInstanceOf(InvalidReleaseMutationAuthenticationError);
    await expect(
      recheckPostgresReleaseOidcMutationOnClient(value.client, {
        ...value.input,
        operation: "publish_decision",
      }),
    ).rejects.toBeInstanceOf(InvalidReleaseMutationAuthenticationError);
    expect(value.query).not.toHaveBeenCalled();
  });
  it("does not let a fake or already-tainted meter start source I/O", async () => {
    const value = await fixture();
    await expect(
      recheckPostgresReleaseOidcMutationOnClient(value.client, {
        ...value.input,
        budget: {} as never,
      }),
    ).rejects.toBeInstanceOf(PostgresReleaseOidcMutationError);
    const error = new Error("earlier owning failure");
    expect(() => value.input.budget.rejectSourceRead(error)).toThrow();
    await expect(value.run()).rejects.toMatchObject({ cause: error });
    expect(value.query).not.toHaveBeenCalled();
  });
  it("rejects an actually authenticated private service publisher before browser-source I/O", async () => {
    const value = await fixture();
    const token = generateServiceToken();
    const passwordHash = await hashServiceTokenSecret(token.secret);
    const authenticators = new ReleaseMutationAuthenticator(
      new OidcSessionAuthenticator({
        async findAndTouchActive() {
          return null;
        },
      }),
      new ServiceTokenAuthenticator({
        async findActiveServiceByPrefix() {
          return {
            kind: "service_token",
            authenticatedAt: "2026-10-16T09:00:00.000Z",
            credentialId: "service_credential_native",
            prefix: token.prefix,
            passwordHash,
            principalId: "service_native_publisher",
            tenantId: scope.tenantId,
            capabilities: ["release:decision:publish"],
            resourceScope: { mode: "tenant" },
          };
        },
        async confirmActiveServiceUse() {
          return true;
        },
      }),
    );
    const authentication = await authenticators.authenticateServiceDecisionPublisher({
      serviceToken: token.value,
      requestId: value.input.requestId,
      scope,
    });
    await expect(
      recheckPostgresReleaseOidcMutationOnClient(value.client, {
        ...value.input,
        authentication,
        operation: "publish_decision",
      }),
    ).rejects.toBeInstanceOf(PostgresReleaseOidcMutationError);
    expect(value.query).not.toHaveBeenCalled();
  });
});
