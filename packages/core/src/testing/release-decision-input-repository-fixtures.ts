import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  encodePolicyEvaluationRequestDefinition,
  encodeReleasePolicySelectionDefinition,
  ReleaseDecisionInputDefinitionSchema,
  ReleaseDecisionInputSchema,
  ReleasePolicyDefinitionSchema,
  ReleasePolicySelectionDefinitionSchema,
  type EvidenceScope,
  type ReleaseDecisionInput,
  type ReleaseDecisionInputDefinition,
  type ReleasePolicy,
} from "@proofstack/contracts";
import { digestReleasePolicyDefinition } from "../policy/release-policy-record-validation.js";
import { releasePolicySelectionReference } from "../release/release-authority-record-validation.js";
import { releaseCandidateReference } from "../release/release-candidate-record-validation.js";
import { digestReleaseDecisionInputDefinition } from "../release/release-decision-input-validation.js";
import type { ReleaseDecisionInputGraph } from "../release/release-decision-input-repository.js";
import { releaseCandidateFixture } from "./release-candidate-repository-fixtures.js";
import { releasePolicyRepositoryFixture } from "./release-policy-repository-fixtures.js";

function vector(name: string) {
  const document = JSON.parse(
    readFileSync(
      new URL(`../../../contracts/vectors/${name}-definition-v1.json`, import.meta.url),
      "utf8",
    ),
  );
  return structuredClone(document.vectors[0].input.definition);
}
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function policy(original: ReleasePolicy, mode: "mandatory" | "advisory") {
  const {
    schemaVersion: _version,
    definitionSha256: _sha,
    publishedAt: _at,
    publishedByPrincipalId: _by,
    scope: _scope,
    ...body
  } = original;
  const definition = ReleasePolicyDefinitionSchema.parse({ ...body, mode });
  return {
    ...original,
    ...definition,
    definitionSha256: digestReleasePolicyDefinition(original.scope, definition),
  };
}
/** Synthetic original graph. Its source witnesses are not installed current publication authority. */
export function releaseDecisionInputRepositoryFixture(
  namespace: string,
  scopeInput?: EvidenceScope,
): ReleaseDecisionInputGraph {
  const template = ReleaseDecisionInputDefinitionSchema.parse(vector("release-decision-input"));
  const scope = scopeInput ?? template.scope;
  const candidate = releaseCandidateFixture(`di_${namespace}`, scope);
  const policies = [
    policy(releasePolicyRepositoryFixture(`di_${namespace}_a`, scope), "mandatory"),
    policy(releasePolicyRepositoryFixture(`di_${namespace}_b`, scope), "advisory"),
  ];
  const installation = policies[0]?.installationBinding.installationId;
  if (!installation) throw new Error("Missing original policy fixture");
  const selectionDefinition = ReleasePolicySelectionDefinitionSchema.parse({
    ...vector("release-policy-selection"),
    scope,
    selectionId: `selection_di_${namespace}`,
    selectionVersionId: `version_di_${namespace}`,
    candidateTarget: candidate.target,
    installationId: installation,
    authorizedPublisherPrincipalIds: [template.publisher.principalId],
    policies: policies.map((p) => ({
      mode: p.mode,
      policy: {
        policyId: p.policyId,
        policyVersionId: p.policyVersionId,
        definitionSha256: p.definitionSha256,
      },
    })),
  });
  const selection = {
    ...selectionDefinition,
    schemaVersion: "0.1" as const,
    publishedAt: "2026-10-15T00:00:00.000001Z",
    publishedByPrincipalId: selectionDefinition.issuerPrincipalId,
    definitionSha256: sha(
      encodeReleasePolicySelectionDefinition({ scope, definition: selectionDefinition }),
    ),
  };
  const definition = ReleaseDecisionInputDefinitionSchema.parse({
    ...template,
    scope,
    decisionInputRequestId: `input_${namespace}`,
    candidate: releaseCandidateReference(candidate),
    selection: releasePolicySelectionReference(selection),
    evaluations: template.evaluations.map((planned, index) => {
      const p = policies[index];
      if (!p) throw new Error("Missing selected policy fixture");
      const request = {
        ...planned.request,
        evaluationRequestId: `request_di_${namespace}_${index}`,
        candidate: releaseCandidateReference(candidate),
        policy: {
          policyId: p.policyId,
          policyVersionId: p.policyVersionId,
          definitionSha256: p.definitionSha256,
        },
      };
      return {
        mode: p.mode,
        request,
        requestSha256: sha(encodePolicyEvaluationRequestDefinition({ scope, definition: request })),
      };
    }),
  });
  return { request: decisionInputVersion(definition), candidate, selection, policies };
}
export function decisionInputVersion(
  original: ReleaseDecisionInput | ReleaseDecisionInputDefinition,
  patch: Partial<ReleaseDecisionInputDefinition> = {},
): ReleaseDecisionInput {
  const {
    schemaVersion: _version,
    definitionSha256: _sha,
    ...body
  } = { ...original, ...patch } as ReleaseDecisionInput;
  // Replanning a test cut updates every exact semantic time and owning canonical request hash.
  const evaluations = body.evaluations.map((p) => {
    const request = { ...p.request, evaluationTime: body.createdAt };
    return {
      ...p,
      request,
      requestSha256: sha(
        encodePolicyEvaluationRequestDefinition({ scope: body.scope, definition: request }),
      ),
    };
  });
  const definition = ReleaseDecisionInputDefinitionSchema.parse({ ...body, evaluations });
  return ReleaseDecisionInputSchema.parse({
    ...definition,
    schemaVersion: "0.1",
    definitionSha256: digestReleaseDecisionInputDefinition(definition.scope, definition),
  });
}
