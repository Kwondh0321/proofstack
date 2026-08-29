CREATE FUNCTION public.proofstack_replay_job_intent_status(
  expected_tenant_id text,
  expected_event_type text,
  expected_job_id text,
  expected_payload jsonb,
  expected_created_at timestamptz
)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT CASE
    WHEN expected_tenant_id IS DISTINCT FROM
      NULLIF(current_setting('proofstack.tenant_id', true), '')
      THEN 'absent'
    WHEN expected_tenant_id IS NULL
      OR expected_tenant_id !~ '^[a-z][a-z0-9_]{2,63}$'
      OR expected_job_id IS NULL
      OR expected_job_id !~ '^[a-z][a-z0-9_]{2,63}$'
      OR expected_event_type NOT IN (
        'replay.job.cancellation-requested',
        'replay.job.created',
        'replay.job.terminal'
      )
      OR jsonb_typeof(expected_payload) IS DISTINCT FROM 'object'
      OR expected_created_at IS NULL
      OR NOT isfinite(expected_created_at)
      THEN 'absent'
    WHEN NOT EXISTS (
      SELECT 1
      FROM public.proofstack_outbox
      WHERE tenant_id = expected_tenant_id
        AND event_type = expected_event_type
        AND aggregate_type = 'replay.job'
        AND aggregate_id = expected_job_id
    )
      THEN 'absent'
    WHEN EXISTS (
      SELECT 1
      FROM public.proofstack_outbox
      WHERE tenant_id = expected_tenant_id
        AND event_type = expected_event_type
        AND aggregate_type = 'replay.job'
        AND aggregate_id = expected_job_id
        AND schema_version = '0.1'
        AND payload = expected_payload
        AND created_at = expected_created_at
    )
      THEN 'canonical'
    ELSE 'conflict'
  END;
$$;

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
  current_tenant_id text;
  intent_payload jsonb;
  job_value jsonb;
  now_lexical text;
  now_value timestamptz;
  stored public.proofstack_replay_jobs%ROWTYPE;
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
    OR expected_plan_id IS NULL
    OR expected_plan_id !~ '^[a-z][a-z0-9_]{2,63}$'
    OR expected_plan_version_id IS NULL
    OR expected_plan_version_id !~ '^[a-z][a-z0-9_]{2,63}$'
    OR expected_plan_definition_sha256 IS NULL
    OR expected_plan_definition_sha256 !~ '^[0-9a-f]{64}$'
    OR expected_created_by_principal_id IS NULL
    OR expected_created_by_principal_id !~ '^[a-z][a-z0-9_]{2,63}$'
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'Invalid replay job creation authority input';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    'proofstack:replay-job:' || current_tenant_id || ':' || expected_job_id,
    0
  ));

  SELECT candidate.*
  INTO stored
  FROM public.proofstack_replay_jobs AS candidate
  WHERE candidate.tenant_id = current_tenant_id
    AND candidate.job_id = expected_job_id;

  IF FOUND THEN
    IF stored.project_id IS DISTINCT FROM expected_project_id
      OR stored.environment_id IS DISTINCT FROM expected_environment_id
      OR stored.plan_id IS DISTINCT FROM expected_plan_id
      OR stored.plan_version_id IS DISTINCT FROM expected_plan_version_id
      OR stored.plan_definition_sha256 IS DISTINCT FROM expected_plan_definition_sha256
      OR stored.created_by_principal_id IS DISTINCT FROM expected_created_by_principal_id
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '23505',
        MESSAGE = 'Replay job identity conflicts with its immutable creation input';
    END IF;

    intent_payload := jsonb_build_object(
      'definitionSha256', stored.plan_definition_sha256,
      'environmentId', stored.environment_id,
      'jobId', stored.job_id,
      'planId', stored.plan_id,
      'planVersionId', stored.plan_version_id,
      'projectId', stored.project_id
    );
    IF public.proofstack_replay_job_intent_status(
      stored.tenant_id,
      'replay.job.created',
      stored.job_id,
      intent_payload,
      stored.created_at
    ) IS DISTINCT FROM 'canonical'
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'Stored replay job is missing its canonical creation intent';
    END IF;

    created := false;
    job := stored.job;
    RETURN NEXT;
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.proofstack_replay_plans AS plan
    WHERE plan.tenant_id = current_tenant_id
      AND plan.project_id = expected_project_id
      AND plan.environment_id = expected_environment_id
      AND plan.plan_id = expected_plan_id
      AND plan.plan_version_id = expected_plan_version_id
      AND plan.definition_sha256 = expected_plan_definition_sha256
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23503',
      MESSAGE = 'Replay job requires an exact published plan';
  END IF;

  now_value := transaction_timestamp();
  now_lexical := to_char(
    now_value AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
  );
  now_value := now_lexical::timestamptz;
  job_value := jsonb_build_object(
    'createdAt', now_lexical,
    'createdByPrincipalId', expected_created_by_principal_id,
    'jobId', expected_job_id,
    'lastFencingToken', 0,
    'plan', jsonb_build_object(
      'definitionSha256', expected_plan_definition_sha256,
      'planId', expected_plan_id,
      'planVersionId', expected_plan_version_id
    ),
    'recoveryEpoch', 0,
    'schemaVersion', '0.1',
    'scope', jsonb_build_object(
      'environmentId', expected_environment_id,
      'projectId', expected_project_id,
      'tenantId', current_tenant_id
    ),
    'stateVersion', 1,
    'status', 'queued'
  );
  intent_payload := jsonb_build_object(
    'definitionSha256', expected_plan_definition_sha256,
    'environmentId', expected_environment_id,
    'jobId', expected_job_id,
    'planId', expected_plan_id,
    'planVersionId', expected_plan_version_id,
    'projectId', expected_project_id
  );

  PERFORM set_config('proofstack.replay_job_writer', 'stored-function-v1', true);
  INSERT INTO public.proofstack_replay_jobs (
    tenant_id,
    project_id,
    environment_id,
    job_id,
    schema_version,
    plan_id,
    plan_version_id,
    plan_definition_sha256,
    status,
    state_version,
    recovery_epoch,
    latest_attempt_sequence,
    last_fencing_token,
    created_at,
    created_at_lexical,
    created_by_principal_id,
    job
  ) VALUES (
    current_tenant_id,
    expected_project_id,
    expected_environment_id,
    expected_job_id,
    '0.1',
    expected_plan_id,
    expected_plan_version_id,
    expected_plan_definition_sha256,
    'queued',
    1,
    0,
    NULL,
    0,
    now_value,
    now_lexical,
    expected_created_by_principal_id,
    job_value
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
    'replay.job.created',
    'replay.job',
    expected_job_id,
    '0.1',
    intent_payload,
    now_value
  );

  created := true;
  job := job_value;
  RETURN NEXT;
