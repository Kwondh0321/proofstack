import {
  OpaqueIdSchema,
  serializeEvaluationCanonicalJson,
  type PolicyEvaluationRequest,
  type PolicyEvaluationUsage,
  type PolicyEvaluationWorkerMutationFence,
} from "@proofstack/contracts";
import {
  digestPolicyEvaluationJobDefinition,
  digestPolicyEvaluationJobGraph,
  policyEvaluationRequestReference,
  validatePolicyEvaluationJobHistoryEntry,
  validatePolicyEvaluationJobSnapshotRecord,
  type PolicyEvaluationJobWorkerRepository,
} from "@proofstack/core";

/** Trusted worker composition only. A generated ID identifies one physical read reservation. */
export interface PolicyArtifactByteAdmission {
  readonly repository: Pick<PolicyEvaluationJobWorkerRepository, "reserveWork">;
  nextReservationId(): string;
}
export class PolicyArtifactByteAdmissionError extends Error {
  readonly code = "policy_artifact_byte_admission_invalid";
  constructor() {
    super("Policy artifact byte admission did not retain its exact owning reservation");
    this.name = "PolicyArtifactByteAdmissionError";
  }
}

/** Expected encrypted buffers only; no partial transport, hidden retry, key or locator claim. */
export class PolicyArtifactByteReservations {
  private readonly ids = new Set<string>();
  private chargedBytes = 0;
  private lastUsage: number | undefined;
  private failed = false;
  private failure: unknown;
  constructor(
    private readonly request: PolicyEvaluationRequest,
    private readonly fence: PolicyEvaluationWorkerMutationFence,
    private readonly admission: PolicyArtifactByteAdmission,
  ) {}

  async beforeRead(expectedBytes: number): Promise<void> {
    if (this.failed) throw this.failure;
    try {
      await this.admit(expectedBytes);
    } catch (error) {
      this.failed = true;
      this.failure = error;
      throw error;
    }
  }
  requireHealthy(): void {
    if (this.failed) throw this.failure;
  }
  private async admit(expectedBytes: number): Promise<void> {
    if (
      !Number.isSafeInteger(expectedBytes) ||
      expectedBytes < 1 ||
      expectedBytes > this.request.limits.maxArtifactReadBytes
    )
      throw new PolicyArtifactByteAdmissionError();
    const reservationId = OpaqueIdSchema.parse(this.admission.nextReservationId());
    if (this.ids.has(reservationId)) throw new PolicyArtifactByteAdmissionError();
    this.ids.add(reservationId);
    const delta: PolicyEvaluationUsage = {
      reads: 0,
      records: 0,
      recordBytes: 0,
      references: 0,
      referenceBytes: 0,
      artifactReadBytes: expectedBytes,
      ruleEvaluations: 0,
    };
    // This acknowledgement finishes BEFORE get and before any held publication transaction.
    // No automatic mutation retry: ambiguous acknowledgement stops I/O and retains its charge.
    const result = await this.admission.repository.reserveWork({
      scope: this.request.scope,
      fence: this.fence,
      reservationId,
      delta,
    });
    if (result.created !== true || result.reservation === null)
      throw new PolicyArtifactByteAdmissionError();
    const requestReference = policyEvaluationRequestReference(this.request);
    const jobReference = {
      jobId: this.fence.jobId,
      definitionSha256: digestPolicyEvaluationJobDefinition(this.request.scope, {
        jobId: this.fence.jobId,
        request: requestReference,
      }),
    };
    const snapshot = validatePolicyEvaluationJobSnapshotRecord({
      expected: { scope: this.request.scope, job: jobReference },
      snapshot: result.snapshot,
    });
    const entry = validatePolicyEvaluationJobHistoryEntry(result.reservation);
    const same = (left: unknown, right: unknown) =>
      serializeEvaluationCanonicalJson(left) === serializeEvaluationCanonicalJson(right);
    if (
      !same(snapshot.request, this.request) ||
      snapshot.job.status !== "acquiring" ||
      !same(snapshot.job.currentLease?.mutationFence, this.fence) ||
      !same(entry.definition.scope, this.request.scope) ||
      !same(entry.definition.job, jobReference) ||
      !same(entry.definition.operation, {
        kind: "reserve",
        fence: this.fence,
        reservationId,
        delta,
      }) ||
      entry.definition.graphSha256 !== digestPolicyEvaluationJobGraph(snapshot) ||
      entry.definition.stateVersion !== snapshot.job.stateVersion ||
      entry.definition.sequence + 1 !== snapshot.job.stateVersion ||
      entry.definition.committedAt !== snapshot.job.updatedAt ||
      snapshot.usage.artifactReadBytes < expectedBytes ||
      (this.lastUsage !== undefined &&
        snapshot.usage.artifactReadBytes !== this.lastUsage + expectedBytes)
    )
      throw new PolicyArtifactByteAdmissionError();
    this.chargedBytes += expectedBytes;
    this.lastUsage = snapshot.usage.artifactReadBytes;
  }
  /** Returned publication must retain every acknowledged admission, including earlier attempts. */
  requireRetainedUsage(artifactReadBytes: number): void {
    this.requireHealthy();
    if (
      this.chargedBytes > 0 &&
      (this.lastUsage === undefined || artifactReadBytes < this.lastUsage)
    )
      throw new PolicyArtifactByteAdmissionError();
  }
}
