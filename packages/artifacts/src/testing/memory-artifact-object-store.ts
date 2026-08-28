import { createHash } from "node:crypto";
import type {
  ArtifactObjectPutResult,
  ArtifactObjectReceipt,
  ArtifactObjectStore,
} from "../artifact-ports.js";

function receipt(value: Uint8Array): ArtifactObjectReceipt {
  return {
    sha256: createHash("sha256").update(value).digest("hex"),
    sizeBytes: value.byteLength,
  };
}

export class MemoryArtifactObjectStore implements ArtifactObjectStore {
  private readonly objects = new Map<string, Uint8Array>();

  async delete(objectKey: string): Promise<{ readonly deleted: boolean }> {
    return { deleted: this.objects.delete(objectKey) };
  }

  async get(objectKey: string): Promise<Uint8Array | null> {
    const value = this.objects.get(objectKey);
    return value ? Uint8Array.from(value) : null;
  }

  async putIfAbsent(objectKey: string, ciphertext: Uint8Array): Promise<ArtifactObjectPutResult> {
    const existing = this.objects.get(objectKey);
    if (existing) return { created: false, receipt: receipt(existing) };

    const stored = Uint8Array.from(ciphertext);
    this.objects.set(objectKey, stored);
    return { created: true, receipt: receipt(stored) };
  }
}
