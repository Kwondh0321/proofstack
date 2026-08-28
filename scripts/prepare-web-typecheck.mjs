import { rmSync } from "node:fs";
import { resolve } from "node:path";

const generatedTypesDirectory = resolve(import.meta.dirname, "../apps/web/.next/types");

// Next type generation does not guarantee removal of stale or conflicted files.
// Only its reproducible type output is removed; build assets and caches remain intact.
rmSync(generatedTypesDirectory, { force: true, recursive: true });
