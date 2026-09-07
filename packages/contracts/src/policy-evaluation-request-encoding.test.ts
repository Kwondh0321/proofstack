import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  encodePolicyEvaluationRequestDefinition,
  POLICY_EVALUATION_REQUEST_DEFINITION_DOMAIN,
  POLICY_EVALUATION_REQUEST_DEFINITION_ENCODING_VERSION,
  type ScopedPolicyEvaluationRequestDefinition,
} from "./policy-evaluation-request-encoding.js";

const document = JSON.parse(
  readFileSync(
    new URL("../vectors/policy-evaluation-request-definition-v1.json", import.meta.url),
    "utf8",
  ),
) as {
  readonly format: string;
  readonly vectors: readonly {
    readonly input: ScopedPolicyEvaluationRequestDefinition;
    readonly encodedByteLength: number;
    readonly sha256: string;
  }[];
};
const vector = document.vectors[0];
if (!vector) throw new Error("Expected a public policy evaluation request vector");

const mutations: readonly {
  readonly label: string;
  readonly change: (input: ScopedPolicyEvaluationRequestDefinition) => void;
}[] = [
  ...(["tenantId", "projectId", "environmentId"] as const).map((field) => ({
    label: `scope ${field}`,
    change: (input: ScopedPolicyEvaluationRequestDefinition) => {
      input.scope[field] = "scope_changed";
    },
  })),
  ...(["candidateId", "candidateVersionId", "definitionSha256"] as const).map((field) => ({
    label: `candidate ${field}`,
    change: (input: ScopedPolicyEvaluationRequestDefinition) => {
      input.definition.candidate[field] =
        field === "definitionSha256" ? "3".repeat(64) : "candidate_changed";
    },
  })),
  ...(["policyId", "policyVersionId", "definitionSha256"] as const).map((field) => ({
    label: `policy ${field}`,
    change: (input: ScopedPolicyEvaluationRequestDefinition) => {
      input.definition.policy[field] =
        field === "definitionSha256" ? "3".repeat(64) : "policy_changed";
    },
  })),
  {
    label: "request identity",
    change: (input) => {
      input.definition.evaluationRequestId = "request_changed";
    },
  },
  {
    label: "evaluation time at the last fractional digit",
    change: (input) => {
      input.definition.evaluationTime = "2026-09-07T11:59:59.999999999999999999999999999998Z";
    },
  },
  ...Object.entries(vector.input.definition.limits)
    .filter(([, value]) => typeof value === "number")
    .map(([field, value]) => ({
      label: `limit ${field}`,
      change: (input: ScopedPolicyEvaluationRequestDefinition) => {
        Object.assign(input.definition.limits, {
          [field]: (value as number) + (field === "maxRuleEvaluations" ? -1 : 1),
        });
      },
    })),
  ...vector.input.definition.limits.retryableErrors.map((error) => ({
    label: `retry ${error}`,
    change: (input: ScopedPolicyEvaluationRequestDefinition) => {
      input.definition.limits.retryableErrors = input.definition.limits.retryableErrors.filter(
        (item) => item !== error,
      );
    },
  })),
];

describe("canonical policy evaluation request encoding", () => {
  it("matches independently constructed public UTF-8 and SHA-256 bytes", () => {
    expect(document.format).toBe("proofstack.policy-evaluation-request-definition.v1");
    const encoded = encodePolicyEvaluationRequestDefinition(vector.input);
    expect(encoded.byteLength).toBe(vector.encodedByteLength);
    expect(createHash("sha256").update(encoded).digest("hex")).toBe(vector.sha256);
    const value = JSON.parse(new TextDecoder().decode(encoded));
    expect(value).toEqual({
      ...vector.input,
      definitionDomain: POLICY_EVALUATION_REQUEST_DEFINITION_DOMAIN,
      encodingVersion: POLICY_EVALUATION_REQUEST_DEFINITION_ENCODING_VERSION,
      schemaVersion: "0.1",
    });
  });

  it("does not depend on object insertion order or mutate original timestamp bytes", () => {
    const input = structuredClone(vector.input);
    const before = JSON.stringify(input);
    const original = encodePolicyEvaluationRequestDefinition(input);
    const reorder = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(reorder);
      if (value && typeof value === "object")
        return Object.fromEntries(
          Object.entries(value)
            .reverse()
            .map(([key, item]) => [key, reorder(item)]),
        );
      return value;
    };
    expect(encodePolicyEvaluationRequestDefinition(reorder(input) as never)).toEqual(original);
    expect(JSON.stringify(input)).toBe(before);
  });

  it.each(mutations)("binds $label in the definition digest", ({ change }) => {
    const input = structuredClone(vector.input);
    change(input);
    expect(encodePolicyEvaluationRequestDefinition(input)).not.toEqual(
      encodePolicyEvaluationRequestDefinition(vector.input),
    );
  });

  it("rejects receipt, computation, and scope override fields at both object boundaries", () => {
    for (const field of [
      "createdAt",
      "createdByPrincipalId",
      "definitionSha256",
      "schemaVersion",
      "verdict",
      "workerId",
      "lease",
      "approval",
    ]) {
      expect(() =>
        encodePolicyEvaluationRequestDefinition({ ...vector.input, [field]: "forged" } as never),
      ).toThrow();
      expect(() =>
        encodePolicyEvaluationRequestDefinition({
          ...vector.input,
          definition: { ...vector.input.definition, [field]: "forged" },
        } as never),
      ).toThrow();
    }
    expect(() =>
      encodePolicyEvaluationRequestDefinition({
        ...vector.input,
        definition: { ...vector.input.definition, scope: vector.input.scope },
      } as never),
    ).toThrow();
    expect(() =>
      encodePolicyEvaluationRequestDefinition({
        ...vector.input,
        scope: { ...vector.input.scope, role: "owner" },
      } as never),
    ).toThrow();
  });
});
