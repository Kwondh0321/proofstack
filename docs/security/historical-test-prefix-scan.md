# Historical synthetic prefix finding

The pinned Gitleaks action uses version 8.24.3. Push events scan the selected
commit range; manual runs scan the complete retained Git history. A manual run
at `8d054d4322c508ab574559f818d02bdb2810acef` found one `generic-api-key`
finding in the historical PostgreSQL workload-identity integration test.
[Korean explanation](historical-test-prefix-scan.ko.md).

## Exact disposition

The finding is line 177 of
`packages/postgres/src/workload-identity-migration.integration.test.ts` at
`d7c1f08358d2a1128381c5d73ab8ccadc4abd85e`. It is the 12-character second
argument of `createValues`, which supplies a synthetic public lookup prefix.
It is not a complete API key, password or provider credential. That test uses
explicit synthetic hash fixtures and checks rejection when tenant context is
missing. The current test constructs the same prefix through `testPrefix`.
No service credential is copied into the fixture.

The root [.gitleaksignore](../../.gitleaksignore) records only this exact
commit/path/rule/line fingerprint, following the
[8.24.3 documentation](https://github.com/gitleaks/gitleaks/blob/v8.24.3/README.md#gitleaksignore).
It does not exclude the file, rule, value or other commits. The scanner version,
default rules, workflow event scope and failing exit code remain unchanged.
The earlier failed CI run remains a failed run; a later successful scan does
not rewrite that evidence or the repository history.

## Verification

Reproduce the full-history scan with the pinned version and 100% redaction.
Confirm that the unmodified scan reports this one historical fingerprint and
that the exact fingerprint disposition permits the complete-history scan.
In a separate disposable repository, commit the historical test content again
with this ignore file and confirm that the same synthetic prefix still produces
a failing scan at its new commit fingerprint. Retain only redacted reports and
finding metadata in review output. This control establishes that the disposition
does not suppress a new occurrence; it does not prove detection of every secret.
