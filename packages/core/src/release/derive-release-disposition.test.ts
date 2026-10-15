import { readFileSync } from "node:fs";
import {
  ReleaseDecisionDefinitionSchema,
  ReleaseDecisionInputDefinitionSchema,
  type ReleaseDecisionPolicyFinding,
} from "@proofstack/contracts";
import { describe, expect, it } from "vitest";
import {
  deriveReleaseDisposition,
  InvalidReleaseDecisionInventoryError,
} from "./derive-release-disposition.js";

function doc(name: string): { vectors: { input: { definition: unknown } }[] } {
  return JSON.parse(
    readFileSync(
      new URL(`../../../contracts/vectors/${name}-definition-v1.json`, import.meta.url),
      "utf8",
    ),
  ) as { vectors: { input: { definition: unknown } }[] };
}
const requests = doc("release-decision-input");
const decisions = doc("release-decision");
function fixture() {
  return {
    request: ReleaseDecisionInputDefinitionSchema.parse(
      structuredClone(requests.vectors[0]?.input.definition),
    ),
    selectionState: "current" as const,
    policies: ReleaseDecisionDefinitionSchema.parse(
      structuredClone(decisions.vectors[0]?.input.definition),
    ).policies,
  };
}
const states = ["satisfied", "unresolved", "violation", "unavailable"] as const;
type State = (typeof states)[number];
// Independent normative table, rows/columns use states above. Operational absence is never rejection.
const mandatoryMatrix = [
  ["proceed", "hold", "reject", "hold"],
  ["hold", "hold", "reject", "hold"],
  ["reject", "reject", "reject", "reject"],
  ["hold", "hold", "reject", "hold"],
] as const;
const singleMandatory = ["proceed", "hold", "reject", "hold"] as const;
function observation(
  base: ReleaseDecisionPolicyFinding,
  state: State,
): ReleaseDecisionPolicyFinding {
  if (base.state !== "evaluated") throw new Error("Missing original evaluated fixture");
  if (state === "unavailable")
    return {
      policy: base.policy,
      request: base.request,
      mode: base.mode,
      state: "unavailable",
      reason: "original_graph_unavailable",
    };
  const original = base.rules[0];
  if (!original) throw new Error("Missing original rule fixture");
  return {
    ...structuredClone(base),
    rules: [
      {
        ...original,
        predicateKind: "coverage_floor",
        originalOutcome:
          state === "satisfied"
            ? "satisfied"
            : state === "violation"
              ? "violated"
              : "indeterminate",
        nonWaivable: state === "violation",
        status: state === "violation" ? "non_waivable_violation" : state,
        reason:
          state === "satisfied"
            ? "evaluation_satisfied"
            : state === "violation"
              ? "non_waivable_violation"
              : "evidence_indeterminate",
        supportingApprovals: [],
      },
    ],
  };
}

