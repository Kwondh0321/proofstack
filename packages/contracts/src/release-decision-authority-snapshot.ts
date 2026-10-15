import { z } from "zod";
import { EvidenceScopeSchema } from "./evidence.js";
import { OpaqueIdSchema, Sha256Schema } from "./primitives.js";
import { PolicyEvaluationTimeSchema } from "./policy-evaluation-time.js";
import { MAX_RELEASE_DECISION_AUTHORITY_MATERIAL_BYTES } from "./release-decision-authority-material.js";
import { ReleaseDecisionInputReferenceSchema } from "./release-decision-input.js";

export const RELEASE_DECISION_AUTHORITY_SNAPSHOT_SCHEMA_VERSION = "0.1" as const;
export const RELEASE_DECISION_AUTHORITY_FRAME_BYTES = 2_048;
export const RELEASE_DECISION_AUTHORITY_PAGE_SIZE = 128;
export const MAX_RELEASE_DECISION_AUTHORITY_FRAMES = Math.ceil(
  MAX_RELEASE_DECISION_AUTHORITY_MATERIAL_BYTES / RELEASE_DECISION_AUTHORITY_FRAME_BYTES,
);
export const MAX_RELEASE_DECISION_AUTHORITY_PAGES = Math.ceil(
  MAX_RELEASE_DECISION_AUTHORITY_FRAMES / RELEASE_DECISION_AUTHORITY_PAGE_SIZE,
);
export const MAX_RELEASE_DECISION_AUTHORITY_RESPONSE_BYTES = 512 * 1024;
export const MAX_RELEASE_DECISION_AUTHORITY_PAGE_RESPONSE_BYTES = 512 * 1024;

const ByteLength = z.number().int().positive().max(MAX_RELEASE_DECISION_AUTHORITY_MATERIAL_BYTES);
const FrameCount = z.number().int().positive().max(MAX_RELEASE_DECISION_AUTHORITY_FRAMES);
const PageIndex = z
  .number()
  .int()
  .nonnegative()
  .max(MAX_RELEASE_DECISION_AUTHORITY_PAGES - 1);
const Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const Frame = z
  .object({
    frameIndex: z
      .number()
      .int()
      .nonnegative()
      .max(MAX_RELEASE_DECISION_AUTHORITY_FRAMES - 1),
    dataBase64url: z
      .string()
      .min(1)
      .max(Math.ceil((RELEASE_DECISION_AUTHORITY_FRAME_BYTES * 4) / 3))
      .regex(/^[A-Za-z0-9_-]+$/u)
      .refine((value) => {
        const remainder = value.length % 4;
        const last = Alphabet.indexOf(value.at(-1) ?? "");
        return (
          remainder !== 1 &&
          (remainder !== 2 || last % 16 === 0) &&
          (remainder !== 3 || last % 4 === 0)
        );
      }, "Authority frames require canonical unpadded base64url"),
  })
  .strict();

const PageShape = {
  authoritySnapshotId: OpaqueIdSchema,
  decisionId: OpaqueIdSchema,
  input: ReleaseDecisionInputReferenceSchema,
  materialSha256: Sha256Schema,
  materialByteLength: ByteLength,
  frameCount: FrameCount,
  pageIndex: PageIndex,
  frames: z.array(Frame).min(1).max(RELEASE_DECISION_AUTHORITY_PAGE_SIZE),
};
export const ReleaseDecisionAuthorityPageDefinitionSchema = z
  .object(PageShape)
  .strict()
  .superRefine((value, context) => {
    if (context.issues.length > 0) return;
    const first = value.pageIndex * RELEASE_DECISION_AUTHORITY_PAGE_SIZE;
    const count = Math.min(RELEASE_DECISION_AUTHORITY_PAGE_SIZE, value.frameCount - first);
    if (
      count <= 0 ||
      value.frames.length !== count ||
      value.frameCount !==
        Math.ceil(value.materialByteLength / RELEASE_DECISION_AUTHORITY_FRAME_BYTES)
    )
      context.addIssue({
        code: "custom",
        message: "Authority pages require complete fixed frame boundaries",
      });
    for (const [index, frame] of value.frames.entries()) {
      const expectedIndex = first + index;
      const expectedBytes = Math.min(
        RELEASE_DECISION_AUTHORITY_FRAME_BYTES,
        value.materialByteLength - expectedIndex * RELEASE_DECISION_AUTHORITY_FRAME_BYTES,
      );
      if (
        frame.frameIndex !== expectedIndex ||
        Math.floor((frame.dataBase64url.length * 3) / 4) !== expectedBytes
      )
        context.addIssue({
          code: "custom",
          message: "Authority frame order and exact byte lengths must agree",
        });
    }
  });
