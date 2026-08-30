import type {
  EvidenceScope,
  ReplayArtifactContentReference,
  ReplayAttempt,
  ReplayAttemptError,
  ReplayBudgetLedgerEntry,
  ReplayBudgetWorkReference,
  ReplayCancellationAcknowledgement,
  ReplayCancellationRequest,
  ReplayExecutionObservation,
  ReplayExecutionObservationPayload,
  ReplayJob,
  ReplayJobTerminalCode,
  ReplayJobTerminalStatus,
  ReplayPlanJobReference,
  ReplayUsageMeasurement,
  ReplayUsageObservation,
  ReplayWorkerMutationFence,
  RequestReplayCancellation,
  WorkerProtocolReference,
} from "@proofstack/contracts";
import type { ReplayBudgetAmounts, ReplayUsageMeasurements } from "./replay-budget.js";

export interface ReplayJobSnapshot {
  readonly attempts: readonly ReplayAttempt[];
  readonly budgetLedger: readonly ReplayBudgetLedgerEntry[];
  readonly cancellationAcknowledgements: readonly ReplayCancellationAcknowledgement[];
  readonly cancellationRequest: ReplayCancellationRequest | null;
  readonly executionObservations: readonly ReplayExecutionObservation[];
  readonly job: ReplayJob;
  readonly usageObservations: readonly ReplayUsageObservation[];
}

export interface CreateReplayJobCommand {
  readonly createdByPrincipalId: string;
  readonly jobId: string;
  readonly plan: ReplayPlanJobReference;
  readonly scope: EvidenceScope;
}

export interface CreateReplayJobResult {
  readonly created: boolean;
  readonly snapshot: ReplayJobSnapshot;
}

export interface ClaimDurableReplayJobCommand {
  readonly attemptId: string;
  readonly jobId: string;
  readonly leaseDurationMilliseconds: number;
  readonly leaseId: string;
  readonly scope: EvidenceScope;
  readonly workerBuildSha256: string;
  readonly workerId: string;
  readonly workerProtocol: WorkerProtocolReference;
}

export type ClaimDurableReplayJobResult =
  | {
      readonly claimed: false;
      readonly reason: "retry_not_ready" | "terminalized";
      readonly snapshot: ReplayJobSnapshot;
    }
  | {
      readonly claimed: true;
      readonly snapshot: ReplayJobSnapshot;
      readonly workerFence: ReplayWorkerMutationFence;
    };

export interface HeartbeatDurableReplayJobCommand {
  readonly leaseDurationMilliseconds: number;
  readonly scope: EvidenceScope;
  readonly workerFence: ReplayWorkerMutationFence;
}

export interface RequestDurableReplayCancellationCommand {
  readonly input: RequestReplayCancellation;
  readonly jobId: string;
  readonly requestedByPrincipalId: string;
  readonly scope: EvidenceScope;
}

export interface RequestDurableReplayCancellationResult {
  readonly created: boolean;
  readonly snapshot: ReplayJobSnapshot;
}

export interface AcknowledgeDurableReplayCancellationCommand {
  readonly acknowledgementId: string;
  readonly action: ReplayCancellationAcknowledgement["action"];
  readonly scope: EvidenceScope;
  readonly workerFence: ReplayWorkerMutationFence;
}

export interface ReserveDurableReplayBudgetCommand {
  readonly requested: ReplayBudgetAmounts;
  readonly reservationId: string;
  readonly scope: EvidenceScope;
  readonly work: ReplayBudgetWorkReference;
  readonly workerFence: ReplayWorkerMutationFence;
}

export interface ReconcileDurableReplayBudgetCommand {
  readonly reconciliationId: string;
  readonly reservationId: string;
  readonly scope: EvidenceScope;
  readonly usage: ReplayUsageMeasurements;
  readonly workerFence: ReplayWorkerMutationFence;
}

export interface AppendReplayExecutionObservationCommand {
  readonly observationId: string;
  readonly payload: ReplayExecutionObservationPayload;
  readonly scope: EvidenceScope;
  readonly workerFence: ReplayWorkerMutationFence;
}

export interface AppendReplayUsageObservationCommand {
  readonly boundaryId?: string;
  readonly measurements: readonly {
    readonly dimension: keyof ReplayUsageMeasurements;
    readonly usage: ReplayUsageMeasurement;
  }[];
  readonly observationId: string;
  readonly scope: EvidenceScope;
  readonly sourceEventSha256: string;
  readonly workerFence: ReplayWorkerMutationFence;
}

export interface CompleteDurableReplayJobCommand {
  readonly code: ReplayJobTerminalCode;
  readonly error?: ReplayAttemptError;
  readonly result?: ReplayArtifactContentReference;
  readonly scope: EvidenceScope;
  readonly status: ReplayJobTerminalStatus;
  readonly workerFence: ReplayWorkerMutationFence;
}

/**
 * Atomic, tenant-scoped durable replay mutation boundary.
 *
 * Implementations own server time, sequence assignment, exact-plan resolution, retry decisions,
 * monotonic fences, cancellation order, budget snapshots, and publication intents. Callers may
 * propose opaque mutation identifiers and bounded work, but cannot supply authoritative state,
 * timestamps, counters, target releases, runtime profiles, limits, or retry eligibility.
 */
/** Control-plane replay authority. Implementations must not carry worker mutation credentials. */
export interface ReplayJobControlRepository {
  createJob(command: CreateReplayJobCommand): Promise<CreateReplayJobResult>;

  findJob(scope: EvidenceScope, jobId: string): Promise<ReplayJobSnapshot | null>;

  requestCancellation(
    command: RequestDurableReplayCancellationCommand,
  ): Promise<RequestDurableReplayCancellationResult>;
}

/** Worker replay authority. Implementations must not carry control-plane mutation credentials. */
export interface ReplayJobWorkerRepository {
  acknowledgeCancellation(
    command: AcknowledgeDurableReplayCancellationCommand,
  ): Promise<ReplayJobSnapshot>;

  appendExecutionObservation(
    command: AppendReplayExecutionObservationCommand,
  ): Promise<ReplayJobSnapshot>;

  appendUsageObservation(command: AppendReplayUsageObservationCommand): Promise<ReplayJobSnapshot>;

  claimJob(command: ClaimDurableReplayJobCommand): Promise<ClaimDurableReplayJobResult>;

  completeJob(command: CompleteDurableReplayJobCommand): Promise<ReplayJobSnapshot>;

  findJob(scope: EvidenceScope, jobId: string): Promise<ReplayJobSnapshot | null>;

  heartbeatJob(command: HeartbeatDurableReplayJobCommand): Promise<ReplayJobSnapshot>;

  reconcileBudget(command: ReconcileDurableReplayBudgetCommand): Promise<ReplayJobSnapshot>;

  reserveBudget(command: ReserveDurableReplayBudgetCommand): Promise<ReplayJobSnapshot>;
}

/**
 * Complete semantic contract used by shared conformance suites and in-memory testing.
 *
 * Production composition must inject the narrower control or worker port so a runtime cannot
 * obtain both database authorities through one repository dependency.
 */
export interface ReplayJobRepository
  extends ReplayJobControlRepository,
    ReplayJobWorkerRepository {}
