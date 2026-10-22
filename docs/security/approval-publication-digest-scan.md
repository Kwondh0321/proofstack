# Original approval publication digest findings

[English](approval-publication-digest-scan.md) | [한국어](approval-publication-digest-scan.ko.md)

The official verified Gitleaks 8.24.3 full retained-history scan at
`d09b92acd4e90bbaf48f3b08e716307b5a2c6c33` reported two `generic-api-key` findings at
`credentialSha256` in `packages/contracts/vectors/release-approval-publication-v1.json`, lines
42 and 87. Both retain the SHA-256 of the same complete synthetic **safe public session-state
metadata**. Independent Python sorted-key compact UTF-8 JSON and hashlib recomputation matches
both exact committed fields; owning core tests also match both independent canonical vectors.

The safe preimage contains identifiers, creation/expiry/use and revocation metadata. It contains
no cookie, CSRF, session-secret digest, password verifier or private key. This digest identifies
original public metadata and cannot authenticate a browser session. The vector file SHA-256 is
`f01bfce898c7c8b6012765c7056ce319895daa76c323e4c63934c3e3ddbe2179`.

The [.gitleaksignore](../../.gitleaksignore) dispositions cover only the two exact immutable
commit/path/rule/line fingerprints. Earlier dispositions remain unchanged. Original file bytes,
field names, values and Git history are preserved. No path, rule, value or future commit is
excluded; nothing is split, encoded or regenerated to avoid detection. Scanner rules, scope,
version and failing exit behavior remain unchanged.

Verification retains the initial failing full-history scan, a zero-finding scan after the exact
disposition, and a negative control that commits the unchanged vector and same ignore file in a
separate disposable local repository. That new commit must still produce both findings and a
failing scanner exit. Reports use complete redaction; review output prints only rule, path, line,
commit and count. No browser credentials or matched values are printed.

These scanner checks do not replace exact-source uncached tests, hosted CI, CodeQL, native service
and recovery checks, or checkpoint acceptance. [Approval withdrawal](../development/workflow-2-authenticated-approval-revocation-reference.md)
remains a synthetic reference component of the open Workflow 2 checkpoint 4.
