import { z } from "zod";
import { encodeEvaluationCanonicalJson } from "./evaluation-definition-encoding.js";
import { EvidenceScopeSchema } from "./evidence.js";
import {
  PolicyEvaluationCancellationSchema,
  PolicyEvaluationUsageSchema,
} from "./policy-evaluation-attempt.js";
import {
  PolicyEvaluationJobReferenceSchema,
  PolicyEvaluationJobStatusSchema,
} from "./policy-evaluation-job.js";
import { PolicyEvaluationWorkerMutationFenceSchema } from "./policy-evaluation-job-fence.js";
import { PolicyEvaluationRetryableErrorSchema } from "./policy-evaluation-request.js";
import { PolicyEvaluationSnapshotReferenceSchema } from "./policy-evaluation-snapshot.js";
import {
  PolicyEvaluationTimeSchema,
  policyEvaluationTimestampOrderKey,
} from "./policy-evaluation-time.js";
import { OpaqueIdSchema, Sha256Schema } from "./primitives.js";

export const POLICY_EVALUATION_JOB_HISTORY_SCHEMA_VERSION = "0.1" as const;
export const POLICY_EVALUATION_JOB_HISTORY_DOMAIN =
  "proofstack.policy-evaluation-job-history.v1" as const;
export const MAX_POLICY_EVALUATION_JOB_HISTORY_ENTRIES = 100_000;
export const POLICY_EVALUATION_JOB_HISTORY_PAGE_SIZE = 100;
export const MAX_POLICY_EVALUATION_JOB_HISTORY_ENTRY_BYTES = 4096;
export const MAX_POLICY_EVALUATION_JOB_HISTORY_PAGE_BYTES = 512 * 1024;
const Sequence = z
  .number()
  .int()
  .nonnegative()
  .max(MAX_POLICY_EVALUATION_JOB_HISTORY_ENTRIES - 1);
const Operation = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("seal"),
      fence: PolicyEvaluationWorkerMutationFenceSchema,
      snapshot: PolicyEvaluationSnapshotReferenceSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("start_computation"),
      fence: PolicyEvaluationWorkerMutationFenceSchema,
    })
    .strict(),
  z.object({ kind: z.literal("created") }).strict(),
  z.object({ kind: z.literal("claim"), fence: PolicyEvaluationWorkerMutationFenceSchema }).strict(),
  z
    .object({ kind: z.literal("heartbeat"), fence: PolicyEvaluationWorkerMutationFenceSchema })
    .strict(),
  z
    .object({
      kind: z.literal("reserve"),
      fence: PolicyEvaluationWorkerMutationFenceSchema,
      reservationId: OpaqueIdSchema,
      delta: PolicyEvaluationUsageSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("interrupt"),
      fence: PolicyEvaluationWorkerMutationFenceSchema,
      reason: PolicyEvaluationRetryableErrorSchema,
    })
    .strict(),
  z.object({ kind: z.literal("reclaim") }).strict(),
  z.object({ kind: z.literal("history_limit") }).strict(),
  z
    .object({ kind: z.literal("recovery"), recoveryEpoch: z.number().int().positive().safe() })
    .strict(),
  z.object({ kind: z.literal("cancel"), intent: PolicyEvaluationCancellationSchema }).strict(),
]);
export const PolicyEvaluationJobHistoryEntryDefinitionSchema = z
  .object({
    scope: EvidenceScopeSchema,
    job: PolicyEvaluationJobReferenceSchema,
    sequence: Sequence,
    predecessorEntrySha256: Sha256Schema.nullable(),
    previousGraphSha256: Sha256Schema.nullable(),
    graphSha256: Sha256Schema,
    stateVersion: z.number().int().positive().max(MAX_POLICY_EVALUATION_JOB_HISTORY_ENTRIES),
    committedAt: PolicyEvaluationTimeSchema,
    previousStatus: PolicyEvaluationJobStatusSchema.nullable(),
    status: PolicyEvaluationJobStatusSchema,
    operation: Operation,
  })
  .strict()
  .superRefine((value, context) => {
    const issue = (message: string) => context.addIssue({ code: "custom", message });
    if (value.stateVersion !== value.sequence + 1)
      issue("History has one contiguous entry for each committed state version");
    const initial = value.sequence === 0;
    if (
      initial !== (value.operation.kind === "created") ||
      initial !== (value.predecessorEntrySha256 === null) ||
      initial !== (value.previousGraphSha256 === null) ||
      initial !== (value.previousStatus === null)
    )
      issue(
        "Creation has no predecessor; every subsequent entry retains exact predecessor hashes/status",
      );
    if (initial && value.status !== "queued")
      issue("History creation must retain original queued state");
    const operation = value.operation;
    if ("fence" in operation && operation.fence.jobId !== value.job.jobId)
      issue("History fence must retain its exact job identity");
    if (
      operation.kind === "reserve" &&
      Object.values(operation.delta).every((amount) => amount === 0)
    )
      issue("History reservation cannot erase all work");
    if (
      operation.kind === "cancel" &&
      (operation.intent.jobId !== value.job.jobId ||
        operation.intent.scope.tenantId !== value.scope.tenantId ||
        operation.intent.scope.projectId !== value.scope.projectId ||
        operation.intent.scope.environmentId !== value.scope.environmentId ||
        operation.intent.requestedAt !== value.committedAt)
    )
      issue("Cancellation history must retain original exact-scope intent and receipt");
  });
