import { createHash, randomUUID } from "node:crypto";
import {
  encodeReleasePolicyDefinition,
  encodeReleasePolicySelectionDefinition,
  encodeReleaseSelectionPublicationDefinition,
  serializeEvaluationCanonicalJson,
  ReleasePolicyDefinitionSchema,
  type EvidenceScope,
  type ReleaseSelectionPublicationMaterial,
} from "@proofstack/contracts";
import {
  releasePolicySelectionReference,
  ReleaseDecisionVerificationBudget,
  releasePolicyReference,
  prepareReleaseSelectionPublicationMaterial,
} from "@proofstack/core";
import {
  releasePolicySelectionRepositoryFixture,
  releasePolicyRepositoryFixture,
  releasePolicyLifecycleFixture,
  selectionVersion,
} from "@proofstack/core/testing";
import {
  generateBrowserSessionCredentials,
  oidcIdentityDigest,
  OidcSessionAuthenticator,
  ReleaseMutationAuthenticator,
} from "@proofstack/identity";
import { releaseSelectionInstallerConformanceCases } from "@proofstack/identity/testing";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateDatabase } from "./migration-runner.js";
import { loadBundledMigrations } from "./migrations.js";
import {
  assertReleaseInstallerSchemaOnClient,
  prepareReleaseInstallerSchema,
} from "./release-installer-schema.js";
import { PolicyWireClient } from "./policy-wire-admission.js";
import { PostgresOidcIdentityRepository } from "./postgres-oidc-identity-repository.js";
import { PostgresReleaseSelectionInstaller } from "./postgres-release-selection-installer.js";
import { PostgresReleasePolicyRepository } from "./postgres-release-policy-repository.js";
import { PostgresReleasePolicySelectionRepository } from "./postgres-release-policy-selection-repository.js";
import { readPostgresReleasePolicySelectionForInstallerOnClient } from "./postgres-release-policy-selection-repository.js";
import { provisionRuntimeRoles, type RuntimeRoleProvisioningOptions } from "./runtime-roles.js";

const databaseUrl = process.env["PROOFSTACK_TEST_DATABASE_URL"];
if (!databaseUrl) throw new Error("PROOFSTACK_TEST_DATABASE_URL is required");
const key = randomUUID().replaceAll("-", "").slice(0, 10);
const kinds = [
  "api",
  "artifact",
  "consumer",
  "evaluationWorker",
  "humanReviewer",
  "identity",
  "modelEvaluationWorker",
  "policyAuthor",
  "publisher",
  "replayWorker",
  "releaseAuthority",
] as const;
const roles = Object.fromEntries(
  kinds.map((kind) => [
    kind,
    { name: `ps_inst_${kind.toLowerCase()}_${key}`, password: `fixture-installer-${kind}-${key}` },
  ]),
) as unknown as RuntimeRoleProvisioningOptions & {
  releaseAuthority: { name: string; password: string };
};
const admin = new Pool({ connectionString: databaseUrl, max: 4 });
const url = new URL(databaseUrl);
url.username = roles.releaseAuthority.name;
url.password = roles.releaseAuthority.password;
const runtime = new Pool({
  connectionString: url.toString(),
  max: 2,
  connectionTimeoutMillis: 500,
  Client: PolicyWireClient,
} as ConstructorParameters<typeof Pool>[0]);
const identityRepository = new PostgresOidcIdentityRepository(admin);
const authenticator = new ReleaseMutationAuthenticator(
  new OidcSessionAuthenticator(identityRepository),
);
const service = new PostgresReleaseSelectionInstaller(runtime, authenticator);
const owningSelections = new PostgresReleasePolicySelectionRepository(admin);
let sequence = 0;
async function begin(client: PoolClient, scope: EvidenceScope) {
  await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
  await client.query(
    "SELECT set_config('proofstack.tenant_id',$1,true),set_config('proofstack.project_id',$2,true),set_config('proofstack.environment_id',$3,true)",
    [scope.tenantId, scope.projectId, scope.environmentId],
  );
}
async function fixture() {
  sequence++;
  const original = releasePolicySelectionRepositoryFixture(`inst_${key}_${sequence}`).original;
  const scope = { ...original.scope, tenantId: `tenant_inst_${key}_${sequence}` };
  const principalId = `user_inst_${key}_${sequence}`,
    bindingId = `binding_inst_${key}_${sequence}`,
    sessionId = `session_inst_${key}_${sequence}`;
  const issuer = "https://installer.example.test",
    subject = `${key}_${sequence}`;
  const client = await admin.connect();
  try {
    await begin(client, scope);
    await client.query(
      "SELECT * FROM public.proofstack_create_oidc_binding($1,$2,$3,$4,$5,$6,$7::text[],$8::text[],$9::jsonb,$10)",
      [
        scope.tenantId,
        bindingId,
        oidcIdentityDigest(issuer, subject),
        issuer,
        subject,
        principalId,
        ["member"],
        ["release:selection:manage"],
        JSON.stringify({ mode: "tenant" }),
        "user_fixture_installer",
      ],
    );
    await client.query("COMMIT");
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
  const secret = generateBrowserSessionCredentials();
  await identityRepository.create({
    bindingId,
    sessionId,
    ...secret,
    absoluteLifetimeSeconds: 3600,
    idleLifetimeSeconds: 1800,
  });
  const {
    schemaVersion: _v,
    definitionSha256: _h,
    publishedAt: _at,
    publishedByPrincipalId: _p,
    issuerPrincipalId: _i,
    scope: _s,
    ...intent
  } = original;
  return {
    scope,
    bindingId,
    principalId,
    sessionId,
    credentials: {
      scope,
      sessionToken: secret.sessionToken,
      csrfToken: secret.csrfToken,
      requestId: `request_inst_${key}_${sequence}`,
    },
    intent: {
      ...intent,
      mode: "observation_only" as const,
      policies: [],
      effectiveAt: "2026-01-01T00:00:00.000001Z",
      expiresAt: "2099-01-01T00:00:00.000001Z",
    },
  };
}
async function counts(scope: EvidenceScope) {
  return (
    await admin.query(
      "SELECT (SELECT count(*)::int FROM public.proofstack_release_policy_selections WHERE tenant_id=$1) AS sources,(SELECT count(*)::int FROM public.proofstack_release_selection_publications WHERE tenant_id=$1) AS origins,(SELECT count(*)::int FROM public.proofstack_outbox WHERE tenant_id=$1 AND aggregate_type='release_selection_publication') AS intents",
      [scope.tenantId],
    )
  ).rows[0];
}
/** Owner-only destructive fixture injection; never available to the runtime role. */
async function replaceIntent(scope: EvidenceScope, aggregate: string, payload: unknown) {
  const client = await admin.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role='replica'");
    await client.query(
      "UPDATE public.proofstack_outbox SET payload=$3::jsonb WHERE tenant_id=$1 AND aggregate_type='release_selection_publication' AND aggregate_id=$2",
      [scope.tenantId, aggregate, JSON.stringify(payload)],
    );
    await client.query("COMMIT");
  } catch (cause) {
    await client.query("ROLLBACK");
    throw cause;
  } finally {
    client.release();
  }
}
async function deleteInjectedIntent(scope: EvidenceScope, aggregate: string) {
  const client = await admin.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role='replica'");
    await client.query(
      "DELETE FROM public.proofstack_outbox WHERE tenant_id=$1 AND aggregate_type='release_selection_publication' AND aggregate_id=$2",
      [scope.tenantId, aggregate],
    );
    await client.query("COMMIT");
  } catch (cause) {
    await client.query("ROLLBACK");
    throw cause;
  } finally {
    client.release();
  }
}
beforeAll(async () => {
  expect((await admin.query("SELECT current_database() AS name")).rows[0]?.name).toBe(
    "proofstack_test",
  );
  await migrateDatabase(admin);
  await provisionRuntimeRoles(admin, roles);
});
afterAll(async () => {
  await runtime.end();
  for (const role of Object.values(roles)) {
    if (
      (
        await admin.query("SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=$1) AS present", [
          role.name,
        ])
      ).rows[0]?.present
    ) {
      await admin.query(`DROP OWNED BY "${role.name}"`);
      await admin.query(`DROP ROLE "${role.name}"`);
    }
  }
  await admin.end();
});

