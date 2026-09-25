import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  type PolicyEvaluationRequest,
  type PolicyEvaluationRequestDefinition,
  type ReleaseCandidate,
  type ReleaseCandidateDefinition,
  type ReleasePolicy,
  type ReleasePolicyDefinition,
  PolicyEvaluationSourceReferenceSchema,
  policyEvaluationSourceReferenceKey,
  encodeEvaluationCanonicalJson,
} from "@proofstack/contracts";
import {
  digestPolicyEvaluationRequestDefinition,
  digestReleaseCandidateDefinition,
  digestReleasePolicyDefinition,
  digestEvaluationRecordDefinition,
  evaluationRecordDescriptors,
  CreateModelAssuranceAssessment,
} from "@proofstack/core";
import {
  createEvaluationRepositoryTestHarness,
  publishEvaluationFixture,
  MemoryReleaseCandidateRepository,
  MemoryReleasePolicyRepository,
  releaseCandidateFixture,
  releasePolicyRepositoryFixture,
  comparisonDefinitionFixture,
  MemoryComparisonRepository,
  createModelAssuranceRepositoryTestHarness,
  FixedClock,
} from "@proofstack/core/testing";
import { describe, expect, it, vi } from "vitest";
import { capturePolicyRecordGraph } from "./capture-record-graph.js";
import { type PolicyRecordGraphRepositories, readAndExpandPolicyRecord } from "./record-routing.js";

