CREATE OR REPLACE FUNCTION public.proofstack_valid_workload_capabilities(value text[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = pg_catalog
AS $$
  SELECT
    cardinality(value) BETWEEN 1 AND 14
    AND value <@ ARRAY[
      'project:read',
      'evidence:ingest',
      'evidence:read',
      'artifact:write',
      'artifact:read',
      'dataset:read',
      'replay:read',
      'replay:run',
      'replay:cancel',
      'evaluation:read',
      'evaluation:run',
      'evaluation:model:run',
      'release:read',
      'policy:evaluate'
    ]::text[]
    AND cardinality(value) = (
      SELECT count(DISTINCT capability)::integer
      FROM unnest(value) AS capabilities(capability)
    )
$$;

REVOKE ALL ON FUNCTION public.proofstack_valid_workload_capabilities(text[]) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.proofstack_valid_user_capabilities(value text[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = pg_catalog
AS $$
  SELECT
    cardinality(value) BETWEEN 0 AND 27
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
      'release:read',
      'release:manage',
      'policy:evaluate',
      'policy:manage',
      'approval:decide',
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