END;
$$;

CREATE FUNCTION public.proofstack_request_replay_cancellation(
  expected_project_id text,
  expected_environment_id text,
  expected_job_id text,
  expected_cancellation_id text,
  expected_reason_code text,
  expected_reason text,
  expected_requested_by_principal_id text
)
RETURNS TABLE(created boolean, job jsonb, request jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  cancellation_intent_payload jsonb;
  current_tenant_id text;
  next_job jsonb;
  now_lexical text;
  now_value timestamptz;
  request_value jsonb;
  stored public.proofstack_replay_jobs%ROWTYPE;
  stored_request public.proofstack_replay_cancellation_requests%ROWTYPE;
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
    OR expected_cancellation_id IS NULL
    OR expected_cancellation_id !~ '^[a-z][a-z0-9_]{2,63}$'
    OR expected_reason_code IS NULL
    OR expected_reason_code NOT IN (
      'operator_request',
      'policy_intervention',
      'safety_intervention',
      'superseded'
    )
    OR expected_reason IS NULL
    OR char_length(expected_reason) NOT BETWEEN 1 AND 512
    OR expected_reason IS DISTINCT FROM btrim(expected_reason)
    OR expected_reason ~ '[[:cntrl:]]'
    OR expected_requested_by_principal_id IS NULL
    OR expected_requested_by_principal_id !~ '^[a-z][a-z0-9_]{2,63}$'
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'Invalid replay cancellation authority input';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    'proofstack:replay-job:' || current_tenant_id || ':' || expected_job_id,
    0
  ));
  SELECT candidate.*
  INTO stored
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
  INTO stored_request
  FROM public.proofstack_replay_cancellation_requests AS candidate
  WHERE candidate.tenant_id = current_tenant_id
    AND candidate.job_id = expected_job_id;

  IF FOUND THEN
    IF stored_request.cancellation_id IS DISTINCT FROM expected_cancellation_id
      OR stored_request.reason_code IS DISTINCT FROM expected_reason_code
      OR stored_request.reason IS DISTINCT FROM expected_reason
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '23505',
        MESSAGE = 'Replay cancellation identity conflicts with its immutable request';
    END IF;

    cancellation_intent_payload := jsonb_build_object(
      'cancellationId', stored_request.cancellation_id,
      'environmentId', stored.environment_id,
      'jobId', stored.job_id,
      'projectId', stored.project_id,
      'reasonCode', stored_request.reason_code
    );
    IF public.proofstack_replay_job_intent_status(
      current_tenant_id,
      'replay.job.cancellation-requested',
      stored.job_id,
      cancellation_intent_payload,
      stored_request.requested_at
    ) IS DISTINCT FROM 'canonical'
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'Stored replay cancellation is missing its canonical intent';
    END IF;

    IF stored.terminal_status IS NOT NULL THEN
      terminal_intent_payload := jsonb_build_object(
        'code', stored.terminal_code,
        'environmentId', stored.environment_id,
        'jobId', stored.job_id,
        'projectId', stored.project_id,
        'stateVersion', stored.state_version,
        'status', stored.status
      );
      IF public.proofstack_replay_job_intent_status(
        current_tenant_id,
        'replay.job.terminal',
        stored.job_id,
        terminal_intent_payload,
        stored.terminal_committed_at
      ) IS DISTINCT FROM 'canonical'
      THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          MESSAGE = 'Stored terminal replay job is missing its canonical intent';
      END IF;
    END IF;

    created := false;
    job := stored.job;
    request := stored_request.request;
    RETURN NEXT;
    RETURN;
  END IF;

  IF stored.status NOT IN ('queued', 'running') THEN
    created := false;
    job := stored.job;
    request := NULL;
    RETURN NEXT;
    RETURN;
  END IF;

  now_value := transaction_timestamp();
  now_lexical := to_char(
    now_value AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
  );
  now_value := now_lexical::timestamptz;
  request_value := jsonb_build_object(
    'cancellationId', expected_cancellation_id,
    'jobId', expected_job_id,
    'reason', expected_reason,
    'reasonCode', expected_reason_code,
    'requestedAt', now_lexical,
    'requestedByPrincipalId', expected_requested_by_principal_id,
    'schemaVersion', '0.1',
    'scope', jsonb_build_object(
      'environmentId', expected_environment_id,
      'projectId', expected_project_id,
      'tenantId', current_tenant_id
    )
  );
  cancellation_intent_payload := jsonb_build_object(
    'cancellationId', expected_cancellation_id,
    'environmentId', expected_environment_id,
    'jobId', expected_job_id,
    'projectId', expected_project_id,
    'reasonCode', expected_reason_code
  );

  INSERT INTO public.proofstack_replay_cancellation_requests (
    tenant_id,
    project_id,
    environment_id,
    job_id,
    cancellation_id,
    schema_version,
    reason_code,
    reason,
    requested_by_principal_id,
    requested_at,
    requested_at_lexical,
    request
  ) VALUES (
    current_tenant_id,
    expected_project_id,
    expected_environment_id,
    expected_job_id,
    expected_cancellation_id,
    '0.1',
    expected_reason_code,
    expected_reason,
    expected_requested_by_principal_id,
    now_value,
    now_lexical,
    request_value
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
    'replay.job.cancellation-requested',
    'replay.job',
    expected_job_id,
    '0.1',
    cancellation_intent_payload,
    now_value
  );

  next_job := stored.job;
  IF stored.status = 'queued' THEN
    IF stored.state_version >= 9007199254740991 THEN
      RAISE EXCEPTION USING
        ERRCODE = '22003',
        MESSAGE = 'Replay job state version is exhausted';
    END IF;
    next_job := stored.job || jsonb_build_object(
      'stateVersion', stored.state_version + 1,
      'status', 'cancelled',
      'terminal', jsonb_build_object(
        'code', 'cancellation_committed',
        'committedAt', now_lexical,
        'status', 'cancelled'
      )
    );
    PERFORM set_config('proofstack.replay_job_writer', 'stored-function-v1', true);
    UPDATE public.proofstack_replay_jobs
    SET status = 'cancelled',
      state_version = stored.state_version + 1,
      terminal_status = 'cancelled',
      terminal_code = 'cancellation_committed',
      terminal_attempt_id = NULL,
      terminal_committed_at = now_value,
      terminal_committed_at_lexical = now_lexical,
      job = next_job
    WHERE tenant_id = current_tenant_id
      AND job_id = expected_job_id
      AND state_version = stored.state_version;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = '40001',
        MESSAGE = 'Replay job changed during queued cancellation';
    END IF;

    terminal_intent_payload := jsonb_build_object(
      'code', 'cancellation_committed',
      'environmentId', expected_environment_id,
      'jobId', expected_job_id,
      'projectId', expected_project_id,
      'stateVersion', stored.state_version + 1,
      'status', 'cancelled'
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
  END IF;

  created := true;
  job := next_job;
  request := request_value;
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.proofstack_replay_job_intent_status(
  text,
  text,
  text,
  jsonb,
  timestamptz
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.proofstack_create_replay_job(
  text,
  text,
  text,
  text,
  text,
  text,
  text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.proofstack_request_replay_cancellation(
  text,
  text,
  text,
  text,
  text,
  text,
  text
) FROM PUBLIC;

ALTER POLICY proofstack_outbox_tenant_insert
  ON public.proofstack_outbox
  WITH CHECK (
    tenant_id = NULLIF(current_setting('proofstack.tenant_id', true), '')
    AND (
      event_type NOT LIKE 'replay.job.%'
      OR current_user = pg_get_userbyid(
        (SELECT relation.relowner
         FROM pg_class AS relation
         WHERE relation.oid = 'public.proofstack_outbox'::regclass)
      )
    )
  );
