# Local development

ProofStack has two explicit local profiles. The default in-memory profile is dependency-free and
disposable. The PostgreSQL profile persists evidence across API and database restarts and exercises
the same migrations, row-level tenant isolation, and least-privilege role boundaries used by the
durable adapter.

Both profiles default to development authentication on an explicit loopback listener. The durable
profile can also exercise the experimental workload API-key path. The OIDC browser backend is
implemented, but exercising it requires a configured provider and an HTTPS endpoint in front of the
API; the repository does not yet ship that TLS proxy as a production deployment artifact.

## Requirements

- Node.js 24 or newer. `.nvmrc` records the CI baseline.
- pnpm 11.24.0, matching the root `package.json`.
- Docker with Compose v2 only when using the PostgreSQL profile.
- macOS or Linux for the optional POSIX shell-loading examples. Application commands are otherwise
  platform-independent.

## Install and verify

```bash
pnpm install --frozen-lockfile
pnpm check
```

The lockfile must not change during installation. pnpm also enforces a minimum package release age
and an explicit native-build allowlist.

## Profile A: disposable memory

Run the API and console without creating an environment file:

```bash
pnpm dev
```

The default endpoints are:

- API: <http://127.0.0.1:4318>
- OpenAPI contract: <http://127.0.0.1:4318/openapi.json>
- Console: <http://127.0.0.1:3000>

Evidence exists only in API process memory in this profile. Restarting the API intentionally clears
all traces.

## Profile B: durable PostgreSQL

The committed Compose definition pins PostgreSQL 16.15 by image digest, initializes checksums with a
deterministic locale and UTC timezone, publishes only to loopback, and stores database files in a
named volume. The credentials in the example are intentionally local-only.

Prepare and load the durable profile before starting Compose so an optional port override applies
to both Docker and the application URLs:

```bash
cp config/postgres.env.example .env
set -a
. ./.env
set +a
pnpm dev:db:up
```

Apply every immutable migration with the administrative URL, then create the isolated runtime
roles. Provisioning is idempotent and rotates passwords for roles it previously marked as managed.
It refuses to adopt an unrelated existing PostgreSQL role.

```bash
pnpm db:migrate
pnpm db:provision
pnpm db:status
pnpm dev
```

The evidence API connects as `proofstack_api`, not as the database administrator. The separately
provisioned `proofstack_identity` role can execute only the fixed credential lifecycle functions;
it cannot read identity base tables or evidence. The API verifies the complete migration ledger at
startup and readiness checks. Stop the local database without deleting evidence with:

```bash
pnpm dev:db:down
```

Starting it again with `pnpm dev:db:up` reuses the named volume. Re-running migrations and
provisioning is safe and reports the already-current or updated state.

### Exercise workload API-key authentication

Bootstrap is an explicit administrative operation; the API never creates a first owner or key from
an unauthenticated request. Set the required values in the current shell, using the narrowest useful
capabilities and resource scope, then run the one-time command:

```bash
export PROOFSTACK_IDENTITY_TENANT_ID=ten_local
export PROOFSTACK_BOOTSTRAP_ACTOR_PRINCIPAL_ID=usr_local_operator
export PROOFSTACK_BOOTSTRAP_KEY_NAME=local-agent
export PROOFSTACK_BOOTSTRAP_KEY_CAPABILITIES=evidence:ingest,evidence:read
export PROOFSTACK_BOOTSTRAP_KEY_RESOURCE_SCOPE='{"mode":"tenant"}'
pnpm db:identity:bootstrap
```

The JSON response contains `value` exactly once. Copy that complete value immediately into an
untracked secret store; it cannot be recovered from PostgreSQL. Do not commit it, paste it into an
issue, or pass it in a URL. Remove the temporary bootstrap variables from the shell afterward.

To start the API in workload-key mode, set `PROOFSTACK_AUTH_MODE=api_key`. The committed PostgreSQL
profile already contains the distinct least-privilege `PROOFSTACK_IDENTITY_DATABASE_URL`. Set
`PROOFSTACK_API_KEY` only for the example process, then run:

```bash
export PROOFSTACK_AUTH_MODE=api_key
export PROOFSTACK_API_KEY='<complete value returned once by the bootstrap command>'
pnpm dev:api
```

From a second shell with the same `PROOFSTACK_API_KEY`, `pnpm example:basic-agent` sends authenticated
evidence. The server reads only the `Authorization: Bearer` header; query parameters, URLs, and
cookies are never API-key transports. `pnpm db:identity:status` reports aggregate active, expired,
revoked, and total counts for `PROOFSTACK_IDENTITY_TENANT_ID` without returning prefixes, hashes, or
secret material. The browser console never accepts workload secrets. Its sign-in UI is not yet
connected to the OIDC backend, so use the documented browser endpoints directly when validating an
OIDC deployment.

### Exercise OIDC browser authentication

OIDC mode requires the durable identity database, an exact HTTPS issuer, and an exact HTTPS callback
registered with the provider. Put an HTTPS reverse proxy in front of the API and forward the fixed
callback path `/v1/auth/oidc/callback`; ProofStack constructs callback validation from the configured
URI and never trusts a request `Host` header. The proxy and certificate are deployment
responsibilities at this checkpoint.

