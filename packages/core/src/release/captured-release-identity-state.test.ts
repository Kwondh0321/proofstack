import {
  ReleaseDecisionCredentialObservationSchema,
  ReleaseDecisionIdentityObservationSchema,
  ReleaseDecisionIdentityReferenceSchema,
  ReleaseDecisionPublisherReceiptSchema,
  type ResourceScope,
} from "@proofstack/contracts";
import { describe, expect, it } from "vitest";
import {
  inspectCapturedReleaseIdentityState,
  InvalidCapturedReleaseIdentityError,
  type CapturedReleaseIdentityOperation,
} from "./captured-release-identity-state.js";
import {
  ReleaseDecisionVerificationBudget,
  ReleaseDecisionVerificationBudgetError,
} from "./release-decision-verification-budget.js";

function fixture() {
  const scope = {
    tenantId: "tenant_example",
    projectId: "project_example",
    environmentId: "env_staging",
  };
  const identity = ReleaseDecisionIdentityReferenceSchema.parse({
    kind: "oidc_binding",
    principalId: "user_reviewer",
    bindingId: "binding_original",
  });
  const receipt = ReleaseDecisionPublisherReceiptSchema.parse({
    principalId: identity.principalId,
    principalType: "user",
    authenticationMethod: "oidc",
    authenticatedAt: "2026-10-15T12:00:00.000Z",
    credentialId: "session_original",
    requestId: "request_original",
  });
  const grant = ReleaseDecisionIdentityObservationSchema.parse({
    state: "observed",
    reference: identity,
    record: {
      identity,
      tenantId: scope.tenantId,
      state: "active",
      revision: 2,
      updatedAt: "2026-10-15T11:00:00.000001Z",
      roles: ["member"],
      capabilities: [
        "approval:authority:manage",
        "approval:decide",
        "release:decision:publish",
        "release:selection:manage",
      ],
      resourceScope: {
        mode: "restricted",
        projects: [{ projectId: scope.projectId, environmentIds: [scope.environmentId] }],
      },
    },
  });
  const credential = ReleaseDecisionCredentialObservationSchema.parse({
    state: "observed",
    reference: {
      kind: "oidc_session",
      principalId: identity.principalId,
      credentialId: receipt.credentialId,
    },
    record: {
      schemaVersion: "0.1",
      kind: "oidc_session",
      credentialId: receipt.credentialId,
      principalId: identity.principalId,
      tenantId: scope.tenantId,
      bindingId: "binding_original",
      createdAt: "2026-10-15T12:00:00.000001Z",
      absoluteExpiresAt: "2026-10-15T13:00:00.000001Z",
      idleExpiresAt: "2026-10-15T12:30:10.000001Z",
      idleLifetimeSeconds: 1_800,
      lastUsedAt: "2026-10-15T12:00:10.000001Z",
      useCount: 1,
      revokedAt: null,
      revocationReason: null,
    },
  });
  return {
    scope,
    identity,
    receipt,
    grant,
    credential,
    capturedAt: "2026-10-15T12:10:00.000001Z",
    operation: "retain_review" as CapturedReleaseIdentityOperation,
    budget: new ReleaseDecisionVerificationBudget({
      maxAcquisitionRecords: 100,
      maxAcquisitionRecordBytes: 1_000_000,
      maxApprovalRecords: 10,
    }),
  };
}
function serviceFixture() {
  const value = fixture();
  value.identity = ReleaseDecisionIdentityReferenceSchema.parse({
    kind: "service_credential",
    principalId: "service_publisher",
    credentialId: "credential_original",
  });
  value.receipt = ReleaseDecisionPublisherReceiptSchema.parse({
    principalId: "service_publisher",
    principalType: "service",
    authenticationMethod: "service_token",
    authenticatedAt: "2026-10-15T12:01:00.000Z",
    credentialId: "credential_original",
    requestId: "request_service",
  });
  value.grant = ReleaseDecisionIdentityObservationSchema.parse({
    state: "observed",
    reference: value.identity,
    record: {
      identity: value.identity,
      tenantId: value.scope.tenantId,
      state: "active",
      revision: 1,
      updatedAt: "2026-10-15T12:00:00.000001Z",
      roles: ["member"],
      capabilities: ["release:decision:publish"],
      resourceScope: { mode: "tenant" },
    },
  });
  value.credential = ReleaseDecisionCredentialObservationSchema.parse({
    state: "observed",
    reference: value.identity,
    record: {
      schemaVersion: "0.1",
      ...value.identity,
      tenantId: value.scope.tenantId,
      createdAt: "2026-10-15T12:00:00.000001Z",
      expiresAt: "2026-10-15T13:00:00.000001Z",
      revokedAt: null,
      revocationReason: null,
    },
  });
  value.operation = "publish_decision";
  return value;
}
function records(value: ReturnType<typeof fixture>) {
  if (value.grant.state !== "observed" || value.credential.state !== "observed")
    throw new Error("Missing observed source fixture");
  return { grant: value.grant.record, credential: value.credential.record };
}

