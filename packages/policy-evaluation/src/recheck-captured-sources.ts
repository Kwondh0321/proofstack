import {
  inspectPolicyEvaluationArtifactCatalog,
  MAX_ENCRYPTED_ARTIFACT_OBJECT_BYTES,
} from "@proofstack/artifacts";
import {
  ArtifactContentReferenceSchema,
  type CriterionSet,
  type CriterionSetStatusRecord,
  type EvidenceScope,
  encodeEvaluationCanonicalJson,
  PolicyEvaluationTimeSchema,
  type PrincipalContext,
  policyEvaluationTimestampOrderKey,
  type ReleasePolicy,
  type ReleasePolicyLifecycleEvent,
} from "@proofstack/contracts";
import {
  type CriterionStatusHistoryLimits,
  inspectPolicyEvaluationControlRecord,
  inspectPolicyEvaluationEvidenceRecord,
} from "@proofstack/core";
import type { AcquisitionBudget } from "./acquisition-budget.js";
import {
  criterionAuthorityMaterialFingerprint,
  observeCapturedCriterionAuthority,
  type PolicyCriterionAuthorityObservation,
} from "./capture-criterion-authority.js";
import { observeCapturedPolicyLifecycle } from "./capture-policy-lifecycle.js";
import {
  acquirePolicyTraceEvidence,
  type PolicyTraceEvidenceCapture,
} from "./capture-trace-evidence.js";
import { deriveCapturedPolicySourceGuards } from "./derive-source-guards.js";
import type {
  PolicyEvaluationMetadataPorts,
  PolicyEvaluationMetadataTransactions,
} from "./metadata-transactions.js";
import { PolicyCapturedObservationRecheckError } from "./reinspect-captured-observations.js";

/** Trusted same-connection ports; no content/key I/O, caller SQL or publication operation. */
export interface PolicyEvaluationSourceRecheckPorts {
  tryMetadataGuard(): Promise<boolean>;
  tryGuard(kind: "artifact" | "release_policy", id: string): Promise<boolean>;
  /** Require the metadata guard and current migration ledger before any SQL. */
  findCriterion(id: string): Promise<unknown>;
  listCriterionSetStatuses(limits: CriterionStatusHistoryLimits): Promise<unknown>;
  findArtifact(id: string): Promise<unknown>;
  findPolicy(id: string): Promise<unknown>;
  listPolicyHistory(id: string): Promise<unknown>;
  observationTime(): Promise<string>;
}

/** The adapter owns exact scope, READ COMMITTED, whole rollback and connection lifetime. */
export interface PolicyEvaluationSourceTransactions {
  run<T>(
    scope: EvidenceScope,
    operation: (ports: PolicyEvaluationSourceRecheckPorts) => Promise<T>,
  ): Promise<T>;
}

export interface PolicyEvaluationSourceRecheck {
  readonly status: "observations_rechecked";
  /** Database-owned exact time under guards, not a seal or a post-transaction freshness token. */
  readonly observedAt: string;
  readonly guards: number;
  readonly artifactReads: number;
  readonly policyReads: number;
  readonly metadataGuard: boolean;
  readonly criterionReads: number;
  readonly criterionHistoryReads: number;
  readonly criterionHistoryRows: number;
  /** Present only for request-owned graph/trace reinspection on the held metadata connection. */
  readonly metadata?: {
    readonly recordObservations: number;
    readonly traceObservations: number;
    readonly recordReads: number;
    readonly traceReads: number;
  };
}

export class PolicyEvaluationSourceRecheckError extends Error {
  readonly code = "policy_evaluation_source_recheck_failed";
  constructor(
    readonly reason:
      | "guard_unavailable"
      | "guard_invalid"
      | "source_revision_changed"
      | "clock_invalid",
    readonly identity?: string,
  ) {
    super(`Policy source recheck: ${reason}${identity ? ` (${identity})` : ""}`);
    this.name = "PolicyEvaluationSourceRecheckError";
  }
}

function canonical(value: unknown): string {
  return Buffer.from(encodeEvaluationCanonicalJson(value)).toString("utf8");
}

/** Internal request-owning composition. Never accepts a precomputed guard subset or public graph. */
export async function deriveAndRecheckCapturedPolicySources(
  input: Parameters<typeof deriveCapturedPolicySourceGuards>[0] & {
    readonly criterionAuthority: PolicyCriterionAuthorityObservation;
  },
  budget: AcquisitionBudget,
  principal: PrincipalContext,
  captureCompletedAt: string,
  transactions?: PolicyEvaluationSourceTransactions,
  metadata?: {
    readonly transactions: PolicyEvaluationMetadataTransactions;
    readonly traceCapture: Extract<PolicyTraceEvidenceCapture, { status: "traces_captured" }>;
  },
): Promise<
  | ReturnType<typeof deriveCapturedPolicySourceGuards>
  | (ReturnType<typeof deriveCapturedPolicySourceGuards> & {
      readonly recheck: PolicyEvaluationSourceRecheck;
      readonly criterionAuthority: PolicyCriterionAuthorityObservation;
    })
