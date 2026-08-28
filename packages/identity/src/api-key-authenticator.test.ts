import { describe, expect, it, vi } from "vitest";
import { generateApiKey, hashApiKeySecret } from "./api-key.js";
import type { ApiKeyCredentialLookup, AuthenticatableApiKey } from "./api-key-authenticator.js";
import {
  ApiKeyAuthenticator,
  IdentityDataIntegrityError,
  InvalidApiKeyError,
} from "./api-key-authenticator.js";

function bytes(value: number): (size: number) => Uint8Array {
  return (size) => new Uint8Array(size).fill(value);
}

async function fixture(): Promise<{
  readonly credential: AuthenticatableApiKey;
  readonly value: string;
}> {
  const issued = generateApiKey(bytes(11));
  return {
    credential: {
      authenticatedAt: "2026-08-28T07:00:00.000Z",
      capabilities: ["evidence:ingest", "project:read"],
      credentialId: "key_authentication",
      passwordHash: await hashApiKeySecret(issued.secret, bytes(12)),
      prefix: issued.prefix,
      principalId: "wrk_authentication",
      resourceScope: {
        mode: "restricted",
        projects: [{ environmentIds: ["env_prod"], projectId: "prj_agent" }],
      },
      tenantId: "ten_authentication",
    },
    value: issued.value,
  };
}

function lookup(result: AuthenticatableApiKey | null): ApiKeyCredentialLookup & {
  readonly confirmActiveUse: ReturnType<typeof vi.fn>;
  readonly findActiveByPrefix: ReturnType<typeof vi.fn>;
} {
  return {
    confirmActiveUse: vi.fn(async () => true),
    findActiveByPrefix: vi.fn(async () => result),
  };
}

describe("ApiKeyAuthenticator", () => {
  it("creates a workload principal from authoritative credential state", async () => {
    const { credential, value } = await fixture();
    const credentials = lookup(credential);

    await expect(
      new ApiKeyAuthenticator(credentials).authenticate(value, "req_api_key_001"),
    ).resolves.toMatchObject({
      authentication: {
        authenticatedAt: credential.authenticatedAt,
        credentialId: credential.credentialId,
        method: "api_key",
      },
      capabilities: credential.capabilities,
      principalId: credential.principalId,
      principalType: "workload",
      requestId: "req_api_key_001",
      resourceScope: credential.resourceScope,
      roles: ["ingest"],
      tenantId: credential.tenantId,
    });
    expect(credentials.findActiveByPrefix).toHaveBeenCalledWith(credential.prefix);
    expect(credentials.confirmActiveUse).toHaveBeenCalledWith({
      credentialId: credential.credentialId,
      prefix: credential.prefix,
      tenantId: credential.tenantId,
    });
  });

  it("rejects malformed keys without accessing credential storage", async () => {
    const credentials = lookup(null);

    await expect(
      new ApiKeyAuthenticator(credentials).authenticate("not-a-key", "req_malformed"),
    ).rejects.toBeInstanceOf(InvalidApiKeyError);
    expect(credentials.findActiveByPrefix).not.toHaveBeenCalled();
    expect(credentials.confirmActiveUse).not.toHaveBeenCalled();
  });

  it("uses one generic error for unknown prefixes and incorrect secrets", async () => {
    const { credential } = await fixture();
    const unknown = generateApiKey(bytes(13));
    const wrongSecret = generateApiKey(bytes(14));
    const matchingPrefixValue = `psk_v1_${credential.prefix}_${wrongSecret.secret}`;

    await expect(
      new ApiKeyAuthenticator(lookup(null)).authenticate(unknown.value, "req_unknown"),
    ).rejects.toEqual(expect.objectContaining({ message: "API key is invalid" }));
    await expect(
      new ApiKeyAuthenticator(lookup(credential)).authenticate(
        matchingPrefixValue,
        "req_incorrect",
      ),
    ).rejects.toEqual(expect.objectContaining({ message: "API key is invalid" }));
  });

  it("reports a mismatched lookup result as stored-data corruption", async () => {
    const { credential, value } = await fixture();

    await expect(
      new ApiKeyAuthenticator(lookup({ ...credential, prefix: "AAAAAAAAAAAA" })).authenticate(
        value,
        "req_mismatch",
      ),
    ).rejects.toThrow("mismatched prefix");
  });

  it("reports corrupt hash parameters as stored-data corruption", async () => {
    const { credential, value } = await fixture();

    await expect(
      new ApiKeyAuthenticator(
        lookup({
          ...credential,
          passwordHash: { ...credential.passwordHash, digest: "corrupt" },
        }),
      ).authenticate(value, "req_hash"),
    ).rejects.toBeInstanceOf(IdentityDataIntegrityError);
  });

  it("reports invalid stored authorization as stored-data corruption", async () => {
    const { credential, value } = await fixture();

    await expect(
      new ApiKeyAuthenticator(lookup({ ...credential, tenantId: "INVALID" })).authenticate(
        value,
        "req_authorization",
      ),
    ).rejects.toThrow("authorization is invalid");
  });

  it("rejects a credential revoked while its secret was being verified", async () => {
    const { credential, value } = await fixture();
    const credentials = lookup(credential);
    credentials.confirmActiveUse.mockResolvedValue(false);

    await expect(
      new ApiKeyAuthenticator(credentials).authenticate(value, "req_revoked_during_hash"),
    ).rejects.toBeInstanceOf(InvalidApiKeyError);
  });

  it("preserves unexpected credential-store failures", async () => {
    const { value } = await fixture();
    const unavailable = new Error("identity store unavailable");
    const credentials: ApiKeyCredentialLookup = {
      confirmActiveUse: async () => true,
      findActiveByPrefix: async () => {
        throw unavailable;
      },
    };

    await expect(
      new ApiKeyAuthenticator(credentials).authenticate(value, "req_store"),
    ).rejects.toBe(unavailable);
  });
});
