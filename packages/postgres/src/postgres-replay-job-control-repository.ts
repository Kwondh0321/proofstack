import { isDeepStrictEqual } from "node:util";
import {
  EvidenceScopeSchema,
  type EvidenceScope,
  OpaqueIdSchema,
  ReplayCancellationRequestSchema,
  ReplayJobSchema,
  ReplayPlanJobReferenceSchema,
  RequestReplayCancellationSchema,
} from "@proofstack/contracts";
import {
  DurableReplayStateError,
  ReplayDefinitionLineageError,
  ReplayJobConflictError,
  ReplayJobNotFoundError,
  ReplayRepositoryContractError,
  type CreateReplayJobCommand,
  type CreateReplayJobResult,
  type ReplayJobControlRepository,
  type ReplayJobSnapshot,
  type RequestDurableReplayCancellationCommand,
  type RequestDurableReplayCancellationResult,
} from "@proofstack/replay";
import type { Pool, QueryResultRow } from "pg";
import {
  loadPostgresReplayJobSnapshot,
  requirePostgresReplayJobSnapshot,
} from "./postgres-replay-job-snapshot.js";
import { withTenantTransaction } from "./tenant-transaction.js";

type ControlOperation = "create" | "request_cancellation";

interface CreateJobRow extends QueryResultRow {
  readonly created: unknown;
  readonly job: unknown;
}

interface CancellationRow extends CreateJobRow {
  readonly request: unknown;
}

function contractViolation(message: string, cause?: unknown): never {
  throw new ReplayRepositoryContractError(message, cause === undefined ? undefined : { cause });
}

function postgresCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}

function postgresMessage(error: unknown): string {
  return typeof error === "object" && error !== null && "message" in error
    ? String(error.message)
    : "";
}

function mapPersistenceError(error: unknown, operation: ControlOperation): never {
  if (
    error instanceof DurableReplayStateError ||
    error instanceof ReplayDefinitionLineageError ||
    error instanceof ReplayJobConflictError ||
    error instanceof ReplayJobNotFoundError ||
    error instanceof ReplayRepositoryContractError
  ) {
    throw error;
  }

  const code = postgresCode(error);
  const message = postgresMessage(error);
  if (code === "P0002") throw new ReplayJobNotFoundError();
  if (code === "23503" && operation === "create") throw new ReplayDefinitionLineageError();
  if (code === "23505") {
    if (operation === "request_cancellation") {
      throw new DurableReplayStateError("cancellation_conflict", { cause: error });
    }
    throw new ReplayJobConflictError();
  }
  if (code === "40001") {
    throw new DurableReplayStateError("state_conflict", { cause: error });
  }
  if (code === "22003") {
    throw new DurableReplayStateError("counter_exhausted", { cause: error });
  }
  if (code === "23514" && /canonical .*intent|missing its canonical intent/i.test(message)) {
    contractViolation(
      "PostgreSQL replay control state is missing a canonical outbox intent",
      error,
    );
  }
  if (code === "22023" || code === "23503" || code === "23514") {
    throw new ReplayJobConflictError();
  }
  throw error;
}

function requireOneRow<Row extends QueryResultRow>(rows: readonly Row[], label: string): Row {
  const row = rows[0];
  if (rows.length !== 1 || !row) contractViolation(`PostgreSQL returned an invalid ${label}`);
  return row;
}

function requireCreated(row: CreateJobRow, label: string): boolean {
  if (typeof row.created !== "boolean") {
    contractViolation(`PostgreSQL returned an invalid ${label}`);
  }
  return row.created;
}

function isInitialSnapshot(snapshot: ReplayJobSnapshot): boolean {
  return (
    snapshot.job.status === "queued" &&
    snapshot.job.stateVersion === 1 &&
    snapshot.job.recoveryEpoch === 0 &&
    snapshot.job.lastFencingToken === 0 &&
    snapshot.job.latestAttemptSequence === undefined &&
    snapshot.job.currentLease === undefined &&
    snapshot.job.startedAt === undefined &&
    snapshot.job.terminal === undefined &&
    snapshot.attempts.length === 0 &&
    snapshot.budgetLedger.length === 0 &&
    snapshot.cancellationAcknowledgements.length === 0 &&
    snapshot.cancellationRequest === null &&
    snapshot.executionObservations.length === 0 &&
    snapshot.usageObservations.length === 0
  );
}

/** PostgreSQL control-plane adapter for replay creation, lookup, and cancellation. */
export class PostgresReplayJobControlRepository implements ReplayJobControlRepository {
  constructor(private readonly pool: Pick<Pool, "connect">) {}

