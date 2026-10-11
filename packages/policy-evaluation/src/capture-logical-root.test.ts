import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  type EvidenceScope,
  type PolicyEvaluationSourceReference,
  PolicyEvaluationSourceReferenceSchema,
  type RegressionFixtureVersionDefinition,
} from "@proofstack/contracts";
import {
  createComparisonRepositoryTestHarness,
  createEvaluationRepositoryTestHarness,
  createReleaseCandidateRepositoryTestHarness,
  createReleasePolicyRepositoryTestHarness,
  MemoryReleaseCandidateRepository,
  releaseCandidateFixture,
} from "@proofstack/core/testing";
import { digestRegressionFixtureVersionDefinition } from "@proofstack/datasets";
import { describe, expect, it, vi } from "vitest";
import {
  capturePolicyLogicalRootBinding,
  inspectCapturedLogicalRootBindings,
  inspectPolicyLogicalRootBinding,
  isPolicyLogicalRootSource,
} from "./capture-logical-root.js";
import type { PolicyEvaluationLogicalRootPorts } from "./logical-root-ports.js";
import {
  inspectRetainedPolicyRecord,
  type PolicyRetainedRecordCapture,
} from "./retained-record-routing.js";

type Fields = Record<string, unknown>;
interface Case {
  readonly name: string;
  readonly kind: PolicyEvaluationSourceReference["kind"];
  readonly record: unknown;
  readonly root: unknown;
  readonly route: string;
  readonly query: readonly unknown[];
}
function fields(value: unknown): Fields {
  if (!value || typeof value !== "object") throw new Error("Expected retained fixture body");
  return value as Fields;
}
function sourceFor(kind: Case["kind"], record: unknown): PolicyEvaluationSourceReference {
  const option = PolicyEvaluationSourceReferenceSchema.options.find(
    ({ shape }) => shape.kind.value === kind,
  );
  if (!option) throw new Error("Expected fixed source schema");
  return PolicyEvaluationSourceReferenceSchema.parse({
    kind,
    reference: Object.fromEntries(
      Object.keys(option.shape.reference.shape).map((key) => [key, fields(record)[key]]),
    ),
  });
}
const evaluation = createEvaluationRepositoryTestHarness("captured_root");
const evaluationKinds = [
  "aggregation_policy",
  "criterion_set",
  "evaluator_spec",
  "oracle_spec",
  "qualification_fixture_set",
] as const;
const comparison = createComparisonRepositoryTestHarness("captured_root");
const originalComparison = comparison.records.find(
  ({ kind }) => kind === "comparison_definition",
)?.record;
if (!originalComparison) throw new Error("Missing owning comparison root");
const candidate = createReleaseCandidateRepositoryTestHarness("captured_root");
const policy = createReleasePolicyRepositoryTestHarness("captured_root");
type Vector = { name: string; kind: string; input: Fields; sha256: string };
const vectors = ["regression-definition-v1.json", "interaction-fixture-definition-v2.json"].flatMap(
  (file) =>
    (
      JSON.parse(
        readFileSync(new URL(`../../datasets/vectors/${file}`, import.meta.url), "utf8"),
      ) as { vectors: Vector[] }
    ).vectors,
);
const evidenceVector = vectors.find(({ kind }) => kind === "fixture");
if (!evidenceVector) throw new Error("Missing evidence-only root vector");
const cases: Case[] = [
  ...evaluationKinds.map((kind): Case => {
    const record = evaluation.records.find((entry) => entry.kind === kind)?.record;
    if (!record) throw new Error("Missing evaluation root fixture");
    const source = sourceFor(kind, record);
    const id = Object.entries(source.reference).find(([field]) => field.endsWith("VersionId"))?.[1];
    return {
      name: kind,
      kind,
      record,
      root: record,
      route: "evaluation.findEvaluationLogicalRoot",
      query: [kind, id],
    };
  }),
  ...comparison.records.map(
    ({ kind, record }): Case => ({
      name: `${kind}:${"role" in record ? record.role : "definition"}`,
      kind: kind === "comparison_evidence_snapshot" ? "comparison_snapshot" : kind,
      record,
      root: originalComparison,
      route: "comparison.findComparisonLogicalRoot",
      query: [
        kind,
        kind === "comparison_definition"
          ? fields(record)["comparisonVersionId"]
          : kind === "comparison_result"
            ? fields(record)["resultId"]
            : fields(record)["snapshotId"],
      ],
    }),
  ),
  {
    name: "candidate successor",
    kind: "release_candidate",
    record: candidate.successor,
    root: candidate.candidate,
    route: "releaseCandidate.findReleaseCandidateLogicalRoot",
    query: [candidate.successor.candidateVersionId],
  },
  {
    name: "policy successor",
    kind: "release_policy",
    record: policy.successor,
    root: policy.policy,
    route: "releasePolicy.findReleasePolicyLogicalRoot",
    query: [policy.successor.policyVersionId],
  },
  ...vectors.map((vector): Case => {
    const record = {
      ...structuredClone(vector.input),
      createdAt: "2026-09-08T00:00:00.123Z",
      createdByPrincipalId: "usr_policy_source",
      definitionSha256: vector.sha256,
      ...(vector.input["source"]
        ? { source: { ...fields(vector.input["source"]), capturedAt: "2026-09-08T00:00:00.000Z" } }
        : {}),
    };
    let root: unknown = record;
    if (vector.kind === "recorded_interaction_fixture") {
      const definition: Fields = {
        ...structuredClone(evidenceVector.input),
        fixtureId: vector.input["fixtureId"],
        fixtureVersionId: "fixture_captured_original",
        scope: vector.input["scope"],
      };
      delete definition["predecessor"];
      root = {
        ...definition,
        createdAt: "2026-09-08T00:00:00.123Z",
        createdByPrincipalId: "usr_policy_source",
        definitionSha256: digestRegressionFixtureVersionDefinition(
          definition as unknown as RegressionFixtureVersionDefinition,
        ),
        source: { ...fields(definition["source"]), capturedAt: "2026-09-08T00:00:00.000Z" },
      };
    }
    return {
      name: vector.name,
      kind: vector.kind === "dataset" ? "dataset_version" : "regression_fixture_version",
      record,
      root,
      route: `datasets.${vector.kind === "dataset" ? "findDatasetLogicalRoot" : vector.kind === "fixture" ? "findFixtureLogicalRoot" : "findRecordedInteractionFixtureLogicalRoot"}`,
      query: [vector.input[vector.kind === "dataset" ? "datasetVersionId" : "fixtureVersionId"]],
    };
  }),
];

