import type { Capability, EvidenceScope } from "@proofstack/contracts";
import { ForbiddenError } from "@proofstack/core";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { generateApiKey } from "./api-key.js";
import { generateBrowserSessionCredentials } from "./oidc-secrets.js";
import {
  type AuthenticatableBrowserSession,
  InvalidBrowserCsrfError,
  InvalidBrowserSessionError,
  OidcSessionAuthenticator,
} from "./oidc-session.js";
import {
  InvalidReleaseMutationAuthenticationError,
  type ReleaseMutationAuthentication,
  ReleaseMutationAuthenticator,
  type ReleaseMutationOperation,
  readReleaseMutationAuthentication,
} from "./release-mutation-authentication.js";
import { generateServiceToken, hashServiceTokenSecret } from "./service-token.js";
import {
  type AuthenticatableServiceToken,
  InvalidServiceTokenError,
  ServiceTokenAuthenticator,
} from "./service-token-authenticator.js";

const scope: EvidenceScope = {
  tenantId: "tenant_release_access",
  projectId: "project_release_access",
  environmentId: "environment_release_access",
};
const operations = [
  ["manage_selection", "release:selection:manage", "authenticateSelectionInstaller"],
  [
    "manage_reviewer_authority",
    "approval:authority:manage",
    "authenticateReviewerAuthorityAdministrator",
  ],
  ["record_approval", "approval:decide", "authenticateApprovalReviewer"],
  ["publish_decision", "release:decision:publish", "authenticateDecisionPublisher"],
] as const;
const allCapabilities: Capability[] = operations.map(([, capability]) => capability);
function browser(patch: Partial<AuthenticatableBrowserSession> = {}) {
  const credentials = generateBrowserSessionCredentials();
  const session: AuthenticatableBrowserSession = {
    capabilities: allCapabilities,
    createdAt: "2026-10-16T09:00:00.000Z",
    csrfDigest: credentials.csrfDigest,
    principalId: "user_release_access",
    resourceScope: {
      mode: "restricted",
      projects: [{ projectId: scope.projectId, environmentIds: [scope.environmentId] }],
    },
    roles: ["admin"],
    sessionDigest: credentials.sessionDigest,
    sessionId: "session_release_access",
    tenantId: scope.tenantId,
    ...patch,
  };
  const lookup = {
    findAndTouchActive: vi.fn(
      async (_digest: string): Promise<AuthenticatableBrowserSession | null> => session,
    ),
  };
  const authenticator = new OidcSessionAuthenticator(lookup);
  return {
    session,
    credentials,
    lookup,
    authenticator,
    release: new ReleaseMutationAuthenticator(authenticator),
    input: {
      sessionToken: credentials.sessionToken,
      csrfToken: credentials.csrfToken,
      requestId: "request_release_access",
      scope: structuredClone(scope),
    },
  };
}
const token = generateServiceToken();
let serviceRecord: AuthenticatableServiceToken;
beforeAll(async () => {
  serviceRecord = {
    kind: "service_token",
    authenticatedAt: "2026-10-16T09:00:00.000Z",
    credentialId: "credential_release_service",
    prefix: token.prefix,
    passwordHash: await hashServiceTokenSecret(token.secret),
    principalId: "service_release_publisher",
    tenantId: scope.tenantId,
    capabilities: ["release:decision:publish"],
    resourceScope: { mode: "tenant" },
  };
});
function service(patch: Partial<AuthenticatableServiceToken> = {}) {
  const lookup = {
    findActiveServiceByPrefix: vi.fn(async () => ({ ...serviceRecord, ...patch })),
    confirmActiveServiceUse: vi.fn(async () => true),
  };
  const authenticator = new ServiceTokenAuthenticator(lookup);
  return {
    lookup,
    release: new ReleaseMutationAuthenticator(browser().authenticator, authenticator),
    input: {
      serviceToken: token.value,
      requestId: "request_release_service",
      scope,
    },
  };
}
const read = (
  proof: ReleaseMutationAuthentication,
  operation: ReleaseMutationOperation = "record_approval",
  requestId = "request_release_access",
) => readReleaseMutationAuthentication(proof, { operation, scope, requestId });