describe("complete original release decision aggregation", () => {
  it.each(states.map((state, index) => ({ state, index })))(
    "matches mandatory matrix for $state without advisory influence",
    ({ state, index }) => {
      for (const other of states)
        for (const bothMandatory of [false, true]) {
          const value = fixture();
          const first = value.policies[0];
          const second = value.policies[1];
          const planned = value.request.evaluations[1];
          if (!first || !second || !planned) throw new Error("Missing two-policy root");
          if (bothMandatory) {
            planned.mode = "mandatory";
            second.mode = "mandatory";
          }
          value.policies = [observation(first, state), observation(second, other)];
          expect(deriveReleaseDisposition(value)).toBe(
            bothMandatory
              ? mandatoryMatrix[index]?.[states.indexOf(other)]
              : singleMandatory[index],
          );
          for (const selectionState of [
            "unavailable",
            "not_effective",
            "expired",
            "withdrawn",
            "superseded",
            "conflicting",
          ] as const)
            expect(deriveReleaseDisposition({ ...value, selectionState })).toBe("hold");
        }
    },
  );

  it("keeps explicit observation advisory even when every advisory result is missing or violated", () => {
    for (const state of states) {
      const value = fixture();
      value.request.mode = "observation_only";
      for (const planned of value.request.evaluations) planned.mode = "advisory";
      value.policies = value.policies.map((policy) =>
        observation({ ...policy, mode: "advisory" }, state),
      );
      expect(deriveReleaseDisposition(value)).toBe("advisory");
    }
    const empty = ReleaseDecisionInputDefinitionSchema.parse(
      structuredClone(requests.vectors[2]?.input.definition),
    );
    expect(
      deriveReleaseDisposition({ request: empty, selectionState: "current", policies: [] }),
    ).toBe("advisory");
    expect(
      deriveReleaseDisposition({ request: empty, selectionState: "unavailable", policies: [] }),
    ).toBe("hold");
  });

  it("rejects omitted, reordered, duplicated and favorable caller-selected original inventories", () => {
    const value = fixture();
    const first = value.policies[0];
    if (!first) throw new Error("Missing policy fixture");
    for (const policies of [
      [],
      [first],
      [first, first],
      [...value.policies].reverse(),
      [...value.policies, first],
    ])
      expect(() => deriveReleaseDisposition({ ...value, policies })).toThrow(
        InvalidReleaseDecisionInventoryError,
      );
  });

  it.each(["policy", "policyVersion", "policyDigest", "request", "requestDigest", "mode"])(
    "rejects substituted %s even if every available rule is satisfied",
    (kind) => {
      const value = fixture();
      const first = value.policies[0];
      if (!first) throw new Error("Missing first policy");
      if (kind === "policy") first.policy.policyId = "policy_substituted";
      if (kind === "policyVersion") first.policy.policyVersionId = "policy_version_substituted";
      if (kind === "policyDigest") first.policy.definitionSha256 = "0".repeat(64);
      if (kind === "request") first.request.evaluationRequestId = "request_substituted";
      if (kind === "requestDigest") first.request.definitionSha256 = "0".repeat(64);
      if (kind === "mode") first.mode = "advisory";
      expect(() => deriveReleaseDisposition(value)).toThrow(InvalidReleaseDecisionInventoryError);
    },
  );

  it.each(["job", "snapshot", "evaluation"] as const)(
    "rejects one original %s reused by distinct planned requests",
    (kind) => {
      const value = fixture();
      const first = value.policies[0];
      const second = value.policies[1];
      if (first?.state !== "evaluated" || second?.state !== "evaluated")
        throw new Error("Missing evaluated originals");
      if (kind === "job") second.job = first.job;
      if (kind === "snapshot") second.snapshot = first.snapshot;
      if (kind === "evaluation") second.evaluation = first.evaluation;
      expect(() => deriveReleaseDisposition(value)).toThrow(InvalidReleaseDecisionInventoryError);
    },
  );

  it("enforces aggregate support bounds and does not count one exact approval for multiple rules", () => {
    const value = fixture();
    value.request.verificationLimits.maxApprovalRecords = 0;
    expect(() => deriveReleaseDisposition(value)).toThrow(InvalidReleaseDecisionInventoryError);
    const repeated = fixture();
    const first = repeated.policies[0];
    const second = repeated.policies[1];
    if (first?.state !== "evaluated" || second?.state !== "evaluated")
      throw new Error("Missing evaluated originals");
    const rule = first.rules[0];
    if (!rule) throw new Error("Missing original approval rule");
    second.rules = [
      {
        ...rule,
        predicateKind: "coverage_floor",
        originalOutcome: "violated",
        nonWaivable: false,
        reason: "scoped_exception_applied",
      },
    ];
    expect(() => deriveReleaseDisposition(repeated)).toThrow(InvalidReleaseDecisionInventoryError);
  });

  it("rejects malformed or authority-injected observations rather than treating them as holds", () => {
    const value = fixture();
    for (const invalid of [
      null,
      [],
      { ...value, authority: true },
      { ...value, selectionState: true },
      { ...value, policies: null },
      { ...value, request: null },
    ])
      expect(() => deriveReleaseDisposition(invalid as typeof value)).toThrow(
        InvalidReleaseDecisionInventoryError,
      );
  });
});
