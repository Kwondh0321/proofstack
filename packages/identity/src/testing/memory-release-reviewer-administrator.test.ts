import { describe, expect, it, vi } from "vitest";
import {
  type ReleaseDecisionIdentityGrant,
  type ReleaseDecisionSessionState,
  type ReleaseReviewerAuthority,
  type ReleaseReviewerPublicationMaterial,
} from "@proofstack/contracts";
import { releaseReviewerAuthorityReference } from "@proofstack/core";
import {
  MemoryReleaseReviewerAuthorityRepository,
  releaseReviewerAuthorityRepositoryFixture,
  releasePolicySelectionRepositoryFixture,
} from "@proofstack/core/testing";
import { MemoryReleaseSelectionInstallerReference } from "./memory-release-selection-installer.js";
import {
  releaseReviewerAdministratorConformanceCases,
  type ReleaseReviewerAdministratorConformanceFactory,
} from "./release-reviewer-administrator-conformance.js";

function fixture(
  namespace = "reviewer_reference",
  tenantId?: string,
  shared?: MemoryReleaseSelectionInstallerReference,
) {
  let now = "2026-10-19T12:00:00.000Z";
  const reference =
    shared ?? new MemoryReleaseSelectionInstallerReference({ now: () => new Date(now) });
  const original = releaseReviewerAuthorityRepositoryFixture(namespace).original;
  const scope = { ...original.scope, ...(tenantId ? { tenantId } : {}) };
  const grant: ReleaseDecisionIdentityGrant = {
    identity: {
      kind: "oidc_binding",
      principalId: "user_synthetic_administrator",
      bindingId: "binding_synthetic_reviewer",
    },
    tenantId: scope.tenantId,
    state: "active",
    capabilities: ["approval:authority:manage"],
    roles: ["member"],
    resourceScope: { mode: "tenant" },
    revision: 1,
    updatedAt: "2026-10-19T11:59:00.000Z",
  };
  reference.writeSyntheticGrant(grant);
  let sessions = 0;
  const login = (requestId: string) =>
    reference.createSyntheticSession({
      scope,
      bindingId: "binding_synthetic_reviewer",
      sessionId: `session_${scope.tenantId}_${++sessions}`,
      requestId,
    });
  const credentials = login("request_synthetic_reviewer");
  const {
    scope: _s,
    issuerPrincipalId: _i,
    schemaVersion: _v,
    definitionSha256: _h,
    publishedAt: _at,
    publishedByPrincipalId: _by,
    ...definition
  } = original;
  const intent = {
    ...definition,
    effectiveAt: "2026-01-01T00:00:00Z",
    expiresAt: "2099-01-01T00:00:00Z",
  };
  return {
    reference,
    scope,
    grant,
    credentials,
    intent,
    login,
    setTime(value: string) {
      now = value;
    },
  };
}
type Fixture = ReturnType<typeof fixture>;
type State = {
  reviewers: MemoryReleaseReviewerAuthorityRepository;
  grants: Map<string, ReleaseDecisionIdentityGrant>;
  sessions: Map<string, { credential: ReleaseDecisionSessionState }>;
  reviewerPublications: Map<string, ReleaseReviewerPublicationMaterial>;
  intents: Map<string, unknown>;
};
/** Inspect/corrupt actual fixture storage only; no public source mutation port. */
const physical = (f: Fixture) =>
  (f.reference as unknown as { tenants: Map<string, State> }).tenants.get(f.scope.tenantId)!;
