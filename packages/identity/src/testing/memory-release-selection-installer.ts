import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import {
  EvidenceScopeSchema,
  encodeReleasePolicySelectionDefinition,
  OpaqueIdSchema,
  PolicyEvaluationTimeSchema,
  policyEvaluationTimestampOrderKey,
  PublishReleasePolicySelectionLifecycleRequestSchema,
  PublishReleasePolicySelectionRequestSchema,
  ReleaseApprovalReviewerReceiptSchema,
  ReleaseDecisionIdentityGrantSchema,
  ReleaseDecisionSessionStateSchema,
  ReleasePolicySelectionDefinitionSchema,
  ReleasePolicySelectionSchema,
  ReleasePolicySelectionLifecycleEventSchema,
  type EvidenceScope,
  type ReleaseApprovalReviewerReceipt,
  type ReleaseDecisionIdentityGrant,
  type ReleaseDecisionSessionState,
  type ReleasePolicy,
  type ReleasePolicyLifecycleEvent,
  type ReleasePolicySelection,
  type ReleaseSelectionPublicationMaterial,
} from "@proofstack/contracts";
import {
  inspectCapturedReleaseIdentityState,
  prepareReleaseSelectionPublicationMaterial,
  releasePolicyReference,
  ReleaseDecisionVerificationBudget,
  validateReleasePolicyRecord,
  validateReleaseSelectionPublicationMaterial,
  type Clock,
} from "@proofstack/core";
import {
  MemoryReleasePolicyRepository,
  MemoryReleasePolicySelectionRepository,
} from "@proofstack/core/testing";
import { generateBrowserSessionCredentials } from "../oidc-secrets.js";
import { OidcSessionAuthenticator, type AuthenticatableBrowserSession } from "../oidc-session.js";
import {
  readReleaseMutationAuthentication,
  ReleaseMutationAuthenticator,
  type ReleaseBrowserMutationCredentials,
} from "../release-mutation-authentication.js";
import type {
  ReleaseSelectionInstaller,
  ReleaseSelectionInstallerResult,
} from "../release-selection-installer.js";

type Material = ReleaseSelectionPublicationMaterial;
type Kind = Material["source"]["kind"];
type StoredSession = {
  readonly credential: ReleaseDecisionSessionState;
  readonly sessionDigest: string;
  readonly csrfDigest: string;
};
interface State {
  readonly policies: MemoryReleasePolicyRepository;
  readonly selections: MemoryReleasePolicySelectionRepository;
  readonly grants: Map<string, ReleaseDecisionIdentityGrant>;
  readonly sessions: Map<string, StoredSession>;
  readonly publications: Map<string, Material>;
  readonly intents: Map<string, unknown>;
}
const empty = (): State => ({
  policies: new MemoryReleasePolicyRepository(),
  selections: new MemoryReleasePolicySelectionRepository(),
  grants: new Map(),
  sessions: new Map(),
  publications: new Map(),
  intents: new Map(),
});
const fork = (state: State): State => ({
  policies: state.policies.fork(),
  selections: state.selections.fork(),
  grants: structuredClone(state.grants),
  sessions: structuredClone(state.sessions),
  publications: structuredClone(state.publications),
  intents: structuredClone(state.intents),
});
const key = (kind: string, id: string) => `${kind}:${id}`;
const order = policyEvaluationTimestampOrderKey;
const limits = {
  maxAcquisitionRecords: 10000,
  maxAcquisitionRecordBytes: 16 * 1024 * 1024,
  maxApprovalRecords: 0,
} as const;
export class MemoryReleaseSelectionInstallerReferenceError extends Error {
  readonly code = "release_selection_installer_rejected";
  constructor() {
    super("Synthetic reference selection installation was rejected");
    this.name = "MemoryReleaseSelectionInstallerReferenceError";
  }
}
function fail(): never {
  throw new MemoryReleaseSelectionInstallerReferenceError();
}
function sourceId(source: Material["source"]): string {
  return source.kind === "release_policy_selection"
    ? source.record.selectionVersionId
    : source.record.eventId;
}
function sourceIntent(source: Material["source"]) {
  return {
    eventType:
      source.kind === "release_policy_selection"
        ? "release.selection.published"
        : "release.selection.lifecycle_recorded",
    schemaVersion: "0.1",
    payload: { recordKind: source.kind, record: source.record },
    createdAt:
      source.kind === "release_policy_selection"
        ? source.record.publishedAt
        : source.record.occurredAt,
  };
}
const profileKey = (material: Material) =>
  key("release_selection_publication", `rsp_${material.publication.definitionSha256.slice(0, 60)}`);
