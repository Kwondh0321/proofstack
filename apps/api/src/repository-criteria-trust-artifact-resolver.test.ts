import { createHash } from "node:crypto";
import type {
  ArtifactCatalogEntry,
  ArtifactCatalogRepository,
  ArtifactContentDecryptor,
  ArtifactObjectStore,
} from "@proofstack/artifacts";
import type { ArtifactMetadata, EvidenceScope } from "@proofstack/contracts";
import { describe, expect, it, vi } from "vitest";
import { RepositoryCriteriaTrustArtifactResolver } from "./repository-criteria-trust-artifact-resolver.js";

const plaintext = Buffer.from("retained criteria authority", "utf8");
const encrypted = Buffer.from("encrypted criteria authority", "utf8");
const scope: EvidenceScope = {
  environmentId: "env_criteria",
  projectId: "prj_criteria",
  tenantId: "ten_criteria",
};

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

const reference = { artifactId: "art_criteria_authority", sha256: sha256(plaintext) };

function metadata(overrides: Partial<ArtifactMetadata> = {}): ArtifactMetadata {
  return {
    availableAt: "2026-09-02T00:00:01.000Z",
    contentReference: {
      artifactId: reference.artifactId,
      classification: "internal",
      mediaType: "text/plain",
      sha256: reference.sha256,
      sizeBytes: plaintext.byteLength,
    },
    createdAt: "2026-09-02T00:00:00.000Z",
    redaction: { status: "not_required" },
    retention: { mode: "retain" },
    schemaVersion: "0.1",
    scope,
    state: "available",
    ...overrides,
  };
}

function entry(overrides: Partial<ArtifactCatalogEntry> = {}): ArtifactCatalogEntry {
  return {
    createdByPrincipalId: "usr_artifact_publisher",
    encryption: {
      contentNonce: Buffer.alloc(12).toString("base64url"),
      version: "a256gcm-v1",
      wrappedDataKey: {
        algorithm: "A256GCM",
        ciphertext: Buffer.alloc(32).toString("base64url"),
        keyId: "key_criteria",
        nonce: Buffer.alloc(12).toString("base64url"),
        tag: Buffer.alloc(16).toString("base64url"),
      },
    },
    metadata: metadata(),
    objectKey: "ten_criteria/art_criteria_authority",
    objectReceipt: { sha256: sha256(encrypted), sizeBytes: encrypted.byteLength },
    ...overrides,
  };
}

function entryWithoutObjectReceipt(): ArtifactCatalogEntry {
  const { objectReceipt: _objectReceipt, ...value } = entry();
  return value;
}

function dependencies(
  overrides: {
    readonly catalogEntry?: ArtifactCatalogEntry | null;
    readonly decrypted?: Uint8Array;
    readonly encryptedObject?: Uint8Array | null;
  } = {},
) {
  const catalog: ArtifactCatalogRepository = {
    activate: vi.fn(),
    find: vi.fn(async () =>
      overrides.catalogEntry === undefined ? entry() : overrides.catalogEntry,
    ),
    findPurgeReceipt: vi.fn(),
    listAbandoned: vi.fn(),
    listExpired: vi.fn(),
    listKeyReferences: vi.fn(),
    listPendingPurge: vi.fn(),
    recordPurge: vi.fn(),
    reserve: vi.fn(),
    tombstone: vi.fn(),
  };
  const encryption: ArtifactContentDecryptor = {
    decrypt: vi.fn(async () => overrides.decrypted ?? plaintext),
  };
  const objects: ArtifactObjectStore = {
    delete: vi.fn(),
    get: vi.fn(async () =>
      overrides.encryptedObject === undefined ? encrypted : overrides.encryptedObject,
    ),
    putIfAbsent: vi.fn(),
  };
  return { catalog, encryption, objects };
}

describe("RepositoryCriteriaTrustArtifactResolver", () => {
  it("marks exact readable bytes available after ciphertext and plaintext verification", async () => {
    const values = dependencies();
    const result = await new RepositoryCriteriaTrustArtifactResolver(values).resolve({
      references: [reference],
      scope,
    });

    expect(result).toEqual([{ ...reference, state: "available" }]);
    expect(values.catalog.find).toHaveBeenCalledWith(scope, reference.artifactId);
    expect(values.objects.get).toHaveBeenCalledWith("ten_criteria/art_criteria_authority");
    expect(values.encryption.decrypt).toHaveBeenCalledWith(
      entry().metadata,
      entry().encryption,
      encrypted,
    );
  });

  it("fails closed when artifact storage is not configured", async () => {
    const result = await new RepositoryCriteriaTrustArtifactResolver({}).resolve({
      references: [reference],
      scope,
    });
    expect(result).toEqual([{ ...reference, state: "unavailable" }]);
  });

  it.each([
    { label: "catalog row is absent", values: { catalogEntry: null } },
    {
      label: "catalog scope differs",
      values: {
        catalogEntry: entry({
          metadata: metadata({ scope: { ...scope, environmentId: "env_other" } }),
        }),
      },
    },
    {
      label: "catalog digest differs",
      values: {
        catalogEntry: entry({
          metadata: metadata({
            contentReference: {
              ...metadata().contentReference,
              sha256: "0".repeat(64),
            },
          }),
        }),
      },
    },
    {
      label: "lifecycle is not available",
      values: {
        catalogEntry: entry({
          metadata: metadata({ availableAt: undefined, state: "reserved" }),
        }),
      },
    },
    {
      label: "object receipt is absent",
      values: { catalogEntry: entryWithoutObjectReceipt() },
    },
    { label: "object is absent", values: { encryptedObject: null } },
    {
      label: "ciphertext receipt differs",
      values: { encryptedObject: Buffer.from("corrupt", "utf8") },
    },
    {
      label: "plaintext digest differs",
      values: { decrypted: Buffer.from("substituted", "utf8") },
    },
  ])("marks bytes unavailable when $label", async ({ values }) => {
    const result = await new RepositoryCriteriaTrustArtifactResolver(dependencies(values)).resolve({
      references: [reference],
      scope,
    });
    expect(result).toEqual([{ ...reference, state: "unavailable" }]);
  });

  it("isolates backend and decryption failures per reference", async () => {
    const values = dependencies();
    vi.mocked(values.catalog.find).mockRejectedValueOnce(new Error("catalog offline"));
    vi.mocked(values.catalog.find).mockResolvedValueOnce(
      entry({
        metadata: metadata({
          contentReference: {
            ...metadata().contentReference,
            artifactId: "art_second",
          },
        }),
      }),
    );
    vi.mocked(values.encryption.decrypt).mockRejectedValueOnce(new Error("key unavailable"));
    const result = await new RepositoryCriteriaTrustArtifactResolver(values).resolve({
      references: [reference, { artifactId: "art_second", sha256: reference.sha256 }],
      scope,
    });
    expect(result).toEqual([
      { ...reference, state: "unavailable" },
      { artifactId: "art_second", sha256: reference.sha256, state: "unavailable" },
    ]);
    expect(values.catalog.find).toHaveBeenCalledTimes(2);
    expect(values.encryption.decrypt).toHaveBeenCalledOnce();
  });
});
