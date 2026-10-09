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
  type ReleaseCandidate,
  type ReleasePolicyApplicability,
  PrincipalContextSchema,
  policyEvaluationSourceReferenceKey,
} from "@proofstack/contracts";
import {
  digestPolicyEvaluationRequestDefinition,
  digestReleaseCandidateDefinition,
  PolicyEvaluationReferenceCollector,
  releaseCandidateReference,
  releasePolicyReference,
  StaticPolicyInstallationBindingResolver,
} from "@proofstack/core";
import {
  MemoryEvaluationRepository,
  MemoryEvidenceRepository,
  MemoryReleaseCandidateRepository,
  MemoryReleasePolicyRepository,
  type PolicyAuthorityFixtureOptions,
  policyAuthorityFixture,
  releaseCandidateFixture,
  releasePolicyLifecycleFixture,
  releasePolicyRepositoryFixture,
} from "@proofstack/core/testing";
import { describe, expect, it, vi } from "vitest";
import {
  capturePolicyArtifactEvidence,
  type PolicyArtifactCapture,
  type PolicyArtifactEvidenceRepositories,
} from "./capture-artifact-evidence.js";
import { inspectCapturedPolicyAuthority } from "./capture-policy-authority.js";
import { inspectCapturedPolicyApplicability } from "./capture-policy-applicability.js";
import type { PolicyRecordGraph } from "./capture-record-graph.js";
import * as publicApi from "./index.js";

const limits = { maxReferences: 10000, maxReferenceBytes: 8_388_608 };
const evaluationTime = "2026-10-01T00:00:00.000Z";
const observedAt = "2026-10-01T02:00:00.000Z";

