import type { ReleaseDecisionVerificationBudget } from "@proofstack/core";
import type { PoolClient } from "pg";
import { ReviewerAdministratorSchemaError } from "./reviewer-administrator-schema.js";

/** Effective privileges, including PUBLIC and direct grants, at the actual connection boundary.
 * No grant, role change, private source read or arbitrary SQL/callback is performed here.
 */
export async function assertReviewerAdministratorRoleOnClient(
  client: PoolClient,
  budget: ReleaseDecisionVerificationBudget,
): Promise<void> {
  budget.snapshot();
  try {
    const result = await client.query<{ kind: string; name: string; privilege: string }>(
      `SELECT 'table' AS kind,c.relname::text AS name,v.privilege
       FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
       CROSS JOIN pg_catalog.unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) AS v(privilege)
       WHERE n.nspname='public' AND c.relkind IN('r','p','v','m','f')
         AND (pg_catalog.has_table_privilege(session_user,c.oid,v.privilege)
           OR pg_catalog.has_table_privilege(session_user,c.oid,v.privilege||' WITH GRANT OPTION'))
         AND NOT(c.relname='proofstack_schema_migrations' AND v.privilege='SELECT'
           AND NOT pg_catalog.has_table_privilege(session_user,c.oid,'SELECT WITH GRANT OPTION'))
       UNION ALL
       SELECT 'column',c.relname::text,v.privilege
       FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
       CROSS JOIN pg_catalog.unnest(ARRAY['SELECT','INSERT','UPDATE','REFERENCES']) AS v(privilege)
       WHERE n.nspname='public' AND c.relkind IN('r','p','v','m','f') AND (
         (pg_catalog.has_any_column_privilege(session_user,c.oid,v.privilege)
           AND NOT pg_catalog.has_table_privilege(session_user,c.oid,v.privilege))
         OR (pg_catalog.has_any_column_privilege(session_user,c.oid,v.privilege||' WITH GRANT OPTION')
           AND NOT pg_catalog.has_table_privilege(session_user,c.oid,v.privilege||' WITH GRANT OPTION')))
       UNION ALL
       SELECT 'sequence',c.relname::text,v.privilege
       FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
       CROSS JOIN pg_catalog.unnest(ARRAY['USAGE','SELECT','UPDATE']) AS v(privilege)
       WHERE n.nspname='public' AND c.relkind='S' AND (
         pg_catalog.has_sequence_privilege(session_user,c.oid,v.privilege)
         OR pg_catalog.has_sequence_privilege(session_user,c.oid,v.privilege||' WITH GRANT OPTION'))
       UNION ALL
       SELECT 'function',p.proname::text,'EXECUTE'
       FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='public' AND (
         pg_catalog.has_function_privilege(session_user,p.oid,'EXECUTE WITH GRANT OPTION') OR (
         pg_catalog.has_function_privilege(session_user,p.oid,'EXECUTE') AND p.oid<>ALL(ARRAY[
           'public.proofstack_reviewer_administrator_context(jsonb)'::regprocedure,
           'public.proofstack_recheck_reviewer_administrator(jsonb,jsonb)'::regprocedure,
           'public.proofstack_begin_authenticated_reviewer_authority(jsonb,jsonb,text,jsonb)'::regprocedure,
           'public.proofstack_begin_authenticated_reviewer_authority_lifecycle(jsonb,jsonb,jsonb)'::regprocedure,
           'public.proofstack_read_reviewer_publication_part(jsonb,text,text,text)'::regprocedure,
           'public.proofstack_finish_reviewer_publication(jsonb,text,text,jsonb,text,text,text,text)'::regprocedure,
           'public.proofstack_read_reviewer_administrator_projection(jsonb,text,text,text,text)'::regprocedure
         ]::oid[])))
       UNION ALL
       SELECT 'schema','public','CREATE OR GRANT OPTION' WHERE
         pg_catalog.has_schema_privilege(session_user,'public','CREATE')
         OR pg_catalog.has_schema_privilege(session_user,'public','CREATE WITH GRANT OPTION')
         OR pg_catalog.has_schema_privilege(session_user,'public','USAGE WITH GRANT OPTION')
       UNION ALL
       SELECT 'database',pg_catalog.current_database(),'CREATE OR GRANT OPTION' WHERE
         pg_catalog.has_database_privilege(session_user,pg_catalog.current_database(),'CREATE')
         OR pg_catalog.has_database_privilege(session_user,pg_catalog.current_database(),'CREATE WITH GRANT OPTION')
         OR pg_catalog.has_database_privilege(session_user,pg_catalog.current_database(),'CONNECT WITH GRANT OPTION')
         OR pg_catalog.has_database_privilege(session_user,pg_catalog.current_database(),'TEMP WITH GRANT OPTION')
       UNION ALL
       SELECT 'identity','connection','SET ROLE' WHERE current_user<>session_user
       ORDER BY kind,name,privilege`,
    );
    for (const row of result.rows) budget.observe(row);
    // The absence itself is a charged readiness observation, not an omitted successful prefix.
    if (result.rows.length === 0) budget.observe({ reviewerAdministratorPrivilegeViolations: [] });
    if (result.rows.length !== 0) throw new ReviewerAdministratorSchemaError();
  } catch (cause) {
    return budget.rejectSourceRead(cause);
  }
}