  async findJob(scopeInput: EvidenceScope, jobIdInput: string): Promise<ReplayJobSnapshot | null> {
    const scope = EvidenceScopeSchema.parse(scopeInput);
    const jobId = OpaqueIdSchema.parse(jobIdInput);
    return withTenantTransaction(this.pool, scope.tenantId, (client) =>
      loadPostgresReplayJobSnapshot(client, scope, jobId),
    );
  }

  async createJob(command: CreateReplayJobCommand): Promise<CreateReplayJobResult> {
    const scope = EvidenceScopeSchema.parse(command.scope);
    const jobId = OpaqueIdSchema.parse(command.jobId);
    const plan = ReplayPlanJobReferenceSchema.parse(command.plan);
    const createdByPrincipalId = OpaqueIdSchema.parse(command.createdByPrincipalId);

    try {
      return await withTenantTransaction(this.pool, scope.tenantId, async (client) => {
        const result = await client.query<CreateJobRow>(
          `SELECT * FROM public.proofstack_create_replay_job(
            $1, $2, $3, $4, $5, $6, $7
          )`,
          [
            scope.projectId,
            scope.environmentId,
            jobId,
            plan.planId,
            plan.planVersionId,
            plan.definitionSha256,
            createdByPrincipalId,
          ],
        );
        const row = requireOneRow(result.rows, "replay job creation result");
        const created = requireCreated(row, "replay job creation result");
        const returnedJob = ReplayJobSchema.parse(row.job);
        const snapshot = await requirePostgresReplayJobSnapshot(client, scope, jobId);
        if (
          !isDeepStrictEqual(returnedJob, snapshot.job) ||
          !isDeepStrictEqual(snapshot.job.plan, plan) ||
          snapshot.job.createdByPrincipalId !== createdByPrincipalId ||
          (created && !isInitialSnapshot(snapshot))
        ) {
          contractViolation(
            "PostgreSQL replay job creation disagrees with its exact durable snapshot",
          );
        }
        return { created, snapshot };
      });
    } catch (error) {
      mapPersistenceError(error, "create");
    }
  }

  async requestCancellation(
    command: RequestDurableReplayCancellationCommand,
  ): Promise<RequestDurableReplayCancellationResult> {
    const scope = EvidenceScopeSchema.parse(command.scope);
    const jobId = OpaqueIdSchema.parse(command.jobId);
    const input = RequestReplayCancellationSchema.parse(command.input);
    const requestedByPrincipalId = OpaqueIdSchema.parse(command.requestedByPrincipalId);

    try {
      return await withTenantTransaction(this.pool, scope.tenantId, async (client) => {
        const result = await client.query<CancellationRow>(
          `SELECT * FROM public.proofstack_request_replay_cancellation(
            $1, $2, $3, $4, $5, $6, $7
          )`,
          [
            scope.projectId,
            scope.environmentId,
            jobId,
            input.cancellationId,
            input.reasonCode,
            input.reason,
            requestedByPrincipalId,
          ],
        );
        const row = requireOneRow(result.rows, "replay cancellation result");
        const created = requireCreated(row, "replay cancellation result");
        const returnedJob = ReplayJobSchema.parse(row.job);
        const snapshot = await requirePostgresReplayJobSnapshot(client, scope, jobId);
        if (!isDeepStrictEqual(returnedJob, snapshot.job)) {
          contractViolation(
            "PostgreSQL replay cancellation job disagrees with its durable snapshot",
          );
        }

        const returnedRequest =
          row.request === null ? null : ReplayCancellationRequestSchema.parse(row.request);
        if (!isDeepStrictEqual(returnedRequest, snapshot.cancellationRequest)) {
          contractViolation(
            "PostgreSQL replay cancellation request disagrees with its durable snapshot",
          );
        }
        if (returnedRequest === null) {
          if (created || snapshot.job.terminal === undefined) {
            contractViolation("PostgreSQL returned an invalid terminal cancellation result");
          }
        } else if (
          returnedRequest.cancellationId !== input.cancellationId ||
          returnedRequest.reasonCode !== input.reasonCode ||
          returnedRequest.reason !== input.reason ||
          (created && returnedRequest.requestedByPrincipalId !== requestedByPrincipalId)
        ) {
          contractViolation(
            "PostgreSQL replay cancellation disagrees with its immutable request input",
          );
        }
        return { created, snapshot };
      });
    } catch (error) {
      mapPersistenceError(error, "request_cancellation");
    }
  }
}
