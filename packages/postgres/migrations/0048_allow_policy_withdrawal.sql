ALTER TABLE public.proofstack_release_policy_lifecycle_events
  DROP CONSTRAINT proofstack_release_policy_lifecycle_events_successor_fk;

ALTER TABLE public.proofstack_release_policy_lifecycle_events
  ADD CONSTRAINT proofstack_release_policy_lifecycle_events_successor_fk FOREIGN KEY (
    tenant_id,
    project_id,
    environment_id,
    successor_policy_version_id,
    successor_definition_sha256
  ) REFERENCES public.proofstack_release_policy_registry (
    tenant_id,
    project_id,
    environment_id,
    policy_version_id,
    definition_sha256
  ) MATCH SIMPLE DEFERRABLE INITIALLY DEFERRED;
