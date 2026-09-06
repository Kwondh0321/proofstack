import {
  type EvidenceScope,
  encodeReleasePolicyDefinition,
  type ReleasePolicyDefinition,
} from "@proofstack/contracts";

export class ReleasePolicyDefinitionDigestError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ReleasePolicyDefinitionDigestError";
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new ReleasePolicyDefinitionDigestError(
      "Web Crypto is required to verify release policy integrity",
    );
  }
  let digest: ArrayBuffer;
  try {
    digest = await subtle.digest("SHA-256", Uint8Array.from(bytes).buffer);
  } catch (cause) {
    throw new ReleasePolicyDefinitionDigestError("Release policy digest calculation failed", {
      cause,
    });
  }
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Independently reproduces the public canonical digest for one exact release policy. */
export async function digestReleasePolicyDefinition(
  scope: EvidenceScope,
  definition: ReleasePolicyDefinition,
): Promise<string> {
  return sha256Hex(encodeReleasePolicyDefinition({ definition, scope }));
}
