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
  type PrincipalContext,
  type PolicyEvaluationSnapshotPageSet,
  PolicyEvaluationWorkerMutationFenceSchema,
  type PolicyEvaluationWorkerMutationFence,
  POLICY_EVALUATION_SNAPSHOT_FRAME_BYTES,
  POLICY_EVALUATION_SNAPSHOT_PAGE_SIZE,
  encodePolicyEvaluationSnapshotInputs,
  OpaqueIdSchema,
  PrincipalContextSchema,
  policyEvaluationTimestampOrderKey,
  serializeEvaluationCanonicalJson,
  UtcMillisecondTimestampSchema,
} from "@proofstack/contracts";
import {
  type ExactEvidenceRepository,
  ForbiddenError,
  InvalidPolicyEvaluationRequestRecordError,
  assemblePolicyEvaluationSnapshot,
  requireCapability,
  requireEnvironmentAccess,
  requirePolicyEvaluationExecution,
  validatePolicyEvaluationRequestRecord,
  digestPolicyEvaluationJobDefinition,
  policyEvaluationRequestReference,
  validatePolicyEvaluationJobSnapshotRecord,
  validatePolicyEvaluationSnapshotRecord,
} from "@proofstack/core";
import { AcquisitionBudget, PolicyRecordGraphError } from "./acquisition-budget.js";
import {
  PolicyAcquisitionAdmissionError,
  reservePolicyAcquisitionForSnapshot,
  type PolicyAcquisitionAdmission,
} from "./acquisition-admission.js";
import type { PolicyArtifactRuleBindings } from "./capture-artifact-rules.js";
import type { PolicyAssessmentRuleInputs } from "./capture-assessment-rules.js";
import {
  candidateAuthorityMaterialFingerprint,
  observeCapturedCandidateAuthority,
  type PolicyCandidateAuthorities,
  type PolicyCandidateAuthorityObservation,
} from "./capture-candidate-authority.js";
import type { PolicyComparisonRuleBindings } from "./capture-comparison-rules.js";
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
import { inspectCapturedRuleInputs, type PolicyRuleInputs } from "./capture-rule-inputs.js";
import {
  acquireStoredPolicyArtifacts,
  artifactCatalogMaterial,
  type PolicyStoredArtifactCapture,
  storedArtifactOccurrences,
} from "./capture-stored-artifacts.js";
import {
  acquirePolicyTraceEvidence,
  type PolicyTraceEvidenceCapture,
} from "./capture-trace-evidence.js";
import type { PolicyRuleDependencyClosure } from "./derive-rule-dependencies.js";
import type {
  PolicyEvaluationSourceGuard,
  PolicyEvaluationSourceGuardUsage,
} from "./derive-source-guards.js";
import type { PolicyEvaluationMetadataTransactions } from "./metadata-transactions.js";
import {
  deriveAndRecheckCapturedPolicySources,
  withRecheckedCapturedPolicySources,
  type PolicyEvaluationSourceRecheck,
  type PolicyEvaluationSourceTransactions,
} from "./recheck-captured-sources.js";
import type { PolicyRecordGraphRepositories } from "./record-routing.js";
import type { PolicySnapshotRuleInputs } from "./project-rule-inputs.js";
import { compileCapturedSnapshotInputs } from "./compile-snapshot-inputs.js";
import {
  prepareCapturedSnapshotInputs,
  type PolicyPreparedSnapshotInputs,
} from "./prepare-snapshot-inputs.js";
import type {
  PolicyEvaluationSnapshotSealReceipt,
  PolicyEvaluationSnapshotSealingTransactions,
  PolicyEvaluationSnapshotSealingPorts,
} from "./snapshot-sealing-transactions.js";
import {
  PolicyArtifactByteReservations,
  type PolicyArtifactByteAdmission,
} from "./artifact-byte-admission.js";

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
      /** Complete stored declarations; catalog readiness does not verify content bytes. */
      readonly storedArtifacts: readonly PolicyStoredArtifactCapture[];
      readonly storedArtifactInspectionUsage: {
        readonly references: number;
        readonly referenceBytes: number;
      };
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
      readonly assessmentRules: PolicyAssessmentRuleInputs;
      readonly ruleInputs: PolicyRuleInputs;
      /** Strict bounded rule projections, still requiring complete closure and atomic sealing. */
      readonly snapshotRules: PolicySnapshotRuleInputs;
      readonly ruleDependencies: PolicyRuleDependencyClosure;
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
  return serializeEvaluationCanonicalJson(value);
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
  return (await acquirePolicyArtifactEvidence(input, actor, repositories, evidence, dependencies))
    .capture;
}

