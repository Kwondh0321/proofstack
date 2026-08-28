export type RecoveryVerificationComponent =
  | "configuration"
  | "database"
  | "inventory"
  | "key-provider"
  | "manifest"
  | "migration-ledger";

export class RecoveryVerificationError extends Error {
  readonly code = "recovery_set_verification_failed";

  constructor(
    readonly component: RecoveryVerificationComponent,
    readonly reason: string,
    options?: ErrorOptions,
  ) {
    super(`Recovery ${component} verification failed: ${reason}`, options);
    this.name = "RecoveryVerificationError";
  }
}
