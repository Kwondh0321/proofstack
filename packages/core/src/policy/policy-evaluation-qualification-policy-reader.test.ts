import { readFileSync } from "node:fs";
import {
  type EvidenceScope,
  type QualificationPolicyDefinition,
  type QualificationPolicyRecord,
} from "@proofstack/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  digestQualificationPolicy,
  InvalidQualificationPolicyRecordError,
  StaticQualificationPolicyCatalogue,
} from "../evaluation/qualification-policy.js";
import { PolicyEvaluationDefinitionReadInputError } from "./policy-evaluation-definition-reader.js";
import {
  enumeratePolicyEvaluationQualificationPolicyReferences,
  inspectPolicyEvaluationQualificationPolicyRecord,
  readPolicyEvaluationQualificationPolicyRecord,
} from "./policy-evaluation-qualification-policy-reader.js";

const document = JSON.parse(
  readFileSync(
    new URL("../../../contracts/vectors/qualification-policy-v1.json", import.meta.url),
    "utf8",
  ),
) as {
  vectors: {
    input: { definition: QualificationPolicyDefinition; scope: EvidenceScope };
    sha256: string;
  }[];
};
const limits = { maxReferences: 10000, maxReferenceBytes: 4000000 };
function scenario(index = 0) {
  const vector = document.vectors[index];
  if (!vector) throw new Error("Missing independent qualification vector");
  const record: QualificationPolicyRecord = {
    ...structuredClone(vector.input.definition),
    scope: structuredClone(vector.input.scope),
    definitionSha256: vector.sha256,
    schemaVersion: "0.1",
    publishedAt: "2026-09-01T00:00:00.001Z",
    publishedByPrincipalId: "operator_retained",
  };
  return {
    record,
    input: {
      evaluationTime: "2026-09-01T00:00:00.001000000000000000000000000000Z",
      scope: structuredClone(record.scope),
      source: {
        kind: "qualification_policy" as const,
        reference: {
          policyId: record.policyId,
          policyVersionId: record.policyVersionId,
          definitionSha256: record.definitionSha256,
        },
      },
    },
  };
}
function rehash(record: QualificationPolicyRecord) {
  const {
    scope,
    definitionSha256: _hash,
    publishedAt: _at,
    publishedByPrincipalId: _by,
    schemaVersion: _version,
    ...definition
  } = record;
  record.definitionSha256 = digestQualificationPolicy(scope, definition);
  return record;
}

