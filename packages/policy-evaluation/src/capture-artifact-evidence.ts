import {
  ARTIFACT_OBJECT_FORMAT_OVERHEAD_BYTES,
  MAX_ENCRYPTED_ARTIFACT_OBJECT_BYTES,
  PolicyEvaluationArtifactCaptureError,
  type PolicyEvaluationArtifactRead,
  type PolicyEvaluationArtifactReadDependencies,
  readPolicyEvaluationArtifact,
} from "@proofstack/artifacts";
import {
  type ContentReference,
  encodeEvaluationCanonicalJson,
  type PrincipalContext,
  PrincipalContextSchema,
  policyEvaluationTimestampOrderKey,
  UtcMillisecondTimestampSchema,
} from "@proofstack/contracts";
import {
  type ExactEvidenceRepository,
  ForbiddenError,
  InvalidPolicyEvaluationRequestRecordError,
  requireCapability,
  requireEnvironmentAccess,
  validatePolicyEvaluationRequestRecord,
} from "@proofstack/core";
import { AcquisitionBudget, PolicyRecordGraphError } from "./acquisition-budget.js";
import {
  inspectCapturedArtifactRules,
  type PolicyArtifactRuleBindings,
} from "./capture-artifact-rules.js";
import {
  candidateAuthorityMaterialFingerprint,
  observeCapturedCandidateAuthority,
  type PolicyCandidateAuthorities,
  type PolicyCandidateAuthorityObservation,
} from "./capture-candidate-authority.js";
import {
  inspectCapturedComparisonRules,
  type PolicyComparisonRuleBindings,
} from "./capture-comparison-rules.js";
import {
  type CriterionAuthorityReadRepository,
  criterionAuthorityMaterialFingerprint,
  observeCapturedCriterionAuthority,
  type PolicyCriterionAuthorityObservation,
} from "./capture-criterion-authority.js";
import {
  inspectCapturedEvaluationTrust,
  type PolicyEvaluationTrustPrerequisites,
} from "./capture-evaluation-trust.js";
import {
  inspectCapturedFixtureBindings,
  type PolicyFixtureBindingCapture,
} from "./capture-fixture-bindings.js";
import {
  inspectCapturedPolicyApplicability,
  type PolicyApplicabilityInputs,
} from "./capture-policy-applicability.js";
import type { PolicyAuthorityPrerequisites } from "./capture-policy-authority.js";
import {
  observeCapturedPolicyLifecycle,
  type PolicyLifecycleObservation,
  type PolicyLifecycleReadRepository,
} from "./capture-policy-lifecycle.js";
import {
  acquirePolicyTraceEvidence,
  type PolicyTraceEvidenceCapture,
} from "./capture-trace-evidence.js";
import type {
  PolicyEvaluationSourceGuard,
  PolicyEvaluationSourceGuardUsage,
} from "./derive-source-guards.js";
import type { PolicyEvaluationMetadataTransactions } from "./metadata-transactions.js";
import {
  deriveAndRecheckCapturedPolicySources,
  type PolicyEvaluationSourceRecheck,
  type PolicyEvaluationSourceTransactions,
} from "./recheck-captured-sources.js";
import type { PolicyRecordGraphRepositories } from "./record-routing.js";

export type PolicyArtifactEvidenceDependencies = PolicyEvaluationArtifactReadDependencies & {
  /** Trusted transaction adapter only; not an HTTP request option or a seal/publication port. */
  readonly sourceTransactions?: PolicyEvaluationSourceTransactions;
  /** Alternative whole-graph metadata mode; cannot be combined with sourceTransactions. */
  readonly metadataTransactions?: PolicyEvaluationMetadataTransactions;
  /** Fixed operator-owned reference authorities; no request-selected callbacks or publication. */
  readonly candidateAuthorities?: PolicyCandidateAuthorities;
};

/** Artifact capture also requires complete policy terminal and criterion status histories. */
export type PolicyArtifactEvidenceRepositories = PolicyRecordGraphRepositories & {
  readonly evidence: PolicyRecordGraphRepositories["evidence"] & {
    readonly evaluation: PolicyRecordGraphRepositories["evidence"]["evaluation"] &
      CriterionAuthorityReadRepository;
  };
  readonly control: PolicyRecordGraphRepositories["control"] & {
    readonly releasePolicy: PolicyLifecycleReadRepository;
  };
};

export type PolicyArtifactCaptureOrigin =
  | { readonly kind: "record"; readonly edgeIndex: number }
  | { readonly kind: "trace"; readonly artifactReferenceIndex: number };

