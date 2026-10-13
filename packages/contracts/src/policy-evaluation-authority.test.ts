import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  RELEASE_POLICY_AUTHORITY_REASONS,
  PolicyEvaluationAuthorityRequirementsSchema,
  PolicyEvaluationLifecycleInputsSchema,
  type PolicyEvaluationLifecycleInputs,
} from "./policy-evaluation-authority.js";
import { ReleasePolicyDefinitionSchema, ReleasePolicySchema } from "./release-policy.js";

const sha = "a".repeat(64);
const scope = {
  tenantId: "tenant_authority",
  projectId: "project_authority",
  environmentId: "env_authority",
};
const policy = {
  policyId: "policy_authority",
  policyVersionId: "policy_authority_v1",
  definitionSha256: sha,
};
function input(): PolicyEvaluationLifecycleInputs {
  return {
    scope: structuredClone(scope),
    policy: structuredClone(policy),
    policyRecordSha256: sha,
    evaluationTime: "2026-10-03T00:00:00.000000000000000000000000000001Z",
    startedAt: "2026-10-04T00:00:00.000Z",
    completedAt: "2026-10-04T00:00:00.001Z",
    observationSha256: sha,
    state: "no_terminal_event_at_evaluation",
    history: [],
  };
}
function withdrawal(at = "2026-10-03T00:00:00.000Z"): PolicyEvaluationLifecycleInputs {
  const value = input();
  value.history = [
    {
      record: {
        actorPrincipalId: "principal_authority",
        eventId: "event_authority",
        occurredAt: at,
        policy: structuredClone(policy),
        reason: "Retained authority withdrawal",
        schemaVersion: "0.1",
        scope: structuredClone(scope),
        kind: "withdrawn",
      },
      recordSha256: sha,
      successor: null,
    },
  ];
  value.state = at.startsWith("2026-10-03")
    ? "withdrawn_at_evaluation"
    : "no_terminal_event_at_evaluation";
  return value;
}
function supersession(): PolicyEvaluationLifecycleInputs {
  const document = JSON.parse(
    readFileSync(new URL("../vectors/release-policy-definition-v1.json", import.meta.url), "utf8"),
  ) as {
    vectors: { kind: string; input: { definition: unknown } }[];
  };
  const raw = document.vectors.find(({ kind }) => kind === "release_policy");
  if (!raw) throw new Error("Missing independent policy definition vector");
  const definition = ReleasePolicyDefinitionSchema.parse(raw.input.definition);
  const record = ReleasePolicySchema.parse({
    ...definition,
    policyId: policy.policyId,
    policyVersionId: "policy_authority_v2",
    predecessor: policy,
    definitionSha256: "b".repeat(64),
    publishedAt: "2026-10-01T00:00:00.000Z",
    publishedByPrincipalId: definition.issuerPrincipalId,
    schemaVersion: "0.1",
    scope,
  });
  const value = input();
  value.history = [
    {
      record: {
        actorPrincipalId: "principal_authority",
        eventId: "event_authority",
        occurredAt: "2026-10-03T00:00:00.000Z",
        policy,
        reason: "Retained exact successor",
        schemaVersion: "0.1",
        scope,
        kind: "superseded",
        successor: {
          policyId: record.policyId,
          policyVersionId: record.policyVersionId,
          definitionSha256: record.definitionSha256,
        },
      },
      recordSha256: sha,
      successor: { record, recordSha256: "b".repeat(64) },
    },
  ];
  value.state = "superseded_at_evaluation";
  return value;
}

describe("strict retained policy authority inputs", () => {
  it.each(RELEASE_POLICY_AUTHORITY_REASONS)("preserves owning authority finding %s", (reason) => {
    const value = { status: "invalid", findings: [{ reason, sourceReviewId: "review_authority" }] };
    expect(PolicyEvaluationAuthorityRequirementsSchema.parse(value)).toEqual(value);
  });
  it.each([
    { status: "valid", findings: [{ reason: "source_snapshot_unavailable" }] },
    { status: "invalid", findings: [] },
    { status: "valid", findings: [], approved: true },
    { status: "invalid", findings: [{ reason: "caller_approval" }] },
  ])("rejects invented status, approval or authority vocabulary", (value) => {
    expect(PolicyEvaluationAuthorityRequirementsSchema.safeParse(value).success).toBe(false);
  });
  it("accepts empty retained findings without implying current publication authority", () => {
    expect(
      PolicyEvaluationAuthorityRequirementsSchema.parse({ status: "valid", findings: [] }),
    ).toEqual({ status: "valid", findings: [] });
  });
  it.each([input, withdrawal, () => withdrawal("2026-10-04T00:00:00.000Z"), supersession])(
    "preserves complete empty, withdrawn, later-terminal and superseded histories",
    (create) => {
      const value = create();
      expect(PolicyEvaluationLifecycleInputsSchema.parse(value)).toEqual(value);
    },
  );
  it.each(["scope", "policy", "future", "state", "cut", "order", "extra_history"] as const)(
    "rejects changed lifecycle %s",
    (field) => {
      const value = withdrawal();
      if (field === "scope") value.history[0]!.record.scope.tenantId = "tenant_other";
      else if (field === "policy")
        value.history[0]!.record.policy.definitionSha256 = "b".repeat(64);
      else if (field === "future") value.history[0]!.record.occurredAt = "2026-10-05T00:00:00.000Z";
      else if (field === "state") value.state = "no_terminal_event_at_evaluation";
      else if (field === "cut") value.startedAt = "2026-10-01T00:00:00.000Z";
      else if (field === "order") value.completedAt = "2026-10-03T00:00:00.000Z";
      else value.history.push(structuredClone(value.history[0]!));
      expect(PolicyEvaluationLifecycleInputsSchema.safeParse(value).success).toBe(false);
    },
  );
  it.each(["missing", "scope", "predecessor", "identity", "time", "withdrawal"] as const)(
    "rejects changed successor %s",
    (field) => {
      const value = supersession();
      const event = value.history[0]!;
      const successor = event.successor!.record;
      if (field === "missing") event.successor = null;
      else if (field === "scope") successor.scope.projectId = "project_other";
      else if (field === "predecessor") successor.predecessor!.definitionSha256 = "c".repeat(64);
      else if (field === "identity") successor.definitionSha256 = "c".repeat(64);
      else if (field === "time") successor.publishedAt = "2026-10-03T00:00:00.001Z";
      else
        event.record = {
          actorPrincipalId: "principal_authority",
          eventId: "event_authority",
          occurredAt: "2026-10-03T00:00:00.000Z",
          policy,
          reason: "Withdrawal cannot carry successor",
          schemaVersion: "0.1",
          scope,
          kind: "withdrawn",
        };
      expect(PolicyEvaluationLifecycleInputsSchema.safeParse(value).success).toBe(false);
    },
  );
});
