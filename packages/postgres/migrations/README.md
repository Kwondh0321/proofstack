# PostgreSQL migrations

Migration files are immutable after merge. Names use `NNNN_lowercase_description.sql`; the
migration runner verifies their exact SHA-256 checksums before applying any pending change.
