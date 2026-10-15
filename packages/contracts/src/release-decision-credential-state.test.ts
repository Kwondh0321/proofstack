import { describe, expect, it } from "vitest";
import {
  ReleaseDecisionCredentialObservationSchema,
  ReleaseDecisionCredentialStateSchema,
  ReleaseDecisionServiceCredentialStateSchema,
  ReleaseDecisionSessionStateSchema,
} from "./release-decision-credential-state.js";

function session() {
  return {
    schemaVersion: "0.1" as const,
    kind: "oidc_session" as const,
    credentialId: "session_original",
    principalId: "user_reviewer",
    tenantId: "tenant_example",
    bindingId: "binding_original",
    createdAt: "2026-10-15T12:00:00.000001Z",
    absoluteExpiresAt: "2026-10-15T13:00:00.000001Z",
    idleExpiresAt: "2026-10-15T12:30:00.000001Z",
    idleLifetimeSeconds: 1_800,
    lastUsedAt: null as string | null,
    useCount: 0,
    revokedAt: null as string | null,
    revocationReason: null as "logout" | "binding_disabled" | "administrative" | null,
  };
}
function service() {
  return {
    schemaVersion: "0.1" as const,
    kind: "service_credential" as const,
    credentialId: "credential_original",
    principalId: "service_publisher",
    tenantId: "tenant_example",
    createdAt: "2026-10-15T12:00:00.000001Z",
    expiresAt: "2026-10-15T13:00:00.000001Z",
    revokedAt: null as string | null,
    revocationReason: null as "administrative" | "rotation" | null,
  };
}
describe("secret-free native credential projections", () => {
  it("retains original native creation/idle/absolute clocks without rounding to authentication receipts", () => {
    const value = session();
    expect(ReleaseDecisionSessionStateSchema.parse(value)).toEqual(value);
    const later = {
      ...value,
      lastUsedAt: "2026-10-15T12:10:00.000002Z",
      useCount: 1,
      idleExpiresAt: "2026-10-15T12:40:00.000002Z",
    };
    expect(ReleaseDecisionSessionStateSchema.parse(later)).toEqual(later);
    expect(
      ReleaseDecisionSessionStateSchema.safeParse({
        ...later,
        idleExpiresAt: "2026-10-15T12:40:00.000Z",
      }).success,
    ).toBe(false);
  });
  it("caps idle lifetime at absolute expiry and retains the saturated native use counter", () => {
    const value = {
      ...session(),
      lastUsedAt: "2026-10-15T12:50:00.000001Z",
      useCount: 2_147_483_647,
      idleExpiresAt: session().absoluteExpiresAt,
    };
    expect(ReleaseDecisionSessionStateSchema.parse(value)).toEqual(value);
    expect(
      ReleaseDecisionSessionStateSchema.safeParse({ ...value, useCount: 2_147_483_648 }).success,
    ).toBe(false);
  });
  it("admits native absolute 60-second and 24-hour boundaries and rejects one precision unit outside", () => {
    const value = session();
    for (const absoluteExpiresAt of [
      "2026-10-15T12:01:00.000001Z",
      "2026-10-16T12:00:00.000001Z",
    ]) {
      const idleExpiresAt = absoluteExpiresAt.startsWith("2026-10-15T12:01")
        ? absoluteExpiresAt
        : value.idleExpiresAt;
      expect(
        ReleaseDecisionSessionStateSchema.safeParse({ ...value, absoluteExpiresAt, idleExpiresAt })
          .success,
      ).toBe(true);
    }
    for (const absoluteExpiresAt of [
      "2026-10-15T12:01:00.000000999999999999999999999999Z",
      "2026-10-16T12:00:00.000001000000000000000000000001Z",
    ])
      expect(
        ReleaseDecisionSessionStateSchema.safeParse({ ...value, absoluteExpiresAt }).success,
      ).toBe(false);
  });
  it.each([0, 59, 86_401, 60.5, Number.NaN])(
    "rejects unsupported native idle lifetime %s",
    (idleLifetimeSeconds) => {
      expect(
        ReleaseDecisionSessionStateSchema.safeParse({ ...session(), idleLifetimeSeconds }).success,
      ).toBe(false);
    },
  );
  it("preserves exact idle geometry at both allowed lifetime boundaries", () => {
    const value = session();
    expect(
      ReleaseDecisionSessionStateSchema.safeParse({
        ...value,
        idleLifetimeSeconds: 60,
        idleExpiresAt: "2026-10-15T12:01:00.000001Z",
      }).success,
    ).toBe(true);
    expect(
      ReleaseDecisionSessionStateSchema.safeParse({
        ...value,
        idleLifetimeSeconds: 86_400,
        idleExpiresAt: value.absoluteExpiresAt,
      }).success,
    ).toBe(true);
  });
  it("binds actual native use count to the retained last-use receipt", () => {
    for (const change of [
      { useCount: 1 },
      { useCount: -1 },
      { lastUsedAt: session().createdAt },
      { useCount: 1, lastUsedAt: "2026-10-15T12:00:00.000000Z" },
    ])
      expect(ReleaseDecisionSessionStateSchema.safeParse({ ...session(), ...change }).success).toBe(
        false,
      );
  });
  it.each(["logout", "binding_disabled", "administrative"] as const)(
    "retains original session revocation %s",
    (revocationReason) => {
      const value = { ...session(), revokedAt: "2026-10-15T12:00:00.000002Z", revocationReason };
      expect(ReleaseDecisionSessionStateSchema.parse(value)).toEqual(value);
      expect(
        ReleaseDecisionSessionStateSchema.safeParse({ ...value, revokedAt: null }).success,
      ).toBe(false);
      expect(
        ReleaseDecisionSessionStateSchema.safeParse({ ...value, revocationReason: null }).success,
      ).toBe(false);
      expect(
        ReleaseDecisionSessionStateSchema.safeParse({
          ...value,
          revokedAt: "2026-10-15T12:00:00.000000Z",
        }).success,
      ).toBe(false);
    },
  );
  it("retains explicit service validity and administrative/rotation revocation, never a raw token", () => {
    const value = service();
    expect(ReleaseDecisionServiceCredentialStateSchema.parse(value)).toEqual(value);
    expect(
      ReleaseDecisionServiceCredentialStateSchema.safeParse({
        ...value,
        expiresAt: value.createdAt,
      }).success,
    ).toBe(false);
    for (const revocationReason of ["administrative", "rotation"] as const) {
      const revoked = { ...value, revokedAt: value.createdAt, revocationReason };
      expect(ReleaseDecisionServiceCredentialStateSchema.parse(revoked)).toEqual(revoked);
      expect(
        ReleaseDecisionServiceCredentialStateSchema.safeParse({ ...revoked, revokedAt: null })
          .success,
      ).toBe(false);
      expect(
        ReleaseDecisionServiceCredentialStateSchema.safeParse({
          ...revoked,
          revokedAt: "2026-10-15T12:00:00.000000Z",
        }).success,
      ).toBe(false);
    }
  });
  it.each([
    "sessionDigest",
    "csrfDigest",
    "token",
    "prefix",
    "passwordHash",
    "salt",
    "privateProof",
  ])("excludes private %s from both projections", (field) => {
    for (const value of [session(), service()])
      expect(
        ReleaseDecisionCredentialStateSchema.safeParse({ ...value, [field]: "not-a-credential" })
          .success,
      ).toBe(false);
  });
  it("binds observations to exact authentication kind, principal and credential ID", () => {
    const record = session();
    const reference = {
      kind: record.kind,
      principalId: record.principalId,
      credentialId: record.credentialId,
    };
    const observed = { state: "observed", reference, record };
    expect(ReleaseDecisionCredentialObservationSchema.parse(observed)).toEqual(observed);
    for (const change of [
      { kind: "service_credential" },
      { principalId: "user_other" },
      { credentialId: "session_other" },
    ])
      expect(
        ReleaseDecisionCredentialObservationSchema.safeParse({
          ...observed,
          reference: { ...reference, ...change },
        }).success,
      ).toBe(false);
    for (const state of ["missing", "unavailable"])
      expect(
        ReleaseDecisionCredentialObservationSchema.safeParse({ state, reference }).success,
      ).toBe(true);
    expect(
      ReleaseDecisionCredentialObservationSchema.safeParse({
        state: "invalid",
        reference,
        observedRecordSha256: "a".repeat(64),
      }).success,
    ).toBe(true);
  });
});
