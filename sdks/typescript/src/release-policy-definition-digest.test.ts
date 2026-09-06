import { readFileSync } from "node:fs";
import type { EvidenceScope, ReleasePolicyDefinition } from "@proofstack/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  digestReleasePolicyDefinition,
  ReleasePolicyDefinitionDigestError,
} from "./release-policy-definition-digest.js";

interface StoredVector {
  readonly input: {
    readonly definition: ReleasePolicyDefinition;
    readonly scope: EvidenceScope;
  };
  readonly kind: string;
  readonly sha256: string;
}

const document = JSON.parse(
  readFileSync(
    new URL(
      "../../../packages/contracts/vectors/release-policy-definition-v1.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as { readonly vectors: readonly StoredVector[] };
const vector = document.vectors.find(({ kind }) => kind === "release_policy");
if (!vector) throw new Error("Expected a release policy definition vector");

describe("release policy definition digest", () => {
  it("reproduces the public contract vector", async () => {
    await expect(
      digestReleasePolicyDefinition(vector.input.scope, vector.input.definition),
    ).resolves.toBe(vector.sha256);
  });

  it("fails closed when Web Crypto is absent or rejects the digest", async () => {
    const originalCrypto = globalThis.crypto;
    vi.stubGlobal("crypto", undefined);
    await expect(
      digestReleasePolicyDefinition(vector.input.scope, vector.input.definition),
    ).rejects.toBeInstanceOf(ReleasePolicyDefinitionDigestError);
    vi.stubGlobal("crypto", originalCrypto);

    const digest = vi
      .spyOn(globalThis.crypto.subtle, "digest")
      .mockRejectedValueOnce(new Error("unavailable"));
    await expect(
      digestReleasePolicyDefinition(vector.input.scope, vector.input.definition),
    ).rejects.toBeInstanceOf(ReleasePolicyDefinitionDigestError);
    digest.mockRestore();
    vi.unstubAllGlobals();
  });
});
