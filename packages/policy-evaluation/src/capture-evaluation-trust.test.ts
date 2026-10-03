import { createHash } from "node:crypto";
import { ArtifactCipher, LocalArtifactKeyring } from "@proofstack/artifacts";
import {
  MemoryArtifactCatalogRepository,
  MemoryArtifactObjectStore,
} from "@proofstack/artifacts/testing";
import {
  type ArtifactMetadata,
  type ContentReference,
  encodeEvaluationCanonicalJson,
  type PolicyEvaluationRequestDefinition,
  PrincipalContextSchema,
  policyEvaluationSourceReferenceKey,
  type ReleaseCandidate,
  type ReleasePolicy,
} from "@proofstack/contracts";
import {
  digestEvaluationRecordDefinition,
  digestPolicyEvaluationRequestDefinition,
  digestReleaseCandidateDefinition,
  digestReleasePolicyDefinition,
  evaluationRecordDescriptors,
  PolicyEvaluationReferenceCollector,
  releaseCandidateReference,
  releasePolicyReference,
} from "@proofstack/core";
import {
  createEvaluationRepositoryTestHarness,
  type EvaluationRepositoryFixtureRecord,
  MemoryEvidenceRepository,
  MemoryReleaseCandidateRepository,
  MemoryReleasePolicyRepository,
  publishEvaluationFixture,
  releaseCandidateFixture,
  releasePolicyRepositoryFixture,
} from "@proofstack/core/testing";
import { describe, expect, it, vi } from "vitest";
import {
  capturePolicyArtifactEvidence,
  type PolicyArtifactEvidenceRepositories,
} from "./capture-artifact-evidence.js";
import { inspectCapturedEvaluationTrust } from "./capture-evaluation-trust.js";
import * as publicApi from "./index.js";

interface Fields {
  [key: string]: unknown;
  artifactId?: unknown;
  sha256?: unknown;
  datasetVersionId?: unknown;
  fixtureVersionId?: unknown;
  definitionSha256?: unknown;
}
const evaluationTime = "2026-10-01T00:00:00.0000004Z";
const observedAt = "2026-10-01T01:00:00.000Z";
const limits = { maxReferences: 10000, maxReferenceBytes: 8_388_608 };

