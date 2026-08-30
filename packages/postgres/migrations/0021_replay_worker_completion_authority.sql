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
DECLARE
  cancellation_requested boolean;
  current_tenant_id text;
  error_code_value text;
  effect_certainty_value text;
  effect_retry_safety_kind_value text;
  next_attempt jsonb;
  next_job jsonb;
  next_state_version bigint;
  now_lexical text;
  now_value timestamptz;
  result_artifact_id_value text;
  stored_attempt public.proofstack_replay_attempts%ROWTYPE;
  stored_job public.proofstack_replay_jobs%ROWTYPE;
  terminal_intent_payload jsonb;
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
    OR expected_status IS NULL
    OR expected_status NOT IN (
      'budget_exhausted',
      'cancelled',
      'failed',
      'succeeded',
      'timed_out'
    )
    OR expected_code IS NULL
    OR NOT (
      (expected_status = 'budget_exhausted' AND expected_code = 'budget_limit_reached')
      OR (expected_status = 'cancelled' AND expected_code = 'cancellation_committed')
      OR (
        expected_status = 'failed'
        AND expected_code IN ('contract_rejected', 'execution_failed', 'retries_exhausted')
      )
      OR (expected_status = 'succeeded' AND expected_code = 'completed')
      OR (expected_status = 'timed_out' AND expected_code = 'deadline_reached')
    )
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'Invalid replay completion authority input';
  END IF;

  IF expected_status = 'succeeded' THEN
    IF expected_error IS NOT NULL
      OR expected_result IS NULL
      OR jsonb_typeof(expected_result) <> 'object'
      OR NOT (expected_result ?& ARRAY[
        'artifactId',
        'classification',
        'mediaType',
        'sha256',
        'sizeBytes'
      ])
      OR expected_result - ARRAY[
        'artifactId',
        'classification',
        'mediaType',
        'redactedAt',
        'sha256',
        'sizeBytes'
      ] <> '{}'::jsonb
      OR jsonb_typeof(expected_result -> 'artifactId') <> 'string'
      OR expected_result ->> 'artifactId' !~ '^[a-z][a-z0-9_]{2,63}$'
      OR jsonb_typeof(expected_result -> 'classification') <> 'string'
      OR expected_result ->> 'classification' NOT IN (
        'metadata',
        'internal',
        'confidential',
        'restricted'
      )
      OR jsonb_typeof(expected_result -> 'mediaType') <> 'string'
      OR expected_result ->> 'mediaType' !~
        '^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$'
      OR jsonb_typeof(expected_result -> 'sha256') <> 'string'
      OR expected_result ->> 'sha256' !~ '^[0-9a-f]{64}$'
      OR jsonb_typeof(expected_result -> 'sizeBytes') <> 'number'
      OR expected_result ->> 'sizeBytes' !~ '^[1-9][0-9]*$'
      OR (expected_result ->> 'sizeBytes')::numeric > 16777216
      OR (
        expected_result ? 'redactedAt'
        AND (
          jsonb_typeof(expected_result -> 'redactedAt') <> 'string'
          OR expected_result ->> 'redactedAt' NOT IN ('source', 'ingest', 'retention')
        )
      )
      OR pg_column_size(expected_result) > 16384
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '22023',
        MESSAGE = 'Successful replay completion requires one canonical artifact result';
    END IF;
  ELSE
    IF expected_result IS NOT NULL
      OR expected_error IS NULL
      OR jsonb_typeof(expected_error) <> 'object'
      OR NOT (expected_error ?& ARRAY['code', 'effectCertainty', 'message'])
      OR expected_error - ARRAY[
        'code',
        'detailsSha256',
        'effectCertainty',
        'effectRetrySafety',
        'message'
      ] <> '{}'::jsonb
      OR jsonb_typeof(expected_error -> 'code') <> 'string'
      OR jsonb_typeof(expected_error -> 'effectCertainty') <> 'string'
      OR expected_error ->> 'effectCertainty' NOT IN ('confirmed', 'may_have_occurred', 'none')
      OR jsonb_typeof(expected_error -> 'message') <> 'string'
      OR char_length(expected_error ->> 'message') NOT BETWEEN 1 AND 1024
      OR expected_error ->> 'message' IS DISTINCT FROM btrim(expected_error ->> 'message')
      OR expected_error ->> 'message' ~ '[[:cntrl:]]'
      OR position(U&'\2028' IN expected_error ->> 'message') > 0
      OR position(U&'\2029' IN expected_error ->> 'message') > 0
      OR (
        expected_error ? 'detailsSha256'
        AND (
          jsonb_typeof(expected_error -> 'detailsSha256') <> 'string'
          OR expected_error ->> 'detailsSha256' !~ '^[0-9a-f]{64}$'
        )
      )
      OR pg_column_size(expected_error) > 16384
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '22023',
        MESSAGE = 'Unsuccessful replay completion requires one canonical attempt error';
    END IF;

    IF (
      expected_error ->> 'effectCertainty' = 'none'
      AND expected_error ? 'effectRetrySafety'
    ) OR (
      expected_error ->> 'effectCertainty' <> 'none'
      AND NOT (expected_error ? 'effectRetrySafety')
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '22023',
        MESSAGE = 'Replay attempt effect certainty has an invalid retry-safety decision';
    END IF;

    IF expected_error ? 'effectRetrySafety' THEN
      IF jsonb_typeof(expected_error -> 'effectRetrySafety') IS DISTINCT FROM 'object'
        OR jsonb_typeof(
          expected_error #> '{effectRetrySafety,kind}'
        ) IS DISTINCT FROM 'string'
        OR (
          expected_error #>> '{effectRetrySafety,kind}' IN (
            'destination_idempotency_verified',
            'not_retryable',
            'read_only'
          )
        ) IS NOT TRUE
        OR (
          expected_error #>> '{effectRetrySafety,kind}' = 'not_retryable'
          AND expected_error -> 'effectRetrySafety' <> jsonb_build_object(
            'kind',
            'not_retryable'
          )
        )
        OR (
          expected_error #>> '{effectRetrySafety,kind}' = 'read_only'
          AND (
            NOT (expected_error -> 'effectRetrySafety' ?& ARRAY['evidenceSha256', 'kind'])
            OR (expected_error -> 'effectRetrySafety') - ARRAY['evidenceSha256', 'kind'] <>
              '{}'::jsonb
            OR jsonb_typeof(
              expected_error #> '{effectRetrySafety,evidenceSha256}'
            ) <> 'string'
            OR expected_error #>> '{effectRetrySafety,evidenceSha256}' !~ '^[0-9a-f]{64}$'
          )
        )
        OR (
          expected_error #>> '{effectRetrySafety,kind}' =
            'destination_idempotency_verified'
          AND (
            NOT (expected_error -> 'effectRetrySafety' ?& ARRAY[
              'evidenceSha256',
              'idempotencyKeySha256',
              'kind'
            ])
            OR (expected_error -> 'effectRetrySafety') - ARRAY[
              'evidenceSha256',
              'idempotencyKeySha256',
              'kind'
            ] <> '{}'::jsonb
            OR jsonb_typeof(
              expected_error #> '{effectRetrySafety,evidenceSha256}'
            ) <> 'string'
            OR expected_error #>> '{effectRetrySafety,evidenceSha256}' !~ '^[0-9a-f]{64}$'
            OR jsonb_typeof(
              expected_error #> '{effectRetrySafety,idempotencyKeySha256}'
            ) <> 'string'
            OR expected_error #>> '{effectRetrySafety,idempotencyKeySha256}' !~
              '^[0-9a-f]{64}$'
          )
        )
      THEN
        RAISE EXCEPTION USING
          ERRCODE = '22023',
          MESSAGE = 'Replay attempt retry-safety evidence is invalid';
      END IF;
    END IF;

    error_code_value := expected_error ->> 'code';
    IF error_code_value IS NULL
      OR NOT (
        (
          expected_status = 'budget_exhausted'
          AND error_code_value IN ('accounting_violation', 'budget_exhausted')
        )
        OR (expected_status = 'cancelled' AND error_code_value = 'cancelled')
        OR (
          expected_status = 'failed'
          AND error_code_value IN (
            'authority_denied',
            'boundary_rate_limited',
            'boundary_temporarily_unavailable',
            'contract_mismatch',
            'credential_unavailable',
            'effect_uncertain',
            'fixture_unavailable',
            'isolation_failed',
            'target_content_unavailable',
            'target_process_interrupted',
            'target_temporary_failure',
            'worker_internal_error'
          )
        )
        OR (expected_status = 'timed_out' AND error_code_value = 'deadline_exceeded')
      )
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '22023',
        MESSAGE = 'Replay attempt error code does not match its terminal status';
    END IF;
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
  IF stored_job.state_version >= 9007199254740991 THEN
    RAISE EXCEPTION USING
      ERRCODE = '22003',
      MESSAGE = 'Replay job state version is exhausted';
  END IF;

  SELECT candidate.*
  INTO stored_attempt
  FROM public.proofstack_replay_attempts AS candidate
  WHERE candidate.tenant_id = current_tenant_id
    AND candidate.project_id = expected_project_id
    AND candidate.environment_id = expected_environment_id
    AND candidate.job_id = expected_job_id
    AND candidate.attempt_id = expected_attempt_id
    AND candidate.lease_id = expected_lease_id
    AND candidate.worker_id = expected_worker_id
    AND candidate.fencing_token = expected_fencing_token
    AND candidate.recovery_epoch = expected_recovery_epoch
  FOR UPDATE;
  IF NOT FOUND OR stored_attempt.status <> 'running' THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'Replay attempt is not the current running attempt';
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
      MESSAGE = 'Replay completion server time moved backwards';
  END IF;
  IF now_value >= stored_job.current_lease_expires_at THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'Replay worker lease is expired';
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.proofstack_replay_cancellation_requests AS request
    WHERE request.tenant_id = current_tenant_id
      AND request.job_id = expected_job_id
  )
  INTO cancellation_requested;
  IF cancellation_requested THEN
    IF expected_status <> 'cancelled' THEN
      RAISE EXCEPTION USING
        ERRCODE = '55000',
        MESSAGE = 'Replay cancellation must win the terminal commit';
    END IF;
    IF NOT EXISTS (
      SELECT 1
      FROM public.proofstack_replay_cancellation_acknowledgements AS acknowledgement
      WHERE acknowledgement.tenant_id = current_tenant_id
        AND acknowledgement.job_id = expected_job_id
        AND acknowledgement.attempt_id = expected_attempt_id
        AND acknowledgement.lease_id = expected_lease_id
        AND acknowledgement.worker_id = expected_worker_id
        AND acknowledgement.fencing_token = expected_fencing_token
        AND acknowledgement.recovery_epoch = expected_recovery_epoch
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '55000',
        MESSAGE = 'Replay cancellation requires acknowledgement by the current worker fence';
    END IF;
  ELSIF expected_status = 'cancelled' THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'Replay completion cannot invent a cancellation request';
  END IF;

  IF EXISTS (
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
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'Replay completion requires every budget reservation to be reconciled';
  END IF;
  IF expected_status <> 'budget_exhausted' AND EXISTS (
    SELECT 1
    FROM public.proofstack_replay_budget_entry_dimensions AS dimension
    WHERE dimension.tenant_id = current_tenant_id
      AND dimension.job_id = expected_job_id
      AND dimension.entry_type = 'reconciliation'
      AND dimension.disposition = 'overrun'
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'Replay budget overrun requires budget-exhausted terminal status';
  END IF;

  IF expected_status = 'succeeded' THEN
    result_artifact_id_value := expected_result ->> 'artifactId';
    IF NOT EXISTS (
      SELECT 1
      FROM public.proofstack_artifact_catalog AS artifact
      WHERE artifact.tenant_id = current_tenant_id
        AND artifact.project_id = expected_project_id
        AND artifact.environment_id = expected_environment_id
        AND artifact.artifact_id = result_artifact_id_value
        AND artifact.state = 'available'
        AND artifact.classification = expected_result ->> 'classification'
        AND artifact.media_type = expected_result ->> 'mediaType'
        AND artifact.content_sha256 = expected_result ->> 'sha256'
        AND artifact.content_size_bytes = (expected_result ->> 'sizeBytes')::integer
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23503',
        MESSAGE = 'Replay result requires an exact available artifact';
    END IF;
  ELSE
    effect_certainty_value := expected_error ->> 'effectCertainty';
    effect_retry_safety_kind_value := expected_error #>> '{effectRetrySafety,kind}';
  END IF;

  next_attempt := stored_attempt.attempt || jsonb_build_object(
    'endedAt', now_lexical,
    'retryDisposition', 'not_retryable',
    'status', expected_status
  );
  IF expected_status = 'succeeded' THEN
    next_attempt := next_attempt || jsonb_build_object('result', expected_result);
  ELSE
    next_attempt := next_attempt || jsonb_build_object('error', expected_error);
  END IF;
  next_state_version := stored_job.state_version + 1;
  next_job := (stored_job.job - 'currentLease') || jsonb_build_object(
    'stateVersion', next_state_version,
    'status', expected_status,
    'terminal', jsonb_build_object(
      'attemptId', expected_attempt_id,
      'code', expected_code,
      'committedAt', now_lexical,
      'status', expected_status
    )
  );
  terminal_intent_payload := jsonb_build_object(
    'code', expected_code,
    'environmentId', expected_environment_id,
    'jobId', expected_job_id,
    'projectId', expected_project_id,
    'stateVersion', next_state_version,
    'status', expected_status
  );

  PERFORM set_config('proofstack.replay_attempt_writer', 'stored-function-v1', true);
  UPDATE public.proofstack_replay_attempts
  SET status = expected_status,
    ended_at = now_value,
    ended_at_lexical = now_lexical,
    retry_disposition = 'not_retryable',
    error_code = error_code_value,
    effect_certainty = effect_certainty_value,
    effect_retry_safety_kind = effect_retry_safety_kind_value,
    result_artifact_id = result_artifact_id_value,
    attempt = next_attempt
  WHERE tenant_id = current_tenant_id
    AND job_id = expected_job_id
    AND attempt_id = expected_attempt_id
    AND status = 'running';
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'Replay attempt changed during completion';
  END IF;

  PERFORM set_config('proofstack.replay_job_writer', 'stored-function-v1', true);
  UPDATE public.proofstack_replay_jobs
  SET status = expected_status,
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
    terminal_status = expected_status,
    terminal_code = expected_code,
    terminal_attempt_id = expected_attempt_id,
    terminal_committed_at = now_value,
    terminal_committed_at_lexical = now_lexical,
    job = next_job
  WHERE tenant_id = current_tenant_id
    AND job_id = expected_job_id
    AND state_version = stored_job.state_version;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'Replay job changed during completion';
  END IF;

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

  job := next_job;
  attempt := next_attempt;
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.proofstack_complete_replay_job(
  text,
  text,
  text,
  text,
  text,
  text,
  bigint,
  bigint,
  text,
  text,
  jsonb,
  jsonb
) FROM PUBLIC;
