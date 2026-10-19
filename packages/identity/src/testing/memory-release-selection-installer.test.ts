import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  encodeReleasePolicyDefinition,
  encodeReleasePolicySelectionDefinition,
  ReleasePolicyDefinitionSchema,
  type ReleasePolicyDefinition,
  type ReleasePolicy,
  type ReleaseDecisionSessionState,
  type ReleaseSelectionPublicationMaterial,
  type ReleaseDecisionIdentityGrant,
  type ReleasePolicySelection,
} from "@proofstack/contracts";
import {
  releasePolicySelectionReference,
  ReleaseDecisionVerificationBudget,
  validateReleaseSelectionPublicationMaterial,
} from "@proofstack/core";
import {
  MemoryReleasePolicyRepository,
  MemoryReleasePolicySelectionRepository,
  releasePolicyRepositoryFixture,
  releasePolicyLifecycleFixture,
  releasePolicySelectionRepositoryFixture,
  selectionVersion,
} from "@proofstack/core/testing";
import { MemoryReleaseSelectionInstallerReference } from "./memory-release-selection-installer.js";
import {
  releaseSelectionInstallerConformanceCases,
  type ReleaseSelectionInstallerConformanceFactory,
} from "./release-selection-installer-conformance.js";
import * as browserSecrets from "../oidc-secrets.js";
import { ReleaseMutationAuthenticator } from "../release-mutation-authentication.js";

type Fixture = ReturnType<typeof fixture>;
type PhysicalState = {
  policies: MemoryReleasePolicyRepository;
  selections: MemoryReleasePolicySelectionRepository;
  grants: Map<string, ReleaseDecisionIdentityGrant>;
  sessions: Map<string, { credential: ReleaseDecisionSessionState }>;
  publications: Map<string, ReleaseSelectionPublicationMaterial>;
  intents: Map<string, unknown>;
};
/** Fixture-owner corruption/observation only, never another public mutation interface. */
function physical(f: Fixture): PhysicalState {
  return (f.reference as unknown as { tenants: Map<string, PhysicalState> }).tenants.get(
    f.scope.tenantId,
  )!;
}
function policyFor(
  f: Fixture,
  patch: Partial<ReleasePolicyDefinition> = {},
  publishedAt?: string,
): ReleasePolicy {
  const template = releasePolicyRepositoryFixture("memory_policy", f.scope);
  const {
    schemaVersion: _version,
    definitionSha256: _hash,
    scope: _scope,
    publishedAt: _at,
    publishedByPrincipalId: _by,
    ...base
  } = template;
  const definition = ReleasePolicyDefinitionSchema.parse({
    ...base,
    installationBinding: { ...base.installationBinding, installationId: f.intent.installationId },
    ...patch,
  });
  return {
    ...template,
    ...definition,
    publishedAt: publishedAt ?? template.publishedAt,
    publishedByPrincipalId: definition.issuerPrincipalId,
    definitionSha256: createHash("sha256")
      .update(encodeReleasePolicyDefinition({ scope: f.scope, definition }))
      .digest("hex"),
  };
}
function policyIntent(f: Fixture, policy: ReleasePolicy) {
  return {
    ...f.intent,
    mode: policy.mode === "mandatory" ? "enforce" : "observation_only",
    policies: [
      {
        policy: {
          policyId: policy.policyId,
          policyVersionId: policy.policyVersionId,
          definitionSha256: policy.definitionSha256,
        },
        mode: policy.mode,
      },
    ],
  };
}

