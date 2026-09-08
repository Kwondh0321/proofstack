import { createHash } from "node:crypto";
import {
  encodeEvaluationCanonicalJson,
  PolicyEvaluationManifestEntrySchema,
  PolicyEvaluationSourceReferenceSchema,
} from "@proofstack/contracts";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { CreateModelAssuranceAssessment } from "../evaluation/create-model-assurance-assessment.js";
import { FixedClock } from "../testing/fixed-clock.js";
import {
  createModelAssuranceRepositoryTestHarness,
  type ModelAssuranceRepositoryTestHarness,
} from "../testing/model-assurance-repository-fixtures.js";
import {
  type PolicyEvaluationEvidenceReaderDependencies,
  PolicyEvaluationEvidenceReadInputError,
  type PolicyEvaluationEvidenceSource,
  type ReadPolicyEvaluationEvidenceInput,
  readPolicyEvaluationEvidence,
} from "./policy-evaluation-evidence-reader.js";

// Independent explicit matrix: new record kinds must not silently disappear from acquisition.
const cases = [
  ["aggregation_policy", "aggregation_policy", "publishedAt"],
  ["assessment", "assessment", "createdAt"],
  ["criterion_set", "criterion_set", "publishedAt"],
  ["criterion_set_status", "criterion_set_status", "recordedAt"],
  ["discovery_record", "discovery_record", "recordedAt"],
  ["evaluation_aggregate", "evaluation_aggregate", "createdAt"],
  ["evaluation_run", "evaluation_run", "createdAt"],
  ["evaluation_run_rejection", "evaluation_run_rejection", "recordedAt"],
  ["evaluation_run_result", "evaluation_run_result", "recordedAt"],
  ["evaluator_spec", "evaluator_spec", "publishedAt"],
  ["oracle_spec", "oracle_spec", "publishedAt"],
  ["qualification_fixture_set", "qualification_fixture_set", "publishedAt"],
  ["qualification_report", "qualification_report", "recordedAt"],
  ["raw_observation", "raw_observation", "recordedAt"],
  ["source_review", "source_review", "reviewedAt"],
  ["source_reviewer_qualification", "source_reviewer_qualification", "recordedAt"],
  ["source_snapshot", "source_snapshot", "recordedAt"],
  ["blinded_plan", "blinded_evaluation_plan", "publishedAt"],
  ["blinded_result", "blinded_evaluation_result", "recordedAt"],
  ["calibration_report", "calibration_report", "recordedAt"],
  ["human_review_protocol", "human_review_protocol", "publishedAt"],
  ["human_review_record", "human_review_record", "recordedAt"],
  ["human_reviewer_independence", "human_reviewer_independence", "recordedAt"],
  ["independence_declaration", "independence_declaration", "recordedAt"],
  ["independent_critique", "independent_critique", "recordedAt"],
  ["model_assisted_evaluator_spec", "model_assisted_evaluator", "publishedAt"],
  ["model_assurance_assessment", "model_assurance_assessment", "recordedAt"],
  ["model_evaluator_profile", "model_evaluator_profile", "publishedAt"],
  ["model_qualification_report", "model_qualification_report", "recordedAt"],
  ["model_qualification_suite", "model_qualification_suite", "publishedAt"],
] as const;
type Case = (typeof cases)[number];
let harness: ModelAssuranceRepositoryTestHarness;
let repositories: PolicyEvaluationEvidenceReaderDependencies;
let records: readonly (
  | ModelAssuranceRepositoryTestHarness["records"][number]
  | ModelAssuranceRepositoryTestHarness["evaluation"]["records"][number]
)[];

function fields(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") throw new Error("Expected fixture object");
  return value as Record<string, unknown>;
}

function sourceFor(kind: Case[0], record: unknown): PolicyEvaluationEvidenceSource {
  const option = PolicyEvaluationSourceReferenceSchema.options.find(
    ({ shape }) => shape.kind.value === kind,
  );
  if (!option) throw new Error(`Expected source schema ${kind}`);
  return PolicyEvaluationSourceReferenceSchema.parse({
    kind,
    reference: Object.fromEntries(
      Object.keys(option.shape.reference.shape).map((key) => [key, fields(record)[key]]),
    ),
  }) as PolicyEvaluationEvidenceSource;
}

