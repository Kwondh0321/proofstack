# Original reviewer publication digest findings

[English](reviewer-publication-digest-scan.md) | [한국어](reviewer-publication-digest-scan.ko.md)

The official verified Gitleaks 8.24.3 scan of implementation commit
`ff86e15e601cee0da8063542e6dc6eddd683a35c` reported three `generic-api-key` findings at the
`credentialSha256` fields in the reviewer-publication canonical vectors. Each is the SHA-256 of
the same complete synthetic **safe public session-state metadata**, independently recomputed with
Python sorted-key compact UTF-8 JSON and checked against the owning core fixture and all three
independent vectors. The preimage contains identifiers, scope, creation/expiry/use and revocation
metadata. It contains no cookie, CSRF, session-secret digest, password verifier or private key.
The digest detects changes to safe metadata and cannot authenticate a browser session.

The [.gitleaksignore](../../.gitleaksignore) adds only these three exact immutable commit/path/rule/
line fingerprints. Existing dispositions remain unchanged. No whole path, rule, value, later
commit or changed line is excluded. Original vector values and history are preserved; nothing
was split, encoded, renamed or regenerated to avoid detection. Scanner version, rules, scan scope
and failing exit behavior remain unchanged.

The full retained-history scan initially failed with those three findings and passed with zero
findings after their exact disposition. A separate disposable local repository committed the
unchanged vector file with the same ignore file: all three findings were still detected and the
scanner failed. This verifies that the disposition does not exempt new occurrences; it is not a
claim that every secret is detectable. Reports/logs use complete redaction. Review output retains
only rule, path, line and count, without matched values or browser credentials.

This scan evidence does not replace exact-source CI, CodeQL, native service/recovery integration
or checkpoint acceptance. Reviewer administration remains a component of the open checkpoint 4.
See the [reference guide](../development/workflow-2-authenticated-reviewer-reference.md).
