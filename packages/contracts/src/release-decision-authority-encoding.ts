import { z } from "zod";
import { encodeEvaluationCanonicalJson } from "./evaluation-definition-encoding.js";
import { type EvidenceScope, EvidenceScopeSchema } from "./evidence.js";
import {
  type ReleaseDecisionAuthorityMaterial,
  ReleaseDecisionAuthorityMaterialSchema,
} from "./release-decision-authority-material.js";
import {
  type ReleaseDecisionAuthorityPageDefinition,
  ReleaseDecisionAuthorityPageDefinitionSchema,
  type ReleaseDecisionAuthoritySnapshotDefinition,
  ReleaseDecisionAuthoritySnapshotDefinitionSchema,
  RELEASE_DECISION_AUTHORITY_SNAPSHOT_SCHEMA_VERSION,
} from "./release-decision-authority-snapshot.js";

export const RELEASE_DECISION_AUTHORITY_MATERIAL_DOMAIN =
  "proofstack.release-decision-authority-material.v1";
export const RELEASE_DECISION_AUTHORITY_MATERIAL_ENCODING =
  "proofstack.release-decision-authority-material-jcs.v1";
export const RELEASE_DECISION_AUTHORITY_SNAPSHOT_DOMAIN =
  "proofstack.release-decision-authority-snapshot.v1";
export const RELEASE_DECISION_AUTHORITY_SNAPSHOT_ENCODING =
  "proofstack.release-decision-authority-snapshot-definition-jcs.v1";
export const RELEASE_DECISION_AUTHORITY_PAGE_DOMAIN =
  "proofstack.release-decision-authority-page.v1";
export const RELEASE_DECISION_AUTHORITY_PAGE_ENCODING =
  "proofstack.release-decision-authority-page-definition-jcs.v1";

const Material = z
  .object({ scope: EvidenceScopeSchema, material: ReleaseDecisionAuthorityMaterialSchema })
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
function sameScope(left: EvidenceScope, right: EvidenceScope): void {
  if (
    left.tenantId !== right.tenantId ||
    left.projectId !== right.projectId ||
    left.environmentId !== right.environmentId
  )
    throw new TypeError("Authority material/header scope must equal its canonical digest scope");
}
function envelope(value: unknown, domain: string, encoding: string): Uint8Array {
  return encodeEvaluationCanonicalJson({
    ...JSON.parse(JSON.stringify(value)),
    definitionDomain: domain,
    encodingVersion: encoding,
    schemaVersion: RELEASE_DECISION_AUTHORITY_SNAPSHOT_SCHEMA_VERSION,
  });
}
export function encodeReleaseDecisionAuthorityMaterial(input: {
  readonly scope: EvidenceScope;
  readonly material: ReleaseDecisionAuthorityMaterial;
}): Uint8Array {
  const parsed = Material.parse(input);
  sameScope(parsed.scope, parsed.material.scope);
  return envelope(
    parsed,
    RELEASE_DECISION_AUTHORITY_MATERIAL_DOMAIN,
    RELEASE_DECISION_AUTHORITY_MATERIAL_ENCODING,
  );
}
export function encodeReleaseDecisionAuthoritySnapshotDefinition(input: {
  readonly scope: EvidenceScope;
  readonly definition: ReleaseDecisionAuthoritySnapshotDefinition;
}): Uint8Array {
  const parsed = Header.parse(input);
  sameScope(parsed.scope, parsed.definition.scope);
  return envelope(
    parsed,
    RELEASE_DECISION_AUTHORITY_SNAPSHOT_DOMAIN,
    RELEASE_DECISION_AUTHORITY_SNAPSHOT_ENCODING,
  );
}
export function encodeReleaseDecisionAuthorityPageDefinition(input: {
  readonly scope: EvidenceScope;
  readonly definition: ReleaseDecisionAuthorityPageDefinition;
}): Uint8Array {
  const parsed = Page.parse(input);
  return envelope(
    parsed,
    RELEASE_DECISION_AUTHORITY_PAGE_DOMAIN,
    RELEASE_DECISION_AUTHORITY_PAGE_ENCODING,
  );
}
