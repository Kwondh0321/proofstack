import { describe, expect, it } from "vitest";
import {
  PolicyEvaluationSourceReferenceSchema,
  PolicyEvaluationSourceKeySchema,
  policyEvaluationSourceReferenceKey,
} from "./policy-evaluation-source-reference.js";
import {
  PolicyEvaluationExpectedSourcesSchema,
  PolicyEvaluationManifestPageDefinitionSchema,
} from "./policy-evaluation-manifest.js";

const cases = [
  {
    kind: "aggregation_policy",
    reference: {
      definitionSha256: "1111111111111111111111111111111111111111111111111111111111111111",
      policyVersionId: "record_one",
      policyId: "logical_one",
    },
    key: "aggregation_policy:record_one",
  },
  {
    kind: "assessment",
    reference: {
      definitionSha256: "1111111111111111111111111111111111111111111111111111111111111111",
      assessmentId: "record_one",
    },
    key: "assessment:record_one",
  },
  {
    kind: "blinded_plan",
    reference: {
      definitionSha256: "1111111111111111111111111111111111111111111111111111111111111111",
      blindedPlanVersionId: "record_one",
      blindedPlanId: "logical_one",
    },
    key: "blinded_plan:record_one",
  },
  {
    kind: "blinded_result",
    reference: {
      definitionSha256: "1111111111111111111111111111111111111111111111111111111111111111",
      resultId: "record_one",
    },
    key: "blinded_result:record_one",
  },
  {
    kind: "calibration_report",
    reference: {
      definitionSha256: "1111111111111111111111111111111111111111111111111111111111111111",
      calibrationReportId: "record_one",
    },
    key: "calibration_report:record_one",
  },
  {
    kind: "comparison_definition",
    reference: {
      definitionSha256: "1111111111111111111111111111111111111111111111111111111111111111",
      comparisonVersionId: "record_one",
      comparisonId: "logical_one",
    },
    key: "comparison_definition:record_one",
  },
  {
    kind: "comparison_result",
    reference: {
      definitionSha256: "1111111111111111111111111111111111111111111111111111111111111111",
      resultId: "record_one",
    },
    key: "comparison_result:record_one",
  },
  {
    kind: "comparison_snapshot",
    reference: {
      definitionSha256: "1111111111111111111111111111111111111111111111111111111111111111",
      snapshotId: "record_one",
      role: "candidate",
    },
    key: "comparison_snapshot:record_one",
  },
  {
    kind: "criterion_set",
    reference: {
      definitionSha256: "1111111111111111111111111111111111111111111111111111111111111111",
      criterionSetVersionId: "record_one",
      criterionSetId: "logical_one",
    },
    key: "criterion_set:record_one",
  },
  {
    kind: "criterion_set_status",
    reference: {
      definitionSha256: "1111111111111111111111111111111111111111111111111111111111111111",
      statusRecordId: "record_one",
    },
    key: "criterion_set_status:record_one",
  },
  {
    kind: "dataset_version",
    reference: {
      definitionSha256: "1111111111111111111111111111111111111111111111111111111111111111",
      datasetVersionId: "record_one",
      datasetId: "logical_one",
    },
    key: "dataset_version:record_one",
  },
  {
    kind: "discovery_record",
    reference: {
      definitionSha256: "1111111111111111111111111111111111111111111111111111111111111111",
      discoveryId: "record_one",
    },
    key: "discovery_record:record_one",
  },
  {
    kind: "evaluation_aggregate",
    reference: {
      definitionSha256: "1111111111111111111111111111111111111111111111111111111111111111",
      aggregateId: "record_one",
    },
    key: "evaluation_aggregate:record_one",
  },
  {
    kind: "evaluation_run",
    reference: {
      definitionSha256: "1111111111111111111111111111111111111111111111111111111111111111",
      evaluationRunId: "record_one",
    },
    key: "evaluation_run:record_one",
  },
  {
    kind: "evaluation_run_rejection",
    reference: {
      definitionSha256: "1111111111111111111111111111111111111111111111111111111111111111",
      rejectionId: "record_one",
    },
    key: "evaluation_run_rejection:record_one",
  },
  {
    kind: "evaluation_run_result",
    reference: {
      definitionSha256: "1111111111111111111111111111111111111111111111111111111111111111",
      resultId: "record_one",
      evaluationRunId: "logical_one",
    },
    key: "evaluation_run_result:record_one",
  },
  {
    kind: "evaluator_spec",
    reference: {
      definitionSha256: "1111111111111111111111111111111111111111111111111111111111111111",
      evaluatorVersionId: "record_one",
      evaluatorId: "logical_one",
    },
    key: "evaluator_spec:record_one",
  },
  {
    kind: "human_review_protocol",
    reference: {
      definitionSha256: "1111111111111111111111111111111111111111111111111111111111111111",
      protocolVersionId: "record_one",
      protocolId: "logical_one",
    },
    key: "human_review_protocol:record_one",
  },
  {
    kind: "human_review_record",
    reference: {
      definitionSha256: "1111111111111111111111111111111111111111111111111111111111111111",
      reviewId: "record_one",
    },
    key: "human_review_record:record_one",
  },
  {
    kind: "human_reviewer_independence",
    reference: {
      definitionSha256: "1111111111111111111111111111111111111111111111111111111111111111",
      declarationId: "record_one",
    },
    key: "human_reviewer_independence:record_one",
  },
  {
    kind: "independence_declaration",
    reference: {
      definitionSha256: "1111111111111111111111111111111111111111111111111111111111111111",
      independenceDeclarationId: "record_one",
    },
    key: "independence_declaration:record_one",
  },
  {
    kind: "independent_critique",
    reference: {
      definitionSha256: "1111111111111111111111111111111111111111111111111111111111111111",
      critiqueId: "record_one",
    },
    key: "independent_critique:record_one",
  },
  {
    kind: "model_assisted_evaluator_spec",
    reference: {
      definitionSha256: "1111111111111111111111111111111111111111111111111111111111111111",
      evaluatorVersionId: "record_one",
      evaluatorId: "logical_one",
    },
    key: "model_assisted_evaluator_spec:record_one",
  },
  {
    kind: "model_assurance_assessment",
    reference: {
      definitionSha256: "1111111111111111111111111111111111111111111111111111111111111111",
      assessmentExtensionId: "record_one",
    },
    key: "model_assurance_assessment:record_one",
  },
  {
    kind: "model_evaluator_profile",
    reference: {
      definitionSha256: "1111111111111111111111111111111111111111111111111111111111111111",
      modelProfileVersionId: "record_one",
      modelProfileId: "logical_one",
    },
    key: "model_evaluator_profile:record_one",
  },
  {
    kind: "model_qualification_report",
    reference: {
      definitionSha256: "1111111111111111111111111111111111111111111111111111111111111111",
      reportId: "record_one",
    },
    key: "model_qualification_report:record_one",
  },
  {
    kind: "model_qualification_suite",
    reference: {
      definitionSha256: "1111111111111111111111111111111111111111111111111111111111111111",
      suiteVersionId: "record_one",
      suiteId: "logical_one",
    },
    key: "model_qualification_suite:record_one",
  },
  {
    kind: "oracle_spec",
    reference: {
      definitionSha256: "1111111111111111111111111111111111111111111111111111111111111111",
      oracleVersionId: "record_one",
      oracleId: "logical_one",
    },
    key: "oracle_spec:record_one",
  },
  {
    kind: "policy_installation_binding",
    reference: {
      definitionSha256: "1111111111111111111111111111111111111111111111111111111111111111",
      bindingVersionId: "record_one",
      installationId: "logical_one",
    },
    key: "policy_installation_binding:record_one",
  },
  {
    kind: "qualification_fixture_set",
    reference: {
      definitionSha256: "1111111111111111111111111111111111111111111111111111111111111111",
      fixtureSetVersionId: "record_one",
      fixtureSetId: "logical_one",
    },
    key: "qualification_fixture_set:record_one",
  },
  {
    kind: "qualification_report",
    reference: {
      definitionSha256: "1111111111111111111111111111111111111111111111111111111111111111",
      qualificationReportId: "record_one",
    },
    key: "qualification_report:record_one",
  },
  {
    kind: "raw_observation",
    reference: {
      definitionSha256: "1111111111111111111111111111111111111111111111111111111111111111",
      observationId: "record_one",
    },
    key: "raw_observation:record_one",
  },
  {
    kind: "regression_fixture_version",
    reference: {
      definitionSha256: "1111111111111111111111111111111111111111111111111111111111111111",
      fixtureVersionId: "record_one",
      fixtureId: "logical_one",
    },
    key: "regression_fixture_version:record_one",
  },
  {
    kind: "release_candidate",
    reference: {
      definitionSha256: "1111111111111111111111111111111111111111111111111111111111111111",
      candidateVersionId: "record_one",
      candidateId: "logical_one",
    },
    key: "release_candidate:record_one",
  },
  {
    kind: "release_policy",
    reference: {
      definitionSha256: "1111111111111111111111111111111111111111111111111111111111111111",
      policyVersionId: "record_one",
      policyId: "logical_one",
    },
    key: "release_policy:record_one",
  },
  {
    kind: "replay_isolation_profile",
    reference: {
      definitionSha256: "1111111111111111111111111111111111111111111111111111111111111111",
      id: "record_one",
      kind: "container",
      version: "1.0+build",
    },
    key: "replay_isolation_profile:record_one:1.0+build",
  },
  {
    kind: "replay_plan",
    reference: {
      definitionSha256: "1111111111111111111111111111111111111111111111111111111111111111",
      planVersionId: "record_one",
      planId: "logical_one",
    },
    key: "replay_plan:record_one",
  },
  {
    kind: "replay_result",
    reference: {
      attemptId: "record_one",
      completedAt: "2026-09-07T00:00:00.123456789012345678901234567890Z",
      jobId: "job_one",
      plan: {
        definitionSha256: "1111111111111111111111111111111111111111111111111111111111111111",
        planId: "plan_one",
        planVersionId: "plan_version",
      },
      result: {
        artifactId: "artifact_one",
        classification: "metadata",
        mediaType: "application/json",
        sha256: "1111111111111111111111111111111111111111111111111111111111111111",
        sizeBytes: 123,
      },
      targetRelease: {
        definitionSha256: "1111111111111111111111111111111111111111111111111111111111111111",
        targetId: "target_one",
        targetReleaseId: "target_version",
        targetAdapter: {
          name: "adapter",
          protocolVersion: "1",
          version: "1",
        },
        workerProtocol: {
          name: "worker",
          version: "1",
        },
      },
      terminalCode: "completed",
      terminalStatus: "succeeded",
    },
    key: "replay_result:record_one",
  },
  {
    kind: "replay_runtime_profile",
    reference: {
      definitionSha256: "1111111111111111111111111111111111111111111111111111111111111111",
      id: "record_one",
      family: "reference",
      version: "1.0+build",
    },
    key: "replay_runtime_profile:record_one:1.0+build",
  },
  {
    kind: "runtime_adapter",
    reference: {
      definitionSha256: "1111111111111111111111111111111111111111111111111111111111111111",
      adapterVersionId: "record_one",
      adapterId: "logical_one",
    },
    key: "runtime_adapter:record_one",
  },
  {
    kind: "source_review",
    reference: {
      definitionSha256: "1111111111111111111111111111111111111111111111111111111111111111",
      sourceReviewId: "record_one",
    },
    key: "source_review:record_one",
  },
  {
    kind: "source_reviewer_qualification",
    reference: {
      definitionSha256: "1111111111111111111111111111111111111111111111111111111111111111",
      qualificationId: "record_one",
    },
    key: "source_reviewer_qualification:record_one",
  },
  {
    kind: "source_snapshot",
    reference: {
      definitionSha256: "1111111111111111111111111111111111111111111111111111111111111111",
      sourceSnapshotId: "record_one",
    },
    key: "source_snapshot:record_one",
  },
  {
    kind: "target_release",
    reference: {
      definitionSha256: "1111111111111111111111111111111111111111111111111111111111111111",
      targetReleaseId: "record_one",
      targetId: "logical_one",
      targetAdapter: {
        name: "adapter",
        protocolVersion: "1",
        version: "1",
      },
      workerProtocol: {
        name: "worker",
        version: "1",
      },
    },
    key: "target_release:record_one",
  },
] as const;

