import { createHash } from "node:crypto";
import {
  type ArtifactOwnership,
  encodeEvaluationCanonicalJson,
  PrincipalContextSchema,
} from "@proofstack/contracts";
import { ForbiddenError } from "@proofstack/core";
import { describe, expect, it, vi } from "vitest";
import { ArtifactCipher, LocalArtifactKeyring } from "./artifact-crypto.js";
import {
  type ArtifactCatalogEntry,
  MAX_ENCRYPTED_ARTIFACT_OBJECT_BYTES,
} from "./artifact-ports.js";
import { ArtifactProtectionError } from "./errors.js";
import {
  type PolicyEvaluationArtifactReadInput,
  readPolicyEvaluationArtifact,
} from "./policy-evaluation-artifact-reader.js";
import { MemoryArtifactCatalogRepository, MemoryArtifactObjectStore } from "./testing/index.js";

const scope = {
  tenantId: "tenant_artifact",
  projectId: "project_artifact",
  environmentId: "environment_artifact",
};
const content = Buffer.from('{"answer":"retained evidence"}');
const createdAt = "2026-09-07T01:00:00.000Z";
const availableAt = "2026-09-07T01:01:00.000Z";
const evaluationTime = "2026-09-07T02:00:00.000Z";
const observedAt = "2026-09-07T03:00:00.000Z";

