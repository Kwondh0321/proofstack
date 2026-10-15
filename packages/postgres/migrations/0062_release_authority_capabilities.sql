-- Register the three C4 authority names without default grants, execution ports or role changes.
-- The unchanged workload vocabulary remains restricted to its original seventeen capabilities.
CREATE OR REPLACE FUNCTION public.proofstack_valid_user_capabilities(value text[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = pg_catalog
AS $$
  SELECT
    cardinality(value) BETWEEN 0 AND 35
    AND value <@ ARRAY[
      'project:read',
      'project:manage',
      'evidence:ingest',
      'evidence:read',
      'artifact:write',
      'artifact:read',
      'artifact:read:restricted',
      'artifact:delete',
      'dataset:read',
      'dataset:manage',
      'replay:read',
      'replay:run',
      'replay:cancel',
      'replay:manage',
      'evaluation:read',
      'evaluation:run',
      'evaluation:model:run',
      'evaluation:human:review',
      'evaluation:manage',
      'comparison:read',
      'comparison:manage',
      'release:read',
      'release:manage',
      'policy:read',
      'policy:author',
      'policy:evaluate',
      'policy:evaluation:execute',
      'policy:evaluation:cancel',
      'approval:decide',
      'release:selection:manage',
      'approval:authority:manage',
      'release:decision:publish',
      'audit:read',
      'identity:read',
      'identity:manage'
    ]::text[]
    AND cardinality(value) = (
      SELECT count(DISTINCT capability)::integer
      FROM unnest(value) AS capabilities(capability)
    )
$$;

REVOKE ALL ON FUNCTION public.proofstack_valid_user_capabilities(text[]) FROM PUBLIC;
