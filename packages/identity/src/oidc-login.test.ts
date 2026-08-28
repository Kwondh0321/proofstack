import { describe, expect, it } from "vitest";
import {
  type ActiveOidcBinding,
  BrowserSessionConflictError,
  type BrowserSessionCreator,
  type CreatedBrowserSession,
  type CreatedOidcLoginTransaction,
  type CreateBrowserSession,
  type CreateOidcLoginTransaction,
  InvalidOidcLoginError,
  OidcIdentityDataIntegrityError,
  OidcBindingNotActiveError,
  OidcLoginGenerationError,
  OidcLoginService,
  type OidcLoginServiceDependencies,
  type OidcLoginServiceOptions,
  OidcLoginTransactionConflictError,
  type OidcLoginTransactionStore,
  type OidcAuthorizationInput,
  type OidcCallbackInput,
  OidcProviderConfigurationError,
  type OidcProviderClient,
} from "./oidc-login.js";
import {
  generateBrowserSessionCredentials,
  generateOidcLoginSecrets,
  generateOidcTransactionSecret,
  OidcLoginTransactionCipher,
  oidcStateDigest,
} from "./oidc-secrets.js";

const CREATED_AT = "2026-08-28T09:00:01.000Z";
const ISSUER = "https://identity.example.test/tenant";
const SUBJECT = "provider-subject-001";

function source(start = 1) {
  let value = start;
  return (size: number) => {
    const result = new Uint8Array(size).fill(value);
    value += 1;
    return result;
  };
}

