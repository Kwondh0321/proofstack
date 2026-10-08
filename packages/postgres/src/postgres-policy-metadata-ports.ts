import {
  type EvidenceScope,
  EvidenceScopeSchema,
  OpaqueIdSchema,
  RegressionTraceSnapshotDefinitionSchema,
  TraceIdSchema,
} from "@proofstack/contracts";
import type {
  CriterionStatusHistoryRepository,
  ModelAssuranceRecordKind,
  PolicyInstallationBindingResolver,
  RuntimeDefinitionReader,
} from "@proofstack/core";
import type { PolicyEvaluationMetadataPorts } from "@proofstack/policy-evaluation";
import type { PoolClient } from "pg";
import { readPostgresComparisonRecordOnClient } from "./postgres-comparison-repository.js";
import {
  listPostgresCriterionSetStatusesOnClient,
  type PostgresEvaluationRecordByKind,
  readPostgresEvaluationRecordOnClient,
} from "./postgres-evaluation-repository.js";
import { resolvePostgresExactEventsOnClient } from "./postgres-evidence-repository.js";
import { readPostgresModelAssuranceRecordOnClient } from "./postgres-model-assurance-repository.js";
import {
  readPostgresDatasetVersionOnClient,
  readPostgresFixtureVersionOnClient,
  readPostgresRecordedInteractionFixtureContentOnClient,
  readPostgresRecordedInteractionFixtureVersionOnClient,
} from "./postgres-regression-version-repository.js";
import { readPostgresReleaseCandidateOnClient } from "./postgres-release-candidate-repository.js";
import { readPostgresReleasePolicyOnClient } from "./postgres-release-policy-repository.js";
import {
  readPostgresReplayPlanOnClient,
  readPostgresTargetReleaseOnClient,
} from "./postgres-replay-definition-repository.js";
import { readPostgresReplayJobSnapshotOnClient } from "./postgres-replay-job-snapshot.js";

export type PolicySourceTransactionCall = <T>(work: () => Promise<T>) => Promise<T>;

const modelKinds = {
  blinded_evaluation_plan: true,
  blinded_evaluation_result: true,
  calibration_report: true,
  human_review_protocol: true,
  human_review_record: true,
  human_reviewer_independence: true,
  independence_declaration: true,
  independent_critique: true,
  model_assisted_evaluator: true,
  model_assurance_assessment: true,
  model_evaluator_profile: true,
  model_qualification_report: true,
  model_qualification_suite: true,
} satisfies Record<ModelAssuranceRecordKind, true>;

