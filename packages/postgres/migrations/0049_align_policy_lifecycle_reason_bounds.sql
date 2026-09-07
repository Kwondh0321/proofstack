-- Match AssuranceRationaleSchema's 4096 Unicode scalar limit without rewriting migration 0047.
-- PostgreSQL UTF-8 char_length counts scalar values, including supplementary characters.
-- Preserve every other identity and digest condition and validate all retained rows atomically.
ALTER TABLE public.proofstack_release_policy_lifecycle_events
  DROP CONSTRAINT proofstack_release_policy_lifecycle_events_values;

ALTER TABLE public.proofstack_release_policy_lifecycle_events
  ADD CONSTRAINT proofstack_release_policy_lifecycle_events_values CHECK (
    schema_version = '0.1'
    AND event_id ~ '^[a-z][a-z0-9_]{2,63}$'
    AND policy_id ~ '^[a-z][a-z0-9_]{2,63}$'
    AND actor_principal_id ~ '^[a-z][a-z0-9_]{2,63}$'
    AND policy_definition_sha256 ~ '^[0-9a-f]{64}$'
    AND (successor_definition_sha256 IS NULL OR successor_definition_sha256 ~ '^[0-9a-f]{64}$')
    AND char_length(reason) BETWEEN 1 AND 4096
  );
