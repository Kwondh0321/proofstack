import { z } from "zod";
import { EvidenceScopeSchema } from "./evidence.js";
import { serializeEvaluationCanonicalJson } from "./evaluation-definition-encoding.js";
import { PolicyEvaluationManifestReferenceSchema } from "./policy-evaluation-manifest.js";
import {
  PolicyEvaluationAlgorithmSchema,
  PolicyEvaluationRequestReferenceSchema,
  MAX_POLICY_EVALUATION_ACQUISITION_RECORD_BYTES,
} from "./policy-evaluation-request.js";
import {
  PolicyEvaluationTimeSchema,
  policyEvaluationTimestampOrderKey,
} from "./policy-evaluation-time.js";
import { OpaqueIdSchema, Sha256Schema } from "./primitives.js";
import { ReleaseCandidateReferenceSchema } from "./release-candidate.js";
import { ReleasePolicyReferenceSchema } from "./release-policy.js";

export const POLICY_EVALUATION_SNAPSHOT_SCHEMA_VERSION = "0.1" as const;
export const POLICY_EVALUATION_SNAPSHOT_FRAME_BYTES = 2048;
export const POLICY_EVALUATION_SNAPSHOT_PAGE_SIZE = 128;
export const MAX_POLICY_EVALUATION_SNAPSHOT_INPUT_BYTES =
  MAX_POLICY_EVALUATION_ACQUISITION_RECORD_BYTES;
export const MAX_POLICY_EVALUATION_SNAPSHOT_FRAMES = Math.ceil(
  MAX_POLICY_EVALUATION_SNAPSHOT_INPUT_BYTES / POLICY_EVALUATION_SNAPSHOT_FRAME_BYTES,
);
export const MAX_POLICY_EVALUATION_SNAPSHOT_PAGES = Math.ceil(
  MAX_POLICY_EVALUATION_SNAPSHOT_FRAMES / POLICY_EVALUATION_SNAPSHOT_PAGE_SIZE,
);
export const MAX_POLICY_EVALUATION_SNAPSHOT_RESPONSE_BYTES = 512 * 1024;
export const MAX_POLICY_EVALUATION_SNAPSHOT_PAGE_RESPONSE_BYTES = 512 * 1024;

const FrameIndex = z
  .number()
  .int()
  .nonnegative()
  .max(MAX_POLICY_EVALUATION_SNAPSHOT_FRAMES - 1);
const PageIndex = z
  .number()
  .int()
  .nonnegative()
  .max(MAX_POLICY_EVALUATION_SNAPSHOT_PAGES - 1);
export const PolicyEvaluationSnapshotPageIndexSchema = PageIndex;
const ByteLength = z.number().int().positive().max(MAX_POLICY_EVALUATION_SNAPSHOT_INPUT_BYTES);
const FrameCount = z.number().int().positive().max(MAX_POLICY_EVALUATION_SNAPSHOT_FRAMES);
const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
function frameByteLength(value: string): number {
  return Math.floor((value.length * 3) / 4);
}
function canonicalFrame(value: string): boolean {
  const remainder = value.length % 4;
  const final = BASE64URL_ALPHABET.indexOf(value.at(-1) ?? "");
  return (
    remainder !== 1 &&
    frameByteLength(value) > 0 &&
    frameByteLength(value) <= POLICY_EVALUATION_SNAPSHOT_FRAME_BYTES &&
    (remainder === 0 || (remainder === 2 ? (final & 15) === 0 : (final & 3) === 0))
  );
}

/** Canonical UTF-8 input bytes; typed inputs are validated after complete bounded reassembly. */
const Frame = z
  .object({
    frameIndex: FrameIndex,
    dataBase64url: z
      .string()
      .min(2)
      .max(Math.ceil((POLICY_EVALUATION_SNAPSHOT_FRAME_BYTES * 4) / 3))
      .regex(/^[A-Za-z0-9_-]+$/)
      .refine(canonicalFrame, "Snapshot frames require canonical bounded unpadded base64url"),
  })
  .strict();
