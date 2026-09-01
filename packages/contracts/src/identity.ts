import { z } from "zod";
import { OpaqueIdSchema, TimestampSchema } from "./primitives.js";

export const PrincipalTypeSchema = z.enum(["user", "workload", "service"]);

export const AuthenticationMethodSchema = z.enum([
  "development",
  "api_key",
  "oidc",
  "service_token",
]);

export const RoleSchema = z.enum(["owner", "admin", "member", "viewer", "ingest"]);

export const CapabilitySchema = z.enum([
  "project:read",
  "project:manage",
  "evidence:ingest",
  "evidence:read",
  "artifact:write",
  "artifact:read",
  "artifact:read:restricted",
  "artifact:delete",
  "dataset:read",
  "dataset:manage",
  "replay:read",
  "replay:run",
  "replay:cancel",
  "replay:manage",
  "evaluation:read",
  "evaluation:run",
  "evaluation:model:run",
  "evaluation:human:review",
  "evaluation:manage",
  "release:read",
  "release:manage",
  "policy:evaluate",
  "policy:manage",
  "approval:decide",
  "audit:read",
  "identity:read",
  "identity:manage",
]);

export const WORKLOAD_DELEGABLE_CAPABILITIES = [
  "project:read",
  "evidence:ingest",
  "evidence:read",
  "artifact:write",
  "artifact:read",
  "dataset:read",
  "replay:read",
  "replay:run",
  "replay:cancel",
  "evaluation:read",
  "evaluation:run",
  "evaluation:model:run",
  "release:read",
  "policy:evaluate",
] as const satisfies readonly z.infer<typeof CapabilitySchema>[];

export const WorkloadCapabilitySchema = z.enum(WORKLOAD_DELEGABLE_CAPABILITIES);

const uniqueOpaqueIds = (values: readonly string[]): boolean =>
  new Set(values).size === values.length;

export const ProjectResourceScopeSchema = z
  .object({
    environmentIds: z
      .array(OpaqueIdSchema)
      .min(1)
      .max(100)
      .refine(uniqueOpaqueIds, {
        message: "environmentIds must not contain duplicates",
      })
      .optional(),
    projectId: OpaqueIdSchema,
  })
  .strict();

export const ResourceScopeSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("tenant") }).strict(),
  z
    .object({
      mode: z.literal("restricted"),
      projects: z.array(ProjectResourceScopeSchema).min(1).max(100),
    })
    .strict()
    .superRefine((value, context) => {
      const projectIds = value.projects.map((project) => project.projectId);
      if (!uniqueOpaqueIds(projectIds)) {
        context.addIssue({
          code: "custom",
          message: "projects must not contain duplicate projectIds",
          path: ["projects"],
        });
      }
    }),
]);

export const AuthenticationContextSchema = z
  .object({
    authenticatedAt: TimestampSchema,
    credentialId: OpaqueIdSchema.optional(),
    method: AuthenticationMethodSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.method !== "development" && !value.credentialId) {
      context.addIssue({
        code: "custom",
        message: "credentialId is required outside development mode",
        path: ["credentialId"],
      });
    }
  });

export const PrincipalContextSchema = z
  .object({
    authentication: AuthenticationContextSchema,
    capabilities: z.array(CapabilitySchema).max(CapabilitySchema.options.length),
    principalId: OpaqueIdSchema,
    principalType: PrincipalTypeSchema,
    requestId: z.string().min(8).max(128),
    resourceScope: ResourceScopeSchema,
    roles: z.array(RoleSchema).min(1).max(RoleSchema.options.length),
    tenantId: OpaqueIdSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.capabilities).size !== value.capabilities.length) {
      context.addIssue({
        code: "custom",
        message: "capabilities must not contain duplicates",
        path: ["capabilities"],
      });
    }

    if (new Set(value.roles).size !== value.roles.length) {
      context.addIssue({
        code: "custom",
        message: "roles must not contain duplicates",
        path: ["roles"],
      });
    }
  });

export type AuthenticationContext = z.infer<typeof AuthenticationContextSchema>;
export type AuthenticationMethod = z.infer<typeof AuthenticationMethodSchema>;
export type Capability = z.infer<typeof CapabilitySchema>;
export type PrincipalContext = z.infer<typeof PrincipalContextSchema>;
export type PrincipalType = z.infer<typeof PrincipalTypeSchema>;
export type ProjectResourceScope = z.infer<typeof ProjectResourceScopeSchema>;
export type ResourceScope = z.infer<typeof ResourceScopeSchema>;
export type Role = z.infer<typeof RoleSchema>;
export type WorkloadCapability = z.infer<typeof WorkloadCapabilitySchema>;
