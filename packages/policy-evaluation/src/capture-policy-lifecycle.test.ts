import { createHash } from "node:crypto";
import {
  encodeEvaluationCanonicalJson,
  type PolicyEvaluationExecutionLimits,
  type ReleasePolicy,
  type ReleasePolicyLifecycleEvent,
} from "@proofstack/contracts";
import { ReleasePolicyRepositoryContractError, releasePolicyReference } from "@proofstack/core";
import {
  MemoryReleasePolicyRepository,
  releasePolicyFixtureScope,
  releasePolicyLifecycleFixture,
  releasePolicyRepositoryFixture,
} from "@proofstack/core/testing";
import { describe, expect, it, vi } from "vitest";
import { AcquisitionBudget, PolicyRecordGraphError } from "./acquisition-budget.js";
import { observeCapturedPolicyLifecycle } from "./capture-policy-lifecycle.js";

const evaluationTime = "2026-10-01T00:00:00.000Z";
const observedAt = "2026-10-01T02:00:00.000Z";
const limits: PolicyEvaluationExecutionLimits = {
  heartbeatIntervalMilliseconds: 1000,
  leaseDurationMilliseconds: 5000,
  maxAcquisitionRecordBytes: 1_048_576,
  maxAcquisitionRecords: 10000,
  maxArtifactReadBytes: 1_048_576,
  maxAttempts: 2,
  maxRuleEvaluations: 256,
  perAttemptTimeoutMilliseconds: 20000,
  retryBackoffMilliseconds: 100,
  retryableErrors: ["source_revision_changed"],
  totalDeadlineMilliseconds: 60000,
};
function digest(value: unknown) {
  return createHash("sha256").update(encodeEvaluationCanonicalJson(value)).digest("hex");
}

async function fixture() {
  const scope = releasePolicyFixtureScope("lifecycle_capture");
  const policy = releasePolicyRepositoryFixture("lifecycle_capture", scope);
  const successor = releasePolicyRepositoryFixture("lifecycle_capture", scope, {
    predecessor: releasePolicyReference(policy),
    publishedAt: "2026-09-30T23:00:00.000Z",
    semanticVersion: "2.0.0",
  });
  const repository = new MemoryReleasePolicyRepository();
  await repository.publishReleasePolicy(policy);
  await repository.publishReleasePolicy(successor);
  const source = { kind: "release_policy" as const, reference: releasePolicyReference(policy) };
  // Unit input represents the already acquired root, not a public caller-supplied snapshot.
  // The separate artifact-capture suite exercises real request-rooted graph acquisition.
  const record = JSON.parse(JSON.stringify(policy)) as ReleasePolicy;
  const graph = {
    scope,
    evaluationTime,
    roots: [source],
    nodes: [
      {
        read: {
          source,
          record,
          observation: { status: "verified" as const, recordSha256: digest(record) },
        },
        references: [],
      },
    ],
  } satisfies Parameters<typeof observeCapturedPolicyLifecycle>[0];
  const clock = { now: vi.fn(() => new Date(observedAt)) };
  const history = vi.spyOn(repository, "listReleasePolicyLifecycleEvents");
  const find = vi.spyOn(repository, "findReleasePolicy");
  const event = (kind: "withdrawn" | "superseded" = "withdrawn", occurredAt = evaluationTime) =>
    releasePolicyLifecycleFixture(
      "lifecycle_capture",
      policy,
      kind === "withdrawn" ? { occurredAt } : { kind, successor, occurredAt },
    );
  const run = () => observeCapturedPolicyLifecycle(graph, repository, clock);
  return { scope, policy, successor, graph, repository, clock, history, find, event, run };
}

