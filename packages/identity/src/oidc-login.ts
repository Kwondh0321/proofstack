import { randomUUID } from "node:crypto";
import {
  type Capability,
  OpaqueIdSchema,
  PrincipalContextSchema,
  type ResourceScope,
  type Role,
  TimestampSchema,
} from "@proofstack/contracts";
import {
  type BrowserSessionCredentials,
  browserSessionDigest,
  generateBrowserSessionCredentials,
  generateOidcLoginSecrets,
  type OidcLoginSecrets,
  type OidcLoginTransactionCipher,
  type OidcLoginTransactionPayload,
  oidcStateDigest,
  verifyBrowserCsrfToken,
} from "./oidc-secrets.js";
import { requireOidcIssuer, requireOidcSubject } from "./oidc-identity.js";

const DEFAULT_TRANSACTION_LIFETIME_SECONDS = 10 * 60;
const DEFAULT_ABSOLUTE_SESSION_LIFETIME_SECONDS = 12 * 60 * 60;
const DEFAULT_IDLE_SESSION_LIFETIME_SECONDS = 30 * 60;
const MIN_LIFETIME_SECONDS = 60;
const MAX_TRANSACTION_LIFETIME_SECONDS = 15 * 60;
const MAX_SESSION_LIFETIME_SECONDS = 24 * 60 * 60;
const MAX_GENERATION_ATTEMPTS = 3;
const MAX_AUTHORIZATION_URL_LENGTH = 4_096;

export interface OidcAuthorizationInput {
  readonly codeChallenge: string;
  readonly nonce: string;
  readonly state: string;
}

export interface OidcCallbackInput {
  readonly codeVerifier: string;
  readonly currentUrl: string;
  readonly expectedNonce: string;
  readonly expectedState: string;
}

export interface OidcProviderClient {
  readonly issuer: string;
  authorizationUrl(input: OidcAuthorizationInput): string;
  validateCallback(input: OidcCallbackInput): Promise<{ readonly subject: string }>;
}

export interface CreateOidcLoginTransaction {
  readonly lifetimeSeconds: number;
  readonly protectedPayload: string;
  readonly stateDigest: string;
}

export interface CreatedOidcLoginTransaction {
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface ConsumedOidcLoginTransaction {
  readonly protectedPayload: string;
  readonly stateDigest: string;
}

export interface OidcLoginTransactionStore {
  consumeActive(stateDigest: string): Promise<ConsumedOidcLoginTransaction | null>;
  create(input: CreateOidcLoginTransaction): Promise<CreatedOidcLoginTransaction>;
}

export interface ActiveOidcBinding {
  readonly bindingId: string;
  readonly capabilities: readonly Capability[];
  readonly issuer: string;
  readonly principalId: string;
  readonly resourceScope: ResourceScope;
  readonly roles: readonly Role[];
  readonly subject: string;
  readonly tenantId: string;
}

export interface OidcBindingLookup {
  findActiveByIssuerSubject(issuer: string, subject: string): Promise<ActiveOidcBinding | null>;
}

export interface CreateBrowserSession {
  readonly absoluteLifetimeSeconds: number;
  readonly bindingId: string;
  readonly csrfDigest: string;
  readonly idleLifetimeSeconds: number;
  readonly sessionDigest: string;
  readonly sessionId: string;
}

export interface CreatedBrowserSession {
  readonly absoluteExpiresAt: string;
  readonly createdAt: string;
  readonly idleExpiresAt: string;
  readonly sessionId: string;
}

export interface BrowserSessionCreator {
  create(input: CreateBrowserSession): Promise<CreatedBrowserSession>;
}

export interface OidcLoginServicePorts {
  readonly bindings: OidcBindingLookup;
  readonly cipher: OidcLoginTransactionCipher;
  readonly provider: OidcProviderClient;
  readonly sessions: BrowserSessionCreator;
  readonly transactions: OidcLoginTransactionStore;
}

export interface OidcLoginServiceOptions {
  readonly absoluteSessionLifetimeSeconds?: number;
  readonly idleSessionLifetimeSeconds?: number;
  readonly transactionLifetimeSeconds?: number;
}

export interface OidcLoginServiceDependencies {
  readonly generateLoginSecrets: () => OidcLoginSecrets;
  readonly generateSessionCredentials: () => BrowserSessionCredentials;
  readonly generateSessionId: () => string;
}

export interface BegunOidcLogin {
  readonly authorizationUrl: string;
  readonly expiresAt: string;
}

export interface CompletedOidcLogin {
  readonly absoluteExpiresAt: string;
  readonly csrfToken: string;
  readonly idleExpiresAt: string;
  readonly returnTo: string;
  readonly sessionToken: string;
}

export class InvalidOidcLoginError extends Error {
  constructor(options?: ErrorOptions) {
    super("OIDC login is invalid or expired", options);
    this.name = "InvalidOidcLoginError";
  }
}

export class OidcProviderConfigurationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "OidcProviderConfigurationError";
  }
}

