import { randomUUID } from "node:crypto";
import {
  encodeReleaseReviewerAuthorityDefinition,
  encodeReleaseReviewerPublicationDefinition,
  serializeEvaluationCanonicalJson,
  MAX_RELEASE_REVIEWER_AUTHORITY_REQUEST_BYTES,
  type Capability,
  type EvidenceScope,
  type ReleaseReviewerPublicationMaterial,
} from "@proofstack/contracts";
import {
  ReleaseDecisionVerificationBudget,
  releaseReviewerAuthorityReference,
  validateReleaseReviewerPublicationMaterial,
  prepareReleaseReviewerPublicationMaterial,
} from "@proofstack/core";
import {
  authorityVersion,
  releaseReviewerAuthorityRepositoryFixture,
} from "@proofstack/core/testing";
import {
  generateBrowserSessionCredentials,
  browserSessionDigest,
  oidcIdentityDigest,
  OidcSessionAuthenticator,
  ReleaseMutationAuthenticator,
  readReleaseMutationAuthentication,
} from "@proofstack/identity";
import { releaseReviewerAdministratorConformanceCases } from "@proofstack/identity/testing";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateDatabase } from "./migration-runner.js";
import { PolicyWireClient } from "./policy-wire-admission.js";
import { PostgresOidcIdentityRepository } from "./postgres-oidc-identity-repository.js";
import { PostgresReleaseReviewerAdministrator } from "./postgres-release-reviewer-administrator.js";
import { PostgresReleaseReviewerAuthorityRepository } from "./postgres-release-reviewer-authority-repository.js";
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
  "reviewerAuthority",
] as const;
const roles = Object.fromEntries(
  kinds.map((kind) => [
    kind,
    { name: `ps_radm_${kind.toLowerCase()}_${key}`, password: randomUUID() },
  ]),
) as unknown as RuntimeRoleProvisioningOptions & {
  reviewerAuthority: { name: string; password: string };
};
const admin = new Pool({ connectionString: databaseUrl, max: 4 });
const runtimeUrl = new URL(databaseUrl);
runtimeUrl.username = roles.reviewerAuthority.name;
runtimeUrl.password = roles.reviewerAuthority.password;
const runtime = new Pool({
  connectionString: runtimeUrl.toString(),
  max: 2,
  connectionTimeoutMillis: 500,
  Client: PolicyWireClient,
} as ConstructorParameters<typeof Pool>[0]);
const identities = new PostgresOidcIdentityRepository(admin);
const authentication = new ReleaseMutationAuthenticator(new OidcSessionAuthenticator(identities));
const service = new PostgresReleaseReviewerAdministrator(runtime, authentication);
const repository = new PostgresReleaseReviewerAuthorityRepository(admin);
const meter = () =>
  new ReleaseDecisionVerificationBudget({
    maxAcquisitionRecords: 10000,
    maxAcquisitionRecordBytes: 16 * 1024 * 1024,
    maxApprovalRecords: 0,
  });
