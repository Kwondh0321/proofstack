import { readFileSync } from "node:fs";
import {
  PolicyEvaluationRuleResultSchema,
  type ReleaseApprovalDefinition,
  ReleaseApprovalDefinitionSchema,
  type ReleaseApprovalRevocation,
  ReleaseApprovalRevocationSchema,
  ReleaseApprovalSchema,
  ReleaseDecisionControlObservationSchema,
  ReleasePolicyRuleSchema,
  type ReleaseReviewerAuthorityDefinition,
} from "@proofstack/contracts";
import { describe, expect, it } from "vitest";
import { capturedReleaseReviewerFixture } from "../testing/release-reviewer-fixtures.js";
import {
  InvalidCapturedRuleExceptionError,
  resolveCapturedRuleExceptionQuorum,
} from "./captured-rule-exception-quorum.js";
import { classifyReleaseRule } from "./classify-release-rule.js";
import {
  digestReleaseApprovalDefinition,
  releaseApprovalReference,
} from "./release-authority-record-validation.js";
import {
  ReleaseDecisionVerificationBudget,
  ReleaseDecisionVerificationBudgetError,
} from "./release-decision-verification-budget.js";
import type { ReleaseReviewerCensus } from "./release-reviewer-census.js";

const original = ReleaseApprovalDefinitionSchema.parse(
  JSON.parse(
    readFileSync(
      new URL("../../../contracts/vectors/release-approval-definition-v1.json", import.meta.url),
      "utf8",
    ),
  ).vectors[2].input.definition,
);

function row(
  principalId = "user_exception_reviewer",
  patch: Partial<ReleaseApprovalDefinition> = {},
  authorityPatch: Partial<ReleaseReviewerAuthorityDefinition> = {},
) {
  const value = capturedReleaseReviewerFixture({
    reviewerPrincipalId: principalId,
    authorityId: `authority_${principalId}`,
    authorityVersionId: `version_${principalId}`,
    ...authorityPatch,
  });
  const reference = {
    artifactId: `control_${principalId}`,
    classification: "internal" as const,
    mediaType: "application/json",
    sizeBytes: 10,
    sha256: "a".repeat(64),
  };
  const definition = ReleaseApprovalDefinitionSchema.parse({
    ...original,
    approvalId: `approval_${principalId}`,
    reviewer: value.receipt,
    authority: value.reference,
    conditions: [],
    declaredConflicts: [],
    expiresAt: "2026-10-15T12:00:00.000001Z",
    compensatingControls: [reference],
    ...patch,
  });
  const record = ReleaseApprovalSchema.parse({
    ...definition,
    schemaVersion: "0.1",
    definitionSha256: digestReleaseApprovalDefinition(definition.subject.scope, definition),
  });
  const catalog = {
    metadata: {
      schemaVersion: "0.1",
      scope: record.subject.scope,
      contentReference: reference,
      state: "available",
      createdAt: "2026-10-15T09:00:00.000001Z",
      availableAt: "2026-10-15T09:30:00.000001Z",
      redaction: { status: "not_required" },
      retention: { mode: "expire", expiresAt: "2026-10-15T11:00:00.000001Z" },
    },
    ownership: null,
    recordSha256: "b".repeat(64),
  };
  const control = ReleaseDecisionControlObservationSchema.parse({
    approval: releaseApprovalReference(record),
    controlIndex: 0,
    scope: record.subject.scope,
    reference,
    content: {
      state: "captured",
      startedAt: "2026-10-15T10:00:10.000001Z",
      completedAt: "2026-10-15T10:00:11.000001Z",
      catalog,
      observation: { status: "verified", sha256: reference.sha256, sizeBytes: reference.sizeBytes },
    },
    underGuards: { state: "observed", record: catalog },
  });
  const authorityCensus: ReleaseReviewerCensus = value.census;
  return {
    record,
    control,
    source: {
      approval: releaseApprovalReference(record),
      identity: value.identity,
      grant: value.grant,
      credential: value.credential,
      authorityCensus,
    },
  };
}
function input(rows = [row()]) {
  const fixture = capturedReleaseReviewerFixture();
  return {
    subject: structuredClone(original.subject),
    context: {
      ...fixture.context,
      purpose: "rule_exception" as "normal_approval" | "rule_exception",
      evaluatorPrincipalIds: [] as string[] | null,
    },
    capturedAt: fixture.capturedAt,
    census: {
      state: "complete" as "complete" | "unavailable" | "invalid",
      records: rows.map(({ record }) => record),
      revocations: [] as ReleaseApprovalRevocation[],
    },
    actors: rows.map(({ source }) => source),
    controls: rows.map(({ control }) => control),
    budget: new ReleaseDecisionVerificationBudget({
      maxAcquisitionRecords: 100_000,
      maxAcquisitionRecordBytes: 64 * 1024 * 1024,
      maxApprovalRecords: 4096,
    }),
  };
}
function revocation(value: ReturnType<typeof row>) {
  return ReleaseApprovalRevocationSchema.parse({
    schemaVersion: "0.1",
    eventId: "event_exception_revoke",
    approval: releaseApprovalReference(value.record),
    scope: value.record.subject.scope,
    reviewer: { ...value.record.reviewer, requestId: "request_exception_revoke" },
    occurredAt: "2026-10-15T10:20:00.000001Z",
    reason: "The original synthetic user revoked this exception.",
  });
}