describe("exact terminal lifecycle observations", () => {
  for (const kind of ["withdrawn", "superseded"] as const) {
    it.each([
      ["2026-09-30T23:59:59.999999999999999999999999999999Z", "no_terminal_event_at_evaluation"],
      [evaluationTime, `${kind}_at_evaluation`],
      ["2026-10-01T00:00:00.000000000000000000000000000001Z", `${kind}_at_evaluation`],
    ])(`${kind} preserves the exact semantic edge at %s`, async (at, state) => {
      const h = await fixture();
      const event = h.event(kind);
      await h.repository.publishReleasePolicyLifecycleEvent(event);
      h.graph.evaluationTime = at;
      const result = await h.run();
      expect(result.state).toBe(state);
      expect(result.history[0]?.record).toEqual(event);
      expect(result.history[0]?.recordSha256).toBe(digest(event));
      if (kind === "superseded") {
        expect(result.history[0]?.successor).toEqual({
          record: h.successor,
          recordSha256: digest(h.successor),
        });
        expect(h.find).toHaveBeenCalledExactlyOnceWith(h.scope, h.successor.policyVersionId);
      } else expect(h.find).not.toHaveBeenCalled();
    });
  }

  it("retains a later successor as lineage without replacing the historical evaluation root", async () => {
    const h = await fixture();
    const successor = releasePolicyRepositoryFixture("late", h.scope, {
      policyId: h.policy.policyId,
      predecessor: releasePolicyReference(h.policy),
      publishedAt: "2026-10-01T00:30:00.000Z",
      semanticVersion: "3.0.0",
    });
    await h.repository.publishReleasePolicy(successor);
    const event = releasePolicyLifecycleFixture("late", h.policy, {
      kind: "superseded",
      successor,
      occurredAt: "2026-10-01T01:00:00.000Z",
    });
    await h.repository.publishReleasePolicyLifecycleEvent(event);
    const result = await h.run();
    expect(result.state).toBe("no_terminal_event_at_evaluation");
    expect(result.history[0]?.successor?.record).toEqual(successor);
    expect(result.policy).toEqual(releasePolicyReference(h.policy));
  });

  it.each([null, undefined, {}, { events: [] }, [null], [{ unknown: true }], [undefined]])(
    "rejects malformed complete history %j",
    async (input) => {
      const h = await fixture();
      h.history.mockResolvedValue(input as unknown as ReleasePolicyLifecycleEvent[]);
      await expect(h.run()).rejects.toBeInstanceOf(ReleasePolicyRepositoryContractError);
      expect(h.find).not.toHaveBeenCalled();
    },
  );

  it.each(["duplicate", "competing"])(
    "rejects %s terminal events instead of choosing one",
    async (kind) => {
      const h = await fixture();
      h.history.mockResolvedValue([
        h.event(),
        kind === "duplicate" ? h.event() : h.event("superseded"),
      ]);
      await expect(h.run()).rejects.toBeInstanceOf(ReleasePolicyRepositoryContractError);
      expect(h.find).not.toHaveBeenCalled();
    },
  );

  it.each([
    "scope",
    "policyId",
    "policyVersionId",
    "digest",
    "before_publication",
    "future_receipt",
    "unknown_field",
  ])("rejects an event with %s corruption", async (kind) => {
    const h = await fixture();
    const event = h.event();
    if (kind === "scope") event.scope.tenantId = "tenant_other";
    if (kind === "policyId") event.policy.policyId = "policy_other";
    if (kind === "policyVersionId") event.policy.policyVersionId = "version_other";
    if (kind === "digest") event.policy.definitionSha256 = "f".repeat(64);
    if (kind === "before_publication") event.occurredAt = "2026-09-01T00:00:00.000Z";
    if (kind === "future_receipt") event.occurredAt = "2026-10-01T02:00:00.001Z";
    if (kind === "unknown_field") Object.assign(event, { extra: undefined });
    h.history.mockResolvedValue([event]);
    await expect(h.run()).rejects.toBeInstanceOf(ReleasePolicyRepositoryContractError);
  });

  it.each([
    "missing",
    "malformed",
    "digest",
    "scope",
    "reference",
    "no_predecessor",
    "wrong_predecessor",
    "future_publication",
  ])("rejects a successor with %s corruption", async (kind) => {
    const h = await fixture();
    h.history.mockResolvedValue([h.event("superseded")]);
    let record: ReleasePolicy | null = structuredClone(h.successor);
    if (kind === "missing") record = null;
    else if (kind === "malformed") Object.assign(record, { unknown: undefined });
    else if (kind === "digest") record.definitionSha256 = "f".repeat(64);
    else if (kind === "scope")
      record = releasePolicyRepositoryFixture(
        "lifecycle_capture",
        { ...h.scope, projectId: "project_other" },
        {
          predecessor: releasePolicyReference(h.policy),
          semanticVersion: "2.0.0",
        },
      );
    else if (kind === "future_publication") record.publishedAt = "2026-10-01T00:00:00.001Z";
    else
      record = releasePolicyRepositoryFixture("lifecycle_capture", h.scope, {
        semanticVersion: "2.0.0",
        ...(kind === "no_predecessor"
          ? {}
          : {
              predecessor:
                kind === "wrong_predecessor"
                  ? { ...releasePolicyReference(h.policy), policyVersionId: "wrong_predecessor" }
                  : releasePolicyReference(h.policy),
            }),
        ...(kind === "reference" ? { changeRationale: "A different admitted definition" } : {}),
      });
    // Bind an otherwise valid alternate successor to exercise lineage checks, not only digest checks.
    if (record && (kind === "no_predecessor" || kind === "wrong_predecessor" || kind === "scope")) {
      const event = h.event("superseded");
      if (event.kind !== "superseded") throw new Error("Expected supersession");
      event.successor = releasePolicyReference(record);
      h.history.mockResolvedValue([event]);
    }
    h.find.mockResolvedValue(record);
    await expect(h.run()).rejects.toBeInstanceOf(ReleasePolicyRepositoryContractError);
    expect(h.find).toHaveBeenCalledTimes(1);
  });

  it("propagates a successor storage exception unchanged", async () => {
    const h = await fixture();
    h.history.mockResolvedValue([h.event("superseded")]);
    const failure = new Error("successor storage offline");
    h.find.mockRejectedValue(failure);
    await expect(h.run()).rejects.toBe(failure);
  });

  it("hashes the full successor receipt, not only its definition", async () => {
    const h = await fixture();
    h.history.mockResolvedValue([h.event("superseded")]);
    const before = await h.run();
    h.find.mockResolvedValue({ ...h.successor, publishedAt: "2026-09-30T22:00:00.000Z" });
    const after = await h.run();
    expect(before.history[0]?.recordSha256).toBe(after.history[0]?.recordSha256);
    expect(before.history[0]?.successor?.record.definitionSha256).toBe(
      after.history[0]?.successor?.record.definitionSha256,
    );
    expect(before.history[0]?.successor?.recordSha256).not.toBe(
      after.history[0]?.successor?.recordSha256,
    );
    expect(before.observationSha256).not.toBe(after.observationSha256);
  });

  it("rejects unknown undefined fields before successor normalization", async () => {
    const h = await fixture();
    h.history.mockResolvedValue([h.event("superseded")]);
    const before = await h.run();
    h.find.mockResolvedValue({ ...h.successor, supersedes: undefined } as ReleasePolicy);
    // Unknown keys must not disappear through JSON normalization.
    await expect(h.run()).rejects.toBeInstanceOf(ReleasePolicyRepositoryContractError);
    h.find.mockResolvedValue({ ...h.successor });
    expect((await h.run()).observationSha256).toBe(before.observationSha256);
  });

  it("owns returned scopes, references, event records and successor records", async () => {
    const h = await fixture();
    const event = h.event("superseded");
    h.history.mockResolvedValue([event]);
    h.find.mockResolvedValue(h.successor);
    const result = await h.run();
    const expected = structuredClone(result);
    event.reason = "Mutated externally";
    h.successor.changeRationale = "Mutated externally";
    h.graph.scope.projectId = "changed_project";
    h.graph.roots[0]!.reference.policyVersionId = "changed_policy";
    expect(result).toEqual(expected);
  });

  it.each([
    "no_root",
    "two_roots",
    "no_parent",
    "missing_parent",
    "wrong_source",
    "scope",
    "hash",
    "reference",
  ])("rejects broken captured root provenance: %s", async (kind) => {
    const h = await fixture();
    const graph: Parameters<typeof observeCapturedPolicyLifecycle>[0] = structuredClone(h.graph);
    const first = h.graph.nodes[0];
    if (!first) throw new Error("Expected root");
    const roots =
      kind === "no_root"
        ? []
        : kind === "two_roots"
          ? [...graph.roots, ...graph.roots]
          : [...graph.roots];
    let nodes = graph.nodes;
    if (kind === "no_parent") nodes = [];
    if (kind === "missing_parent")
      nodes = [
        {
          read: { source: first.read.source, observation: { status: "missing" }, record: null },
          references: null,
        },
      ];
    if (kind === "scope") graph.scope.projectId = "other_project";
    if (kind === "hash")
      nodes = [
        {
          ...first,
          read: {
            ...first.read,
            observation: { status: "verified", recordSha256: "f".repeat(64) },
          },
        },
      ];
    if (kind === "wrong_source" || kind === "reference") {
      const source = {
        ...first.read.source,
        reference: { ...first.read.source.reference, definitionSha256: "f".repeat(64) },
      };
      nodes = [{ ...first, read: { ...first.read, source } }];
      if (kind === "reference") roots[0] = source;
    }
    await expect(
      observeCapturedPolicyLifecycle({ ...graph, roots, nodes }, h.repository, h.clock),
    ).rejects.toBeInstanceOf(PolicyRecordGraphError);
    expect(h.history).not.toHaveBeenCalled();
  });

  it("does not read lifecycle before the semantic evaluation time", async () => {
    const h = await fixture();
    h.graph.evaluationTime = "2026-10-01T02:00:00.000000000000000000000000000001Z";
    await expect(h.run()).rejects.toBeInstanceOf(ReleasePolicyRepositoryContractError);
    expect(h.history).not.toHaveBeenCalled();
  });
});