const profileIntent = (material: Material) => ({
  eventType: "release.selection.authentication_recorded",
  schemaVersion: "0.1",
  payload: { recordKind: "release_selection_publication", record: material.publication },
  createdAt: material.publication.issuedAt,
});

/** Explicit synthetic workspace reference, not a production OIDC store or durable transaction.
 * Actual cookie/CSRF verification uses the owning authenticators over this same private state.
 * All source/profile/intents commit by one per-tenant compare-and-replace; no mutable repository
 * handle, principal, authority callback or generic transaction interface escapes.
 * Synthetic seed/session methods are fixture-owner operations, never public HTTP capabilities.
 */
export class MemoryReleaseSelectionInstallerReference implements ReleaseSelectionInstaller {
  readonly mode = "synthetic_reference" as const;
  private readonly tenants = new Map<string, State>();
  private readonly sessionIndex = new Map<string, { tenantId: string; sessionId: string }>();
  private readonly authentication: ReleaseMutationAuthenticator;

  constructor(private readonly clock: Clock) {
    this.authentication = new ReleaseMutationAuthenticator(
      new OidcSessionAuthenticator({ findAndTouchActive: (digest) => this.touch(digest) }),
    );
  }
  private now(): string {
    return PolicyEvaluationTimeSchema.parse(this.clock.now().toISOString());
  }
  private commit(tenant: string, original: State | undefined, next: State): void {
    if (this.tenants.get(tenant) !== original) fail();
    this.tenants.set(tenant, next);
  }
  /** Fixed synthetic owner input; it cannot authenticate a public request. */
  writeSyntheticGrant(input: ReleaseDecisionIdentityGrant): void {
    const grant = ReleaseDecisionIdentityGrantSchema.parse(input);
    if (grant.identity.kind !== "oidc_binding") fail();
    const original = this.tenants.get(grant.tenantId),
      next = fork(original ?? empty()),
      prior = next.grants.get(grant.identity.bindingId);
    if (
      prior &&
      (!isDeepStrictEqual(prior.identity, grant.identity) ||
        grant.revision <= prior.revision ||
        order(grant.updatedAt) < order(prior.updatedAt))
    )
      fail();
    next.grants.set(grant.identity.bindingId, grant);
    this.commit(grant.tenantId, original, next);
  }
  createSyntheticSession(input: {
    readonly scope: EvidenceScope;
    readonly bindingId: string;
    readonly sessionId: string;
    readonly requestId: string;
  }): ReleaseBrowserMutationCredentials {
    const scope = EvidenceScopeSchema.parse(input.scope),
      id = OpaqueIdSchema.parse(input.sessionId),
      original = this.tenants.get(scope.tenantId),
      grant = original?.grants.get(OpaqueIdSchema.parse(input.bindingId));
    if (!original || !grant || original.sessions.has(id)) fail();
    const createdAt = this.now(),
      created = Date.parse(createdAt),
      secret = generateBrowserSessionCredentials(),
      next = fork(original);
    if (this.sessionIndex.has(secret.sessionDigest)) fail();
    const credential = ReleaseDecisionSessionStateSchema.parse({
      schemaVersion: "0.1",
      kind: "oidc_session",
      tenantId: scope.tenantId,
      principalId: grant.identity.principalId,
      bindingId: input.bindingId,
      credentialId: id,
      createdAt,
      absoluteExpiresAt: new Date(created + 3600000).toISOString(),
      idleExpiresAt: new Date(created + 1800000).toISOString(),
      idleLifetimeSeconds: 1800,
      lastUsedAt: null,
      useCount: 0,
      revokedAt: null,
      revocationReason: null,
    });
    next.sessions.set(id, {
      credential,
      sessionDigest: secret.sessionDigest,
      csrfDigest: secret.csrfDigest,
    });
    this.commit(scope.tenantId, original, next);
    this.sessionIndex.set(secret.sessionDigest, { tenantId: scope.tenantId, sessionId: id });
    return {
      scope,
      requestId: input.requestId,
      sessionToken: secret.sessionToken,
      csrfToken: secret.csrfToken,
    };
  }
  revokeSyntheticSession(scopeInput: EvidenceScope, id: string): void {
    const scope = EvidenceScopeSchema.parse(scopeInput),
      original = this.tenants.get(scope.tenantId),
      stored = original?.sessions.get(OpaqueIdSchema.parse(id));
    if (!original || !stored) fail();
    const next = fork(original);
    next.sessions.set(id, {
      ...stored,
      credential: ReleaseDecisionSessionStateSchema.parse({
        ...stored.credential,
        revokedAt: this.now(),
        revocationReason: "administrative",
      }),
    });
    this.commit(scope.tenantId, original, next);
  }
  private async touch(digest: string): Promise<AuthenticatableBrowserSession | null> {
    const index = this.sessionIndex.get(digest);
    if (!index) return null;
    const original = this.tenants.get(index.tenantId) as State,
      stored = original.sessions.get(index.sessionId) as StoredSession,
      credential = stored.credential,
      grant = original.grants.get(credential.bindingId) as ReleaseDecisionIdentityGrant,
      now = this.now();
    if (
      grant.state !== "active" ||
      credential.revokedAt !== null ||
      order(now) < order(credential.createdAt) ||
      order(now) >= order(credential.absoluteExpiresAt) ||
      order(now) >= order(credential.idleExpiresAt)
    )
      return null;
    const next = fork(original);
    const touched = ReleaseDecisionSessionStateSchema.parse({
      ...credential,
      lastUsedAt: now,
      useCount: Math.min(2147483647, credential.useCount + 1),
      idleExpiresAt: new Date(
        Math.min(
          Date.parse(credential.absoluteExpiresAt),
          Date.parse(now) + credential.idleLifetimeSeconds * 1000,
        ),
      ).toISOString(),
    });
    next.sessions.set(index.sessionId, { ...stored, credential: touched });
    this.commit(index.tenantId, original, next);
    return {
      capabilities: grant.capabilities,
      createdAt: credential.createdAt,
      csrfDigest: stored.csrfDigest,
      principalId: credential.principalId,
      resourceScope: grant.resourceScope,
      roles: grant.roles,
      sessionDigest: stored.sessionDigest,
      sessionId: credential.credentialId,
      tenantId: credential.tenantId,
    };
  }
  async seedSyntheticPolicy(record: ReleasePolicy): Promise<void> {
    const scope = EvidenceScopeSchema.parse(record.scope),
      original = this.tenants.get(scope.tenantId),
      next = fork(original ?? empty());
    await next.policies.publishReleasePolicy(record);
    this.commit(scope.tenantId, original, next);
  }
  async seedSyntheticPolicyLifecycle(event: ReleasePolicyLifecycleEvent): Promise<void> {
    const scope = EvidenceScopeSchema.parse(event.scope),
      original = this.tenants.get(scope.tenantId),
      next = fork(original ?? empty());
    await next.policies.publishReleasePolicyLifecycleEvent(event);
    this.commit(scope.tenantId, original, next);
  }
  async seedSyntheticSelection(record: ReleasePolicySelection): Promise<void> {
    const scope = EvidenceScopeSchema.parse(record.scope),
      original = this.tenants.get(scope.tenantId),
      next = fork(original ?? empty());
    const result = await next.selections.publishReleasePolicySelection(record);
    if (result.created)
      next.intents.set(
        key("release_policy_selection", record.selectionVersionId),
        sourceIntent({ kind: "release_policy_selection", record }),
      );
    this.commit(scope.tenantId, original, next);
  }
  private identity(
    state: State,
    scope: EvidenceScope,
    actor: ReleaseApprovalReviewerReceipt,
    at: string,
    budget: ReleaseDecisionVerificationBudget,
  ) {
    const stored = state.sessions.get(actor.credentialId);
    if (!stored) fail();
    const credential = ReleaseDecisionSessionStateSchema.parse(stored.credential),
      grant = ReleaseDecisionIdentityGrantSchema.parse(state.grants.get(credential.bindingId));
    const eligible = inspectCapturedReleaseIdentityState({
      scope,
      receipt: actor,
      identity: grant.identity,
      grant: { state: "observed", reference: grant.identity, record: grant },
      credential: {
        state: "observed",
        reference: {
          kind: "oidc_session",
          principalId: actor.principalId,
          credentialId: actor.credentialId,
        },
        record: credential,
      },
      capturedAt: at,
      operation: "manage_selection",
      budget,
    });
    if (eligible.state !== "eligible") fail();
    return { grant, credential };
  }
  private async readMaterial(
    state: State,
    scope: EvidenceScope,
    kind: Kind,
    id: string,
    budget: ReleaseDecisionVerificationBudget,
  ): Promise<Material | null> {
    const raw = state.publications.get(key(kind, id));
    budget.observe(raw ?? { scope, kind, id, state: "missing" });
    if (!raw) return null;
    const material = validateReleaseSelectionPublicationMaterial(raw, budget);
    const source =
      kind === "release_policy_selection"
        ? await state.selections.findReleasePolicySelection(scope, id)
        : await state.selections.findReleasePolicySelectionLifecycleEvent(scope, id);
    budget.observe(source);
    const intents = [state.intents.get(key(kind, id)), state.intents.get(profileKey(material))];
    for (const intent of intents) budget.observe(intent ?? null);
    if (
      !isDeepStrictEqual(material.publication.scope, scope) ||
      material.source.kind !== kind ||
      sourceId(material.source) !== id ||
      !isDeepStrictEqual(source, material.source.record) ||
      !isDeepStrictEqual(intents, [sourceIntent(material.source), profileIntent(material)])
    )
      fail();
    return material;
  }
  private async requireMaterial(
    state: State,
    scope: EvidenceScope,
    kind: Kind,
    id: string,
    budget: ReleaseDecisionVerificationBudget,
  ): Promise<Material> {
    const material = await this.readMaterial(state, scope, kind, id, budget);
    if (!material) fail();
    return material;
  }
  publishSelection(
    credentials: ReleaseBrowserMutationCredentials,
    intent: unknown,
  ): Promise<ReleaseSelectionInstallerResult> {
    return this.publish(credentials, intent, "release_policy_selection");
  }
  publishLifecycle(
    credentials: ReleaseBrowserMutationCredentials,
    intent: unknown,
  ): Promise<ReleaseSelectionInstallerResult> {
    return this.publish(credentials, intent, "release_policy_selection_lifecycle");
  }
  private async publish(
    credentials: ReleaseBrowserMutationCredentials,
    raw: unknown,
    kind: Kind,
  ): Promise<ReleaseSelectionInstallerResult> {
    const proof = await this.authentication.authenticateSelectionInstaller(credentials);
    const authenticated = readReleaseMutationAuthentication(proof, {
      operation: "manage_selection",
      scope: credentials.scope,
      requestId: credentials.requestId,
    });
    const actor = ReleaseApprovalReviewerReceiptSchema.parse(authenticated.receipt),
      scope = authenticated.scope;
    const mutation =
      kind === "release_policy_selection"
        ? {
            kind: "release_policy_selection" as const,
            definition: ReleasePolicySelectionDefinitionSchema.parse({
              ...PublishReleasePolicySelectionRequestSchema.parse(raw),
              scope,
              issuerPrincipalId: actor.principalId,
            }),
          }
        : {
            kind: "release_policy_selection_lifecycle" as const,
            intent: PublishReleasePolicySelectionLifecycleRequestSchema.parse(raw),
          };
    const id =
      mutation.kind === "release_policy_selection"
        ? mutation.definition.selectionVersionId
        : mutation.intent.eventId;
    const original = this.tenants.get(scope.tenantId),
      next = fork(original as State),
      budget = new ReleaseDecisionVerificationBudget(limits);
    try {
      const policySources: {
        policy: ReleasePolicy;
        events: readonly ReleasePolicyLifecycleEvent[];
      }[] = [];
      this.identity(next, scope, actor, this.now(), budget);
      const existing = await this.readMaterial(next, scope, kind, id, budget);
      if (existing) {
        const record = existing.source.record;
        // readMaterial already binds the exact requested source kind. Strict owning schemas retain
        // that proof across this internal mutation union, without an unreachable fallback operation.
        if (mutation.kind === "release_policy_selection") {
          const {
            schemaVersion: _v,
            definitionSha256: _h,
            publishedAt: _at,
            publishedByPrincipalId: _by,
            ...definition
          } = ReleasePolicySelectionSchema.parse(existing.source.record);
          if (!isDeepStrictEqual(definition, mutation.definition)) fail();
        } else {
          const {
            schemaVersion: _v,
            scope: _scope,
            occurredAt: _at,
            actorPrincipalId,
            ...intent
          } = ReleasePolicySelectionLifecycleEventSchema.parse(existing.source.record);
          if (actorPrincipalId !== actor.principalId || !isDeepStrictEqual(intent, mutation.intent))
            fail();
        }
        this.identity(next, scope, actor, this.now(), budget);
        const usage = budget.snapshot();
        this.commit(scope.tenantId, original, next);
        return { created: false, record, publication: existing.publication, usage };
      }
      if (mutation.kind === "release_policy_selection") {
        const selection = mutation.definition;
        const prior = await next.selections.findReleasePolicySelection(scope, id);
        budget.observe(prior);
        if (prior) fail();
        const target = await next.selections.readReleasePolicySelectionTarget(
          scope,
          { installationId: selection.installationId, gateTargetId: selection.gateTargetId },
          budget,
        );
        if (target.root)
          await this.requireMaterial(
            next,
            scope,
            "release_policy_selection",
            target.root.selectionVersionId,
            budget,
          );
        if (selection.predecessor)
          await this.requireMaterial(
            next,
            scope,
            "release_policy_selection",
            selection.predecessor.selectionVersionId,
            budget,
          );
        for (const chosen of selection.policies) {
          const rawPolicy = await next.policies.findReleasePolicy(
            scope,
            chosen.policy.policyVersionId,
          );
          budget.observe(rawPolicy);
          if (!rawPolicy) fail();
          const policy = validateReleasePolicyRecord(rawPolicy);
          if (
            !isDeepStrictEqual(releasePolicyReference(policy), chosen.policy) ||
            policy.mode !== chosen.mode ||
            policy.installationBinding.installationId !== selection.installationId
          )
            fail();
          const events = await next.policies.listReleasePolicyLifecycleEvents(
            scope,
            policy.policyVersionId,
          );
          for (const event of events) budget.observe(event);
          policySources.push({ policy, events });
        }
      } else {
        const lifecycle = mutation.intent;
        const prior = await next.selections.findReleasePolicySelectionLifecycleEvent(scope, id);
        budget.observe(prior);
        if (prior) fail();
        for (const ref of [
          lifecycle.selection,
          ...(lifecycle.kind === "superseded" ? [lifecycle.successor] : []),
        ]) {
          const retained = await this.requireMaterial(
            next,
            scope,
            "release_policy_selection",
            ref.selectionVersionId,
            budget,
          );
          if (!isDeepStrictEqual(retained.publication.subject.selection, ref)) fail();
        }
      }
      const issuedAt = this.now(),
        identity = this.identity(next, scope, actor, issuedAt, budget);
      const cut = order(issuedAt);
      for (const { policy, events } of policySources) {
        if (
          order(policy.effectiveAt) > cut ||
          order(policy.publishedAt) > cut ||
          order(policy.expiresAt) <= cut ||
          events.some((event) => order(event.occurredAt) <= cut)
        )
          fail();
      }
      let source: Material["source"];
      if (mutation.kind === "release_policy_selection") {
        const selection = mutation.definition;
        const result = await next.selections.publishReleasePolicySelection(
          ReleasePolicySelectionSchema.parse({
            ...selection,
            schemaVersion: "0.1",
            definitionSha256: createHash("sha256")
              .update(encodeReleasePolicySelectionDefinition({ scope, definition: selection }))
              .digest("hex"),
            publishedAt: issuedAt,
            publishedByPrincipalId: actor.principalId,
          }),
        );
        if (!result.created) fail();
        source = { kind: "release_policy_selection", record: result.selection };
      } else {
        const result = await next.selections.publishReleasePolicySelectionLifecycleEvent({
          ...mutation.intent,
          scope,
          schemaVersion: "0.1",
          actorPrincipalId: actor.principalId,
          occurredAt: issuedAt,
        });
        if (!result.created) fail();
        source = { kind: "release_policy_selection_lifecycle", record: result.event };
      }
      const material = prepareReleaseSelectionPublicationMaterial({
        scope,
        source,
        actor,
        identity: identity.grant.identity as Material["publication"]["identity"],
        grant: identity.grant,
        credential: identity.credential,
        issuedAt,
        budget,
      });
      for (const [intentKey, value] of [
        [key(kind, id), sourceIntent(source)],
        [profileKey(material), profileIntent(material)],
      ] as const) {
        budget.observe(next.intents.get(intentKey) ?? { intentKey, state: "missing" });
        if (next.intents.has(intentKey)) fail();
        next.intents.set(intentKey, value);
      }
      next.publications.set(key(kind, id), material);
      const reread = await this.requireMaterial(next, scope, kind, id, budget);
      const usage = budget.snapshot();
      this.commit(scope.tenantId, original, next);
      return {
        created: true,
        record: reread.source.record,
        publication: reread.publication,
        usage,
      };
    } catch (cause) {
      return budget.rejectSourceRead(cause);
    }
  }
  async readSyntheticSelection(scopeInput: EvidenceScope, id: string) {
    const scope = EvidenceScopeSchema.parse(scopeInput),
      versionId = OpaqueIdSchema.parse(id);
    return (
      (await this.tenants
        .get(scope.tenantId)
        ?.selections.findReleasePolicySelection(scope, versionId)) ?? null
    );
  }
  readSyntheticPublication(scopeInput: EvidenceScope, kind: Kind, id: string): Material | null {
    const scope = EvidenceScopeSchema.parse(scopeInput),
      sourceId = OpaqueIdSchema.parse(id),
      value = this.tenants.get(scope.tenantId)?.publications.get(key(kind, sourceId));
    return value && isDeepStrictEqual(value.publication.scope, scope)
      ? structuredClone(value)
      : null;
  }
}
