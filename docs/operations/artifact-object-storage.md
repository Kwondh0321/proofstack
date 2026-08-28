# Artifact object-storage operations

Status: pre-production reference

Last reviewed: 2026-08-28

This document defines the deployment contract for encrypted artifact objects. It does not make
ProofStack production-ready: coordinated backup and restore, an external key provider, deployed
maintenance scheduling, and production topology remain open Foundation 2 gates.

## Ownership boundary

PostgreSQL is authoritative for tenant scope, protected metadata, lifecycle state, tombstones, and
purge receipts. The object store contains only envelope-encrypted bytes at service-generated exact
keys. It is neither an authorization database nor a discovery API.

The runtime adapter deliberately supports only three object operations:

- `PutObject` with `If-None-Match: *` for immutable creation;
- bounded `GetObject` with SHA-256 verification;
- `DeleteObject` with `If-Match: *` for existence-checked deletion.

It does not list buckets or keys, accept caller-provided URLs, overwrite objects, copy objects, or
issue presigned content access. The current direct path does not use multipart upload.

## Required provider semantics

An S3-compatible provider is supported only when all of these properties hold for the selected
service version and deployment mode:

1. Conditional creation and deletion are atomic for one exact key under concurrency.
2. `If-None-Match: *` refuses an existing current object with a precondition failure.
3. `If-Match: *` refuses a missing current object with a not-found or precondition failure.
4. A successful non-versioned delete removes the current bytes instead of creating a delete
   marker.
5. A successful write is immediately readable through the same key, including from a new client.
6. `GetObject` supports an inclusive byte range and returns a trustworthy bounded content length.
7. The provider accepts a SHA-256 request checksum. ProofStack recomputes the digest on every read
   even when the provider does not return a checksum header.
8. Signature Version 4, path-style addressing when configured, and the selected endpoint behavior
   match the AWS SDK client.

The dedicated integration job exercises the shared immutable object-store contract against
SeaweedFS 4.44. Both the container tag and multi-platform image digest are pinned in
[Compose](../../compose.yaml) and [CI](../../.github/workflows/ci.yml). The test covers exact-byte
receipts, defensive copies, retry idempotence, overwrite refusal, exact-key isolation, concurrent
creation, deletion idempotence, intentional key reuse after deletion, and a fresh adapter client.

Passing that job establishes compatibility with that exact test service. It is not evidence that
an arbitrary provider, proxy, gateway, or later service release preserves the same semantics.

## Bucket invariants

Provision one dedicated bucket per deployment trust zone and enforce the following controls before
any artifact is reserved:

- Keep the bucket private. Block public access, disable ACL-based sharing, and prevent website
  hosting or anonymous policies.
- Never enable bucket versioning. Versioning-enabled and versioning-suspended Amazon S3 buckets can
  retain old ciphertext behind delete markers. Once versioning has ever been enabled, migrate to a
  newly created unversioned bucket before using this adapter.
- Do not enable object lock, legal hold, or provider retention on this bucket. Those controls can
  make an application purge appear successful while bytes remain. A future legal-hold feature must
  extend the catalog and deletion protocol first.
- Do not configure automatic object expiration. ProofStack must create the PostgreSQL tombstone
  before object deletion and append a purge receipt only after the provider confirms success.
- Reserve the `objects/v1/` prefix for ProofStack. Restore, migration, and administrative tooling
  must not write into it while the runtime policy is active.
- Require TLS for every non-loopback endpoint. Plain HTTP is accepted by the client only when an
  operator explicitly enables it for the exact hosts `localhost`, `127.0.0.1`, or `[::1]`.
- On Amazon S3, configure the expected 12-digit bucket-owner account so a mistaken bucket name
  fails closed. Equivalent ownership pinning is deployment-specific on other providers.
- Provider-side encryption may be enabled as defense in depth, but it never replaces ProofStack
  envelope encryption or tenant-aware key separation.
- Treat opaque keys, request metadata, and access logs as sensitive operational data even though
  object bodies are ciphertext. Do not log bodies, credentials, wrapped data keys, or complete
  provider errors.

Bucket versioning is intentionally different from normal S3 durability advice. Artifact deletion
is a privacy and retention operation, not merely a way to hide the latest version. Backup safety
must come from coordinated snapshots or replication with an explicit deletion policy, not from
recoverable live-bucket versions.

## Runtime least privilege

