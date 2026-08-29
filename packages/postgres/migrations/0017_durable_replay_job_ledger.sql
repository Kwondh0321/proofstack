CREATE FUNCTION public.proofstack_guard_replay_job_root_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF NULLIF(current_setting('proofstack.replay_job_writer', true), '') IS DISTINCT FROM
    'stored-function-v1'
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'Replay job root mutations require an audited stored function';
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

REVOKE ALL ON FUNCTION public.proofstack_guard_replay_job_root_mutation() FROM PUBLIC;

CREATE TABLE public.proofstack_replay_jobs (
  tenant_id varchar(64) NOT NULL,
  project_id varchar(64) NOT NULL,
  environment_id varchar(64) NOT NULL,
  job_id varchar(64) NOT NULL,
  schema_version varchar(16) NOT NULL,
  plan_id varchar(64) NOT NULL,
  plan_version_id varchar(64) NOT NULL,
  plan_definition_sha256 character(64) NOT NULL,
  status varchar(32) NOT NULL,
  state_version bigint NOT NULL,
  recovery_epoch bigint NOT NULL,
  latest_attempt_sequence bigint,
  last_fencing_token bigint NOT NULL,
  current_attempt_id varchar(64),
  current_lease_id varchar(64),
  current_worker_id varchar(64),
  current_fencing_token bigint,
  current_attempt_sequence bigint,
  current_lease_acquired_at timestamptz,
  current_lease_acquired_at_lexical text,
  current_lease_heartbeat_at timestamptz,
  current_lease_heartbeat_at_lexical text,
  current_lease_expires_at timestamptz,
  current_lease_expires_at_lexical text,
  started_at timestamptz,
  started_at_lexical text,
  terminal_status varchar(32),
  terminal_code varchar(32),
  terminal_attempt_id varchar(64),
  terminal_committed_at timestamptz,
  terminal_committed_at_lexical text,
  created_at timestamptz NOT NULL,
  created_at_lexical text NOT NULL,
  created_by_principal_id varchar(64) NOT NULL,
  job jsonb NOT NULL,

  CONSTRAINT proofstack_replay_jobs_pk PRIMARY KEY (tenant_id, job_id),
  CONSTRAINT proofstack_replay_jobs_scope_unique UNIQUE (
    tenant_id,
    project_id,
    environment_id,
    job_id
  ),
  CONSTRAINT proofstack_replay_jobs_plan_fk FOREIGN KEY (
    tenant_id,
    project_id,
    environment_id,
    plan_id,
    plan_version_id,
    plan_definition_sha256
  ) REFERENCES public.proofstack_replay_plans (
    tenant_id,
    project_id,
    environment_id,
    plan_id,
    plan_version_id,
    definition_sha256
  ),
  CONSTRAINT proofstack_replay_jobs_schema CHECK (schema_version = '0.1'),
  CONSTRAINT proofstack_replay_jobs_scope_format CHECK (
    tenant_id ~ '^[a-z][a-z0-9_]{2,63}$'
    AND project_id ~ '^[a-z][a-z0-9_]{2,63}$'
    AND environment_id ~ '^[a-z][a-z0-9_]{2,63}$'
    AND job_id ~ '^[a-z][a-z0-9_]{2,63}$'
    AND plan_id ~ '^[a-z][a-z0-9_]{2,63}$'
    AND plan_version_id ~ '^[a-z][a-z0-9_]{2,63}$'
    AND created_by_principal_id ~ '^[a-z][a-z0-9_]{2,63}$'
  ),
  CONSTRAINT proofstack_replay_jobs_digest CHECK (
    plan_definition_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT proofstack_replay_jobs_status CHECK (
    status IN (
      'budget_exhausted',
      'cancelled',
      'failed',
      'queued',
      'running',
      'succeeded',
      'timed_out'
    )
  ),
  CONSTRAINT proofstack_replay_jobs_counters CHECK (
    state_version BETWEEN 1 AND 9007199254740991
    AND recovery_epoch BETWEEN 0 AND 9007199254740991
    AND last_fencing_token BETWEEN 0 AND 9007199254740991
    AND (
      latest_attempt_sequence IS NULL
      OR latest_attempt_sequence BETWEEN 0 AND 9007199254740991
    )
    AND (
      current_attempt_sequence IS NULL
      OR current_attempt_sequence BETWEEN 0 AND 9007199254740991
    )
    AND (
      current_fencing_token IS NULL
      OR current_fencing_token BETWEEN 1 AND 9007199254740991
    )
  ),
  CONSTRAINT proofstack_replay_jobs_queued_shape CHECK (
    status <> 'queued'
    OR (
      latest_attempt_sequence IS NULL
      AND last_fencing_token = 0
      AND current_attempt_id IS NULL
      AND current_lease_id IS NULL
      AND current_worker_id IS NULL
      AND current_fencing_token IS NULL
      AND current_attempt_sequence IS NULL
      AND current_lease_acquired_at IS NULL
      AND current_lease_acquired_at_lexical IS NULL
      AND current_lease_heartbeat_at IS NULL
      AND current_lease_heartbeat_at_lexical IS NULL
      AND current_lease_expires_at IS NULL
      AND current_lease_expires_at_lexical IS NULL
      AND started_at IS NULL
      AND started_at_lexical IS NULL
      AND terminal_status IS NULL
      AND terminal_code IS NULL
      AND terminal_attempt_id IS NULL
      AND terminal_committed_at IS NULL
      AND terminal_committed_at_lexical IS NULL
    )
  ),
  CONSTRAINT proofstack_replay_jobs_running_shape CHECK (
    status <> 'running'
    OR (
      latest_attempt_sequence IS NOT NULL
      AND last_fencing_token > 0
      AND current_attempt_id ~ '^[a-z][a-z0-9_]{2,63}$'
      AND current_lease_id ~ '^[a-z][a-z0-9_]{2,63}$'
      AND current_worker_id ~ '^[a-z][a-z0-9_]{2,63}$'
      AND current_fencing_token = last_fencing_token
      AND current_attempt_sequence = latest_attempt_sequence
      AND current_lease_acquired_at IS NOT NULL
      AND current_lease_acquired_at_lexical IS NOT NULL
      AND current_lease_heartbeat_at IS NOT NULL
      AND current_lease_heartbeat_at_lexical IS NOT NULL
      AND current_lease_expires_at IS NOT NULL
      AND current_lease_expires_at_lexical IS NOT NULL
      AND started_at IS NOT NULL
      AND started_at_lexical IS NOT NULL
      AND terminal_status IS NULL
      AND terminal_code IS NULL
      AND terminal_attempt_id IS NULL
      AND terminal_committed_at IS NULL
      AND terminal_committed_at_lexical IS NULL
      AND current_lease_acquired_at <= current_lease_heartbeat_at
      AND current_lease_heartbeat_at < current_lease_expires_at
    )
  ),
  CONSTRAINT proofstack_replay_jobs_terminal_shape CHECK (
    status IN ('queued', 'running')
    OR (
      current_attempt_id IS NULL
      AND current_lease_id IS NULL
      AND current_worker_id IS NULL
      AND current_fencing_token IS NULL
      AND current_attempt_sequence IS NULL
      AND current_lease_acquired_at IS NULL
      AND current_lease_acquired_at_lexical IS NULL
      AND current_lease_heartbeat_at IS NULL
      AND current_lease_heartbeat_at_lexical IS NULL
      AND current_lease_expires_at IS NULL
      AND current_lease_expires_at_lexical IS NULL
      AND terminal_status = status
      AND terminal_code IS NOT NULL
      AND terminal_committed_at IS NOT NULL
      AND terminal_committed_at_lexical IS NOT NULL
      AND (
        (
          terminal_attempt_id IS NULL
          AND status = 'cancelled'
          AND latest_attempt_sequence IS NULL
          AND last_fencing_token = 0
          AND started_at IS NULL
          AND started_at_lexical IS NULL
        )
        OR (
          terminal_attempt_id IS NOT NULL
          AND latest_attempt_sequence IS NOT NULL
          AND last_fencing_token > 0
          AND started_at IS NOT NULL
          AND started_at_lexical IS NOT NULL
        )
      )
      AND (
        (
          status = 'cancelled'
          AND terminal_code = 'cancellation_committed'
          AND (
            terminal_attempt_id IS NULL
            OR terminal_attempt_id ~ '^[a-z][a-z0-9_]{2,63}$'
          )
        )
        OR (
          terminal_attempt_id ~ '^[a-z][a-z0-9_]{2,63}$'
          AND (
            (status = 'budget_exhausted' AND terminal_code = 'budget_limit_reached')
            OR (status = 'failed' AND terminal_code IN (
              'contract_rejected',
              'execution_failed',
              'retries_exhausted'
            ))
            OR (status = 'succeeded' AND terminal_code = 'completed')
            OR (status = 'timed_out' AND terminal_code = 'deadline_reached')
          )
        )
      )
    )
  ),
  CONSTRAINT proofstack_replay_jobs_times CHECK (
    isfinite(created_at)
    AND created_at_lexical ~
      '^[0-9]{4}-(0[1-9]|1[0-2])-([0-2][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\.[0-9]{3}Z$'
    AND created_at_lexical !~ '^0000-'
    AND created_at = created_at_lexical::timestamptz
    AND (started_at IS NULL OR (
      isfinite(started_at)
      AND started_at = started_at_lexical::timestamptz
      AND started_at >= created_at
    ))
    AND (current_lease_acquired_at IS NULL OR (
      isfinite(current_lease_acquired_at)
      AND current_lease_acquired_at = current_lease_acquired_at_lexical::timestamptz
    ))
    AND (current_lease_heartbeat_at IS NULL OR (
      isfinite(current_lease_heartbeat_at)
      AND current_lease_heartbeat_at = current_lease_heartbeat_at_lexical::timestamptz
    ))
    AND (current_lease_expires_at IS NULL OR (
      isfinite(current_lease_expires_at)
      AND current_lease_expires_at = current_lease_expires_at_lexical::timestamptz
    ))
    AND (terminal_committed_at IS NULL OR (
      isfinite(terminal_committed_at)
      AND terminal_committed_at = terminal_committed_at_lexical::timestamptz
      AND terminal_committed_at >= COALESCE(started_at, created_at)
    ))
  ),
  CONSTRAINT proofstack_replay_jobs_payload CHECK (
    (
      jsonb_typeof(job) = 'object'
      AND job ->> 'schemaVersion' = schema_version
      AND job ->> 'jobId' = job_id
      AND job ->> 'status' = status
      AND (job ->> 'stateVersion')::bigint = state_version
      AND (job ->> 'recoveryEpoch')::bigint = recovery_epoch
      AND (job ->> 'lastFencingToken')::bigint = last_fencing_token
      AND (job -> 'plan' ->> 'planId') = plan_id
      AND (job -> 'plan' ->> 'planVersionId') = plan_version_id
      AND (job -> 'plan' ->> 'definitionSha256') = plan_definition_sha256
      AND (job #>> '{scope,tenantId}') = tenant_id
      AND (job #>> '{scope,projectId}') = project_id
      AND (job #>> '{scope,environmentId}') = environment_id
      AND (job ->> 'createdAt') = created_at_lexical
      AND (job ->> 'createdByPrincipalId') = created_by_principal_id
      AND (job ->> 'startedAt') IS NOT DISTINCT FROM started_at_lexical
      AND (
        (job ->> 'latestAttemptSequence')::bigint
      ) IS NOT DISTINCT FROM latest_attempt_sequence
      AND (
        (
          status = 'running'
          AND job ? 'currentLease'
          AND job #>> '{currentLease,schemaVersion}' = '0.1'
          AND job #>> '{currentLease,mutationFence,jobId}' = job_id
          AND job #>> '{currentLease,mutationFence,attemptId}' = current_attempt_id
          AND job #>> '{currentLease,mutationFence,leaseId}' = current_lease_id
          AND job #>> '{currentLease,mutationFence,workerId}' = current_worker_id
          AND (job #>> '{currentLease,mutationFence,fencingToken}')::bigint =
            current_fencing_token
          AND (job #>> '{currentLease,mutationFence,recoveryEpoch}')::bigint = recovery_epoch
          AND (job #>> '{currentLease,attemptSequence}')::bigint = current_attempt_sequence
          AND job #>> '{currentLease,acquiredAt}' = current_lease_acquired_at_lexical
          AND job #>> '{currentLease,heartbeatAt}' = current_lease_heartbeat_at_lexical
          AND job #>> '{currentLease,expiresAt}' = current_lease_expires_at_lexical
        )
        OR (status <> 'running' AND NOT (job ? 'currentLease'))
      )
      AND (
        (
          status IN ('queued', 'running')
          AND NOT (job ? 'terminal')
        )
        OR (
          status NOT IN ('queued', 'running')
          AND job ? 'terminal'
          AND job #>> '{terminal,status}' = terminal_status
          AND job #>> '{terminal,code}' = terminal_code
          AND (job #>> '{terminal,attemptId}') IS NOT DISTINCT FROM terminal_attempt_id
          AND job #>> '{terminal,committedAt}' = terminal_committed_at_lexical
        )
      )
      AND pg_column_size(job) <= 262144
    ) IS TRUE
  )
);

CREATE TABLE public.proofstack_replay_attempts (
  tenant_id varchar(64) NOT NULL,
  project_id varchar(64) NOT NULL,
  environment_id varchar(64) NOT NULL,
  job_id varchar(64) NOT NULL,
  attempt_id varchar(64) NOT NULL,
  attempt_sequence bigint NOT NULL,
  schema_version varchar(16) NOT NULL,
  status varchar(32) NOT NULL,
  lease_id varchar(64) NOT NULL,
  worker_id varchar(64) NOT NULL,
  fencing_token bigint NOT NULL,
  recovery_epoch bigint NOT NULL,
  plan_id varchar(64) NOT NULL,
  plan_version_id varchar(64) NOT NULL,
  plan_definition_sha256 character(64) NOT NULL,
  target_id varchar(64) NOT NULL,
  target_release_id varchar(64) NOT NULL,
  target_definition_sha256 character(64) NOT NULL,
  worker_protocol_name varchar(256) NOT NULL,
  worker_protocol_version varchar(64) NOT NULL,
  worker_build_sha256 character(64) NOT NULL,
  started_at timestamptz NOT NULL,
  started_at_lexical text NOT NULL,
  ended_at timestamptz,
  ended_at_lexical text,
  retry_disposition varchar(32),
  error_code varchar(64),
  effect_certainty varchar(32),
  effect_retry_safety_kind varchar(64),
  result_artifact_id varchar(64),
  attempt jsonb NOT NULL,

  CONSTRAINT proofstack_replay_attempts_pk PRIMARY KEY (tenant_id, attempt_id),
  CONSTRAINT proofstack_replay_attempts_sequence_unique UNIQUE (
    tenant_id,
    job_id,
    attempt_sequence
  ),
  CONSTRAINT proofstack_replay_attempts_job_attempt_unique UNIQUE (
    tenant_id,
    job_id,
    attempt_id
  ),
  CONSTRAINT proofstack_replay_attempts_fence_unique UNIQUE (
    tenant_id,
    job_id,
    attempt_id,
    lease_id,
    worker_id,
    fencing_token,
    recovery_epoch
  ),
  CONSTRAINT proofstack_replay_attempts_job_fk FOREIGN KEY (
    tenant_id,
    project_id,
    environment_id,
    job_id
  ) REFERENCES public.proofstack_replay_jobs (
    tenant_id,
    project_id,
    environment_id,
    job_id
  ) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT proofstack_replay_attempts_plan_fk FOREIGN KEY (
    tenant_id,
    project_id,
    environment_id,
    plan_id,
    plan_version_id,
    plan_definition_sha256
  ) REFERENCES public.proofstack_replay_plans (
    tenant_id,
    project_id,
    environment_id,
    plan_id,
    plan_version_id,
    definition_sha256
  ),
  CONSTRAINT proofstack_replay_attempts_target_fk FOREIGN KEY (
    tenant_id,
    project_id,
    environment_id,
    target_id,
    target_release_id,
    target_definition_sha256
  ) REFERENCES public.proofstack_target_releases (
    tenant_id,
    project_id,
    environment_id,
    target_id,
    target_release_id,
    definition_sha256
  ),
  CONSTRAINT proofstack_replay_attempts_schema CHECK (schema_version = '0.1'),
  CONSTRAINT proofstack_replay_attempts_identity CHECK (
    attempt_id ~ '^[a-z][a-z0-9_]{2,63}$'
    AND lease_id ~ '^[a-z][a-z0-9_]{2,63}$'
    AND worker_id ~ '^[a-z][a-z0-9_]{2,63}$'
    AND attempt_sequence BETWEEN 0 AND 9007199254740991
    AND fencing_token BETWEEN 1 AND 9007199254740991
    AND recovery_epoch BETWEEN 0 AND 9007199254740991
  ),
  CONSTRAINT proofstack_replay_attempts_lineage CHECK (
    plan_definition_sha256 ~ '^[0-9a-f]{64}$'
    AND target_definition_sha256 ~ '^[0-9a-f]{64}$'
    AND worker_build_sha256 ~ '^[0-9a-f]{64}$'
    AND worker_protocol_name ~ '^[A-Za-z0-9][A-Za-z0-9._+:/@-]{0,255}$'
    AND worker_protocol_version ~ '^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$'
  ),
  CONSTRAINT proofstack_replay_attempts_status CHECK (
    status IN (
      'budget_exhausted',
      'cancelled',
      'failed',
      'lease_expired',
      'running',
      'succeeded',
      'timed_out'
    )
  ),
  CONSTRAINT proofstack_replay_attempts_outcome CHECK (
    (
      status = 'running'
      AND ended_at IS NULL
      AND ended_at_lexical IS NULL
      AND retry_disposition IS NULL
      AND error_code IS NULL
      AND effect_certainty IS NULL
      AND effect_retry_safety_kind IS NULL
      AND result_artifact_id IS NULL
    ) OR (
      status <> 'running'
      AND ended_at IS NOT NULL
      AND ended_at_lexical IS NOT NULL
      AND retry_disposition IN ('not_retryable', 'retry_eligible', 'retry_scheduled')
      AND (
        (status = 'succeeded' AND error_code IS NULL AND result_artifact_id IS NOT NULL)
        OR (status <> 'succeeded' AND error_code IS NOT NULL AND result_artifact_id IS NULL)
      )
    )
  ),
  CONSTRAINT proofstack_replay_attempts_effect CHECK (
    effect_certainty IS NULL
    OR (
      effect_certainty IN ('confirmed', 'may_have_occurred', 'none')
      AND ((effect_certainty = 'none') = (effect_retry_safety_kind IS NULL))
      AND (
        effect_retry_safety_kind IS NULL
        OR effect_retry_safety_kind IN (
          'destination_idempotency_verified',
          'not_retryable',
          'read_only'
        )
      )
    )
  ),
  CONSTRAINT proofstack_replay_attempts_times CHECK (
    isfinite(started_at)
    AND started_at = started_at_lexical::timestamptz
    AND (ended_at IS NULL OR (
      isfinite(ended_at)
      AND ended_at = ended_at_lexical::timestamptz
      AND ended_at >= started_at
    ))
  ),
  CONSTRAINT proofstack_replay_attempts_payload CHECK (
    (
      jsonb_typeof(attempt) = 'object'
      AND attempt ->> 'schemaVersion' = schema_version
      AND attempt ->> 'attemptId' = attempt_id
      AND attempt ->> 'jobId' = job_id
      AND attempt ->> 'status' = status
      AND (attempt ->> 'attemptSequence')::bigint = attempt_sequence
      AND (attempt #>> '{mutationFence,leaseId}') = lease_id
      AND (attempt #>> '{mutationFence,workerId}') = worker_id
      AND (attempt #>> '{mutationFence,fencingToken}')::bigint = fencing_token
      AND (attempt #>> '{mutationFence,recoveryEpoch}')::bigint = recovery_epoch
      AND attempt #>> '{plan,planId}' = plan_id
      AND attempt #>> '{plan,planVersionId}' = plan_version_id
      AND attempt #>> '{plan,definitionSha256}' = plan_definition_sha256
      AND attempt #>> '{targetRelease,targetId}' = target_id
      AND attempt #>> '{targetRelease,targetReleaseId}' = target_release_id
      AND attempt #>> '{targetRelease,definitionSha256}' = target_definition_sha256
      AND attempt #>> '{workerProtocol,name}' = worker_protocol_name
      AND attempt #>> '{workerProtocol,version}' = worker_protocol_version
      AND attempt ->> 'workerBuildSha256' = worker_build_sha256
      AND (attempt #>> '{scope,tenantId}') = tenant_id
      AND (attempt #>> '{scope,projectId}') = project_id
      AND (attempt #>> '{scope,environmentId}') = environment_id
      AND (attempt ->> 'startedAt') = started_at_lexical
      AND (attempt ->> 'endedAt') IS NOT DISTINCT FROM ended_at_lexical
      AND pg_column_size(attempt) <= 262144
    ) IS TRUE
  )
);

CREATE TABLE public.proofstack_replay_cancellation_requests (
  tenant_id varchar(64) NOT NULL,
  project_id varchar(64) NOT NULL,
  environment_id varchar(64) NOT NULL,
  job_id varchar(64) NOT NULL,
  cancellation_id varchar(64) NOT NULL,
  schema_version varchar(16) NOT NULL,
  reason_code varchar(32) NOT NULL,
  reason text NOT NULL,
  requested_by_principal_id varchar(64) NOT NULL,
  requested_at timestamptz NOT NULL,
  requested_at_lexical text NOT NULL,
  request jsonb NOT NULL,

  CONSTRAINT proofstack_replay_cancellation_requests_pk PRIMARY KEY (tenant_id, job_id),
  CONSTRAINT proofstack_replay_cancellation_requests_id_unique UNIQUE (
    tenant_id,
    cancellation_id
  ),
  CONSTRAINT proofstack_replay_cancellation_requests_job_id_unique UNIQUE (
    tenant_id,
    job_id,
    cancellation_id
  ),
  CONSTRAINT proofstack_replay_cancellation_requests_job_fk FOREIGN KEY (
    tenant_id,
    project_id,
    environment_id,
    job_id
  ) REFERENCES public.proofstack_replay_jobs (
    tenant_id,
    project_id,
    environment_id,
    job_id
  ) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT proofstack_replay_cancellation_requests_schema CHECK (schema_version = '0.1'),
  CONSTRAINT proofstack_replay_cancellation_requests_values CHECK (
    cancellation_id ~ '^[a-z][a-z0-9_]{2,63}$'
    AND requested_by_principal_id ~ '^[a-z][a-z0-9_]{2,63}$'
    AND reason_code IN (
      'operator_request',
      'policy_intervention',
      'safety_intervention',
      'superseded'
    )
    AND char_length(reason) BETWEEN 1 AND 512
    AND reason = btrim(reason)
    AND reason !~ '[[:cntrl:]]'
    AND isfinite(requested_at)
    AND requested_at = requested_at_lexical::timestamptz
  ),
  CONSTRAINT proofstack_replay_cancellation_requests_payload CHECK (
    (
      jsonb_typeof(request) = 'object'
      AND request ->> 'schemaVersion' = schema_version
      AND request ->> 'jobId' = job_id
      AND request ->> 'cancellationId' = cancellation_id
      AND request ->> 'reasonCode' = reason_code
      AND request ->> 'reason' = reason
      AND request ->> 'requestedByPrincipalId' = requested_by_principal_id
      AND request ->> 'requestedAt' = requested_at_lexical
      AND request #>> '{scope,tenantId}' = tenant_id
      AND request #>> '{scope,projectId}' = project_id
      AND request #>> '{scope,environmentId}' = environment_id
      AND pg_column_size(request) <= 16384
    ) IS TRUE
  )
);

CREATE TABLE public.proofstack_replay_cancellation_acknowledgements (
  tenant_id varchar(64) NOT NULL,
  project_id varchar(64) NOT NULL,
  environment_id varchar(64) NOT NULL,
  job_id varchar(64) NOT NULL,
  cancellation_id varchar(64) NOT NULL,
  acknowledgement_id varchar(64) NOT NULL,
  schema_version varchar(16) NOT NULL,
  action varchar(64) NOT NULL,
  attempt_id varchar(64) NOT NULL,
  lease_id varchar(64) NOT NULL,
  worker_id varchar(64) NOT NULL,
  fencing_token bigint NOT NULL,
  recovery_epoch bigint NOT NULL,
  acknowledged_at timestamptz NOT NULL,
  acknowledged_at_lexical text NOT NULL,
  acknowledgement jsonb NOT NULL,

  CONSTRAINT proofstack_replay_cancellation_acknowledgements_pk PRIMARY KEY (
    tenant_id,
    acknowledgement_id
  ),
  CONSTRAINT proofstack_replay_cancellation_acknowledgements_request_fk FOREIGN KEY (
    tenant_id,
    job_id,
    cancellation_id
  ) REFERENCES public.proofstack_replay_cancellation_requests (
    tenant_id,
    job_id,
    cancellation_id
  ),
  CONSTRAINT proofstack_replay_cancellation_acknowledgements_attempt_fk FOREIGN KEY (
    tenant_id,
    job_id,
    attempt_id,
    lease_id,
    worker_id,
    fencing_token,
    recovery_epoch
  ) REFERENCES public.proofstack_replay_attempts (
    tenant_id,
    job_id,
    attempt_id,
    lease_id,
    worker_id,
    fencing_token,
    recovery_epoch
  ),
  CONSTRAINT proofstack_replay_cancellation_acknowledgements_schema CHECK (
    schema_version = '0.1'
  ),
  CONSTRAINT proofstack_replay_cancellation_acknowledgements_values CHECK (
    acknowledgement_id ~ '^[a-z][a-z0-9_]{2,63}$'
    AND action IN (
      'observed_after_uninterruptible_completion',
      'stop_requested',
      'stopped_before_target_start'
    )
    AND fencing_token BETWEEN 1 AND 9007199254740991
    AND recovery_epoch BETWEEN 0 AND 9007199254740991
    AND isfinite(acknowledged_at)
    AND acknowledged_at = acknowledged_at_lexical::timestamptz
  ),
  CONSTRAINT proofstack_replay_cancellation_acknowledgements_payload CHECK (
    (
      jsonb_typeof(acknowledgement) = 'object'
      AND acknowledgement ->> 'schemaVersion' = schema_version
      AND acknowledgement ->> 'acknowledgementId' = acknowledgement_id
      AND acknowledgement ->> 'cancellationId' = cancellation_id
      AND acknowledgement ->> 'action' = action
      AND acknowledgement ->> 'acknowledgedAt' = acknowledged_at_lexical
      AND acknowledgement #>> '{mutationFence,jobId}' = job_id
      AND acknowledgement #>> '{mutationFence,attemptId}' = attempt_id
      AND acknowledgement #>> '{mutationFence,leaseId}' = lease_id
      AND acknowledgement #>> '{mutationFence,workerId}' = worker_id
      AND (acknowledgement #>> '{mutationFence,fencingToken}')::bigint = fencing_token
      AND (acknowledgement #>> '{mutationFence,recoveryEpoch}')::bigint = recovery_epoch
      AND acknowledgement #>> '{scope,tenantId}' = tenant_id
      AND acknowledgement #>> '{scope,projectId}' = project_id
      AND acknowledgement #>> '{scope,environmentId}' = environment_id
      AND pg_column_size(acknowledgement) <= 32768
    ) IS TRUE
  )
);

CREATE TABLE public.proofstack_replay_budget_entries (
  tenant_id varchar(64) NOT NULL,
  project_id varchar(64) NOT NULL,
  environment_id varchar(64) NOT NULL,
  job_id varchar(64) NOT NULL,
  ledger_sequence bigint NOT NULL,
  schema_version varchar(16) NOT NULL,
  entry_type varchar(32) NOT NULL,
  entry_id varchar(64) NOT NULL,
  reservation_id varchar(64) NOT NULL,
  attempt_id varchar(64) NOT NULL,
  lease_id varchar(64) NOT NULL,
  worker_id varchar(64) NOT NULL,
  fencing_token bigint NOT NULL,
  recovery_epoch bigint NOT NULL,
  recorded_at timestamptz NOT NULL,
  recorded_at_lexical text NOT NULL,
  work_kind varchar(32),
  work_boundary_id varchar(64),
  work_boundary_kind varchar(32),
  work_artifact_id varchar(64),
  entry jsonb NOT NULL,

  CONSTRAINT proofstack_replay_budget_entries_pk PRIMARY KEY (
    tenant_id,
    job_id,
    ledger_sequence
  ),
  CONSTRAINT proofstack_replay_budget_entries_id_unique UNIQUE (tenant_id, entry_id),
  CONSTRAINT proofstack_replay_budget_entries_kind_unique UNIQUE (
    tenant_id,
    job_id,
    ledger_sequence,
    entry_type
  ),
  CONSTRAINT proofstack_replay_budget_entries_reservation_reconciliation_unique UNIQUE (
    tenant_id,
    job_id,
    entry_type,
    reservation_id
  ),
  CONSTRAINT proofstack_replay_budget_entries_job_fk FOREIGN KEY (
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
  CONSTRAINT proofstack_replay_budget_entries_attempt_fk FOREIGN KEY (
    tenant_id,
    job_id,
    attempt_id,
    lease_id,
    worker_id,
    fencing_token,
    recovery_epoch
  ) REFERENCES public.proofstack_replay_attempts (
    tenant_id,
    job_id,
    attempt_id,
    lease_id,
    worker_id,
    fencing_token,
    recovery_epoch
  ),
  CONSTRAINT proofstack_replay_budget_entries_schema CHECK (schema_version = '0.1'),
  CONSTRAINT proofstack_replay_budget_entries_values CHECK (
    ledger_sequence BETWEEN 0 AND 9007199254740991
    AND entry_type IN ('reconciliation', 'reservation')
    AND entry_id ~ '^[a-z][a-z0-9_]{2,63}$'
    AND reservation_id ~ '^[a-z][a-z0-9_]{2,63}$'
    AND fencing_token BETWEEN 1 AND 9007199254740991
    AND recovery_epoch BETWEEN 0 AND 9007199254740991
    AND isfinite(recorded_at)
    AND recorded_at = recorded_at_lexical::timestamptz
  ),
  CONSTRAINT proofstack_replay_budget_entries_work CHECK (
    (
      entry_type = 'reconciliation'
      AND work_kind IS NULL
      AND work_boundary_id IS NULL
      AND work_boundary_kind IS NULL
      AND work_artifact_id IS NULL
    ) OR (
      entry_type = 'reservation'
      AND (
        (
          work_kind = 'attempt_start'
          AND work_boundary_id IS NULL
          AND work_boundary_kind IS NULL
          AND work_artifact_id IS NULL
        )
        OR (
          work_kind = 'boundary_call'
          AND work_boundary_id ~ '^[a-z][a-z0-9_]{2,63}$'
          AND work_boundary_kind IN ('model', 'tool')
          AND work_artifact_id IS NULL
        )
        OR (
          work_kind = 'artifact_emission'
          AND work_boundary_id IS NULL
          AND work_boundary_kind IS NULL
          AND work_artifact_id ~ '^[a-z][a-z0-9_]{2,63}$'
        )
      )
    )
  ),
  CONSTRAINT proofstack_replay_budget_entries_payload CHECK (
    (
      jsonb_typeof(entry) = 'object'
      AND entry ->> 'schemaVersion' = schema_version
      AND entry ->> 'entryType' = entry_type
      AND (entry ->> 'ledgerSequence')::bigint = ledger_sequence
      AND entry ->> 'reservationId' = reservation_id
      AND (
        (entry_type = 'reservation' AND entry ->> 'reservationId' = entry_id)
        OR (entry_type = 'reconciliation' AND entry ->> 'reconciliationId' = entry_id)
      )
      AND entry #>> '{mutationFence,jobId}' = job_id
      AND entry #>> '{mutationFence,attemptId}' = attempt_id
      AND entry #>> '{mutationFence,leaseId}' = lease_id
      AND entry #>> '{mutationFence,workerId}' = worker_id
      AND (entry #>> '{mutationFence,fencingToken}')::bigint = fencing_token
      AND (entry #>> '{mutationFence,recoveryEpoch}')::bigint = recovery_epoch
      AND entry #>> '{scope,tenantId}' = tenant_id
      AND entry #>> '{scope,projectId}' = project_id
      AND entry #>> '{scope,environmentId}' = environment_id
      AND pg_column_size(entry) <= 131072
    ) IS TRUE
  )
);

CREATE TABLE public.proofstack_replay_budget_entry_dimensions (
  tenant_id varchar(64) NOT NULL,
  job_id varchar(64) NOT NULL,
  ledger_sequence bigint NOT NULL,
  entry_type varchar(32) NOT NULL,
  dimension varchar(64) NOT NULL,
  limit_value bigint,
  measurement varchar(32),
  committed_before bigint,
  reserved_amount bigint NOT NULL,
  actual_status varchar(32),
  actual_amount bigint,
  actual_source varchar(32),
  unavailable_reason varchar(64),
  disposition varchar(32),
  released_amount bigint,
  overrun_amount bigint,

  CONSTRAINT proofstack_replay_budget_entry_dimensions_pk PRIMARY KEY (
    tenant_id,
    job_id,
    ledger_sequence,
    entry_type,
    dimension
  ),
  CONSTRAINT proofstack_replay_budget_entry_dimensions_entry_fk FOREIGN KEY (
    tenant_id,
    job_id,
    ledger_sequence,
    entry_type
  ) REFERENCES public.proofstack_replay_budget_entries (
    tenant_id,
    job_id,
    ledger_sequence,
    entry_type
  ) ON DELETE RESTRICT,
  CONSTRAINT proofstack_replay_budget_entry_dimensions_dimension CHECK (
    dimension IN (
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
    )
  ),
  CONSTRAINT proofstack_replay_budget_entry_dimensions_amounts CHECK (
    reserved_amount BETWEEN 0 AND 9007199254740991
    AND (
      limit_value IS NULL
      OR limit_value BETWEEN 1 AND 9007199254740991
    )
    AND (
      committed_before IS NULL
      OR committed_before BETWEEN 0 AND 9007199254740991
    )
    AND (actual_amount IS NULL OR actual_amount BETWEEN 0 AND 9007199254740991)
    AND (released_amount IS NULL OR released_amount BETWEEN 0 AND 9007199254740991)
    AND (overrun_amount IS NULL OR overrun_amount BETWEEN 0 AND 9007199254740991)
  ),
  CONSTRAINT proofstack_replay_budget_entry_dimensions_shape CHECK (
    (
      entry_type = 'reservation'
      AND actual_status IS NULL
      AND actual_amount IS NULL
      AND actual_source IS NULL
      AND unavailable_reason IS NULL
      AND disposition IS NULL
      AND released_amount IS NULL
      AND overrun_amount IS NULL
      AND limit_value IS NOT NULL
      AND measurement IN ('measured', 'provider_reported', 'unavailable')
      AND committed_before IS NOT NULL
      AND committed_before <= limit_value - reserved_amount
    ) OR (
      entry_type = 'reconciliation'
      AND limit_value IS NULL
      AND measurement IS NULL
      AND committed_before IS NULL
      AND actual_status IN ('observed', 'unavailable')
      AND disposition IN ('disputed', 'overrun', 'settled')
      AND released_amount IS NOT NULL
      AND overrun_amount IS NOT NULL
      AND (
        (
          actual_status = 'observed'
          AND actual_amount IS NOT NULL
          AND actual_source IN ('estimated', 'measured', 'provider_reported')
          AND unavailable_reason IS NULL
        ) OR (
          actual_status = 'unavailable'
          AND actual_amount IS NULL
          AND actual_source IS NULL
          AND unavailable_reason IN (
            'measurement_failed',
            'provider_did_not_report',
            'source_unavailable'
          )
          AND disposition = 'disputed'
          AND released_amount = 0
          AND overrun_amount = 0
        )
      )
    )
  )
);

CREATE TABLE public.proofstack_replay_observations (
  tenant_id varchar(64) NOT NULL,
  project_id varchar(64) NOT NULL,
  environment_id varchar(64) NOT NULL,
  job_id varchar(64) NOT NULL,
  observation_id varchar(64) NOT NULL,
  observation_sequence bigint NOT NULL,
  schema_version varchar(16) NOT NULL,
  observation_kind varchar(32) NOT NULL,
  payload_kind varchar(32),
  boundary_id varchar(64),
  source_event_sha256 character(64),
  attempt_id varchar(64) NOT NULL,
  lease_id varchar(64) NOT NULL,
  worker_id varchar(64) NOT NULL,
  fencing_token bigint NOT NULL,
  recovery_epoch bigint NOT NULL,
  observed_at timestamptz NOT NULL,
  observed_at_lexical text NOT NULL,
  observation jsonb NOT NULL,

  CONSTRAINT proofstack_replay_observations_pk PRIMARY KEY (tenant_id, observation_id),
  CONSTRAINT proofstack_replay_observations_sequence_unique UNIQUE (
    tenant_id,
    job_id,
    observation_sequence
  ),
  CONSTRAINT proofstack_replay_observations_kind_unique UNIQUE (
    tenant_id,
    observation_id,
    observation_kind
  ),
  CONSTRAINT proofstack_replay_observations_job_fk FOREIGN KEY (
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
  CONSTRAINT proofstack_replay_observations_attempt_fk FOREIGN KEY (
    tenant_id,
    job_id,
    attempt_id,
    lease_id,
    worker_id,
    fencing_token,
    recovery_epoch
  ) REFERENCES public.proofstack_replay_attempts (
    tenant_id,
    job_id,
    attempt_id,
    lease_id,
    worker_id,
    fencing_token,
    recovery_epoch
  ),
  CONSTRAINT proofstack_replay_observations_schema CHECK (schema_version = '0.1'),
  CONSTRAINT proofstack_replay_observations_values CHECK (
    observation_id ~ '^[a-z][a-z0-9_]{2,63}$'
    AND observation_sequence BETWEEN 0 AND 9007199254740991
    AND observation_kind IN ('execution', 'usage')
    AND fencing_token BETWEEN 1 AND 9007199254740991
    AND recovery_epoch BETWEEN 0 AND 9007199254740991
    AND isfinite(observed_at)
    AND observed_at = observed_at_lexical::timestamptz
  ),
  CONSTRAINT proofstack_replay_observations_kind CHECK (
    (
      observation_kind = 'execution'
      AND payload_kind IN ('boundary', 'cancellation', 'isolation', 'target')
      AND source_event_sha256 IS NULL
    ) OR (
      observation_kind = 'usage'
      AND payload_kind IS NULL
      AND source_event_sha256 ~ '^[0-9a-f]{64}$'
    )
  ),
  CONSTRAINT proofstack_replay_observations_payload CHECK (
    (
      jsonb_typeof(observation) = 'object'
      AND observation ->> 'schemaVersion' = schema_version
      AND observation ->> 'observationId' = observation_id
      AND (observation ->> 'observationSequence')::bigint = observation_sequence
      AND observation ->> 'observedAt' = observed_at_lexical
      AND observation #>> '{mutationFence,jobId}' = job_id
      AND observation #>> '{mutationFence,attemptId}' = attempt_id
      AND observation #>> '{mutationFence,leaseId}' = lease_id
      AND observation #>> '{mutationFence,workerId}' = worker_id
      AND (observation #>> '{mutationFence,fencingToken}')::bigint = fencing_token
      AND (observation #>> '{mutationFence,recoveryEpoch}')::bigint = recovery_epoch
      AND observation #>> '{scope,tenantId}' = tenant_id
      AND observation #>> '{scope,projectId}' = project_id
      AND observation #>> '{scope,environmentId}' = environment_id
      AND pg_column_size(observation) <= 262144
    ) IS TRUE
  )
);

CREATE TABLE public.proofstack_replay_usage_measurements (
  tenant_id varchar(64) NOT NULL,
  observation_id varchar(64) NOT NULL,
  observation_kind varchar(32) NOT NULL,
  dimension varchar(64) NOT NULL,
  usage_status varchar(32) NOT NULL,
  amount bigint,
  source varchar(32),
  unavailable_reason varchar(64),

  CONSTRAINT proofstack_replay_usage_measurements_pk PRIMARY KEY (
    tenant_id,
    observation_id,
    observation_kind,
    dimension
  ),
  CONSTRAINT proofstack_replay_usage_measurements_observation_fk FOREIGN KEY (
    tenant_id,
    observation_id,
    observation_kind
  ) REFERENCES public.proofstack_replay_observations (
    tenant_id,
    observation_id,
    observation_kind
  ),
  CONSTRAINT proofstack_replay_usage_measurements_kind CHECK (
    observation_kind = 'usage'
  ),
  CONSTRAINT proofstack_replay_usage_measurements_dimension CHECK (
    dimension IN (
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
    )
  ),
  CONSTRAINT proofstack_replay_usage_measurements_shape CHECK (
    (
      usage_status = 'observed'
      AND amount BETWEEN 0 AND 9007199254740991
      AND source IN ('estimated', 'measured', 'provider_reported')
      AND unavailable_reason IS NULL
    ) OR (
      usage_status = 'unavailable'
      AND amount IS NULL
      AND source IS NULL
      AND unavailable_reason IN (
        'measurement_failed',
        'provider_did_not_report',
        'source_unavailable'
      )
    )
  )
);

CREATE FUNCTION public.proofstack_verify_replay_budget_entry_dimensions()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  actual_count integer;
BEGIN
  SELECT count(*)::integer
  INTO actual_count
  FROM public.proofstack_replay_budget_entry_dimensions
  WHERE tenant_id = NEW.tenant_id
    AND job_id = NEW.job_id
    AND ledger_sequence = NEW.ledger_sequence;

  IF actual_count <> 10 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Replay budget entries require exactly ten normalized dimensions';
  END IF;

  RETURN NULL;
END;
$$;

CREATE FUNCTION public.proofstack_verify_replay_usage_measurements()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  actual_count integer;
BEGIN
  SELECT count(*)::integer
  INTO actual_count
  FROM public.proofstack_replay_usage_measurements
  WHERE tenant_id = NEW.tenant_id
    AND observation_id = NEW.observation_id;

  IF (NEW.observation_kind = 'execution' AND actual_count <> 0)
    OR (NEW.observation_kind = 'usage' AND actual_count NOT BETWEEN 1 AND 10)
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Replay observations have an invalid normalized usage measurement set';
  END IF;

  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.proofstack_verify_replay_budget_entry_dimensions() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.proofstack_verify_replay_usage_measurements() FROM PUBLIC;

CREATE TRIGGER proofstack_replay_jobs_root_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.proofstack_replay_jobs
  FOR EACH ROW
  EXECUTE FUNCTION public.proofstack_guard_replay_job_root_mutation();

CREATE TRIGGER proofstack_replay_attempts_append_only
  BEFORE UPDATE OR DELETE ON public.proofstack_replay_attempts
  FOR EACH ROW
  EXECUTE FUNCTION public.proofstack_reject_append_only_mutation();

CREATE TRIGGER proofstack_replay_cancellation_requests_append_only
  BEFORE UPDATE OR DELETE ON public.proofstack_replay_cancellation_requests
  FOR EACH ROW
  EXECUTE FUNCTION public.proofstack_reject_append_only_mutation();

CREATE TRIGGER proofstack_replay_cancellation_acknowledgements_append_only
  BEFORE UPDATE OR DELETE ON public.proofstack_replay_cancellation_acknowledgements
  FOR EACH ROW
  EXECUTE FUNCTION public.proofstack_reject_append_only_mutation();

CREATE TRIGGER proofstack_replay_budget_entries_append_only
  BEFORE UPDATE OR DELETE ON public.proofstack_replay_budget_entries
  FOR EACH ROW
  EXECUTE FUNCTION public.proofstack_reject_append_only_mutation();

CREATE TRIGGER proofstack_replay_budget_entry_dimensions_append_only
  BEFORE UPDATE OR DELETE ON public.proofstack_replay_budget_entry_dimensions
  FOR EACH ROW
  EXECUTE FUNCTION public.proofstack_reject_append_only_mutation();

CREATE TRIGGER proofstack_replay_observations_append_only
  BEFORE UPDATE OR DELETE ON public.proofstack_replay_observations
  FOR EACH ROW
  EXECUTE FUNCTION public.proofstack_reject_append_only_mutation();

CREATE TRIGGER proofstack_replay_usage_measurements_append_only
  BEFORE UPDATE OR DELETE ON public.proofstack_replay_usage_measurements
  FOR EACH ROW
  EXECUTE FUNCTION public.proofstack_reject_append_only_mutation();

CREATE CONSTRAINT TRIGGER proofstack_replay_budget_entries_dimensions_complete
  AFTER INSERT ON public.proofstack_replay_budget_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION public.proofstack_verify_replay_budget_entry_dimensions();

CREATE CONSTRAINT TRIGGER proofstack_replay_observations_measurements_complete
  AFTER INSERT ON public.proofstack_replay_observations
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION public.proofstack_verify_replay_usage_measurements();

ALTER TABLE public.proofstack_replay_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.proofstack_replay_jobs FORCE ROW LEVEL SECURITY;
ALTER TABLE public.proofstack_replay_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.proofstack_replay_attempts FORCE ROW LEVEL SECURITY;
ALTER TABLE public.proofstack_replay_cancellation_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.proofstack_replay_cancellation_requests FORCE ROW LEVEL SECURITY;
ALTER TABLE public.proofstack_replay_cancellation_acknowledgements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.proofstack_replay_cancellation_acknowledgements FORCE ROW LEVEL SECURITY;
ALTER TABLE public.proofstack_replay_budget_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.proofstack_replay_budget_entries FORCE ROW LEVEL SECURITY;
ALTER TABLE public.proofstack_replay_budget_entry_dimensions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.proofstack_replay_budget_entry_dimensions FORCE ROW LEVEL SECURITY;
ALTER TABLE public.proofstack_replay_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.proofstack_replay_observations FORCE ROW LEVEL SECURITY;
ALTER TABLE public.proofstack_replay_usage_measurements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.proofstack_replay_usage_measurements FORCE ROW LEVEL SECURITY;

CREATE POLICY proofstack_replay_jobs_tenant_select
  ON public.proofstack_replay_jobs FOR SELECT
  USING (tenant_id = NULLIF(current_setting('proofstack.tenant_id', true), ''));
CREATE POLICY proofstack_replay_jobs_tenant_insert
  ON public.proofstack_replay_jobs FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('proofstack.tenant_id', true), ''));
CREATE POLICY proofstack_replay_jobs_tenant_update
  ON public.proofstack_replay_jobs FOR UPDATE
  USING (tenant_id = NULLIF(current_setting('proofstack.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('proofstack.tenant_id', true), ''));

CREATE POLICY proofstack_replay_attempts_tenant_select
  ON public.proofstack_replay_attempts FOR SELECT
  USING (tenant_id = NULLIF(current_setting('proofstack.tenant_id', true), ''));
CREATE POLICY proofstack_replay_attempts_tenant_insert
  ON public.proofstack_replay_attempts FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('proofstack.tenant_id', true), ''));

CREATE POLICY proofstack_replay_cancellation_requests_tenant_select
  ON public.proofstack_replay_cancellation_requests FOR SELECT
  USING (tenant_id = NULLIF(current_setting('proofstack.tenant_id', true), ''));
CREATE POLICY proofstack_replay_cancellation_requests_tenant_insert
  ON public.proofstack_replay_cancellation_requests FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('proofstack.tenant_id', true), ''));

CREATE POLICY proofstack_replay_cancellation_acknowledgements_tenant_select
  ON public.proofstack_replay_cancellation_acknowledgements FOR SELECT
  USING (tenant_id = NULLIF(current_setting('proofstack.tenant_id', true), ''));
CREATE POLICY proofstack_replay_cancellation_acknowledgements_tenant_insert
  ON public.proofstack_replay_cancellation_acknowledgements FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('proofstack.tenant_id', true), ''));

CREATE POLICY proofstack_replay_budget_entries_tenant_select
  ON public.proofstack_replay_budget_entries FOR SELECT
  USING (tenant_id = NULLIF(current_setting('proofstack.tenant_id', true), ''));
CREATE POLICY proofstack_replay_budget_entries_tenant_insert
  ON public.proofstack_replay_budget_entries FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('proofstack.tenant_id', true), ''));

CREATE POLICY proofstack_replay_budget_entry_dimensions_tenant_select
  ON public.proofstack_replay_budget_entry_dimensions FOR SELECT
  USING (tenant_id = NULLIF(current_setting('proofstack.tenant_id', true), ''));
CREATE POLICY proofstack_replay_budget_entry_dimensions_tenant_insert
  ON public.proofstack_replay_budget_entry_dimensions FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('proofstack.tenant_id', true), ''));

CREATE POLICY proofstack_replay_observations_tenant_select
  ON public.proofstack_replay_observations FOR SELECT
  USING (tenant_id = NULLIF(current_setting('proofstack.tenant_id', true), ''));
CREATE POLICY proofstack_replay_observations_tenant_insert
  ON public.proofstack_replay_observations FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('proofstack.tenant_id', true), ''));

CREATE POLICY proofstack_replay_usage_measurements_tenant_select
  ON public.proofstack_replay_usage_measurements FOR SELECT
  USING (tenant_id = NULLIF(current_setting('proofstack.tenant_id', true), ''));
CREATE POLICY proofstack_replay_usage_measurements_tenant_insert
  ON public.proofstack_replay_usage_measurements FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('proofstack.tenant_id', true), ''));

REVOKE ALL ON TABLE
  public.proofstack_replay_jobs,
  public.proofstack_replay_attempts,
  public.proofstack_replay_cancellation_requests,
  public.proofstack_replay_cancellation_acknowledgements,
  public.proofstack_replay_budget_entries,
  public.proofstack_replay_budget_entry_dimensions,
  public.proofstack_replay_observations,
  public.proofstack_replay_usage_measurements
FROM PUBLIC;
