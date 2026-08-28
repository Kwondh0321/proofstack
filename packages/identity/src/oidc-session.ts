import {
  type Capability,
  type PrincipalContext,
  PrincipalContextSchema,
  type ResourceScope,
  type Role,
} from "@proofstack/contracts";
import { OidcIdentityDataIntegrityError } from "./oidc-login.js";
import { browserSessionDigest, verifyBrowserCsrfToken } from "./oidc-secrets.js";

export interface AuthenticatableBrowserSession {
  readonly capabilities: readonly Capability[];
  readonly createdAt: string;
  readonly csrfDigest: string;
  readonly principalId: string;
  readonly resourceScope: ResourceScope;
  readonly roles: readonly Role[];
  readonly sessionDigest: string;
  readonly sessionId: string;
  readonly tenantId: string;
}

export interface BrowserSessionLookup {
  findAndTouchActive(sessionDigest: string): Promise<AuthenticatableBrowserSession | null>;
}

export interface BrowserSessionRevoker {
  revokeActive(sessionDigest: string): Promise<boolean>;
}

export interface AuthenticatedBrowserSession {
  readonly csrfDigest: string;
  readonly principal: PrincipalContext;
  readonly sessionDigest: string;
}

export class InvalidBrowserSessionError extends Error {
  constructor(options?: ErrorOptions) {
    super("Browser session is invalid or expired", options);
    this.name = "InvalidBrowserSessionError";
  }
}

export class InvalidBrowserCsrfError extends Error {
  constructor() {
    super("Browser request CSRF verification failed");
    this.name = "InvalidBrowserCsrfError";
  }
}

export class OidcSessionAuthenticator {
  constructor(private readonly sessions: BrowserSessionLookup) {}

  async authenticate(value: string, requestId: string): Promise<AuthenticatedBrowserSession> {
    let sessionDigest: string;
    try {
      sessionDigest = browserSessionDigest(value);
    } catch (error) {
      throw new InvalidBrowserSessionError({ cause: error });
    }

    const session = await this.sessions.findAndTouchActive(sessionDigest);
    if (!session) throw new InvalidBrowserSessionError();
    if (session.sessionDigest !== sessionDigest) {
      throw new OidcIdentityDataIntegrityError(
        "Browser session lookup returned a different session digest",
      );
    }
    if (!/^[0-9a-f]{64}$/.test(session.csrfDigest)) {
      throw new OidcIdentityDataIntegrityError("Stored browser session CSRF digest is invalid");
    }

    const principal = PrincipalContextSchema.safeParse({
      authentication: {
        authenticatedAt: session.createdAt,
        credentialId: session.sessionId,
        method: "oidc",
      },
      capabilities: session.capabilities,
      principalId: session.principalId,
      principalType: "user",
      requestId,
      resourceScope: session.resourceScope,
      roles: session.roles,
      tenantId: session.tenantId,
    });
    if (!principal.success) {
      throw new OidcIdentityDataIntegrityError("Stored browser session authorization is invalid", {
        cause: principal.error,
      });
    }
    return { csrfDigest: session.csrfDigest, principal: principal.data, sessionDigest };
  }
}

export function requireBrowserCsrfToken(value: string, expectedDigest: string): void {
  if (!verifyBrowserCsrfToken(value, expectedDigest)) throw new InvalidBrowserCsrfError();
}

export class OidcSessionLifecycle {
  constructor(private readonly sessions: BrowserSessionRevoker) {}

  async revoke(authentication: AuthenticatedBrowserSession): Promise<boolean> {
    return this.sessions.revokeActive(authentication.sessionDigest);
  }
}
