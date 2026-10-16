import { isDeepStrictEqual } from "node:util";
import {
  EvidenceScopeSchema,
  OpaqueIdSchema,
  UtcMillisecondTimestampSchema,
  ReleaseDecisionIdentityGrantSchema,
  ReleaseDecisionServiceCredentialStateSchema,
  ResourceScopeSchema,
  policyEvaluationTimestampOrderKey,
  type EvidenceScope,
} from "@proofstack/contracts";
import {
  ReleaseDecisionVerificationBudget,
  inspectCapturedReleaseIdentityState,
} from "@proofstack/core";
import {
  readReleaseMutationAuthentication,
  type AuthenticatableServiceToken,
  type ReleaseMutationAuthentication,
  type ServiceTokenCredentialLookup,
  type ServiceTokenPasswordHash,
  type ServiceTokenUseConfirmation,
} from "@proofstack/identity";
import type { Pool, PoolClient } from "pg";

type Client = Pick<PoolClient, "query">;
const capability = "release:decision:publish" as const;
export class PostgresReleaseServiceCredentialError extends Error {
  readonly code = "release_service_credential_invalid";
  constructor() {
    // Never include a raw credential row, verifier, prefix, secret or underlying query error.
    super("Private release service credential was rejected");
    this.name = "PostgresReleaseServiceCredentialError";
  }
}
function fail(): never {
  throw new PostgresReleaseServiceCredentialError();
}
function object(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail();
  return raw as Record<string, unknown>;
}
function canonical(value: unknown, bytes: number) {
  if (
    typeof value !== "string" ||
    value.length !== Math.ceil((bytes * 8) / 6) ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  )
    fail();
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length !== bytes || decoded.toString("base64url") !== value) fail();
  return value;
}
function hash(raw: unknown): ServiceTokenPasswordHash {
  const row = object(raw);
  const expected: ServiceTokenPasswordHash = {
    algorithm: "scrypt-v1",
    blockSize: 8,
    cost: 32768,
    keyLength: 32,
    parallelization: 1,
    digest: canonical(row["digest"], 32),
    salt: canonical(row["salt"], 16),
  };
  if (!isDeepStrictEqual(row, expected)) fail();
  return expected;
}
function resourceScope(raw: unknown) {
  const parsed = ResourceScopeSchema.safeParse(raw);
  if (
    !parsed.success ||
    parsed.data.mode !== "restricted" ||
    parsed.data.projects.some((p) => !p.environmentIds)
  )
    fail();
  return parsed.data;
}
function credentialBody(raw: unknown, prefix: string): ServiceTokenUseConfirmation {
  const row = object(raw);
  if (
    row["kind"] !== "service_token" ||
    row["prefix"] !== prefix ||
    !isDeepStrictEqual(row["capabilities"], [capability])
  )
    fail();
  const value: ServiceTokenUseConfirmation = {
    kind: "service_token",
    credentialId: OpaqueIdSchema.parse(row["credentialId"]),
    prefix,
    passwordHash: hash(row["passwordHash"]),
    principalId: OpaqueIdSchema.parse(row["principalId"]),
    tenantId: OpaqueIdSchema.parse(row["tenantId"]),
    capabilities: [capability],
    resourceScope: resourceScope(row["resourceScope"]),
  };
  if (!isDeepStrictEqual(value, row)) fail();
  return value;
}
function authentication(raw: unknown, prefix: string): AuthenticatableServiceToken {
  const { authenticatedAt, ...body } = object(raw);
  return {
    ...credentialBody(body, prefix),
    authenticatedAt: UtcMillisecondTimestampSchema.parse(authenticatedAt),
  };
}

/** Private publisher profile only. This pool gets fixed authentication functions, never a
 * delegated workload credential, human approval power or arbitrary principal-producing callback.
 * Native grants are installed separately; the administrative test pool is not a runtime role.
 */
export class PostgresReleaseServiceCredentialRepository implements ServiceTokenCredentialLookup {
  constructor(private readonly pool: Pick<Pool, "query">) {}
  async findActiveServiceByPrefix(input: string): Promise<AuthenticatableServiceToken | null> {
    const prefix = canonical(input, 16);
    try {
      const result = await this.pool.query<{ value: unknown }>(
        "SELECT public.proofstack_find_active_release_service_credential($1) AS value",
        [prefix],
      );
      if (result.rows.length !== 1) fail();
      const value = result.rows[0]?.value;
      return value === null ? null : authentication(value, prefix);
    } catch {
      return fail();
    }
  }
  async confirmActiveServiceUse(input: ServiceTokenUseConfirmation): Promise<boolean> {
    try {
      const body = credentialBody(input, canonical(input.prefix, 16));
      const result = await this.pool.query<{ value: unknown }>(
        "SELECT public.proofstack_confirm_release_service_use($1::jsonb) AS value",
        [JSON.stringify(body)],
      );
      if (result.rows.length !== 1 || typeof result.rows[0]?.value !== "boolean") fail();
      return result.rows[0].value;
    } catch {
      return fail();
    }
  }
}