describe("exact retained qualification policy acquisition", () => {
  it.each([0, 1, 2])(
    "reads independent vector %s with every original coordinate and no digest-selected lookup",
    async (index) => {
      const s = scenario(index);
      const catalogue = new StaticQualificationPolicyCatalogue([s.record]);
      const read = vi.fn((...args: Parameters<typeof catalogue.findQualificationPolicy>) =>
        catalogue.findQualificationPolicy(...args),
      );
      const result = await readPolicyEvaluationQualificationPolicyRecord(s.input, {
        findQualificationPolicy: read,
      });
      expect(result.observation.status).toBe("verified");
      expect(result.record).toEqual(s.record);
      expect(read).toHaveBeenCalledExactlyOnceWith(
        s.input.scope,
        s.record.policyId,
        s.record.policyVersionId,
      );
      expect(result).toEqual(inspectPolicyEvaluationQualificationPolicyRecord(s.input, s.record));
      expect(
        enumeratePolicyEvaluationQualificationPolicyReferences(s.input, result, {
          maxReferences: 0,
          maxReferenceBytes: 0,
        }).references,
      ).toEqual([]);
      if (index === 0) {
        // Independently computed by Python sorted JSON, not the production encoder.
        expect(result.observation).toEqual({
          status: "verified",
          recordSha256: "ff6a12b8396c3635bc4bf529d28e9376fea626d7e93640f2b2ed1c156b264672",
        });
      }
      expect(result).not.toHaveProperty("qualified");
      expect(result).not.toHaveProperty("sealed");
    },
  );

  it("keeps null missing and malformed, unsupported, authority-bearing or digest-invalid bodies unavailable", () => {
    const s = scenario();
    expect(inspectPolicyEvaluationQualificationPolicyRecord(s.input, null)).toEqual({
      source: s.input.source,
      observation: { status: "missing" },
      record: null,
    });
    for (const raw of [
      undefined,
      false,
      0,
      {},
      { ...s.record, definitionSha256: "0".repeat(64) },
      { ...s.record, approved: true },
      { ...s.record, caseMatching: "any_case" },
      { ...s.record, unexpectedErrorLimit: 1 },
    ]) {
      expect(inspectPolicyEvaluationQualificationPolicyRecord(s.input, raw)).toEqual({
        source: s.input.source,
        observation: { status: "unavailable", reason: "record_invalid" },
        record: null,
      });
    }
  });

  it("compares all three reference and scope fields even when a substituted body has a valid digest", () => {
    const s = scenario();
    for (const field of ["policyId", "policyVersionId", "definitionSha256"] as const) {
      const input = structuredClone(s.input);
      input.source.reference[field] =
        field === "definitionSha256" ? "d".repeat(64) : "other_identity";
      expect(inspectPolicyEvaluationQualificationPolicyRecord(input, s.record).observation).toEqual(
        { status: "unavailable", reason: "reference_mismatch" },
      );
    }
    for (const field of ["tenantId", "projectId", "environmentId"] as const) {
      const record = rehash({
        ...structuredClone(s.record),
        scope: { ...s.record.scope, [field]: "outside_scope" },
      });
      expect(inspectPolicyEvaluationQualificationPolicyRecord(s.input, record).observation).toEqual(
        { status: "unavailable", reason: "reference_mismatch" },
      );
    }
    for (const field of ["policyId", "policyVersionId"] as const) {
      const record = rehash({ ...structuredClone(s.record), [field]: "other_identity" });
      expect(inspectPolicyEvaluationQualificationPolicyRecord(s.input, record).observation).toEqual(
        { status: "unavailable", reason: "reference_mismatch" },
      );
    }
  });

  it("uses the unrounded cut and hashes publication receipts without changing semantic identity", () => {
    const s = scenario();
    const before = {
      ...s.input,
      evaluationTime: "2026-09-01T00:00:00.000999999999999999999999999999Z",
    };
    expect(inspectPolicyEvaluationQualificationPolicyRecord(before, s.record).observation).toEqual({
      status: "unavailable",
      reason: "not_yet_available",
    });
    const original = inspectPolicyEvaluationQualificationPolicyRecord(s.input, s.record);
    for (const patch of [
      { publishedByPrincipalId: "operator_other" },
      { publishedAt: "2026-09-01T00:00:00.000Z" },
    ]) {
      const result = inspectPolicyEvaluationQualificationPolicyRecord(s.input, {
        ...s.record,
        ...patch,
      });
      expect(result.source).toEqual(original.source);
      expect(result.observation.status).toBe("verified");
      expect(result.observation).not.toEqual(original.observation);
      expect(result.record).toMatchObject(patch);
    }
  });

  it("rejects invalid or unsupported context before lookup and propagates operational failures", async () => {
    const s = scenario();
    const read = vi.fn(async () => s.record);
    for (const input of [
      null,
      { ...s.input, authority: true },
      { ...s.input, evaluationTime: "invalid" },
      { ...s.input, scope: { ...s.input.scope, tenantId: "" } },
      { ...s.input, source: { kind: "release_policy", reference: s.input.source.reference } },
    ]) {
      await expect(
        readPolicyEvaluationQualificationPolicyRecord(input as typeof s.input, {
          findQualificationPolicy: read,
        }),
      ).rejects.toThrow(PolicyEvaluationDefinitionReadInputError);
    }
    expect(read).not.toHaveBeenCalled();
    for (const error of [
      new Error("storage unavailable"),
      new InvalidQualificationPolicyRecordError(),
    ]) {
      await expect(
        readPolicyEvaluationQualificationPolicyRecord(s.input, {
          findQualificationPolicy: async () => {
            throw error;
          },
        }),
      ).rejects.toBe(error);
    }
  });

  it("owns context across I/O mutation and returns a detached original body", async () => {
    const s = scenario();
    const original = structuredClone(s);
    const result = await readPolicyEvaluationQualificationPolicyRecord(s.input, {
      findQualificationPolicy: async (scope) => {
        scope.environmentId = "port_mutation";
        s.input.scope.tenantId = "caller_mutation";
        s.input.source.reference.policyVersionId = "version_mutated";
        return original.record;
      },
    });
    expect(result).toEqual(
      inspectPolicyEvaluationQualificationPolicyRecord(original.input, original.record),
    );
    if (!result.record) throw new Error("Missing original policy");
    result.record.requiredCaseKinds.reverse();
    expect(original.record.requiredCaseKinds).toEqual(
      document.vectors[0]?.input.definition.requiredCaseKinds,
    );
  });

  it("revalidates full captured observations and rejects forged leaves or unexpected limit fields", () => {
    const s = scenario();
    const read = inspectPolicyEvaluationQualificationPolicyRecord(s.input, s.record);
    for (const patch of [
      { observation: { status: "verified", recordSha256: "0".repeat(64) } },
      {
        source: {
          ...s.input.source,
          reference: { ...s.input.source.reference, policyId: "other_policy" },
        },
      },
      { record: { ...s.record, publishedByPrincipalId: "operator_other" } },
      { observation: { status: "missing" }, record: null },
      { authority: true },
    ]) {
      expect(() =>
        enumeratePolicyEvaluationQualificationPolicyReferences(
          s.input,
          { ...read, ...patch } as never,
          limits,
        ),
      ).toThrow();
    }
    expect(() =>
      enumeratePolicyEvaluationQualificationPolicyReferences(s.input, read, {
        ...limits,
        extra: true,
      } as never),
    ).toThrow();
  });
});
