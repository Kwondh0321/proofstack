import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";

const MIGRATION_FILE_PATTERN = /^(\d{4})_([a-z0-9]+(?:_[a-z0-9]+)*)\.sql$/;

export interface Migration {
  readonly checksum: string;
  readonly filename: string;
  readonly id: string;
  readonly sequence: number;
  readonly sql: string;
}

export class MigrationFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationFileError";
  }
}

function checksum(contents: Uint8Array): string {
  return createHash("sha256").update(contents).digest("hex");
}

export async function loadMigrations(directory: URL): Promise<readonly Migration[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const filenames = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort();
  const sequences = new Set<number>();
  const migrations: Migration[] = [];

  for (const filename of filenames) {
    const match = MIGRATION_FILE_PATTERN.exec(filename);
    if (!match) {
      throw new MigrationFileError(
        `Migration filename ${filename} must match NNNN_lowercase_description.sql`,
      );
    }

    const sequenceText = match[1];
    if (!sequenceText) throw new MigrationFileError(`Migration ${filename} has no sequence`);
    const sequence = Number.parseInt(sequenceText, 10);
    if (sequences.has(sequence)) {
      throw new MigrationFileError(`Migration sequence ${sequenceText} is used more than once`);
    }

    const contents = await readFile(new URL(filename, directory));
    const sql = contents.toString("utf8");
    if (sql.trim().length === 0) {
      throw new MigrationFileError(`Migration ${filename} cannot be empty`);
    }

    sequences.add(sequence);
    migrations.push({
      checksum: checksum(contents),
      filename,
      id: filename.slice(0, -4),
      sequence,
      sql,
    });
  }

  return migrations;
}

export function loadBundledMigrations(): Promise<readonly Migration[]> {
  return loadMigrations(new URL("../migrations/", import.meta.url));
}
