import { createHash } from "node:crypto";
import {
  type CriterionSet,
  type EvaluationRecordKind,
  type EvidenceScope,
  encodeEvaluationCanonicalJson,
  PolicyEvaluationSourceReferenceSchema,
} from "@proofstack/contracts";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { digestComparisonRecordDefinition } from "../evaluation/comparison-record-validation.js";
import { digestEvaluationRecordDefinition } from "../evaluation/evaluation-record-validation.js";
import { InvalidEvaluationRecordInputError } from "../evaluation/evaluation-repository-errors.js";
import { digestModelAssuranceRecordDefinition } from "../evaluation/model-assurance-record-validation.js";
import type { ModelAssuranceRecordKind } from "../evaluation/model-assurance-repository.js";
import { comparisonDefinitionFixture } from "../testing/comparison-repository-fixtures.js";
import { MemoryComparisonRepository } from "../testing/memory-comparison-repository.js";
import { createModelAssuranceRepositoryTestHarness } from "../testing/model-assurance-repository-fixtures.js";
import { inspectPolicyEvaluationControlRecord } from "./policy-evaluation-control-record-reader.js";
import {
  inspectPolicyEvaluationEvidenceRecord,
  type PolicyEvaluationEvidenceSource,
} from "./policy-evaluation-evidence-reader.js";
import { enumeratePolicyEvaluationEvidenceReferences } from "./policy-evaluation-evidence-references.js";
import {
  type PolicyEvaluationSelectorParentRead,
  type PolicyEvaluationSelectorParentSource,
  type PolicyEvaluationSelectorReaderDependencies,
  PolicyEvaluationSelectorReadInputError,
  type ReadPolicyEvaluationSelectorInput,
  readPolicyEvaluationSelector,
} from "./policy-evaluation-selector-reader.js";

type Fields = Record<string, unknown>;
const evaluationTime = "2026-10-01T00:00:00.000Z";
const limits = { maxReferenceBytes: 4_000_000, maxReferences: 10_000 };
const ids = {
  comparison_definition: ["comparisonId", "comparisonVersionId"],
  criterion_set: ["criterionSetId", "criterionSetVersionId"],
  evaluation_run: ["evaluationRunId"],
  evaluation_run_result: ["evaluationRunId", "resultId"],
  evaluator_spec: ["evaluatorId", "evaluatorVersionId"],
  oracle_spec: ["oracleId", "oracleVersionId"],
  qualification_fixture_set: ["fixtureSetId", "fixtureSetVersionId"],
  model_assisted_evaluator_spec: ["evaluatorId", "evaluatorVersionId"],
  model_evaluator_profile: ["modelProfileId", "modelProfileVersionId"],
  model_qualification_suite: ["suiteId", "suiteVersionId"],
} as const;
type Kind = keyof typeof ids;
interface Scenario {
  readonly label: string;
  readonly parentKind: PolicyEvaluationSelectorParentSource["kind"];
  readonly parent: Fields;
  readonly path: string;
  readonly childKind:
    | "criterion_set"
    | "evaluation_run"
    | "model_assisted_evaluator_spec"
    | "comparison_definition";
  readonly child: Fields;
  readonly method: "criterion" | "run" | "model" | "comparison";
}
let scenarios: Scenario[];
let dependencies: PolicyEvaluationSelectorReaderDependencies;

function source(kind: Kind, record: Fields) {
  return PolicyEvaluationSourceReferenceSchema.parse({
    kind,
    reference: Object.fromEntries(
      ["definitionSha256", ...ids[kind]].map((key) => [key, record[key]]),
    ),
  });
}

function captured(scenario: Scenario, parent = scenario.parent, time = evaluationTime) {
  const input: ReadPolicyEvaluationSelectorInput = {
    evaluationTime: time,
    limits: structuredClone(limits),
    path: scenario.path,
    scope: structuredClone(parent["scope"]) as EvidenceScope,
    source: source(scenario.parentKind, parent) as PolicyEvaluationSelectorParentSource,
  };
  const evidence =
    input.source.kind === "comparison_definition"
      ? inspectPolicyEvaluationControlRecord(
          { evaluationTime: time, scope: input.scope, source: input.source },
          parent,
        )
      : inspectPolicyEvaluationEvidenceRecord(
          { evaluationTime: time, scope: input.scope, source: input.source },
          parent,
        );
  expect(evidence.observation.status).toBe("verified");
  return { evidence, input };
}

