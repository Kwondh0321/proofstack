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
DECLARE
  actual_amount_value numeric;
  actual_status_value text;
  current_tenant_id text;
  dimension_name text;
  existing_observation public.proofstack_replay_observations%ROWTYPE;
  expected_dimensions CONSTANT text[] := ARRAY[
    'concurrentInteractions',
    'elapsedMilliseconds',
    'emittedArtifactBytes',
    'inputTokens',
    'jobAttempts',
    'modelRequests',
    'outputTokens',
    'providerCostMicrounits',
    'retrievedBytes',
    'toolCalls'
  ];
  measurement_count integer;
  measurement_keys text[];
  measurement_value jsonb;
  now_lexical text;
  now_value timestamptz;
  observation_count bigint;
  observation_max_sequence bigint;
  observation_value jsonb;
  previous_dimension_name text;
  stored_job public.proofstack_replay_jobs%ROWTYPE;
  unavailable_reason_value text;
  usage_keys text[];
  usage_value jsonb;
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
    OR expected_observation_id IS NULL
    OR expected_observation_id !~ '^[a-z][a-z0-9_]{2,63}$'
    OR (
      expected_boundary_id IS NOT NULL
      AND expected_boundary_id !~ '^[a-z][a-z0-9_]{2,63}$'
    )
    OR expected_source_event_sha256 IS NULL
    OR expected_source_event_sha256 !~ '^[0-9a-f]{64}$'
    OR jsonb_typeof(expected_measurements) IS DISTINCT FROM 'array'
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'Invalid replay usage observation input';
  END IF;

  measurement_count := jsonb_array_length(expected_measurements);
  IF measurement_count NOT BETWEEN 1 AND 10 THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'Replay usage observation requires between one and ten measurements';
  END IF;

  FOR measurement_value IN
    SELECT measurement.value
    FROM jsonb_array_elements(expected_measurements) AS measurement(value)
  LOOP
    IF jsonb_typeof(measurement_value) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION USING
        ERRCODE = '22023',
        MESSAGE = 'Replay usage observation measurement is invalid';
    END IF;
    SELECT array_agg(key ORDER BY key)
    INTO measurement_keys
    FROM jsonb_object_keys(measurement_value) AS measurement_field(key);
    dimension_name := measurement_value ->> 'dimension';
    usage_value := measurement_value -> 'usage';
    IF measurement_keys IS DISTINCT FROM ARRAY['dimension', 'usage']::text[]
      OR jsonb_typeof(measurement_value -> 'dimension') IS DISTINCT FROM 'string'
      OR NOT (dimension_name = ANY(expected_dimensions))
      OR (
        previous_dimension_name IS NOT NULL
        AND previous_dimension_name >= dimension_name
      )
      OR jsonb_typeof(usage_value) IS DISTINCT FROM 'object'
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '22023',
        MESSAGE = 'Replay usage measurements must be exact, unique, and sorted by dimension';
    END IF;

    actual_status_value := usage_value ->> 'status';
    SELECT array_agg(key ORDER BY key)
    INTO usage_keys
    FROM jsonb_object_keys(usage_value) AS usage_field(key);
    IF actual_status_value = 'observed' THEN
      IF usage_keys IS DISTINCT FROM ARRAY['amount', 'source', 'status']::text[]
        OR jsonb_typeof(usage_value -> 'amount') IS DISTINCT FROM 'number'
        OR jsonb_typeof(usage_value -> 'source') IS DISTINCT FROM 'string'
        OR jsonb_typeof(usage_value -> 'status') IS DISTINCT FROM 'string'
        OR usage_value ->> 'source' NOT IN ('estimated', 'measured', 'provider_reported')
      THEN
        RAISE EXCEPTION USING
          ERRCODE = '22023',
          MESSAGE = 'Observed replay usage measurement is invalid';
      END IF;
      actual_amount_value := (usage_value ->> 'amount')::numeric;
      IF actual_amount_value <> trunc(actual_amount_value)
        OR actual_amount_value NOT BETWEEN 0 AND 9007199254740991
      THEN
        RAISE EXCEPTION USING
          ERRCODE = '22023',
          MESSAGE = 'Observed replay usage amount is invalid';
      END IF;
    ELSIF actual_status_value = 'unavailable' THEN
      unavailable_reason_value := usage_value ->> 'reason';
      IF usage_keys IS DISTINCT FROM ARRAY['reason', 'status']::text[]
        OR jsonb_typeof(usage_value -> 'reason') IS DISTINCT FROM 'string'
        OR jsonb_typeof(usage_value -> 'status') IS DISTINCT FROM 'string'
        OR unavailable_reason_value NOT IN (
          'measurement_failed',
          'provider_did_not_report',
          'source_unavailable'
        )
      THEN
        RAISE EXCEPTION USING
          ERRCODE = '22023',
          MESSAGE = 'Unavailable replay usage measurement is invalid';
      END IF;
    ELSE
      RAISE EXCEPTION USING
        ERRCODE = '22023',
        MESSAGE = 'Replay usage measurement status is invalid';
    END IF;
    previous_dimension_name := dimension_name;
  END LOOP;

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
      MESSAGE = 'Replay usage observation server time moved backwards';
  END IF;
  IF now_value >= stored_job.current_lease_expires_at THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'Replay worker lease is expired';
  END IF;

  SELECT candidate.*
  INTO existing_observation
  FROM public.proofstack_replay_observations AS candidate
  WHERE candidate.tenant_id = current_tenant_id
    AND candidate.observation_id = expected_observation_id;
  IF FOUND THEN
    IF existing_observation.observation_kind <> 'usage'
      OR existing_observation.project_id IS DISTINCT FROM expected_project_id
      OR existing_observation.environment_id IS DISTINCT FROM expected_environment_id
      OR existing_observation.job_id IS DISTINCT FROM expected_job_id
      OR existing_observation.boundary_id IS DISTINCT FROM expected_boundary_id
      OR existing_observation.source_event_sha256 IS DISTINCT FROM expected_source_event_sha256
      OR existing_observation.attempt_id IS DISTINCT FROM expected_attempt_id
      OR existing_observation.lease_id IS DISTINCT FROM expected_lease_id
      OR existing_observation.worker_id IS DISTINCT FROM expected_worker_id
      OR existing_observation.fencing_token IS DISTINCT FROM expected_fencing_token
      OR existing_observation.recovery_epoch IS DISTINCT FROM expected_recovery_epoch
      OR existing_observation.observation -> 'measurements' IS DISTINCT FROM expected_measurements
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '23505',
        MESSAGE = 'Replay usage observation conflicts with its immutable identity';
    END IF;
    created := false;
    observation := existing_observation.observation;
    RETURN NEXT;
    RETURN;
  END IF;

  IF expected_boundary_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM public.proofstack_replay_plan_boundaries AS boundary
    WHERE boundary.tenant_id = current_tenant_id
      AND boundary.project_id = stored_job.project_id
      AND boundary.environment_id = stored_job.environment_id
      AND boundary.plan_id = stored_job.plan_id
      AND boundary.plan_version_id = stored_job.plan_version_id
      AND boundary.boundary_id = expected_boundary_id
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23503',
      MESSAGE = 'Replay usage observation boundary is not declared by the exact plan';
  END IF;

  SELECT count(*), COALESCE(max(candidate.observation_sequence), -1)
  INTO observation_count, observation_max_sequence
  FROM public.proofstack_replay_observations AS candidate
  WHERE candidate.tenant_id = current_tenant_id
    AND candidate.job_id = expected_job_id;
  IF observation_count <> observation_max_sequence + 1
    OR observation_count > 9007199254740991
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'Replay observation sequence is invalid';
  END IF;

  observation_value := jsonb_build_object(
    'measurements', expected_measurements,
    'mutationFence', jsonb_build_object(
      'attemptId', expected_attempt_id,
      'fencingToken', expected_fencing_token,
      'jobId', expected_job_id,
      'leaseId', expected_lease_id,
      'recoveryEpoch', expected_recovery_epoch,
      'workerId', expected_worker_id
    ),
    'observationId', expected_observation_id,
    'observationSequence', observation_count,
    'observedAt', now_lexical,
    'schemaVersion', '0.1',
    'scope', stored_job.job -> 'scope',
    'sourceEventSha256', expected_source_event_sha256
  );
  IF expected_boundary_id IS NOT NULL THEN
    observation_value := observation_value || jsonb_build_object(
      'boundaryId', expected_boundary_id
    );
  END IF;

  INSERT INTO public.proofstack_replay_observations (
    tenant_id,
    project_id,
    environment_id,
    job_id,
    observation_id,
    observation_sequence,
    schema_version,
    observation_kind,
    payload_kind,
    boundary_id,
    source_event_sha256,
    attempt_id,
    lease_id,
    worker_id,
    fencing_token,
    recovery_epoch,
    observed_at,
    observed_at_lexical,
    observation
  ) VALUES (
    current_tenant_id,
    expected_project_id,
    expected_environment_id,
    expected_job_id,
    expected_observation_id,
    observation_count,
    '0.1',
    'usage',
    NULL,
    expected_boundary_id,
    expected_source_event_sha256,
    expected_attempt_id,
    expected_lease_id,
    expected_worker_id,
    expected_fencing_token,
    expected_recovery_epoch,
    now_value,
    now_lexical,
    observation_value
  );

  FOR measurement_value IN
    SELECT measurement.value
    FROM jsonb_array_elements(expected_measurements) AS measurement(value)
  LOOP
    dimension_name := measurement_value ->> 'dimension';
    usage_value := measurement_value -> 'usage';
    actual_status_value := usage_value ->> 'status';
    INSERT INTO public.proofstack_replay_usage_measurements (
      tenant_id,
      observation_id,
      observation_kind,
      dimension,
      usage_status,
      amount,
      source,
      unavailable_reason
    ) VALUES (
      current_tenant_id,
      expected_observation_id,
      'usage',
      dimension_name,
      actual_status_value,
      CASE WHEN actual_status_value = 'observed'
        THEN (usage_value ->> 'amount')::bigint
        ELSE NULL
      END,
      CASE WHEN actual_status_value = 'observed'
        THEN usage_value ->> 'source'
        ELSE NULL
      END,
      CASE WHEN actual_status_value = 'unavailable'
        THEN usage_value ->> 'reason'
        ELSE NULL
      END
    );
  END LOOP;

  created := true;
  observation := observation_value;
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.proofstack_append_replay_usage_observation(
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
  text,
  jsonb
) FROM PUBLIC;
