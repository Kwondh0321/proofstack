import {
  type EvidenceScope,
  type PolicyEvaluationManifestPageSet,
  type PolicyEvaluationManifestReference,
  type PolicyEvaluationRequestReference,
  type PolicyEvaluationSnapshotSourceInputs,
  PolicyEvaluationSnapshotSourceInputsSchema,
  PolicyEvaluationTimeSchema,
  serializeEvaluationCanonicalJson,
} from "@proofstack/contracts";
import { validatePolicyEvaluationManifest } from "./policy-evaluation-manifest.js";

export class PolicyEvaluationSnapshotSourceIntegrityError extends Error {
  constructor(
    readonly code: "invalid_sources" | "reference_mismatch" | "observation_mismatch",
    options?: ErrorOptions,
  ) {
    super(`Invalid policy evaluation snapshot sources: ${code}`, options);
    this.name = "PolicyEvaluationSnapshotSourceIntegrityError";
  }
}

/**
 * Bind every manifest entry to independently acquired original record witnesses. Callers must
 * derive sources from owning bodies, not from manifest entries or a submitted expected list.
 * Digest integrity and this exact join do not confer source truth or publication authority.
 */
export function validatePolicyEvaluationSnapshotSources(input: {
  readonly expected: {
    readonly request: PolicyEvaluationRequestReference;
    readonly scope: EvidenceScope;
    readonly evaluationTime: string;
    readonly manifest: PolicyEvaluationManifestReference;
  };
  readonly sources: PolicyEvaluationSnapshotSourceInputs;
  readonly pageSet: PolicyEvaluationManifestPageSet;
}): PolicyEvaluationSnapshotSourceInputs {
  const parsed = PolicyEvaluationSnapshotSourceInputsSchema.safeParse(input.sources);
  const cut = PolicyEvaluationTimeSchema.safeParse(input.expected.evaluationTime);
  if (!parsed.success || !cut.success)
    throw new PolicyEvaluationSnapshotSourceIntegrityError("invalid_sources");
  const sources = parsed.data;
  const same = (left: unknown, right: unknown) =>
    serializeEvaluationCanonicalJson(left) === serializeEvaluationCanonicalJson(right);
  if (
    !same(sources.records.request, input.expected.request) ||
    !same(sources.records.scope, input.expected.scope) ||
    sources.records.evaluationTime !== cut.data
  )
    throw new PolicyEvaluationSnapshotSourceIntegrityError("reference_mismatch");
  const pageSet = validatePolicyEvaluationManifest({
    expected: {
      manifest: input.expected.manifest,
      request: input.expected.request,
      scope: input.expected.scope,
      sources: sources.records.records.map(({ entry }) => entry.source),
    },
    pageSet: input.pageSet,
  });
  let index = 0;
  for (const page of pageSet.pages)
    for (const entry of page.entries) {
      const witness = sources.records.records[index++];
      // The manifest validator already checked count, source identity, page order and all digests.
      // Availability and full original body hashes must additionally match the owning witnesses.
      if (!witness || !same(entry, witness.entry))
        throw new PolicyEvaluationSnapshotSourceIntegrityError("observation_mismatch");
    }
  return sources;
}
