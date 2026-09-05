import { describe, expect, it } from "vitest";
import {
  COMPARISON_EVIDENCE_SNAPSHOT_SCHEMA_VERSION,
  ComparisonAssuranceStateSchema,
  ComparisonEvidenceSnapshotDefinitionSchema,
  ComparisonEvidenceSnapshotSchema,
  ComparisonOmissionSchema,
  ComparisonTraceStructureSchema,
  ComparisonUsageValueSchema,
  ComparisonVerdictCountsSchema,
  CreateComparisonEvidenceSnapshotRequestSchema,
} from "./evaluation-comparison.js";

const sha = (character: string) => character.repeat(64);

function replay() {
  return {
    attemptId: "candidate_attempt",
    completedAt: "2026-09-02T01:00:00.000Z",
    jobId: "candidate_job",
    plan: {
      definitionSha256: sha("1"),
      planId: "candidate_plan",
      planVersionId: "candidate_plan_v1",
    },
    result: {
      artifactId: "candidate_result",
      classification: "internal",
      mediaType: "application/json",
      sha256: sha("2"),
      sizeBytes: 128,
    },
    targetRelease: {
      definitionSha256: sha("3"),
      targetAdapter: { name: "local_target", protocolVersion: "1.0.0", version: "1.0.0" },
      targetId: "target_agent",
      targetReleaseId: "candidate_release",
      workerProtocol: { name: "json_line", version: "1.0.0" },
    },
    terminalCode: "completed",
    terminalStatus: "succeeded",
  } as const;
}

function definition() {
  return {
    comparison: {
      comparisonId: "comparison_login",
      comparisonVersionId: "comparison_login_v1",
      definitionSha256: sha("4"),
    },
    dataset: {
      datasetId: "dataset_main",
      datasetVersionId: "dataset_v1",
      definitionSha256: sha("5"),
    },
    fixtures: [
      {
        artifacts: [
          {
            artifact: {
              artifactId: "artifact_output",
              classification: "internal",
              mediaType: "application/json",
              sha256: sha("6"),
              sizeBytes: 256,
            },
            availability: "available",
          },
        ],
        assurance: [
          {
            eligibility: "ineligible",
            kind: "assessment",
            reasons: ["human_review_required"],
            reference: { assessmentId: "assessment_login", definitionSha256: sha("7") },
          },
          {
            eligibility: "ineligible",
            kind: "model_assurance",
            reasons: ["calibration_unavailable"],
            reference: {
              assessmentExtensionId: "assurance_login",
              definitionSha256: sha("8"),
            },
          },
        ],
        evaluationOutcomes: [
          {
            assessment: { assessmentId: "assessment_login", definitionSha256: sha("7") },
            counts: { abstain: 0, error: 0, fail: 1, notApplicable: 0, pass: 0, total: 1 },
            criterion: {
              criterionId: "criterion_login",
              criterionSet: {
                criterionSetId: "criteria_main",
                criterionSetVersionId: "criteria_main_v1",
                definitionSha256: sha("9"),
              },
            },
          },
        ],
        fixture: {
          definitionSha256: sha("a"),
          fixtureId: "fixture_login",
          fixtureVersionId: "fixture_login_v1",
        },
        numericObservations: [
          {
            measurementName: "response_time",
            observation: { definitionSha256: sha("b"), observationId: "observation_login" },
            unit: "milliseconds",
            value: "125.5",
          },
        ],
        replay: replay(),
        safetyEvents: [
          {
            eventId: "safety_guardrail",
            kind: "guardrail_check",
            occurredAt: "2026-09-02T00:59:59.000Z",
            sourceId: "event_guardrail",
            sourceSha256: sha("c"),
          },
        ],
        trace: {
          eventCount: 2,
          eventKinds: [
            { count: 1, kind: "agent.run" },
            { count: 1, kind: "guardrail.check" },
          ],
          eventKindStatuses: [
            { count: 1, kind: "agent.run", status: "ok" },
            { count: 1, kind: "guardrail.check", status: "error" },
          ],
          eventStatuses: [
            { count: 1, status: "error" },
            { count: 1, status: "ok" },
          ],
        },
        usage: [
          {
            dimension: "elapsedMilliseconds",
            value: {
              amount: 125,
              observedCount: 1,
              sources: ["measured"],
              status: "available",
              unavailableCount: 0,
            },
          },
          {
            dimension: "providerCostMicrounits",
            value: {
              amount: 25,
              observedCount: 1,
              sources: ["provider_reported"],
              status: "partial",
              unavailableCount: 1,
              unavailableReasons: ["provider_did_not_report"],
            },
          },
        ],
      },
    ],
    integrity: "verified",
    knownLimitations: ["Synthetic comparison source"],
    omissions: [
      {
        fixtureId: "fixture_login",
        projectionKey: "prompt_plaintext",
        reason: "classified_content_excluded",
        sourceKind: "classified_content",
      },
    ],
    role: "candidate",
    snapshotId: "snapshot_candidate",
    sourceCutoff: "2026-09-02T01:00:01.000Z",
  } as const;
}