Create a local authorization binding with the migration connection. The issuer and subject must
exactly match the validated ID token. Roles, capabilities, tenant, and resource scope come only from
this ProofStack record, never from an email, group, domain, or tenant claim:

```bash
export PROOFSTACK_IDENTITY_TENANT_ID=ten_local
export PROOFSTACK_BOOTSTRAP_ACTOR_PRINCIPAL_ID=usr_local_operator
export PROOFSTACK_OIDC_BINDING_ID=oidc_local_operator
export PROOFSTACK_OIDC_ISSUER='https://identity.example.test/tenant'
export PROOFSTACK_OIDC_SUBJECT='provider-subject-001'
export PROOFSTACK_OIDC_PRINCIPAL_ID=usr_local_operator
export PROOFSTACK_OIDC_ROLES=owner
export PROOFSTACK_OIDC_CAPABILITIES=project:read,project:manage,evidence:read,identity:read,identity:manage
export PROOFSTACK_OIDC_RESOURCE_SCOPE='{"mode":"tenant"}'
pnpm db:oidc:create
```

Generate a new transaction key into an untracked secret store, then configure and start the API. Do
not reuse this example command's output across installations or commit it:

```bash
export PROOFSTACK_OIDC_TRANSACTION_SECRET="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))')"
export PROOFSTACK_AUTH_MODE=combined
export PROOFSTACK_CORS_ORIGIN='https://console.example.test'
export PROOFSTACK_OIDC_CLIENT_ID='proofstack-console'
export PROOFSTACK_OIDC_CLIENT_SECRET='<provider client secret>'
export PROOFSTACK_OIDC_ISSUER='https://identity.example.test/tenant'
export PROOFSTACK_OIDC_REDIRECT_URI='https://proofstack.example.test/v1/auth/oidc/callback'
export PROOFSTACK_OIDC_SCOPES='openid profile email'
pnpm dev:api
```

Open `/v1/auth/oidc/login?returnTo=/` through the public HTTPS API endpoint. ProofStack uses
Authorization Code + PKCE S256, nonce, one-time state, and a short-lived browser-bound interaction
cookie. A successful callback creates a random server-side session and redirects only to the local
path stored in the encrypted transaction. `GET /v1/auth/session` returns current authorization.
Cookie-authenticated state changes, including `POST /v1/auth/oidc/logout`, require the exact allowed
`Origin`, an `X-ProofStack-CSRF` header, and the matching readable `__Host-proofstack_csrf` cookie.

To change authorization without changing provider identity, set the binding, actor, tenant, roles,
capabilities, and scope variables and run `pnpm db:oidc:update`. To terminate future logins and make
existing sessions fail their authoritative binding check, set a bounded reason and run:

```bash
export PROOFSTACK_OIDC_DISABLE_REASON='access removed'
pnpm db:oidc:disable
```

## Verify the running system

From another terminal, load the same profile if you created one, then check liveness, readiness, and
send a real SDK trace:

```bash
set -a
test ! -f .env || . ./.env
set +a
curl --fail-with-body http://127.0.0.1:4318/health/live
curl --fail-with-body http://127.0.0.1:4318/health/ready
pnpm example:basic-agent
```

The example sends an `agent.run` event and its child `tool.execute` event, waits for delivery, and
prints the generated trace ID and console URL. It uses fail-closed delivery so an unavailable API
cannot produce a false successful demonstration.

## Configuration reference