type Fields = Record<string, unknown>;
const requestVector = JSON.parse(
  readFileSync(
    new URL(
      "../../contracts/vectors/policy-evaluation-request-definition-v1.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as { vectors: { input: { definition: PolicyEvaluationRequestDefinition } }[] };
const defaults = requestVector.vectors[0]?.input.definition;
if (!defaults) throw new Error("Missing request vector");
const time = "2026-10-01T00:00:00.000Z";

function request(
  candidate: ReleaseCandidate,
  policy: ReleasePolicy,
  limits = defaults?.limits,
): PolicyEvaluationRequest {
  const definition: PolicyEvaluationRequestDefinition = {
    ...(defaults as PolicyEvaluationRequestDefinition),
    evaluationTime: time,
    limits: limits as PolicyEvaluationRequestDefinition["limits"],
    candidate: {
      candidateId: candidate.candidateId,
      candidateVersionId: candidate.candidateVersionId,
      definitionSha256: candidate.definitionSha256,
    },
    policy: {
      policyId: policy.policyId,
      policyVersionId: policy.policyVersionId,
      definitionSha256: policy.definitionSha256,
    },
  };
  return {
    ...definition,
    createdAt: time,
    createdByPrincipalId: "principal_graph",
    definitionSha256: digestPolicyEvaluationRequestDefinition(candidate.scope, definition),
    schemaVersion: "0.1",
    scope: structuredClone(candidate.scope),
  };
}

function candidateDigest(candidate: ReleaseCandidate): ReleaseCandidate {
  const {
    createdAt: _at,
    createdByPrincipalId: _by,
    schemaVersion: _version,
    definitionSha256: _hash,
    scope,
    ...definition
  } = candidate;
  return {
    ...candidate,
    definitionSha256: digestReleaseCandidateDefinition(
      scope,
      definition as ReleaseCandidateDefinition,
    ),
  };
}

function policyDigest(policy: ReleasePolicy): ReleasePolicy {
  const {
    publishedAt: _at,
    publishedByPrincipalId: _by,
    schemaVersion: _version,
    definitionSha256: _hash,
    scope,
    ...definition
  } = policy;
  return {
    ...policy,
    definitionSha256: digestReleasePolicyDefinition(scope, definition as ReleasePolicyDefinition),
  };
}

function missingRepositories() {
  const calls: { domain: string; method: string; args: unknown[] }[] = [];
  const port = (domain: string) =>
    new Proxy(
      {},
      {
        get:
          (_target, method) =>
          async (...args: unknown[]) => {
            calls.push({ domain, method: String(method), args: structuredClone(args) });
            return null;
          },
      },
    );
  const repositories = {
    control: {
      comparison: port("comparison"),
      releaseCandidate: port("candidate"),
      releasePolicy: port("policy"),
      installationBinding: port("binding"),
    },
    evidence: { evaluation: port("evaluation"), modelAssurance: port("model") },
    datasets: port("dataset"),
    replayDefinitions: port("replay"),
    replayResults: port("job"),
    runtimeDefinitions: port("runtime"),
  } as PolicyRecordGraphRepositories;
  return { repositories, calls };
}

async function harness() {
  const evaluation = createEvaluationRepositoryTestHarness("graph");
  const rewrittenHashes = new Map<string, string>();
  const bind = (value: unknown): void => {
    if (value === null || typeof value !== "object") return;
    const object = value as Fields;
    // Independent vectors reuse artifact names for different bytes. Give different descriptors
    // distinct fixture identities, while keeping genuinely identical occurrences shared.
    if (typeof object["artifactId"] === "string" && typeof object["sha256"] === "string") {
      const suffix = createHash("sha256")
        .update(encodeEvaluationCanonicalJson(object))
        .digest("hex")
        .slice(0, 16);
      object["artifactId"] = `graph_${object["artifactId"]}_${suffix}`;
    }
    if (object["datasetVersionId"] === "dtv_regression_v1")
      object["definitionSha256"] = "7".repeat(64);
    if (object["fixtureVersionId"] === "fxv_boundary") object["definitionSha256"] = "2".repeat(64);
    const hash = object["definitionSha256"];
    if (typeof hash === "string" && rewrittenHashes.has(hash))
      object["definitionSha256"] = rewrittenHashes.get(hash);
    for (const child of Object.values(object)) bind(child);
  };
  for (const fixture of evaluation.records) {
    const oldHash = fixture.record.definitionSha256;
    bind(fixture.record);
    const body = structuredClone(fixture.record) as unknown as Fields;
    for (const key of evaluationRecordDescriptors[fixture.kind].receiptKeys) delete body[key];
    fixture.record.definitionSha256 = digestEvaluationRecordDefinition(
      fixture.kind,
      evaluation.scope,
      body,
    );
    rewrittenHashes.set(oldHash, fixture.record.definitionSha256);
    await publishEvaluationFixture(evaluation.repository, fixture);
  }
  const assessment = evaluation.records.find((fixture) => fixture.kind === "assessment");
  const run = evaluation.records.find((fixture) => fixture.kind === "evaluation_run");
  if (assessment?.kind !== "assessment" || run?.kind !== "evaluation_run")
    throw new Error("Missing evaluation graph roots");
  const candidate = candidateDigest({
    ...releaseCandidateFixture("graph", evaluation.scope),
    assessments: [
      {
        assessmentId: assessment.record.assessmentId,
        definitionSha256: assessment.record.definitionSha256,
      },
    ],
    datasets: [run.record.dataset],
    targetRelease: run.record.replay.targetRelease,
    modelAssuranceAssessments: [],
  });
  // The standalone candidate/policy vectors contain placeholder hashes. Bind shared references to
  // the actual evaluation records before publishing this joined fixture; never rewrite the store.
  const policyDraft = releasePolicyRepositoryFixture("graph", evaluation.scope);
  for (const rule of policyDraft.rules) {
    if ("assessment" in rule.predicate && "assessmentId" in rule.predicate.assessment) {
      rule.predicate.assessment.definitionSha256 = assessment.record.definitionSha256;
      rule.predicate.assessment.assessmentId = assessment.record.assessmentId;
    }
  }
  const policy = policyDigest(policyDraft);
  const candidateRepository = new MemoryReleaseCandidateRepository();
  const policyRepository = new MemoryReleasePolicyRepository();
  await candidateRepository.publishReleaseCandidate(candidate);
  await policyRepository.publishReleasePolicy(policy);
  const missing = missingRepositories();
  const { calls } = missing;
  const repositories: PolicyRecordGraphRepositories = {
    ...missing.repositories,
    control: {
      ...missing.repositories.control,
      releaseCandidate: candidateRepository,
      releasePolicy: policyRepository,
    },
    evidence: { ...missing.repositories.evidence, evaluation: evaluation.repository },
  };
  return { candidate, policy, repositories, calls, evaluation, input: request(candidate, policy) };
}

describe("request-rooted recursive record graph", () => {
  it("traverses real immutable evaluation records, terminates backreferences, and retains open frontiers", async () => {
    const setup = await harness();
    const graph = await capturePolicyRecordGraph(setup.input, setup.repositories);
    expect(graph.nodes.length).toBeGreaterThan(20);
    expect(graph.edges.length).toBeGreaterThan(graph.nodes.length);
    expect(graph.roots).toEqual([
      { kind: "release_candidate", reference: setup.input.candidate },
      { kind: "release_policy", reference: setup.input.policy },
    ]);
    expect(graph.nodes.filter(({ read }) => read.source.kind === "criterion_set")).toHaveLength(1);
    expect(
      graph.edges.filter(({ reference }) => reference.kind === "criterion_selector").length,
    ).toBeGreaterThan(5);
    expect(
      graph.edges.filter(
        ({ reference, target }) =>
          reference.kind === "criterion_selector" && target?.kind === "criterion_set",
      ).length,
    ).toBeGreaterThan(5);
    expect(graph.unresolved.records).toBeGreaterThan(0);
    expect(graph.unresolved.references).toBeGreaterThan(0);
    expect(
      graph.nodes
        .filter(({ read }) => read.observation.status !== "verified")
        .every(({ references }) => references === null),
    ).toBe(true);
    expect(
      graph.edges.some(({ reference, target }) => reference.kind === "artifact" && target === null),
    ).toBe(true);
    const keys = graph.entries.map(({ source }) => policyEvaluationSourceReferenceKey(source));
    expect(keys).toEqual([...new Set(keys)].sort());
    expect(graph.edges[0]?.parent.kind).toBe("release_candidate");
    expect(graph.usage.references).toBe(graph.edges.length);
    expect(graph.usage.referenceBytes).toBe(
      graph.edges.reduce(
        (sum, edge) => sum + encodeEvaluationCanonicalJson(edge.reference).byteLength,
        0,
      ),
    );
    expect(graph).not.toHaveProperty("sealed");
    expect(graph).not.toHaveProperty("verdict");
  });

  it("produces identical graphs on repeated reads without changing caller or repository state", async () => {
    const setup = await harness();
    const original = structuredClone(setup.input);
    const first = await capturePolicyRecordGraph(setup.input, setup.repositories);
    const second = await capturePolicyRecordGraph(setup.input, setup.repositories);
    expect(first).toEqual(second);
    expect(setup.input).toEqual(original);
    (first.roots[0]?.reference as { definitionSha256: string }).definitionSha256 = "f".repeat(64);
    const stored = await setup.repositories.control.releaseCandidate.findReleaseCandidate(
      setup.input.scope,
      setup.candidate.candidateVersionId,
    );
    expect(stored).toEqual(setup.candidate);
    expect(setup.input).toEqual(original);
  });

  it("retains both missing roots without inventing child records or accepting an empty graph", async () => {
    const setup = await harness();
    const missing = missingRepositories();
    const graph = await capturePolicyRecordGraph(setup.input, missing.repositories);
    expect(graph.entries).toHaveLength(2);
    expect(graph.entries.every(({ observation }) => observation.status === "missing")).toBe(true);
    expect(graph.unresolved).toEqual({ records: 2, references: 0 });
    expect(graph.usage).toMatchObject({ reads: 2, records: 2, bytes: 8, references: 0 });
    expect(missing.calls.map(({ domain }) => domain)).toEqual(["candidate", "policy"]);
  });

  it("rejects forged request digests and caller-added roots before storage access", async () => {
    const setup = await harness();
    const missing = missingRepositories();
    for (const input of [
      { ...setup.input, definitionSha256: "f".repeat(64) },
      { ...setup.input, roots: [] },
    ])
      await expect(capturePolicyRecordGraph(input, missing.repositories)).rejects.toMatchObject({
        code: "policy_evaluation_request_record_invalid",
      });
    expect(missing.calls).toHaveLength(0);
  });

  it("preserves unavailable roots and does not turn them into verified leaves", async () => {
    const setup = await harness();
    setup.repositories = {
      ...setup.repositories,
      control: {
        ...setup.repositories.control,
        releaseCandidate: {
          findReleaseCandidate: async () =>
            ({ ...setup.candidate, extra: true }) as ReleaseCandidate,
        },
      },
    };
    const graph = await capturePolicyRecordGraph(setup.input, setup.repositories);
    const node = graph.nodes.find(({ read }) => read.source.kind === "release_candidate");
    expect(node).toMatchObject({
      read: { record: null, observation: { status: "unavailable", reason: "record_invalid" } },
      references: null,
    });
  });

  it("returns no partial graph when cumulative records, bytes, or references exceed limits", async () => {
    const setup = await harness();
    for (const [dimension, limit] of [
      ["maxAcquisitionRecords", 2],
      ["maxAcquisitionRecordBytes", 1],
    ] as const) {
      const input = request(setup.candidate, setup.policy, {
        ...setup.input.limits,
        [dimension]: limit,
      });
      await expect(capturePolicyRecordGraph(input, setup.repositories)).rejects.toMatchObject({
        code:
          dimension === "maxAcquisitionRecords"
            ? "policy_evaluation_evidence_references_invalid"
            : "policy_record_graph_failed",
      });
    }
    const missing = missingRepositories();
    const exact = request(setup.candidate, setup.policy, {
      ...setup.input.limits,
      maxAcquisitionRecords: 2,
      maxAcquisitionRecordBytes: 8,
    });
    expect((await capturePolicyRecordGraph(exact, missing.repositories)).usage.bytes).toBe(8);
    await expect(
      capturePolicyRecordGraph(
        request(setup.candidate, setup.policy, { ...exact.limits, maxAcquisitionRecordBytes: 7 }),
        missing.repositories,
      ),
    ).rejects.toMatchObject({ reason: "byte_limit" });
  });

  it("propagates repository failures instead of fabricating missing graph nodes", async () => {
    const setup = await harness();
    const failure = new Error("database offline");
    setup.repositories = {
      ...setup.repositories,
      control: {
        ...setup.repositories.control,
        releasePolicy: {
          findReleasePolicy: async () => {
            throw failure;
          },
        },
      },
    };
    await expect(capturePolicyRecordGraph(setup.input, setup.repositories)).rejects.toBe(failure);
  });

  it("keeps failed selector occurrences as explicit unresolved edges", async () => {
    const setup = await harness();
    const original = setup.repositories.evidence.evaluation;
    setup.repositories = {
      ...setup.repositories,
      evidence: {
        ...setup.repositories.evidence,
        evaluation: new Proxy(original, {
          get(target, key) {
            if (key === "findCriterionSet") return async () => null;
            const value: unknown = Reflect.get(target, key);
            return typeof value === "function" ? value.bind(target) : value;
          },
        }),
      },
    };
    const graph = await capturePolicyRecordGraph(setup.input, setup.repositories);
    expect(
      graph.edges
        .filter(({ reference }) => reference.kind === "criterion_selector")
        .every(
          ({ target, selectorFailure }) => target === null && selectorFailure?.status === "missing",
        ),
    ).toBe(true);
    expect(graph.edges.some(({ selectorFailure }) => selectorFailure?.status === "missing")).toBe(
      true,
    );
  });

  it("rejects conflicting exact references from different parents", async () => {
    const setup = await harness();
    const draft = structuredClone(setup.policy);
    for (const rule of draft.rules)
      if ("assessment" in rule.predicate && "assessmentId" in rule.predicate.assessment)
        rule.predicate.assessment.definitionSha256 = "f".repeat(64);
    const policy = policyDigest(draft);
    await expect(
      capturePolicyRecordGraph(request(setup.candidate, policy), {
        ...setup.repositories,
        control: {
          ...setup.repositories.control,
          releasePolicy: { findReleasePolicy: async () => policy },
        },
      }),
    ).rejects.toMatchObject({
      reason: "reference_conflict",
      identity: `assessment:${setup.candidate.assessments[0]?.assessmentId}`,
    });
  });

  it("rejects conflicting artifact descriptors even when each parent is internally consistent", async () => {
    const setup = await harness();
    const previous = structuredClone(setup.candidate);
    previous.candidateVersionId = "candidate_graph_prior";
    const build = previous.buildArtifacts[0];
    if (!build) throw new Error("Missing build artifact");
    build.artifact.sizeBytes++;
    const retained = candidateDigest(previous);
    const candidate = candidateDigest({
      ...setup.candidate,
      predecessor: {
        candidateId: retained.candidateId,
        candidateVersionId: retained.candidateVersionId,
        definitionSha256: retained.definitionSha256,
      },
    });
    await expect(
      capturePolicyRecordGraph(request(candidate, setup.policy), {
        ...setup.repositories,
        control: {
          ...setup.repositories.control,
          releaseCandidate: {
            findReleaseCandidate: async (_scope, id) =>
              id === candidate.candidateVersionId ? candidate : retained,
          },
        },
      }),
    ).rejects.toMatchObject({
      reason: "reference_conflict",
      identity: `artifact:${build.artifact.artifactId}`,
    });
  });

  it("rejects changed full-record receipts across repeated exact selector reads", async () => {
    const setup = await harness();
    const original = setup.repositories.evidence.evaluation;
    let reads = 0;
    const repositories = {
      ...setup.repositories,
      evidence: {
        ...setup.repositories.evidence,
        evaluation: new Proxy(original, {
          get(target, key) {
            if (key === "findCriterionSet")
              return async (...args: Parameters<typeof original.findCriterionSet>) => {
                const value = await original.findCriterionSet(...args);
                reads++;
                return value && reads > 1
                  ? { ...value, publishedAt: "2026-09-03T00:00:00.000Z" }
                  : value;
              };
            const value: unknown = Reflect.get(target, key);
            return typeof value === "function" ? value.bind(target) : value;
          },
        }),
      },
    };
    await expect(capturePolicyRecordGraph(setup.input, repositories)).rejects.toMatchObject({
      reason: "observation_conflict",
    });
    expect(reads).toBeGreaterThan(1);
  });

  it("keeps unavailable selectors distinct from missing and does not manufacture their hashes", async () => {
    const setup = await harness();
    const original = setup.repositories.evidence.evaluation;
    const repositories = {
      ...setup.repositories,
      evidence: {
        ...setup.repositories.evidence,
        evaluation: new Proxy(original, {
          get(target, key) {
            if (key === "findCriterionSet")
              return async (...args: Parameters<typeof original.findCriterionSet>) => {
                const value = await original.findCriterionSet(...args);
                return value && { ...value, publishedAt: "2027-01-01T00:00:00.000Z" };
              };
            const value: unknown = Reflect.get(target, key);
            return typeof value === "function" ? value.bind(target) : value;
          },
        }),
      },
    };
    const graph = await capturePolicyRecordGraph(setup.input, repositories);
    const edges = graph.edges.filter(({ reference }) => reference.kind === "criterion_selector");
    expect(edges.length).toBeGreaterThan(0);
    for (const edge of edges)
      expect(edge).toMatchObject({
        target: null,
        selectorFailure: { status: "unavailable", reason: "not_yet_available" },
      });
  });

  it("admits exact aggregate budgets and rejects one byte or occurrence less", async () => {
    const setup = await harness();
    const graph = await capturePolicyRecordGraph(setup.input, setup.repositories);
    const limits = {
      ...setup.input.limits,
      maxAcquisitionRecords: graph.usage.references,
      maxAcquisitionRecordBytes: graph.usage.bytes + graph.usage.referenceBytes,
    };
    expect(graph.usage.references).toBeGreaterThan(graph.usage.records);
    const exact = await capturePolicyRecordGraph(
      request(setup.candidate, setup.policy, limits),
      setup.repositories,
    );
    expect(exact.usage).toEqual(graph.usage);
    for (const [key, reason] of [
      ["maxAcquisitionRecords", "reference_limit"],
      ["maxAcquisitionRecordBytes", "byte_limit"],
    ] as const)
      await expect(
        capturePolicyRecordGraph(
          request(setup.candidate, setup.policy, { ...limits, [key]: limits[key] - 1 }),
          setup.repositories,
        ),
      ).rejects.toMatchObject({ code: "policy_record_graph_failed", reason });
  });

  it("retains a comparison predecessor edge and expands the prefetched definition without rereading it", async () => {
    const setup = await harness();
    const repository = new MemoryComparisonRepository();
    const prior = comparisonDefinitionFixture("graph", setup.input.scope);
    const successor = comparisonDefinitionFixture("graph", setup.input.scope, {
      predecessor: {
        comparisonVersionId: prior.comparisonVersionId,
        definitionSha256: prior.definitionSha256,
      },
      version: "v2",
    });
    await repository.publishComparisonDefinition(prior);
    await repository.publishComparisonDefinition(successor);
    const rule = structuredClone(
      setup.policy.rules.find(({ predicate }) => predicate.kind === "comparison_threshold"),
    );
    if (rule?.predicate.kind !== "comparison_threshold") throw new Error("Missing comparison rule");
    rule.predicate.comparison = {
      comparisonId: successor.comparisonId,
      comparisonVersionId: successor.comparisonVersionId,
      definitionSha256: successor.definitionSha256,
    };
    const policy = policyDigest({
      ...setup.policy,
      rules: [
        rule,
        ...setup.policy.rules.filter(({ predicate }) => predicate.kind === "approval_required"),
      ].sort((a, b) => (a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0)),
    });
    const read = vi.spyOn(repository, "findComparisonDefinition");
    const missing = missingRepositories();
    const graph = await capturePolicyRecordGraph(request(setup.candidate, policy), {
      ...missing.repositories,
      control: {
        ...missing.repositories.control,
        comparison: repository,
        releasePolicy: { findReleasePolicy: async () => policy },
      },
    });
    expect(read).toHaveBeenCalledTimes(2);
    expect(
      graph.nodes.filter(({ read }) => read.source.kind === "comparison_definition"),
    ).toHaveLength(2);
    expect(graph.edges.find(({ reference }) => reference.path === "/predecessor")).toMatchObject({
      target: {
        kind: "comparison_definition",
        reference: { comparisonVersionId: prior.comparisonVersionId },
      },
    });
  });

  it("waits for an already-started fixture sibling read before exposing a storage failure", async () => {
    const setup = await harness();
    const failure = new Error("fixture store offline");
    let release!: (value: null) => void;
    let started!: () => void;
    const pending = new Promise<null>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    let finished = false;
    const capture = capturePolicyRecordGraph(setup.input, {
      ...setup.repositories,
      datasets: {
        findDatasetVersion: async () => null,
        findFixtureVersion: async () => {
          throw failure;
        },
        findRecordedInteractionFixtureVersion: async () => {
          started();
          return pending;
        },
      },
    }).catch((error: unknown) => {
      finished = true;
      return error;
    });
    await entered;
    await Promise.resolve();
    expect(finished).toBe(false);
    release(null);
    expect(await capture).toBe(failure);
    expect(finished).toBe(true);
  });

  it("retains the normal model-profile/evaluator cycle while expanding each exact node only once", async () => {
    const setup = await harness();
    const model = await createModelAssuranceRepositoryTestHarness("graph");
    const assessment = await new CreateModelAssuranceAssessment({
      clock: new FixedClock(new Date("2026-09-02T06:00:00.000Z")),
      evaluationRepository: model.evaluation.repository,
      modelAssuranceRepository: model.repository,
    }).execute(model.command);
    const candidate = candidateDigest({
      ...setup.candidate,
      assessments: [assessment.record.baseAssessment],
      modelAssuranceAssessments: [
        {
          assessmentExtensionId: assessment.record.assessmentExtensionId,
          definitionSha256: assessment.record.definitionSha256,
        },
      ],
    });
    const missing = missingRepositories();
    const allowed = new Set([
      "model_assurance_assessment",
      "model_qualification_report",
      "model_evaluator_profile",
      "model_assisted_evaluator",
    ]);
    const graph = await capturePolicyRecordGraph(request(candidate, setup.policy), {
      ...missing.repositories,
      control: {
        ...missing.repositories.control,
        releaseCandidate: { findReleaseCandidate: async () => candidate },
      },
      evidence: {
        ...missing.repositories.evidence,
        modelAssurance: {
          find: async (scope, kind, id) =>
            allowed.has(kind) ? model.repository.find(scope, kind, id) : null,
        },
      },
    });
    for (const kind of ["model_evaluator_profile", "model_assisted_evaluator_spec"])
      expect(graph.nodes.filter(({ read }) => read.source.kind === kind)).toHaveLength(1);
    expect(
      graph.edges.find(({ reference }) => reference.kind === "model_evaluator_selector"),
    ).toMatchObject({ target: { kind: "model_assisted_evaluator_spec" } });
    expect(
      graph.edges.some(
        ({ parent, target }) =>
          parent.kind === "model_assisted_evaluator_spec" &&
          target?.kind === "model_evaluator_profile",
      ),
    ).toBe(true);
    expect(graph.usage.reads).toBeLessThan(50);
  });

  it("owns the validated request before a repository can mutate the caller's context", async () => {
    const setup = await harness();
    const original = structuredClone(setup.input);
    const missing = missingRepositories();
    const graph = await capturePolicyRecordGraph(setup.input, {
      ...missing.repositories,
      control: {
        ...missing.repositories.control,
        releaseCandidate: {
          findReleaseCandidate: async () => {
            setup.input.scope.tenantId = "tenant_mutated";
            setup.input.policy.definitionSha256 = "f".repeat(64);
            setup.input.limits.maxAcquisitionRecordBytes = 1;
            return null;
          },
        },
      },
    });
    expect(graph.scope).toEqual(original.scope);
    expect(graph.roots[1]).toEqual({ kind: "release_policy", reference: original.policy });
    expect(graph.usage.bytes).toBe(8);
    expect(missing.calls[0]?.args[0]).toEqual(original.scope);
  });
});

describe("fixed cross-domain routing", () => {
  it("routes every declared source kind without a plugin validator or latest lookup", async () => {
    const setup = await harness();
    const run = setup.evaluation.records.find(({ kind }) => kind === "evaluation_run");
    if (run?.kind !== "evaluation_run") throw new Error("Missing replay reference");
    const runtimeVectors = JSON.parse(
      readFileSync(
        new URL("../../contracts/vectors/runtime-definition-v1.json", import.meta.url),
        "utf8",
      ),
    ) as { vectors: { input: { definition: Fields } }[] };
    const readLimits = { maxReferences: 1000, maxReferenceBytes: 1000000 };
    expect(PolicyEvaluationSourceReferenceSchema.options).toHaveLength(44);
    for (const option of PolicyEvaluationSourceReferenceSchema.options) {
      const kind = option.shape.kind.value;
      const runtime = runtimeVectors.vectors.find(
        ({ input }) => input.definition["recordKind"] === kind,
      )?.input.definition;
      const reference =
        kind === "replay_result"
          ? run.record.replay
          : kind === "target_release"
            ? run.record.replay.targetRelease
            : Object.fromEntries(
                Object.keys(option.shape.reference.shape).map((key) => [
                  key,
                  key === "definitionSha256"
                    ? "a".repeat(64)
                    : key === "role"
                      ? "candidate"
                      : (runtime?.[key] ?? "record_one"),
                ]),
              );
      const source = PolicyEvaluationSourceReferenceSchema.parse({ kind, reference });
      const missing = missingRepositories();
      const expansion = await readAndExpandPolicyRecord(
        { scope: setup.input.scope, evaluationTime: time, source },
        missing.repositories,
        readLimits,
        { maximumRecords: 1000, maximumRecordBytes: 1000000 },
      );
      expect(expansion, kind).toEqual({
        read: { source, observation: { status: "missing" }, record: null },
        references: null,
      });
      expect(missing.calls.length, kind).toBe(kind === "regression_fixture_version" ? 2 : 1);
      const domain = kind.startsWith("comparison_")
        ? "comparison"
        : kind === "release_candidate"
          ? "candidate"
          : kind === "release_policy"
            ? "policy"
            : kind === "policy_installation_binding"
              ? "binding"
              : ["dataset_version", "regression_fixture_version"].includes(kind)
                ? "dataset"
                : ["replay_plan", "target_release"].includes(kind)
                  ? "replay"
                  : kind === "replay_result"
                    ? "job"
                    : runtime
                      ? "runtime"
                      : [
                            "blinded_plan",
                            "blinded_result",
                            "calibration_report",
                            "human_review_protocol",
                            "human_review_record",
                            "human_reviewer_independence",
                            "independence_declaration",
                            "independent_critique",
                            "model_assisted_evaluator_spec",
                            "model_assurance_assessment",
                            "model_evaluator_profile",
                            "model_qualification_report",
                            "model_qualification_suite",
                          ].includes(kind)
                        ? "model"
                        : "evaluation";
      expect(
        missing.calls.every((call) => call.domain === domain),
        kind,
      ).toBe(true);
    }
  });
});
