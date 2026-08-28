import type { Pool, PoolClient, QueryResultRow } from "pg";
import { loadBundledMigrations, type Migration } from "./migrations.js";

const MIGRATION_LOCK_NAMESPACE = 1_347_579_483;
const MIGRATION_LOCK_RESOURCE = 1;

interface AppliedMigrationRow extends QueryResultRow {
  readonly checksum: string;
  readonly id: string;
}

interface LedgerPresenceRow extends QueryResultRow {
  readonly ledger: string | null;
}

export interface MigrationStatus {
  readonly appliedIds: readonly string[];
  readonly ledgerExists: boolean;
  readonly pendingIds: readonly string[];
}

export interface MigrationResult extends MigrationStatus {
  readonly newlyAppliedIds: readonly string[];
}

export interface MigrationLedgerEntry {
  readonly checksum: string;
  readonly id: string;
}

export class MigrationIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationIntegrityError";
  }
}

export class MigrationRequiredError extends Error {
  constructor(readonly pendingIds: readonly string[]) {
    super(
      pendingIds.length === 0
        ? "The database migration ledger is missing"
        : `The database requires migrations: ${pendingIds.join(", ")}`,
    );
    this.name = "MigrationRequiredError";
  }
}

const CREATE_LEDGER_SQL = `
  CREATE TABLE IF NOT EXISTS public.proofstack_schema_migrations (
    id text PRIMARY KEY CHECK (id ~ '^[0-9]{4}_[a-z0-9]+(?:_[a-z0-9]+)*$'),
    checksum text NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
    applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
  )
`;

async function appliedMigrations(client: PoolClient): Promise<readonly AppliedMigrationRow[]> {
  const result = await client.query<AppliedMigrationRow>(
    "SELECT id, checksum FROM public.proofstack_schema_migrations ORDER BY id",
  );
  return result.rows;
}

function pendingMigrations(
  migrations: readonly Migration[],
  applied: readonly AppliedMigrationRow[],
): readonly Migration[] {
  const bundledById = new Map(migrations.map((migration) => [migration.id, migration]));
  const appliedIds = new Set(applied.map((migration) => migration.id));

  for (const row of applied) {
    const bundled = bundledById.get(row.id);
    if (!bundled) {
      throw new MigrationIntegrityError(
        `Database migration ${row.id} is not known to this ProofStack release`,
      );
    }
    if (bundled.checksum !== row.checksum) {
      throw new MigrationIntegrityError(`Database migration ${row.id} has a checksum mismatch`);
    }
  }

  let sawPending = false;
  for (const migration of migrations) {
    if (!appliedIds.has(migration.id)) {
      sawPending = true;
      continue;
    }
    if (sawPending) {
      throw new MigrationIntegrityError(
        `Database migration ${migration.id} is applied after a missing earlier migration`,
      );
    }
  }

  return migrations.filter((migration) => !appliedIds.has(migration.id));
}

async function ledgerExists(client: PoolClient): Promise<boolean> {
  const result = await client.query<LedgerPresenceRow>(
    "SELECT to_regclass('public.proofstack_schema_migrations')::text AS ledger",
  );
  return result.rows[0]?.ledger !== null && result.rows[0]?.ledger !== undefined;
}

export async function inspectMigrations(
  pool: Pick<Pool, "connect">,
  migrations?: readonly Migration[],
): Promise<MigrationStatus> {
  const availableMigrations = migrations ?? (await loadBundledMigrations());
  const client = await pool.connect();
  try {
    if (!(await ledgerExists(client))) {
      return {
        appliedIds: [],
        ledgerExists: false,
        pendingIds: availableMigrations.map((migration) => migration.id),
      };
    }

    const applied = await appliedMigrations(client);
    const pending = pendingMigrations(availableMigrations, applied);
    return {
      appliedIds: applied.map((migration) => migration.id),
      ledgerExists: true,
      pendingIds: pending.map((migration) => migration.id),
    };
  } finally {
    client.release();
  }
}