describe("lifecycle read admission", () => {
  it.each(["withdrawn", "superseded"] as const)(
    "charges exact %s response bytes and rows including duplicates across observations",
    async (kind) => {
      const h = await fixture();
      const event = h.event(kind);
      await h.repository.publishReleasePolicyLifecycleEvent(event);
      const expectedBytes =
        Buffer.byteLength(JSON.stringify([event])) +
        (kind === "superseded" ? Buffer.byteLength(JSON.stringify(h.successor)) : 0);
      const perObservationRecords = kind === "superseded" ? 3 : 2;
      const budget = new AcquisitionBudget({
        ...limits,
        maxAcquisitionRecords: perObservationRecords * 2,
        maxAcquisitionRecordBytes: expectedBytes * 2,
      });
      const port = budget.wrap(h.repository);
      await observeCapturedPolicyLifecycle(h.graph, port, h.clock);
      await observeCapturedPolicyLifecycle(h.graph, port, h.clock);
      expect(budget.usage()).toMatchObject({
        records: perObservationRecords * 2,
        bytes: expectedBytes * 2,
        reads: kind === "superseded" ? 4 : 2,
      });
      await expect(observeCapturedPolicyLifecycle(h.graph, port, h.clock)).rejects.toMatchObject({
        reason: "record_limit",
      });
      expect(h.history).toHaveBeenCalledTimes(2);
      await budget.settle();
    },
  );

  it.each(["records", "bytes"])(
    "rejects one-less %s capacity without normalizing a history to empty",
    async (dimension) => {
      const h = await fixture();
      const event = h.event();
      h.history.mockResolvedValue([event]);
      const budget = new AcquisitionBudget({
        ...limits,
        maxAcquisitionRecords: dimension === "records" ? 1 : 2,
        maxAcquisitionRecordBytes:
          Buffer.byteLength(JSON.stringify([event])) - (dimension === "bytes" ? 1 : 0),
      });
      await expect(
        observeCapturedPolicyLifecycle(h.graph, budget.wrap(h.repository), h.clock),
      ).rejects.toMatchObject({ reason: dimension === "records" ? "record_limit" : "byte_limit" });
      expect(h.find).not.toHaveBeenCalled();
      await budget.settle();
    },
  );

  it("meters every malformed duplicate history member before rejecting the repository contract", async () => {
    const h = await fixture();
    h.history.mockResolvedValue([h.event(), h.event()]);
    const budget = new AcquisitionBudget({ ...limits, maxAcquisitionRecords: 2 });
    await expect(
      observeCapturedPolicyLifecycle(h.graph, budget.wrap(h.repository), h.clock),
    ).rejects.toMatchObject({ reason: "record_limit" });
    expect(h.history).toHaveBeenCalledTimes(1);
    expect(h.find).not.toHaveBeenCalled();
    await budget.settle();
  });

  it("charges empty complete histories as reads and raw array bytes", async () => {
    const h = await fixture();
    const budget = new AcquisitionBudget(limits);
    await observeCapturedPolicyLifecycle(h.graph, budget.wrap(h.repository), h.clock);
    expect(budget.usage()).toMatchObject({ records: 1, reads: 1, bytes: 2 });
    await budget.settle();
  });
});
