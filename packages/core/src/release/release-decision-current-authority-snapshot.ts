import { createHash } from "node:crypto";
import {
  encodeReleaseDecisionCurrentAuthorityMaterial,
  encodeReleaseDecisionCurrentAuthorityPageDefinition,
  encodeReleaseDecisionCurrentAuthoritySnapshotDefinition,
  encodeReleaseDecisionInputDefinition,
  MAX_RELEASE_DECISION_AUTHORITY_MATERIAL_BYTES,
  MAX_RELEASE_DECISION_AUTHORITY_PAGES,
  RELEASE_DECISION_AUTHORITY_FRAME_BYTES,
  RELEASE_DECISION_CURRENT_AUTHORITY_MATERIAL_DOMAIN,
  RELEASE_DECISION_CURRENT_AUTHORITY_MATERIAL_ENCODING,
  RELEASE_DECISION_AUTHORITY_PAGE_SIZE,
  RELEASE_DECISION_CURRENT_AUTHORITY_SCHEMA_VERSION,
  ReleaseDecisionCurrentAuthorityMaterialSchema,
  ReleaseDecisionCurrentAuthorityPageSchema,
  ReleaseDecisionCurrentAuthoritySnapshotSchema,
  type EvidenceScope,
  type ReleaseDecisionCurrentAuthorityMaterial,
  type ReleaseDecisionCurrentAuthorityPage,
  type ReleaseDecisionCurrentAuthoritySnapshot,
  type ReleaseDecisionAuthoritySnapshotReference,
  type ReleaseDecisionInputReference,
  serializeEvaluationCanonicalJson,
  policyEvaluationSourceReferenceKey,
  encodeEvaluationCanonicalJson,
} from "@proofstack/contracts";

