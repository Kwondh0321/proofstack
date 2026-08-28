import { randomUUID } from "node:crypto";
import {
  ApiKeyNameSchema,
  ApiKeyRevocationReasonSchema,
  OpaqueIdSchema,
  type PrincipalContext,
  type ResourceScope,
  TimestampSchema,
  type WorkloadCapability,
} from "@proofstack/contracts";
import {
  type Clock,
  canDelegateResourceScope,
  ForbiddenError,
  requireCapability,
  requireWorkloadDelegation,
  SystemClock,
} from "@proofstack/core";
import {
  type ApiKeyPasswordHash,
  generateApiKey,
  hashApiKeySecret,
  type IssuedApiKey,
} from "./api-key.js";

const DEFAULT_EXPIRATION_MS = 90 * 24 * 60 * 60 * 1_000;
const MIN_EXPIRATION_MS = 60 * 1_000;
const MAX_EXPIRATION_MS = 365 * 24 * 60 * 60 * 1_000;
const MAX_GENERATION_ATTEMPTS = 3;

export interface ManagedApiKeyCredential {
  readonly capabilities: readonly WorkloadCapability[];
  readonly createdAt: string;
  readonly credentialId: string;
  readonly expiresAt: string;
  readonly name: string;
  readonly prefix: string;
  readonly principalId: string;
  readonly resourceScope: ResourceScope;
  readonly revokedAt: string | null;
  readonly rotatedFromCredentialId: string | null;
  readonly tenantId: string;
}

export interface CreateApiKeyCredential
  extends Omit<ManagedApiKeyCredential, "createdAt" | "revokedAt"> {
  readonly actorPrincipalId: string;
  readonly passwordHash: ApiKeyPasswordHash;
}

export interface RotateApiKeyCredential {
  readonly actorPrincipalId: string;
  readonly credential: CreateApiKeyCredential;
  readonly previousCredentialId: string;
}

export interface ApiKeyCredentialStore {
  create(input: CreateApiKeyCredential): Promise<{ readonly createdAt: string }>;
  findById(tenantId: string, credentialId: string): Promise<ManagedApiKeyCredential | null>;
  revoke(
    tenantId: string,
    credentialId: string,
    actorPrincipalId: string,
    reason: string,
  ): Promise<boolean>;
  rotate(input: RotateApiKeyCredential): Promise<{ readonly createdAt: string }>;
}

export interface IssueApiKeyOptions {
  readonly capabilities: readonly WorkloadCapability[];
  readonly expiresAt?: string;
  readonly issuer: PrincipalContext;
  readonly name: string;
  readonly resourceScope: ResourceScope;
}

export interface RotateApiKeyOptions {
  readonly credentialId: string;
  readonly expiresAt?: string;
  readonly issuer: PrincipalContext;
}

export interface RevokeApiKeyOptions {
  readonly credentialId: string;
  readonly issuer: PrincipalContext;
  readonly reason: string;
}

export interface IssuedApiKeyCredential {
  readonly credential: ManagedApiKeyCredential;
  readonly value: string;
}

export class ApiKeyCredentialConflictError extends Error {
  constructor() {
    super("Generated API key identity conflicts with an existing credential");
    this.name = "ApiKeyCredentialConflictError";
  }
}

export class ApiKeyCredentialNotFoundError extends Error {
  constructor(credentialId: string) {
    super(`API key credential ${credentialId} was not found`);
    this.name = "ApiKeyCredentialNotFoundError";
  }
}

export class ApiKeyCredentialNotActiveError extends Error {
  constructor(credentialId: string) {
    super(`API key credential ${credentialId} is not active`);
    this.name = "ApiKeyCredentialNotActiveError";
  }
}

export class ApiKeyGenerationError extends Error {
  constructor(options?: ErrorOptions) {
    super("Could not generate a unique API key credential", options);
    this.name = "ApiKeyGenerationError";
  }
}

export class InvalidApiKeyLifecycleInputError extends TypeError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "InvalidApiKeyLifecycleInputError";
  }
}