export class OidcLoginTransactionConflictError extends Error {
  constructor() {
    super("OIDC login transaction identity conflicts with an existing transaction");
    this.name = "OidcLoginTransactionConflictError";
  }
}

export class BrowserSessionConflictError extends Error {
  constructor() {
    super("Browser session identity conflicts with an existing session");
    this.name = "BrowserSessionConflictError";
  }
}

export class OidcBindingNotActiveError extends Error {
  constructor() {
    super("OIDC binding is not active");
    this.name = "OidcBindingNotActiveError";
  }
}

export class OidcLoginGenerationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "OidcLoginGenerationError";
  }
}

export class OidcIdentityDataIntegrityError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "OidcIdentityDataIntegrityError";
  }
}

const defaultDependencies: OidcLoginServiceDependencies = {
  generateLoginSecrets: generateOidcLoginSecrets,
  generateSessionCredentials: generateBrowserSessionCredentials,
  generateSessionId: () => `ses_${randomUUID().replaceAll("-", "")}`,
};

function lifetime(
  value: number | undefined,
  fallback: number,
  maximum: number,
  label: string,
): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < MIN_LIFETIME_SECONDS || result > maximum) {
    throw new OidcProviderConfigurationError(
      `${label} must be an integer between ${MIN_LIFETIME_SECONDS} and ${maximum} seconds`,
    );
  }
  return result;
}

function requireIssuer(value: string): string {
  try {
    return requireOidcIssuer(value);
  } catch (error) {
    throw new OidcProviderConfigurationError((error as Error).message, { cause: error });
  }
}

function requireSubject(value: string): string {
  try {
    return requireOidcSubject(value);
  } catch {
    throw new OidcIdentityDataIntegrityError("OIDC provider returned an invalid subject");
  }
}

function requireAuthorizationUrl(value: string, input: OidcAuthorizationInput): string {
  if (value.length === 0 || value.length > MAX_AUTHORIZATION_URL_LENGTH) {
    throw new OidcProviderConfigurationError("OIDC authorization URL is invalid");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new OidcProviderConfigurationError("OIDC authorization URL is invalid", { cause: error });
  }
  const exactParameter = (name: string, expected: string): boolean => {
    const values = url.searchParams.getAll(name);
    return values.length === 1 && values[0] === expected;
  };
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    !exactParameter("response_type", "code") ||
    !exactParameter("state", input.state) ||
    !exactParameter("nonce", input.nonce) ||
    !exactParameter("code_challenge", input.codeChallenge) ||
    !exactParameter("code_challenge_method", "S256")
  ) {
    throw new OidcProviderConfigurationError(
      "OIDC authorization URL does not preserve the required secure parameters",
    );
  }
  return value;
}

function requireSessionId(value: string): string {
  const result = OpaqueIdSchema.safeParse(value);
  if (!result.success) {
    throw new OidcLoginGenerationError("Generated browser session identifier is invalid", {
      cause: result.error,
    });
  }
  return result.data;
}

function requireCreatedSession(
  value: CreatedBrowserSession,
  expectedSessionId: string,
  absoluteLifetimeSeconds: number,
  idleLifetimeSeconds: number,
): CreatedBrowserSession {
  if (value.sessionId !== expectedSessionId) {
    throw new OidcIdentityDataIntegrityError("Browser session store returned invalid metadata");
  }
  const authenticatedAt = TimestampSchema.safeParse(value.createdAt);
  const absoluteExpiresAt = TimestampSchema.safeParse(value.absoluteExpiresAt);
  const idleExpiresAt = TimestampSchema.safeParse(value.idleExpiresAt);
  if (!authenticatedAt.success || !absoluteExpiresAt.success || !idleExpiresAt.success) {
    throw new OidcIdentityDataIntegrityError("Browser session store returned invalid metadata");
  }
  const createdAtMs = new Date(authenticatedAt.data).getTime();
  const absoluteExpiresAtMs = new Date(absoluteExpiresAt.data).getTime();
  const idleExpiresAtMs = new Date(idleExpiresAt.data).getTime();
  if (
    absoluteExpiresAtMs - createdAtMs !== absoluteLifetimeSeconds * 1_000 ||
    idleExpiresAtMs - createdAtMs !== idleLifetimeSeconds * 1_000
  ) {
    throw new OidcIdentityDataIntegrityError("Browser session store returned invalid metadata");
  }
  return value;
}