export async function assertMigrationsCurrent(
  pool: Pick<Pool, "connect">,
  migrations?: readonly Migration[],
): Promise<void> {
  const client = await pool.connect();
  try {
    await assertMigrationsCurrentOnClient(client, migrations);
  } finally {
    client.release();
  }
}

export async function assertMigrationsCurrentOnClient(
  client: PoolClient,
  migrations?: readonly Migration[],
): Promise<void> {
  await verifiedCurrentMigrationLedgerOnClient(client, migrations);
}

async function verifiedCurrentMigrationLedgerOnClient(
  client: PoolClient,
  migrations?: readonly Migration[],
): Promise<readonly MigrationLedgerEntry[]> {
  const availableMigrations = migrations ?? (await loadBundledMigrations());
  if (!(await ledgerExists(client))) {
    throw new MigrationRequiredError(availableMigrations.map((migration) => migration.id));
  }

  const applied = await appliedMigrations(client);
  const pending = pendingMigrations(availableMigrations, applied);
  if (pending.length > 0) {
    throw new MigrationRequiredError(pending.map((migration) => migration.id));
  }
  return applied.map(({ checksum, id }) => ({ checksum, id }));
}

export async function inspectVerifiedMigrationLedger(
  pool: Pick<Pool, "connect">,
  migrations?: readonly Migration[],
): Promise<readonly MigrationLedgerEntry[]> {
  const client = await pool.connect();
  try {
    return await verifiedCurrentMigrationLedgerOnClient(client, migrations);
  } finally {
    client.release();
  }
}

async function rollback(client: PoolClient): Promise<boolean> {
  try {
    await client.query("ROLLBACK");
    return false;
  } catch {
    client.release(true);
    return true;
  }
}

export async function migrateDatabase(
  pool: Pick<Pool, "connect">,
  migrations?: readonly Migration[],
): Promise<MigrationResult> {
  const availableMigrations = migrations ?? (await loadBundledMigrations());
  const client = await pool.connect();
  let connectionDestroyed = false;
  let lockAcquired = false;
  let operationError: unknown;
  let operationFailed = false;
  let result: MigrationResult | undefined;

  try {
    await client.query("SELECT pg_advisory_lock($1, $2)", [
      MIGRATION_LOCK_NAMESPACE,
      MIGRATION_LOCK_RESOURCE,
    ]);
    lockAcquired = true;
    await client.query(CREATE_LEDGER_SQL);

    const applied = await appliedMigrations(client);
    const pending = pendingMigrations(availableMigrations, applied);
    const newlyAppliedIds: string[] = [];

    for (const migration of pending) {
      await client.query("BEGIN");
      try {
        await client.query(migration.sql);
        await client.query(
          "INSERT INTO public.proofstack_schema_migrations (id, checksum) VALUES ($1, $2)",
          [migration.id, migration.checksum],
        );
        await client.query("COMMIT");
        newlyAppliedIds.push(migration.id);
      } catch (error) {
        connectionDestroyed = await rollback(client);
        throw error;
      }
    }

    result = {
      appliedIds: [...applied.map((migration) => migration.id), ...newlyAppliedIds],
      ledgerExists: true,
      newlyAppliedIds,
      pendingIds: [],
    };
  } catch (error) {
    operationError = error;
    operationFailed = true;
  }

  if (!connectionDestroyed) {
    if (lockAcquired) {
      try {
        await client.query("SELECT pg_advisory_unlock($1, $2)", [
          MIGRATION_LOCK_NAMESPACE,
          MIGRATION_LOCK_RESOURCE,
        ]);
      } catch (error) {
        if (!operationFailed) {
          operationError = error;
          operationFailed = true;
        }
        client.release(true);
        connectionDestroyed = true;
      }
    }
    if (!connectionDestroyed) client.release();
  }

  if (operationFailed) throw operationError;
  if (!result) throw new MigrationIntegrityError("Migration execution produced no result");
  return result;
}