const PageShape = {
  snapshotId: OpaqueIdSchema,
  request: PolicyEvaluationRequestReferenceSchema,
  inputSha256: Sha256Schema,
  inputByteLength: ByteLength,
  frameCount: FrameCount,
  pageIndex: PageIndex,
  frames: z.array(Frame).min(1).max(POLICY_EVALUATION_SNAPSHOT_PAGE_SIZE),
};
function pageCheck(value: z.infer<z.ZodObject<typeof PageShape>>, context: z.RefinementCtx) {
  if (context.issues.length > 0) return;
  const first = value.pageIndex * POLICY_EVALUATION_SNAPSHOT_PAGE_SIZE;
  const expected = Math.min(POLICY_EVALUATION_SNAPSHOT_PAGE_SIZE, value.frameCount - first);
  if (
    expected <= 0 ||
    value.frames.length !== expected ||
    value.frameCount !== Math.ceil(value.inputByteLength / POLICY_EVALUATION_SNAPSHOT_FRAME_BYTES)
  )
    context.addIssue({
      code: "custom",
      message: "Snapshot pages must preserve complete fixed frame boundaries",
    });
  for (const [index, frame] of value.frames.entries()) {
    const frameIndex = first + index;
    const bytes = Math.min(
      POLICY_EVALUATION_SNAPSHOT_FRAME_BYTES,
      value.inputByteLength - frameIndex * POLICY_EVALUATION_SNAPSHOT_FRAME_BYTES,
    );
    if (frame.frameIndex !== frameIndex || frameByteLength(frame.dataBase64url) !== bytes)
      context.addIssue({
        code: "custom",
        message: "Snapshot frame order and exact original byte lengths must agree",
      });
  }
}
export const PolicyEvaluationSnapshotPageDefinitionSchema = z
  .object(PageShape)
  .strict()
  .superRefine(pageCheck);
export const PolicyEvaluationSnapshotPageSchema = z
  .object({
    ...PageShape,
    scope: EvidenceScopeSchema,
    schemaVersion: z.literal(POLICY_EVALUATION_SNAPSHOT_SCHEMA_VERSION),
    definitionSha256: Sha256Schema,
  })
  .strict()
  .superRefine(pageCheck);
export const PolicyEvaluationSnapshotPageDescriptorSchema = z
  .object({
    pageIndex: PageIndex,
    definitionSha256: Sha256Schema,
    firstFrameIndex: FrameIndex,
    frameCount: z.number().int().positive().max(POLICY_EVALUATION_SNAPSHOT_PAGE_SIZE),
  })
  .strict();
const DefinitionShape = {
  snapshotId: OpaqueIdSchema,
  request: PolicyEvaluationRequestReferenceSchema,
  candidate: ReleaseCandidateReferenceSchema,
  policy: ReleasePolicyReferenceSchema,
  algorithm: PolicyEvaluationAlgorithmSchema,
  evaluationTime: PolicyEvaluationTimeSchema,
  capturedAt: PolicyEvaluationTimeSchema,
  manifest: PolicyEvaluationManifestReferenceSchema,
  inputSha256: Sha256Schema,
  inputByteLength: ByteLength,
  frameCount: FrameCount,
  pages: z
    .array(PolicyEvaluationSnapshotPageDescriptorSchema)
    .min(1)
    .max(MAX_POLICY_EVALUATION_SNAPSHOT_PAGES),
};
function definitionCheck(
  value: z.infer<z.ZodObject<typeof DefinitionShape>>,
  context: z.RefinementCtx,
) {
  if (context.issues.length > 0) return;
  if (
    policyEvaluationTimestampOrderKey(value.capturedAt) <
    policyEvaluationTimestampOrderKey(value.evaluationTime)
  )
    context.addIssue({
      code: "custom",
      message: "Snapshot capture cannot precede its original semantic cut",
    });
  if (
    value.frameCount !==
      Math.ceil(value.inputByteLength / POLICY_EVALUATION_SNAPSHOT_FRAME_BYTES) ||
    value.pages.length !== Math.ceil(value.frameCount / POLICY_EVALUATION_SNAPSHOT_PAGE_SIZE)
  )
    context.addIssue({
      code: "custom",
      message: "Snapshot root must retain every fixed input frame and page",
    });
  for (const [index, descriptor] of value.pages.entries()) {
    const first = index * POLICY_EVALUATION_SNAPSHOT_PAGE_SIZE;
    if (
      descriptor.pageIndex !== index ||
      descriptor.firstFrameIndex !== first ||
      descriptor.frameCount !==
        Math.min(POLICY_EVALUATION_SNAPSHOT_PAGE_SIZE, value.frameCount - first)
    )
      context.addIssue({
        code: "custom",
        message: "Snapshot descriptors must preserve complete contiguous original page order",
      });
  }
}
export const PolicyEvaluationSnapshotDefinitionSchema = z
  .object(DefinitionShape)
  .strict()
  .superRefine(definitionCheck);
