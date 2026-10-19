import type { ReleaseDecisionVerificationBudget } from "@proofstack/core";
import type { PoolClient } from "pg";
import { ReleaseInstallerSchemaError } from "./release-installer-schema.js";

/** Effective privileges, including PUBLIC and direct grants, at the actual connection boundary.
 * No grant, role change, private source read or arbitrary SQL/callback is performed here.
 */
export async function assertReleaseInstallerRoleOnClient(
  client: PoolClient,
  budget: ReleaseDecisionVerificationBudget,
): Promise<void> {
  budget.snapshot();
  try {
    const result = await client.query<{ kind: string; name: string; privilege: string }>(
      `SELECT 'table' AS kind,c.relname::text AS name,v.privilege
       FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) AS v(privilege)
       WHERE n.nspname='public' AND c.relkind IN('r','p','v','m','f')
         AND has_table_privilege(session_user,c.oid,v.privilege)
         AND NOT(c.relname='proofstack_schema_migrations' AND v.privilege='SELECT')
       UNION ALL
       SELECT 'sequence',c.relname::text,v.privilege
       FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       CROSS JOIN unnest(ARRAY['USAGE','SELECT','UPDATE']) AS v(privilege)
       WHERE n.nspname='public' AND c.relkind='S' AND has_sequence_privilege(session_user,c.oid,v.privilege)
       UNION ALL
       SELECT 'function',p.proname::text,'EXECUTE'
       FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='public' AND has_function_privilege(session_user,p.oid,'EXECUTE')
         AND p.oid<>ALL(ARRAY[
           'public.proofstack_release_installer_context(jsonb)'::regprocedure,
           'public.proofstack_recheck_release_installer(jsonb,jsonb)'::regprocedure,
           'public.proofstack_begin_authenticated_selection(jsonb,jsonb,text,jsonb)'::regprocedure,
           'public.proofstack_begin_authenticated_selection_lifecycle(jsonb,jsonb,jsonb)'::regprocedure,
           'public.proofstack_read_selection_publication_part(jsonb,text,text,text)'::regprocedure,
           'public.proofstack_finish_selection_publication(jsonb,text,text,jsonb,text,text,text,text)'::regprocedure,
           'public.proofstack_read_installer_projection(jsonb,text,text)'::regprocedure,
           'public.proofstack_release_policy_intent_status(text,text,jsonb,timestamptz)'::regprocedure,
           'public.proofstack_release_policy_lifecycle_intent_status(text,text,jsonb,timestamptz)'::regprocedure
         ]::oid[])
       UNION ALL
       SELECT 'schema','public','CREATE' WHERE has_schema_privilege(session_user,'public','CREATE')
       UNION ALL
       SELECT 'identity','connection','SET ROLE' WHERE current_user<>session_user
       ORDER BY kind,name,privilege`,
    );
    for (const row of result.rows) budget.observe(row);
    // The absence itself is a charged readiness observation, not an omitted successful prefix.
    if (result.rows.length === 0) budget.observe({ installerPrivilegeViolations: [] });
    if (result.rows.length !== 0) throw new ReleaseInstallerSchemaError();
  } catch (cause) {
    return budget.rejectSourceRead(cause);
  }
}
