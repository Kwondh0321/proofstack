import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { loadMigrations, MigrationFileError } from "./migrations.js";

const temporaryDirectories: string[] = [];

async function migrationDirectory(): Promise<{ readonly path: string; readonly url: URL }> {
  const path = await mkdtemp(join(tmpdir(), "proofstack-migrations-"));
  temporaryDirectories.push(path);
  return { path, url: pathToFileURL(`${path}/`) };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("loadMigrations", () => {
  it("loads ordered SQL files with exact SHA-256 checksums", async () => {
    const directory = await migrationDirectory();
    await writeFile(join(directory.path, "0002_second.sql"), "SELECT 2;\n");
    await writeFile(join(directory.path, "0001_first.sql"), "SELECT 1;\n");
    await writeFile(join(directory.path, "README.md"), "ignored");

    const migrations = await loadMigrations(directory.url);

    expect(migrations.map(({ id }) => id)).toEqual(["0001_first", "0002_second"]);
    expect(migrations[0]).toMatchObject({
      checksum: "b4e0497804e46e0a0b0b8c31975b062152d551bac49c3c2e80932567b4085dcd",
      filename: "0001_first.sql",
      sequence: 1,
      sql: "SELECT 1;\n",
    });
  });

  it("rejects malformed SQL filenames", async () => {
    const directory = await migrationDirectory();
    await writeFile(join(directory.path, "1-BAD.sql"), "SELECT 1;");

    await expect(loadMigrations(directory.url)).rejects.toBeInstanceOf(MigrationFileError);
  });

  it("rejects duplicate numeric sequences", async () => {
    const directory = await migrationDirectory();
    await writeFile(join(directory.path, "0001_first.sql"), "SELECT 1;");
    await writeFile(join(directory.path, "0001_second.sql"), "SELECT 2;");

    await expect(loadMigrations(directory.url)).rejects.toThrow("used more than once");
  });

  it("rejects empty migration files", async () => {
    const directory = await migrationDirectory();
    await writeFile(join(directory.path, "0001_empty.sql"), " \n");

    await expect(loadMigrations(directory.url)).rejects.toThrow("cannot be empty");
  });
});
