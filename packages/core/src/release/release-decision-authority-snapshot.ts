import { createHash } from "node:crypto";
import {
  encodeReleaseDecisionAuthorityMaterial,
  encodeReleaseDecisionAuthorityPageDefinition,
  encodeReleaseDecisionAuthoritySnapshotDefinition,
  encodeReleaseDecisionInputDefinition,
  MAX_RELEASE_DECISION_AUTHORITY_MATERIAL_BYTES,
  MAX_RELEASE_DECISION_AUTHORITY_PAGES,
  RELEASE_DECISION_AUTHORITY_FRAME_BYTES,
  RELEASE_DECISION_AUTHORITY_MATERIAL_DOMAIN,
  RELEASE_DECISION_AUTHORITY_MATERIAL_ENCODING,
  RELEASE_DECISION_AUTHORITY_PAGE_SIZE,
  RELEASE_DECISION_AUTHORITY_SNAPSHOT_SCHEMA_VERSION,
  ReleaseDecisionAuthorityMaterialSchema,
  ReleaseDecisionAuthorityPageSchema,
  ReleaseDecisionAuthoritySnapshotSchema,
  type EvidenceScope,
  type ReleaseDecisionAuthorityMaterial,
  type ReleaseDecisionAuthorityPage,
  type ReleaseDecisionAuthoritySnapshot,
  type ReleaseDecisionAuthoritySnapshotReference,
  type ReleaseDecisionInputReference,
  serializeEvaluationCanonicalJson,
} from "@proofstack/contracts";

export class ReleaseDecisionAuthorityIntegrityError extends Error {
  readonly code = "release_decision_authority_integrity_invalid";
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ReleaseDecisionAuthorityIntegrityError";
  }
}
function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function same(left: unknown, right: unknown): boolean {
  return serializeEvaluationCanonicalJson(left) === serializeEvaluationCanonicalJson(right);
}
function requireValue(condition: boolean, message: string): asserts condition {
  if (!condition) throw new ReleaseDecisionAuthorityIntegrityError(message);
}
function validateOriginalInput(material: ReleaseDecisionAuthorityMaterial): void {
  const { schemaVersion: _version, definitionSha256, ...definition } = material.input;
  requireValue(
    hash(encodeReleaseDecisionInputDefinition({ scope: material.scope, definition })) ===
      definitionSha256,
    "Captured original input digest is invalid",
  );
}
function assurance(material: ReleaseDecisionAuthorityMaterial) {
  return {
    reviewAuthorityAssurances: [
      ...new Set(
        material.authorities.records.flatMap((source) =>
          source.state === "observed" ? [source.record.assurance] : [],
        ),
      ),
    ].sort(),
    hasUnavailableReviewerAuthority: material.authorities.records.some(
      (source) => source.state !== "observed",
    ),
  };
}

/** Pure historical encoding only; native graph/decision/outbox publication must remain atomic. */
export function prepareReleaseDecisionAuthoritySnapshot(input: ReleaseDecisionAuthorityMaterial): {
  readonly snapshot: ReleaseDecisionAuthoritySnapshot;
  readonly pages: readonly ReleaseDecisionAuthorityPage[];
} {
  try {
    const material = ReleaseDecisionAuthorityMaterialSchema.parse(input);
    validateOriginalInput(material);
    const bytes = encodeReleaseDecisionAuthorityMaterial({ scope: material.scope, material });
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
      decisionInputRequestId: material.input.decisionInputRequestId,
      definitionSha256: material.input.definitionSha256,
    };
    const pages: ReleaseDecisionAuthorityPage[] = [];
    for (let first = 0; first < frames.length; first += RELEASE_DECISION_AUTHORITY_PAGE_SIZE) {
      const definition = {
        authoritySnapshotId: material.authoritySnapshotId,
        decisionId: material.decisionId,
        input: inputReference,
        materialSha256,
        materialByteLength: bytes.byteLength,
        frameCount: frames.length,
        pageIndex: pages.length,
        frames: frames.slice(first, first + RELEASE_DECISION_AUTHORITY_PAGE_SIZE),
      };
      pages.push(
        ReleaseDecisionAuthorityPageSchema.parse({
          ...definition,
          scope: material.scope,
          schemaVersion: RELEASE_DECISION_AUTHORITY_SNAPSHOT_SCHEMA_VERSION,
          definitionSha256: hash(
            encodeReleaseDecisionAuthorityPageDefinition({ scope: material.scope, definition }),
          ),
        }),
      );
    }
    const definition = {
      authoritySnapshotId: material.authoritySnapshotId,
      decisionId: material.decisionId,
      scope: material.scope,
      input: inputReference,
      capturedAt: material.capturedAt,
      recoveryEpoch: material.recoveryEpoch,
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
      snapshot: ReleaseDecisionAuthoritySnapshotSchema.parse({
        ...definition,
        schemaVersion: RELEASE_DECISION_AUTHORITY_SNAPSHOT_SCHEMA_VERSION,
        definitionSha256: hash(
          encodeReleaseDecisionAuthoritySnapshotDefinition({ scope: material.scope, definition }),
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

/** Reconstruct the exact original captured view, never current authentication/publication power. */
export function decodeReleaseDecisionAuthoritySnapshot(input: {
  readonly expected: {
    readonly scope: EvidenceScope;
    readonly snapshot: ReleaseDecisionAuthoritySnapshotReference;
    readonly decisionId: string;
    readonly input: ReleaseDecisionInputReference;
  };
  readonly snapshot: unknown;
  readonly pages: readonly unknown[];
}): ReleaseDecisionAuthorityMaterial {
  try {
    const snapshot = ReleaseDecisionAuthoritySnapshotSchema.parse(input.snapshot);
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
        encodeReleaseDecisionAuthoritySnapshotDefinition({ scope: snapshot.scope, definition }),
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
      const page = ReleaseDecisionAuthorityPageSchema.parse(value);
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
            encodeReleaseDecisionAuthorityPageDefinition({ scope, definition: pageDefinition }),
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
        record["definitionDomain"] === RELEASE_DECISION_AUTHORITY_MATERIAL_DOMAIN &&
        record["encodingVersion"] === RELEASE_DECISION_AUTHORITY_MATERIAL_ENCODING &&
        record["schemaVersion"] === RELEASE_DECISION_AUTHORITY_SNAPSHOT_SCHEMA_VERSION &&
        same(record["scope"], snapshot.scope),
      "Authority material domain/version/scope is invalid",
    );
    const material = ReleaseDecisionAuthorityMaterialSchema.parse(record["material"]);
    validateOriginalInput(material);
    requireValue(
      material.authoritySnapshotId === snapshot.authoritySnapshotId &&
        material.decisionId === snapshot.decisionId &&
        material.capturedAt === snapshot.capturedAt &&
        material.recoveryEpoch === snapshot.recoveryEpoch &&
        same(
          {
            decisionInputRequestId: material.input.decisionInputRequestId,
            definitionSha256: material.input.definitionSha256,
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
        encodeReleaseDecisionAuthorityMaterial({ scope: material.scope, material }),
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
