CREATE TABLE public.proofstack_recovery_state (
  singleton boolean PRIMARY KEY DEFAULT true,
  recovery_epoch bigint NOT NULL,
  advanced_at timestamptz NOT NULL,
  advanced_at_lexical text NOT NULL,

  CONSTRAINT proofstack_recovery_state_singleton CHECK (singleton),
  CONSTRAINT proofstack_recovery_state_epoch CHECK (
    recovery_epoch BETWEEN 0 AND 9007199254740991
  ),
  CONSTRAINT proofstack_recovery_state_time CHECK (
    isfinite(advanced_at)
    AND advanced_at_lexical ~
      '^[0-9]{4}-(0[1-9]|1[0-2])-([0-2][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\.[0-9]{3}Z$'
    AND advanced_at_lexical !~ '^0000-'
    AND advanced_at = advanced_at_lexical::timestamptz
  )
);

INSERT INTO public.proofstack_recovery_state (
  singleton,
  recovery_epoch,
  advanced_at,
  advanced_at_lexical
)
SELECT
  true,
  0,
  migration_time.instant,
  migration_time.lexical
FROM (
  SELECT
    to_char(
      transaction_timestamp() AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    ) AS lexical,
    to_char(
      transaction_timestamp() AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    )::timestamptz AS instant
) AS migration_time;

REVOKE ALL ON TABLE public.proofstack_recovery_state FROM PUBLIC;

CREATE TABLE public.proofstack_replay_recovery_events (
  recovery_epoch bigint NOT NULL,
  tenant_id varchar(64) NOT NULL,
  project_id varchar(64) NOT NULL,
  environment_id varchar(64) NOT NULL,
  job_id varchar(64) NOT NULL,
  previous_recovery_epoch bigint NOT NULL,
  previous_state_version bigint NOT NULL,
  previous_status varchar(32) NOT NULL,
  previous_lease jsonb,
  invalidated_at timestamptz NOT NULL,
  invalidated_at_lexical text NOT NULL,
  event jsonb NOT NULL,

  CONSTRAINT proofstack_replay_recovery_events_pk PRIMARY KEY (
    recovery_epoch,
    tenant_id,
    job_id
  ),
  CONSTRAINT proofstack_replay_recovery_events_job_fk FOREIGN KEY (
    tenant_id,
    project_id,
    environment_id,
    job_id
  ) REFERENCES public.proofstack_replay_jobs (
    tenant_id,
    project_id,
    environment_id,
    job_id
  ),
  CONSTRAINT proofstack_replay_recovery_events_scope CHECK (
    tenant_id ~ '^[a-z][a-z0-9_]{2,63}$'
    AND project_id ~ '^[a-z][a-z0-9_]{2,63}$'
    AND environment_id ~ '^[a-z][a-z0-9_]{2,63}$'
    AND job_id ~ '^[a-z][a-z0-9_]{2,63}$'
  ),
  CONSTRAINT proofstack_replay_recovery_events_counters CHECK (
    recovery_epoch BETWEEN 1 AND 9007199254740991
    AND previous_recovery_epoch BETWEEN 0 AND 9007199254740991
    AND previous_recovery_epoch < recovery_epoch
    AND previous_state_version BETWEEN 1 AND 9007199254740991
  ),
  CONSTRAINT proofstack_replay_recovery_events_status CHECK (
    previous_status IN ('queued', 'running')
    AND (
      (previous_status = 'queued' AND previous_lease IS NULL)
      OR (previous_status = 'running' AND jsonb_typeof(previous_lease) = 'object')
    )
  ),
  CONSTRAINT proofstack_replay_recovery_events_time CHECK (
    isfinite(invalidated_at)
    AND invalidated_at_lexical ~
      '^[0-9]{4}-(0[1-9]|1[0-2])-([0-2][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\.[0-9]{3}Z$'
    AND invalidated_at_lexical !~ '^0000-'
    AND invalidated_at = invalidated_at_lexical::timestamptz
  ),
  CONSTRAINT proofstack_replay_recovery_events_payload CHECK (
    (
      jsonb_typeof(event) = 'object'
      AND (event ->> 'recoveryEpoch')::bigint = recovery_epoch
      AND event ->> 'jobId' = job_id
      AND (event ->> 'previousRecoveryEpoch')::bigint = previous_recovery_epoch
      AND (event ->> 'previousStateVersion')::bigint = previous_state_version
      AND event ->> 'previousStatus' = previous_status
      AND (
        (previous_lease IS NULL AND event -> 'previousLease' = 'null'::jsonb)
        OR event -> 'previousLease' = previous_lease
      )
      AND event ->> 'invalidatedAt' = invalidated_at_lexical
      AND event #>> '{scope,tenantId}' = tenant_id
      AND event #>> '{scope,projectId}' = project_id
      AND event #>> '{scope,environmentId}' = environment_id
      AND pg_column_size(event) <= 262144
    ) IS TRUE
  )
);

