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
