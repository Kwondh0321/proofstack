import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  MAX_RELEASE_APPROVAL_DEFINITION_BYTES,
  MAX_RELEASE_APPROVAL_INTENT_BYTES,
  MAX_RELEASE_APPROVAL_RESPONSE_BYTES,
  ReleaseApprovalDefinitionSchema,
  ReleaseApprovalIntentSchema,
  ReleaseApprovalReferenceSchema,
  ReleaseApprovalRevocationSchema,
  ReleaseApprovalSchema,
  ReleaseApprovalSubjectSchema,
} from "./release-approval.js";

const vectors = JSON.parse(
  readFileSync(new URL("../vectors/release-approval-definition-v1.json", import.meta.url), "utf8"),
) as { vectors: { input: { definition: unknown } }[] };
function definition(index = 1) {
  return ReleaseApprovalDefinitionSchema.parse(
    structuredClone(vectors.vectors[index]?.input.definition),
  );
}
function intent(index = 1) {
  const {
    reviewer: _reviewer,
    authority: _authority,
    recordedAt: _at,
    ...value
  } = definition(index);
  return ReleaseApprovalIntentSchema.parse(value);
}
function atBytes(bytes: number) {
  const value = intent();
  value.rationale = "😀".repeat(1024);
  value.conditions = Array.from({ length: 32 }, (_, i) => `cond_${i.toString().padStart(3, "0")}_`);
  let left = bytes - Buffer.byteLength(JSON.stringify(value));
  for (let i = 0; i < value.conditions.length; i += 1) {
    const prefix = value.conditions[i] ?? "";
    const addition = Math.min(left, (512 - prefix.length - 3) * 4);
    if (addition < 0) throw new Error("Invalid approval byte fixture base");
    value.conditions[i] = prefix + "😀".repeat(Math.floor(addition / 4)) + "x".repeat(addition % 4);
    left -= addition;
  }
  if (left !== 0) throw new Error("Insufficient approval byte fixture headroom");
  expect(Buffer.byteLength(JSON.stringify(value))).toBe(bytes);
  return value;
}

