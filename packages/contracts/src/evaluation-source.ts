import { z } from "zod";
import { ArtifactContentReferenceSchema } from "./artifact.js";
import { EvidenceScopeSchema, evidenceTimestampOrderKey } from "./evidence.js";
import {
  JsonValueSchema,
  OpaqueIdSchema,
  PostgresTimestampSchema,
  Sha256Schema,
  UtcMillisecondTimestampSchema,
} from "./primitives.js";

export const DISCOVERY_RECORD_SCHEMA_VERSION = "0.1" as const;
export const SOURCE_SNAPSHOT_SCHEMA_VERSION = "0.1" as const;
export const SOURCE_REVIEW_SCHEMA_VERSION = "0.1" as const;
export const MAX_DISCOVERY_CANDIDATES = 100;
export const MAX_SOURCE_CONFLICTS = 64;
export const MAX_SOURCE_REVIEW_BASIS_ARTIFACTS = 16;
export const MAX_SOURCE_SCOPE_VALUES = 64;

function unicodeScalarLength(value: string): number | undefined {
  let length = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined || (codePoint >= 0xd800 && codePoint <= 0xdfff)) return undefined;
    length += 1;
  }
  return length;
}

function containsUnsafeDisplayControl(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) return true;
    return (
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      codePoint === 0x061c ||
      codePoint === 0x200e ||
      codePoint === 0x200f ||
      (codePoint >= 0x2028 && codePoint <= 0x202e) ||
      (codePoint >= 0x2066 && codePoint <= 0x2069)
    );
  });
}

function boundedCanonicalText(maximumCharacters: number, label: string) {
  return z
    .string()
    .min(1)
    .refine((value) => value.trim() === value, `${label} must not have surrounding whitespace`)
    .refine((value) => value.normalize("NFC") === value, `${label} must use NFC normalization`)
    .refine(
      (value) => !containsUnsafeDisplayControl(value),
      `${label} must not contain unsafe display control characters`,
    )
    .refine((value) => {
      const length = unicodeScalarLength(value);
      return length !== undefined && length <= maximumCharacters;
    }, `${label} must contain valid Unicode scalar values and at most ${maximumCharacters} characters`);
}

function isStrictlySortedUnique(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || (values[index - 1] ?? "") < value);
}

function sortedCanonicalTextValues(maximumItems: number, maximumCharacters: number, label: string) {
  return z
    .array(boundedCanonicalText(maximumCharacters, label))
    .max(maximumItems)
    .refine(isStrictlySortedUnique, { message: `${label} values must be unique and ordered` });
}

function scopeSelector<T extends z.ZodType<string>>(item: T, maximumItems: number, label: string) {
  return z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("any") }).strict(),
    z
      .object({
        mode: z.literal("include"),
        values: z
          .array(item)
          .min(1)
          .max(maximumItems)
          .refine(isStrictlySortedUnique, {
            message: `${label} values must be unique and ordered`,
          }),
      })
      .strict(),
  ]);
}

