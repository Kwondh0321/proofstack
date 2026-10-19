# Original selection publication digest findings

[English](selection-publication-digest-scan.md) |
[한국어](selection-publication-digest-scan.ko.md)

The first CI scan of `a65458d6deccf13f01f161c42907e25de6a123f7` reported ten
`generic-api-key` findings in the new selection publication vectors and actual native response
fixtures. All ten locations are `credentialSha256` fields: SHA-256 digests of the complete
**safe public session-state record**, not cookies, secrets, session-token verifiers or password
hashes. The safe preimage contains original credential identity, scope, creation/expiry/use/revocation
metadata. It excludes session/CSRF digests and raw browser credentials. The compact profile's
credential digest detects changes to that safe record; it cannot authenticate a session.

Each matched value was recomputed from its retained safe canonical preimage. The vector values
were also checked against the shared synthetic fixture and independent Python canonical-byte
vectors. Native values were checked against the original completion call's retained canonical
safe credential bytes. No matched value was replaced, split, encoded or regenerated to evade a rule.
The original observations remain in Git history. When native readiness queries change, a fresh
actual response capture is retained separately and any new findings receive their own exact
commit fingerprints after the same preimage verification; no blanket exemption is introduced.
The version 0.1 semantic encoding and original contract vectors remain unchanged.

The root [.gitleaksignore](../../.gitleaksignore) appends only those ten exact immutable
commit/path/rule/line fingerprints, alongside the separate
[historical test-prefix disposition](historical-test-prefix-scan.md). It excludes no whole path,
rule, value, future commit or changed line. Scanner rules, version, workflow scan scope and failing
exit code are unchanged. The original failed CI evidence and Git history remain intact.

## Verification

The verified official Gitleaks 8.24.3 binary reproduced ten findings with the original ignore file.
The exact fingerprint disposition produced zero findings for that same range. In a separate
disposable local repository, committing the unchanged vector file at a new commit still produced
two failing findings with the disposition present. This confirms that the exact fingerprints do
not exempt new occurrences; it is not a claim that every secret is detectable. Reports/logs used
100% redaction, and review output retained only rule/path/line/count metadata.

The independent full source check at the original implementation SHA passed 18,007 package tests
plus 16 runner tests and 31 uncached builds. That local result does not substitute for corrected-SHA
CI, security, native integration or the checkpoint exit audit. Initial native CI separately exposed
stale table/migration inventories; those corrections preserve the unchanged C3 source boundary.
