import {
  EvidenceScopeSchema,
  OpaqueIdSchema,
  PolicyEvaluationWorkerMutationFenceSchema,
  serializeEvaluationCanonicalJson,
  type EvidenceScope,
  type PolicyEvaluationWorkerMutationFence,
} from "@proofstack/contracts";
import type { PolicyArtifactEvidenceRepositories } from "@proofstack/policy-evaluation";
import type { PolicyTransactionPool } from "./bounded-policy-transaction.js";
import {
  PostgresPolicyEvaluationJobReader,
  PostgresPolicyEvaluationJobContractError,
} from "./postgres-policy-evaluation-job-base.js";
import { createPostgresPolicyMetadataPorts } from "./postgres-policy-metadata-ports.js";
import {
  copyPostgresPolicyMetadataCatalogues,
  type PostgresPolicyMetadataCatalogues,
} from "./postgres-policy-source-ports.js";
import { readPostgresArtifactCatalogOnClient } from "./postgres-artifact-catalog-repository.js";
import { listPostgresReleasePolicyLifecycleEventsOnClient } from "./postgres-release-policy-repository.js";

export interface PostgresPolicyInitialSourceIdentity {
  readonly scope: EvidenceScope;
  readonly fence: PolicyEvaluationWorkerMutationFence;
  readonly allowanceId: string;
}
type ReadPorts = ReturnType<typeof createPostgresPolicyMetadataPorts> & {
  readonly catalog: {
    find: (
      scope: EvidenceScope,
      artifactId: string,
    ) => ReturnType<typeof readPostgresArtifactCatalogOnClient>;
  };
  readonly policyHistory: (
    scope: EvidenceScope,
    policyVersionId: string,
  ) => ReturnType<typeof listPostgresReleasePolicyLifecycleEventsOnClient>;
};
const same = (a: unknown, b: unknown) =>
  serializeEvaluationCanonicalJson(a) === serializeEvaluationCanonicalJson(b);

/** Private transport owner. Only fixed leaf readers, never this callback interface, escape. */
class InitialSourceTransactions extends PostgresPolicyEvaluationJobReader {
  private readonly identity;
  private readonly catalogues;
  constructor(
    pool: PolicyTransactionPool,
    identity: PostgresPolicyInitialSourceIdentity,
    catalogues: PostgresPolicyMetadataCatalogues,
  ) {
    super(pool);
    this.identity = {
      scope: EvidenceScopeSchema.parse(identity.scope),
      fence: PolicyEvaluationWorkerMutationFenceSchema.parse(identity.fence),
      allowanceId: OpaqueIdSchema.parse(identity.allowanceId),
    };
    this.catalogues = copyPostgresPolicyMetadataCatalogues(catalogues);
  }
  async read<T>(
    input: EvidenceScope,
    operation: (ports: ReadPorts, scope: EvidenceScope) => Promise<T>,
  ) {
    const scope = EvidenceScopeSchema.parse(input);
    if (!same(scope, this.identity.scope))
      throw new PostgresPolicyEvaluationJobContractError("Initial source scope differs from job");
    return this.transact(
      scope,
      async (client) => {
        const { fence, allowanceId } = this.identity;
        const job = this.inspect(
          await this.one(
            client,
            "SELECT public.proofstack_prepare_policy_evaluation_job_mutation($1) AS value",
            [fence.jobId],
          ),
          scope,
          fence.jobId,
        );
        await this.admitWorkerBudget(client, job, fence);
        if (
          job.job.status !== "acquiring" ||
          job.job.snapshot !== null ||
          job.acquisitionAllowance?.allowanceId !== allowanceId ||
          !same(job.acquisitionAllowance.mutationFence, fence)
        )
          throw new PostgresPolicyEvaluationJobContractError(
            "Initial source read lacks its exact open acquisition credit",
          );
        await this.lastOnClient(client, scope, job);
        await this.verifyIntents(client, job);
        return operation(
          {
            ...createPostgresPolicyMetadataPorts(
              client,
              scope,
              async (work) => work(),
              this.catalogues,
            ),
            catalog: {
              find: (exact, id) => {
                if (!same(EvidenceScopeSchema.parse(exact), scope))
                  throw new PostgresPolicyEvaluationJobContractError(
                    "Catalog scope differs from job",
                  );
                return readPostgresArtifactCatalogOnClient(client, scope, OpaqueIdSchema.parse(id));
              },
            },
            policyHistory: (exact, id) => {
              if (!same(EvidenceScopeSchema.parse(exact), scope))
                throw new PostgresPolicyEvaluationJobContractError("Policy scope differs from job");
              return listPostgresReleasePolicyLifecycleEventsOnClient(
                client,
                scope,
                OpaqueIdSchema.parse(id),
              );
            },
          },
          scope,
        );
      },
      { requireWire: true },
    );
  }
}

