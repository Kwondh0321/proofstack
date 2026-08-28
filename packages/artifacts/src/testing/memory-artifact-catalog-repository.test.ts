import { describe, expect, it } from "vitest";
import type { ArtifactCatalogEntry } from "../artifact-ports.js";
import { MemoryArtifactCatalogRepository } from "./memory-artifact-catalog-repository.js";

function candidate(): ArtifactCatalogEntry {
  return {
    createdByPrincipalId: "usr_mutation",
    encryption: {
      contentNonce: "AAAAAAAAAAAAAAAA",
      version: "a256gcm-v1",
      wrappedDataKey: {
        algorithm: "A256GCM",
        ciphertext: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        keyId: "key_mutation",
        nonce: "AAAAAAAAAAAAAAAA",
        tag: "AAAAAAAAAAAAAAAAAAAAAA",
      },
    },
    metadata: {
      contentReference: {
        artifactId: "art_mutation",
        classification: "internal",
        mediaType: "text/plain",
        sha256: "1".repeat(64),
        sizeBytes: 1,
      },
      createdAt: "2026-08-28T03:00:00.000Z",
      redaction: { status: "not_performed" },
      retention: { mode: "retain" },
      schemaVersion: "0.1",
      scope: {
        environmentId: "env_mutation",
        projectId: "prj_mutation",
        tenantId: "ten_mutation",
      },
      state: "reserved",
    },
    objectKey: "artifacts/mutation/art_mutation",
  };
}

describe("MemoryArtifactCatalogRepository", () => {
  it("returns defensive copies instead of mutable catalog state", async () => {
    const repository = new MemoryArtifactCatalogRepository();
    const input = candidate();
    const reserved = await repository.reserve(input);
    input.metadata.scope.projectId = "prj_changed";
    reserved.entry.metadata.scope.projectId = "prj_changed";

    const stored = await repository.find(
      candidate().metadata.scope,
      candidate().metadata.contentReference.artifactId,
    );
    expect(stored?.metadata.scope.projectId).toBe("prj_mutation");
  });
});
