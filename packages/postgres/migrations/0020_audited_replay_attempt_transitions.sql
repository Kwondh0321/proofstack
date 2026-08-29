CREATE TABLE public.proofstack_replay_attempt_events (
  tenant_id varchar(64) NOT NULL,
  project_id varchar(64) NOT NULL,
  environment_id varchar(64) NOT NULL,
  job_id varchar(64) NOT NULL,
  attempt_id varchar(64) NOT NULL,
  transition_sequence bigint NOT NULL,
  schema_version varchar(16) NOT NULL,
  event_type varchar(32) NOT NULL,
  status varchar(32) NOT NULL,
  occurred_at timestamptz NOT NULL,
  occurred_at_lexical text NOT NULL,
  event jsonb NOT NULL,

  CONSTRAINT proofstack_replay_attempt_events_pk PRIMARY KEY (
    tenant_id,
    attempt_id,
    transition_sequence
  ),
  CONSTRAINT proofstack_replay_attempt_events_job_sequence_unique UNIQUE (
    tenant_id,
    job_id,
    attempt_id,
    transition_sequence
  ),
  CONSTRAINT proofstack_replay_attempt_events_attempt_fk FOREIGN KEY (
    tenant_id,
    job_id,
    attempt_id
  ) REFERENCES public.proofstack_replay_attempts (
    tenant_id,
    job_id,
    attempt_id
  ) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT proofstack_replay_attempt_events_schema CHECK (schema_version = '0.1'),
  CONSTRAINT proofstack_replay_attempt_events_scope CHECK (
    tenant_id ~ '^[a-z][a-z0-9_]{2,63}$'
    AND project_id ~ '^[a-z][a-z0-9_]{2,63}$'
    AND environment_id ~ '^[a-z][a-z0-9_]{2,63}$'
    AND job_id ~ '^[a-z][a-z0-9_]{2,63}$'
    AND attempt_id ~ '^[a-z][a-z0-9_]{2,63}$'
  ),
  CONSTRAINT proofstack_replay_attempt_events_transition CHECK (
    transition_sequence BETWEEN 0 AND 1
    AND event_type IN ('attempt_claimed', 'attempt_closed', 'attempt_imported')
    AND status IN (
      'budget_exhausted',
      'cancelled',
      'failed',
      'lease_expired',
      'running',
      'succeeded',
      'timed_out'
    )
    AND (
      (
        transition_sequence = 0
        AND event_type IN ('attempt_claimed', 'attempt_imported')
      )
      OR (
        transition_sequence = 1
        AND event_type = 'attempt_closed'
        AND status <> 'running'
      )
    )
  ),
  CONSTRAINT proofstack_replay_attempt_events_time CHECK (
    isfinite(occurred_at)
    AND occurred_at_lexical ~
      '^[0-9]{4}-(0[1-9]|1[0-2])-([0-2][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\.[0-9]{3}Z$'
    AND occurred_at_lexical !~ '^0000-'
    AND occurred_at = occurred_at_lexical::timestamptz
  ),
  CONSTRAINT proofstack_replay_attempt_events_payload CHECK (
    (
      jsonb_typeof(event) = 'object'
      AND event ->> 'schemaVersion' = schema_version
      AND event ->> 'eventType' = event_type
      AND event ->> 'jobId' = job_id
      AND event ->> 'attemptId' = attempt_id
      AND (event ->> 'transitionSequence')::bigint = transition_sequence
      AND event ->> 'status' = status
      AND event ->> 'occurredAt' = occurred_at_lexical
      AND event #>> '{scope,tenantId}' = tenant_id
      AND event #>> '{scope,projectId}' = project_id
      AND event #>> '{scope,environmentId}' = environment_id
      AND event #>> '{attempt,attemptId}' = attempt_id
      AND event #>> '{attempt,jobId}' = job_id
      AND event #>> '{attempt,status}' = status
      AND pg_column_size(event) <= 524288
    ) IS TRUE
  )
);

ALTER TABLE public.proofstack_replay_attempts DISABLE ROW LEVEL SECURITY;
INSERT INTO public.proofstack_replay_attempt_events (
  tenant_id,
  project_id,
  environment_id,
  job_id,
  attempt_id,
  transition_sequence,
  schema_version,
  event_type,
  status,
  occurred_at,
  occurred_at_lexical,
  event
)
SELECT
  attempt.tenant_id,
  attempt.project_id,
  attempt.environment_id,
  attempt.job_id,
  attempt.attempt_id,
  0,
  '0.1',
  'attempt_imported',
  attempt.status,
  COALESCE(attempt.ended_at, attempt.started_at),
  COALESCE(attempt.ended_at_lexical, attempt.started_at_lexical),
  jsonb_build_object(
    'attempt', attempt.attempt,
    'attemptId', attempt.attempt_id,
    'eventType', 'attempt_imported',
    'jobId', attempt.job_id,
    'occurredAt', COALESCE(attempt.ended_at_lexical, attempt.started_at_lexical),
    'schemaVersion', '0.1',
    'scope', jsonb_build_object(
      'environmentId', attempt.environment_id,
      'projectId', attempt.project_id,
      'tenantId', attempt.tenant_id
    ),
    'status', attempt.status,
    'transitionSequence', 0
  )
FROM public.proofstack_replay_attempts AS attempt;
SET CONSTRAINTS proofstack_replay_attempt_events_attempt_fk IMMEDIATE;
ALTER TABLE public.proofstack_replay_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.proofstack_replay_attempts FORCE ROW LEVEL SECURITY;