function factory(
  reference: MemoryReleaseSelectionInstallerReference,
): ReleaseReviewerAdministratorConformanceFactory {
  return async (namespace) => {
    const f = fixture(namespace, `tenant_${namespace}`, reference);
    let revision = f.grant.revision;
    return {
      service: reference,
      scope: f.scope,
      credentials: f.credentials,
      intent: f.intent,
      principalId: f.grant.identity.principalId,
      login: async (requestId) => f.login(requestId),
      async changeCapabilities(capabilities) {
        reference.writeSyntheticGrant({
          ...f.grant,
          capabilities: [...capabilities],
          revision: ++revision,
        });
      },
      readOriginal: async (id) => reference.readSyntheticReviewerAuthority(f.scope, id),
      readPublication: async (kind, id) =>
        reference.readSyntheticReviewerPublication(f.scope, kind, id),
    };
  };
}
describe("authenticated reviewer reference shared service conformance", () => {
  for (const test of releaseReviewerAdministratorConformanceCases)
    it(test.name, async () =>
      test.run(
        factory(
          new MemoryReleaseSelectionInstallerReference({
            now: () => new Date("2026-10-19T12:00:00.000Z"),
          }),
        ),
      ),
    );
});
describe("reviewer reference transaction and authority boundaries", () => {
  it("shares the complete selection and reviewer state boundary during an actual owning read", async () => {
    const f = fixture();
    f.reference.writeSyntheticGrant({
      ...f.grant,
      revision: 2,
      capabilities: ["approval:authority:manage", "release:selection:manage"],
    });
    const original = releasePolicySelectionRepositoryFixture("cross_domain").original;
    const {
      scope: _s,
      issuerPrincipalId: _i,
      schemaVersion: _v,
      definitionSha256: _h,
      publishedAt: _at,
      publishedByPrincipalId: _by,
      ...definition
    } = original;
    const selection = {
      ...definition,
      mode: "observation_only",
      policies: [],
      effectiveAt: "2026-01-01T00:00:00Z",
      expiresAt: "2099-01-01T00:00:00Z",
    };
    const owning =
      MemoryReleaseReviewerAuthorityRepository.prototype.readReleaseReviewerAuthorityTarget;
    const spy = vi
      .spyOn(
        MemoryReleaseReviewerAuthorityRepository.prototype,
        "readReleaseReviewerAuthorityTarget",
      )
      .mockImplementationOnce(async function (
        this: MemoryReleaseReviewerAuthorityRepository,
        ...args
      ) {
        const result = await owning.apply(this, args);
        await f.reference.publishSelection(f.credentials, selection);
        return result;
      });
    try {
      await expect(f.reference.publishReviewerAuthority(f.credentials, f.intent)).rejects.toThrow();
    } finally {
      spy.mockRestore();
    }
    expect(
      await f.reference.readSyntheticSelection(f.scope, original.selectionVersionId),
    ).not.toBeNull();
    expect(
      await f.reference.readSyntheticReviewerAuthority(f.scope, f.intent.authorityVersionId),
    ).toBeNull();
    expect(physical(f).reviewerPublications.size).toBe(0);
    expect(physical(f).intents.size).toBe(2);
  });
  it("permits another current administrator action after original administrator revocation without rewriting provenance", async () => {
    const f = fixture();
    const root = await f.reference.publishReviewerAuthority(f.credentials, f.intent);
    const secondGrant: ReleaseDecisionIdentityGrant = {
      ...f.grant,
      identity: {
        kind: "oidc_binding",
        bindingId: "binding_second_administrator",
        principalId: "user_second_administrator",
      },
    };
    f.reference.writeSyntheticGrant(secondGrant);
    const credentials = f.reference.createSyntheticSession({
      scope: f.scope,
      bindingId: "binding_second_administrator",
      sessionId: "session_second_administrator",
      requestId: "request_second_administrator",
    });
    f.reference.revokeSyntheticSession(f.scope, `session_${f.scope.tenantId}_1`);
    const intent = {
      eventId: "event_second_administrator",
      kind: "revoked",
      authority: root.publication.subject.authority,
      reason: "A separately authorized administrator revoked the exact declaration.",
    };
    const result = await f.reference.publishReviewerAuthorityLifecycle(credentials, intent);
    expect(result.publication.actor.principalId).toBe("user_second_administrator");
    expect(
      f.reference.readSyntheticReviewerPublication(
        f.scope,
        "release_reviewer_authority",
        f.intent.authorityVersionId,
      )?.publication,
    ).toEqual(root.publication);
    f.reference.writeSyntheticGrant({ ...f.grant, revision: 2 });
    await expect(
      f.reference.publishReviewerAuthorityLifecycle(
        f.login("request_first_administrator_retry"),
        intent,
      ),
    ).rejects.toThrow();
  });
  it.each(["get", "ownKeys"])(
    "the shared oracle detects an incorrect %s body read before authentication",
    async (method) => {
      const reference = new MemoryReleaseSelectionInstallerReference({
        now: () => new Date("2026-10-19T12:00:00.000Z"),
      });
      const shared = factory(reference);
      const conformance = releaseReviewerAdministratorConformanceCases.find(
        (test) => test.name === "rejects invalid cookie before interpreting a publication body",
      )!;
      await expect(
        conformance.run(async (namespace) => {
          const h = await shared(namespace);
          return {
            ...h,
            service: {
              publishReviewerAuthorityLifecycle: h.service.publishReviewerAuthorityLifecycle.bind(
                h.service,
              ),
              async publishReviewerAuthority(credentials, body) {
                if (method === "get") Reflect.get(body as object, "authorityId");
                else Reflect.ownKeys(body as object);
                return h.service.publishReviewerAuthority(credentials, body);
              },
            },
          };
        }),
      ).rejects.toThrow(/true !== false/);
    },
  );
  it("seeds a fresh synthetic owning state idempotently without inventing an authenticated origin", async () => {
    const reference = new MemoryReleaseSelectionInstallerReference({
      now: () => new Date("2026-10-19T12:00:00.000Z"),
    });
    const f = releaseReviewerAuthorityRepositoryFixture("fresh_seed");
    expect(
      await reference.readSyntheticReviewerAuthority(f.scope, f.original.authorityVersionId),
    ).toBeNull();
    expect(
      reference.readSyntheticReviewerPublication(
        f.scope,
        "release_reviewer_authority",
        f.original.authorityVersionId,
      ),
    ).toBeNull();
    await reference.seedSyntheticReviewerAuthority(f.original);
    await reference.seedSyntheticReviewerAuthority(f.original);
    expect(
      await reference.readSyntheticReviewerAuthority(f.scope, f.original.authorityVersionId),
    ).toEqual(f.original);
    expect(
      reference.readSyntheticReviewerPublication(
        f.scope,
        "release_reviewer_authority",
        f.original.authorityVersionId,
      ),
    ).toBeNull();
  });
  it("rejects changed lifecycle retry bodies while preserving the first complete publication", async () => {
    const f = fixture();
    const root = await f.reference.publishReviewerAuthority(f.credentials, f.intent);
    const intent = {
      eventId: "event_retry_body",
      kind: "revoked",
      authority: root.publication.subject.authority,
      reason: "Revoke the exact authority.",
    };
    const first = await f.reference.publishReviewerAuthorityLifecycle(f.credentials, intent);
    await expect(
      f.reference.publishReviewerAuthorityLifecycle(f.credentials, {
        ...intent,
        reason: "Replace the original reason.",
      }),
    ).rejects.toThrow();
    expect(
      f.reference.readSyntheticReviewerPublication(
        f.scope,
        "release_reviewer_authority_lifecycle",
        intent.eventId,
      )?.publication,
    ).toEqual(first.publication);
  });
  it("rejects a pre-existing terminal record that has no authenticated profile", async () => {
    const f = fixture();
    const root = await f.reference.publishReviewerAuthority(f.credentials, f.intent);
    const intent = {
      eventId: "event_legacy_terminal",
      kind: "revoked" as const,
      authority: root.publication.subject.authority,
      reason: "Preserve the legacy terminal.",
    };
    await physical(f).reviewers.publishReleaseReviewerAuthorityLifecycleEvent({
      ...intent,
      scope: f.scope,
      schemaVersion: "0.1",
      actorPrincipalId: f.grant.identity.principalId,
      occurredAt: "2026-10-19T12:00:00.000Z",
    });
    await expect(
      f.reference.publishReviewerAuthorityLifecycle(f.credentials, intent),
    ).rejects.toThrow();
    expect(physical(f).reviewerPublications.size).toBe(1);
  });
  it("rejects a substituted exact terminal reference while retaining its authenticated declaration", async () => {
    const f = fixture();
    const root = await f.reference.publishReviewerAuthority(f.credentials, f.intent);
    await expect(
      f.reference.publishReviewerAuthorityLifecycle(f.credentials, {
        eventId: "event_wrong_reference",
        kind: "revoked",
        authority: { ...root.publication.subject.authority, definitionSha256: "f".repeat(64) },
        reason: "Reject the substituted source reference.",
      }),
    ).rejects.toThrow();
    expect(physical(f).reviewerPublications.size).toBe(1);
    expect(physical(f).intents.size).toBe(2);
  });
  it.each(["source", "authentication"])(
    "rejects missing %s intent on original retry",
    async (kind) => {
      const f = fixture();
      const root = await f.reference.publishReviewerAuthority(f.credentials, f.intent);
      const intentKey =
        kind === "source"
          ? `release_reviewer_authority:${f.intent.authorityVersionId}`
          : `release_reviewer_publication:rrp_${root.publication.definitionSha256.slice(0, 60)}`;
      physical(f).intents.delete(intentKey);
      await expect(f.reference.publishReviewerAuthority(f.credentials, f.intent)).rejects.toThrow();
      expect(
        await f.reference.readSyntheticReviewerAuthority(f.scope, f.intent.authorityVersionId),
      ).toEqual(root.record);
    },
  );
  it.each(["declaration", "lifecycle"])(
    "rejects a false created receipt after the actual owning %s write",
    async (kind) => {
      const f = fixture();
      if (kind === "declaration") {
        const original =
          MemoryReleaseReviewerAuthorityRepository.prototype.publishReleaseReviewerAuthority;
        const spy = vi
          .spyOn(
            MemoryReleaseReviewerAuthorityRepository.prototype,
            "publishReleaseReviewerAuthority",
          )
          .mockImplementationOnce(async function (
            this: MemoryReleaseReviewerAuthorityRepository,
            row,
          ) {
            const result = await original.call(this, row);
            return { ...result, created: false };
          });
        try {
          await expect(
            f.reference.publishReviewerAuthority(f.credentials, f.intent),
          ).rejects.toThrow();
        } finally {
          spy.mockRestore();
        }
        expect(
          await f.reference.readSyntheticReviewerAuthority(f.scope, f.intent.authorityVersionId),
        ).toBeNull();
        expect(physical(f).intents.size).toBe(0);
      } else {
        const root = await f.reference.publishReviewerAuthority(f.credentials, f.intent);
        const original =
          MemoryReleaseReviewerAuthorityRepository.prototype
            .publishReleaseReviewerAuthorityLifecycleEvent;
        const spy = vi
          .spyOn(
            MemoryReleaseReviewerAuthorityRepository.prototype,
            "publishReleaseReviewerAuthorityLifecycleEvent",
          )
          .mockImplementationOnce(async function (
            this: MemoryReleaseReviewerAuthorityRepository,
            event,
          ) {
            const result = await original.call(this, event);
            return { ...result, created: false };
          });
        try {
          await expect(
            f.reference.publishReviewerAuthorityLifecycle(f.credentials, {
              kind: "revoked",
              eventId: "event_false_created",
              authority: root.publication.subject.authority,
              reason: "Keep the strict actual publication receipt.",
            }),
          ).rejects.toThrow();
        } finally {
          spy.mockRestore();
        }
        expect(
          await physical(f).reviewers.findReleaseReviewerAuthorityLifecycleEvent(
            f.scope,
            "event_false_created",
          ),
        ).toBeNull();
        expect(physical(f).intents.size).toBe(2);
      }
    },
  );
  it.each(["scope", "kind", "id", "source"])(
    "rejects substituted %s original material on owning reinspection",
    async (kind) => {
      const f = fixture();
      const root = await f.reference.publishReviewerAuthority(f.credentials, f.intent);
      let replacement: ReleaseReviewerPublicationMaterial;
      if (kind === "scope") {
        const other = fixture("other_material", "tenant_other_material");
        await other.reference.publishReviewerAuthority(other.credentials, other.intent);
        replacement = other.reference.readSyntheticReviewerPublication(
          other.scope,
          "release_reviewer_authority",
          other.intent.authorityVersionId,
        )!;
      } else if (kind === "kind") {
        const event = {
          kind: "revoked",
          eventId: "event_material",
          authority: root.publication.subject.authority,
          reason: "Retain the exact event for kind substitution.",
        };
        await f.reference.publishReviewerAuthorityLifecycle(f.credentials, event);
        replacement = f.reference.readSyntheticReviewerPublication(
          f.scope,
          "release_reviewer_authority_lifecycle",
          event.eventId,
        )!;
      } else if (kind === "id") {
        await f.reference.publishReviewerAuthority(f.credentials, {
          ...f.intent,
          authorityVersionId: "version_material_other",
          predecessor: root.publication.subject.authority,
        });
        replacement = f.reference.readSyntheticReviewerPublication(
          f.scope,
          "release_reviewer_authority",
          "version_material_other",
        )!;
      } else {
        replacement = f.reference.readSyntheticReviewerPublication(
          f.scope,
          "release_reviewer_authority",
          f.intent.authorityVersionId,
        )!;
        const tenants = (
          physical(f).reviewers as unknown as {
            tenants: Map<string, { versions: Map<string, ReleaseReviewerAuthority> }>;
          }
        ).tenants;
        tenants.get(f.scope.tenantId)!.versions.delete(f.intent.authorityVersionId);
      }
      physical(f).reviewerPublications.set(
        `release_reviewer_authority:${f.intent.authorityVersionId}`,
        replacement,
      );
      await expect(f.reference.publishReviewerAuthority(f.credentials, f.intent)).rejects.toThrow();
    },
  );
  it.each(["projectId", "environmentId"] as const)(
    "does not adopt an original in another authorized %s",
    async (field) => {
      const f = fixture();
      const root = await f.reference.publishReviewerAuthority(f.credentials, f.intent);
      const scope = { ...f.scope, [field]: "other_scope" };
      await expect(
        f.reference.publishReviewerAuthority({ ...f.credentials, scope }, f.intent),
      ).rejects.toThrow();
      expect(
        await f.reference.readSyntheticReviewerAuthority(scope, f.intent.authorityVersionId),
      ).toBeNull();
      expect(
        f.reference.readSyntheticReviewerPublication(
          scope,
          "release_reviewer_authority",
          f.intent.authorityVersionId,
        ),
      ).toBeNull();
      expect(
        await f.reference.readSyntheticReviewerAuthority(f.scope, f.intent.authorityVersionId),
      ).toEqual(root.record);
    },
  );
  it.each(["source", "authentication"])(
    "rolls back a conflicting %s intent with its tentative source and provenance",
    async (kind) => {
      const f = fixture();
      let intentKey = `release_reviewer_authority:${f.intent.authorityVersionId}`;
      if (kind === "authentication") {
        const shadow = fixture();
        const published = await shadow.reference.publishReviewerAuthority(
          shadow.credentials,
          shadow.intent,
        );
        intentKey = `release_reviewer_publication:rrp_${published.publication.definitionSha256.slice(0, 60)}`;
      }
      physical(f).intents.set(intentKey, { conflicting: true });
      await expect(f.reference.publishReviewerAuthority(f.credentials, f.intent)).rejects.toThrow();
      expect(
        await f.reference.readSyntheticReviewerAuthority(f.scope, f.intent.authorityVersionId),
      ).toBeNull();
      expect(physical(f).reviewerPublications.size).toBe(0);
      expect(physical(f).intents.size).toBe(1);
    },
  );
  it("does not permit a reviewer to issue their own authority", async () => {
    const f = fixture();
    await expect(
      f.reference.publishReviewerAuthority(f.credentials, {
        ...f.intent,
        reviewerPrincipalId: f.grant.identity.principalId,
      }),
    ).rejects.toThrow();
    expect(
      await f.reference.readSyntheticReviewerAuthority(f.scope, f.intent.authorityVersionId),
    ).toBeNull();
  });
  it.each(["unverifiable", "rejected"] as const)(
    "preserves %s declarations and future effectiveness without inventing an active selection",
    async (status) => {
      const f = fixture();
      const result = await f.reference.publishReviewerAuthority(f.credentials, {
        ...f.intent,
        status,
        statusReasons: ["Qualifications remain unresolved."],
        effectiveAt: "2027-01-01T00:00:00Z",
      });
      expect((result.record as ReleaseReviewerAuthority).status).toBe(status);
      expect((result.record as ReleaseReviewerAuthority).assurance).toBe("synthetic_reference");
      expect(result.publication.operation).toBe("manage_reviewer_authority");
    },
  );
  it("records exact supersession and preserves its first receipt across another login", async () => {
    const f = fixture();
    const root = await f.reference.publishReviewerAuthority(f.credentials, f.intent);
    const authority = releaseReviewerAuthorityReference(root.record as ReleaseReviewerAuthority);
    const next = await f.reference.publishReviewerAuthority(f.credentials, {
      ...f.intent,
      authorityVersionId: "reviewer_successor",
      predecessor: authority,
    });
    const intent = {
      eventId: "reviewer_superseded",
      kind: "superseded",
      authority,
      successor: releaseReviewerAuthorityReference(next.record as ReleaseReviewerAuthority),
      reason: "Supersede this exact declaration.",
    };
    const first = await f.reference.publishReviewerAuthorityLifecycle(f.credentials, intent);
    const retry = await f.reference.publishReviewerAuthorityLifecycle(
      f.login("request_reviewer_retry"),
      intent,
    );
    expect(retry.created).toBe(false);
    expect(retry.record).toEqual(first.record);
    expect(retry.publication).toEqual(first.publication);
  });
  it.each(["original", "root", "parent", "terminal"])(
    "refuses to adopt an unproven legacy %s",
    async (kind) => {
      const f = fixture();
      const source = releaseReviewerAuthorityRepositoryFixture("reviewer_reference").original;
      // Seed an actual owning record with its original legitimate issuer and canonical digest.
      await f.reference.seedSyntheticReviewerAuthority(source);
      if (kind === "terminal")
        await expect(
          f.reference.publishReviewerAuthorityLifecycle(f.credentials, {
            eventId: "reviewer_revoked",
            kind: "revoked",
            authority: releaseReviewerAuthorityReference(source),
            reason: "Revoke the retained legacy declaration.",
          }),
        ).rejects.toThrow();
      else
        await expect(
          f.reference.publishReviewerAuthority(f.credentials, {
            ...f.intent,
            authorityVersionId:
              kind === "original" ? f.intent.authorityVersionId : "reviewer_new_version",
            ...(kind === "parent"
              ? { predecessor: releaseReviewerAuthorityReference(source) }
              : {}),
          }),
        ).rejects.toThrow();
      expect(
        await f.reference.readSyntheticReviewerAuthority(f.scope, "reviewer_new_version"),
      ).toBeNull();
      expect(physical(f).reviewerPublications.size).toBe(0);
    },
  );
  it.each(["grant", "session", "expiry"] as const)(
    "rejects an actual intervening %s mutation without partial source/profile/intent publication",
    async (kind) => {
      const f = fixture();
      const owning =
        MemoryReleaseReviewerAuthorityRepository.prototype.readReleaseReviewerAuthorityTarget;
      const spy = vi
        .spyOn(
          MemoryReleaseReviewerAuthorityRepository.prototype,
          "readReleaseReviewerAuthorityTarget",
        )
        .mockImplementationOnce(async function (
          this: MemoryReleaseReviewerAuthorityRepository,
          ...args
        ) {
          const result = await owning.apply(this, args);
          if (kind === "grant")
            f.reference.writeSyntheticGrant({ ...f.grant, capabilities: [], revision: 2 });
          if (kind === "session")
            f.reference.revokeSyntheticSession(f.scope, `session_${f.scope.tenantId}_1`);
          if (kind === "expiry") f.setTime("2026-10-19T13:00:00.000Z");
          return result;
        });
      try {
        await expect(
          f.reference.publishReviewerAuthority(f.credentials, f.intent),
        ).rejects.toThrow();
      } finally {
        spy.mockRestore();
      }
      expect(
        await f.reference.readSyntheticReviewerAuthority(f.scope, f.intent.authorityVersionId),
      ).toBeNull();
      expect(physical(f).reviewerPublications.size).toBe(0);
      expect(physical(f).intents.size).toBe(0);
      if (kind === "session")
        expect(
          physical(f).sessions.get(`session_${f.scope.tenantId}_1`)?.credential.revokedAt,
        ).toBe("2026-10-19T12:00:00.000Z");
    },
  );
});
