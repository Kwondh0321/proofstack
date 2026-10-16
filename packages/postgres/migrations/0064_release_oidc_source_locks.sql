-- Separate from C3 artifact/policy locks. These guards do not authenticate a browser,
-- grant decision publication, or protect an entire decision's mutable dependency closure.
CREATE FUNCTION public.proofstack_try_lock_release_oidc_source(source_kind text, source_id text)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  tenant text := current_setting('proofstack.tenant_id', true);
  project text := current_setting('proofstack.project_id', true);
  environment text := current_setting('proofstack.environment_id', true);
BEGIN
  IF tenant IS NULL OR tenant !~ '^[a-z][a-z0-9_]{2,63}$'
    OR project IS NULL OR project !~ '^[a-z][a-z0-9_]{2,63}$'
    OR environment IS NULL OR environment !~ '^[a-z][a-z0-9_]{2,63}$'
  THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Exact release OIDC scope is required';
  END IF;
  IF source_kind IS NULL OR source_kind NOT IN ('oidc_binding', 'oidc_session')
    OR source_id IS NULL OR source_id !~ '^[a-z][a-z0-9_]{2,63}$'
  THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Invalid release OIDC lock identity';
  END IF;
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION USING ERRCODE = '0A000', MESSAGE = 'Release OIDC guards require READ COMMITTED';
  END IF;
  -- Never wait while holding other guards. A false result requires whole rollback.
  RETURN pg_try_advisory_xact_lock_shared(hashtextextended(
    jsonb_build_array('proofstack.release-oidc-source.v1', tenant, source_kind, source_id)::text, 0
  ));
END;
$$;

CREATE FUNCTION public.proofstack_lock_release_oidc_source_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  tenant text;
  resource_id text;
BEGIN
  -- Existing BEFORE validators make both identities immutable. DELETE is needed for
  -- retained-session purge; INSERT protects observations of an absent source.
  IF TG_OP = 'DELETE' THEN
    tenant := OLD.tenant_id;
    resource_id := OLD.session_id;
  ELSE
    tenant := NEW.tenant_id;
    IF TG_ARGV[0] = 'oidc_binding' THEN
      resource_id := NEW.binding_id;
    ELSE
      resource_id := NEW.session_id;
    END IF;
  END IF;
  -- AFTER preserves the existing writer row-lock order. Uncommitted changes cannot
  -- become visible or commit until this exclusive transaction lock is acquired.
  PERFORM pg_advisory_xact_lock(hashtextextended(
    jsonb_build_array('proofstack.release-oidc-source.v1', tenant, TG_ARGV[0], resource_id)::text, 0
  ));
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.proofstack_try_lock_release_oidc_source(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.proofstack_lock_release_oidc_source_write() FROM PUBLIC;

CREATE TRIGGER proofstack_release_oidc_source_write_lock
  AFTER INSERT OR UPDATE ON public.proofstack_oidc_bindings
  FOR EACH ROW EXECUTE FUNCTION public.proofstack_lock_release_oidc_source_write('oidc_binding');

CREATE TRIGGER proofstack_release_oidc_source_write_lock
  AFTER INSERT OR UPDATE OR DELETE ON public.proofstack_browser_sessions
  FOR EACH ROW EXECUTE FUNCTION public.proofstack_lock_release_oidc_source_write('oidc_session');
