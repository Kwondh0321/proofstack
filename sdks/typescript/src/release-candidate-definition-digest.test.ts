import { readFileSync } from "node:fs";
import type { EvidenceScope, ReleaseCandidateDefinition } from "@proofstack/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  digestReleaseCandidateDefinition,
  ReleaseCandidateDefinitionDigestError,
} from "./release-candidate-definition-digest.js";

interface StoredVector {
  readonly input: {
    readonly definition: ReleaseCandidateDefinition;
    readonly scope: EvidenceScope;
  };
  readonly sha256: string;
}

const document = JSON.parse(
  readFileSync(
    new URL(
      "../../../packages/contracts/vectors/release-candidate-definition-v1.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as { readonly vectors: readonly StoredVector[] };
const vector = document.vectors[0];
if (!vector) throw new Error("Expected a release candidate definition vector");

describe("release candidate definition digest", () => {
  it("reproduces the public contract vector", async () => {
    await expect(
      digestReleaseCandidateDefinition(vector.input.scope, vector.input.definition),
    ).resolves.toBe(vector.sha256);
  });

  it("fails closed when Web Crypto is absent or rejects the digest", async () => {
    const originalCrypto = globalThis.crypto;
    vi.stubGlobal("crypto", undefined);
    await expect(
      digestReleaseCandidateDefinition(vector.input.scope, vector.input.definition),
    ).rejects.toBeInstanceOf(ReleaseCandidateDefinitionDigestError);
    vi.stubGlobal("crypto", originalCrypto);

    const digest = vi
      .spyOn(globalThis.crypto.subtle, "digest")
      .mockRejectedValueOnce(new Error("unavailable"));
    await expect(
      digestReleaseCandidateDefinition(vector.input.scope, vector.input.definition),
    ).rejects.toBeInstanceOf(ReleaseCandidateDefinitionDigestError);
    digest.mockRestore();
    vi.unstubAllGlobals();
  });
});