export const PolicyEvaluationSnapshotReferenceSchema = z
  .object({ snapshotId: OpaqueIdSchema, definitionSha256: Sha256Schema })
  .strict();

/** Server publication receipt. A parsed record cannot grant worker or publication permission. */
export const PolicyEvaluationSnapshotSchema = z
  .object({
    ...DefinitionShape,
    definitionSha256: Sha256Schema,
    scope: EvidenceScopeSchema,
    schemaVersion: z.literal(POLICY_EVALUATION_SNAPSHOT_SCHEMA_VERSION),
    sealedAt: PolicyEvaluationTimeSchema,
    sealedByPrincipalId: OpaqueIdSchema,
    jobId: OpaqueIdSchema,
    attemptId: OpaqueIdSchema,
    workerId: OpaqueIdSchema,
    leaseId: OpaqueIdSchema,
    fencingToken: z.number().int().positive().safe(),
    recoveryEpoch: z.number().int().nonnegative().safe(),
    recordedAt: PolicyEvaluationTimeSchema,
  })
  .strict()
  .superRefine((value, context) => {
    definitionCheck(value, context);
    if (context.issues.length > 0) return;
    if (
      policyEvaluationTimestampOrderKey(value.sealedAt) <
        policyEvaluationTimestampOrderKey(value.capturedAt) ||
      policyEvaluationTimestampOrderKey(value.recordedAt) <
        policyEvaluationTimestampOrderKey(value.sealedAt)
    )
      context.addIssue({
        code: "custom",
        message: "Publication receipts must follow contained capture and database seal cuts",
      });
  });

/** Complete transport/storage set; integrity validation also recomputes every page/root digest. */
export const PolicyEvaluationSnapshotPageSetSchema = z
  .object({
    definition: PolicyEvaluationSnapshotDefinitionSchema,
    scope: EvidenceScopeSchema,
    definitionSha256: Sha256Schema,
    pages: z
      .array(PolicyEvaluationSnapshotPageSchema)
      .min(1)
      .max(MAX_POLICY_EVALUATION_SNAPSHOT_PAGES),
  })
  .strict()
  .superRefine((value, context) => {
    if (context.issues.length > 0) return;
    const same = (left: unknown, right: unknown) =>
      serializeEvaluationCanonicalJson(left) === serializeEvaluationCanonicalJson(right);
    if (value.pages.length !== value.definition.pages.length)
      context.addIssue({ code: "custom", message: "All snapshot pages must be retained" });
    for (const [index, page] of value.pages.entries()) {
      const descriptor = value.definition.pages[index];
      if (
        !descriptor ||
        page.pageIndex !== index ||
        page.snapshotId !== value.definition.snapshotId ||
        !same(page.scope, value.scope) ||
        !same(page.request, value.definition.request) ||
        page.inputSha256 !== value.definition.inputSha256 ||
        page.inputByteLength !== value.definition.inputByteLength ||
        page.frameCount !== value.definition.frameCount ||
        page.definitionSha256 !== descriptor.definitionSha256 ||
        page.frames.length !== descriptor.frameCount ||
        page.frames[0]?.frameIndex !== descriptor.firstFrameIndex
      )
        context.addIssue({
          code: "custom",
          message: "Every page must bind its exact scoped snapshot descriptor and request",
        });
    }
  });

export type PolicyEvaluationSnapshotDefinition = z.infer<
  typeof PolicyEvaluationSnapshotDefinitionSchema
>;
export type PolicyEvaluationSnapshot = z.infer<typeof PolicyEvaluationSnapshotSchema>;
export type PolicyEvaluationSnapshotReference = z.infer<
  typeof PolicyEvaluationSnapshotReferenceSchema
>;
export type PolicyEvaluationSnapshotPageDefinition = z.infer<
  typeof PolicyEvaluationSnapshotPageDefinitionSchema
>;
export type PolicyEvaluationSnapshotPage = z.infer<typeof PolicyEvaluationSnapshotPageSchema>;
export type PolicyEvaluationSnapshotPageSet = z.infer<typeof PolicyEvaluationSnapshotPageSetSchema>;
