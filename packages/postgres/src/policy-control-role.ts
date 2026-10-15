import { withBoundedPolicyTransaction } from "./bounded-policy-transaction.js";
import type { createPolicyPostgresPool } from "./database.js";

/** Readiness checks actual effective grants, including inherited grants, without granting any. */
export async function assertPostgresPolicyControlRole(
  pool: ReturnType<typeof createPolicyPostgresPool>,
  connectionString: string,
) {
  const expected = decodeURIComponent(new URL(connectionString).username);
  const result = await withBoundedPolicyTransaction(
    pool,
    (client) =>
      client.query(`SELECT current_user AS identity,
      (NOT r.rolsuper AND NOT r.rolbypassrls AND NOT r.rolcreaterole AND NOT r.rolcreatedb
       AND NOT r.rolreplication AND r.rolcanlogin) AS restricted,
      has_function_privilege(current_user,'public.proofstack_create_policy_evaluation_job(jsonb,text,text)','EXECUTE') AS enqueue,
      has_function_privilege(current_user,'public.proofstack_cancel_policy_evaluation_job(text,text,text,text)','EXECUTE') AS cancel,
      has_function_privilege(current_user,'public.proofstack_read_policy_evaluation_job(text)','EXECUTE') AS read,
      has_function_privilege(current_user,'public.proofstack_publish_policy_evaluation_result(jsonb,text,text)','EXECUTE') AS publish
      FROM pg_roles r WHERE r.rolname=current_user`),
    { requireWire: true },
  );
  const row = result.rows[0];
  if (
    result.rows.length !== 1 ||
    row?.identity !== expected ||
    row.restricted !== true ||
    row.enqueue !== true ||
    row.cancel !== true ||
    row.read !== true ||
    row.publish !== false
  )
    throw new Error(
      "Policy control PostgreSQL connection requires a dedicated restricted control role",
    );
}
