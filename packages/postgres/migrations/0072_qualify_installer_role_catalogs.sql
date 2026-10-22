-- Preserve installed function identity, grants, source records and original publication bytes.
-- A caller-owned temporary relation must not replace system role or membership observations.
CREATE OR REPLACE FUNCTION public.proofstack_release_installer_context(expected_scope jsonb)
RETURNS text LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE scoped jsonb:=public.proofstack_release_selection_scope();role_value record;
BEGIN
  SELECT r.*,pg_catalog.shobj_description(r.oid,'pg_authid') AS marker INTO role_value FROM pg_catalog.pg_roles r WHERE r.rolname=session_user;
  IF role_value.marker IS DISTINCT FROM 'proofstack-managed-runtime-role:v1:releaseAuthority'
    OR NOT role_value.rolcanlogin OR role_value.rolsuper OR role_value.rolcreatedb OR role_value.rolcreaterole
    OR role_value.rolreplication OR role_value.rolbypassrls OR role_value.rolinherit
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.member=role_value.oid OR m.roleid=role_value.oid) THEN
    RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Dedicated unshared installer runtime role is required';
  END IF;
  IF scoped IS DISTINCT FROM expected_scope OR current_setting('transaction_isolation')<>'read committed' THEN
    RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Exact READ COMMITTED installer scope is required';
  END IF;
  IF NOT public.proofstack_try_lock_policy_evaluation_metadata() OR NOT pg_try_advisory_xact_lock(
    hashtextextended(jsonb_build_array('proofstack.release-selection.v1',scoped->>'tenantId')::text,0)) THEN
    RAISE EXCEPTION USING ERRCODE='55P03',MESSAGE='Installer guards are contended; whole rollback required';
  END IF;
  RETURN public.proofstack_current_replay_recovery_epoch()::text;
END; $$;
