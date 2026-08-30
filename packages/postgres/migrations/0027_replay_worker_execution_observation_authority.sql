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
DECLARE
  after_cancellation_value boolean;
  current_tenant_id text;
  evidence_sha256_value text;
  existing_observation public.proofstack_replay_observations%ROWTYPE;
  exit_code_value numeric;
  expected_keys text[];
  observation_count bigint;
  observation_max_sequence bigint;
  observation_value jsonb;
  now_lexical text;
  now_value timestamptz;
  payload_kind_value text;
  stored_job public.proofstack_replay_jobs%ROWTYPE;
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
    OR jsonb_typeof(expected_payload) IS DISTINCT FROM 'object'
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'Invalid replay execution observation input';
  END IF;

  payload_kind_value := expected_payload ->> 'kind';
  evidence_sha256_value := expected_payload ->> 'evidenceSha256';
  IF jsonb_typeof(expected_payload -> 'evidenceSha256') IS DISTINCT FROM 'string'
    OR evidence_sha256_value !~ '^[0-9a-f]{64}$'
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'Replay execution observation evidence digest is invalid';
  END IF;
  SELECT array_agg(key ORDER BY key)
  INTO expected_keys
  FROM jsonb_object_keys(expected_payload) AS payload_field(key);

  IF payload_kind_value = 'boundary' THEN
    IF expected_keys IS DISTINCT FROM ARRAY[
      'afterCancellationRequest',
      'boundaryId',
      'boundaryKind',
      'effectCertainty',
      'evidenceSha256',
      'executionOrigin',
      'kind',
      'mode',
      'phase'
    ]::text[]
      OR jsonb_typeof(expected_payload -> 'afterCancellationRequest') IS DISTINCT FROM 'boolean'
      OR jsonb_typeof(expected_payload -> 'boundaryId') IS DISTINCT FROM 'string'
      OR expected_payload ->> 'boundaryId' !~ '^[a-z][a-z0-9_]{2,63}$'
      OR jsonb_typeof(expected_payload -> 'boundaryKind') IS DISTINCT FROM 'string'
      OR expected_payload ->> 'boundaryKind' NOT IN ('data', 'model', 'retrieval', 'tool')
      OR jsonb_typeof(expected_payload -> 'effectCertainty') IS DISTINCT FROM 'string'
      OR expected_payload ->> 'effectCertainty' NOT IN ('confirmed', 'may_have_occurred', 'none')
      OR jsonb_typeof(expected_payload -> 'executionOrigin') IS DISTINCT FROM 'string'
      OR jsonb_typeof(expected_payload -> 'mode') IS DISTINCT FROM 'string'
      OR expected_payload ->> 'mode' NOT IN ('live_provider', 'recorded_stub', 'simulation')
      OR jsonb_typeof(expected_payload -> 'phase') IS DISTINCT FROM 'string'
      OR expected_payload ->> 'phase' NOT IN ('failed', 'request_started', 'response_observed')
      OR (expected_payload ->> 'executionOrigin') IS DISTINCT FROM (
        CASE (expected_payload ->> 'mode')
          WHEN 'live_provider' THEN 'live'
          WHEN 'recorded_stub' THEN 'recorded'
          WHEN 'simulation' THEN 'simulated'
          ELSE NULL
        END
      )
      OR (
        expected_payload ->> 'mode' <> 'live_provider'
        AND expected_payload ->> 'effectCertainty' <> 'none'
      )
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '22023',
        MESSAGE = 'Replay boundary execution observation is invalid';
    END IF;
  ELSIF payload_kind_value = 'target' THEN
    IF jsonb_typeof(expected_payload -> 'afterCancellationRequest') IS DISTINCT FROM 'boolean'
      OR jsonb_typeof(expected_payload -> 'event') IS DISTINCT FROM 'string'
      OR expected_payload ->> 'event' NOT IN (
        'exited',
        'started',
        'stderr_capped',
        'stdout_capped'
      )
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '22023',
        MESSAGE = 'Replay target execution observation is invalid';
    END IF;
    IF expected_payload ->> 'event' = 'exited' THEN
      IF expected_keys IS DISTINCT FROM ARRAY[
        'afterCancellationRequest',
        'event',
        'evidenceSha256',
        'exitCode',
        'kind'
      ]::text[]
        OR jsonb_typeof(expected_payload -> 'exitCode') IS DISTINCT FROM 'number'
      THEN
        RAISE EXCEPTION USING
          ERRCODE = '22023',
          MESSAGE = 'Replay target exit observation is invalid';
      END IF;
      exit_code_value := (expected_payload ->> 'exitCode')::numeric;
      IF exit_code_value <> trunc(exit_code_value)
        OR exit_code_value NOT BETWEEN -1 AND 255
      THEN
        RAISE EXCEPTION USING
          ERRCODE = '22023',
          MESSAGE = 'Replay target exit code is invalid';
      END IF;
    ELSIF expected_keys IS DISTINCT FROM ARRAY[
      'afterCancellationRequest',
      'event',
      'evidenceSha256',
      'kind'
    ]::text[] THEN
      RAISE EXCEPTION USING
        ERRCODE = '22023',
        MESSAGE = 'Replay target execution observation has invalid fields';
    END IF;
  ELSIF payload_kind_value = 'cancellation' THEN
    IF expected_keys IS DISTINCT FROM ARRAY[
      'cancellationId',
      'event',
      'evidenceSha256',
      'kind'
    ]::text[]
      OR jsonb_typeof(expected_payload -> 'cancellationId') IS DISTINCT FROM 'string'
      OR expected_payload ->> 'cancellationId' !~ '^[a-z][a-z0-9_]{2,63}$'
      OR jsonb_typeof(expected_payload -> 'event') IS DISTINCT FROM 'string'
      OR expected_payload ->> 'event' NOT IN (
        'late_completion_observed',
        'request_observed',
        'stop_requested',
        'stopped_before_target_start'
      )
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '22023',
        MESSAGE = 'Replay cancellation execution observation is invalid';
    END IF;
  ELSIF payload_kind_value = 'isolation' THEN
    IF expected_keys IS DISTINCT FROM ARRAY[
      'control',
      'evidenceSha256',
      'kind',
      'verdict'
    ]::text[]
      OR jsonb_typeof(expected_payload -> 'control') IS DISTINCT FROM 'string'
      OR expected_payload ->> 'control' NOT IN (
        'environment_allowlist',
        'filesystem_mounts',
        'network_policy',
        'no_new_privileges',
        'output_limits',
        'process_boundary',
        'resource_limits'
      )
      OR jsonb_typeof(expected_payload -> 'verdict') IS DISTINCT FROM 'string'
      OR expected_payload ->> 'verdict' NOT IN ('failed', 'not_verified', 'verified')
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '22023',
        MESSAGE = 'Replay isolation execution observation is invalid';
    END IF;
  ELSE
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'Replay execution observation kind is invalid';
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
      MESSAGE = 'Replay execution observation server time moved backwards';
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
    IF existing_observation.observation_kind <> 'execution'
      OR existing_observation.project_id IS DISTINCT FROM expected_project_id
      OR existing_observation.environment_id IS DISTINCT FROM expected_environment_id
      OR existing_observation.job_id IS DISTINCT FROM expected_job_id
      OR existing_observation.attempt_id IS DISTINCT FROM expected_attempt_id
      OR existing_observation.lease_id IS DISTINCT FROM expected_lease_id
      OR existing_observation.worker_id IS DISTINCT FROM expected_worker_id
      OR existing_observation.fencing_token IS DISTINCT FROM expected_fencing_token
      OR existing_observation.recovery_epoch IS DISTINCT FROM expected_recovery_epoch
      OR existing_observation.observation -> 'payload' IS DISTINCT FROM expected_payload
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '23505',
        MESSAGE = 'Replay execution observation conflicts with its immutable identity';
    END IF;
    created := false;
    observation := existing_observation.observation;
    RETURN NEXT;
    RETURN;
  END IF;

  IF payload_kind_value IN ('boundary', 'target') THEN
    SELECT EXISTS (
      SELECT 1
      FROM public.proofstack_replay_cancellation_requests AS cancellation
      WHERE cancellation.tenant_id = current_tenant_id
        AND cancellation.job_id = expected_job_id
    )
    INTO after_cancellation_value;
    IF (expected_payload ->> 'afterCancellationRequest')::boolean
      IS DISTINCT FROM after_cancellation_value
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '55000',
        MESSAGE = 'Replay execution observation has an incorrect cancellation order';
    END IF;
  END IF;
  IF payload_kind_value = 'boundary' AND NOT EXISTS (
    SELECT 1
    FROM public.proofstack_replay_plan_boundaries AS boundary
    WHERE boundary.tenant_id = current_tenant_id
      AND boundary.project_id = stored_job.project_id
      AND boundary.environment_id = stored_job.environment_id
      AND boundary.plan_id = stored_job.plan_id
      AND boundary.plan_version_id = stored_job.plan_version_id
      AND boundary.boundary_id = (expected_payload ->> 'boundaryId')
      AND boundary.boundary_kind = (expected_payload ->> 'boundaryKind')
      AND boundary.boundary_mode = (expected_payload ->> 'mode')
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23503',
      MESSAGE = 'Replay boundary observation is not declared by the exact plan';
  END IF;
  IF payload_kind_value = 'cancellation' AND NOT EXISTS (
    SELECT 1
    FROM public.proofstack_replay_cancellation_requests AS cancellation
    WHERE cancellation.tenant_id = current_tenant_id
      AND cancellation.job_id = expected_job_id
      AND cancellation.cancellation_id = (expected_payload ->> 'cancellationId')
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23503',
      MESSAGE = 'Replay cancellation observation has no exact request';
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
    'payload', expected_payload,
    'schemaVersion', '0.1',
    'scope', stored_job.job -> 'scope'
  );

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
    'execution',
    payload_kind_value,
    CASE WHEN payload_kind_value = 'boundary'
      THEN expected_payload ->> 'boundaryId'
      ELSE NULL
    END,
    expected_attempt_id,
    expected_lease_id,
    expected_worker_id,
    expected_fencing_token,
    expected_recovery_epoch,
    now_value,
    now_lexical,
    observation_value
  );

  created := true;
  observation := observation_value;
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.proofstack_append_replay_execution_observation(
  text,
  text,
  text,
  text,
  text,
  text,
  bigint,
  bigint,
  text,
  jsonb
) FROM PUBLIC;
