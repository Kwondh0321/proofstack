import {
  BrowserLoginQuerySchema,
  BrowserLogoutResponseSchema,
  BrowserSessionResponseSchema,
  OidcCallbackQuerySchema,
  TimestampSchema,
} from "@proofstack/contracts";
import {
  type AuthenticatedBrowserSession,
  InvalidOidcLoginError,
  OidcIdentityDataIntegrityError,
  type OidcLoginService,
  type OidcSessionLifecycle,
} from "@proofstack/identity";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { BROWSER_CSRF_COOKIE, BROWSER_SESSION_COOKIE, readSingleCookie } from "./auth.js";

export const OIDC_INTERACTION_COOKIE = "__Host-proofstack_oidc";

export type OidcLoginFlow = Pick<OidcLoginService, "begin" | "complete">;
export type BrowserSessionLifecycle = Pick<OidcSessionLifecycle, "revoke">;

export interface BrowserSessionRequestVerifier {
  authenticateSession(request: FastifyRequest): Promise<AuthenticatedBrowserSession>;
}

export interface OidcRouteDependencies {
  readonly browserSessions: BrowserSessionRequestVerifier;
  readonly login: OidcLoginFlow;
  readonly redirectUri: string;
  readonly sessionLifecycle: BrowserSessionLifecycle;
}

function noStore(reply: FastifyReply): FastifyReply {
  return reply
    .header("cache-control", "no-store")
    .header("pragma", "no-cache")
    .header("referrer-policy", "no-referrer");
}

function cookieExpiration(value: string): string {
  const parsed = TimestampSchema.safeParse(value);
  if (!parsed.success) {
    throw new OidcIdentityDataIntegrityError("OIDC flow returned an invalid expiration time", {
      cause: parsed.error,
    });
  }
  return new Date(parsed.data).toUTCString();
}

function persistentCookie(
  name: string,
  value: string,
  expiresAt: string,
  httpOnly: boolean,
): string {
  return `${name}=${value}; Path=/; Expires=${cookieExpiration(expiresAt)}; Secure;${
    httpOnly ? " HttpOnly;" : ""
  } SameSite=Lax`;
}

function expiredCookie(name: string, httpOnly: boolean): string {
  return `${name}=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; Secure;${
    httpOnly ? " HttpOnly;" : ""
  } SameSite=Lax`;
}

function callbackUrl(requestUrl: string | undefined, redirectUri: string): string {
  const result = new URL(redirectUri);
  const queryStart = requestUrl?.indexOf("?") ?? -1;
  if (queryStart >= 0) result.search = requestUrl?.slice(queryStart) ?? "";
  return result.href;
}

export async function registerOidcRoutes(
  app: FastifyInstance,
  dependencies: OidcRouteDependencies,
): Promise<void> {
  app.get(
    "/v1/auth/oidc/login",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request, reply) => {
      noStore(reply);
      const query = BrowserLoginQuerySchema.parse(request.query);
      const begun = await dependencies.login.begin(query.returnTo);
      return noStore(reply)
        .header(
          "set-cookie",
          persistentCookie(OIDC_INTERACTION_COOKIE, begun.interactionToken, begun.expiresAt, true),
        )
        .status(302)
        .header("location", begun.authorizationUrl)
        .send();
    },
  );

  app.get(
    "/v1/auth/oidc/callback",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      noStore(reply);
      const query = OidcCallbackQuerySchema.parse(request.query);
      const interactionToken = readSingleCookie(request.headers.cookie, OIDC_INTERACTION_COOKIE);
      if (interactionToken !== query.state) {
        reply.header("set-cookie", expiredCookie(OIDC_INTERACTION_COOKIE, true));
        throw new InvalidOidcLoginError();
      }

      try {
        const completed = await dependencies.login.complete(
          callbackUrl(request.raw.url, dependencies.redirectUri),
          query.state,
        );
        return noStore(reply)
          .header("set-cookie", [
            persistentCookie(
              BROWSER_SESSION_COOKIE,
              completed.sessionToken,
              completed.absoluteExpiresAt,
              true,
            ),
            persistentCookie(
              BROWSER_CSRF_COOKIE,
              completed.csrfToken,
              completed.absoluteExpiresAt,
              false,
            ),
            expiredCookie(OIDC_INTERACTION_COOKIE, true),
          ])
          .status(303)
          .header("location", completed.returnTo)
          .send();
      } catch (error) {
        noStore(reply).header("set-cookie", expiredCookie(OIDC_INTERACTION_COOKIE, true));
        throw error;
      }
    },
  );

  app.get(
    "/v1/auth/session",
    { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } },
    async (request, reply) => {
      noStore(reply);
      const authenticated = await dependencies.browserSessions.authenticateSession(request);
      return noStore(reply).send(
        BrowserSessionResponseSchema.parse({
          principal: authenticated.principal,
          requestId: request.id,
        }),
      );
    },
  );

  app.post(
    "/v1/auth/oidc/logout",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      noStore(reply);
      const authenticated = await dependencies.browserSessions.authenticateSession(request);
      const revoked = await dependencies.sessionLifecycle.revoke(authenticated);
      return noStore(reply)
        .header("set-cookie", [
          expiredCookie(BROWSER_SESSION_COOKIE, true),
          expiredCookie(BROWSER_CSRF_COOKIE, false),
          expiredCookie(OIDC_INTERACTION_COOKIE, true),
        ])
        .send(BrowserLogoutResponseSchema.parse({ requestId: request.id, revoked }));
    },
  );
}
