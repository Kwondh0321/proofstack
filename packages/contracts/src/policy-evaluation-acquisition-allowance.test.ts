import { describe, expect, it } from "vitest";
import {
  PolicyEvaluationAcquisitionAllowanceSchema as Allowance,
  PolicyEvaluationAcquisitionUsageSchema as Usage,
  PolicyEvaluationAcquisitionLimitsSchema as Limits,
} from "./policy-evaluation-acquisition-allowance.js";

const fence = {
  jobId: "job_allowance",
  attemptId: "attempt_allowance",
  workerId: "worker_allowance",
  leaseId: "lease_allowance",
  fencingToken: 1,
  recoveryEpoch: 0,
};
const usage = { reads: 1, records: 2, references: 3, recordBytes: 4, referenceBytes: 5 };
const allowance = {
  schemaVersion: "0.1",
  allowanceId: "allowance_contract",
  mutationFence: fence,
  reservedAt: "2026-10-14T12:00:00.123456Z",
  usageAtReservation: usage,
  limits: { reads: 100000, records: 100000, references: 100000, recordAndReferenceBytes: 67108864 },
};

describe("strict acquisition allowance contracts", () => {
  it("retains full native receipt precision and independent count ceilings", () => {
    expect(Allowance.parse(allowance)).toEqual(allowance);
    expect(
      Limits.parse({ reads: 0, records: 1, references: 0, recordAndReferenceBytes: 1 }),
    ).toEqual({ reads: 0, records: 1, references: 0, recordAndReferenceBytes: 1 });
  });
  it("shares the exact64MiB boundary across record and reference bytes", () => {
    expect(Usage.parse({ ...usage, recordBytes: 67108863, referenceBytes: 1 }).referenceBytes).toBe(
      1,
    );
    expect(Usage.safeParse({ ...usage, recordBytes: 67108863, referenceBytes: 2 }).success).toBe(
      false,
    );
  });
  it.each(["reads", "records", "references"] as const)(
    "rejects out-of-range and coerced %s",
    (key) => {
      for (const value of [-1, 100001, 0.1, "1", NaN, Infinity])
        expect(Usage.safeParse({ ...usage, [key]: value }).success).toBe(false);
    },
  );
  it("rejects unknown billing fields, identities, version and substituted fence shape", () => {
    expect(Usage.safeParse({ ...usage, artifactReadBytes: 1 }).success).toBe(false);
    expect(Limits.safeParse({ ...allowance.limits, ruleEvaluations: 1 }).success).toBe(false);
    expect(Allowance.safeParse({ ...allowance, schemaVersion: "0.2" }).success).toBe(false);
    expect(Allowance.safeParse({ ...allowance, allowanceId: "bad/id" }).success).toBe(false);
    expect(
      Allowance.safeParse({ ...allowance, mutationFence: { ...fence, fencingToken: "1" } }).success,
    ).toBe(false);
    expect(Allowance.safeParse({ ...allowance, settlementAuthority: true }).success).toBe(false);
  });
});