describe("public approval intent and original authenticated record", () => {
  it("admits separate normal approval and exact-rule exception declarations", () => {
    expect(intent().kind).toBe("normal_approval");
    expect(intent(2).kind).toBe("rule_exception");
    const v = definition();
    expect(
      ReleaseApprovalSchema.safeParse({
        ...v,
        definitionSha256: "a".repeat(64),
        schemaVersion: "0.1",
      }).success,
    ).toBe(true);
    expect(
      ReleaseApprovalReferenceSchema.safeParse({
        approvalId: v.approvalId,
        definitionSha256: "a".repeat(64),
      }).success,
    ).toBe(true);
  });
  it.each([
    "reviewer",
    "authority",
    "recordedAt",
    "definitionSha256",
    "current",
    "sessionDigest",
    "workerId",
    "verdict",
  ])("rejects public actor/authority/receipt smuggling: %s", (key) => {
    expect(ReleaseApprovalIntentSchema.safeParse({ ...intent(), [key]: "untrusted" }).success).toBe(
      false,
    );
  });
  it.each([
    "scope",
    "selection",
    "candidate",
    "policy",
    "request",
    "snapshot",
    "evaluation",
    "jobId",
    "ruleId",
  ])("requires original exact subject component: %s", (key) => {
    const value: Record<string, unknown> = { ...intent().subject };
    delete value[key];
    expect(ReleaseApprovalSubjectSchema.safeParse(value).success).toBe(false);
  });
  it("rejects latest operands, executable targets and nested caller claims", () => {
    const v = intent();
    expect(
      ReleaseApprovalIntentSchema.safeParse({ ...v, subject: { ...v.subject, latest: true } })
        .success,
    ).toBe(false);
    expect(
      ReleaseApprovalIntentSchema.safeParse({
        ...v,
        subject: { ...v.subject, ruleId: "https://callback.example/approve" },
      }).success,
    ).toBe(false);
    expect(
      ReleaseApprovalIntentSchema.safeParse({
        ...v,
        subject: { ...v.subject, evaluation: { ...v.subject.evaluation, outcome: "satisfied" } },
      }).success,
    ).toBe(false);
  });
  it.each(["api_key", "development", "service_token"])(
    "rejects a %s receipt as OIDC user approval",
    (authenticationMethod) => {
      const v = definition();
      expect(
        ReleaseApprovalDefinitionSchema.safeParse({
          ...v,
          reviewer: { ...v.reviewer, authenticationMethod },
        }).success,
      ).toBe(false);
    },
  );
  it.each(["service", "workload"])("rejects a %s acting as a human", (principalType) => {
    const v = definition();
    expect(
      ReleaseApprovalDefinitionSchema.safeParse({
        ...v,
        reviewer: { ...v.reviewer, principalType },
      }).success,
    ).toBe(false);
  });
  it("rejects substituted reviewer/installation/target authority and missing credentials", () => {
    const v = definition();
    for (const change of [
      { reviewerPrincipalId: "user_other" },
      { installationId: "installation_other" },
      { gateTargetId: "gate_other" },
    ])
      expect(
        ReleaseApprovalDefinitionSchema.safeParse({
          ...v,
          authority: { ...v.authority, ...change },
        }).success,
      ).toBe(false);
    expect(
      ReleaseApprovalDefinitionSchema.safeParse({
        ...v,
        reviewer: { ...v.reviewer, credentialId: undefined },
      }).success,
    ).toBe(false);
  });
  it("retains opposing, abstaining, conditional and conflicted claims without a decision", () => {
    for (const action of ["approve", "oppose", "escalate", "abstain"])
      expect(
        ReleaseApprovalIntentSchema.safeParse({
          ...intent(),
          action,
          conditions: ["Independent follow-up remains required."],
          declaredConflicts: ["A disclosed relationship requires review."],
        }).success,
      ).toBe(true);
    // Shape admission does not count these as eligible approval or resolve their conditions.
    expect(ReleaseApprovalIntentSchema.safeParse({ ...intent(), action: "proceed" }).success).toBe(
      false,
    );
  });
  it("requires retained controls for an affirmative exception, never inventing a waiver", () => {
    const v = intent(2);
    expect(ReleaseApprovalIntentSchema.safeParse({ ...v, compensatingControls: [] }).success).toBe(
      false,
    );
    expect(
      ReleaseApprovalIntentSchema.safeParse({ ...v, action: "oppose", compensatingControls: [] })
        .success,
    ).toBe(true);
    expect(ReleaseApprovalIntentSchema.safeParse({ ...v, kind: "normal_approval" }).success).toBe(
      false,
    );
    const control = v.compensatingControls[0];
    if (!control) throw new Error("Missing control fixture");
    expect(
      ReleaseApprovalIntentSchema.safeParse({ ...v, compensatingControls: [control, control] })
        .success,
    ).toBe(false);
  });
  it("rejects repeated or unordered conditions/conflicts and bounded inventory excess", () => {
    const v = intent();
    for (const key of ["conditions", "declaredConflicts"])
      for (const items of [
        ["Repeated", "Repeated"],
        ["Second", "First"],
        Array.from({ length: 33 }, (_, i) => `item_${i.toString().padStart(3, "0")}`),
      ])
        expect(ReleaseApprovalIntentSchema.safeParse({ ...v, [key]: items }).success).toBe(false);
  });
  it("preserves supersession references but rejects self supersession", () => {
    const v = intent();
    expect(
      ReleaseApprovalIntentSchema.safeParse({
        ...v,
        supersedes: { approvalId: "approval_old", definitionSha256: "a".repeat(64) },
      }).success,
    ).toBe(true);
    expect(
      ReleaseApprovalIntentSchema.safeParse({
        ...v,
        supersedes: { approvalId: v.approvalId, definitionSha256: "a".repeat(64) },
      }).success,
    ).toBe(false);
    expect(ReleaseApprovalIntentSchema.safeParse({ ...v, supersedes: undefined }).success).toBe(
      true,
    );
  });
  it("checks exact native expiry and original authentication chronology", () => {
    const v = definition();
    expect(
      ReleaseApprovalDefinitionSchema.safeParse({ ...v, expiresAt: "2026-10-15T10:00:05.0000011Z" })
        .success,
    ).toBe(true);
    for (const change of [
      { expiresAt: v.recordedAt },
      { expiresAt: "2026-10-15T10:00:05.0000009Z" },
      { expiresAt: "invalid" },
      { recordedAt: "invalid" },
      { recordedAt: "2026-10-15T09:59:59.999999Z" },
    ])
      expect(ReleaseApprovalDefinitionSchema.safeParse({ ...v, ...change }).success).toBe(false);
  });
  it("rejects secret proof and arbitrary metadata in immutable public records", () => {
    const v = definition();
    expect(
      ReleaseApprovalDefinitionSchema.safeParse({
        ...v,
        reviewer: { ...v.reviewer, sessionDigest: "private-proof" },
      }).success,
    ).toBe(false);
    expect(
      ReleaseApprovalSchema.safeParse({
        ...v,
        definitionSha256: "a".repeat(64),
        schemaVersion: "99",
      }).success,
    ).toBe(false);
  });
  it("independently admits just-below/exact intent bytes and preserves server/response headroom", () => {
    for (const bytes of [
      MAX_RELEASE_APPROVAL_INTENT_BYTES - 1,
      MAX_RELEASE_APPROVAL_INTENT_BYTES,
    ]) {
      const value = atBytes(bytes);
      expect(ReleaseApprovalIntentSchema.safeParse(value).success).toBe(true);
      const original = definition();
      const derived = ReleaseApprovalDefinitionSchema.parse({
        ...original,
        ...value,
        reviewer: {
          ...original.reviewer,
          credentialId: "session_".padEnd(64, "x"),
          requestId: "\u0000".repeat(128),
        },
      });
      expect(Buffer.byteLength(JSON.stringify(derived))).toBeLessThanOrEqual(
        MAX_RELEASE_APPROVAL_DEFINITION_BYTES,
      );
      const published = ReleaseApprovalSchema.parse({
        ...derived,
        schemaVersion: "0.1",
        definitionSha256: "a".repeat(64),
      });
      expect(
        Buffer.byteLength(
          JSON.stringify({ approval: published, created: true, requestId: "\u0000".repeat(128) }),
        ),
      ).toBeLessThanOrEqual(MAX_RELEASE_APPROVAL_RESPONSE_BYTES);
    }
    const over = atBytes(MAX_RELEASE_APPROVAL_INTENT_BYTES + 1);
    expect(ReleaseApprovalIntentSchema.safeParse(over).success).toBe(false);
    expect(ReleaseApprovalDefinitionSchema.safeParse({ ...definition(), ...over }).success).toBe(
      false,
    );
  });
});

describe("approval revocation record shape", () => {
  function event() {
    const v = definition();
    return {
      eventId: "approval_revocation",
      approval: { approvalId: v.approvalId, definitionSha256: "a".repeat(64) },
      scope: v.subject.scope,
      reviewer: v.reviewer,
      occurredAt: "2026-10-15T10:01:00.000001Z",
      reason: "Withdraw this exact synthetic reference action.",
      schemaVersion: "0.1",
    };
  }
  it("retains original reference and actual user receipt without overwriting an action", () => {
    expect(ReleaseApprovalRevocationSchema.safeParse(event()).success).toBe(true);
  });
  it("rejects future authentication, invalid time and authority bypass fields", () => {
    for (const changed of [
      { occurredAt: "2026-10-15T09:59:59.999999Z" },
      { occurredAt: "invalid" },
      { current: true },
      { revokeEveryone: true },
    ])
      expect(ReleaseApprovalRevocationSchema.safeParse({ ...event(), ...changed }).success).toBe(
        false,
      );
  });
});