> {
  if (transactions && metadata) throw new TypeError("Expected one policy recheck transaction mode");
  if (
    metadata &&
    (metadata.traceCapture.comparisonCapture.graph !== input.graph ||
      metadata.traceCapture.artifactReferences !== input.traceReferences)
  )
    throw new PolicyEvaluationSourceRecheckError("source_revision_changed");
  const plan = deriveCapturedPolicySourceGuards(input, budget);
  if (!transactions && !metadata) return plan;
  const { request, graph, artifacts, lifecycle, criterionAuthority } = input;
  const reinspect = async (
    supplied: PolicyEvaluationSourceRecheckPorts,
    metadataPorts?: PolicyEvaluationMetadataPorts,
  ) => {
    const ports = budget.wrap(supplied);
    const metadataGuard = metadataPorts !== undefined || criterionAuthority.status === "observed";
    const historyLimits = {
      maxRecords: request.limits.maxAcquisitionRecords,
      maxRecordBytes: request.limits.maxAcquisitionRecordBytes,
    };
    if (metadataGuard && !metadataPorts) {
      const acquired: unknown = await ports.tryMetadataGuard();
      if (acquired !== true)
        throw new PolicyEvaluationSourceRecheckError(
          acquired === false ? "guard_unavailable" : "guard_invalid",
          "metadata",
        );
    }
    for (const { kind, id } of plan.guards) {
      const acquired: unknown = await ports.tryGuard(kind, id);
      if (acquired !== true)
        throw new PolicyEvaluationSourceRecheckError(
          acquired === false ? "guard_unavailable" : "guard_invalid",
          JSON.stringify([kind, id]),
        );
    }
    // No authoritative read is allowed until the entire required guard set has succeeded.
    let metadataRecheck: PolicyEvaluationSourceRecheck["metadata"];
    if (metadataPorts && metadata) {
      const before = budget.usage();
      let recaptured: PolicyTraceEvidenceCapture;
      try {
        recaptured = await acquirePolicyTraceEvidence(
          request,
          metadataPorts.records,
          metadataPorts.evidence,
          budget,
          metadata.traceCapture,
        );
      } catch (error) {
        if (error instanceof PolicyCapturedObservationRecheckError)
          throw new PolicyEvaluationSourceRecheckError("source_revision_changed", error.identity);
        throw error;
      }
      if (recaptured.status !== "traces_captured")
        throw new PolicyEvaluationSourceRecheckError("source_revision_changed");
      metadataRecheck = {
        recordObservations: recaptured.comparisonCapture.graph.nodes.length,
        traceObservations: recaptured.traces.length,
        recordReads: recaptured.comparisonCapture.graph.usage.reads - before.reads,
        traceReads: recaptured.usage.reads - recaptured.comparisonCapture.graph.usage.reads,
      };
    }
    const policyRecords = new Map<string, unknown>();
    const artifactRecords = new Map<string, unknown>();
    for (const { kind, id, origins } of plan.guards) {
      if (kind === "release_policy") policyRecords.set(id, await ports.findPolicy(id));
      else {
        const origin = origins.find((origin) => origin.kind === "artifact_capture");
        const captured =
          origin?.kind === "artifact_capture" ? artifacts[origin.captureIndex] : undefined;
        // Derivation established complete origins. Unsupported references deliberately remain
        // unqueried, but their known IDs are still guarded; never waive other known coordinates.
        if (!captured) throw new PolicyEvaluationSourceRecheckError("source_revision_changed");
        if (ArtifactContentReferenceSchema.safeParse(captured.read.reference).success)
          artifactRecords.set(id, await ports.findArtifact(id));
      }
    }
    const history = await ports.listPolicyHistory(request.policy.policyVersionId);
    const criterionRecords = new Map<string, unknown>();
    let criterionHistory: unknown;
    if (criterionAuthority.status === "observed") {
      criterionHistory = await ports.listCriterionSetStatuses(historyLimits);
      // Reject a changed complete inventory before reading any new successor identity.
      if (
        canonical(criterionHistory) !==
        canonical(criterionAuthority.history.map(({ record }) => record))
      )
        throw new PolicyEvaluationSourceRecheckError("source_revision_changed");
      const ids = new Set<string>();
      for (const { read } of graph.nodes)
        if (read.source.kind === "criterion_set")
          ids.add(read.source.reference.criterionSetVersionId);
      for (const { source } of criterionAuthority.successors)
        if (source.kind === "criterion_set") ids.add(source.reference.criterionSetVersionId);
      for (const id of [...ids].sort()) criterionRecords.set(id, await ports.findCriterion(id));
      for (const { read } of graph.nodes) {
        if (read.source.kind !== "criterion_set") continue;
        const current = inspectPolicyEvaluationEvidenceRecord(
          { source: read.source, scope: request.scope, evaluationTime: request.evaluationTime },
          criterionRecords.get(read.source.reference.criterionSetVersionId),
        );
        if (canonical(current.observation) !== canonical(read.observation))
          throw new PolicyEvaluationSourceRecheckError("source_revision_changed");
      }
    }
    const observedAt = PolicyEvaluationTimeSchema.safeParse(await ports.observationTime());
    if (
      !observedAt.success ||
      policyEvaluationTimestampOrderKey(observedAt.data) <
        policyEvaluationTimestampOrderKey(captureCompletedAt)
    )
      throw new PolicyEvaluationSourceRecheckError("clock_invalid");
    for (const { read } of graph.nodes) {
      if (read.source.kind !== "release_policy") continue;
      const current = inspectPolicyEvaluationControlRecord(
        { source: read.source, scope: request.scope, evaluationTime: request.evaluationTime },
        policyRecords.get(read.source.reference.policyVersionId),
      );
      if (canonical(current.observation) !== canonical(read.observation))
        throw new PolicyEvaluationSourceRecheckError("source_revision_changed");
    }
    for (const { read } of artifacts) {
      const current = inspectPolicyEvaluationArtifactCatalog(
        {
          scope: request.scope,
          principal,
          reference: read.reference,
          evaluationTime: request.evaluationTime,
          maxReadBytes: MAX_ENCRYPTED_ARTIFACT_OBJECT_BYTES,
        },
        artifactRecords.has(read.reference.artifactId)
          ? artifactRecords.get(read.reference.artifactId)
          : null,
        observedAt.data,
      );
      const contentWasAttempted =
        read.observation.status === "verified" ||
        (read.observation.status === "unavailable" &&
          (read.observation.reason === "object_missing" ||
            read.observation.reason === "content_integrity_failed"));
      if (
        canonical(current.catalog) !== canonical(read.catalog) ||
        (contentWasAttempted
          ? current.observation.status !== "content_pending"
          : canonical(current.observation) !== canonical(read.observation))
      )
        throw new PolicyEvaluationSourceRecheckError("source_revision_changed");
    }
    // Compare complete history before resolving any successor. A newly introduced successor
    // cannot be queried under a guard set that did not contain its identity.
    if (canonical(history) !== canonical(lifecycle.history.map(({ record }) => record)))
      throw new PolicyEvaluationSourceRecheckError("source_revision_changed");
    // Policy/event receipt contracts are milliseconds. Retain the full DB cut for artifact
    // receipt/expiry comparison; a Date here is only the owning lifecycle reader's clock port.
    const currentLifecycle = await observeCapturedPolicyLifecycle(
      graph,
      {
        findReleasePolicy: async (_scope, id) =>
          structuredClone(policyRecords.get(id)) as ReleasePolicy | null,
        listReleasePolicyLifecycleEvents: async () =>
          structuredClone(history) as ReleasePolicyLifecycleEvent[],
      },
      { now: () => new Date(observedAt.data) },
    );
    if (currentLifecycle.observationSha256 !== lifecycle.observationSha256)
      throw new PolicyEvaluationSourceRecheckError("source_revision_changed");
    const guardedCriterionAuthority = await observeCapturedCriterionAuthority(
      graph,
      {
        listCriterionSetStatuses: async () =>
          structuredClone(criterionHistory) as CriterionSetStatusRecord[],
        findCriterionSet: async (_scope, id) =>
          structuredClone(criterionRecords.get(id)) as CriterionSet | null,
      },
      // This internal clock preserves the database cut; the public content clock remains Date.
      { now: () => observedAt.data },
      historyLimits,
    );
    if (
      criterionAuthorityMaterialFingerprint(guardedCriterionAuthority) !==
      criterionAuthorityMaterialFingerprint(criterionAuthority)
    )
      throw new PolicyEvaluationSourceRecheckError("source_revision_changed");
    if (guardedCriterionAuthority.status === "observed")
      budget.addReferences(
        guardedCriterionAuthority.inspectionUsage.references,
        guardedCriterionAuthority.inspectionUsage.referenceBytes,
      );
    return {
      criterionAuthority: guardedCriterionAuthority,
      recheck: {
        status: "observations_rechecked" as const,
        observedAt: observedAt.data,
        guards: plan.guards.length,
        artifactReads: artifactRecords.size,
        policyReads: policyRecords.size,
        metadataGuard,
        criterionReads: criterionRecords.size,
        criterionHistoryReads: criterionAuthority.status === "observed" ? 1 : 0,
        criterionHistoryRows:
          criterionAuthority.status === "observed" ? criterionAuthority.history.length : 0,
        ...(metadataRecheck ? { metadata: metadataRecheck } : {}),
      } satisfies PolicyEvaluationSourceRecheck,
    };
  };
  const scope = structuredClone(request.scope);
  const inspection = metadata
    ? await metadata.transactions.runMetadata(scope, (ports) => reinspect(ports.sources, ports))
    : await (transactions as PolicyEvaluationSourceTransactions).run(scope, (ports) =>
        reinspect(ports),
      );
  // The read transaction has ended here. This observation report is NOT a publication authority.
  return { ...plan, ...inspection };
}
