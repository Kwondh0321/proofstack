import {
  type ComparisonRecordKind,
  type EvidenceScope,
  encodeComparisonDefinition,
  encodeComparisonEvidenceSnapshotDefinition,
  encodeComparisonResultDefinition,
} from "@proofstack/contracts";

export class ComparisonDefinitionDigestError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ComparisonDefinitionDigestError";
  }
}

function encodeDefinition(
  kind: ComparisonRecordKind,
  scope: EvidenceScope,
  definition: unknown,
): Uint8Array {
  const input = { definition, scope };
  switch (kind) {
    case "comparison_definition":
      return encodeComparisonDefinition(input as never);
    case "comparison_evidence_snapshot":
      return encodeComparisonEvidenceSnapshotDefinition(input as never);
    case "comparison_result":
      return encodeComparisonResultDefinition(input as never);
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new ComparisonDefinitionDigestError(
      "Web Crypto is required to verify comparison definition integrity",
    );
  }
  let digest: ArrayBuffer;
  try {
    digest = await subtle.digest("SHA-256", Uint8Array.from(bytes).buffer);
  } catch (cause) {
    throw new ComparisonDefinitionDigestError("Comparison definition digest calculation failed", {
      cause,
    });
  }
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function digestComparisonDefinition(
  kind: ComparisonRecordKind,
  scope: EvidenceScope,
  definition: unknown,
): Promise<string> {
  return sha256Hex(encodeDefinition(kind, scope, definition));
}
