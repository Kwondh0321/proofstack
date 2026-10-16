import {
  PolicyEvaluationRecordWitnessSchema,
  PolicyEvaluationSourceReferenceSchema,
  EvidenceScopeSchema,
} from "@proofstack/contracts";
import {
  CreateModelAssuranceAssessment,
  readPolicyEvaluationEvidenceCapture,
  ReleaseDecisionVerificationBudget,
  ReleaseDecisionVerificationBudgetError,
  type PolicyEvaluationEvidenceSource,
} from "@proofstack/core";
import {
  createModelAssuranceRepositoryTestHarness,
  FixedClock,
  type ModelAssuranceRepositoryTestHarness,
} from "@proofstack/core/testing";
import { beforeAll, describe, expect, it } from "vitest";
import {
  inspectOriginalSourceActors,
  InvalidOriginalSourceActorsError,
} from "./inspect-original-source-actors.js";

// Independent explicit owning-record/actor matrix. An enqueue or publication is not execution.
const cases = [
  ["aggregation_policy", "aggregation_policy", [["/publishedByPrincipalId", "source_author"]]],
  ["assessment", "assessment", [["/createdByPrincipalId", "evaluation_actor"]]],
  ["criterion_set", "criterion_set", [["/publishedByPrincipalId", "source_author"]]],
  ["criterion_set_status", "criterion_set_status", [["/recordedByPrincipalId", "source_author"]]],
  ["discovery_record", "discovery_record", [["/recordedByPrincipalId", "source_author"]]],
  ["evaluation_aggregate", "evaluation_aggregate", [["/createdByPrincipalId", "evaluation_actor"]]],
  ["evaluation_run", "evaluation_run", [["/createdByPrincipalId", "evaluation_requester"]]],
  [
    "evaluation_run_rejection",
    "evaluation_run_rejection",
    [["/requestedByPrincipalId", "evaluation_requester"]],
  ],
  [
    "evaluation_run_result",
    "evaluation_run_result",
    [["/recordedByPrincipalId", "evaluation_actor"]],
  ],
  ["evaluator_spec", "evaluator_spec", [["/publishedByPrincipalId", "source_author"]]],
  ["oracle_spec", "oracle_spec", [["/publishedByPrincipalId", "source_author"]]],
  [
    "qualification_fixture_set",
    "qualification_fixture_set",
    [["/publishedByPrincipalId", "source_author"]],
  ],
  [
    "qualification_report",
    "qualification_report",
    [["/executedByPrincipalId", "evaluation_actor"]],
  ],
  ["raw_observation", "raw_observation", [["/executedByPrincipalId", "evaluation_actor"]]],
  ["source_review", "source_review", [["/reviewedByPrincipalId", "evaluation_actor"]]],
  [
    "source_reviewer_qualification",
    "source_reviewer_qualification",
    [
      ["/reviewerPrincipalId", "declared_principal"],
      ["/verifiedByPrincipalId", "evaluation_actor"],
    ],
  ],
  ["source_snapshot", "source_snapshot", [["/publishedByPrincipalId", "source_author"]]],
  ["blinded_plan", "blinded_evaluation_plan", [["/publishedByPrincipalId", "source_author"]]],
  ["blinded_result", "blinded_evaluation_result", [["/recordedByPrincipalId", "evaluation_actor"]]],
  ["calibration_report", "calibration_report", [["/executedByPrincipalId", "evaluation_actor"]]],
  [
    "human_review_protocol",
    "human_review_protocol",
    [["/publishedByPrincipalId", "source_author"]],
  ],
  ["human_review_record", "human_review_record", [["/reviewer/principalId", "evaluation_actor"]]],
  [
    "human_reviewer_independence",
    "human_reviewer_independence",
    [
      ["/reviewedByPrincipalId", "evaluation_actor"],
      ["/reviewerPrincipalId", "declared_principal"],
    ],
  ],
  [
    "independence_declaration",
    "independence_declaration",
    [["/reviewedByPrincipalId", "evaluation_actor"]],
  ],
  [
    "independent_critique",
    "independent_critique",
    [["/recordedByPrincipalId", "evaluation_actor"]],
  ],
  [
    "model_assisted_evaluator_spec",
    "model_assisted_evaluator",
    [["/publishedByPrincipalId", "source_author"]],
  ],
  ["model_assurance_assessment", "model_assurance_assessment", []],
  [
    "model_evaluator_profile",
    "model_evaluator_profile",
    [["/publishedByPrincipalId", "source_author"]],
  ],
  [
    "model_qualification_report",
    "model_qualification_report",
    [["/executedByPrincipalId", "evaluation_actor"]],
  ],
  [
    "model_qualification_suite",
    "model_qualification_suite",
    [["/publishedByPrincipalId", "source_author"]],
  ],
] as const;
type Case = (typeof cases)[number];
let harness: ModelAssuranceRepositoryTestHarness;
let records: readonly { readonly kind: string; readonly record: unknown }[];
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Missing owning fixture object");
  return value as Record<string, unknown>;
}
function field(record: unknown, path: string): string {
  let value = record;
  for (const key of path.split("/").slice(1)) value = object(value)[key];
  if (typeof value !== "string") throw new Error("Missing fixture actor receipt");
  return value;
}
async function fixture(testCase: Case, evaluationTime = "2026-10-01T00:00:00.000Z") {
  const row = records.find(({ kind }) => kind === testCase[1]);
  if (!row) throw new Error("Missing owning record fixture");
  const record = structuredClone(row.record);
  const option = PolicyEvaluationSourceReferenceSchema.options.find(
    ({ shape }) => shape.kind.value === testCase[0],
  );
  if (!option) throw new Error("Missing owning source schema");
  const source = PolicyEvaluationSourceReferenceSchema.parse({
    kind: testCase[0],
    reference: Object.fromEntries(
      Object.keys(option.shape.reference.shape).map((key) => [key, object(record)[key]]),
    ),
  }) as PolicyEvaluationEvidenceSource;
  const scope = EvidenceScopeSchema.parse(object(record)["scope"]);
  // Owning schema capture supplies the real scope rather than a caller-selected source actor.
  const captured = await readPolicyEvaluationEvidenceCapture(
    { source, scope, evaluationTime },
    { evaluation: harness.evaluation.repository, modelAssurance: harness.repository },
  );
  if (!captured.storage) throw new Error("Missing real retained fixture body");
  const witness = PolicyEvaluationRecordWitnessSchema.parse({
    entry: { source, observation: captured.read.observation },
    storage: {
      recordSha256: captured.storage.recordSha256,
      receiptTime: captured.storage.receiptTime,
    },
    origins: [
      { kind: "semantic_node", nodeIndex: 0 },
      { kind: "stored_node", nodeIndex: 1 },
    ],
  });
  return {
    scope,
    evaluationTime,
    witness,
    body: record,
    replayLimits: { maximumRecords: 1000, maximumRecordBytes: 1_000_000 },
    budget: new ReleaseDecisionVerificationBudget({
      maxAcquisitionRecords: 1000,
      maxAcquisitionRecordBytes: 8 * 1024 * 1024,
      maxApprovalRecords: 0,
    }),
  };
}
beforeAll(async () => {
  harness = await createModelAssuranceRepositoryTestHarness("release_actors");
  const assessment = await new CreateModelAssuranceAssessment({
    clock: new FixedClock(new Date("2026-09-02T06:00:00.000Z")),
    evaluationRepository: harness.evaluation.repository,
    modelAssuranceRepository: harness.repository,
  }).execute(harness.command);
  records = [
    ...harness.evaluation.records,
    ...harness.records,
    { kind: "model_assurance_assessment", record: assessment.record },
  ];
});
describe("original source actors through fixed owning validators", () => {
  it("retains all thirty actual evaluation and assurance owning kinds", () => {
    expect(cases).toHaveLength(30);
    expect(new Set(cases.map((entry) => entry[1]))).toEqual(
      new Set(records.map(({ kind }) => kind)),
    );
  });
  describe.each(cases)("%s", (kind, repositoryKind, expected) => {
    const testCase = [kind, repositoryKind, expected] as Case;
    it("rederives the exact source actors from a real retained full body without mutating it", async () => {
      const input = await fixture(testCase);
      const before = structuredClone({ body: input.body, witness: input.witness });
      const result = inspectOriginalSourceActors(input);
      expect(result.state).toBe("observed");
      if (result.state !== "observed") throw new Error("Missing original actor projection");
      expect(result.actors).toEqual(
        expected.map(([path, role]) => ({
          field: path,
          role,
          principalId: field(input.body, path),
        })),
      );
      expect(result.witness).toEqual(input.witness);
      expect({ body: input.body, witness: input.witness }).toEqual(before);
      expect(input.budget.snapshot().records).toBe(1);
    });
    it("preserves a future original body's semantic unavailability while retaining only its actor facts", async () => {
      const input = await fixture(testCase, "2000-01-01T00:00:00.000Z");
      const result = inspectOriginalSourceActors(input);
      expect(result.state).toBe("observed");
      expect(result.witness.entry.observation).toEqual({
        status: "unavailable",
        reason: "not_yet_available",
      });
      expect(input.evaluationTime).toBe("2000-01-01T00:00:00.000Z");
    });
    it("cannot substitute a newer valid body for an original full record hash", async () => {
      const input = await fixture(testCase);
      const storage = input.witness.storage;
      if (!storage) throw new Error("Missing original body fixture");
      input.witness.storage = { recordSha256: "0".repeat(64), receiptTime: storage.receiptTime };
      input.witness.entry.observation = { status: "verified", recordSha256: "0".repeat(64) };
      expect(inspectOriginalSourceActors(input)).toMatchObject({
        state: "unavailable",
        reason: "original_body_mismatch",
      });
    });
    it("retains missing owning bodies and absent original bodies without inventing actors", async () => {
      const input = await fixture(testCase);
      expect(inspectOriginalSourceActors({ ...input, body: null })).toMatchObject({
        state: "unavailable",
        reason: "owning_source_unavailable",
      });
      input.witness.entry.observation = { status: "missing" };
      input.witness.storage = null;
      expect(inspectOriginalSourceActors(input)).toMatchObject({
        state: "unavailable",
        reason: "original_body_unavailable",
      });
    });
  });
  it.each(["assessment", "evaluation_run_result", "blinded_result"])(
    "binds %s actor receipts even when their semantic definition digest is unchanged",
    async (kind) => {
      const testCase = cases.find((entry) => entry[0] === kind);
      if (!testCase) throw new Error("Missing receipt case");
      const input = await fixture(testCase);
      const record = object(input.body);
      const definitionSha = record["definitionSha256"];
      const actorField = kind === "assessment" ? "createdByPrincipalId" : "recordedByPrincipalId";
      record[actorField] = "principal_forged";
      expect(record["definitionSha256"]).toBe(definitionSha);
      expect(inspectOriginalSourceActors(input)).toMatchObject({
        state: "unavailable",
        reason: "original_body_mismatch",
      });
    },
  );
  it("preserves aggregate admission and cannot refund an oversized discarded body", async () => {
    const input = await fixture(cases[0]);
    input.budget = new ReleaseDecisionVerificationBudget({
      maxAcquisitionRecords: 2,
      maxAcquisitionRecordBytes: 2,
      maxApprovalRecords: 0,
    });
    expect(() => inspectOriginalSourceActors(input)).toThrow(
      ReleaseDecisionVerificationBudgetError,
    );
    expect(() => input.budget.snapshot()).toThrow(ReleaseDecisionVerificationBudgetError);
  });
  it.each(["tenantId", "projectId", "environmentId"] as const)(
    "never extracts an actor through a different owning %s",
    async (key) => {
      const input = await fixture(cases[0]);
      input.scope = { ...input.scope, [key]: "scope_other" };
      expect(inspectOriginalSourceActors(input)).toMatchObject({
        state: "unavailable",
        reason: "owning_source_unavailable",
      });
    },
  );
  it("rejects an invalid original witness with a bounded domain error", async () => {
    const input = await fixture(cases[0]);
    Reflect.set(input.witness, "authenticated", true);
    expect(() => inspectOriginalSourceActors(input)).toThrow(InvalidOriginalSourceActorsError);
  });
});