describe("comparison evidence snapshot contracts", () => {
  it("accepts a source-backed bounded snapshot without classified plaintext", () => {
    expect(ComparisonEvidenceSnapshotDefinitionSchema.parse(definition())).toEqual(definition());
  });

  it("keeps zero, partial, and unavailable usage distinct", () => {
    expect(
      ComparisonUsageValueSchema.safeParse({
        amount: 0,
        observedCount: 1,
        sources: ["measured"],
        status: "available",
        unavailableCount: 0,
      }).success,
    ).toBe(true);
    expect(
      ComparisonUsageValueSchema.safeParse({
        observedCount: 0,
        status: "unavailable",
        unavailableCount: 1,
        unavailableReasons: ["measurement_failed"],
      }).success,
    ).toBe(true);
    expect(
      ComparisonUsageValueSchema.safeParse({
        amount: 0,
        observedCount: 0,
        sources: [],
        status: "partial",
        unavailableCount: 1,
        unavailableReasons: ["measurement_failed"],
      }).success,
    ).toBe(false);
  });

  it("reconstructs trace and verdict totals exactly", () => {
    const trace = {
      eventCount: 2,
      eventKinds: [
        { count: 1, kind: "agent.run" },
        { count: 1, kind: "guardrail.check" },
      ],
      eventKindStatuses: [
        { count: 1, kind: "agent.run", status: "ok" },
        { count: 1, kind: "guardrail.check", status: "error" },
      ],
      eventStatuses: [
        { count: 1, status: "error" },
        { count: 1, status: "ok" },
      ],
    } as const;
    expect(ComparisonTraceStructureSchema.safeParse(trace).success).toBe(true);
    expect(
      ComparisonTraceStructureSchema.safeParse({
        ...trace,
        eventKindStatuses: [
          { count: 1, kind: "agent.run", status: "error" },
          { count: 1, kind: "guardrail.check", status: "error" },
        ],
      }).success,
    ).toBe(false);
    expect(
      ComparisonTraceStructureSchema.safeParse({
        ...trace,
        eventKindStatuses: [
          ...trace.eventKindStatuses,
          { count: 0, kind: "tool.execute", status: "unset" },
        ],
      }).success,
    ).toBe(false);
    expect(
      ComparisonVerdictCountsSchema.safeParse({
        abstain: 0,
        error: 0,
        fail: 1,
        notApplicable: 0,
        pass: 1,
        total: 1,
      }).success,
    ).toBe(false);
  });

  it("binds every omission to one typed fixture source", () => {
    const omissions = [
      {
        artifactId: "artifact_missing",
        fixtureId: "fixture_login",
        reason: "artifact_unavailable",
        sourceKind: "artifact",
      },
      {
        assessment: { assessmentId: "assessment_optional", definitionSha256: sha("1") },
        fixtureId: "fixture_login",
        reason: "optional_assessment_missing",
        sourceKind: "assessment",
      },
      definition().omissions[0],
      {
        fixtureId: "fixture_login",
        modelAssuranceAssessment: {
          assessmentExtensionId: "assurance_optional",
          definitionSha256: sha("2"),
        },
        reason: "optional_assessment_missing",
        sourceKind: "model_assurance_assessment",
      },
      {
        fixtureId: "fixture_login",
        measurementName: "optional_latency",
        reason: "measurement_unavailable",
        sourceKind: "numeric_measurement",
        unit: "milliseconds",
      },
    ] as const;
    for (const omission of omissions) {
      expect(ComparisonOmissionSchema.safeParse(omission).success).toBe(true);
    }
    expect(
      ComparisonEvidenceSnapshotDefinitionSchema.safeParse({
        ...definition(),
        omissions,
      }).success,
    ).toBe(true);
  });

  it("requires eligibility to agree with exact ordered reasons", () => {
    expect(
      ComparisonAssuranceStateSchema.safeParse({
        eligibility: "eligible",
        kind: "assessment",
        reasons: ["human_review_required"],
        reference: { assessmentId: "assessment_login", definitionSha256: sha("d") },
      }).success,
    ).toBe(false);
    expect(
      ComparisonAssuranceStateSchema.safeParse({
        eligibility: "ineligible",
        kind: "model_assurance",
        reasons: [],
        reference: { assessmentExtensionId: "assurance_login", definitionSha256: sha("e") },
      }).success,
    ).toBe(false);
  });

  it("rejects duplicate source entries and caller-derived snapshot data", () => {
    const valid = definition();
    const fixture = valid.fixtures[0];
    expect(fixture).toBeDefined();
    if (!fixture) return;
    expect(
      ComparisonEvidenceSnapshotDefinitionSchema.safeParse({
        ...valid,
        fixtures: [{ ...fixture, artifacts: [fixture.artifacts[0], fixture.artifacts[0]] }],
      }).success,
    ).toBe(false);
    expect(
      ComparisonEvidenceSnapshotDefinitionSchema.safeParse({
        ...valid,
        omissions: [
          {
            fixtureId: "fixture_login",
            measurementName: "response_time",
            reason: "measurement_unavailable",
            sourceKind: "numeric_measurement",
            unit: "milliseconds",
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      ComparisonEvidenceSnapshotDefinitionSchema.safeParse({
        ...valid,
        omissions: [
          {
            assessment: { assessmentId: "assessment_login", definitionSha256: sha("7") },
            fixtureId: "fixture_login",
            reason: "optional_assessment_missing",
            sourceKind: "assessment",
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      ComparisonEvidenceSnapshotDefinitionSchema.safeParse({
        ...valid,
        omissions: [
          {
            fixtureId: "fixture_login",
            modelAssuranceAssessment: {
              assessmentExtensionId: "assurance_login",
              definitionSha256: sha("8"),
            },
            reason: "optional_assessment_missing",
            sourceKind: "model_assurance_assessment",
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      ComparisonEvidenceSnapshotDefinitionSchema.safeParse({
        ...valid,
        omissions: [
          {
            artifactId: "artifact_output",
            fixtureId: "fixture_login",
            reason: "artifact_unavailable",
            sourceKind: "artifact",
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      ComparisonEvidenceSnapshotDefinitionSchema.safeParse({
        ...valid,
        omissions: [valid.omissions[0], valid.omissions[0]],
      }).success,
    ).toBe(false);
    expect(
      ComparisonEvidenceSnapshotDefinitionSchema.safeParse({
        ...valid,
        omissions: [{ ...valid.omissions[0], fixtureId: "fixture_unknown" }],
      }).success,
    ).toBe(false);
    expect(
      ComparisonEvidenceSnapshotDefinitionSchema.safeParse({
        ...valid,
        omissions: [
          {
            fixtureId: "fixture_login",
            measurementName: "response_time",
            reason: "artifact_unavailable",
            sourceKind: "numeric_measurement",
            unit: "milliseconds",
          },
        ],
      }).success,
    ).toBe(false);

    const request = {
      comparison: valid.comparison,
      role: valid.role,
      snapshotId: valid.snapshotId,
    };
    expect(CreateComparisonEvidenceSnapshotRequestSchema.safeParse(request).success).toBe(true);
    expect(
      CreateComparisonEvidenceSnapshotRequestSchema.safeParse({
        ...request,
        fixtures: valid.fixtures,
        sourceCutoff: valid.sourceCutoff,
      }).success,
    ).toBe(false);
  });

  it("requires canonical server provenance after the source cutoff", () => {
    const record = {
      ...definition(),
      createdAt: "2026-09-02T01:00:02.000Z",
      createdByPrincipalId: "principal_operator",
      definitionSha256: sha("f"),
      schemaVersion: COMPARISON_EVIDENCE_SNAPSHOT_SCHEMA_VERSION,
      scope: {
        environmentId: "environment_reference",
        projectId: "project_reference",
        tenantId: "tenant_reference",
      },
    };
    expect(ComparisonEvidenceSnapshotSchema.safeParse(record).success).toBe(true);
    expect(
      ComparisonEvidenceSnapshotSchema.safeParse({
        ...record,
        createdAt: "2026-09-02T01:00:00.000Z",
      }).success,
    ).toBe(false);
  });
});
