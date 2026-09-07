import { z } from "zod";
import { EvidenceScopeSchema } from "./evidence.js";
import {
  MAX_POLICY_EVALUATION_ACQUISITION_RECORDS,
  PolicyEvaluationRequestReferenceSchema,
} from "./policy-evaluation-request.js";
import {
  PolicyEvaluationSourceKeySchema,
  PolicyEvaluationSourceReferenceSchema,
  policyEvaluationSourceReferenceKey,
} from "./policy-evaluation-source-reference.js";
import { OpaqueIdSchema, Sha256Schema } from "./primitives.js";

export const POLICY_EVALUATION_MANIFEST_SCHEMA_VERSION = "0.1" as const;
export const POLICY_EVALUATION_MANIFEST_PAGE_SIZE = 128;
export const MAX_POLICY_EVALUATION_MANIFEST_ENTRIES = MAX_POLICY_EVALUATION_ACQUISITION_RECORDS;
export const MAX_POLICY_EVALUATION_MANIFEST_PAGES = Math.ceil(
  MAX_POLICY_EVALUATION_MANIFEST_ENTRIES / POLICY_EVALUATION_MANIFEST_PAGE_SIZE,
);
export const MAX_POLICY_EVALUATION_MANIFEST_RESPONSE_BYTES = 512 * 1024;
export const MAX_POLICY_EVALUATION_MANIFEST_PAGE_RESPONSE_BYTES = 512 * 1024;

/** A captured observation, not a caller assertion or a policy verdict. */
export const PolicyEvaluationSourceObservationSchema = z.discriminatedUnion("status", [
  z
    .object({
      recordSha256: Sha256Schema,
      status: z.literal("verified"),
    })
    .strict(),
  z.object({ status: z.literal("missing") }).strict(),
  z
    .object({
      reason: z.enum(["record_invalid", "reference_mismatch", "not_yet_available"]),
      status: z.literal("unavailable"),
    })
    .strict(),
]);

export const PolicyEvaluationManifestEntrySchema = z
  .object({
    observation: PolicyEvaluationSourceObservationSchema,
    source: PolicyEvaluationSourceReferenceSchema,
  })
  .strict();

const EntryCountSchema = z.number().int().min(2).max(MAX_POLICY_EVALUATION_MANIFEST_ENTRIES);
const PageIndexSchema = z
  .number()
  .int()
  .min(0)
  .max(MAX_POLICY_EVALUATION_MANIFEST_PAGES - 1);

const pageShape = {
  entries: z
    .array(PolicyEvaluationManifestEntrySchema)
    .min(1)
    .max(POLICY_EVALUATION_MANIFEST_PAGE_SIZE),
  entryCount: EntryCountSchema,
  manifestId: OpaqueIdSchema,
  pageIndex: PageIndexSchema,
  request: PolicyEvaluationRequestReferenceSchema,
};

function refinePage(value: z.infer<z.ZodObject<typeof pageShape>>, context: z.RefinementCtx): void {
  if (context.issues.length > 0) return;
  const expectedCount = Math.min(
    POLICY_EVALUATION_MANIFEST_PAGE_SIZE,
    value.entryCount - value.pageIndex * POLICY_EVALUATION_MANIFEST_PAGE_SIZE,
  );
  if (expectedCount <= 0 || value.entries.length !== expectedCount) {
    context.addIssue({
      code: "custom",
      message: "Manifest page must contain its complete fixed-size range",
      path: ["entries"],
    });
  }
  let previous = "";
  for (const [index, entry] of value.entries.entries()) {
    const key = policyEvaluationSourceReferenceKey(entry.source);
    if (key <= previous) {
      context.addIssue({
        code: "custom",
        message:
          "Manifest sources must be strictly ordered and unique by repository identity, excluding digest",
        path: ["entries", index, "source"],
      });
      break;
    }
    previous = key;
  }
}