export const PolicyEvaluationJobHistoryEntrySchema = z
  .object({
    schemaVersion: z.literal(POLICY_EVALUATION_JOB_HISTORY_SCHEMA_VERSION),
    definition: PolicyEvaluationJobHistoryEntryDefinitionSchema,
    entrySha256: Sha256Schema,
  })
  .strict();
export const PolicyEvaluationJobHistoryHeadSchema = z
  .object({
    scope: EvidenceScopeSchema,
    job: PolicyEvaluationJobReferenceSchema,
    sequence: Sequence,
    entrySha256: Sha256Schema,
    graphSha256: Sha256Schema,
  })
  .strict();
export const PolicyEvaluationJobHistoryPageIndexSchema = z
  .number()
  .int()
  .nonnegative()
  .max(
    Math.ceil(MAX_POLICY_EVALUATION_JOB_HISTORY_ENTRIES / POLICY_EVALUATION_JOB_HISTORY_PAGE_SIZE) -
      1,
  );
const JobHistoryPageObjectSchema = z
  .object({
    head: PolicyEvaluationJobHistoryHeadSchema,
    pageIndex: PolicyEvaluationJobHistoryPageIndexSchema,
    entries: z
      .array(PolicyEvaluationJobHistoryEntrySchema)
      .min(1)
      .max(POLICY_EVALUATION_JOB_HISTORY_PAGE_SIZE),
  })
  .strict()
  .superRefine((value, context) => {
    const first = value.pageIndex * POLICY_EVALUATION_JOB_HISTORY_PAGE_SIZE;
    const count = Math.min(
      POLICY_EVALUATION_JOB_HISTORY_PAGE_SIZE,
      value.head.sequence + 1 - first,
    );
    if (count <= 0 || value.entries.length !== count)
      context.addIssue({
        code: "custom",
        message: "History preserves complete fixed page boundaries",
      });
    for (const [index, entry] of value.entries.entries()) {
      const definition = entry.definition;
      if (
        definition.sequence !== first + index ||
        definition.job.jobId !== value.head.job.jobId ||
        definition.job.definitionSha256 !== value.head.job.definitionSha256 ||
        definition.scope.tenantId !== value.head.scope.tenantId ||
        definition.scope.projectId !== value.head.scope.projectId ||
        definition.scope.environmentId !== value.head.scope.environmentId
      )
        context.addIssue({
          code: "custom",
          message: "History page cannot omit, reorder or substitute exact scoped entries",
        });
      const previous = value.entries[index - 1];
      if (
        previous &&
        (definition.predecessorEntrySha256 !== previous.entrySha256 ||
          definition.previousGraphSha256 !== previous.definition.graphSha256 ||
          definition.previousStatus !== previous.definition.status ||
          policyEvaluationTimestampOrderKey(definition.committedAt) <
            policyEvaluationTimestampOrderKey(previous.definition.committedAt))
      )
        context.addIssue({
          code: "custom",
          message: "History page requires complete predecessor continuity",
        });
    }
    const last = value.entries.at(-1);
    if (
      last?.definition.sequence === value.head.sequence &&
      (last.entrySha256 !== value.head.entrySha256 ||
        last.definition.graphSha256 !== value.head.graphSha256)
    )
      context.addIssue({
        code: "custom",
        message: "Final history page must reach its exact retained head",
      });
  });
export const PolicyEvaluationJobHistoryPageSchema = z.preprocess((raw, context) => {
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    const entries: unknown = Reflect.get(raw, "entries");
    if (Array.isArray(entries) && entries.length > POLICY_EVALUATION_JOB_HISTORY_PAGE_SIZE) {
      context.addIssue({
        code: "custom",
        message: "History page exceeds its fixed admission count",
        path: ["entries"],
      });
      return z.NEVER;
    }
  }
  return raw;
}, JobHistoryPageObjectSchema);
export type PolicyEvaluationJobHistoryEntryDefinition = z.infer<
  typeof PolicyEvaluationJobHistoryEntryDefinitionSchema
>;
export type PolicyEvaluationJobHistoryEntry = z.infer<typeof PolicyEvaluationJobHistoryEntrySchema>;
export type PolicyEvaluationJobHistoryHead = z.infer<typeof PolicyEvaluationJobHistoryHeadSchema>;
export type PolicyEvaluationJobHistoryPage = z.infer<typeof PolicyEvaluationJobHistoryPageSchema>;
export function encodePolicyEvaluationJobHistoryEntry(
  input: PolicyEvaluationJobHistoryEntryDefinition,
): Uint8Array {
  return encodeEvaluationCanonicalJson({
    definition: PolicyEvaluationJobHistoryEntryDefinitionSchema.parse(input),
    definitionDomain: POLICY_EVALUATION_JOB_HISTORY_DOMAIN,
    encodingVersion: "proofstack.policy-evaluation-job-history-jcs.v1",
    schemaVersion: POLICY_EVALUATION_JOB_HISTORY_SCHEMA_VERSION,
  });
}