function fixture(testCase: Case) {
  const match = records.find(({ kind }) => kind === testCase[1]);
  if (!match) throw new Error(`Expected retained fixture ${testCase[1]}`);
  const record = structuredClone(match.record);
  const input: ReadPolicyEvaluationEvidenceInput = {
    evaluationTime: "2026-10-01T00:00:00.000Z",
    scope: structuredClone(record.scope),
    source: sourceFor(testCase[0], record),
  };
  return { input, record };
}

function fakeRepositories(read: (...args: unknown[]) => Promise<unknown>) {
  return {
    evaluation: new Proxy({}, { get: () => read }),
    modelAssurance: { find: read },
  } as PolicyEvaluationEvidenceReaderDependencies;
}

beforeAll(async () => {
  harness = await createModelAssuranceRepositoryTestHarness("pol_read");
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
  repositories = { evaluation: harness.evaluation.repository, modelAssurance: harness.repository };
});

describe("policy evaluation evidence acquisition", () => {
  it("covers every non-model and model/human repository kind exactly once", () => {
    expect(cases).toHaveLength(30);
    expect(new Set(cases.map(([source]) => source)).size).toBe(30);
    expect(new Set(cases.map(([, kind]) => kind))).toEqual(
      new Set(records.map(({ kind }) => kind)),
    );
  });

  describe.each(cases)("%s", (kind, repositoryKind, receiptField) => {
    const testCase = [kind, repositoryKind, receiptField] as Case;

    it("reads an exact retained record and hashes the complete receipt-bearing body", async () => {
      const { input, record } = fixture(testCase);
      const output = await readPolicyEvaluationEvidence(input, repositories);
      expect(output.record).toEqual(record);
      expect(output.source).toEqual(input.source);
      expect(output.observation).toEqual({
        recordSha256: createHash("sha256")
          .update(encodeEvaluationCanonicalJson(record))
          .digest("hex"),
        status: "verified",
      });
      expect(
        PolicyEvaluationManifestEntrySchema.parse({
          observation: output.observation,
          source: output.source,
        }),
      ).toEqual({ observation: output.observation, source: input.source });
    });

    it("keeps real absent and out-of-scope reads hidden without leaking a record", async () => {
      const { input } = fixture(testCase);
      const scope = { ...input.scope, tenantId: "ten_absent" };
      expect(await readPolicyEvaluationEvidence({ ...input, scope }, repositories)).toEqual({
        observation: { status: "missing" },
        record: null,
        source: input.source,
      });
    });

    it("distinguishes changed receipt bytes even when the semantic digest is unchanged", async () => {
      const { input, record } = fixture(testCase);
      const original = await readPolicyEvaluationEvidence(
        input,
        fakeRepositories(async () => record),
      );
      const changed = {
        ...record,
        [receiptField]: new Date(
          Date.parse(String(fields(record)[receiptField])) + 1,
        ).toISOString(),
      };
      const output = await readPolicyEvaluationEvidence(
        input,
        fakeRepositories(async () => changed),
      );
      expect(output.observation.status).toBe("verified");
      expect(output.record?.definitionSha256).toBe(record.definitionSha256);
      expect(output.observation).not.toEqual(original.observation);
    });

    it("distinguishes a corrupt digest from authoritative absence", async () => {
      const { input, record } = fixture(testCase);
      const dependencies = fakeRepositories(async () => ({
        ...record,
        definitionSha256: "f".repeat(64),
      }));
      expect(await readPolicyEvaluationEvidence(input, dependencies)).toEqual({
        observation: { reason: "record_invalid", status: "unavailable" },
        record: null,
        source: input.source,
      });
    });

    it("rejects unknown schemas and extra result fields", async () => {
      const { input, record } = fixture(testCase);
      for (const raw of [
        { ...record, schemaVersion: "future" },
        { ...record, approved: true },
        undefined,
      ]) {
        const output = await readPolicyEvaluationEvidence(
          input,
          fakeRepositories(async () => raw),
        );
        expect(output.observation).toEqual({ reason: "record_invalid", status: "unavailable" });
        expect(output.record).toBeNull();
      }
    });

    it("checks every exact reference field, including logical parent identities", async () => {
      const { input, record } = fixture(testCase);
      const originalReference = fields(input.source.reference);
      for (const key of Object.keys(originalReference)) {
        const source = {
          kind,
          reference: {
            ...originalReference,
            [key]: key === "definitionSha256" ? "f".repeat(64) : "id_substituted",
          },
        } as PolicyEvaluationEvidenceSource;
        const read = vi.fn(async () => record);
        const output = await readPolicyEvaluationEvidence(
          { ...input, source },
          fakeRepositories(read),
        );
        expect(read).toHaveBeenCalledTimes(1);
        expect(output.observation).toEqual({ reason: "reference_mismatch", status: "unavailable" });
        expect(output.record).toBeNull();
      }
    });

    it("rejects repository scope substitution on all three dimensions", async () => {
      const { input, record } = fixture(testCase);
      for (const key of ["tenantId", "projectId", "environmentId"] as const) {
        const output = await readPolicyEvaluationEvidence(
          {
            ...input,
            scope: { ...input.scope, [key]: "id_other" },
          },
          fakeRepositories(async () => record),
        );
        expect(output.observation).toEqual({ reason: "reference_mismatch", status: "unavailable" });
        expect(output.record).toBeNull();
      }
    });

    it("uses the kind's authoritative receipt and retains fractional boundary precision", async () => {
      const { input, record } = fixture(testCase);
      const receipt = String(fields(record)[receiptField]);
      const before = new Date(Date.parse(receipt) - 1)
        .toISOString()
        .replace("Z", `${"9".repeat(27)}Z`);
      const prior = await readPolicyEvaluationEvidence(
        { ...input, evaluationTime: before },
        repositories,
      );
      expect(prior.observation).toEqual({ reason: "not_yet_available", status: "unavailable" });
      expect(prior.record).toBeNull();
      const exact = await readPolicyEvaluationEvidence(
        { ...input, evaluationTime: receipt },
        repositories,
      );
      expect(exact.observation.status).toBe("verified");
    });

    it("returns defensive copies and does not mutate the retained repository body", async () => {
      const { input, record } = fixture(testCase);
      const original = structuredClone(input);
      const output = await readPolicyEvaluationEvidence(
        input,
        fakeRepositories(async () => record),
      );
      if (!output.record) throw new Error("Expected verified fixture");
      output.record.scope.tenantId = "ten_changed";
      output.source.reference.definitionSha256 = "f".repeat(64);
      expect(record.scope).toEqual(original.scope);
      expect(input).toEqual(original);
    });

    it("does not turn an operational repository failure into an evidence observation", async () => {
      const { input } = fixture(testCase);
      const failure = new Error("Synthetic repository outage");
      await expect(
        readPolicyEvaluationEvidence(
          input,
          fakeRepositories(async () => {
            throw failure;
          }),
        ),
      ).rejects.toBe(failure);
    });
  });

  it.each(["scope", "source", "evaluationTime"] as const)(
    "rejects malformed %s before any repository call",
    async (key) => {
      const { input } = fixture(cases[0]);
      const read = vi.fn();
      await expect(
        readPolicyEvaluationEvidence(
          { ...input, [key]: {} } as unknown as ReadPolicyEvaluationEvidenceInput,
          fakeRepositories(read),
        ),
      ).rejects.toBeInstanceOf(PolicyEvaluationEvidenceReadInputError);
      expect(read).not.toHaveBeenCalled();
    },
  );

  it("does not pretend to support a different source family or a supplied verdict", async () => {
    const { input } = fixture(cases[0]);
    const read = vi.fn();
    for (const source of [
      {
        kind: "comparison_result",
        reference: { definitionSha256: "a".repeat(64), resultId: "result_other" },
      },
      { ...input.source, observation: { status: "verified" } },
    ]) {
      await expect(
        readPolicyEvaluationEvidence(
          { ...input, source } as ReadPolicyEvaluationEvidenceInput,
          fakeRepositories(read),
        ),
      ).rejects.toBeInstanceOf(PolicyEvaluationEvidenceReadInputError);
    }
    expect(read).not.toHaveBeenCalled();
  });

  it.each([cases[0], cases[17]])(
    "keeps acquisition context stable while %s repository code mutates caller inputs",
    async (...testCase) => {
      const { input, record } = fixture(testCase as Case);
      const original = structuredClone(input);
      const read = vi.fn(async (scope) => {
        input.scope.tenantId = "ten_mutated";
        input.source.reference.definitionSha256 = "f".repeat(64);
        (input as { evaluationTime: string }).evaluationTime = "2020-01-01T00:00:00.000Z";
        Object.assign(fields(scope), { tenantId: "ten_port_mutated" });
        return record;
      });
      const output = await readPolicyEvaluationEvidence(input, fakeRepositories(read));
      expect(output.source).toEqual(original.source);
      expect(output.observation.status).toBe("verified");
      expect(output.record?.scope).toEqual(original.scope);
    },
  );
});