export const ReleaseDecisionAuthorityPageSchema =
  ReleaseDecisionAuthorityPageDefinitionSchema.safeExtend({
    scope: EvidenceScopeSchema,
    schemaVersion: z.literal(RELEASE_DECISION_AUTHORITY_SNAPSHOT_SCHEMA_VERSION),
    definitionSha256: Sha256Schema,
  });

const Descriptor = z
  .object({
    pageIndex: PageIndex,
    definitionSha256: Sha256Schema,
    firstFrameIndex: z
      .number()
      .int()
      .nonnegative()
      .max(MAX_RELEASE_DECISION_AUTHORITY_FRAMES - 1),
    frameCount: z.number().int().positive().max(RELEASE_DECISION_AUTHORITY_PAGE_SIZE),
  })
  .strict();

export const ReleaseDecisionAuthoritySnapshotDefinitionSchema = z
  .object({
    authoritySnapshotId: OpaqueIdSchema,
    decisionId: OpaqueIdSchema,
    scope: EvidenceScopeSchema,
    input: ReleaseDecisionInputReferenceSchema,
    capturedAt: PolicyEvaluationTimeSchema,
    recoveryEpoch: z.number().int().nonnegative().safe(),
    materialSha256: Sha256Schema,
    materialByteLength: ByteLength,
    frameCount: FrameCount,
    reviewAuthorityAssurances: z
      .array(z.enum(["operator_verified", "synthetic_reference"]))
      .max(2)
      .refine(
        (values) =>
          values.every((value, index) => index === 0 || (values[index - 1] ?? "") < value),
        "Observed assurance modes must be unique and ordered",
      ),
    hasUnavailableReviewerAuthority: z.boolean(),
    pages: z.array(Descriptor).min(1).max(MAX_RELEASE_DECISION_AUTHORITY_PAGES),
  })
  .strict()
  .superRefine((value, context) => {
    if (context.issues.length > 0) return;
    if (
      value.frameCount !==
        Math.ceil(value.materialByteLength / RELEASE_DECISION_AUTHORITY_FRAME_BYTES) ||
      value.pages.length !== Math.ceil(value.frameCount / RELEASE_DECISION_AUTHORITY_PAGE_SIZE)
    )
      context.addIssue({
        code: "custom",
        message: "Authority header must retain the complete original fixed page inventory",
      });
    for (const [index, page] of value.pages.entries()) {
      const first = index * RELEASE_DECISION_AUTHORITY_PAGE_SIZE;
      if (
        page.pageIndex !== index ||
        page.firstFrameIndex !== first ||
        page.frameCount !== Math.min(RELEASE_DECISION_AUTHORITY_PAGE_SIZE, value.frameCount - first)
      )
        context.addIssue({
          code: "custom",
          message: "Authority descriptors require complete contiguous frame/page indices",
        });
    }
  });
export const ReleaseDecisionAuthoritySnapshotSchema =
  ReleaseDecisionAuthoritySnapshotDefinitionSchema.safeExtend({
    schemaVersion: z.literal(RELEASE_DECISION_AUTHORITY_SNAPSHOT_SCHEMA_VERSION),
    definitionSha256: Sha256Schema,
  });

export type ReleaseDecisionAuthoritySnapshotDefinition = z.infer<
  typeof ReleaseDecisionAuthoritySnapshotDefinitionSchema
>;
export type ReleaseDecisionAuthoritySnapshot = z.infer<
  typeof ReleaseDecisionAuthoritySnapshotSchema
>;
export type ReleaseDecisionAuthorityPageDefinition = z.infer<
  typeof ReleaseDecisionAuthorityPageDefinitionSchema
>;
export type ReleaseDecisionAuthorityPage = z.infer<typeof ReleaseDecisionAuthorityPageSchema>;
