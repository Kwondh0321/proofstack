import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  encodeReleaseApprovalDefinition,
  type ReleaseApproval,
  type ReleaseApprovalPublicationMaterial,
  type ReleaseDecisionIdentityGrant,
} from "@proofstack/contracts";
import {
  MemoryReleaseApprovalRepository,
  releaseApprovalPublicationFixture,
} from "@proofstack/core/testing";
import { MemoryReleaseSelectionInstallerReference } from "./memory-release-selection-installer.js";
import {
  releaseApprovalRevokerConformanceCases,
  type ReleaseApprovalRevokerConformanceFactory,
} from "./release-approval-revoker-conformance.js";

type Physical = {
  approvals: MemoryReleaseApprovalRepository;
  approvalPublications: Map<string, ReleaseApprovalPublicationMaterial>;
  intents: Map<string, unknown>;
};
async function fixture() {
  let now = "2026-10-19T12:00:00.000Z";
  const reference = new MemoryReleaseSelectionInstallerReference({ now: () => new Date(now) });
  const original = releaseApprovalPublicationFixture();
  if (original.source.kind !== "release_approval") throw new Error("Fixture kind");
  const record = original.source.record,
    scope = original.publication.scope;
  const grant: ReleaseDecisionIdentityGrant = {
    ...original.grant,
    revision: 1,
    updatedAt: "2026-10-19T11:59:00.000Z",
  };
  reference.writeSyntheticGrant(grant);
  await reference.seedSyntheticApprovalPublication(original);
  let sessions = 0;
  const login = async (requestId: string) =>
    reference.createSyntheticSession({
      scope,
      bindingId: original.publication.identity.bindingId,
      sessionId: `session_current_reviewer_${++sessions}`,
      requestId,
    });
  const credentials = await login("request_current_revocation");
  const intent = {
    eventId: "event_current_revocation",
    approval: { approvalId: record.approvalId, definitionSha256: record.definitionSha256 },
    reason: "Withdraw my exact original approval.",
  };
  const physical = () =>
    (reference as unknown as { tenants: Map<string, Physical> }).tenants.get(scope.tenantId)!;
  return {
    reference,
    original,
    record,
    scope,
    grant,
    credentials,
    login,
    intent,
    physical,
    setTime(value: string) {
      now = value;
    },
  };
}
const factory: ReleaseApprovalRevokerConformanceFactory = async () => {
  const f = await fixture();
  let revision = f.grant.revision;
  return {
    service: f.reference,
    credentials: f.credentials,
    original: f.record,
    intent: f.intent,
    login: f.login,
    async changeCapabilities(capabilities) {
      f.reference.writeSyntheticGrant({
        ...f.grant,
        capabilities: [...capabilities],
        revision: ++revision,
      });
    },
    readRevocation: (id) => f.reference.readSyntheticApprovalRevocation(f.scope, id),
    readPublication: async (id) =>
      f.reference.readSyntheticApprovalPublication(f.scope, "release_approval_revocation", id),
  };
};
describe("actual authenticated approval revocation shared service conformance", () => {
  for (const test of releaseApprovalRevokerConformanceCases) it(test.name, () => test.run(factory));
});
describe("approval revocation owning-state boundaries", () => {
  it("can import a synthetic original before a login exists, and rejects duplicate or lifecycle imports", async () => {
    const reference = new MemoryReleaseSelectionInstallerReference({
      now: () => new Date("2026-10-19T12:00:00Z"),
    });
    const original = releaseApprovalPublicationFixture();
    await reference.seedSyntheticApprovalPublication(original);
    await expect(reference.seedSyntheticApprovalPublication(original)).rejects.toThrow();
    await expect(
      reference.seedSyntheticApprovalPublication(releaseApprovalPublicationFixture("revocation")),
    ).rejects.toThrow();
  });
  it("rejects importing a legacy original without synthesizing its missing provenance", async () => {
    const f = await fixture();
    f.physical().approvalPublications.clear();
    f.physical().intents.clear();
    await expect(f.reference.seedSyntheticApprovalPublication(f.original)).rejects.toThrow();
    expect(f.physical().approvalPublications.size).toBe(0);
    expect(f.physical().intents.size).toBe(0);
  });
  it("returns unavailable for missing and cross-scope synthetic observations", async () => {
    const f = await fixture();
    const unknown = { ...f.scope, tenantId: "tenant_no_approval_state" };
    const foreign = { ...f.scope, projectId: "project_other" };
    for (const scope of [unknown, foreign]) {
      expect(await f.reference.readSyntheticApproval(scope, f.record.approvalId)).toBeNull();
      expect(await f.reference.readSyntheticApprovalRevocation(scope, f.intent.eventId)).toBeNull();
      expect(
        f.reference.readSyntheticApprovalPublication(
          scope,
          "release_approval",
          f.record.approvalId,
        ),
      ).toBeNull();
    }
    expect(
      f.reference.readSyntheticApprovalPublication(f.scope, "release_approval", "approval_missing"),
    ).toBeNull();
  });
  it("rejects a trusted source port reporting reuse after a new revocation was requested", async () => {
    const f = await fixture(),
      owning = MemoryReleaseApprovalRepository.prototype.publishReleaseApprovalRevocation;
    const spy = vi
      .spyOn(MemoryReleaseApprovalRepository.prototype, "publishReleaseApprovalRevocation")
      .mockImplementationOnce(async function (this: MemoryReleaseApprovalRepository, input) {
        const result = await owning.call(this, input);
        return { ...result, created: false };
      });
    try {
      await expect(f.reference.revokeApproval(f.credentials, f.intent)).rejects.toThrow();
    } finally {
      spy.mockRestore();
    }
    expect(await f.reference.readSyntheticApprovalRevocation(f.scope, f.intent.eventId)).toBeNull();
    expect(f.physical().approvalPublications.size).toBe(1);
  });
  it("allows the original reviewer to withdraw after old login and approval expiry without requiring current expertise", async () => {
    const f = await fixture();
    expect(Date.parse(f.record.expiresAt)).toBeLessThan(Date.parse("2026-10-19T12:00:00Z"));
    const result = await f.reference.revokeApproval(f.credentials, f.intent);
    expect(result.created).toBe(true);
    expect(result.record.reviewer.principalId).toBe(f.record.reviewer.principalId);
    expect(result.record.reviewer.credentialId).not.toBe(f.record.reviewer.credentialId);
    expect(await f.reference.readSyntheticApproval(f.scope, f.record.approvalId)).toEqual(f.record);
  });
  it("rejects another currently authorized user instead of impersonating the original reviewer", async () => {
    const f = await fixture();
    f.reference.writeSyntheticGrant({
      ...f.grant,
      identity: { kind: "oidc_binding", principalId: "other_reviewer", bindingId: "other_binding" },
    });
    const other = f.reference.createSyntheticSession({
      scope: f.scope,
      bindingId: "other_binding",
      sessionId: "other_session",
      requestId: "other_request",
    });
    await expect(f.reference.revokeApproval(other, f.intent)).rejects.toThrow();
    expect(await f.reference.readSyntheticApprovalRevocation(f.scope, f.intent.eventId)).toBeNull();
    expect(f.physical().approvalPublications.size).toBe(1);
  });
  it.each([
    "profile",
    "source_intent",
    "profile_intent",
    "source",
    "source_changed",
    "profile_changed",
  ] as const)("fails wholly on retained original %s corruption", async (kind) => {
    const f = await fixture(),
      state = f.physical();
    const sourceKey = `release_approval:${f.record.approvalId}`;
    const profileKey = `release_approval_publication:rap_${f.original.publication.definitionSha256.slice(0, 60)}`;
    if (kind === "profile") state.approvalPublications.delete(sourceKey);
    if (kind === "source_intent") state.intents.delete(sourceKey);
    if (kind === "profile_intent") state.intents.delete(profileKey);
    if (kind === "source" || kind === "source_changed") {
      const native = state.approvals as unknown as {
        tenants: Map<string, { approvals: Map<string, ReleaseApproval> }>;
      };
      const rows = native.tenants.get(f.scope.tenantId)!.approvals;
      if (kind === "source") rows.delete(f.record.approvalId);
      else rows.get(f.record.approvalId)!.rationale = "Corrupt the physical original";
    }
    if (kind === "profile_changed")
      state.approvalPublications.get(sourceKey)!.credential.useCount++;
    const before = structuredClone(state.intents);
    await expect(f.reference.revokeApproval(f.credentials, f.intent)).rejects.toThrow();
    expect(await f.reference.readSyntheticApprovalRevocation(f.scope, f.intent.eventId)).toBeNull();
    expect(f.physical().intents).toEqual(before);
    expect(
      f.reference.readSyntheticApprovalPublication(
        f.scope,
        "release_approval_revocation",
        f.intent.eventId,
      ),
    ).toBeNull();
  });
  it.each(["source_intent", "profile_intent", "profile"] as const)(
    "rejects a corrupted %s on an equal retry without repairing it",
    async (part) => {
      const f = await fixture();
      const first = await f.reference.revokeApproval(f.credentials, f.intent),
        state = f.physical();
      const sourceKey = `release_approval_revocation:${f.intent.eventId}`;
      if (part === "source_intent") state.intents.delete(sourceKey);
      if (part === "profile_intent")
        state.intents.delete(
          `release_approval_publication:rap_${first.publication.definitionSha256.slice(0, 60)}`,
        );
      if (part === "profile") state.approvalPublications.delete(sourceKey);
      const before = structuredClone(state.intents);
      await expect(f.reference.revokeApproval(f.credentials, f.intent)).rejects.toThrow();
      expect(await f.reference.readSyntheticApprovalRevocation(f.scope, f.intent.eventId)).toEqual(
        first.record,
      );
      expect(f.physical().intents).toEqual(before);
    },
  );
  it("does not upgrade a trusted legacy row into an authenticated origin", async () => {
    const f = await fixture(),
      state = f.physical();
    state.approvalPublications.clear();
    state.intents.clear();
    await expect(f.reference.revokeApproval(f.credentials, f.intent)).rejects.toThrow();
    expect(await f.reference.readSyntheticApproval(f.scope, f.record.approvalId)).toEqual(f.record);
    expect(f.physical().approvalPublications.size).toBe(0);
    expect(f.physical().intents.size).toBe(0);
  });
  it.each(["source_conflict", "profile_conflict"] as const)(
    "rolls back the tentative source on %s",
    async (kind) => {
      const f = await fixture();
      if (kind === "source_conflict")
        f.physical().intents.set(`release_approval_revocation:${f.intent.eventId}`, {
          conflicting: true,
        });
      const owning = MemoryReleaseApprovalRepository.prototype.publishReleaseApprovalRevocation;
      const spy =
        kind === "profile_conflict"
          ? vi
              .spyOn(MemoryReleaseApprovalRepository.prototype, "publishReleaseApprovalRevocation")
              .mockImplementationOnce(async function (
                this: MemoryReleaseApprovalRepository,
                input,
              ) {
                const result = await owning.call(this, input);
                throw new Error(
                  `Failure after ${result.created ? "tentative" : "existing"} source`,
                );
              })
          : undefined;
      try {
        await expect(f.reference.revokeApproval(f.credentials, f.intent)).rejects.toThrow();
      } finally {
        spy?.mockRestore();
      }
      expect(
        await f.reference.readSyntheticApprovalRevocation(f.scope, f.intent.eventId),
      ).toBeNull();
      expect(f.physical().approvalPublications.size).toBe(1);
    },
  );
  it.each(["logout", "capability", "expiry"] as const)(
    "rejects %s intervening during an owning source read",
    async (change) => {
      const f = await fixture();
      const owning = MemoryReleaseApprovalRepository.prototype.readReleaseApprovalSubject;
      const spy = vi
        .spyOn(MemoryReleaseApprovalRepository.prototype, "readReleaseApprovalSubject")
        .mockImplementationOnce(async function (this: MemoryReleaseApprovalRepository, ...args) {
          const result = await owning.apply(this, args);
          if (change === "logout")
            f.reference.revokeSyntheticSession(f.scope, "session_current_reviewer_1");
          if (change === "capability")
            f.reference.writeSyntheticGrant({ ...f.grant, capabilities: [], revision: 2 });
          if (change === "expiry") f.setTime("2026-10-19T13:00:00.000Z");
          return result;
        });
      try {
        await expect(f.reference.revokeApproval(f.credentials, f.intent)).rejects.toThrow();
      } finally {
        spy.mockRestore();
      }
      expect(
        await f.reference.readSyntheticApprovalRevocation(f.scope, f.intent.eventId),
      ).toBeNull();
      expect(f.physical().approvalPublications.size).toBe(1);
    },
  );
  it("rejects natural expiry after the tentative source has been created", async () => {
    const f = await fixture(),
      owning = MemoryReleaseApprovalRepository.prototype.publishReleaseApprovalRevocation;
    const spy = vi
      .spyOn(MemoryReleaseApprovalRepository.prototype, "publishReleaseApprovalRevocation")
      .mockImplementationOnce(async function (this: MemoryReleaseApprovalRepository, input) {
        const result = await owning.call(this, input);
        f.setTime("2026-10-19T13:00:00.000Z");
        return result;
      });
    try {
      await expect(f.reference.revokeApproval(f.credentials, f.intent)).rejects.toThrow();
    } finally {
      spy.mockRestore();
    }
    expect(await f.reference.readSyntheticApprovalRevocation(f.scope, f.intent.eventId)).toBeNull();
  });
  it("isolates two concurrent different revocations and retains exactly one complete publication", async () => {
    const f = await fixture();
    const results = await Promise.allSettled([
      f.reference.revokeApproval(f.credentials, f.intent),
      f.reference.revokeApproval(f.credentials, {
        ...f.intent,
        eventId: "event_competing_revocation",
      }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(f.physical().approvalPublications.size).toBe(2);
    expect(f.physical().intents.size).toBe(4);
  });
  it("preserves original subject and source hash rather than rewriting expired approval content", async () => {
    const f = await fixture();
    const { schemaVersion: _v, definitionSha256: sha, ...definition } = f.record;
    expect(
      createHash("sha256")
        .update(encodeReleaseApprovalDefinition({ scope: f.scope, definition }))
        .digest("hex"),
    ).toBe(sha);
    await f.reference.revokeApproval(f.credentials, f.intent);
    expect(await f.reference.readSyntheticApproval(f.scope, f.record.approvalId)).toEqual(f.record);
  });
  it("rejects a synthetic provenance map colliding with a different source kind or exact ID", async () => {
    for (const corruption of ["kind", "id", "scope"] as const) {
      const f = await fixture(),
        state = f.physical();
      const sourceKey = `release_approval:${f.record.approvalId}`;
      if (corruption === "kind")
        state.approvalPublications.set(sourceKey, releaseApprovalPublicationFixture("revocation"));
      if (corruption === "id")
        state.approvalPublications.set("release_approval:approval_other_id", f.original);
      if (corruption === "scope") {
        // A tenant-colliding scope key must not expose another project's retained original.
        await expect(
          f.reference.revokeApproval(
            { ...f.credentials, scope: { ...f.scope, projectId: "project_other" } },
            f.intent,
          ),
        ).rejects.toThrow();
      } else {
        await expect(
          f.reference.revokeApproval(
            f.credentials,
            corruption === "id"
              ? { ...f.intent, approval: { ...f.intent.approval, approvalId: "approval_other_id" } }
              : f.intent,
          ),
        ).rejects.toThrow();
      }
      expect(
        await f.reference.readSyntheticApprovalRevocation(f.scope, f.intent.eventId),
      ).toBeNull();
    }
  });
  it("rejects time regression after a tentative write even when the current login is still live", async () => {
    const f = await fixture();
    f.setTime("2026-10-19T12:05:00.000Z");
    const owning = MemoryReleaseApprovalRepository.prototype.publishReleaseApprovalRevocation;
    const spy = vi
      .spyOn(MemoryReleaseApprovalRepository.prototype, "publishReleaseApprovalRevocation")
      .mockImplementationOnce(async function (this: MemoryReleaseApprovalRepository, input) {
        const result = await owning.call(this, input);
        f.setTime("2026-10-19T12:01:00.000Z");
        return result;
      });
    try {
      await expect(f.reference.revokeApproval(f.credentials, f.intent)).rejects.toThrow();
    } finally {
      spy.mockRestore();
    }
    expect(await f.reference.readSyntheticApprovalRevocation(f.scope, f.intent.eventId)).toBeNull();
  });
  it("does not serve a future-dated original after clock regression on an equal retry", async () => {
    const f = await fixture();
    f.setTime("2026-10-19T12:05:00.000Z");
    const first = await f.reference.revokeApproval(f.credentials, f.intent);
    f.setTime("2026-10-19T12:01:00.000Z");
    await expect(f.reference.revokeApproval(f.credentials, f.intent)).rejects.toThrow();
    expect(await f.reference.readSyntheticApprovalRevocation(f.scope, f.intent.eventId)).toEqual(
      first.record,
    );
  });
});
