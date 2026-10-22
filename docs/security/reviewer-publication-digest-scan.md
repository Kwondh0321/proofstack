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

## Native observations at original commit 086d236

The official retained-history scan of `086d2365ff679b5803b584d5cb707787263c052c`
reported eight `generic-api-key` findings in
`packages/postgres/src/fixtures/reviewer-administrator-native-wire-v1.json`: lines 126, 249,
344, 436, 1317, 1385, 1981 and 2050. Every exact committed line is a `credentialSha256`
field. Independent Python compact sorted-key UTF-8/hashlib computation verifies the two original
profile hashes against the captured safe public session-state preimages; the transcript also
retains two later session observations. No credential-shaped private field occurs in the fixture.

The fixture is an actual synthetic PostgreSQL 16.15 query transcript, with four publication/retry
cases and deduplicated observations. Values, original bytes and history remain unchanged. Only
these eight original commit/path/rule/line fingerprints are added. The original vector dispositions
above remain separate; no path, field name, value, rule or future commit is exempted.

The same unchanged native fixture and ignore file are also scanned in a separate disposable Git
repository with a new commit. All eight findings must remain detectable there. Retained-history
scan success and this negative control are distinct from native integration, recovery, CodeQL,
exact-source checks and checkpoint acceptance. No scanner threshold or rule is relaxed.
