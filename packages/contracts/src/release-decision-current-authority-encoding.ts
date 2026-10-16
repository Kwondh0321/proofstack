import { z } from "zod";
import { encodeEvaluationCanonicalJson } from "./evaluation-definition-encoding.js";
import { EvidenceScopeSchema, type EvidenceScope } from "./evidence.js";
import { Sha256Schema } from "./primitives.js";
import { MAX_RELEASE_DECISION_AUTHORITY_MATERIAL_BYTES } from "./release-decision-authority-material.js";
import {
  ReleaseDecisionAuthorityPageDefinitionSchema,
  ReleaseDecisionAuthoritySnapshotDefinitionSchema,
  type ReleaseDecisionAuthorityPageDefinition,
  type ReleaseDecisionAuthoritySnapshotDefinition,
} from "./release-decision-authority-snapshot.js";
import {
  RELEASE_DECISION_CURRENT_AUTHORITY_SCHEMA_VERSION,
  ReleaseDecisionCurrentAuthorityMaterialSchema,
  type ReleaseDecisionCurrentAuthorityMaterial,
} from "./release-decision-current-authority-material.js";

export const RELEASE_DECISION_CURRENT_AUTHORITY_MATERIAL_DOMAIN =
  "proofstack.release-decision-authority-material.v2";
export const RELEASE_DECISION_CURRENT_AUTHORITY_MATERIAL_ENCODING =
  "proofstack.release-decision-authority-material-jcs.v2";
export const RELEASE_DECISION_CURRENT_AUTHORITY_SNAPSHOT_DOMAIN =
  "proofstack.release-decision-authority-snapshot.v2";
export const RELEASE_DECISION_CURRENT_AUTHORITY_SNAPSHOT_ENCODING =
  "proofstack.release-decision-authority-snapshot-definition-jcs.v2";
export const RELEASE_DECISION_CURRENT_AUTHORITY_PAGE_DOMAIN =
  "proofstack.release-decision-authority-page.v2";
export const RELEASE_DECISION_CURRENT_AUTHORITY_PAGE_ENCODING =
  "proofstack.release-decision-authority-page-definition-jcs.v2";

/** Reuse the proven strict frame/page geometry; preserve all historical 0.1 domains and schemas. */
export const ReleaseDecisionCurrentAuthoritySnapshotSchema =
  ReleaseDecisionAuthoritySnapshotDefinitionSchema.safeExtend({
    schemaVersion: z.literal(RELEASE_DECISION_CURRENT_AUTHORITY_SCHEMA_VERSION),
    definitionSha256: Sha256Schema,
  });
export const ReleaseDecisionCurrentAuthorityPageSchema =
  ReleaseDecisionAuthorityPageDefinitionSchema.safeExtend({
    scope: EvidenceScopeSchema,
    schemaVersion: z.literal(RELEASE_DECISION_CURRENT_AUTHORITY_SCHEMA_VERSION),
    definitionSha256: Sha256Schema,
  });
const Material = z
  .object({ scope: EvidenceScopeSchema, material: ReleaseDecisionCurrentAuthorityMaterialSchema })
  .strict();
const Header = z
  .object({
    scope: EvidenceScopeSchema,
    definition: ReleaseDecisionAuthoritySnapshotDefinitionSchema,
  })
  .strict();
const Page = z
  .object({ scope: EvidenceScopeSchema, definition: ReleaseDecisionAuthorityPageDefinitionSchema })
  .strict();
function sameScope(a: EvidenceScope, b: EvidenceScope) {
  if (
    a.tenantId !== b.tenantId ||
    a.projectId !== b.projectId ||
    a.environmentId !== b.environmentId
  )
    throw new TypeError("Current authority source scope must equal its canonical digest scope");
}
function envelope(value: unknown, domain: string, encoding: string) {
  return encodeEvaluationCanonicalJson({
    ...JSON.parse(JSON.stringify(value)),
    definitionDomain: domain,
    encodingVersion: encoding,
    schemaVersion: RELEASE_DECISION_CURRENT_AUTHORITY_SCHEMA_VERSION,
  });
}
export function encodeReleaseDecisionCurrentAuthorityMaterial(input: {
  readonly scope: EvidenceScope;
  readonly material: ReleaseDecisionCurrentAuthorityMaterial;
}): Uint8Array {
  const parsed = Material.parse(input);
  sameScope(parsed.scope, parsed.material.base.scope);
  const bytes = envelope(
    parsed,
    RELEASE_DECISION_CURRENT_AUTHORITY_MATERIAL_DOMAIN,
    RELEASE_DECISION_CURRENT_AUTHORITY_MATERIAL_ENCODING,
  );
  if (bytes.byteLength > MAX_RELEASE_DECISION_AUTHORITY_MATERIAL_BYTES)
    throw new RangeError("Current authority envelope exceeds its fixed canonical UTF-8 ceiling");
  return bytes;
}
export function encodeReleaseDecisionCurrentAuthoritySnapshotDefinition(input: {
  readonly scope: EvidenceScope;
  readonly definition: ReleaseDecisionAuthoritySnapshotDefinition;
}): Uint8Array {
  const parsed = Header.parse(input);
  sameScope(parsed.scope, parsed.definition.scope);
  return envelope(
    parsed,
    RELEASE_DECISION_CURRENT_AUTHORITY_SNAPSHOT_DOMAIN,
    RELEASE_DECISION_CURRENT_AUTHORITY_SNAPSHOT_ENCODING,
  );
}
export function encodeReleaseDecisionCurrentAuthorityPageDefinition(input: {
  readonly scope: EvidenceScope;
  readonly definition: ReleaseDecisionAuthorityPageDefinition;
}): Uint8Array {
  return envelope(
    Page.parse(input),
    RELEASE_DECISION_CURRENT_AUTHORITY_PAGE_DOMAIN,
    RELEASE_DECISION_CURRENT_AUTHORITY_PAGE_ENCODING,
  );
}
export type ReleaseDecisionCurrentAuthoritySnapshot = z.infer<
  typeof ReleaseDecisionCurrentAuthoritySnapshotSchema
>;
export type ReleaseDecisionCurrentAuthorityPage = z.infer<
  typeof ReleaseDecisionCurrentAuthorityPageSchema
>;
