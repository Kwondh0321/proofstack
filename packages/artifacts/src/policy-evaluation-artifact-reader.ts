import { createHash } from "node:crypto";
import {
  ArtifactContentReferenceSchema,
  type ArtifactMetadata,
  ArtifactMetadataSchema,
  type ArtifactOwnership,
  ArtifactOwnershipSchema,
  type ContentReference,
  ContentReferenceSchema,
  type EvidenceScope,
  EvidenceScopeSchema,
  encodeEvaluationCanonicalJson,
  OpaqueIdSchema,
  PolicyEvaluationTimeSchema,
  policyEvaluationTimestampOrderKey,
  PostgresTimestampSchema,
  type PrincipalContext,
  PrincipalContextSchema,
  Sha256Schema,
  UtcMillisecondTimestampSchema,
} from "@proofstack/contracts";
import {
  type Clock,
  ForbiddenError,
  requireCapability,
  requireEnvironmentAccess,
} from "@proofstack/core";
import {
  ARTIFACT_ENCRYPTION_VERSION,
  ARTIFACT_OBJECT_FORMAT_OVERHEAD_BYTES,
  type ArtifactCatalogEntry,
  type ArtifactCatalogRepository,
  type ArtifactContentDecryptor,
  type ArtifactObjectStore,
  MAX_ENCRYPTED_ARTIFACT_OBJECT_BYTES,
} from "./artifact-ports.js";

export interface PolicyEvaluationArtifactReadInput {
  readonly scope: EvidenceScope;
  readonly principal: PrincipalContext;
  readonly reference: ContentReference;
  readonly evaluationTime: string;
  /** Per-call encrypted object-byte ceiling; not a durable or wire-transfer budget. */
  readonly maxReadBytes: number;
}

export interface PolicyEvaluationArtifactReadDependencies {
  readonly catalog: Pick<ArtifactCatalogRepository, "find">;
  readonly objects: Pick<ArtifactObjectStore, "get">;
  readonly encryption: ArtifactContentDecryptor;
  readonly clock: Clock;
}

export interface PolicyEvaluationArtifactCatalogObservation {
  readonly metadata: ArtifactMetadata;
  readonly ownership: ArtifactOwnership | null;
  /** Complete validated private catalog record hash; no object locator or wrapped key is exposed. */
  readonly recordSha256: string;
}

export type PolicyEvaluationArtifactObservation =
  | { readonly status: "verified"; readonly sha256: string; readonly sizeBytes: number }
  | { readonly status: "missing" }
  | {
      readonly status: "unavailable";
      readonly reason:
        | "reference_unsupported"
        | "record_invalid"
        | "reference_mismatch"
        | "not_yet_available"
        | "reserved"
        | "tombstoned"
        | "purged"
        | "retention_expired"
        | "object_missing"
        | "content_integrity_failed";
    };

export interface PolicyEvaluationArtifactRead {
  readonly scope: EvidenceScope;
  readonly reference: ContentReference;
  readonly evaluationTime: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly catalog: PolicyEvaluationArtifactCatalogObservation | null;
  readonly observation: PolicyEvaluationArtifactObservation;
  readonly usage: {
    readonly catalogReads: number;
    readonly objectReads: number;
    readonly objectBytes: number;
  };
}

export class PolicyEvaluationArtifactReadInputError extends TypeError {
  readonly code = "policy_evaluation_artifact_read_input_invalid";
  constructor(options?: ErrorOptions) {
    super(
      "Artifact observation requires exact authorized scope, reference, evaluation time and read limit",
      options,
    );
    this.name = "PolicyEvaluationArtifactReadInputError";
  }
}

export class PolicyEvaluationArtifactCaptureError extends Error {
  readonly code = "policy_evaluation_artifact_capture_failed";
  constructor(readonly reason: "clock_invalid" | "read_limit" | "source_revision_changed") {
    super(`Policy artifact capture: ${reason}`);
    this.name = "PolicyEvaluationArtifactCaptureError";
  }
}