let sequence = 0;
async function begin(client: PoolClient, scope: EvidenceScope) {
  await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
  await client.query(
    "SELECT set_config('proofstack.tenant_id',$1,true),set_config('proofstack.project_id',$2,true),set_config('proofstack.environment_id',$3,true)",
    [scope.tenantId, scope.projectId, scope.environmentId],
  );
}
async function fixture() {
  const id = `${key}_${++sequence}`;
  const original = releaseReviewerAuthorityRepositoryFixture(`radm_${id}`).original;
  const scope = { ...original.scope, tenantId: `tenant_radm_${id}` };
  const principalId = `user_radm_${id}`,
    bindingId = `binding_radm_${id}`;
  const client = await admin.connect();
  try {
    await begin(client, scope);
    await client.query(
      "SELECT * FROM public.proofstack_create_oidc_binding($1,$2,$3,$4,$5,$6,$7::text[],$8::text[],$9::jsonb,$10)",
      [
        scope.tenantId,
        bindingId,
        oidcIdentityDigest("https://reviewer-admin.example.test", id),
        "https://reviewer-admin.example.test",
        id,
        principalId,
        ["member"],
        ["approval:authority:manage"],
        JSON.stringify({ mode: "tenant" }),
        "user_fixture_reviewer_admin",
      ],
    );
    await client.query("COMMIT");
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
  let logins = 0;
  async function login(requestId: string) {
    const secret = generateBrowserSessionCredentials();
    await identities.create({
      bindingId,
      sessionId: `session_radm_${id}_${++logins}`,
      ...secret,
      absoluteLifetimeSeconds: 3600,
      idleLifetimeSeconds: 1800,
    });
    return { scope, requestId, sessionToken: secret.sessionToken, csrfToken: secret.csrfToken };
  }
  const {
    schemaVersion: _v,
    definitionSha256: _h,
    publishedAt: _at,
    publishedByPrincipalId: _p,
    scope: _s,
    issuerPrincipalId: _i,
    ...intent
  } = original;
  return {
    service,
    scope,
    bindingId,
    principalId,
    intent: { ...intent, expiresAt: "2099-01-01T00:00:00.000001Z" },
    credentials: await login(`request_radm_${id}`),
    login,
    async changeCapabilities(capabilities: readonly Capability[]) {
      const client = await admin.connect();
      try {
        await begin(client, scope);
        await client.query(
          "SELECT public.proofstack_update_oidc_binding($1,$2,$3::text[],$4::text[],$5::jsonb,$6)",
          [
            scope.tenantId,
            bindingId,
            ["member"],
            capabilities,
            JSON.stringify({ mode: "tenant" }),
            "user_fixture_reviewer_admin",
          ],
        );
        await client.query("COMMIT");
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    },
    readOriginal: (versionId: string) => repository.findReleaseReviewerAuthority(scope, versionId),
    async readPublication(
      kind: ReleaseReviewerPublicationMaterial["source"]["kind"],
      sourceId: string,
    ) {
      const result = await admin.query(
        "SELECT publication,source_record,grant_record,credential_record FROM public.proofstack_release_reviewer_publications WHERE tenant_id=$1 AND project_id=$2 AND environment_id=$3 AND source_kind=$4 AND source_id=$5",
        [scope.tenantId, scope.projectId, scope.environmentId, kind, sourceId],
      );
      const value = result.rows[0];
      return value
        ? validateReleaseReviewerPublicationMaterial(
            {
              publication: value.publication,
              source: { kind, record: value.source_record },
              grant: value.grant_record,
              credential: value.credential_record,
            },
            meter(),
          )
        : null;
    },
  };
}
async function counts(scope: EvidenceScope) {
  return (
    await admin.query(
      "SELECT (SELECT count(*)::int FROM public.proofstack_release_reviewer_authorities WHERE tenant_id=$1) AS sources,(SELECT count(*)::int FROM public.proofstack_release_reviewer_publications WHERE tenant_id=$1) AS origins,(SELECT count(*)::int FROM public.proofstack_outbox WHERE tenant_id=$1 AND aggregate_type='release_reviewer_publication') AS intents",
      [scope.tenantId],
    )
  ).rows[0];
}
async function pending(f: Awaited<ReturnType<typeof fixture>>) {
  const proof = await authentication.authenticateReviewerAuthorityAdministrator(f.credentials);
  const actor = readReleaseMutationAuthentication(proof, {
    operation: "manage_reviewer_authority",
    scope: f.scope,
    requestId: f.credentials.requestId,
  }).receipt;
  const definition = { ...f.intent, scope: f.scope, issuerPrincipalId: actor.principalId };
  const client = await runtime.connect();
  try {
    await begin(client, f.scope);
    await client.query(
      "SELECT public.proofstack_begin_authenticated_reviewer_authority($1::jsonb,$2::jsonb,$3,$4::jsonb)",
      [
        JSON.stringify(f.scope),
        JSON.stringify(definition),
        Buffer.from(
          encodeReleaseReviewerAuthorityDefinition({ scope: f.scope, definition }),
        ).toString("utf8"),
        JSON.stringify(actor),
      ],
    );
    const part = async (name: string) =>
      (
        await client.query(
          "SELECT public.proofstack_read_reviewer_publication_part($1::jsonb,$2,$3,$4) AS value",
          [
            JSON.stringify(f.scope),
            "release_reviewer_authority",
            f.intent.authorityVersionId,
            name,
          ],
        )
      ).rows[0]?.value;
    const header = await part("header");
    const material = prepareReleaseReviewerPublicationMaterial({
      scope: f.scope,
      source: await part("source"),
      actor: header.actor,
      identity: header.identity,
      grant: await part("grant"),
      credential: await part("credential"),
      issuedAt: header.issuedAt,
      budget: meter(),
    });
    const { schemaVersion: _v, definitionSha256: _h, ...profile } = material.publication;
    return {
      client,
      material,
      finish: () =>
        client.query(
          "SELECT public.proofstack_finish_reviewer_publication($1::jsonb,$2,$3,$4::jsonb,$5,$6,$7,$8)",
          [
            JSON.stringify(f.scope),
            "release_reviewer_authority",
            f.intent.authorityVersionId,
            JSON.stringify(material.publication),
            Buffer.from(
              encodeReleaseReviewerPublicationDefinition({ scope: f.scope, definition: profile }),
            ).toString("utf8"),
            serializeEvaluationCanonicalJson(material.source.record),
            serializeEvaluationCanonicalJson(material.grant),
            serializeEvaluationCanonicalJson(material.credential),
          ],
        ),
    };
  } catch (cause) {
    await client.query("ROLLBACK");
    client.release();
    throw cause;
  }
}
beforeAll(async () => {
  expect(
    (
      await admin.query(
        "SELECT current_database() AS name,current_setting('server_version') AS version",
      )
    ).rows,
  ).toEqual([{ name: "proofstack_test", version: "16.15" }]);
  await migrateDatabase(admin);
  await provisionRuntimeRoles(admin, roles);
});
afterAll(async () => {
  await runtime.end();
  for (const role of Object.values(roles)) {
    if (
      (
        await admin.query(
          "SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=$1) AS present",
          [role.name],
        )
      ).rows[0]?.present
    ) {
      await admin.query(`DROP OWNED BY "${role.name}"`);
      await admin.query(`DROP ROLE "${role.name}"`);
    }
  }
  await admin.end();
});
describe("actual authenticated native reviewer administration", () => {
  it("publishes the exact request-byte ceiling through real fragmented normalized reads and rejects one byte over", async () => {
    const f = await fixture();
    const declarations = Array.from(
      { length: 32 },
      (_, i) => `${String(i).padStart(2, "0")}:${"x".repeat(477)}`,
    );
    const intent = {
      ...f.intent,
      status: "unverifiable" as const,
      affiliations: declarations,
      relationships: declarations,
      conflicts: declarations,
      statusReasons: declarations,
    };
    const remainder =
      MAX_RELEASE_REVIEWER_AUTHORITY_REQUEST_BYTES -
      Buffer.byteLength(serializeEvaluationCanonicalJson(intent));
    if (remainder < 0 || intent.rationale.length + remainder > 4096)
      throw new Error("Invalid exact-byte fixture construction");
    intent.rationale += "x".repeat(remainder);
    expect(Buffer.byteLength(serializeEvaluationCanonicalJson(intent))).toBe(
      MAX_RELEASE_REVIEWER_AUTHORITY_REQUEST_BYTES,
    );
    const result = await service.publishReviewerAuthority(f.credentials, intent);
    expect(result.created).toBe(true);
    expect((await service.publishReviewerAuthority(f.credentials, intent)).publication).toEqual(
      result.publication,
    );
    await expect(
      service.publishReviewerAuthority(f.credentials, {
        ...intent,
        rationale: `${intent.rationale}x`,
      }),
    ).rejects.toBeDefined();
    expect(await counts(f.scope)).toEqual({ sources: 1, origins: 1, intents: 1 });
  });
  it.each(["verified", "unverifiable", "rejected"] as const)(
    "retains a future-effective %s declaration without inventing active-selection or expertise evidence",
    async (status) => {
      const f = await fixture();
      const result = await service.publishReviewerAuthority(f.credentials, {
        ...f.intent,
        status,
        statusReasons:
          status === "verified" ? [] : ["Qualification remains unresolved in this fixture."],
        effectiveAt: "2090-01-01T00:00:00.000001Z",
      });
      expect("status" in result.record && result.record.status).toBe(status);
      expect(result.publication.issuedAt < "2090").toBe(true);
    },
  );
  for (const conformance of releaseReviewerAdministratorConformanceCases)
    it(conformance.name, () => conformance.run(fixture));
  it("rejects self-issuance without committing any source, profile or intent", async () => {
    const f = await fixture();
    await expect(
      service.publishReviewerAuthority(f.credentials, {
        ...f.intent,
        reviewerPrincipalId: f.principalId,
      }),
    ).rejects.toBeDefined();
    expect(await counts(f.scope)).toEqual({ sources: 0, origins: 0, intents: 0 });
  });
  it.each([
    { capabilities: [] },
    { capabilities: ["identity:manage"] },
    { capabilities: ["release:selection:manage"] },
  ] as { capabilities: Capability[] }[])(
    "requires the fixed reviewer management capability $capabilities",
    async ({ capabilities }) => {
      const f = await fixture();
      await f.changeCapabilities(capabilities);
      await expect(service.publishReviewerAuthority(f.credentials, f.intent)).rejects.toBeDefined();
      expect(await counts(f.scope)).toEqual({ sources: 0, origins: 0, intents: 0 });
    },
  );
  it("never upgrades a legacy root or predecessor into an authenticated origin", async () => {
    const f = await fixture();
    const legacy = authorityVersion(
      { ...f.intent, scope: f.scope, issuerPrincipalId: f.principalId },
      {},
      "2026-01-01T00:00:00.000001Z",
    );
    await repository.publishReleaseReviewerAuthority(legacy);
    await expect(service.publishReviewerAuthority(f.credentials, f.intent)).rejects.toBeDefined();
    await expect(
      service.publishReviewerAuthority(f.credentials, {
        ...f.intent,
        authorityVersionId: `version_next_${key}_${sequence}`,
        predecessor: releaseReviewerAuthorityReference(legacy),
      }),
    ).rejects.toBeDefined();
    expect(await counts(f.scope)).toEqual({ sources: 1, origins: 0, intents: 0 });
  });
  it("publishes an authenticated successor and exact supersession while retaining the root", async () => {
    const f = await fixture(),
      first = await service.publishReviewerAuthority(f.credentials, f.intent);
    if (!("authorityVersionId" in first.record)) throw new Error("Expected authority");
    const successor = await service.publishReviewerAuthority(f.credentials, {
      ...f.intent,
      authorityVersionId: `version_next_${key}_${sequence}`,
      predecessor: releaseReviewerAuthorityReference(first.record),
    });
    if (!("authorityVersionId" in successor.record)) throw new Error("Expected successor");
    const terminal = await service.publishReviewerAuthorityLifecycle(f.credentials, {
      eventId: `event_next_${key}_${sequence}`,
      kind: "superseded",
      authority: releaseReviewerAuthorityReference(first.record),
      successor: releaseReviewerAuthorityReference(successor.record),
      reason: "Replace this exact original reviewer declaration.",
    });
    expect(terminal.created).toBe(true);
    expect((await service.publishReviewerAuthority(f.credentials, f.intent)).record).toEqual(
      first.record,
    );
    expect(await counts(f.scope)).toEqual({ sources: 2, origins: 3, intents: 3 });
  });
  it("rejects an API connection despite valid administrator cookie and CSRF", async () => {
    const f = await fixture(),
      url = new URL(databaseUrl as string);
    url.username = roles.api.name;
    url.password = roles.api.password;
    const pool = new Pool({
      connectionString: url.toString(),
      max: 1,
      Client: PolicyWireClient,
    } as ConstructorParameters<typeof Pool>[0]);
    try {
      await expect(
        new PostgresReleaseReviewerAdministrator(pool, authentication).publishReviewerAuthority(
          f.credentials,
          f.intent,
        ),
      ).rejects.toBeDefined();
    } finally {
      await pool.end();
    }
    expect(await counts(f.scope)).toEqual({ sources: 0, origins: 0, intents: 0 });
  });
  it("retains original provenance after its administrator logs out while another authorized administrator publishes a successor", async () => {
    const f = await fixture(),
      original = await service.publishReviewerAuthority(f.credentials, f.intent);
    if (!("authorityVersionId" in original.record))
      throw new Error("Expected reviewer declaration");
    expect(await identities.revokeActive(browserSessionDigest(f.credentials.sessionToken))).toBe(
      true,
    );
    await expect(service.publishReviewerAuthority(f.credentials, f.intent)).rejects.toBeDefined();
    const id = `${key}_${sequence}_other`,
      bindingId = `binding_${id}`,
      principalId = `user_${id}`;
    const owner = await admin.connect();
    try {
      await begin(owner, f.scope);
      await owner.query(
        "SELECT * FROM public.proofstack_create_oidc_binding($1,$2,$3,$4,$5,$6,$7::text[],$8::text[],$9::jsonb,$10)",
        [
          f.scope.tenantId,
          bindingId,
          oidcIdentityDigest("https://reviewer-admin.example.test", id),
          "https://reviewer-admin.example.test",
          id,
          principalId,
          ["member"],
          ["approval:authority:manage"],
          JSON.stringify({ mode: "tenant" }),
          "user_fixture_reviewer_admin",
        ],
      );
      await owner.query("COMMIT");
    } finally {
      await owner.query("ROLLBACK");
      owner.release();
    }
    const secret = generateBrowserSessionCredentials();
    await identities.create({
      bindingId,
      sessionId: `session_${id}`,
      ...secret,
      absoluteLifetimeSeconds: 3600,
      idleLifetimeSeconds: 1800,
    });
    const successor = await service.publishReviewerAuthority(
      {
        scope: f.scope,
        sessionToken: secret.sessionToken,
        csrfToken: secret.csrfToken,
        requestId: "request_other_reviewer_administrator",
      },
      {
        ...f.intent,
        authorityVersionId: `version_${id}`,
        predecessor: releaseReviewerAuthorityReference(original.record),
      },
    );
    expect(successor.publication.actor.principalId).toBe(principalId);
    expect(
      (await f.readPublication("release_reviewer_authority", f.intent.authorityVersionId))
        ?.publication,
    ).toEqual(original.publication);
  });
  it.each(["body", "rls", "trigger"])(
    "rejects actual installed %s drift and preserves a reusable pool",
    async (damage) => {
      const f = await fixture();
      const saved = (
        await admin.query(
          "SELECT pg_catalog.pg_get_functiondef('public.proofstack_read_reviewer_publication_part(jsonb,text,text,text)'::regprocedure) AS definition",
        )
      ).rows[0]?.definition as string;
      try {
        if (damage === "body")
          await admin.query(saved.replace("BEGIN\n", "BEGIN\n-- Owner-only drift fixture\n"));
        if (damage === "rls")
          await admin.query(
            "ALTER TABLE public.proofstack_release_reviewer_publications NO FORCE ROW LEVEL SECURITY",
          );
        if (damage === "trigger")
          await admin.query(
            "ALTER TABLE public.proofstack_release_reviewer_publications DISABLE TRIGGER proofstack_release_reviewer_publication_complete",
          );
        await expect(
          service.publishReviewerAuthority(f.credentials, f.intent),
        ).rejects.toBeDefined();
        expect(await counts(f.scope)).toEqual({ sources: 0, origins: 0, intents: 0 });
      } finally {
        if (damage === "body") await admin.query(saved);
        if (damage === "rls")
          await admin.query(
            "ALTER TABLE public.proofstack_release_reviewer_publications FORCE ROW LEVEL SECURITY",
          );
        if (damage === "trigger")
          await admin.query(
            "ALTER TABLE public.proofstack_release_reviewer_publications ENABLE TRIGGER proofstack_release_reviewer_publication_complete",
          );
      }
      expect((await service.publishReviewerAuthority(f.credentials, f.intent)).created).toBe(true);
    },
  );
  it.each([
    {
      kind: "table",
      grant: "GRANT SELECT ON public.proofstack_browser_sessions",
      revoke: "REVOKE SELECT ON public.proofstack_browser_sessions",
    },
    {
      kind: "column",
      grant: "GRANT SELECT(session_digest) ON public.proofstack_browser_sessions",
      revoke: "REVOKE SELECT(session_digest) ON public.proofstack_browser_sessions",
    },
    {
      kind: "selection",
      grant:
        "GRANT EXECUTE ON FUNCTION public.proofstack_begin_authenticated_selection(jsonb,jsonb,text,jsonb)",
      revoke:
        "REVOKE EXECUTE ON FUNCTION public.proofstack_begin_authenticated_selection(jsonb,jsonb,text,jsonb)",
    },
    {
      kind: "grant_option",
      grant: "GRANT SELECT ON public.proofstack_schema_migrations",
      revoke: "REVOKE GRANT OPTION FOR SELECT ON public.proofstack_schema_migrations",
      option: true,
    },
    {
      kind: "schema",
      grant: "GRANT CREATE ON SCHEMA public",
      revoke: "REVOKE CREATE ON SCHEMA public",
    },
  ])(
    "rejects unexpected effective $kind power before creating a source",
    async ({ grant, revoke, option }) => {
      const f = await fixture();
      try {
        await admin.query(
          `${grant} TO "${roles.reviewerAuthority.name}"${option ? " WITH GRANT OPTION" : ""}`,
        );
        await expect(
          service.publishReviewerAuthority(f.credentials, f.intent),
        ).rejects.toBeDefined();
        expect(await counts(f.scope)).toEqual({ sources: 0, origins: 0, intents: 0 });
      } finally {
        await admin.query(`${revoke} FROM "${roles.reviewerAuthority.name}"`);
      }
      expect((await service.publishReviewerAuthority(f.credentials, f.intent)).created).toBe(true);
    },
  );
  it("keeps one original under concurrent identical requests without hidden retries", async () => {
    const f = await fixture();
    const outcomes = await Promise.allSettled([
      service.publishReviewerAuthority(f.credentials, f.intent),
      service.publishReviewerAuthority(
        { ...f.credentials, requestId: "request_radm_concurrent" },
        f.intent,
      ),
    ]);
    const successful = outcomes.filter((result) => result.status === "fulfilled");
    expect(successful.filter((result) => result.value.created)).toHaveLength(1);
    const retry = await service.publishReviewerAuthority(f.credentials, f.intent);
    for (const result of successful) expect(result.value.publication).toEqual(retry.publication);
    expect(await counts(f.scope)).toEqual({ sources: 1, origins: 1, intents: 1 });
  });
  it("rejects pending original publication at COMMIT and rolls back source and outbox", async () => {
    const f = await fixture();
    const proof = await authentication.authenticateReviewerAuthorityAdministrator(f.credentials);
    const actor = readReleaseMutationAuthentication(proof, {
      operation: "manage_reviewer_authority",
      scope: f.scope,
      requestId: f.credentials.requestId,
    }).receipt;
    const definition = { ...f.intent, scope: f.scope, issuerPrincipalId: actor.principalId };
    const client = await runtime.connect();
    try {
      await begin(client, f.scope);
      const started = await client.query(
        "SELECT public.proofstack_begin_authenticated_reviewer_authority($1::jsonb,$2::jsonb,$3,$4::jsonb) AS value",
        [
          JSON.stringify(f.scope),
          JSON.stringify(definition),
          Buffer.from(
            encodeReleaseReviewerAuthorityDefinition({ scope: f.scope, definition }),
          ).toString("utf8"),
          JSON.stringify(actor),
        ],
      );
      expect(started.rows[0]?.value.created).toBe(true);
      await expect(client.query("COMMIT")).rejects.toMatchObject({ code: "23514" });
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
    expect(await counts(f.scope)).toEqual({ sources: 0, origins: 0, intents: 0 });
    expect((await service.publishReviewerAuthority(f.credentials, f.intent)).created).toBe(true);
  });
  it("holds actual identity guards through transaction end and rejects a contending grant writer", async () => {
    const f = await fixture(),
      published = await service.publishReviewerAuthority(f.credentials, f.intent);
    const reader = await runtime.connect(),
      writer = await admin.connect();
    try {
      await begin(reader, f.scope);
      await reader.query(
        "SELECT public.proofstack_recheck_reviewer_administrator($1::jsonb,$2::jsonb)",
        [JSON.stringify(f.scope), JSON.stringify(published.publication.actor)],
      );
      await begin(writer, f.scope);
      await writer.query("SET LOCAL lock_timeout='250ms'");
      await expect(
        writer.query(
          "SELECT public.proofstack_update_oidc_binding($1,$2,$3::text[],$4::text[],$5::jsonb,$6)",
          [
            f.scope.tenantId,
            f.bindingId,
            ["member"],
            [],
            JSON.stringify({ mode: "tenant" }),
            "user_fixture_reviewer_admin",
          ],
        ),
      ).rejects.toMatchObject({ code: "55P03" });
    } finally {
      await writer.query("ROLLBACK");
      writer.release();
      await reader.query("ROLLBACK");
      reader.release();
    }
    expect((await service.publishReviewerAuthority(f.credentials, f.intent)).created).toBe(false);
  });
  it.each(["profile", "intent", "normalized"])(
    "reinspects authenticated root %s before publishing a distinct version",
    async (damage) => {
      const f = await fixture(),
        first = await service.publishReviewerAuthority(f.credentials, f.intent);
      const row = (
        await admin.query(
          "SELECT publication FROM public.proofstack_release_reviewer_publications WHERE tenant_id=$1",
          [f.scope.tenantId],
        )
      ).rows[0];
      const aggregate = `rrp_${first.publication.definitionSha256.slice(0, 60)}`;
      const originalIntent = (
        await admin.query(
          "SELECT payload FROM public.proofstack_outbox WHERE tenant_id=$1 AND aggregate_id=$2",
          [f.scope.tenantId, aggregate],
        )
      ).rows[0]?.payload;
      const fault = await admin.connect();
      async function inject(restore: boolean) {
        await fault.query("BEGIN");
        try {
          await fault.query("SET LOCAL session_replication_role='replica'");
          if (damage === "profile")
            await fault.query(
              "UPDATE public.proofstack_release_reviewer_publications SET publication=$2::jsonb WHERE tenant_id=$1",
              [
                f.scope.tenantId,
                JSON.stringify(
                  restore ? row?.publication : { ...row?.publication, grantSha256: "0".repeat(64) },
                ),
              ],
            );
          if (damage === "intent")
            await fault.query(
              "UPDATE public.proofstack_outbox SET payload=$3::jsonb WHERE tenant_id=$1 AND aggregate_id=$2",
              [f.scope.tenantId, aggregate, JSON.stringify(restore ? originalIntent : {})],
            );
          if (damage === "normalized")
            await fault.query(
              "UPDATE public.proofstack_release_reviewer_memberships SET member_id=$2 WHERE tenant_id=$1 AND kind='role' AND ordinal=0",
              [f.scope.tenantId, restore ? f.intent.roleIds[0] : "role_injected"],
            );
          await fault.query("COMMIT");
        } catch (cause) {
          await fault.query("ROLLBACK");
          throw cause;
        }
      }
      const next = { ...f.intent, authorityVersionId: `version_distinct_${key}_${sequence}` };
      try {
        await inject(false);
        await expect(service.publishReviewerAuthority(f.credentials, next)).rejects.toBeDefined();
        expect(await counts(f.scope)).toEqual({ sources: 1, origins: 1, intents: 1 });
      } finally {
        await inject(true);
        fault.release();
      }
      expect((await service.publishReviewerAuthority(f.credentials, next)).created).toBe(true);
    },
  );
  it("rejects natural session expiry at final completion and preserves no partial source", async () => {
    const f = await fixture(),
      fault = await admin.connect();
    try {
      // Owner-only clock fixture: valid native session intervals, with immutable-write triggers
      // bypassed only for test setup. No runtime role can perform this mutation.
      await fault.query("BEGIN");
      await fault.query("SET LOCAL session_replication_role='replica'");
      await fault.query(
        "WITH cut AS MATERIALIZED (SELECT clock_timestamp() AS at) UPDATE public.proofstack_browser_sessions SET created_at=cut.at-interval '61 seconds',absolute_expires_at=cut.at+interval '2 seconds',idle_expires_at=cut.at+interval '2 seconds' FROM cut WHERE tenant_id=$1",
        [f.scope.tenantId],
      );
      await fault.query("COMMIT");
    } catch (cause) {
      await fault.query("ROLLBACK");
      throw cause;
    } finally {
      fault.release();
    }
    const draft = await pending(f);
    try {
      await draft.client.query(
        "SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM $1::timestamptz-clock_timestamp()))+0.01)",
        [draft.material.credential.absoluteExpiresAt],
      );
      await expect(draft.finish()).rejects.toMatchObject({ code: "42501" });
    } finally {
      await draft.client.query("ROLLBACK");
      draft.client.release();
    }
    expect(await counts(f.scope)).toEqual({ sources: 0, origins: 0, intents: 0 });
  });
  it("rolls back source and provenance when a conflicting canonical authentication intent exists", async () => {
    const f = await fixture(),
      draft = await pending(f);
    const aggregate = `rrp_${draft.material.publication.definitionSha256.slice(0, 60)}`;
    const fault = await admin.connect();
    const failures: unknown[] = [];
    try {
      await fault.query("BEGIN");
      await fault.query("SET LOCAL session_replication_role='replica'");
      await fault.query(
        "INSERT INTO public.proofstack_outbox(tenant_id,aggregate_type,aggregate_id,event_type,payload,schema_version,created_at) VALUES($1,'release_reviewer_publication',$2,'release.reviewer-authority.authentication_recorded','{}'::jsonb,'0.1',$3::timestamptz)",
        [f.scope.tenantId, aggregate, draft.material.publication.issuedAt],
      );
      await fault.query("COMMIT");
      await expect(draft.finish()).rejects.toMatchObject({ code: "23505" });
      await draft.client.query("ROLLBACK");
      expect(await counts(f.scope)).toEqual({ sources: 0, origins: 0, intents: 1 });
    } catch (cause) {
      failures.push(cause);
    } finally {
      await draft.client.query("ROLLBACK");
      draft.client.release();
      await fault.query("ROLLBACK");
      try {
        await fault.query("BEGIN");
        await fault.query("SET LOCAL session_replication_role='replica'");
        await fault.query(
          "DELETE FROM public.proofstack_outbox WHERE tenant_id=$1 AND aggregate_id=$2",
          [f.scope.tenantId, aggregate],
        );
        await fault.query("COMMIT");
      } catch (cause) {
        await fault.query("ROLLBACK");
        failures.push(cause);
      } finally {
        fault.release();
      }
    }
    if (failures.length) throw new AggregateError(failures, "Native conflict or cleanup failed");
    expect((await service.publishReviewerAuthority(f.credentials, f.intent)).created).toBe(true);
  });
});