describe("complete captured rule-exception quorum, never native waiver authority", () => {
  it("keeps known non-waivable and indeterminate outcomes conservative even after a captured quorum matches", () => {
    const policies = JSON.parse(
      readFileSync(
        new URL("../../../contracts/vectors/release-policy-definition-v1.json", import.meta.url),
        "utf8",
      ),
    );
    const rules = policies.vectors
      .find((value: { kind: string }) => value.kind === "release_policy")
      .input.definition.rules.map((rule: unknown) => ReleasePolicyRuleSchema.parse(rule));
    const rule = rules.find(
      (value: ReturnType<typeof ReleasePolicyRuleSchema.parse>) =>
        value.predicate.kind === "coverage_floor",
    );
    const results = JSON.parse(
      readFileSync(
        new URL("../../../contracts/vectors/policy-evaluation-result-v1.json", import.meta.url),
        "utf8",
      ),
    ).definition.rules.map((value: unknown) => PolicyEvaluationRuleResultSchema.parse(value));
    const violated = results.find(
      (value: ReturnType<typeof PolicyEvaluationRuleResultSchema.parse>) =>
        value.predicateKind === "coverage_floor" && value.outcome === "violated",
    );
    const unknown = results.find(
      (value: ReturnType<typeof PolicyEvaluationRuleResultSchema.parse>) =>
        value.predicateKind === "coverage_floor" && value.outcome === "indeterminate",
    );
    if (!rule || !violated || !unknown)
      throw new Error("Missing independent original rule/result vectors");
    const entry = row("user_exception_reviewer", {
      subject: { ...original.subject, ruleId: rule.ruleId },
    });
    const value = input([entry]);
    value.subject = structuredClone(entry.record.subject);
    const quorum = resolveCapturedRuleExceptionQuorum(value);
    expect(quorum.state).toBe("matched");
    const base = {
      rule: { ...rule, nonWaivable: false },
      result: { ...violated, ruleId: rule.ruleId },
      applicability: "match" as const,
      candidateAuthority: "qualified" as const,
      originalPolicyState: "active" as const,
      currentPolicyState: "active" as const,
      normalApproval: "unavailable" as const,
      ruleException: quorum.state,
    };
    expect(classifyReleaseRule(base)).toMatchObject({
      status: "satisfied",
      reason: "scoped_exception_applied",
      originalOutcome: "violated",
    });
    expect(classifyReleaseRule({ ...base, rule: { ...rule, nonWaivable: true } })).toMatchObject({
      status: "non_waivable_violation",
      reason: "non_waivable_violation",
      originalOutcome: "violated",
    });
    expect(
      classifyReleaseRule({ ...base, result: { ...unknown, ruleId: rule.ruleId } }),
    ).toMatchObject({
      status: "unresolved",
      reason: "evidence_indeterminate",
      originalOutcome: "indeterminate",
    });
    expect(classifyReleaseRule({ ...base, currentPolicyState: "withdrawn" })).toMatchObject({
      status: "unresolved",
      reason: "current_policy_unavailable",
    });
    const approvalRule = rules.find(
      (value: ReturnType<typeof ReleasePolicyRuleSchema.parse>) =>
        value.predicate.kind === "approval_required",
    );
    const approvalResult = results.find(
      (value: ReturnType<typeof PolicyEvaluationRuleResultSchema.parse>) =>
        value.predicateKind === "approval_required",
    );
    if (!approvalRule || !approvalResult)
      throw new Error("Missing original approval prerequisite vector");
    expect(
      classifyReleaseRule({
        ...base,
        rule: approvalRule,
        result: { ...approvalResult, ruleId: approvalRule.ruleId },
      }),
    ).toMatchObject({
      status: "unresolved",
      reason: "normal_approval_unavailable",
      originalOutcome: "indeterminate",
    });
    expect(approvalResult.evidence).toEqual({
      kind: "not_evaluated",
      reason: "approval_not_evaluated",
    });
    expect(violated.outcome).toBe("violated");
    expect(unknown.outcome).toBe("indeterminate");
    expect(entry.record.kind).toBe("rule_exception");
  });
  it("matches original exact exception records and retained controls without doubling approval admission", () => {
    const value = input();
    const result = resolveCapturedRuleExceptionQuorum(value);
    expect(result.state).toBe("matched");
    expect(result.supportingApprovals).toEqual(value.census.records.map(releaseApprovalReference));
    expect(result.controls).toHaveLength(1);
    expect(result.controls[0]?.inspection.state).toBe("retained");
    expect(result.expiresAt).toBe("2026-10-15T11:00:00.000001Z");
    expect(value.budget.snapshot().approvalRecords).toBe(1);
    expect(value.census.records[0]?.kind).toBe("rule_exception");
    expect(result.witnesses[0]).toMatchObject({
      independentHuman: true,
      assurance: "synthetic_reference",
    });
  });
  it.each(["candidate", "policy", "evaluator"] as const)(
    "excludes an exact %s author regardless of an otherwise matching declaration",
    (kind) => {
      const value = input();
      const actor = value.actors[0];
      if (!actor) throw new Error("Missing actor");
      const principal = actor.identity.principalId;
      if (kind === "candidate") value.context.candidateAuthorPrincipalId = principal;
      if (kind === "policy") value.context.policyAuthorPrincipalId = principal;
      if (kind === "evaluator") value.context.evaluatorPrincipalIds = [principal];
      const result = resolveCapturedRuleExceptionQuorum(value);
      expect(result.state).toBe("insufficient");
      expect(result.observations[0]?.state).toBe("ineligible");
      expect(result.supportingApprovals).toEqual([]);
    },
  );
  it("retains unknown evaluator provenance as unavailable rather than inventing independence", () => {
    const value = input();
    value.context.evaluatorPrincipalIds = null;
    expect(resolveCapturedRuleExceptionQuorum(value).state).toBe("unavailable");
  });
  it.each(["oppose", "escalate", "abstain"] as const)(
    "preserves an active %s action alongside positive evidence",
    (action) => {
      const value = input([row(), row("user_other", { action })]);
      const result = resolveCapturedRuleExceptionQuorum(value);
      expect(result.observations.some((entry) => entry.state === action)).toBe(true);
      expect(result.state).toBe(
        action === "oppose" ? "opposed" : action === "escalate" ? "escalated" : "matched",
      );
      if (action !== "abstain") expect(result.supportingApprovals).toEqual([]);
    },
  );
  it("does not remove conditions or declared conflicts because control bytes were retained", () => {
    for (const kind of ["conditions", "declaredConflicts"] as const) {
      const value = input([
        row(),
        row("user_conditional", {
          [kind]: ["A real operator must resolve this attributable declaration."],
        }),
      ]);
      const result = resolveCapturedRuleExceptionQuorum(value);
      expect(result.state).toBe(kind === "conditions" ? "conditions_unresolved" : "conflicted");
      expect(result.supportingApprovals).toEqual([]);
    }
  });
  it.each(["missing", "uninspected", "changed", "expired", "unverified"] as const)(
    "retains an active %s control as unavailable without a favorable subset",
    (kind) => {
      const value = input([row(), row("user_other")]);
      const source = value.controls[1];
      if (!source) throw new Error("Missing control");
      if (kind === "missing") value.controls.pop();
      if (kind === "uninspected")
        source.content = { state: "not_inspected", reason: "acquisition_unavailable" };
      if (kind === "changed") {
        if (source.underGuards.state !== "observed") throw new Error("Missing current catalog");
        source.underGuards.record.recordSha256 = "c".repeat(64);
      }
      if (kind === "expired") value.capturedAt = "2026-10-15T11:00:00.000001Z";
      if (kind === "unverified") {
        if (source.content.state !== "captured") throw new Error("Missing content");
        source.content.observation = { status: "unavailable", reason: "content_integrity_failed" };
      }
      const result = resolveCapturedRuleExceptionQuorum(value);
      expect(result.state).toBe("unavailable");
      expect(result.observations).toHaveLength(2);
      expect(result.controls).toHaveLength(2);
      expect(result.supportingApprovals).toEqual([]);
    },
  );
  it("retains explicit skipped controls on a revoked predecessor while a different current reviewer supports", () => {
    const old = row();
    const value = input([old, row("user_current")]);
    value.census.revocations.push(revocation(old));
    const source = value.controls[0];
    if (!source) throw new Error("Missing old control");
    source.content = { state: "not_inspected", reason: "approval_inactive" };
    const result = resolveCapturedRuleExceptionQuorum(value);
    expect(result.state).toBe("matched");
    expect(
      result.observations.find((entry) => entry.approval.approvalId === old.record.approvalId)
        ?.state,
    ).toBe("revoked");
    expect(
      result.controls.find((entry) => entry.approval.approvalId === old.record.approvalId)
        ?.inspection.observations[0]?.state,
    ).toBe("not_inspected");
    const current = value.census.records[1];
    if (!current) throw new Error("Missing current approval");
    expect(result.supportingApprovals).toEqual([releaseApprovalReference(current)]);
  });
  it("does not omit a revoked original control occurrence from the complete inventory", () => {
    const old = row();
    const value = input([old, row("user_current")]);
    value.census.revocations.push(revocation(old));
    value.controls.shift();
    expect(resolveCapturedRuleExceptionQuorum(value).state).toBe("unavailable");
  });
  it.each(["approval_inactive", "action_not_approval"] as const)(
    "rejects an invented %s skip reason on a current affirmative exception",
    (reason) => {
      const value = input();
      const source = value.controls[0];
      if (!source) throw new Error("Missing control");
      source.content = { state: "not_inspected", reason };
      expect(() => resolveCapturedRuleExceptionQuorum(value)).toThrow(
        InvalidCapturedRuleExceptionError,
      );
    },
  );
  it("admits all 4096 original exception actors, controls and the final required human group", () => {
    const rows = Array.from({ length: 4096 }, (_, index) =>
      row(
        `user_exception_${index.toString().padStart(4, "0")}`,
        {},
        {
          independenceGroupIds: [index === 4095 ? "group_security_review" : "group_release_review"],
        },
      ),
    );
    const value = input(rows);
    value.context.requirement.independenceGroupIds = [
      "group_release_review",
      "group_security_review",
    ];
    value.context.requirement.humanReviewerGroupIds = ["group_security_review"];
    value.context.requirement.quorum = 2;
    const result = resolveCapturedRuleExceptionQuorum(value);
    expect(result.state).toBe("matched");
    expect(result.observations).toHaveLength(4096);
    expect(result.controls).toHaveLength(4096);
    expect(result.controls.every(({ inspection }) => inspection.state === "retained")).toBe(true);
    expect(
      result.witnesses.some(
        ({ principalId, groupId }) =>
          principalId === "user_exception_4095" && groupId === "group_security_review",
      ),
    ).toBe(true);
    expect(value.budget.snapshot()).toMatchObject({ approvalRecords: 4096, records: 32768 });
  }, 30000);
  it.each(["records", "recordBytes", "approvalRecords"] as const)(
    "preserves exact %s admission and taints a cut one unit below",
    (kind) => {
      const measured = input();
      resolveCapturedRuleExceptionQuorum(measured);
      const usage = measured.budget.snapshot();
      const exact = {
        maxAcquisitionRecords: usage.records,
        maxAcquisitionRecordBytes: usage.recordBytes,
        maxApprovalRecords: usage.approvalRecords,
      };
      const value = input();
      value.budget = new ReleaseDecisionVerificationBudget(exact);
      expect(resolveCapturedRuleExceptionQuorum(value).state).toBe("matched");
      const short = { ...exact };
      if (kind === "records") short.maxAcquisitionRecords--;
      if (kind === "recordBytes") short.maxAcquisitionRecordBytes--;
      if (kind === "approvalRecords") short.maxApprovalRecords--;
      const rejected = input();
      rejected.budget = new ReleaseDecisionVerificationBudget(short);
      expect(() => resolveCapturedRuleExceptionQuorum(rejected)).toThrow(
        ReleaseDecisionVerificationBudgetError,
      );
      expect(() => rejected.budget.snapshot()).toThrow(ReleaseDecisionVerificationBudgetError);
    },
  );
  it.each(["credential", "grant", "authority"] as const)(
    "does not replace invalid current %s with a retained content report",
    (kind) => {
      const value = input();
      const actor = value.actors[0];
      if (!actor) throw new Error("Missing actor");
      if (kind === "credential") {
        if (actor.credential.state !== "observed") throw new Error("Missing credential");
        actor.credential.record.revokedAt = "2026-10-15T10:20:00.000001Z";
        actor.credential.record.revocationReason = "administrative";
      }
      if (kind === "grant") {
        if (actor.grant.state !== "observed") throw new Error("Missing grant");
        actor.grant.record.state = "inactive";
      }
      if (kind === "authority")
        actor.authorityCensus = { ...actor.authorityCensus, state: "unavailable" };
      expect(resolveCapturedRuleExceptionQuorum(value).state).toBe(
        kind === "authority" ? "unavailable" : "insufficient",
      );
    },
  );
  it.each([
    "normal_context",
    "kind",
    "subject",
    "actor_digest",
    "control_digest",
    "orphan_control",
    "duplicate_control",
    "unknown_outer",
    "fake_meter",
  ] as const)("rejects substituted %s before returning a favorable quorum", (kind) => {
    const value = input();
    const record = value.census.records[0],
      actor = value.actors[0],
      control = value.controls[0];
    if (!record || !actor || !control) throw new Error("Missing original exception fixture");
    if (kind === "normal_context") value.context.purpose = "normal_approval";
    if (kind === "kind") record.kind = "normal_approval";
    if (kind === "subject") value.subject.ruleId = "rule_other";
    if (kind === "actor_digest") actor.approval.definitionSha256 = "c".repeat(64);
    if (kind === "control_digest") control.approval.definitionSha256 = "c".repeat(64);
    if (kind === "orphan_control") control.approval.approvalId = "approval_unknown";
    if (kind === "duplicate_control") value.controls.push(structuredClone(control));
    if (kind === "unknown_outer") Reflect.set(value, "matched", true);
    if (kind === "fake_meter") Reflect.set(value, "budget", { observe: () => undefined });
    expect(() => resolveCapturedRuleExceptionQuorum(value)).toThrow(
      InvalidCapturedRuleExceptionError,
    );
  });
  it("retains a cross-approval physical catalog conflict even when each isolated content report is consistent", () => {
    const a = row(),
      b = row("user_other");
    const reference = a.record.compensatingControls[0];
    if (!reference) throw new Error("Missing exact control");
    const { schemaVersion: _version, definitionSha256: _digest, ...body } = b.record;
    const definition = ReleaseApprovalDefinitionSchema.parse({
      ...body,
      compensatingControls: [reference],
    });
    b.record = ReleaseApprovalSchema.parse({
      ...definition,
      schemaVersion: "0.1",
      definitionSha256: digestReleaseApprovalDefinition(definition.subject.scope, definition),
    });
    b.source.approval = releaseApprovalReference(b.record);
    b.control.approval = releaseApprovalReference(b.record);
    b.control.reference = structuredClone(reference);
    if (
      b.control.content.state !== "captured" ||
      b.control.content.catalog === null ||
      b.control.underGuards.state !== "observed"
    )
      throw new Error("Missing captured catalog");
    b.control.content.catalog.metadata.contentReference = structuredClone(reference);
    b.control.underGuards.record.metadata.contentReference = structuredClone(reference);
    b.control.content.catalog.recordSha256 = "c".repeat(64);
    b.control.underGuards.record.recordSha256 = "c".repeat(64);
    const result = resolveCapturedRuleExceptionQuorum(input([a, b]));
    expect(result.state).toBe("unavailable");
    expect(result.controls.every(({ inspection }) => inspection.state === "retained")).toBe(true);
    expect(result.supportingApprovals).toEqual([]);
  });
  it("keeps exact supersession history and skipped predecessor controls without selecting a favorable latest lookup", () => {
    const old = row("user_exception_reviewer", { action: "oppose" });
    const next = row("user_exception_reviewer", {
      approvalId: "approval_successor",
      supersedes: releaseApprovalReference(old.record),
    });
    old.control.content = { state: "not_inspected", reason: "approval_inactive" };
    const result = resolveCapturedRuleExceptionQuorum(input([next, old]));
    expect(result.state).toBe("matched");
    expect(result.supportingApprovals).toEqual([releaseApprovalReference(next.record)]);
    expect(
      result.observations.find(({ approval }) => approval.approvalId === old.record.approvalId)
        ?.state,
    ).toBe("superseded");
    expect(result.controls).toHaveLength(2);
  });
  it("admits a large raw control before deep schema validation and preserves admission failure", () => {
    const value = input();
    const control = value.controls[0];
    if (!control) throw new Error("Missing control");
    Reflect.set(control, "unsupported", "x".repeat(1_000_000));
    value.budget = new ReleaseDecisionVerificationBudget({
      maxAcquisitionRecords: 100_000,
      maxAcquisitionRecordBytes: 8192,
      maxApprovalRecords: 4096,
    });
    expect(() => resolveCapturedRuleExceptionQuorum(value)).toThrow(
      ReleaseDecisionVerificationBudgetError,
    );
    expect(() => value.budget.snapshot()).toThrow(ReleaseDecisionVerificationBudgetError);
  });
  it("preserves a competing successor fork instead of choosing one current exception", () => {
    const old = row();
    const left = row("user_exception_reviewer", {
      approvalId: "approval_branch_a",
      supersedes: releaseApprovalReference(old.record),
    });
    const right = row("user_exception_reviewer", {
      approvalId: "approval_branch_b",
      supersedes: releaseApprovalReference(old.record),
    });
    old.control.content = { state: "not_inspected", reason: "approval_inactive" };
    const result = resolveCapturedRuleExceptionQuorum(input([right, old, left]));
    expect(result.state).toBe("conflicted");
    expect(result.observations).toHaveLength(3);
    expect(result.controls).toHaveLength(3);
    expect(result.supportingApprovals).toEqual([]);
  });
  it("does not revoke an already recorded exception merely because its original login naturally expires", () => {
    const value = input();
    value.capturedAt = "2026-10-15T11:30:00.000001Z";
    const source = value.controls[0];
    if (
      source?.content.state !== "captured" ||
      source.content.catalog === null ||
      source.underGuards.state !== "observed"
    )
      throw new Error("Missing exact catalog");
    source.content.catalog.metadata.retention = {
      mode: "expire",
      expiresAt: "2026-10-15T12:00:00.000001Z",
    };
    source.underGuards.record.metadata.retention = {
      mode: "expire",
      expiresAt: "2026-10-15T12:00:00.000001Z",
    };
    const result = resolveCapturedRuleExceptionQuorum(value);
    expect(result.state).toBe("matched");
    expect(result.expiresAt).toBe("2026-10-15T12:00:00.000001Z");
  });
  it("retains expiry and explicit skipped evidence without inventing a new action", () => {
    const expired = row();
    const value = input([expired]);
    value.capturedAt = "2026-10-15T12:00:00.000001Z";
    const source = value.controls[0];
    if (!source) throw new Error("Missing control");
    source.content = { state: "not_inspected", reason: "approval_inactive" };
    const result = resolveCapturedRuleExceptionQuorum(value);
    expect(result.state).toBe("insufficient");
    expect(result.observations[0]?.state).toBe("expired");
    expect(result.controls[0]?.inspection.observations[0]?.state).toBe("not_inspected");
    expect(result.supportingApprovals).toEqual([]);
  });
});