export interface PolicyArtifactCapture {
  /** Index into this invocation's traceCapture; never a caller-provided source or fetch URL. */
  readonly origin: PolicyArtifactCaptureOrigin;
  readonly read: PolicyEvaluationArtifactRead;
}

export type PolicyArtifactEvidenceCapture = {
  readonly traceCapture: PolicyTraceEvidenceCapture;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly usage: ReturnType<AcquisitionBudget["usage"]> & {
    readonly artifacts: ReturnType<AcquisitionBudget["artifactUsage"]>;
    readonly sourceGuards: PolicyEvaluationSourceGuardUsage;
  };
} & (
  | { readonly status: "roots_unavailable" }
  | {
      readonly status: "artifacts_captured";
      readonly artifacts: readonly PolicyArtifactCapture[];
      readonly sourceGuards: readonly PolicyEvaluationSourceGuard[];
      /** Read-only observations under source guards; not a seal or later publication authority. */
      readonly sourceRecheck?: PolicyEvaluationSourceRecheck;
      readonly fixtureBindings: readonly PolicyFixtureBindingCapture[];
      readonly artifactRules: PolicyArtifactRuleBindings;
      readonly candidateAuthority: {
        readonly beforeArtifacts: PolicyCandidateAuthorityObservation;
        readonly afterArtifacts: PolicyCandidateAuthorityObservation;
      };
      readonly policyAuthority: PolicyAuthorityPrerequisites;
      readonly applicability: PolicyApplicabilityInputs;
      readonly comparisonRules: PolicyComparisonRuleBindings;
      readonly evaluationTrust: PolicyEvaluationTrustPrerequisites;
      readonly criterionAuthority: {
        readonly beforeArtifacts: PolicyCriterionAuthorityObservation;
        readonly afterArtifacts: PolicyCriterionAuthorityObservation;
        readonly underGuards?: PolicyCriterionAuthorityObservation;
      };
      readonly policyLifecycle: {
        readonly beforeArtifacts: PolicyLifecycleObservation;
        readonly afterArtifacts: PolicyLifecycleObservation;
      };
    }
);

function canonical(value: unknown): string {
  return Buffer.from(encodeEvaluationCanonicalJson(value)).toString("utf8");
}

/**
 * Request-rooted graph, comparison, trace and authorized artifact acquisition. The caller must
 * authorize metadata/trace ports separately; artifact access does not grant those permissions.
 * This checks recorded-fixture bindings, static policy-authority prerequisites and terminal
 * lifecycle observations and derives installed-domain guard coordinates, NOT acquired locks,
 * complete semantic/mutable authority or a sealed policy snapshot.
 */
