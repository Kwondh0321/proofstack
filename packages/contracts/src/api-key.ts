import { z } from "zod";
import { RequestIdSchema } from "./api.js";
import {
  ResourceScopeSchema,
  WORKLOAD_DELEGABLE_CAPABILITIES,
  WorkloadCapabilitySchema,
} from "./identity.js";
import { OpaqueIdSchema, TimestampSchema } from "./primitives.js";

export const MAX_API_KEY_NAME_LENGTH = 128;
export const MAX_API_KEY_REVOCATION_REASON_LENGTH = 512;

const printableText = (maximumLength: number, label: string) =>
  z
    .string()
    .min(1)
    .refine(
      (value) => Array.from(value).length <= maximumLength,
      `${label} must contain at most ${maximumLength} characters`,
    )
    .refine((value) => value.trim() === value, `${label} must not have surrounding whitespace`)
    .refine(
      (value) =>
        !Array.from(value).some((character) => {
          const codePoint = character.codePointAt(0);
          return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
        }),
      `${label} must not contain control characters`,
    );

export const ApiKeyNameSchema = printableText(MAX_API_KEY_NAME_LENGTH, "API key name");
export const ApiKeyRevocationReasonSchema = printableText(
  MAX_API_KEY_REVOCATION_REASON_LENGTH,
  "API key revocation reason",
);
export const ApiKeyPrefixSchema = z.string().regex(/^[A-Za-z0-9_-]{12}$/);
export const ApiKeyValueSchema = z
  .string()
  .regex(/^psk_v1_[A-Za-z0-9_-]{12}_[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/);
export const ApiKeyCapabilitiesSchema = z
  .array(WorkloadCapabilitySchema)
  .min(1)
  .max(WORKLOAD_DELEGABLE_CAPABILITIES.length)
  .refine((values) => new Set(values).size === values.length, {
    message: "API key capabilities must not contain duplicates",
  });

export const ApiKeyCredentialSchema = z
  .object({
    capabilities: ApiKeyCapabilitiesSchema,
    createdAt: TimestampSchema,
    credentialId: OpaqueIdSchema,
    expiresAt: TimestampSchema,
    name: ApiKeyNameSchema,
    prefix: ApiKeyPrefixSchema,
    principalId: OpaqueIdSchema,
    resourceScope: ResourceScopeSchema,
    revokedAt: TimestampSchema.nullable(),
    rotatedFromCredentialId: OpaqueIdSchema.nullable(),
    tenantId: OpaqueIdSchema,
  })
  .strict();

export const IssueApiKeyRequestSchema = z
  .object({
    capabilities: ApiKeyCapabilitiesSchema,
    expiresAt: TimestampSchema.optional(),
    name: ApiKeyNameSchema,
    resourceScope: ResourceScopeSchema,
  })
  .strict();

export const RotateApiKeyRequestSchema = z
  .object({
    expiresAt: TimestampSchema.optional(),
  })
  .strict();

export const RevokeApiKeyRequestSchema = z
  .object({
    reason: ApiKeyRevocationReasonSchema,
  })
  .strict();

const issuedApiKeyResponseSchema = z
  .object({
    credential: ApiKeyCredentialSchema,
    requestId: RequestIdSchema,
    value: ApiKeyValueSchema,
  })
  .strict()
  .superRefine((response, context) => {
    const presentedPrefix = response.value.split("_")[2];
    if (presentedPrefix !== response.credential.prefix) {
      context.addIssue({
        code: "custom",
        message: "API key value does not match the credential prefix",
        path: ["value"],
      });
    }
  });

export const IssueApiKeyResponseSchema = issuedApiKeyResponseSchema;
export const RotateApiKeyResponseSchema = issuedApiKeyResponseSchema;

export const RevokeApiKeyResponseSchema = z
  .object({
    credentialId: OpaqueIdSchema,
    requestId: RequestIdSchema,
    revoked: z.boolean(),
  })
  .strict();

export type ApiKeyCredential = z.infer<typeof ApiKeyCredentialSchema>;
export type IssueApiKeyRequest = z.infer<typeof IssueApiKeyRequestSchema>;
export type IssueApiKeyResponse = z.infer<typeof IssueApiKeyResponseSchema>;
export type RevokeApiKeyRequest = z.infer<typeof RevokeApiKeyRequestSchema>;
export type RevokeApiKeyResponse = z.infer<typeof RevokeApiKeyResponseSchema>;
export type RotateApiKeyRequest = z.infer<typeof RotateApiKeyRequestSchema>;
export type RotateApiKeyResponse = z.infer<typeof RotateApiKeyResponseSchema>;
