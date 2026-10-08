import { readFileSync } from "node:fs";
import {
  type EvidenceScope,
  type QualificationPolicyDefinition,
  type QualificationPolicyRecord,
} from "@proofstack/contracts";
import { describe, expect, it } from "vitest";
import {
  digestQualificationPolicy,
  InvalidQualificationPolicyRecordError,
  MAX_STATIC_QUALIFICATION_POLICIES,
  StaticQualificationPolicyCatalogue,
  validateQualificationPolicyRecord,
} from "./qualification-policy.js";

const vectors = (
  JSON.parse(
    readFileSync(
      new URL("../../../contracts/vectors/qualification-policy-v1.json", import.meta.url),
      "utf8",
    ),
  ) as {
    vectors: {
      input: { definition: QualificationPolicyDefinition; scope: EvidenceScope };
      sha256: string;
    }[];
  }
).vectors;

function record(index = 0): QualificationPolicyRecord {
  const vector = vectors[index];
  if (!vector) throw new Error("Missing fixed qualification policy vector");
  return structuredClone({
    ...vector.input.definition,
    scope: vector.input.scope,
    definitionSha256: vector.sha256,
    schemaVersion: "0.1" as const,
    publishedAt: "2026-10-08T00:00:00.000Z",
    publishedByPrincipalId: "operator_policy",
  });
}

function rehash(value: QualificationPolicyRecord) {
  const {
    definitionSha256: _sha,
    publishedAt: _at,
    publishedByPrincipalId: _by,
    schemaVersion: _version,
    scope,
    ...definition
  } = value;
  value.definitionSha256 = digestQualificationPolicy(scope, definition);
  return value;
}