export async function capturePolicyArtifactEvidence(
  input: unknown,
  actor: PrincipalContext,
  repositories: PolicyArtifactEvidenceRepositories,
  evidence: Pick<ExactEvidenceRepository, "resolveExactEvents">,
  dependencies: PolicyArtifactEvidenceDependencies,
): Promise<PolicyArtifactEvidenceCapture> {
  const request = validatePolicyEvaluationRequestRecord(input);
  const principal = PrincipalContextSchema.parse(actor);
  const sourceTransactions = dependencies.sourceTransactions;
  const metadataTransactions = dependencies.metadataTransactions;
  requireCapability(principal, "artifact:read");
  if (principal.tenantId !== request.scope.tenantId)
    throw new ForbiddenError("Artifact capture scope does not match principal");
  requireEnvironmentAccess(principal, request.scope.projectId, request.scope.environmentId);
  if (sourceTransactions && metadataTransactions)
    throw new TypeError("Expected one policy recheck transaction mode");

  let previousTime: string | undefined;
  const clock = {
    now: () => {
      let timestamp: string;
      try {
        timestamp = UtcMillisecondTimestampSchema.parse(dependencies.clock.now().toISOString());
      } catch {
        throw new PolicyEvaluationArtifactCaptureError("clock_invalid");
      }
      if (previousTime !== undefined && timestamp < previousTime)
        throw new PolicyEvaluationArtifactCaptureError("clock_invalid");
      previousTime = timestamp;
      return new Date(timestamp);
    },
  };
  const startedAt = clock.now().toISOString();
  if (
    [request.evaluationTime, request.createdAt].some(
      (time) =>
        policyEvaluationTimestampOrderKey(time) > policyEvaluationTimestampOrderKey(startedAt),
    )
  )
    throw new InvalidPolicyEvaluationRequestRecordError("Request time follows artifact capture");
  const budget = new AcquisitionBudget(request.limits);
  let sourceGuardUsage: PolicyEvaluationSourceGuardUsage = {
    resources: 0,
    origins: 0,
    canonicalBytes: 0,
  };
  try {
    const traceCapture = await acquirePolicyTraceEvidence(request, repositories, evidence, budget);
    const usage = () => ({
      ...budget.usage(),
      artifacts: budget.artifactUsage(),
      sourceGuards: sourceGuardUsage,
    });
    if (traceCapture.status === "roots_unavailable")
      return {
        status: "roots_unavailable",
        traceCapture,
        startedAt,
        completedAt: clock.now().toISOString(),
        usage: usage(),
      };
    const policyRepository = budget.wrap(repositories.control.releasePolicy);
    const beforeArtifacts = await observeCapturedPolicyLifecycle(
      traceCapture.comparisonCapture.graph,
      policyRepository,
      clock,
    );
    const criterionRepository = budget.wrap(repositories.evidence.evaluation);
    const observeCriteria = async () => {
      const observation = await observeCapturedCriterionAuthority(
        traceCapture.comparisonCapture.graph,
        criterionRepository,
        clock,
        {
          maxRecords: request.limits.maxAcquisitionRecords,
          maxRecordBytes: request.limits.maxAcquisitionRecordBytes,
        },
      );
      if (observation.status === "observed")
        budget.addReferences(
          observation.inspectionUsage.references,
          observation.inspectionUsage.referenceBytes,
        );
      return observation;
    };
    const criteriaBeforeArtifacts = await observeCriteria();
    const observeCandidateAuthority = () =>
      observeCapturedCandidateAuthority(
        request,
        traceCapture.comparisonCapture.graph,
        dependencies.candidateAuthorities,
        clock,
        budget,
        {
          maxReferences: request.limits.maxAcquisitionRecords,
          maxReferenceBytes: request.limits.maxAcquisitionRecordBytes,
        },
      );
    const candidateBeforeArtifacts = await observeCandidateAuthority();
    const occurrences: { origin: PolicyArtifactCaptureOrigin; reference: ContentReference }[] = [];
    traceCapture.comparisonCapture.graph.edges.forEach((edge, edgeIndex) => {
      if (edge.reference.kind === "artifact")
        occurrences.push({
          origin: { kind: "record", edgeIndex },
          reference: edge.reference.reference,
        });
    });
    traceCapture.artifactReferences.forEach(({ reference }, artifactReferenceIndex) => {
      occurrences.push({ origin: { kind: "trace", artifactReferenceIndex }, reference });
    });
    // Preflight every known descriptor before any content reads; stored classification is still
    // checked again by the owning reader so an understated declaration cannot bypass authority.
    for (const { reference } of occurrences) {
      if (reference.classification === "restricted")
        requireCapability(principal, "artifact:read:restricted");
    }
    const catalog = budget.wrap(dependencies.catalog);
    const observations = new Map<string, string>();
    const artifacts: PolicyArtifactCapture[] = [];
    for (const { origin, reference } of occurrences) {
      const read = await readPolicyEvaluationArtifact(
        {
          scope: request.scope,
          principal,
          reference,
          evaluationTime: request.evaluationTime,
          maxReadBytes: MAX_ENCRYPTED_ARTIFACT_OBJECT_BYTES,
        },
        {
          catalog,
          encryption: dependencies.encryption,
          clock,
          objects: {
            get: (objectKey) =>
              budget.readArtifactObject(
                reference.sizeBytes + ARTIFACT_OBJECT_FORMAT_OVERHEAD_BYTES,
                () => dependencies.objects.get(objectKey),
              ),
          },
        },
      );
      // Per-read clock/usage fields may differ. Catalog identity and availability/content may not.
      const fingerprint = canonical({ catalog: read.catalog, observation: read.observation });
      const previous = observations.get(reference.artifactId);
      if (previous !== undefined && previous !== fingerprint)
        throw new PolicyRecordGraphError(
          "observation_conflict",
          `artifact:${reference.artifactId}`,
        );
      observations.set(reference.artifactId, fingerprint);
      artifacts.push({ origin, read });
    }
    const fixtureBindings = inspectCapturedFixtureBindings(
      traceCapture.comparisonCapture.graph,
      artifacts,
    );
    const evaluationTrust = inspectCapturedEvaluationTrust(
      traceCapture.comparisonCapture.graph,
      artifacts,
      {
        maxReferences: request.limits.maxAcquisitionRecords,
        maxReferenceBytes: request.limits.maxAcquisitionRecordBytes,
      },
    );
    budget.addReferences(
      evaluationTrust.inspectionUsage.references,
      evaluationTrust.inspectionUsage.referenceBytes,
    );
    const artifactRules = inspectCapturedArtifactRules(
      request,
      traceCapture.comparisonCapture.graph,
      artifacts,
      {
        maxReferences: request.limits.maxAcquisitionRecords,
        maxReferenceBytes: request.limits.maxAcquisitionRecordBytes,
      },
    );
    budget.addReferences(
      artifactRules.inspectionUsage.references,
      artifactRules.inspectionUsage.referenceBytes,
    );
    const candidateAfterArtifacts = await observeCandidateAuthority();
    if (
      candidateAuthorityMaterialFingerprint(candidateBeforeArtifacts) !==
      candidateAuthorityMaterialFingerprint(candidateAfterArtifacts)
    )
      throw new PolicyEvaluationArtifactCaptureError("source_revision_changed");
    const afterArtifacts = await observeCapturedPolicyLifecycle(
      traceCapture.comparisonCapture.graph,
      policyRepository,
      clock,
    );
    if (beforeArtifacts.observationSha256 !== afterArtifacts.observationSha256)
      throw new PolicyEvaluationArtifactCaptureError("source_revision_changed");
    const { authority: policyAuthority, applicability } = await inspectCapturedPolicyApplicability(
      request,
      traceCapture.comparisonCapture.graph,
      artifacts,
      afterArtifacts,
      {
        maxReferences: request.limits.maxAcquisitionRecords,
        maxReferenceBytes: request.limits.maxAcquisitionRecordBytes,
      },
    );
    budget.addReferences(
      policyAuthority.inspectionUsage.references + applicability.inspectionUsage.references,
      policyAuthority.inspectionUsage.referenceBytes + applicability.inspectionUsage.referenceBytes,
    );
    const comparisonRules = inspectCapturedComparisonRules(
      request,
      traceCapture.comparisonCapture,
      {
        maxReferences: request.limits.maxAcquisitionRecords,
        maxReferenceBytes: request.limits.maxAcquisitionRecordBytes,
      },
    );
    budget.addReferences(
      comparisonRules.inspectionUsage.references,
      comparisonRules.inspectionUsage.referenceBytes,
    );
    const criteriaAfterArtifacts = await observeCriteria();
    if (
      criterionAuthorityMaterialFingerprint(criteriaBeforeArtifacts) !==
      criterionAuthorityMaterialFingerprint(criteriaAfterArtifacts)
    )
      throw new PolicyEvaluationArtifactCaptureError("source_revision_changed");
    const sourceGuardPlan = await deriveAndRecheckCapturedPolicySources(
      {
        request,
        graph: traceCapture.comparisonCapture.graph,
        traceReferences: traceCapture.artifactReferences,
        artifacts,
        lifecycle: afterArtifacts,
        criterionAuthority: criteriaAfterArtifacts,
      },
      budget,
      principal,
      sourceTransactions || metadataTransactions ? clock.now().toISOString() : startedAt,
      sourceTransactions,
      metadataTransactions ? { transactions: metadataTransactions, traceCapture } : undefined,
    );
    sourceGuardUsage = sourceGuardPlan.usage;
    const localCompletedAt = clock.now().toISOString();
    const completedAt =
      "recheck" in sourceGuardPlan &&
      policyEvaluationTimestampOrderKey(sourceGuardPlan.recheck.observedAt) >
        policyEvaluationTimestampOrderKey(localCompletedAt)
        ? sourceGuardPlan.recheck.observedAt
        : localCompletedAt;
    for (const { read } of artifacts) {
      if (
        read.observation.status === "verified" &&
        read.catalog?.metadata.retention.mode === "expire" &&
        policyEvaluationTimestampOrderKey(read.catalog.metadata.retention.expiresAt) <=
          policyEvaluationTimestampOrderKey(completedAt)
      )
        throw new PolicyEvaluationArtifactCaptureError("source_revision_changed");
    }
    return {
      status: "artifacts_captured",
      traceCapture,
      startedAt,
      completedAt,
      artifacts,
      sourceGuards: sourceGuardPlan.guards,
      ...("recheck" in sourceGuardPlan ? { sourceRecheck: sourceGuardPlan.recheck } : {}),
      fixtureBindings,
      artifactRules,
      candidateAuthority: {
        beforeArtifacts: candidateBeforeArtifacts,
        afterArtifacts: candidateAfterArtifacts,
      },
      policyAuthority,
      applicability,
      comparisonRules,
      evaluationTrust,
      criterionAuthority: {
        beforeArtifacts: criteriaBeforeArtifacts,
        afterArtifacts: criteriaAfterArtifacts,
        ...("criterionAuthority" in sourceGuardPlan
          ? { underGuards: sourceGuardPlan.criterionAuthority }
          : {}),
      },
      policyLifecycle: { beforeArtifacts, afterArtifacts },
      usage: usage(),
    };
  } finally {
    await budget.settle();
  }
}
