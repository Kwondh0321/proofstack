CREATE OR REPLACE FUNCTION public.proofstack_claim_replay_job(
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
  backoff_delay_milliseconds bigint;
  backoff_step integer;
  cancellation_requested boolean;
  current_tenant_id text;
  effect_certainty_value text;
  effect_retry_safety_kind_value text;
  error_value jsonb;
  expires_at_lexical text;
  expires_at_value timestamptz;
  expired_attempt_value jsonb;
  fencing_token_value bigint;
  fence_value jsonb;
  has_open_reservation boolean;
  lease_value jsonb;
  live_boundary_count bigint;
  non_read_only_live_boundary_count bigint;
  next_attempt_completes_at timestamptz;
  next_job jsonb;
  next_state_version bigint;
  not_before_value timestamptz;
  now_lexical text;
  now_value timestamptz;
  retry_block_reason text;
  retry_eligible boolean;
  started_at_lexical_value text;
  started_at_value timestamptz;
  stored_attempt public.proofstack_replay_attempts%ROWTYPE;
  stored_job public.proofstack_replay_jobs%ROWTYPE;
  stored_plan public.proofstack_replay_plans%ROWTYPE;
  terminal_code_value text;
  terminal_intent_payload jsonb;
  terminal_status_value text;
  total_boundary_count bigint;
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

  IF stored_job.status NOT IN ('queued', 'running') THEN
    IF stored_job.terminal_attempt_id IS NOT NULL THEN
      SELECT candidate.*
      INTO stored_attempt
      FROM public.proofstack_replay_attempts AS candidate
      WHERE candidate.tenant_id = current_tenant_id
        AND candidate.project_id = stored_job.project_id
        AND candidate.environment_id = stored_job.environment_id
        AND candidate.job_id = expected_job_id
        AND candidate.attempt_id = stored_job.terminal_attempt_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          MESSAGE = 'Terminal replay job is missing its deciding attempt';
      END IF;
    END IF;
    terminal_intent_payload := jsonb_build_object(
      'code', stored_job.terminal_code,
      'environmentId', stored_job.environment_id,
      'jobId', stored_job.job_id,
      'projectId', stored_job.project_id,
      'stateVersion', stored_job.state_version,
      'status', stored_job.status
    );
    IF public.proofstack_replay_job_intent_status(
      current_tenant_id,
      'replay.job.terminal',
      stored_job.job_id,
      terminal_intent_payload,
      stored_job.terminal_committed_at
    ) IS DISTINCT FROM 'canonical'
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'Terminal replay job is missing its canonical intent';
    END IF;
    claimed := false;
    reason := 'terminalized';
    job := stored_job.job;
    attempt := stored_attempt.attempt;
    worker_fence := NULL;
    RETURN NEXT;
    RETURN;
  END IF;

  now_value := transaction_timestamp();
  now_lexical := to_char(
    now_value AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
  );
  now_value := now_lexical::timestamptz;

  IF stored_job.status = 'running' THEN
    SELECT candidate.*
    INTO stored_attempt
    FROM public.proofstack_replay_attempts AS candidate
    WHERE candidate.tenant_id = current_tenant_id
      AND candidate.project_id = expected_project_id
      AND candidate.environment_id = expected_environment_id
      AND candidate.job_id = expected_job_id
      AND candidate.attempt_id = stored_job.current_attempt_id
      AND candidate.lease_id = stored_job.current_lease_id
      AND candidate.worker_id = stored_job.current_worker_id
      AND candidate.fencing_token = stored_job.current_fencing_token
      AND candidate.recovery_epoch = stored_job.recovery_epoch
    FOR UPDATE;
    IF NOT FOUND OR stored_attempt.status <> 'running' THEN
      RAISE EXCEPTION USING
        ERRCODE = '55000',
        MESSAGE = 'Replay attempt is not the current running attempt';
    END IF;

    IF stored_job.current_attempt_id = expected_attempt_id THEN
      IF stored_job.current_lease_id IS DISTINCT FROM expected_lease_id
        OR stored_job.current_worker_id IS DISTINCT FROM expected_worker_id
        OR stored_attempt.worker_build_sha256 IS DISTINCT FROM expected_worker_build_sha256
      THEN
        RAISE EXCEPTION USING
          ERRCODE = '23505',
          MESSAGE = 'Replay claim conflicts with its immutable attempt identity';
      END IF;
      IF now_value >= stored_job.current_lease_expires_at THEN
        RAISE EXCEPTION USING
          ERRCODE = '23505',
          MESSAGE = 'Expired replay attempt identifier cannot be reclaimed';
      END IF;
      claimed := true;
      reason := NULL;
      job := stored_job.job;
      attempt := stored_attempt.attempt;
      worker_fence := stored_job.job #> '{currentLease,mutationFence}';
      RETURN NEXT;
      RETURN;
    END IF;

    IF now_value < stored_job.current_lease_expires_at THEN
      RAISE EXCEPTION USING
        ERRCODE = '55000',
        MESSAGE = 'Replay worker lease is active';
    END IF;

    SELECT
      count(*),
      count(*) FILTER (WHERE boundary.boundary_mode = 'live_provider'),
      count(*) FILTER (
        WHERE boundary.boundary_mode = 'live_provider'
          AND boundary.side_effect_kind <> 'read_only'
      )
    INTO total_boundary_count, live_boundary_count, non_read_only_live_boundary_count
    FROM public.proofstack_replay_plan_boundaries AS boundary
    WHERE boundary.tenant_id = current_tenant_id
      AND boundary.project_id = stored_job.project_id
      AND boundary.environment_id = stored_job.environment_id
      AND boundary.plan_id = stored_job.plan_id
      AND boundary.plan_version_id = stored_job.plan_version_id;
    IF total_boundary_count <> stored_plan.boundary_count THEN
      RAISE EXCEPTION USING
        ERRCODE = '55000',
        MESSAGE = 'Replay plan boundary set is incomplete';
    END IF;

    IF live_boundary_count = 0 THEN
      effect_certainty_value := 'none';
      effect_retry_safety_kind_value := NULL;
      error_value := jsonb_build_object(
        'code', 'lease_expired',
        'effectCertainty', effect_certainty_value,
        'message', 'The worker lease expired before a terminal attempt commit.'
      );
    ELSIF non_read_only_live_boundary_count = 0 THEN
      effect_certainty_value := 'may_have_occurred';
      effect_retry_safety_kind_value := 'read_only';
      error_value := jsonb_build_object(
        'code', 'lease_expired',
        'effectCertainty', effect_certainty_value,
        'effectRetrySafety', jsonb_build_object(
          'evidenceSha256', stored_job.plan_definition_sha256,
          'kind', effect_retry_safety_kind_value
        ),
        'message', 'The worker lease expired before a terminal attempt commit.'
      );
    ELSE
      effect_certainty_value := 'may_have_occurred';
      effect_retry_safety_kind_value := 'not_retryable';
      error_value := jsonb_build_object(
        'code', 'lease_expired',
        'effectCertainty', effect_certainty_value,
        'effectRetrySafety', jsonb_build_object(
          'kind', effect_retry_safety_kind_value
        ),
        'message', 'The worker lease expired before a terminal attempt commit.'
      );
    END IF;

    SELECT EXISTS (
      SELECT 1
      FROM public.proofstack_replay_cancellation_requests AS request
      WHERE request.tenant_id = current_tenant_id
        AND request.job_id = expected_job_id
    ) INTO cancellation_requested;
    SELECT EXISTS (
      SELECT 1
      FROM public.proofstack_replay_budget_entries AS reservation
      WHERE reservation.tenant_id = current_tenant_id
        AND reservation.job_id = expected_job_id
        AND reservation.entry_type = 'reservation'
        AND NOT EXISTS (
          SELECT 1
          FROM public.proofstack_replay_budget_entries AS reconciliation
          WHERE reconciliation.tenant_id = reservation.tenant_id
            AND reconciliation.job_id = reservation.job_id
            AND reconciliation.entry_type = 'reconciliation'
            AND reconciliation.reservation_id = reservation.reservation_id
        )
    ) INTO has_open_reservation;

    retry_eligible := true;
    retry_block_reason := NULL;
    IF cancellation_requested THEN
      retry_eligible := false;
      retry_block_reason := 'cancellation_requested';
    ELSIF has_open_reservation THEN
      retry_eligible := false;
      retry_block_reason := 'open_budget_reservation';
    ELSIF NOT stored_plan.retry_automatic THEN
      retry_eligible := false;
      retry_block_reason := 'automatic_retry_disabled';
    ELSIF stored_attempt.attempt_sequence + 1 >= stored_plan.retry_max_attempts THEN
      retry_eligible := false;
      retry_block_reason := 'attempt_limit_reached';
    ELSIF NOT stored_plan.retry_target_process_interrupted THEN
      retry_eligible := false;
      retry_block_reason := 'error_not_declared';
    ELSIF effect_certainty_value <> 'none'
      AND effect_retry_safety_kind_value NOT IN (
        'destination_idempotency_verified',
        'read_only'
      )
    THEN
      retry_eligible := false;
      retry_block_reason := 'effect_not_retry_safe';
    END IF;

    IF retry_eligible THEN
      IF stored_plan.retry_backoff_kind = 'none' THEN
        backoff_delay_milliseconds := 0;
      ELSIF stored_plan.retry_backoff_kind = 'fixed' THEN
        backoff_delay_milliseconds := stored_plan.retry_backoff_delay_milliseconds;
      ELSE
        backoff_delay_milliseconds := stored_plan.retry_backoff_initial_delay_milliseconds;
        FOR backoff_step IN 1..stored_attempt.attempt_sequence::integer LOOP
          IF backoff_delay_milliseconds >
            stored_plan.retry_backoff_maximum_delay_milliseconds /
              stored_plan.retry_backoff_multiplier
          THEN
            backoff_delay_milliseconds :=
              stored_plan.retry_backoff_maximum_delay_milliseconds;
          ELSE
            backoff_delay_milliseconds := LEAST(
              backoff_delay_milliseconds * stored_plan.retry_backoff_multiplier,
              stored_plan.retry_backoff_maximum_delay_milliseconds
            );
          END IF;
        END LOOP;
      END IF;
      not_before_value := stored_job.current_lease_expires_at +
        (backoff_delay_milliseconds * interval '1 millisecond');
      next_attempt_completes_at := GREATEST(now_value, not_before_value) +
        (stored_plan.retry_per_attempt_timeout_milliseconds * interval '1 millisecond');
      IF next_attempt_completes_at > stored_job.started_at +
        (stored_plan.retry_total_deadline_milliseconds * interval '1 millisecond')
      THEN
        retry_eligible := false;
        retry_block_reason := 'deadline_insufficient';
      ELSIF now_value < not_before_value THEN
        claimed := false;
        reason := 'retry_not_ready';
        job := stored_job.job;
        attempt := stored_attempt.attempt;
        worker_fence := NULL;
        RETURN NEXT;
        RETURN;
      END IF;
    END IF;

    IF NOT retry_eligible THEN
      IF retry_block_reason = 'cancellation_requested' THEN
        terminal_status_value := 'cancelled';
        terminal_code_value := 'cancellation_committed';
      ELSIF retry_block_reason = 'deadline_insufficient' THEN
        terminal_status_value := 'timed_out';
        terminal_code_value := 'deadline_reached';
      ELSIF retry_block_reason IN ('effect_not_retry_safe', 'open_budget_reservation') THEN
        terminal_status_value := 'failed';
        terminal_code_value := 'execution_failed';
      ELSE
        terminal_status_value := 'failed';
        terminal_code_value := 'retries_exhausted';
      END IF;
      IF stored_job.state_version >= 9007199254740991 THEN
        RAISE EXCEPTION USING
          ERRCODE = '22003',
          MESSAGE = 'Replay job state version is exhausted';
      END IF;

      expired_attempt_value := stored_attempt.attempt || jsonb_build_object(
        'endedAt', stored_job.current_lease_expires_at_lexical,
        'error', error_value,
        'retryDisposition', 'not_retryable',
        'status', 'lease_expired'
      );
      next_state_version := stored_job.state_version + 1;
      next_job := (stored_job.job - 'currentLease') || jsonb_build_object(
        'stateVersion', next_state_version,
        'status', terminal_status_value,
        'terminal', jsonb_build_object(
          'attemptId', stored_attempt.attempt_id,
          'code', terminal_code_value,
          'committedAt', now_lexical,
          'status', terminal_status_value
        )
      );

      PERFORM set_config('proofstack.replay_attempt_writer', 'stored-function-v1', true);
      UPDATE public.proofstack_replay_attempts
      SET status = 'lease_expired',
        ended_at = stored_job.current_lease_expires_at,
        ended_at_lexical = stored_job.current_lease_expires_at_lexical,
        retry_disposition = 'not_retryable',
        error_code = 'lease_expired',
        effect_certainty = effect_certainty_value,
        effect_retry_safety_kind = effect_retry_safety_kind_value,
        attempt = expired_attempt_value
      WHERE tenant_id = current_tenant_id
        AND job_id = expected_job_id
        AND attempt_id = stored_attempt.attempt_id
        AND status = 'running';
      IF NOT FOUND THEN
        RAISE EXCEPTION USING
          ERRCODE = '40001',
          MESSAGE = 'Replay attempt changed during lease reconciliation';
      END IF;

      PERFORM set_config('proofstack.replay_job_writer', 'stored-function-v1', true);
      UPDATE public.proofstack_replay_jobs
      SET status = terminal_status_value,
        state_version = next_state_version,
        current_attempt_id = NULL,
        current_lease_id = NULL,
        current_worker_id = NULL,
        current_fencing_token = NULL,
        current_attempt_sequence = NULL,
        current_lease_acquired_at = NULL,
        current_lease_acquired_at_lexical = NULL,
        current_lease_heartbeat_at = NULL,
        current_lease_heartbeat_at_lexical = NULL,
        current_lease_expires_at = NULL,
        current_lease_expires_at_lexical = NULL,
        terminal_status = terminal_status_value,
        terminal_code = terminal_code_value,
        terminal_attempt_id = stored_attempt.attempt_id,
        terminal_committed_at = now_value,
        terminal_committed_at_lexical = now_lexical,
        job = next_job
      WHERE tenant_id = current_tenant_id
        AND job_id = expected_job_id
        AND state_version = stored_job.state_version;
      IF NOT FOUND THEN
        RAISE EXCEPTION USING
          ERRCODE = '40001',
          MESSAGE = 'Replay job changed during lease reconciliation';
      END IF;

      terminal_intent_payload := jsonb_build_object(
        'code', terminal_code_value,
        'environmentId', expected_environment_id,
        'jobId', expected_job_id,
        'projectId', expected_project_id,
        'stateVersion', next_state_version,
        'status', terminal_status_value
      );
      INSERT INTO public.proofstack_outbox (
        tenant_id,
        event_type,
        aggregate_type,
        aggregate_id,
        schema_version,
        payload,
        created_at
      ) VALUES (
        current_tenant_id,
        'replay.job.terminal',
        'replay.job',
        expected_job_id,
        '0.1',
        terminal_intent_payload,
        now_value
      );

      claimed := false;
      reason := 'terminalized';
      job := next_job;
      attempt := expired_attempt_value;
      worker_fence := NULL;
      RETURN NEXT;
      RETURN;
    END IF;

    expired_attempt_value := stored_attempt.attempt || jsonb_build_object(
      'endedAt', now_lexical,
      'error', error_value,
      'retryDisposition', 'retry_scheduled',
      'status', 'lease_expired'
    );
    PERFORM set_config('proofstack.replay_attempt_writer', 'stored-function-v1', true);
    UPDATE public.proofstack_replay_attempts
    SET status = 'lease_expired',
      ended_at = now_value,
      ended_at_lexical = now_lexical,
      retry_disposition = 'retry_scheduled',
      error_code = 'lease_expired',
      effect_certainty = effect_certainty_value,
      effect_retry_safety_kind = effect_retry_safety_kind_value,
      attempt = expired_attempt_value
    WHERE tenant_id = current_tenant_id
      AND job_id = expected_job_id
      AND attempt_id = stored_attempt.attempt_id
      AND status = 'running';
    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = '40001',
        MESSAGE = 'Replay attempt changed during lease reclaim';
    END IF;
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
  expires_at_value := now_value +
    (requested_lease_duration_milliseconds * interval '1 millisecond');
  expires_at_lexical := to_char(
    expires_at_value AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
  );
  expires_at_value := expires_at_lexical::timestamptz;
  started_at_value := COALESCE(stored_job.started_at, now_value);
  started_at_lexical_value := COALESCE(stored_job.started_at_lexical, now_lexical);
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
    'startedAt', started_at_lexical_value,
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
    started_at = started_at_value,
    started_at_lexical = started_at_lexical_value,
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