describe("independent retained qualification policy catalogue", () => {
  it("looks up exact scope and both identities without choosing a latest version", async () => {
    const rows = [record(0), record(1), record(2)];
    const catalogue = new StaticQualificationPolicyCatalogue(rows);
    for (const row of rows)
      await expect(
        catalogue.findQualificationPolicy(row.scope, row.policyId, row.policyVersionId),
      ).resolves.toEqual(row);
    const original = record();
    for (const dimension of ["tenantId", "projectId", "environmentId"] as const)
      await expect(
        catalogue.findQualificationPolicy(
          { ...original.scope, [dimension]: "outside_scope" },
          original.policyId,
          original.policyVersionId,
        ),
      ).resolves.toBeNull();
    for (const [id, version] of [
      ["policy_missing", original.policyVersionId],
      [original.policyId, "version_missing"],
    ])
      await expect(
        catalogue.findQualificationPolicy(original.scope, id as string, version as string),
      ).resolves.toBeNull();
    await expect(
      new StaticQualificationPolicyCatalogue([]).findQualificationPolicy(
        original.scope,
        original.policyId,
        original.policyVersionId,
      ),
    ).resolves.toBeNull();
  });

  it("rejects malformed and coercible lookup coordinates before treating them as identities", async () => {
    const original = record();
    const catalogue = new StaticQualificationPolicyCatalogue([original]);
    for (const scope of [
      { ...original.scope, tenantId: "" },
      { ...original.scope, projectId: "" },
      { ...original.scope, environmentId: "" },
      { ...original.scope, approved: true },
    ])
      await expect(
        catalogue.findQualificationPolicy(scope, original.policyId, original.policyVersionId),
      ).rejects.toThrow();
    let coerced = false;
    const coercible = {
      toString: () => {
        coerced = true;
        return original.policyId;
      },
    };
    for (const [id, version] of [
      ["", original.policyVersionId],
      [original.policyId, ""],
      [coercible, original.policyVersionId],
    ])
      await expect(
        catalogue.findQualificationPolicy(original.scope, id as string, version as string),
      ).rejects.toThrow();
    expect(coerced).toBe(false);
    expect(new InvalidQualificationPolicyRecordError().code).toBe(
      "qualification_policy_record_invalid",
    );
  });

  it("copies inputs and detaches outputs, including nested case arrays and original publication receipts", async () => {
    const original = record();
    const supplied = [structuredClone(original)];
    const catalogue = new StaticQualificationPolicyCatalogue(supplied);
    const input = supplied[0];
    if (!input) throw new Error("Missing operator input");
    input.requiredCaseKinds.pop();
    input.publishedAt = "2026-10-09T00:00:00.000Z";
    input.scope.tenantId = "input_mutation";
    supplied.length = 0;
    const read = () =>
      catalogue.findQualificationPolicy(
        original.scope,
        original.policyId,
        original.policyVersionId,
      );
    const first = await read();
    expect(first).toEqual(original);
    if (!first) throw new Error("Missing retained policy");
    first.requiredCaseKinds.pop();
    first.publishedByPrincipalId = "output_mutation";
    first.scope.projectId = "output_mutation";
    await expect(read()).resolves.toEqual(original);
  });
  it("validates independent digests and preserves changed receipts without changing semantic identity", () => {
    for (let index = 0; index < vectors.length; index++) {
      const row = record(index);
      expect(rehash(structuredClone(row)).definitionSha256).toBe(row.definitionSha256);
      expect(validateQualificationPolicyRecord(row)).toEqual(row);
      const changedReceipt = {
        ...row,
        publishedAt: "2026-10-09T00:00:00.000Z",
        publishedByPrincipalId: "operator_other",
      };
      expect(validateQualificationPolicyRecord(changedReceipt)).toEqual(changedReceipt);
      expect(rehash(structuredClone(changedReceipt)).definitionSha256).toBe(row.definitionSha256);
    }
    for (const raw of [
      null,
      undefined,
      { ...record(), definitionSha256: "f".repeat(64) },
      { ...record(), policyId: "policy_other" },
      { ...record(), qualified: true },
      { ...record(), publishedAt: "2026-10-08T00:00:00.000001Z" },
      { ...record(), unexpectedErrorLimit: 1 },
    ]) {
      expect(() => validateQualificationPolicyRecord(raw)).toThrow(
        InvalidQualificationPolicyRecordError,
      );
      expect(() => new StaticQualificationPolicyCatalogue([raw])).toThrow(
        InvalidQualificationPolicyRecordError,
      );
    }
  });

  it("rejects duplicate identities even when original receipts differ", () => {
    const original = record();
    for (const duplicate of [
      structuredClone(original),
      { ...original, publishedAt: "2026-10-09T00:00:00.000Z" },
      { ...original, publishedByPrincipalId: "operator_other" },
    ])
      expect(() => new StaticQualificationPolicyCatalogue([original, duplicate])).toThrow(
        "Duplicate",
      );
  });

  it("admits the exact catalogue limit and rejects overflow before visiting any records", async () => {
    const rows = Array.from({ length: MAX_STATIC_QUALIFICATION_POLICIES }, (_, index) =>
      rehash({ ...record(), policyVersionId: `qver_limit_${index}` }),
    );
    const catalogue = new StaticQualificationPolicyCatalogue(rows);
    const last = rows.at(-1);
    if (!last) throw new Error("Missing exact-limit record");
    await expect(
      catalogue.findQualificationPolicy(last.scope, last.policyId, last.policyVersionId),
    ).resolves.toEqual(last);
    let visited = false;
    const overflow = new Proxy(Array(MAX_STATIC_QUALIFICATION_POLICIES + 1).fill(null), {
      get: (target, property, receiver) => {
        if (property === "0") visited = true;
        return Reflect.get(target, property, receiver);
      },
    });
    expect(() => new StaticQualificationPolicyCatalogue(overflow)).toThrow("entry limit");
    expect(visited).toBe(false);
  });

  it("rejects non-arrays and sparse entries without inventing policy bodies", () => {
    for (const input of [
      null,
      undefined,
      {},
      { length: 0 },
      { length: -1 },
      { length: NaN },
      new Array(2),
    ])
      expect(() => new StaticQualificationPolicyCatalogue(input as readonly unknown[])).toThrow();
  });
});
