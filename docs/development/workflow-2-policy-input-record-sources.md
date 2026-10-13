# Request-owned record sources for policy input

[English](workflow-2-policy-input-record-sources.md) |
[한국어](workflow-2-policy-input-record-sources.ko.md)

Status: implementation prerequisite; Workflow 2 checkpoint 3 remains open (2/7 accepted).

The [strict relationship component and manifest join](workflow-2-policy-snapshot-source-inputs.md)
add exact retained relationship/source-witness validation without replacing owning reinspection.

The [strict snapshot record component](workflow-2-policy-snapshot-record-inputs.md) adds
versioned original metadata validation and canonical vectors. Server derivation validates it
after output admission; full owning validation and all other input domains remain separate.

The workspace server entry `capturePolicyInputRecordSources` acquires the graph and derives its
record sources on one request-owned meter. It accepts the existing exact-scope read repositories,
performs no content/key reads and returns the owned graph separately from source metadata.
Guarded server composition may supply transaction-lifetime metadata ports; the returned result
does not retain their guards or become publication authority.

Internal `derivePolicyInputRecordSources` independently re-derives record sources from the request's
semantic graph and original storage inventory. It does not trust `graph.entries`, a supplied
closure report or a caller-selected expected source list. Owning dispatchers validate exact
scope, source identities, full body hashes, receipts, reachability, ordered references, complete
original selector outcomes and original logical roots before the two domains are joined.

Every semantic source must agree with its original capture. The unique source set preserves the
original manifest observation, including missing, invalid, mismatched and not-yet-available
records. Original body hashes and receipt times remain separate witnesses. A valid future body
does not become a verified semantic operand. Original-only dependencies remain in the source
set even when they were not traversable through the semantic graph.

Each unique record retains every request-root, semantic/stored node, parent/target edge and
logical-root use. Repeated sources are not a smaller favorable evidence set. Semantic non-record
frontiers retain their exact parent, full parent hash, path/reference and retained target.
Original non-record mappings preserve all targets and zero/unique/multiple cardinality. Cardinality
is structural; a unique target is not current authority. A fingerprint binds the entire original
owning resolution without copying its retained child bodies into the metadata report. The
complete original resolution remains a separate captured input, not evidence reconstructed from
its fingerprint alone. Logical-root metadata preserves configured/unconfigured state, unresolved
reasons and exact retained original-root references.

Occurrence admission precedes material serialization, and exact canonical bytes are admitted
before copying or deriving witnesses. Semantic and stored reinspection plus every returned origin,
frontier and mapping are charged to the same cumulative acquisition meter. Exact limits succeed;
one record/reference or byte below the required admission fails. Source metadata is detached from the
captured graph, performs no additional repository/content/key I/O, and contains record metadata
and declared references rather than full retained bodies.

The existing manifest assembler and verifier can use this independently derived source set.
A semantic-only manifest is insufficient when original storage introduces additional dependencies;
otherwise valid pages/digests do not repair the omitted closure. The existing versioned request,
source and fixed-page manifest contracts are preserved.

This internal helper returns `record_sources_only`, not a sealed snapshot or policy outcome.
Policy/criterion authority histories, artifact/content observations, complete trace evidence,
current authority and execution fences remain separate inputs. Complete typed input closure,
strict snapshot/result contracts, guarded atomic publication, finite native reads, durable workers,
API/SDK/recovery and the independent checkpoint-3 exit audit remain open. Never publish later from
an ended read-only report or treat source enumeration as release approval.

Focused coverage includes future bodies, omitted/substituted nodes/edges/hashes/scope/time,
repeated origins, caller-list substitution, exact/one-below cumulative admission, original logical
roots and ambiguous/future protocol mappings. Existing assertions and coverage thresholds remain
unchanged; focused tests alone do not establish checkpoint acceptance.
