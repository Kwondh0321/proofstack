import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  type ContentReference,
  encodeEvaluationCanonicalJson,
  type PolicyEvaluationRequestDefinition,
  type ReleasePolicy,
} from "@proofstack/contracts";
import {
  digestPolicyEvaluationRequestDefinition,
  inspectPolicyEvaluationControlRecord,
  policyEvaluationRequestReference,
  releaseCandidateReference,
  releasePolicyReference,
} from "@proofstack/core";
import {
  releaseCandidateFixture,
  releasePolicyFixtureScope,
  releasePolicyLifecycleFixture,
  releasePolicyRepositoryFixture,
} from "@proofstack/core/testing";
import { describe, expect, it } from "vitest";
import { AcquisitionBudget } from "./acquisition-budget.js";
import type { PolicyArtifactCapture } from "./capture-artifact-evidence.js";
import type { PolicyLifecycleObservation } from "./capture-policy-lifecycle.js";
import type { PolicyRecordGraphEdge } from "./capture-record-graph.js";
import { deriveCapturedPolicySourceGuards } from "./derive-source-guards.js";
import type { PolicyRecordExpansion } from "./record-routing.js";

const evaluationTime = "2026-10-01T00:00:00.000Z";
const observedAt = "2026-10-01T02:00:00.000Z";
const reference: ContentReference = {
  artifactId: "artifact_shared",
  classification: "confidential",
  mediaType: "text/plain",
  sha256: "a".repeat(64),
  sizeBytes: 10,
};
function digest(value: unknown) {
  return createHash("sha256").update(encodeEvaluationCanonicalJson(value)).digest("hex");
}
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected test fixture member");
  return value;
}