describe("actual authenticated native selection publication", () => {
  it("rejects a wrong role even when caller-owned temporary catalogs impersonate the installer", async () => {
    const f = await fixture(),
      wrongUrl = new URL(databaseUrl as string);
    wrongUrl.username = roles.api.name;
    wrongUrl.password = roles.api.password;
    const wrong = new Pool({ connectionString: wrongUrl.toString(), max: 1 });
    await admin.query(
      `GRANT EXECUTE ON FUNCTION public.proofstack_release_installer_context(jsonb) TO "${roles.api.name}"`,
    );
    const client = await wrong.connect();
    try {
      for (const shadow of [false, true]) {
        await begin(client, f.scope);
        try {
          if (shadow) {
            await client.query(
              "CREATE TEMP TABLE pg_roles AS SELECT oid,current_user::name AS rolname,rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,rolinherit FROM pg_catalog.pg_roles WHERE rolname=$1",
              [roles.releaseAuthority.name],
            );
            await client.query(
              "CREATE TEMP TABLE pg_auth_members AS SELECT * FROM pg_catalog.pg_auth_members WHERE false",
            );
          }
          await expect(
            client.query("SELECT public.proofstack_release_installer_context($1::jsonb)", [
              JSON.stringify(f.scope),
            ]),
          ).rejects.toMatchObject({ code: "42501" });
        } finally {
          await client.query("ROLLBACK");
        }
      }
    } finally {
      client.release();
      await wrong.end();
      await admin.query(
        `REVOKE EXECUTE ON FUNCTION public.proofstack_release_installer_context(jsonb) FROM "${roles.api.name}"`,
      );
    }
    expect(await counts(f.scope)).toEqual({ sources: 0, origins: 0, intents: 0 });
  });
  it("validates real schema catalogs despite temporary copies that hide installed drift", async () => {
    const f = await fixture(),
      client = await runtime.connect();
    const expected = prepareReleaseInstallerSchema(await loadBundledMigrations());
    try {
      await begin(client, f.scope);
      for (const table of ["pg_proc", "pg_namespace", "pg_language", "pg_class", "pg_trigger"])
        await client.query(`CREATE TEMP TABLE ${table} AS SELECT * FROM pg_catalog.${table}`);
      await client
        .query(
          "ALTER FUNCTION public.proofstack_read_selection_publication_part(jsonb,text,text,text) SET search_path=public",
        )
        .then(
          () => {
            throw new Error("Installer unexpectedly altered the installed routine");
          },
          (error: { code?: string }) => {
            expect(error.code).toBe("42501");
          },
        );
      await client.query("ROLLBACK");
      await begin(client, f.scope);
      for (const table of ["pg_proc", "pg_namespace", "pg_language", "pg_class", "pg_trigger"])
        await client.query(`CREATE TEMP TABLE ${table} AS SELECT * FROM pg_catalog.${table}`);
      await admin.query(
        "ALTER FUNCTION public.proofstack_read_selection_publication_part(jsonb,text,text,text) SET search_path=public",
      );
      // The old unqualified query reads the stale temporary copy and misses this real drift.
      const stale = await client.query(
        "SELECT proconfig FROM pg_proc WHERE oid='public.proofstack_read_selection_publication_part(jsonb,text,text,text)'::regprocedure",
      );
      const actual = await client.query(
        "SELECT proconfig FROM pg_catalog.pg_proc WHERE oid='public.proofstack_read_selection_publication_part(jsonb,text,text,text)'::regprocedure",
      );
      expect(stale.rows[0]?.proconfig).toEqual(["search_path=pg_catalog"]);
      expect(actual.rows[0]?.proconfig).toEqual(["search_path=public"]);
      await expect(
        assertReleaseInstallerSchemaOnClient(
          client,
          expected,
          new ReleaseDecisionVerificationBudget({
            maxAcquisitionRecords: 10000,
            maxAcquisitionRecordBytes: 16 * 1024 * 1024,
            maxApprovalRecords: 0,
          }),
        ),
      ).rejects.toBeDefined();
    } finally {
      await client.query("ROLLBACK");
      client.release();
      await admin.query(
        "ALTER FUNCTION public.proofstack_read_selection_publication_part(jsonb,text,text,text) SET search_path=pg_catalog",
      );
    }
    expect((await service.publishSelection(f.credentials, f.intent)).created).toBe(true);
  });
  for (const conformance of releaseSelectionInstallerConformanceCases) {
    it(conformance.name, async () => {
      let sessions = 0;
      await conformance.run(async () => {
        const f = await fixture();
        return {
          service,
          scope: f.scope,
          credentials: f.credentials,
          intent: f.intent,
          principalId: f.principalId,
          async login(requestId) {
            sessions++;
            const secret = generateBrowserSessionCredentials();
            await identityRepository.create({
              bindingId: f.bindingId,
              sessionId: `session_shared_${key}_${sequence}_${sessions}`,
              ...secret,
              absoluteLifetimeSeconds: 3600,
              idleLifetimeSeconds: 1800,
            });
            return {
              scope: f.scope,
              requestId,
              sessionToken: secret.sessionToken,
              csrfToken: secret.csrfToken,
            };
          },
          async changeCapabilities(capabilities) {
            const client = await admin.connect();
            try {
              await begin(client, f.scope);
              await client.query(
                "SELECT public.proofstack_update_oidc_binding($1,$2,$3::text[],$4::text[],$5::jsonb,$6)",
                [
                  f.scope.tenantId,
                  f.bindingId,
                  ["member"],
                  [...capabilities],
                  JSON.stringify({ mode: "tenant" }),
                  "user_fixture_installer",
                ],
              );
              await client.query("COMMIT");
            } finally {
              await client.query("ROLLBACK");
              client.release();
            }
          },
          readOriginal: (id) => owningSelections.findReleasePolicySelection(f.scope, id),
          async readPublication(kind, id) {
            const rows = await admin.query<{ value: ReleaseSelectionPublicationMaterial }>(
              "SELECT jsonb_build_object('publication',publication,'source',jsonb_build_object('kind',source_kind,'record',source_record),'grant',grant_record,'credential',credential_record) AS value FROM public.proofstack_release_selection_publications WHERE tenant_id=$1 AND project_id=$2 AND environment_id=$3 AND source_kind=$4 AND source_id=$5",
              [f.scope.tenantId, f.scope.projectId, f.scope.environmentId, kind, id],
            );
            return rows.rows[0]?.value ?? null;
          },
        };
      });
    });
  }
  it("publishes source/original safe provenance/intent atomically and preserves its exact retry receipt", async () => {
    const f = await fixture();
    const first = await service.publishSelection(f.credentials, f.intent);
    expect(first.created).toBe(true);
    expect(first.publication.actor.principalId).toBe(f.principalId);
    expect(first.publication.actor.credentialId).toBe(f.sessionId);
    expect(first.publication.issuedAt).toMatch(/\.[0-9]{6}Z$/);
    expect(first.record.scope).toEqual(f.scope);
    const again = await service.publishSelection(
      { ...f.credentials, requestId: "request_inst_retry" },
      f.intent,
    );
    expect(again.created).toBe(false);
    expect(again.record).toEqual(first.record);
    expect(again.publication).toEqual(first.publication);
    expect(await counts(f.scope)).toEqual({ sources: 1, origins: 1, intents: 1 });
  });
  it("records an authenticated withdrawal and preserves the original event on retry", async () => {
    const f = await fixture();
    const first = await service.publishSelection(f.credentials, f.intent);
    if (!("selectionVersionId" in first.record)) throw new Error("Expected selection");
    const intent = {
      eventId: `event_inst_${key}_${sequence}`,
      kind: "withdrawn",
      selection: releasePolicySelectionReference(first.record),
      reason: "Withdraw this exact authenticated installed selection.",
    };
    const event = await service.publishLifecycle(f.credentials, intent);
    expect(event.created).toBe(true);
    expect(event.publication.subject.kind).toBe("release_policy_selection_lifecycle");
    const again = await service.publishLifecycle(
      { ...f.credentials, requestId: "request_inst_event_retry" },
      intent,
    );
    expect(again.created).toBe(false);
    expect(again.record).toEqual(event.record);
    expect(again.publication).toEqual(event.publication);
    expect(await counts(f.scope)).toEqual({ sources: 1, origins: 2, intents: 2 });
  });
  it.each(["cookie", "csrf", "body_actor", "body_clock", "scope"])(
    "rejects %s without publishing",
    async (reason) => {
      const f = await fixture();
      const credentials = { ...f.credentials },
        intent: Record<string, unknown> = { ...f.intent };
      if (reason === "cookie") credentials.sessionToken = "invalid";
      if (reason === "csrf") credentials.csrfToken = "invalid";
      if (reason === "scope") credentials.scope = { ...f.scope, tenantId: "tenant_foreign" };
      if (reason === "body_actor") intent["issuerPrincipalId"] = f.principalId;
      if (reason === "body_clock") intent["publishedAt"] = "2099-01-01T00:00:00Z";
      await expect(service.publishSelection(credentials, intent)).rejects.toBeDefined();
      expect(await counts(f.scope)).toEqual({ sources: 0, origins: 0, intents: 0 });
    },
  );
  it("cannot commit a native source with an unfinished original authentication profile", async () => {
    const f = await fixture();
    const proof = await authenticator.authenticateSelectionInstaller(f.credentials);
    const { readReleaseMutationAuthentication } = await import("@proofstack/identity");
    const actor = readReleaseMutationAuthentication(proof, {
      operation: "manage_selection",
      scope: f.scope,
      requestId: f.credentials.requestId,
    }).receipt;
    const definition = { ...f.intent, scope: f.scope, issuerPrincipalId: actor.principalId };
    const client = await runtime.connect();
    try {
      await begin(client, f.scope);
      await client.query(
        "SELECT public.proofstack_begin_authenticated_selection($1::jsonb,$2::jsonb,$3,$4::jsonb)",
        [
          JSON.stringify(f.scope),
          JSON.stringify(definition),
          Buffer.from(
            encodeReleasePolicySelectionDefinition({ scope: f.scope, definition }),
          ).toString("utf8"),
          JSON.stringify(actor),
        ],
      );
      await expect(client.query("COMMIT")).rejects.toMatchObject({ code: "23514" });
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
    expect(await counts(f.scope)).toEqual({ sources: 0, origins: 0, intents: 0 });
  });
  it("grants no direct graph, credential or worker authority to the installer role", async () => {
    const row = (
      await admin.query(
        "SELECT has_table_privilege($1,'public.proofstack_browser_sessions','SELECT') AS credential,has_table_privilege($1,'public.proofstack_release_policy_selections','INSERT') AS source,has_table_privilege($1,'public.proofstack_release_selection_publications','UPDATE') AS origin,has_function_privilege($1,'public.proofstack_store_release_policy_selection(jsonb,text)','EXECUTE') AS trusted",
        [roles.releaseAuthority.name],
      )
    ).rows[0];
    expect(row).toEqual({ credential: false, source: false, origin: false, trusted: false });
  });
  it("rejects an admin pool rather than silently using owner privileges", async () => {
    const f = await fixture();
    const unsafe = new Pool({
      connectionString: databaseUrl,
      max: 1,
      connectionTimeoutMillis: 500,
      Client: PolicyWireClient,
    } as ConstructorParameters<typeof Pool>[0]);
    try {
      await expect(
        new PostgresReleaseSelectionInstaller(unsafe, authenticator).publishSelection(
          f.credentials,
          f.intent,
        ),
      ).rejects.toBeDefined();
    } finally {
      await unsafe.end();
    }
    expect(await counts(f.scope)).toEqual({ sources: 0, origins: 0, intents: 0 });
  });
  it.each([
    "credential_read",
    "origin_write",
    "ledger_write",
    "approval_function",
    "schema_create",
    "sequence_usage",
    "public_read",
    "credential_column_read",
    "origin_column_insert",
    "origin_column_update",
    "origin_column_reference",
    "public_column_read",
    "ledger_grant_option",
    "function_grant_option",
    "database_create",
    "database_connect_grant_option",
    "database_temp_grant_option",
    "schema_usage_grant_option",
  ])("rejects effective %s privilege drift before source publication", async (kind) => {
    const f = await fixture(),
      role = `"${roles.releaseAuthority.name}"`;
    const permissions = {
      credential_read: [
        `GRANT SELECT ON public.proofstack_browser_sessions TO ${role}`,
        `REVOKE SELECT ON public.proofstack_browser_sessions FROM ${role}`,
      ],
      origin_write: [
        `GRANT INSERT ON public.proofstack_release_selection_publications TO ${role}`,
        `REVOKE INSERT ON public.proofstack_release_selection_publications FROM ${role}`,
      ],
      ledger_write: [
        `GRANT UPDATE ON public.proofstack_schema_migrations TO ${role}`,
        `REVOKE UPDATE ON public.proofstack_schema_migrations FROM ${role}`,
      ],
      approval_function: [
        `GRANT EXECUTE ON FUNCTION public.proofstack_store_release_approval(jsonb,text) TO ${role}`,
        `REVOKE EXECUTE ON FUNCTION public.proofstack_store_release_approval(jsonb,text) FROM ${role}`,
      ],
      schema_create: [
        `GRANT CREATE ON SCHEMA public TO ${role}`,
        `REVOKE CREATE ON SCHEMA public FROM ${role}`,
      ],
      sequence_usage: [
        `GRANT USAGE ON SEQUENCE public.proofstack_outbox_outbox_id_seq TO ${role}`,
        `REVOKE USAGE ON SEQUENCE public.proofstack_outbox_outbox_id_seq FROM ${role}`,
      ],
      public_read: [
        "GRANT SELECT ON public.proofstack_browser_sessions TO PUBLIC",
        "REVOKE SELECT ON public.proofstack_browser_sessions FROM PUBLIC",
      ],
      credential_column_read: [
        `GRANT SELECT(session_digest) ON public.proofstack_browser_sessions TO ${role}`,
        `REVOKE SELECT(session_digest) ON public.proofstack_browser_sessions FROM ${role}`,
      ],
      origin_column_insert: [
        `GRANT INSERT(publication) ON public.proofstack_release_selection_publications TO ${role}`,
        `REVOKE INSERT(publication) ON public.proofstack_release_selection_publications FROM ${role}`,
      ],
      origin_column_update: [
        `GRANT UPDATE(publication) ON public.proofstack_release_selection_publications TO ${role}`,
        `REVOKE UPDATE(publication) ON public.proofstack_release_selection_publications FROM ${role}`,
      ],
      origin_column_reference: [
        `GRANT REFERENCES(source_id) ON public.proofstack_release_selection_publications TO ${role}`,
        `REVOKE REFERENCES(source_id) ON public.proofstack_release_selection_publications FROM ${role}`,
      ],
      public_column_read: [
        "GRANT SELECT(session_digest) ON public.proofstack_browser_sessions TO PUBLIC",
        "REVOKE SELECT(session_digest) ON public.proofstack_browser_sessions FROM PUBLIC",
      ],
      ledger_grant_option: [
        `GRANT SELECT ON public.proofstack_schema_migrations TO ${role} WITH GRANT OPTION`,
        `REVOKE GRANT OPTION FOR SELECT ON public.proofstack_schema_migrations FROM ${role}`,
      ],
      function_grant_option: [
        `GRANT EXECUTE ON FUNCTION public.proofstack_recheck_release_installer(jsonb,jsonb) TO ${role} WITH GRANT OPTION`,
        `REVOKE GRANT OPTION FOR EXECUTE ON FUNCTION public.proofstack_recheck_release_installer(jsonb,jsonb) FROM ${role}`,
      ],
      database_create: [
        `GRANT CREATE ON DATABASE proofstack_test TO ${role}`,
        `REVOKE CREATE ON DATABASE proofstack_test FROM ${role}`,
      ],
      database_connect_grant_option: [
        `GRANT CONNECT ON DATABASE proofstack_test TO ${role} WITH GRANT OPTION`,
        `REVOKE GRANT OPTION FOR CONNECT ON DATABASE proofstack_test FROM ${role}`,
      ],
      database_temp_grant_option: [
        `GRANT TEMP ON DATABASE proofstack_test TO ${role} WITH GRANT OPTION`,
        `REVOKE GRANT OPTION FOR TEMP ON DATABASE proofstack_test FROM ${role}`,
      ],
      schema_usage_grant_option: [
        `GRANT USAGE ON SCHEMA public TO ${role} WITH GRANT OPTION`,
        `REVOKE GRANT OPTION FOR USAGE ON SCHEMA public FROM ${role}`,
      ],
    } as const;
    const pair = permissions[kind as keyof typeof permissions];
    try {
      await admin.query(pair[0]);
      await expect(service.publishSelection(f.credentials, f.intent)).rejects.toBeDefined();
    } finally {
      await admin.query(pair[1]);
    }
    expect(await counts(f.scope)).toEqual({ sources: 0, origins: 0, intents: 0 });
    // Restoring only the offending grant recovers readiness without rewriting the role/profile.
    expect((await service.publishSelection(f.credentials, f.intent)).created).toBe(true);
  });
  it.each(["table", "function"])(
    "rejects %s ownership after ordinary privileges are revoked",
    async (kind) => {
      const f = await fixture(),
        role = `"${roles.releaseAuthority.name}"`,
        name = `fixture_owned_${key}`;
      try {
        await admin.query(`GRANT CREATE ON SCHEMA public TO ${role}`);
        if (kind === "table") {
          await admin.query(`CREATE TABLE public."${name}"(value integer)`);
          await admin.query(`ALTER TABLE public."${name}" OWNER TO ${role}`);
          await admin.query(`REVOKE ALL ON public."${name}" FROM ${role}`);
        } else {
          await admin.query(
            `CREATE FUNCTION public."${name}"() RETURNS integer LANGUAGE sql AS 'SELECT 1'`,
          );
          await admin.query(`REVOKE ALL ON FUNCTION public."${name}"() FROM PUBLIC`);
          await admin.query(`ALTER FUNCTION public."${name}"() OWNER TO ${role}`);
          await admin.query(`REVOKE ALL ON FUNCTION public."${name}"() FROM ${role}`);
        }
        await admin.query(`REVOKE CREATE ON SCHEMA public FROM ${role}`);
        await expect(service.publishSelection(f.credentials, f.intent)).rejects.toBeDefined();
      } finally {
        await admin.query(`REVOKE CREATE ON SCHEMA public FROM ${role}`);
        if (kind === "table") await admin.query(`DROP TABLE IF EXISTS public."${name}"`);
        else await admin.query(`DROP FUNCTION IF EXISTS public."${name}"()`);
      }
      expect(await counts(f.scope)).toEqual({ sources: 0, origins: 0, intents: 0 });
      expect((await service.publishSelection(f.credentials, f.intent)).created).toBe(true);
    },
  );
  it.each(["events", "condition", "columns", "function_schema"])(
    "rejects changed trigger %s with unchanged name/enabled/deferred flags",
    async (kind) => {
      const f = await fixture();
      const triggerName =
        kind === "columns"
          ? "proofstack_release_selection_publication_guard"
          : "proofstack_release_selection_publication_complete";
      const original = (
        await admin.query(
          "SELECT pg_get_triggerdef(oid) AS definition FROM pg_trigger WHERE tgrelid='public.proofstack_release_selection_publications'::regclass AND tgname=$1",
          [triggerName],
        )
      ).rows[0]?.definition as string;
      const schema = `fixture_trigger_${key}`;
      try {
        if (kind === "function_schema") {
          await admin.query(`CREATE SCHEMA "${schema}"`);
          await admin.query(
            `CREATE FUNCTION "${schema}".proofstack_verify_selection_publication() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NEW; END'`,
          );
        }
        await admin.query(
          `DROP TRIGGER ${triggerName} ON public.proofstack_release_selection_publications`,
        );
        const events =
          kind === "events"
            ? "DELETE"
            : kind === "columns"
              ? "UPDATE OF completed"
              : "INSERT OR UPDATE";
        const condition = kind === "condition" ? "WHEN (false)" : "";
        const functionName =
          kind === "function_schema"
            ? `"${schema}".proofstack_verify_selection_publication`
            : "public.proofstack_verify_selection_publication";
        if (kind === "columns")
          await admin.query(
            "CREATE TRIGGER proofstack_release_selection_publication_guard BEFORE INSERT OR UPDATE OF completed OR DELETE ON public.proofstack_release_selection_publications FOR EACH ROW EXECUTE FUNCTION public.proofstack_guard_selection_publication()",
          );
        else
          await admin.query(
            `CREATE CONSTRAINT TRIGGER proofstack_release_selection_publication_complete AFTER ${events} ON public.proofstack_release_selection_publications DEFERRABLE INITIALLY DEFERRED FOR EACH ROW ${condition} EXECUTE FUNCTION ${functionName}()`,
          );
        await expect(service.publishSelection(f.credentials, f.intent)).rejects.toBeDefined();
      } finally {
        await admin.query(
          `DROP TRIGGER IF EXISTS ${triggerName} ON public.proofstack_release_selection_publications`,
        );
        await admin.query(original);
        if (kind === "function_schema") {
          await admin.query(`DROP FUNCTION "${schema}".proofstack_verify_selection_publication()`);
          await admin.query(`DROP SCHEMA "${schema}"`);
        }
      }
      expect(await counts(f.scope)).toEqual({ sources: 0, origins: 0, intents: 0 });
      expect((await service.publishSelection(f.credentials, f.intent)).created).toBe(true);
    },
  );
  it.each(["disabled_trigger", "changed_function", "changed_body", "disabled_rls"])(
    "rejects %s despite a matching migration ledger",
    async (change) => {
      const f = await fixture();
      const original = (
        await admin.query(
          "SELECT prosrc FROM pg_proc WHERE oid='public.proofstack_release_installer_context(jsonb)'::regprocedure",
        )
      ).rows[0]?.prosrc as string;
      const originalReadDefinition = (
        await admin.query(
          "SELECT pg_get_functiondef('public.proofstack_read_selection_publication_part(jsonb,text,text,text)'::regprocedure) AS definition",
        )
      ).rows[0]?.definition as string;
      try {
        if (change === "disabled_trigger")
          await admin.query(
            "ALTER TABLE public.proofstack_release_selection_publications DISABLE TRIGGER proofstack_release_selection_publication_complete",
          );
        if (change === "disabled_rls")
          await admin.query(
            "ALTER TABLE public.proofstack_release_selection_publications NO FORCE ROW LEVEL SECURITY",
          );
        if (change === "changed_function")
          await admin.query(
            "ALTER FUNCTION public.proofstack_read_selection_publication_part(jsonb,text,text,text) SET search_path=public",
          );
        if (change === "changed_body")
          await admin.query(
            originalReadDefinition.replace(
              "BEGIN\n",
              "BEGIN\n-- Deliberate harmless fixture drift\n",
            ),
          );
        await expect(service.publishSelection(f.credentials, f.intent)).rejects.toBeDefined();
      } finally {
        if (change === "disabled_trigger")
          await admin.query(
            "ALTER TABLE public.proofstack_release_selection_publications ENABLE TRIGGER proofstack_release_selection_publication_complete",
          );
        if (change === "disabled_rls")
          await admin.query(
            "ALTER TABLE public.proofstack_release_selection_publications FORCE ROW LEVEL SECURITY",
          );
        if (change === "changed_function")
          await admin.query(
            "ALTER FUNCTION public.proofstack_read_selection_publication_part(jsonb,text,text,text) SET search_path=pg_catalog",
          );
        if (change === "changed_body") await admin.query(originalReadDefinition);
      }
      expect(
        (
          await admin.query(
            "SELECT prosrc FROM pg_proc WHERE oid='public.proofstack_release_installer_context(jsonb)'::regprocedure",
          )
        ).rows[0]?.prosrc,
      ).toBe(original);
      expect(await counts(f.scope)).toEqual({ sources: 0, origins: 0, intents: 0 });
    },
  );
  it("rejects a missing canonical authentication intent on exact historical retry", async () => {
    const f = await fixture();
    const first = await service.publishSelection(f.credentials, f.intent);
    const aggregate = `rsp_${first.publication.definitionSha256.slice(0, 60)}`;
    const saved = (
      await admin.query(
        "SELECT payload FROM public.proofstack_outbox WHERE tenant_id=$1 AND aggregate_type='release_selection_publication' AND aggregate_id=$2",
        [f.scope.tenantId, aggregate],
      )
    ).rows[0]?.payload;
    try {
      await replaceIntent(f.scope, aggregate, {});
      await expect(service.publishSelection(f.credentials, f.intent)).rejects.toBeDefined();
    } finally {
      await replaceIntent(f.scope, aggregate, saved);
    }
    expect((await service.publishSelection(f.credentials, f.intent)).publication).toEqual(
      first.publication,
    );
  });
  it("never upgrades a historical trusted declaration into authenticated origin", async () => {
    const f = await fixture();
    const legacy = selectionVersion(
      { ...f.intent, scope: f.scope, issuerPrincipalId: f.principalId },
      {},
      "2026-01-01T00:00:00.000001Z",
    );
    const trusted = new PostgresReleasePolicySelectionRepository(admin);
    await trusted.publishReleasePolicySelection(legacy);
    await expect(service.publishSelection(f.credentials, f.intent)).rejects.toBeDefined();
    await expect(
      service.publishSelection(f.credentials, {
        ...f.intent,
        selectionVersionId: `version_new_${key}_${sequence}`,
        predecessor: releasePolicySelectionReference(legacy),
      }),
    ).rejects.toBeDefined();
    expect(await trusted.findReleasePolicySelection(f.scope, legacy.selectionVersionId)).toEqual(
      legacy,
    );
    expect(await counts(f.scope)).toEqual({ sources: 1, origins: 0, intents: 0 });
  });
  it("rejects changed current grants before publishing even on an exact retry", async () => {
    const f = await fixture();
    await service.publishSelection(f.credentials, f.intent);
    const client = await admin.connect();
    try {
      await begin(client, f.scope);
      await client.query(
        "SELECT public.proofstack_update_oidc_binding($1,$2,$3::text[],$4::text[],$5::jsonb,$6)",
        [
          f.scope.tenantId,
          f.bindingId,
          ["member"],
          ["release:read"],
          JSON.stringify({ mode: "tenant" }),
          "user_fixture_installer",
        ],
      );
      await client.query("COMMIT");
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
    await expect(service.publishSelection(f.credentials, f.intent)).rejects.toBeDefined();
    expect(await counts(f.scope)).toEqual({ sources: 1, origins: 1, intents: 1 });
  });
  it("holds identity guards until rollback and rejects a contending grant rewrite", async () => {
    const f = await fixture();
    const published = await service.publishSelection(f.credentials, f.intent);
    const client = await runtime.connect(),
      writer = await admin.connect();
    let mutation: Promise<unknown> | undefined;
    try {
      await begin(client, f.scope);
      await readPostgresReleasePolicySelectionForInstallerOnClient(
        client,
        f.scope,
        f.intent.selectionVersionId,
        new ReleaseDecisionVerificationBudget({
          maxAcquisitionRecords: 10000,
          maxAcquisitionRecordBytes: 16 * 1024 * 1024,
          maxApprovalRecords: 0,
        }),
      );
      await client.query(
        "SELECT public.proofstack_recheck_release_installer($1::jsonb,$2::jsonb)",
        [JSON.stringify(f.scope), JSON.stringify(published.publication.actor)],
      );
      await begin(writer, f.scope);
      await writer.query("SET LOCAL lock_timeout='250ms'");
      mutation = writer.query(
        "SELECT public.proofstack_update_oidc_binding($1,$2,$3::text[],$4::text[],$5::jsonb,$6)",
        [
          f.scope.tenantId,
          f.bindingId,
          ["member"],
          ["release:read"],
          JSON.stringify({ mode: "tenant" }),
          "user_fixture_installer",
        ],
      );
      await expect(mutation).rejects.toMatchObject({ code: "55P03" });
      await writer.query("ROLLBACK");
    } finally {
      if (mutation) await Promise.allSettled([mutation]);
      await writer.query("ROLLBACK");
      writer.release();
      await client.query("ROLLBACK");
      client.release();
    }
  });
  it("reuses owning normalized policy/lifecycle validation and preserves historical retry after withdrawal", async () => {
    const f = await fixture(),
      repository = new PostgresReleasePolicyRepository(admin);
    const template = releasePolicyRepositoryFixture(`inst_${key}_${sequence}`, f.scope);
    const {
      schemaVersion: _v,
      definitionSha256: _h,
      publishedAt: _at,
      publishedByPrincipalId: _p,
      scope: _scope,
      ...old
    } = template;
    const definition = ReleasePolicyDefinitionSchema.parse({
      ...old,
      installationBinding: { ...old.installationBinding, installationId: f.intent.installationId },
    });
    const policy = {
      ...template,
      ...definition,
      definitionSha256: createHash("sha256")
        .update(encodeReleasePolicyDefinition({ scope: f.scope, definition }))
        .digest("hex"),
    };
    await repository.publishReleasePolicy(policy);
    const intent = {
      ...f.intent,
      mode: policy.mode === "mandatory" ? ("enforce" as const) : ("observation_only" as const),
      policies: [{ policy: releasePolicyReference(policy), mode: policy.mode }],
    };
    const first = await service.publishSelection(f.credentials, intent);
    await repository.publishReleasePolicyLifecycleEvent(
      releasePolicyLifecycleFixture(`inst_${key}_${sequence}`, policy, {
        occurredAt: new Date().toISOString(),
      }),
    );
    const again = await service.publishSelection(f.credentials, intent);
    expect(again.created).toBe(false);
    expect(again.publication).toEqual(first.publication);
    await expect(
      service.publishSelection(f.credentials, {
        ...intent,
        selectionVersionId: `version_after_${key}_${sequence}`,
        predecessor: first.publication.subject.selection,
      }),
    ).rejects.toBeDefined();
    expect(await counts(f.scope)).toEqual({ sources: 1, origins: 1, intents: 1 });
  });
  it("retains separate original provenance for the same source IDs in three tenants", async () => {
    const fixtures = [await fixture(), await fixture(), await fixture()];
    const shared = fixtures[0]?.intent;
    if (!shared) throw new Error("Fixture missing");
    const digests = new Set<string>();
    for (const f of fixtures) {
      const result = await service.publishSelection(f.credentials, shared);
      expect(result.record.scope).toEqual(f.scope);
      expect(result.publication.actor.principalId).toBe(f.principalId);
      digests.add(result.publication.definitionSha256);
      expect(await counts(f.scope)).toEqual({ sources: 1, origins: 1, intents: 1 });
    }
    expect(digests.size).toBe(3);
  });
  it("concurrent identical requests create one source/profile/intent with no internal retry", async () => {
    const f = await fixture();
    const outcomes = await Promise.allSettled([
      service.publishSelection(f.credentials, f.intent),
      service.publishSelection(
        { ...f.credentials, requestId: "request_inst_concurrent" },
        f.intent,
      ),
    ]);
    const fulfilled = outcomes.filter((value) => value.status === "fulfilled");
    expect(fulfilled.length).toBeGreaterThan(0);
    expect(fulfilled.filter((value) => value.value.created)).toHaveLength(1);
    const retry = await service.publishSelection(f.credentials, f.intent);
    expect(retry.created).toBe(false);
    for (const value of fulfilled) expect(value.value.publication).toEqual(retry.publication);
    expect(await counts(f.scope)).toEqual({ sources: 1, origins: 1, intents: 1 });
  });
  it("publishes an exact authenticated successor and supersession without rewriting its root", async () => {
    const f = await fixture(),
      first = await service.publishSelection(f.credentials, f.intent);
    if (!("selectionVersionId" in first.record)) throw new Error("Expected selection");
    const second = await service.publishSelection(f.credentials, {
      ...f.intent,
      selectionVersionId: `version_successor_${key}_${sequence}`,
      predecessor: releasePolicySelectionReference(first.record),
    });
    if (!("selectionVersionId" in second.record)) throw new Error("Expected successor");
    const event = await service.publishLifecycle(f.credentials, {
      eventId: `event_successor_${key}_${sequence}`,
      kind: "superseded",
      selection: releasePolicySelectionReference(first.record),
      successor: releasePolicySelectionReference(second.record),
      reason: "Supersede this exact authenticated target selection.",
    });
    expect(event.created).toBe(true);
    expect((await service.publishSelection(f.credentials, f.intent)).record).toEqual(first.record);
    expect(await counts(f.scope)).toEqual({ sources: 2, origins: 3, intents: 3 });
  });
  it("rolls back the entire native source/profile when its canonical authentication intent conflicts", async () => {
    const f = await fixture();
    const proof = await authenticator.authenticateSelectionInstaller(f.credentials);
    const { readReleaseMutationAuthentication } = await import("@proofstack/identity");
    const actor = readReleaseMutationAuthentication(proof, {
      operation: "manage_selection",
      scope: f.scope,
      requestId: f.credentials.requestId,
    }).receipt;
    const definition = { ...f.intent, scope: f.scope, issuerPrincipalId: actor.principalId };
    const client = await runtime.connect();
    let aggregate: string | undefined;
    const failures: unknown[] = [];
    try {
      await begin(client, f.scope);
      await client.query(
        "SELECT public.proofstack_begin_authenticated_selection($1::jsonb,$2::jsonb,$3,$4::jsonb)",
        [
          JSON.stringify(f.scope),
          JSON.stringify(definition),
          Buffer.from(
            encodeReleasePolicySelectionDefinition({ scope: f.scope, definition }),
          ).toString("utf8"),
          JSON.stringify(actor),
        ],
      );
      const read = async (part: string) =>
        (
          await client.query(
            "SELECT public.proofstack_read_selection_publication_part($1::jsonb,$2,$3,$4) AS value",
            [
              JSON.stringify(f.scope),
              "release_policy_selection",
              f.intent.selectionVersionId,
              part,
            ],
          )
        ).rows[0]?.value;
      const header = await read("header");
      const material = prepareReleaseSelectionPublicationMaterial({
        scope: f.scope,
        source: await read("source"),
        actor: header.actor,
        identity: header.identity,
        grant: await read("grant"),
        credential: await read("credential"),
        issuedAt: header.issuedAt,
        budget: new ReleaseDecisionVerificationBudget({
          maxAcquisitionRecords: 10000,
          maxAcquisitionRecordBytes: 16 * 1024 * 1024,
          maxApprovalRecords: 0,
        }),
      });
      aggregate = `rsp_${material.publication.definitionSha256.slice(0, 60)}`;
      // Owner-only corruption injection in this disposable fixture. A normal writer correctly
      // waits behind the held metadata guard; bypass it here solely to exercise conflict rollback.
      const fault = await admin.connect();
      try {
        await fault.query("BEGIN");
        await fault.query("SET LOCAL lock_timeout='250ms'");
        await fault.query("SET LOCAL session_replication_role='replica'");
        await fault.query(
          "INSERT INTO public.proofstack_outbox(tenant_id,aggregate_type,aggregate_id,event_type,payload,schema_version,created_at) VALUES($1,'release_selection_publication',$2,'release.selection.authentication_recorded','{}'::jsonb,'0.1',$3::timestamptz)",
          [f.scope.tenantId, aggregate, material.publication.issuedAt],
        );
        await fault.query("COMMIT");
      } catch (cause) {
        await fault.query("ROLLBACK");
        throw cause;
      } finally {
        fault.release();
      }
      const {
        schemaVersion: _version,
        definitionSha256: _hash,
        ...profileDefinition
      } = material.publication;
      await expect(
        client.query(
          "SELECT public.proofstack_finish_selection_publication($1::jsonb,$2,$3,$4::jsonb,$5,$6,$7,$8)",
          [
            JSON.stringify(f.scope),
            "release_policy_selection",
            f.intent.selectionVersionId,
            JSON.stringify(material.publication),
            Buffer.from(
              encodeReleaseSelectionPublicationDefinition({
                scope: f.scope,
                definition: profileDefinition,
              }),
            ).toString("utf8"),
            serializeEvaluationCanonicalJson(material.source.record),
            serializeEvaluationCanonicalJson(material.grant),
            serializeEvaluationCanonicalJson(material.credential),
          ],
        ),
      ).rejects.toMatchObject({ code: "23505" });
      await client.query("ROLLBACK");
      expect(await counts(f.scope)).toEqual({ sources: 0, origins: 0, intents: 1 });
    } catch (cause) {
      failures.push(cause);
    } finally {
      const rollback = await Promise.allSettled([client.query("ROLLBACK")]);
      for (const result of rollback) if (result.status === "rejected") failures.push(result.reason);
      client.release();
      if (aggregate) {
        const cleanup = await Promise.allSettled([deleteInjectedIntent(f.scope, aggregate)]);
        for (const result of cleanup)
          if (result.status === "rejected") failures.push(result.reason);
      }
    }
    if (failures.length)
      throw new AggregateError(failures, "Native conflict fixture assertions or cleanup failed");
  });
});
