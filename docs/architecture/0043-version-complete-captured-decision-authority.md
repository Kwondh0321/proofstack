# ADR-0043: Version complete captured decision authority

Status: Accepted contract and historical transport design. Current acquisition, guarded decision
publication and checkpoint 4 remain open.

Date: 2026-10-16

## Context

The historical 0.1 decision authority material retains original evaluation summaries and public
actor bindings. A future current authority transaction additionally needs exact logical root
observations, original credential state, full original evaluation graphs/pages and every declared
compensating-control occurrence. Reinterpreting existing bytes as that larger claim would lose
the distinction between historical evidence and actual current publication authority.

## Decision

Introduce material version 0.2 with separate v2 material/header/page digest domains. Retain the
strict historical 0.1 material as its `base`, with its original refinements. Keep existing 0.1
schemas, codecs, domains and independent vectors unchanged. Reuse bounded frame/page geometry.

Retain target-owned selection binding and reviewer logical-root/census observations, including
missing, unavailable and invalid states. Bind each unique original publisher/reviewer credential
without substituting a newer login. Repeated physical identities, credentials and reviewer root
bindings must agree on their preimages. An expired original session remains historical data;
whether it invalidates an earlier approval belongs to the current authority resolver.

For each predeclared original request retain either the complete original owning graph, sealed
pages and actor provenance or explicit unavailability. Bind those records to the original
request/job/deciding attempt/header/result and immutable subject authors. The private codec
reuses owning immutable definition checks and original sealed evaluation semantic inspection.
Canonical logical-root projections and summary assurance are recomputed rather than trusted.

Keep every compensating-control occurrence in original approval and numeric index order,
including repeated references and non-supporting/inactive approvals. Retain sanitized content
outcomes plus the later catalog observation. Explicit non-inspection has a reason and no invented
content timestamps. Scope, descriptor and ownership checks still apply to the later catalog.
Successful earlier content does not erase later expiry, tombstones, changes or missingness.

Every retained normalized row/byte contributes to the frozen request's lower bound. This does
not refund discarded, repeated or failed acquisition attempts: the future server-owned composer
must charge all work to one original meter. Keep the aggregate 64 MiB ceiling and existing page,
frame and response headroom limits. No plaintext, key, locator or private authentication proof
is added to transport.

## Boundaries and validation

Parsing and hashing cannot authenticate private credentials, establish complete enumeration or
prove guards are held. Non-root actor facts and actual artifact observations still require owning
source validation. Historical decoding cannot authorize later publication. A future native
composer must establish current migration/epoch, all identity/source/absence guards and private
authentication on the same transaction through atomic graph/decision/outbox publication.

Independent Python UTF-8/hashlib/base64 vectors and adversarial contract/codec cases cover domain
separation, old-byte compatibility, missingness, physical-source conflicts, numeric occurrence
order, native cut precision, quotas, owning digests, original graph bindings, pagination, Unicode
and recalculated outer hashes. Synthetic fixtures are contract evidence, not live authority.
See the [current authority material guide](../development/workflow-2-decision-current-authority-material.md).