function input(testCase: Case, evaluationTime = "2030-01-01T00:00:00.000Z") {
  return {
    scope: structuredClone(fields(testCase.record)["scope"]) as EvidenceScope,
    source: sourceFor(testCase.kind, testCase.record),
    evaluationTime,
  };
}
function captured(testCase: Case, evaluationTime?: string): PolicyRetainedRecordCapture {
  const result = inspectRetainedPolicyRecord(input(testCase, evaluationTime), testCase.record);
  if (!result?.storage) throw new Error(`Missing validated retained fixture: ${testCase.name}`);
  return result;
}
function ports(raw: unknown) {
  const calls: { route: string; args: unknown[] }[] = [];
  const domain = (name: string) =>
    new Proxy(
      {},
      {
        get: (target, method) =>
          Object.hasOwn(target, method)
            ? Reflect.get(target, method)
            : async (...args: unknown[]) => {
                calls.push({ route: `${name}.${String(method)}`, args: structuredClone(args) });
                return raw;
              },
      },
    );
  return {
    calls,
    ports: {
      evaluation: domain("evaluation"),
      comparison: domain("comparison"),
      releaseCandidate: domain("releaseCandidate"),
      releasePolicy: domain("releasePolicy"),
      datasets: domain("datasets"),
    } as unknown as PolicyEvaluationLogicalRootPorts,
  };
}
// Independent sorted JSON oracle; source validation is not reused for the expected full-body hash.
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, sorted(item)]),
    );
  return value;
}
const hash = (value: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(sorted(value)))
    .digest("hex");