function fixture() {
  const scope = releasePolicyFixtureScope("guard_plan");
  const candidate = releaseCandidateFixture("guard_plan", scope);
  const policy = releasePolicyRepositoryFixture("guard_plan", scope);
  const vectors = JSON.parse(
    readFileSync(
      new URL(
        "../../contracts/vectors/policy-evaluation-request-definition-v1.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as { vectors: { input: { definition: PolicyEvaluationRequestDefinition } }[] };
  const vector = vectors.vectors[0];
  if (!vector) throw new Error("Expected canonical request vector");
  const definition = {
    ...structuredClone(vector.input.definition),
    candidate: releaseCandidateReference(candidate),
    policy: releasePolicyReference(policy),
    evaluationTime,
  };
  const request = {
    ...definition,
    scope,
    schemaVersion: "0.1" as const,
    createdAt: observedAt,
    createdByPrincipalId: "principal_guard",
    definitionSha256: digestPolicyEvaluationRequestDefinition(scope, definition),
  };
  const candidateSource = { kind: "release_candidate" as const, reference: request.candidate };
  const policySource = { kind: "release_policy" as const, reference: request.policy };
  const root = inspectPolicyEvaluationControlRecord(
    { scope, evaluationTime, source: policySource },
    policy,
  );
  if (root.observation.status !== "verified") throw new Error("Expected verified root fixture");
  const candidateRead = inspectPolicyEvaluationControlRecord(
    { scope, evaluationTime, source: candidateSource },
    candidate,
  );
  if (candidateRead.observation.status !== "verified")
    throw new Error("Expected verified candidate fixture");
  const candidateRecordSha256 = candidateRead.observation.recordSha256;
  // These inputs represent already acquired internal observations, not a public caller snapshot.
  // The artifact-capture suite separately exercises the authorized request-owning entry point.
  const input = {
    request,
    graph: {
      request: policyEvaluationRequestReference(request),
      scope,
      evaluationTime,
      roots: [candidateSource, policySource],
      nodes: [
        {
          read: candidateRead,
          references: [],
        },
        { read: root, references: [] },
      ] as PolicyRecordExpansion[],
      edges: [] as PolicyRecordGraphEdge[],
    },
    traceReferences: [] as { reference: ContentReference }[],
    artifacts: [] as PolicyArtifactCapture[],
    lifecycle: {
      scope,
      policy: request.policy,
      policyRecordSha256: root.observation.recordSha256,
      evaluationTime,
      startedAt: observedAt,
      completedAt: observedAt,
      observationSha256: "b".repeat(64),
      state: "no_terminal_event_at_evaluation",
      history: [],
    } as PolicyLifecycleObservation,
  } satisfies Parameters<typeof deriveCapturedPolicySourceGuards>[0];
  const append = (ref = reference, trace = false) => {
    const origin = trace
      ? { kind: "trace" as const, artifactReferenceIndex: input.traceReferences.length }
      : { kind: "record" as const, edgeIndex: input.graph.edges.length };
    if (trace) input.traceReferences.push({ reference: structuredClone(ref) });
    else
      input.graph.edges.push({
        parent: candidateSource,
        parentRecordSha256: candidateRecordSha256,
        target: null,
        reference: { kind: "artifact", path: "/buildArtifacts/0/artifact", reference: ref },
      });
    input.artifacts.push({
      origin,
      read: {
        scope,
        reference: structuredClone(ref),
        evaluationTime,
        startedAt: observedAt,
        completedAt: observedAt,
        catalog: null,
        observation:
          ref.sizeBytes === 0
            ? { status: "unavailable", reason: "reference_unsupported" }
            : { status: "missing" },
        usage: { catalogReads: ref.sizeBytes === 0 ? 0 : 1, objectReads: 0, objectBytes: 0 },
      },
    });
  };
  const addPolicy = (record: ReleasePolicy | null, id = "policy_absent") => {
    const source = {
      kind: "release_policy" as const,
      reference: record
        ? releasePolicyReference(record)
        : { ...request.policy, policyVersionId: id },
    };
    const read = inspectPolicyEvaluationControlRecord({ scope, evaluationTime, source }, record);
    input.graph.nodes.push({ read, references: read.record ? [] : null });
  };
  const successor = (publishedAt = "2026-10-01T00:30:00.000Z") => {
    const record = releasePolicyRepositoryFixture("guard_next", scope, {
      policyId: policy.policyId,
      predecessor: request.policy,
      publishedAt,
      semanticVersion: "2.0.0",
    });
    const event = releasePolicyLifecycleFixture("guard_next", policy, {
      kind: "superseded",
      successor: record,
      occurredAt: "2026-10-01T01:00:00.000Z",
    });
    const retained = JSON.parse(JSON.stringify(record)) as ReleasePolicy;
    Object.assign(input.lifecycle, {
      history: [
        {
          record: event,
          recordSha256: digest(event),
          successor: { record: retained, recordSha256: digest(retained) },
        },
      ],
    });
    return retained;
  };
  const run = (budget = new AcquisitionBudget(request.limits)) =>
    deriveCapturedPolicySourceGuards(input, budget);
  return { input, policy, append, addPolicy, successor, run };
}

describe("complete installed-domain source guard derivation", () => {
  it("orders unique coordinates while retaining every missing, unsupported and repeated origin", () => {
    const h = fixture();
    h.addPolicy(null, "artifact_shared");
    h.append();
    h.append(reference, true);
    h.append(reference, true);
    h.append(
      { ...reference, artifactId: "artifact_unmanaged", mediaType: "opaque", sizeBytes: 0 },
      true,
    );
    const plan = h.run();
    expect(plan.guards).toEqual([
      {
        kind: "artifact",
        id: "artifact_shared",
        origins: [0, 1, 2].map((captureIndex) => ({ kind: "artifact_capture", captureIndex })),
      },
      {
        kind: "artifact",
        id: "artifact_unmanaged",
        origins: [{ kind: "artifact_capture", captureIndex: 3 }],
      },
      {
        kind: "release_policy",
        id: "artifact_shared",
        origins: [{ kind: "policy_node", nodeIndex: 2 }],
      },
      {
        kind: "release_policy",
        id: h.policy.policyVersionId,
        origins: [{ kind: "policy_node", nodeIndex: 1 }],
      },
    ]);
    expect(plan.usage).toEqual({
      resources: 4,
      origins: 6,
      canonicalBytes: Buffer.byteLength(JSON.stringify(plan.guards)),
    });
    expect(plan).not.toHaveProperty("sealed");
    expect(plan).not.toHaveProperty("verdict");
  });

  it("keeps verified and unavailable policy identities, including a later lifecycle successor", () => {
    const h = fixture();
    const later = h.successor();
    const future = releasePolicyRepositoryFixture("guard_future", h.input.request.scope, {
      publishedAt: observedAt,
    });
    h.addPolicy(future);
    const plan = h.run();
    expect(plan.guards.find(({ id }) => id === later.policyVersionId)?.origins).toEqual([
      { kind: "policy_successor", historyIndex: 0 },
    ]);
    expect(plan.guards.find(({ id }) => id === future.policyVersionId)?.origins).toEqual([
      { kind: "policy_node", nodeIndex: 2 },
    ]);
    expect(h.input.request.policy).toEqual(releasePolicyReference(h.policy));
    expect(plan.guards.some(({ id }) => id === h.policy.policyVersionId)).toBe(true);
    expect(h.input.graph.nodes[2]?.read.observation).toMatchObject({
      status: "unavailable",
      reason: "not_yet_available",
    });
  });

  it("merges the same verified successor observation instead of dropping either origin", () => {
    const h = fixture();
    const later = h.successor("2026-09-30T23:00:00.000Z");
    h.addPolicy(later);
    expect(h.run().guards.find(({ id }) => id === later.policyVersionId)?.origins).toHaveLength(2);
  });

  it("preserves a withdrawn root without inventing a successor coordinate", () => {
    const h = fixture();
    const record = releasePolicyLifecycleFixture("guard_withdrawn", h.policy);
    Object.assign(h.input.lifecycle, {
      state: "withdrawn_at_evaluation",
      history: [{ record, recordSha256: digest(record), successor: null }],
    });
    expect(h.run().guards).toEqual([
      {
        kind: "release_policy",
        id: h.policy.policyVersionId,
        origins: [{ kind: "policy_node", nodeIndex: 1 }],
      },
    ]);
  });

  it.each(["request", "scope", "time", "roots"])("rejects mismatched graph %s", (kind) => {
    const h = fixture();
    if (kind === "request")
      Object.assign(h.input.graph.request, { definitionSha256: "f".repeat(64) });
    if (kind === "scope")
      h.input.graph.scope = { ...h.input.request.scope, projectId: "project_other" };
    if (kind === "time") h.input.graph.evaluationTime = observedAt;
    if (kind === "roots") h.input.graph.roots.reverse();
    expect(h.run).toThrow(expect.objectContaining({ reason: "reference_conflict" }));
  });

  it.each(["root_absent", "root_missing", "root_reference", "scope", "policy", "time", "hash"])(
    "rejects mismatched lifecycle %s",
    (kind) => {
      const h = fixture();
      if (kind === "root_absent") h.input.graph.nodes.splice(1, 1);
      if (kind === "root_missing")
        h.input.graph.nodes[1] = {
          read: {
            source: { kind: "release_policy", reference: h.input.request.policy },
            record: null,
            observation: { status: "missing" },
          },
          references: null,
        };
      if (kind === "root_reference")
        Object.assign(required(h.input.graph.nodes[1]).read, {
          source: {
            kind: "release_policy",
            reference: { ...h.input.request.policy, policyVersionId: "policy_other" },
          },
        });
      if (kind === "scope")
        Object.assign(h.input.lifecycle, {
          scope: { ...h.input.request.scope, tenantId: "tenant_other" },
        });
      if (kind === "policy")
        Object.assign(h.input.lifecycle, {
          policy: { ...h.input.request.policy, definitionSha256: "f".repeat(64) },
        });
      if (kind === "time") Object.assign(h.input.lifecycle, { evaluationTime: observedAt });
      if (kind === "hash") Object.assign(h.input.lifecycle, { policyRecordSha256: "f".repeat(64) });
      expect(h.run).toThrow(expect.objectContaining({ reason: "observation_conflict" }));
    },
  );

  it.each(["missing", "extra", "origin", "reference", "scope", "time"])(
    "rejects %s artifact capture composition",
    (kind) => {
      const h = fixture();
      h.append();
      const capture = h.input.artifacts[0];
      if (!capture) throw new Error("Expected capture fixture");
      if (kind === "missing") h.input.artifacts.pop();
      if (kind === "extra") h.input.artifacts.push(structuredClone(capture));
      if (kind === "origin")
        Object.assign(capture, { origin: { kind: "trace", artifactReferenceIndex: 0 } });
      if (kind === "reference")
        Object.assign(capture.read, { reference: { ...reference, sha256: "f".repeat(64) } });
      if (kind === "scope")
        Object.assign(capture.read, {
          scope: { ...h.input.request.scope, environmentId: "environment_other" },
        });
      if (kind === "time") Object.assign(capture.read, { evaluationTime: observedAt });
      expect(h.run).toThrow(expect.objectContaining({ reason: "observation_conflict" }));
    },
  );

  it.each(["descriptor", "observation", "identity"])(
    "rejects contradictory repeated artifact %s",
    (kind) => {
      const h = fixture();
      h.append();
      h.append(kind === "descriptor" ? { ...reference, sha256: "f".repeat(64) } : reference, true);
      if (kind === "observation")
        Object.assign(required(h.input.artifacts[1]).read, {
          observation: { status: "unavailable", reason: "object_missing" },
        });
      if (kind === "identity") {
        const invalid = { ...reference, artifactId: "invalid identity" };
        h.input.graph.edges[0] = {
          ...(h.input.graph.edges[0] as PolicyRecordGraphEdge),
          reference: { kind: "artifact", path: "/buildArtifacts/0/artifact", reference: invalid },
        };
        Object.assign(required(h.input.artifacts[0]).read, { reference: invalid });
      }
      expect(h.run).toThrow(
        expect.objectContaining({
          reason: kind === "observation" ? "observation_conflict" : "reference_conflict",
        }),
      );
    },
  );

  it.each([
    "missing_successor",
    "wrong_reference",
    "withdrawn_successor",
    "policy_descriptor",
    "policy_observation",
  ])("rejects %s lifecycle/graph contradictions", (kind) => {
    const h = fixture();
    const later = h.successor();
    const terminal = h.input.lifecycle.history[0];
    if (!terminal) throw new Error("Expected terminal fixture");
    if (kind === "missing_successor") Object.assign(terminal, { successor: null });
    if (kind === "wrong_reference")
      Object.assign(terminal.record, {
        successor: { ...releasePolicyReference(later), policyVersionId: "policy_other" },
      });
    if (kind === "withdrawn_successor")
      Object.assign(terminal, { record: releasePolicyLifecycleFixture("withdrawn", h.policy) });
    if (kind === "policy_descriptor") h.addPolicy(null, later.policyVersionId);
    if (kind === "policy_observation") {
      const source = { kind: "release_policy" as const, reference: releasePolicyReference(later) };
      h.input.graph.nodes.push({
        read: { source, record: null, observation: { status: "missing" } },
        references: null,
      });
    }
    expect(h.run).toThrow(
      expect.objectContaining({
        reason: kind === "policy_descriptor" ? "reference_conflict" : "observation_conflict",
      }),
    );
  });

  it("rejects a repeated policy receipt change with the same semantic reference", () => {
    const h = fixture();
    h.addPolicy({ ...h.policy, publishedAt: "2026-09-08T00:00:00.000Z" });
    expect(h.run).toThrow(expect.objectContaining({ reason: "observation_conflict" }));
  });

  it("bounds unique guards separately and charges exact UTF-8 array bytes to the shared budget", () => {
    const h = fixture();
    h.append();
    h.append({ ...reference, artifactId: "artifact_other" });
    const baseline = h.run();
    expect(baseline.usage.canonicalBytes).toBe(
      Buffer.byteLength(JSON.stringify(baseline.guards), "utf8"),
    );
    const priorBytes = 123;
    const exact = new AcquisitionBudget({
      ...h.input.request.limits,
      maxAcquisitionRecordBytes: priorBytes + baseline.usage.canonicalBytes,
    });
    exact.addReferences(2, priorBytes);
    expect(h.run(exact)).toEqual(baseline);
    expect(exact.usage()).toMatchObject({
      references: 2,
      referenceBytes: priorBytes + baseline.usage.canonicalBytes,
    });
    const short = new AcquisitionBudget({
      ...h.input.request.limits,
      maxAcquisitionRecordBytes: priorBytes + baseline.usage.canonicalBytes - 1,
    });
    short.addReferences(2, priorBytes);
    expect(() => h.run(short)).toThrow(expect.objectContaining({ reason: "byte_limit" }));
    h.input.request.limits.maxAcquisitionRecords = 2;
    expect(h.run).toThrow(expect.objectContaining({ reason: "guard_limit" }));
  });

  it("owns output arrays and origin objects independently of the captured inputs", () => {
    const h = fixture();
    h.append();
    const before = structuredClone(h.input);
    const baseline = h.run();
    const changed = h.run();
    Object.assign(required(changed.guards[0]), { id: "changed" });
    Object.assign(required(required(changed.guards[0]).origins[0]), { captureIndex: 999 });
    expect(h.input).toEqual(before);
    expect(h.run()).toEqual(baseline);
  });
});