function compareTimestamp(left: string, right: string): number {
  const leftKey = evidenceTimestampOrderKey(left);
  const rightKey = evidenceTimestampOrderKey(right);
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

export const AssuranceSummarySchema = boundedCanonicalText(512, "Assurance summary");
export const AssuranceRationaleSchema = boundedCanonicalText(4_096, "Assurance rationale");
export const SourceDocumentVersionSchema = boundedCanonicalText(256, "Source document version");
export const SourceLocaleSchema = z.string().regex(/^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/);
export const SourceJurisdictionSchema = z.string().regex(/^[a-z][a-z0-9._-]{1,63}$/);
export const HttpsSourceUriSchema = z
  .string()
  .url()
  .max(2_048)
  .refine((value) => value.startsWith("https://"), "Source URI must use HTTPS");

export const SourceReferenceSchema = z
  .object({
    definitionSha256: Sha256Schema,
    sourceSnapshotId: OpaqueIdSchema,
  })
  .strict();

export const SourceReviewReferenceSchema = z
  .object({
    definitionSha256: Sha256Schema,
    sourceReviewId: OpaqueIdSchema,
  })
  .strict();

export const SourceApplicabilityScopeSchema = z
  .object({
    environments: scopeSelector(OpaqueIdSchema, MAX_SOURCE_SCOPE_VALUES, "Source environment"),
    exclusions: sortedCanonicalTextValues(MAX_SOURCE_SCOPE_VALUES, 256, "Source scope exclusion"),
    jurisdictions: scopeSelector(
      SourceJurisdictionSchema,
      MAX_SOURCE_SCOPE_VALUES,
      "Source jurisdiction",
    ),
    locales: scopeSelector(SourceLocaleSchema, MAX_SOURCE_SCOPE_VALUES, "Source locale"),
    populations: scopeSelector(
      boundedCanonicalText(256, "Source population"),
      MAX_SOURCE_SCOPE_VALUES,
      "Source population",
    ),
    riskTiers: scopeSelector(
      z.enum(["low", "moderate", "high", "critical"]),
      4,
      "Source risk tier",
    ),
    taskKinds: scopeSelector(OpaqueIdSchema, MAX_SOURCE_SCOPE_VALUES, "Source task kind"),
  })
  .strict();

const DiscoverySelectionSchema = z.discriminatedUnion("decision", [
  z
    .object({
      decision: z.literal("pending"),
    })
    .strict(),
  z
    .object({
      decision: z.enum(["selected", "excluded"]),
      reason: AssuranceRationaleSchema,
    })
    .strict(),
]);

export const DiscoveryCandidateSchema = z
  .object({
    canonicalUri: HttpsSourceUriSchema,
    displayedPublisher: AssuranceSummarySchema.optional(),
    displayedTitle: AssuranceSummarySchema,
    rank: z.number().int().positive().max(MAX_DISCOVERY_CANDIDATES),
    selection: DiscoverySelectionSchema,
  })
  .strict();

const DiscoveryFiltersSchema = z
  .record(boundedCanonicalText(64, "Discovery filter name"), JsonValueSchema)
  .refine((value) => Object.keys(value).length <= 32, {
    message: "Discovery filters cannot contain more than 32 keys",
  });

const discoveryRecordDefinitionShape = {
  candidates: z.array(DiscoveryCandidateSchema).max(MAX_DISCOVERY_CANDIDATES),
  discoveryId: OpaqueIdSchema,
  filters: DiscoveryFiltersSchema,
  locale: SourceLocaleSchema,
  providerName: boundedCanonicalText(128, "Discovery provider name"),
  query: boundedCanonicalText(1_024, "Discovery query"),
  resultLimit: z.number().int().positive().max(MAX_DISCOVERY_CANDIDATES),
  toolVersion: boundedCanonicalText(128, "Discovery tool version"),
};

function refineDiscoveryRecord(
  value: {
    readonly candidates: readonly {
      readonly canonicalUri: string;
      readonly rank: number;
    }[];
    readonly resultLimit: number;
  },
  context: z.RefinementCtx,
): void {
  if (value.candidates.length > value.resultLimit) {
    context.addIssue({
      code: "custom",
      message: "Discovery candidates cannot exceed the declared result limit",
      path: ["candidates"],
    });
  }
  const uris = value.candidates.map(({ canonicalUri }) => canonicalUri);
  if (new Set(uris).size !== uris.length) {
    context.addIssue({
      code: "custom",
      message: "Discovery candidates must not contain duplicate canonical URIs",
      path: ["candidates"],
    });
  }
  value.candidates.forEach(({ rank }, index) => {
    if (rank !== index + 1) {
      context.addIssue({
        code: "custom",
        message: "Discovery candidate ranks must be complete and ordered from one",
        path: ["candidates", index, "rank"],
      });
    }
  });
}

export const DiscoveryRecordDefinitionSchema = z
  .object(discoveryRecordDefinitionShape)
  .strict()
  .superRefine(refineDiscoveryRecord);

export const DiscoveryRecordSchema = z
  .object({
    ...discoveryRecordDefinitionShape,
    definitionSha256: Sha256Schema,
    recordedAt: UtcMillisecondTimestampSchema,
    recordedByPrincipalId: OpaqueIdSchema,
    schemaVersion: z.literal(DISCOVERY_RECORD_SCHEMA_VERSION),
    scope: EvidenceScopeSchema,
  })
  .strict()
  .superRefine(refineDiscoveryRecord);

export const SourcePublisherClaimSchema = z
  .object({
    canonicalName: AssuranceSummarySchema,
    identifier: HttpsSourceUriSchema,
  })
  .strict();

const SourceIdentityVerificationMethodSchema = z.enum([
  "digital_signature",
  "dns_https",
  "manual_documentary",
  "registry_record",
]);

function exactArtifactReferences(label: string) {
  return z
    .array(ArtifactContentReferenceSchema)
    .min(1)
    .max(MAX_SOURCE_REVIEW_BASIS_ARTIFACTS)
    .refine(
      (references) =>
        isStrictlySortedUnique(
          references.map(({ artifactId, sha256 }) => `${artifactId}:${sha256}`),
        ),
      { message: `${label} must be unique and ordered by exact artifact reference` },
    );
}

export const SourceIdentityVerificationSchema = z.discriminatedUnion("status", [
  z
    .object({
      evidence: exactArtifactReferences("Source identity evidence"),
      method: SourceIdentityVerificationMethodSchema,
      status: z.literal("verified"),
      verifiedAt: PostgresTimestampSchema,
      verifierPrincipalId: OpaqueIdSchema,
    })
    .strict(),
  z
    .object({
      reason: AssuranceRationaleSchema,
      status: z.literal("unverified"),
    })
    .strict(),
  z
    .object({
      evidence: exactArtifactReferences("Disputed source identity evidence"),
      reason: AssuranceRationaleSchema,
      status: z.literal("disputed"),
    })
    .strict(),
]);

export const SourceLicenseSchema = z.discriminatedUnion("status", [
  z
    .object({
      expression: boundedCanonicalText(256, "Source license expression"),
      status: z.literal("declared"),
      termsUri: HttpsSourceUriSchema.optional(),
    })
    .strict(),
  z
    .object({
      reason: AssuranceRationaleSchema,
      status: z.enum(["restricted", "unknown"]),
      termsUri: HttpsSourceUriSchema.optional(),
    })
    .strict(),
]);

const SourceDiscoveryReferenceSchema = z
  .object({
    candidateRank: z.number().int().positive().max(MAX_DISCOVERY_CANDIDATES),
    definitionSha256: Sha256Schema,
    discoveryId: OpaqueIdSchema,
  })
  .strict();

function sourceReferences(label: string) {
  return z
    .array(SourceReferenceSchema)
    .max(MAX_SOURCE_CONFLICTS)
    .refine(
      (references) =>
        isStrictlySortedUnique(
          references.map(
            ({ definitionSha256, sourceSnapshotId }) => `${sourceSnapshotId}:${definitionSha256}`,
          ),
        ),
      { message: `${label} must be unique and ordered by exact source reference` },
    );
}

const sourceSnapshotDefinitionShape = {
  applicabilityScope: SourceApplicabilityScopeSchema,
  canonicalUri: HttpsSourceUriSchema,
  conflictsWith: sourceReferences("Source conflicts"),
  content: ArtifactContentReferenceSchema,
  discovery: SourceDiscoveryReferenceSchema.optional(),
  documentVersion: SourceDocumentVersionSchema,
  effectiveAt: PostgresTimestampSchema.optional(),
  expiresAt: PostgresTimestampSchema.optional(),
  identityVerification: SourceIdentityVerificationSchema,
  knownLimitations: z.array(AssuranceSummarySchema).max(64).refine(isStrictlySortedUnique, {
    message: "Source limitations must be unique and ordered",
  }),
  license: SourceLicenseSchema,
  publishedAt: PostgresTimestampSchema.optional(),
  publisher: SourcePublisherClaimSchema,
  retrievedAt: PostgresTimestampSchema,
  sourceKind: z.enum([
    "contract",
    "law_or_regulation",
    "organizational_policy",
    "primary_research",
    "product_specification",
    "standard",
    "technical_documentation",
  ]),
  sourceSnapshotId: OpaqueIdSchema,
  supersedes: sourceReferences("Superseded sources"),
};

function refineSourceSnapshot(
  value: {
    readonly conflictsWith: readonly { readonly sourceSnapshotId: string }[];
    readonly effectiveAt?: string | undefined;
    readonly expiresAt?: string | undefined;
    readonly publishedAt?: string | undefined;
    readonly retrievedAt: string;
    readonly sourceSnapshotId: string;
    readonly supersedes: readonly { readonly sourceSnapshotId: string }[];
  },
  context: z.RefinementCtx,
): void {
  if (value.publishedAt && compareTimestamp(value.publishedAt, value.retrievedAt) > 0) {
    context.addIssue({
      code: "custom",
      message: "Source publication time cannot be after retrieval",
      path: ["publishedAt"],
    });
  }
  if (value.expiresAt && compareTimestamp(value.retrievedAt, value.expiresAt) >= 0) {
    context.addIssue({
      code: "custom",
      message: "Source expiry must be after retrieval",
      path: ["expiresAt"],
    });
  }
  if (
    value.effectiveAt &&
    value.expiresAt &&
    compareTimestamp(value.effectiveAt, value.expiresAt) >= 0
  ) {
    context.addIssue({
      code: "custom",
      message: "Source expiry must be after the effective time",
      path: ["expiresAt"],
    });
  }
  const conflicts = new Set(value.conflictsWith.map(({ sourceSnapshotId }) => sourceSnapshotId));
  const superseded = new Set(value.supersedes.map(({ sourceSnapshotId }) => sourceSnapshotId));
  if (conflicts.has(value.sourceSnapshotId) || superseded.has(value.sourceSnapshotId)) {
    context.addIssue({
      code: "custom",
      message: "A source snapshot cannot reference itself",
      path: ["sourceSnapshotId"],
    });
  }
  for (const sourceSnapshotId of conflicts) {
    if (superseded.has(sourceSnapshotId)) {
      context.addIssue({
        code: "custom",
        message: "A source cannot be both conflicting and superseded",
        path: ["conflictsWith"],
      });
      break;
    }
  }
}

export const SourceSnapshotDefinitionSchema = z
  .object(sourceSnapshotDefinitionShape)
  .strict()
  .superRefine(refineSourceSnapshot);

export const SourceSnapshotSchema = z
  .object({
    ...sourceSnapshotDefinitionShape,
    definitionSha256: Sha256Schema,
    publishedByPrincipalId: OpaqueIdSchema,
    recordedAt: UtcMillisecondTimestampSchema,
    schemaVersion: z.literal(SOURCE_SNAPSHOT_SCHEMA_VERSION),
    scope: EvidenceScopeSchema,
  })
  .strict()
  .superRefine(refineSourceSnapshot);

const sourceReviewDefinitionShape = {
  applicabilityConclusion: z.enum(["approved", "rejected", "undetermined"]),
  approvedScope: SourceApplicabilityScopeSchema,
  authorityConclusion: z.enum(["accepted", "rejected", "uncertain"]),
  criticalConflictStatus: z.enum(["none", "resolved", "unresolved"]),
  declaredRelationships: sortedCanonicalTextValues(16, 256, "Reviewer relationship"),
  freshnessConclusion: z.enum(["current", "expired", "unknown"]),
  licensingConclusion: z.enum(["usable", "restricted", "unknown"]),
  outcome: z.enum(["approved", "rejected", "require_approval", "unverifiable"]),
  rationale: AssuranceRationaleSchema,
  reviewBasis: exactArtifactReferences("Source review basis"),
  reviewedConflicts: sourceReferences("Reviewed source conflicts"),
  source: SourceReferenceSchema,
  sourceReviewId: OpaqueIdSchema,
  supersedesReview: SourceReviewReferenceSchema.optional(),
  validFrom: PostgresTimestampSchema,
  validUntil: PostgresTimestampSchema,
};

function refineSourceReview(
  value: {
    readonly applicabilityConclusion: "approved" | "rejected" | "undetermined";
    readonly authorityConclusion: "accepted" | "rejected" | "uncertain";
    readonly criticalConflictStatus: "none" | "resolved" | "unresolved";
    readonly freshnessConclusion: "current" | "expired" | "unknown";
    readonly licensingConclusion: "restricted" | "unknown" | "usable";
    readonly outcome: "approved" | "rejected" | "require_approval" | "unverifiable";
    readonly reviewedConflicts: readonly unknown[];
    readonly sourceReviewId: string;
    readonly supersedesReview?: { readonly sourceReviewId: string } | undefined;
    readonly validFrom: string;
    readonly validUntil: string;
  },
  context: z.RefinementCtx,
): void {
  if (compareTimestamp(value.validFrom, value.validUntil) >= 0) {
    context.addIssue({
      code: "custom",
      message: "Source review validity must have a positive interval",
      path: ["validUntil"],
    });
  }
  if (value.supersedesReview?.sourceReviewId === value.sourceReviewId) {
    context.addIssue({
      code: "custom",
      message: "A source review cannot supersede itself",
      path: ["supersedesReview", "sourceReviewId"],
    });
  }
  if (value.criticalConflictStatus === "none" && value.reviewedConflicts.length > 0) {
    context.addIssue({
      code: "custom",
      message: "A no-conflict review cannot contain reviewed conflicts",
      path: ["reviewedConflicts"],
    });
  }
  if (value.criticalConflictStatus !== "none" && value.reviewedConflicts.length === 0) {
    context.addIssue({
      code: "custom",
      message: "A conflict conclusion requires exact reviewed conflicts",
      path: ["reviewedConflicts"],
    });
  }
  if (
    value.outcome === "approved" &&
    (value.authorityConclusion !== "accepted" ||
      value.applicabilityConclusion !== "approved" ||
      value.freshnessConclusion !== "current" ||
      value.licensingConclusion !== "usable" ||
      value.criticalConflictStatus === "unresolved")
  ) {
    context.addIssue({
      code: "custom",
      message: "An approved source review requires accepted current usable applicable authority",
      path: ["outcome"],
    });
  }
  if (
    value.outcome === "rejected" &&
    value.authorityConclusion !== "rejected" &&
    value.applicabilityConclusion !== "rejected" &&
    value.licensingConclusion !== "restricted"
  ) {
    context.addIssue({
      code: "custom",
      message: "A rejected source review requires an explicit rejection or restriction",
      path: ["outcome"],
    });
  }
}

export const SourceReviewDefinitionSchema = z
  .object(sourceReviewDefinitionShape)
  .strict()
  .superRefine(refineSourceReview);

export const SourceReviewRecordSchema = z
  .object({
    ...sourceReviewDefinitionShape,
    definitionSha256: Sha256Schema,
    reviewedAt: UtcMillisecondTimestampSchema,
    reviewedByPrincipalId: OpaqueIdSchema,
    reviewerRole: AssuranceSummarySchema,
    schemaVersion: z.literal(SOURCE_REVIEW_SCHEMA_VERSION),
    scope: EvidenceScopeSchema,
  })
  .strict()
  .superRefine(refineSourceReview);

export type DiscoveryCandidate = z.infer<typeof DiscoveryCandidateSchema>;
export type DiscoveryRecord = z.infer<typeof DiscoveryRecordSchema>;
export type DiscoveryRecordDefinition = z.infer<typeof DiscoveryRecordDefinitionSchema>;
export type SourceApplicabilityScope = z.infer<typeof SourceApplicabilityScopeSchema>;
export type SourceReference = z.infer<typeof SourceReferenceSchema>;
export type SourceReviewDefinition = z.infer<typeof SourceReviewDefinitionSchema>;
export type SourceReviewRecord = z.infer<typeof SourceReviewRecordSchema>;
export type SourceSnapshot = z.infer<typeof SourceSnapshotSchema>;
export type SourceSnapshotDefinition = z.infer<typeof SourceSnapshotDefinitionSchema>;
