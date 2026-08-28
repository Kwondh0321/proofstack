import { PrincipalContextSchema } from "@proofstack/contracts";
import {
  ApiKeyAuthenticator,
  ApiKeyLifecycle,
  generateApiKey,
  InvalidApiKeyError,
  parseApiKey,
} from "@proofstack/identity";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateDatabase } from "./migration-runner.js";
import { PostgresApiKeyCredentialRepository } from "./postgres-api-key-credential-repository.js";
import { provisionRuntimeRoles, type RuntimeRoleProvisioningOptions } from "./runtime-roles.js";

const { PROOFSTACK_TEST_DATABASE_URL: databaseUrl } = process.env;
if (!databaseUrl) {
  throw new Error("PROOFSTACK_TEST_DATABASE_URL is required for PostgreSQL integration tests");
}

const runKey = Date.now().toString();
const tenantId = `ten_identity_adapter_${runKey}`;
const roleNames = {
  api: `proofstack_adapter_api_${runKey}`,
  consumer: `proofstack_adapter_consumer_${runKey}`,
  identity: `proofstack_adapter_identity_${runKey}`,
  publisher: `proofstack_adapter_publisher_${runKey}`,
};
const adminPool = new Pool({ connectionString: databaseUrl, max: 2 });
let identityPool: Pool;

function options(): RuntimeRoleProvisioningOptions {
  return {
    api: { name: roleNames.api, password: `proofstack-adapter-api-${runKey}` },
    consumer: {
      name: roleNames.consumer,
      password: `proofstack-adapter-consumer-${runKey}`,
    },
    identity: {
      name: roleNames.identity,
      password: `proofstack-adapter-identity-${runKey}`,
    },
    publisher: {
      name: roleNames.publisher,
      password: `proofstack-adapter-publisher-${runKey}`,
    },
  };
}

function identityManager() {
  return PrincipalContextSchema.parse({
    authentication: {
      authenticatedAt: "2026-08-28T08:00:00.000Z",
      credentialId: "ses_identity_adapter",
      method: "oidc",
    },
    capabilities: ["identity:manage", "evidence:ingest", "evidence:read"],
    principalId: "usr_identity_adapter",
    principalType: "user",
    requestId: "req_identity_adapter",
    resourceScope: { mode: "tenant" },
    roles: ["admin"],
    tenantId,
  });
}

beforeAll(async () => {
  await migrateDatabase(adminPool);
  const credentials = options();
  await provisionRuntimeRoles(adminPool, credentials);

  const url = new URL(databaseUrl as string);
  url.username = credentials.identity.name;
  url.password = credentials.identity.password;
  identityPool = new Pool({ connectionString: url.toString(), max: 2 });
});

afterAll(async () => {
  await identityPool?.end();
  for (const roleName of Object.values(roleNames)) {
    const exists = await adminPool.query<{ readonly present: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS present",
      [roleName],
    );
    if (exists.rows[0]?.present) {
      await adminPool.query(`DROP OWNED BY "${roleName}"`);
      await adminPool.query(`DROP ROLE "${roleName}"`);
    }
  }
  await adminPool.end();
});

describe("PostgresApiKeyCredentialRepository", () => {
  it("runs issuance, authentication, rotation, and revocation through the isolated role", async () => {
    const repository = new PostgresApiKeyCredentialRepository(identityPool);
    const lifecycle = new ApiKeyLifecycle(repository);
    const authenticator = new ApiKeyAuthenticator(repository);
    const issuer = identityManager();

    await expect(
      identityPool.query("SELECT * FROM proofstack_api_key_credentials"),
    ).rejects.toMatchObject({ code: "42501" });

    const issued = await lifecycle.issue({
      capabilities: ["evidence:ingest", "evidence:read"],
      issuer,
      name: "integration agent",
      resourceScope: {
        mode: "restricted",
        projects: [{ environmentIds: ["env_prod"], projectId: "prj_agent" }],
      },
    });
    expect(issued.value).toMatch(/^psk_v1_/);
    expect(issued.credential.tenantId).toBe(tenantId);
    expect(issued.credential).not.toHaveProperty("passwordHash");

    await expect(
      authenticator.authenticate(issued.value, "req_adapter_authentication"),
    ).resolves.toMatchObject({
      capabilities: ["evidence:ingest", "evidence:read"],
      principalId: issued.credential.principalId,
      principalType: "workload",
      resourceScope: issued.credential.resourceScope,
      tenantId,
    });

    const issuedParts = parseApiKey(issued.value);
    const unrelated = generateApiKey();
    await expect(
      authenticator.authenticate(
        `psk_v1_${issuedParts.prefix}_${unrelated.secret}`,
        "req_adapter_wrong_secret",
      ),
    ).rejects.toBeInstanceOf(InvalidApiKeyError);

    const rotated = await lifecycle.rotate({
      credentialId: issued.credential.credentialId,
      issuer,
    });
    expect(rotated.credential.principalId).toBe(issued.credential.principalId);
    await expect(
      authenticator.authenticate(issued.value, "req_adapter_old_key"),
    ).rejects.toBeInstanceOf(InvalidApiKeyError);
    await expect(
      authenticator.authenticate(rotated.value, "req_adapter_rotated_key"),
    ).resolves.toMatchObject({ principalId: issued.credential.principalId, tenantId });

    await expect(
      lifecycle.revoke({
        credentialId: rotated.credential.credentialId,
        issuer,
        reason: "integration complete",
      }),
    ).resolves.toBe(true);
    await expect(
      authenticator.authenticate(rotated.value, "req_adapter_revoked_key"),
    ).rejects.toBeInstanceOf(InvalidApiKeyError);

    const state = await adminPool.query<{
      readonly audit_types: string[];
      readonly credential_count: number;
      readonly total_use_count: number;
    }>(
      `
        SELECT
          (
            SELECT array_agg(event_type ORDER BY audit_id)
            FROM proofstack_identity_audit_events
            WHERE tenant_id = $1
          ) AS audit_types,
          count(*)::integer AS credential_count,
          sum(use_count)::integer AS total_use_count
        FROM proofstack_api_key_credentials
        WHERE tenant_id = $1
      `,
      [tenantId],
    );
    expect(state.rows[0]).toEqual({
      audit_types: ["api_key.issued", "api_key.rotated", "api_key.revoked"],
      credential_count: 2,
      total_use_count: 2,
    });
  });
});