describe("fixed actual release mutation authentication, not installed/native authority", () => {
  it.each(operations)(
    "binds actual OIDC/CSRF, exact scope and separately granted %s",
    async (operation, _capability, method) => {
      const value = browser();
      const proof = await value.release[method](value.input);
      const authenticated = read(proof, operation);
      expect(authenticated.operation).toBe(operation);
      expect(authenticated.scope).toEqual(scope);
      expect(authenticated.receipt).toEqual({
        principalId: value.session.principalId,
        principalType: "user",
        authenticationMethod: "oidc",
        authenticatedAt: value.session.createdAt,
        credentialId: value.session.sessionId,
        requestId: value.input.requestId,
      });
      expect(authenticated.principal.capabilities).toEqual(allCapabilities);
      expect(value.lookup.findAndTouchActive).toHaveBeenCalledExactlyOnceWith(
        value.credentials.sessionDigest,
      );
      expect(Object.isFrozen(proof)).toBe(true);
      expect(Object.keys(proof)).toEqual([]);
      expect(JSON.stringify(proof)).toBe("{}");
      for (const secret of Object.values(value.credentials))
        expect(JSON.stringify(authenticated)).not.toContain(secret);
    },
  );
  it.each(operations)(
    "does not infer %s from admin or the other release capabilities",
    async (_operation, capability, method) => {
      const value = browser({
        capabilities: allCapabilities.filter((item) => item !== capability),
      });
      await expect(value.release[method](value.input)).rejects.toBeInstanceOf(ForbiddenError);
    },
  );
  it("accepts actual unrestricted tenant grants without inventing a reviewer authority", async () => {
    const value = browser({ resourceScope: { mode: "tenant" } });
    const authenticated = read(await value.release.authenticateApprovalReviewer(value.input));
    expect(authenticated.principal.resourceScope).toEqual({ mode: "tenant" });
    expect(Object.keys(authenticated).sort()).toEqual([
      "operation",
      "principal",
      "receipt",
      "scope",
    ]);
  });
  it.each(["tenantId", "projectId", "environmentId"] as const)(
    "rejects a foreign %s",
    async (field) => {
      const value = browser();
      await expect(
        value.release.authenticateApprovalReviewer({
          ...value.input,
          scope: { ...scope, [field]: `foreign_${field.toLowerCase()}` },
        }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    },
  );
  it("authenticates before scope parsing and checks capability before invalid scope", async () => {
    const value = browser({ capabilities: [] });
    const input = { ...value.input, scope: { ...scope, tenantId: "INVALID" } };
    await expect(
      value.release.authenticateApprovalReviewer({ ...input, sessionToken: "invalid" }),
    ).rejects.toBeInstanceOf(InvalidBrowserSessionError);
    expect(value.lookup.findAndTouchActive).not.toHaveBeenCalled();
    await expect(value.release.authenticateApprovalReviewer(input)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });
  it("rejects malformed scope after actual authentication/CSRF and capability", async () => {
    const value = browser();
    await expect(
      value.release.authenticateApprovalReviewer({
        ...value.input,
        scope: { ...scope, tenantId: "INVALID" },
      }),
    ).rejects.toThrow();
    expect(value.lookup.findAndTouchActive).toHaveBeenCalledOnce();
  });
  it("refuses a noncanonical receipt request ID after actual browser authentication", async () => {
    const value = browser();
    await expect(
      value.release.authenticateApprovalReviewer({ ...value.input, requestId: "request_\ud800" }),
    ).rejects.toThrow();
    expect(value.lookup.findAndTouchActive).toHaveBeenCalledOnce();
  });
  it.each(["", "invalid", generateBrowserSessionCredentials().csrfToken])(
    "rejects an absent, malformed or other-session CSRF token %#",
    async (csrfToken) => {
      const value = browser();
      await expect(
        value.release.authenticateApprovalReviewer({ ...value.input, csrfToken }),
      ).rejects.toBeInstanceOf(InvalidBrowserCsrfError);
    },
  );
  it.each(["invalid", generateApiKey().value, token.value])(
    "cannot promote foreign/development credentials into OIDC approval %#",
    async (sessionToken) => {
      const value = browser();
      await expect(
        value.release.authenticateApprovalReviewer({ ...value.input, sessionToken }),
      ).rejects.toBeInstanceOf(InvalidBrowserSessionError);
      expect(value.lookup.findAndTouchActive).not.toHaveBeenCalled();
    },
  );
  it("rejects inactive/revoked sessions and retains a prior proof only as an authentication fact", async () => {
    const value = browser();
    const proof = await value.release.authenticateApprovalReviewer(value.input);
    value.lookup.findAndTouchActive.mockResolvedValue(null);
    await expect(value.release.authenticateApprovalReviewer(value.input)).rejects.toBeInstanceOf(
      InvalidBrowserSessionError,
    );
    expect(read(proof).receipt.credentialId).toBe(value.session.sessionId);
    // A native owner must still check current identity/session/authority under held guards.
    expect(read(proof)).not.toHaveProperty("currentAuthority");
  });
  it("preserves actual identity storage failures without minting a proof", async () => {
    const value = browser();
    const failure = new Error("isolated identity storage unavailable");
    value.lookup.findAndTouchActive.mockRejectedValue(failure);
    await expect(value.release.authenticateApprovalReviewer(value.input)).rejects.toBe(failure);
  });
  it("keeps issued state independent of mutable provider, request and returned projections", async () => {
    const value = browser();
    const proof = await value.release.authenticateApprovalReviewer(value.input);
    const first = read(proof);
    first.principal.capabilities.length = 0;
    first.principal.resourceScope = { mode: "tenant" };
    value.input.scope.environmentId = "environment_changed";
    Object.assign(value.session, { principalId: "user_changed" });
    const retained = read(proof);
    expect(retained.scope).toEqual(scope);
    expect(retained.principal.capabilities).toEqual(allCapabilities);
    expect(retained.receipt.principalId).toBe("user_release_access");
  });
  it("rejects public principals/receipts, clones, spreads and proxy wrappers as proofs", async () => {
    const value = browser();
    const proof = await value.release.authenticateApprovalReviewer(value.input);
    const state = read(proof);
    for (const fake of [
      null,
      undefined,
      "",
      {},
      [],
      state,
      state.principal,
      state.receipt,
      structuredClone(proof),
      { ...proof },
      new Proxy(proof, {}),
    ])
      expect(() => read(fake as ReleaseMutationAuthentication)).toThrow(
        InvalidReleaseMutationAuthenticationError,
      );
  });
  it("does not rebind an issued proof to another operation or scope", async () => {
    const value = browser();
    const proof = await value.release.authenticateApprovalReviewer(value.input);
    expect(() => read(proof, "record_approval", "request_another_mutation")).toThrow(
      InvalidReleaseMutationAuthenticationError,
    );
    expect(() => read(proof, "publish_decision")).toThrow(
      InvalidReleaseMutationAuthenticationError,
    );
    expect(() =>
      readReleaseMutationAuthentication(proof, {
        operation: "record_approval",
        scope: { ...scope, environmentId: "environment_foreign" },
        requestId: value.input.requestId,
      }),
    ).toThrow(InvalidReleaseMutationAuthenticationError);
  });
  it.each([
    null,
    "invalid",
    1,
    [],
    {},
    { sessionToken: "invalid" },
    { sessionToken: "invalid", csrfToken: "invalid", requestId: "request_invalid", principal: {} },
    {
      sessionToken: "invalid",
      csrfToken: "invalid",
      requestId: "request_invalid",
      scope,
      principal: {},
    },
  ])("refuses malformed/caller-selected browser authority fields %#", async (input) => {
    const value = browser();
    await expect(value.release.authenticateApprovalReviewer(input as never)).rejects.toBeInstanceOf(
      InvalidReleaseMutationAuthenticationError,
    );
    expect(value.lookup.findAndTouchActive).not.toHaveBeenCalled();
  });
  it("refuses substitute authenticator callbacks", () => {
    expect(
      () => new ReleaseMutationAuthenticator({ authenticate: async () => ({}) } as never),
    ).toThrow(InvalidReleaseMutationAuthenticationError);
    expect(() => new ReleaseMutationAuthenticator(browser().authenticator, {} as never)).toThrow(
      InvalidReleaseMutationAuthenticationError,
    );
  });
  it("allows an actual separately provisioned service secret only through the private publisher path", async () => {
    const value = service();
    const proof = await value.release.authenticateServiceDecisionPublisher(value.input);
    const state = read(proof, "publish_decision", value.input.requestId);
    expect(state.receipt).toEqual({
      principalId: serviceRecord.principalId,
      principalType: "service",
      authenticationMethod: "service_token",
      authenticatedAt: serviceRecord.authenticatedAt,
      credentialId: serviceRecord.credentialId,
      requestId: value.input.requestId,
    });
    expect(value.lookup.confirmActiveServiceUse).toHaveBeenCalledOnce();
    for (const operation of [
      "record_approval",
      "manage_selection",
      "manage_reviewer_authority",
    ] as const)
      expect(() => read(proof, operation, value.input.requestId)).toThrow(
        InvalidReleaseMutationAuthenticationError,
      );
    expect(JSON.stringify(state)).not.toContain(token.secret);
    expect(JSON.stringify(state)).not.toContain(serviceRecord.passwordHash.digest);
  });
  it("requires a separately configured service authenticator", async () => {
    const value = browser();
    await expect(
      value.release.authenticateServiceDecisionPublisher(service().input),
    ).rejects.toBeInstanceOf(InvalidReleaseMutationAuthenticationError);
  });
  it("does not substitute a policy worker service capability for publisher authority", async () => {
    const value = service({ capabilities: ["policy:evaluation:execute"] });
    await expect(
      value.release.authenticateServiceDecisionPublisher(value.input),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
  it("rejects service revocation during actual secret verification", async () => {
    const value = service();
    value.lookup.confirmActiveServiceUse.mockResolvedValue(false);
    await expect(
      value.release.authenticateServiceDecisionPublisher(value.input),
    ).rejects.toBeInstanceOf(InvalidServiceTokenError);
  });
  it("rejects a wrong service secret and preserves owning lookup failure", async () => {
    const value = service();
    await expect(
      value.release.authenticateServiceDecisionPublisher({
        ...value.input,
        serviceToken: `pss_v1_${token.prefix}_${generateServiceToken().secret}`,
      }),
    ).rejects.toBeInstanceOf(InvalidServiceTokenError);
    const failure = new Error("isolated service provider unavailable");
    value.lookup.findActiveServiceByPrefix.mockRejectedValue(failure);
    await expect(value.release.authenticateServiceDecisionPublisher(value.input)).rejects.toBe(
      failure,
    );
  });
  it("rejects caller authority fields on the private publisher input", async () => {
    const value = service();
    await expect(
      value.release.authenticateServiceDecisionPublisher({
        ...value.input,
        principal: {},
      } as never),
    ).rejects.toBeInstanceOf(InvalidReleaseMutationAuthenticationError);
    expect(value.lookup.findActiveServiceByPrefix).not.toHaveBeenCalled();
  });
});
