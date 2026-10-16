import { isDeepStrictEqual } from "node:util";
import { type EvidenceScope, PolicyEvaluationTimeSchema } from "@proofstack/contracts";
import {
  inspectCapturedReleaseIdentityState,
  ReleaseDecisionVerificationBudget,
  ReleaseDecisionVerificationBudgetError,
} from "@proofstack/core";
import {
  type ReleaseMutationAuthentication,
  type ReleaseMutationOperation,
  readReleaseMutationAuthentication,
} from "@proofstack/identity";
import type { PoolClient } from "pg";
import {
  readPostgresReleaseOidcBindingOnClient,
  readPostgresReleaseOidcSessionOnClient,
  tryPostgresReleaseOidcSourceGuardOnClient,
} from "./postgres-release-oidc-sources.js";

export class PostgresReleaseOidcMutationError extends Error {
  readonly code = "release_oidc_mutation_recheck_rejected";
  constructor() {
    super("Current guarded release OIDC mutation authentication was rejected");
    this.name = "PostgresReleaseOidcMutationError";
  }
}
function fail(): never {
  throw new PostgresReleaseOidcMutationError();
}
const contextSql = `SELECT current_setting('proofstack.tenant_id', true) AS tenant_id,
  current_setting('proofstack.project_id', true) AS project_id,
  current_setting('proofstack.environment_id', true) AS environment_id,
  current_setting('transaction_isolation') AS isolation`;

/** Fixed owning boundary on the caller's same scoped READ COMMITTED transaction. No transaction,
 * client, private credential, DML or callback is returned. Guards remain held until its transaction
 * ends; ANY failure requires whole rollback. This identity component is not complete current
 * installation/reviewer/source authority or an independently reusable publication seal.
 */
export async function recheckPostgresReleaseOidcMutationOnClient(
  client: Pick<PoolClient, "query">,
  input: {
    readonly authentication: ReleaseMutationAuthentication;
    readonly scope: EvidenceScope;
    readonly operation: ReleaseMutationOperation;
    readonly requestId: string;
    readonly budget: ReleaseDecisionVerificationBudget;
  },
) {
  // Reject a caller receipt, foreign request or private service proof before any database I/O.
  const authenticated = readReleaseMutationAuthentication(input.authentication, input);
  if (
    authenticated.receipt.principalType !== "user" ||
    !(input.budget instanceof ReleaseDecisionVerificationBudget)
  )
    fail();
  const { scope, receipt } = authenticated;
  const budget = input.budget;
  budget.snapshot();
  try {
    const context = await client.query(contextSql);
    for (const row of context.rows) budget.observe(row);
    const row = context.rows[0];
    if (
      context.rows.length !== 1 ||
      !row ||
      row.tenant_id !== scope.tenantId ||
      row.project_id !== scope.projectId ||
      row.environment_id !== scope.environmentId ||
      row.isolation !== "read committed"
    )
      fail();
    const guard = async (kind: "oidc_session" | "oidc_binding", id: string) => {
      const acquired = await tryPostgresReleaseOidcSourceGuardOnClient(client, kind, id);
      budget.observe({ kind, id, acquired });
      if (!acquired) fail();
    };
    await guard("oidc_session", receipt.credentialId);
    const first = await readPostgresReleaseOidcSessionOnClient(
      client,
      scope,
      receipt.credentialId,
      budget,
    );
    if (!first || first.principalId !== receipt.principalId) fail();
    await guard("oidc_binding", first.bindingId);
    // Re-read complete session and owning grant after ALL derived OIDC guards are held.
    const session = await readPostgresReleaseOidcSessionOnClient(
      client,
      scope,
      receipt.credentialId,
      budget,
    );
    const grant = await readPostgresReleaseOidcBindingOnClient(
      client,
      scope,
      first.bindingId,
      budget,
    );
    if (!session || !grant || !isDeepStrictEqual(first, session)) fail();
    const clock = await client.query(`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS captured_at`);
    for (const value of clock.rows) budget.observe(value);
    const at: unknown = clock.rows[0]?.captured_at;
    if (
      clock.rows.length !== 1 ||
      typeof at !== "string" ||
      !/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z$/.test(at)
    )
      fail();
    const capturedAt = PolicyEvaluationTimeSchema.parse(at);
    const identity = grant.identity;
    const observedGrant = { reference: identity, state: "observed" as const, record: grant };
    const credential = {
      reference: {
        kind: "oidc_session" as const,
        principalId: receipt.principalId,
        credentialId: receipt.credentialId,
      },
      state: "observed" as const,
      record: session,
    };
    const eligibility = inspectCapturedReleaseIdentityState({
      scope,
      receipt,
      identity,
      grant: observedGrant,
      credential,
      capturedAt,
      operation: input.operation === "record_approval" ? "create_approval" : input.operation,
      budget,
    });
    if (eligibility.state !== "eligible" || eligibility.credentialLimit === null) fail();
    return {
      receipt,
      capturedAt,
      identity,
      grant: observedGrant,
      credential,
      credentialExpiresAt: eligibility.credentialLimit,
    };
  } catch (cause) {
    if (cause instanceof ReleaseDecisionVerificationBudgetError) throw cause;
    return budget.rejectSourceRead(cause);
  }
}
