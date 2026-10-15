# Reference policy worker credentials and finite executable

[English](workflow-2-policy-worker-executable.md) | [한국어](workflow-2-policy-worker-executable.ko.md)

Status: implementation prerequisite; Workflow 2 checkpoint 3 remains open (2/7 accepted).

The [native runtime](workflow-2-policy-worker-runtime.md) now has an actual reference executable:

```sh
pnpm install --frozen-lockfile
pnpm exec turbo run build --filter=@proofstack/policy-worker... --concurrency=3
pnpm --filter @proofstack/policy-worker start execute <project-id> <environment-id> <job-id>
```

It consumes one already-enqueued exact job and exits. There is no queue polling, automatic retry,
caller-supplied principal/fence/result, deployment or persistent scheduler. Public enqueue/read/
cancel API and SDK operations remain a separate required slice. Do not create jobs by changing
operating tables to try the executable; native integration tests provision disposable fixtures.

The only command arguments are project, environment and job identifiers. Server authentication
comes from `PROOFSTACK_POLICY_WORKER_SERVICE_TOKEN` and the absolute
`PROOFSTACK_POLICY_WORKER_CREDENTIALS_FILE`. Never put the raw token in argv, source, URLs, output
or delivery. Use `generateServiceToken` and `hashServiceTokenSecret` from the workspace identity
package for operator-side issuance. Store only its canonical prefix and bounded scrypt-v1 hash in
the credential catalogue; keep the raw value in a private execution channel. This adds no API-key
issuance/delegation route and does not broaden existing workload capabilities.

The strict catalogue is `{schemaVersion:"0.1", revision, credentials}` with at most 64 records and
64 KiB UTF-8 JSON. Each record has `kind:"service_token"`, opaque `credentialId`, canonical 16-byte
`prefix`, `passwordHash`, `principalId`, `tenantId`, mandatory `policy:evaluation:execute` and
`artifact:read`, optional explicit `artifact:read:restricted`, restricted `resourceScope` with explicit projects and environments,
`status:"active"|"revoked"`, and millisecond UTC `notBefore`/`expiresAt` with positive validity.
Prefix and credential IDs must be unique. Unsupported hash parameters, noncanonical encoding,
unknown fields, implicit broad scope and malformed records invalidate the whole catalogue.
Grants are unique and limited to those three capabilities. Restricted graph artifacts require
the optional grant; its absence remains an authorization failure. It does not grant policy
authoring, workload enqueue authority or access outside the credential's exact scope. Changing
it during secret verification invalidates confirmation of the original authority.

`FilePolicyWorkerCredentials` reads actual installed state before verification and rereads it
after asynchronous secret verification. Confirmation binds the exact original identity, hash,
grants and validity interval; expiry is exclusive and not-before inclusive. Atomic replacement
can revoke/rotate records. Unrelated rotation need not invalidate an unchanged credential.
Errors, corruption, removal or changes during verification cannot authenticate. Revocation blocks
new authentication; it does not cancel an already-authenticated native lease. Active work remains
bounded by database lease/fence/deadline and explicit control cancellation.

This POSIX reference reader requires an absolute regular file owned by the running UID, one hard
link and no group/other permissions (use mode `0600` in an operator-owned private directory).
No-follow/nonblocking open rejects symlinks and nonregular files. Reads use fixed byte ceilings,
complete EOF, fatal UTF-8 decoding and before/after inode/ownership/mode/size/nanosecond metadata
checks. Every descriptor closes; original and cleanup errors are preserved. Required protections
being unavailable fails closed. These checks do not establish same-user process isolation, a
production secret store, filesystem availability or Windows support.

Runtime settings are read only after actual token/scope authorization:

| Setting | Reference requirement |
| --- | --- |
| `PROOFSTACK_ENV` | `development` or `test`; production local-key composition is refused |
| `PROOFSTACK_POLICY_WORKER_DATABASE_URL` | Dedicated worker connection; TLS except explicitly allowed loopback |
| `PROOFSTACK_POLICY_WORKER_DATABASE_ROLE` | Optional explicit installed role; otherwise `policyEvaluator` default |
| `PROOFSTACK_POLICY_WORKER_S3_BUCKET`, `PROOFSTACK_POLICY_WORKER_S3_REGION` | Required installed bucket and region |
| `PROOFSTACK_POLICY_WORKER_S3_ACCESS_KEY_ID`, `PROOFSTACK_POLICY_WORKER_S3_SECRET_ACCESS_KEY` | Explicit isolated credentials; no ambient credential fallback |
| `PROOFSTACK_POLICY_WORKER_S3_ENDPOINT` | Optional installed endpoint; plaintext only for loopback |
| `PROOFSTACK_POLICY_WORKER_S3_FORCE_PATH_STYLE` | Exactly `true` or `false`, default `false` |
| `PROOFSTACK_POLICY_WORKER_S3_EXPECTED_BUCKET_OWNER` | Optional installed owner |
| `PROOFSTACK_POLICY_WORKER_KEYRING_ACTIVE_KEY_ID`, `PROOFSTACK_POLICY_WORKER_KEYRING_KEYS` | Explicit local reference key ID and bounded JSON map of canonical 32-byte base64url keys |
| `PROOFSTACK_POLICY_WORKER_AUTHORITIES_FILE` | Optional private scoped candidate reference configuration; see the [authority guide](workflow-2-policy-worker-authorities.md) |
| `PROOFSTACK_POLICY_WORKER_CATALOGUES_FILE` | Optional owner-protected strict installed metadata catalogue, at most 16 MiB |

The catalogue file permits only `installationBindings`, `runtimeDefinitions`,
`implementationRegistrations`, `qualificationPolicies`, `endpointProfiles` and
`protocolDefinitions`. Owning static/native constructors still validate their records. Missing
installed authorities remain unavailable; they never become fabricated provider authority.
The keyring retains its existing eight-key/unique-material checks. Temporary decoded key buffers
are cleared after the keyring copies them; no process-memory erasure or production KMS is claimed.

The command prints one compact JSON operational receipt: exact scope/job, disposition/status,
snapshot/result references and separate counts for `satisfied`, `violated`, `indeterminate` and
`not_applicable` when a result exists. Exit `0` means operational completion, including a stored
indeterminate/violated result; it is never approval or release permission. Deferred or other
terminal observations return `2`, command errors `1`, usage errors `64`. Errors print a fixed
message without causes, credentials, keys, object locators or private configuration contents.

Unit cases exercise real private files, partial reads, permission/owner/link/type/size/encoding
failures, concurrent changes, descriptor cleanup, expiry/rotation/revocation during verification,
actual secret verification, authorization before runtime creation, finite command states and
bounded/redacted output. Thin argv/exit glue is checked through the real process tests rather
than unit coverage; business modules retain their existing 100% thresholds. Native tests use
actual PostgreSQL roles and encrypted S3 objects, run the built command in separate processes,
independently read original pages/results and prove restart preserves receipts/fees. Wrong tokens
and insecure credential files do not mutate job state. These are synthetic reference fixtures,
not live identity/provider or production-key evidence.

The [actual process-death and cancellation barriers](workflow-2-policy-worker-process-barriers.md)
now exercise pre-seal death, post-seal restart and cancellation during real object I/O.
[All-state native recovery](workflow-2-policy-job-recovery.md) has separate restore evidence.
Public API/OpenAPI/SDK, the complete retained contributor graph with every predicate/outcome and independent
exit audit remain required before checkpoint 3 acceptance. Later release decisions/approvals,
attestations, CI adapters and measured operations have their own entry/exit gates. This executable
does not complete those gates or create an automatic development goal.