async function harness(
  options: PolicyAuthorityFixtureOptions = {},
  counterevidence = false,
  conflicted = false,
  mutateCandidate?: (candidate: ReleaseCandidate) => void,
) {
  const contents = new Map<string, { reference: ContentReference; bytes: Buffer }>();
  const normalize = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    const fields = value as Record<string, unknown>;
    if (typeof fields["artifactId"] === "string" && typeof fields["sha256"] === "string") {
      if (contents.has(fields["artifactId"])) return;
      // The source vectors contain example hashes. Publish genuine retained bytes, with unique
      // IDs for distinct descriptors, before hashing the containing authority definitions.
      const bytes = Buffer.from(encodeEvaluationCanonicalJson(value));
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      fields["artifactId"] = `authority_${sha256.slice(0, 24)}`;
      fields["sha256"] = sha256;
      fields["sizeBytes"] = bytes.byteLength;
      contents.set(fields["artifactId"] as string, {
        reference: structuredClone(value) as ContentReference,
        bytes,
      });
      return;
    }
    for (const child of Object.values(fields)) normalize(child);
  };
  const makeFixture = (mutate: PolicyAuthorityFixtureOptions) =>
    policyAuthorityFixture({
      mutateSource: (source) => {
        delete source.discovery;
        mutate.mutateSource?.(source);
        normalize(source);
      },
      mutateReviewer: (reviewer) => {
        delete reviewer.predecessor;
        mutate.mutateReviewer?.(reviewer);
        normalize(reviewer);
      },
      mutateReview: (review) => {
        delete review.supersedesReview;
        mutate.mutateReview?.(review);
        normalize(review);
      },
      mutateBinding: (binding) => {
        mutate.mutateBinding?.(binding);
        normalize(binding);
      },
      mutatePolicy: (policy) => {
        mutate.mutatePolicy?.(policy);
      },
    });
  const counter = counterevidence
    ? makeFixture({
        mutateSource: (s) => {
          s.sourceSnapshotId = "source_counter";
        },
        mutateReviewer: (q) => {
          q.qualificationId = "qualification_counter";
        },
        mutateReview: (r) => {
          r.sourceReviewId = "review_counter";
          r.outcome = "require_approval";
        },
      })
    : undefined;
  const fixture = makeFixture({
    ...options,
    mutateSource: (source) => {
      if (conflicted && counter)
        source.conflictsWith = [
          {
            sourceSnapshotId: counter.source.sourceSnapshotId,
            definitionSha256: counter.source.definitionSha256,
          },
        ];
      options.mutateSource?.(source);
    },
    mutateReview: (review) => {
      if (conflicted && counter) {
        review.criticalConflictStatus = "unresolved";
        review.outcome = "require_approval";
        review.reviewedConflicts = [
          {
            sourceSnapshotId: counter.source.sourceSnapshotId,
            definitionSha256: counter.source.definitionSha256,
          },
        ];
      }
      options.mutateReview?.(review);
    },
    mutatePolicy: (policy) => {
      if (counter)
        policy.counterevidence = [
          {
            source: {
              sourceSnapshotId: counter.source.sourceSnapshotId,
              definitionSha256: counter.source.definitionSha256,
            },
            review: {
              sourceReviewId: counter.review.sourceReviewId,
              definitionSha256: counter.review.definitionSha256,
            },
          },
        ];
      options.mutatePolicy?.(policy);
    },
  });
  const { scope } = fixture.policy;
  const evaluation = new MemoryEvaluationRepository();
  for (const record of [...(counter ? [counter] : []), fixture]) {
    await evaluation.publishSourceSnapshot(record.source);
    await evaluation.publishSourceReviewerQualification(record.reviewer);
    await evaluation.publishSourceReview(record.review);
  }
  const candidate = releaseCandidateFixture("authority_graph", scope);
  mutateCandidate?.(candidate);
  const {
    scope: _candidateScope,
    schemaVersion: _candidateVersion,
    definitionSha256: _candidateHash,
    createdAt: _candidateAt,
    createdByPrincipalId: _candidateBy,
    ...candidateDefinition
  } = candidate;
  candidate.definitionSha256 = digestReleaseCandidateDefinition(scope, candidateDefinition);
  const candidates = new MemoryReleaseCandidateRepository();
  const policies = new MemoryReleasePolicyRepository();
  await candidates.publishReleaseCandidate(candidate);
  await policies.publishReleasePolicy(fixture.policy);
  const installation = new StaticPolicyInstallationBindingResolver([fixture.binding]);
  const absent = new Proxy({}, { get: () => async () => null });
  const repositories = {
    control: {
      comparison: absent,
      installationBinding: installation,
      releaseCandidate: candidates,
      releasePolicy: policies,
    },
    evidence: { evaluation, modelAssurance: absent },
    datasets: absent,
    replayDefinitions: absent,
    replayResults: absent,
    runtimeDefinitions: absent,
  } as unknown as PolicyArtifactEvidenceRepositories;
  const definition: PolicyEvaluationRequestDefinition = {
    algorithm: { id: "proofstack.deterministic-policy", version: "1.0.0" },
    evaluationRequestId: "request_authority",
    evaluationTime,
    candidate: releaseCandidateReference(candidate),
    policy: releasePolicyReference(fixture.policy),
    limits: {
      heartbeatIntervalMilliseconds: 1000,
      leaseDurationMilliseconds: 5000,
      maxAcquisitionRecordBytes: limits.maxReferenceBytes,
      maxAcquisitionRecords: limits.maxReferences,
      maxArtifactReadBytes: 1_048_576,
      maxAttempts: 2,
      maxRuleEvaluations: 256,
      perAttemptTimeoutMilliseconds: 20000,
      retryBackoffMilliseconds: 100,
      retryableErrors: ["source_revision_changed"],
      totalDeadlineMilliseconds: 60000,
    },
  };
  const requestAt = (at = evaluationTime) => {
    const body = { ...definition, evaluationTime: at };
    return {
      ...body,
      schemaVersion: "0.1" as const,
      scope,
      createdAt: "2026-10-01T01:00:00.000Z",
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
      activeKeyId: "key_authority",
      keys: { key_authority: new Uint8Array(32).fill(11) },
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
  const originalGet = objects.get.bind(objects);
  const get = vi.spyOn(objects, "get");
  const find = vi.spyOn(catalog, "find");
  const binding = vi.spyOn(installation, "resolve");
  const source = vi.spyOn(evaluation, "findSourceSnapshot");
  const review = vi.spyOn(evaluation, "findSourceReview");
  const qualification = vi.spyOn(evaluation, "findSourceReviewerQualification");
  const policy = vi.spyOn(policies, "findReleasePolicy");
  const history = vi.spyOn(policies, "listReleasePolicyLifecycleEvents");
  const dependencies = { catalog, objects, encryption, clock: { now: () => new Date(observedAt) } };
  const execute = async (at = evaluationTime) => {
    const output = await capturePolicyArtifactEvidence(
      requestAt(at),
      actor,
      repositories,
      evidence,
      dependencies,
    );
    if (output.status !== "artifacts_captured") throw new Error("Expected artifact capture");
    return output;
  };
  return {
    fixture,
    candidate,
    counter,
    execute,
    requestAt,
    actor,
    repositories,
    evidence,
    dependencies,
    get,
    originalGet,
    find,
    binding,
    source,
    review,
    qualification,
    policy,
    policies,
    history,
  };
}

type Capture = Awaited<ReturnType<Awaited<ReturnType<typeof harness>>["execute"]>>;
function graphOf(capture: Capture) {
  if (capture.traceCapture.status !== "traces_captured") throw new Error("Expected trace capture");
  return capture.traceCapture.comparisonCapture.graph;
}
function reasons(capture: Capture) {
  return capture.policyAuthority.requirements.findings.map(({ reason }) => reason);
}

describe("candidate-bound policy applicability inputs", () => {
  const any: ReleasePolicyApplicability = {
    jurisdiction: { operator: "any" },
    locale: { operator: "any" },
    maximumDataClassification: { operator: "any" },
    populationTags: { operator: "any" },
    purpose: { operator: "any" },
    riskTier: { operator: "any" },
    taskKind: { operator: "any" },
  };
  const setup = (
    selectors: Partial<ReleasePolicyApplicability> = {},
    target?: (candidate: ReleaseCandidate) => void,
  ) =>
    harness(
      {
        mutatePolicy: (policy) => {
          policy.applicability = { ...structuredClone(any), ...selectors };
        },
      },
      false,
      false,
      target,
    );

  it("retains seven exact root-bound dimensions without exposing an evaluator or publication authority", async () => {
    const h = await setup();
    const output = await h.execute();
    const report = output.applicability;
    expect(report.conjunction).toBe("match");
    expect(report.dimensions.map(({ field }) => field)).toEqual(Object.keys(any));
    expect(report.dimensions).toHaveLength(7);
    for (const dimension of report.dimensions) {
      expect(dimension).toEqual({
        field: dimension.field,
        policyPath: `/applicability/${dimension.field}`,
        candidatePath: `/target/${dimension.field}`,
        selector: h.fixture.policy.applicability[dimension.field],
        targetValue: h.candidate.target[dimension.field] ?? null,
        status: "match",
        reason: "any",
      });
    }
    expect(report.policy.recordSha256).toBe(output.policyAuthority.recordSha256);
    expect(report.candidate.source.reference).toEqual(releaseCandidateReference(h.candidate));
    expect(report.installationBinding.source.reference).toEqual(
      h.fixture.policy.installationBinding,
    );
    expect(report.lifecycle).toEqual(output.policyLifecycle.afterArtifacts);
    expect(report.authorityBoundary).toBe("retained_prerequisites_only");
    expect(report).not.toHaveProperty("outcome");
    expect(report).not.toHaveProperty("sealed");
    expect(publicApi).not.toHaveProperty("inspectCapturedPolicyApplicability");
    expect(h.binding).toHaveBeenCalledTimes(1);
    expect(h.history).toHaveBeenCalledTimes(2);
  });

  it.each(["jurisdiction", "locale"] as const)(
    "distinguishes all optional %s selector cases",
    async (field) => {
      const match = field === "jurisdiction" ? "us" : "en-us";
      const other = field === "jurisdiction" ? "kr" : "ko-kr";
      const cases = [
        [{ operator: "any" }, undefined, "match", "any"],
        [{ operator: "absent" }, undefined, "match", "optional_absent"],
        [{ operator: "absent" }, match, "mismatch", "optional_present"],
        [{ operator: "equals", value: match }, match, "match", "equal"],
        [{ operator: "equals", value: match }, other, "mismatch", "not_equal"],
        [{ operator: "equals", value: match }, undefined, "unknown", "value_missing"],
        [{ operator: "one_of", values: [match] }, match, "match", "member"],
        [{ operator: "one_of", values: [match] }, other, "mismatch", "not_member"],
        [{ operator: "one_of", values: [match] }, undefined, "unknown", "value_missing"],
      ] as const;
      for (const [selector, value, status, reason] of cases) {
        const selectors = structuredClone(any);
        Reflect.set(selectors, field, structuredClone(selector));
        const h = await setup(selectors, (candidate) => {
          if (value === undefined) Reflect.deleteProperty(candidate.target, field);
          else Reflect.set(candidate.target, field, value);
        });
        const result = await h.execute();
        expect(result.policyAuthority.requirements.status).toBe("valid");
        expect(result.applicability.dimensions.find((d) => d.field === field)).toMatchObject({
          selector,
          targetValue: value ?? null,
          status,
          reason,
        });
        expect(result.applicability.conjunction).toBe(status);
      }
    },
  );

  it.each([
    ["maximumDataClassification", "confidential", "restricted"],
    ["purpose", "Declared evaluation purpose.", "A different evaluation purpose."],
    ["riskTier", "high", "low"],
    ["taskKind", "checkout_agent", "other_agent"],
  ] as const)(
    "uses exact equality/membership rather than ordering for %s",
    async (field, match, other) => {
      for (const operator of ["equals", "one_of"] as const) {
        for (const value of [match, other]) {
          const selectors = structuredClone(any);
          const selected = field === "maximumDataClassification" ? value : match;
          Reflect.set(
            selectors,
            field,
            operator === "equals"
              ? { operator, value: selected }
              : { operator, values: [selected] },
          );
          const h = await setup(selectors, (candidate) => {
            Reflect.set(
              candidate.target,
              field,
              field === "maximumDataClassification" ? match : value,
            );
          });
          const result = await h.execute();
          expect(result.applicability.dimensions.find((d) => d.field === field)?.status).toBe(
            value === match ? "match" : "mismatch",
          );
          expect(result.applicability.conjunction).toBe(value === match ? "match" : "mismatch");
        }
      }
    },
  );

  it.each([
    ["contains_all", ["business"], ["business", "checkout"], "match"],
    ["contains_all", ["business"], ["checkout"], "mismatch"],
    ["contains_all", ["business"], [], "mismatch"],
    ["exactly", [], [], "match"],
    ["exactly", [], ["business"], "mismatch"],
    ["exactly", ["business"], [], "mismatch"],
    ["exactly", ["business"], ["business"], "match"],
    ["exactly", ["business"], ["business", "checkout"], "mismatch"],
  ] as const)(
    "compares complete %s population sets %j against %j",
    async (operator, values, declared, status) => {
      const h = await setup({ populationTags: { operator, values: [...values] } }, (candidate) => {
        candidate.target.populationTags = [...declared];
      });
      const output = await h.execute();
      expect(
        output.applicability.dimensions.find((d) => d.field === "populationTags"),
      ).toMatchObject({
        selector: { operator, values },
        targetValue: declared,
        status,
      });
      expect(output.applicability.conjunction).toBe(status);
    },
  );

  it("preserves an unknown optional value when a different established mismatch determines the conjunction", async () => {
    const h = await setup(
      {
        jurisdiction: { operator: "equals", value: "us" },
        taskKind: { operator: "equals", value: "other_task" },
      },
      (candidate) => {
        delete candidate.target.jurisdiction;
      },
    );
    const output = await h.execute();
    expect(output.applicability.conjunction).toBe("mismatch");
    expect(output.applicability.dimensions.find((d) => d.field === "jurisdiction")).toMatchObject({
      status: "unknown",
      targetValue: null,
      reason: "value_missing",
    });
    expect(output.applicability.dimensions.find((d) => d.field === "taskKind")?.status).toBe(
      "mismatch",
    );
    expect(output.applicability.dimensions).toHaveLength(7);
  });

  it.each(["missing_binding", "issuer", "missing_content", "withdrawn", "superseded"] as const)(
    "blocks a convenient mismatch under %s authority",
    async (fault) => {
      const h = await setup({ taskKind: { operator: "equals", value: "other_task" } });
      if (fault === "missing_binding") h.binding.mockResolvedValue(null);
      if (fault === "issuer") {
        const invalid = await harness({
          mutateBinding: (binding) => {
            binding.authorizedIssuerPrincipalIds = ["other_issuer"];
          },
          mutatePolicy: (policy) => {
            policy.applicability = {
              ...structuredClone(any),
              taskKind: { operator: "equals", value: "other_task" },
            };
          },
        });
        const result = await invalid.execute();
        expect(result.applicability.conjunction).toBe("not_evaluated");
        expect(result.applicability.dimensions.every((d) => d.status === "not_evaluated")).toBe(
          true,
        );
        return;
      }
      if (fault === "missing_content") h.get.mockResolvedValue(null);
      if (fault === "withdrawn" || fault === "superseded") {
        const successor = releasePolicyRepositoryFixture(
          "applicability_successor",
          h.fixture.policy.scope,
          {
            policyId: h.fixture.policy.policyId,
            predecessor: releasePolicyReference(h.fixture.policy),
            publishedAt: "2026-09-30T23:00:00.000Z",
            semanticVersion: "2.0.0",
          },
        );
        if (fault === "superseded") await h.policies.publishReleasePolicy(successor);
        await h.policies.publishReleasePolicyLifecycleEvent(
          releasePolicyLifecycleFixture(
            "applicability_terminal",
            h.fixture.policy,
            fault === "withdrawn"
              ? { occurredAt: evaluationTime }
              : { kind: fault, successor, occurredAt: evaluationTime },
          ),
        );
      }
      const result = await h.execute();
      expect(result.applicability.conjunction).toBe("not_evaluated");
      expect(result.applicability.dimensions).toHaveLength(7);
      expect(
        result.applicability.dimensions.every(
          (d) => d.status === "not_evaluated" && d.reason === "authority_unverified",
        ),
      ).toBe(true);
      expect(result.applicability.dimensions.find((d) => d.field === "taskKind")?.selector).toEqual(
        { operator: "equals", value: "other_task" },
      );
    },
  );

  it.each([
    ["2026-09-06T23:59:59.999999999Z", "not_evaluated"],
    ["2026-09-07T00:00:00.000Z", "match"],
    ["2027-03-06T23:59:59.999999999Z", "match"],
    ["2027-03-07T00:00:00.000Z", "not_evaluated"],
  ] as const)(
    "preserves the half-open policy interval at full precision: %s",
    async (at, conjunction) => {
      const h = await setup();
      h.dependencies.clock.now = () => new Date("2027-03-07T02:00:00.000Z");
      const output = await h.execute(at);
      expect(output.applicability.evaluationTime).toBe(at);
      expect(output.applicability.conjunction).toBe(conjunction);
      expect(output.applicability.dimensions).toHaveLength(7);
    },
  );

  it("retains later terminal history without replacing or invalidating a historically applicable root", async () => {
    const h = await setup();
    const event = releasePolicyLifecycleFixture("applicability_later", h.fixture.policy, {
      occurredAt: "2026-10-01T00:00:00.001Z",
    });
    await h.policies.publishReleasePolicyLifecycleEvent(event);
    const at = "2026-10-01T00:00:00.000000001Z";
    const output = await h.execute(at);
    expect(output.applicability.conjunction).toBe("match");
    expect(output.applicability.lifecycle.history[0]?.record).toEqual(event);
    expect(output.applicability.lifecycle.state).toBe("no_terminal_event_at_evaluation");
    expect(output.applicability.policy.source.reference).toEqual(
      releasePolicyReference(h.fixture.policy),
    );
  });

  it.each([
    "scope",
    "missing_root",
    "missing_binding_node",
    "unverified_root",
    "unavailable_binding_body",
    "unavailable_binding_references",
    "time",
    "roots",
    "duplicate_node",
    "candidate_body",
    "candidate_receipt",
    "policy_receipt",
    "parent_references",
    "binding_body",
    "binding_edge",
    "duplicate_binding_edge",
    "lifecycle_hash",
    "lifecycle_state",
    "lifecycle_scope",
    "lifecycle_policy",
    "clock",
  ] as const)("rejects substituted retained applicability provenance: %s", async (fault) => {
    const h = await setup();
    const output = await h.execute();
    const graph = structuredClone(graphOf(output));
    const lifecycle = structuredClone(output.policyLifecycle.afterArtifacts);
    const candidate = graph.nodes.find(({ read }) => read.source.kind === "release_candidate");
    const policy = graph.nodes.find(({ read }) => read.source.kind === "release_policy");
    const binding = graph.nodes.find(
      ({ read }) => read.source.kind === "policy_installation_binding",
    );
    const edge = graph.edges.find((e) => e.reference.path === "/installationBinding");
    if (!candidate || !policy || !binding || !edge)
      throw new Error("Missing original roots/binding");
    if (fault === "scope") graph.scope.environmentId = "other_environment";
    if (fault === "missing_root")
      Reflect.set(
        graph,
        "nodes",
        graph.nodes.filter((node) => node !== candidate),
      );
    if (fault === "missing_binding_node")
      Reflect.set(
        graph,
        "nodes",
        graph.nodes.filter((node) => node !== binding),
      );
    if (fault === "unverified_root")
      Reflect.set(candidate.read, "observation", { status: "missing" });
    if (fault === "unavailable_binding_body" || fault === "unavailable_binding_references") {
      Reflect.set(binding.read, "observation", { status: "missing" });
      if (fault === "unavailable_binding_body") Reflect.set(binding, "references", null);
      else Reflect.set(binding.read, "record", null);
    }
    if (fault === "time") Reflect.set(graph, "evaluationTime", "2026-10-01T00:00:00.000000001Z");
    if (fault === "roots") Reflect.set(graph, "roots", [...graph.roots].reverse());
    if (fault === "duplicate_node")
      Reflect.set(graph, "nodes", [...graph.nodes, structuredClone(candidate)]);
    if (fault === "candidate_body")
      Reflect.set(candidate.read.record as ReleaseCandidate, "target", {
        ...(candidate.read.record as ReleaseCandidate).target,
        jurisdiction: "kr",
      });
    if (fault === "candidate_receipt")
      Reflect.set(candidate.read.record as ReleaseCandidate, "createdByPrincipalId", "other_actor");
    if (fault === "policy_receipt")
      Reflect.set(policy.read.record as object, "publishedByPrincipalId", "other_actor");
    if (fault === "parent_references") Reflect.set(candidate, "references", []);
    if (fault === "binding_body")
      Reflect.set(binding.read.record as object, "installationId", "other_installation");
    if (fault === "binding_edge") Reflect.set(edge, "parentRecordSha256", "f".repeat(64));
    if (fault === "duplicate_binding_edge")
      Reflect.set(graph, "edges", [...graph.edges, structuredClone(edge)]);
    if (fault === "lifecycle_hash") Reflect.set(lifecycle, "observationSha256", "f".repeat(64));
    if (fault === "lifecycle_state") Reflect.set(lifecycle, "state", "withdrawn_at_evaluation");
    if (fault === "lifecycle_scope") lifecycle.scope.environmentId = "other_environment";
    if (fault === "lifecycle_policy") lifecycle.policy.policyVersionId = "other_policy";
    if (fault === "clock") Reflect.set(lifecycle, "completedAt", "2026-10-01T01:59:59.999Z");
    await expect(
      inspectCapturedPolicyApplicability(h.requestAt(), graph, output.artifacts, lifecycle, limits),
    ).rejects.toThrow();
  });

  it("admits exact cumulative parent/context/dimension canonical bytes and rejects one below", async () => {
    const h = await setup({
      purpose: { operator: "equals", value: "가나다 Unicode evaluation purpose." },
    });
    const output = await h.execute();
    const graph = graphOf(output);
    const report = output.applicability;
    const { dimensions, conjunction: _conjunction, inspectionUsage: _usage, ...context } = report;
    const parents = graph.nodes.filter(({ read }) =>
      ["release_candidate", "release_policy", "policy_installation_binding"].includes(
        read.source.kind,
      ),
    );
    const frames = [
      ...parents.flatMap(({ references }) => references ?? []),
      context,
      ...dimensions,
    ];
    expect(report.inspectionUsage).toEqual({
      references: frames.length,
      referenceBytes: frames.reduce(
        (sum, frame) => sum + encodeEvaluationCanonicalJson(frame).byteLength,
        0,
      ),
    });
    const exact = {
      maxReferences:
        report.inspectionUsage.references + output.policyAuthority.inspectionUsage.references,
      maxReferenceBytes:
        report.inspectionUsage.referenceBytes +
        output.policyAuthority.inspectionUsage.referenceBytes,
    };
    expect(
      (
        await inspectCapturedPolicyApplicability(
          h.requestAt(),
          graph,
          output.artifacts,
          output.policyLifecycle.afterArtifacts,
          exact,
        )
      ).applicability,
    ).toEqual(report);
    await expect(
      inspectCapturedPolicyApplicability(
        h.requestAt(),
        graph,
        output.artifacts,
        output.policyLifecycle.afterArtifacts,
        { ...exact, maxReferences: exact.maxReferences - 1 },
      ),
    ).rejects.toMatchObject({ reason: "reference_limit_exceeded" });
    await expect(
      inspectCapturedPolicyApplicability(
        h.requestAt(),
        graph,
        output.artifacts,
        output.policyLifecycle.afterArtifacts,
        { ...exact, maxReferenceBytes: exact.maxReferenceBytes - 1 },
      ),
    ).rejects.toMatchObject({ reason: "reference_bytes_exceeded" });
    const prior = structuredClone({
      graph,
      artifacts: output.artifacts,
      lifecycle: output.policyLifecycle.afterArtifacts,
    });
    const copy = await inspectCapturedPolicyApplicability(
      h.requestAt(),
      graph,
      output.artifacts,
      output.policyLifecycle.afterArtifacts,
      limits,
    );
    copy.applicability.candidate.source.reference.candidateId = "mutated_copy";
    const dimension = copy.applicability.dimensions.find((d) => d.field === "populationTags");
    if (!dimension || !Array.isArray(dimension.targetValue))
      throw new Error("Missing complete population");
    dimension.targetValue.push("mutated_copy");
    expect({
      graph,
      artifacts: output.artifacts,
      lifecycle: output.policyLifecycle.afterArtifacts,
    }).toEqual(prior);
  });
});

describe("combined policy-authority inspection admission", () => {
  it.each(["references", "bytes"] as const)(
    "admits exact combined %s and rejects one below before opening source transactions",
    async (dimension) => {
      const h = await harness({}, true);
      const baseline = await h.execute();
      expect(baseline.policyAuthority.inspectionUsage.references).toBeGreaterThan(0);
      expect(baseline.usage.references).toBe(
        baseline.traceCapture.usage.references +
          baseline.policyAuthority.inspectionUsage.references +
          baseline.applicability.inspectionUsage.references +
          baseline.artifactRules.inspectionUsage.references,
      );
      expect(baseline.usage.referenceBytes).toBe(
        baseline.traceCapture.usage.referenceBytes +
          baseline.policyAuthority.inspectionUsage.referenceBytes +
          baseline.applicability.inspectionUsage.referenceBytes +
          baseline.artifactRules.inspectionUsage.referenceBytes +
          baseline.usage.sourceGuards.canonicalBytes,
      );
      expect(baseline.usage.records).toBeLessThan(baseline.usage.references);
      const original = h.requestAt();
      const {
        scope,
        schemaVersion: _version,
        createdAt: _at,
        createdByPrincipalId: _by,
        definitionSha256: _hash,
        ...definition
      } = original;
      const limits = {
        ...definition.limits,
        maxAcquisitionRecords: baseline.usage.references,
        maxAcquisitionRecordBytes: baseline.usage.bytes + baseline.usage.referenceBytes,
      };
      const request = (nextLimits: typeof limits) => {
        const next = { ...definition, limits: nextLimits };
        return {
          ...original,
          ...next,
          definitionSha256: digestPolicyEvaluationRequestDefinition(scope, next),
        };
      };
      expect(
        (
          await capturePolicyArtifactEvidence(
            request(limits),
            h.actor,
            h.repositories,
            h.evidence,
            h.dependencies,
          )
        ).usage,
      ).toEqual(baseline.usage);
      const sourceTransactions = {
        run: vi.fn(async () => {
          throw new Error("Over-budget capture opened transaction");
        }),
      };
      await expect(
        capturePolicyArtifactEvidence(
          request({
            ...limits,
            ...(dimension === "references"
              ? { maxAcquisitionRecords: limits.maxAcquisitionRecords - 1 }
              : { maxAcquisitionRecordBytes: limits.maxAcquisitionRecordBytes - 1 }),
          }),
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

describe("request-rooted terminal policy lifecycle capture", () => {
  it("retains an explicit empty history without asserting active or sealed authority", async () => {
    const h = await harness();
    const capture = await h.execute();
    const before = capture.policyLifecycle.beforeArtifacts;
    expect(before).toMatchObject({
      scope: h.fixture.policy.scope,
      policy: releasePolicyReference(h.fixture.policy),
      evaluationTime,
      startedAt: observedAt,
      completedAt: observedAt,
      state: "no_terminal_event_at_evaluation",
      history: [],
    });
    expect(before.policyRecordSha256).toBe(capture.policyAuthority.recordSha256);
    expect(capture.policyLifecycle.afterArtifacts).toEqual(before);
    expect(h.history.mock.calls).toEqual(
      Array.from({ length: 2 }, () => [h.fixture.policy.scope, h.fixture.policy.policyVersionId]),
    );
    expect(before).not.toHaveProperty("revision");
    expect(before).not.toHaveProperty("valid");
    expect(publicApi).not.toHaveProperty("observeCapturedPolicyLifecycle");
  });

  it.each(["withdrawn", "superseded"] as const)(
    "retains stable %s history separately from valid static prerequisites",
    async (kind) => {
      const h = await harness();
      const successor = releasePolicyRepositoryFixture(
        "capture_successor",
        h.fixture.policy.scope,
        {
          policyId: h.fixture.policy.policyId,
          predecessor: releasePolicyReference(h.fixture.policy),
          publishedAt: "2026-09-30T23:00:00.000Z",
          semanticVersion: "2.0.0",
        },
      );
      if (kind === "superseded") await h.policies.publishReleasePolicy(successor);
      const event = releasePolicyLifecycleFixture(
        "capture_terminal",
        h.fixture.policy,
        kind === "withdrawn"
          ? { occurredAt: evaluationTime }
          : { kind, successor, occurredAt: evaluationTime },
      );
      await h.policies.publishReleasePolicyLifecycleEvent(event);
      const capture = await h.execute();
      expect(capture.policyAuthority.requirements.status).toBe("valid");
      expect(capture.policyLifecycle.beforeArtifacts.state).toBe(`${kind}_at_evaluation`);
      expect(capture.policyLifecycle.beforeArtifacts.history[0]?.record).toEqual(event);
      expect(capture.policyLifecycle.beforeArtifacts.observationSha256).toBe(
        capture.policyLifecycle.afterArtifacts.observationSha256,
      );
      expect(h.policy).toHaveBeenCalledTimes(kind === "superseded" ? 3 : 1);
      expect(graphOf(capture).roots).toContainEqual({
        kind: "release_policy",
        reference: releasePolicyReference(h.fixture.policy),
      });
      expect(
        graphOf(capture).nodes.some(
          ({ read }) =>
            read.source.kind === "release_policy" &&
            read.source.reference.policyVersionId === successor.policyVersionId,
        ),
      ).toBe(false);
      // Both complete-history reads and each returned member are charged independently.
      expect(
        capture.usage.records - capture.traceCapture.usage.records - h.find.mock.calls.length,
      ).toBe(kind === "superseded" ? 6 : 4);
      expect(
        capture.usage.reads - capture.traceCapture.usage.reads - h.find.mock.calls.length,
      ).toBe(kind === "superseded" ? 4 : 2);
    },
  );

  it.each([evaluationTime, "2026-10-01T00:30:00.000Z"])(
    "rejects a real terminal write during object acquisition at %s",
    async (occurredAt) => {
      const h = await harness();
      h.get.mockImplementationOnce(async (key) => {
        await h.policies.publishReleasePolicyLifecycleEvent(
          releasePolicyLifecycleFixture("concurrent", h.fixture.policy, { occurredAt }),
        );
        return h.originalGet(key);
      });
      await expect(h.execute()).rejects.toMatchObject({ reason: "source_revision_changed" });
      expect(h.history).toHaveBeenCalledTimes(2);
      expect(h.get).toHaveBeenCalled();
    },
  );

  it.each(["reason", "actorPrincipalId"] as const)(
    "detects a same-time terminal %s substitution by complete-record digest",
    async (field) => {
      const h = await harness();
      const event = releasePolicyLifecycleFixture("capture_change", h.fixture.policy, {
        occurredAt: evaluationTime,
      });
      h.history
        .mockResolvedValueOnce([event])
        .mockResolvedValueOnce([{ ...event, [field]: "changed_value" }]);
      await expect(h.execute()).rejects.toMatchObject({ reason: "source_revision_changed" });
    },
  );

  it.each(["before", "after"] as const)(
    "propagates %s-history storage failures without a partial result",
    async (when) => {
      const h = await harness();
      const failure = new Error("history store unavailable");
      if (when === "after") h.history.mockResolvedValueOnce([]);
      h.history.mockRejectedValueOnce(failure);
      await expect(h.execute()).rejects.toBe(failure);
      expect(h.history).toHaveBeenCalledTimes(when === "before" ? 1 : 2);
      if (when === "before") expect(h.get).not.toHaveBeenCalled();
    },
  );

  it("does not inspect lifecycle or fabricate it when the policy root is unavailable", async () => {
    const h = await harness();
    h.policy.mockResolvedValue(null);
    const output = await capturePolicyArtifactEvidence(
      h.requestAt(),
      h.actor,
      h.repositories,
      h.evidence,
      h.dependencies,
    );
    expect(output.status).toBe("roots_unavailable");
    expect(output).not.toHaveProperty("policyLifecycle");
    expect(h.history).not.toHaveBeenCalled();
    expect(h.get).not.toHaveBeenCalled();
  });

  it("does not bypass final artifact expiry during the lifecycle recheck", async () => {
    const h = await harness();
    let now = observedAt;
    h.dependencies.clock.now = () => new Date(now);
    h.history.mockResolvedValueOnce([]).mockImplementationOnce(async () => {
      now = "2028-01-01T00:00:00.000Z";
      return [];
    });
    await expect(h.execute()).rejects.toMatchObject({ reason: "source_revision_changed" });
    expect(h.get).toHaveBeenCalled();
  });

  it("does not count advancing observation times as changed authority", async () => {
    const h = await harness();
    let milliseconds = Date.parse(observedAt);
    h.dependencies.clock.now = () => new Date(milliseconds++);
    const capture = await h.execute();
    expect(
      capture.policyLifecycle.afterArtifacts.startedAt >
        capture.policyLifecycle.beforeArtifacts.completedAt,
    ).toBe(true);
    expect(capture.policyLifecycle.afterArtifacts.observationSha256).toBe(
      capture.policyLifecycle.beforeArtifacts.observationSha256,
    );
  });
});

describe("request-rooted retained policy authority prerequisites", () => {
  it("composes published exact records and real encrypted bytes without granting caller authority", async () => {
    const h = await harness();
    const result = await h.execute();
    expect(result.policyAuthority.requirements).toEqual({ status: "valid", findings: [] });
    expect(h.actor.principalId).not.toBe(h.fixture.policy.publishedByPrincipalId);
    expect(h.actor.capabilities).toEqual(["artifact:read", "artifact:read:restricted"]);
    expect(h.actor.capabilities).not.toContain("policy:author");
    expect(h.actor.capabilities).not.toContain("policy:evaluate");
    expect(result.policyAuthority.evaluationTime).toBe(evaluationTime);
    const graph = graphOf(result);
    const parent = graph.nodes.find(({ read }) => read.source.kind === "release_policy")?.read;
    expect(result.policyAuthority.recordSha256).toBe(
      parent?.observation.status === "verified" ? parent.observation.recordSha256 : undefined,
    );
    expect(result.policyAuthority.source).toEqual({
      kind: "release_policy",
      reference: releasePolicyReference(h.fixture.policy),
    });
    expect(h.binding).toHaveBeenCalledTimes(1);
    expect(h.source).toHaveBeenCalledTimes(1);
    expect(h.review).toHaveBeenCalledTimes(1);
    expect(h.qualification).toHaveBeenCalledTimes(1);
    expect(h.policy).toHaveBeenCalledTimes(1);
    // Other candidate children intentionally remain missing; valid STATIC policy requirements
    // must never be confused with complete graph closure, a sealed snapshot or a release verdict.
    expect(graph.nodes.some(({ read }) => read.observation.status !== "verified")).toBe(true);
    expect(result).not.toHaveProperty("decision");
    expect(result).not.toHaveProperty("snapshot");
    expect(publicApi).not.toHaveProperty("inspectCapturedPolicyAuthority");
  });

  it("preserves parent digests, original repeated rule edges, bytes and bounded inspection usage", async () => {
    const h = await harness();
    const capture = await h.execute();
    const graph = graphOf(capture);
    const report = capture.policyAuthority;
    const meter = new PolicyEvaluationReferenceCollector(limits);
    for (const index of report.dependencyEdgeIndexes) {
      const edge = graph.edges[index];
      if (!edge) throw new Error("Missing inspected edge");
      const owner = graph.nodes.find(
        ({ read }) =>
          policyEvaluationSourceReferenceKey(read.source) ===
          policyEvaluationSourceReferenceKey(edge.parent),
      )?.read;
      expect(owner?.observation).toMatchObject({
        status: "verified",
        recordSha256: edge.parentRecordSha256,
      });
      if (edge.reference.kind === "artifact")
        meter.artifact(edge.reference.path, edge.reference.reference);
      else if (edge.target)
        meter.record(edge.reference.path, edge.target.kind, edge.target.reference);
      else throw new Error("Expected admitted authority dependency");
    }
    const usage = meter.result();
    expect(report.inspectionUsage).toEqual({
      references: usage.references.length,
      referenceBytes: usage.referenceBytes,
    });
    const paths = report.dependencyEdgeIndexes.map((index) => graph.edges[index]?.reference.path);
    for (let i = 0; i < h.fixture.policy.rules.length; i++)
      expect(paths).toContain(`/rules/${i}/sources/0/source`);
    expect(report.artifactCaptureIndexes.length).toBeGreaterThan(
      new Set(report.artifactCaptureIndexes).size,
    );
    for (const index of report.artifactCaptureIndexes)
      expect(capture.artifacts[index]?.read.observation.status).toBe("verified");
    expect(
      inspectCapturedPolicyAuthority(graph, capture.artifacts, {
        maxReferences: usage.references.length,
        maxReferenceBytes: usage.referenceBytes,
      }),
    ).toEqual(report);
    expect(() =>
      inspectCapturedPolicyAuthority(graph, capture.artifacts, {
        ...limits,
        maxReferences: usage.references.length - 1,
      }),
    ).toThrow("reference_limit_exceeded");
    expect(() =>
      inspectCapturedPolicyAuthority(graph, capture.artifacts, {
        ...limits,
        maxReferenceBytes: usage.referenceBytes - 1,
      }),
    ).toThrow("reference_bytes_exceeded");
    const before = structuredClone(capture);
    const calls = [h.get.mock.calls.length, h.find.mock.calls.length, h.source.mock.calls.length];
    const copy = inspectCapturedPolicyAuthority(graph, capture.artifacts, limits);
    (copy.dependencyEdgeIndexes as number[]).pop();
    copy.source.reference.definitionSha256 = "f".repeat(64);
    expect(capture).toEqual(before);
    expect([h.get.mock.calls.length, h.find.mock.calls.length, h.source.mock.calls.length]).toEqual(
      calls,
    );
  });

  it("does not let later capture time activate a policy at an earlier semantic instant", async () => {
    const h = await harness();
    expect(
      reasons(await h.execute("2026-09-06T23:59:59.999999999999999999999999999999Z")),
    ).toContain("policy_not_effective_at_evaluation");
    expect(reasons(await h.execute("2026-09-07T00:00:00Z"))).toEqual([]);
  });

  const adverse: [string, PolicyAuthorityFixtureOptions][] = [
    [
      "policy_expired_at_evaluation",
      {
        mutatePolicy: (p) => {
          p.expiresAt = evaluationTime;
        },
      },
    ],
    [
      "issuer_not_authorized",
      {
        mutateBinding: (b) => {
          b.authorizedIssuerPrincipalIds = ["principal_capture"];
        },
      },
    ],
    [
      "policy_mode_not_authorized",
      {
        mutateBinding: (b) => {
          b.allowedModes = ["advisory"];
        },
      },
    ],
    [
      "installation_binding_not_current",
      {
        mutateBinding: (b) => {
          b.expiresAt = evaluationTime;
        },
      },
    ],
    [
      "source_identity_unverified",
      {
        mutateSource: (s) => {
          s.identityVerification = { status: "unverified", reason: "Identity is unknown" };
        },
      },
    ],
    [
      "source_identity_disputed",
      {
        mutateSource: (s) => {
          s.identityVerification = {
            status: "disputed",
            reason: "Identity is contested",
            evidence: [s.content],
          };
        },
      },
    ],
    [
      "source_identity_not_independent",
      {
        mutateSource: (s) => {
          if (s.identityVerification.status !== "verified")
            throw new Error("Expected verified identity");
          s.identityVerification.verifierPrincipalId = "principal_policy_author";
        },
      },
    ],
    [
      "source_license_unusable",
      {
        mutateReview: (r) => {
          r.licensingConclusion = "unknown";
          r.outcome = "require_approval";
        },
      },
    ],
    [
      "source_review_not_current",
      {
        mutateReview: (r) => {
          r.validUntil = evaluationTime;
        },
      },
    ],
    [
      "source_review_not_approved",
      {
        mutateReview: (r) => {
          r.outcome = "require_approval";
        },
      },
    ],
    [
      "source_review_relationship_disclosed",
      {
        mutateReview: (r) => {
          r.declaredRelationships = ["Reports to policy author"];
        },
      },
    ],
    [
      "reviewer_qualification_unavailable",
      {
        mutateReview: (r) => {
          delete r.reviewerQualification;
        },
      },
    ],
    [
      "reviewer_qualification_not_current",
      {
        mutateReviewer: (q) => {
          q.validUntil = evaluationTime;
        },
      },
    ],
  ];
  it.each(adverse)(
    "retains owning-domain finding %s from actual published records",
    async (reason, options) => {
      const result = await (await harness(options)).execute();
      expect(result.policyAuthority.requirements.status).toBe("invalid");
      expect(reasons(result)).toContain(reason);
    },
  );

  it("checks separately published counterevidence instead of only supporting rule sources", async () => {
    const h = await harness({}, true);
    const result = await h.execute();
    expect(result.policyAuthority.requirements.findings).toContainEqual({
      reason: "source_review_not_approved",
      sourceReviewId: "review_counter",
      sourceSnapshotId: "source_counter",
    });
    expect(
      result.policyAuthority.dependencyEdgeIndexes.map(
        (i) => graphOf(result).edges[i]?.reference.path,
      ),
    ).toContain("/counterevidence/0/source");
  });

  it("preserves unresolved conflicts with separately published conflicting evidence", async () => {
    const result = await (await harness({}, true, true)).execute();
    expect(reasons(result)).toContain("source_conflict_unresolved");
    expect(result.policyAuthority.requirements.findings).toContainEqual({
      reason: "source_conflict_unresolved",
      sourceSnapshotId: "source_release_standard",
      sourceReviewId: "review_release_standard",
    });
  });

  it.each(["binding", "source", "review", "qualification"] as const)(
    "keeps missing %s explicit with no substitute lookup",
    async (port) => {
      const h = await harness();
      h[port].mockResolvedValue(null);
      const result = await h.execute();
      const expected = {
        binding: "installation_binding_unavailable",
        source: "source_snapshot_unavailable",
        review: "source_review_unavailable",
        qualification: "reviewer_qualification_unavailable",
      };
      expect(reasons(result)).toContain(expected[port]);
      expect(h[port]).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["binding", "source", "review", "qualification"] as const)(
    "retains corrupt %s observations instead of making authority valid",
    async (port) => {
      const h = await harness();
      const record = port === "qualification" ? h.fixture.reviewer : h.fixture[port];
      h[port].mockResolvedValue({ ...record, definitionSha256: "0".repeat(64) } as never);
      const result = await h.execute();
      expect(result.policyAuthority.requirements.status).toBe("invalid");
      expect(
        graphOf(result).nodes.some(({ read }) => read.observation.status === "unavailable"),
      ).toBe(true);
    },
  );

  it.each(["binding", "source", "review", "qualification"] as const)(
    "propagates %s storage failure rather than returning a verdict",
    async (port) => {
      const h = await harness();
      const failure = new Error(`${port} unavailable`);
      h[port].mockRejectedValue(failure);
      await expect(h.execute()).rejects.toThrow(failure);
      expect(h.get).not.toHaveBeenCalled();
    },
  );

  const artifactRoles = ["installation", "content", "identity", "review", "qualification"] as const;
  it.each(artifactRoles)("does not treat %s metadata as retained authority bytes", async (role) => {
    const h = await harness();
    const { binding, source, review, reviewer } = h.fixture;
    const reference =
      role === "installation"
        ? binding.authorityEvidence
        : role === "content"
          ? source.content
          : role === "review"
            ? review.reviewBasis[0]
            : role === "qualification"
              ? reviewer.credentialEvidence[0]
              : source.identityVerification.status === "verified"
                ? source.identityVerification.evidence[0]
                : undefined;
    if (!reference) throw new Error("Expected authority artifact");
    const get = h.originalGet;
    h.get.mockImplementation((key) =>
      key === `objects/v1/${reference.artifactId}` ? Promise.resolve(null) : get(key),
    );
    const result = await h.execute();
    const expected = {
      installation: "installation_authority_evidence_unavailable",
      content: "source_content_unavailable",
      identity: "source_identity_evidence_unavailable",
      review: "source_review_basis_unavailable",
      qualification: "reviewer_qualification_evidence_unavailable",
    };
    expect(reasons(result)).toContain(expected[role]);
    expect(
      result.artifacts
        .filter(({ read }) => read.reference.artifactId === reference.artifactId)
        .every(
          ({ read }) =>
            read.observation.status === "unavailable" &&
            read.observation.reason === "object_missing",
        ),
    ).toBe(true);
  });

  it("refuses an altered encrypted object even when source metadata and digest are valid", async () => {
    const h = await harness();
    const get = h.originalGet;
    h.get.mockImplementation(async (key) => {
      const bytes = await get(key);
      if (key === `objects/v1/${h.fixture.binding.authorityEvidence.artifactId}` && bytes) {
        const changed = Uint8Array.from(bytes);
        changed[changed.length - 1] = (changed[changed.length - 1] ?? 0) ^ 1;
        return changed;
      }
      return bytes;
    });
    expect(reasons(await h.execute())).toContain("installation_authority_evidence_unavailable");
  });

  it("keeps the unavailable-root branch free of invented authority reports", async () => {
    const h = await harness();
    h.policy.mockResolvedValue(null);
    const output = await capturePolicyArtifactEvidence(
      h.requestAt(),
      h.actor,
      h.repositories,
      h.evidence,
      h.dependencies,
    );
    expect(output.status).toBe("roots_unavailable");
    expect(output).not.toHaveProperty("policyAuthority");
    expect(h.get).not.toHaveBeenCalled();
  });

  it.each([
    "missing policy root",
    "duplicate policy root",
    "missing policy node",
    "missing edge",
    "duplicate edge",
    "parent hash",
    "missing target",
    "target kind",
    "missing child",
    "child exact reference",
    "missing artifact capture",
    "duplicate artifact capture",
    "artifact scope",
    "artifact time",
    "artifact reference",
    "artifact parent descriptor",
  ])("refuses internally inconsistent provenance: %s", async (variant) => {
    const capture = await (await harness()).execute();
    let graph: PolicyRecordGraph = structuredClone(graphOf(capture));
    let artifacts: readonly PolicyArtifactCapture[] = structuredClone(capture.artifacts);
    const policy = graph.roots.find((root) => root.kind === "release_policy");
    const bindingIndex = graph.edges.findIndex(
      (edge) =>
        edge.parent.kind === "release_policy" && edge.reference.path === "/installationBinding",
    );
    const binding = graph.edges[bindingIndex];
    const artifactIndex = capture.policyAuthority.artifactCaptureIndexes[0];
    const artifact = artifactIndex === undefined ? undefined : artifacts[artifactIndex];
    if (
      !policy ||
      !binding?.target ||
      artifactIndex === undefined ||
      !artifact ||
      artifact.origin.kind !== "record"
    )
      throw new Error("Expected authority provenance");
    const artifactEdgeIndex = artifact.origin.edgeIndex;
    switch (variant) {
      case "missing policy root":
        graph = { ...graph, roots: graph.roots.filter((r) => r.kind !== "release_policy") };
        break;
      case "duplicate policy root":
        graph = { ...graph, roots: [...graph.roots, policy] };
        break;
      case "missing policy node":
        graph = {
          ...graph,
          nodes: graph.nodes.filter(({ read }) => read.source.kind !== "release_policy"),
        };
        break;
      case "missing edge":
        graph = { ...graph, edges: graph.edges.filter((_, i) => i !== bindingIndex) };
        break;
      case "duplicate edge":
        graph = { ...graph, edges: [...graph.edges, binding] };
        break;
      case "parent hash":
        graph = {
          ...graph,
          edges: graph.edges.map((edge, i) =>
            i === bindingIndex ? { ...edge, parentRecordSha256: "0".repeat(64) } : edge,
          ),
        };
        break;
      case "missing target":
        graph = {
          ...graph,
          edges: graph.edges.map((edge, i) =>
            i === bindingIndex ? { ...edge, target: null } : edge,
          ),
        };
        break;
      case "target kind":
        graph = {
          ...graph,
          edges: graph.edges.map((edge, i) =>
            i === bindingIndex ? { ...edge, target: policy } : edge,
          ),
        };
        break;
      case "missing child":
        graph = {
          ...graph,
          nodes: graph.nodes.filter(
            ({ read }) => read.source.kind !== "policy_installation_binding",
          ),
        };
        break;
      case "child exact reference":
        for (const node of graph.nodes) {
          if (node.read.source.kind === "policy_installation_binding")
            node.read.source.reference.definitionSha256 = "0".repeat(64);
        }
        break;
      case "missing artifact capture":
        artifacts = artifacts.filter((_, i) => i !== artifactIndex);
        break;
      case "duplicate artifact capture":
        artifacts = [...artifacts, artifact];
        break;
      case "artifact scope":
        artifacts = artifacts.map((item, i) =>
          i === artifactIndex
            ? {
                ...item,
                read: { ...item.read, scope: { ...item.read.scope, tenantId: "tenant_other" } },
              }
            : item,
        );
        break;
      case "artifact time":
        artifacts = artifacts.map((item, i) =>
          i === artifactIndex
            ? { ...item, read: { ...item.read, evaluationTime: "2026-10-01T00:00:01.000Z" } }
            : item,
        );
        break;
      case "artifact reference":
        artifacts = artifacts.map((item, i) =>
          i === artifactIndex
            ? {
                ...item,
                read: {
                  ...item.read,
                  reference: { ...item.read.reference, sha256: "0".repeat(64) },
                },
              }
            : item,
        );
        break;
      case "artifact parent descriptor":
        graph = {
          ...graph,
          edges: graph.edges.map((edge, i) =>
            i === artifactEdgeIndex
              ? {
                  ...edge,
                  reference: {
                    kind: "artifact",
                    path: edge.reference.path,
                    reference: { ...artifact.read.reference, sha256: "0".repeat(64) },
                  },
                }
              : edge,
          ),
        };
        break;
    }
    expect(() => inspectCapturedPolicyAuthority(graph, artifacts, limits)).toThrow(
      /reference_conflict|observation_conflict/u,
    );
  });

  it("rejects conflicting states for an authority artifact used by two original parents", async () => {
    let shared: ContentReference | undefined;
    const h = await harness({
      mutateSource: (source) => {
        shared = source.content;
      },
      mutateBinding: (binding) => {
        if (!shared) throw new Error("Expected prior source definition");
        binding.authorityEvidence = shared;
      },
    });
    const capture = await h.execute();
    const graph = graphOf(capture);
    const artifacts = capture.artifacts.map((item) => {
      const edge = item.origin.kind === "record" ? graph.edges[item.origin.edgeIndex] : undefined;
      return edge?.parent.kind === "source_snapshot" && edge.reference.path === "/content"
        ? {
            ...item,
            read: {
              ...item.read,
              observation: { status: "unavailable" as const, reason: "object_missing" as const },
            },
          }
        : item;
    });
    expect(() => inspectCapturedPolicyAuthority(graph, artifacts, limits)).toThrow(
      "observation_conflict",
    );
  });

  it("does not mistake an unrelated trace artifact occurrence for a record observation", async () => {
    const capture = await (await harness()).execute();
    const first = capture.artifacts[0];
    if (!first) throw new Error("Expected artifact capture");
    expect(
      inspectCapturedPolicyAuthority(
        graphOf(capture),
        [...capture.artifacts, { ...first, origin: { kind: "trace", artifactReferenceIndex: 0 } }],
        limits,
      ),
    ).toEqual(capture.policyAuthority);
  });
});
