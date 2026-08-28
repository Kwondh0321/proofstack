# Local development

The foundation workspace is deliberately runnable without databases, cloud accounts, model API
keys, or seeded placeholder data. The API uses a process-local repository and a server-owned local
identity so the implemented ingestion path can be exercised before production adapters exist.

## Requirements

- Node.js 24 or newer. `.nvmrc` records the CI baseline.
- pnpm 11.24.0, matching the `packageManager` field in the root `package.json`.
- macOS or Linux for the optional `.env` shell-loading example below. The application commands are
  otherwise platform-independent.

## Install and verify

```bash
pnpm install --frozen-lockfile
pnpm check
```

The lockfile must not change during installation. pnpm also enforces a minimum package release age
and an explicit native-build allowlist.

## Run the API and console

```bash
pnpm dev
```

The default local endpoints are:

- API: <http://127.0.0.1:4318>
- OpenAPI contract: <http://127.0.0.1:4318/openapi.json>
- Console: <http://127.0.0.1:3000>

Verify process health from another terminal:

```bash
curl --fail-with-body http://127.0.0.1:4318/health/live
curl --fail-with-body http://127.0.0.1:4318/health/ready
```

If the defaults conflict with another local service, export only the variables you need. To load
the complete example file in a POSIX shell:

```bash
cp .env.example .env
set -a
. ./.env
set +a
pnpm dev
```

`.env` is ignored by Git. Never add real credentials to `.env.example`.

## Send a verified SDK trace

With the API running, build the workspace and run the example:

```bash
pnpm example:basic-agent
```

The command sends an `agent.run` event and its child `tool.execute` event, waits for delivery, and
prints the generated trace ID. Open the printed console URL to inspect the causal relationship. The
example uses fail-closed delivery so an unavailable API exits unsuccessfully instead of pretending
the demonstration worked.

## Configuration reference

| Variable | Default | Owner | Purpose |
| --- | --- | --- | --- |
| `PROOFSTACK_ENV` | `development` | API | Runtime safety mode: `development`, `test`, or `production` |
| `PROOFSTACK_AUTH_MODE` | `development` | API | Identity adapter; non-development modes currently refuse startup |
| `PROOFSTACK_HOST` | `127.0.0.1` | API | Listen address |
| `PROOFSTACK_PORT` | `4318` | API | Listen port |
| `PROOFSTACK_LOG_LEVEL` | `info` | API | Structured log level |
| `PROOFSTACK_CORS_ORIGIN` | unset | API | Exact allowed browser origin when cross-origin access is needed |
| `PROOFSTACK_API_URL` | `http://127.0.0.1:4318` | Web/example | API base URL |
| `PROOFSTACK_PROJECT_ID` | `prj_local` | Web/example | Local project scope |
| `PROOFSTACK_ENVIRONMENT_ID` | `env_local` | Web/example | Local environment scope |

## Reset and troubleshooting

Evidence is stored only in API process memory. Restarting the API intentionally resets all traces.
This is a current limitation, not a persistence bug.

```bash
pnpm clean
pnpm install --frozen-lockfile
pnpm check
```

If a production configuration starts with development authentication, report it as a security
issue. The intended behavior is an immediate startup refusal.
