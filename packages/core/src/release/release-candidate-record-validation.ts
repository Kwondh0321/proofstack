import { createHash } from "node:crypto";
import {
  encodeReleaseCandidateDefinition,
  type EvidenceScope,
  type ReleaseCandidate,
  ReleaseCandidateSchema,
  type ReleaseCandidateDefinition,
  type ReleaseCandidateReference,
} from "@proofstack/contracts";
import { InvalidReleaseCandidateRecordInputError } from "./release-candidate-errors.js";

const receiptKeys = [
  "createdAt",
  "createdByPrincipalId",
  "definitionSha256",
  "schemaVersion",
  "scope",
] as const;

function definitionOf(record: ReleaseCandidate): ReleaseCandidateDefinition {
  const definition = structuredClone(record) as unknown as Record<string, unknown>;
  for (const key of receiptKeys) delete definition[key];
  return definition as unknown as ReleaseCandidateDefinition;
}

export function digestReleaseCandidateDefinition(
  scope: EvidenceScope,
  definition: ReleaseCandidateDefinition,
): string {
  const bytes = encodeReleaseCandidateDefinition({ definition, scope });
  return createHash("sha256").update(bytes).digest("hex");
}

/** Strict-parses and independently verifies one authoritative candidate record. */
export function validateReleaseCandidateRecord(candidate: unknown): ReleaseCandidate {
  let parsed: ReleaseCandidate;
  let digest: string;
  try {
    parsed = ReleaseCandidateSchema.parse(candidate);
    digest = digestReleaseCandidateDefinition(parsed.scope, definitionOf(parsed));
  } catch (cause) {
    throw new InvalidReleaseCandidateRecordInputError("Invalid release candidate record", {
      cause,
    });
  }
  if (digest !== parsed.definitionSha256) {
    throw new InvalidReleaseCandidateRecordInputError(
      `Release candidate ${parsed.candidateVersionId} has an invalid canonical definition digest`,
    );
  }
  return parsed;
}

export function releaseCandidateReference(candidate: ReleaseCandidate): ReleaseCandidateReference {
  return {
    candidateId: candidate.candidateId,
    candidateVersionId: candidate.candidateVersionId,
    definitionSha256: candidate.definitionSha256,
  };
}
