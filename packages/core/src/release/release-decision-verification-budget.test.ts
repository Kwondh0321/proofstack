import { describe, expect, it } from "vitest";
import {
  ReleaseDecisionVerificationBudget,
  ReleaseDecisionVerificationBudgetError,
} from "./release-decision-verification-budget.js";

const limits = {
  maxAcquisitionRecords: 3,
  maxAcquisitionRecordBytes: 1_024,
  maxApprovalRecords: 1,
};
describe("one aggregate release decision verification admission", () => {
  it("counts every repeated and missing observation instead of deduplicating costs", () => {
    const meter = new ReleaseDecisionVerificationBudget(limits);
    const missing = { state: "missing" };
    meter.observe(missing);
    meter.observe(missing);
    expect(meter.snapshot()).toEqual({ records: 2, recordBytes: 38, approvalRecords: 0 });
  });
  it("uses original UTF-8/JSON escape bytes, not JS string length", () => {
    const meter = new ReleaseDecisionVerificationBudget(limits);
    const encoded = '{"rationale":"한글😀\\u0000"}';
    meter.observe({ rationale: "한글😀\0" });
    expect(meter.snapshot().recordBytes).toBe(Buffer.byteLength(encoded, "utf8"));
  });
  it("admits the exact original byte/row/approval limits", () => {
    const meter = new ReleaseDecisionVerificationBudget({
      maxAcquisitionRecords: 2,
      maxAcquisitionRecordBytes: 4,
      maxApprovalRecords: 1,
    });
    meter.observe({}, "approval");
    meter.observe({});
    expect(meter.snapshot()).toEqual({ records: 2, recordBytes: 4, approvalRecords: 1 });
  });
  it.each(["records", "recordBytes", "approvals"])(
    "taints the complete cut after %s admission fails",
    (kind) => {
      const meter = new ReleaseDecisionVerificationBudget({
        maxAcquisitionRecords: 2,
        maxAcquisitionRecordBytes: kind === "recordBytes" ? 3 : 100,
        maxApprovalRecords: 1,
      });
      meter.observe({}, "approval");
      if (kind === "records") meter.observe({});
      expect(() => meter.observe({}, kind === "approvals" ? "approval" : "metadata")).toThrow(
        ReleaseDecisionVerificationBudgetError,
      );
      expect(() => meter.observe({})).toThrow(ReleaseDecisionVerificationBudgetError);
      expect(() => meter.snapshot()).toThrow(ReleaseDecisionVerificationBudgetError);
    },
  );
  it("allows a no-approval cut while rejecting its first actual approval row", () => {
    const meter = new ReleaseDecisionVerificationBudget({ ...limits, maxApprovalRecords: 0 });
    meter.observe({ state: "complete" });
    expect(meter.snapshot().approvalRecords).toBe(0);
    expect(() => meter.observe({}, "approval")).toThrow(ReleaseDecisionVerificationBudgetError);
  });
  it("owns original limits and returns isolated usage values", () => {
    const original = { ...limits };
    const meter = new ReleaseDecisionVerificationBudget(original);
    original.maxAcquisitionRecords = 100;
    meter.observe({});
    const view = meter.snapshot();
    (view as { records: number }).records = 100;
    expect(meter.snapshot().records).toBe(1);
    meter.observe({});
    meter.observe({});
    expect(() => meter.observe({})).toThrow(ReleaseDecisionVerificationBudgetError);
  });
  it.each([undefined, { value: Number.NaN }, { value: BigInt(1) }])(
    "taints malformed canonical observations without a refundable successful report",
    (value) => {
      const meter = new ReleaseDecisionVerificationBudget(limits);
      expect(() => meter.observe(value)).toThrow(ReleaseDecisionVerificationBudgetError);
      expect(() => meter.snapshot()).toThrow(ReleaseDecisionVerificationBudgetError);
    },
  );
  it("distinguishes corrupt observations from quota exhaustion and preserves the first failure", () => {
    const quota = new ReleaseDecisionVerificationBudget({ ...limits, maxApprovalRecords: 0 });
    const invalid = new ReleaseDecisionVerificationBudget(limits);
    let quotaFailure: unknown;
    let invalidFailure: unknown;
    try {
      quota.observe({}, "approval");
    } catch (error) {
      quotaFailure = error;
    }
    try {
      invalid.observe(undefined);
    } catch (error) {
      invalidFailure = error;
    }
    expect(quotaFailure).toMatchObject({
      code: "release_decision_verification_budget_exhausted",
      reason: "approval_limit",
    });
    expect(invalidFailure).toMatchObject({
      code: "release_decision_verification_observation_invalid",
      reason: "invalid_observation",
    });
    expect(() => quota.snapshot()).toThrow(quotaFailure as Error);
    expect(() => invalid.observe({})).toThrow(invalidFailure as Error);
  });
});
