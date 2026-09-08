import { createHash } from "node:crypto";
import type { PolicyEvaluationSourceReference } from "@proofstack/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  PolicyEvaluationDefinitionReadInputError,
  readPolicyEvaluationDefinitionRecord,
} from "./policy-evaluation-definition-reader.js";

const scope = { environmentId: "env_test", projectId: "prj_test", tenantId: "ten_test" };
const source = {
  kind: "dataset_version",
  reference: {
    datasetId: "dat_test",
    datasetVersionId: "datv_test",
    definitionSha256: "a".repeat(64),
  },
} as const;
const time = "2026-09-08T00:00:00.000000000000000000000000000001Z";
const input = () => ({
  evaluationTime: time,
  scope: structuredClone(scope),
  source: structuredClone(source),
});
const record = () => ({ ...source.reference, createdAt: time, scope: structuredClone(scope) });

// An independent, sorted-field oracle for this fixed fixture, not the production canonical encoder.
const recordHash = () =>
  createHash("sha256")
    .update(
      `{"createdAt":"${time}","datasetId":"dat_test","datasetVersionId":"datv_test","definitionSha256":"${"a".repeat(64)}","scope":{"environmentId":"env_test","projectId":"prj_test","tenantId":"ten_test"}}`,
    )
    .digest("hex");

function adapter(raw: unknown = record()) {
  return {
    isInvalidRecordError: (cause: unknown) => cause instanceof SyntaxError,
    kinds: ["dataset_version"] as const,
    read: vi.fn(async () => raw),
    // The domain adapters separately test their real schemas/digests. This unit stub exercises
    // the shared observation boundary only; it is deliberately not an authority implementation.
    validate: vi.fn((_source: PolicyEvaluationSourceReference, value: unknown) => {
      if (typeof value !== "object" || value === null) throw new SyntaxError("invalid fixture");
      return structuredClone(value) as ReturnType<typeof record>;
    }),
  };
}

describe("domain-owned policy definition observations", () => {
  it("retains a complete canonical record hash and exact equal-time receipt", async () => {
    const port = adapter();
    expect(await readPolicyEvaluationDefinitionRecord(input(), port)).toEqual({
      observation: { recordSha256: recordHash(), status: "verified" },
      record: record(),
      source,
    });
    expect(port.read).toHaveBeenCalledExactlyOnceWith(scope, source);
  });

  for (const raw of [undefined, false, 0, "invalid"]) {
    it(`does not treat ${String(raw)} as absence`, async () => {
      const port = adapter();
      port.read.mockResolvedValue(raw);
      expect((await readPolicyEvaluationDefinitionRecord(input(), port)).observation).toEqual({
        reason: "record_invalid",
        status: "unavailable",
      });
    });
  }
  it("only treats an exact null as missing", async () => {
    const port = adapter(null);
    expect(await readPolicyEvaluationDefinitionRecord(input(), port)).toEqual({
      observation: { status: "missing" },
      record: null,
      source,
    });
    expect(port.validate).not.toHaveBeenCalled();
  });

  for (const key of ["tenantId", "projectId", "environmentId"] as const) {
    it(`rejects a valid record from another ${key}`, async () => {
      const value = record();
      value.scope[key] = "foreign_scope";
      expect(await readPolicyEvaluationDefinitionRecord(input(), adapter(value))).toEqual({
        observation: { reason: "reference_mismatch", status: "unavailable" },
        record: null,
        source,
      });
    });
  }
  for (const key of Object.keys(source.reference)) {
    it(`compares the full ${key} reference field`, async () => {
      const value = { ...record(), [key]: "substituted" };
      expect(
        (await readPolicyEvaluationDefinitionRecord(input(), adapter(value))).observation,
      ).toEqual({
        reason: "reference_mismatch",
        status: "unavailable",
      });
    });
  }
  it("does not discard sub-millisecond publication time", async () => {
    const value = { ...record(), createdAt: time.replace(/1Z$/, "2Z") };
    expect(await readPolicyEvaluationDefinitionRecord(input(), adapter(value))).toEqual({
      observation: { reason: "not_yet_available", status: "unavailable" },
      record: null,
      source,
    });
  });
  it("rejects a reference field missing from a validator's returned projection", async () => {
    const value = record();
    Reflect.deleteProperty(value, "datasetId");
    expect(
      (await readPolicyEvaluationDefinitionRecord(input(), adapter(value))).observation,
    ).toEqual({ reason: "reference_mismatch", status: "unavailable" });
  });
  it("accepts a strictly earlier receipt and binds receipt-only changes", async () => {
    const value = { ...record(), createdAt: time.replace(/1Z$/, "0Z") };
    const result = await readPolicyEvaluationDefinitionRecord(input(), adapter(value));
    expect(result.observation.status).toBe("verified");
    expect(result.observation).not.toEqual({ recordSha256: recordHash(), status: "verified" });
  });
  for (const malformed of [
    null,
    undefined,
    {},
    { ...input(), source: {} },
    { ...input(), scope: {} },
    { ...input(), evaluationTime: "2026-09-08" },
    { ...input(), operand: 0 },
    { ...input(), source: { ...source, approval: true } },
    {
      ...input(),
      source: {
        kind: "regression_fixture_version",
        reference: {
          fixtureId: "fix_a",
          fixtureVersionId: "fixv_a",
          definitionSha256: "a".repeat(64),
        },
      },
    },
  ]) {
    it(`rejects invalid or unsupported context before I/O: ${JSON.stringify(malformed)}`, async () => {
      const port = adapter();
      await expect(
        readPolicyEvaluationDefinitionRecord(malformed as ReturnType<typeof input>, port),
      ).rejects.toBeInstanceOf(PolicyEvaluationDefinitionReadInputError);
      expect(port.read).not.toHaveBeenCalled();
    });
  }
  it("propagates read failures without manufacturing missing evidence", async () => {
    const port = adapter();
    const error = new Error("storage offline");
    port.read.mockRejectedValue(error);
    await expect(readPolicyEvaluationDefinitionRecord(input(), port)).rejects.toBe(error);
  });
  it("propagates unexpected validator failures", async () => {
    const port = adapter();
    const error = new Error("validator failure");
    port.validate.mockImplementation(() => {
      throw error;
    });
    await expect(readPolicyEvaluationDefinitionRecord(input(), port)).rejects.toBe(error);
  });
  it("isolates input and port arguments before awaiting an untrusted callback", async () => {
    const command = input();
    const port = adapter();
    const read = vi.fn(
      async (portScope: typeof scope, portSource: PolicyEvaluationSourceReference) => {
        portScope.tenantId = "ten_mutated";
        (portSource.reference as { definitionSha256: string }).definitionSha256 = "b".repeat(64);
        command.scope.projectId = "prj_mutated";
        Object.assign(command.source.reference, { datasetId: "dat_mutated" });
        command.evaluationTime = "2000-01-01T00:00:00Z";
        return record();
      },
    );
    const result = await readPolicyEvaluationDefinitionRecord(command, { ...port, read });
    expect(result).toEqual({
      observation: { recordSha256: recordHash(), status: "verified" },
      record: record(),
      source,
    });
  });
  it("does not alias parsed records or captured references to repository and input state", async () => {
    const value = record();
    const command = input();
    const result = await readPolicyEvaluationDefinitionRecord(command, adapter(value));
    if (!result.record) throw new Error("expected verified record");
    result.record.scope.tenantId = "ten_returned";
    Object.assign(result.source.reference, { datasetId: "dat_returned" });
    expect(value).toEqual(record());
    expect(command).toEqual(input());
  });
});
