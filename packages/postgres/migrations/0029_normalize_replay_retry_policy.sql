ALTER TABLE public.proofstack_replay_plans
  ADD COLUMN retry_idempotency_requirement varchar(32)
    GENERATED ALWAYS AS (
      plan #>> '{retryPolicy,idempotencyRequirement}'
    ) STORED,
  ADD COLUMN retry_backoff_kind varchar(16)
    GENERATED ALWAYS AS (
      plan #>> '{retryPolicy,backoff,kind}'
    ) STORED,
  ADD COLUMN retry_backoff_delay_milliseconds bigint
    GENERATED ALWAYS AS (
      CASE
        WHEN plan #>> '{retryPolicy,backoff,kind}' = 'fixed'
          THEN (plan #>> '{retryPolicy,backoff,delayMilliseconds}')::bigint
        ELSE NULL
      END
    ) STORED,
  ADD COLUMN retry_backoff_initial_delay_milliseconds bigint
    GENERATED ALWAYS AS (
      CASE
        WHEN plan #>> '{retryPolicy,backoff,kind}' = 'exponential'
          THEN (plan #>> '{retryPolicy,backoff,initialDelayMilliseconds}')::bigint
        ELSE NULL
      END
    ) STORED,
  ADD COLUMN retry_backoff_maximum_delay_milliseconds bigint
    GENERATED ALWAYS AS (
      CASE
        WHEN plan #>> '{retryPolicy,backoff,kind}' = 'exponential'
          THEN (plan #>> '{retryPolicy,backoff,maximumDelayMilliseconds}')::bigint
        ELSE NULL
      END
    ) STORED,
  ADD COLUMN retry_backoff_multiplier smallint
    GENERATED ALWAYS AS (
      CASE
        WHEN plan #>> '{retryPolicy,backoff,kind}' = 'exponential'
          THEN (plan #>> '{retryPolicy,backoff,multiplier}')::smallint
        ELSE NULL
      END
    ) STORED,
  ADD COLUMN retry_boundary_rate_limited boolean
    GENERATED ALWAYS AS (
      COALESCE(
        plan #> '{retryPolicy,retryableErrors}' @>
          '["boundary_rate_limited"]'::jsonb,
        false
      )
    ) STORED,
  ADD COLUMN retry_boundary_temporarily_unavailable boolean
    GENERATED ALWAYS AS (
      COALESCE(
        plan #> '{retryPolicy,retryableErrors}' @>
          '["boundary_temporarily_unavailable"]'::jsonb,
        false
      )
    ) STORED,
  ADD COLUMN retry_target_process_interrupted boolean
    GENERATED ALWAYS AS (
      COALESCE(
        plan #> '{retryPolicy,retryableErrors}' @>
          '["target_process_interrupted"]'::jsonb,
        false
      )
    ) STORED,
  ADD COLUMN retry_target_temporary_failure boolean
    GENERATED ALWAYS AS (
      COALESCE(
        plan #> '{retryPolicy,retryableErrors}' @>
          '["target_temporary_failure"]'::jsonb,
        false
      )
    ) STORED;

ALTER TABLE public.proofstack_replay_plans
  ALTER COLUMN retry_idempotency_requirement SET NOT NULL,
  ALTER COLUMN retry_backoff_kind SET NOT NULL,
  ALTER COLUMN retry_boundary_rate_limited SET NOT NULL,
  ALTER COLUMN retry_boundary_temporarily_unavailable SET NOT NULL,
  ALTER COLUMN retry_target_process_interrupted SET NOT NULL,
  ALTER COLUMN retry_target_temporary_failure SET NOT NULL,
  ADD CONSTRAINT proofstack_replay_plans_retry_policy_normalized CHECK (
    retry_idempotency_requirement IN (
      'destination_supported',
      'no_external_effect',
      'read_only'
    )
    AND retry_backoff_kind IN ('none', 'fixed', 'exponential')
    AND (
      (
        retry_backoff_kind = 'none'
        AND retry_backoff_delay_milliseconds IS NULL
        AND retry_backoff_initial_delay_milliseconds IS NULL
        AND retry_backoff_maximum_delay_milliseconds IS NULL
        AND retry_backoff_multiplier IS NULL
      )
      OR (
        retry_backoff_kind = 'fixed'
        AND retry_backoff_delay_milliseconds BETWEEN 1 AND 3600000
        AND retry_backoff_initial_delay_milliseconds IS NULL
        AND retry_backoff_maximum_delay_milliseconds IS NULL
        AND retry_backoff_multiplier IS NULL
      )
      OR (
        retry_backoff_kind = 'exponential'
        AND retry_backoff_delay_milliseconds IS NULL
        AND retry_backoff_initial_delay_milliseconds BETWEEN 1 AND 3600000
        AND retry_backoff_maximum_delay_milliseconds BETWEEN
          retry_backoff_initial_delay_milliseconds AND 3600000
        AND retry_backoff_multiplier BETWEEN 2 AND 16
      )
    )
    AND (
      retry_automatic
      OR (
        retry_backoff_kind = 'none'
        AND NOT retry_boundary_rate_limited
        AND NOT retry_boundary_temporarily_unavailable
        AND NOT retry_target_process_interrupted
        AND NOT retry_target_temporary_failure
      )
    )
    AND (retry_max_attempts > 1 OR NOT retry_automatic)
  );