async function harness(mutate?: (fixture: EvaluationRepositoryFixtureRecord) => void) {
  const evaluation = createEvaluationRepositoryTestHarness("evaluation_trust");
  const { scope } = evaluation;
  const contents = new Map<string, { reference: ContentReference; bytes: Buffer }>();
  const rewrittenHashes = new Map<string, string>();
  const normalize = (input: unknown): void => {
    if (!input || typeof input !== "object") return;
    const value = input as Fields;
    if (typeof value.artifactId === "string" && typeof value.sha256 === "string") {
      // These are synthetic fixtures with actual retained encrypted bytes, not source truth.
      const bytes = Buffer.from(encodeEvaluationCanonicalJson(value));
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      Object.assign(value, {
        artifactId: `trust_${sha256.slice(0, 24)}`,
        sha256,
        sizeBytes: bytes.byteLength,
      });
      contents.set(value.artifactId as string, {
        reference: structuredClone(value) as ContentReference,
        bytes,
      });
      return;
    }
    if (value.datasetVersionId === "dtv_regression_v1") value.definitionSha256 = "7".repeat(64);
    if (value.fixtureVersionId === "fxv_boundary") value.definitionSha256 = "2".repeat(64);
    const hash = value.definitionSha256;
    if (typeof hash === "string" && rewrittenHashes.has(hash))
      value.definitionSha256 = rewrittenHashes.get(hash);
    for (const [key, child] of Object.entries(value)) {
      if (child === "env_local") value[key] = scope.environmentId;
      else normalize(child);
    }
  };
  for (const fixture of evaluation.records) {
    const originalHash = fixture.record.definitionSha256;
    normalize(fixture.record);
    if (fixture.kind === "criterion_set")
      fixture.record.publishedByPrincipalId = "usr_criterion_author";
    if (fixture.kind === "evaluator_spec")
      fixture.record.publishedByPrincipalId = "usr_evaluator_author";
    if (fixture.kind === "oracle_spec") fixture.record.publishedByPrincipalId = "usr_oracle_author";
    if (fixture.kind === "qualification_fixture_set")
      fixture.record.publishedByPrincipalId = "usr_fixture_curator";
    if (fixture.kind === "source_reviewer_qualification")
      fixture.record.reviewerPrincipalId = "usr_source_reviewer";
    if (fixture.kind === "source_review") {
      fixture.record.reviewedByPrincipalId = "usr_source_reviewer";
      fixture.record.declaredRelationships = [];
    }
    if (fixture.kind === "qualification_report") {
      fixture.record.executedByPrincipalId = "wrk_qualification";
      fixture.record.startedAt = "2026-09-02T00:00:00.000Z";
      fixture.record.completedAt = "2026-09-02T00:00:00.000Z";
      fixture.record.validFrom = "2026-09-02T00:00:00.000Z";
    }
    if (fixture.kind === "evaluation_run") {
      fixture.record.createdByPrincipalId = "usr_task_requester";
      fixture.record.applicability.context.populationTags = ["adult users"];
      fixture.record.applicability.context.jurisdiction = "kr";
      fixture.record.applicability.context.riskTier = "high";
      fixture.record.applicability.context.taskKind = "task_support";
      fixture.record.applicability.contextSha256 = createHash("sha256")
        .update(encodeEvaluationCanonicalJson(fixture.record.applicability.context))
        .digest("hex");
    }
    mutate?.(fixture);
    const definition = structuredClone(fixture.record) as unknown as Fields;
    for (const key of evaluationRecordDescriptors[fixture.kind].receiptKeys) delete definition[key];
    fixture.record.definitionSha256 = digestEvaluationRecordDefinition(
      fixture.kind,
      scope,
      definition,
    );
    rewrittenHashes.set(originalHash, fixture.record.definitionSha256);
    await publishEvaluationFixture(evaluation.repository, fixture);
  }
  const assessment = evaluation.records.find((f) => f.kind === "assessment");
  const run = evaluation.records.find((f) => f.kind === "evaluation_run");
  if (assessment?.kind !== "assessment" || run?.kind !== "evaluation_run")
    throw new Error("Missing graph roots");
  const candidate: ReleaseCandidate = {
    ...releaseCandidateFixture("evaluation_trust", scope),
    assessments: [
      {
        assessmentId: assessment.record.assessmentId,
        definitionSha256: assessment.record.definitionSha256,
      },
    ],
    datasets: [run.record.dataset],
    targetRelease: run.record.replay.targetRelease,
    modelAssuranceAssessments: [],
  };
  const {
    createdAt: _ca,
    createdByPrincipalId: _cb,
    definitionSha256: _ch,
    schemaVersion: _cv,
    scope: _cs,
    ...candidateDefinition
  } = candidate;
  candidate.definitionSha256 = digestReleaseCandidateDefinition(scope, candidateDefinition);
  const policy: ReleasePolicy = releasePolicyRepositoryFixture("evaluation_trust", scope);
  for (const rule of policy.rules) {
    if ("assessment" in rule.predicate && "assessmentId" in rule.predicate.assessment) {
      rule.predicate.assessment.assessmentId = assessment.record.assessmentId;
      rule.predicate.assessment.definitionSha256 = assessment.record.definitionSha256;
    }
  }
  const {
    publishedAt: _pa,
    publishedByPrincipalId: _pb,
    definitionSha256: _ph,
    schemaVersion: _pv,
    scope: _ps,
    ...policyDefinition
  } = policy;
  policy.definitionSha256 = digestReleasePolicyDefinition(scope, policyDefinition);
  const candidates = new MemoryReleaseCandidateRepository();
  const policies = new MemoryReleasePolicyRepository();
  await candidates.publishReleaseCandidate(candidate);
  await policies.publishReleasePolicy(policy);
  const absent = new Proxy({}, { get: () => async () => null });
  const repositories = {
    control: {
      comparison: absent,
      installationBinding: absent,
      releaseCandidate: candidates,
      releasePolicy: policies,
    },
    evidence: { evaluation: evaluation.repository, modelAssurance: absent },
    datasets: absent,
    replayDefinitions: absent,
    replayResults: absent,
    runtimeDefinitions: absent,
  } as unknown as PolicyArtifactEvidenceRepositories;
  const definition: PolicyEvaluationRequestDefinition = {
    algorithm: { id: "proofstack.deterministic-policy", version: "1.0.0" },
    evaluationRequestId: "request_evaluation_trust",
    evaluationTime,
    candidate: releaseCandidateReference(candidate),
    policy: releasePolicyReference(policy),
    limits: {
      heartbeatIntervalMilliseconds: 1000,
      leaseDurationMilliseconds: 5000,
      maxAcquisitionRecordBytes: limits.maxReferenceBytes,
      maxAcquisitionRecords: limits.maxReferences,
      maxArtifactReadBytes: 8_388_608,
      maxAttempts: 2,
      maxRuleEvaluations: 256,
      perAttemptTimeoutMilliseconds: 20000,
      retryBackoffMilliseconds: 100,
      retryableErrors: ["source_revision_changed"],
      totalDeadlineMilliseconds: 60000,
    },
  };
  const request = (changes: Partial<PolicyEvaluationRequestDefinition> = {}) => {
    const body = { ...definition, ...changes };
    return {
      ...body,
      schemaVersion: "0.1" as const,
      scope,
      createdAt: observedAt,
      createdByPrincipalId: "principal_request",
      definitionSha256: digestPolicyEvaluationRequestDefinition(scope, body),
    };
  };
  const actor = PrincipalContextSchema.parse({
    authentication: { authenticatedAt: "2026-01-01T00:00:00.000Z", method: "development" },
    capabilities: ["artifact:read", "artifact:read:restricted"],
    principalId: "principal_capture",
    principalType: "service",
    requestId: "request_capture",
    resourceScope: { mode: "tenant" },
    roles: ["viewer"],
    tenantId: scope.tenantId,
  });
  const catalog = new MemoryArtifactCatalogRepository();
  const objects = new MemoryArtifactObjectStore();
  const encryption = new ArtifactCipher(
    new LocalArtifactKeyring({
      activeKeyId: "key_trust",
      keys: { key_trust: new Uint8Array(32).fill(19) },
    }),
  );
  for (const { reference, bytes } of contents.values()) {
    const metadata: ArtifactMetadata = {
      schemaVersion: "0.1",
      scope,
      createdAt: "2026-01-01T00:00:00.000Z",
      state: "reserved",
      contentReference: reference,
      redaction: { status: "not_required" },
      retention: { mode: "expire", expiresAt: "2028-01-01T00:00:00.000Z" },
    };
    const plan = await encryption.createPlan(metadata);
    const objectKey = `objects/v1/${reference.artifactId}`;
    await catalog.reserve({
      metadata,
      encryption: plan,
      objectKey,
      createdByPrincipalId: "principal_writer",
    });
    const encrypted = await encryption.encrypt(metadata, plan, bytes);
    await objects.putIfAbsent(objectKey, encrypted.bytes);
    await catalog.activate(
      scope,
      reference.artifactId,
      encrypted.receipt,
      "2026-01-01T00:01:00.000Z",
    );
  }
  const evidence = new MemoryEvidenceRepository();
  const dependencies = { catalog, objects, encryption, clock: { now: () => new Date(observedAt) } };
  const execute = async (changes: Partial<PolicyEvaluationRequestDefinition> = {}) => {
    const capture = await capturePolicyArtifactEvidence(
      request(changes),
      actor,
      repositories,
      evidence,
      dependencies,
    );
    if (
      capture.status !== "artifacts_captured" ||
      capture.traceCapture.status !== "traces_captured"
    )
      throw new Error("Expected capture");
    return { capture, graph: capture.traceCapture.comparisonCapture.graph };
  };
  return { execute, evaluation, repositories, request, actor, evidence, dependencies };
}

