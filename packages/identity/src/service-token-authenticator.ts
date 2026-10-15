import { PrincipalContextSchema, type Capability, type ResourceScope } from "@proofstack/contracts";
import { IdentityDataIntegrityError } from "./api-key-authenticator.js";
import {
  parseServiceToken,
  verifyServiceTokenSecret,
  type ServiceTokenPasswordHash,
} from "./service-token.js";

/** A separately provisioned immutable service credential, never a delegated API key. */
export interface AuthenticatableServiceToken {
  readonly kind: "service_token";
  readonly authenticatedAt: string;
  readonly credentialId: string;
  readonly prefix: string;
  readonly passwordHash: ServiceTokenPasswordHash;
  readonly principalId: string;
  readonly tenantId: string;
  readonly capabilities: readonly Capability[];
  readonly resourceScope: ResourceScope;
}
export type ServiceTokenUseConfirmation = Omit<AuthenticatableServiceToken, "authenticatedAt">;
export interface ServiceTokenCredentialLookup {
  findActiveServiceByPrefix(prefix: string): Promise<AuthenticatableServiceToken | null>;
  /** Confirm the same immutable identity, secret hash AND grants after async verification. */
  confirmActiveServiceUse(expected: ServiceTokenUseConfirmation): Promise<boolean>;
}
export class InvalidServiceTokenError extends Error {
  constructor(options?: ErrorOptions) {
    super("Service token is invalid", options);
    this.name = "InvalidServiceTokenError";
  }
}
export class ServiceTokenAuthenticator {
  constructor(private readonly credentials: ServiceTokenCredentialLookup) {}

  async authenticate(value: string, requestId: string) {
    let parts: ReturnType<typeof parseServiceToken>;
    try {
      parts = parseServiceToken(value);
    } catch (error) {
      throw new InvalidServiceTokenError({ cause: error });
    }
    const raw = await this.credentials.findActiveServiceByPrefix(parts.prefix);
    if (raw === null) throw new InvalidServiceTokenError();
    let credential: AuthenticatableServiceToken;
    try {
      credential = structuredClone(raw);
    } catch (error) {
      throw new IdentityDataIntegrityError("Stored service credential is invalid", {
        cause: error,
      });
    }
    if (credential.kind !== "service_token" || credential.prefix !== parts.prefix)
      throw new IdentityDataIntegrityError(
        "Service credential lookup substituted its kind or prefix",
      );
    let verified: boolean;
    try {
      verified = await verifyServiceTokenSecret(parts.secret, credential.passwordHash);
    } catch (error) {
      throw new IdentityDataIntegrityError("Stored service secret hash is invalid", {
        cause: error,
      });
    }
    if (!verified) throw new InvalidServiceTokenError();
    const principal = PrincipalContextSchema.safeParse({
      authentication: {
        authenticatedAt: credential.authenticatedAt,
        credentialId: credential.credentialId,
        method: "service_token",
      },
      principalType: "service",
      principalId: credential.principalId,
      tenantId: credential.tenantId,
      capabilities: credential.capabilities,
      resourceScope: credential.resourceScope,
      roles: ["member"],
      requestId,
    });
    if (!principal.success)
      throw new IdentityDataIntegrityError("Stored service authorization is invalid", {
        cause: principal.error,
      });
    const { authenticatedAt: _at, ...expected } = credential;
    if ((await this.credentials.confirmActiveServiceUse(expected)) !== true)
      throw new InvalidServiceTokenError();
    return principal.data;
  }
}