Use a dedicated workload identity for the artifact adapter. It needs only `GetObject`, `PutObject`,
and `DeleteObject` on the artifact prefix. It does not need `ListBucket`, bucket administration,
ACL, policy, replication, version, or object-lock permissions.

An AWS identity-policy baseline is:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ProofStackArtifactObjectAccess",
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:PutObject",
        "s3:DeleteObject"
      ],
      "Resource": "arn:aws:s3:::proofstack-artifacts/objects/v1/*"
    }
  ]
}
```

Replace the example bucket name. Do not add bucket-wide resource patterns for convenience.

Where the provider supports the AWS condition keys, add a bucket policy that denies runtime writes
or deletes which omit the required precondition. This protects immutability even if another code
path obtains the same identity policy:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "DenyUnconditionalArtifactWrites",
      "Effect": "Deny",
      "Principal": "*",
      "Action": "s3:PutObject",
      "Resource": "arn:aws:s3:::proofstack-artifacts/objects/v1/*",
      "Condition": {
        "Null": {
          "s3:if-none-match": "true"
        }
      }
    },
    {
      "Sid": "DenyUnconditionalArtifactDeletes",
      "Effect": "Deny",
      "Principal": "*",
      "Action": "s3:DeleteObject",
      "Resource": "arn:aws:s3:::proofstack-artifacts/objects/v1/*",
      "Condition": {
        "Null": {
          "s3:if-match": "true"
        }
      }
    },
    {
      "Sid": "DenyInsecureArtifactTransport",
      "Effect": "Deny",
      "Principal": "*",
      "Action": "s3:*",
      "Resource": [
        "arn:aws:s3:::proofstack-artifacts",
        "arn:aws:s3:::proofstack-artifacts/*"
      ],
      "Condition": {
        "Bool": {
          "aws:SecureTransport": "false"
        }
      }
    }
  ]
}
```

Conditional-request policy syntax follows the Amazon S3 documentation for
[conditional writes](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes-enforce.html)
and
[conditional deletes](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-delete-enforce.html).
Validate equivalent policies against a non-AWS provider; accepting AWS policy JSON does not prove
that the provider enforces every condition key.

Use a separate short-lived administrative identity for bucket creation, policy changes,
compatibility tests, restore, and migration. Never give those permissions to the API or retention
worker. The global deny statements also block ordinary administrative overwrite and deletion under
the reserved prefix; an exceptional restore must use a new empty bucket or an explicitly audited
temporary policy change.

## Client configuration

Construct `S3ArtifactObjectStore` with configuration from an external secret and deployment
configuration source. The application integration must validate all values before accepting
traffic.

| Setting | Required behavior |
| --- | --- |
| `bucket` | Exact dedicated DNS-style bucket name |
| `region` | Exact signing region expected by the provider |
| `endpoint` | Omit for AWS defaults; otherwise pin one absolute origin without credentials, path, query, or fragment |
| `credentials` | Dedicated runtime identity from a workload or secret provider; never put credentials in an endpoint URL |
| `forcePathStyle` | Enable only when the selected compatible service requires it |
| `expectedBucketOwner` | Set for Amazon S3; omit only when the compatible provider cannot implement it |
| `allowInsecureLoopback` | `true` only for an exact local HTTP test endpoint |
| timeouts | Finite connection, request, and socket limits appropriate to the deployment SLO |

The adapter has bounded retries for conditional conflicts but does not make unbounded availability
promises. Service composition must destroy the client during graceful shutdown.

## One-shot maintenance commands

`pnpm artifacts:maintenance <command>` composes a short-lived, scoped maintenance process. It is
not a continuously running worker and it does not discover tenants, projects, environments, or
objects. An operator must supply exactly one explicit scope through
`PROOFSTACK_ARTIFACT_TENANT_ID`, `PROOFSTACK_ARTIFACT_PROJECT_ID`,
`PROOFSTACK_ARTIFACT_ENVIRONMENT_ID`, and `PROOFSTACK_ARTIFACT_OPERATOR_PRINCIPAL_ID`.

Every command validates that the database migration ledger is current before it reads or mutates
lifecycle data. Its database identity must be the dedicated
`proofstack_artifact_maintenance` role (or an equivalently restricted role), never the migration
or application role. The process creates a restricted service principal for precisely that scope;
it does not accept an operator-supplied broad principal.