describe("captured identity preimages, not private authentication or publication proof", () => {
  it.each([
    "publish_decision",
    "create_approval",
    "manage_selection",
    "manage_reviewer_authority",
  ] as const)("checks live exact OIDC state for a new %s action", (operation) => {
    const value = fixture();
    value.operation = operation;
    expect(inspectCapturedReleaseIdentityState(value)).toEqual({
      state: "eligible",
      credentialLimit: "2026-10-15T12:30:10.000001Z",
    });
    expect(value.budget.snapshot().records).toBe(2);
  });
  it("keeps natural old-login expiry separate from recorded review validity, while fresh actions require liveness", () => {
    const value = fixture();
    const credential = records(value).credential;
    if (credential.kind !== "oidc_session") throw new Error("Missing session fixture");
    credential.absoluteExpiresAt = "2026-10-15T12:01:00.000001Z";
    credential.idleExpiresAt = credential.absoluteExpiresAt;
    expect(inspectCapturedReleaseIdentityState(value)).toEqual({
      state: "eligible",
      credentialLimit: null,
    });
    value.operation = "create_approval";
    expect(inspectCapturedReleaseIdentityState(value)).toEqual({
      state: "ineligible",
      reason: "credential_expired",
    });
    value.operation = "publish_decision";
    expect(inspectCapturedReleaseIdentityState(value)).toEqual({
      state: "ineligible",
      reason: "credential_expired",
    });
  });
  it("rejects exact fresh-action idle expiry without rounding its native cut", () => {
    const value = fixture();
    value.operation = "create_approval";
    value.capturedAt = "2026-10-15T12:30:10.000001Z";
    expect(inspectCapturedReleaseIdentityState(value)).toEqual({
      state: "ineligible",
      reason: "credential_expired",
    });
    value.capturedAt = "2026-10-15T12:30:10.000000999999999999999999999999Z";
    expect(inspectCapturedReleaseIdentityState(value).state).toBe("eligible");
  });
  it.each(["logout", "binding_disabled", "administrative"] as const)(
    "retains explicit %s revocation as ineligibility even for an earlier valid review",
    (reason) => {
      const value = fixture();
      const record = records(value).credential;
      if (record.kind !== "oidc_session") throw new Error("Missing session fixture");
      record.revokedAt = "2026-10-15T12:05:00.000001Z";
      record.revocationReason = reason;
      expect(inspectCapturedReleaseIdentityState(value)).toEqual({
        state: "ineligible",
        reason: "credential_revoked",
      });
    },
  );
  it("requires current grants independently of generic owner roles and original credential presence", () => {
    const value = fixture();
    const grant = records(value).grant;
    grant.roles = ["owner"];
    grant.capabilities = [];
    expect(inspectCapturedReleaseIdentityState(value)).toEqual({
      state: "ineligible",
      reason: "capability_missing",
    });
    grant.state = "inactive";
    expect(inspectCapturedReleaseIdentityState(value)).toEqual({
      state: "ineligible",
      reason: "identity_inactive",
    });
  });
  it.each([
    "publish_decision",
    "create_approval",
    "retain_review",
    "manage_selection",
    "manage_reviewer_authority",
  ] as const)("requires the independently grantable capability for %s", (operation) => {
    const value = fixture();
    value.operation = operation;
    records(value).grant.capabilities = [];
    expect(inspectCapturedReleaseIdentityState(value)).toEqual({
      state: "ineligible",
      reason: "capability_missing",
    });
  });
  it("reuses exact project/environment scope semantics and retains tenant-wide grants", () => {
    const value = fixture();
    for (const resourceScope of [
      { mode: "restricted", projects: [{ projectId: "project_other" }] },
      {
        mode: "restricted",
        projects: [{ projectId: value.scope.projectId, environmentIds: ["env_other"] }],
      },
    ] as const) {
      records(value).grant.resourceScope = resourceScope as unknown as ResourceScope;
      expect(inspectCapturedReleaseIdentityState(value)).toEqual({
        state: "ineligible",
        reason: "scope_denied",
      });
    }
    for (const resourceScope of [
      { mode: "tenant" },
      { mode: "restricted", projects: [{ projectId: value.scope.projectId }] },
    ] as const) {
      records(value).grant.resourceScope = resourceScope as unknown as ResourceScope;
      expect(inspectCapturedReleaseIdentityState(value).state).toBe("eligible");
    }
  });
  it.each(["missing", "unavailable", "invalid"] as const)(
    "keeps %s identity/credential state unresolved instead of dropping it",
    (state) => {
      for (const source of ["grant", "credential"] as const) {
        const value = fixture();
        const extra = state === "invalid" ? { observedRecordSha256: "a".repeat(64) } : {};
        if (source === "grant")
          value.grant = ReleaseDecisionIdentityObservationSchema.parse({
            state,
            reference: value.grant.reference,
            ...extra,
          });
        else
          value.credential = ReleaseDecisionCredentialObservationSchema.parse({
            state,
            reference: value.credential.reference,
            ...extra,
          });
        expect(inspectCapturedReleaseIdentityState(value)).toEqual({
          state: "unavailable",
          reason: source === "grant" ? "identity_unavailable" : "credential_unavailable",
        });
        expect(value.budget.snapshot().records).toBe(2);
      }
    },
  );
  it("allows service credential data only for a separately authorized private decision publisher", () => {
    const value = serviceFixture();
    expect(inspectCapturedReleaseIdentityState(value)).toEqual({
      state: "eligible",
      credentialLimit: "2026-10-15T13:00:00.000001Z",
    });
    for (const operation of [
      "create_approval",
      "retain_review",
      "manage_selection",
      "manage_reviewer_authority",
    ] as const)
      expect(inspectCapturedReleaseIdentityState({ ...value, operation })).toEqual({
        state: "ineligible",
        reason: "principal_type_not_allowed",
      });
  });
  it("rejects service expiry and rotation without borrowing the grant of a replacement credential", () => {
    const value = serviceFixture();
    value.capturedAt = "2026-10-15T13:00:00.000001Z";
    expect(inspectCapturedReleaseIdentityState(value)).toEqual({
      state: "ineligible",
      reason: "credential_expired",
    });
    const current = serviceFixture();
    const credential = records(current).credential;
    if (credential.kind !== "service_credential") throw new Error("Missing service fixture");
    credential.revokedAt = "2026-10-15T12:05:00.000001Z";
    credential.revocationReason = "rotation";
    expect(inspectCapturedReleaseIdentityState(current)).toEqual({
      state: "ineligible",
      reason: "credential_revoked",
    });
  });
  it.each([
    "tenant",
    "binding",
    "principal",
    "credential",
    "grant_reference",
    "credential_reference",
    "authentication_receipt",
  ])("rejects a substituted original %s", (kind) => {
    const value = fixture();
    const source = records(value);
    if (kind === "tenant") source.credential.tenantId = "tenant_other";
    if (kind === "binding" && source.credential.kind === "oidc_session")
      source.credential.bindingId = "binding_other";
    if (kind === "principal") value.receipt.principalId = "user_other";
    if (kind === "credential") value.receipt.credentialId = "session_other";
    if (kind === "grant_reference") value.grant.reference.principalId = "user_other";
    if (kind === "credential_reference") value.credential.reference.credentialId = "session_other";
    if (kind === "authentication_receipt")
      value.receipt.authenticatedAt = "2026-10-15T12:00:00.001Z";
    expect(() => inspectCapturedReleaseIdentityState(value)).toThrow(
      InvalidCapturedReleaseIdentityError,
    );
  });
  it("checks original millisecond authentication receipts against native creation even before the epoch", () => {
    const value = fixture();
    const source = records(value);
    source.grant.updatedAt = "1969-12-31T23:00:00.000001Z";
    if (source.credential.kind !== "oidc_session") throw new Error("Missing session fixture");
    Object.assign(source.credential, {
      createdAt: "1969-12-31T23:59:59.999999Z",
      lastUsedAt: "1969-12-31T23:59:59.999999Z",
      idleExpiresAt: "1970-01-01T00:29:59.999999Z",
      absoluteExpiresAt: "1970-01-01T00:59:59.999999Z",
    });
    value.receipt.authenticatedAt = "1969-12-31T23:59:59.999Z";
    value.capturedAt = "1970-01-01T00:10:00.000001Z";
    expect(inspectCapturedReleaseIdentityState(value).state).toBe("eligible");
    expect(source.credential.createdAt).toBe("1969-12-31T23:59:59.999999Z");
    value.receipt.authenticatedAt = "1970-01-01T00:00:00.000Z";
    expect(() => inspectCapturedReleaseIdentityState(value)).toThrow(
      InvalidCapturedReleaseIdentityError,
    );
  });
  it.each(["grant", "use", "revocation", "authentication"])(
    "rejects captured %s from after the native cut",
    (kind) => {
      const value = fixture();
      const source = records(value);
      if (kind === "grant") source.grant.updatedAt = "2026-10-15T12:10:00.000002Z";
      if (kind === "use" && source.credential.kind === "oidc_session") {
        source.credential.lastUsedAt = "2026-10-15T12:10:00.000002Z";
        source.credential.idleExpiresAt = "2026-10-15T12:40:00.000002Z";
      }
      if (kind === "revocation" && source.credential.kind === "oidc_session") {
        source.credential.revokedAt = "2026-10-15T12:10:00.000002Z";
        source.credential.revocationReason = "logout";
      }
      if (kind === "authentication") value.receipt.authenticatedAt = "2026-10-15T12:11:00.000Z";
      expect(() => inspectCapturedReleaseIdentityState(value)).toThrow(
        InvalidCapturedReleaseIdentityError,
      );
    },
  );
  it("preserves callers and cannot reuse a caught failed shared admission", () => {
    const value = fixture();
    const before = structuredClone({
      receipt: value.receipt,
      grant: value.grant,
      credential: value.credential,
    });
    value.budget = new ReleaseDecisionVerificationBudget({
      maxAcquisitionRecords: 2,
      maxAcquisitionRecordBytes: 1_000_000,
      maxApprovalRecords: 0,
    });
    inspectCapturedReleaseIdentityState(value);
    expect({ receipt: value.receipt, grant: value.grant, credential: value.credential }).toEqual(
      before,
    );
    expect(() => inspectCapturedReleaseIdentityState(value)).toThrow(
      ReleaseDecisionVerificationBudgetError,
    );
    expect(() => value.budget.snapshot()).toThrow(ReleaseDecisionVerificationBudgetError);
  });
});