import { ReleaseDecisionAuthorityIntegrityError } from "./release-decision-authority-snapshot.js";
import { inspectOwnedPolicyEvaluation } from "./owned-policy-evaluation.js";
import { ReleaseDecisionVerificationBudget } from "./release-decision-verification-budget.js";
import { validateReleaseCandidateRecord } from "./release-candidate-record-validation.js";
import { validateReleasePolicyRecord } from "../policy/release-policy-record-validation.js";
import {
  validateReleasePolicySelectionRecord,
  releasePolicySelectionReference,
  validateReleaseReviewerAuthorityRecord,
  validateReleaseApprovalRecord,
  releaseApprovalReference,
} from "./release-authority-record-validation.js";
function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function same(left: unknown, right: unknown): boolean {
  return serializeEvaluationCanonicalJson(left) === serializeEvaluationCanonicalJson(right);
}
function requireValue(condition: boolean, message: string): asserts condition {
  if (!condition) throw new ReleaseDecisionAuthorityIntegrityError(message);
}
function validateOriginalInput(material: ReleaseDecisionCurrentAuthorityMaterial): void {
  const { schemaVersion: _version, definitionSha256, ...definition } = material.base.input;
  requireValue(
    hash(encodeReleaseDecisionInputDefinition({ scope: material.base.scope, definition })) ===
      definitionSha256,
    "Captured original input digest is invalid",
  );
}
/** Recompute owning immutable definitions, never treat a rehashed caller report as source validation. */
function validateObservedRecords(material: ReleaseDecisionCurrentAuthorityMaterial): void {
  const { base } = material;
  if (base.candidate.state === "observed") validateReleaseCandidateRecord(base.candidate.record);
  for (const source of base.policies)
    if (source.policy.state === "observed") validateReleasePolicyRecord(source.policy.record);
  for (const record of base.selections.records)
    validateReleasePolicySelectionRecord({
      expected: { scope: base.scope, reference: releasePolicySelectionReference(record) },
      record,
    });
  for (const source of base.authorities.records)
    if (source.state === "observed")
      validateReleaseReviewerAuthorityRecord({
        expected: { scope: base.scope, reference: source.reference },
        record: source.record,
      });
  for (const record of base.approvals.records)
    validateReleaseApprovalRecord({
      expected: { scope: base.scope, reference: releaseApprovalReference(record) },
      record,
    });
  for (const source of [
    material.selectionRoot,
    ...material.reviewerCensuses.map((row) => row.binding),
  ])
    if (source.state === "observed")
      requireValue(
        hash(encodeEvaluationCanonicalJson(source.record)) === source.recordSha256,
        "Immutable logical root must retain its complete canonical binding projection",
      );
}
/** Original semantic integrity only. Non-root actor facts still require fixed owning-source reinspection at publication. */
function validateOriginalProofs(material: ReleaseDecisionCurrentAuthorityMaterial): void {
  const budget = new ReleaseDecisionVerificationBudget(material.base.input.verificationLimits);
  for (const [index, source] of material.originals.entries()) {
    if (source.state !== "observed") continue;
    const prior = material.base.policies[index]?.original;
    requireValue(
      prior?.state === "complete",
      "Observed original proof omitted its original result",
    );
    const owned = inspectOwnedPolicyEvaluation({
      expected: {
        scope: material.base.scope,
        request: source.request,
        job: { jobId: source.graph.job.jobId, definitionSha256: source.graph.job.definitionSha256 },
      },
      jobGraph: source.graph,
      snapshot: prior.snapshot,
      pageSet: source.pageSet,
      evaluation: prior.evaluation,
      capturedAt: material.base.capturedAt,
      budget,
    });
    const witnesses = [...owned.originalSourceWitnesses].sort((a, b) => {
      const left = policyEvaluationSourceReferenceKey(a.entry.source),
        right = policyEvaluationSourceReferenceKey(b.entry.source);
      return left < right ? -1 : left > right ? 1 : 0;
    });
    requireValue(
      same(
        witnesses,
        source.actors.sources.map((row) => row.witness),
      ) &&
        source.actors.candidate.authorPrincipalId === owned.candidate.createdByPrincipalId &&
        source.actors.policy.authorPrincipalId === owned.policy.publishedByPrincipalId,
      "Original actor witnesses/authors must retain the actual validated original seal",
    );
  }
}
function assurance(material: ReleaseDecisionCurrentAuthorityMaterial) {
  return {
    reviewAuthorityAssurances: [
      ...new Set(
        material.base.authorities.records.flatMap((source) =>
          source.state === "observed" ? [source.record.assurance] : [],
        ),
      ),
    ].sort(),
    hasUnavailableReviewerAuthority:
      material.base.authorities.records.some((source) => source.state !== "observed") ||
      material.reviewerCensuses.some(
        (source) =>
          source.state !== "complete" ||
          source.binding.state !== "observed" ||
          source.binding.record.authorityId !== source.reference.authorityId,
      ),
  };
}