ALTER TABLE public.proofstack_replay_recovery_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.proofstack_replay_recovery_events FORCE ROW LEVEL SECURITY;

CREATE POLICY proofstack_replay_recovery_events_tenant_select
  ON public.proofstack_replay_recovery_events
  FOR SELECT
  USING (
    tenant_id = NULLIF(current_setting('proofstack.tenant_id', true), '')
  );

CREATE TRIGGER proofstack_replay_recovery_events_append_only
  BEFORE UPDATE OR DELETE ON public.proofstack_replay_recovery_events
  FOR EACH ROW
  EXECUTE FUNCTION public.proofstack_reject_append_only_mutation();

REVOKE ALL ON TABLE public.proofstack_replay_recovery_events FROM PUBLIC;

CREATE FUNCTION public.proofstack_current_replay_recovery_epoch()
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT recovery_epoch
  FROM public.proofstack_recovery_state
  WHERE singleton = true
$$;

REVOKE ALL ON FUNCTION public.proofstack_current_replay_recovery_epoch() FROM PUBLIC;

CREATE FUNCTION public.proofstack_assert_current_replay_recovery_epoch(
  expected_recovery_epoch bigint
)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  current_epoch bigint;
BEGIN
  SELECT public.proofstack_current_replay_recovery_epoch()
  INTO current_epoch;
  IF expected_recovery_epoch IS NULL
    OR expected_recovery_epoch NOT BETWEEN 0 AND 9007199254740991
    OR current_epoch IS NULL
    OR expected_recovery_epoch IS DISTINCT FROM current_epoch
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'Replay worker recovery epoch is stale';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.proofstack_assert_current_replay_recovery_epoch(bigint)
  FROM PUBLIC;

CREATE FUNCTION public.proofstack_apply_replay_recovery_epoch_to_job()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  target_epoch bigint;
  target_text text;
BEGIN
  target_text := NULLIF(
    current_setting('proofstack.replay_recovery_target_epoch', true),
    ''
  );
  IF target_text IS NULL THEN
    RETURN NEW;
  END IF;
  IF target_text !~ '^[0-9]{1,16}$' THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'Replay recovery target epoch is invalid';
  END IF;
  target_epoch := target_text::bigint;
  IF target_epoch NOT BETWEEN 0 AND 9007199254740991
    OR NEW.recovery_epoch > target_epoch
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'Replay job recovery epoch cannot move backward';
  END IF;
  IF NEW.recovery_epoch = target_epoch OR NEW.status NOT IN ('queued', 'running') THEN
    RETURN NEW;
  END IF;

  NEW.recovery_epoch := target_epoch;
  NEW.job := jsonb_set(
    NEW.job,
    '{recoveryEpoch}',
    to_jsonb(target_epoch),
    false
  );
  IF NEW.status = 'running' THEN
    NEW.job := jsonb_set(
      NEW.job,
      '{currentLease,mutationFence,recoveryEpoch}',
      to_jsonb(target_epoch),
      false
    );
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.proofstack_apply_replay_recovery_epoch_to_job()
  FROM PUBLIC;

