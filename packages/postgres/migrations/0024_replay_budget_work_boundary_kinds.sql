ALTER TABLE public.proofstack_replay_budget_entries
  DROP CONSTRAINT proofstack_replay_budget_entries_work;

ALTER TABLE public.proofstack_replay_budget_entries
  ADD CONSTRAINT proofstack_replay_budget_entries_work CHECK (
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
          AND work_boundary_kind IN ('data', 'model', 'retrieval', 'tool')
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
  );
