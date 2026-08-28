# ADR-0016: Linearize regression version publication at one repository boundary

Status: Accepted
Date: 2026-08-29
Owners: ProofStack maintainers

## Context

ADR-0012 makes regression fixture and dataset versions immutable and requires each publication to
write one durable outbox intent. That requirement spans logical-resource identity, exact version
identity, predecessor lineage, ordered dataset membership, provenance, and an event for downstream
consumers. Implementing those checks as separate repository calls would leave time-of-check to
time-of-use gaps: another publisher could establish a competing root, rebind a version identifier,
or change the authoritative fixture set between validation and persistence.

Lost responses also make retries unavoidable. A retry must distinguish the same semantic
definition from a conflicting reuse without trusting a caller-supplied digest or replacing the
provenance recorded by the successful publication. At the same time, read and conflict behavior
must not reveal whether an identifier exists outside the authenticated tenant, project, and
environment.

## Decision

### Make one repository operation the publication authority

The datasets domain exposes one repository boundary for publishing fixture versions and one for
publishing dataset versions. Each operation validates and persists the complete change as one
linearizable unit. PostgreSQL implements the unit with one tenant-scoped transaction. An in-memory
adapter prepares a detached next state and replaces the tenant state once, with no asynchronous or
potentially throwing work after that replacement.

A successful new fixture publication atomically creates or verifies the logical fixture binding,
stores the immutable version, and inserts exactly one canonical outbox intent. A successful new
dataset publication additionally stores its ordered membership. A failed invariant, conflict, or
outbox write leaves none of those records behind.

The repository revalidates every invariant even when a use case performed an earlier check. Use
case checks improve error timing and avoid expensive capture work; they are not the concurrency
boundary.

### Bind identifiers tenant-wide and hide other scopes

Logical fixture IDs, fixture version IDs, logical dataset IDs, and dataset version IDs are unique
within a tenant. The first root version binds its logical resource to one exact project and
environment. Reusing that logical or version identifier through another project or environment is
a conflict, not a new resource. Different tenants may use the same opaque identifiers.

Read methods accept the complete authenticated scope and fail closed with `null` or `false` for
records outside that exact scope. Public not-found, lineage, and conflict errors remain generic and
identifier-free. Authorization occurs before any repository lookup.

### Define root, predecessor, and retry behavior exactly

A version without a predecessor may be published only when its logical resource has no root. A
version with a predecessor must reference an exact authoritative version of the same tenant,
scope, and logical resource, including its stored definition digest. Multiple children may share a
valid predecessor; publication does not create a mutable `latest` pointer and does not require a
predecessor to be a leaf.

The target version identifier is checked before creating new source evidence or resolving dataset
members. When it already exists, the repository validates both stored and requested values,
projects their semantic definitions explicitly, and compares the fixed ADR-0015 canonical bytes.
It never treats matching digest strings alone as proof of equality. Equivalent semantics return
the originally stored version and provenance with `created: false`; different semantics return a
generic conflict and write no event.

### Resolve and revalidate dataset membership authoritatively

Batch fixture resolution is all-or-nothing and preserves the caller's order. It returns the stored
digest for every exact fixture version rather than accepting a caller assertion. Dataset
publication revalidates those references inside its linearization boundary, closing the gap
between resolution and persistence. It never sorts, deduplicates, partially resolves, or silently
substitutes membership.

### Emit a small canonical locator intent

The atomic outbox record identifies the exact version without embedding its potentially large
event or membership sequence. Fixture publication uses:

- aggregate type `regression.fixture-version`;
- event type `regression.fixture-version.published`; and
- a payload containing `projectId`, `environmentId`, `fixtureId`, `fixtureVersionId`, and
  `definitionSha256`.

Dataset publication uses the corresponding `regression.dataset-version` identifiers and dataset
fields. Both use outbox schema version `0.1`, keep `tenantId` at the intent envelope, use the
version's original `createdAt`, and require consumers to perform an authorized exact-version read.
Regression publication time is the server-owned canonical UTC millisecond representation
`YYYY-MM-DDTHH:mm:ss.sssZ`, so PostgreSQL storage and outbox delivery preserve that original string
exactly. Source evidence capture time remains a separately preserved PostgreSQL-compatible instant.
An equivalent retry writes no additional intent.

## Consequences

### Positive

- Publication has one enforceable race and rollback boundary across every durable effect.
- Timed-out retries preserve original authorship and time without allowing semantic drift.
- Tenant-wide binding prevents scope hopping while scope-safe reads avoid existence leakage.
- Dataset order and authoritative fixture digests cannot change between validation and storage.
- Small outbox payloads remain within the shared JSON envelope limits at maximum fixture and
  dataset sizes.

### Negative

- Every durable adapter must implement the complete transaction rather than composing simpler
  writes.
- PostgreSQL publication requires explicit locking and conflict translation under concurrency.
- Consumers need one exact read to obtain a full version after receiving a publication event.
- The in-memory adapter's synchronous linearization assumption must be replaced by a tenant mutex
  if asynchronous hooks are introduced.

### Follow-up

- Run one shared conformance suite against memory and PostgreSQL adapters, including concurrent
  roots, conflicting versions, sibling branches, defensive copies, and fault-injected rollback.
- Exercise fixture and dataset state plus outbox records in coordinated recovery rehearsals.
- Keep HTTP and SDK operations exact-version-only and map scope-safe repository outcomes without
  leaking identifiers.

## Alternatives considered

### Validate in a use case and persist through independent repository calls

Rejected because competing publishers could invalidate identity, lineage, or membership checks
between calls, and an outbox failure could leave an unpublished durable version.

### Treat matching digest strings as an idempotent retry

Rejected because stored or caller-supplied digests can be malformed, forged, or inconsistent with
the definition. Both sides must be validated and canonical semantic bytes compared.

### Scope identifiers by tenant, project, and environment

Rejected because the same tenant could rebind one opaque logical or version identifier by moving
it through another scope, making external references ambiguous.

### Put the complete version in the outbox payload

Rejected because fixtures can contain 1,000 event identifiers and datasets can contain 500
members, exceeding the deliberately bounded shared JSON event shape and duplicating authoritative
state.

### Require a unique successor or mutable latest version

Rejected because experimental branches are legitimate and every replay, evaluation, export, and
release reference must remain exact and immutable.

## Revisit when

- publication spans more than one authoritative database;
- asynchronous validation or hooks enter the in-memory transaction path;
- consumers require a signed portable event rather than an exact authoritative read; or
- measured exact-read load justifies a new bounded event schema with an explicit compatibility
  plan.
