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
DECLARE
  committed_value numeric;
  current_tenant_id text;
  dimension_name text;
  dimensions_value jsonb := '{}'::jsonb;
  existing_entry public.proofstack_replay_budget_entries%ROWTYPE;
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
  ledger_count bigint;
  ledger_max_sequence bigint;
  limit_value bigint;
  measurement_value text;
  now_lexical text;
  now_value timestamptz;
  requested_keys text[];
  requested_value numeric;
  reservation_value jsonb;
  stored_job public.proofstack_replay_jobs%ROWTYPE;
  work_artifact_id_value text;
  work_boundary_id_value text;
  work_boundary_kind_value text;
  work_keys text[];
  work_kind_value text;
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
    OR expected_reservation_id IS NULL
    OR expected_reservation_id !~ '^[a-z][a-z0-9_]{2,63}$'
    OR jsonb_typeof(expected_work) IS DISTINCT FROM 'object'
    OR jsonb_typeof(expected_requested_amounts) IS DISTINCT FROM 'object'
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'Invalid replay budget reservation input';
  END IF;

  SELECT array_agg(key ORDER BY key)
  INTO requested_keys
  FROM jsonb_object_keys(expected_requested_amounts) AS requested(key);
  IF requested_keys IS DISTINCT FROM expected_dimensions THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'Replay budget reservation requires every exact budget dimension';
  END IF;
  FOREACH dimension_name IN ARRAY expected_dimensions LOOP
    IF jsonb_typeof(expected_requested_amounts -> dimension_name) IS DISTINCT FROM 'number' THEN
      RAISE EXCEPTION USING
        ERRCODE = '22023',
        MESSAGE = 'Replay budget reservation amounts must be finite nonnegative integers';
    END IF;
    requested_value := (expected_requested_amounts ->> dimension_name)::numeric;
    IF requested_value <> trunc(requested_value)
      OR requested_value NOT BETWEEN 0 AND 9007199254740991
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '22023',
        MESSAGE = 'Replay budget reservation amounts must be finite nonnegative integers';
    END IF;
  END LOOP;
  IF NOT EXISTS (
    SELECT 1
    FROM jsonb_each_text(expected_requested_amounts) AS requested(dimension, amount)
    WHERE requested.amount::numeric > 0
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'Replay budget reservation must reserve at least one dimension';
  END IF;

  work_kind_value := expected_work ->> 'kind';
  SELECT array_agg(key ORDER BY key)
  INTO work_keys
  FROM jsonb_object_keys(expected_work) AS work(key);
  IF work_kind_value = 'attempt_start' THEN
    IF work_keys IS DISTINCT FROM ARRAY['kind']::text[] THEN
      RAISE EXCEPTION USING
        ERRCODE = '22023',
        MESSAGE = 'Replay attempt-start budget work has invalid fields';
    END IF;
  ELSIF work_kind_value = 'boundary_call' THEN
    work_boundary_id_value := expected_work ->> 'boundaryId';
    work_boundary_kind_value := expected_work ->> 'boundaryKind';
    IF work_keys IS DISTINCT FROM ARRAY['boundaryId', 'boundaryKind', 'kind']::text[]
      OR work_boundary_id_value IS NULL
      OR work_boundary_id_value !~ '^[a-z][a-z0-9_]{2,63}$'
      OR work_boundary_kind_value IS NULL
      OR work_boundary_kind_value NOT IN ('data', 'model', 'retrieval', 'tool')
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '22023',
        MESSAGE = 'Replay boundary-call budget work is invalid';
    END IF;
  ELSIF work_kind_value = 'artifact_emission' THEN
    work_artifact_id_value := expected_work ->> 'artifactId';
    IF work_keys IS DISTINCT FROM ARRAY['artifactId', 'kind']::text[]
      OR work_artifact_id_value IS NULL
      OR work_artifact_id_value !~ '^[a-z][a-z0-9_]{2,63}$'
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '22023',
        MESSAGE = 'Replay artifact-emission budget work is invalid';
    END IF;
  ELSE
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'Replay budget work kind is invalid';
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
      MESSAGE = 'Replay budget reservation server time moved backwards';
  END IF;
  IF now_value >= stored_job.current_lease_expires_at THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'Replay worker lease is expired';
  END IF;

  IF (
    SELECT count(*)
    FROM public.proofstack_replay_plan_budgets AS budget
    WHERE budget.tenant_id = current_tenant_id
      AND budget.project_id = stored_job.project_id
      AND budget.environment_id = stored_job.environment_id
      AND budget.plan_id = stored_job.plan_id
      AND budget.plan_version_id = stored_job.plan_version_id
  ) <> 10 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23503',
      MESSAGE = 'Replay job has no complete exact plan budget';
  END IF;
  IF work_kind_value = 'boundary_call' AND NOT EXISTS (
    SELECT 1
    FROM public.proofstack_replay_plan_boundaries AS boundary
    WHERE boundary.tenant_id = current_tenant_id
      AND boundary.project_id = stored_job.project_id
      AND boundary.environment_id = stored_job.environment_id
      AND boundary.plan_id = stored_job.plan_id
      AND boundary.plan_version_id = stored_job.plan_version_id
      AND boundary.boundary_id = work_boundary_id_value
      AND boundary.boundary_kind = work_boundary_kind_value
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23503',
      MESSAGE = 'Replay budget work is not declared by the exact plan';
  END IF;

  SELECT candidate.*
  INTO existing_entry
  FROM public.proofstack_replay_budget_entries AS candidate
  WHERE candidate.tenant_id = current_tenant_id
    AND candidate.entry_id = expected_reservation_id;
  IF FOUND THEN
    IF existing_entry.entry_type <> 'reservation'
      OR existing_entry.project_id IS DISTINCT FROM expected_project_id
      OR existing_entry.environment_id IS DISTINCT FROM expected_environment_id
      OR existing_entry.job_id IS DISTINCT FROM expected_job_id
      OR existing_entry.attempt_id IS DISTINCT FROM expected_attempt_id
      OR existing_entry.lease_id IS DISTINCT FROM expected_lease_id
      OR existing_entry.worker_id IS DISTINCT FROM expected_worker_id
      OR existing_entry.fencing_token IS DISTINCT FROM expected_fencing_token
      OR existing_entry.recovery_epoch IS DISTINCT FROM expected_recovery_epoch
      OR existing_entry.entry -> 'work' IS DISTINCT FROM expected_work
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '23505',
        MESSAGE = 'Replay budget reservation conflicts with its immutable identity';
    END IF;
    FOREACH dimension_name IN ARRAY expected_dimensions LOOP
      IF existing_entry.entry #> ARRAY['dimensions', dimension_name, 'reservedAmount']
        IS DISTINCT FROM expected_requested_amounts -> dimension_name
      THEN
        RAISE EXCEPTION USING
          ERRCODE = '23505',
          MESSAGE = 'Replay budget reservation conflicts with its immutable amounts';
      END IF;
    END LOOP;
    created := false;
    reservation := existing_entry.entry;
    RETURN NEXT;
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.proofstack_replay_cancellation_requests AS cancellation
    WHERE cancellation.tenant_id = current_tenant_id
      AND cancellation.job_id = expected_job_id
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'Replay cancellation prevents new budget reservation';
  END IF;

  SELECT count(*), COALESCE(max(entry.ledger_sequence), -1)
  INTO ledger_count, ledger_max_sequence
  FROM public.proofstack_replay_budget_entries AS entry
  WHERE entry.tenant_id = current_tenant_id
    AND entry.job_id = expected_job_id;
  IF ledger_count <> ledger_max_sequence + 1
    OR ledger_count > 9007199254740991
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'Replay budget ledger sequence is invalid';
  END IF;

  FOREACH dimension_name IN ARRAY expected_dimensions LOOP
    SELECT
      budget.limit_value,
      budget.measurement,
      COALESCE(sum(
        CASE ledger_dimension.entry_type
          WHEN 'reservation' THEN ledger_dimension.reserved_amount::numeric
          ELSE (
            ledger_dimension.overrun_amount::numeric -
            ledger_dimension.released_amount::numeric
          )
        END
      ), 0::numeric)
    INTO limit_value, measurement_value, committed_value
    FROM public.proofstack_replay_plan_budgets AS budget
    LEFT JOIN public.proofstack_replay_budget_entry_dimensions AS ledger_dimension
      ON ledger_dimension.tenant_id = current_tenant_id
      AND ledger_dimension.job_id = expected_job_id
      AND ledger_dimension.dimension = budget.dimension
    WHERE budget.tenant_id = current_tenant_id
      AND budget.project_id = stored_job.project_id
      AND budget.environment_id = stored_job.environment_id
      AND budget.plan_id = stored_job.plan_id
      AND budget.plan_version_id = stored_job.plan_version_id
      AND budget.dimension = dimension_name
    GROUP BY budget.limit_value, budget.measurement;

    IF NOT FOUND
      OR committed_value NOT BETWEEN 0 AND 9007199254740991
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '55000',
        MESSAGE = 'Replay budget ledger has invalid committed amounts';
    END IF;
    requested_value := (expected_requested_amounts ->> dimension_name)::numeric;
    IF committed_value > limit_value::numeric - requested_value THEN
      RAISE EXCEPTION USING
        ERRCODE = '22003',
        MESSAGE = 'Replay budget reservation exceeds the immutable plan limit';
    END IF;
    dimensions_value := dimensions_value || jsonb_build_object(
      dimension_name,
      jsonb_build_object(
        'committedBefore', committed_value::bigint,
        'limit', limit_value,
        'measurement', measurement_value,
        'reservedAmount', requested_value::bigint
      )
    );
  END LOOP;

  reservation_value := jsonb_build_object(
    'dimensions', dimensions_value,
    'entryType', 'reservation',
    'ledgerSequence', ledger_count,
    'mutationFence', jsonb_build_object(
      'attemptId', expected_attempt_id,
      'fencingToken', expected_fencing_token,
      'jobId', expected_job_id,
      'leaseId', expected_lease_id,
      'recoveryEpoch', expected_recovery_epoch,
      'workerId', expected_worker_id
    ),
    'reservationId', expected_reservation_id,
    'reservedAt', now_lexical,
    'schemaVersion', '0.1',
    'scope', stored_job.job -> 'scope',
    'work', expected_work
  );

  INSERT INTO public.proofstack_replay_budget_entries (
    tenant_id,
    project_id,
    environment_id,
    job_id,
    ledger_sequence,
    schema_version,
    entry_type,
    entry_id,
    reservation_id,
    attempt_id,
    lease_id,
    worker_id,
    fencing_token,
    recovery_epoch,
    recorded_at,
    recorded_at_lexical,
    work_kind,
    work_boundary_id,
    work_boundary_kind,
    work_artifact_id,
    entry
  ) VALUES (
    current_tenant_id,
    expected_project_id,
    expected_environment_id,
    expected_job_id,
    ledger_count,
    '0.1',
    'reservation',
    expected_reservation_id,
    expected_reservation_id,
    expected_attempt_id,
    expected_lease_id,
    expected_worker_id,
    expected_fencing_token,
    expected_recovery_epoch,
    now_value,
    now_lexical,
    work_kind_value,
    work_boundary_id_value,
    work_boundary_kind_value,
    work_artifact_id_value,
    reservation_value
  );

  FOREACH dimension_name IN ARRAY expected_dimensions LOOP
    INSERT INTO public.proofstack_replay_budget_entry_dimensions (
      tenant_id,
      job_id,
      ledger_sequence,
      entry_type,
      dimension,
      limit_value,
      measurement,
      committed_before,
      reserved_amount
    ) VALUES (
      current_tenant_id,
      expected_job_id,
      ledger_count,
      'reservation',
      dimension_name,
      (dimensions_value #>> ARRAY[dimension_name, 'limit'])::bigint,
      dimensions_value #>> ARRAY[dimension_name, 'measurement'],
      (dimensions_value #>> ARRAY[dimension_name, 'committedBefore'])::bigint,
      (dimensions_value #>> ARRAY[dimension_name, 'reservedAmount'])::bigint
    );
  END LOOP;

  created := true;
  reservation := reservation_value;
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.proofstack_reserve_replay_budget(
  text,
  text,
  text,
  text,
  text,
  text,
  bigint,
  bigint,
  text,
  jsonb,
  jsonb
) FROM PUBLIC;
