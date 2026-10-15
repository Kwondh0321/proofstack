import { z } from "zod";
import {
  POLICY_EVALUATION_TIME_UNITS_PER_MILLISECOND,
  PolicyEvaluationTimeSchema,
  policyEvaluationTimestampOrderKey,
} from "./policy-evaluation-time.js";
import { OpaqueIdSchema, Sha256Schema } from "./primitives.js";

export const RELEASE_DECISION_CREDENTIAL_STATE_SCHEMA_VERSION = "0.1" as const;
const Common = {
  schemaVersion: z.literal(RELEASE_DECISION_CREDENTIAL_STATE_SCHEMA_VERSION),
  credentialId: OpaqueIdSchema,
  principalId: OpaqueIdSchema,
  tenantId: OpaqueIdSchema,
  createdAt: PolicyEvaluationTimeSchema,
  revokedAt: PolicyEvaluationTimeSchema.nullable(),
};

/** Secret-free native session projection. It cannot authenticate a cookie or pass CSRF checks. */
export const ReleaseDecisionSessionStateSchema = z
  .object({
    ...Common,
    kind: z.literal("oidc_session"),
    bindingId: OpaqueIdSchema,
    absoluteExpiresAt: PolicyEvaluationTimeSchema,
    idleExpiresAt: PolicyEvaluationTimeSchema,
    idleLifetimeSeconds: z.number().int().min(60).max(86_400),
    lastUsedAt: PolicyEvaluationTimeSchema.nullable(),
    useCount: z.number().int().nonnegative().max(2_147_483_647),
    revocationReason: z.enum(["logout", "binding_disabled", "administrative"]).nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (context.issues.length > 0) return;
    const order = policyEvaluationTimestampOrderKey;
    const issue = (message: string) => context.addIssue({ code: "custom", message });
    const second = 1_000n * POLICY_EVALUATION_TIME_UNITS_PER_MILLISECOND;
    const created = order(value.createdAt);
    const absolute = order(value.absoluteExpiresAt);
    const last = value.lastUsedAt === null ? created : order(value.lastUsedAt);
    if (absolute - created < 60n * second || absolute - created > 86_400n * second)
      issue("Session absolute expiry must retain the owning native 60-second/24-hour interval");
    if ((value.useCount === 0) !== (value.lastUsedAt === null) || last < created)
      issue("Session use count and last-use receipt must retain the owning native shape");
    const idle = last + BigInt(value.idleLifetimeSeconds) * second;
    if (order(value.idleExpiresAt) !== (idle < absolute ? idle : absolute))
      issue("Session idle expiry must retain its exact native last-use/absolute minimum");
    if (
      (value.revokedAt === null) !== (value.revocationReason === null) ||
      (value.revokedAt !== null && order(value.revokedAt) < created)
    )
      issue("Session revocation requires its original reason and native receipt order");
  });

/** A bounded private-publisher credential projection; no token, prefix, salt or secret verifier. */
export const ReleaseDecisionServiceCredentialStateSchema = z
  .object({
    ...Common,
    kind: z.literal("service_credential"),
    expiresAt: PolicyEvaluationTimeSchema,
    revocationReason: z.enum(["administrative", "rotation"]).nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (context.issues.length > 0) return;
    const order = policyEvaluationTimestampOrderKey;
    if (order(value.expiresAt) <= order(value.createdAt))
      context.addIssue({
        code: "custom",
        message: "Service credentials require a positive native validity interval",
      });
    if (
      (value.revokedAt === null) !== (value.revocationReason === null) ||
      (value.revokedAt !== null && order(value.revokedAt) < order(value.createdAt))
    )
      context.addIssue({
        code: "custom",
        message: "Credential revocation requires its original reason and native receipt order",
      });
  });
export const ReleaseDecisionCredentialStateSchema = z.discriminatedUnion("kind", [
  ReleaseDecisionSessionStateSchema,
  ReleaseDecisionServiceCredentialStateSchema,
]);
export const ReleaseDecisionCredentialReferenceSchema = z
  .object({
    kind: z.enum(["oidc_session", "service_credential"]),
    principalId: OpaqueIdSchema,
    credentialId: OpaqueIdSchema,
  })
  .strict();

export const ReleaseDecisionCredentialObservationSchema = z
  .discriminatedUnion("state", [
    z
      .object({
        state: z.literal("observed"),
        reference: ReleaseDecisionCredentialReferenceSchema,
        record: ReleaseDecisionCredentialStateSchema,
      })
      .strict(),
    z
      .object({
        state: z.enum(["missing", "unavailable"]),
        reference: ReleaseDecisionCredentialReferenceSchema,
      })
      .strict(),
    z
      .object({
        state: z.literal("invalid"),
        reference: ReleaseDecisionCredentialReferenceSchema,
        observedRecordSha256: Sha256Schema,
      })
      .strict(),
  ])
  .superRefine((value, context) => {
    if (context.issues.length > 0 || value.state !== "observed") return;
    if (
      value.reference.kind !== value.record.kind ||
      value.reference.principalId !== value.record.principalId ||
      value.reference.credentialId !== value.record.credentialId
    )
      context.addIssue({
        code: "custom",
        message:
          "Credential observation must bind its exact original owner and authentication kind",
      });
  });

export type ReleaseDecisionSessionState = z.infer<typeof ReleaseDecisionSessionStateSchema>;
export type ReleaseDecisionServiceCredentialState = z.infer<
  typeof ReleaseDecisionServiceCredentialStateSchema
>;
export type ReleaseDecisionCredentialState = z.infer<typeof ReleaseDecisionCredentialStateSchema>;
export type ReleaseDecisionCredentialReference = z.infer<
  typeof ReleaseDecisionCredentialReferenceSchema
>;
export type ReleaseDecisionCredentialObservation = z.infer<
  typeof ReleaseDecisionCredentialObservationSchema
>;