export const PolicyEvaluationManifestPageDefinitionSchema = z
  .object(pageShape)
  .strict()
  .superRefine(refinePage);
export const PolicyEvaluationManifestPageSchema = z
  .object({
    ...pageShape,
    definitionSha256: Sha256Schema,
    schemaVersion: z.literal(POLICY_EVALUATION_MANIFEST_SCHEMA_VERSION),
    scope: EvidenceScopeSchema,
  })
  .strict()
  .superRefine(refinePage);

export const PolicyEvaluationManifestPageDescriptorSchema = z
  .object({
    definitionSha256: Sha256Schema,
    entryCount: z.number().int().min(1).max(POLICY_EVALUATION_MANIFEST_PAGE_SIZE),
    firstKey: PolicyEvaluationSourceKeySchema,
    lastKey: PolicyEvaluationSourceKeySchema,
    pageIndex: PageIndexSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (context.issues.length > 0) return;
    if (
      value.entryCount === 1 ? value.firstKey !== value.lastKey : value.firstKey >= value.lastKey
    ) {
      context.addIssue({
        code: "custom",
        message: "Manifest descriptor range must agree with its entry count",
        path: ["lastKey"],
      });
    }
  });

const manifestShape = {
  entryCount: EntryCountSchema,
  manifestId: OpaqueIdSchema,
  pages: z
    .array(PolicyEvaluationManifestPageDescriptorSchema)
    .min(1)
    .max(MAX_POLICY_EVALUATION_MANIFEST_PAGES),
  request: PolicyEvaluationRequestReferenceSchema,
};

function refineManifest(
  value: z.infer<z.ZodObject<typeof manifestShape>>,
  context: z.RefinementCtx,
): void {
  if (context.issues.length > 0) return;
  if (value.pages.length !== Math.ceil(value.entryCount / POLICY_EVALUATION_MANIFEST_PAGE_SIZE)) {
    context.addIssue({
      code: "custom",
      message: "Manifest must declare every fixed-size page",
      path: ["pages"],
    });
  }
  let previousLast = "";
  for (const [index, page] of value.pages.entries()) {
    const expectedCount = Math.min(
      POLICY_EVALUATION_MANIFEST_PAGE_SIZE,
      value.entryCount - index * POLICY_EVALUATION_MANIFEST_PAGE_SIZE,
    );
    if (
      page.pageIndex !== index ||
      page.entryCount !== expectedCount ||
      page.firstKey <= previousLast
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Manifest page indices, counts, and disjoint ordered ranges must cover the complete inventory",
        path: ["pages", index],
      });
      break;
    }
    previousLast = page.lastKey;
  }
}

export const PolicyEvaluationManifestDefinitionSchema = z
  .object(manifestShape)
  .strict()
  .superRefine(refineManifest);
export const PolicyEvaluationManifestSchema = z
  .object({
    ...manifestShape,
    definitionSha256: Sha256Schema,
    schemaVersion: z.literal(POLICY_EVALUATION_MANIFEST_SCHEMA_VERSION),
    scope: EvidenceScopeSchema,
  })
  .strict()
  .superRefine(refineManifest);

export const PolicyEvaluationManifestReferenceSchema = z
  .object({
    definitionSha256: Sha256Schema,
    manifestId: OpaqueIdSchema,
  })
  .strict();