function authorizationUrl(input: OidcAuthorizationInput): string {
  const url = new URL("https://identity.example.test/authorize");
  url.searchParams.set("client_id", "proofstack-console");
  url.searchParams.set("redirect_uri", "https://proofstack.example.test/auth/oidc/callback");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid");
  url.searchParams.set("state", input.state);
  url.searchParams.set("nonce", input.nonce);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

class Provider implements OidcProviderClient {
  readonly authorizationInputs: OidcAuthorizationInput[] = [];
  readonly callbackInputs: OidcCallbackInput[] = [];
  authorizationTransform?: (value: string, input: OidcAuthorizationInput) => string;
  callbackError?: Error;
  issuer = ISSUER;
  subject = SUBJECT;

  authorizationUrl(input: OidcAuthorizationInput): string {
    this.authorizationInputs.push(input);
    const value = authorizationUrl(input);
    return this.authorizationTransform?.(value, input) ?? value;
  }

  async validateCallback(input: OidcCallbackInput): Promise<{ readonly subject: string }> {
    this.callbackInputs.push(input);
    if (this.callbackError) throw this.callbackError;
    return { subject: this.subject };
  }
}

class Transactions implements OidcLoginTransactionStore {
  readonly createInputs: CreateOidcLoginTransaction[] = [];
  readonly consumeInputs: string[] = [];
  readonly records = new Map<string, CreateOidcLoginTransaction>();
  conflicts = 0;
  createError?: Error;
  transform?: (
    value: CreatedOidcLoginTransaction,
    input: CreateOidcLoginTransaction,
  ) => CreatedOidcLoginTransaction;

  async create(input: CreateOidcLoginTransaction): Promise<CreatedOidcLoginTransaction> {
    this.createInputs.push(input);
    if (this.createError) throw this.createError;
    if (this.conflicts > 0) {
      this.conflicts -= 1;
      throw new OidcLoginTransactionConflictError();
    }
    this.records.set(input.stateDigest, input);
    const value = {
      createdAt: CREATED_AT,
      expiresAt: new Date(
        new Date(CREATED_AT).getTime() + input.lifetimeSeconds * 1_000,
      ).toISOString(),
    };
    return this.transform?.(value, input) ?? value;
  }

  async consumeActive(stateDigest: string) {
    this.consumeInputs.push(stateDigest);
    const record = this.records.get(stateDigest) ?? null;
    this.records.delete(stateDigest);
    return record;
  }
}

class Sessions implements BrowserSessionCreator {
  readonly createInputs: CreateBrowserSession[] = [];
  conflicts = 0;
  createError?: Error;
  transform?: (value: CreatedBrowserSession, input: CreateBrowserSession) => CreatedBrowserSession;

  async create(input: CreateBrowserSession): Promise<CreatedBrowserSession> {
    this.createInputs.push(input);
    if (this.createError) throw this.createError;
    if (this.conflicts > 0) {
      this.conflicts -= 1;
      throw new BrowserSessionConflictError();
    }
    const createdAtMs = new Date(CREATED_AT).getTime();
    const value = {
      absoluteExpiresAt: new Date(
        createdAtMs + input.absoluteLifetimeSeconds * 1_000,
      ).toISOString(),
      createdAt: CREATED_AT,
      idleExpiresAt: new Date(createdAtMs + input.idleLifetimeSeconds * 1_000).toISOString(),
      sessionId: input.sessionId,
    };
    return this.transform?.(value, input) ?? value;
  }
}

function binding(overrides: Partial<ActiveOidcBinding> = {}): ActiveOidcBinding {
  return {
    bindingId: "oidc_binding_001",
    capabilities: ["project:read", "evidence:read", "identity:manage"],
    issuer: ISSUER,
    principalId: "usr_operator_001",
    resourceScope: { mode: "tenant" },
    roles: ["admin"],
    subject: SUBJECT,
    tenantId: "ten_identity_001",
    ...overrides,
  };
}

function dependencies(): OidcLoginServiceDependencies {
  let loginSequence = 10;
  let sessionSequence = 40;
  let sessionIdSequence = 0;
  return {
    generateLoginSecrets: () => {
      loginSequence += 3;
      return generateOidcLoginSecrets(source(loginSequence));
    },
    generateSessionCredentials: () => {
      sessionSequence += 3;
      return generateBrowserSessionCredentials(source(sessionSequence));
    },
    generateSessionId: () => {
      sessionIdSequence += 1;
      return `ses_generated_${sessionIdSequence}`;
    },
  };
}

function fixture(options: OidcLoginServiceOptions = {}) {
  const provider = new Provider();
  const transactions = new Transactions();
  const sessions = new Sessions();
  const activeBinding = binding();
  const bindings = {
    calls: [] as Array<{ readonly issuer: string; readonly subject: string }>,
    result: activeBinding as ActiveOidcBinding | null,
    async findActiveByIssuerSubject(issuer: string, subject: string) {
      this.calls.push({ issuer, subject });
      return this.result;
    },
  };
  const cipher = new OidcLoginTransactionCipher(generateOidcTransactionSecret(source(2)));
  const injected = dependencies();
  const service = new OidcLoginService(
    { bindings, cipher, provider, sessions, transactions },
    options,
    injected,
  );
  return { bindings, cipher, injected, provider, service, sessions, transactions };
}

async function beginAndState(value: ReturnType<typeof fixture>, returnTo = "/traces") {
  const begun = await value.service.begin(returnTo);
  const state = new URL(begun.authorizationUrl).searchParams.get("state");
  if (!state) throw new Error("fixture authorization URL did not contain state");
  return { begun, state };
}

describe("OidcLoginService.begin", () => {
  it("stores an encrypted, expiring transaction after verifying every PKCE URL parameter", async () => {
    const value = fixture({ transactionLifetimeSeconds: 15 * 60 });
    const result = await value.service.begin("/traces?view=recent");
    const input = value.provider.authorizationInputs[0];
    const stored = value.transactions.createInputs[0];

    expect(result.expiresAt).toBe("2026-08-28T09:15:01.000Z");
    expect(input).toEqual({
      codeChallenge: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      nonce: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      state: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    });
    expect(new URL(result.authorizationUrl).searchParams.get("code_challenge_method")).toBe("S256");
    expect(stored).toMatchObject({
      lifetimeSeconds: 15 * 60,
      protectedPayload: expect.stringMatching(/^otx_v1_/),
      stateDigest: oidcStateDigest(input?.state ?? ""),
    });
    expect(value.cipher.decrypt(stored?.protectedPayload ?? "")).toEqual({
      codeVerifier: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      nonce: input?.nonce,
      returnTo: "/traces?view=recent",
      state: input?.state,
    });
  });

  it("retries transaction identity conflicts with fresh independent state", async () => {
    const value = fixture();
    value.transactions.conflicts = 2;

    await expect(value.service.begin("/")).resolves.toMatchObject({
      authorizationUrl: expect.stringContaining("response_type=code"),
    });
    expect(value.transactions.createInputs).toHaveLength(3);
    expect(new Set(value.transactions.createInputs.map((input) => input.stateDigest)).size).toBe(3);
  });

  it("stops after bounded transaction conflicts", async () => {
    const value = fixture();
    value.transactions.conflicts = 3;

    await expect(value.service.begin("/")).rejects.toBeInstanceOf(OidcLoginGenerationError);
    expect(value.transactions.createInputs).toHaveLength(3);
  });

  it("preserves transaction storage failures and rejects unsafe return paths", async () => {
    const unavailable = fixture();
    const storageError = new Error("transaction store unavailable");
    unavailable.transactions.createError = storageError;
    await expect(unavailable.service.begin("/")).rejects.toBe(storageError);

    const unsafe = fixture();
    await expect(unsafe.service.begin("https://attacker.example/redirect")).rejects.toThrow(
      "payload is malformed",
    );
    expect(unsafe.transactions.createInputs).toHaveLength(0);
  });

  it.each([
    ["creation time", (value: CreatedOidcLoginTransaction) => ({ ...value, createdAt: "invalid" })],
    [
      "expiration time",
      (value: CreatedOidcLoginTransaction) => ({ ...value, expiresAt: "invalid" }),
    ],
    [
      "lifetime",
      (value: CreatedOidcLoginTransaction) => ({
        ...value,
        expiresAt: new Date(new Date(value.expiresAt).getTime() + 1_000).toISOString(),
      }),
    ],
  ])("rejects invalid transaction-store %s", async (_label, transform) => {
    const value = fixture();
    value.transactions.transform = transform;

    await expect(value.service.begin("/")).rejects.toThrow(
      "transaction store returned invalid metadata",
    );
  });

  it.each([
    ["empty", () => ""],
    ["oversized", () => "x".repeat(4_097)],
    ["malformed", () => "not a URL"],
    ["non-HTTPS", (value: string) => value.replace("https:", "http:")],
    ["username", (value: string) => value.replace("https://", "https://user@")],
    ["password", (value: string) => value.replace("https://", "https://:secret@")],
    ["fragment", (value: string) => `${value}#fragment`],
    [
      "missing response type",
      (value: string) => {
        const url = new URL(value);
        url.searchParams.delete("response_type");
        return url.toString();
      },
    ],
    [
      "duplicate state",
      (value: string) => {
        const url = new URL(value);
        url.searchParams.append("state", "duplicate");
        return url.toString();
      },
    ],
    [
      "wrong nonce",
      (value: string) => {
        const url = new URL(value);
        url.searchParams.set("nonce", "wrong");
        return url.toString();
      },
    ],
    [
      "wrong challenge",
      (value: string) => {
        const url = new URL(value);
        url.searchParams.set("code_challenge", "wrong");
        return url.toString();
      },
    ],
    [
      "wrong challenge method",
      (value: string) => {
        const url = new URL(value);
        url.searchParams.set("code_challenge_method", "plain");
        return url.toString();
      },
    ],
  ])("rejects a %s authorization URL before persistence", async (_label, transform) => {
    const value = fixture();
    value.provider.authorizationTransform = transform;

    await expect(value.service.begin("/")).rejects.toBeInstanceOf(OidcProviderConfigurationError);
    expect(value.transactions.createInputs).toHaveLength(0);
  });
});

describe("OidcLoginService configuration", () => {
  it.each([
    ["", "invalid"],
    [`https://identity.example.test/${"x".repeat(2_100)}`, "invalid"],
    ["https://identity.example.test/bad\nissuer", "invalid"],
    ["not a URL", "invalid"],
    ["http://identity.example.test", "HTTPS"],
    ["https://user@identity.example.test", "HTTPS"],
    ["https://:secret@identity.example.test", "HTTPS"],
    ["https://identity.example.test?tenant=one", "HTTPS"],
    ["https://identity.example.test#tenant", "HTTPS"],
  ])("rejects unsafe issuer %j", (issuer, message) => {
    const value = fixture();
    value.provider.issuer = issuer;

    expect(
      () =>
        new OidcLoginService(
          {
            bindings: value.bindings,
            cipher: value.cipher,
            provider: value.provider,
            sessions: value.sessions,
            transactions: value.transactions,
          },
          {},
          value.injected,
        ),
    ).toThrow(message);
  });

  it.each([
    [{ transactionLifetimeSeconds: 60.5 }, "transaction"],
    [{ transactionLifetimeSeconds: 59 }, "transaction"],
    [{ transactionLifetimeSeconds: 901 }, "transaction"],
    [{ absoluteSessionLifetimeSeconds: 86_401 }, "absolute"],
    [{ absoluteSessionLifetimeSeconds: 600, idleSessionLifetimeSeconds: 601 }, "idle"],
  ] satisfies Array<[OidcLoginServiceOptions, string]>)(
    "rejects invalid lifetime options %j",
    (options, message) => {
      expect(() => fixture(options)).toThrow(message);
    },
  );
});

describe("OidcLoginService.complete", () => {
  it("consumes one transaction, validates the callback, binds the subject, and rotates into a session", async () => {
    const value = fixture({
      absoluteSessionLifetimeSeconds: 3_600,
      idleSessionLifetimeSeconds: 600,
    });
    const { state } = await beginAndState(value, "/traces/trace_001");
    const result = await value.service.complete(
      `https://proofstack.example.test/auth/oidc/callback?code=opaque&state=${state}`,
      state,
    );

    expect(value.transactions.consumeInputs).toEqual([oidcStateDigest(state)]);
    expect(value.provider.callbackInputs).toEqual([
      {
        codeVerifier: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
        currentUrl: expect.stringContaining("code=opaque"),
        expectedNonce: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
        expectedState: state,
      },
    ]);
    expect(value.bindings.calls).toEqual([{ issuer: ISSUER, subject: SUBJECT }]);
    expect(value.sessions.createInputs).toEqual([
      {
        absoluteLifetimeSeconds: 3_600,
        bindingId: "oidc_binding_001",
        csrfDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
        idleLifetimeSeconds: 600,
        sessionDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
        sessionId: "ses_generated_1",
      },
    ]);
    expect(result).toEqual({
      absoluteExpiresAt: "2026-08-28T10:00:01.000Z",
      csrfToken: expect.stringMatching(/^psc_v1_/),
      idleExpiresAt: "2026-08-28T09:10:01.000Z",
      returnTo: "/traces/trace_001",
      sessionToken: expect.stringMatching(/^pss_v1_/),
    });
  });

  it("makes a login transaction single-use", async () => {
    const value = fixture();
    const { state } = await beginAndState(value);

    await expect(
      value.service.complete("https://proofstack.example.test/callback", state),
    ).resolves.toBeDefined();
    await expect(
      value.service.complete("https://proofstack.example.test/callback", state),
    ).rejects.toBeInstanceOf(InvalidOidcLoginError);
    expect(value.provider.callbackInputs).toHaveLength(1);
  });

  it("rejects malformed and unknown state through one bounded error", async () => {
    const malformed = fixture();
    await expect(
      malformed.service.complete("https://proofstack.example.test/callback", "invalid"),
    ).rejects.toEqual(expect.objectContaining({ message: "OIDC login is invalid or expired" }));
    expect(malformed.transactions.consumeInputs).toHaveLength(0);

    const unknown = fixture();
    const state = generateOidcLoginSecrets(source(70)).state;
    await expect(
      unknown.service.complete("https://proofstack.example.test/callback", state),
    ).rejects.toBeInstanceOf(InvalidOidcLoginError);
  });

  it("detects inconsistent or corrupted transaction storage", async () => {
    const mismatchedDigest = fixture();
    const first = await beginAndState(mismatchedDigest);
    const firstDigest = oidcStateDigest(first.state);
    const record = mismatchedDigest.transactions.records.get(firstDigest);
    if (!record) throw new Error("missing fixture transaction");
    mismatchedDigest.transactions.records.set(firstDigest, {
      ...record,
      stateDigest: "f".repeat(64),
    });
    await expect(
      mismatchedDigest.service.complete("https://proofstack.example.test/callback", first.state),
    ).rejects.toThrow("different state digest");

    const corrupted = fixture();
    const second = await beginAndState(corrupted);
    const secondDigest = oidcStateDigest(second.state);
    const secondRecord = corrupted.transactions.records.get(secondDigest);
    if (!secondRecord) throw new Error("missing fixture transaction");
    corrupted.transactions.records.set(secondDigest, {
      ...secondRecord,
      protectedPayload: "corrupted",
    });
    await expect(
      corrupted.service.complete("https://proofstack.example.test/callback", second.state),
    ).rejects.toThrow("Stored OIDC transaction is invalid");
  });

  it("detects a state mismatch inside an otherwise authentic transaction", async () => {
    const value = fixture();
    const { state } = await beginAndState(value);
    const digest = oidcStateDigest(state);
    const stored = value.transactions.records.get(digest);
    const other = generateOidcLoginSecrets(source(73));
    if (!stored) throw new Error("missing fixture transaction");
    value.transactions.records.set(digest, {
      ...stored,
      protectedPayload: value.cipher.encrypt({
        codeVerifier: other.codeVerifier,
        nonce: other.nonce,
        returnTo: "/",
        state: other.state,
      }),
    });

    await expect(
      value.service.complete("https://proofstack.example.test/callback", state),
    ).rejects.toThrow("state is inconsistent");
  });

  it("normalizes provider callback failures without attempting a binding lookup", async () => {
    const value = fixture();
    const { state } = await beginAndState(value);
    value.provider.callbackError = new Error("provider rejected callback");

    await expect(
      value.service.complete("https://proofstack.example.test/callback", state),
    ).rejects.toBeInstanceOf(InvalidOidcLoginError);
    expect(value.bindings.calls).toHaveLength(0);
  });

  it.each(["", "x".repeat(513), "bad\nsubject"])(
    "rejects an invalid provider subject %j as an integration fault",
    async (subject) => {
      const value = fixture();
      const { state } = await beginAndState(value);
      value.provider.subject = subject;

      await expect(
        value.service.complete("https://proofstack.example.test/callback", state),
      ).rejects.toBeInstanceOf(OidcIdentityDataIntegrityError);
      expect(value.bindings.calls).toHaveLength(0);
    },
  );

  it("rejects an unbound identity without disclosing whether the subject exists", async () => {
    const value = fixture();
    const { state } = await beginAndState(value);
    value.bindings.result = null;

    await expect(
      value.service.complete("https://proofstack.example.test/callback", state),
    ).rejects.toEqual(expect.objectContaining({ message: "OIDC login is invalid or expired" }));
    expect(value.sessions.createInputs).toHaveLength(0);
  });

  it.each([
    [{ issuer: "https://other.example.test" }, "different identity"],
    [{ subject: "other-subject" }, "different identity"],
    [{ tenantId: "INVALID" }, "authorization is invalid"],
  ] satisfies Array<[Partial<ActiveOidcBinding>, string]>)(
    "rejects corrupt binding data %j",
    async (override, message) => {
      const value = fixture();
      const { state } = await beginAndState(value);
      value.bindings.result = binding(override);

      await expect(
        value.service.complete("https://proofstack.example.test/callback", state),
      ).rejects.toThrow(message);
      expect(value.sessions.createInputs).toHaveLength(0);
    },
  );

  it("retries browser session conflicts with new token and identifier pairs", async () => {
    const value = fixture();
    const { state } = await beginAndState(value);
    value.sessions.conflicts = 2;

    await expect(
      value.service.complete("https://proofstack.example.test/callback", state),
    ).resolves.toBeDefined();
    expect(value.sessions.createInputs).toHaveLength(3);
    expect(new Set(value.sessions.createInputs.map((input) => input.sessionId)).size).toBe(3);
    expect(new Set(value.sessions.createInputs.map((input) => input.sessionDigest)).size).toBe(3);
  });

  it("stops after bounded browser session conflicts", async () => {
    const value = fixture();
    const { state } = await beginAndState(value);
    value.sessions.conflicts = 3;

    await expect(
      value.service.complete("https://proofstack.example.test/callback", state),
    ).rejects.toBeInstanceOf(OidcLoginGenerationError);
    expect(value.sessions.createInputs).toHaveLength(3);
  });

  it("preserves browser session storage failures", async () => {
    const value = fixture();
    const { state } = await beginAndState(value);
    const storageError = new Error("session store unavailable");
    value.sessions.createError = storageError;

    await expect(
      value.service.complete("https://proofstack.example.test/callback", state),
    ).rejects.toBe(storageError);
  });

  it("normalizes a binding disabled between lookup and session creation", async () => {
    const value = fixture();
    const { state } = await beginAndState(value);
    value.sessions.createError = new OidcBindingNotActiveError();

    await expect(
      value.service.complete("https://proofstack.example.test/callback", state),
    ).rejects.toEqual(expect.objectContaining({ message: "OIDC login is invalid or expired" }));
    expect(value.sessions.createInputs).toHaveLength(1);
  });

  it("rejects invalid generated session identifiers and credentials", async () => {
    const invalidId = fixture();
    const first = await beginAndState(invalidId);
    const invalidIdDependencies = {
      ...invalidId.injected,
      generateSessionId: () => "INVALID",
    };
    const invalidIdService = new OidcLoginService(
      {
        bindings: invalidId.bindings,
        cipher: invalidId.cipher,
        provider: invalidId.provider,
        sessions: invalidId.sessions,
        transactions: invalidId.transactions,
      },
      {},
      invalidIdDependencies,
    );
    await expect(
      invalidIdService.complete("https://proofstack.example.test/callback", first.state),
    ).rejects.toThrow("session identifier is invalid");

    const malformedToken = fixture();
    const second = await beginAndState(malformedToken);
    const malformedTokenService = new OidcLoginService(
      {
        bindings: malformedToken.bindings,
        cipher: malformedToken.cipher,
        provider: malformedToken.provider,
        sessions: malformedToken.sessions,
        transactions: malformedToken.transactions,
      },
      {},
      {
        ...malformedToken.injected,
        generateSessionCredentials: () => ({
          ...generateBrowserSessionCredentials(source(80)),
          sessionToken: "malformed",
        }),
      },
    );
    await expect(
      malformedTokenService.complete("https://proofstack.example.test/callback", second.state),
    ).rejects.toThrow("credentials are invalid");
  });

  it("rejects inconsistent generated session and CSRF digests", async () => {
    const sessionMismatch = fixture();
    const first = await beginAndState(sessionMismatch);
    const sessionMismatchService = new OidcLoginService(
      {
        bindings: sessionMismatch.bindings,
        cipher: sessionMismatch.cipher,
        provider: sessionMismatch.provider,
        sessions: sessionMismatch.sessions,
        transactions: sessionMismatch.transactions,
      },
      {},
      {
        ...sessionMismatch.injected,
        generateSessionCredentials: () => ({
          ...generateBrowserSessionCredentials(source(84)),
          sessionDigest: "0".repeat(64),
        }),
      },
    );
    await expect(
      sessionMismatchService.complete("https://proofstack.example.test/callback", first.state),
    ).rejects.toThrow("credentials are inconsistent");

    const csrfMismatch = fixture();
    const second = await beginAndState(csrfMismatch);
    const csrfMismatchService = new OidcLoginService(
      {
        bindings: csrfMismatch.bindings,
        cipher: csrfMismatch.cipher,
        provider: csrfMismatch.provider,
        sessions: csrfMismatch.sessions,
        transactions: csrfMismatch.transactions,
      },
      {},
      {
        ...csrfMismatch.injected,
        generateSessionCredentials: () => ({
          ...generateBrowserSessionCredentials(source(87)),
          csrfDigest: "0".repeat(64),
        }),
      },
    );
    await expect(
      csrfMismatchService.complete("https://proofstack.example.test/callback", second.state),
    ).rejects.toThrow("credentials are inconsistent");
  });

  it.each([
    ["session ID", (value: CreatedBrowserSession) => ({ ...value, sessionId: "ses_other" })],
    ["created time", (value: CreatedBrowserSession) => ({ ...value, createdAt: "invalid" })],
    [
      "absolute expiration",
      (value: CreatedBrowserSession) => ({ ...value, absoluteExpiresAt: "invalid" }),
    ],
    ["idle expiration", (value: CreatedBrowserSession) => ({ ...value, idleExpiresAt: "invalid" })],
    [
      "absolute duration",
      (value: CreatedBrowserSession) => ({
        ...value,
        absoluteExpiresAt: new Date(
          new Date(value.absoluteExpiresAt).getTime() + 1_000,
        ).toISOString(),
      }),
    ],
    [
      "idle duration",
      (value: CreatedBrowserSession) => ({
        ...value,
        idleExpiresAt: new Date(new Date(value.idleExpiresAt).getTime() + 1_000).toISOString(),
      }),
    ],
  ] satisfies Array<
    [string, (value: CreatedBrowserSession, input: CreateBrowserSession) => CreatedBrowserSession]
  >)("rejects invalid session-store %s", async (_label, transform) => {
    const value = fixture();
    const { state } = await beginAndState(value);
    value.sessions.transform = transform;

    await expect(
      value.service.complete("https://proofstack.example.test/callback", state),
    ).rejects.toThrow("session store returned invalid metadata");
  });

  it("can use production randomness, identifiers, and default lifetimes", async () => {
    const provider = new Provider();
    const transactions = new Transactions();
    const sessions = new Sessions();
    const cipher = new OidcLoginTransactionCipher(generateOidcTransactionSecret(source(91)));
    const service = new OidcLoginService({
      bindings: { findActiveByIssuerSubject: async () => binding() },
      cipher,
      provider,
      sessions,
      transactions,
    });
    const begun = await service.begin("/");
    const state = new URL(begun.authorizationUrl).searchParams.get("state");
    if (!state) throw new Error("missing generated state");

    await expect(
      service.complete("https://proofstack.example.test/callback", state),
    ).resolves.toMatchObject({ sessionToken: expect.stringMatching(/^pss_v1_/) });
    expect(sessions.createInputs[0]).toMatchObject({
      absoluteLifetimeSeconds: 12 * 60 * 60,
      idleLifetimeSeconds: 30 * 60,
      sessionId: expect.stringMatching(/^ses_[0-9a-f]{32}$/),
    });
  });
});
