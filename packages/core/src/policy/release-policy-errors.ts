export class InvalidPolicyInstallationBindingInputError extends TypeError {
  readonly code = "policy_installation_binding_input_invalid";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "InvalidPolicyInstallationBindingInputError";
  }
}

export class InvalidReleasePolicyRecordInputError extends TypeError {
  readonly code = "release_policy_record_input_invalid";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "InvalidReleasePolicyRecordInputError";
  }
}

export class InvalidReleasePolicyLifecycleInputError extends TypeError {
  readonly code = "release_policy_lifecycle_input_invalid";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "InvalidReleasePolicyLifecycleInputError";
  }
}

export class InvalidReleasePolicyAuthorityInputError extends TypeError {
  readonly code = "release_policy_authority_input_invalid";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "InvalidReleasePolicyAuthorityInputError";
  }
}

export class ReleasePolicyAuthorityResolutionError extends Error {
  readonly code = "release_policy_authority_resolution_unavailable";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ReleasePolicyAuthorityResolutionError";
  }
}

export class ReleasePolicyAuthorityResolverContractError extends Error {
  readonly code = "release_policy_authority_resolver_contract_violation";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ReleasePolicyAuthorityResolverContractError";
  }
}

export class InvalidReleasePolicyCommandError extends TypeError {
  readonly code = "release_policy_command_invalid";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "InvalidReleasePolicyCommandError";
  }
}

export class ReleasePolicyVersionConflictError extends Error {
  readonly code = "release_policy_version_conflict";

  constructor(readonly policyVersionId: string) {
    super(
      `Release policy version ${policyVersionId} is already bound to different immutable semantics`,
    );
    this.name = "ReleasePolicyVersionConflictError";
  }
}

export class ReleasePolicyResourceConflictError extends Error {
  readonly code = "release_policy_resource_conflict";

  constructor(readonly policyId: string) {
    super(`Release policy resource ${policyId} is already bound to a different tenant scope`);
    this.name = "ReleasePolicyResourceConflictError";
  }
}

export class ReleasePolicyLineageError extends Error {
  readonly code = "release_policy_lineage_invalid";

  constructor(
    readonly policyVersionId: string,
    readonly relatedPolicyVersionId: string,
  ) {
    super(
      `Release policy ${policyVersionId} references unavailable or conflicting policy ${relatedPolicyVersionId}`,
    );
    this.name = "ReleasePolicyLineageError";
  }
}

export interface ReleasePolicyAuthorityRejectionFinding {
  readonly reason: string;
  readonly sourceReviewId?: string;
  readonly sourceSnapshotId?: string;
}

export class ReleasePolicyAuthorityRejectedError extends Error {
  readonly code = "release_policy_authority_rejected";
  readonly findings: readonly ReleasePolicyAuthorityRejectionFinding[];

  constructor(findings: readonly ReleasePolicyAuthorityRejectionFinding[]) {
    super("Release policy publication authority was rejected");
    this.name = "ReleasePolicyAuthorityRejectedError";
    this.findings = structuredClone(findings);
  }
}

export class ReleasePolicyRepositoryContractError extends Error {
  readonly code = "release_policy_repository_contract_violation";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ReleasePolicyRepositoryContractError";
  }
}

export class ReleasePolicyNotFoundError extends Error {
  readonly code = "release_policy_not_found";

  constructor(readonly policyVersionId: string) {
    super(`Release policy ${policyVersionId} was not found`);
    this.name = "ReleasePolicyNotFoundError";
  }
}

export class ReleasePolicyLifecycleEventConflictError extends Error {
  readonly code = "release_policy_lifecycle_event_conflict";

  constructor(readonly eventId: string) {
    super(`Release policy lifecycle event ${eventId} is bound to different semantics`);
    this.name = "ReleasePolicyLifecycleEventConflictError";
  }
}

export class ReleasePolicyLifecycleEventNotFoundError extends Error {
  readonly code = "release_policy_lifecycle_event_not_found";

  constructor(readonly eventId: string) {
    super(`Release policy lifecycle event ${eventId} was not found`);
    this.name = "ReleasePolicyLifecycleEventNotFoundError";
  }
}

export class ReleasePolicyLifecycleStateConflictError extends Error {
  readonly code = "release_policy_lifecycle_state_conflict";

  constructor(readonly policyVersionId: string) {
    super(`Release policy ${policyVersionId} already has a terminal lifecycle event`);
    this.name = "ReleasePolicyLifecycleStateConflictError";
  }
}