function hash(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function principal() {
  return PrincipalContextSchema.parse({
    authentication: { authenticatedAt: createdAt, method: "development" },
    capabilities: ["artifact:read"],
    principalId: "principal_observer",
    principalType: "service",
    requestId: "request_observe",
    resourceScope: { mode: "tenant" },
    roles: ["viewer"],
    tenantId: scope.tenantId,
  });
}

function ownership(): ArtifactOwnership {
  return {
    schemaVersion: "0.1",
    artifactId: "artifact_retained",
    scope: structuredClone(scope),
    boundAt: availableAt,
    boundByPrincipalId: "principal_fixture",
    owner: {
      kind: "regression_fixture_version",
      fixtureId: "fixture_one",
      fixtureVersionId: "fixture_one_v1",
    },
  };
}

async function harness(
  options: { classification?: "confidential" | "restricted"; retention?: boolean } = {},
) {
  const catalog = new MemoryArtifactCatalogRepository();
  const objects = new MemoryArtifactObjectStore();
  const keyring = new LocalArtifactKeyring({
    activeKeyId: "key_local",
    keys: { key_local: new Uint8Array(32).fill(7) },
  });
  const encryption = new ArtifactCipher(keyring);
  const metadata: ArtifactCatalogEntry["metadata"] = {
    schemaVersion: "0.1",
    scope: structuredClone(scope),
    createdAt,
    state: "reserved",
    contentReference: {
      artifactId: "artifact_retained",
      classification: options.classification ?? "confidential",
      mediaType: "application/json",
      sha256: hash(content),
      sizeBytes: content.byteLength,
    },
    redaction: { status: "not_required" },
    retention: options.retention
      ? { mode: "expire", expiresAt: "2026-09-08T00:00:00.000Z" }
      : { mode: "retain" },
  };
  const reserved: ArtifactCatalogEntry = {
    metadata,
    createdByPrincipalId: "principal_writer",
    objectKey: "objects/v1/retained_artifact",
    encryption: await encryption.createPlan(metadata),
  };
  await catalog.reserve(reserved);
  const encrypted = await encryption.encrypt(metadata, reserved.encryption, content);
  await objects.putIfAbsent(reserved.objectKey, encrypted.bytes);
  const active = await catalog.activate(
    scope,
    metadata.contentReference.artifactId,
    encrypted.receipt,
    availableAt,
  );
  const input: PolicyEvaluationArtifactReadInput = {
    scope: structuredClone(scope),
    principal: principal(),
    reference: structuredClone(metadata.contentReference),
    evaluationTime,
    maxReadBytes: MAX_ENCRYPTED_ARTIFACT_OBJECT_BYTES,
  };
  const find = vi.spyOn(catalog, "find");
  const get = vi.spyOn(objects, "get");
  const decrypt = vi.spyOn(encryption, "decrypt");
  const clock = { now: vi.fn(() => new Date(observedAt)) };
  const dependencies = { catalog, objects, encryption, clock };
  const execute = () => readPolicyEvaluationArtifact(input, dependencies);
  return {
    input,
    dependencies,
    execute,
    active,
    reserved,
    encrypted,
    catalog,
    objects,
    encryption,
    keyring,
    find,
    get,
    decrypt,
    clock,
  };
}

function set(value: object, path: string, replacement: unknown) {
  const parts = path.split(".");
  const key = parts.pop();
  if (!key) throw new Error("Missing test path");
  let target = value as Record<string, unknown>;
  for (const part of parts) target = target[part] as Record<string, unknown>;
  target[key] = replacement;
}

describe("exact policy artifact observation", () => {
  it("uses real authenticated encryption and returns receipts and hashes, never bytes, locators or keys", async () => {
    const h = await harness();
    const result = await h.execute();
    expect(result).toEqual({
      scope,
      reference: h.input.reference,
      evaluationTime,
      startedAt: observedAt,
      completedAt: observedAt,
      catalog: {
        metadata: h.active.metadata,
        ownership: null,
        recordSha256: hash(encodeEvaluationCanonicalJson(h.active)),
      },
      observation: { status: "verified", sha256: hash(content), sizeBytes: content.byteLength },
      usage: { catalogReads: 2, objectReads: 1, objectBytes: h.encrypted.bytes.byteLength },
    });
    expect(h.find).toHaveBeenCalledTimes(2);
    expect(h.find).toHaveBeenNthCalledWith(1, scope, "artifact_retained");
    expect(h.find).toHaveBeenNthCalledWith(2, scope, "artifact_retained");
    expect(h.get).toHaveBeenCalledExactlyOnceWith(h.active.objectKey);
    expect(h.decrypt).toHaveBeenCalledOnce();
    const text = JSON.stringify(result);
    for (const secret of [
      h.active.objectKey,
      h.active.encryption.wrappedDataKey.ciphertext,
      content.toString(),
    ])
      expect(text).not.toContain(secret);
    expect(result).not.toHaveProperty("content");
    expect(result).not.toHaveProperty("sealed");
  });

  it("captures full catalog ownership, permits exact byte limits, and normalizes only admitted undefined", async () => {
    const h = await harness({ retention: true });
    const owned = { ...h.active, ownership: ownership() };
    h.find.mockResolvedValue(owned);
    Object.assign(h.input, { maxReadBytes: h.encrypted.bytes.byteLength });
    const result = await h.execute();
    expect(result.observation.status).toBe("verified");
    expect(result.catalog?.ownership).toEqual(owned.ownership);
    expect(result.catalog?.recordSha256).toBe(hash(encodeEvaluationCanonicalJson(owned)));
    owned.ownership.owner.fixtureId = "fixture_changed";
    expect(result.catalog?.ownership?.owner.fixtureId).toBe("fixture_one");
    const optional = structuredClone(h.active);
    Object.assign(optional, { ownership: undefined });
    h.find.mockResolvedValue(optional);
    expect((await h.execute()).catalog?.recordSha256).toBe(
      hash(encodeEvaluationCanonicalJson(h.active)),
    );
  });

  it.each(["capability", "tenant", "project", "environment", "restricted"])(
    "denies %s access before catalog or content I/O",
    async (kind) => {
      const h = await harness({
        classification: kind === "restricted" ? "restricted" : "confidential",
      });
      if (kind === "capability") h.input.principal.capabilities = ["policy:evaluate"];
      if (kind === "tenant") h.input.principal.tenantId = "tenant_other";
      if (kind === "project")
        h.input.principal.resourceScope = {
          mode: "restricted",
          projects: [{ projectId: "project_other" }],
        };
      if (kind === "environment")
        h.input.principal.resourceScope = {
          mode: "restricted",
          projects: [{ projectId: scope.projectId, environmentIds: ["environment_other"] }],
        };
      await expect(h.execute()).rejects.toBeInstanceOf(ForbiddenError);
      expect(h.find).not.toHaveBeenCalled();
      expect(h.get).not.toHaveBeenCalled();
    },
  );

  it("requires restricted access from the observed classification even if the declared descriptor understates it", async () => {
    const h = await harness({ classification: "restricted" });
    h.input.reference.classification = "confidential";
    await expect(h.execute()).rejects.toBeInstanceOf(ForbiddenError);
    expect(h.get).not.toHaveBeenCalled();
    h.input.reference.classification = "restricted";
    h.input.principal.capabilities.push("artifact:read:restricted");
    expect((await h.execute()).observation.status).toBe("verified");
  });

  it.each([
    ["extra", true],
    ["scope.extra", true],
    ["principal.extra", true],
    ["reference.extra", undefined],
    ["evaluationTime", "2026-09-07T02:00:00+00:00"],
    ["maxReadBytes", -1],
    ["maxReadBytes", 0.5],
    ["maxReadBytes", MAX_ENCRYPTED_ARTIFACT_OBJECT_BYTES + 1],
  ])("rejects invalid input %s=%j before I/O", async (path, value) => {
    const h = await harness();
    set(h.input, String(path), value);
    await expect(h.execute()).rejects.toMatchObject({
      code: "policy_evaluation_artifact_read_input_invalid",
    });
    expect(h.find).not.toHaveBeenCalled();
  });

  it("rejects a future semantic cut and bad clocks without making it ordinary missing evidence", async () => {
    const h = await harness();
    Object.assign(h.input, {
      evaluationTime: "2026-09-07T03:00:00.000000000000000000000000000001Z",
    });
    await expect(h.execute()).rejects.toMatchObject({
      code: "policy_evaluation_artifact_read_input_invalid",
    });
    h.clock.now.mockReturnValue(new Date(Number.NaN));
    await expect(h.execute()).rejects.toMatchObject({ reason: "clock_invalid" });
    expect(h.find).not.toHaveBeenCalled();
  });

  it.each([{ mediaType: "opaque" }, { sizeBytes: 0 }, { sizeBytes: 16_777_217 }])(
    "preserves unmanaged content declarations %j without querying the managed store",
    async (change) => {
      const h = await harness();
      Object.assign(h.input.reference, change);
      const result = await h.execute();
      expect(result.observation).toEqual({
        status: "unavailable",
        reason: "reference_unsupported",
      });
      expect(result.catalog).toBeNull();
      expect(h.find).not.toHaveBeenCalled();
    },
  );

  it("retains explicit catalog absence with no object lookup", async () => {
    const h = await harness();
    h.find.mockResolvedValue(null);
    expect(await h.execute()).toMatchObject({
      catalog: null,
      observation: { status: "missing" },
      usage: { catalogReads: 1, objectReads: 0, objectBytes: 0 },
    });
    expect(h.get).not.toHaveBeenCalled();
  });

  it.each([undefined, [], "catalog", { extra: true }])(
    "does not convert malformed catalog %j to absence",
    async (raw) => {
      const h = await harness();
      h.find.mockResolvedValue(raw as unknown as ArtifactCatalogEntry);
      expect((await h.execute()).observation).toEqual({
        status: "unavailable",
        reason: "record_invalid",
      });
    },
  );

  it.each([
    ["extra", undefined],
    ["metadata.extra", true],
    ["createdByPrincipalId", ""],
    ["objectKey", 3],
    ["objectKey", ""],
    ["objectKey", "a".repeat(1025)],
    ["encryption", null],
    ["encryption.extra", true],
    ["encryption.version", "unknown"],
    ["encryption.contentNonce", 42],
    ["encryption.contentNonce", "short"],
    ["encryption.contentNonce", "!".repeat(16)],
    ["encryption.wrappedDataKey", {}],
    ["encryption.wrappedDataKey.extra", true],
    ["encryption.wrappedDataKey.algorithm", "unknown"],
    ["encryption.wrappedDataKey.keyId", ""],
    ["encryption.wrappedDataKey.ciphertext", "A".repeat(42) + "B"],
    ["encryption.wrappedDataKey.nonce", "!".repeat(16)],
    ["encryption.wrappedDataKey.tag", "short"],
    ["objectReceipt", {}],
    ["objectReceipt.extra", true],
    ["objectReceipt.sha256", "bad"],
    ["objectReceipt.sizeBytes", 1],
    ["objectReceipt", undefined],
    ["ownership", {}],
    ["metadata.createdAt", "2026-09-07T01:00:00." + "0".repeat(31) + "Z"],
  ])("strictly rejects invalid catalog field %s=%j", async (path, value) => {
    const h = await harness();
    const raw = structuredClone(h.active);
    set(raw, String(path), value);
    h.find.mockResolvedValue(raw);
    const result = await h.execute();
    expect(result).toMatchObject({
      catalog: null,
      observation: { status: "unavailable", reason: "record_invalid" },
    });
    expect(h.get).not.toHaveBeenCalled();
  });

  it.each(["artifact", "scope", "chronology"])(
    "rejects inconsistent ownership %s",
    async (field) => {
      const h = await harness();
      const owned = ownership();
      if (field === "artifact") owned.artifactId = "artifact_other";
      if (field === "scope") owned.scope.projectId = "project_other";
      if (field === "chronology") owned.boundAt = "2026-09-07T00:59:59.999Z";
      h.find.mockResolvedValue({ ...h.active, ownership: owned });
      expect((await h.execute()).observation).toEqual({
        status: "unavailable",
        reason: "record_invalid",
      });
    },
  );

  it.each(["scope", "reference"])(
    "drops mismatched %s bodies rather than retaining foreign metadata",
    async (field) => {
      const h = await harness();
      const raw = structuredClone(h.active);
      if (field === "scope") raw.metadata.scope.environmentId = "environment_other";
      else raw.metadata.contentReference.sha256 = "a".repeat(64);
      h.find.mockResolvedValue(raw);
      expect(await h.execute()).toMatchObject({
        catalog: null,
        observation: { status: "unavailable", reason: "reference_mismatch" },
      });
      expect(h.get).not.toHaveBeenCalled();
    },
  );

  it.each(["reserved", "tombstoned", "purged"] as const)(
    "records %s without reading or decrypting unavailable content",
    async (state) => {
      const h = await harness();
      const raw = structuredClone(state === "reserved" ? h.reserved : h.active);
      raw.metadata.state = state;
      if (state !== "reserved") raw.metadata.tombstonedAt = "2026-09-07T02:10:00.000Z";
      if (state === "purged") raw.metadata.purgedAt = "2026-09-07T02:11:00.000Z";
      h.find.mockResolvedValue(raw);
      expect((await h.execute()).observation).toEqual({ status: "unavailable", reason: state });
      expect(h.get).not.toHaveBeenCalled();
      expect(h.decrypt).not.toHaveBeenCalled();
    },
  );

  it.each(["created", "available", "ownership", "future_terminal"])(
    "preserves %s timestamp evidence outside the observation or semantic cut",
    async (field) => {
      const h = await harness();
      const raw = structuredClone(h.active);
      if (field === "created") {
        raw.metadata.createdAt = "2026-09-07T02:01:00.000Z";
        raw.metadata.availableAt = "2026-09-07T02:02:00.000Z";
      }
      if (field === "available")
        raw.metadata.availableAt = "2026-09-07T02:00:00.000000000000000000000000000001Z";
      if (field === "ownership")
        Object.assign(raw, { ownership: { ...ownership(), boundAt: "2026-09-07T04:00:00.000Z" } });
      if (field === "future_terminal") {
        raw.metadata.state = "tombstoned";
        raw.metadata.tombstonedAt = "2026-09-07T04:00:00.000Z";
      }
      h.find.mockResolvedValue(raw);
      expect((await h.execute()).observation).toEqual({
        status: "unavailable",
        reason: "not_yet_available",
      });
      expect(h.get).not.toHaveBeenCalled();
    },
  );

  it("accepts equal semantic times and offset equivalents without rounding receipt fractions", async () => {
    const h = await harness();
    const raw = structuredClone(h.active);
    raw.metadata.availableAt = "2026-09-07T03:00:00.000+01:00";
    h.find.mockResolvedValue(raw);
    expect((await h.execute()).observation.status).toBe("verified");
    raw.metadata.createdAt = "2026-09-07T02:00:00.000000000000000000000000000002Z";
    raw.metadata.availableAt = "2026-09-07T02:00:00.000000000000000000000000000001Z";
    expect((await h.execute()).observation).toEqual({
      status: "unavailable",
      reason: "record_invalid",
    });
  });

  it("rejects unsupported retention precision instead of truncating it", async () => {
    const h = await harness({ retention: true });
    const raw = structuredClone(h.active);
    raw.metadata.retention = {
      mode: "expire",
      expiresAt: "2026-09-08T00:00:00." + "0".repeat(31) + "Z",
    };
    h.find.mockResolvedValue(raw);
    expect((await h.execute()).observation).toEqual({
      status: "unavailable",
      reason: "record_invalid",
    });
  });

  it("treats expiry equality as unavailable before I/O even if maintenance has not tombstoned the row", async () => {
    const h = await harness({ retention: true });
    h.clock.now.mockReturnValue(new Date("2026-09-08T00:00:00.000Z"));
    expect((await h.execute()).observation).toEqual({
      status: "unavailable",
      reason: "retention_expired",
    });
    expect(h.get).not.toHaveBeenCalled();
  });

  it("does not report verified bytes that expired during acquisition", async () => {
    const h = await harness({ retention: true });
    h.clock.now
      .mockReturnValueOnce(new Date(observedAt))
      .mockReturnValueOnce(new Date(observedAt))
      .mockReturnValue(new Date("2026-09-08T00:00:00.000Z"));
    expect((await h.execute()).observation).toEqual({
      status: "unavailable",
      reason: "retention_expired",
    });
    expect(h.decrypt).toHaveBeenCalledOnce();
  });

  it("reserves the encrypted object ceiling before I/O, including a zero limit", async () => {
    const h = await harness();
    for (const maxReadBytes of [0, h.encrypted.bytes.byteLength - 1]) {
      Object.assign(h.input, { maxReadBytes });
      await expect(h.execute()).rejects.toMatchObject({ reason: "read_limit" });
    }
    expect(h.get).not.toHaveBeenCalled();
  });

  it("rejects oversized responses even when the catalogue predicted fewer bytes", async () => {
    const h = await harness();
    Object.assign(h.input, { maxReadBytes: h.encrypted.bytes.byteLength });
    h.get.mockResolvedValue(new Uint8Array(h.encrypted.bytes.byteLength + 1));
    await expect(h.execute()).rejects.toMatchObject({ reason: "read_limit" });
    expect(h.decrypt).not.toHaveBeenCalled();
  });

  it.each(["missing", "type", "length", "hash"])(
    "classifies %s object observations and rechecks the catalogue",
    async (field) => {
      const h = await harness();
      if (field === "missing") h.get.mockResolvedValue(null);
      if (field === "type") h.get.mockResolvedValue([] as unknown as Uint8Array);
      if (field === "length") h.get.mockResolvedValue(new Uint8Array(1));
      if (field === "hash") h.get.mockResolvedValue(new Uint8Array(h.encrypted.bytes.byteLength));
      const output = await h.execute();
      expect(output.observation).toEqual({
        status: "unavailable",
        reason: field === "missing" ? "object_missing" : "content_integrity_failed",
      });
      expect(h.find).toHaveBeenCalledTimes(2);
      expect(h.decrypt).not.toHaveBeenCalled();
    },
  );

  it.each(["type", "hash", "length"])(
    "independently rejects an untrustworthy decryptor's %s result",
    async (field) => {
      const h = await harness();
      const bytes =
        field === "type"
          ? []
          : field === "hash"
            ? new Uint8Array(content.byteLength)
            : new Uint8Array(1);
      h.decrypt.mockResolvedValue(bytes as Uint8Array);
      expect((await h.execute()).observation).toEqual({
        status: "unavailable",
        reason: "content_integrity_failed",
      });
    },
  );

  it("distinguishes cryptographic/key unavailability from proven byte mismatch", async () => {
    const h = await harness();
    const failure = new ArtifactProtectionError();
    h.decrypt.mockRejectedValue(failure);
    await expect(h.execute()).rejects.toBe(failure);
    expect(h.find).toHaveBeenCalledTimes(1);
  });

  it("propagates an actual key-provider outage through the existing crypto boundary", async () => {
    const h = await harness();
    const failure = new Error("key provider unavailable");
    const unwrap = vi.spyOn(h.keyring, "unwrapDataKey").mockRejectedValue(failure);
    await expect(h.execute()).rejects.toMatchObject({
      code: "artifact_protection_failed",
      cause: failure,
    });
    expect(unwrap).toHaveBeenCalledOnce();
  });

  it("records later ownership without calling it historical owner eligibility", async () => {
    const h = await harness();
    h.find.mockResolvedValue({
      ...h.active,
      ownership: { ...ownership(), boundAt: "2026-09-07T02:30:00.000Z" },
    });
    const result = await h.execute();
    expect(result.observation.status).toBe("verified");
    expect(result.catalog?.ownership?.boundAt).toBe("2026-09-07T02:30:00.000Z");
    expect(result).not.toHaveProperty("ownerEligible");
    expect(result).not.toHaveProperty("verdict");
  });

  it.each(["missing", "invalid", "lifecycle", "ownership", "locator", "encryption"])(
    "fails if %s changes while object storage is read",
    async (field) => {
      const h = await harness();
      const changed = structuredClone(h.active);
      if (field === "lifecycle") {
        changed.metadata.state = "tombstoned";
        changed.metadata.tombstonedAt = evaluationTime;
      }
      if (field === "ownership") Object.assign(changed, { ownership: ownership() });
      if (field === "locator") Object.assign(changed, { objectKey: "objects/v1/changed" });
      if (field === "encryption")
        Object.assign(changed.encryption.wrappedDataKey, { keyId: "key_rotated" });
      if (field === "invalid") Object.assign(changed, { extra: true });
      h.find
        .mockResolvedValueOnce(h.active)
        .mockResolvedValueOnce(field === "missing" ? null : changed);
      await expect(h.execute()).rejects.toMatchObject({
        code: "policy_evaluation_artifact_capture_failed",
        reason: "source_revision_changed",
      });
    },
  );

  it.each(["catalog", "object", "decrypt", "recheck"])(
    "propagates unexpected %s errors without inventing absence",
    async (stage) => {
      const h = await harness();
      const failure = new Error("storage or execution failed");
      if (stage === "catalog") h.find.mockRejectedValue(failure);
      if (stage === "object") h.get.mockRejectedValue(failure);
      if (stage === "decrypt") h.decrypt.mockRejectedValue(failure);
      if (stage === "recheck")
        h.find.mockResolvedValueOnce(h.active).mockRejectedValueOnce(failure);
      await expect(h.execute()).rejects.toBe(failure);
    },
  );

  it("does not allow the observed clock to go backwards", async () => {
    const h = await harness();
    h.clock.now.mockReturnValueOnce(new Date(observedAt)).mockReturnValue(new Date(evaluationTime));
    await expect(h.execute()).rejects.toMatchObject({ reason: "clock_invalid" });
    expect(h.get).not.toHaveBeenCalled();
  });

  it("owns input and retained catalogue independently of asynchronous port argument mutation", async () => {
    const h = await harness();
    const raw = structuredClone(h.active);
    h.find.mockImplementation(async (passedScope) => {
      passedScope.tenantId = "tenant_mutated";
      h.input.scope.projectId = "project_mutated";
      h.input.principal.capabilities.length = 0;
      h.input.reference.sha256 = "a".repeat(64);
      Object.assign(h.input, { evaluationTime: "2020-01-01T00:00:00.000Z", maxReadBytes: 0 });
      return raw;
    });
    h.decrypt.mockImplementation(async (metadata, plan, encrypted) => {
      metadata.contentReference.sha256 = "a".repeat(64);
      Object.assign(plan.wrappedDataKey, { keyId: "mutated" });
      encrypted.fill(0);
      return content;
    });
    const result = await h.execute();
    expect(result.scope).toEqual(scope);
    expect(result.evaluationTime).toBe(evaluationTime);
    expect(result.observation).toEqual({
      status: "verified",
      sha256: hash(content),
      sizeBytes: content.byteLength,
    });
    expect(result.catalog?.recordSha256).toBe(hash(encodeEvaluationCanonicalJson(raw)));
    expect(h.encrypted.bytes.some((byte) => byte !== 0)).toBe(true);
    expect(content.toString()).toContain("retained evidence");
  });
});