/**
 * Server-owned initial reads on one exact acquiring fence/credit. Every leaf ends its bounded
 * transaction before returning. No source guard, object/key I/O or publication port is exposed.
 * The acquisition composition still owns cumulative response admission and drained settlement.
 */
export function createPostgresPolicyInitialSources(
  pool: PolicyTransactionPool,
  identity: PostgresPolicyInitialSourceIdentity,
  catalogues: PostgresPolicyMetadataCatalogues = {},
) {
  const transactions = new InitialSourceTransactions(pool, identity, catalogues);
  function lift<Args extends unknown[], Result>(
    select: (ports: ReadPorts) => (scope: EvidenceScope, ...args: Args) => Promise<Result>,
  ) {
    return async (scope: EvidenceScope, ...args: Args): Promise<Result> => {
      const copied = structuredClone(args);
      return transactions.read(scope, (ports, owned) => select(ports)(owned, ...copied));
    };
  }
  const findEvaluationLogicalRoot: NonNullable<
    PolicyArtifactEvidenceRepositories["logicalRoots"]
  >["evaluation"]["findEvaluationLogicalRoot"] = (scope, kind, id) =>
    transactions.read(scope, (ports, owned) =>
      ports.records.logicalRoots!.evaluation.findEvaluationLogicalRoot(owned, kind, id),
    );
  const findModelAssurance: PolicyArtifactEvidenceRepositories["evidence"]["modelAssurance"]["find"] =
    (scope, kind, id) =>
      transactions.read(scope, (ports, owned) =>
        ports.records.evidence.modelAssurance.find(owned, kind, id),
      );
  const repositories = {
    logicalRoots: {
      evaluation: {
        findEvaluationLogicalRoot,
      },
      comparison: {
        findComparisonLogicalRoot: lift(
          (p) => p.records.logicalRoots!.comparison.findComparisonLogicalRoot,
        ),
      },
      releaseCandidate: {
        findReleaseCandidateLogicalRoot: lift(
          (p) => p.records.logicalRoots!.releaseCandidate.findReleaseCandidateLogicalRoot,
        ),
      },
      releasePolicy: {
        findReleasePolicyLogicalRoot: lift(
          (p) => p.records.logicalRoots!.releasePolicy.findReleasePolicyLogicalRoot,
        ),
      },
      datasets: {
        findDatasetLogicalRoot: lift(
          (p) => p.records.logicalRoots!.datasets.findDatasetLogicalRoot,
        ),
        findFixtureLogicalRoot: lift(
          (p) => p.records.logicalRoots!.datasets.findFixtureLogicalRoot,
        ),
        findRecordedInteractionFixtureLogicalRoot: lift(
          (p) => p.records.logicalRoots!.datasets.findRecordedInteractionFixtureLogicalRoot,
        ),
      },
    },
    protocolDefinitions: {
      findProtocolDefinition: lift((p) => p.records.protocolDefinitions!.findProtocolDefinition),
      listProtocolDefinitions: lift((p) => p.records.protocolDefinitions!.listProtocolDefinitions),
    },
    endpointProfiles: {
      findEndpointProfile: lift((p) => p.records.endpointProfiles!.findEndpointProfile),
    },
    qualificationPolicies: {
      findQualificationPolicy: lift(
        (p) => p.records.qualificationPolicies!.findQualificationPolicy,
      ),
    },
    implementationRegistrations: {
      findEvaluationImplementationRegistration: lift(
        (p) => p.records.implementationRegistrations!.findEvaluationImplementationRegistration,
      ),
    },
    control: {
      comparison: {
        findComparisonDefinition: lift(
          (p) => p.records.control.comparison.findComparisonDefinition,
        ),
        findComparisonEvidenceSnapshot: lift(
          (p) => p.records.control.comparison.findComparisonEvidenceSnapshot,
        ),
        findComparisonResult: lift((p) => p.records.control.comparison.findComparisonResult),
      },
      releaseCandidate: {
        findReleaseCandidate: lift((p) => p.records.control.releaseCandidate.findReleaseCandidate),
      },
      releasePolicy: {
        findReleasePolicy: lift((p) => p.records.control.releasePolicy.findReleasePolicy),
        listReleasePolicyLifecycleEvents: lift((p) => p.policyHistory),
      },
      installationBinding: {
        resolve: async (
          input: Parameters<
            NonNullable<
              PolicyArtifactEvidenceRepositories["control"]["installationBinding"]
            >["resolve"]
          >[0],
        ) => {
          const copied = structuredClone(input);
          return transactions.read(copied.scope, (p, owned) =>
            p.records.control.installationBinding!.resolve({ ...copied, scope: owned }),
          );
        },
      },
    },
    evidence: {
      evaluation: {
        findAggregationPolicy: lift((p) => p.records.evidence.evaluation.findAggregationPolicy),
        findAssessment: lift((p) => p.records.evidence.evaluation.findAssessment),
        findCriterionSet: lift((p) => p.records.evidence.evaluation.findCriterionSet),
        findCriterionSetStatus: lift((p) => p.records.evidence.evaluation.findCriterionSetStatus),
        findDiscoveryRecord: lift((p) => p.records.evidence.evaluation.findDiscoveryRecord),
        findEvaluationAggregate: lift((p) => p.records.evidence.evaluation.findEvaluationAggregate),
        findEvaluationRun: lift((p) => p.records.evidence.evaluation.findEvaluationRun),
        findEvaluationRunRejection: lift(
          (p) => p.records.evidence.evaluation.findEvaluationRunRejection,
        ),
        findEvaluationRunResult: lift((p) => p.records.evidence.evaluation.findEvaluationRunResult),
        findEvaluatorSpec: lift((p) => p.records.evidence.evaluation.findEvaluatorSpec),
        findOracleSpec: lift((p) => p.records.evidence.evaluation.findOracleSpec),
        findQualificationFixtureSet: lift(
          (p) => p.records.evidence.evaluation.findQualificationFixtureSet,
        ),
        findQualificationReport: lift((p) => p.records.evidence.evaluation.findQualificationReport),
        findRawObservation: lift((p) => p.records.evidence.evaluation.findRawObservation),
        findSourceReview: lift((p) => p.records.evidence.evaluation.findSourceReview),
        findSourceReviewerQualification: lift(
          (p) => p.records.evidence.evaluation.findSourceReviewerQualification,
        ),
        findSourceSnapshot: lift((p) => p.records.evidence.evaluation.findSourceSnapshot),
        listCriterionSetStatuses: lift((p) => p.criterionStatusHistory.listCriterionSetStatuses),
      },
      modelAssurance: { find: findModelAssurance },
    },
    datasets: {
      findDatasetVersion: lift((p) => p.records.datasets.findDatasetVersion),
      findFixtureVersion: lift((p) => p.records.datasets.findFixtureVersion),
      findRecordedInteractionFixtureVersion: lift(
        (p) => p.records.datasets.findRecordedInteractionFixtureVersion,
      ),
    },
    replayDefinitions: {
      findReplayPlan: lift((p) => p.records.replayDefinitions.findReplayPlan),
      findTargetRelease: lift((p) => p.records.replayDefinitions.findTargetRelease),
    },
    replayResults: { findJob: lift((p) => p.records.replayResults.findJob) },
    runtimeDefinitions: {
      findRuntimeProfile: lift((p) => p.records.runtimeDefinitions.findRuntimeProfile),
      findIsolationProfile: lift((p) => p.records.runtimeDefinitions.findIsolationProfile),
      findRuntimeAdapter: lift((p) => p.records.runtimeDefinitions.findRuntimeAdapter),
    },
  } satisfies PolicyArtifactEvidenceRepositories;
  return {
    repositories,
    evidence: { resolveExactEvents: lift((p) => p.evidence.resolveExactEvents) },
    catalog: { find: lift((p) => p.catalog.find) },
    fixtureContent: {
      findRecordedInteractionFixtureContent: lift(
        (p) => p.fixtureContent.findRecordedInteractionFixtureContent,
      ),
    },
  };
}
