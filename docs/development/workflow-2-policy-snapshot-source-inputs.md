# Strict policy snapshot source inputs

[English](workflow-2-policy-snapshot-source-inputs.md) |
[한국어](workflow-2-policy-snapshot-source-inputs.ko.md)

Status: implementation prerequisite; Workflow 2 checkpoint 3 remains open (2/7 accepted).

`PolicyEvaluationSnapshotSourceInputsSchema` joins existing strict original record witnesses
with parent-bound semantic frontiers, stored non-record mappings and original logical-root
bindings. It preserves original edge/binding indices, full parent body hashes, JSON-pointer
paths, exact source references and every target position, including repeated targets. The
fourteen reference kinds reuse owning contract shapes. Control/replay declarations retain
selectors and identities without resolving credentials, loading implementations or granting
authority.

Every relationship parent and retained target must occur in the exact record inventory with
its original use coordinate. Semantic parents must be verified. Valid future stored parents
retain original body witnesses without becoming semantic operands. Mappings preserve
zero/unique/multiple cardinality and resolution fingerprints; fingerprints do not reconstruct
complete captured resolutions. Logical-root configuration and retained bindings agree in both
directions. A stored mapping cannot discard targets while retaining their original positions.
A unique target is not proof of current authority.

Combined record/origin/frontier/mapping/binding admission and target-position admission precede
nested material parsing. Original uses are indexed for linear relationship joins. Owning
`derivePolicyInputRecordSources` validates this component after existing cumulative occurrence
and canonical-byte admission, preserving its output shape without additional I/O. Schemas check
metadata consistency; owning reinspection of complete bodies establishes authenticity,
completeness and original selector results.

`validatePolicyEvaluationSnapshotSources` binds independently acquired sources to the existing
fixed-page manifest. It checks exact request, scope and full-precision evaluation cut. Manifest
validation checks root/page digests, complete source identity, count and order. The join also
compares every availability observation and full body hash. Removing a source or substituting
an observation and recomputing valid manifest hashes does not bypass the join. Derive witnesses
from owning acquisition, never from the manifest or a publicly submitted expected list.
Returned metadata is detached from caller objects.

Canonical domain: `proofstack.policy-evaluation-snapshot-sources.v1`.
Encoding: `proofstack.policy-evaluation-snapshot-sources-jcs.v1`. The independent Python
UTF-8/JSON/hashlib vector includes Unicode occurrence paths, missing sources, original positions
and logical-root bindings. Encoded length: 3,459 bytes. SHA-256:
`11f10dc27214c14c7e180c28a6f9932a35dd91c2e4dfa9458dfcfcdceea52fa8`.

This component and join are not a sealed snapshot, policy result or publication token.
Complete authority histories, artifact/trace evidence, typed rule projections, bounded snapshot
pages and current presence/selector authority remain separate requirements. Publication must
validate complete closure and worker lease/fence in the same still-open guarded transaction as
atomic snapshot/job publication. The read-only `sourceRecheck` transaction ends before returning;
its report cannot authorize later publication. Deterministic predicates, workers, API/SDK,
recovery and independent checkpoint exit acceptance remain open.

See [record-source derivation](workflow-2-policy-input-record-sources.md),
[strict record witnesses](workflow-2-policy-snapshot-record-inputs.md),
[typed rule inputs](workflow-2-policy-snapshot-rule-inputs.md), and the
[entry audit](workflow-2-policy-evaluation-entry-audit.md).
