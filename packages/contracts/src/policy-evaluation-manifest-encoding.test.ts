import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  encodePolicyEvaluationManifestDefinition,
  encodePolicyEvaluationManifestPageDefinition,
  POLICY_EVALUATION_MANIFEST_DOMAIN,
  POLICY_EVALUATION_MANIFEST_PAGE_DOMAIN,
} from "./policy-evaluation-manifest-encoding.js";
import type {
  PolicyEvaluationManifestDefinition,
  PolicyEvaluationManifestPageDefinition,
} from "./policy-evaluation-manifest.js";
import type { EvidenceScope } from "./evidence.js";

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected manifest vector member");
  return value;
}
const document = JSON.parse(
  readFileSync(new URL("../vectors/policy-evaluation-manifest-v1.json", import.meta.url), "utf8"),
) as {
  format: string;
  vectors: {
    kind: "manifest" | "page";
    input: {
      definition: PolicyEvaluationManifestDefinition | PolicyEvaluationManifestPageDefinition;
      scope: EvidenceScope;
    };
    encodedByteLength: number;
    sha256: string;
  }[];
};
function encode(kind: "manifest" | "page", input: unknown): Uint8Array {
  return kind === "manifest"
    ? encodePolicyEvaluationManifestDefinition(input as never)
    : encodePolicyEvaluationManifestPageDefinition(input as never);
}

describe("domain-separated policy evaluation manifest vectors", () => {
  it("uses independently calculated public vectors with different root and page domains", () => {
    expect(document.format).toBe("proofstack.policy-evaluation-manifest.v1");
    expect(document.vectors.map(({ kind }) => kind)).toEqual(["page", "manifest"]);
    for (const { kind, input, encodedByteLength, sha256 } of document.vectors) {
      const bytes = encode(kind, input);
      expect(bytes.byteLength).toBe(encodedByteLength);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(sha256);
      expect(JSON.parse(new TextDecoder().decode(bytes)).definitionDomain).toBe(
        kind === "manifest"
          ? POLICY_EVALUATION_MANIFEST_DOMAIN
          : POLICY_EVALUATION_MANIFEST_PAGE_DOMAIN,
      );
    }
  });
  it.each(document.vectors)(
    "ignores object insertion order but preserves input bytes for $kind",
    ({ kind, input }) => {
      const before = structuredClone(input);
      function reverse(value: unknown): unknown {
        if (Array.isArray(value)) return value.map(reverse);
        if (value && typeof value === "object")
          return Object.fromEntries(
            Object.entries(value)
              .reverse()
              .map(([key, child]) => [key, reverse(child)]),
          );
        return value;
      }
      expect(encode(kind, reverse(input))).toEqual(encode(kind, input));
      expect(input).toEqual(before);
    },
  );
  it.each(document.vectors)(
    "binds exact scope, manifest identity and request for $kind",
    ({ kind, input }) => {
      const original = encode(kind, input);
      for (const field of ["tenantId", "projectId", "environmentId"] as const) {
        const changed = structuredClone(input);
        changed.scope[field] = "scope_other";
        expect(encode(kind, changed)).not.toEqual(original);
      }
      const changedId = structuredClone(input);
      changedId.definition.manifestId = "manifest_other";
      expect(encode(kind, changedId)).not.toEqual(original);
      for (const field of ["evaluationRequestId", "definitionSha256"] as const) {
        const changed = structuredClone(input);
        changed.definition.request[field] =
          field === "definitionSha256" ? "f".repeat(64) : "request_other";
        expect(encode(kind, changed)).not.toEqual(original);
      }
    },
  );
  it("binds unavailable observations and full exact references into page bytes", () => {
    const vector = required(document.vectors[0]);
    const original = encode("page", vector.input);
    for (const field of ["record_digest", "source_digest", "missingness", "kind"] as const) {
      const input = structuredClone(vector.input) as {
        definition: PolicyEvaluationManifestPageDefinition;
        scope: EvidenceScope;
      };
      const entry = required(input.definition.entries[0]);
      if (field === "record_digest")
        entry.observation = { status: "verified", recordSha256: "f".repeat(64) };
      if (field === "source_digest")
        Object.assign(entry.source.reference, { definitionSha256: "f".repeat(64) });
      if (field === "missingness")
        entry.observation = { status: "unavailable", reason: "reference_mismatch" };
      if (field === "kind")
        entry.source = {
          kind: "aggregation_policy",
          reference: {
            policyId: "policy_one",
            policyVersionId: "policy_version",
            definitionSha256: "c".repeat(64),
          },
        };
      expect(encode("page", input)).not.toEqual(original);
    }
    const input = structuredClone(vector.input) as {
      definition: PolicyEvaluationManifestPageDefinition;
      scope: EvidenceScope;
    };
    input.definition.entries.reverse();
    expect(() => encode("page", input)).toThrow();
  });
  it("binds the exact page digest and range into root bytes", () => {
    const vector = required(document.vectors[1]);
    for (const field of ["definitionSha256", "firstKey", "lastKey"] as const) {
      const input = structuredClone(vector.input) as {
        definition: PolicyEvaluationManifestDefinition;
        scope: EvidenceScope;
      };
      required(input.definition.pages[0])[field] =
        field === "definitionSha256"
          ? "f".repeat(64)
          : field === "firstKey"
            ? "assessment:assessment_other"
            : "comparison_result:result_other";
      expect(encode("manifest", input)).not.toEqual(encode("manifest", vector.input));
    }
  });
  it.each(document.vectors)(
    "rejects unbound receipt, actor, credential and outcome fields for $kind",
    ({ kind, input }) => {
      for (const field of [
        "createdAt",
        "actorId",
        "workerId",
        "scope",
        "credential",
        "result",
        "approval",
        "definitionSha256",
      ]) {
        expect(() =>
          encode(kind, { ...input, definition: { ...input.definition, [field]: "forged" } }),
        ).toThrow();
        if (field !== "scope")
          expect(() => encode(kind, { ...input, [field]: "forged" })).toThrow();
      }
    },
  );
});