function hash(record: unknown) {
  return createHash("sha256").update(encodeEvaluationCanonicalJson(record)).digest("hex");
}

function rehash(kind: Kind, record: Fields): Fields {
  const copy = structuredClone(record);
  const definition = structuredClone(copy);
  for (const key of [
    "definitionSha256",
    "schemaVersion",
    "scope",
    "createdAt",
    "createdByPrincipalId",
    "publishedAt",
    "publishedByPrincipalId",
    "recordedAt",
  ])
    delete definition[key];
  const scope = copy["scope"] as EvidenceScope;
  copy["definitionSha256"] =
    kind === "comparison_definition"
      ? digestComparisonRecordDefinition(kind, scope, definition)
      : kind.startsWith("model_")
        ? digestModelAssuranceRecordDefinition(
            (kind === "model_assisted_evaluator_spec"
              ? "model_assisted_evaluator"
              : kind) as ModelAssuranceRecordKind,
            scope,
            definition,
          )
        : digestEvaluationRecordDefinition(kind as EvaluationRecordKind, scope, definition);
  return copy;
}

function ports(raw: unknown, fail?: Error) {
  const read = vi.fn(async () => {
    if (fail) throw fail;
    return raw;
  });
  const criterion = vi.fn(read);
  const run = vi.fn(read);
  const model = vi.fn(read);
  const comparison = vi.fn(read);
  return {
    calls: { comparison, criterion, model, run },
    dependencies: {
      comparison: { findComparisonDefinition: comparison },
      evaluation: { findCriterionSet: criterion, findEvaluationRun: run },
      modelAssurance: { find: model },
    } as unknown as PolicyEvaluationSelectorReaderDependencies,
    read,
  };
}

beforeAll(async () => {
  const harness = await createModelAssuranceRepositoryTestHarness("selectors");
  const comparison = new MemoryComparisonRepository();
  const previous = comparisonDefinitionFixture("selectors", harness.evaluation.scope);
  const successor = comparisonDefinitionFixture("selectors", harness.evaluation.scope, {
    predecessor: {
      comparisonVersionId: previous.comparisonVersionId,
      definitionSha256: previous.definitionSha256,
    },
    version: "v2",
  });
  await comparison.publishComparisonDefinition(previous);
  await comparison.publishComparisonDefinition(successor);
  dependencies = {
    comparison,
    evaluation: harness.evaluation.repository,
    modelAssurance: harness.repository,
  };
  const records = [...harness.evaluation.records, ...harness.records].map(({ kind, record }) => ({
    kind: kind === "model_assisted_evaluator" ? "model_assisted_evaluator_spec" : kind,
    record: record as unknown as Fields,
  }));
  const find = (kind: string) => {
    const found = records.find((value) => value.kind === kind);
    if (!found) throw new Error(`Missing fixture ${kind}`);
    return found.record;
  };
  scenarios = (
    [
      "evaluator_spec",
      "oracle_spec",
      "qualification_fixture_set",
      "model_assisted_evaluator_spec",
      "model_evaluator_profile",
      "model_qualification_suite",
    ] as const
  ).map((parentKind) => ({
    child: find("criterion_set"),
    childKind: "criterion_set",
    label: `${parentKind} criterion`,
    method: "criterion",
    parent: find(parentKind),
    parentKind,
    path:
      parentKind === "qualification_fixture_set"
        ? "/cases/0/criterion"
        : parentKind === "model_qualification_suite"
          ? "/criteria/0"
          : "/supportedCriteria/0",
  }));
  scenarios.push({
    child: find("model_assisted_evaluator_spec"),
    childKind: "model_assisted_evaluator_spec",
    label: "profile evaluator",
    method: "model",
    parent: find("model_evaluator_profile"),
    parentKind: "model_evaluator_profile",
    path: "/evaluator",
  });
  scenarios.push({
    child: find("evaluation_run"),
    childKind: "evaluation_run",
    label: "result run",
    method: "run",
    parent: find("evaluation_run_result"),
    parentKind: "evaluation_run_result",
    path: "/evaluationRunId",
  });
  scenarios.push({
    child: previous as unknown as Fields,
    childKind: "comparison_definition",
    label: "comparison predecessor",
    method: "comparison",
    parent: successor as unknown as Fields,
    parentKind: "comparison_definition",
    path: "/predecessor",
  });
  // The model vector declares a different criterion version from the non-model harness. Retain a
  // separate fixture at that identity; do not rewrite the already published evaluator/profile.
  for (let index = 0; index < scenarios.length; index++) {
    const scenario = scenarios[index] as Scenario;
    if (scenario.parentKind !== "model_assisted_evaluator_spec") continue;
    const selector = (scenario.parent["supportedCriteria"] as Fields[])[0] as Fields;
    const child = rehash("criterion_set", {
      ...scenario.child,
      criterionSetId: selector["criterionSetId"],
      criterionSetVersionId: selector["criterionSetVersionId"],
      criteria: (scenario.child["criteria"] as Fields[]).map((criterion) => ({
        ...criterion,
        criterionId: selector["criterionId"],
      })),
    });
    await harness.evaluation.repository.publishCriterionSet(child as unknown as CriterionSet);
    scenarios[index] = { ...scenario, child };
  }
});