CREATE FUNCTION public.proofstack_guard_replay_attempt_transition()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'Replay attempts cannot be deleted';
  END IF;
  IF NULLIF(current_setting('proofstack.replay_attempt_writer', true), '') IS DISTINCT FROM
    'stored-function-v1'
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'Replay attempt transitions require an audited stored function';
  END IF;
  IF OLD.status <> 'running'
    OR NEW.status = 'running'
    OR ROW(
      OLD.tenant_id,
      OLD.project_id,
      OLD.environment_id,
      OLD.job_id,
      OLD.attempt_id,
      OLD.attempt_sequence,
      OLD.schema_version,
      OLD.lease_id,
      OLD.worker_id,
      OLD.fencing_token,
      OLD.recovery_epoch,
      OLD.plan_id,
      OLD.plan_version_id,
      OLD.plan_definition_sha256,
      OLD.target_id,
      OLD.target_release_id,
      OLD.target_definition_sha256,
      OLD.worker_protocol_name,
      OLD.worker_protocol_version,
      OLD.worker_build_sha256,
      OLD.started_at,
      OLD.started_at_lexical
    ) IS DISTINCT FROM ROW(
      NEW.tenant_id,
      NEW.project_id,
      NEW.environment_id,
      NEW.job_id,
      NEW.attempt_id,
      NEW.attempt_sequence,
      NEW.schema_version,
      NEW.lease_id,
      NEW.worker_id,
      NEW.fencing_token,
      NEW.recovery_epoch,
      NEW.plan_id,
      NEW.plan_version_id,
      NEW.plan_definition_sha256,
      NEW.target_id,
      NEW.target_release_id,
      NEW.target_definition_sha256,
      NEW.worker_protocol_name,
      NEW.worker_protocol_version,
      NEW.worker_build_sha256,
      NEW.started_at,
      NEW.started_at_lexical
    )
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'Replay attempt transition changes immutable lineage or lifecycle order';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.proofstack_record_replay_attempt_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  event_type_value text;
  occurred_at_lexical_value text;
  occurred_at_value timestamptz;
  transition_sequence_value bigint;
BEGIN
  IF TG_OP = 'INSERT' THEN
    transition_sequence_value := 0;
    event_type_value := CASE
      WHEN NEW.status = 'running' THEN 'attempt_claimed'
      ELSE 'attempt_imported'
    END;
    occurred_at_value := COALESCE(NEW.ended_at, NEW.started_at);
    occurred_at_lexical_value := COALESCE(NEW.ended_at_lexical, NEW.started_at_lexical);
  ELSE
    transition_sequence_value := 1;
    event_type_value := 'attempt_closed';
    occurred_at_value := NEW.ended_at;
    occurred_at_lexical_value := NEW.ended_at_lexical;
  END IF;

  INSERT INTO public.proofstack_replay_attempt_events (
    tenant_id,
    project_id,
    environment_id,
    job_id,
    attempt_id,
    transition_sequence,
    schema_version,
    event_type,
    status,
    occurred_at,
    occurred_at_lexical,
    event
  ) VALUES (
    NEW.tenant_id,
    NEW.project_id,
    NEW.environment_id,
    NEW.job_id,
    NEW.attempt_id,
    transition_sequence_value,
    '0.1',
    event_type_value,
    NEW.status,
    occurred_at_value,
    occurred_at_lexical_value,
    jsonb_build_object(
      'attempt', NEW.attempt,
      'attemptId', NEW.attempt_id,
      'eventType', event_type_value,
      'jobId', NEW.job_id,
      'occurredAt', occurred_at_lexical_value,
      'schemaVersion', '0.1',
      'scope', jsonb_build_object(
        'environmentId', NEW.environment_id,
        'projectId', NEW.project_id,
        'tenantId', NEW.tenant_id
      ),
      'status', NEW.status,
      'transitionSequence', transition_sequence_value
    )
  );
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.proofstack_guard_replay_attempt_transition() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.proofstack_record_replay_attempt_event() FROM PUBLIC;

DROP TRIGGER proofstack_replay_attempts_append_only
  ON public.proofstack_replay_attempts;
CREATE TRIGGER proofstack_replay_attempts_transition_guard
  BEFORE UPDATE OR DELETE ON public.proofstack_replay_attempts
  FOR EACH ROW
  EXECUTE FUNCTION public.proofstack_guard_replay_attempt_transition();
CREATE TRIGGER proofstack_replay_attempts_history
  AFTER INSERT OR UPDATE ON public.proofstack_replay_attempts
  FOR EACH ROW
  EXECUTE FUNCTION public.proofstack_record_replay_attempt_event();
CREATE TRIGGER proofstack_replay_attempt_events_append_only
  BEFORE UPDATE OR DELETE ON public.proofstack_replay_attempt_events
  FOR EACH ROW
  EXECUTE FUNCTION public.proofstack_reject_append_only_mutation();

ALTER TABLE public.proofstack_replay_attempt_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.proofstack_replay_attempt_events FORCE ROW LEVEL SECURITY;
CREATE POLICY proofstack_replay_attempt_events_tenant_select
  ON public.proofstack_replay_attempt_events FOR SELECT
  USING (tenant_id = NULLIF(current_setting('proofstack.tenant_id', true), ''));
CREATE POLICY proofstack_replay_attempt_events_tenant_insert
  ON public.proofstack_replay_attempt_events FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('proofstack.tenant_id', true), ''));

REVOKE ALL ON TABLE public.proofstack_replay_attempt_events FROM PUBLIC;
