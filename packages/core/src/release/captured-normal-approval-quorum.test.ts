import { readFileSync } from "node:fs";
import {
  ReleaseApprovalDefinitionSchema,
  ReleaseApprovalSchema,
  ReleaseApprovalRevocationSchema,
  type ReleaseApprovalDefinition,
  type ReleaseApprovalRevocation,
  type ReleaseReviewerAuthorityDefinition,
} from "@proofstack/contracts";
import { describe, expect, it } from "vitest";
import { capturedReleaseReviewerFixture } from "../testing/release-reviewer-fixtures.js";
import {
  digestReleaseApprovalDefinition,
  releaseApprovalReference,
  releaseReviewerAuthorityReference,
} from "./release-authority-record-validation.js";
import {
  resolveCapturedNormalApprovalQuorum,
  InvalidCapturedNormalApprovalError,
} from "./captured-normal-approval-quorum.js";
import {
  ReleaseDecisionVerificationBudget,
  ReleaseDecisionVerificationBudgetError,
} from "./release-decision-verification-budget.js";

const original = ReleaseApprovalDefinitionSchema.parse(
  JSON.parse(
    readFileSync(
      new URL("../../../contracts/vectors/release-approval-definition-v1.json", import.meta.url),
      "utf8",
    ),
  ).vectors[1].input.definition,
);
function row(
  principalId = "user_release_reviewer",
  patch: Partial<ReleaseApprovalDefinition> = {},
  authorityPatch: Partial<ReleaseReviewerAuthorityDefinition> = {},
) {
  const value = capturedReleaseReviewerFixture({
    reviewerPrincipalId: principalId,
    authorityId: `authority_${principalId}`,
    authorityVersionId: `version_${principalId}`,
    ...authorityPatch,
  });
  const definition = ReleaseApprovalDefinitionSchema.parse({
    ...original,
    approvalId: `approval_${principalId}`,
    reviewer: value.receipt,
    authority: value.reference,
    ...patch,
  });
  const record = ReleaseApprovalSchema.parse({
    ...definition,
    schemaVersion: "0.1",
    definitionSha256: digestReleaseApprovalDefinition(definition.subject.scope, definition),
  });
  return {
    record,
    source: {
      approval: releaseApprovalReference(record),
      identity: value.identity,
      grant: value.grant,
      credential: value.credential,
      authorityCensus: value.census,
    },
  };
}
function input(rows = [row()]) {
  const value = capturedReleaseReviewerFixture();
  return {
    subject: structuredClone(original.subject),
    context: value.context,
    capturedAt: value.capturedAt,
    census: {
      state: "complete" as "complete" | "unavailable" | "invalid",
      records: rows.map(({ record }) => record),
      revocations: [] as ReleaseApprovalRevocation[],
    },
    actors: rows.map(({ source }) => source),
    budget: new ReleaseDecisionVerificationBudget({
      maxAcquisitionRecords: 100_000,
      maxAcquisitionRecordBytes: 64 * 1024 * 1024,
      maxApprovalRecords: 4_096,
    }),
  };
}
function revocation(value: ReturnType<typeof row>, patch: Partial<ReleaseApprovalRevocation> = {}) {
  return ReleaseApprovalRevocationSchema.parse({
    schemaVersion: "0.1",
    eventId: "event_revoke",
    scope: value.record.subject.scope,
    approval: releaseApprovalReference(value.record),
    reviewer: { ...value.record.reviewer, requestId: "request_revoke" },
    occurredAt: "2026-10-15T10:20:00.000001Z",
    reason: "The original reviewer revoked this exact synthetic action.",
    ...patch,
  });
}
describe("complete exact normal-approval census, never a public authority report", () => {
  it("normalizes repeated complete authority-history ordering without losing its immutable predecessors", () => {
    const principal = "user_release_reviewer";
    const initial = row(principal);
    const previous = initial.source.authorityCensus.records[0];
    if (!previous) throw new Error("Missing original authority");
    const current = capturedReleaseReviewerFixture({
      authorityId: previous.authorityId,
      authorityVersionId: "authority_version_current",
      predecessor: releaseReviewerAuthorityReference(previous),
    }).authority;
    const authority = releaseReviewerAuthorityReference(current);
    const old = row(principal, { action: "oppose", authority });
    const next = row(principal, {
      approvalId: "approval_replacement",
      authority,
      supersedes: releaseApprovalReference(old.record),
    });
    const event = {
      schemaVersion: "0.1" as const,
      eventId: "authority_event_superseded",
      authority: releaseReviewerAuthorityReference(previous),
      scope: previous.scope,
      actorPrincipalId: "user_reviewer_administrator",
      occurredAt: "2026-10-15T09:00:00.000001Z",
      reason: "Retain the original reviewer authority and exact current successor.",
      kind: "superseded" as const,
      successor: authority,
    };
    old.source.authorityCensus = {
      state: "complete",
      records: [previous, current],
      lifecycle: [event],
    };
    next.source.authorityCensus = {
      state: "complete",
      records: [current, previous],
      lifecycle: [event],
    };
    const result = resolveCapturedNormalApprovalQuorum(input([old, next]));
    expect(result.state).toBe("matched");
    expect(result.supportingApprovals).toEqual([releaseApprovalReference(next.record)]);
  });
  it.each(["grant", "credential", "authority_receipt"] as const)(
    "rejects inconsistent repeated %s preimages instead of keeping a favorable latest observation",
    (kind) => {
      const old = row("user_release_reviewer", { action: "oppose" });
      const next = row("user_release_reviewer", {
        approvalId: "approval_replacement",
        supersedes: releaseApprovalReference(old.record),
      });
      if (kind === "grant") {
        if (next.source.grant.state !== "observed") throw new Error("Missing grant fixture");
        next.source.grant.record.revision += 1;
      }
      if (kind === "credential") {
        if (old.source.credential.state !== "observed")
          throw new Error("Missing credential fixture");
        old.source.credential.record.revokedAt = "2026-10-15T10:20:00.000001Z";
        old.source.credential.record.revocationReason = "administrative";
      }
      if (kind === "authority_receipt") {
        const authority = next.source.authorityCensus.records[0];
        if (!authority) throw new Error("Missing authority fixture");
        authority.publishedAt = "2026-10-15T00:01:00.000001Z";
      }
      expect(resolveCapturedNormalApprovalQuorum(input([old, next])).state).toBe("unavailable");
    },
  );
  it("cannot bind one physical credential ID to two different owners in the same cut", () => {
    const first = row("user_one");
    const second = row("user_two", {
      reviewer: {
        ...row("user_two").record.reviewer,
        credentialId: first.record.reviewer.credentialId,
      },
    });
    if (second.source.credential.state !== "observed")
      throw new Error("Missing credential fixture");
    second.source.credential.reference.credentialId = first.record.reviewer.credentialId;
    second.source.credential.record.credentialId = first.record.reviewer.credentialId;
    expect(resolveCapturedNormalApprovalQuorum(input([first, second])).state).toBe("unavailable");
  });
  it("resolves all 4096 admitted actors and retains the final required human group without truncation", () => {
    const rows = Array.from({ length: 4096 }, (_, index) =>
      row(
        `user_${index.toString().padStart(4, "0")}`,
        {},
        {
          independenceGroupIds: [index === 4095 ? "group_security_review" : "group_release_review"],
        },
      ),
    );
    const value = input(rows);
    value.context = {
      ...value.context,
      requirement: {
        ...value.context.requirement,
        quorum: 2,
        independenceGroupIds: ["group_release_review", "group_security_review"],
        humanReviewerGroupIds: ["group_security_review"],
      },
    };
    const result = resolveCapturedNormalApprovalQuorum(value);
    expect(result.state).toBe("matched");
    expect(result.observations).toHaveLength(4096);
    expect(
      result.witnesses.some(
        ({ principalId, groupId, independentHuman }) =>
          principalId === "user_4095" && groupId === "group_security_review" && independentHuman,
      ),
    ).toBe(true);
    expect(value.budget.snapshot()).toMatchObject({ records: 20480, approvalRecords: 4096 });
  }, 30000);
  it.each(["records", "revocations", "actors"] as const)(
    "rejects one row beyond the complete %s admission before attempting a partial graph",
    (kind) => {
      const entry = row();
      const value = input([entry]);
      if (kind === "records")
        value.census.records = Array.from({ length: 4097 }, () => entry.record);
      if (kind === "actors") value.actors = Array.from({ length: 4097 }, () => entry.source);
      if (kind === "revocations")
        value.census.revocations = Array.from({ length: 4097 }, () => revocation(entry));
      expect(() => resolveCapturedNormalApprovalQuorum(value)).toThrow(
        InvalidCapturedNormalApprovalError,
      );
    },
  );
  it("retains a synthetic exact witness, original receipts and earliest supporting validity without mutating input", () => {
    const value = input();
    const before = structuredClone({ census: value.census, actors: value.actors });
    const result = resolveCapturedNormalApprovalQuorum(value);
    expect(result.state).toBe("matched");
    const record = value.census.records[0];
    if (!record) throw new Error("Missing original approval fixture");
    expect(result.supportingApprovals).toEqual([releaseApprovalReference(record)]);
    expect(result.witnesses).toEqual([
      {
        approval: result.supportingApprovals[0],
        principalId: "user_release_reviewer",
        groupId: "group_release_review",
        independentHuman: true,
        assurance: "synthetic_reference",
      },
    ]);
    expect(result.expiresAt).toBe(original.expiresAt);
    expect(result.observations).toEqual([
      { approval: result.supportingApprovals[0], state: "approve" },
    ]);
    expect({ census: value.census, actors: value.actors }).toEqual(before);
    expect(value.budget.snapshot()).toMatchObject({ records: 5, approvalRecords: 1 });
  });
  it("requires distinct actual principals and groups rather than adding multiple memberships", () => {
    const one = input();
    one.context = {
      ...one.context,
      requirement: {
        ...one.context.requirement,
        quorum: 2,
        independenceGroupIds: ["group_release_review", "group_security_review"],
        humanReviewerGroupIds: ["group_security_review"],
      },
    };
    expect(resolveCapturedNormalApprovalQuorum(one).state).toBe("insufficient");
    const two = input([row("user_one"), row("user_two")]);
    two.context = one.context;
    const result = resolveCapturedNormalApprovalQuorum(two);
    expect(result.state).toBe("matched");
    expect(new Set(result.witnesses.map(({ principalId }) => principalId)).size).toBe(2);
    expect(new Set(result.witnesses.map(({ groupId }) => groupId)).size).toBe(2);
    const reversed = input([row("user_two"), row("user_one")]);
    reversed.context = one.context;
    expect(resolveCapturedNormalApprovalQuorum(reversed)).toEqual(result);
  });
  it.each(["oppose", "escalate", "abstain"] as const)(
    "retains an eligible %s even alongside enough positive reviews",
    (action) => {
      const value = input([row("user_positive"), row("user_other", { action })]);
      const result = resolveCapturedNormalApprovalQuorum(value);
      expect(result.state).toBe(
        action === "oppose" ? "opposed" : action === "escalate" ? "escalated" : "matched",
      );
      expect(result.observations.some((observation) => observation.state === action)).toBe(true);
      if (action !== "abstain") expect(result.supportingApprovals).toEqual([]);
    },
  );
  it("does not claim arbitrary conditional approval text has been verified", () => {
    const result = resolveCapturedNormalApprovalQuorum(
      input([
        row("user_positive"),
        row("user_conditional", {
          conditions: ["A real operator must independently verify this external condition."],
        }),
      ]),
    );
    expect(result.state).toBe("conditions_unresolved");
    expect(result.supportingApprovals).toEqual([]);
    expect(result.observations.some(({ state }) => state === "conditions_unresolved")).toBe(true);
  });
  it("retains an active declared conflict rather than favorably discarding it", () => {
    const result = resolveCapturedNormalApprovalQuorum(
      input([
        row("user_positive"),
        row("user_conflict", {
          declaredConflicts: ["An original attributable conflict remains unresolved."],
        }),
      ]),
    );
    expect(result.state).toBe("conflicted");
    expect(result.observations.some(({ state }) => state === "conflicted")).toBe(true);
  });
  it("does not select a favorable latest action from one person's multiple active records", () => {
    const first = row();
    const next = row("user_release_reviewer", {
      approvalId: "approval_other",
      action: "oppose",
      recordedAt: "2026-10-15T10:10:00.000001Z",
    });
    const result = resolveCapturedNormalApprovalQuorum(input([first, next]));
    expect(result.state).toBe("conflicted");
    expect(result.observations).toHaveLength(2);
  });
  it("binds explicit supersession to the same exact subject and original reviewer, retaining the old opposition", () => {
    const old = row("user_release_reviewer", { action: "oppose" });
    const next = row("user_release_reviewer", {
      approvalId: "approval_replacement",
      supersedes: releaseApprovalReference(old.record),
      recordedAt: "2026-10-15T10:10:00.000001Z",
    });
    const result = resolveCapturedNormalApprovalQuorum(input([old, next]));
    expect(result.state).toBe("matched");
    expect(result.supportingApprovals).toEqual([releaseApprovalReference(next.record)]);
    expect(result.observations).toContainEqual({
      approval: releaseApprovalReference(old.record),
      state: "superseded",
    });
  });
  it("retains revoked opposition and refuses a revoked positive witness", () => {
    const old = row("user_opposition", { action: "oppose" });
    const positive = row("user_positive");
    const value = input([old, positive]);
    value.census.revocations.push(revocation(old));
    expect(resolveCapturedNormalApprovalQuorum(value).state).toBe("matched");
    const alone = input([positive]);
    alone.census.revocations.push(revocation(positive));
    const result = resolveCapturedNormalApprovalQuorum(alone);
    expect(result.state).toBe("insufficient");
    expect(result.observations).toContainEqual({
      approval: releaseApprovalReference(positive.record),
      state: "revoked",
    });
  });
  it.each(["unavailable", "invalid"] as const)(
    "keeps a %s census unresolved despite a positive witness",
    (state) => {
      const value = input();
      value.census.state = state;
      expect(resolveCapturedNormalApprovalQuorum(value).state).toBe("unavailable");
    },
  );
  it("cannot omit the original actor binding even for an expired or revoked record", () => {
    const value = input();
    value.actors = [];
    value.capturedAt = original.expiresAt;
    expect(resolveCapturedNormalApprovalQuorum(value).state).toBe("unavailable");
  });
  it("does not count an explicitly revoked current identity or borrow another login", () => {
    const entry = row();
    if (entry.source.credential.state !== "observed") throw new Error("Missing source credential");
    entry.source.credential.record.revokedAt = "2026-10-15T10:20:00.000001Z";
    entry.source.credential.record.revocationReason = "administrative";
    expect(resolveCapturedNormalApprovalQuorum(input([entry])).state).toBe("insufficient");
    const other = row();
    other.source.identity.principalId = "user_substituted";
    expect(() => resolveCapturedNormalApprovalQuorum(input([other]))).toThrow(
      InvalidCapturedNormalApprovalError,
    );
  });
  it("keeps missing predecessor/revocation targets unresolved rather than treating the census as complete", () => {
    const next = row("user_release_reviewer", {
      supersedes: { approvalId: "approval_missing", definitionSha256: "0".repeat(64) },
    });
    expect(resolveCapturedNormalApprovalQuorum(input([next])).state).toBe("unavailable");
    const value = input();
    value.census.revocations.push(
      revocation(row(), {
        approval: { approvalId: "approval_missing", definitionSha256: "0".repeat(64) },
      }),
    );
    expect(resolveCapturedNormalApprovalQuorum(value).state).toBe("unavailable");
  });
  it.each(["record", "actor", "revocation", "terminal", "fork"] as const)(
    "retains duplicate/conflicting %s observations",
    (kind) => {
      const first = row();
      const value = input([first]);
      if (kind === "record") value.census.records.push(first.record);
      if (kind === "actor") value.actors.push(first.source);
      if (kind === "revocation")
        value.census.revocations.push(revocation(first), revocation(first));
      if (kind === "terminal")
        value.census.revocations.push(
          revocation(first),
          revocation(first, { eventId: "event_other" }),
        );
      if (kind === "fork") {
        const a = row("user_release_reviewer", {
          approvalId: "approval_branch_a",
          supersedes: releaseApprovalReference(first.record),
        });
        const b = row("user_release_reviewer", {
          approvalId: "approval_branch_b",
          supersedes: releaseApprovalReference(first.record),
        });
        value.census.records.push(a.record, b.record);
        value.actors.push(a.source, b.source);
      }
      expect(resolveCapturedNormalApprovalQuorum(value).state).toBe("conflicted");
    },
  );
  it.each([
    "subject",
    "kind",
    "future_record",
    "revoker",
    "future_revocation",
    "early_revocation",
    "actor_digest",
    "supersession_owner",
    "supersession_digest",
    "unknown_census",
    "unknown_actor",
    "unknown_context",
  ] as const)("rejects substituted %s without a favorable partial quorum", (kind) => {
    let entry = row();
    if (kind === "subject")
      entry = row("user_release_reviewer", {
        subject: { ...original.subject, ruleId: "rule_other" },
      });
    if (kind === "kind")
      entry = row("user_release_reviewer", { kind: "rule_exception", action: "abstain" });
    if (kind === "future_record")
      entry = row("user_release_reviewer", { recordedAt: "2026-10-15T10:30:00.000002Z" });
    const value = input([entry]);
    if (kind === "revoker")
      value.census.revocations.push(
        revocation(entry, { reviewer: { ...entry.record.reviewer, principalId: "user_other" } }),
      );
    if (kind === "future_revocation")
      value.census.revocations.push(
        revocation(entry, { occurredAt: "2026-10-15T10:30:00.000002Z" }),
      );
    if (kind === "early_revocation")
      value.census.revocations.push(
        revocation(entry, { occurredAt: "2026-10-15T10:00:05.000000Z" }),
      );
    if (kind === "actor_digest") entry.source.approval.definitionSha256 = "0".repeat(64);
    if (kind === "unknown_census") Reflect.set(value.census, "completeProof", true);
    if (kind === "unknown_actor") Reflect.set(entry.source, "authenticated", true);
    if (kind === "unknown_context") Reflect.set(value.context, "publisher", "user_fake");
    if (kind === "supersession_owner" || kind === "supersession_digest") {
      const next = row(kind === "supersession_owner" ? "user_other" : "user_release_reviewer", {
        approvalId: "approval_new",
        supersedes: {
          ...releaseApprovalReference(entry.record),
          ...(kind === "supersession_digest" ? { definitionSha256: "0".repeat(64) } : {}),
        },
      });
      value.census.records.push(next.record);
      value.actors.push(next.source);
    }
    expect(() => resolveCapturedNormalApprovalQuorum(value)).toThrow(
      InvalidCapturedNormalApprovalError,
    );
  });
  it("binds exact aggregate row, byte and actual approval admission without refunding failed cuts", () => {
    const first = input();
    resolveCapturedNormalApprovalQuorum(first);
    const usage = first.budget.snapshot();
    const exact = input();
    exact.budget = new ReleaseDecisionVerificationBudget({
      maxAcquisitionRecords: usage.records,
      maxAcquisitionRecordBytes: usage.recordBytes,
      maxApprovalRecords: usage.approvalRecords,
    });
    expect(resolveCapturedNormalApprovalQuorum(exact).state).toBe("matched");
    for (const kind of ["row", "byte", "approval"]) {
      const value = input();
      value.budget = new ReleaseDecisionVerificationBudget({
        maxAcquisitionRecords: usage.records - (kind === "row" ? 1 : 0),
        maxAcquisitionRecordBytes: usage.recordBytes - (kind === "byte" ? 1 : 0),
        maxApprovalRecords: usage.approvalRecords - (kind === "approval" ? 1 : 0),
      });
      expect(() => resolveCapturedNormalApprovalQuorum(value)).toThrow(
        ReleaseDecisionVerificationBudgetError,
      );
      expect(() => value.budget.snapshot()).toThrow(ReleaseDecisionVerificationBudgetError);
    }
  });
  it("treats exact approval expiry as expired and cannot turn a natural login expiry into new authentication", () => {
    const value = input();
    value.capturedAt = original.expiresAt;
    const result = resolveCapturedNormalApprovalQuorum(value);
    expect(result.state).toBe("insufficient");
    expect(result.observations[0]?.state).toBe("expired");
  });
});