/** Structural binding only: authoritative consumers must also recompute every canonical digest. */
export const PolicyEvaluationManifestPageSetSchema = z
  .object({
    manifest: PolicyEvaluationManifestSchema,
    pages: z
      .array(PolicyEvaluationManifestPageSchema)
      .min(1)
      .max(MAX_POLICY_EVALUATION_MANIFEST_PAGES),
  })
  .strict()
  .superRefine((value, context) => {
    if (context.issues.length > 0) return;
    const { manifest, pages } = value;
    if (pages.length !== manifest.pages.length) {
      context.addIssue({
        code: "custom",
        message: "Manifest page set must be complete",
        path: ["pages"],
      });
      return;
    }
    for (const [index, page] of pages.entries()) {
      const descriptor = manifest.pages[index];
      const first = page.entries[0];
      const last = page.entries.at(-1);
      if (
        !descriptor ||
        !first ||
        !last ||
        page.manifestId !== manifest.manifestId ||
        page.pageIndex !== index ||
        page.entryCount !== manifest.entryCount ||
        page.entries.length !== descriptor.entryCount ||
        page.definitionSha256 !== descriptor.definitionSha256 ||
        page.request.evaluationRequestId !== manifest.request.evaluationRequestId ||
        page.request.definitionSha256 !== manifest.request.definitionSha256 ||
        page.scope.tenantId !== manifest.scope.tenantId ||
        page.scope.projectId !== manifest.scope.projectId ||
        page.scope.environmentId !== manifest.scope.environmentId ||
        policyEvaluationSourceReferenceKey(first.source) !== descriptor.firstKey ||
        policyEvaluationSourceReferenceKey(last.source) !== descriptor.lastKey
      ) {
        context.addIssue({
          code: "custom",
          message: "Page does not match its exact scoped manifest descriptor and request",
          path: ["pages", index],
        });
      }
    }
  });

/** Expected closure is derived from authoritative records by capture, never submitted publicly. */
export const PolicyEvaluationExpectedSourcesSchema = z
  .array(PolicyEvaluationSourceReferenceSchema)
  .min(2)
  .max(MAX_POLICY_EVALUATION_MANIFEST_ENTRIES)
  .superRefine((values, context) => {
    if (context.issues.length > 0) return;
    let previous = "";
    for (const [index, value] of values.entries()) {
      const key = policyEvaluationSourceReferenceKey(value);
      if (key <= previous) {
        context.addIssue({
          code: "custom",
          message:
            "Expected source closure must be strictly ordered and unique by repository identity",
          path: [index],
        });
        break;
      }
      previous = key;
    }
  });

export type PolicyEvaluationManifestEntry = z.infer<typeof PolicyEvaluationManifestEntrySchema>;
export type PolicyEvaluationManifestPageDefinition = z.infer<
  typeof PolicyEvaluationManifestPageDefinitionSchema
>;
export type PolicyEvaluationManifestPage = z.infer<typeof PolicyEvaluationManifestPageSchema>;
export type PolicyEvaluationManifestDefinition = z.infer<
  typeof PolicyEvaluationManifestDefinitionSchema
>;
export type PolicyEvaluationManifest = z.infer<typeof PolicyEvaluationManifestSchema>;
export type PolicyEvaluationManifestReference = z.infer<
  typeof PolicyEvaluationManifestReferenceSchema
>;
export type PolicyEvaluationManifestPageSet = z.infer<typeof PolicyEvaluationManifestPageSetSchema>;

export const PolicyEvaluationManifestAssemblySchema = z
  .object({
    entries: z
      .array(PolicyEvaluationManifestEntrySchema)
      .min(2)
      .max(MAX_POLICY_EVALUATION_MANIFEST_ENTRIES),
    manifestId: OpaqueIdSchema,
    request: PolicyEvaluationRequestReferenceSchema,
    scope: EvidenceScopeSchema,
  })
  .strict();

export const PolicyEvaluationManifestVerificationSchema = z
  .object({
    expected: z
      .object({
        manifest: PolicyEvaluationManifestReferenceSchema,
        request: PolicyEvaluationRequestReferenceSchema,
        scope: EvidenceScopeSchema,
        sources: PolicyEvaluationExpectedSourcesSchema,
      })
      .strict(),
    pageSet: PolicyEvaluationManifestPageSetSchema,
  })
  .strict();

export type PolicyEvaluationManifestAssembly = z.infer<
  typeof PolicyEvaluationManifestAssemblySchema
>;
export type PolicyEvaluationManifestVerification = z.infer<
  typeof PolicyEvaluationManifestVerificationSchema
>;