function requireCreatedTransaction(
  value: CreatedOidcLoginTransaction,
  lifetimeSeconds: number,
): CreatedOidcLoginTransaction {
  const createdAt = TimestampSchema.safeParse(value.createdAt);
  const expiresAt = TimestampSchema.safeParse(value.expiresAt);
  if (!createdAt.success || !expiresAt.success) {
    throw new OidcIdentityDataIntegrityError("OIDC transaction store returned invalid metadata");
  }
  if (
    new Date(expiresAt.data).getTime() - new Date(createdAt.data).getTime() !==
    lifetimeSeconds * 1_000
  ) {
    throw new OidcIdentityDataIntegrityError("OIDC transaction store returned invalid metadata");
  }
  return value;
}

function requireBinding(
  binding: ActiveOidcBinding,
  issuer: string,
  subject: string,
): ActiveOidcBinding {
  if (binding.issuer !== issuer || binding.subject !== subject) {
    throw new OidcIdentityDataIntegrityError("OIDC binding lookup returned a different identity");
  }
  const parsed = PrincipalContextSchema.safeParse({
    authentication: {
      authenticatedAt: "2000-01-01T00:00:00.000Z",
      credentialId: binding.bindingId,
      method: "oidc",
    },
    capabilities: binding.capabilities,
    principalId: binding.principalId,
    principalType: "user",
    requestId: "req_oidc_binding_validation",
    resourceScope: binding.resourceScope,
    roles: binding.roles,
    tenantId: binding.tenantId,
  });
  if (!parsed.success) {
    throw new OidcIdentityDataIntegrityError("Stored OIDC binding authorization is invalid", {
      cause: parsed.error,
    });
  }
  return binding;
}

export class OidcLoginService {
  private readonly absoluteSessionLifetimeSeconds: number;
  private readonly idleSessionLifetimeSeconds: number;
  private readonly issuer: string;
  private readonly transactionLifetimeSeconds: number;

  constructor(
    private readonly ports: OidcLoginServicePorts,
    options: OidcLoginServiceOptions = {},
    private readonly dependencies: OidcLoginServiceDependencies = defaultDependencies,
  ) {
    this.issuer = requireIssuer(ports.provider.issuer);
    this.transactionLifetimeSeconds = lifetime(
      options.transactionLifetimeSeconds,
      DEFAULT_TRANSACTION_LIFETIME_SECONDS,
      MAX_TRANSACTION_LIFETIME_SECONDS,
      "OIDC login transaction lifetime",
    );
    this.absoluteSessionLifetimeSeconds = lifetime(
      options.absoluteSessionLifetimeSeconds,
      DEFAULT_ABSOLUTE_SESSION_LIFETIME_SECONDS,
      MAX_SESSION_LIFETIME_SECONDS,
      "OIDC absolute session lifetime",
    );
    this.idleSessionLifetimeSeconds = lifetime(
      options.idleSessionLifetimeSeconds,
      DEFAULT_IDLE_SESSION_LIFETIME_SECONDS,
      this.absoluteSessionLifetimeSeconds,
      "OIDC idle session lifetime",
    );
  }

  async begin(returnTo: string): Promise<BegunOidcLogin> {
    let lastConflict: OidcLoginTransactionConflictError | undefined;
    for (let attempt = 0; attempt < MAX_GENERATION_ATTEMPTS; attempt += 1) {
      const secrets = this.dependencies.generateLoginSecrets();
      const authorizationUrl = requireAuthorizationUrl(
        this.ports.provider.authorizationUrl({
          codeChallenge: secrets.codeChallenge,
          nonce: secrets.nonce,
          state: secrets.state,
        }),
        secrets,
      );
      const protectedPayload = this.ports.cipher.encrypt({
        codeVerifier: secrets.codeVerifier,
        nonce: secrets.nonce,
        returnTo,
        state: secrets.state,
      });
      try {
        const created = requireCreatedTransaction(
          await this.ports.transactions.create({
            lifetimeSeconds: this.transactionLifetimeSeconds,
            protectedPayload,
            stateDigest: secrets.stateDigest,
          }),
          this.transactionLifetimeSeconds,
        );
        return { authorizationUrl, expiresAt: created.expiresAt };
      } catch (error) {
        if (!(error instanceof OidcLoginTransactionConflictError)) throw error;
        lastConflict = error;
      }
    }
    throw new OidcLoginGenerationError("Could not generate a unique OIDC login transaction", {
      cause: lastConflict,
    });
  }

