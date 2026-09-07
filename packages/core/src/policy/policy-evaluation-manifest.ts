import { createHash } from "node:crypto";
import {
  encodeEvaluationCanonicalJson,
  encodePolicyEvaluationManifestDefinition,
  encodePolicyEvaluationManifestPageDefinition,
  POLICY_EVALUATION_MANIFEST_PAGE_SIZE,
  POLICY_EVALUATION_MANIFEST_SCHEMA_VERSION,
  type PolicyEvaluationManifestAssembly,
  PolicyEvaluationManifestAssemblySchema,
  type PolicyEvaluationManifestDefinition,
  type PolicyEvaluationManifestPage,
  type PolicyEvaluationManifestPageSet,
  PolicyEvaluationManifestPageSetSchema,
  PolicyEvaluationExpectedSourcesSchema,
  type PolicyEvaluationManifestVerification,
  PolicyEvaluationManifestVerificationSchema,
  policyEvaluationSourceReferenceKey,
} from "@proofstack/contracts";

export class PolicyEvaluationManifestIntegrityError extends Error {
  constructor(
    readonly code:
      | "invalid_manifest"
      | "reference_mismatch"
      | "digest_mismatch"
      | "source_closure_mismatch",
    options?: ErrorOptions,
  ) {
    super(`Invalid policy evaluation manifest: ${code}`, options);
    this.name = "PolicyEvaluationManifestIntegrityError";
  }
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function equalJson(left: unknown, right: unknown): boolean {
  return Buffer.from(encodeEvaluationCanonicalJson(left)).equals(
    encodeEvaluationCanonicalJson(right),
  );
}

/**
 * Assemble capture-derived observations without sorting, deduplicating, dropping unavailable
 * entries, resolving a source, or granting snapshot/publication authority.
 */
export function assemblePolicyEvaluationManifest(
  input: PolicyEvaluationManifestAssembly,
): PolicyEvaluationManifestPageSet {
  try {
    const { entries, manifestId, request, scope } =
      PolicyEvaluationManifestAssemblySchema.parse(input);
    PolicyEvaluationExpectedSourcesSchema.parse(entries.map(({ source }) => source));
    const pages: PolicyEvaluationManifestPage[] = [];
    for (let offset = 0; offset < entries.length; offset += POLICY_EVALUATION_MANIFEST_PAGE_SIZE) {
      const definition = {
        entries: entries.slice(offset, offset + POLICY_EVALUATION_MANIFEST_PAGE_SIZE),
        entryCount: entries.length,
        manifestId,
        pageIndex: pages.length,
        request,
      };
      pages.push({
        ...definition,
        definitionSha256: digest(
          encodePolicyEvaluationManifestPageDefinition({ definition, scope }),
        ),
        schemaVersion: POLICY_EVALUATION_MANIFEST_SCHEMA_VERSION,
        scope,
      });
    }
    const definition: PolicyEvaluationManifestDefinition = {
      entryCount: entries.length,
      manifestId,
      pages: pages.map((page) => {
        const first = page.entries[0];
        const last = page.entries.at(-1);
        if (!first || !last) throw new Error("Manifest assembly produced an empty page");
        return {
          definitionSha256: page.definitionSha256,
          entryCount: page.entries.length,
          firstKey: policyEvaluationSourceReferenceKey(first.source),
          lastKey: policyEvaluationSourceReferenceKey(last.source),
          pageIndex: page.pageIndex,
        };
      }),
      request,
    };
    return PolicyEvaluationManifestPageSetSchema.parse({
      manifest: {
        ...definition,
        definitionSha256: digest(encodePolicyEvaluationManifestDefinition({ definition, scope })),
        schemaVersion: POLICY_EVALUATION_MANIFEST_SCHEMA_VERSION,
        scope,
      },
      pages,
    });
  } catch (cause) {
    throw new PolicyEvaluationManifestIntegrityError("invalid_manifest", { cause });
  }
}

/**
 * Verify the entire exact manifest and a separately derived expected source closure. This does
 * not prove that the supplied closure is authoritative or that the source records are true.
 * Capture must derive that closure and verify raw records; snapshots must bind this manifest.
 */
export function validatePolicyEvaluationManifest(
  input: PolicyEvaluationManifestVerification,
): PolicyEvaluationManifestPageSet {
  const parsed = PolicyEvaluationManifestVerificationSchema.safeParse(input);
  if (!parsed.success)
    throw new PolicyEvaluationManifestIntegrityError("invalid_manifest", { cause: parsed.error });
  const { expected, pageSet } = parsed.data;
  const { manifest, pages } = pageSet;
  if (
    manifest.manifestId !== expected.manifest.manifestId ||
    manifest.definitionSha256 !== expected.manifest.definitionSha256 ||
    !equalJson(manifest.scope, expected.scope) ||
    !equalJson(manifest.request, expected.request)
  ) {
    throw new PolicyEvaluationManifestIntegrityError("reference_mismatch");
  }
  const { definitionSha256, schemaVersion: _manifestVersion, scope, ...definition } = manifest;
  if (
    digest(encodePolicyEvaluationManifestDefinition({ definition, scope })) !== definitionSha256
  ) {
    throw new PolicyEvaluationManifestIntegrityError("digest_mismatch");
  }
  if (expected.sources.length !== manifest.entryCount)
    throw new PolicyEvaluationManifestIntegrityError("source_closure_mismatch");
  let sourceIndex = 0;
  for (const page of pages) {
    const {
      definitionSha256: pageDigest,
      schemaVersion: _pageVersion,
      scope: pageScope,
      ...pageDefinition
    } = page;
    if (
      digest(
        encodePolicyEvaluationManifestPageDefinition({
          definition: pageDefinition,
          scope: pageScope,
        }),
      ) !== pageDigest
    ) {
      throw new PolicyEvaluationManifestIntegrityError("digest_mismatch");
    }
    for (const entry of page.entries) {
      if (!equalJson(entry.source, expected.sources[sourceIndex]))
        throw new PolicyEvaluationManifestIntegrityError("source_closure_mismatch");
      sourceIndex += 1;
    }
  }
  return pageSet;
}