function record(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).every((key) => keys.includes(key))
  );
}

function canonical(value: unknown): string {
  return Buffer.from(encodeEvaluationCanonicalJson(value)).toString("utf8");
}

function hash(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function base64(value: unknown, size: number): boolean {
  if (typeof value !== "string" || value.length !== Math.ceil((size * 4) / 3)) return false;
  const decoded = Buffer.from(value, "base64url");
  return decoded.byteLength === size && decoded.toString("base64url") === value;
}

/** Fixed catalog inspection; adapters must bound and admit raw JSON before this domain boundary. */
function catalogRecord(value: unknown): ArtifactCatalogEntry | null {
  if (
    !record(value, [
      "createdByPrincipalId",
      "encryption",
      "metadata",
      "objectKey",
      "objectReceipt",
      "ownership",
    ])
  )
    return null;
  const metadata = ArtifactMetadataSchema.safeParse(value["metadata"]);
  const plan = value["encryption"];
  if (
    !metadata.success ||
    !OpaqueIdSchema.safeParse(value["createdByPrincipalId"]).success ||
    typeof value["objectKey"] !== "string" ||
    value["objectKey"].length === 0 ||
    value["objectKey"].length > 1024 ||
    !record(plan, ["version", "contentNonce", "wrappedDataKey"]) ||
    plan["version"] !== ARTIFACT_ENCRYPTION_VERSION ||
    !base64(plan["contentNonce"], 12)
  )
    return null;
  const wrapped = plan["wrappedDataKey"];
  if (
    !record(wrapped, ["algorithm", "ciphertext", "keyId", "nonce", "tag"]) ||
    wrapped["algorithm"] !== "A256GCM" ||
    !OpaqueIdSchema.safeParse(wrapped["keyId"]).success ||
    !base64(wrapped["ciphertext"], 32) ||
    !base64(wrapped["nonce"], 12) ||
    !base64(wrapped["tag"], 16)
  )
    return null;
  const receipt = value["objectReceipt"];
  if (
    receipt !== undefined &&
    (!record(receipt, ["sha256", "sizeBytes"]) ||
      !Sha256Schema.safeParse(receipt["sha256"]).success ||
      receipt["sizeBytes"] !==
        metadata.data.contentReference.sizeBytes + ARTIFACT_OBJECT_FORMAT_OVERHEAD_BYTES)
  )
    return null;
  if (metadata.data.state === "available" && receipt === undefined) return null;
  const times = [
    metadata.data.createdAt,
    metadata.data.availableAt,
    metadata.data.tombstonedAt,
    metadata.data.purgedAt,
  ].filter((time): time is string => time !== undefined);
  if (!times.every((time) => PostgresTimestampSchema.safeParse(time).success)) return null;
  if (
    metadata.data.retention.mode === "expire" &&
    !PostgresTimestampSchema.safeParse(metadata.data.retention.expiresAt).success
  )
    return null;
  const ownership = value["ownership"];
  if (ownership !== undefined) {
    const parsed = ArtifactOwnershipSchema.safeParse(ownership);
    if (
      !parsed.success ||
      parsed.data.artifactId !== metadata.data.contentReference.artifactId ||
      canonical(parsed.data.scope) !== canonical(metadata.data.scope) ||
      policyEvaluationTimestampOrderKey(parsed.data.boundAt) <
        policyEvaluationTimestampOrderKey(metadata.data.createdAt)
    )
      return null;
  }
  if (
    times.some(
      (time, index) =>
        index > 0 &&
        policyEvaluationTimestampOrderKey(time) <
          policyEvaluationTimestampOrderKey(times[index - 1] as string),
    )
  )
    return null;
  // All private and public fields have been checked; preserve receipts and omit only allowed undefined.
  return JSON.parse(JSON.stringify(value)) as ArtifactCatalogEntry;
}

function capture(input: PolicyEvaluationArtifactReadInput): PolicyEvaluationArtifactReadInput {
  try {
    if (
      !record(input, ["scope", "principal", "reference", "evaluationTime", "maxReadBytes"]) ||
      !Number.isInteger(input.maxReadBytes) ||
      input.maxReadBytes < 0 ||
      input.maxReadBytes > MAX_ENCRYPTED_ARTIFACT_OBJECT_BYTES
    )
      throw new TypeError("Invalid artifact observation fields");
    return {
      scope: EvidenceScopeSchema.parse(input.scope),
      principal: PrincipalContextSchema.parse(input.principal),
      reference: ContentReferenceSchema.parse(input.reference),
      evaluationTime: PolicyEvaluationTimeSchema.parse(input.evaluationTime),
      maxReadBytes: input.maxReadBytes,
    };
  } catch (cause) {
    throw new PolicyEvaluationArtifactReadInputError({ cause });
  }
}

/**
 * Authorized exact content observation, not an HTTP boundary, policy verdict or sealed DB cut.
 * Returns no plaintext, key or locator. The future capture composer must supply parent provenance,
 * shared admission/byte accounting and a database revision guard for sealing after this read.
 */
export async function readPolicyEvaluationArtifact(
  input: PolicyEvaluationArtifactReadInput,
  dependencies: PolicyEvaluationArtifactReadDependencies,
): Promise<PolicyEvaluationArtifactRead> {
  const fixed = capture(input);
  const { scope, principal, reference, evaluationTime } = fixed;
  requireCapability(principal, "artifact:read");
  if (principal.tenantId !== scope.tenantId)
    throw new ForbiddenError("Artifact observation scope does not match principal");
  requireEnvironmentAccess(principal, scope.projectId, scope.environmentId);
  if (reference.classification === "restricted")
    requireCapability(principal, "artifact:read:restricted");
  let lastTime: string | undefined;
  const now = () => {
    let timestamp: string;
    try {
      timestamp = UtcMillisecondTimestampSchema.parse(dependencies.clock.now().toISOString());
    } catch {
      throw new PolicyEvaluationArtifactCaptureError("clock_invalid");
    }
    if (lastTime !== undefined && timestamp < lastTime)
      throw new PolicyEvaluationArtifactCaptureError("clock_invalid");
    lastTime = timestamp;
    return timestamp;
  };
  const startedAt = now();
  if (
    policyEvaluationTimestampOrderKey(evaluationTime) > policyEvaluationTimestampOrderKey(startedAt)
  )
    throw new PolicyEvaluationArtifactReadInputError();
  const usage = { catalogReads: 0, objectReads: 0, objectBytes: 0 };
  const unavailable = (
    reason: Extract<PolicyEvaluationArtifactObservation, { status: "unavailable" }>["reason"],
  ): PolicyEvaluationArtifactObservation => ({ status: "unavailable", reason });
  const finish = (
    observation: PolicyEvaluationArtifactObservation,
    catalog: PolicyEvaluationArtifactCatalogObservation | null = null,
  ): PolicyEvaluationArtifactRead => {
    const completedAt = now();
    if (
      observation.status === "verified" &&
      catalog?.metadata.retention.mode === "expire" &&
      policyEvaluationTimestampOrderKey(catalog.metadata.retention.expiresAt) <=
        policyEvaluationTimestampOrderKey(completedAt)
    )
      observation = unavailable("retention_expired");
    return {
      scope,
      reference,
      evaluationTime,
      startedAt,
      completedAt,
      catalog,
      observation,
      usage: { ...usage },
    };
  };
  if (!ArtifactContentReferenceSchema.safeParse(reference).success)
    return finish(unavailable("reference_unsupported"));
  const find = async () => {
    usage.catalogReads++;
    return dependencies.catalog.find(structuredClone(scope), reference.artifactId);
  };
  const raw = await find();
  const observedAt = now();
  if (raw === null) return finish({ status: "missing" });
  const entry = catalogRecord(raw);
  if (!entry) return finish(unavailable("record_invalid"));
  if (canonical(entry.metadata.scope) !== canonical(scope))
    return finish(unavailable("reference_mismatch"));
  if (entry.metadata.contentReference.classification === "restricted")
    requireCapability(principal, "artifact:read:restricted");
  if (canonical(entry.metadata.contentReference) !== canonical(reference))
    return finish(unavailable("reference_mismatch"));
  const recordSha256 = hash(canonical(entry));
  const catalog = {
    metadata: structuredClone(entry.metadata),
    ownership: entry.ownership ? structuredClone(entry.ownership) : null,
    recordSha256,
  };
  const received = [
    entry.metadata.createdAt,
    entry.metadata.availableAt,
    entry.metadata.tombstonedAt,
    entry.metadata.purgedAt,
    entry.ownership?.boundAt,
  ];
  if (
    received.some(
      (time) =>
        time !== undefined &&
        policyEvaluationTimestampOrderKey(time) > policyEvaluationTimestampOrderKey(observedAt),
    )
  )
    return finish(unavailable("not_yet_available"), catalog);
  if (
    policyEvaluationTimestampOrderKey(entry.metadata.createdAt) >
      policyEvaluationTimestampOrderKey(evaluationTime) ||
    (entry.metadata.availableAt !== undefined &&
      policyEvaluationTimestampOrderKey(entry.metadata.availableAt) >
        policyEvaluationTimestampOrderKey(evaluationTime))
  )
    return finish(unavailable("not_yet_available"), catalog);
  if (entry.metadata.state !== "available")
    return finish(unavailable(entry.metadata.state), catalog);
  if (
    entry.metadata.retention.mode === "expire" &&
    policyEvaluationTimestampOrderKey(entry.metadata.retention.expiresAt) <=
      policyEvaluationTimestampOrderKey(observedAt)
  )
    return finish(unavailable("retention_expired"), catalog);
  const expectedBytes = reference.sizeBytes + ARTIFACT_OBJECT_FORMAT_OVERHEAD_BYTES;
  if (expectedBytes > fixed.maxReadBytes)
    throw new PolicyEvaluationArtifactCaptureError("read_limit");
  usage.objectReads++;
  const supplied = await dependencies.objects.get(entry.objectKey);
  let observation: PolicyEvaluationArtifactObservation;
  if (supplied === null) observation = unavailable("object_missing");
  else if (!(supplied instanceof Uint8Array)) observation = unavailable("content_integrity_failed");
  else {
    usage.objectBytes = supplied.byteLength;
    if (supplied.byteLength > fixed.maxReadBytes)
      throw new PolicyEvaluationArtifactCaptureError("read_limit");
    const encrypted = Uint8Array.from(supplied);
    if (encrypted.byteLength !== expectedBytes || hash(encrypted) !== entry.objectReceipt?.sha256)
      observation = unavailable("content_integrity_failed");
    else {
      // Crypto also wraps key-provider outages. Propagate failures; an outage is not an
      // authoritative missing/corrupt-content observation or a completed indeterminate evaluation.
      const plaintext = await dependencies.encryption.decrypt(
        structuredClone(entry.metadata),
        structuredClone(entry.encryption),
        encrypted,
      );
      if (!(plaintext instanceof Uint8Array)) observation = unavailable("content_integrity_failed");
      else {
        const owned = Uint8Array.from(plaintext);
        const sha256 = hash(owned);
        const sizeBytes = owned.byteLength;
        owned.fill(0);
        observation =
          sha256 === reference.sha256 && sizeBytes === reference.sizeBytes
            ? { status: "verified", sha256, sizeBytes }
            : unavailable("content_integrity_failed");
      }
    }
  }
  // This detects a changed catalog during object I/O, not a lock or revision guard for later sealing.
  const after = catalogRecord(await find());
  if (!after || hash(canonical(after)) !== recordSha256)
    throw new PolicyEvaluationArtifactCaptureError("source_revision_changed");
  return finish(observation, catalog);
}
