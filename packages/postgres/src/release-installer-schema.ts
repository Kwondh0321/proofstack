import { isDeepStrictEqual } from "node:util";
import type { ReleaseDecisionVerificationBudget } from "@proofstack/core";
import type { PoolClient } from "pg";
import type { Migration } from "./migrations.js";

const names = [
  "proofstack_release_installer_context",
  "proofstack_recheck_release_installer",
  "proofstack_guard_selection_publication",
  "proofstack_verify_selection_publication",
  "proofstack_begin_authenticated_selection",
  "proofstack_begin_authenticated_selection_lifecycle",
  "proofstack_read_selection_publication_part",
  "proofstack_finish_selection_publication",
  "proofstack_read_installer_projection",
] as const;
interface ExpectedRoutine {
  readonly name: string;
  readonly body: string;
  readonly securityDefiner: boolean;
}
export class ReleaseInstallerSchemaError extends Error {
  readonly code = "release_installer_schema_invalid";
  constructor() {
    super("Installed release installer schema differs from its bundled authority boundary");
    this.name = "ReleaseInstallerSchemaError";
  }
}
/** Parse only this bundled migration's fixed dollar-quoted definitions, before native guards.
 * Not caller SQL, migration execution or a reusable authority capability.
 */
export function prepareReleaseInstallerSchema(
  migrations: readonly Migration[],
): readonly ExpectedRoutine[] {
  const migration = migrations.find(
    (item) => item.id === "0071_authenticated_release_selection_publication",
  );
  if (!migration) throw new ReleaseInstallerSchemaError();
  const expected = names.map((name) => {
    const expression = new RegExp(
      `CREATE FUNCTION public\\.${name}\\([^]*?\\)\\s*RETURNS ([^]*?) AS \\$\\$([^]*?)\\$\\$;`,
      "g",
    );
    const matches = [...migration.sql.matchAll(expression)];
    if (matches.length !== 1 || !matches[0]?.[1] || !matches[0]?.[2])
      throw new ReleaseInstallerSchemaError();
    return { name, body: matches[0][2], securityDefiner: /SECURITY DEFINER/.test(matches[0][1]) };
  });
  // The forward repair preserves the installed function identity. Require its current body,
  // while still rejecting incomplete or ambiguous original bundled definitions above.
  const repair = migrations.find((item) => item.id === "0072_qualify_installer_role_catalogs");
  if (!repair) throw new ReleaseInstallerSchemaError();
  const replacements = [
    ...repair.sql.matchAll(
      /CREATE OR REPLACE FUNCTION public\.proofstack_release_installer_context\([\s\S]*?\)\s*RETURNS ([\s\S]*?) AS \$\$([\s\S]*?)\$\$;/g,
    ),
  ];
  const current = replacements[0];
  if (replacements.length !== 1 || !current?.[1] || !current[2])
    throw new ReleaseInstallerSchemaError();
  const body = current[2],
    securityDefiner = /SECURITY DEFINER/.test(current[1]);
  return expected.map((item) =>
    item.name === "proofstack_release_installer_context"
      ? {
          name: item.name,
          body,
          securityDefiner,
        }
      : item,
  );
}
export async function assertReleaseInstallerSchemaOnClient(
  client: PoolClient,
  expected: readonly ExpectedRoutine[],
  budget: ReleaseDecisionVerificationBudget,
): Promise<void> {
  budget.snapshot();
  try {
    const routines = await client.query<{
      name: string;
      body: string;
      definer: boolean;
      config: unknown;
      language: string;
      volatility: string;
    }>(
      `SELECT p.proname AS name,p.prosrc AS body,p.prosecdef AS definer,p.proconfig AS config,l.lanname AS language,p.provolatile AS volatility
       FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace JOIN pg_catalog.pg_language l ON l.oid=p.prolang
       WHERE n.nspname='public' AND p.proname=ANY($1::text[]) ORDER BY p.proname COLLATE "C"`,
      [expected.map((item) => item.name)],
    );
    for (const row of routines.rows) budget.observe(row);
    if (routines.rows.length !== expected.length) throw new ReleaseInstallerSchemaError();
    for (const item of expected) {
      const rows = routines.rows.filter((row) => row.name === item.name),
        row = rows[0];
      if (
        rows.length !== 1 ||
        !row ||
        row.body !== item.body ||
        row.definer !== item.securityDefiner ||
        !isDeepStrictEqual(row.config, ["search_path=pg_catalog"]) ||
        row.language !== "plpgsql" ||
        row.volatility !== "v"
      )
        throw new ReleaseInstallerSchemaError();
    }
    const table = await client.query<{ forced: boolean; enabled: boolean }>(
      "SELECT relforcerowsecurity AS forced,relrowsecurity AS enabled FROM pg_catalog.pg_class WHERE oid='public.proofstack_release_selection_publications'::regclass",
    );
    for (const row of table.rows) budget.observe(row);
    if (!isDeepStrictEqual(table.rows, [{ forced: true, enabled: true }]))
      throw new ReleaseInstallerSchemaError();
    const triggers = await client.query<{
      name: string;
      enabled: string;
      deferred: boolean;
      deferrable: boolean;
      function: string;
      function_schema: string;
      type: number;
      arguments: number;
      columns: string;
      unconditional: boolean;
    }>(
      `SELECT t.tgname AS name,t.tgenabled AS enabled,t.tginitdeferred AS deferred,t.tgdeferrable AS deferrable,p.proname AS function,
         n.nspname AS function_schema,t.tgtype::int AS type,t.tgnargs::int AS arguments,
         t.tgattr::text AS columns,t.tgqual IS NULL AS unconditional
       FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
       WHERE t.tgrelid='public.proofstack_release_selection_publications'::regclass AND NOT t.tgisinternal ORDER BY t.tgname COLLATE "C"`,
    );
    for (const row of triggers.rows) budget.observe(row);
    if (
      !isDeepStrictEqual(triggers.rows, [
        {
          name: "proofstack_release_selection_publication_complete",
          enabled: "O",
          deferred: true,
          deferrable: true,
          function: "proofstack_verify_selection_publication",
          function_schema: "public",
          type: 21,
          arguments: 0,
          columns: "",
          unconditional: true,
        },
        {
          name: "proofstack_release_selection_publication_guard",
          enabled: "O",
          deferred: false,
          deferrable: false,
          function: "proofstack_guard_selection_publication",
          function_schema: "public",
          type: 31,
          arguments: 0,
          columns: "",
          unconditional: true,
        },
      ])
    )
      throw new ReleaseInstallerSchemaError();
  } catch (cause) {
    return budget.rejectSourceRead(cause);
  }
}
