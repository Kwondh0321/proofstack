import {
  type ContentReference,
  type CriterionSet,
  type CriterionSetStatusRecord,
  type EvaluationRun,
  type EvaluatorSpec,
  encodeEvaluationCanonicalJson,
  type OracleSpec,
  type PolicyEvaluationManifestEntry,
  type PolicyEvaluationSourceReference,
  policyEvaluationSourceReferenceKey,
  type QualificationFixtureSet,
  type QualificationReport,
  type SourceReviewerQualification,
  type SourceReviewRecord,
  type SourceSnapshot,
} from "@proofstack/contracts";
import {
  type CriteriaTrustArtifactAvailability,
  type CriteriaTrustQualificationEvidence,
  evaluatePolicyCriteriaTrust,
  type PolicyCriteriaTrustEvaluation,
  type PolicyEvaluationEvidenceReferenceLimits,
  PolicyEvaluationReferenceCollector,
} from "@proofstack/core";
import { PolicyRecordGraphError } from "./acquisition-budget.js";
import type { PolicyArtifactCapture } from "./capture-artifact-evidence.js";
import type { PolicyRecordGraph } from "./capture-record-graph.js";
import type { PolicyRecordRead } from "./record-routing.js";

type Source = Extract<PolicyEvaluationSourceReference, { kind: "evaluation_run" }>;
type Retained<T> = { readonly read: PolicyRecordRead; readonly value: T };

export interface PolicyEvaluationTrustPrerequisites {
  readonly parents: readonly {
    readonly source: Source;
    readonly recordSha256: string;
    readonly evaluationTime: string;
    readonly dependencyEdgeIndexes: readonly number[];
    readonly artifactCaptureIndexes: readonly number[];
    readonly observation:
      | { readonly status: "unavailable"; readonly reason: "criterion_set_unavailable" }
      | { readonly status: "inspected"; readonly requirements: PolicyCriteriaTrustEvaluation };
  }[];
  readonly unavailableParents: readonly {
    readonly source: Source;
    readonly observation: Exclude<
      PolicyEvaluationManifestEntry["observation"],
      { status: "verified" }
    >;
  }[];
  readonly inspectionUsage: { readonly references: number; readonly referenceBytes: number };
}

function same(left: unknown, right: unknown): boolean {
  return Buffer.from(encodeEvaluationCanonicalJson(left)).equals(
    encodeEvaluationCanonicalJson(right),
  );
}

/**
 * Internal composition over this capture's exact records and actual artifact observations.
 * The original run owns actor/context/report selection. This does not establish current logical
 * authority, complete history, execution, complete closure, a sealed snapshot or policy eligibility.
 */
