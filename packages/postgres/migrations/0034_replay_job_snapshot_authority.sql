CREATE FUNCTION public.proofstack_read_replay_job_snapshot(
  expected_project_id text,
  expected_environment_id text,
  expected_job_id text
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT jsonb_build_object(
    'attempts', COALESCE((
      SELECT jsonb_agg(attempt.attempt ORDER BY attempt.attempt_sequence)
      FROM public.proofstack_replay_attempts AS attempt
      WHERE attempt.tenant_id = job.tenant_id
        AND attempt.project_id = job.project_id
        AND attempt.environment_id = job.environment_id
        AND attempt.job_id = job.job_id
    ), '[]'::jsonb),
    'budgetLedger', COALESCE((
      SELECT jsonb_agg(entry.entry ORDER BY entry.ledger_sequence)
      FROM public.proofstack_replay_budget_entries AS entry
      WHERE entry.tenant_id = job.tenant_id
        AND entry.project_id = job.project_id
        AND entry.environment_id = job.environment_id
        AND entry.job_id = job.job_id
    ), '[]'::jsonb),
    'cancellationAcknowledgements', COALESCE((
      SELECT jsonb_agg(
        acknowledgement.acknowledgement
        ORDER BY acknowledgement.acknowledged_at, acknowledgement.acknowledgement_id
      )
      FROM public.proofstack_replay_cancellation_acknowledgements AS acknowledgement
      WHERE acknowledgement.tenant_id = job.tenant_id
        AND acknowledgement.project_id = job.project_id
        AND acknowledgement.environment_id = job.environment_id
        AND acknowledgement.job_id = job.job_id
    ), '[]'::jsonb),
    'cancellationRequest', (
      SELECT request.request
      FROM public.proofstack_replay_cancellation_requests AS request
      WHERE request.tenant_id = job.tenant_id
        AND request.project_id = job.project_id
        AND request.environment_id = job.environment_id
        AND request.job_id = job.job_id
    ),
    'executionObservations', COALESCE((
      SELECT jsonb_agg(observation.observation ORDER BY observation.observation_sequence)
      FROM public.proofstack_replay_observations AS observation
      WHERE observation.tenant_id = job.tenant_id
        AND observation.project_id = job.project_id
        AND observation.environment_id = job.environment_id
        AND observation.job_id = job.job_id
        AND observation.observation_kind = 'execution'
    ), '[]'::jsonb),
    'job', job.job,
    'usageObservations', COALESCE((
      SELECT jsonb_agg(observation.observation ORDER BY observation.observation_sequence)
      FROM public.proofstack_replay_observations AS observation
      WHERE observation.tenant_id = job.tenant_id
        AND observation.project_id = job.project_id
        AND observation.environment_id = job.environment_id
        AND observation.job_id = job.job_id
        AND observation.observation_kind = 'usage'
    ), '[]'::jsonb)
  )
  FROM public.proofstack_replay_jobs AS job
  WHERE job.tenant_id = NULLIF(current_setting('proofstack.tenant_id', true), '')
    AND job.project_id = expected_project_id
    AND job.environment_id = expected_environment_id
    AND job.job_id = expected_job_id
    AND NULLIF(current_setting('proofstack.tenant_id', true), '') ~
      '^[a-z][a-z0-9_]{2,63}$'
    AND expected_project_id ~ '^[a-z][a-z0-9_]{2,63}$'
    AND expected_environment_id ~ '^[a-z][a-z0-9_]{2,63}$'
    AND expected_job_id ~ '^[a-z][a-z0-9_]{2,63}$';
$$;

REVOKE ALL ON FUNCTION public.proofstack_read_replay_job_snapshot(
  text,
  text,
  text
) FROM PUBLIC;