| Variable | Default | Owner | Purpose |
| --- | --- | --- | --- |
| `PROOFSTACK_ENV` | `development` | API/database CLI | Runtime safety mode |
| `PROOFSTACK_AUTH_MODE` | `development` | API | `development`, `api_key`, `oidc`, or `combined` |
| `PROOFSTACK_HOST` | `127.0.0.1` | API | Listen address; development auth requires explicit loopback |
| `PROOFSTACK_PORT` | `4318` | API | Listen port |
| `PROOFSTACK_LOG_LEVEL` | `info` | API | Structured log level |
| `PROOFSTACK_CORS_ORIGIN` | unset | API | Exact allowed browser origin when cross-origin access is needed |
| `PROOFSTACK_STORAGE_MODE` | `memory` | API | `memory` or `postgres` evidence adapter |
| `PROOFSTACK_DATABASE_URL` | unset | API | Least-privilege runtime database URL in PostgreSQL mode |
| `PROOFSTACK_IDENTITY_DATABASE_URL` | unset | API | Distinct least-privilege identity URL required outside development auth |
| `PROOFSTACK_OIDC_CLIENT_ID` | unset | API | Provider client identifier required by OIDC modes |
| `PROOFSTACK_OIDC_CLIENT_SECRET` | unset | API | Provider client secret required by OIDC modes |
| `PROOFSTACK_OIDC_ISSUER` | unset | API/identity CLI | Exact HTTPS issuer; also selects the binding during create |
| `PROOFSTACK_OIDC_REDIRECT_URI` | unset | API | Exact registered HTTPS callback without query or fragment |
| `PROOFSTACK_OIDC_SCOPES` | `openid profile email` | API | Unique printable scopes including `openid` |
| `PROOFSTACK_OIDC_TRANSACTION_SECRET` | unset | API | Canonical base64url encoding of a dedicated random 32-byte key |
| `PROOFSTACK_OIDC_BINDING_ID` | unset | identity CLI | Opaque binding identifier for create, update, or disable |
| `PROOFSTACK_OIDC_SUBJECT` | unset | identity CLI | Exact provider subject used only during binding create |
| `PROOFSTACK_OIDC_PRINCIPAL_ID` | unset | identity CLI | Stable ProofStack user principal used during binding create |
| `PROOFSTACK_OIDC_ROLES` | unset | identity CLI | Unique comma-separated authorization roles |
| `PROOFSTACK_OIDC_CAPABILITIES` | unset | identity CLI | Unique comma-separated authorization capabilities; may be empty on update |
| `PROOFSTACK_OIDC_RESOURCE_SCOPE` | unset | identity CLI | Strict JSON tenant or restricted project/environment scope |
| `PROOFSTACK_OIDC_DISABLE_REASON` | unset | identity CLI | Bounded audited reason required to disable a binding |
| `PROOFSTACK_MIGRATION_DATABASE_URL` | unset | database CLI | Administrative migration and provisioning URL |
| `PROOFSTACK_API_DATABASE_ROLE` | `proofstack_api` | database CLI | Managed API role name |
| `PROOFSTACK_IDENTITY_DATABASE_ROLE` | `proofstack_identity` | database CLI | Managed identity role name |
| `PROOFSTACK_PUBLISHER_DATABASE_ROLE` | `proofstack_publisher` | database CLI | Managed outbox publisher role name |
| `PROOFSTACK_CONSUMER_DATABASE_ROLE` | `proofstack_consumer` | database CLI | Managed consumer role name |
| `PROOFSTACK_API_DATABASE_PASSWORD` | unset | database CLI | API role password used only during provisioning |
| `PROOFSTACK_IDENTITY_DATABASE_PASSWORD` | unset | database CLI | Identity role password used only during provisioning |
| `PROOFSTACK_PUBLISHER_DATABASE_PASSWORD` | unset | database CLI | Publisher role password used only during provisioning |
| `PROOFSTACK_CONSUMER_DATABASE_PASSWORD` | unset | database CLI | Consumer role password used only during provisioning |
| `PROOFSTACK_IDENTITY_TENANT_ID` | unset | identity CLI | Explicit tenant for bootstrap and aggregate status |
| `PROOFSTACK_BOOTSTRAP_ACTOR_PRINCIPAL_ID` | unset | identity CLI | Audited local operator identifier for bootstrap |
| `PROOFSTACK_BOOTSTRAP_KEY_NAME` | unset | identity CLI | Printable display name for the initial workload key |
| `PROOFSTACK_BOOTSTRAP_KEY_CAPABILITIES` | unset | identity CLI | Unique comma-separated delegable capabilities |
| `PROOFSTACK_BOOTSTRAP_KEY_RESOURCE_SCOPE` | unset | identity CLI | Strict JSON tenant or restricted project/environment scope |
| `PROOFSTACK_BOOTSTRAP_KEY_EXPIRES_AT` | 90 days | identity CLI | Optional ISO 8601 expiry, bounded to 1 minute–365 days |
| `PROOFSTACK_POSTGRES_PORT` | `5432` | Compose | Loopback host port for the local database |
| `PROOFSTACK_API_URL` | `http://127.0.0.1:4318` | Web/example | API base URL |
| `PROOFSTACK_API_KEY` | unset | SDK example | Complete one-time-issued key; never used by the API server or browser console |
| `PROOFSTACK_PROJECT_ID` | `prj_local` | Web/example | Local project scope |
| `PROOFSTACK_ENVIRONMENT_ID` | `env_local` | Web/example | Local environment scope |

If `PROOFSTACK_POSTGRES_PORT` changes, update every database URL in `.env` to the same port. When
rotating a runtime password, update its runtime URL and matching provisioning variable, then run
`pnpm db:provision` before restarting the API. Never commit `.env`, a bootstrap response, or a
complete API key, and never place production credentials in an example file.

## Reset and troubleshooting

Use `pnpm db:status` to distinguish missing or pending migrations from an API problem. The command
returns nonzero until the bundled migration ledger is current. A PostgreSQL readiness failure is
intentional when the database is unavailable or its migration history is incomplete or corrupted.

If port 5432 is occupied, change `PROOFSTACK_POSTGRES_PORT` and both database URLs in `.env`, then
start Compose again. If development authentication starts in production or on a non-loopback
listener, report it as a security issue; both configurations must cause immediate startup refusal.

For a routine stop, use `pnpm dev:db:down`; it preserves the named volume. The following command is
destructive and permanently deletes all local ProofStack PostgreSQL evidence:

```bash
docker compose down --volumes
```

After destructive reset, repeat `pnpm dev:db:up`, `pnpm db:migrate`, and `pnpm db:provision` before
starting the API.