export function inspectCapturedEvaluationTrust(
  graph: PolicyRecordGraph,
  artifacts: readonly PolicyArtifactCapture[],
  limits: PolicyEvaluationEvidenceReferenceLimits,
): PolicyEvaluationTrustPrerequisites {
  const meter = new PolicyEvaluationReferenceCollector(limits);
  const nodes = new Map<string, PolicyRecordRead>();
  for (const { read } of graph.nodes) {
    const key = policyEvaluationSourceReferenceKey(read.source);
    if (nodes.has(key)) throw new PolicyRecordGraphError("reference_conflict", key);
    nodes.set(key, read);
  }
  const edgeKey = (source: PolicyEvaluationSourceReference, path: string) =>
    JSON.stringify([policyEvaluationSourceReferenceKey(source), path]);
  const edges = new Map<string, number>();
  graph.edges.forEach((edge, index) => {
    const key = edgeKey(edge.parent, edge.reference.path);
    if (edges.has(key)) throw new PolicyRecordGraphError("reference_conflict", key);
    edges.set(key, index);
  });
  const artifactsByEdge = new Map<number, number>();
  artifacts.forEach(({ origin }, index) => {
    if (origin.kind !== "record") return;
    if (artifactsByEdge.has(origin.edgeIndex))
      throw new PolicyRecordGraphError("observation_conflict");
    artifactsByEdge.set(origin.edgeIndex, index);
  });
  const parents: PolicyEvaluationTrustPrerequisites["parents"][number][] = [];
  const unavailableParents: PolicyEvaluationTrustPrerequisites["unavailableParents"][number][] = [];
  const ordered = [...nodes.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [, parent] of ordered) {
    if (parent.source.kind !== "evaluation_run") continue;
    if (parent.observation.status !== "verified") {
      unavailableParents.push({ source: parent.source, observation: parent.observation });
      continue;
    }
    const run = parent.record as EvaluationRun;
    const dependencyEdgeIndexes: number[] = [];
    const artifactCaptureIndexes: number[] = [];
    const availability = new Map<string, CriteriaTrustArtifactAvailability>();
    const edgeAt = (owner: PolicyRecordRead, path: string) => {
      const index = edges.get(edgeKey(owner.source, path));
      const edge = index === undefined ? undefined : graph.edges[index];
      if (
        index === undefined ||
        !edge ||
        owner.observation.status !== "verified" ||
        edge.parentRecordSha256 !== owner.observation.recordSha256 ||
        !same(edge.parent, owner.source)
      )
        throw new PolicyRecordGraphError("reference_conflict");
      dependencyEdgeIndexes.push(index);
      return { edge, index };
    };
    const read = <T>(
      owner: PolicyRecordRead,
      path: string,
      expected: PolicyEvaluationSourceReference,
    ): Retained<T> | undefined => {
      const { edge } = edgeAt(owner, path);
      if (
        edge.reference.kind !== "record" ||
        !same(edge.reference.source, expected) ||
        !same(edge.target, expected)
      )
        throw new PolicyRecordGraphError("reference_conflict");
      meter.record(path, expected.kind, expected.reference);
      const child = nodes.get(policyEvaluationSourceReferenceKey(expected));
      if (!child || !same(child.source, expected))
        throw new PolicyRecordGraphError("reference_conflict");
      return child.observation.status === "verified"
        ? { read: child, value: child.record as T }
        : undefined;
    };
    const artifact = (owner: PolicyRecordRead, path: string, reference: ContentReference) => {
      const { edge, index } = edgeAt(owner, path);
      if (
        edge.reference.kind !== "artifact" ||
        !same(edge.reference.reference, reference) ||
        edge.target !== null
      )
        throw new PolicyRecordGraphError("reference_conflict");
      meter.artifact(path, reference);
      const captureIndex = artifactsByEdge.get(index);
      const capture = captureIndex === undefined ? undefined : artifacts[captureIndex];
      if (
        captureIndex === undefined ||
        !capture ||
        !same(capture.read.reference, reference) ||
        !same(capture.read.scope, graph.scope) ||
        capture.read.evaluationTime !== graph.evaluationTime
      )
        throw new PolicyRecordGraphError("observation_conflict");
      artifactCaptureIndexes.push(captureIndex);
      const key = JSON.stringify([reference.artifactId, reference.sha256]);
      const state = capture.read.observation.status === "verified" ? "available" : "unavailable";
      const previous = availability.get(key);
      if (previous && previous.state !== state)
        throw new PolicyRecordGraphError("observation_conflict");
      availability.set(key, { artifactId: reference.artifactId, sha256: reference.sha256, state });
    };
    const criterion = read<CriterionSet>(parent, "/criterion/criterionSet", {
      kind: "criterion_set",
      reference: run.criterion.criterionSet,
    });
    const base = {
      source: parent.source,
      recordSha256: parent.observation.recordSha256,
      evaluationTime: graph.evaluationTime,
      dependencyEdgeIndexes,
      artifactCaptureIndexes,
    };
    if (!criterion) {
      parents.push({
        ...base,
        observation: { status: "unavailable", reason: "criterion_set_unavailable" },
      });
      continue;
    }
    const status = read<CriterionSetStatusRecord>(parent, "/criterionStatus", {
      kind: "criterion_set_status",
      reference: run.criterionStatus,
    });
    const reviewers = new Map<string, SourceReviewerQualification>();
    const sources = criterion.value.sources.map((reference, index) => {
      const source = read<SourceSnapshot>(criterion.read, `/sources/${index}/source`, {
        kind: "source_snapshot",
        reference: reference.source,
      });
      const review = read<SourceReviewRecord>(criterion.read, `/sources/${index}/review`, {
        kind: "source_review",
        reference: reference.review,
      });
      if (source) {
        artifact(source.read, "/content", source.value.content);
        if (source.value.identityVerification.status !== "unverified")
          source.value.identityVerification.evidence.forEach((ref, i) => {
            artifact(source.read, `/identityVerification/evidence/${i}`, ref);
          });
      }
      if (review) {
        review.value.reviewBasis.forEach((ref, i) => {
          artifact(review.read, `/reviewBasis/${i}`, ref);
        });
        const qualification = review.value.reviewerQualification;
        const reviewer = qualification
          ? read<SourceReviewerQualification>(review.read, "/reviewerQualification", {
              kind: "source_reviewer_qualification",
              reference: qualification,
            })
          : undefined;
        if (reviewer) {
          reviewers.set(policyEvaluationSourceReferenceKey(reviewer.read.source), reviewer.value);
          reviewer.value.credentialEvidence.forEach((ref, i) => {
            artifact(reviewer.read, `/credentialEvidence/${i}`, ref);
          });
        }
      }
      return { source: source?.value ?? null, review: review?.value ?? null };
    });
    const qualifications = new Map<string, CriteriaTrustQualificationEvidence>();
    for (const role of ["evaluator", "oracle"] as const) {
      const reference = role === "evaluator" ? run.evaluatorQualification : run.oracleQualification;
      const report = read<QualificationReport>(parent, `/${role}Qualification`, {
        kind: "qualification_report",
        reference,
      });
      if (!report) continue;
      const subject =
        report.value.subject.kind === "evaluator"
          ? read<EvaluatorSpec>(report.read, "/subject/evaluator", {
              kind: "evaluator_spec",
              reference: report.value.subject.evaluator,
            })
          : read<OracleSpec>(report.read, "/subject/oracle", {
              kind: "oracle_spec",
              reference: report.value.subject.oracle,
            });
      const fixtureSet = read<QualificationFixtureSet>(report.read, "/fixtureSet", {
        kind: "qualification_fixture_set",
        reference: report.value.fixtureSet,
      });
      report.value.environmentEvidence.forEach((ref, i) => {
        artifact(report.read, `/environmentEvidence/${i}`, ref);
      });
      report.value.caseResults.forEach((result, i) => {
        result.rawEvidence.forEach((ref, j) => {
          artifact(report.read, `/caseResults/${i}/rawEvidence/${j}`, ref);
        });
      });
      qualifications.set(policyEvaluationSourceReferenceKey(report.read.source), {
        report: report.value,
        subject: subject?.value ?? null,
        fixtureSet: fixtureSet?.value ?? null,
      });
    }
    const requirements = evaluatePolicyCriteriaTrust({
      at: graph.evaluationTime,
      criterionSet: criterion.value,
      criterionStatus: status?.value ?? null,
      qualifications: [...qualifications.values()],
      sources,
      reviewerQualifications: [...reviewers.values()],
      artifacts: [...availability.values()],
      request: {
        scope: graph.scope,
        context: run.applicability.context,
        requesterPrincipalId: run.createdByPrincipalId,
      },
    });
    parents.push({ ...base, observation: { status: "inspected", requirements } });
  }
  const usage = meter.result();
  return structuredClone({
    parents,
    unavailableParents,
    inspectionUsage: { references: usage.references.length, referenceBytes: usage.referenceBytes },
  });
}
