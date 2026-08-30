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
DECLARE
  actual_amount_value numeric;
  actual_source_value text;
  actual_status_value text;
  actual_usage_value jsonb;
  committed_value numeric;
  current_tenant_id text;
  dimension_name text;
  dimensions_value jsonb := '{}'::jsonb;
  disposition_value text;
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
  now_lexical text;
  now_value timestamptz;
  overrun_amount_value bigint;
  reconciliation_value jsonb;
  released_amount_value bigint;
  reservation_dimension_count integer;
  reserved_amount_value bigint;
  stored_job public.proofstack_replay_jobs%ROWTYPE;
  stored_reservation public.proofstack_replay_budget_entries%ROWTYPE;
  unavailable_reason_value text;
  usage_keys text[];
  usage_value jsonb;
  usage_value_keys text[];
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
    OR expected_reconciliation_id IS NULL
    OR expected_reconciliation_id !~ '^[a-z][a-z0-9_]{2,63}$'
    OR expected_reservation_id IS NULL
    OR expected_reservation_id !~ '^[a-z][a-z0-9_]{2,63}$'
    OR jsonb_typeof(expected_usage) IS DISTINCT FROM 'object'
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'Invalid replay budget reconciliation input';
  END IF;

  SELECT array_agg(key ORDER BY key)
  INTO usage_keys
  FROM jsonb_object_keys(expected_usage) AS usage(key);
  IF usage_keys IS DISTINCT FROM expected_dimensions THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'Replay budget reconciliation requires every exact budget dimension';
  END IF;
  FOREACH dimension_name IN ARRAY expected_dimensions LOOP
    usage_value := expected_usage -> dimension_name;
    IF jsonb_typeof(usage_value) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION USING
        ERRCODE = '22023',
        MESSAGE = 'Replay budget usage measurement is invalid';
    END IF;
    actual_status_value := usage_value ->> 'status';
    SELECT array_agg(key ORDER BY key)
    INTO usage_value_keys
    FROM jsonb_object_keys(usage_value) AS usage_field(key);
    IF actual_status_value = 'observed' THEN
      IF usage_value_keys IS DISTINCT FROM ARRAY['amount', 'source', 'status']::text[]
        OR jsonb_typeof(usage_value -> 'amount') IS DISTINCT FROM 'number'
        OR jsonb_typeof(usage_value -> 'source') IS DISTINCT FROM 'string'
        OR usage_value ->> 'source' NOT IN ('estimated', 'measured', 'provider_reported')
      THEN
        RAISE EXCEPTION USING
          ERRCODE = '22023',
          MESSAGE = 'Observed replay budget usage is invalid';
      END IF;
      actual_amount_value := (usage_value ->> 'amount')::numeric;
      IF actual_amount_value <> trunc(actual_amount_value)
        OR actual_amount_value NOT BETWEEN 0 AND 9007199254740991
      THEN
        RAISE EXCEPTION USING
          ERRCODE = '22023',
          MESSAGE = 'Observed replay budget usage amount is invalid';
      END IF;
    ELSIF actual_status_value = 'unavailable' THEN
      IF usage_value_keys IS DISTINCT FROM ARRAY['reason', 'status']::text[]
        OR jsonb_typeof(usage_value -> 'reason') IS DISTINCT FROM 'string'
        OR usage_value ->> 'reason' NOT IN (
          'measurement_failed',
          'provider_did_not_report',
          'source_unavailable'
        )
      THEN
        RAISE EXCEPTION USING
          ERRCODE = '22023',
          MESSAGE = 'Unavailable replay budget usage is invalid';
      END IF;
    ELSE
      RAISE EXCEPTION USING
        ERRCODE = '22023',
        MESSAGE = 'Replay budget usage status is invalid';
    END IF;
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
      MESSAGE = 'Replay budget reconciliation server time moved backwards';
  END IF;
  IF now_value >= stored_job.current_lease_expires_at THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'Replay worker lease is expired';
  END IF;

  SELECT candidate.*
  INTO stored_reservation
  FROM public.proofstack_replay_budget_entries AS candidate
  WHERE candidate.tenant_id = current_tenant_id
    AND candidate.project_id = expected_project_id
    AND candidate.environment_id = expected_environment_id
    AND candidate.job_id = expected_job_id
    AND candidate.entry_type = 'reservation'
    AND candidate.reservation_id = expected_reservation_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0002',
      MESSAGE = 'Replay budget reservation is unavailable';
  END IF;
  IF stored_reservation.attempt_id IS DISTINCT FROM expected_attempt_id
    OR stored_reservation.lease_id IS DISTINCT FROM expected_lease_id
    OR stored_reservation.worker_id IS DISTINCT FROM expected_worker_id
    OR stored_reservation.fencing_token IS DISTINCT FROM expected_fencing_token
    OR stored_reservation.recovery_epoch IS DISTINCT FROM expected_recovery_epoch
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'Replay budget reservation belongs to another worker fence';
  END IF;
  SELECT count(*)::integer
  INTO reservation_dimension_count
  FROM public.proofstack_replay_budget_entry_dimensions AS dimension
  WHERE dimension.tenant_id = current_tenant_id
    AND dimension.job_id = expected_job_id
    AND dimension.ledger_sequence = stored_reservation.ledger_sequence
    AND dimension.entry_type = 'reservation';
  IF reservation_dimension_count <> 10 THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'Replay budget reservation has incomplete normalized dimensions';
  END IF;

  FOREACH dimension_name IN ARRAY expected_dimensions LOOP
    SELECT dimension.reserved_amount
    INTO reserved_amount_value
    FROM public.proofstack_replay_budget_entry_dimensions AS dimension
    WHERE dimension.tenant_id = current_tenant_id
      AND dimension.job_id = expected_job_id
      AND dimension.ledger_sequence = stored_reservation.ledger_sequence
      AND dimension.entry_type = 'reservation'
      AND dimension.dimension = dimension_name;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = '55000',
        MESSAGE = 'Replay budget reservation dimension is unavailable';
    END IF;

    usage_value := expected_usage -> dimension_name;
    actual_status_value := usage_value ->> 'status';
    IF actual_status_value = 'unavailable' THEN
      unavailable_reason_value := usage_value ->> 'reason';
      actual_usage_value := jsonb_build_object(
        'reason', unavailable_reason_value,
        'status', 'unavailable'
      );
      disposition_value := 'disputed';
      released_amount_value := 0;
      overrun_amount_value := 0;
    ELSE
      actual_amount_value := (usage_value ->> 'amount')::numeric;
      actual_source_value := usage_value ->> 'source';
      actual_usage_value := jsonb_build_object(
        'amount', actual_amount_value::bigint,
        'source', actual_source_value,
        'status', 'observed'
      );
      IF actual_amount_value <= reserved_amount_value THEN
        disposition_value := 'settled';
        released_amount_value := reserved_amount_value - actual_amount_value::bigint;
        overrun_amount_value := 0;
      ELSE
        disposition_value := 'overrun';
        released_amount_value := 0;
        overrun_amount_value := (actual_amount_value - reserved_amount_value)::bigint;
      END IF;
    END IF;
    dimensions_value := dimensions_value || jsonb_build_object(
      dimension_name,
      jsonb_build_object(
        'actualUsage', actual_usage_value,
        'disposition', disposition_value,
        'overrunAmount', overrun_amount_value,
        'releasedAmount', released_amount_value,
        'reservedAmount', reserved_amount_value
      )
    );
  END LOOP;

  SELECT candidate.*
  INTO existing_entry
  FROM public.proofstack_replay_budget_entries AS candidate
  WHERE candidate.tenant_id = current_tenant_id
    AND candidate.entry_id = expected_reconciliation_id;
  IF FOUND THEN
    IF existing_entry.entry_type <> 'reconciliation'
      OR existing_entry.project_id IS DISTINCT FROM expected_project_id
      OR existing_entry.environment_id IS DISTINCT FROM expected_environment_id
      OR existing_entry.job_id IS DISTINCT FROM expected_job_id
      OR existing_entry.reservation_id IS DISTINCT FROM expected_reservation_id
      OR existing_entry.attempt_id IS DISTINCT FROM expected_attempt_id
      OR existing_entry.lease_id IS DISTINCT FROM expected_lease_id
      OR existing_entry.worker_id IS DISTINCT FROM expected_worker_id
      OR existing_entry.fencing_token IS DISTINCT FROM expected_fencing_token
      OR existing_entry.recovery_epoch IS DISTINCT FROM expected_recovery_epoch
      OR existing_entry.entry -> 'dimensions' IS DISTINCT FROM dimensions_value
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '23505',
        MESSAGE = 'Replay budget reconciliation conflicts with its immutable identity';
    END IF;
    created := false;
    reconciliation := existing_entry.entry;
    RETURN NEXT;
    RETURN;
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.proofstack_replay_budget_entries AS candidate
    WHERE candidate.tenant_id = current_tenant_id
      AND candidate.job_id = expected_job_id
      AND candidate.entry_type = 'reconciliation'
      AND candidate.reservation_id = expected_reservation_id
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23505',
      MESSAGE = 'Replay budget reservation is already reconciled';
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
    SELECT COALESCE(sum(
      CASE ledger_dimension.entry_type
        WHEN 'reservation' THEN ledger_dimension.reserved_amount::numeric
        ELSE (
          ledger_dimension.overrun_amount::numeric -
          ledger_dimension.released_amount::numeric
        )
      END
    ), 0::numeric)
    INTO committed_value
    FROM public.proofstack_replay_budget_entry_dimensions AS ledger_dimension
    WHERE ledger_dimension.tenant_id = current_tenant_id
      AND ledger_dimension.job_id = expected_job_id
      AND ledger_dimension.dimension = dimension_name;
    released_amount_value := (
      dimensions_value #>> ARRAY[dimension_name, 'releasedAmount']
    )::bigint;
    overrun_amount_value := (
      dimensions_value #>> ARRAY[dimension_name, 'overrunAmount']
    )::bigint;
    IF committed_value < released_amount_value
      OR committed_value - released_amount_value + overrun_amount_value > 9007199254740991
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '22003',
        MESSAGE = 'Replay budget reconciliation would overflow committed accounting';
    END IF;
  END LOOP;

  reconciliation_value := jsonb_build_object(
    'dimensions', dimensions_value,
    'entryType', 'reconciliation',
    'ledgerSequence', ledger_count,
    'mutationFence', stored_reservation.entry -> 'mutationFence',
    'reconciledAt', now_lexical,
    'reconciliationId', expected_reconciliation_id,
    'reservationId', expected_reservation_id,
    'schemaVersion', '0.1',
    'scope', stored_job.job -> 'scope'
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
    entry
  ) VALUES (
    current_tenant_id,
    expected_project_id,
    expected_environment_id,
    expected_job_id,
    ledger_count,
    '0.1',
    'reconciliation',
    expected_reconciliation_id,
    expected_reservation_id,
    expected_attempt_id,
    expected_lease_id,
    expected_worker_id,
    expected_fencing_token,
    expected_recovery_epoch,
    now_value,
    now_lexical,
    reconciliation_value
  );

  FOREACH dimension_name IN ARRAY expected_dimensions LOOP
    usage_value := dimensions_value #> ARRAY[dimension_name, 'actualUsage'];
    actual_status_value := usage_value ->> 'status';
    INSERT INTO public.proofstack_replay_budget_entry_dimensions (
      tenant_id,
      job_id,
      ledger_sequence,
      entry_type,
      dimension,
      reserved_amount,
      actual_status,
      actual_amount,
      actual_source,
      unavailable_reason,
      disposition,
      released_amount,
      overrun_amount
    ) VALUES (
      current_tenant_id,
      expected_job_id,
      ledger_count,
      'reconciliation',
      dimension_name,
      (dimensions_value #>> ARRAY[dimension_name, 'reservedAmount'])::bigint,
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
      END,
      dimensions_value #>> ARRAY[dimension_name, 'disposition'],
      (dimensions_value #>> ARRAY[dimension_name, 'releasedAmount'])::bigint,
      (dimensions_value #>> ARRAY[dimension_name, 'overrunAmount'])::bigint
    );
  END LOOP;

  created := true;
  reconciliation := reconciliation_value;
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.proofstack_reconcile_replay_budget(
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
  jsonb
) FROM PUBLIC;