export interface ApiKeyLifecycleDependencies {
  readonly clock: Clock;
  readonly generateId: (kind: "credential" | "workload") => string;
  readonly generateKey: () => IssuedApiKey;
  readonly hashSecret: (secret: string) => Promise<ApiKeyPasswordHash>;
}

const defaultDependencies: ApiKeyLifecycleDependencies = {
  clock: new SystemClock(),
  generateId: (kind) =>
    `${kind === "credential" ? "key" : "wrk"}_${randomUUID().replaceAll("-", "")}`,
  generateKey: generateApiKey,
  hashSecret: hashApiKeySecret,
};

function requireName(name: string): string {
  const parsed = ApiKeyNameSchema.safeParse(name);
  if (!parsed.success) {
    throw new InvalidApiKeyLifecycleInputError("API key name is invalid", {
      cause: parsed.error,
    });
  }
  return parsed.data;
}

function requireCredentialId(value: string): string {
  if (!OpaqueIdSchema.safeParse(value).success) {
    throw new InvalidApiKeyLifecycleInputError("API key credential identifier is invalid");
  }
  return value;
}

function requireGeneratedId(value: string, kind: "credential" | "workload"): string {
  if (!OpaqueIdSchema.safeParse(value).success) {
    throw new ApiKeyGenerationError({ cause: new TypeError(`Generated ${kind} ID is invalid`) });
  }
  return value;
}

function expiration(clock: Clock, requested?: string): string {
  const now = clock.now().getTime();
  const expiresAt = requested ?? new Date(now + DEFAULT_EXPIRATION_MS).toISOString();
  if (!TimestampSchema.safeParse(expiresAt).success) {
    throw new InvalidApiKeyLifecycleInputError("API key expiration must be an ISO 8601 timestamp");
  }
  const duration = new Date(expiresAt).getTime() - now;
  if (duration < MIN_EXPIRATION_MS || duration > MAX_EXPIRATION_MS) {
    throw new InvalidApiKeyLifecycleInputError(
      "API key expiration must be between 1 minute and 365 days from now",
    );
  }
  return new Date(expiresAt).toISOString();
}

function requireReason(reason: string): string {
  const parsed = ApiKeyRevocationReasonSchema.safeParse(reason);
  if (!parsed.success) {
    throw new InvalidApiKeyLifecycleInputError("API key revocation reason is invalid", {
      cause: parsed.error,
    });
  }
  return parsed.data;
}

function requireIdentityManager(issuer: PrincipalContext, targetScope: ResourceScope): void {
  requireIdentityAdministrator(issuer);
  if (!canDelegateResourceScope(issuer.resourceScope, targetScope)) {
    throw new ForbiddenError("A principal cannot manage a workload outside its resource scope");
  }
}

function requireIdentityAdministrator(issuer: PrincipalContext): void {
  requireCapability(issuer, "identity:manage");
  if (issuer.principalType !== "user") {
    throw new ForbiddenError("Only a user principal can manage workload credentials");
  }
}

function activeAt(credential: ManagedApiKeyCredential, clock: Clock): boolean {
  return (
    credential.revokedAt === null &&
    new Date(credential.expiresAt).getTime() > clock.now().getTime()
  );
}

function managedCredential(
  input: CreateApiKeyCredential,
  createdAt: string,
): ManagedApiKeyCredential {
  return {
    capabilities: input.capabilities,
    createdAt,
    credentialId: input.credentialId,
    expiresAt: input.expiresAt,
    name: input.name,
    prefix: input.prefix,
    principalId: input.principalId,
    resourceScope: input.resourceScope,
    revokedAt: null,
    rotatedFromCredentialId: input.rotatedFromCredentialId,
    tenantId: input.tenantId,
  };
}

export class ApiKeyLifecycle {
  constructor(
    private readonly store: ApiKeyCredentialStore,
    private readonly dependencies: ApiKeyLifecycleDependencies = defaultDependencies,
  ) {}