describe.each(cases)("original root capture: $name", (testCase) => {
  it.each(["2000-01-01T00:00:00.000Z", "2030-01-01T00:00:00.000Z"])(
    "retains original bytes and exact owning query at cut %s",
    async (cut) => {
      const context = input(testCase, cut);
      const parent = captured(testCase, cut);
      const f = ports(testCase.root);
      const result = await capturePolicyLogicalRootBinding(context, parent, f.ports);
      expect(f.calls).toEqual([
        { route: testCase.route, args: [context.scope, ...testCase.query] },
      ]);
      expect(result?.status).toBe("retained");
      if (result?.status !== "retained") throw new Error("Missing retained root");
      expect(result.parent).toEqual(context.source);
      expect(result.parentRecordSha256).toBe(hash(testCase.record));
      expect(result.root.storage?.record).toEqual(testCase.root);
      expect(result.root.storage?.recordSha256).toBe(hash(testCase.root));
      expect(result.root.read.observation.status).toBe(
        cut.startsWith("2000") ? "unavailable" : "verified",
      );
      expect(result.root.read.record).toEqual(cut.startsWith("2000") ? null : testCase.root);
      expect(inspectPolicyLogicalRootBinding(context, parent, testCase.root)).toEqual(result);
    },
  );
  it("retains an explicit configuration frontier without claiming absence", async () => {
    const parent = captured(testCase);
    await expect(
      capturePolicyLogicalRootBinding(input(testCase), parent, undefined),
    ).resolves.toEqual({
      parent: input(testCase).source,
      parentRecordSha256: hash(testCase.record),
      status: "unresolved",
      reason: "root_port_unconfigured",
    });
  });
  it("rejects a missing root for a retained child", async () => {
    const f = ports(null);
    await expect(
      capturePolicyLogicalRootBinding(input(testCase), captured(testCase), f.ports),
    ).rejects.toMatchObject({ reason: "observation_conflict" });
    expect(f.calls).toHaveLength(1);
  });
});

