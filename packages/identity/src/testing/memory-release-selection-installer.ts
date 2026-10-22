import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import {
  EvidenceScopeSchema,
  encodeReleasePolicySelectionDefinition,
  encodeReleaseReviewerAuthorityDefinition,
  OpaqueIdSchema,
  PolicyEvaluationTimeSchema,
  policyEvaluationTimestampOrderKey,
  PublishReleasePolicySelectionLifecycleRequestSchema,
  PublishReleasePolicySelectionRequestSchema,
  PublishReleaseReviewerAuthorityRequestSchema,
  PublishReleaseReviewerAuthorityLifecycleRequestSchema,
  ReleaseReviewerAuthorityDefinitionSchema,
  ReleaseReviewerAuthoritySchema,
  ReleaseReviewerAuthorityLifecycleEventSchema,
  ReleaseApprovalReviewerReceiptSchema,
  ReleaseApprovalRevocationIntentSchema,
  ReleaseApprovalRevocationSchema,
  ReleaseDecisionIdentityGrantSchema,
  ReleaseDecisionSessionStateSchema,
  ReleasePolicySelectionDefinitionSchema,
  ReleasePolicySelectionSchema,
  ReleasePolicySelectionLifecycleEventSchema,
  type EvidenceScope,
  type ReleaseApprovalReviewerReceipt,
  type ReleaseApprovalPublicationMaterial,
  type ReleaseDecisionIdentityGrant,
  type ReleaseDecisionSessionState,
  type ReleasePolicy,
  type ReleasePolicyLifecycleEvent,
  type ReleasePolicySelection,
  type ReleaseSelectionPublicationMaterial,
  type ReleaseReviewerAuthority,
  type ReleaseReviewerPublicationMaterial,
} from "@proofstack/contracts";
import {
  inspectCapturedReleaseIdentityState,
  prepareReleaseSelectionPublicationMaterial,
  prepareReleaseReviewerPublicationMaterial,
  prepareReleaseApprovalPublicationMaterial,
  releasePolicyReference,
  ReleaseDecisionVerificationBudget,
  validateReleasePolicyRecord,
  validateReleaseSelectionPublicationMaterial,
  validateReleaseReviewerPublicationMaterial,
  validateReleaseApprovalPublicationMaterial,
  type Clock,
} from "@proofstack/core";
import {
  MemoryReleasePolicyRepository,
  MemoryReleasePolicySelectionRepository,
  MemoryReleaseReviewerAuthorityRepository,
  MemoryReleaseApprovalRepository,
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
import type {
  ReleaseReviewerAdministrator,
  ReleaseReviewerAdministratorResult,
} from "../release-reviewer-administrator.js";
import type {
  ReleaseApprovalRevoker,
  ReleaseApprovalRevokerResult,
} from "../release-approval-revoker.js";

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
  readonly reviewers: MemoryReleaseReviewerAuthorityRepository;
  readonly approvals: MemoryReleaseApprovalRepository;
  readonly grants: Map<string, ReleaseDecisionIdentityGrant>;
  readonly sessions: Map<string, StoredSession>;
  readonly publications: Map<string, Material>;
  readonly reviewerPublications: Map<string, ReleaseReviewerPublicationMaterial>;
  readonly approvalPublications: Map<string, ReleaseApprovalPublicationMaterial>;
  readonly intents: Map<string, unknown>;
}
const empty = (): State => ({
  policies: new MemoryReleasePolicyRepository(),
  selections: new MemoryReleasePolicySelectionRepository(),
  reviewers: new MemoryReleaseReviewerAuthorityRepository(),
  approvals: new MemoryReleaseApprovalRepository(),
  grants: new Map(),
  sessions: new Map(),
  publications: new Map(),
  reviewerPublications: new Map(),
  approvalPublications: new Map(),
  intents: new Map(),
});
const fork = (state: State): State => ({
  policies: state.policies.fork(),
  selections: state.selections.fork(),
  reviewers: state.reviewers.fork(),
  approvals: state.approvals.fork(),
  grants: structuredClone(state.grants),
  sessions: structuredClone(state.sessions),
  publications: structuredClone(state.publications),
  reviewerPublications: structuredClone(state.reviewerPublications),
  approvalPublications: structuredClone(state.approvalPublications),
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
type ReviewerMaterial = ReleaseReviewerPublicationMaterial;
type ReviewerKind = ReviewerMaterial["source"]["kind"];
const reviewerSourceId = (source: ReviewerMaterial["source"]) =>
  source.kind === "release_reviewer_authority"
    ? source.record.authorityVersionId
    : source.record.eventId;
const reviewerSourceIntent = (source: ReviewerMaterial["source"]) => ({
  eventType:
    source.kind === "release_reviewer_authority"
      ? "release.reviewer-authority.published"
      : "release.reviewer-authority.lifecycle_recorded",
  schemaVersion: "0.1",
  payload: { recordKind: source.kind, record: source.record },
  createdAt:
    source.kind === "release_reviewer_authority"
      ? source.record.publishedAt
      : source.record.occurredAt,
});
const reviewerProfileKey = (material: ReviewerMaterial) =>
  key("release_reviewer_publication", `rrp_${material.publication.definitionSha256.slice(0, 60)}`);
const reviewerProfileIntent = (material: ReviewerMaterial) => ({
  eventType: "release.reviewer-authority.authentication_recorded",
  schemaVersion: "0.1",
  payload: { recordKind: "release_reviewer_publication", record: material.publication },
  createdAt: material.publication.issuedAt,
});
type ApprovalMaterial = ReleaseApprovalPublicationMaterial;
type ApprovalKind = ApprovalMaterial["source"]["kind"];
const approvalSourceId = (source: ApprovalMaterial["source"]) =>
  source.kind === "release_approval" ? source.record.approvalId : source.record.eventId;
const approvalSourceIntent = (source: ApprovalMaterial["source"]) => ({
  eventType:
    source.kind === "release_approval" ? "release.approval.recorded" : "release.approval.revoked",
  schemaVersion: "0.1",
  payload: { recordKind: source.kind, record: source.record },
  createdAt:
    source.kind === "release_approval" ? source.record.recordedAt : source.record.occurredAt,
});
const approvalProfileKey = (material: ApprovalMaterial) =>
  key("release_approval_publication", `rap_${material.publication.definitionSha256.slice(0, 60)}`);
const approvalProfileIntent = (material: ApprovalMaterial) => ({
  eventType: "release.approval.authentication_recorded",
  schemaVersion: "0.1",
  payload: { recordKind: "release_approval_publication", record: material.publication },
  createdAt: material.publication.issuedAt,
});
const approvalLimits = { ...limits, maxApprovalRecords: 4096 } as const;

/** Explicit synthetic workspace reference, not a production OIDC store or durable transaction.
 * Actual cookie/CSRF verification uses the owning authenticators over this same private state.
 * All source/profile/intents commit by one per-tenant compare-and-replace; no mutable repository
 * handle, principal, authority callback or generic transaction interface escapes.
 * Synthetic seed/session methods are fixture-owner operations, never public HTTP capabilities.
 */
export class MemoryReleaseSelectionInstallerReference
  implements ReleaseSelectionInstaller, ReleaseReviewerAdministrator, ReleaseApprovalRevoker
{
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
    operation:
      | "manage_selection"
      | "manage_reviewer_authority"
      | "create_approval" = "manage_selection",
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
      operation,
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
  async seedSyntheticReviewerAuthority(record: ReleaseReviewerAuthority): Promise<void> {
    const scope = EvidenceScopeSchema.parse(record.scope),
      original = this.tenants.get(scope.tenantId),
      next = fork(original ?? empty());
    const result = await next.reviewers.publishReleaseReviewerAuthority(record);
    if (result.created)
      next.intents.set(
        key("release_reviewer_authority", record.authorityVersionId),
        reviewerSourceIntent({ kind: "release_reviewer_authority", record }),
      );
    this.commit(scope.tenantId, original, next);
  }
  private async readReviewerMaterial(
    state: State,
    scope: EvidenceScope,
    kind: ReviewerKind,
    id: string,
    budget: ReleaseDecisionVerificationBudget,
  ): Promise<ReviewerMaterial | null> {
    const raw = state.reviewerPublications.get(key(kind, id));
    budget.observe(raw ?? { scope, kind, id, state: "missing" });
    if (!raw) return null;
    const material = validateReleaseReviewerPublicationMaterial(raw, budget);
    const source =
      kind === "release_reviewer_authority"
        ? await state.reviewers.findReleaseReviewerAuthority(scope, id)
        : await state.reviewers.findReleaseReviewerAuthorityLifecycleEvent(scope, id);
    budget.observe(source);
    const intents = [
      state.intents.get(key(kind, id)),
      state.intents.get(reviewerProfileKey(material)),
    ];
    for (const intent of intents) budget.observe(intent ?? null);
    if (
      !isDeepStrictEqual(material.publication.scope, scope) ||
      material.source.kind !== kind ||
      reviewerSourceId(material.source) !== id ||
      !isDeepStrictEqual(source, material.source.record) ||
      !isDeepStrictEqual(intents, [
        reviewerSourceIntent(material.source),
        reviewerProfileIntent(material),
      ])
    )
      fail();
    return material;
  }
  private async requireReviewerMaterial(
    state: State,
    scope: EvidenceScope,
    kind: ReviewerKind,
    id: string,
    budget: ReleaseDecisionVerificationBudget,
  ): Promise<ReviewerMaterial> {
    const material = await this.readReviewerMaterial(state, scope, kind, id, budget);
    if (!material) fail();
    return material;
  }
  publishReviewerAuthority(
    credentials: ReleaseBrowserMutationCredentials,
    intent: unknown,
  ): Promise<ReleaseReviewerAdministratorResult> {
    return this.publishReviewer(credentials, intent, "release_reviewer_authority");
  }
  publishReviewerAuthorityLifecycle(
    credentials: ReleaseBrowserMutationCredentials,
    intent: unknown,
  ): Promise<ReleaseReviewerAdministratorResult> {
    return this.publishReviewer(credentials, intent, "release_reviewer_authority_lifecycle");
  }
  private async publishReviewer(
    credentials: ReleaseBrowserMutationCredentials,
    raw: unknown,
    kind: ReviewerKind,
  ): Promise<ReleaseReviewerAdministratorResult> {
    const proof = await this.authentication.authenticateReviewerAuthorityAdministrator(credentials);
    const authenticated = readReleaseMutationAuthentication(proof, {
      operation: "manage_reviewer_authority",
      scope: credentials.scope,
      requestId: credentials.requestId,
    });
    const actor = ReleaseApprovalReviewerReceiptSchema.parse(authenticated.receipt),
      scope = authenticated.scope;
    const mutation =
      kind === "release_reviewer_authority"
        ? {
            kind: "release_reviewer_authority" as const,
            definition: ReleaseReviewerAuthorityDefinitionSchema.parse({
              ...PublishReleaseReviewerAuthorityRequestSchema.parse(raw),
              scope,
              issuerPrincipalId: actor.principalId,
            }),
          }
        : {
            kind: "release_reviewer_authority_lifecycle" as const,
            intent: PublishReleaseReviewerAuthorityLifecycleRequestSchema.parse(raw),
          };
    const id =
      mutation.kind === "release_reviewer_authority"
        ? mutation.definition.authorityVersionId
        : mutation.intent.eventId;
    const original = this.tenants.get(scope.tenantId),
      next = fork(original as State),
      budget = new ReleaseDecisionVerificationBudget(limits);
    try {
      this.identity(next, scope, actor, this.now(), budget, "manage_reviewer_authority");
      const existing = await this.readReviewerMaterial(next, scope, kind, id, budget);
      if (existing) {
        if (mutation.kind === "release_reviewer_authority") {
          const {
            schemaVersion: _v,
            definitionSha256: _h,
            publishedAt: _at,
            publishedByPrincipalId: _by,
            ...definition
          } = ReleaseReviewerAuthoritySchema.parse(existing.source.record);
          if (!isDeepStrictEqual(definition, mutation.definition)) fail();
        } else {
          const {
            schemaVersion: _v,
            scope: _s,
            occurredAt: _at,
            actorPrincipalId,
            ...intent
          } = ReleaseReviewerAuthorityLifecycleEventSchema.parse(existing.source.record);
          if (actorPrincipalId !== actor.principalId || !isDeepStrictEqual(intent, mutation.intent))
            fail();
        }
        this.identity(next, scope, actor, this.now(), budget, "manage_reviewer_authority");
        const usage = budget.snapshot();
        this.commit(scope.tenantId, original, next);
        return {
          created: false,
          record: existing.source.record,
          publication: existing.publication,
          usage,
        };
      }
      if (mutation.kind === "release_reviewer_authority") {
        const declaration = mutation.definition;
        const prior = await next.reviewers.findReleaseReviewerAuthority(scope, id);
        budget.observe(prior);
        if (prior) fail();
        const target = await next.reviewers.readReleaseReviewerAuthorityTarget(
          scope,
          {
            installationId: declaration.installationId,
            gateTargetId: declaration.gateTargetId,
            reviewerPrincipalId: declaration.reviewerPrincipalId,
          },
          budget,
        );
        if (target.root)
          await this.requireReviewerMaterial(
            next,
            scope,
            "release_reviewer_authority",
            target.root.authorityVersionId,
            budget,
          );
        if (declaration.predecessor)
          await this.requireReviewerMaterial(
            next,
            scope,
            "release_reviewer_authority",
            declaration.predecessor.authorityVersionId,
            budget,
          );
      } else {
        const prior = await next.reviewers.findReleaseReviewerAuthorityLifecycleEvent(scope, id);
        budget.observe(prior);
        if (prior) fail();
        for (const reference of [
          mutation.intent.authority,
          ...(mutation.intent.kind === "superseded" ? [mutation.intent.successor] : []),
        ]) {
          const retained = await this.requireReviewerMaterial(
            next,
            scope,
            "release_reviewer_authority",
            reference.authorityVersionId,
            budget,
          );
          if (!isDeepStrictEqual(retained.publication.subject.authority, reference)) fail();
        }
      }
      const issuedAt = this.now(),
        identity = this.identity(next, scope, actor, issuedAt, budget, "manage_reviewer_authority");
      let source: ReviewerMaterial["source"];
      if (mutation.kind === "release_reviewer_authority") {
        const result = await next.reviewers.publishReleaseReviewerAuthority(
          ReleaseReviewerAuthoritySchema.parse({
            ...mutation.definition,
            schemaVersion: "0.1",
            definitionSha256: createHash("sha256")
              .update(
                encodeReleaseReviewerAuthorityDefinition({
                  scope,
                  definition: mutation.definition,
                }),
              )
              .digest("hex"),
            publishedAt: issuedAt,
            publishedByPrincipalId: actor.principalId,
          }),
        );
        if (!result.created) fail();
        source = { kind: "release_reviewer_authority", record: result.authority };
      } else {
        const result = await next.reviewers.publishReleaseReviewerAuthorityLifecycleEvent({
          ...mutation.intent,
          scope,
          schemaVersion: "0.1",
          actorPrincipalId: actor.principalId,
          occurredAt: issuedAt,
        });
        if (!result.created) fail();
        source = { kind: "release_reviewer_authority_lifecycle", record: result.event };
      }
      const material = prepareReleaseReviewerPublicationMaterial({
        scope,
        source,
        actor,
        identity: identity.grant.identity as ReviewerMaterial["publication"]["identity"],
        grant: identity.grant,
        credential: identity.credential,
        issuedAt,
        budget,
      });
      for (const [intentKey, intent] of [
        [key(kind, id), reviewerSourceIntent(source)],
        [reviewerProfileKey(material), reviewerProfileIntent(material)],
      ] as const) {
        budget.observe(next.intents.get(intentKey) ?? { intentKey, state: "missing" });
        if (next.intents.has(intentKey)) fail();
        next.intents.set(intentKey, intent);
      }
      next.reviewerPublications.set(key(kind, id), material);
      const retained = await this.requireReviewerMaterial(next, scope, kind, id, budget),
        usage = budget.snapshot();
      this.commit(scope.tenantId, original, next);
      return {
        created: true,
        record: retained.source.record,
        publication: retained.publication,
        usage,
      };
    } catch (cause) {
      return budget.rejectSourceRead(cause);
    }
  }
  async readSyntheticReviewerAuthority(scopeInput: EvidenceScope, id: string) {
    const scope = EvidenceScopeSchema.parse(scopeInput),
      versionId = OpaqueIdSchema.parse(id);
    return (
      (await this.tenants
        .get(scope.tenantId)
        ?.reviewers.findReleaseReviewerAuthority(scope, versionId)) ?? null
    );
  }
  readSyntheticReviewerPublication(
    scopeInput: EvidenceScope,
    kind: ReviewerKind,
    id: string,
  ): ReviewerMaterial | null {
    const scope = EvidenceScopeSchema.parse(scopeInput),
      sourceId = OpaqueIdSchema.parse(id),
      material = this.tenants.get(scope.tenantId)?.reviewerPublications.get(key(kind, sourceId));
    return material && isDeepStrictEqual(material.publication.scope, scope)
      ? structuredClone(material)
      : null;
  }

  /** Fixture-owner import of historical synthetic preimages. It does not authenticate a caller
   * or establish current reviewer expertise, content acquisition or release authority.
   */
  async seedSyntheticApprovalPublication(raw: ApprovalMaterial): Promise<void> {
    const budget = new ReleaseDecisionVerificationBudget(approvalLimits);
    const material = validateReleaseApprovalPublicationMaterial(raw, budget);
    if (material.source.kind !== "release_approval") fail();
    const scope = material.publication.scope,
      original = this.tenants.get(scope.tenantId),
      next = fork(original ?? empty()),
      id = approvalSourceId(material.source);
    if (next.approvalPublications.has(key(material.source.kind, id))) fail();
    const result = await next.approvals.publishReleaseApproval(material.source.record);
    if (!result.created) fail();
    this.storeApprovalMaterial(next, material, budget);
    await this.requireApprovalMaterial(next, scope, material.source.kind, id, budget);
    budget.snapshot();
    this.commit(scope.tenantId, original, next);
  }
  private storeApprovalMaterial(
    state: State,
    material: ApprovalMaterial,
    budget: ReleaseDecisionVerificationBudget,
  ): void {
    const sourceKey = key(material.source.kind, approvalSourceId(material.source));
    budget.observe(state.approvalPublications.get(sourceKey) ?? { sourceKey, state: "missing" });
    // Fixed callers checked the source slot on this private fork; canonical intent collisions
    // below still reject the whole publication before the profile map changes.
    for (const [intentKey, intent] of [
      [sourceKey, approvalSourceIntent(material.source)],
      [approvalProfileKey(material), approvalProfileIntent(material)],
    ] as const) {
      budget.observe(state.intents.get(intentKey) ?? { intentKey, state: "missing" });
      if (state.intents.has(intentKey)) fail();
      state.intents.set(intentKey, intent);
    }
    state.approvalPublications.set(sourceKey, material);
  }
  private async readApprovalMaterial<K extends ApprovalKind>(
    state: State,
    scope: EvidenceScope,
    kind: K,
    id: string,
    budget: ReleaseDecisionVerificationBudget,
  ): Promise<
    (ApprovalMaterial & { source: Extract<ApprovalMaterial["source"], { kind: K }> }) | null
  > {
    const raw = state.approvalPublications.get(key(kind, id));
    budget.observe(raw ?? { scope, kind, id, state: "missing" });
    if (!raw) return null;
    const material = validateReleaseApprovalPublicationMaterial(raw, budget);
    const source =
      kind === "release_approval"
        ? await state.approvals.findReleaseApproval(scope, id)
        : await state.approvals.findReleaseApprovalRevocation(scope, id);
    budget.observe(source, kind === "release_approval" ? "approval" : "metadata");
    const intents = [
      state.intents.get(key(kind, id)),
      state.intents.get(approvalProfileKey(material)),
    ];
    for (const intent of intents) budget.observe(intent ?? null);
    if (
      !isDeepStrictEqual(material.publication.scope, scope) ||
      material.source.kind !== kind ||
      approvalSourceId(material.source) !== id ||
      !isDeepStrictEqual(source, material.source.record) ||
      !isDeepStrictEqual(intents, [
        approvalSourceIntent(material.source),
        approvalProfileIntent(material),
      ])
    )
      fail();
    return material as ApprovalMaterial & {
      source: Extract<ApprovalMaterial["source"], { kind: K }>;
    };
  }
  private async requireApprovalMaterial<K extends ApprovalKind>(
    state: State,
    scope: EvidenceScope,
    kind: K,
    id: string,
    budget: ReleaseDecisionVerificationBudget,
  ): Promise<ApprovalMaterial & { source: Extract<ApprovalMaterial["source"], { kind: K }> }> {
    const value = await this.readApprovalMaterial(state, scope, kind, id, budget);
    if (!value) fail();
    return value;
  }
  async revokeApproval(
    credentials: ReleaseBrowserMutationCredentials,
    raw: unknown,
  ): Promise<ReleaseApprovalRevokerResult> {
    const proof = await this.authentication.authenticateApprovalReviewer(credentials);
    const authenticated = readReleaseMutationAuthentication(proof, {
      operation: "record_approval",
      scope: credentials.scope,
      requestId: credentials.requestId,
    });
    const scope = authenticated.scope,
      actor = ReleaseApprovalReviewerReceiptSchema.parse(authenticated.receipt),
      intent = ReleaseApprovalRevocationIntentSchema.parse(raw),
      original = this.tenants.get(scope.tenantId) as State;
    const next = fork(original),
      budget = new ReleaseDecisionVerificationBudget(approvalLimits);
    try {
      this.identity(next, scope, actor, this.now(), budget, "create_approval");
      const retained = await this.requireApprovalMaterial(
        next,
        scope,
        "release_approval",
        intent.approval.approvalId,
        budget,
      );
      if (
        !isDeepStrictEqual(retained.publication.subject.approval, intent.approval) ||
        retained.source.record.reviewer.principalId !== actor.principalId
      )
        fail();
      // The owning complete subject census validates successor, revocation and reverse indexes.
      // A missing provenance or intent is never repaired from a trusted legacy source row.
      const census = await next.approvals.readReleaseApprovalSubject(
        scope,
        retained.source.record.kind,
        retained.source.record.subject,
        budget,
      );
      for (const row of census.records)
        await this.requireApprovalMaterial(next, scope, "release_approval", row.approvalId, budget);
      for (const row of census.revocations)
        await this.requireApprovalMaterial(
          next,
          scope,
          "release_approval_revocation",
          row.eventId,
          budget,
        );
      const existing = await this.readApprovalMaterial(
        next,
        scope,
        "release_approval_revocation",
        intent.eventId,
        budget,
      );
      if (existing) {
        const {
          schemaVersion: _v,
          scope: _s,
          reviewer,
          occurredAt: _at,
          ...originalIntent
        } = existing.source.record;
        if (
          reviewer.principalId !== actor.principalId ||
          !isDeepStrictEqual(originalIntent, intent)
        )
          fail();
        const finishedAt = this.now();
        if (order(finishedAt) < order(existing.source.record.occurredAt)) fail();
        this.identity(next, scope, actor, finishedAt, budget, "create_approval");
        const usage = budget.snapshot();
        this.commit(scope.tenantId, original, next);
        return {
          created: false,
          record: existing.source.record,
          publication: existing.publication,
          usage,
        };
      }
      budget.observe(await next.approvals.findReleaseApprovalRevocation(scope, intent.eventId));
      const issuedAt = this.now(),
        identity = this.identity(next, scope, actor, issuedAt, budget, "create_approval");
      const result = await next.approvals.publishReleaseApprovalRevocation(
        ReleaseApprovalRevocationSchema.parse({
          ...intent,
          schemaVersion: "0.1",
          scope,
          reviewer: actor,
          occurredAt: issuedAt,
        }),
      );
      if (!result.created) fail();
      const material = prepareReleaseApprovalPublicationMaterial({
        scope,
        source: { kind: "release_approval_revocation", record: result.event },
        actor,
        identity: identity.grant.identity as ApprovalMaterial["publication"]["identity"],
        grant: identity.grant,
        credential: identity.credential,
        issuedAt,
        budget,
      });
      this.storeApprovalMaterial(next, material, budget);
      const committed = await this.requireApprovalMaterial(
        next,
        scope,
        "release_approval_revocation",
        intent.eventId,
        budget,
      );
      const finishedAt = this.now();
      if (order(finishedAt) < order(issuedAt)) fail();
      this.identity(next, scope, actor, finishedAt, budget, "create_approval");
      const usage = budget.snapshot();
      this.commit(scope.tenantId, original, next);
      return {
        created: true,
        record: committed.source.record,
        publication: committed.publication,
        usage,
      };
    } catch (cause) {
      return budget.rejectSourceRead(cause);
    }
  }
  async readSyntheticApproval(scopeInput: EvidenceScope, id: string) {
    const scope = EvidenceScopeSchema.parse(scopeInput),
      sourceId = OpaqueIdSchema.parse(id);
    return (
      (await this.tenants.get(scope.tenantId)?.approvals.findReleaseApproval(scope, sourceId)) ??
      null
    );
  }
  async readSyntheticApprovalRevocation(scopeInput: EvidenceScope, id: string) {
    const scope = EvidenceScopeSchema.parse(scopeInput),
      sourceId = OpaqueIdSchema.parse(id);
    return (
      (await this.tenants
        .get(scope.tenantId)
        ?.approvals.findReleaseApprovalRevocation(scope, sourceId)) ?? null
    );
  }
  readSyntheticApprovalPublication(
    scopeInput: EvidenceScope,
    kind: ApprovalKind,
    id: string,
  ): ApprovalMaterial | null {
    const scope = EvidenceScopeSchema.parse(scopeInput),
      sourceId = OpaqueIdSchema.parse(id),
      material = this.tenants.get(scope.tenantId)?.approvalPublications.get(key(kind, sourceId));
    return material && isDeepStrictEqual(material.publication.scope, scope)
      ? structuredClone(material)
      : null;
  }
}
