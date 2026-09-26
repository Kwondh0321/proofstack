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
} from "@proofstack/contracts";
import {
  digestPolicyEvaluationRequestDefinition,
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
} from "@proofstack/core/testing";
import { describe, expect, it, vi } from "vitest";
import {
  capturePolicyArtifactEvidence,
  type PolicyArtifactCapture,
} from "./capture-artifact-evidence.js";
import { inspectCapturedPolicyAuthority } from "./capture-policy-authority.js";
import type { PolicyRecordGraph } from "./capture-record-graph.js";
import * as publicApi from "./index.js";
import type { PolicyRecordGraphRepositories } from "./record-routing.js";

const limits = { maxReferences: 10000, maxReferenceBytes: 8_388_608 };
const evaluationTime = "2026-10-01T00:00:00.000Z";
const observedAt = "2026-10-01T02:00:00.000Z";

async function harness(
  options: PolicyAuthorityFixtureOptions = {},
  counterevidence = false,
  conflicted = false,
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
  } as unknown as PolicyRecordGraphRepositories;
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
