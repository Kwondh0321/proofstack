import { readFileSync } from "node:fs";
import {
  ReleasePolicySelectionDefinitionSchema,
  ReleasePolicySelectionSchema,
  type ReleasePolicySelection,
  type ReleasePolicySelectionDefinition,
  type ReleasePolicySelectionLifecycleEvent,
} from "@proofstack/contracts";
import {
  digestReleasePolicySelectionDefinition,
  releasePolicySelectionReference,
} from "../release/release-authority-record-validation.js";

export function releasePolicySelectionRepositoryFixture(namespace: string) {
  const vector = JSON.parse(
    readFileSync(
      new URL(
        "../../../contracts/vectors/release-policy-selection-definition-v1.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ).vectors[0];
  const definition = ReleasePolicySelectionDefinitionSchema.parse({
    ...vector.input.definition,
    selectionId: `selection_${namespace}`,
    selectionVersionId: `version_${namespace}_a`,
    installationId: `installation_${namespace}`,
    gateTargetId: `gate_${namespace}`,
  });
  const original = selectionVersion(definition, {}, definition.effectiveAt);
  const successor = selectionVersion(
    definition,
    {
      selectionVersionId: `version_${namespace}_b`,
      predecessor: releasePolicySelectionReference(original),
      effectiveAt: "2026-10-15T11:00:00.000001Z",
    },
    "2026-10-15T11:00:00.000001Z",
  );
  const withdrawal: ReleasePolicySelectionLifecycleEvent = {
    schemaVersion: "0.1",
    eventId: `event_${namespace}_withdrawn`,
    scope: original.scope,
    selection: releasePolicySelectionReference(original),
    kind: "withdrawn",
    actorPrincipalId: "principal_installer",
    occurredAt: "2026-10-15T11:00:00.000001Z",
    reason: "Withdraw this exact installed target selection.",
  };
  const supersession: ReleasePolicySelectionLifecycleEvent = {
    ...withdrawal,
    eventId: `event_${namespace}_superseded`,
    kind: "superseded",
    successor: releasePolicySelectionReference(successor),
  };
  return {
    original,
    successor,
    withdrawal,
    supersession,
    scope: original.scope,
    target: { installationId: original.installationId, gateTargetId: original.gateTargetId },
  };
}
export function selectionVersion(
  original: ReleasePolicySelectionDefinition | ReleasePolicySelection,
  patch: Partial<ReleasePolicySelectionDefinition>,
  publishedAt: string,
): ReleasePolicySelection {
  const parsed = ReleasePolicySelectionDefinitionSchema.parse(
    Object.fromEntries(
      Object.entries({ ...original, ...patch }).filter(
        ([key]) =>
          !["schemaVersion", "definitionSha256", "publishedAt", "publishedByPrincipalId"].includes(
            key,
          ),
      ),
    ),
  );
  return ReleasePolicySelectionSchema.parse({
    ...parsed,
    schemaVersion: "0.1",
    publishedAt,
    publishedByPrincipalId: parsed.issuerPrincipalId,
    definitionSha256: digestReleasePolicySelectionDefinition(parsed.scope, parsed),
  });
}