/** Internal adapter composition; the owning transaction has already acquired and verified guards. */
export function createPostgresPolicyMetadataPorts(
  client: Pick<PoolClient, "query">,
  exact: EvidenceScope,
  call: PolicySourceTransactionCall,
  catalogues: {
    readonly installationBinding: PolicyInstallationBindingResolver;
    readonly runtimeDefinitions: RuntimeDefinitionReader;
  },
): Omit<PolicyEvaluationMetadataPorts, "sources"> {
  const scoped = <T>(scopeInput: EvidenceScope, work: (scope: EvidenceScope) => Promise<T>) =>
    call(async () => {
      const scope = EvidenceScopeSchema.parse(scopeInput);
      if (
        scope.tenantId !== exact.tenantId ||
        scope.projectId !== exact.projectId ||
        scope.environmentId !== exact.environmentId
      )
        throw new TypeError("Policy metadata port scope differs from its transaction scope");
      return work(scope);
    });
  const id = (value: string) => OpaqueIdSchema.parse(value);
  const evaluation =
    <K extends keyof PostgresEvaluationRecordByKind>(kind: K) =>
    (scope: EvidenceScope, value: string) =>
      scoped(scope, (owned) =>
        readPostgresEvaluationRecordOnClient(client, owned, kind, id(value)),
      );
  const criterionStatusHistory: CriterionStatusHistoryRepository = {
    listCriterionSetStatuses: (scope, limits) =>
      scoped(scope, (owned) => listPostgresCriterionSetStatusesOnClient(client, owned, limits)),
  };
  return {
    records: {
      control: {
        comparison: {
          findComparisonDefinition: (scope, value) =>
            scoped(scope, (owned) =>
              readPostgresComparisonRecordOnClient(
                client,
                owned,
                "comparison_definition",
                id(value),
              ),
            ),
          findComparisonEvidenceSnapshot: (scope, value) =>
            scoped(scope, (owned) =>
              readPostgresComparisonRecordOnClient(
                client,
                owned,
                "comparison_evidence_snapshot",
                id(value),
              ),
            ),
          findComparisonResult: (scope, value) =>
            scoped(scope, (owned) =>
              readPostgresComparisonRecordOnClient(client, owned, "comparison_result", id(value)),
            ),
        },
        releaseCandidate: {
          findReleaseCandidate: (scope, value) =>
            scoped(scope, (owned) =>
              readPostgresReleaseCandidateOnClient(client, owned, id(value)),
            ),
        },
        releasePolicy: {
          findReleasePolicy: (scope, value) =>
            scoped(scope, (owned) => readPostgresReleasePolicyOnClient(client, owned, id(value))),
        },
        installationBinding: {
          resolve: ({ scope, reference }) =>
            scoped(scope, (owned) =>
              catalogues.installationBinding.resolve({ scope: owned, reference }),
            ),
        },
      },
      evidence: {
        evaluation: {
          findAggregationPolicy: evaluation("aggregation_policy"),
          findAssessment: evaluation("assessment"),
          findCriterionSet: evaluation("criterion_set"),
          findCriterionSetStatus: evaluation("criterion_set_status"),
          findDiscoveryRecord: evaluation("discovery_record"),
          findEvaluationAggregate: evaluation("evaluation_aggregate"),
          findEvaluationRun: evaluation("evaluation_run"),
          findEvaluationRunRejection: evaluation("evaluation_run_rejection"),
          findEvaluationRunResult: evaluation("evaluation_run_result"),
          findEvaluatorSpec: evaluation("evaluator_spec"),
          findOracleSpec: evaluation("oracle_spec"),
          findQualificationFixtureSet: evaluation("qualification_fixture_set"),
          findQualificationReport: evaluation("qualification_report"),
          findRawObservation: evaluation("raw_observation"),
          findSourceReview: evaluation("source_review"),
          findSourceReviewerQualification: evaluation("source_reviewer_qualification"),
          findSourceSnapshot: evaluation("source_snapshot"),
        },
        modelAssurance: {
          find: (scope, kind, value) =>
            scoped(scope, (owned) => {
              if (!Object.hasOwn(modelKinds, kind))
                throw new TypeError("Unsupported model-assurance kind");
              return readPostgresModelAssuranceRecordOnClient(client, owned, kind, id(value));
            }),
        },
      },
      datasets: {
        findDatasetVersion: (scope, value) =>
          scoped(scope, (owned) => readPostgresDatasetVersionOnClient(client, owned, id(value))),
        findFixtureVersion: (scope, value) =>
          scoped(scope, (owned) => readPostgresFixtureVersionOnClient(client, owned, id(value))),
        findRecordedInteractionFixtureVersion: (scope, value) =>
          scoped(scope, (owned) =>
            readPostgresRecordedInteractionFixtureVersionOnClient(client, owned, id(value)),
          ),
      },
      replayDefinitions: {
        findReplayPlan: (scope, value) =>
          scoped(scope, (owned) => readPostgresReplayPlanOnClient(client, owned, id(value))),
        findTargetRelease: (scope, value) =>
          scoped(scope, (owned) => readPostgresTargetReleaseOnClient(client, owned, id(value))),
      },
      replayResults: {
        findJob: (scope, value) =>
          scoped(scope, (owned) => readPostgresReplayJobSnapshotOnClient(client, owned, id(value))),
      },
      runtimeDefinitions: {
        findRuntimeProfile: (scope, value, version) =>
          scoped(scope, (owned) =>
            catalogues.runtimeDefinitions.findRuntimeProfile(owned, value, version),
          ),
        findIsolationProfile: (scope, value, version) =>
          scoped(scope, (owned) =>
            catalogues.runtimeDefinitions.findIsolationProfile(owned, value, version),
          ),
        findRuntimeAdapter: (scope, value) =>
          scoped(scope, (owned) => catalogues.runtimeDefinitions.findRuntimeAdapter(owned, value)),
      },
    },
    evidence: {
      resolveExactEvents: (scope, traceId, eventIds) =>
        scoped(scope, (owned) =>
          resolvePostgresExactEventsOnClient(
            client,
            owned,
            TraceIdSchema.parse(traceId),
            RegressionTraceSnapshotDefinitionSchema.shape.eventIds.parse(eventIds),
          ),
        ),
    },
    criterionStatusHistory,
    fixtureContent: {
      findRecordedInteractionFixtureContent: (scope, value) =>
        scoped(scope, (owned) =>
          readPostgresRecordedInteractionFixtureContentOnClient(client, owned, id(value)),
        ),
    },
  };
}
