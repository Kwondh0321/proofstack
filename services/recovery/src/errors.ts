export type RecoveryOperation = "database-backup" | "database-restore" | "postgres-tool";

export class RecoveryOperationError extends Error {
  readonly code = "recovery_operation_failed";

  constructor(
    readonly operation: RecoveryOperation,
    readonly reason: string,
    options?: ErrorOptions,
  ) {
    super(`Recovery ${operation} failed: ${reason}`, options);
    this.name = "RecoveryOperationError";
  }
}