export type PolicySnapshotInputCapture =
  | Extract<PolicyArtifactEvidenceCapture, { status: "roots_unavailable" }>
  | (Extract<PolicyArtifactEvidenceCapture, { status: "artifacts_captured" }> & {
      /** Prepared retained inputs; publication requires complete current authority and live guards. */
      readonly snapshotInputs: PolicyPreparedSnapshotInputs;
    });

/** Fixed server-owned composition; no submitted graph, expected closure, snapshot or result. */
export async function capturePolicySnapshotInputs(
  input: unknown,
  actor: PrincipalContext,
  repositories: PolicyArtifactEvidenceRepositories,
  evidence: Pick<ExactEvidenceRepository, "resolveExactEvents">,
  dependencies: PolicyArtifactEvidenceDependencies,
  options: { readonly manifestId: string },
): Promise<PolicySnapshotInputCapture> {
  const result = await acquirePolicyArtifactEvidence(
    input,
    actor,
    repositories,
    evidence,
    dependencies,
    { manifestId: options?.manifestId },
  );
  if (result.capture.status === "roots_unavailable") return result.capture;
  if (!result.snapshotInputs) throw new TypeError("Missing internal snapshot input composition");
  return { ...result.capture, snapshotInputs: result.snapshotInputs };
}

export type PolicySnapshotDefinitionCapture =
  | Extract<PolicyArtifactEvidenceCapture, { status: "roots_unavailable" }>
  | (Extract<PolicyArtifactEvidenceCapture, { status: "artifacts_captured" }> & {
      readonly snapshotInputs: PolicyPreparedSnapshotInputs;
      /** Canonical pages only; an atomic publisher must still own complete live guards and fence. */
      readonly snapshotDefinition: PolicyEvaluationSnapshotPageSet;
    });

export async function capturePolicySnapshotDefinition(
  input: unknown,
  actor: PrincipalContext,
  repositories: PolicyArtifactEvidenceRepositories,
  evidence: Pick<ExactEvidenceRepository, "resolveExactEvents">,
  dependencies: PolicyArtifactEvidenceDependencies,
  options: { readonly manifestId: string; readonly snapshotId: string },
): Promise<PolicySnapshotDefinitionCapture> {
  const result = await acquirePolicyArtifactEvidence(
    input,
    actor,
    repositories,
    evidence,
    dependencies,
    { manifestId: options?.manifestId, snapshotId: options?.snapshotId },
  );
  if (result.capture.status === "roots_unavailable") return result.capture;
  if (!result.snapshotInputs || !result.snapshotDefinition)
    throw new TypeError("Missing internal snapshot definition composition");
  return {
    ...result.capture,
    snapshotInputs: result.snapshotInputs,
    snapshotDefinition: result.snapshotDefinition,
  };
}