/** Secret-free original/native state on a supplied scoped client. No authentication or transaction. */
export async function readPostgresReleaseServiceCredentialOnClient(
  client: Client,
  scopeInput: EvidenceScope,
  idInput: string,
  budget: ReleaseDecisionVerificationBudget,
) {
  if (!(budget instanceof ReleaseDecisionVerificationBudget)) fail();
  budget.snapshot();
  try {
    const scope = EvidenceScopeSchema.parse(scopeInput),
      id = OpaqueIdSchema.parse(idInput);
    const result = await client.query(
      `SELECT tenant_id,credential_id,principal_id,resource_scope,
      created_at_lexical,expires_at_lexical,created_at_key::text,expires_at_key::text,
      revoked_at_lexical,revoked_at_key::text,revocation_reason
      FROM public.proofstack_release_service_credentials WHERE tenant_id=$1 AND credential_id=$2`,
      [scope.tenantId, id],
    );
    for (const row of result.rows) budget.observe(row);
    if (result.rows.length > 1) fail();
    const raw = result.rows[0];
    if (!raw) {
      budget.observe({ scope, credentialId: id, state: "missing" });
      return null;
    }
    const credential = ReleaseDecisionServiceCredentialStateSchema.parse({
      schemaVersion: "0.1",
      kind: "service_credential",
      tenantId: raw.tenant_id,
      credentialId: raw.credential_id,
      principalId: raw.principal_id,
      createdAt: raw.created_at_lexical,
      expiresAt: raw.expires_at_lexical,
      revokedAt: raw.revoked_at_lexical,
      revocationReason: raw.revocation_reason,
    });
    if (
      credential.tenantId !== scope.tenantId ||
      credential.credentialId !== id ||
      raw.created_at_key !== policyEvaluationTimestampOrderKey(credential.createdAt).toString() ||
      raw.expires_at_key !== policyEvaluationTimestampOrderKey(credential.expiresAt).toString() ||
      raw.revoked_at_key !==
        (credential.revokedAt === null
          ? null
          : policyEvaluationTimestampOrderKey(credential.revokedAt).toString())
    )
      fail();
    const grant = ReleaseDecisionIdentityGrantSchema.parse({
      identity: {
        kind: "service_credential",
        principalId: credential.principalId,
        credentialId: id,
      },
      tenantId: scope.tenantId,
      state: credential.revokedAt === null ? "active" : "inactive",
      capabilities: [capability],
      roles: ["member"],
      resourceScope: resourceScope(raw.resource_scope),
      revision: credential.revokedAt === null ? 1 : 2,
      updatedAt: credential.revokedAt ?? credential.createdAt,
    });
    return { grant, credential };
  } catch (cause) {
    return budget.rejectSourceRead(cause);
  }
}

/** Actual private service authentication plus current held native identity. No installation,
 * reviewer, complete source authority, reusable publication seal or decision is supplied here.
 */
export async function recheckPostgresReleaseServicePublisherOnClient(
  client: Client,
  input: {
    readonly authentication: ReleaseMutationAuthentication;
    readonly scope: EvidenceScope;
    readonly requestId: string;
    readonly budget: ReleaseDecisionVerificationBudget;
  },
) {
  const state = readReleaseMutationAuthentication(input.authentication, {
    ...input,
    operation: "publish_decision",
  });
  if (
    state.receipt.principalType !== "service" ||
    !(input.budget instanceof ReleaseDecisionVerificationBudget)
  )
    fail();
  const budget = input.budget;
  budget.snapshot();
  try {
    const context = await client.query(
      "SELECT current_setting('proofstack.tenant_id',true) AS tenant_id,current_setting('proofstack.project_id',true) AS project_id,current_setting('proofstack.environment_id',true) AS environment_id,current_setting('transaction_isolation') AS isolation",
    );
    for (const raw of context.rows) budget.observe(raw);
    if (
      !isDeepStrictEqual(context.rows, [
        {
          tenant_id: input.scope.tenantId,
          project_id: input.scope.projectId,
          environment_id: input.scope.environmentId,
          isolation: "read committed",
        },
      ])
    )
      fail();
    const guarded = await client.query<{ acquired: unknown }>(
      "SELECT public.proofstack_try_lock_release_service_credential($1::jsonb,$2) AS acquired",
      [JSON.stringify(state.scope), state.receipt.credentialId],
    );
    for (const raw of guarded.rows) budget.observe(raw);
    if (guarded.rows.length !== 1 || guarded.rows[0]?.acquired !== true) fail();
    const observed = await readPostgresReleaseServiceCredentialOnClient(
      client,
      state.scope,
      state.receipt.credentialId,
      budget,
    );
    if (!observed || observed.credential.principalId !== state.receipt.principalId) fail();
    const clock = await client.query(
      `SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS captured_at`,
    );
    for (const raw of clock.rows) budget.observe(raw);
    const capturedAt = clock.rows[0]?.captured_at;
    if (
      clock.rows.length !== 1 ||
      typeof capturedAt !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(capturedAt)
    )
      fail();
    const eligibility = inspectCapturedReleaseIdentityState({
      scope: state.scope,
      receipt: state.receipt,
      identity: observed.grant.identity,
      grant: { state: "observed", reference: observed.grant.identity, record: observed.grant },
      credential: {
        state: "observed",
        reference: {
          kind: "service_credential",
          principalId: state.receipt.principalId,
          credentialId: state.receipt.credentialId,
        },
        record: observed.credential,
      },
      capturedAt,
      operation: "publish_decision",
      budget,
    });
    if (eligibility.state !== "eligible" || eligibility.credentialLimit === null) fail();
    return {
      receipt: state.receipt,
      ...observed,
      capturedAt,
      credentialLimit: eligibility.credentialLimit,
    };
  } catch (cause) {
    return budget.rejectSourceRead(cause);
  }
}
