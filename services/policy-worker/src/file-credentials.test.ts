import { mkdtemp, writeFile, rename, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  generateServiceToken,
  hashServiceTokenSecret,
  ServiceTokenAuthenticator,
  InvalidServiceTokenError,
  type ServiceTokenPasswordHash,
} from "@proofstack/identity";
import {
  FilePolicyWorkerCredentials,
  PolicyWorkerCredentialCatalogueError,
  MAX_POLICY_WORKER_CREDENTIAL_FILE_BYTES,
} from "./file-credentials.js";

const token = generateServiceToken(),
  other = generateServiceToken();
let hash: ServiceTokenPasswordHash, otherHash: ServiceTokenPasswordHash, root: string;
let sequence = 0;
const start = "2026-10-15T05:00:00.000Z",
  end = "2026-10-15T06:00:00.000Z";
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "proofstack-worker-credentials-"));
  await chmod(root, 0o700);
  [hash, otherHash] = await Promise.all([
    hashServiceTokenSecret(token.secret),
    hashServiceTokenSecret(other.secret),
  ]);
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const row = {
    kind: "service_token",
    credentialId: "credential_worker",
    prefix: token.prefix,
    passwordHash: structuredClone(hash),
    principalId: "worker_reference",
    tenantId: "tenant_reference",
    capabilities: ["policy:evaluation:execute", "artifact:read"],
    resourceScope: {
      mode: "restricted",
      projects: [{ projectId: "project_reference", environmentIds: ["env_reference"] }],
    },
    status: "active",
    notBefore: start,
    expiresAt: end,
  };
  const catalogue = { schemaVersion: "0.1", revision: "catalogue_first", credentials: [row] };
  const path = join(root, `credentials_${sequence++}.json`);
  await writeFile(path, JSON.stringify(catalogue), { mode: 0o600, flag: "wx" });
  const time = { value: start };
  const clock = { now: () => new Date(time.value) };
  const provider = new FilePolicyWorkerCredentials(path, clock);
  const save = async () => {
    await writeFile(path + ".next", JSON.stringify(catalogue), { mode: 0o600, flag: "wx" });
    await rename(path + ".next", path);
  };
  return { path, row, catalogue, time, provider, save };
}
async function confirmation(provider: FilePolicyWorkerCredentials) {
  const found = await provider.findActiveServiceByPrefix(token.prefix);
  if (!found) throw new Error("Expected active test credential");
  const { authenticatedAt: _at, ...expected } = found;
  return expected;
}
describe("actual operator-owned reference worker credential catalogue", () => {
  it("authenticates the actual secret and confirms the entire original authority including validity", async () => {
    const f = await fixture();
    const confirm = vi.spyOn(f.provider, "confirmActiveServiceUse");
    const principal = await new ServiceTokenAuthenticator(f.provider).authenticate(
      token.value,
      "request_reference",
    );
    expect(principal).toMatchObject({
      principalType: "service",
      principalId: f.row.principalId,
      tenantId: f.row.tenantId,
      authentication: {
        method: "service_token",
        credentialId: f.row.credentialId,
        authenticatedAt: start,
      },
      capabilities: f.row.capabilities,
      resourceScope: f.row.resourceScope,
    });
    const { status: _status, ...originalAuthority } = f.row;
    expect(confirm).toHaveBeenCalledWith(originalAuthority);
  });
  it("uses current server time by default", async () => {
    const f = await fixture();
    f.row.notBefore = new Date(Date.now() - 60000).toISOString();
    f.row.expiresAt = new Date(Date.now() + 60000).toISOString();
    await f.save();
    expect(
      await new FilePolicyWorkerCredentials(f.path).findActiveServiceByPrefix(token.prefix),
    ).toMatchObject({ credentialId: f.row.credentialId });
  });
  it.each(["before", "start", "last", "expiry", "revoked", "missing", "empty"])(
    "observes exact active-state boundary %s",
    async (kind) => {
      const f = await fixture();
      if (kind === "before") f.time.value = "2026-10-15T04:59:59.999Z";
      if (kind === "last") f.time.value = "2026-10-15T05:59:59.999Z";
      if (kind === "expiry") f.time.value = end;
      if (kind === "revoked") f.row.status = "revoked";
      if (kind === "empty") f.catalogue.credentials = [];
      await f.save();
      const found = await f.provider.findActiveServiceByPrefix(
        kind === "missing" ? other.prefix : token.prefix,
      );
      if (kind === "start" || kind === "last") expect(found).not.toBeNull();
      else expect(found).toBeNull();
    },
  );
  it("rejects a caller's partial authority projection instead of omitting original validity", async () => {
    const f = await fixture();
    const expected = await confirmation(f.provider);
    expect(await f.provider.confirmActiveServiceUse(expected)).toBe(true);
    const stripped = { ...expected } as unknown as Record<string, unknown>;
    delete stripped["notBefore"];
    delete stripped["expiresAt"];
    expect(await f.provider.confirmActiveServiceUse(stripped as never)).toBe(false);
  });
  it.each(["principalId", "tenantId", "credentialId", "hash", "scope", "validity", "grant_order"])(
    "refuses changed immutable %s at confirmation",
    async (kind) => {
      const f = await fixture(),
        expected = await confirmation(f.provider);
      if (kind === "principalId") f.row.principalId = "worker_changed";
      if (kind === "tenantId") f.row.tenantId = "tenant_changed";
      if (kind === "credentialId") f.row.credentialId = "credential_changed";
      if (kind === "hash") f.row.passwordHash = otherHash;
      if (kind === "scope") f.row.resourceScope.projects[0]!.environmentIds = ["env_changed"];
      if (kind === "validity") f.row.expiresAt = "2026-10-15T07:00:00.000Z";
      if (kind === "grant_order") f.row.capabilities.reverse();
      await f.save();
      expect(await f.provider.confirmActiveServiceUse(expected)).toBe(false);
    },
  );
  it.each(["revoked", "expired"])("refuses %s after successful lookup", async (kind) => {
    const f = await fixture(),
      expected = await confirmation(f.provider);
    if (kind === "revoked") {
      f.row.status = "revoked";
      await f.save();
    } else f.time.value = end;
    expect(await f.provider.confirmActiveServiceUse(expected)).toBe(false);
  });
  it("rejects actual authentication when an atomic revocation wins during secret verification", async () => {
    const f = await fixture(),
      original = f.provider.confirmActiveServiceUse.bind(f.provider);
    vi.spyOn(f.provider, "confirmActiveServiceUse").mockImplementation(async (expected) => {
      f.row.status = "revoked";
      await f.save();
      return original(expected);
    });
    await expect(
      new ServiceTokenAuthenticator(f.provider).authenticate(token.value, "request_reference"),
    ).rejects.toBeInstanceOf(InvalidServiceTokenError);
  });
  it("permits unrelated catalogue rotation while retaining exactly the same original credential", async () => {
    const f = await fixture(),
      expected = await confirmation(f.provider);
    f.catalogue.revision = "catalogue_second";
    f.catalogue.credentials.push({
      ...structuredClone(f.row),
      credentialId: "credential_other",
      prefix: other.prefix,
      passwordHash: otherHash,
    });
    await f.save();
    expect(await f.provider.confirmActiveServiceUse(expected)).toBe(true);
  });
  it("returned records are copies and cannot mutate the installed authority", async () => {
    const f = await fixture(),
      first = await f.provider.findActiveServiceByPrefix(token.prefix);
    if (!first) throw new Error("Missing test credential");
    Object.assign(first.passwordHash, { digest: "corrupt" });
    expect((await f.provider.findActiveServiceByPrefix(token.prefix))!.passwordHash).toEqual(hash);
  });
  it.each([63, 64, 65])("enforces the %i-entry catalogue boundary", async (count) => {
    const f = await fixture();
    f.catalogue.credentials = Array.from({ length: count }, (_, i) => ({
      ...structuredClone(f.row),
      credentialId: `credential_${i}`,
      prefix: i === 0 ? token.prefix : generateServiceToken().prefix,
    }));
    await f.save();
    if (count <= 64)
      expect(await f.provider.findActiveServiceByPrefix(token.prefix)).not.toBeNull();
    else
      await expect(f.provider.findActiveServiceByPrefix(token.prefix)).rejects.toBeInstanceOf(
        PolicyWorkerCredentialCatalogueError,
      );
  });
  it.each(["prefix", "credentialId"] as const)(
    "refuses duplicate %s instead of choosing one record",
    async (field) => {
      const f = await fixture();
      const second = {
        ...structuredClone(f.row),
        prefix: other.prefix,
        credentialId: "credential_other",
      };
      second[field] = f.row[field];
      f.catalogue.credentials.push(second);
      await f.save();
      await expect(f.provider.findActiveServiceByPrefix(token.prefix)).rejects.toBeInstanceOf(
        PolicyWorkerCredentialCatalogueError,
      );
    },
  );
  it.each([
    "version",
    "kind",
    "prefix",
    "prefix_bits",
    "hash_cost",
    "hash_salt",
    "hash_digest",
    "duplicate_grant",
    "extra_grant",
    "tenant_scope",
    "implicit_environment",
    "interval",
    "extra_field",
  ])("rejects corrupt/unbounded authorization %s", async (kind) => {
    const f = await fixture();
    if (kind === "version") f.catalogue.schemaVersion = "0.2";
    if (kind === "kind") f.row.kind = "api_key";
    if (kind === "prefix") f.row.prefix = "";
    if (kind === "prefix_bits") f.row.prefix = token.prefix.slice(0, -1) + "B";
    if (kind === "hash_cost") Object.assign(f.row.passwordHash, { cost: 65536 });
    if (kind === "hash_salt") Object.assign(f.row.passwordHash, { salt: "" });
    if (kind === "hash_digest") Object.assign(f.row.passwordHash, { digest: "A".repeat(42) + "B" });
    if (kind === "duplicate_grant")
      f.row.capabilities = ["policy:evaluation:execute", "policy:evaluation:execute"];
    if (kind === "extra_grant")
      f.row.capabilities = ["policy:evaluation:execute", "identity:manage"];
    if (kind === "tenant_scope") Object.assign(f.row, { resourceScope: { mode: "tenant" } });
    if (kind === "implicit_environment")
      Object.assign(f.row.resourceScope.projects[0]!, { environmentIds: undefined });
    if (kind === "interval") f.row.expiresAt = f.row.notBefore;
    if (kind === "extra_field") Object.assign(f.row, { rawToken: "must_not_be_accepted" });
    await f.save();
    await expect(f.provider.findActiveServiceByPrefix(token.prefix)).rejects.toBeInstanceOf(
      PolicyWorkerCredentialCatalogueError,
    );
  });
  it("refuses invalid lookup encodings before file access", async () => {
    await expect(
      new FilePolicyWorkerCredentials("/definitely/missing").findActiveServiceByPrefix("invalid"),
    ).rejects.toBeInstanceOf(PolicyWorkerCredentialCatalogueError);
  });
  it("fails closed on a bad server clock", async () => {
    const f = await fixture();
    await expect(
      new FilePolicyWorkerCredentials(f.path, {
        now: () => new Date(NaN),
      }).findActiveServiceByPrefix(token.prefix),
    ).rejects.toBeInstanceOf(PolicyWorkerCredentialCatalogueError);
  });
  it("fails closed on oversize/read errors without exposing paths or hashes in its public message", async () => {
    const f = await fixture();
    await writeFile(f.path, Buffer.alloc(MAX_POLICY_WORKER_CREDENTIAL_FILE_BYTES + 1, 32));
    const error = await f.provider.findActiveServiceByPrefix(token.prefix).catch((error) => error);
    expect(error).toBeInstanceOf(PolicyWorkerCredentialCatalogueError);
    expect(error.message).not.toContain(f.path);
    expect(error.message).not.toContain(hash.digest);
    await rm(f.path);
    await expect(
      f.provider.confirmActiveServiceUse({ prefix: token.prefix } as never),
    ).rejects.toBeInstanceOf(PolicyWorkerCredentialCatalogueError);
  });
});
