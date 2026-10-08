# Owning dataset and fixture storage integrity

Singular dataset, evidence-only fixture and recorded fixture readers now verify retained logical
resources, original publication intents and exact logical roots on the supplied PostgreSQL
connection. Ordinary repository reads use the same helpers. Workflow 2 remains **2/7 accepted
checkpoints**; checkpoint 3 remains open.
[Korean guide](workflow-2-regression-storage-integrity.ko.md).

## Retained records and roots

Existing strict reconstruction checks preserve exact identity/scope/digest/schema, native receipt
witnesses, original lexical timestamps, ordered events/members, recorded manifests and ownership.
The logical resource must match the selected record's scope and stored root identity/digest.
Every selected version requires its original complete canonical publication intent.

A distinct root is loaded in exact normalized scope before canonical parsing. Its complete body,
ordered children, native receipt and original intent must remain valid, and its resource/digest
must match the selected record. The deployed regression grammar requires predecessor-free roots;
fixture roots are evidence-only. Recorded promotions retain that evidence-only root. This differs
from evaluation/comparison resources that permit independent versions without predecessors.
The reader does not choose a latest version or establish first-publication chronology.

These checks do not independently derive every predecessor/member's complete semantic or current
authority closure. Private publication conflict/lineage and retained-retry validation remain their
existing paths; this slice does not newly claim complete root validation during every mutation.
The policy acquisition layer still needs complete request-owned semantic and authority observations.

## Presence and connection boundaries

One fixed statement observes exact scoped header and owned normalized metadata presence at one
database cut. Dataset witnesses are members and logical roots. Fixture witnesses are events,
logical roots, recorded manifests, artifact ownership and content revocation. Native booleans
must agree; witnesses without a body and malformed responses fail. Present bodies that disappear
before reconstruction also fail. A normal atomic publication after an absent cut preserves that
observed absence. Outside-scope data remains opaque.

Both fixture formats share one header. A healthy other format remains typed absence rather than
an orphan error. Recorded content reads retain their revocation/tombstone/catalog checks and add
the same logical-root validation; they return metadata and do not read or decrypt object bytes.
Outbox-only orphans lack normalized project/environment ownership and are not silently assigned
to the requested scope.

Events, dataset members and recorded ownership reads return at most their existing contract
ceiling per requested header plus one overflow sentinel. Reconstruction validates the whole
returned set and rejects excess/inconsistent children. These limits do not impose hard SQL
scan/time/transport-byte ceilings. A distinct root adds internal SQL/body/child reads that current
outer response admission does not completely count; explicit root admission remains required.

Helpers issue fixed reads without acquiring a connection, changing GUCs, beginning/ending the
transaction or acquiring guards. The caller owns authorization, lifetime, scope, admission,
failed-port taint, draining and rollback. No migration, role/grant, dependency, route or worker is
added. Complete closure and live lease/fence authority must remain guarded on the same connection
through atomic snapshot/job publication. Returned records and ended read reports are not a seal.

## Verification

Actual API roles publish root/successor graphs in disposable PostgreSQL. Administrator-only
damage retains CHECKs, rolls back every mutation and verifies seven table fingerprints plus
original owning reads. Cases cover missing/mismatched resources and intents, orphan children/
roots, distinct missing root bodies/intents/children, exact/outside scope and shared-format
absence. Controlled two-connection normal publication exercises the absent-cut race. Separate
supplied-client response mutations verify rejection of non-native booleans; they do not claim
PostgreSQL emitted those values. Existing shared conformance retains recorded promotion,
ownership/revocation, original retry receipts, scope conflicts and publication rollback.
This is experimental retained-storage evidence, not provider truthfulness or production readiness.