describe("exact policy evaluation source identities", () => {
  it("covers every registered source kind with independently declared identities", () => {
    expect(cases).toHaveLength(44);
    expect(
      PolicyEvaluationSourceReferenceSchema.options.map((schema) => schema.shape.kind.value).sort(),
    ).toEqual(cases.map(({ kind }) => kind));
  });

  it.each(cases)(
    "retains the complete $kind reference and repository key",
    ({ kind, reference, key }) => {
      const value = PolicyEvaluationSourceReferenceSchema.parse({ kind, reference });
      expect(value).toEqual({ kind, reference });
      expect(policyEvaluationSourceReferenceKey(value)).toBe(key);
      expect(PolicyEvaluationSourceKeySchema.safeParse(key).success).toBe(true);
      expect(
        PolicyEvaluationSourceReferenceSchema.safeParse({ kind, reference, approval: true })
          .success,
      ).toBe(false);
      expect(
        PolicyEvaluationSourceReferenceSchema.safeParse({
          kind,
          reference: { ...reference, secret: "not allowed" },
        }).success,
      ).toBe(false);
      expect(PolicyEvaluationSourceReferenceSchema.safeParse({ kind, reference: {} }).success).toBe(
        false,
      );
    },
  );

  it.each(cases.filter(({ kind }) => kind !== "replay_result"))(
    "does not turn a $kind digest conflict into another identity",
    ({ kind, reference }) => {
      const original = PolicyEvaluationSourceReferenceSchema.parse({ kind, reference });
      const changed = PolicyEvaluationSourceReferenceSchema.parse({
        kind,
        reference: { ...reference, definitionSha256: "2".repeat(64) },
      });
      expect(policyEvaluationSourceReferenceKey(changed)).toBe(
        policyEvaluationSourceReferenceKey(original),
      );
      expect(PolicyEvaluationExpectedSourcesSchema.safeParse([original, changed]).success).toBe(
        false,
      );
    },
  );

  it("rejects a duplicate replay attempt despite a different job, target, result digest or receipt", () => {
    const fixture = cases.find(({ kind }) => kind === "replay_result");
    if (fixture?.kind !== "replay_result") throw new Error("Expected replay result fixture");
    for (const patch of [
      { jobId: "job_other" },
      { completedAt: "2026-09-07T00:00:00.123456789012345678901234567891Z" },
      { result: { ...fixture.reference.result, sha256: "2".repeat(64) } },
    ]) {
      const first = PolicyEvaluationSourceReferenceSchema.parse({
        kind: fixture.kind,
        reference: fixture.reference,
      });
      const second = PolicyEvaluationSourceReferenceSchema.parse({
        kind: fixture.kind,
        reference: { ...fixture.reference, ...patch },
      });
      expect(policyEvaluationSourceReferenceKey(first)).toBe(
        policyEvaluationSourceReferenceKey(second),
      );
      expect(PolicyEvaluationExpectedSourcesSchema.safeParse([first, second]).success).toBe(false);
    }
  });

  it("rejects duplicate identities on a page before any digest-based deduplication", () => {
    const source = PolicyEvaluationSourceReferenceSchema.parse({
      kind: "comparison_result",
      reference: { resultId: "result_one", definitionSha256: "1".repeat(64) },
    });
    expect(
      PolicyEvaluationManifestPageDefinitionSchema.safeParse({
        entries: [
          { source, observation: { status: "missing" } },
          {
            source: {
              ...source,
              reference: { ...source.reference, definitionSha256: "2".repeat(64) },
            },
            observation: { status: "missing" },
          },
        ],
        entryCount: 2,
        manifestId: "manifest_one",
        pageIndex: 0,
        request: { evaluationRequestId: "request_one", definitionSha256: "3".repeat(64) },
      }).success,
    ).toBe(false);
  });

  it("treats a different logical parent or snapshot role under one record ID as a conflict", () => {
    for (const [kind, original, changed] of [
      [
        "release_candidate",
        {
          candidateId: "candidate_one",
          candidateVersionId: "candidate_version",
          definitionSha256: "1".repeat(64),
        },
        {
          candidateId: "candidate_two",
          candidateVersionId: "candidate_version",
          definitionSha256: "1".repeat(64),
        },
      ],
      [
        "comparison_snapshot",
        { role: "baseline", snapshotId: "snapshot_one", definitionSha256: "1".repeat(64) },
        { role: "candidate", snapshotId: "snapshot_one", definitionSha256: "1".repeat(64) },
      ],
    ] as const) {
      const first = PolicyEvaluationSourceReferenceSchema.parse({ kind, reference: original });
      const second = PolicyEvaluationSourceReferenceSchema.parse({ kind, reference: changed });
      expect(policyEvaluationSourceReferenceKey(first)).toBe(
        policyEvaluationSourceReferenceKey(second),
      );
      expect(PolicyEvaluationExpectedSourcesSchema.safeParse([first, second]).success).toBe(false);
    }
  });

  it.each(["approval", "decision", "custom", "latest", "artifact_bytes"])(
    "rejects unregistered kind %s",
    (kind) => {
      expect(
        PolicyEvaluationSourceReferenceSchema.safeParse({
          kind,
          reference: { id: "record_one", definitionSha256: "1".repeat(64) },
        }).success,
      ).toBe(false);
    },
  );
});
