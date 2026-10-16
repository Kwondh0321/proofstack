# ADR-0053: Persist complete target-owned policy selections

Status: Accepted storage design. Actual installation authorization, native decision publication
and checkpoint 4 remain open.

Date: 2026-10-16

## Context

The memory/shared selection repository preserves the first target owner and complete version and
terminal history. A native implementation must retain the same contract without choosing a
favorable version, losing submicrosecond receipt order or exposing declarations to existing
evaluation credentials. Persistence of an attributable declaration is not installer authentication.

## Decision

Migration 0065 stores original selection definitions, ordered policy and publisher projections,
the immutable target root and terminal lifecycle separately. Scope-bound foreign keys, canonical
definition bytes/digests, native precision order keys and deferred graph/outbox constraints bind
the whole stored graph. All five tables are append-only with forced exact-scope RLS. Private fixed
storage functions publish the graph and its canonical outbox intent in one transaction. Equal
intent retries retain the original actor/time; conflicts roll back the whole write.

Use a separate coarse tenant selection guard domain. Mandatory insert triggers acquire its
exclusive transaction lock, including absent-root creation and lifecycle insertion. A complete
target read takes the shared nonwaiting guard before its root observation. Its private VOLATILE
function performs READ COMMITTED SPI reads after acquiring that guard. A contended guard fails
the whole cut; do not reuse an earlier outer-statement snapshot or return a partial inventory.
This reference granularity makes no production concurrency or throughput claim.

The owning adapter derives the original root from the installation/gate target and enumerates
every version and terminal event through fixed keyset pages. It re-encodes original canonical
definitions, compares all normalized projections and verifies exact lineage and canonical outbox
intent. The original verification meter admits raw observations, absences, relationship rereads
and pages before deep interpretation. Caught source, connection and transaction failures taint
that same meter. No fresh meter, caller-selected inventory or latest-version fallback is allowed.

Keep lexical full-precision UTC receipt text and exact numeric order keys. JSON transport converts
these keys to strings before JavaScript decoding. Native outbox timestamps are receipt projections,
not the semantic ordering oracle. Existing timestamp and canonical contracts are unchanged.

## Consequences

The adapter implements the unchanged memory/shared port using trusted server-owned records.
No public raw-record route, installer authenticator, dedicated runtime role, default capability
grant or decision publisher is introduced. Existing runtime roles lose access to these private
tables/functions during provisioning, including restored stale grants. The evaluator's broad
policy-read inventory explicitly excludes the new private selection tables.

Provided-client helpers leave their caller's explicit transaction, connection and guards held.
The convenience repository ends its read transaction before returning, so its detached census
is historical observation. A future publisher must retain selection, identity, reviewer and all
other source/absence guards on one connection through current migration/recovery-epoch checks
and atomic decision/outbox publication. Complete authority, separate roles, recovery acceptance,
API/SDK, contributor flow and checkpoint exit audit remain open.

See the [English/Korean native selection guide](../development/workflow-2-native-selection-repository.md)
and [entry requirements](../development/workflow-2-decision-entry-audit.md).
