import { z } from "zod";
import { EvidenceScopeSchema } from "./evidence.js";
import { OpaqueIdSchema, Sha256Schema, TimestampSchema, TraceIdSchema } from "./primitives.js";

export const REGRESSION_FIXTURE_VERSION_SCHEMA_VERSION = "0.1" as const;
export const REGRESSION_DATASET_VERSION_SCHEMA_VERSION = "0.1" as const;
export const MAX_FIXTURE_SOURCE_EVENTS = 1_000;
export const MAX_DATASET_FIXTURE_VERSIONS = 500;
export const MAX_REGRESSION_VERSION_NAME_CHARACTERS = 128;
export const MAX_REGRESSION_VERSION_DESCRIPTION_CHARACTERS = 2_048;

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

function canonicalText(maximumCharacters: number, label: string) {
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

const uniqueStrings = (values: readonly string[]): boolean =>
  new Set(values).size === values.length;

export const RegressionVersionNameSchema = canonicalText(
  MAX_REGRESSION_VERSION_NAME_CHARACTERS,
  "Regression version name",
);
export const RegressionVersionDescriptionSchema = canonicalText(
  MAX_REGRESSION_VERSION_DESCRIPTION_CHARACTERS,
  "Regression version description",
);

export const PublishRegressionFixtureVersionRequestSchema = z
  .object({
    description: RegressionVersionDescriptionSchema.optional(),
    fixtureVersionId: OpaqueIdSchema,
    name: RegressionVersionNameSchema,
    predecessorVersionId: OpaqueIdSchema.optional(),
    source: z
      .object({
        kind: z.literal("trace_snapshot"),
        traceId: TraceIdSchema,
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.predecessorVersionId === value.fixtureVersionId) {
      context.addIssue({
        code: "custom",
        message: "A fixture version cannot name itself as its predecessor",
        path: ["predecessorVersionId"],
      });
    }
  });

export const RegressionFixturePredecessorSchema = z
  .object({
    definitionSha256: Sha256Schema,
    fixtureVersionId: OpaqueIdSchema,
  })
  .strict();

const regressionTraceSnapshotDefinitionShape = {
  eventIds: z
    .array(OpaqueIdSchema)
    .min(1)
    .max(MAX_FIXTURE_SOURCE_EVENTS)
    .refine(uniqueStrings, { message: "Trace snapshot eventIds must not contain duplicates" }),
  kind: z.literal("trace_snapshot"),
  observedEventCount: z.number().int().positive().max(MAX_FIXTURE_SOURCE_EVENTS),
  sourceCompleteness: z.literal("observed_snapshot"),
  traceId: TraceIdSchema,
};

function refineObservedEventCount(
  value: { readonly eventIds: readonly string[]; readonly observedEventCount: number },
  context: z.RefinementCtx,
): void {
  if (value.observedEventCount !== value.eventIds.length) {
    context.addIssue({
      code: "custom",
      message: "observedEventCount must equal the number of captured eventIds",
      path: ["observedEventCount"],
    });
  }
}

export const RegressionTraceSnapshotDefinitionSchema = z
  .object(regressionTraceSnapshotDefinitionShape)
  .strict()
  .superRefine(refineObservedEventCount);

export const RegressionTraceSnapshotSchema = z
  .object({
    capturedAt: TimestampSchema,
    ...regressionTraceSnapshotDefinitionShape,
  })
  .strict()
  .superRefine(refineObservedEventCount);

const regressionFixtureVersionDefinitionShape = {
  description: RegressionVersionDescriptionSchema.optional(),
  fixtureId: OpaqueIdSchema,
  fixtureVersionId: OpaqueIdSchema,
  name: RegressionVersionNameSchema,
  predecessor: RegressionFixturePredecessorSchema.optional(),
  replayability: z.literal("evidence_only"),
  schemaVersion: z.literal(REGRESSION_FIXTURE_VERSION_SCHEMA_VERSION),
  scope: EvidenceScopeSchema,
  source: RegressionTraceSnapshotDefinitionSchema,
};

function refineFixturePredecessor(
  value: {
    readonly fixtureVersionId: string;
    readonly predecessor?: { readonly fixtureVersionId: string } | undefined;
  },
  context: z.RefinementCtx,
): void {
  if (value.predecessor?.fixtureVersionId === value.fixtureVersionId) {
    context.addIssue({
      code: "custom",
      message: "A fixture version cannot name itself as its predecessor",
      path: ["predecessor", "fixtureVersionId"],
    });
  }
}

export const RegressionFixtureVersionDefinitionSchema = z
  .object(regressionFixtureVersionDefinitionShape)
  .strict()
  .superRefine(refineFixturePredecessor);

export const RegressionFixtureVersionSchema = z
  .object({
    createdAt: TimestampSchema,
    createdByPrincipalId: OpaqueIdSchema,
    definitionSha256: Sha256Schema,
    ...regressionFixtureVersionDefinitionShape,
    source: RegressionTraceSnapshotSchema,
  })
  .strict()
  .superRefine((value, context) => {
    refineFixturePredecessor(value, context);
    if (Date.parse(value.source.capturedAt) > Date.parse(value.createdAt)) {
      context.addIssue({
        code: "custom",
        message: "createdAt cannot be earlier than the trace capture time",
        path: ["createdAt"],
      });
    }
  });

export const RequestedRegressionFixtureVersionReferenceSchema = z
  .object({
    fixtureId: OpaqueIdSchema,
    fixtureVersionId: OpaqueIdSchema,
  })
  .strict();

export const RegressionFixtureVersionReferenceSchema =
  RequestedRegressionFixtureVersionReferenceSchema.extend({
    definitionSha256: Sha256Schema,
  }).strict();

const RequestedFixtureVersionsSchema = z
  .array(RequestedRegressionFixtureVersionReferenceSchema)
  .min(1)
  .max(MAX_DATASET_FIXTURE_VERSIONS)
  .refine((values) => uniqueStrings(values.map(({ fixtureId }) => fixtureId)), {
    message: "A dataset version cannot contain the same logical fixture more than once",
  })
  .refine((values) => uniqueStrings(values.map(({ fixtureVersionId }) => fixtureVersionId)), {
    message: "A dataset version cannot contain the same fixture version more than once",
  });

const ResolvedFixtureVersionsSchema = z
  .array(RegressionFixtureVersionReferenceSchema)
  .min(1)
  .max(MAX_DATASET_FIXTURE_VERSIONS)
  .refine((values) => uniqueStrings(values.map(({ fixtureId }) => fixtureId)), {
    message: "A dataset version cannot contain the same logical fixture more than once",
  })
  .refine((values) => uniqueStrings(values.map(({ fixtureVersionId }) => fixtureVersionId)), {
    message: "A dataset version cannot contain the same fixture version more than once",
  });

export const PublishRegressionDatasetVersionRequestSchema = z
  .object({
    datasetVersionId: OpaqueIdSchema,
    description: RegressionVersionDescriptionSchema.optional(),
    fixtureVersions: RequestedFixtureVersionsSchema,
    name: RegressionVersionNameSchema,
    predecessorVersionId: OpaqueIdSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.predecessorVersionId === value.datasetVersionId) {
      context.addIssue({
        code: "custom",
        message: "A dataset version cannot name itself as its predecessor",
        path: ["predecessorVersionId"],
      });
    }
  });

export const RegressionDatasetPredecessorSchema = z
  .object({
    datasetVersionId: OpaqueIdSchema,
    definitionSha256: Sha256Schema,
  })
  .strict();

const regressionDatasetVersionIdentityShape = {
  datasetId: OpaqueIdSchema,
  datasetVersionId: OpaqueIdSchema,
};

const regressionDatasetVersionDefinitionDetailsShape = {
  description: RegressionVersionDescriptionSchema.optional(),
  fixtureVersions: ResolvedFixtureVersionsSchema,
  name: RegressionVersionNameSchema,
  predecessor: RegressionDatasetPredecessorSchema.optional(),
  schemaVersion: z.literal(REGRESSION_DATASET_VERSION_SCHEMA_VERSION),
  scope: EvidenceScopeSchema,
};

const regressionDatasetVersionDefinitionShape = {
  ...regressionDatasetVersionIdentityShape,
  ...regressionDatasetVersionDefinitionDetailsShape,
};

function refineDatasetPredecessor(
  value: {
    readonly datasetVersionId: string;
    readonly predecessor?: { readonly datasetVersionId: string } | undefined;
  },
  context: z.RefinementCtx,
): void {
  if (value.predecessor?.datasetVersionId === value.datasetVersionId) {
    context.addIssue({
      code: "custom",
      message: "A dataset version cannot name itself as its predecessor",
      path: ["predecessor", "datasetVersionId"],
    });
  }
}

export const RegressionDatasetVersionDefinitionSchema = z
  .object(regressionDatasetVersionDefinitionShape)
  .strict()
  .superRefine(refineDatasetPredecessor);

export const RegressionDatasetVersionSchema = z
  .object({
    createdAt: TimestampSchema,
    createdByPrincipalId: OpaqueIdSchema,
    ...regressionDatasetVersionIdentityShape,
    definitionSha256: Sha256Schema,
    ...regressionDatasetVersionDefinitionDetailsShape,
  })
  .strict()
  .superRefine(refineDatasetPredecessor);

export type PublishRegressionDatasetVersionRequest = z.infer<
  typeof PublishRegressionDatasetVersionRequestSchema
>;
export type PublishRegressionFixtureVersionRequest = z.infer<
  typeof PublishRegressionFixtureVersionRequestSchema
>;
export type RegressionDatasetPredecessor = z.infer<typeof RegressionDatasetPredecessorSchema>;
export type RegressionDatasetVersionDefinition = z.infer<
  typeof RegressionDatasetVersionDefinitionSchema
>;
export type RegressionDatasetVersion = z.infer<typeof RegressionDatasetVersionSchema>;
export type RegressionFixturePredecessor = z.infer<typeof RegressionFixturePredecessorSchema>;
export type RegressionFixtureVersionDefinition = z.infer<
  typeof RegressionFixtureVersionDefinitionSchema
>;
export type RegressionFixtureVersion = z.infer<typeof RegressionFixtureVersionSchema>;
export type RegressionFixtureVersionReference = z.infer<
  typeof RegressionFixtureVersionReferenceSchema
>;
export type RegressionTraceSnapshotDefinition = z.infer<
  typeof RegressionTraceSnapshotDefinitionSchema
>;
export type RegressionTraceSnapshot = z.infer<typeof RegressionTraceSnapshotSchema>;
export type RequestedRegressionFixtureVersionReference = z.infer<
  typeof RequestedRegressionFixtureVersionReferenceSchema
>;
