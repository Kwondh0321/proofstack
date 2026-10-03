-- Complete tenant metadata publication barrier. This is a transaction protocol, not a seal.
-- Every source writer participates, including creation of absent records and reverse lineage.
-- Writers share the tenant lock; a future publisher exclusively holds a short validation cut.
CREATE FUNCTION public.proofstack_try_lock_policy_evaluation_metadata()
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
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION USING ERRCODE = '0A000', MESSAGE = 'Metadata guards require READ COMMITTED';
  END IF;

  -- Match the migration runner's session lock, then the existing recovery procedure's lock.
  -- Never wait while holding job/source guards. Any false requires whole-transaction rollback.
  IF NOT pg_try_advisory_xact_lock_shared(1347579483, 1) THEN
    RETURN false;
  END IF;
  IF NOT pg_try_advisory_xact_lock_shared(hashtextextended('proofstack:replay-recovery-epoch', 0)) THEN
    RETURN false;
  END IF;
  RETURN pg_try_advisory_xact_lock(hashtextextended(
    jsonb_build_array('proofstack.policy-evaluation-metadata.v1', tenant)::text, 0
  ));
END;
$$;

CREATE FUNCTION public.proofstack_lock_policy_evaluation_metadata_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  identities text[];
  protected_tenant text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    identities := ARRAY[NEW.tenant_id];
  ELSIF TG_OP = 'DELETE' THEN
    identities := ARRAY[OLD.tenant_id];
  ELSE
    identities := ARRAY[OLD.tenant_id, NEW.tenant_id];
  END IF;
  FOR protected_tenant IN
    SELECT DISTINCT input.tenant_id COLLATE "C"
    FROM unnest(identities) AS input(tenant_id) ORDER BY 1
  LOOP
    -- AFTER row triggers preserve owning validation/row-lock order. A blocked uncommitted
    -- mutation is invisible and cannot commit while the publisher retains its exclusive lock.
    PERFORM pg_advisory_xact_lock_shared(hashtextextended(
      jsonb_build_array('proofstack.policy-evaluation-metadata.v1', protected_tenant)::text, 0
    ));
  END LOOP;
  RETURN NULL;
END;
$$;

CREATE FUNCTION public.proofstack_lock_policy_evaluation_recovery_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  -- BEFORE STATEMENT preserves the recovery procedure's advisory-before-row-lock order,
  -- including direct SQL. It is global because the epoch is a database-wide singleton.
  PERFORM pg_advisory_xact_lock(hashtextextended('proofstack:replay-recovery-epoch', 0));
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.proofstack_try_lock_policy_evaluation_metadata() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.proofstack_lock_policy_evaluation_metadata_write() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.proofstack_lock_policy_evaluation_recovery_write() FROM PUBLIC;

CREATE TRIGGER proofstack_policy_evaluation_recovery_write_lock
  BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON public.proofstack_recovery_state
  FOR EACH STATEMENT EXECUTE FUNCTION public.proofstack_lock_policy_evaluation_recovery_write();

-- Fixed inventory, not dynamic discovery of whatever tables happen to exist at runtime.
-- Parent triggers are cloned to all 33 record partitions, including direct child inserts.
-- Outbox intent presence is authoritative too; its delivery updates conservatively participate.
DO $$
DECLARE
  source_table text;
BEGIN
  FOREACH source_table IN ARRAY ARRAY[
    'proofstack_artifact_catalog',
    'proofstack_artifact_purge_receipts',
    'proofstack_artifact_tombstones',
    'proofstack_comparison_lineage',
    'proofstack_comparison_record_registry',
    'proofstack_comparison_records',
    'proofstack_comparison_resource_bindings',
    'proofstack_evaluation_lineage',
    'proofstack_evaluation_record_registry',
    'proofstack_evaluation_records',
    'proofstack_evaluation_resource_bindings',
    'proofstack_evaluation_unique_bindings',
    'proofstack_evidence_events',
    'proofstack_interaction_fixture_artifact_ownerships',
    'proofstack_interaction_fixture_content_revocations',
    'proofstack_model_assurance_records',
    'proofstack_outbox',
    'proofstack_recorded_interaction_fixture_versions',
    'proofstack_regression_dataset_members',
    'proofstack_regression_dataset_versions',
    'proofstack_regression_datasets',
    'proofstack_regression_fixture_events',
    'proofstack_regression_fixture_versions',
    'proofstack_regression_fixtures',
    'proofstack_release_candidate_lineage',
    'proofstack_release_candidate_registry',
    'proofstack_release_candidate_resources',
    'proofstack_release_candidates',
    'proofstack_release_policies',
    'proofstack_release_policy_lifecycle_events',
    'proofstack_release_policy_lineage',
    'proofstack_release_policy_registry',
    'proofstack_release_policy_resources',
    'proofstack_release_policy_rule_sources',
    'proofstack_release_policy_rules',
    'proofstack_release_policy_sources',
    'proofstack_replay_attempt_events',
    'proofstack_replay_attempts',
    'proofstack_replay_budget_entries',
    'proofstack_replay_budget_entry_dimensions',
    'proofstack_replay_cancellation_acknowledgements',
    'proofstack_replay_cancellation_requests',
    'proofstack_replay_jobs',
    'proofstack_replay_observations',
    'proofstack_replay_plan_boundaries',
    'proofstack_replay_plan_budgets',
    'proofstack_replay_plan_resources',
    'proofstack_replay_plans',
    'proofstack_replay_recovery_events',
    'proofstack_replay_targets',
    'proofstack_replay_usage_measurements',
    'proofstack_target_releases'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER proofstack_policy_evaluation_metadata_write_lock '
      'AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW '
      'EXECUTE FUNCTION public.proofstack_lock_policy_evaluation_metadata_write()',
      source_table
    );
  END LOOP;
END;
$$;