  private async generateCredential(
    input: Omit<CreateApiKeyCredential, "credentialId" | "passwordHash" | "prefix">,
  ): Promise<{ readonly credential: CreateApiKeyCredential; readonly issued: IssuedApiKey }> {
    const issued = this.dependencies.generateKey();
    return {
      credential: {
        ...input,
        credentialId: requireGeneratedId(this.dependencies.generateId("credential"), "credential"),
        passwordHash: await this.dependencies.hashSecret(issued.secret),
        prefix: issued.prefix,
      },
      issued,
    };
  }

  async issue(options: IssueApiKeyOptions): Promise<IssuedApiKeyCredential> {
    requireWorkloadDelegation(options.issuer, options.capabilities, options.resourceScope);
    const name = requireName(options.name);
    const expiresAt = expiration(this.dependencies.clock, options.expiresAt);
    const principalId = requireGeneratedId(this.dependencies.generateId("workload"), "workload");
    let lastConflict: ApiKeyCredentialConflictError | undefined;

    for (let attempt = 0; attempt < MAX_GENERATION_ATTEMPTS; attempt += 1) {
      const generated = await this.generateCredential({
        actorPrincipalId: options.issuer.principalId,
        capabilities: options.capabilities,
        expiresAt,
        name,
        principalId,
        resourceScope: options.resourceScope,
        rotatedFromCredentialId: null,
        tenantId: options.issuer.tenantId,
      });
      try {
        const result = await this.store.create(generated.credential);
        return {
          credential: managedCredential(generated.credential, result.createdAt),
          value: generated.issued.value,
        };
      } catch (error) {
        if (!(error instanceof ApiKeyCredentialConflictError)) throw error;
        lastConflict = error;
      }
    }
    throw new ApiKeyGenerationError({ cause: lastConflict });
  }

  async rotate(options: RotateApiKeyOptions): Promise<IssuedApiKeyCredential> {
    const previousCredentialId = requireCredentialId(options.credentialId);
    requireIdentityAdministrator(options.issuer);
    const previous = await this.store.findById(options.issuer.tenantId, previousCredentialId);
    if (!previous) throw new ApiKeyCredentialNotFoundError(previousCredentialId);
    if (!activeAt(previous, this.dependencies.clock)) {
      throw new ApiKeyCredentialNotActiveError(previousCredentialId);
    }
    requireWorkloadDelegation(options.issuer, previous.capabilities, previous.resourceScope);
    const expiresAt = expiration(this.dependencies.clock, options.expiresAt);
    let lastConflict: ApiKeyCredentialConflictError | undefined;

    for (let attempt = 0; attempt < MAX_GENERATION_ATTEMPTS; attempt += 1) {
      const generated = await this.generateCredential({
        actorPrincipalId: options.issuer.principalId,
        capabilities: previous.capabilities,
        expiresAt,
        name: previous.name,
        principalId: previous.principalId,
        resourceScope: previous.resourceScope,
        rotatedFromCredentialId: previous.credentialId,
        tenantId: previous.tenantId,
      });
      try {
        const result = await this.store.rotate({
          actorPrincipalId: options.issuer.principalId,
          credential: generated.credential,
          previousCredentialId,
        });
        return {
          credential: managedCredential(generated.credential, result.createdAt),
          value: generated.issued.value,
        };
      } catch (error) {
        if (!(error instanceof ApiKeyCredentialConflictError)) throw error;
        lastConflict = error;
      }
    }
    throw new ApiKeyGenerationError({ cause: lastConflict });
  }

  async revoke(options: RevokeApiKeyOptions): Promise<boolean> {
    const credentialId = requireCredentialId(options.credentialId);
    const reason = requireReason(options.reason);
    requireIdentityAdministrator(options.issuer);
    const credential = await this.store.findById(options.issuer.tenantId, credentialId);
    if (!credential) throw new ApiKeyCredentialNotFoundError(credentialId);
    requireIdentityManager(options.issuer, credential.resourceScope);
    return this.store.revoke(
      options.issuer.tenantId,
      credentialId,
      options.issuer.principalId,
      reason,
    );
  }
}
