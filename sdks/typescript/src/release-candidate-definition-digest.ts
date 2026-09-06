import {
  type EvidenceScope,
  encodeReleaseCandidateDefinition,
  type ReleaseCandidateDefinition,
} from "@proofstack/contracts";

export class ReleaseCandidateDefinitionDigestError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ReleaseCandidateDefinitionDigestError";
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new ReleaseCandidateDefinitionDigestError(
      "Web Crypto is required to verify release candidate integrity",
    );
  }
  let digest: ArrayBuffer;
  try {
    digest = await subtle.digest("SHA-256", Uint8Array.from(bytes).buffer);
  } catch (cause) {
    throw new ReleaseCandidateDefinitionDigestError("Release candidate digest calculation failed", {
      cause,
    });
  }
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Independently reproduces the public canonical digest for one exact candidate definition. */
export async function digestReleaseCandidateDefinition(
  scope: EvidenceScope,
  definition: ReleaseCandidateDefinition,
): Promise<string> {
  return sha256Hex(encodeReleaseCandidateDefinition({ definition, scope }));
}
