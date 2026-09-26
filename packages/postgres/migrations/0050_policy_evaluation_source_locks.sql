-- Resource locks for the final database observation/publication transaction. These are not
-- revision tokens: callers must still revalidate the complete captured observations under locks.
-- Tenant + kind + id matches the existing tenant-wide catalog/version identities. Project and
-- environment remain mandatory read predicates; a lock is not permission to read a record.
CREATE FUNCTION public.proofstack_try_lock_policy_evaluation_source(
  source_kind text,
  source_id text
)
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
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Exact policy evaluation scope is required';
  END IF;
  IF source_kind IS NULL OR source_kind NOT IN ('artifact', 'release_policy')
    OR source_id IS NULL OR source_id !~ '^[a-z][a-z0-9_]{2,63}$'
  THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Invalid policy evaluation lock identity';
  END IF;
  -- A snapshot taken before obtaining a lock must not hide a writer that has just committed.
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION USING ERRCODE = '0A000', MESSAGE = 'Source guards require READ COMMITTED';
  END IF;
  -- Do not wait while holding other source locks: existing writers may acquire row locks and
  -- multiple resource locks in their own domain order. False requires whole-transaction rollback.
  RETURN pg_try_advisory_xact_lock_shared(hashtextextended(
    jsonb_build_array('proofstack.policy-evaluation-source.v1', tenant, source_kind, source_id)::text,
    0
  ));
END;
$$;

CREATE FUNCTION public.proofstack_lock_policy_evaluation_source_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  resource_id text;
BEGIN
  IF TG_ARGV[0] = 'artifact' THEN
    resource_id := NEW.artifact_id;
  ELSE
    resource_id := NEW.policy_version_id;
  END IF;
  -- AFTER triggers preserve the existing domain validators' row-lock order. An uncommitted
  -- change is invisible to the reader and cannot commit until this exclusive lock is obtained.
  PERFORM pg_advisory_xact_lock(hashtextextended(
    jsonb_build_array(
      'proofstack.policy-evaluation-source.v1', NEW.tenant_id, TG_ARGV[0], resource_id
    )::text,
    0
  ));
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.proofstack_try_lock_policy_evaluation_source(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.proofstack_lock_policy_evaluation_source_write() FROM PUBLIC;

-- Existing append-only and forward-only guards reject deletes, identity changes, and reversal.
-- Inserts are deliberately included: FOR UPDATE cannot protect an absent catalog row/history.
CREATE TRIGGER proofstack_policy_evaluation_source_write_lock
  AFTER INSERT OR UPDATE ON public.proofstack_artifact_catalog
  FOR EACH ROW EXECUTE FUNCTION public.proofstack_lock_policy_evaluation_source_write('artifact');

CREATE TRIGGER proofstack_policy_evaluation_source_write_lock
  AFTER INSERT ON public.proofstack_interaction_fixture_artifact_ownerships
  FOR EACH ROW EXECUTE FUNCTION public.proofstack_lock_policy_evaluation_source_write('artifact');

CREATE TRIGGER proofstack_policy_evaluation_source_write_lock
  AFTER INSERT ON public.proofstack_release_policies
  FOR EACH ROW EXECUTE FUNCTION public.proofstack_lock_policy_evaluation_source_write('release_policy');

CREATE TRIGGER proofstack_policy_evaluation_source_write_lock
  AFTER INSERT ON public.proofstack_release_policy_lifecycle_events
  FOR EACH ROW EXECUTE FUNCTION public.proofstack_lock_policy_evaluation_source_write('release_policy');
