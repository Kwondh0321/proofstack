import { beforeAll, describe, expect, it, vi } from "vitest";
import { generateApiKey } from "./api-key.js";
import { IdentityDataIntegrityError } from "./api-key-authenticator.js";
import { generateServiceToken, hashServiceTokenSecret } from "./service-token.js";
import {
  ServiceTokenAuthenticator,
  InvalidServiceTokenError,
  type AuthenticatableServiceToken,
  type ServiceTokenCredentialLookup,
} from "./service-token-authenticator.js";

const token = generateServiceToken();
let stored: AuthenticatableServiceToken;
beforeAll(async () => {
  stored = {
    kind: "service_token",
    prefix: token.prefix,
    credentialId: "service_policy_worker",
    passwordHash: await hashServiceTokenSecret(token.secret),
    authenticatedAt: "2026-10-15T00:00:00.000Z",
    principalId: "worker_policy",
    tenantId: "tenant_policy",
    capabilities: ["policy:evaluation:execute", "artifact:read"],
    resourceScope: {
      mode: "restricted",
      projects: [{ projectId: "project_policy", environmentIds: ["env_test"] }],
    },
  };
});
function lookup(record: AuthenticatableServiceToken | null = stored) {
  return {
    findActiveServiceByPrefix: vi
      .fn<ServiceTokenCredentialLookup["findActiveServiceByPrefix"]>()
      .mockResolvedValue(record),
    confirmActiveServiceUse: vi
      .fn<ServiceTokenCredentialLookup["confirmActiveServiceUse"]>()
      .mockResolvedValue(true),
  };
}
describe("server-owned service token authentication", () => {
  it("authenticates an actual service secret with its exact non-delegated identity/grants", async () => {
    const provider = lookup();
    const principal = await new ServiceTokenAuthenticator(provider).authenticate(
      token.value,
      "request_policy_worker",
    );
    expect(principal).toEqual({
      authentication: {
        method: "service_token",
        credentialId: stored.credentialId,
        authenticatedAt: stored.authenticatedAt,
      },
      principalType: "service",
      principalId: stored.principalId,
      tenantId: stored.tenantId,
      capabilities: stored.capabilities,
      resourceScope: stored.resourceScope,
      roles: ["member"],
      requestId: "request_policy_worker",
    });
    const { authenticatedAt: _at, ...expected } = stored;
    expect(provider.confirmActiveServiceUse).toHaveBeenCalledExactlyOnceWith(expected);
    principal.capabilities.push("identity:manage");
    expect(stored.capabilities).not.toContain("identity:manage");
  });
  it.each(["invalid", generateApiKey().value])(
    "refuses a foreign/malformed namespace before lookup %#",
    async (value) => {
      const provider = lookup();
      await expect(
        new ServiceTokenAuthenticator(provider).authenticate(value, "request_policy_worker"),
      ).rejects.toBeInstanceOf(InvalidServiceTokenError);
      expect(provider.findActiveServiceByPrefix).not.toHaveBeenCalled();
      expect(provider.confirmActiveServiceUse).not.toHaveBeenCalled();
    },
  );
  it("refuses an absent active service record", async () => {
    const provider = lookup(null);
    await expect(
      new ServiceTokenAuthenticator(provider).authenticate(token.value, "request_policy_worker"),
    ).rejects.toBeInstanceOf(InvalidServiceTokenError);
    expect(provider.confirmActiveServiceUse).not.toHaveBeenCalled();
  });
  it.each(["kind", "prefix"] as const)(
    "refuses substituted %s before confirmation",
    async (field) => {
      const bad = { ...stored, [field]: "other" } as AuthenticatableServiceToken;
      const provider = lookup(bad);
      await expect(
        new ServiceTokenAuthenticator(provider).authenticate(token.value, "request_policy_worker"),
      ).rejects.toBeInstanceOf(IdentityDataIntegrityError);
      expect(provider.confirmActiveServiceUse).not.toHaveBeenCalled();
    },
  );
  it("refuses a secret mismatch before confirming any use", async () => {
    const other = generateServiceToken();
    const provider = lookup();
    await expect(
      new ServiceTokenAuthenticator(provider).authenticate(
        `pss_v1_${token.prefix}_${other.secret}`,
        "request_policy_worker",
      ),
    ).rejects.toBeInstanceOf(InvalidServiceTokenError);
    expect(provider.confirmActiveServiceUse).not.toHaveBeenCalled();
  });
  it("fails closed on corrupted stored hash parameters", async () => {
    const provider = lookup({
      ...stored,
      passwordHash: { ...stored.passwordHash, salt: "invalid" },
    });
    await expect(
      new ServiceTokenAuthenticator(provider).authenticate(token.value, "request_policy_worker"),
    ).rejects.toBeInstanceOf(IdentityDataIntegrityError);
    expect(provider.confirmActiveServiceUse).not.toHaveBeenCalled();
  });
  it("fails closed on unserializable provider data", async () => {
    const bad = { ...stored, unexpected: () => "not_data" };
    const provider = lookup(bad);
    await expect(
      new ServiceTokenAuthenticator(provider).authenticate(token.value, "request_policy_worker"),
    ).rejects.toBeInstanceOf(IdentityDataIntegrityError);
    expect(provider.confirmActiveServiceUse).not.toHaveBeenCalled();
  });
  it.each(["principalId", "tenantId", "credentialId", "authenticatedAt"] as const)(
    "refuses invalid stored %s",
    async (field) => {
      const provider = lookup({ ...stored, [field]: "" });
      await expect(
        new ServiceTokenAuthenticator(provider).authenticate(token.value, "request_policy_worker"),
      ).rejects.toBeInstanceOf(IdentityDataIntegrityError);
      expect(provider.confirmActiveServiceUse).not.toHaveBeenCalled();
    },
  );
  it("refuses use revoked during asynchronous secret verification", async () => {
    const provider = lookup();
    provider.confirmActiveServiceUse.mockResolvedValue(false);
    await expect(
      new ServiceTokenAuthenticator(provider).authenticate(token.value, "request_policy_worker"),
    ).rejects.toBeInstanceOf(InvalidServiceTokenError);
    expect(provider.confirmActiveServiceUse).toHaveBeenCalledOnce();
  });
  it.each(["false", 1, {}, null, undefined])(
    "refuses a non-boolean active confirmation %#",
    async (confirmation) => {
      const provider = lookup();
      provider.confirmActiveServiceUse.mockResolvedValue(confirmation as boolean);
      await expect(
        new ServiceTokenAuthenticator(provider).authenticate(token.value, "request_policy_worker"),
      ).rejects.toBeInstanceOf(InvalidServiceTokenError);
      expect(provider.confirmActiveServiceUse).toHaveBeenCalledOnce();
    },
  );
  it("binds a copy of original grants/hash even when the provider mutates its record at confirmation", async () => {
    const raw = {
        ...structuredClone(stored),
        capabilities: [...stored.capabilities],
        passwordHash: { ...stored.passwordHash },
      },
      provider = lookup(raw);
    provider.confirmActiveServiceUse.mockImplementation(async (expected) => {
      raw.capabilities.push("identity:manage");
      raw.passwordHash.digest = "changed";
      expect(expected.capabilities).toEqual(stored.capabilities);
      expect(expected.passwordHash).toEqual(stored.passwordHash);
      return true;
    });
    const principal = await new ServiceTokenAuthenticator(provider).authenticate(
      token.value,
      "request_policy_worker",
    );
    expect(principal.capabilities).toEqual(stored.capabilities);
  });
  it.each(["lookup", "confirmation"] as const)(
    "propagates a provider %s failure without authenticating",
    async (phase) => {
      const provider = lookup(),
        failure = new Error("provider_unavailable");
      if (phase === "lookup") provider.findActiveServiceByPrefix.mockRejectedValue(failure);
      else provider.confirmActiveServiceUse.mockRejectedValue(failure);
      await expect(
        new ServiceTokenAuthenticator(provider).authenticate(token.value, "request_policy_worker"),
      ).rejects.toBe(failure);
    },
  );
});
