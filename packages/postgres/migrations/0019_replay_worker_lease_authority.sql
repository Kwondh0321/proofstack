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
  attempt_sequence_value bigint;
  attempt_value jsonb;
  current_tenant_id text;
  expires_at_lexical text;
  expires_at_value timestamptz;
  fencing_token_value bigint;
  fence_value jsonb;
  lease_value jsonb;
  next_job jsonb;
  next_state_version bigint;
  now_lexical text;
  now_value timestamptz;
  stored_job public.proofstack_replay_jobs%ROWTYPE;
  stored_plan public.proofstack_replay_plans%ROWTYPE;
BEGIN
  current_tenant_id := NULLIF(current_setting('proofstack.tenant_id', true), '');
  IF current_tenant_id IS NULL
    OR current_tenant_id !~ '^[a-z][a-z0-9_]{2,63}$'
    OR expected_project_id IS NULL
    OR expected_project_id !~ '^[a-z][a-z0-9_]{2,63}$'
    OR expected_environment_id IS NULL
    OR expected_environment_id !~ '^[a-z][a-z0-9_]{2,63}$'
    OR expected_job_id IS NULL
    OR expected_job_id !~ '^[a-z][a-z0-9_]{2,63}$'
    OR expected_attempt_id IS NULL
    OR expected_attempt_id !~ '^[a-z][a-z0-9_]{2,63}$'
    OR expected_lease_id IS NULL
    OR expected_lease_id !~ '^[a-z][a-z0-9_]{2,63}$'
    OR expected_worker_id IS NULL
    OR expected_worker_id !~ '^[a-z][a-z0-9_]{2,63}$'
    OR expected_worker_protocol_name IS NULL
    OR expected_worker_protocol_name !~ '^[A-Za-z0-9][A-Za-z0-9._+:/@-]{0,255}$'
    OR expected_worker_protocol_version IS NULL
    OR expected_worker_protocol_version !~ '^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$'
    OR expected_worker_build_sha256 IS NULL
    OR expected_worker_build_sha256 !~ '^[0-9a-f]{64}$'
    OR requested_lease_duration_milliseconds IS NULL
    OR requested_lease_duration_milliseconds NOT BETWEEN 1 AND 86400000
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'Invalid replay claim authority input';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    'proofstack:replay-job:' || current_tenant_id || ':' || expected_job_id,
    0
  ));
  SELECT candidate.*
  INTO stored_job
  FROM public.proofstack_replay_jobs AS candidate
  WHERE candidate.tenant_id = current_tenant_id
    AND candidate.project_id = expected_project_id
    AND candidate.environment_id = expected_environment_id
    AND candidate.job_id = expected_job_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0002',
      MESSAGE = 'Replay job is unavailable';
  END IF;

  SELECT candidate.*
  INTO stored_plan
  FROM public.proofstack_replay_plans AS candidate
  WHERE candidate.tenant_id = current_tenant_id
    AND candidate.project_id = stored_job.project_id
    AND candidate.environment_id = stored_job.environment_id
    AND candidate.plan_id = stored_job.plan_id
    AND candidate.plan_version_id = stored_job.plan_version_id
    AND candidate.definition_sha256 = stored_job.plan_definition_sha256;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23503',
      MESSAGE = 'Replay job has no exact published plan';
  END IF;
  IF stored_plan.worker_protocol_name IS DISTINCT FROM expected_worker_protocol_name
    OR stored_plan.worker_protocol_version IS DISTINCT FROM expected_worker_protocol_version
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Replay worker protocol does not match the published plan';
  END IF;
  IF requested_lease_duration_milliseconds >
    stored_plan.retry_per_attempt_timeout_milliseconds
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'Replay lease duration exceeds the published attempt timeout';
  END IF;
  IF stored_job.status <> 'queued' THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = CASE
        WHEN stored_job.status = 'running'
          THEN 'Replay job requires active or expired lease reconciliation'
        ELSE 'Replay job is not claimable'
      END;
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.proofstack_replay_attempts AS existing
    WHERE existing.tenant_id = current_tenant_id
      AND existing.attempt_id = expected_attempt_id
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23505',
      MESSAGE = 'Replay attempt identifier is already in use';
  END IF;
  IF stored_job.state_version >= 9007199254740991
    OR stored_job.last_fencing_token >= 9007199254740991
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '22003',
      MESSAGE = 'Replay job counter is exhausted';
  END IF;

  attempt_sequence_value := COALESCE(stored_job.latest_attempt_sequence, -1) + 1;
  IF attempt_sequence_value >= stored_plan.retry_max_attempts THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'Replay attempt limit is reached';
  END IF;
  fencing_token_value := stored_job.last_fencing_token + 1;
  next_state_version := stored_job.state_version + 1;
  now_value := transaction_timestamp();
  now_lexical := to_char(
    now_value AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
  );
  now_value := now_lexical::timestamptz;
  expires_at_value := now_value +
    (requested_lease_duration_milliseconds * interval '1 millisecond');
  expires_at_lexical := to_char(
    expires_at_value AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
  );
  expires_at_value := expires_at_lexical::timestamptz;
  fence_value := jsonb_build_object(
    'attemptId', expected_attempt_id,
    'fencingToken', fencing_token_value,
    'jobId', expected_job_id,
    'leaseId', expected_lease_id,
    'recoveryEpoch', stored_job.recovery_epoch,
    'workerId', expected_worker_id
  );
  lease_value := jsonb_build_object(
    'acquiredAt', now_lexical,
    'attemptSequence', attempt_sequence_value,
    'expiresAt', expires_at_lexical,
    'heartbeatAt', now_lexical,
    'mutationFence', fence_value,
    'schemaVersion', '0.1',
    'scope', stored_job.job -> 'scope'
  );
  attempt_value := jsonb_build_object(
    'attemptId', expected_attempt_id,
    'attemptSequence', attempt_sequence_value,
    'isolationProfile', stored_plan.plan -> 'isolationProfile',
    'jobId', expected_job_id,
    'mutationFence', fence_value,
    'plan', stored_job.job -> 'plan',
    'runtimeProfile', stored_plan.plan -> 'runtimeProfile',
    'schemaVersion', '0.1',
    'scope', stored_job.job -> 'scope',
    'startedAt', now_lexical,
    'status', 'running',
    'targetRelease', stored_plan.plan -> 'targetRelease',
    'workerBuildSha256', expected_worker_build_sha256,
    'workerProtocol', jsonb_build_object(
      'name', stored_plan.worker_protocol_name,
      'version', stored_plan.worker_protocol_version
    )
  );
  next_job := stored_job.job || jsonb_build_object(
    'currentLease', lease_value,
    'lastFencingToken', fencing_token_value,
    'latestAttemptSequence', attempt_sequence_value,
    'startedAt', now_lexical,
    'stateVersion', next_state_version,
    'status', 'running'
  );

  INSERT INTO public.proofstack_replay_attempts (
    tenant_id,
    project_id,
    environment_id,
    job_id,
    attempt_id,
    attempt_sequence,
    schema_version,
    status,
    lease_id,
    worker_id,
    fencing_token,
    recovery_epoch,
    plan_id,
    plan_version_id,
    plan_definition_sha256,
    target_id,
    target_release_id,
    target_definition_sha256,
    worker_protocol_name,
    worker_protocol_version,
    worker_build_sha256,
    started_at,
    started_at_lexical,
    attempt
  ) VALUES (
    current_tenant_id,
    stored_job.project_id,
    stored_job.environment_id,
    stored_job.job_id,
    expected_attempt_id,
    attempt_sequence_value,
    '0.1',
    'running',
    expected_lease_id,
    expected_worker_id,
    fencing_token_value,
    stored_job.recovery_epoch,
    stored_job.plan_id,
    stored_job.plan_version_id,
    stored_job.plan_definition_sha256,
    stored_plan.target_id,
    stored_plan.target_release_id,
    stored_plan.target_definition_sha256,
    stored_plan.worker_protocol_name,
    stored_plan.worker_protocol_version,
    expected_worker_build_sha256,
    now_value,
    now_lexical,
    attempt_value
  );

  PERFORM set_config('proofstack.replay_job_writer', 'stored-function-v1', true);
  UPDATE public.proofstack_replay_jobs
  SET status = 'running',
    state_version = next_state_version,
    latest_attempt_sequence = attempt_sequence_value,
    last_fencing_token = fencing_token_value,
    current_attempt_id = expected_attempt_id,
    current_lease_id = expected_lease_id,
    current_worker_id = expected_worker_id,
    current_fencing_token = fencing_token_value,
    current_attempt_sequence = attempt_sequence_value,
    current_lease_acquired_at = now_value,
    current_lease_acquired_at_lexical = now_lexical,
    current_lease_heartbeat_at = now_value,
    current_lease_heartbeat_at_lexical = now_lexical,
    current_lease_expires_at = expires_at_value,
    current_lease_expires_at_lexical = expires_at_lexical,
    started_at = now_value,
    started_at_lexical = now_lexical,
    job = next_job
  WHERE tenant_id = current_tenant_id
    AND job_id = expected_job_id
    AND state_version = stored_job.state_version;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'Replay job changed during claim';
  END IF;

  claimed := true;
  reason := NULL;
  job := next_job;
  attempt := attempt_value;
  worker_fence := fence_value;
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
DECLARE
  current_tenant_id text;
  expires_at_lexical text;
  expires_at_value timestamptz;
  next_job jsonb;
  next_lease jsonb;
  next_state_version bigint;
  now_lexical text;
  now_value timestamptz;
  stored_job public.proofstack_replay_jobs%ROWTYPE;
  stored_plan public.proofstack_replay_plans%ROWTYPE;