describe("root binding integrity and detached capture", () => {
  const testCase = cases.find(({ kind }) => kind === "release_candidate");
  if (!testCase) throw new Error("Missing candidate case");
  it.each(["body", "hash", "receipt", "semantic observation"])(
    "rejects substituted parent %s before I/O",
    async (change) => {
      const parent = captured(testCase);
      if (!parent.storage) throw new Error("Expected retained parent");
      if (change === "body")
        fields(parent.storage.record)["createdByPrincipalId"] = "other_principal";
      else if (change === "hash") Reflect.set(parent.storage, "recordSha256", "0".repeat(64));
      else if (change === "receipt")
        Reflect.set(parent.storage, "receiptTime", "2000-01-01T00:00:00.000Z");
      else fields(parent.read)["observation"] = { status: "missing" };
      const f = ports(testCase.root);
      await expect(
        capturePolicyLogicalRootBinding(input(testCase), parent, f.ports),
      ).rejects.toMatchObject({ reason: "observation_conflict" });
      expect(f.calls).toEqual([]);
    },
  );
  it.each(["tenantId", "projectId", "environmentId", "logical ID", "digest", "unknown field"])(
    "rejects substituted root %s",
    (change) => {
      const root = structuredClone(testCase.root);
      if (["tenantId", "projectId", "environmentId"].includes(change))
        fields(fields(root)["scope"])[change] = "foreign_scope";
      else if (change === "logical ID") fields(root)["candidateId"] = "other_candidate";
      else if (change === "digest") fields(root)["definitionSha256"] = "0".repeat(64);
      else fields(root)["extra"] = true;
      expect(() =>
        inspectPolicyLogicalRootBinding(input(testCase), captured(testCase), root),
      ).toThrow();
    },
  );
  it("owns parent context before awaiting the root port and all returned bodies", async () => {
    const context = input(testCase);
    const parent = captured(testCase);
    let finish!: (value: unknown) => void;
    const pending = new Promise<unknown>((resolve) => {
      finish = resolve;
    });
    const f = ports(testCase.root);
    f.ports.releaseCandidate.findReleaseCandidateLogicalRoot = vi.fn(
      async () => pending,
    ) as PolicyEvaluationLogicalRootPorts["releaseCandidate"]["findReleaseCandidateLogicalRoot"];
    const running = capturePolicyLogicalRootBinding(context, parent, f.ports);
    context.evaluationTime = "2000-01-01T00:00:00.000Z";
    context.scope.tenantId = "foreign_scope";
    fields(parent.storage?.record)["createdByPrincipalId"] = "mutated_while_pending";
    const root = structuredClone(testCase.root);
    finish(root);
    const result = await running;
    if (result?.status !== "retained" || !result.root.storage)
      throw new Error("Missing owned root");
    expect(result.root.read.observation.status).toBe("verified");
    expect(result.parentRecordSha256).toBe(hash(testCase.record));
    fields(root)["createdByPrincipalId"] = "mutated_port_body";
    fields(parent.storage?.record)["createdByPrincipalId"] = "mutated_parent_body";
    expect(result.root.storage.record).toEqual(testCase.root);
  });
  it("uses the actual first memory binding when an independent later version has an earlier receipt", async () => {
    const owner = new MemoryReleaseCandidateRepository();
    await owner.publishReleaseCandidate(candidate.candidate);
    const independent = { ...candidate.successor, createdAt: "2020-01-01T00:00:00.000Z" };
    await owner.publishReleaseCandidate(independent);
    const f = ports(null);
    Reflect.set(f.ports, "releaseCandidate", owner);
    const scenario = { ...testCase, record: independent };
    const result = await capturePolicyLogicalRootBinding(
      input(scenario),
      captured(scenario),
      f.ports,
    );
    if (result?.status !== "retained") throw new Error("Missing original binding");
    expect(result.root.storage?.record).toEqual(candidate.candidate);
    expect(result.root.storage?.record).not.toEqual(independent);
  });
  it("propagates a port failure and skips unreadable parents", async () => {
    const f = ports(null);
    const failure = new Error("storage unavailable");
    f.ports.releaseCandidate.findReleaseCandidateLogicalRoot = vi.fn(async () => {
      throw failure;
    });
    await expect(
      capturePolicyLogicalRootBinding(input(testCase), captured(testCase), f.ports),
    ).rejects.toBe(failure);
    const missing = inspectRetainedPolicyRecord(input(testCase), null);
    if (!missing) throw new Error("Missing owning route");
    await expect(
      capturePolicyLogicalRootBinding(input(testCase), missing, f.ports),
    ).resolves.toBeNull();
  });
  it("rejects non-root source kinds without introducing synthetic resources", () => {
    const raw = PolicyEvaluationSourceReferenceSchema.parse({
      kind: "runtime_adapter",
      reference: {
        adapterId: "adapter_one",
        adapterVersionId: "adapter_version_one",
        definitionSha256: "1".repeat(64),
      },
    });
    expect(isPolicyLogicalRootSource(raw)).toBe(false);
    expect(() =>
      inspectPolicyLogicalRootBinding(
        { ...input(testCase), source: raw },
        captured(testCase),
        testCase.root,
      ),
    ).toThrow("Unsupported");
    expect(inspectRetainedPolicyRecord({ ...input(testCase), source: raw }, null)).toEqual({
      read: { source: raw, observation: { status: "missing" }, record: null },
      storage: null,
    });
  });
  it("rejects another full receipt under the parent's own root identity", () => {
    const original = cases.find(({ kind }) => kind === "criterion_set");
    if (!original) throw new Error("Missing self-root fixture");
    const changed = structuredClone(original.root);
    fields(changed)["publishedByPrincipalId"] = "changed_root_receipt";
    expect(() =>
      inspectPolicyLogicalRootBinding(input(original), captured(original), changed),
    ).toThrow("observation_conflict");
  });
  it("rejects inconsistent full roots shared by two independent child origins", () => {
    const second = {
      ...testCase,
      record: releaseCandidateFixture("captured_shared", candidate.scope, {
        candidateId: candidate.candidate.candidateId,
        candidateVersionId: "candidate_captured_root_v3",
      }),
    };
    const firstParent = captured(testCase);
    const secondParent = captured(second);
    const changed = structuredClone(testCase.root);
    fields(changed)["createdByPrincipalId"] = "changed_root_receipt";
    const bindings = [
      inspectPolicyLogicalRootBinding(input(testCase), firstParent, testCase.root),
      inspectPolicyLogicalRootBinding(input(second), secondParent, changed),
    ];
    const graph = {
      nodes: [
        { ...firstParent, references: [] },
        { ...secondParent, references: [] },
      ],
      logicalRoots: { configuration: "configured" as const, bindings },
    };
    expect(() => inspectCapturedLogicalRootBindings(input(testCase), graph)).toThrow(
      "observation_conflict",
    );
  });
  it.each(["missing", "extra", "substituted", "configuration"])(
    "independently rejects %s root witnesses",
    async (change) => {
      const context = input(testCase);
      const parent = captured(testCase);
      const binding = await capturePolicyLogicalRootBinding(
        context,
        parent,
        ports(testCase.root).ports,
      );
      if (!binding) throw new Error("Missing root binding");
      const graph = {
        nodes: [{ ...parent, references: [] }],
        logicalRoots: { configuration: "configured" as const, bindings: [binding] },
      };
      expect(() => inspectCapturedLogicalRootBindings(context, graph)).not.toThrow();
      if (change === "missing") graph.logicalRoots.bindings = [];
      else if (change === "extra") graph.logicalRoots.bindings.push(structuredClone(binding));
      else if (change === "configuration")
        fields(graph.logicalRoots)["configuration"] = "unsupported";
      else graph.logicalRoots.bindings[0] = { ...binding, parentRecordSha256: "0".repeat(64) };
      expect(() => inspectCapturedLogicalRootBindings(context, graph)).toThrow();
    },
  );
});
