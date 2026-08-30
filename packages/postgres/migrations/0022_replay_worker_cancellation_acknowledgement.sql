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
DECLARE
  acknowledgement_value jsonb;
  current_tenant_id text;
  now_lexical text;
  now_value timestamptz;
  stored_acknowledgement public.proofstack_replay_cancellation_acknowledgements%ROWTYPE;
  stored_job public.proofstack_replay_jobs%ROWTYPE;
  stored_request public.proofstack_replay_cancellation_requests%ROWTYPE;
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
    OR expected_acknowledgement_id IS NULL
    OR expected_acknowledgement_id !~ '^[a-z][a-z0-9_]{2,63}$'
    OR expected_action IS NULL
    OR expected_action NOT IN (
      'observed_after_uninterruptible_completion',
      'stop_requested',
      'stopped_before_target_start'
    )
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'Invalid replay cancellation acknowledgement input';
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

  now_value := transaction_timestamp();
  now_lexical := to_char(
    now_value AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
  );
  now_value := now_lexical::timestamptz;
  IF now_value < stored_job.current_lease_heartbeat_at THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'Replay cancellation acknowledgement server time moved backwards';
  END IF;
  IF now_value >= stored_job.current_lease_expires_at THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'Replay worker lease is expired';
  END IF;

  SELECT candidate.*
  INTO stored_request
  FROM public.proofstack_replay_cancellation_requests AS candidate
  WHERE candidate.tenant_id = current_tenant_id
    AND candidate.project_id = expected_project_id
    AND candidate.environment_id = expected_environment_id
    AND candidate.job_id = expected_job_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0002',
      MESSAGE = 'Replay cancellation request is unavailable';
  END IF;
  IF now_value < stored_request.requested_at THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'Replay cancellation acknowledgement precedes its request';
  END IF;

  SELECT candidate.*
  INTO stored_acknowledgement
  FROM public.proofstack_replay_cancellation_acknowledgements AS candidate
  WHERE candidate.tenant_id = current_tenant_id
    AND candidate.acknowledgement_id = expected_acknowledgement_id;
  IF FOUND THEN
    IF stored_acknowledgement.project_id IS DISTINCT FROM expected_project_id
      OR stored_acknowledgement.environment_id IS DISTINCT FROM expected_environment_id
      OR stored_acknowledgement.job_id IS DISTINCT FROM expected_job_id
      OR stored_acknowledgement.cancellation_id IS DISTINCT FROM stored_request.cancellation_id
      OR stored_acknowledgement.action IS DISTINCT FROM expected_action
      OR stored_acknowledgement.attempt_id IS DISTINCT FROM expected_attempt_id
      OR stored_acknowledgement.lease_id IS DISTINCT FROM expected_lease_id
      OR stored_acknowledgement.worker_id IS DISTINCT FROM expected_worker_id
      OR stored_acknowledgement.fencing_token IS DISTINCT FROM expected_fencing_token
      OR stored_acknowledgement.recovery_epoch IS DISTINCT FROM expected_recovery_epoch
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '23505',
        MESSAGE = 'Replay cancellation acknowledgement conflicts with its immutable identity';
    END IF;
    created := false;
    acknowledgement := stored_acknowledgement.acknowledgement;
    RETURN NEXT;
    RETURN;
  END IF;

  acknowledgement_value := jsonb_build_object(
    'acknowledgedAt', now_lexical,
    'acknowledgementId', expected_acknowledgement_id,
    'action', expected_action,
    'cancellationId', stored_request.cancellation_id,
    'mutationFence', jsonb_build_object(
      'attemptId', expected_attempt_id,
      'fencingToken', expected_fencing_token,
      'jobId', expected_job_id,
      'leaseId', expected_lease_id,
      'recoveryEpoch', expected_recovery_epoch,
      'workerId', expected_worker_id
    ),
    'schemaVersion', '0.1',
    'scope', stored_job.job -> 'scope'
  );

  INSERT INTO public.proofstack_replay_cancellation_acknowledgements (
    tenant_id,
    project_id,
    environment_id,
    job_id,
    cancellation_id,
    acknowledgement_id,
    schema_version,
    action,
    attempt_id,
    lease_id,
    worker_id,
    fencing_token,
    recovery_epoch,
    acknowledged_at,
    acknowledged_at_lexical,
    acknowledgement
  ) VALUES (
    current_tenant_id,
    expected_project_id,
    expected_environment_id,
    expected_job_id,
    stored_request.cancellation_id,
    expected_acknowledgement_id,
    '0.1',
    expected_action,
    expected_attempt_id,
    expected_lease_id,
    expected_worker_id,
    expected_fencing_token,
    expected_recovery_epoch,
    now_value,
    now_lexical,
    acknowledgement_value
  );

  created := true;
  acknowledgement := acknowledgement_value;
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.proofstack_acknowledge_replay_cancellation(
  text,
  text,
  text,
  text,
  text,
  text,
  bigint,
  bigint,
  text,
  text
) FROM PUBLIC;