CREATE TRIGGER proofstack_replay_jobs_a_apply_recovery_epoch
  BEFORE INSERT OR UPDATE ON public.proofstack_replay_jobs
  FOR EACH ROW
  EXECUTE FUNCTION public.proofstack_apply_replay_recovery_epoch_to_job();

CREATE FUNCTION public.proofstack_apply_replay_recovery_epoch_to_attempt()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  target_epoch bigint;
  target_text text;
BEGIN
  target_text := NULLIF(
    current_setting('proofstack.replay_recovery_target_epoch', true),
    ''
  );
  IF target_text IS NULL THEN
    RETURN NEW;
  END IF;
  IF target_text !~ '^[0-9]{1,16}$' THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'Replay recovery target epoch is invalid';
  END IF;
  target_epoch := target_text::bigint;
  IF target_epoch NOT BETWEEN 0 AND 9007199254740991
    OR NEW.recovery_epoch > target_epoch
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'Replay attempt recovery epoch cannot move backward';
  END IF;
  IF NEW.recovery_epoch = target_epoch THEN
    RETURN NEW;
  END IF;

  NEW.recovery_epoch := target_epoch;
  NEW.attempt := jsonb_set(
    NEW.attempt,
    '{mutationFence,recoveryEpoch}',
    to_jsonb(target_epoch),
    false
  );
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.proofstack_apply_replay_recovery_epoch_to_attempt()
  FROM PUBLIC;

CREATE TRIGGER proofstack_replay_attempts_apply_recovery_epoch
  BEFORE INSERT ON public.proofstack_replay_attempts
  FOR EACH ROW
  EXECUTE FUNCTION public.proofstack_apply_replay_recovery_epoch_to_attempt();

