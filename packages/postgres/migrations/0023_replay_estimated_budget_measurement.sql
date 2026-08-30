ALTER TABLE public.proofstack_replay_budget_entry_dimensions
  DROP CONSTRAINT proofstack_replay_budget_entry_dimensions_shape;

ALTER TABLE public.proofstack_replay_budget_entry_dimensions
  ADD CONSTRAINT proofstack_replay_budget_entry_dimensions_shape CHECK (
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
      AND measurement IN ('estimated', 'measured', 'provider_reported', 'unavailable')
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
  );
