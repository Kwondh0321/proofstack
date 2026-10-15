import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  encodeReleasePolicySelectionDefinition,
  RELEASE_POLICY_SELECTION_DEFINITION_DOMAIN,
  RELEASE_POLICY_SELECTION_ENCODING_VERSION,
} from "./release-policy-selection-encoding.js";
import { ReleasePolicySelectionDefinitionSchema } from "./release-policy-selection.js";
import { EvidenceScopeSchema } from "./evidence.js";

const document = JSON.parse(
  readFileSync(
    new URL("../vectors/release-policy-selection-definition-v1.json", import.meta.url),
    "utf8",
  ),
) as {
  readonly format: string;
  readonly vectors: readonly {
    readonly name: string;
    readonly encodedByteLength: number;
    readonly sha256: string;
    readonly input: { readonly definition: unknown; readonly scope: unknown };
  }[];
};

function input() {
  return {
    definition: ReleasePolicySelectionDefinitionSchema.parse(document.vectors[0]?.input.definition),
    scope: EvidenceScopeSchema.parse(document.vectors[0]?.input.scope),
  };
}

function digest(value: ReturnType<typeof input>): string {
  return createHash("sha256").update(encodeReleasePolicySelectionDefinition(value)).digest("hex");
}

describe("canonical complete policy selection encoding", () => {
  it("matches independently generated Python UTF-8/digest vectors", () => {
    expect(document.format).toBe("proofstack.release-policy-selection-definition.v1");
    for (const vector of document.vectors) {
      const bytes = encodeReleasePolicySelectionDefinition({
        definition: ReleasePolicySelectionDefinitionSchema.parse(vector.input.definition),
        scope: EvidenceScopeSchema.parse(vector.input.scope),
      });
      expect(bytes.byteLength).toBe(vector.encodedByteLength);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(vector.sha256);
      const text = Buffer.from(bytes).toString("utf8");
      expect(text).toContain(RELEASE_POLICY_SELECTION_DEFINITION_DOMAIN);
      expect(text).toContain(RELEASE_POLICY_SELECTION_ENCODING_VERSION);
    }
  });

  it("preserves semantics across object property ordering", () => {
    const value = input();
    expect(
      encodeReleasePolicySelectionDefinition({
        definition: Object.fromEntries(
          Object.entries(value.definition).reverse(),
        ) as typeof value.definition,
        scope: value.scope,
      }),
    ).toEqual(encodeReleasePolicySelectionDefinition(value));
  });

  it.each(["tenantId", "projectId", "environmentId"] as const)(
    "rejects an envelope with a substituted %s",
    (key) => {
      const value = input();
      expect(() =>
        encodeReleasePolicySelectionDefinition({
          ...value,
          scope: { ...value.scope, [key]: "scope_other" },
        }),
      ).toThrow(/digest scope/);
    },
  );

  it("binds full target, exact policy/mode, publisher, authority, validity and rationale", () => {
    const value = input();
    const original = digest(value);
    const changes = [
      { gateTargetId: "gate_other" },
      { installationId: "installation_other" },
      {
        candidateTarget: {
          ...value.definition.candidateTarget,
          purpose: "Another declared purpose",
        },
      },
      { candidateTarget: { ...value.definition.candidateTarget, populationTags: ["other"] } },
      {
        policies: value.definition.policies.map((policy) => ({
          ...policy,
          policy: { ...policy.policy, definitionSha256: "d".repeat(64) },
        })),
      },
      { authorizedPublisherPrincipalIds: ["publisher_other"] },
      { issuerPrincipalId: "issuer_other" },
      { authorityEvidence: { ...value.definition.authorityEvidence, sha256: "d".repeat(64) } },
      { effectiveAt: "2026-10-15T00:00:00.000002Z" },
      { expiresAt: "2026-10-16T00:00:00.000002Z" },
      { rationale: "A changed accountable choice" },
      {
        predecessor: {
          selectionId: value.definition.selectionId,
          selectionVersionId: "selection_old",
          installationId: value.definition.installationId,
          gateTargetId: value.definition.gateTargetId,
          definitionSha256: "f".repeat(64),
        },
      },
    ];
    for (const changed of changes)
      expect(digest({ ...value, definition: { ...value.definition, ...changed } })).not.toBe(
        original,
      );
    const advisory = {
      ...value.definition,
      mode: "observation_only" as const,
      policies: value.definition.policies.map((policy) => ({
        ...policy,
        mode: "advisory" as const,
      })),
    };
    expect(digest({ ...value, definition: advisory })).not.toBe(original);
    const withoutException = {
      ...value.definition,
      policies: value.definition.policies.map(({ policy, mode }) => ({ policy, mode })),
    };
    expect(digest({ ...value, definition: withoutException })).not.toBe(original);
  });

  it("rejects caller authority, result, server receipt and envelope field smuggling", () => {
    const value = input();
    for (const key of [
      "publishedAt",
      "definitionSha256",
      "decision",
      "workerId",
      "currentAuthority",
    ])
      expect(() =>
        encodeReleasePolicySelectionDefinition({
          ...value,
          definition: { ...value.definition, [key]: "untrusted" },
        }),
      ).toThrow();
    expect(() =>
      encodeReleasePolicySelectionDefinition({ ...value, current: true } as never),
    ).toThrow();
  });
});
