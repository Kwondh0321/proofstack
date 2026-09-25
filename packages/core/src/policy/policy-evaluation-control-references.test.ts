import { createHash } from "node:crypto";
import {
  ArtifactContentReferenceSchema,
  PolicyEvaluationSourceReferenceSchema,
  type ReleasePolicy,
} from "@proofstack/contracts";
import { describe, expect, it } from "vitest";
import { digestComparisonRecordDefinition } from "../evaluation/comparison-record-validation.js";
import { digestReleaseCandidateDefinition } from "../release/release-candidate-record-validation.js";
import {
  comparisonDefinitionFixture,
  comparisonFixtureScope,
  comparisonResultFixture,
  comparisonSnapshotFixture,
} from "../testing/comparison-repository-fixtures.js";
import { MemoryComparisonRepository } from "../testing/memory-comparison-repository.js";
import { MemoryReleaseCandidateRepository } from "../testing/memory-release-candidate-repository.js";
import { MemoryReleasePolicyRepository } from "../testing/memory-release-policy-repository.js";
import { releaseCandidateFixture } from "../testing/release-candidate-repository-fixtures.js";
import { policyAuthorityFixture } from "../testing/release-policy-fixtures.js";
import {
  type PolicyEvaluationControlDeclaration,
  parsePolicyEvaluationControlDeclaration,
} from "./policy-evaluation-control-declaration.js";
import {
  inspectPolicyEvaluationControlRecord,
  type PolicyEvaluationControlRead,
  type PolicyEvaluationControlRecord,
  type PolicyEvaluationControlSource,
  readPolicyEvaluationControlRecord,
} from "./policy-evaluation-control-record-reader.js";
import { enumeratePolicyEvaluationControlReferences } from "./policy-evaluation-control-references.js";
import {
  type PolicyEvaluationEvidenceReference,
  PolicyEvaluationEvidenceReferenceError,
  PolicyEvaluationReferenceCollector,
} from "./policy-evaluation-reference-collector.js";
import { StaticPolicyInstallationBindingResolver } from "./release-policy-authority-resolver.js";
import {
  digestPolicyInstallationBindingDefinition,
  digestReleasePolicyDefinition,
} from "./release-policy-record-validation.js";

type Kind = PolicyEvaluationControlSource["kind"];
type Fields = Record<string, unknown>;
const scope = comparisonFixtureScope("control_references");
const evaluationTime = "2026-10-01T00:00:00.000Z";
const limits = { maxReferences: 10_000, maxReferenceBytes: 4_000_000 };
const definition = comparisonDefinitionFixture("control_references", scope);
const baseline = comparisonSnapshotFixture("control_references", scope, definition, "baseline");
const candidate = comparisonSnapshotFixture("control_references", scope, definition, "candidate");
const conflictingComparison = comparisonResultFixture(
  "control_references",
  scope,
  definition,
  baseline,
  candidate,
);
// The retained comparison vector intentionally describes two digests under one artifact ID.
// Keep it for the rejection test; the successful traversal case uses one consistent identity.
const comparison = structuredClone(conflictingComparison);
for (const change of comparison.artifactChanges) {
  if (change.baseline && change.candidate) {
    change.candidate = structuredClone(change.baseline);
    change.status = "unchanged";
  }
}
comparison.definitionSha256 = rehash("comparison_result", comparison).definitionSha256;
const release = releaseCandidateFixture("control_references", scope);
const { policy, binding } = policyAuthorityFixture({ scope });
const records = {
  comparison_definition: definition,
  comparison_snapshot: baseline,
  comparison_result: comparison,
  release_candidate: release,
  release_policy: policy,
  policy_installation_binding: binding,
};
const kinds = Object.keys(records) as Kind[];