/** Workspace worker entry. Caller supplies no source graph, page definition, operand or outcome. */
export async function sealPolicyEvaluationSnapshot(
  input: unknown,
  actor: PrincipalContext,
  repositories: PolicyArtifactEvidenceRepositories,
  evidence: Pick<ExactEvidenceRepository, "resolveExactEvents">,
  dependencies: PolicyArtifactEvidenceDependencies,
  options: {
    readonly manifestId: string;
    readonly snapshotId: string;
    readonly fence: PolicyEvaluationWorkerMutationFence;
    readonly transactions: PolicyEvaluationSnapshotSealingTransactions;
    readonly artifactByteAdmission?: PolicyArtifactByteAdmission;
    readonly acquisitionAdmission?: PolicyAcquisitionAdmission;
  },
): Promise<PolicyEvaluationSnapshotSealReceipt> {
  const principal = PrincipalContextSchema.parse(actor);
  requireCapability(principal, "policy:evaluation:execute");
  if (principal.principalType !== "service" || principal.authentication.method !== "service_token")
    throw new ForbiddenError("Policy execution requires a service-token worker principal");
  requireCapability(principal, "artifact:read");
  const request = validatePolicyEvaluationRequestRecord(input);
  requirePolicyEvaluationExecution(principal, request.scope);
  const fence = PolicyEvaluationWorkerMutationFenceSchema.parse(options.fence);
  if (fence.workerId !== principal.principalId)
    throw new ForbiddenError("Policy fence belongs to another worker principal");
  const acquisition = options.acquisitionAdmission
    ? await reservePolicyAcquisitionForSnapshot(request, fence, options.acquisitionAdmission)
    : undefined;
  const budget = new AcquisitionBudget(
    request.limits,
    acquisition?.allowance.limits,
    acquisition?.requireLive,
  );
  let settlementRequested = false,
    settlementCommitted = false;
  const artifactReservations = options.artifactByteAdmission
    ? new PolicyArtifactByteReservations(request, fence, options.artifactByteAdmission)
    : undefined;
  let held: PolicyEvaluationSnapshotSealingPorts | undefined;
  const transactions: PolicyEvaluationMetadataTransactions = {
    runMetadata: async (scope, operation) => {
      const result = await options.transactions.runSealing({ scope, fence }, async (ports) => {
        held = ports;
        try {
          return await operation(ports);
        } finally {
          held = undefined;
        }
      });
      if (settlementRequested) settlementCommitted = true;
      return result;
    },
  };
  try {
    const result = await acquirePolicyArtifactEvidence(
      input,
      principal,
      repositories,
      evidence,
      dependencies,
      {
        manifestId: options.manifestId,
        snapshotId: options.snapshotId,
        budget,
        whileHeld: {
          transactions,
          ...(artifactReservations ? { artifactReservations } : {}),
          publish: async (definition) => {
            if (!held) throw new TypeError("Snapshot publication port has expired");
            if (acquisition) {
              await budget.settle();
              acquisition.requireLive();
              const usage = budget.metadataUsage();
              if (!usage || !held.settleAcquisition)
                throw new PolicyAcquisitionAdmissionError(
                  "Known drained metadata and same-client settlement are required",
                );
              acquisition.validateSettlement(
                await held.settleAcquisition(acquisition.allowance.allowanceId, usage),
                usage,
              );
              settlementRequested = true;
              acquisition.requireLive();
            }
            const receipt = await held.publishSnapshot(definition, principal.principalId);
            const reference = {
              snapshotId: definition.definition.snapshotId,
              definitionSha256: definition.definitionSha256,
            };
            const requestReference = policyEvaluationRequestReference(request);
            const checked = validatePolicyEvaluationSnapshotRecord({
              expected: {
                scope: request.scope,
                snapshot: reference,
                request: requestReference,
                jobId: fence.jobId,
              },
              record: receipt.snapshot,
              pageSet: definition,
            });
            const job = validatePolicyEvaluationJobSnapshotRecord({
              expected: {
                scope: request.scope,
                job: {
                  jobId: fence.jobId,
                  definitionSha256: digestPolicyEvaluationJobDefinition(request.scope, {
                    jobId: fence.jobId,
                    request: requestReference,
                  }),
                },
              },
              snapshot: receipt.job,
            });
            artifactReservations?.requireRetainedUsage(job.usage.artifactReadBytes);
            if (
              job.job.status !== "sealed" ||
              canonical(job.request) !== canonical(request) ||
              canonical(job.job.snapshot) !== canonical(reference) ||
              canonical(job.job.currentLease?.mutationFence) !== canonical(fence) ||
              job.job.updatedAt !== checked.record.sealedAt ||
              checked.record.attemptId !== fence.attemptId ||
              checked.record.workerId !== fence.workerId ||
              checked.record.leaseId !== fence.leaseId ||
              checked.record.fencingToken !== fence.fencingToken ||
              checked.record.recoveryEpoch !== fence.recoveryEpoch
            )
              throw new PolicyRecordGraphError(
                "observation_conflict",
                "sealed_publication_receipt",
              );
            return { snapshot: checked.record, job };
          },
        },
      },
    );
    if (!result.sealedSnapshot)
      throw new InvalidPolicyEvaluationRequestRecordError(
        "Policy roots cannot produce a sealed snapshot",
      );
    return result.sealedSnapshot;
  } catch (error) {
    await budget.settle();
    if (acquisition && options.acquisitionAdmission && !settlementCommitted) {
      try {
        const usage = budget.metadataUsage();
        const settled = await options.acquisitionAdmission.repository.settleAcquisition({
          scope: request.scope,
          fence,
          allowanceId: acquisition.allowance.allowanceId,
          usage,
        });
        acquisition.validateSettlement(settled, usage);
      } catch (settlementError) {
        throw new AggregateError(
          [error, settlementError],
          "Policy capture failed; committed credit remains authoritative",
        );
      }
    }
    throw error;
  }
}