/** Captured current-cut encoding only. Actual private authentication and still-held native publication guards remain mandatory. */
export function prepareReleaseDecisionCurrentAuthoritySnapshot(
  input: ReleaseDecisionCurrentAuthorityMaterial,
): {
  readonly snapshot: ReleaseDecisionCurrentAuthoritySnapshot;
  readonly pages: readonly ReleaseDecisionCurrentAuthorityPage[];
} {
  try {
    const material = ReleaseDecisionCurrentAuthorityMaterialSchema.parse(input);
    validateOriginalInput(material);
    validateObservedRecords(material);
    validateOriginalProofs(material);
    const bytes = encodeReleaseDecisionCurrentAuthorityMaterial({
      scope: material.base.scope,
      material,
    });
    requireValue(
      bytes.byteLength <= MAX_RELEASE_DECISION_AUTHORITY_MATERIAL_BYTES,
      "Authority material exceeds its encoded byte ceiling",
    );
    const materialSha256 = hash(bytes);
    const frames = Array.from(
      { length: Math.ceil(bytes.byteLength / RELEASE_DECISION_AUTHORITY_FRAME_BYTES) },
      (_, index) => ({
        frameIndex: index,
        dataBase64url: Buffer.from(
          bytes.subarray(
            index * RELEASE_DECISION_AUTHORITY_FRAME_BYTES,
            (index + 1) * RELEASE_DECISION_AUTHORITY_FRAME_BYTES,
          ),
        ).toString("base64url"),
      }),
    );
    const inputReference = {
      decisionInputRequestId: material.base.input.decisionInputRequestId,
      definitionSha256: material.base.input.definitionSha256,
    };
    const pages: ReleaseDecisionCurrentAuthorityPage[] = [];
    for (let first = 0; first < frames.length; first += RELEASE_DECISION_AUTHORITY_PAGE_SIZE) {
      const definition = {
        authoritySnapshotId: material.base.authoritySnapshotId,
        decisionId: material.base.decisionId,
        input: inputReference,
        materialSha256,
        materialByteLength: bytes.byteLength,
        frameCount: frames.length,
        pageIndex: pages.length,
        frames: frames.slice(first, first + RELEASE_DECISION_AUTHORITY_PAGE_SIZE),
      };
      pages.push(
        ReleaseDecisionCurrentAuthorityPageSchema.parse({
          ...definition,
          scope: material.base.scope,
          schemaVersion: RELEASE_DECISION_CURRENT_AUTHORITY_SCHEMA_VERSION,
          definitionSha256: hash(
            encodeReleaseDecisionCurrentAuthorityPageDefinition({
              scope: material.base.scope,
              definition,
            }),
          ),
        }),
      );
    }
    const definition = {
      authoritySnapshotId: material.base.authoritySnapshotId,
      decisionId: material.base.decisionId,
      scope: material.base.scope,
      input: inputReference,
      capturedAt: material.base.capturedAt,
      recoveryEpoch: material.base.recoveryEpoch,
      materialSha256,
      materialByteLength: bytes.byteLength,
      frameCount: frames.length,
      ...assurance(material),
      pages: pages.map((page) => ({
        pageIndex: page.pageIndex,
        definitionSha256: page.definitionSha256,
        firstFrameIndex: page.pageIndex * RELEASE_DECISION_AUTHORITY_PAGE_SIZE,
        frameCount: page.frames.length,
      })),
    };
    return {
      snapshot: ReleaseDecisionCurrentAuthoritySnapshotSchema.parse({
        ...definition,
        schemaVersion: RELEASE_DECISION_CURRENT_AUTHORITY_SCHEMA_VERSION,
        definitionSha256: hash(
          encodeReleaseDecisionCurrentAuthoritySnapshotDefinition({
            scope: material.base.scope,
            definition,
          }),
        ),
      }),
      pages,
    };
  } catch (cause) {
    if (cause instanceof ReleaseDecisionAuthorityIntegrityError) throw cause;
    throw new ReleaseDecisionAuthorityIntegrityError("Invalid authority snapshot material", {
      cause,
    });
  }
}