function fields(value: unknown): Fields {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected object");
  return value as Fields;
}
function sortedJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(sortedJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, field]) => `${JSON.stringify(key)}:${sortedJson(field)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

// Structural oracle, not the production field traversal, collector, or repository lineage helper.
// It finds exact reference shapes in a recursive JSON walk and preserves numeric array order.
function oracle(record: unknown): PolicyEvaluationEvidenceReference[] {
  const found: PolicyEvaluationEvidenceReference[] = [];
  function declaration(
    path: string,
    kind: PolicyEvaluationControlDeclaration["kind"],
    reference: unknown,
  ) {
    found.push({
      kind: "control_declaration",
      path,
      declaration: { kind, reference } as PolicyEvaluationControlDeclaration,
    });
  }
  function visit(value: unknown, path: string): void {
    if (typeof value === "string" && /^\/(artifactChanges|omissions)\/\d+\/artifactId$/.test(path))
      declaration(path, "artifact_identity", value);
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach((child, index) => {
        visit(child, `${path}/${index}`);
      });
      return;
    }
    const object = fields(value);
    const artifact = ArtifactContentReferenceSchema.safeParse(value);
    if (artifact.success) found.push({ kind: "artifact", path, reference: artifact.data });
    const matches = PolicyEvaluationSourceReferenceSchema.options.flatMap((schema) => {
      // Candidate comparisons and blinded results share the exact resultId/digest shape.
      if (/^\/comparisons\/\d+$/.test(path) && schema.shape.kind.value !== "comparison_result")
        return [];
      if (
        path === "/predecessor" &&
        "policyId" in object &&
        schema.shape.kind.value !== "release_policy"
      )
        return [];
      const parsed = schema.safeParse({ kind: schema.shape.kind.value, reference: value });
      return parsed.success ? [parsed.data] : [];
    });
    expect(
      matches.length,
      `${path}: ${matches.map((match) => match.kind).join(",")}`,
    ).toBeLessThanOrEqual(1);
    for (const source of matches) found.push({ kind: "record", path, source });
    if (
      path === "/predecessor" &&
      Object.keys(object).sort().join(",") === "comparisonVersionId,definitionSha256"
    )
      declaration(path, "comparison_predecessor", value);
    if ("repositoryUrl" in object && "commit" in object && "tree" in object)
      declaration(path, "candidate_source", value);
    if ("eventId" in object && "sourceSha256" in object) declaration(path, "safety_event", value);
    if (object["kind"] === "approval_required") declaration(path, "approval_requirement", value);
    if (object["kind"] === "artifact_required") declaration(path, "artifact_requirement", value);
    if (object["kind"] === "model" && "resolution" in object) {
      declaration(path, "model_declaration", {
        providerId: object["providerId"],
        providerModelId: object["providerModelId"],
        resolution: object["resolution"],
      });
    }
    for (const key of Object.keys(object).sort()) visit(object[key], `${path}/${key}`);
  }
  visit(record, "");
  return found;
}

function prepare(kind: Kind, record: PolicyEvaluationControlRecord = records[kind]) {
  const schema = PolicyEvaluationSourceReferenceSchema.options.find(
    (s) => s.shape.kind.value === kind,
  );
  if (!schema) throw new Error("Missing source schema");
  const source = PolicyEvaluationSourceReferenceSchema.parse({
    kind,
    reference: Object.fromEntries(
      Object.keys(schema.shape.reference.shape).map((key) => [key, fields(record)[key]]),
    ),
  }) as PolicyEvaluationControlSource;
  const input = { evaluationTime, scope: structuredClone(record.scope), source };
  const evidence = inspectPolicyEvaluationControlRecord(input, record);
  expect(evidence.observation.status).toBe("verified");
  if (evidence.observation.status !== "verified" || evidence.record === null)
    throw new Error("Expected verified record");
  return {
    input,
    evidence: {
      source: evidence.source,
      observation: evidence.observation,
      record: evidence.record,
    },
  };
}

function rehash(kind: Kind, record: PolicyEvaluationControlRecord): PolicyEvaluationControlRecord {
  const body = structuredClone(record) as unknown as Fields;
  for (const key of [
    "createdAt",
    "createdByPrincipalId",
    "publishedAt",
    "publishedByPrincipalId",
    "registeredAt",
    "registeredByPrincipalId",
    "schemaVersion",
    "definitionSha256",
  ])
    delete body[key];
  if (kind !== "policy_installation_binding") delete body["scope"];
  const digest =
    kind === "release_candidate"
      ? digestReleaseCandidateDefinition(record.scope, body as never)
      : kind === "release_policy"
        ? digestReleasePolicyDefinition(record.scope, body as never)
        : kind === "policy_installation_binding"
          ? digestPolicyInstallationBindingDefinition(record.scope, body as never)
          : digestComparisonRecordDefinition(
              kind === "comparison_snapshot" ? "comparison_evidence_snapshot" : kind,
              record.scope,
              body,
            );
  return { ...record, definitionSha256: digest };
}

function verify(kind: Kind, record: PolicyEvaluationControlRecord = records[kind]) {
  const { input, evidence } = prepare(kind, record);
  const actual = enumeratePolicyEvaluationControlReferences(input, evidence, limits);
  const expected = oracle(record);
  expect(actual).toEqual({
    source: input.source,
    recordSha256: createHash("sha256").update(sortedJson(record)).digest("hex"),
    references: expected,
    referenceBytes: expected.reduce(
      (total, item) => total + Buffer.byteLength(sortedJson(item)),
      0,
    ),
  });
  return actual;
}

describe("captured control-record dependency occurrences", () => {
  it("rejects conflicting retained artifact identities instead of dropping either role", () => {
    const { input, evidence } = prepare("comparison_result", conflictingComparison);
    expect(() => enumeratePolicyEvaluationControlReferences(input, evidence, limits)).toThrow(
      expect.objectContaining({ reason: "reference_conflict" }),
    );
  });
  for (const kind of kinds) {
    it(`${kind}: matches the independent structural and byte oracle`, () => {
      verify(kind);
    });
    it(`${kind}: accepts exact limits and rejects overflow without partial output`, () => {
      const { input, evidence } = prepare(kind);
      const result = verify(kind);
      const exact = {
        maxReferences: result.references.length,
        maxReferenceBytes: result.referenceBytes,
      };
      expect(enumeratePolicyEvaluationControlReferences(input, evidence, exact)).toEqual(result);
      expect(() =>
        enumeratePolicyEvaluationControlReferences(input, evidence, {
          ...exact,
          maxReferences: exact.maxReferences - 1,
        }),
      ).toThrow(expect.objectContaining({ reason: "reference_limit_exceeded" }));
      expect(() =>
        enumeratePolicyEvaluationControlReferences(input, evidence, {
          ...exact,
          maxReferenceBytes: exact.maxReferenceBytes - 1,
        }),
      ).toThrow(expect.objectContaining({ reason: "reference_bytes_exceeded" }));
    });
    it(`${kind}: rejects substituted context, bodies, and captured observations`, () => {
      const { input, evidence } = prepare(kind);
      for (const key of ["tenantId", "projectId", "environmentId"] as const) {
        const other = structuredClone(input);
        other.scope[key] = "foreign_scope";
        expect(() => enumeratePolicyEvaluationControlReferences(other, evidence, limits)).toThrow(
          PolicyEvaluationEvidenceReferenceError,
        );
      }
      for (const altered of [
        { ...evidence, record: null },
        { ...evidence, record: { ...evidence.record, approved: undefined } },
        { ...evidence, observation: { status: "missing" } },
        { ...evidence, observation: { status: "verified", recordSha256: "f".repeat(64) } },
        {
          ...evidence,
          source: {
            ...input.source,
            reference: { ...input.source.reference, definitionSha256: "f".repeat(64) },
          },
        },
      ])
        expect(() =>
          enumeratePolicyEvaluationControlReferences(
            input,
            altered as PolicyEvaluationControlRead,
            limits,
          ),
        ).toThrow(PolicyEvaluationEvidenceReferenceError);
      expect(() =>
        enumeratePolicyEvaluationControlReferences(
          { ...input, evaluationTime: "2000-01-01T00:00:00Z" },
          evidence,
          limits,
        ),
      ).toThrow(PolicyEvaluationEvidenceReferenceError);
    });
    it(`${kind}: binds receipt-only changes and reads the body once before caller mutation`, () => {
      const { input, evidence } = prepare(kind);
      let reads = 0;
      const wrapped = {
        ...evidence,
        get record() {
          reads++;
          input.scope.tenantId = "mutated";
          input.evaluationTime = "2000-01-01T00:00:00Z";
          return structuredClone(records[kind]);
        },
      };
      const result = enumeratePolicyEvaluationControlReferences(input, wrapped, limits);
      expect(reads).toBe(1);
      expect(result.references).toEqual(oracle(records[kind]));
      const receipt =
        kind === "release_policy"
          ? "publishedAt"
          : kind === "policy_installation_binding"
            ? "registeredAt"
            : "createdAt";
      const fresh = prepare(kind);
      const altered = {
        ...fresh.evidence,
        record: { ...records[kind], [receipt]: "2026-09-09T00:00:00.000Z" },
      };
      expect(() =>
        enumeratePolicyEvaluationControlReferences(fresh.input, altered, limits),
      ).toThrow(expect.objectContaining({ reason: "observation_mismatch" }));
      Object.assign(result.references[0] ?? {}, { path: "/changed" });
      expect(verify(kind).references).toEqual(oracle(records[kind]));
    });
  }

  it("preserves predecessor declarations without inventing a logical comparison identity", () => {
    const record = comparisonDefinitionFixture("control_successor", scope, {
      predecessor: {
        comparisonVersionId: definition.comparisonVersionId,
        definitionSha256: definition.definitionSha256,
      },
    });
    const result = verify("comparison_definition", record);
    expect(result.references.find((item) => item.path === "/predecessor")).toEqual({
      kind: "control_declaration",
      path: "/predecessor",
      declaration: { kind: "comparison_predecessor", reference: record.predecessor },
    });
  });

  it("preserves candidate and policy predecessors, repeated sources, and model alias declarations", () => {
    const child = releaseCandidateFixture("control_references", scope, {
      version: "v2",
      predecessor: {
        candidateId: release.candidateId,
        candidateVersionId: release.candidateVersionId,
        definitionSha256: release.definitionSha256,
      },
    });
    const component = child.runtimeComponents.find((entry) => entry.kind === "model");
    if (component?.kind !== "model") throw new Error("Expected model");
    component.resolution = {
      status: "provider_alias_only",
      declaredAlias: "moving-alias",
      limitation: "No exact provider resolution",
    };
    verify("release_candidate", rehash("release_candidate", child));
    const successor = structuredClone(policy);
    successor.policyVersionId += "_v2";
    successor.predecessor = {
      policyId: policy.policyId,
      policyVersionId: policy.policyVersionId,
      definitionSha256: policy.definitionSha256,
    };
    const result = verify("release_policy", rehash("release_policy", successor));
    const sources = result.references.filter(
      (item) => item.kind === "record" && item.source.kind === "source_snapshot",
    );
    expect(sources.length).toBeGreaterThan(1);
  });

  it("retains every omission family, unavailable artifact, safety source and numeric observation", () => {
    const snapshot = structuredClone(baseline);
    const fixture = snapshot.fixtures[0];
    if (!fixture || !fixture.artifacts[0]) throw new Error("Expected snapshot fixture");
    fixture.artifacts[0].availability = "revoked";
    fixture.numericObservations = [
      {
        measurementName: "score",
        observation: { observationId: "observation_score", definitionSha256: "e".repeat(64) },
        unit: "points",
        value: "1",
      },
    ];
    const { fixtureId } = fixture.fixture;
    snapshot.omissions = [
      {
        sourceKind: "artifact",
        fixtureId,
        artifactId: fixture.artifacts[0].artifact.artifactId,
        reason: "artifact_revoked",
      },
      {
        sourceKind: "assessment",
        fixtureId,
        assessment: { assessmentId: "assessment_missing", definitionSha256: "a".repeat(64) },
        reason: "optional_assessment_missing",
      },
      {
        sourceKind: "classified_content",
        fixtureId,
        projectionKey: "private_prompt",
        reason: "classified_content_excluded",
      },
      {
        sourceKind: "model_assurance_assessment",
        fixtureId,
        modelAssuranceAssessment: {
          assessmentExtensionId: "assurance_missing",
          definitionSha256: "b".repeat(64),
        },
        reason: "optional_assessment_missing",
      },
      {
        sourceKind: "numeric_measurement",
        fixtureId,
        measurementName: "missing_score",
        unit: "points",
        reason: "measurement_unavailable",
      },
    ];
    fixture.safetyEvents = (
      ["guardrail_check", "replay_safety_intervention", "uncertain_side_effect"] as const
    ).map((kind, index) => ({
      kind,
      eventId: `event_${index}`,
      occurredAt: "2026-09-02T00:00:00.000Z",
      sourceId: `source_${index}`,
      sourceSha256: "d".repeat(64),
    }));
    const result = verify("comparison_snapshot", rehash("comparison_snapshot", snapshot));
    expect(result.references.some((item) => item.path === "/omissions/0/artifactId")).toBe(true);
    expect(
      result.references.filter(
        (item) => item.kind === "control_declaration" && item.declaration.kind === "safety_event",
      ),
    ).toHaveLength(3);
  });

  it("includes criterion references from both criterion-bearing comparison metric families", () => {
    const record = structuredClone(definition);
    const criterion = baseline.fixtures[0]?.evaluationOutcomes[0]?.criterion;
    const stratumId = record.strata[0]?.stratumId;
    if (!criterion || !stratumId) throw new Error("Expected criterion and stratum");
    record.metrics = [
      {
        kind: "coverage_count",
        criterion,
        dimension: "observed",
        label: "Coverage",
        metricId: "coverage",
        stratumId,
        unit: "cases",
      },
      {
        kind: "evaluation_verdict_count",
        criterion,
        label: "Failures",
        metricId: "failures",
        stratumId,
        unit: "evaluation_outcomes",
        verdict: "fail",
      },
    ];
    verify("comparison_definition", rehash("comparison_definition", record));
  });

  it("includes assessment coverage, comparison sample counts, model eligibility and counterevidence", () => {
    const record = structuredClone(policy);
    const rule = record.rules[0];
    const assessment = release.assessments[0];
    const comparisonRef = {
      comparisonId: definition.comparisonId,
      comparisonVersionId: definition.comparisonVersionId,
      definitionSha256: definition.definitionSha256,
    };
    if (!rule || !assessment) throw new Error("Expected policy rule and assessment");
    const predicates: ReleasePolicy["rules"][number]["predicate"][] = [
      {
        kind: "coverage_floor",
        sourceKind: "assessment_samples",
        assessment,
        minimumCount: 1,
        sampleClass: "observed",
        unit: "cases",
      },
      {
        kind: "coverage_floor",
        sourceKind: "comparison_metric_samples",
        comparison: comparisonRef,
        metricId: "metric_count",
        minimumCount: 1,
        sampleClass: "paired_total",
        unit: "cases",
      },
      {
        kind: "eligibility_required",
        assessmentClass: "model_assurance",
        assessment: {
          assessmentExtensionId: "assurance_required",
          definitionSha256: "e".repeat(64),
        },
        expected: "eligible",
      },
    ];
    record.rules.push(
      ...predicates.map((predicate, index) => ({
        ...rule,
        predicate,
        ruleId: `zz_extra_${index}`,
      })),
    );
    record.counterevidence = [
      {
        review: { sourceReviewId: "counter_review", definitionSha256: "c".repeat(64) },
        source: { sourceSnapshotId: "counter_source", definitionSha256: "d".repeat(64) },
      },
    ];
    verify("release_policy", rehash("release_policy", record));
  });

  it("preserves numeric array order beyond nine and repeated artifact occurrences", () => {
    const record = structuredClone(release);
    const artifact = record.buildArtifacts[0]?.artifact;
    if (!artifact) throw new Error("Expected build artifact");
    record.buildArtifacts = Array.from({ length: 12 }, (_, index) => ({
      role: `role_${String(index).padStart(2, "0")}`,
      artifact: structuredClone(artifact),
    }));
    const result = verify("release_candidate", rehash("release_candidate", record));
    expect(
      result.references
        .filter((item) => item.path.startsWith("/buildArtifacts/"))
        .map((item) => item.path),
    ).toEqual(Array.from({ length: 12 }, (_, i) => `/buildArtifacts/${i}/artifact`));
  });

  it("retains added, removed and unavailable result artifacts without resolving their availability", () => {
    const record = structuredClone(comparison);
    const template = record.artifactChanges[0]?.baseline;
    if (!template) throw new Error("Expected artifact");
    record.artifactChanges = [
      {
        artifactId: "artifact_added",
        candidate: { ...template, artifactId: "artifact_added" },
        candidateAvailability: "available",
        status: "added",
      },
      {
        artifactId: "artifact_removed",
        baseline: { ...template, artifactId: "artifact_removed" },
        baselineAvailability: "available",
        status: "removed",
      },
      {
        artifactId: "artifact_unavailable",
        baseline: { ...template, artifactId: "artifact_unavailable" },
        baselineAvailability: "revoked",
        status: "unavailable",
      },
    ];
    verify("comparison_result", rehash("comparison_result", record));
  });

  it("retains fixture references from invalid and one-sided comparison cases", () => {
    const record = structuredClone(comparison);
    const fixture = baseline.fixtures[0]?.fixture;
    if (!fixture) throw new Error("Expected fixture");
    const ref = (fixtureId: string) => ({
      ...fixture,
      fixtureId,
      fixtureVersionId: `${fixtureId}_v1`,
    });
    record.cases.push(
      {
        state: "baseline_only",
        fixtureId: "zz_baseline",
        baseline: ref("zz_baseline"),
        candidateMissingReason: "source_unavailable",
      },
      {
        state: "candidate_only",
        fixtureId: "zz_candidate",
        candidate: ref("zz_candidate"),
        baselineMissingReason: "source_unavailable",
      },
      {
        state: "invalid",
        fixtureId: "zz_invalid_base",
        baseline: ref("zz_invalid_base"),
        reasons: ["unresolved_lineage"],
      },
      {
        state: "invalid",
        fixtureId: "zz_invalid_candidate",
        candidate: ref("zz_invalid_candidate"),
        reasons: ["unresolved_lineage"],
      },
    );
    record.pairing = {
      baselineOnlyCount: 1,
      candidateOnlyCount: 1,
      invalidCount: 2,
      pairedCount: comparison.pairing.pairedCount,
      requestedCount: record.cases.length,
    };
    // Existing metric populations stay within the original paired subset.
    record.comparability = { status: "partially_comparable", reasons: ["missing_source_evidence"] };
    verify("comparison_result", rehash("comparison_result", record));
  });

  it("does not turn an accessor failure into empty dependencies", () => {
    const { input, evidence } = prepare("release_policy");
    const failure = new Error("record access failed");
    const broken = {
      ...evidence,
      get record(): PolicyEvaluationControlRecord {
        throw failure;
      },
    };
    expect(() => enumeratePolicyEvaluationControlReferences(input, broken, limits)).toThrow(
      expect.objectContaining({ reason: "input_invalid", cause: failure }),
    );
  });

  it("integrates exact acquired records from real memory stores before expansion", async () => {
    const comparisonStore = new MemoryComparisonRepository();
    await comparisonStore.publishComparisonDefinition(definition);
    await comparisonStore.publishComparisonEvidenceSnapshot(baseline);
    await comparisonStore.publishComparisonEvidenceSnapshot(candidate);
    await comparisonStore.publishComparisonResult(comparison);
    const releaseCandidate = new MemoryReleaseCandidateRepository();
    await releaseCandidate.publishReleaseCandidate(release);
    const releasePolicy = new MemoryReleasePolicyRepository();
    await releasePolicy.publishReleasePolicy(policy);
    const dependencies = {
      comparison: comparisonStore,
      releaseCandidate,
      releasePolicy,
      installationBinding: new StaticPolicyInstallationBindingResolver([binding]),
    };
    for (const kind of kinds) {
      const { input } = prepare(kind);
      const read = await readPolicyEvaluationControlRecord(input, dependencies);
      expect(enumeratePolicyEvaluationControlReferences(input, read, limits)).toEqual(verify(kind));
    }
  });
});

describe("typed unresolved control declarations", () => {
  it("captures a changing declaration discriminator exactly once", () => {
    let reads = 0;
    const declaration = {
      get kind() {
        return ++reads === 1 ? ("artifact_identity" as const) : ("candidate_source" as const);
      },
      reference: "artifact_test",
    };
    expect(
      parsePolicyEvaluationControlDeclaration(declaration as PolicyEvaluationControlDeclaration),
    ).toEqual({ kind: "artifact_identity", reference: "artifact_test" });
    expect(reads).toBe(1);
  });
  const declarations = kinds
    .flatMap((kind) => oracle(records[kind]))
    .filter((item) => item.kind === "control_declaration")
    .map((item) => item.declaration);
  declarations.push(
    { kind: "artifact_identity", reference: "artifact_missing" },
    {
      kind: "comparison_predecessor",
      reference: { comparisonVersionId: "comparison_previous", definitionSha256: "a".repeat(64) },
    },
  );
  for (const declaration of declarations) {
    it(`${declaration.kind}: parses defensively and rejects malformed claims`, () => {
      const parsed = parsePolicyEvaluationControlDeclaration(declaration);
      expect(parsed).toEqual(declaration);
      expect(parsed).not.toBe(declaration);
      if (typeof parsed.reference === "object")
        expect(parsed.reference).not.toBe(declaration.reference);
      for (const invalid of [
        null,
        { ...declaration, approved: true },
        { ...declaration, reference: {} },
        { kind: "unknown", reference: declaration.reference },
      ])
        expect(() =>
          parsePolicyEvaluationControlDeclaration(invalid as PolicyEvaluationControlDeclaration),
        ).toThrow();
      if (typeof declaration.reference === "object")
        expect(() =>
          parsePolicyEvaluationControlDeclaration({
            ...declaration,
            reference: { ...fields(declaration.reference), approved: undefined },
          } as unknown as PolicyEvaluationControlDeclaration),
        ).toThrow();
    });
  }
  it("counts duplicates but rejects contradictory predecessor and safety-event claims", () => {
    for (const original of declarations.filter(
      (item) => item.kind === "comparison_predecessor" || item.kind === "safety_event",
    )) {
      const out = new PolicyEvaluationReferenceCollector(limits);
      out.controlDeclaration("/a", original);
      out.controlDeclaration("/b", original);
      expect(out.result().references).toHaveLength(2);
      const reference = {
        ...fields(original.reference),
        [original.kind === "comparison_predecessor" ? "definitionSha256" : "sourceSha256"]:
          "f".repeat(64),
      };
      expect(() =>
        out.controlDeclaration("/c", {
          ...original,
          reference,
        } as PolicyEvaluationControlDeclaration),
      ).toThrow(expect.objectContaining({ reason: "reference_conflict" }));
    }
  });
});
