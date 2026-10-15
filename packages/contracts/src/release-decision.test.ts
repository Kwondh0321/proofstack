import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CreateReleaseDecisionRequestSchema,
  MAX_RELEASE_DECISION_DEFINITION_BYTES,
  MAX_RELEASE_DECISION_RESPONSE_BYTES,
  ReleaseDecisionDefinitionSchema,
  ReleaseDecisionPolicyFindingSchema,
  ReleaseDecisionReferenceSchema,
  ReleaseDecisionRuleFindingSchema,
  ReleaseDecisionSchema,
  type ReleaseDecisionDefinition,
} from "./release-decision.js";

const document = JSON.parse(
  readFileSync(new URL("../vectors/release-decision-definition-v1.json", import.meta.url), "utf8"),
) as { vectors: { input: { definition: unknown } }[] };
function definition(index = 0) {
  return ReleaseDecisionDefinitionSchema.parse(
    structuredClone(document.vectors[index]?.input.definition),
  );
}
function first(value: ReleaseDecisionDefinition) {
  const policy = value.policies[0];
  if (policy?.state !== "evaluated" || !policy.rules[0])
    throw new Error("Missing evaluated rule fixture");
  return { policy, rule: policy.rules[0] };
}

describe("accountable release decision record shape", () => {
  it.each([0, 1, 2, 3])("retains disposition vector %i without inventing authority", (index) => {
    const value = definition(index);
    expect(
      ReleaseDecisionSchema.parse({
        ...value,
        schemaVersion: "0.1",
        definitionSha256: "a".repeat(64),
      }),
    ).toMatchObject(value);
  });

  it("admits only explicit public intent and prevents result/actor/clock injection", () => {
    const value = definition();
    const intent = { decisionId: value.decisionId, input: value.input, rationale: value.rationale };
    expect(CreateReleaseDecisionRequestSchema.parse(intent)).toEqual(intent);
    for (const field of [
      "scope",
      "candidate",
      "selection",
      "policies",
      "authoritySnapshot",
      "publisher",
      "decidedAt",
      "expiresAt",
      "disposition",
      "safe",
      "workerId",
    ])
      expect(
        CreateReleaseDecisionRequestSchema.safeParse({ ...intent, [field]: true }).success,
        field,
      ).toBe(false);
  });

  it("keeps original approval indeterminate and requires attributable applied approval references", () => {
    const { rule } = first(definition());
    expect(rule.originalOutcome).toBe("indeterminate");
    expect(rule.status).toBe("satisfied");
    for (const changed of [
      { originalOutcome: "satisfied" },
      { supportingApprovals: [] },
      { predicateKind: "artifact_required" },
    ])
      expect(ReleaseDecisionRuleFindingSchema.safeParse({ ...rule, ...changed }).success).toBe(
        false,
      );
    expect(
      ReleaseDecisionRuleFindingSchema.safeParse({
        ...rule,
        status: "unresolved",
        reason: "normal_approval_unavailable",
        supportingApprovals: [],
      }).success,
    ).toBe(true);
  });

  it("allows exact exceptions only for known waivable non-approval violations", () => {
    const { rule } = first(definition());
    const exception = {
      ...rule,
      predicateKind: "coverage_floor",
      originalOutcome: "violated",
      nonWaivable: false,
      reason: "scoped_exception_applied",
    };
    expect(ReleaseDecisionRuleFindingSchema.safeParse(exception).success).toBe(true);
    for (const changed of [
      { nonWaivable: true },
      { originalOutcome: "indeterminate" },
      { originalOutcome: "not_applicable" },
      { predicateKind: "approval_required" },
      { supportingApprovals: [] },
    ])
      expect(ReleaseDecisionRuleFindingSchema.safeParse({ ...exception, ...changed }).success).toBe(
        false,
      );
  });

  it("rejects relabelled non-waivable findings and unsupported resolution bases", () => {
    const { rule } = first(definition(2));
    for (const changed of [
      { nonWaivable: false },
      { originalOutcome: "satisfied" },
      { reason: "exception_unavailable" },
      { predicateKind: "approval_required" },
      {
        supportingApprovals: [
          { approvalId: "approval_unrelated", definitionSha256: "a".repeat(64) },
        ],
      },
    ])
      expect(ReleaseDecisionRuleFindingSchema.safeParse({ ...rule, ...changed }).success).toBe(
        false,
      );
    expect(
      ReleaseDecisionRuleFindingSchema.safeParse({ ...rule, status: "unresolved" }).success,
    ).toBe(false);
    expect(
      ReleaseDecisionRuleFindingSchema.safeParse({
        ...rule,
        status: "satisfied",
        reason: "review_opposed",
      }).success,
    ).toBe(false);
    expect(
      ReleaseDecisionRuleFindingSchema.safeParse({
        ...rule,
        status: "satisfied",
        reason: "evaluation_satisfied",
      }).success,
    ).toBe(false);
  });

  it("does not erase unavailable original requests, jobs, seals or ledger statuses", () => {
    const unavailable = definition(1).policies[0];
    if (unavailable?.state !== "unavailable") throw new Error("Missing unavailable fixture");
    expect(unavailable.jobStatus).toBe("running");
    expect(
      ReleaseDecisionPolicyFindingSchema.safeParse({ ...unavailable, jobStatus: undefined })
        .success,
    ).toBe(false);
    expect(
      ReleaseDecisionPolicyFindingSchema.safeParse({
        ...unavailable,
        job: undefined,
        jobStatus: undefined,
      }).success,
    ).toBe(false);
    expect(
      ReleaseDecisionPolicyFindingSchema.safeParse({ ...unavailable, reason: "request_missing" })
        .success,
    ).toBe(false);
    expect(
      ReleaseDecisionPolicyFindingSchema.safeParse({ ...unavailable, jobStatus: "successful" })
        .success,
    ).toBe(false);
  });

  it("preserves full original contiguous rule inventory and unique support identities", () => {
    const value = definition();
    const { policy, rule } = first(value);
    for (const changed of [
      { ruleCount: 2 },
      { rules: [] },
      { rules: [{ ...rule, ruleIndex: 1 }] },
      { ruleCount: 2, rules: [rule, rule] },
    ])
      expect(ReleaseDecisionPolicyFindingSchema.safeParse({ ...policy, ...changed }).success).toBe(
        false,
      );
    const support = rule.supportingApprovals[0];
    if (!support) throw new Error("Missing supporting approval");
    expect(
      ReleaseDecisionRuleFindingSchema.safeParse({
        ...rule,
        supportingApprovals: [support, { ...support, definitionSha256: "b".repeat(64) }],
      }).success,
    ).toBe(false);
    const second = value.policies[1];
    if (second?.state !== "evaluated") throw new Error("Missing advisory fixture");
    second.rules = [
      {
        ...rule,
        predicateKind: "coverage_floor",
        originalOutcome: "violated",
        nonWaivable: false,
        reason: "scoped_exception_applied",
      },
    ];
    expect(ReleaseDecisionDefinitionSchema.safeParse(value).success).toBe(false);
  });

  it("rejects forged overall disposition, mandatory downgrade and original request reuse", () => {
    const value = definition();
    expect(value.disposition).toBe("proceed"); // The advisory non-waivable violation remains non-blocking.
    expect(
      ReleaseDecisionDefinitionSchema.safeParse({ ...value, disposition: "reject" }).success,
    ).toBe(false);
    expect(
      ReleaseDecisionDefinitionSchema.safeParse({ ...value, mode: "observation_only" }).success,
    ).toBe(false);
    const p = value.policies[0];
    const q = value.policies[1];
    if (!p || !q) throw new Error("Missing full policy inventory");
    q.request = p.request;
    expect(ReleaseDecisionDefinitionSchema.safeParse(value).success).toBe(false);
    expect(
      ReleaseDecisionDefinitionSchema.safeParse({
        ...definition(),
        policies: [...definition().policies].reverse(),
      }).success,
    ).toBe(false);
  });

  it.each([
    "unavailable",
    "not_effective",
    "expired",
    "withdrawn",
    "superseded",
    "conflicting",
  ] as const)(
    "requires hold for %s current selection while retaining original results",
    (selectionState) => {
      const value = definition();
      expect(ReleaseDecisionDefinitionSchema.safeParse({ ...value, selectionState }).success).toBe(
        false,
      );
      expect(
        ReleaseDecisionDefinitionSchema.safeParse({ ...value, selectionState, disposition: "hold" })
          .success,
      ).toBe(true);
    },
  );

  it.each(["job", "snapshot", "evaluation"] as const)(
    "rejects original %s reuse across requests",
    (kind) => {
      const value = definition();
      const p = first(value).policy;
      const q = value.policies[1];
      if (q?.state !== "evaluated") throw new Error("Missing second evaluated policy");
      if (kind === "job") q.job = p.job;
      if (kind === "snapshot") q.snapshot = p.snapshot;
      if (kind === "evaluation") q.evaluation = p.evaluation;
      expect(ReleaseDecisionDefinitionSchema.safeParse(value).success).toBe(false);
    },
  );

  it("bounds exact native validity and rejects malformed authentication strings without throwing", () => {
    const value = definition();
    for (const expiresAt of [
      value.decidedAt,
      "2026-10-15T13:02:00.000001000000000000000000000001Z",
    ])
      expect(ReleaseDecisionDefinitionSchema.safeParse({ ...value, expiresAt }).success).toBe(
        false,
      );
    expect(
      ReleaseDecisionDefinitionSchema.safeParse({
        ...value,
        expiresAt: "2026-10-15T13:02:00.000001Z",
      }).success,
    ).toBe(true);
    expect(
      ReleaseDecisionDefinitionSchema.safeParse({
        ...value,
        publisher: { ...value.publisher, authenticatedAt: "2026-10-15T12:02:00.001Z" },
      }).success,
    ).toBe(false);
    expect(
      ReleaseDecisionDefinitionSchema.safeParse({
        ...value,
        publisher: { ...value.publisher, requestId: String.fromCharCode(0xd800) },
      }).success,
    ).toBe(false);
  });

  it("strictly versions immutable records and references", () => {
    const value = definition();
    const reference = { decisionId: value.decisionId, definitionSha256: "a".repeat(64) };
    expect(ReleaseDecisionReferenceSchema.parse(reference)).toEqual(reference);
    expect(ReleaseDecisionReferenceSchema.safeParse({ ...reference, approved: true }).success).toBe(
      false,
    );
    expect(
      ReleaseDecisionSchema.safeParse({
        ...value,
        schemaVersion: "0.2",
        definitionSha256: "a".repeat(64),
      }).success,
    ).toBe(false);
    expect(
      ReleaseDecisionDefinitionSchema.safeParse({ ...value, trustedAuthority: true }).success,
    ).toBe(false);
    expect(
      ReleaseDecisionDefinitionSchema.safeParse({
        ...value,
        algorithm: { ...value.algorithm, version: "2.0.0" },
      }).success,
    ).toBe(false);
  });

  it("independently proves full 16x128-rule and 4096-support UTF-8 response headroom", () => {
    const value = definition(2);
    const { policy, rule } = first(value);
    const id = (prefix: string) => prefix.padEnd(64, "x");
    const ref = (key: string, prefix: string) => ({
      [key]: id(prefix),
      definitionSha256: "a".repeat(64),
    });
    value.scope = {
      tenantId: id("tenant"),
      projectId: id("project"),
      environmentId: id("environment"),
    };
    value.decisionId = id("decision");
    value.rationale = "😀".repeat(4096);
    value.publisher = {
      ...value.publisher,
      principalId: id("principal"),
      credentialId: id("credential"),
      requestId: String.fromCharCode(0).repeat(128),
    };
    value.input = { decisionInputRequestId: id("input"), definitionSha256: "a".repeat(64) };
    value.candidate = {
      candidateId: id("candidate"),
      candidateVersionId: id("version"),
      definitionSha256: "a".repeat(64),
    };
    value.selection = {
      selectionId: id("selection"),
      selectionVersionId: id("version"),
      installationId: id("installation"),
      gateTargetId: id("gate"),
      definitionSha256: "a".repeat(64),
    };
    value.authoritySnapshot = {
      authoritySnapshotId: id("authority_snapshot"),
      definitionSha256: "a".repeat(64),
    };
    value.decidedAt = "2026-10-15T12:02:00.000001000000000000000000000000Z";
    value.expiresAt = "2026-10-15T13:02:00.000001000000000000000000000000Z";
    value.policies = Array.from({ length: 16 }, (_, p) => ({
      ...structuredClone(policy),
      policy: {
        policyId: id(`policy_${p.toString().padStart(2, "0")}`),
        policyVersionId: id("version"),
        definitionSha256: "a".repeat(64),
      },
      request: {
        evaluationRequestId: id(`request_${p.toString().padStart(2, "0")}`),
        definitionSha256: "a".repeat(64),
      },
      job: ref("jobId", `job_${p.toString().padStart(2, "0")}`) as typeof policy.job,
      snapshot: ref(
        "snapshotId",
        `snapshot_${p.toString().padStart(2, "0")}`,
      ) as typeof policy.snapshot,
      evaluation: ref(
        "evaluationId",
        `evaluation_${p.toString().padStart(2, "0")}`,
      ) as typeof policy.evaluation,
      ruleCount: 128,
      rules: Array.from({ length: 128 }, (_, r) => ({
        ...structuredClone(rule),
        ruleId: id(`rule_${r.toString().padStart(3, "0")}`),
        ruleIndex: r,
        predicateKind: "comparison_threshold" as const,
        ...(p === 0
          ? {
              nonWaivable: false,
              status: "satisfied" as const,
              reason: "scoped_exception_applied" as const,
              supportingApprovals: Array.from({ length: 32 }, (_, a) => ({
                approvalId: id(
                  `approval_${r.toString().padStart(3, "0")}_${a.toString().padStart(2, "0")}`,
                ),
                definitionSha256: "a".repeat(64),
              })),
            }
          : {}),
      })),
    }));
    const parsed = ReleaseDecisionDefinitionSchema.parse(value);
    expect(Buffer.byteLength(JSON.stringify(parsed))).toBeLessThan(
      MAX_RELEASE_DECISION_DEFINITION_BYTES,
    );
    expect(
      Buffer.byteLength(
        JSON.stringify({
          decision: { ...parsed, schemaVersion: "0.1", definitionSha256: "a".repeat(64) },
          requestId: String.fromCharCode(0).repeat(128),
        }),
      ),
    ).toBeLessThan(MAX_RELEASE_DECISION_RESPONSE_BYTES);
    const extra = first({ ...value, policies: [value.policies[1] as typeof policy] });
    extra.rule.nonWaivable = false;
    extra.rule.status = "satisfied";
    extra.rule.reason = "scoped_exception_applied";
    extra.rule.supportingApprovals = [
      { approvalId: id("approval_extra"), definitionSha256: "a".repeat(64) },
    ];
    expect(ReleaseDecisionDefinitionSchema.safeParse(value).success).toBe(false);
    expect(
      ReleaseDecisionDefinitionSchema.safeParse({
        ...parsed,
        policies: [...parsed.policies, structuredClone(parsed.policies[15])],
      }).success,
    ).toBe(false);
  });
});