/** Reconstruct complete captured 0.2 data and original evidence; never authenticate or grant later publication. */
export function decodeReleaseDecisionCurrentAuthoritySnapshot(input: {
  readonly expected: {
    readonly scope: EvidenceScope;
    readonly snapshot: ReleaseDecisionAuthoritySnapshotReference;
    readonly decisionId: string;
    readonly input: ReleaseDecisionInputReference;
  };
  readonly snapshot: unknown;
  readonly pages: readonly unknown[];
}): ReleaseDecisionCurrentAuthorityMaterial {
  try {
    const snapshot = ReleaseDecisionCurrentAuthoritySnapshotSchema.parse(input.snapshot);
    const { schemaVersion: _version, definitionSha256, ...definition } = snapshot;
    requireValue(
      same(snapshot.scope, input.expected.scope) &&
        snapshot.authoritySnapshotId === input.expected.snapshot.authoritySnapshotId &&
        definitionSha256 === input.expected.snapshot.definitionSha256 &&
        snapshot.decisionId === input.expected.decisionId &&
        same(snapshot.input, input.expected.input),
      "Authority snapshot must bind the expected exact original owner",
    );
    requireValue(
      hash(
        encodeReleaseDecisionCurrentAuthoritySnapshotDefinition({
          scope: snapshot.scope,
          definition,
        }),
      ) === definitionSha256,
      "Authority header digest is invalid",
    );
    requireValue(
      Array.isArray(input.pages) &&
        input.pages.length === snapshot.pages.length &&
        input.pages.length <= MAX_RELEASE_DECISION_AUTHORITY_PAGES,
      "Complete original authority pages are required",
    );
    const chunks: Buffer[] = [];
    let total = 0;
    for (const [index, value] of input.pages.entries()) {
      const page = ReleaseDecisionCurrentAuthorityPageSchema.parse(value);
      const {
        scope,
        schemaVersion: _pageVersion,
        definitionSha256: pageSha256,
        ...pageDefinition
      } = page;
      requireValue(
        same(scope, snapshot.scope) &&
          page.authoritySnapshotId === snapshot.authoritySnapshotId &&
          page.decisionId === snapshot.decisionId &&
          same(page.input, snapshot.input) &&
          page.materialSha256 === snapshot.materialSha256 &&
          page.materialByteLength === snapshot.materialByteLength &&
          page.frameCount === snapshot.frameCount &&
          page.pageIndex === index,
        "Authority pages cannot be reordered, substituted or rebound",
      );
      requireValue(
        snapshot.pages[index]?.definitionSha256 === pageSha256 &&
          hash(
            encodeReleaseDecisionCurrentAuthorityPageDefinition({
              scope,
              definition: pageDefinition,
            }),
          ) === pageSha256,
        "Authority page digest is invalid",
      );
      for (const frame of page.frames) {
        const chunk = Buffer.from(frame.dataBase64url, "base64url");
        total += chunk.byteLength;
        requireValue(
          total <= snapshot.materialByteLength &&
            total <= MAX_RELEASE_DECISION_AUTHORITY_MATERIAL_BYTES,
          "Authority frame bytes exceed the retained ceiling",
        );
        chunks.push(chunk);
      }
    }
    requireValue(total === snapshot.materialByteLength, "Authority material cannot be truncated");
    const bytes = Buffer.concat(chunks, total);
    requireValue(hash(bytes) === snapshot.materialSha256, "Authority material digest is invalid");
    const envelope: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    requireValue(
      typeof envelope === "object" && envelope !== null && !Array.isArray(envelope),
      "Authority material requires its exact domain envelope",
    );
    const record = envelope as Record<string, unknown>;
    requireValue(
      Object.keys(record).length === 5 &&
        ["definitionDomain", "encodingVersion", "schemaVersion", "scope", "material"].every((key) =>
          Object.hasOwn(record, key),
        ) &&
        record["definitionDomain"] === RELEASE_DECISION_CURRENT_AUTHORITY_MATERIAL_DOMAIN &&
        record["encodingVersion"] === RELEASE_DECISION_CURRENT_AUTHORITY_MATERIAL_ENCODING &&
        record["schemaVersion"] === RELEASE_DECISION_CURRENT_AUTHORITY_SCHEMA_VERSION &&
        same(record["scope"], snapshot.scope),
      "Authority material domain/version/scope is invalid",
    );
    const material = ReleaseDecisionCurrentAuthorityMaterialSchema.parse(record["material"]);
    validateOriginalInput(material);
    validateObservedRecords(material);
    validateOriginalProofs(material);
    requireValue(
      material.base.authoritySnapshotId === snapshot.authoritySnapshotId &&
        material.base.decisionId === snapshot.decisionId &&
        material.base.capturedAt === snapshot.capturedAt &&
        material.base.recoveryEpoch === snapshot.recoveryEpoch &&
        same(
          {
            decisionInputRequestId: material.base.input.decisionInputRequestId,
            definitionSha256: material.base.input.definitionSha256,
          },
          snapshot.input,
        ),
      "Authority material must retain original header identity, native cut and epoch",
    );
    requireValue(
      same(assurance(material), {
        reviewAuthorityAssurances: snapshot.reviewAuthorityAssurances,
        hasUnavailableReviewerAuthority: snapshot.hasUnavailableReviewerAuthority,
      }),
      "Authority assurance summary cannot hide synthetic or unavailable records",
    );
    requireValue(
      Buffer.from(
        encodeReleaseDecisionCurrentAuthorityMaterial({ scope: material.base.scope, material }),
      ).equals(bytes),
      "Authority material must retain exact canonical UTF-8 bytes",
    );
    return material;
  } catch (cause) {
    if (cause instanceof ReleaseDecisionAuthorityIntegrityError) throw cause;
    throw new ReleaseDecisionAuthorityIntegrityError("Invalid original authority snapshot/pages", {
      cause,
    });
  }
}
