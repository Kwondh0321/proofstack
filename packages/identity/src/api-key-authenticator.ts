import {
  PrincipalContextSchema,
  type ResourceScope,
  type WorkloadCapability,
} from "@proofstack/contracts";
import { type ApiKeyPasswordHash, parseApiKey, verifyApiKeySecret } from "./api-key.js";

export interface AuthenticatableApiKey {
  readonly authenticatedAt: string;
  readonly capabilities: readonly WorkloadCapability[];
  readonly credentialId: string;
  readonly passwordHash: ApiKeyPasswordHash;
  readonly prefix: string;
  readonly principalId: string;
  readonly resourceScope: ResourceScope;
  readonly tenantId: string;
}

export interface ApiKeyCredentialLookup {
  findActiveByPrefix(prefix: string): Promise<AuthenticatableApiKey | null>;
}

export class InvalidApiKeyError extends Error {
  constructor(options?: ErrorOptions) {
    super("API key is invalid", options);
    this.name = "InvalidApiKeyError";
  }
}

export class IdentityDataIntegrityError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "IdentityDataIntegrityError";
  }
}

export class ApiKeyAuthenticator {
  constructor(private readonly credentials: ApiKeyCredentialLookup) {}

  async authenticate(value: string, requestId: string) {
    let parts: ReturnType<typeof parseApiKey>;
    try {
      parts = parseApiKey(value);
    } catch (error) {
      throw new InvalidApiKeyError({ cause: error });
    }

    const credential = await this.credentials.findActiveByPrefix(parts.prefix);
    if (!credential) throw new InvalidApiKeyError();
    if (credential.prefix !== parts.prefix) {
      throw new IdentityDataIntegrityError("API key lookup returned a mismatched prefix");
    }

    let verified: boolean;
    try {
      verified = await verifyApiKeySecret(parts.secret, credential.passwordHash);
    } catch (error) {
      throw new IdentityDataIntegrityError("Stored API key hash is invalid", { cause: error });
    }
    if (!verified) throw new InvalidApiKeyError();

    const principal = PrincipalContextSchema.safeParse({
      authentication: {
        authenticatedAt: credential.authenticatedAt,
        credentialId: credential.credentialId,
        method: "api_key",
      },
      capabilities: credential.capabilities,
      principalId: credential.principalId,
      principalType: "workload",
      requestId,
      resourceScope: credential.resourceScope,
      roles: ["ingest"],
      tenantId: credential.tenantId,
    });
    if (!principal.success) {
      throw new IdentityDataIntegrityError("Stored API key authorization is invalid", {
        cause: principal.error,
      });
    }
    return principal.data;
  }
}
