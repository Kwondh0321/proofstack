# PostgreSQL migrations

Migration files are immutable after merge. Names use `NNNN_lowercase_description.sql`; the
migration runner verifies their exact SHA-256 checksums before applying any pending change.

## Safe workflow

Use a dedicated administrative connection. The API runtime role cannot create schema objects or
roles and must never receive the migration URL.

```bash
pnpm db:status
pnpm db:migrate
pnpm db:provision
pnpm db:status
```

`db:migrate` serializes runners with a PostgreSQL advisory lock and records each migration only
after its transaction commits. `db:provision` refuses a missing, pending, unknown, or
checksum-mismatched migration history before it changes runtime roles. It creates or rotates marked
API, identity, publisher, and consumer roles, removes stale ProofStack table, sequence, and function
grants, and reapplies the audited least-privilege matrix.

After a migration is shared, never edit or reorder it. Add the next numbered file for every schema
change. Destructive rollback is not automated; recovery must use a tested forward repair or a
documented backup restore. The coordinated recovery set, empty-target restore rule, compatibility
window, and old-binary rollback barrier are defined in
[ADR-0011](../../../docs/architecture/0011-coordinated-recovery-and-schema-rollback.md).

The complete local sequence, environment variables, persistence behavior, and reset procedure are
documented in the [local development guide](../../../docs/development/local-development.md).