| Command | Required inputs beyond scope and database URL | Effect |
| --- | --- | --- |
| `key-status` | Local development/test key inventory | Reports configured and referenced key IDs; a referenced but unconfigured key yields `attention` |
| `reconcile` | S3 settings, abandonment threshold, local development/test key inventory | Authenticates an interrupted upload before atomically activating it; missing objects remain reserved |
| `cleanup-abandoned` | S3 settings and abandonment threshold | Tombstones and purges eligible abandoned reservations |
| `retention` | S3 settings | Tombstones and purges artifacts whose configured retention has elapsed |
| `retry-purges` | S3 settings | Retries object deletion for tombstones with pending purges |

`PROOFSTACK_ARTIFACT_BATCH_LIMIT` is optional and bounded to 1–100. The S3 endpoint, when set,
cannot contain credentials. Plain HTTP is accepted only for a loopback endpoint in development or
test. The command inherits standard AWS SDK workload credentials; do not place access keys in the
command arguments, endpoint, output, or logs.

For `key-status` and `reconcile`, `PROOFSTACK_ARTIFACT_KEYS` is a JSON map of opaque key IDs to
canonical base64url 32-byte values and `PROOFSTACK_ARTIFACT_ACTIVE_KEY_ID` selects one member.
That local keyring is intentionally rejected in production. Production reconciliation and key
status require a future external key-provider composition; this prevents a file or environment
variable full of production key material from being mistaken for a production design.

The command prints one JSON result and exits `0` only for an `ok` result, `2` for actionable
`attention`, `64` for invalid command usage, and `1` for configuration, migration, connection, or
operation failure. Treat a nonzero result as an alerting signal; do not automatically retry it
without preserving the result and determining whether the underlying provider or key condition is
safe to retry.

## Deployment and upgrade gate

Before first use or any provider, proxy, SDK, policy, or service-version change:

1. Verify the bucket is private, has never had versioning enabled, has no lifecycle expiry or object
   lock, and is owned by the expected account.
2. Verify the runtime identity cannot list the bucket, administer it, bypass TLS, or make an
   unconditional write or delete under `objects/v1/`.
3. Run the pinned local integration job from a clean checkout.
4. In an isolated staging bucket, exercise the same conditional create, read, concurrent collision,
   and conditional delete behavior through the intended network path and credentials.
5. Confirm that access logs and metrics redact credentials and do not retain bodies or wrapped key
   material.
6. Rehearse failure between object creation and catalog activation, and between tombstone creation
   and object deletion. The item must converge through upload retry or purge retry without becoming
   readable after tombstoning.
7. Record the provider version, endpoint mode, bucket policy checksum, test evidence, operator, and
   approval in the deployment change.

The committed integration test creates and removes a random `proofstack-test-*` bucket. Its
credentials are compatibility-administrator credentials, not the runtime least-privilege identity.
Never point that test at a production account or endpoint.

## Monitoring and incident handling

Monitor at least these signals once workers are deployed:

- request latency and timeout rate by operation, without object keys;
- provider 5xx and network failures;
- unexpected authorization failures;
- conditional conflicts and precondition failures separated from ordinary failures;
- reserved artifacts older than the cleanup threshold;
- tombstoned artifacts still pending purge;
- purge retry age and failed-artifact count;
- ciphertext capacity and provider durability alarms;
- active and referenced key-encryption-key versions.

A read integrity failure, ownership mismatch, unexpected overwrite, successful unconditional
mutation, or cross-scope object access is a security incident. Stop artifact writes, preserve
catalog and provider audit evidence, rotate exposed credentials, and follow [SECURITY.md](../../SECURITY.md).
Do not delete or rewrite catalog evidence during triage.

## Backup and recovery boundary

Ciphertext alone is not a backup. Recovery requires a mutually consistent set of:

- PostgreSQL catalog, tombstones, and purge receipts;
- encrypted objects;
- every key-encryption-key version still referenced by catalog rows;
- deployment configuration and provider policies.

Backups and replicas may retain ciphertext after a live purge. Their retention, access control,
tenant deletion behavior, and eventual destruction must be explicit. Restoring an older object
without the matching catalog state and keys is forbidden, as is restoring purged content into the
live prefix without an audited lifecycle decision.

ProofStack has not yet accepted a coordinated backup-and-restore procedure. Until roadmap item 7
passes, this document is a deployment contract and review checklist rather than a production
recovery claim.