type AcquisitionResult = {
  readonly capture: PolicyArtifactEvidenceCapture;
  readonly snapshotInputs?: PolicyPreparedSnapshotInputs;
  readonly snapshotDefinition?: PolicyEvaluationSnapshotPageSet;
  readonly sealedSnapshot?: PolicyEvaluationSnapshotSealReceipt;
};

async function acquirePolicyArtifactEvidence(
  input: unknown,
  actor: PrincipalContext,
  repositories: PolicyArtifactEvidenceRepositories,
  evidence: Pick<ExactEvidenceRepository, "resolveExactEvents">,
  dependencies: PolicyArtifactEvidenceDependencies,
  snapshotOptions?: {
    readonly budget?: AcquisitionBudget;
    readonly manifestId: string;
    readonly snapshotId?: string;
    readonly whileHeld?: {
      readonly transactions: PolicyEvaluationMetadataTransactions;
      readonly artifactReservations?: PolicyArtifactByteReservations;
      readonly publish: (
        definition: PolicyEvaluationSnapshotPageSet,
      ) => Promise<PolicyEvaluationSnapshotSealReceipt>;
    };
  },
): Promise<AcquisitionResult> {
  const request = validatePolicyEvaluationRequestRecord(input);
  const principal = PrincipalContextSchema.parse(actor);
  const sourceTransactions = dependencies.sourceTransactions;
  const metadataTransactions = dependencies.metadataTransactions;
  requireCapability(principal, "artifact:read");
  if (principal.tenantId !== request.scope.tenantId)
    throw new ForbiddenError("Artifact capture scope does not match principal");
  requireEnvironmentAccess(principal, request.scope.projectId, request.scope.environmentId);
  const manifestId = snapshotOptions ? OpaqueIdSchema.parse(snapshotOptions.manifestId) : undefined;
  const snapshotId =
    snapshotOptions && Object.hasOwn(snapshotOptions, "snapshotId")
      ? OpaqueIdSchema.parse(snapshotOptions.snapshotId)
      : undefined;
  if (sourceTransactions && metadataTransactions)
    throw new TypeError("Expected one policy recheck transaction mode");
  if (
    snapshotOptions?.whileHeld &&
    (sourceTransactions || metadataTransactions || snapshotId === undefined)
  )
    throw new TypeError(
      "Held publication requires its own complete metadata transaction and snapshot identity",
    );

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
  const budget = snapshotOptions?.budget ?? new AcquisitionBudget(request.limits);
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
        capture: {
          status: "roots_unavailable",
          traceCapture,
          startedAt,
          completedAt: clock.now().toISOString(),
          usage: usage(),
        },
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
    const descriptors = new Map<string, string>();
    for (const { reference } of [
      ...occurrences,
      ...storedArtifactOccurrences(traceCapture.comparisonCapture.graph),
    ]) {
      if (reference.classification === "restricted")
        requireCapability(principal, "artifact:read:restricted");
      const descriptor = canonical(reference);
      const previous = descriptors.get(reference.artifactId);
      if (previous !== undefined && previous !== descriptor)
        throw new PolicyRecordGraphError("reference_conflict", `artifact:${reference.artifactId}`);
      descriptors.set(reference.artifactId, descriptor);
    }
    const catalog = budget.wrap(dependencies.catalog);
    const storedArtifactCapture = await acquireStoredPolicyArtifacts(
      request,
      traceCapture.comparisonCapture.graph,
      principal,
      catalog,
      clock,
      budget,
    );
    const storedObservations = new Map(
      storedArtifactCapture.captures.map(({ read }) => [
        read.reference.artifactId,
        canonical({ catalog: read.catalog, observation: read.observation }),
      ]),
    );
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
                async () => {
                  const reservations = snapshotOptions?.whileHeld?.artifactReservations;
                  if (reservations)
                    return reservations.readObject(
                      reference.sizeBytes + ARTIFACT_OBJECT_FORMAT_OVERHEAD_BYTES,
                      objectKey,
                      () => dependencies.objects.get(objectKey),
                    );
                  return dependencies.objects.get(objectKey);
                },
              ),
          },
        },
      );
      // Per-read clock/usage fields may differ. Catalog identity and availability/content may not.
      snapshotOptions?.whileHeld?.artifactReservations?.requireHealthy();
      const fingerprint = canonical({ catalog: read.catalog, observation: read.observation });
      const previous = observations.get(reference.artifactId);
      if (previous !== undefined && previous !== fingerprint)
        throw new PolicyRecordGraphError(
          "observation_conflict",
          `artifact:${reference.artifactId}`,
        );
      observations.set(reference.artifactId, fingerprint);
      const stored = storedObservations.get(reference.artifactId);
      if (stored !== undefined && stored !== canonical(artifactCatalogMaterial(read)))
        throw new PolicyRecordGraphError(
          "observation_conflict",
          `artifact:${reference.artifactId}`,
        );
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
    const {
      artifactRules,
      comparisonRules,
      assessmentRules,
      ruleInputs,
      ruleDependencies,
      snapshotRules,
    } = inspectCapturedRuleInputs(request, traceCapture.comparisonCapture, artifacts, {
      maxReferences: request.limits.maxAcquisitionRecords,
      maxReferenceBytes: request.limits.maxAcquisitionRecordBytes,
    });
    for (const report of [
      artifactRules,
      comparisonRules,
      assessmentRules,
      ruleInputs,
      ruleDependencies,
      snapshotRules,
    ])
      budget.addReferences(
        report.inspectionUsage.references,
        report.inspectionUsage.referenceBytes,
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
    const criteriaAfterArtifacts = await observeCriteria();
    if (
      criterionAuthorityMaterialFingerprint(criteriaBeforeArtifacts) !==
      criterionAuthorityMaterialFingerprint(criteriaAfterArtifacts)
    )
      throw new PolicyEvaluationArtifactCaptureError("source_revision_changed");
    const snapshotInputs =
      manifestId === undefined
        ? undefined
        : prepareCapturedSnapshotInputs(
            request,
            traceCapture.comparisonCapture.graph,
            snapshotRules.inputs,
            manifestId,
            budget,
          );
    const guardInput = {
      request,
      graph: traceCapture.comparisonCapture.graph,
      traceReferences: traceCapture.artifactReferences,
      artifacts,
      storedArtifacts: storedArtifactCapture.captures,
      lifecycle: afterArtifacts,
      criterionAuthority: criteriaAfterArtifacts,
    };
    const finish = async (
      sourceGuardPlan: Awaited<ReturnType<typeof deriveAndRecheckCapturedPolicySources>>,
    ): Promise<AcquisitionResult> => {
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
      for (const { read } of storedArtifactCapture.captures) {
        if (
          read.observation.status === "content_pending" &&
          read.catalog?.metadata.retention.mode === "expire" &&
          policyEvaluationTimestampOrderKey(read.catalog.metadata.retention.expiresAt) <=
            policyEvaluationTimestampOrderKey(completedAt)
        )
          throw new PolicyEvaluationArtifactCaptureError("source_revision_changed");
      }
      const capture: Extract<PolicyArtifactEvidenceCapture, { status: "artifacts_captured" }> = {
        status: "artifacts_captured",
        traceCapture,
        startedAt,
        completedAt,
        artifacts,
        storedArtifacts: storedArtifactCapture.captures,
        storedArtifactInspectionUsage: storedArtifactCapture.inspectionUsage,
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
        assessmentRules,
        ruleInputs,
        snapshotRules,
        ruleDependencies,
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
      let snapshotDefinition: PolicyEvaluationSnapshotPageSet | undefined;
      if (snapshotId !== undefined) {
        if (!snapshotInputs) throw new TypeError("Missing original snapshot source inputs");
        const compiled = compileCapturedSnapshotInputs(request, capture, snapshotInputs, budget);
        const encodedInputs = encodePolicyEvaluationSnapshotInputs(compiled.inputs);
        budget.addReferences(0, encodedInputs.byteLength);
        const frameCount = Math.ceil(
          encodedInputs.byteLength / POLICY_EVALUATION_SNAPSHOT_FRAME_BYTES,
        );
        budget.addReferences(
          1 + frameCount + 2 * Math.ceil(frameCount / POLICY_EVALUATION_SNAPSHOT_PAGE_SIZE),
          0,
        );
        snapshotDefinition = assemblePolicyEvaluationSnapshot({
          snapshotId,
          inputs: compiled.inputs,
        });
        budget.addReferences(
          0,
          Buffer.byteLength(serializeEvaluationCanonicalJson(snapshotDefinition), "utf8"),
        );
        // Whole compilation/page construction shares this request's original meter; no new capture.
        const end = clock.now().toISOString();
        const finalCompletedAt =
          policyEvaluationTimestampOrderKey(end) < policyEvaluationTimestampOrderKey(completedAt)
            ? completedAt
            : end;
        for (const { read } of artifacts)
          if (
            read.observation.status === "verified" &&
            read.catalog?.metadata.retention.mode === "expire" &&
            policyEvaluationTimestampOrderKey(read.catalog.metadata.retention.expiresAt) <=
              policyEvaluationTimestampOrderKey(finalCompletedAt)
          )
            throw new PolicyEvaluationArtifactCaptureError("source_revision_changed");
        for (const { read } of storedArtifactCapture.captures)
          if (
            read.observation.status === "content_pending" &&
            read.catalog?.metadata.retention.mode === "expire" &&
            policyEvaluationTimestampOrderKey(read.catalog.metadata.retention.expiresAt) <=
              policyEvaluationTimestampOrderKey(finalCompletedAt)
          )
            throw new PolicyEvaluationArtifactCaptureError("source_revision_changed");
        return {
          capture: { ...capture, completedAt: finalCompletedAt, usage: usage() },
          snapshotInputs,
          snapshotDefinition,
          ...(snapshotOptions?.whileHeld
            ? { sealedSnapshot: await snapshotOptions.whileHeld.publish(snapshotDefinition) }
            : {}),
        };
      }
      return { capture, ...(snapshotInputs ? { snapshotInputs } : {}) };
    };
    if (snapshotOptions?.whileHeld)
      return await withRecheckedCapturedPolicySources(
        guardInput,
        budget,
        principal,
        clock.now().toISOString(),
        { transactions: snapshotOptions.whileHeld.transactions, traceCapture },
        (inspection) => finish(inspection),
      );
    const sourceGuardPlan = await deriveAndRecheckCapturedPolicySources(
      guardInput,
      budget,
      principal,
      sourceTransactions || metadataTransactions ? clock.now().toISOString() : startedAt,
      sourceTransactions,
      metadataTransactions ? { transactions: metadataTransactions, traceCapture } : undefined,
    );
    return await finish(sourceGuardPlan);
  } finally {
    await budget.settle();
  }
}