describe("retained evaluation trust prerequisites", () => {
  it.each([
    "duplicate_node",
    "duplicate_edge",
    "missing_edge",
    "edge_parent_hash",
    "edge_parent_source",
    "edge_target",
    "edge_reference",
    "missing_child",
    "child_source",
    "artifact_edge_target",
    "artifact_edge_reference",
    "duplicate_artifact",
    "missing_artifact",
    "artifact_reference",
    "artifact_scope",
    "artifact_time",
    "artifact_origin",
  ] as const)("rejects original provenance corruption: %s", async (kind) => {
    const h = await harness();
    const { capture, graph } = await h.execute();
    const changed = structuredClone(graph);
    const artifacts = structuredClone([...capture.artifacts]);
    const parent = capture.evaluationTrust.parents[0];
    const firstEdgeIndex = parent?.dependencyEdgeIndexes[0];
    const firstArtifactIndex = parent?.artifactCaptureIndexes[0];
    if (firstEdgeIndex === undefined || firstArtifactIndex === undefined)
      throw new Error("Missing provenance fixture");
    const edge = changed.edges[firstEdgeIndex];
    const captured = artifacts[firstArtifactIndex];
    if (!edge?.target || !captured || captured.origin.kind !== "record")
      throw new Error("Missing provenance inputs");
    const target = edge.target;
    const node = changed.nodes.find(
      (n) =>
        policyEvaluationSourceReferenceKey(n.read.source) ===
        policyEvaluationSourceReferenceKey(target),
    );
    const artifactEdge = changed.edges[captured.origin.edgeIndex];
    if (!node || !artifactEdge) throw new Error("Missing exact target");
    if (kind === "duplicate_node") Object.assign(changed, { nodes: [...changed.nodes, node] });
    if (kind === "duplicate_edge") Object.assign(changed, { edges: [...changed.edges, edge] });
    if (kind === "missing_edge")
      Object.assign(changed, { edges: changed.edges.filter((_, i) => i !== firstEdgeIndex) });
    if (kind === "edge_parent_hash") Object.assign(edge, { parentRecordSha256: "f".repeat(64) });
    if (kind === "edge_parent_source")
      Object.assign(edge, {
        parent: {
          ...edge.parent,
          reference: { ...edge.parent.reference, definitionSha256: "f".repeat(64) },
        },
      });
    if (kind === "edge_target")
      Object.assign(edge, {
        target: { ...target, reference: { ...target.reference, definitionSha256: "f".repeat(64) } },
      });
    if (kind === "edge_reference")
      Object.assign(edge, {
        reference: {
          kind: "artifact",
          path: edge.reference.path,
          reference: captured.read.reference,
        },
      });
    if (kind === "missing_child")
      Object.assign(changed, { nodes: changed.nodes.filter((n) => n !== node) });
    if (kind === "child_source")
      Object.assign(node.read.source.reference, { definitionSha256: "f".repeat(64) });
    if (kind === "artifact_edge_target") Object.assign(artifactEdge, { target });
    if (kind === "artifact_edge_reference")
      Object.assign(artifactEdge, {
        reference: {
          kind: "artifact",
          path: artifactEdge.reference.path,
          reference: { ...captured.read.reference, sha256: "f".repeat(64) },
        },
      });
    if (kind === "duplicate_artifact") artifacts.push(structuredClone(captured));
    if (kind === "missing_artifact") artifacts.splice(firstArtifactIndex, 1);
    if (kind === "artifact_reference")
      Object.assign(captured.read.reference, { sha256: "f".repeat(64) });
    if (kind === "artifact_scope") Object.assign(captured.read.scope, { tenantId: "tenant_other" });
    if (kind === "artifact_time")
      Object.assign(captured.read, { evaluationTime: "2026-10-01T00:00:00.0000005Z" });
    if (kind === "artifact_origin")
      Object.assign(captured, { origin: { kind: "trace", artifactReferenceIndex: 0 } });
    expect(() => inspectCapturedEvaluationTrust(changed, artifacts, limits)).toThrow(
      expect.objectContaining({
        reason: [
          "duplicate_artifact",
          "missing_artifact",
          "artifact_reference",
          "artifact_scope",
          "artifact_time",
          "artifact_origin",
        ].includes(kind)
          ? "observation_conflict"
          : "reference_conflict",
      }),
    );
  });

  it("rejects contradictory availability at repeated occurrences", async () => {
    const h = await harness();
    const { capture, graph } = await h.execute();
    const parent = capture.evaluationTrust.parents[0];
    const artifacts = structuredClone([...capture.artifacts]);
    const seen = new Map<string, number>();
    let repeated: number | undefined;
    for (const index of parent?.artifactCaptureIndexes ?? []) {
      const reference = artifacts[index]?.read.reference;
      if (!reference) throw new Error("Missing artifact");
      const key = JSON.stringify(reference);
      const previous = seen.get(key);
      if (previous !== undefined && previous !== index) {
        repeated = index;
        break;
      }
      seen.set(key, index);
    }
    const repeatedCapture = repeated === undefined ? undefined : artifacts[repeated];
    if (!repeatedCapture) throw new Error("Missing repeated artifact fixture");
    Object.assign(repeatedCapture.read, { observation: { status: "missing" } });
    expect(() => inspectCapturedEvaluationTrust(graph, artifacts, limits)).toThrow(
      expect.objectContaining({ reason: "observation_conflict" }),
    );
  });

  it("uses exact original runs and actual retained bytes without claiming complete authority", async () => {
    const h = await harness();
    const { capture, graph } = await h.execute();
    expect(capture.evaluationTrust.parents).toHaveLength(2);
    expect(capture.evaluationTrust.unavailableParents).toEqual([]);
    for (const parent of capture.evaluationTrust.parents) {
      expect(parent.evaluationTime).toBe(evaluationTime);
      expect(parent.observation).toEqual({
        status: "inspected",
        requirements: {
          evaluationTime,
          status: "eligible",
          reasons: [],
        },
      });
      const run = graph.nodes.find(
        (n) =>
          policyEvaluationSourceReferenceKey(n.read.source) ===
          policyEvaluationSourceReferenceKey(parent.source),
      );
      expect(run?.read.observation).toEqual({
        status: "verified",
        recordSha256: parent.recordSha256,
      });
      expect(parent.artifactCaptureIndexes.length).toBeGreaterThan(0);
      for (const index of parent.artifactCaptureIndexes)
        expect(capture.artifacts[index]?.read.observation.status).toBe("verified");
    }
    // Other deliberately absent domains remain absent: this report is not whole-graph success.
    expect(graph.unresolved.records).toBeGreaterThan(0);
    expect(publicApi).not.toHaveProperty("inspectCapturedEvaluationTrust");
  });

  it.each([
    ["findSourceSnapshot", "source_snapshot_unavailable"],
    ["findSourceReview", "source_review_unavailable"],
    ["findSourceReviewerQualification", "reviewer_qualification_unavailable"],
    ["findCriterionSetStatus", "criterion_status_unavailable"],
    ["findQualificationReport", "qualification_report_unavailable"],
    ["findQualificationFixtureSet", "qualification_fixture_set_unavailable"],
  ] as const)("retains missing %s as an unavailable prerequisite", async (method, reason) => {
    const h = await harness();
    vi.spyOn(h.evaluation.repository, method).mockResolvedValue(null);
    const { capture } = await h.execute();
    for (const parent of capture.evaluationTrust.parents) {
      expect(parent.observation).toEqual({
        status: "inspected",
        requirements: {
          evaluationTime,
          status: "unverifiable",
          reasons: [reason],
        },
      });
    }
    expect(capture.evaluationTrust.parents).toHaveLength(2);
  });

  it("keeps missing criterion sets and unreadable runs explicit", async () => {
    const h = await harness();
    vi.spyOn(h.evaluation.repository, "findCriterionSet").mockResolvedValue(null);
    const missingSet = await h.execute();
    expect(missingSet.capture.evaluationTrust.parents).toHaveLength(2);
    for (const parent of missingSet.capture.evaluationTrust.parents) {
      expect(parent.observation).toEqual({
        status: "unavailable",
        reason: "criterion_set_unavailable",
      });
      expect(parent.dependencyEdgeIndexes).toHaveLength(1);
      expect(parent.artifactCaptureIndexes).toEqual([]);
    }
    vi.spyOn(h.evaluation.repository, "findEvaluationRun").mockResolvedValue(null);
    const missingRuns = await h.execute();
    expect(missingRuns.capture.evaluationTrust.parents).toEqual([]);
    expect(missingRuns.capture.evaluationTrust.unavailableParents).toHaveLength(2);
    expect(
      missingRuns.capture.evaluationTrust.unavailableParents.every(
        (p) => p.observation.status === "missing",
      ),
    ).toBe(true);
  });

  it("checks original run independence, not the artifact reader's identity", async () => {
    const h = await harness();
    h.actor.principalId = "usr_source_reviewer";
    const normal = await h.execute();
    expect(
      normal.capture.evaluationTrust.parents.every(
        (p) =>
          p.observation.status === "inspected" && p.observation.requirements.status === "eligible",
      ),
    ).toBe(true);
    const requester = await harness((f) => {
      if (f.kind === "evaluation_run") f.record.createdByPrincipalId = "usr_source_reviewer";
    });
    const result = await requester.execute();
    for (const parent of result.capture.evaluationTrust.parents)
      expect(parent.observation).toEqual({
        status: "inspected",
        requirements: {
          evaluationTime,
          status: "require_approval",
          reasons: ["requester_only_review"],
        },
      });
  });

  it("requires actual readable artifacts, preserving all missing evidence categories", async () => {
    const h = await harness();
    vi.spyOn(h.dependencies.objects, "get").mockResolvedValue(null);
    const { capture } = await h.execute();
    for (const parent of capture.evaluationTrust.parents)
      expect(parent.observation).toEqual({
        status: "inspected",
        requirements: {
          evaluationTime,
          status: "unverifiable",
          reasons: [
            "qualification_evidence_unavailable",
            "reviewer_qualification_evidence_unavailable",
            "source_content_unavailable",
            "source_identity_evidence_unavailable",
            "source_review_basis_unavailable",
          ],
        },
      });
  });

  it("retains an explicitly unverified identity and an absent reviewer credential", async () => {
    const h = await harness((f) => {
      if (f.kind === "source_snapshot")
        f.record.identityVerification = {
          status: "unverified",
          reason: "Identity evidence has not been verified",
        };
      if (f.kind === "source_review") delete f.record.reviewerQualification;
    });
    const { capture } = await h.execute();
    for (const parent of capture.evaluationTrust.parents)
      expect(parent.observation).toEqual({
        status: "inspected",
        requirements: {
          evaluationTime,
          status: "ineligible",
          reasons: ["reviewer_qualification_unavailable", "source_identity_unverified"],
        },
      });
  });

  it("does not replace a missing subject with a different available specification", async () => {
    const h = await harness();
    vi.spyOn(h.evaluation.repository, "findEvaluatorSpec").mockResolvedValue(null);
    const { capture, graph } = await h.execute();
    expect(
      graph.nodes.some(
        (n) => n.read.source.kind === "evaluator_spec" && n.read.observation.status === "missing",
      ),
    ).toBe(true);
    for (const parent of capture.evaluationTrust.parents) {
      if (parent.observation.status !== "inspected") throw new Error("Missing prerequisite result");
      expect(parent.observation.requirements.reasons).toEqual([
        "qualification_reference_mismatch",
        "qualification_report_unavailable",
      ]);
      expect(parent.observation.requirements.status).not.toBe("eligible");
    }
  });

  it("charges repeated selected reports without inventing the omitted oracle qualification", async () => {
    const h = await harness((f) => {
      if (f.kind === "evaluation_run")
        f.record.oracleQualification = structuredClone(f.record.evaluatorQualification);
    });
    const { capture, graph } = await h.execute();
    for (const parent of capture.evaluationTrust.parents) {
      expect(parent.observation).toEqual({
        status: "inspected",
        requirements: {
          evaluationTime,
          status: "unverifiable",
          reasons: ["qualification_report_unavailable"],
        },
      });
      const paths = parent.dependencyEdgeIndexes.map((i) => graph.edges[i]?.reference.path);
      expect(paths).toContain("/evaluatorQualification");
      expect(paths).toContain("/oracleQualification");
      expect(paths.filter((p) => p === "/subject/evaluator")).toHaveLength(2);
    }
  });

  it.each(["source", "status", "review", "reviewer", "qualification"] as const)(
    "rechecks %s expiry at the exact policy cut",
    async (kind) => {
      const boundary = "2026-10-01T00:00:00.0000005Z";
      const h = await harness((f) => {
        if (kind === "source" && f.kind === "source_snapshot") f.record.expiresAt = boundary;
        if (
          kind === "status" &&
          f.kind === "criterion_set_status" &&
          f.record.status === "approved"
        )
          f.record.expiresAt = boundary;
        if (kind === "review" && f.kind === "source_review") f.record.validUntil = boundary;
        if (kind === "reviewer" && f.kind === "source_reviewer_qualification")
          f.record.validUntil = boundary;
        if (kind === "qualification" && f.kind === "qualification_report")
          f.record.validUntil = boundary;
      });
      const before = await h.execute();
      const at = await h.execute({ evaluationTime: boundary });
      expect(
        before.capture.evaluationTrust.parents.every(
          (p) =>
            p.observation.status === "inspected" &&
            p.observation.requirements.status === "eligible",
        ),
      ).toBe(true);
      const reason = {
        source: "source_not_current",
        status: "criterion_status_not_current",
        review: "source_review_not_current",
        reviewer: "reviewer_qualification_not_current",
        qualification: "qualification_not_current",
      }[kind];
      for (const parent of at.capture.evaluationTrust.parents)
        expect(parent.observation).toEqual({
          status: "inspected",
          requirements: {
            evaluationTime: boundary,
            status: kind === "reviewer" ? "unverifiable" : "ineligible",
            reasons: [reason],
          },
        });
    },
  );

  it("does not round future source effectiveness into a valid prerequisite", async () => {
    const h = await harness((f) => {
      if (f.kind === "source_snapshot") f.record.effectiveAt = "2026-10-01T00:00:00.0000005Z";
    });
    const { capture } = await h.execute();
    for (const parent of capture.evaluationTrust.parents)
      expect(parent.observation).toEqual({
        status: "inspected",
        requirements: { evaluationTime, status: "ineligible", reasons: ["source_not_effective"] },
      });
  });

  it("preserves original scope mismatches instead of inventing a matching context", async () => {
    const h = await harness((f) => {
      if (f.kind === "evaluation_run") {
        f.record.applicability.context.locale = "fr";
        f.record.applicability.contextSha256 = createHash("sha256")
          .update(encodeEvaluationCanonicalJson(f.record.applicability.context))
          .digest("hex");
      }
    });
    const { capture } = await h.execute();
    for (const parent of capture.evaluationTrust.parents)
      expect(parent.observation).toEqual({
        status: "inspected",
        requirements: { evaluationTime, status: "ineligible", reasons: ["source_scope_mismatch"] },
      });
  });

  it("meters every repeated exact dependency and returns detached observations", async () => {
    const h = await harness();
    const { capture, graph } = await h.execute();
    const report = capture.evaluationTrust;
    const meter = new PolicyEvaluationReferenceCollector(limits);
    const indexes = report.parents.flatMap((p) => p.dependencyEdgeIndexes);
    for (const index of indexes) {
      const edge = graph.edges[index];
      if (!edge) throw new Error("Missing dependency edge");
      if (edge.reference.kind === "record")
        meter.record(
          edge.reference.path,
          edge.reference.source.kind,
          edge.reference.source.reference,
        );
      else if (edge.reference.kind === "artifact")
        meter.artifact(edge.reference.path, edge.reference.reference);
      else throw new Error("Unexpected trust dependency");
    }
    const expected = meter.result();
    expect(report.inspectionUsage).toEqual({
      references: indexes.length,
      referenceBytes: expected.referenceBytes,
    });
    expect(new Set(indexes).size).toBeLessThan(indexes.length);
    expect(new Set(report.parents.flatMap((p) => p.artifactCaptureIndexes)).size).toBeLessThan(
      report.parents.reduce((n, p) => n + p.artifactCaptureIndexes.length, 0),
    );
    const exact = { maxReferences: indexes.length, maxReferenceBytes: expected.referenceBytes };
    expect(inspectCapturedEvaluationTrust(graph, capture.artifacts, exact)).toEqual(report);
    expect(() =>
      inspectCapturedEvaluationTrust(graph, capture.artifacts, {
        ...exact,
        maxReferences: exact.maxReferences - 1,
      }),
    ).toThrow(expect.objectContaining({ reason: "reference_limit_exceeded" }));
    expect(() =>
      inspectCapturedEvaluationTrust(graph, capture.artifacts, {
        ...exact,
        maxReferenceBytes: exact.maxReferenceBytes - 1,
      }),
    ).toThrow(expect.objectContaining({ reason: "reference_bytes_exceeded" }));
    const copy = inspectCapturedEvaluationTrust(graph, capture.artifacts, limits);
    expect(copy.parents[0]?.source).not.toBe(report.parents[0]?.source);
    expect(copy.parents[0]?.dependencyEdgeIndexes).not.toBe(
      report.parents[0]?.dependencyEdgeIndexes,
    );
    expect(copy.parents[0]?.observation).not.toBe(report.parents[0]?.observation);
  });

  it.each(["references", "bytes"] as const)(
    "admits exact combined %s and fails one below before recheck",
    async (dimension) => {
      const h = await harness();
      const { capture } = await h.execute();
      expect(capture.usage.references).toBe(
        capture.traceCapture.usage.references +
          capture.policyAuthority.inspectionUsage.references +
          capture.evaluationTrust.inspectionUsage.references,
      );
      expect(capture.usage.referenceBytes).toBe(
        capture.traceCapture.usage.referenceBytes +
          capture.policyAuthority.inspectionUsage.referenceBytes +
          capture.evaluationTrust.inspectionUsage.referenceBytes +
          capture.usage.sourceGuards.canonicalBytes,
      );
      const exact = {
        ...h.request().limits,
        maxAcquisitionRecords: capture.usage.references,
        maxAcquisitionRecordBytes: capture.usage.bytes + capture.usage.referenceBytes,
      };
      expect((await h.execute({ limits: exact })).capture.usage).toEqual(capture.usage);
      const sourceTransactions = {
        run: vi.fn(async () => {
          throw new Error("Over-budget capture opened transaction");
        }),
      };
      const below = {
        ...exact,
        ...(dimension === "references"
          ? { maxAcquisitionRecords: exact.maxAcquisitionRecords - 1 }
          : { maxAcquisitionRecordBytes: exact.maxAcquisitionRecordBytes - 1 }),
      };
      await expect(
        capturePolicyArtifactEvidence(
          h.request({ limits: below }),
          h.actor,
          h.repositories,
          h.evidence,
          { ...h.dependencies, sourceTransactions },
        ),
      ).rejects.toMatchObject({
        reason: dimension === "references" ? "reference_limit" : "byte_limit",
      });
      expect(sourceTransactions.run).not.toHaveBeenCalled();
    },
  );
});
