import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ReleaseDecisionAuthorityMaterialSchema } from "./release-decision-authority-material.js";
import {
  ReleaseDecisionCurrentAuthorityMaterialSchema,
  type ReleaseDecisionCurrentAuthorityMaterial,
} from "./release-decision-current-authority-material.js";
import {
  ReleaseDecisionControlObservationSchema,
  type ReleaseDecisionControlObservation,
} from "./release-decision-current-authority-sources.js";
import { serializeEvaluationCanonicalJson } from "./evaluation-definition-encoding.js";

const vectors = JSON.parse(
  readFileSync(
    new URL("../vectors/release-decision-authority-snapshot-v1.json", import.meta.url),
    "utf8",
  ),
) as { vectors: { material: unknown }[] };
const key = (v: unknown) => serializeEvaluationCanonicalJson(v);
function first<T>(values: readonly T[]): T {
  const value = values[0];
  if (value === undefined) throw new Error("Missing required synthetic fixture row");
  return value;
}
type CapturedControl = ReleaseDecisionControlObservation & {
  content: Extract<ReleaseDecisionControlObservation["content"], { state: "captured" }>;
};
function requireCapturedControls(
  value: ReleaseDecisionCurrentAuthorityMaterial,
): asserts value is ReleaseDecisionCurrentAuthorityMaterial & { controls: CapturedControl[] } {
  if (!value.controls.every((row) => row.content.state === "captured"))
    throw new Error("Missing captured fixture controls");
}
/** Synthetic unavailable source views; these are contract data, never authenticated approval/publication. */
function fixture(index = 0): ReleaseDecisionCurrentAuthorityMaterial {
  const base = ReleaseDecisionAuthorityMaterialSchema.parse(
    structuredClone(vectors.vectors[index]?.material),
  );
  base.usage.records = base.input.verificationLimits.maxAcquisitionRecords;
  base.usage.recordBytes = base.input.verificationLimits.maxAcquisitionRecordBytes;
  const roots = new Map();
  for (const row of base.authorities.records) {
    const { installationId, gateTargetId, reviewerPrincipalId, authorityId } = row.reference;
    const reference = { installationId, gateTargetId, reviewerPrincipalId, authorityId };
    roots.set(key(reference), {
      reference,
      state: "unavailable",
      binding: {
        state: "unavailable",
        reference: { installationId, gateTargetId, reviewerPrincipalId },
      },
    });
  }
  const credentials = new Map();
  credentials.set(
    key({
      kind: "service_credential",
      principalId: base.publisher.principalId,
      credentialId: base.publisher.credentialId,
    }),
    {
      state: "missing",
      reference: {
        kind: "service_credential",
        principalId: base.publisher.principalId,
        credentialId: base.publisher.credentialId,
      },
    },
  );
  for (const approval of base.approvals.records) {
    const reference = {
      kind: "oidc_session",
      principalId: approval.reviewer.principalId,
      credentialId: approval.reviewer.credentialId,
    };
    credentials.set(key(reference), { state: "missing", reference });
  }
  return ReleaseDecisionCurrentAuthorityMaterialSchema.parse({
    schemaVersion: "0.2",
    base,
    selectionRoot: {
      state: "unavailable",
      reference: {
        installationId: base.input.selection.installationId,
        gateTargetId: base.input.selection.gateTargetId,
      },
    },
    reviewerCensuses: [...roots].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, v]) => v),
    credentials: [...credentials].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, v]) => v),
    originals: base.policies.map((source) => ({
      state: "unavailable",
      request: source.request,
      reason: "original_unresolved",
    })),
    controls: [],
  });
}
function controlFixture() {
  const value = fixture(3),
    approval = value.base.approvals.records[0];
  if (!approval) throw new Error("Missing synthetic approval");
  const reference = {
    artifactId: "artifact_control",
    classification: "internal" as const,
    sha256: "a".repeat(64),
    sizeBytes: 10,
    mediaType: "application/json",
  };
  approval.kind = "rule_exception";
  approval.compensatingControls = [reference];
  const catalog = {
    metadata: {
      schemaVersion: "0.1",
      scope: value.base.scope,
      contentReference: reference,
      state: "available",
      createdAt: "2026-10-15T12:00:00.000001Z",
      availableAt: "2026-10-15T12:00:01.000001Z",
      redaction: { status: "not_required" },
      retention: { mode: "expire", expiresAt: "2026-10-15T12:10:00.000001Z" },
    },
    ownership: null,
    recordSha256: "b".repeat(64),
  };
  value.controls = [
    ReleaseDecisionControlObservationSchema.parse({
      approval: { approvalId: approval.approvalId, definitionSha256: approval.definitionSha256 },
      controlIndex: 0,
      scope: value.base.scope,
      reference,
      content: {
        state: "captured",
        startedAt: "2026-10-15T12:00:02.000001Z",
        completedAt: "2026-10-15T12:00:03.000001Z",
        catalog,
        observation: {
          status: "verified",
          sha256: reference.sha256,
          sizeBytes: reference.sizeBytes,
        },
      },
      underGuards: { state: "observed", record: catalog },
    }),
  ];
  requireCapturedControls(value);
  return value;
}
describe("complete versioned current authority source contract, not authentication", () => {
  it("preserves all sixteen controls in original numeric order and rejects reordered, missing or duplicate occurrences", () => {
    const value = controlFixture(),
      approval = first(value.base.approvals.records),
      original = structuredClone(first(value.controls));
    approval.compensatingControls = Array.from({ length: 16 }, (_, index) => ({
      ...original.reference,
      artifactId: `artifact_control_${String(index).padStart(2, "0")}`,
    }));
    value.controls = approval.compensatingControls.map((reference, index) => {
      const control = structuredClone(original);
      control.controlIndex = index;
      control.reference = reference;
      if (control.content.catalog === null || control.underGuards.state !== "observed")
        throw new Error("Missing structural control catalog");
      control.content.catalog.metadata.contentReference = reference;
      control.underGuards.record.metadata.contentReference = reference;
      return control;
    });
    expect(ReleaseDecisionCurrentAuthorityMaterialSchema.safeParse(value).success).toBe(true);
    const reordered = structuredClone(value);
    reordered.controls.sort((a, b) =>
      key([a.approval.approvalId, a.controlIndex]) < key([b.approval.approvalId, b.controlIndex])
        ? -1
        : 1,
    );
    expect(ReleaseDecisionCurrentAuthorityMaterialSchema.safeParse(reordered).success).toBe(false);
    const missing = structuredClone(value);
    missing.controls.pop();
    expect(ReleaseDecisionCurrentAuthorityMaterialSchema.safeParse(missing).success).toBe(false);
    const duplicate = structuredClone(value);
    duplicate.controls[15] = structuredClone(first(duplicate.controls));
    expect(ReleaseDecisionCurrentAuthorityMaterialSchema.safeParse(duplicate).success).toBe(false);
  });
  it.each([0, 1, 2, 3])(
    "preserves old historical component %i and explicit unknown current sources",
    (index) => {
      const value = fixture(index),
        before = structuredClone(value);
      expect(ReleaseDecisionCurrentAuthorityMaterialSchema.parse(value)).toEqual(before);
      expect(ReleaseDecisionAuthorityMaterialSchema.parse(value.base)).toEqual(value.base);
      expect(value.credentials.every((row) => row.state === "missing")).toBe(true);
    },
  );
  it.each(["credentials", "originals", "reviewerCensuses"] as const)(
    "rejects an omitted %s inventory",
    (field) => {
      const value = fixture(3);
      value[field] = [];
      expect(ReleaseDecisionCurrentAuthorityMaterialSchema.safeParse(value).success).toBe(false);
    },
  );
  it.each(["credential", "reviewer", "original"])(
    "rejects a duplicate %s source rather than favorably deduplicating",
    (kind) => {
      const value = fixture(3);
      if (kind === "credential") value.credentials.push(structuredClone(first(value.credentials)));
      if (kind === "reviewer")
        value.reviewerCensuses.push(structuredClone(first(value.reviewerCensuses)));
      if (kind === "original") value.originals.push(structuredClone(first(value.originals)));
      expect(ReleaseDecisionCurrentAuthorityMaterialSchema.safeParse(value).success).toBe(false);
    },
  );
  it("rejects another login used in place of the original actual receipt", () => {
    const value = fixture(3),
      credential = value.credentials.find((row) => row.reference.kind === "oidc_session");
    if (!credential) throw new Error("Missing reviewer credential");
    credential.reference.credentialId = "session_favorable_new";
    expect(ReleaseDecisionCurrentAuthorityMaterialSchema.safeParse(value).success).toBe(false);
  });
  it("retains a native secret-free publisher credential without claiming private authentication", () => {
    const value = fixture(),
      reference = value.credentials[0]?.reference;
    if (reference?.kind !== "service_credential") throw new Error("Missing publisher credential");
    value.credentials = [
      {
        state: "observed",
        reference,
        record: {
          schemaVersion: "0.1",
          kind: "service_credential",
          principalId: reference.principalId,
          credentialId: reference.credentialId,
          tenantId: value.base.scope.tenantId,
          createdAt: "2026-10-15T11:59:00.000001Z",
          expiresAt: "2026-10-15T12:10:00.000001Z",
          revokedAt: null,
          revocationReason: null,
        },
      },
    ];
    expect(ReleaseDecisionCurrentAuthorityMaterialSchema.safeParse(value).success).toBe(true);
  });
  it.each(["token", "cookie", "privateProof", "verifier"])(
    "rejects a transferable %s field",
    (field) => {
      const value = fixture();
      Reflect.set(first(value.credentials), field, "forbidden_source_value");
      expect(ReleaseDecisionCurrentAuthorityMaterialSchema.safeParse(value).success).toBe(false);
    },
  );
  it("retains changed logical selection ownership for a hold rather than rewriting the original", () => {
    const value = fixture();
    value.selectionRoot = {
      state: "observed",
      reference: value.selectionRoot.reference,
      recordSha256: "a".repeat(64),
      record: {
        ...value.selectionRoot.reference,
        scope: value.base.scope,
        selectionId: "selection_changed",
      },
    };
    expect(ReleaseDecisionCurrentAuthorityMaterialSchema.safeParse(value).success).toBe(true);
    value.selectionRoot.record.scope.environmentId = "env_other";
    expect(ReleaseDecisionCurrentAuthorityMaterialSchema.safeParse(value).success).toBe(false);
  });
  it("requires all declared compensating-control occurrences, not only supporting actions", () => {
    const value = controlFixture();
    expect(ReleaseDecisionCurrentAuthorityMaterialSchema.safeParse(value).success).toBe(true);
    value.controls = [];
    expect(ReleaseDecisionCurrentAuthorityMaterialSchema.safeParse(value).success).toBe(false);
  });
  it.each(["scope", "digest", "index", "approval"])("rejects a substituted control %s", (kind) => {
    const value = controlFixture(),
      control = value.controls[0];
    if (!control) throw new Error("Missing control");
    if (kind === "scope") control.scope.environmentId = "env_other";
    if (kind === "digest") control.approval.definitionSha256 = "c".repeat(64);
    if (kind === "index") control.controlIndex = 1;
    if (kind === "approval") control.approval.approvalId = "approval_other";
    expect(ReleaseDecisionCurrentAuthorityMaterialSchema.safeParse(value).success).toBe(false);
  });
  it("preserves a later changed catalog instead of treating earlier verified content as fresh authority", () => {
    const value = controlFixture(),
      control = value.controls[0];
    if (!control) throw new Error("Missing control");
    control.underGuards = { state: "missing" };
    expect(ReleaseDecisionCurrentAuthorityMaterialSchema.safeParse(value).success).toBe(true);
  });
  it.each(["before_input", "after_cut"])("rejects control capture %s", (kind) => {
    const value = controlFixture(),
      control = value.controls[0];
    if (!control) throw new Error("Missing control");
    if (kind === "before_input") control.content.startedAt = "2026-10-15T11:00:00.000001Z";
    else control.content.completedAt = "2026-10-16T00:00:00.000001Z";
    expect(ReleaseDecisionCurrentAuthorityMaterialSchema.safeParse(value).success).toBe(false);
  });
  it.each(["records", "recordBytes"] as const)(
    "requires the new sources in the original aggregate %s admission",
    (field) => {
      const value = fixture();
      value.base.usage[field] = 0;
      expect(ReleaseDecisionCurrentAuthorityMaterialSchema.safeParse(value).success).toBe(false);
    },
  );
  it.each(["records", "recordBytes"] as const)(
    "rejects one below the independently enumerated retained %s while legacy admission still fits",
    (field) => {
      const v2 = JSON.parse(
        readFileSync(
          new URL(
            "../vectors/release-decision-current-authority-snapshot-v2.json",
            import.meta.url,
          ),
          "utf8",
        ),
      );
      const value = ReleaseDecisionCurrentAuthorityMaterialSchema.parse(v2.vectors[0].material);
      value.base.usage[field]--;
      expect(ReleaseDecisionAuthorityMaterialSchema.safeParse(value.base).success).toBe(true);
      expect(ReleaseDecisionCurrentAuthorityMaterialSchema.safeParse(value).success).toBe(false);
    },
  );
  it.each(["digest", "size", "scope", "missing_catalog", "missing_content", "expiry", "order"])(
    "rejects inconsistent retained control %s",
    (kind) => {
      const value = controlFixture(),
        control = first(value.controls);
      const catalog = control.content.catalog;
      if (!catalog || control.content.observation.status !== "verified")
        throw new Error("Missing verified synthetic control");
      if (kind === "digest") control.content.observation.sha256 = "c".repeat(64);
      if (kind === "size") control.content.observation.sizeBytes++;
      if (kind === "scope") catalog.metadata.scope.environmentId = "env_other";
      if (kind === "missing_catalog") control.content.catalog = null;
      if (kind === "missing_content") control.content.observation = { status: "missing" };
      if (kind === "expiry")
        catalog.metadata.retention = { mode: "expire", expiresAt: control.content.completedAt };
      if (kind === "order") control.content.completedAt = "2026-10-15T12:00:01.000001Z";
      expect(ReleaseDecisionCurrentAuthorityMaterialSchema.safeParse(value).success).toBe(false);
    },
  );
  it("retains known tombstoned under-guard catalog after an earlier successful content capture", () => {
    const value = controlFixture(),
      control = first(value.controls),
      catalog = control.content.catalog;
    if (!catalog) throw new Error("Missing retained catalog");
    control.underGuards = {
      state: "observed",
      record: {
        ...structuredClone(catalog),
        recordSha256: "c".repeat(64),
        metadata: {
          ...catalog.metadata,
          state: "tombstoned",
          tombstonedAt: control.content.completedAt,
        },
      },
    };
    expect(ReleaseDecisionCurrentAuthorityMaterialSchema.safeParse(value).success).toBe(true);
  });
  it("retains a correctly bound expired old reviewer session as historical source state", () => {
    const value = fixture(3),
      approval = first(value.base.approvals.records),
      actor = first(value.base.approvals.actors);
    const row = value.credentials.find((row) => row.reference.kind === "oidc_session");
    if (!row || actor.identity.kind !== "oidc_binding")
      throw new Error("Missing original synthetic reviewer");
    const expiresAt = new Date(Date.parse(approval.reviewer.authenticatedAt) + 60000).toISOString();
    const index = value.credentials.indexOf(row);
    value.credentials[index] = {
      state: "observed",
      reference: row.reference,
      record: {
        schemaVersion: "0.1",
        kind: "oidc_session",
        principalId: row.reference.principalId,
        credentialId: row.reference.credentialId,
        bindingId: actor.identity.bindingId,
        tenantId: value.base.scope.tenantId,
        createdAt: approval.reviewer.authenticatedAt,
        absoluteExpiresAt: expiresAt,
        idleExpiresAt: expiresAt,
        idleLifetimeSeconds: 60,
        lastUsedAt: null,
        useCount: 0,
        revokedAt: null,
        revocationReason: null,
      },
    };
    expect(ReleaseDecisionCurrentAuthorityMaterialSchema.safeParse(value).success).toBe(true);
    const credential = value.credentials[index];
    if (credential?.state !== "observed" || credential.record.kind !== "oidc_session")
      throw new Error("Missing bound session");
    credential.record.bindingId = "binding_favorable_other";
    expect(ReleaseDecisionCurrentAuthorityMaterialSchema.safeParse(value).success).toBe(false);
  });
  it("retains explicit non-inspection without inventing content receipts", () => {
    const value: ReleaseDecisionCurrentAuthorityMaterial = controlFixture(),
      control = first(value.controls);
    control.content = { state: "not_inspected", reason: "authorization_unavailable" };
    expect(ReleaseDecisionCurrentAuthorityMaterialSchema.safeParse(value).success).toBe(true);
    Reflect.set(control.content, "completedAt", value.base.capturedAt);
    expect(ReleaseDecisionCurrentAuthorityMaterialSchema.safeParse(value).success).toBe(false);
  });
  it("still checks exact catalog scope when content was not inspected", () => {
    const value: ReleaseDecisionCurrentAuthorityMaterial = controlFixture(),
      control = first(value.controls);
    control.content = { state: "not_inspected", reason: "acquisition_unavailable" };
    if (control.underGuards.state !== "observed") throw new Error("Missing catalog");
    control.underGuards.record.metadata.scope.environmentId = "env_other";
    expect(ReleaseDecisionCurrentAuthorityMaterialSchema.safeParse(value).success).toBe(false);
  });
  it("requires retained inactive/non-supporting facts for skipped controls", () => {
    const value: ReleaseDecisionCurrentAuthorityMaterial = controlFixture(),
      control = first(value.controls),
      approval = first(value.base.approvals.records);
    control.content = { state: "not_inspected", reason: "action_not_approval" };
    expect(ReleaseDecisionCurrentAuthorityMaterialSchema.safeParse(value).success).toBe(false);
    approval.action = "oppose";
    expect(ReleaseDecisionCurrentAuthorityMaterialSchema.safeParse(value).success).toBe(true);
    control.content = { state: "not_inspected", reason: "approval_inactive" };
    expect(ReleaseDecisionCurrentAuthorityMaterialSchema.safeParse(value).success).toBe(false);
    approval.expiresAt = value.base.capturedAt;
    expect(ReleaseDecisionCurrentAuthorityMaterialSchema.safeParse(value).success).toBe(true);
  });
  it.each(["credential", "identity"])(
    "cannot relabel one physical %s as two independent original owners",
    (kind) => {
      const value = fixture(3),
        original = first(value.base.approvals.records),
        actor = first(value.base.approvals.actors);
      const other = structuredClone(original);
      other.approvalId = original.approvalId + "_b";
      other.reviewer.principalId = "reviewer_other";
      other.reviewer.credentialId =
        kind === "credential" ? original.reviewer.credentialId : "session_other";
      other.authority = {
        ...other.authority,
        authorityId: "authority_other",
        authorityVersionId: "authority_other_v1",
        reviewerPrincipalId: other.reviewer.principalId,
      };
      const identity = {
        ...actor.identity,
        principalId: other.reviewer.principalId,
        bindingId: kind === "identity" ? actor.identity.bindingId : "binding_other",
      };
      value.base.approvals.records.push(other);
      value.base.approvals.actors.push({
        approval: { approvalId: other.approvalId, definitionSha256: other.definitionSha256 },
        identity,
      });
      value.base.identities.push({ state: "missing", reference: identity });
      value.base.authorities.records.push({ state: "missing", reference: other.authority });
      const reference = {
        installationId: other.authority.installationId,
        gateTargetId: other.authority.gateTargetId,
        reviewerPrincipalId: other.reviewer.principalId,
        authorityId: other.authority.authorityId,
      };
      value.reviewerCensuses.push({
        state: "unavailable",
        reference,
        binding: {
          state: "unavailable",
          reference: {
            installationId: reference.installationId,
            gateTargetId: reference.gateTargetId,
            reviewerPrincipalId: reference.reviewerPrincipalId,
          },
        },
      });
      value.reviewerCensuses.sort((a, b) => (key(a.reference) < key(b.reference) ? -1 : 1));
      value.credentials.push({
        state: "missing",
        reference: {
          kind: "oidc_session",
          principalId: other.reviewer.principalId,
          credentialId: other.reviewer.credentialId,
        },
      });
      value.credentials.sort((a, b) => (key(a.reference) < key(b.reference) ? -1 : 1));
      value.base.usage.approvalRecords = 2;
      expect(ReleaseDecisionAuthorityMaterialSchema.safeParse(value.base).success).toBe(true);
      expect(ReleaseDecisionCurrentAuthorityMaterialSchema.safeParse(value).success).toBe(false);
    },
  );
});