function fixture(
  namespace = "memory_auth",
  tenantId?: string,
  shared?: MemoryReleaseSelectionInstallerReference,
) {
  let now = "2026-10-19T12:00:00.000Z";
  const reference =
    shared ?? new MemoryReleaseSelectionInstallerReference({ now: () => new Date(now) });
  const original = releasePolicySelectionRepositoryFixture(namespace).original;
  const scope = { ...original.scope, ...(tenantId ? { tenantId } : {}) };
  const grant: ReleaseDecisionIdentityGrant = {
    identity: {
      kind: "oidc_binding",
      principalId: "user_synthetic_installer",
      bindingId: "binding_synthetic",
    },
    tenantId: scope.tenantId,
    state: "active",
    capabilities: ["release:selection:manage"],
    roles: ["member"],
    resourceScope: { mode: "tenant" },
    revision: 1,
    updatedAt: "2026-10-19T11:59:00.000Z",
  };
  reference.writeSyntheticGrant(grant);
  const credentials = reference.createSyntheticSession({
    scope,
    bindingId: "binding_synthetic",
    sessionId: "session_synthetic",
    requestId: "request_synthetic",
  });
  const {
    scope: _scope,
    issuerPrincipalId: _issuer,
    schemaVersion: _version,
    definitionSha256: _sha,
    publishedAt: _at,
    publishedByPrincipalId: _by,
    ...definition
  } = original;
  const intent = {
    ...definition,
    mode: "observation_only" as const,
    policies: [],
    effectiveAt: "2026-01-01T00:00:00Z",
    expiresAt: "2099-01-01T00:00:00Z",
  };
  return {
    reference,
    scope,
    grant,
    credentials,
    intent,
    setTime(value: string) {
      now = value;
    },
  };
}
function meter() {
  return new ReleaseDecisionVerificationBudget({
    maxAcquisitionRecords: 10000,
    maxAcquisitionRecordBytes: 16 * 1024 * 1024,
    maxApprovalRecords: 0,
  });
}
function sharedFactory(
  reference: MemoryReleaseSelectionInstallerReference,
): ReleaseSelectionInstallerConformanceFactory {
  let sessions = 0;
  return async (namespace) => {
    const f = fixture(namespace, `tenant_${namespace}`, reference);
    let revision = f.grant.revision;
    return {
      service: reference,
      scope: f.scope,
      credentials: f.credentials,
      intent: f.intent,
      principalId: f.grant.identity.principalId,
      async login(requestId) {
        sessions++;
        return reference.createSyntheticSession({
          scope: f.scope,
          bindingId: "binding_synthetic",
          sessionId: `session_shared_${sessions}`,
          requestId,
        });
      },
      async changeCapabilities(capabilities) {
        revision++;
        reference.writeSyntheticGrant({ ...f.grant, capabilities: [...capabilities], revision });
      },
      readOriginal: async (id) => reference.readSyntheticSelection(f.scope, id),
      readPublication: async (kind, id) => reference.readSyntheticPublication(f.scope, kind, id),
    };
  };
}
describe("authenticated memory reference failures and transaction boundaries", () => {
  it("rejects an over-budget complete target inventory without committing a shorter successful prefix", async () => {
    const f = fixture();
    const root = await f.reference.publishSelection(f.credentials, f.intent);
    const physicalSelections = (
      physical(f).selections as unknown as {
        tenants: Map<string, { versions: Map<string, ReleasePolicySelection> }>;
      }
    ).tenants.get(f.scope.tenantId)!;
    // Fixture-owner bulk declarations use real canonical records; avoid quadratic reference seeding.
    // This is no alternate runtime mutation or caller-selected authority census.
    const template = selectionVersion(
      root.record as ReleasePolicySelection,
      { selectionVersionId: "version_budget_template", rationale: "😀".repeat(4096) },
      "2026-10-19T12:00:00.000Z",
    );
    const {
      schemaVersion: _version,
      definitionSha256: _hash,
      publishedAt: _at,
      publishedByPrincipalId: _by,
      ...definition
    } = template;
    const canonical = Buffer.from(
      encodeReleasePolicySelectionDefinition({ scope: f.scope, definition }),
    ).toString("utf8");
    const originalId = JSON.stringify(template.selectionVersionId);
    expect(canonical.split(originalId)).toHaveLength(2);
    for (let index = 0; index < 1000; index++) {
      const selectionVersionId = `version_budget_${index}`;
      // Only one quoted generated ASCII ID changes; canonical key/array ordering stays identical.
      // The actual owning reader still validates every admitted record and hash during acquisition.
      const record = {
        ...template,
        selectionVersionId,
        definitionSha256: createHash("sha256")
          .update(canonical.replace(originalId, JSON.stringify(selectionVersionId)))
          .digest("hex"),
      };
      physicalSelections.versions.set(record.selectionVersionId, record);
      physical(f).intents.set(`release_policy_selection:${record.selectionVersionId}`, {
        eventType: "release.selection.published",
        schemaVersion: "0.1",
        payload: { recordKind: "release_policy_selection", record },
        createdAt: record.publishedAt,
      });
    }
    await expect(
      f.reference.publishSelection(f.credentials, {
        ...f.intent,
        selectionVersionId: "version_over_budget",
        predecessor: root.publication.subject.selection,
      }),
    ).rejects.toMatchObject({ code: "release_decision_verification_budget_exhausted" });
    expect(await f.reference.readSyntheticSelection(f.scope, "version_over_budget")).toBeNull();
    expect(physical(f).publications.size).toBe(1);
    expect(physical(f).intents.size).toBe(1002);
    expect(physicalSelections.versions.size).toBe(1001);
  });
  it("preserves a legacy terminal event without manufacturing an authenticated origin", async () => {
    const f = fixture();
    const root = await f.reference.publishSelection(f.credentials, f.intent);
    const intent = {
      kind: "withdrawn" as const,
      eventId: "event_legacy_terminal",
      selection: root.publication.subject.selection,
      reason: "Preserve a trusted historical declaration.",
    };
    const event = {
      ...intent,
      scope: f.scope,
      actorPrincipalId: f.grant.identity.principalId,
      schemaVersion: "0.1" as const,
      occurredAt: "2026-10-19T12:00:00.000Z",
    };
    await physical(f).selections.publishReleasePolicySelectionLifecycleEvent(event);
    physical(f).intents.set(`release_policy_selection_lifecycle:${event.eventId}`, {
      eventType: "release.selection.lifecycle_recorded",
      schemaVersion: "0.1",
      payload: { recordKind: "release_policy_selection_lifecycle", record: event },
      createdAt: event.occurredAt,
    });
    await expect(f.reference.publishLifecycle(f.credentials, intent)).rejects.toBeDefined();
    expect(
      f.reference.readSyntheticPublication(
        f.scope,
        "release_policy_selection_lifecycle",
        event.eventId,
      ),
    ).toBeNull();
    expect(physical(f).publications.size).toBe(1);
  });
  it.each(["source", "terminal"])(
    "rejects a misreported %s store receipt and discards all tentative changes",
    async (kind) => {
      const f = fixture();
      if (kind === "source") {
        const original = physical(f).selections.publishReleasePolicySelection;
        const spy = vi
          .spyOn(MemoryReleasePolicySelectionRepository.prototype, "publishReleasePolicySelection")
          .mockImplementation(async function (
            this: MemoryReleasePolicySelectionRepository,
            record: ReleasePolicySelection,
          ) {
            const result = await original.call(this, record);
            return { ...result, created: false };
          });
        try {
          await expect(f.reference.publishSelection(f.credentials, f.intent)).rejects.toBeDefined();
          expect(
            await f.reference.readSyntheticSelection(f.scope, f.intent.selectionVersionId),
          ).toBeNull();
          expect(physical(f).intents.size).toBe(0);
        } finally {
          spy.mockRestore();
        }
      } else {
        const root = await f.reference.publishSelection(f.credentials, f.intent);
        const original = physical(f).selections.publishReleasePolicySelectionLifecycleEvent;
        const spy = vi
          .spyOn(
            MemoryReleasePolicySelectionRepository.prototype,
            "publishReleasePolicySelectionLifecycleEvent",
          )
          .mockImplementation(async function (
            this: MemoryReleasePolicySelectionRepository,
            event: Parameters<
              MemoryReleasePolicySelectionRepository["publishReleasePolicySelectionLifecycleEvent"]
            >[0],
          ) {
            const result = await original.call(this, event);
            return { ...result, created: false };
          });
        try {
          await expect(
            f.reference.publishLifecycle(f.credentials, {
              kind: "withdrawn",
              eventId: "event_wrong_receipt",
              selection: root.publication.subject.selection,
              reason: "Exercise the actual store followed by a damaged transport receipt.",
            }),
          ).rejects.toBeDefined();
          expect(physical(f).publications.size).toBe(1);
          expect(physical(f).intents.size).toBe(2);
          expect(
            await physical(f).selections.findReleasePolicySelectionLifecycleEvent(
              f.scope,
              "event_wrong_receipt",
            ),
          ).toBeNull();
        } finally {
          spy.mockRestore();
        }
      }
    },
  );
  it.each(["get", "ownKeys"])(
    "the shared oracle detects a known incorrect %s body read before authentication",
    async (method) => {
      const reference = new MemoryReleaseSelectionInstallerReference({
        now: () => new Date("2026-10-19T12:00:00.000Z"),
      });
      const factory = sharedFactory(reference);
      const conformance = releaseSelectionInstallerConformanceCases.find(
        (test) => test.name === "rejects invalid cookie before interpreting a publication body",
      )!;
      await expect(
        conformance.run(async (namespace) => {
          const h = await factory(namespace);
          return {
            ...h,
            service: {
              publishLifecycle: h.service.publishLifecycle.bind(h.service),
              async publishSelection(credentials, body) {
                // Deliberately incorrect order is a negative control for the shared test oracle.
                if (method === "get") Reflect.get(body as object, "selectionId");
                else Reflect.ownKeys(body as object);
                return h.service.publishSelection(credentials, body);
              },
            },
          };
        }),
      ).rejects.toThrow(/true !== false/);
    },
  );
  it("rejects a repeated random session digest without rebinding an existing cookie", () => {
    const secret = browserSecrets.generateBrowserSessionCredentials();
    const spy = vi
      .spyOn(browserSecrets, "generateBrowserSessionCredentials")
      .mockReturnValue(secret);
    try {
      const f = fixture();
      expect(() =>
        f.reference.createSyntheticSession({
          scope: f.scope,
          bindingId: "binding_synthetic",
          sessionId: "session_collision",
          requestId: "request_collision",
        }),
      ).toThrow();
      expect(physical(f).sessions.size).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });
  it.each(["projectId", "environmentId"] as const)(
    "does not adopt an original in another authorized %s",
    async (field) => {
      const f = fixture();
      const root = await f.reference.publishSelection(f.credentials, f.intent);
      const scope = { ...f.scope, [field]: "scope_other" };
      await expect(
        f.reference.publishSelection({ ...f.credentials, scope }, f.intent),
      ).rejects.toBeDefined();
      expect(
        await f.reference.readSyntheticSelection(scope, f.intent.selectionVersionId),
      ).toBeNull();
      expect(
        f.reference.readSyntheticPublication(
          scope,
          "release_policy_selection",
          f.intent.selectionVersionId,
        ),
      ).toBeNull();
      expect(
        await f.reference.readSyntheticSelection(f.scope, f.intent.selectionVersionId),
      ).toEqual(root.record);
    },
  );
  it("publishes at most one of two overlapping writes to the same tenant without automatic retry", async () => {
    const f = fixture();
    const results = await Promise.allSettled([
      f.reference.publishSelection(f.credentials, f.intent),
      f.reference.publishSelection(
        { ...f.credentials, requestId: "request_concurrent" },
        { ...f.intent, selectionVersionId: "version_concurrent" },
      ),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(physical(f).publications.size).toBe(1);
    expect(physical(f).intents.size).toBe(2);
  });
  it.each(["session_missing", "revocation", "scope", "capability"])(
    "rechecks %s after actual authentication instead of trusting its earlier receipt",
    async (kind) => {
      const f = fixture();
      const original = ReleaseMutationAuthenticator.prototype.authenticateSelectionInstaller;
      const spy = vi
        .spyOn(ReleaseMutationAuthenticator.prototype, "authenticateSelectionInstaller")
        .mockImplementation(async function (this: ReleaseMutationAuthenticator, credentials) {
          const proof = await original.call(this, credentials);
          if (kind === "session_missing") physical(f).sessions.delete("session_synthetic");
          if (kind === "revocation")
            f.reference.revokeSyntheticSession(f.scope, "session_synthetic");
          if (kind === "scope")
            f.reference.writeSyntheticGrant({
              ...f.grant,
              revision: 2,
              resourceScope: { mode: "restricted", projects: [{ projectId: "project_other" }] },
            });
          if (kind === "capability")
            f.reference.writeSyntheticGrant({ ...f.grant, revision: 2, capabilities: [] });
          return proof;
        });
      try {
        await expect(f.reference.publishSelection(f.credentials, f.intent)).rejects.toBeDefined();
        expect(physical(f).publications.size).toBe(0);
        expect(physical(f).intents.size).toBe(0);
      } finally {
        spy.mockRestore();
      }
    },
  );
  it.each(["source", "authentication"])(
    "rejects missing %s intent on historical retry",
    async (kind) => {
      const f = fixture();
      const root = await f.reference.publishSelection(f.credentials, f.intent);
      const id =
        kind === "source"
          ? `release_policy_selection:${f.intent.selectionVersionId}`
          : `release_selection_publication:rsp_${root.publication.definitionSha256.slice(0, 60)}`;
      physical(f).intents.delete(id);
      await expect(f.reference.publishSelection(f.credentials, f.intent)).rejects.toBeDefined();
      expect(
        await f.reference.readSyntheticSelection(f.scope, f.intent.selectionVersionId),
      ).toEqual(root.record);
    },
  );
  it.each(["scope", "kind", "id", "source"])(
    "rejects substituted %s original material on owning reinspection",
    async (kind) => {
      const f = fixture();
      const root = await f.reference.publishSelection(f.credentials, f.intent);
      let replacement: ReleaseSelectionPublicationMaterial;
      if (kind === "scope") {
        const other = fixture("other_material", "tenant_other_material");
        await other.reference.publishSelection(other.credentials, other.intent);
        replacement = other.reference.readSyntheticPublication(
          other.scope,
          "release_policy_selection",
          other.intent.selectionVersionId,
        )!;
      } else if (kind === "kind") {
        const event = {
          kind: "withdrawn",
          eventId: "event_material",
          selection: root.publication.subject.selection,
          reason: "Retain the exact event for a kind substitution control.",
        };
        await f.reference.publishLifecycle(f.credentials, event);
        replacement = f.reference.readSyntheticPublication(
          f.scope,
          "release_policy_selection_lifecycle",
          event.eventId,
        )!;
      } else if (kind === "id") {
        await f.reference.publishSelection(f.credentials, {
          ...f.intent,
          selectionVersionId: "version_material_other",
          predecessor: root.publication.subject.selection,
        });
        replacement = f.reference.readSyntheticPublication(
          f.scope,
          "release_policy_selection",
          "version_material_other",
        )!;
      } else {
        replacement = f.reference.readSyntheticPublication(
          f.scope,
          "release_policy_selection",
          f.intent.selectionVersionId,
        )!;
        const tenants = (
          physical(f).selections as unknown as {
            tenants: Map<string, { versions: Map<string, ReleasePolicySelection> }>;
          }
        ).tenants;
        const state = tenants.get(f.scope.tenantId)!;
        const stored = state.versions.get(f.intent.selectionVersionId)!;
        state.versions.set(f.intent.selectionVersionId, {
          ...stored,
          publishedAt: "2026-10-19T12:00:00.001Z",
        });
      }
      physical(f).publications.set(
        `release_policy_selection:${f.intent.selectionVersionId}`,
        replacement,
      );
      await expect(f.reference.publishSelection(f.credentials, f.intent)).rejects.toBeDefined();
    },
  );
  it.each(["identity", "revision", "time", "service"])(
    "rejects invalid synthetic grant %s without replacing its owner",
    (kind) => {
      const f = fixture();
      let grant = { ...f.grant, revision: 2 };
      if (kind === "identity")
        grant = {
          ...grant,
          identity: {
            kind: "oidc_binding",
            principalId: "user_substituted",
            bindingId: "binding_synthetic",
          },
        };
      if (kind === "revision") grant.revision = 1;
      if (kind === "time") grant.updatedAt = "2026-10-19T11:58:00.000Z";
      if (kind === "service")
        grant.identity = {
          kind: "service_credential",
          principalId: "service_synthetic",
          credentialId: "credential_service",
        };
      expect(() => f.reference.writeSyntheticGrant(grant)).toThrow();
      expect(physical(f).grants.get("binding_synthetic")).toEqual(f.grant);
    },
  );
  it.each(["tenant", "binding", "duplicate"])("rejects invalid synthetic session %s", (kind) => {
    const f = fixture();
    expect(() =>
      f.reference.createSyntheticSession({
        scope: kind === "tenant" ? { ...f.scope, tenantId: "tenant_missing" } : f.scope,
        bindingId: kind === "binding" ? "binding_missing" : "binding_synthetic",
        sessionId: kind === "duplicate" ? "session_synthetic" : "session_other",
        requestId: "request_other",
      }),
    ).toThrow();
    expect(physical(f).sessions.size).toBe(1);
  });
  it.each(["tenant", "session"])("rejects missing %s on explicit session revocation", (kind) => {
    const f = fixture();
    expect(() =>
      f.reference.revokeSyntheticSession(
        kind === "tenant" ? { ...f.scope, tenantId: "tenant_missing" } : f.scope,
        kind === "session" ? "session_missing" : "session_synthetic",
      ),
    ).toThrow();
  });
  it.each([
    "revoked",
    "inactive",
    "before_creation",
    "absolute_expiry",
    "idle_expiry",
    "unknown_cookie",
  ])("rejects %s before source publication", async (kind) => {
    const f = fixture();
    if (kind === "revoked") f.reference.revokeSyntheticSession(f.scope, "session_synthetic");
    if (kind === "inactive")
      f.reference.writeSyntheticGrant({ ...f.grant, revision: 2, state: "inactive" });
    if (kind === "before_creation") f.setTime("2026-10-19T11:59:59.999Z");
    if (kind === "absolute_expiry") f.setTime("2026-10-19T13:00:00.000Z");
    if (kind === "idle_expiry") f.setTime("2026-10-19T12:30:00.000Z");
    const credentials =
      kind === "unknown_cookie" ? fixture("other_cookie").credentials : f.credentials;
    await expect(f.reference.publishSelection(credentials, f.intent)).rejects.toBeDefined();
    expect(
      await f.reference.readSyntheticSelection(f.scope, f.intent.selectionVersionId),
    ).toBeNull();
  });
  it("retains saturated use counters and clamps idle expiry to the original absolute expiry", async () => {
    const f = fixture();
    const session = physical(f).sessions.get("session_synthetic")!;
    session.credential = {
      ...session.credential,
      useCount: 2147483647,
      lastUsedAt: session.credential.createdAt,
    };
    f.setTime("2026-10-19T12:20:00.000Z");
    const first = await f.reference.publishSelection(f.credentials, f.intent);
    f.setTime("2026-10-19T12:40:00.000Z");
    const result = await f.reference.publishSelection(f.credentials, {
      ...f.intent,
      selectionVersionId: "version_clamped",
      predecessor: first.publication.subject.selection,
    });
    const material = f.reference.readSyntheticPublication(
      f.scope,
      "release_policy_selection",
      "version_clamped",
    )!;
    expect(result.created).toBe(true);
    expect(material.credential.useCount).toBe(2147483647);
    expect(material.credential.idleExpiresAt).toBe("2026-10-19T13:00:00.000Z");
  });
  it("validates original policies and complete terminal history while preserving historical retry", async () => {
    const f = fixture(),
      policy = policyFor(f);
    await f.reference.seedSyntheticPolicy(policy);
    const intent = policyIntent(f, policy);
    const first = await f.reference.publishSelection(f.credentials, intent);
    await f.reference.seedSyntheticPolicyLifecycle(
      releasePolicyLifecycleFixture("memory_withdrawn", policy, {
        occurredAt: "2026-10-19T12:00:00.000Z",
      }),
    );
    expect((await f.reference.publishSelection(f.credentials, intent)).publication).toEqual(
      first.publication,
    );
    await expect(
      f.reference.publishSelection(f.credentials, {
        ...intent,
        selectionVersionId: "version_after_withdrawal",
        predecessor: first.publication.subject.selection,
      }),
    ).rejects.toBeDefined();
    expect(
      await f.reference.readSyntheticSelection(f.scope, "version_after_withdrawal"),
    ).toBeNull();
  });
  it.each(["digest", "mode", "installation", "future_effective", "future_receipt", "expired"])(
    "rejects %s policy evidence without committing any selection",
    async (kind) => {
      const f = fixture();
      const policy = policyFor(
        f,
        kind === "future_effective"
          ? { effectiveAt: "2026-10-20T00:00:00.000Z" }
          : kind === "expired"
            ? { expiresAt: "2026-10-19T12:00:00.000Z" }
            : {},
        kind === "future_receipt" ? "2026-10-20T00:00:00.000Z" : undefined,
      );
      await f.reference.seedSyntheticPolicy(policy);
      const intent = policyIntent(f, policy);
      if (kind === "digest") intent.policies[0]!.policy.definitionSha256 = "a".repeat(64);
      if (kind === "mode") {
        intent.mode = "observation_only";
        intent.policies[0]!.mode = "advisory";
      }
      if (kind === "installation") intent.installationId = "installation_other";
      await expect(f.reference.publishSelection(f.credentials, intent)).rejects.toBeDefined();
      expect(
        await f.reference.readSyntheticSelection(f.scope, f.intent.selectionVersionId),
      ).toBeNull();
      expect(physical(f).intents.size).toBe(0);
    },
  );
  it("retains future terminal history without treating it as already effective", async () => {
    const f = fixture(),
      policy = policyFor(f);
    await f.reference.seedSyntheticPolicy(policy);
    await f.reference.seedSyntheticPolicyLifecycle(
      releasePolicyLifecycleFixture("memory_future_terminal", policy, {
        occurredAt: "2026-10-20T00:00:00.000Z",
      }),
    );
    expect(
      (await f.reference.publishSelection(f.credentials, policyIntent(f, policy))).created,
    ).toBe(true);
  });
  it("can seed an empty synthetic reference but rejects lifecycle records without their owning source", async () => {
    const f = fixture(),
      policy = policyFor(f);
    const reference = new MemoryReleaseSelectionInstallerReference({
      now: () => new Date("2026-10-19T12:00:00.000Z"),
    });
    expect(await reference.readSyntheticSelection(f.scope, f.intent.selectionVersionId)).toBeNull();
    expect(
      reference.readSyntheticPublication(
        f.scope,
        "release_policy_selection",
        f.intent.selectionVersionId,
      ),
    ).toBeNull();
    await expect(
      reference.seedSyntheticPolicyLifecycle(
        releasePolicyLifecycleFixture("memory_absent", policy),
      ),
    ).rejects.toBeDefined();
    await reference.seedSyntheticPolicy(policy);
  });
  it("preserves legacy declarations and refuses to adopt their original or logical target", async () => {
    const f = fixture();
    const legacy = selectionVersion(
      { ...f.intent, scope: f.scope, issuerPrincipalId: f.grant.identity.principalId },
      {},
      "2026-10-19T12:00:00.000Z",
    );
    const emptyReference = new MemoryReleaseSelectionInstallerReference({
      now: () => new Date("2026-10-19T12:00:00.000Z"),
    });
    await emptyReference.seedSyntheticSelection(legacy);
    expect(await emptyReference.readSyntheticSelection(f.scope, legacy.selectionVersionId)).toEqual(
      legacy,
    );
    await f.reference.seedSyntheticSelection(legacy);
    await f.reference.seedSyntheticSelection(legacy);
    await expect(f.reference.publishSelection(f.credentials, f.intent)).rejects.toBeDefined();
    await expect(
      f.reference.publishSelection(f.credentials, {
        ...f.intent,
        selectionVersionId: "version_legacy_successor",
      }),
    ).rejects.toBeDefined();
    expect(await f.reference.readSyntheticSelection(f.scope, f.intent.selectionVersionId)).toEqual(
      legacy,
    );
    expect(physical(f).publications.size).toBe(0);
  });
  it("publishes exact successors and authenticated supersession while rejecting changed lifecycle retries", async () => {
    const f = fixture();
    const root = await f.reference.publishSelection(f.credentials, f.intent);
    const successor = await f.reference.publishSelection(f.credentials, {
      ...f.intent,
      selectionVersionId: "version_successor",
      predecessor: root.publication.subject.selection,
    });
    const intent = {
      kind: "superseded" as const,
      eventId: "event_superseded",
      selection: root.publication.subject.selection,
      successor: successor.publication.subject.selection,
      reason: "Replace the exact original version.",
    };
    const first = await f.reference.publishLifecycle(f.credentials, intent);
    expect((await f.reference.publishLifecycle(f.credentials, intent)).publication).toEqual(
      first.publication,
    );
    await expect(
      f.reference.publishLifecycle(f.credentials, {
        ...intent,
        reason: "Changed original terminal intent.",
      }),
    ).rejects.toBeDefined();
    await expect(
      f.reference.publishLifecycle(f.credentials, {
        ...intent,
        occurredAt: "2026-10-19T12:00:00.000Z",
      }),
    ).rejects.toBeDefined();
  });
  it.each(["missing", "digest"])("rejects %s retained predecessor identity", async (kind) => {
    const f = fixture();
    const root = await f.reference.publishSelection(f.credentials, f.intent);
    const predecessor = {
      ...root.publication.subject.selection,
      ...(kind === "missing"
        ? { selectionVersionId: "version_missing" }
        : { definitionSha256: "a".repeat(64) }),
    };
    await expect(
      f.reference.publishSelection(f.credentials, {
        ...f.intent,
        selectionVersionId: "version_rejected_parent",
        predecessor,
      }),
    ).rejects.toBeDefined();
    expect(await f.reference.readSyntheticSelection(f.scope, "version_rejected_parent")).toBeNull();
  });
  it.each(["missing", "digest", "successor"])(
    "rejects lifecycle with %s authenticated references",
    async (kind) => {
      const f = fixture();
      const root = await f.reference.publishSelection(f.credentials, f.intent);
      const selection = {
        ...root.publication.subject.selection,
        ...(kind === "missing"
          ? { selectionVersionId: "version_missing" }
          : kind === "digest"
            ? { definitionSha256: "a".repeat(64) }
            : {}),
      };
      const intent = {
        eventId: "event_bad_reference",
        kind: "withdrawn",
        selection,
        reason: "Retain the missing or substituted reference.",
      };
      await expect(
        f.reference.publishLifecycle(
          f.credentials,
          kind === "successor"
            ? {
                ...intent,
                kind: "superseded",
                successor: { ...selection, selectionVersionId: "version_missing" },
              }
            : intent,
        ),
      ).rejects.toBeDefined();
      expect(
        f.reference.readSyntheticPublication(
          f.scope,
          "release_policy_selection_lifecycle",
          intent.eventId,
        ),
      ).toBeNull();
    },
  );
  it.each(["source", "authentication"])(
    "rejects a conflicting %s intent and rolls back tentative source and provenance together",
    async (kind) => {
      const f = fixture();
      let intentKey = `release_policy_selection:${f.intent.selectionVersionId}`;
      if (kind === "authentication") {
        const shadow = fixture();
        const published = await shadow.reference.publishSelection(
          shadow.credentials,
          shadow.intent,
        );
        intentKey = `release_selection_publication:rsp_${published.publication.definitionSha256.slice(0, 60)}`;
      }
      physical(f).intents.set(intentKey, { conflicting: true });
      await expect(f.reference.publishSelection(f.credentials, f.intent)).rejects.toBeDefined();
      expect(
        await f.reference.readSyntheticSelection(f.scope, f.intent.selectionVersionId),
      ).toBeNull();
      expect(physical(f).publications.size).toBe(0);
      expect(physical(f).intents.size).toBe(1);
    },
  );
  it.each(["grant", "withdrawal", "expiry"])(
    "rejects intervening %s after an actual owning read begins",
    async (kind) => {
      const f = fixture(),
        policy = policyFor(f, kind === "expiry" ? { expiresAt: "2026-10-19T12:00:01.000Z" } : {});
      await f.reference.seedSyntheticPolicy(policy);
      let start!: () => void, release!: () => void;
      const started = new Promise<void>((resolve) => {
        start = resolve;
      });
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      const original = MemoryReleasePolicyRepository.prototype.findReleasePolicy;
      const spy = vi
        .spyOn(MemoryReleasePolicyRepository.prototype, "findReleasePolicy")
        .mockImplementation(async function (this: MemoryReleasePolicyRepository, scope, id) {
          start();
          await barrier;
          return original.call(this, scope, id);
        });
      try {
        const pending = f.reference.publishSelection(f.credentials, policyIntent(f, policy));
        const rejected = expect(pending).rejects.toBeDefined();
        await started;
        if (kind === "grant")
          f.reference.writeSyntheticGrant({ ...f.grant, revision: 2, capabilities: [] });
        if (kind === "withdrawal")
          await f.reference.seedSyntheticPolicyLifecycle(
            releasePolicyLifecycleFixture("memory_race", policy, {
              occurredAt: "2026-10-19T12:00:00.000Z",
            }),
          );
        if (kind === "expiry") f.setTime("2026-10-19T12:00:02.000Z");
        release();
        await rejected;
        expect(
          await f.reference.readSyntheticSelection(f.scope, f.intent.selectionVersionId),
        ).toBeNull();
        expect(physical(f).publications.size).toBe(0);
        expect(physical(f).intents.size).toBe(0);
      } finally {
        release();
        spy.mockRestore();
      }
    },
  );
});
describe("synthetic actual authenticated selection memory reference", () => {
  for (const conformance of releaseSelectionInstallerConformanceCases) {
    it(conformance.name, async () => {
      const reference = new MemoryReleaseSelectionInstallerReference({
        now: () => new Date("2026-10-19T12:00:00.000Z"),
      });
      await conformance.run(sharedFactory(reference));
    });
  }
  it("commits real authenticated original, safe provenance and intents together", async () => {
    const f = fixture();
    const result = await f.reference.publishSelection(f.credentials, f.intent);
    expect(f.reference.mode).toBe("synthetic_reference");
    expect(result.created).toBe(true);
    expect(await f.reference.readSyntheticSelection(f.scope, f.intent.selectionVersionId)).toEqual(
      result.record,
    );
    const material = f.reference.readSyntheticPublication(
      f.scope,
      "release_policy_selection",
      f.intent.selectionVersionId,
    );
    expect(validateReleaseSelectionPublicationMaterial(material, meter()).publication).toEqual(
      result.publication,
    );
    expect(result.publication.actor).toMatchObject({
      principalId: f.grant.identity.principalId,
      authenticationMethod: "oidc",
      credentialId: "session_synthetic",
    });
    expect(JSON.stringify(result)).not.toContain(f.credentials.sessionToken);
    expect(JSON.stringify(result)).not.toContain(f.credentials.csrfToken);
    expect(result.usage.records).toBeGreaterThan(0);
  });
  it("retains original actor/request/cut after a real different login and later retry", async () => {
    const f = fixture();
    const first = await f.reference.publishSelection(f.credentials, f.intent);
    f.setTime("2026-10-19T12:00:05.000Z");
    const credentials = f.reference.createSyntheticSession({
      scope: f.scope,
      bindingId: "binding_synthetic",
      sessionId: "session_second",
      requestId: "request_second",
    });
    const second = await f.reference.publishSelection(credentials, f.intent);
    expect(second.created).toBe(false);
    expect(second.record).toEqual(first.record);
    expect(second.publication).toEqual(first.publication);
  });
  it.each(["csrf", "cookie", "capability"])(
    "rejects invalid %s before inspecting a body",
    async (change) => {
      const f = fixture();
      const credentials = { ...f.credentials };
      if (change === "csrf") credentials.csrfToken = "invalid";
      if (change === "cookie") credentials.sessionToken = "invalid";
      if (change === "capability")
        f.reference.writeSyntheticGrant({ ...f.grant, capabilities: [], revision: 2 });
      let observed = false;
      const body = new Proxy(
        {},
        {
          get() {
            observed = true;
            throw new Error("Body was inspected");
          },
          ownKeys() {
            observed = true;
            throw new Error("Body was inspected");
          },
        },
      );
      await expect(f.reference.publishSelection(credentials, body)).rejects.toBeDefined();
      expect(observed).toBe(false);
      expect(
        await f.reference.readSyntheticSelection(f.scope, f.intent.selectionVersionId),
      ).toBeNull();
    },
  );
  it("publishes and retries exact terminal lifecycle with the original authenticated receipt", async () => {
    const f = fixture();
    const root = await f.reference.publishSelection(f.credentials, f.intent);
    const intent = {
      eventId: "event_synthetic_withdrawn",
      kind: "withdrawn" as const,
      selection: releasePolicySelectionReference(root.record as ReleasePolicySelection),
      reason: "Withdraw this exact synthetic reference selection.",
    };
    const first = await f.reference.publishLifecycle(f.credentials, intent);
    f.setTime("2026-10-19T12:00:02.000Z");
    const second = await f.reference.publishLifecycle(
      { ...f.credentials, requestId: "request_retry" },
      intent,
    );
    expect(second.created).toBe(false);
    expect(second.record).toEqual(first.record);
    expect(second.publication).toEqual(first.publication);
    expect(
      validateReleaseSelectionPublicationMaterial(
        f.reference.readSyntheticPublication(
          f.scope,
          "release_policy_selection_lifecycle",
          intent.eventId,
        ),
        meter(),
      ).publication,
    ).toEqual(first.publication);
  });
  it("rejects substituted original intent without overwriting its authenticated publication", async () => {
    const f = fixture();
    const first = await f.reference.publishSelection(f.credentials, f.intent);
    await expect(
      f.reference.publishSelection(f.credentials, {
        ...f.intent,
        rationale: "Changed original body.",
      }),
    ).rejects.toBeDefined();
    expect(await f.reference.readSyntheticSelection(f.scope, f.intent.selectionVersionId)).toEqual(
      first.record,
    );
  });
});