BEGIN
  current_tenant_id := NULLIF(current_setting('proofstack.tenant_id', true), '');
  IF current_tenant_id IS NULL
    OR current_tenant_id !~ '^[a-z][a-z0-9_]{2,63}$'
    OR expected_project_id IS NULL
    OR expected_project_id !~ '^[a-z][a-z0-9_]{2,63}$'
    OR expected_environment_id IS NULL
    OR expected_environment_id !~ '^[a-z][a-z0-9_]{2,63}$'
    OR expected_job_id IS NULL
    OR expected_job_id !~ '^[a-z][a-z0-9_]{2,63}$'
    OR expected_attempt_id IS NULL
    OR expected_attempt_id !~ '^[a-z][a-z0-9_]{2,63}$'
    OR expected_lease_id IS NULL
    OR expected_lease_id !~ '^[a-z][a-z0-9_]{2,63}$'
    OR expected_worker_id IS NULL
    OR expected_worker_id !~ '^[a-z][a-z0-9_]{2,63}$'
    OR expected_fencing_token IS NULL
    OR expected_fencing_token NOT BETWEEN 1 AND 9007199254740991
    OR expected_recovery_epoch IS NULL
    OR expected_recovery_epoch NOT BETWEEN 0 AND 9007199254740991
    OR requested_lease_duration_milliseconds IS NULL
    OR requested_lease_duration_milliseconds NOT BETWEEN 1 AND 86400000
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'Invalid replay heartbeat authority input';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    'proofstack:replay-job:' || current_tenant_id || ':' || expected_job_id,
    0
  ));
  SELECT candidate.*
  INTO stored_job
  FROM public.proofstack_replay_jobs AS candidate
  WHERE candidate.tenant_id = current_tenant_id
    AND candidate.project_id = expected_project_id
    AND candidate.environment_id = expected_environment_id
    AND candidate.job_id = expected_job_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0002',
      MESSAGE = 'Replay job is unavailable';
  END IF;
  IF stored_job.status <> 'running' THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'Replay job is not running';
  END IF;
  IF stored_job.current_attempt_id IS DISTINCT FROM expected_attempt_id
    OR stored_job.current_lease_id IS DISTINCT FROM expected_lease_id
    OR stored_job.current_worker_id IS DISTINCT FROM expected_worker_id
    OR stored_job.current_fencing_token IS DISTINCT FROM expected_fencing_token
    OR stored_job.recovery_epoch IS DISTINCT FROM expected_recovery_epoch
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'Replay worker mutation fence is stale';
  END IF;

  SELECT candidate.*
  INTO stored_plan
  FROM public.proofstack_replay_plans AS candidate
  WHERE candidate.tenant_id = current_tenant_id
    AND candidate.project_id = stored_job.project_id
    AND candidate.environment_id = stored_job.environment_id
    AND candidate.plan_id = stored_job.plan_id
    AND candidate.plan_version_id = stored_job.plan_version_id
    AND candidate.definition_sha256 = stored_job.plan_definition_sha256;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23503',
      MESSAGE = 'Replay job has no exact published plan';
  END IF;
  IF requested_lease_duration_milliseconds >
    stored_plan.retry_per_attempt_timeout_milliseconds
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'Replay lease duration exceeds the published attempt timeout';
  END IF;
  IF stored_job.state_version >= 9007199254740991 THEN
    RAISE EXCEPTION USING
      ERRCODE = '22003',
      MESSAGE = 'Replay job state version is exhausted';
  END IF;

  now_value := transaction_timestamp();
  now_lexical := to_char(
    now_value AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
  );
  now_value := now_lexical::timestamptz;
  IF now_value < stored_job.current_lease_heartbeat_at THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'Replay heartbeat server time moved backwards';
  END IF;
  IF now_value >= stored_job.current_lease_expires_at THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'Replay worker lease is expired';
  END IF;

  expires_at_value := now_value +
    (requested_lease_duration_milliseconds * interval '1 millisecond');
  expires_at_lexical := to_char(
    expires_at_value AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
  );
  expires_at_value := expires_at_lexical::timestamptz;
  next_state_version := stored_job.state_version + 1;
  next_lease := (stored_job.job -> 'currentLease') || jsonb_build_object(
    'expiresAt', expires_at_lexical,
    'heartbeatAt', now_lexical
  );
  next_job := stored_job.job || jsonb_build_object(
    'currentLease', next_lease,
    'stateVersion', next_state_version
  );

  PERFORM set_config('proofstack.replay_job_writer', 'stored-function-v1', true);
  UPDATE public.proofstack_replay_jobs
  SET state_version = next_state_version,
    current_lease_heartbeat_at = now_value,
    current_lease_heartbeat_at_lexical = now_lexical,
    current_lease_expires_at = expires_at_value,
    current_lease_expires_at_lexical = expires_at_lexical,
    job = next_job
  WHERE tenant_id = current_tenant_id
    AND job_id = expected_job_id
    AND state_version = stored_job.state_version;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'Replay job changed during heartbeat';
  END IF;

  RETURN next_job;
END;
$$;

REVOKE ALL ON FUNCTION public.proofstack_claim_replay_job(
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  bigint
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.proofstack_heartbeat_replay_job(
  text,
  text,
  text,
  text,
  text,
  text,
  bigint,
  bigint,
  bigint
) FROM PUBLIC;