CREATE FUNCTION public.proofstack_begin_replay_recovery()
RETURNS TABLE(
  source_recovery_epoch bigint,
  next_recovery_epoch bigint,
  queued_job_count bigint,
  running_job_count bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  acquired_at_lexical text;
  acquired_at_value timestamptz;
  heartbeat_at_lexical text;
  heartbeat_at_value timestamptz;
  invalidated_at_lexical text;
  invalidated_at_value timestamptz;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'proofstack:replay-recovery-epoch',
    0
  ));
  SELECT state.recovery_epoch
  INTO source_recovery_epoch
  FROM public.proofstack_recovery_state AS state
  WHERE state.singleton = true
  FOR UPDATE;
  IF NOT FOUND OR source_recovery_epoch NOT BETWEEN 0 AND 9007199254740990 THEN
    RAISE EXCEPTION USING
      ERRCODE = '22003',
      MESSAGE = 'Replay recovery epoch is unavailable or exhausted';
  END IF;
  next_recovery_epoch := source_recovery_epoch + 1;
  invalidated_at_lexical := to_char(
    transaction_timestamp() AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
  );
  invalidated_at_value := invalidated_at_lexical::timestamptz;
  heartbeat_at_value := invalidated_at_value - interval '1 millisecond';
  heartbeat_at_lexical := to_char(
    heartbeat_at_value AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
  );
  heartbeat_at_value := heartbeat_at_lexical::timestamptz;
  acquired_at_value := invalidated_at_value - interval '2 milliseconds';
  acquired_at_lexical := to_char(
    acquired_at_value AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
  );
  acquired_at_value := acquired_at_lexical::timestamptz;

  IF EXISTS (
    SELECT 1
    FROM public.proofstack_replay_jobs AS job
    WHERE job.status IN ('queued', 'running')
      AND (
        job.recovery_epoch > source_recovery_epoch
        OR job.state_version >= 9007199254740991
      )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'Replay jobs cannot enter the next recovery epoch safely';
  END IF;

  SELECT
    count(*) FILTER (WHERE job.status = 'queued'),
    count(*) FILTER (WHERE job.status = 'running')
  INTO queued_job_count, running_job_count
  FROM public.proofstack_replay_jobs AS job
  WHERE job.status IN ('queued', 'running');

  INSERT INTO public.proofstack_replay_recovery_events (
    recovery_epoch,
    tenant_id,
    project_id,
    environment_id,
    job_id,
    previous_recovery_epoch,
    previous_state_version,
    previous_status,
    previous_lease,
    invalidated_at,
    invalidated_at_lexical,
    event
  )
  SELECT
    next_recovery_epoch,
    job.tenant_id,
    job.project_id,
    job.environment_id,
    job.job_id,
    job.recovery_epoch,
    job.state_version,
    job.status,
    job.job -> 'currentLease',
    invalidated_at_value,
    invalidated_at_lexical,
    jsonb_build_object(
      'invalidatedAt', invalidated_at_lexical,
      'jobId', job.job_id,
      'previousLease', COALESCE(job.job -> 'currentLease', 'null'::jsonb),
      'previousRecoveryEpoch', job.recovery_epoch,
      'previousStateVersion', job.state_version,
      'previousStatus', job.status,
      'recoveryEpoch', next_recovery_epoch,
      'scope', jsonb_build_object(
        'environmentId', job.environment_id,
        'projectId', job.project_id,
        'tenantId', job.tenant_id
      )
    )
  FROM public.proofstack_replay_jobs AS job
  WHERE job.status IN ('queued', 'running');

  PERFORM set_config('proofstack.replay_job_writer', 'stored-function-v1', true);
  UPDATE public.proofstack_replay_jobs AS job
  SET state_version = job.state_version + 1,
    recovery_epoch = next_recovery_epoch,
    job = jsonb_set(
      jsonb_set(
        job.job,
        '{stateVersion}',
        to_jsonb(job.state_version + 1),
        false
      ),
      '{recoveryEpoch}',
      to_jsonb(next_recovery_epoch),
      false
    )
  WHERE job.status = 'queued';

  UPDATE public.proofstack_replay_jobs AS job
  SET state_version = job.state_version + 1,
    current_lease_acquired_at = acquired_at_value,
    current_lease_acquired_at_lexical = acquired_at_lexical,
    current_lease_heartbeat_at = heartbeat_at_value,
    current_lease_heartbeat_at_lexical = heartbeat_at_lexical,
    current_lease_expires_at = invalidated_at_value,
    current_lease_expires_at_lexical = invalidated_at_lexical,
    job = jsonb_set(
      jsonb_set(
        jsonb_set(
          jsonb_set(
            job.job,
            '{stateVersion}',
            to_jsonb(job.state_version + 1),
            false
          ),
          '{currentLease,acquiredAt}',
          to_jsonb(acquired_at_lexical),
          false
        ),
        '{currentLease,heartbeatAt}',
        to_jsonb(heartbeat_at_lexical),
        false
      ),
      '{currentLease,expiresAt}',
      to_jsonb(invalidated_at_lexical),
      false
    )
  WHERE job.status = 'running';

  UPDATE public.proofstack_recovery_state AS state
  SET recovery_epoch = next_recovery_epoch,
    advanced_at = invalidated_at_value,
    advanced_at_lexical = invalidated_at_lexical
  WHERE state.singleton = true;

  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.proofstack_begin_replay_recovery() FROM PUBLIC;

ALTER FUNCTION public.proofstack_create_replay_job(
  text, text, text, text, text, text, text
) RENAME TO proofstack_create_replay_job_before_recovery_epoch;
ALTER FUNCTION public.proofstack_claim_replay_job(
  text, text, text, text, text, text, text, text, text, bigint
) RENAME TO proofstack_claim_replay_job_before_recovery_epoch;
ALTER FUNCTION public.proofstack_heartbeat_replay_job(
  text, text, text, text, text, text, bigint, bigint, bigint
) RENAME TO proofstack_heartbeat_replay_job_before_recovery_epoch;
ALTER FUNCTION public.proofstack_acknowledge_replay_cancellation(
  text, text, text, text, text, text, bigint, bigint, text, text
) RENAME TO proofstack_acknowledge_replay_cancellation_before_recovery_epoch;
ALTER FUNCTION public.proofstack_reserve_replay_budget(
  text, text, text, text, text, text, bigint, bigint, text, jsonb, jsonb
) RENAME TO proofstack_reserve_replay_budget_before_recovery_epoch;
ALTER FUNCTION public.proofstack_reconcile_replay_budget(
  text, text, text, text, text, text, bigint, bigint, text, text, jsonb
) RENAME TO proofstack_reconcile_replay_budget_before_recovery_epoch;
ALTER FUNCTION public.proofstack_append_replay_execution_observation(
  text, text, text, text, text, text, bigint, bigint, text, jsonb
) RENAME TO proofstack_append_replay_execution_observation_before_recovery_epoch;
ALTER FUNCTION public.proofstack_append_replay_usage_observation(
  text, text, text, text, text, text, bigint, bigint, text, text, text, jsonb
) RENAME TO proofstack_append_replay_usage_observation_before_recovery_epoch;
ALTER FUNCTION public.proofstack_complete_replay_job(
  text, text, text, text, text, text, bigint, bigint, text, text, jsonb, jsonb
) RENAME TO proofstack_complete_replay_job_before_recovery_epoch;

CREATE FUNCTION public.proofstack_create_replay_job(
  expected_project_id text,
  expected_environment_id text,
  expected_job_id text,
  expected_plan_id text,
  expected_plan_version_id text,
  expected_plan_definition_sha256 text,
  expected_created_by_principal_id text
)
RETURNS TABLE(created boolean, job jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  current_epoch bigint;
  legacy_row record;
BEGIN
  SELECT public.proofstack_current_replay_recovery_epoch()
  INTO current_epoch;
  IF current_epoch IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'Replay recovery epoch is unavailable';
  END IF;
  PERFORM set_config(
    'proofstack.replay_recovery_target_epoch',
    current_epoch::text,
    true
  );
  SELECT *
  INTO legacy_row
  FROM public.proofstack_create_replay_job_before_recovery_epoch(
    expected_project_id,
    expected_environment_id,
    expected_job_id,
    expected_plan_id,
    expected_plan_version_id,
    expected_plan_definition_sha256,
    expected_created_by_principal_id
  );
  IF legacy_row.job ->> 'status' = 'queued' THEN
    legacy_row.job := jsonb_set(
      legacy_row.job,
      '{recoveryEpoch}',
      to_jsonb(current_epoch),
      false
    );
  END IF;
  created := legacy_row.created;
  job := legacy_row.job;
  RETURN NEXT;
END;
$$;

CREATE FUNCTION public.proofstack_claim_replay_job(
  expected_project_id text,
  expected_environment_id text,
  expected_job_id text,
  expected_attempt_id text,
  expected_lease_id text,
  expected_worker_id text,
  expected_worker_protocol_name text,
  expected_worker_protocol_version text,
  expected_worker_build_sha256 text,
  requested_lease_duration_milliseconds bigint
)
RETURNS TABLE(
  claimed boolean,
  reason text,
  job jsonb,
  attempt jsonb,
  worker_fence jsonb
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  current_epoch bigint;
  legacy_row record;
BEGIN
  SELECT public.proofstack_current_replay_recovery_epoch()
  INTO current_epoch;
  IF current_epoch IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'Replay recovery epoch is unavailable';
  END IF;
  PERFORM set_config(
    'proofstack.replay_recovery_target_epoch',
    current_epoch::text,
    true
  );
  SELECT *
  INTO legacy_row
  FROM public.proofstack_claim_replay_job_before_recovery_epoch(
    expected_project_id,
    expected_environment_id,
    expected_job_id,
    expected_attempt_id,
    expected_lease_id,
    expected_worker_id,
    expected_worker_protocol_name,
    expected_worker_protocol_version,
    expected_worker_build_sha256,
    requested_lease_duration_milliseconds
  );
  IF legacy_row.claimed THEN
    IF (legacy_row.job ->> 'recoveryEpoch')::bigint > current_epoch THEN
      RAISE EXCEPTION USING
        ERRCODE = '55000',
        MESSAGE = 'Replay job recovery epoch is ahead of the installation';
    END IF;
    legacy_row.job := jsonb_set(
      jsonb_set(
        legacy_row.job,
        '{recoveryEpoch}',
        to_jsonb(current_epoch),
        false
      ),
      '{currentLease,mutationFence,recoveryEpoch}',
      to_jsonb(current_epoch),
      false
    );
    legacy_row.attempt := jsonb_set(
      legacy_row.attempt,
      '{mutationFence,recoveryEpoch}',
      to_jsonb(current_epoch),
      false
    );
    legacy_row.worker_fence := jsonb_set(
      legacy_row.worker_fence,
      '{recoveryEpoch}',
      to_jsonb(current_epoch),
      false
    );
  END IF;
  claimed := legacy_row.claimed;
  reason := legacy_row.reason;
  job := legacy_row.job;
  attempt := legacy_row.attempt;
  worker_fence := legacy_row.worker_fence;
  RETURN NEXT;
END;
$$;

CREATE FUNCTION public.proofstack_heartbeat_replay_job(
  expected_project_id text,
  expected_environment_id text,
  expected_job_id text,
  expected_attempt_id text,
  expected_lease_id text,
  expected_worker_id text,
  expected_fencing_token bigint,
  expected_recovery_epoch bigint,
  requested_lease_duration_milliseconds bigint
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  PERFORM public.proofstack_assert_current_replay_recovery_epoch(
    expected_recovery_epoch
  );
  RETURN public.proofstack_heartbeat_replay_job_before_recovery_epoch(
    expected_project_id,
    expected_environment_id,
    expected_job_id,
    expected_attempt_id,
    expected_lease_id,
    expected_worker_id,
    expected_fencing_token,
    expected_recovery_epoch,
    requested_lease_duration_milliseconds
  );
END;
$$;

CREATE FUNCTION public.proofstack_acknowledge_replay_cancellation(
  expected_project_id text,
  expected_environment_id text,
  expected_job_id text,
  expected_attempt_id text,
  expected_lease_id text,
  expected_worker_id text,
  expected_fencing_token bigint,
  expected_recovery_epoch bigint,
  expected_acknowledgement_id text,
  expected_action text
)
RETURNS TABLE(created boolean, acknowledgement jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  PERFORM public.proofstack_assert_current_replay_recovery_epoch(
    expected_recovery_epoch
  );
  RETURN QUERY
  SELECT *
  FROM public.proofstack_acknowledge_replay_cancellation_before_recovery_epoch(
    expected_project_id,
    expected_environment_id,
    expected_job_id,
    expected_attempt_id,
    expected_lease_id,
    expected_worker_id,
    expected_fencing_token,
    expected_recovery_epoch,
    expected_acknowledgement_id,
    expected_action
  );
END;
$$;

CREATE FUNCTION public.proofstack_reserve_replay_budget(
  expected_project_id text,
  expected_environment_id text,
  expected_job_id text,
  expected_attempt_id text,
  expected_lease_id text,
  expected_worker_id text,
  expected_fencing_token bigint,
  expected_recovery_epoch bigint,
  expected_reservation_id text,
  expected_work jsonb,
  expected_requested_amounts jsonb
)
RETURNS TABLE(created boolean, reservation jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  PERFORM public.proofstack_assert_current_replay_recovery_epoch(
    expected_recovery_epoch
  );
  RETURN QUERY
  SELECT *
  FROM public.proofstack_reserve_replay_budget_before_recovery_epoch(
    expected_project_id,
    expected_environment_id,
    expected_job_id,
    expected_attempt_id,
    expected_lease_id,
    expected_worker_id,
    expected_fencing_token,
    expected_recovery_epoch,
    expected_reservation_id,
    expected_work,
    expected_requested_amounts
  );
END;
$$;

CREATE FUNCTION public.proofstack_reconcile_replay_budget(
  expected_project_id text,
  expected_environment_id text,
  expected_job_id text,
  expected_attempt_id text,
  expected_lease_id text,
  expected_worker_id text,
  expected_fencing_token bigint,
  expected_recovery_epoch bigint,
  expected_reconciliation_id text,
  expected_reservation_id text,
  expected_usage jsonb
)
RETURNS TABLE(created boolean, reconciliation jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  PERFORM public.proofstack_assert_current_replay_recovery_epoch(
    expected_recovery_epoch
  );
  RETURN QUERY
  SELECT *
  FROM public.proofstack_reconcile_replay_budget_before_recovery_epoch(
    expected_project_id,
    expected_environment_id,
    expected_job_id,
    expected_attempt_id,
    expected_lease_id,
    expected_worker_id,
    expected_fencing_token,
    expected_recovery_epoch,
    expected_reconciliation_id,
    expected_reservation_id,
    expected_usage
  );
END;
$$;

CREATE FUNCTION public.proofstack_append_replay_execution_observation(
  expected_project_id text,
  expected_environment_id text,
  expected_job_id text,
  expected_attempt_id text,
  expected_lease_id text,
  expected_worker_id text,
  expected_fencing_token bigint,
  expected_recovery_epoch bigint,
  expected_observation_id text,
  expected_payload jsonb
)
RETURNS TABLE(created boolean, observation jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  PERFORM public.proofstack_assert_current_replay_recovery_epoch(
    expected_recovery_epoch
  );
  RETURN QUERY
  SELECT *
  FROM public.proofstack_append_replay_execution_observation_before_recovery_epoch(
    expected_project_id,
    expected_environment_id,
    expected_job_id,
    expected_attempt_id,
    expected_lease_id,
    expected_worker_id,
    expected_fencing_token,
    expected_recovery_epoch,
    expected_observation_id,
    expected_payload
  );
END;
$$;

CREATE FUNCTION public.proofstack_append_replay_usage_observation(
  expected_project_id text,
  expected_environment_id text,
  expected_job_id text,
  expected_attempt_id text,
  expected_lease_id text,
  expected_worker_id text,
  expected_fencing_token bigint,
  expected_recovery_epoch bigint,
  expected_observation_id text,
  expected_boundary_id text,
  expected_source_event_sha256 text,
  expected_measurements jsonb
)
RETURNS TABLE(created boolean, observation jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  PERFORM public.proofstack_assert_current_replay_recovery_epoch(
    expected_recovery_epoch
  );
  RETURN QUERY
  SELECT *
  FROM public.proofstack_append_replay_usage_observation_before_recovery_epoch(
    expected_project_id,
    expected_environment_id,
    expected_job_id,
    expected_attempt_id,
    expected_lease_id,
    expected_worker_id,
    expected_fencing_token,
    expected_recovery_epoch,
    expected_observation_id,
    expected_boundary_id,
    expected_source_event_sha256,
    expected_measurements
  );
END;
$$;

CREATE FUNCTION public.proofstack_complete_replay_job(
  expected_project_id text,
  expected_environment_id text,
  expected_job_id text,
  expected_attempt_id text,
  expected_lease_id text,
  expected_worker_id text,
  expected_fencing_token bigint,
  expected_recovery_epoch bigint,
  expected_status text,
  expected_code text,
  expected_error jsonb,
  expected_result jsonb
)
RETURNS TABLE(job jsonb, attempt jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  PERFORM public.proofstack_assert_current_replay_recovery_epoch(
    expected_recovery_epoch
  );
  RETURN QUERY
  SELECT *
  FROM public.proofstack_complete_replay_job_before_recovery_epoch(
    expected_project_id,
    expected_environment_id,
    expected_job_id,
    expected_attempt_id,
    expected_lease_id,
    expected_worker_id,
    expected_fencing_token,
    expected_recovery_epoch,
    expected_status,
    expected_code,
    expected_error,
    expected_result
  );
END;
$$;

REVOKE ALL ON FUNCTION public.proofstack_create_replay_job(
  text, text, text, text, text, text, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.proofstack_claim_replay_job(
  text, text, text, text, text, text, text, text, text, bigint
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.proofstack_heartbeat_replay_job(
  text, text, text, text, text, text, bigint, bigint, bigint
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.proofstack_acknowledge_replay_cancellation(
  text, text, text, text, text, text, bigint, bigint, text, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.proofstack_reserve_replay_budget(
  text, text, text, text, text, text, bigint, bigint, text, jsonb, jsonb
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.proofstack_reconcile_replay_budget(
  text, text, text, text, text, text, bigint, bigint, text, text, jsonb
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.proofstack_append_replay_execution_observation(
  text, text, text, text, text, text, bigint, bigint, text, jsonb
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.proofstack_append_replay_usage_observation(
  text, text, text, text, text, text, bigint, bigint, text, text, text, jsonb
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.proofstack_complete_replay_job(
  text, text, text, text, text, text, bigint, bigint, text, text, jsonb, jsonb
) FROM PUBLIC;

DO $$
DECLARE
  legacy_function record;
  role_record record;
BEGIN
  FOR legacy_function IN
    SELECT
      routine.oid,
      routine.oid::regprocedure AS identity,
      to_regprocedure(replace(
        routine.oid::regprocedure::text,
        '_before_recovery_epoch',
        ''
      )) AS wrapper_identity
    FROM pg_proc AS routine
    JOIN pg_namespace AS namespace ON namespace.oid = routine.pronamespace
    WHERE namespace.nspname = 'public'
      AND routine.proname = ANY (ARRAY[
        'proofstack_create_replay_job_before_recovery_epoch',
        'proofstack_claim_replay_job_before_recovery_epoch',
        'proofstack_heartbeat_replay_job_before_recovery_epoch',
        'proofstack_acknowledge_replay_cancellation_before_recovery_epoch',
        'proofstack_reserve_replay_budget_before_recovery_epoch',
        'proofstack_reconcile_replay_budget_before_recovery_epoch',
        'proofstack_append_replay_execution_observation_before_recovery_epoch',
        'proofstack_append_replay_usage_observation_before_recovery_epoch',
        'proofstack_complete_replay_job_before_recovery_epoch'
      ])
  LOOP
    IF legacy_function.wrapper_identity IS NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '55000',
        MESSAGE = 'Replay recovery wrapper function is unavailable';
    END IF;
    FOR role_record IN
      SELECT privilege.grantee, role.rolname
      FROM aclexplode(
        COALESCE(
          (SELECT proacl FROM pg_proc WHERE oid = legacy_function.oid),
          acldefault('f', (SELECT proowner FROM pg_proc WHERE oid = legacy_function.oid))
        )
      ) AS privilege
      LEFT JOIN pg_roles AS role ON role.oid = privilege.grantee
      WHERE privilege.privilege_type = 'EXECUTE'
        AND privilege.grantee IS DISTINCT FROM (
          SELECT proowner FROM pg_proc WHERE oid = legacy_function.oid
        )
    LOOP
      IF role_record.grantee = 0 THEN
        EXECUTE format(
          'REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC',
          legacy_function.identity
        );
      ELSE
        EXECUTE format(
          'GRANT EXECUTE ON FUNCTION %s TO %I',
          legacy_function.wrapper_identity,
          role_record.rolname
        );
        EXECUTE format(
          'REVOKE EXECUTE ON FUNCTION %s FROM %I',
          legacy_function.identity,
          role_record.rolname
        );
      END IF;
    END LOOP;
  END LOOP;
END;
$$;
