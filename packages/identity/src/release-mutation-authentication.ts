import { isDeepStrictEqual } from "node:util";
import {
  type Capability,
  type EvidenceScope,
  EvidenceScopeSchema,
  type PrincipalContext,
  type ReleaseDecisionPublisherReceipt,
  ReleaseDecisionPublisherReceiptSchema,
} from "@proofstack/contracts";
import { ForbiddenError, requireCapability, requireEnvironmentAccess } from "@proofstack/core";
import { OidcSessionAuthenticator, requireBrowserCsrfToken } from "./oidc-session.js";
import { ServiceTokenAuthenticator } from "./service-token-authenticator.js";

export type ReleaseMutationOperation =
  | "manage_selection"
  | "manage_reviewer_authority"
  | "record_approval"
  | "publish_decision";

declare const authenticationBrand: unique symbol;
/** Process-local authentication only. Cannot be serialized, restored or submitted as a receipt. */
export interface ReleaseMutationAuthentication {
  readonly [authenticationBrand]: true;
}
interface AuthenticatedState {
  readonly operation: ReleaseMutationOperation;
  readonly scope: EvidenceScope;
  readonly principal: PrincipalContext;
  readonly receipt: ReleaseDecisionPublisherReceipt;
}
const issued = new WeakMap<ReleaseMutationAuthentication, AuthenticatedState>();
const capabilities = {
  manage_selection: "release:selection:manage",
  manage_reviewer_authority: "approval:authority:manage",
  record_approval: "approval:decide",
  publish_decision: "release:decision:publish",
} as const satisfies Record<ReleaseMutationOperation, Capability>;

export class InvalidReleaseMutationAuthenticationError extends Error {
  readonly code = "release_mutation_authentication_invalid";
  constructor() {
    super("Invalid release mutation authentication");
    this.name = "InvalidReleaseMutationAuthenticationError";
  }
}
export interface ReleaseBrowserMutationCredentials {
  readonly sessionToken: string;
  readonly csrfToken: string;
  readonly requestId: string;
  readonly scope: EvidenceScope;
}
export interface ReleaseServicePublisherCredentials {
  readonly serviceToken: string;
  readonly requestId: string;
  readonly scope: EvidenceScope;
}
function exact(input: unknown, keys: readonly string[]): void {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(input, key))
  )
    throw new InvalidReleaseMutationAuthenticationError();
}
function issue(
  operation: ReleaseMutationOperation,
  scopeInput: EvidenceScope,
  principal: PrincipalContext,
): ReleaseMutationAuthentication {
  // Authenticate first, then authorize before interpreting a mutation body or looking up its graph.
  requireCapability(principal, capabilities[operation]);
  const scope = EvidenceScopeSchema.parse(scopeInput);
  if (principal.tenantId !== scope.tenantId) throw new ForbiddenError("Release tenant mismatch");
  requireEnvironmentAccess(principal, scope.projectId, scope.environmentId);
  const receipt = ReleaseDecisionPublisherReceiptSchema.parse({
    principalId: principal.principalId,
    principalType: principal.principalType,
    authenticationMethod: principal.authentication.method,
    authenticatedAt: principal.authentication.authenticatedAt,
    credentialId: principal.authentication.credentialId,
    requestId: principal.requestId,
  });
  const proof = Object.freeze({}) as ReleaseMutationAuthentication;
  issued.set(proof, structuredClone({ operation, scope, principal, receipt }));
  return proof;
}

/** Fixed server composition, using installed owning authenticators, never a supplied principal or
 * callback. Issuance is not current installation/reviewer authority, expertise or native publication.
 */
export class ReleaseMutationAuthenticator {
  constructor(
    private readonly browser: OidcSessionAuthenticator,
    private readonly service?: ServiceTokenAuthenticator,
  ) {
    if (
      !(browser instanceof OidcSessionAuthenticator) ||
      (service !== undefined && !(service instanceof ServiceTokenAuthenticator))
    )
      throw new InvalidReleaseMutationAuthenticationError();
  }
  authenticateSelectionInstaller(input: ReleaseBrowserMutationCredentials) {
    return this.authenticateBrowser("manage_selection", input);
  }
  authenticateReviewerAuthorityAdministrator(input: ReleaseBrowserMutationCredentials) {
    return this.authenticateBrowser("manage_reviewer_authority", input);
  }
  authenticateApprovalReviewer(input: ReleaseBrowserMutationCredentials) {
    return this.authenticateBrowser("record_approval", input);
  }
  authenticateDecisionPublisher(input: ReleaseBrowserMutationCredentials) {
    return this.authenticateBrowser("publish_decision", input);
  }
  private async authenticateBrowser(
    operation: ReleaseMutationOperation,
    input: ReleaseBrowserMutationCredentials,
  ): Promise<ReleaseMutationAuthentication> {
    exact(input, ["sessionToken", "csrfToken", "requestId", "scope"]);
    const authenticated = await this.browser.authenticate(input.sessionToken, input.requestId);
    requireBrowserCsrfToken(input.csrfToken, authenticated.csrfDigest);
    return issue(operation, input.scope, authenticated.principal);
  }
  async authenticateServiceDecisionPublisher(
    input: ReleaseServicePublisherCredentials,
  ): Promise<ReleaseMutationAuthentication> {
    exact(input, ["serviceToken", "requestId", "scope"]);
    if (!this.service) throw new InvalidReleaseMutationAuthenticationError();
    const principal = await this.service.authenticate(input.serviceToken, input.requestId);
    return issue("publish_decision", input.scope, principal);
  }
}

/** Fixed owning services consume this process-local proof with their exact operation/scope/request.
 * Returns copies without credentials. They must still validate current grants/session/installation,
 * complete sources, epoch and held guards through atomic publication. Never accept a public report.
 */
export function readReleaseMutationAuthentication(
  proof: ReleaseMutationAuthentication,
  expected: {
    readonly operation: ReleaseMutationOperation;
    readonly scope: EvidenceScope;
    readonly requestId: string;
  },
): AuthenticatedState {
  const state = issued.get(proof);
  if (
    !state ||
    state.operation !== expected.operation ||
    state.principal.requestId !== expected.requestId ||
    !isDeepStrictEqual(state.scope, EvidenceScopeSchema.parse(expected.scope))
  )
    throw new InvalidReleaseMutationAuthenticationError();
  return structuredClone(state);
}