  async complete(currentUrl: string, state: string): Promise<CompletedOidcLogin> {
    let stateDigest: string;
    try {
      stateDigest = oidcStateDigest(state);
    } catch (error) {
      throw new InvalidOidcLoginError({ cause: error });
    }
    const transaction = await this.ports.transactions.consumeActive(stateDigest);
    if (!transaction) throw new InvalidOidcLoginError();
    if (transaction.stateDigest !== stateDigest) {
      throw new OidcIdentityDataIntegrityError(
        "OIDC transaction lookup returned a different state digest",
      );
    }

    let payload: OidcLoginTransactionPayload;
    try {
      payload = this.ports.cipher.decrypt(transaction.protectedPayload);
    } catch (error) {
      throw new OidcIdentityDataIntegrityError("Stored OIDC transaction is invalid", {
        cause: error,
      });
    }
    if (payload.state !== state) {
      throw new OidcIdentityDataIntegrityError("Stored OIDC transaction state is inconsistent");
    }

    let providerIdentity: { readonly subject: string };
    try {
      providerIdentity = await this.ports.provider.validateCallback({
        codeVerifier: payload.codeVerifier,
        currentUrl,
        expectedNonce: payload.nonce,
        expectedState: payload.state,
      });
    } catch (error) {
      throw new InvalidOidcLoginError({ cause: error });
    }
    const subject = requireSubject(providerIdentity.subject);

    const found = await this.ports.bindings.findActiveByIssuerSubject(this.issuer, subject);
    if (!found) throw new InvalidOidcLoginError();
    const binding = requireBinding(found, this.issuer, subject);
    let session: Awaited<ReturnType<OidcLoginService["createSession"]>>;
    try {
      session = await this.createSession(binding.bindingId);
    } catch (error) {
      if (error instanceof OidcBindingNotActiveError) {
        throw new InvalidOidcLoginError({ cause: error });
      }
      throw error;
    }
    return {
      absoluteExpiresAt: session.created.absoluteExpiresAt,
      csrfToken: session.credentials.csrfToken,
      idleExpiresAt: session.created.idleExpiresAt,
      returnTo: payload.returnTo,
      sessionToken: session.credentials.sessionToken,
    };
  }

  private async createSession(bindingId: string): Promise<{
    readonly created: CreatedBrowserSession;
    readonly credentials: BrowserSessionCredentials;
  }> {
    let lastConflict: BrowserSessionConflictError | undefined;
    for (let attempt = 0; attempt < MAX_GENERATION_ATTEMPTS; attempt += 1) {
      const credentials = this.dependencies.generateSessionCredentials();
      const sessionId = requireSessionId(this.dependencies.generateSessionId());
      let sessionDigest: string;
      try {
        sessionDigest = browserSessionDigest(credentials.sessionToken);
      } catch (error) {
        throw new OidcLoginGenerationError("Generated browser session credentials are invalid", {
          cause: error,
        });
      }
      if (
        sessionDigest !== credentials.sessionDigest ||
        !verifyBrowserCsrfToken(credentials.csrfToken, credentials.csrfDigest)
      ) {
        throw new OidcLoginGenerationError(
          "Generated browser session credentials are inconsistent",
        );
      }
      try {
        const created = requireCreatedSession(
          await this.ports.sessions.create({
            absoluteLifetimeSeconds: this.absoluteSessionLifetimeSeconds,
            bindingId,
            csrfDigest: credentials.csrfDigest,
            idleLifetimeSeconds: this.idleSessionLifetimeSeconds,
            sessionDigest,
            sessionId,
          }),
          sessionId,
          this.absoluteSessionLifetimeSeconds,
          this.idleSessionLifetimeSeconds,
        );
        return { created, credentials };
      } catch (error) {
        if (!(error instanceof BrowserSessionConflictError)) throw error;
        lastConflict = error;
      }
    }
    throw new OidcLoginGenerationError("Could not generate a unique browser session", {
      cause: lastConflict,
    });
  }
}
