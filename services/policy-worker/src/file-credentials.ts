import { z } from "zod";
import {
  OpaqueIdSchema,
  ResourceScopeSchema,
  UtcMillisecondTimestampSchema,
  serializeEvaluationCanonicalJson,
} from "@proofstack/contracts";
import { SystemClock, type Clock } from "@proofstack/core";
import type {
  AuthenticatableServiceToken,
  ServiceTokenCredentialLookup,
  ServiceTokenUseConfirmation,
} from "@proofstack/identity";
import { readPolicyWorkerJsonFile } from "./private-json-file.js";

export const MAX_POLICY_WORKER_CREDENTIAL_FILE_BYTES = 64 * 1024;
export const MAX_POLICY_WORKER_CREDENTIALS = 64;
function canonicalBytes(size: number, encodedLength: number) {
  return z
    .string()
    .length(encodedLength)
    .regex(/^[A-Za-z0-9_-]+$/)
    .refine((value) => {
      const decoded = Buffer.from(value, "base64url");
      return decoded.length === size && decoded.toString("base64url") === value;
    }, "Credential encoding must be canonical");
}
const Prefix = canonicalBytes(16, 22);
const Hash = z
  .object({
    algorithm: z.literal("scrypt-v1"),
    blockSize: z.literal(8),
    cost: z.literal(32768),
    parallelization: z.literal(1),
    keyLength: z.literal(32),
    salt: canonicalBytes(16, 22),
    digest: canonicalBytes(32, 43),
  })
  .strict();
const Credential = z
  .object({
    kind: z.literal("service_token"),
    credentialId: OpaqueIdSchema,
    prefix: Prefix,
    passwordHash: Hash,
    principalId: OpaqueIdSchema,
    tenantId: OpaqueIdSchema,
    capabilities: z
      .array(z.enum(["policy:evaluation:execute", "artifact:read"]))
      .length(2)
      .refine(
        (values) => new Set(values).size === 2,
        "Explicit execution and artifact-read grants are required",
      ),
    resourceScope: ResourceScopeSchema.refine(
      (scope) =>
        scope.mode === "restricted" &&
        scope.projects.every((project) => project.environmentIds !== undefined),
      "Reference worker credentials require explicit projects and environments",
    ),
    status: z.enum(["active", "revoked"]),
    notBefore: UtcMillisecondTimestampSchema,
    expiresAt: UtcMillisecondTimestampSchema,
  })
  .strict()
  .refine(
    (record) => Date.parse(record.notBefore) < Date.parse(record.expiresAt),
    "Credential validity must be positive",
  );
const Catalogue = z
  .object({
    schemaVersion: z.literal("0.1"),
    revision: OpaqueIdSchema,
    credentials: z.array(Credential).max(MAX_POLICY_WORKER_CREDENTIALS),
  })
  .strict()
  .superRefine((catalogue, context) => {
    for (const key of ["prefix", "credentialId"] as const) {
      if (
        new Set(catalogue.credentials.map((record) => record[key])).size !==
        catalogue.credentials.length
      )
        context.addIssue({ code: "custom", message: `Duplicate credential ${key}` });
    }
  });
type CredentialRecord = z.infer<typeof Credential>;
export class PolicyWorkerCredentialCatalogueError extends Error {
  constructor(options?: ErrorOptions) {
    super("Policy worker credential catalogue is invalid", options);
    this.name = "PolicyWorkerCredentialCatalogueError";
  }
}
function authority(record: CredentialRecord): ServiceTokenUseConfirmation & {
  readonly notBefore: string;
  readonly expiresAt: string;
} {
  return {
    kind: record.kind,
    credentialId: record.credentialId,
    prefix: record.prefix,
    passwordHash: record.passwordHash,
    principalId: record.principalId,
    tenantId: record.tenantId,
    capabilities: record.capabilities,
    resourceScope: record.resourceScope,
    // The authenticator retains extra immutable fields in its post-verification confirmation.
    notBefore: record.notBefore,
    expiresAt: record.expiresAt,
  };
}

/** Operator-owned reference provider. Revocation blocks authentication, not an existing DB lease. */
export class FilePolicyWorkerCredentials implements ServiceTokenCredentialLookup {
  constructor(
    private readonly filename: string,
    private readonly clock: Clock = new SystemClock(),
  ) {}
  private async active(prefix: string) {
    try {
      Prefix.parse(prefix);
      const catalogue = Catalogue.parse(
        await readPolicyWorkerJsonFile(this.filename, MAX_POLICY_WORKER_CREDENTIAL_FILE_BYTES),
      );
      const observedAt = UtcMillisecondTimestampSchema.parse(this.clock.now().toISOString());
      const now = Date.parse(observedAt);
      const record = catalogue.credentials.find((candidate) => candidate.prefix === prefix);
      if (
        !record ||
        record.status !== "active" ||
        now < Date.parse(record.notBefore) ||
        now >= Date.parse(record.expiresAt)
      )
        return null;
      return { record, observedAt };
    } catch (error) {
      throw new PolicyWorkerCredentialCatalogueError({ cause: error });
    }
  }
  async findActiveServiceByPrefix(prefix: string): Promise<AuthenticatableServiceToken | null> {
    const active = await this.active(prefix);
    return active === null
      ? null
      : { ...authority(active.record), authenticatedAt: active.observedAt };
  }
  async confirmActiveServiceUse(expected: ServiceTokenUseConfirmation): Promise<boolean> {
    const active = await this.active(expected.prefix);
    return (
      active !== null &&
      serializeEvaluationCanonicalJson(authority(active.record)) ===
        serializeEvaluationCanonicalJson(expected)
    );
  }
}