describe("parent-bound policy evaluation selector reads", () => {
  it("resolves every selector-bearing parent through actual memory repositories", async () => {
    for (const scenario of scenarios) {
      const { input, evidence } = captured(scenario);
      const result = await readPolicyEvaluationSelector(input, evidence, dependencies);
      expect(result, scenario.label).toMatchObject({
        evidence: {
          observation: { recordSha256: hash(scenario.child), status: "verified" },
          record: scenario.child,
          source: source(scenario.childKind, scenario.child),
        },
        parent: { recordSha256: hash(scenario.parent), source: input.source },
        reference: { path: scenario.path },
        status: "resolved",
      });
    }
  });

  it("performs only one fixed exact-version read and exposes no latest fallback", async () => {
    for (const scenario of scenarios) {
      const { input, evidence } = captured(scenario);
      const port = ports(scenario.child);
      const result = await readPolicyEvaluationSelector(input, evidence, port.dependencies);
      expect(result.status, scenario.label).toBe("resolved");
      expect(port.read).toHaveBeenCalledTimes(1);
      expect(port.calls[scenario.method]).toHaveBeenCalledTimes(1);
      const id = scenario.child[ids[scenario.childKind].at(-1) as string];
      expect(port.calls[scenario.method]).toHaveBeenCalledWith(
        ...(scenario.method === "model"
          ? [input.scope, "model_assisted_evaluator", id]
          : [input.scope, id]),
      );
    }
  });

  it("keeps missing selectors as parent-bound frontiers without fabricated digest-bearing sources", async () => {
    for (const scenario of scenarios) {
      const { input, evidence } = captured(scenario);
      const port = ports(null);
      const result = await readPolicyEvaluationSelector(input, evidence, port.dependencies);
      expect(result).toMatchObject({
        evidence: null,
        parent: { source: input.source },
        reference: { path: scenario.path },
        status: "missing",
      });
      expect(Object.keys(result).sort()).toEqual(["evidence", "parent", "reference", "status"]);
      expect(port.read).toHaveBeenCalledTimes(1);
    }
  });

  it("distinguishes malformed records from missing records across all four read routes", async () => {
    for (const scenario of scenarios.filter(
      (value) => value.method !== "criterion" || value.parentKind === "oracle_spec",
    )) {
      for (const raw of [
        undefined,
        {},
        { ...scenario.child, extra: true },
        { ...scenario.child, definitionSha256: "f".repeat(64) },
      ]) {
        const { input, evidence } = captured(scenario);
        const port = ports(raw);
        expect(
          await readPolicyEvaluationSelector(input, evidence, port.dependencies),
        ).toMatchObject({ evidence: null, reason: "record_invalid", status: "unavailable" });
      }
    }
  });

  it("propagates storage failures, including domain-typed failures thrown by a port", async () => {
    for (const scenario of scenarios) {
      for (const failure of [
        new Error("storage unavailable"),
        new InvalidEvaluationRecordInputError("port failure"),
      ]) {
        const { input, evidence } = captured(scenario);
        const port = ports(null, failure);
        await expect(readPolicyEvaluationSelector(input, evidence, port.dependencies)).rejects.toBe(
          failure,
        );
        expect(port.read).toHaveBeenCalledTimes(1);
      }
    }
  });

  it("rejects every substituted lookup and logical identity even with a recomputed digest", async () => {
    for (const scenario of scenarios) {
      for (const key of ids[scenario.childKind]) {
        const child = rehash(scenario.childKind, {
          ...scenario.child,
          [key]: `other_${scenario.child[key]}`,
        });
        const { input, evidence } = captured(scenario);
        const port = ports(child);
        expect(
          await readPolicyEvaluationSelector(input, evidence, port.dependencies),
          `${scenario.label}/${key}`,
        ).toMatchObject({ evidence: null, reason: "reference_mismatch", status: "unavailable" });
      }
    }
  });

  it("requires criterion membership, not just a matching set ID and version", async () => {
    const scenario = scenarios[0] as Scenario;
    const parent = structuredClone(scenario.parent);
    (parent["supportedCriteria"] as Fields[])[0] = {
      ...(parent["supportedCriteria"] as Fields[])[0],
      criterionId: "criterion_not_in_set",
    };
    const { input, evidence } = captured(scenario, rehash(scenario.parentKind, parent));
    expect(await readPolicyEvaluationSelector(input, evidence, dependencies)).toMatchObject({
      evidence: null,
      reason: "lineage_mismatch",
      status: "unavailable",
    });
  });

  it("requires all three reciprocal model profile fields", async () => {
    const scenario = scenarios.find((value) => value.method === "model") as Scenario;
    for (const key of ["modelProfileId", "modelProfileVersionId", "definitionSha256"]) {
      const profile = scenario.child["modelProfile"] as Fields;
      const child = rehash(scenario.childKind, {
        ...scenario.child,
        modelProfile: {
          ...profile,
          [key]: key === "definitionSha256" ? "f".repeat(64) : `other_${profile[key]}`,
        },
      });
      const { input, evidence } = captured(scenario);
      expect(
        await readPolicyEvaluationSelector(input, evidence, ports(child).dependencies),
      ).toMatchObject({ evidence: null, reason: "lineage_mismatch", status: "unavailable" });
    }
  });

  it("refuses a hash-valid predecessor of another comparison family", async () => {
    const scenario = scenarios.find((value) => value.method === "comparison") as Scenario;
    const child = rehash(scenario.childKind, {
      ...scenario.child,
      comparisonId: "comparison_unrelated",
    });
    const parent = rehash(scenario.parentKind, {
      ...scenario.parent,
      predecessor: {
        comparisonVersionId: child["comparisonVersionId"],
        definitionSha256: child["definitionSha256"],
      },
    });
    const { input, evidence } = captured(scenario, parent);
    expect(
      await readPolicyEvaluationSelector(input, evidence, ports(child).dependencies),
    ).toMatchObject({ evidence: null, reason: "lineage_mismatch", status: "unavailable" });
  });

  it("enforces the declared predecessor digest rather than replacing it with the lookup digest", async () => {
    const scenario = scenarios.find((value) => value.method === "comparison") as Scenario;
    const child = rehash(scenario.childKind, {
      ...scenario.child,
      description: "Changed definition",
    });
    const { input, evidence } = captured(scenario);
    expect(
      await readPolicyEvaluationSelector(input, evidence, ports(child).dependencies),
    ).toMatchObject({ reason: "reference_mismatch", status: "unavailable" });
  });

  it("checks tenant, project, and environment on returned bodies with valid scoped digests", async () => {
    for (const scenario of scenarios) {
      for (const key of ["tenantId", "projectId", "environmentId"]) {
        const child = rehash(scenario.childKind, {
          ...scenario.child,
          scope: { ...(scenario.child["scope"] as Fields), [key]: `other_${key.toLowerCase()}` },
        });
        const { input, evidence } = captured(scenario);
        expect(
          await readPolicyEvaluationSelector(input, evidence, ports(child).dependencies),
        ).toMatchObject({ evidence: null, reason: "reference_mismatch", status: "unavailable" });
      }
    }
  });

  it("keeps original receipt fields and full precision at the evaluation cut", async () => {
    for (const scenario of scenarios) {
      const receipt = ["publishedAt", "createdAt"].find((key) => key in scenario.child) as string;
      const child = { ...scenario.child, [receipt]: evaluationTime };
      const exact = captured(scenario);
      expect(
        await readPolicyEvaluationSelector(exact.input, exact.evidence, ports(child).dependencies),
      ).toMatchObject({
        evidence: { observation: { recordSha256: hash(child) } },
        status: "resolved",
      });
      const before = captured(scenario, scenario.parent, "2026-09-30T23:59:59.999999999Z");
      expect(
        await readPolicyEvaluationSelector(
          before.input,
          before.evidence,
          ports(child).dependencies,
        ),
      ).toMatchObject({ evidence: null, reason: "not_yet_available", status: "unavailable" });
    }
  });

  it("rejects malformed context, unsupported parents, paths, and injected selectors before I/O", async () => {
    const scenario = scenarios[0] as Scenario;
    const { input, evidence } = captured(scenario);
    const inputs = [
      null,
      { ...input, extra: true },
      { ...input, selector: { criterionId: "chosen" } },
      { ...input, source: source("criterion_set", scenario.child) },
      { ...input, evaluationTime: "invalid" },
      { ...input, scope: { ...input.scope, extra: true } },
      { ...input, path: null },
      { ...input, path: "supportedCriteria/0" },
      { ...input, path: `/${"x".repeat(1024)}` },
      { ...input, path: "/supportedCriteria/99" },
      { ...input, path: "/implementation" },
      { ...input, path: "/supportedCriteria/00" },
    ];
    const port = ports(scenario.child);
    for (const invalid of inputs)
      await expect(
        readPolicyEvaluationSelector(
          invalid as ReadPolicyEvaluationSelectorInput,
          evidence,
          port.dependencies,
        ),
      ).rejects.toBeInstanceOf(PolicyEvaluationSelectorReadInputError);
    expect(port.read).not.toHaveBeenCalled();
  });

  it("revalidates parent body, receipt, observation, and source before any lookup", async () => {
    for (const scenario of scenarios) {
      const { input, evidence } = captured(scenario);
      const changed = structuredClone(scenario.parent);
      const receipt = ["publishedAt", "recordedAt", "createdAt"].find(
        (key) => key in changed,
      ) as string;
      changed[receipt] = "2026-09-20T00:00:00.000Z";
      const variants = [
        { ...evidence, record: changed },
        { ...evidence, record: null },
        { ...evidence, extra: true },
        { ...evidence, record: { ...scenario.parent, extra: true } },
        { ...evidence, observation: { status: "missing" } },
        { ...evidence, observation: { recordSha256: "f".repeat(64), status: "verified" } },
        {
          ...evidence,
          source: {
            ...input.source,
            reference: { ...input.source.reference, definitionSha256: "f".repeat(64) },
          },
        },
      ];
      const port = ports(scenario.child);
      for (const invalid of variants)
        await expect(
          readPolicyEvaluationSelector(
            input,
            invalid as PolicyEvaluationSelectorParentRead,
            port.dependencies,
          ),
        ).rejects.toMatchObject({ code: "policy_evaluation_evidence_references_invalid" });
      expect(port.read).not.toHaveBeenCalled();
    }
  });

  it("requires the whole parent frontier to fit and never truncates to the selected occurrence", async () => {
    const scenario = scenarios[0] as Scenario;
    const { input, evidence } = captured(scenario);
    const frontier = enumeratePolicyEvaluationEvidenceReferences(
      { ...input, source: input.source as PolicyEvaluationEvidenceSource },
      evidence as never,
      limits,
    );
    const bytes = frontier.references.reduce(
      (sum, value) => sum + encodeEvaluationCanonicalJson(value).byteLength,
      0,
    );
    const port = ports(scenario.child);
    const exact = { maxReferenceBytes: bytes, maxReferences: frontier.references.length };
    expect(
      (await readPolicyEvaluationSelector({ ...input, limits: exact }, evidence, port.dependencies))
        .status,
    ).toBe("resolved");
    port.read.mockClear();
    for (const bounded of [
      { ...exact, maxReferences: exact.maxReferences - 1 },
      { ...exact, maxReferenceBytes: exact.maxReferenceBytes - 1 },
      { ...exact, maxReferences: -1 },
      { ...exact, maxReferenceBytes: Number.NaN },
      { ...exact, extra: true },
    ])
      await expect(
        readPolicyEvaluationSelector({ ...input, limits: bounded }, evidence, port.dependencies),
      ).rejects.toMatchObject({ code: "policy_evaluation_evidence_references_invalid" });
    expect(port.read).not.toHaveBeenCalled();
  });

  it("captures context before parent getters and reads the captured parent body only once", async () => {
    const scenario = scenarios[0] as Scenario;
    const { input, evidence } = captured(scenario);
    const original = structuredClone(input);
    let reads = 0;
    const accessor = {
      ...evidence,
      get record() {
        reads++;
        (input as { path: string }).path = "/wrong";
        (input.scope as { tenantId: string }).tenantId = "ten_mutated";
        return scenario.parent;
      },
    };
    const result = await readPolicyEvaluationSelector(
      input,
      accessor as PolicyEvaluationSelectorParentRead,
      dependencies,
    );
    expect(result).toMatchObject({
      parent: { source: original.source },
      reference: { path: original.path },
      status: "resolved",
    });
    expect(reads).toBe(1);
  });

  it("retains repeated criterion occurrences and exact numeric paths beyond index nine", async () => {
    const scenario = scenarios.find(
      (value) => value.parentKind === "qualification_fixture_set",
    ) as Scenario;
    const cases = structuredClone(scenario.parent["cases"]) as Fields[];
    while (cases.length < 12)
      cases.push({
        ...cases[0],
        caseId: `z_repeat_${String(cases.length).padStart(2, "0")}`,
        fixture: {
          ...(cases[0]?.["fixture"] as Fields),
          fixtureId: `fixture_repeat_${cases.length}`,
          fixtureVersionId: `fixture_version_repeat_${cases.length}`,
        },
      });
    const parent = rehash(scenario.parentKind, { ...scenario.parent, cases });
    const results = [];
    for (const index of [0, 9, 10, 11]) {
      const { input, evidence } = captured(
        { ...scenario, path: `/cases/${index}/criterion` },
        parent,
      );
      results.push(await readPolicyEvaluationSelector(input, evidence, dependencies));
    }
    expect(results.map((result) => result.reference.path)).toEqual([
      "/cases/0/criterion",
      "/cases/9/criterion",
      "/cases/10/criterion",
      "/cases/11/criterion",
    ]);
    for (const result of results)
      expect(result).toMatchObject({
        evidence: { source: source("criterion_set", scenario.child) },
        parent: { recordSha256: hash(parent) },
        status: "resolved",
      });
  });

  it("rejects future parents and substituted parent scopes before child acquisition", async () => {
    for (const scenario of scenarios) {
      const { input, evidence } = captured(scenario);
      const port = ports(scenario.child);
      for (const changed of [
        { ...input, evaluationTime: "2026-01-01T00:00:00.000Z" },
        { ...input, scope: { ...input.scope, environmentId: "env_other" } },
        { ...input, scope: { ...input.scope, projectId: "prj_other" } },
        { ...input, scope: { ...input.scope, tenantId: "ten_other" } },
      ])
        await expect(
          readPolicyEvaluationSelector(changed, evidence, port.dependencies),
        ).rejects.toMatchObject({ code: "policy_evaluation_evidence_references_invalid" });
      expect(port.read).not.toHaveBeenCalled();
    }
  });

  it("owns context across awaits, isolates port scope mutation, and returns detached records", async () => {
    const scenario = scenarios[0] as Scenario;
    const { input, evidence } = captured(scenario);
    let release!: (value: unknown) => void;
    const pending = new Promise<unknown>((resolve) => {
      release = resolve;
    });
    const child = structuredClone(scenario.child);
    const port = ports(null);
    const deps = {
      ...port.dependencies,
      evaluation: {
        ...port.dependencies.evaluation,
        async findCriterionSet(scope: EvidenceScope) {
          (scope as { tenantId: string }).tenantId = "ten_port_mutation";
          return (await pending) as never;
        },
      },
    };
    const resolution = readPolicyEvaluationSelector(input, evidence, deps);
    (input.scope as { tenantId: string }).tenantId = "ten_caller_mutation";
    (input as { path: string }).path = "/mutated";
    (input.source.reference as { definitionSha256: string }).definitionSha256 = "f".repeat(64);
    release(child);
    const result = await resolution;
    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") throw new Error("Expected resolution");
    child["publishedAt"] = "2026-11-01T00:00:00.000Z";
    expect(result.evidence.record).toEqual(scenario.child);
    (result.evidence.record.scope as { tenantId: string }).tenantId = "ten_output_mutation";
    expect(child["scope"]).toEqual(scenario.child["scope"]);
  });
});
