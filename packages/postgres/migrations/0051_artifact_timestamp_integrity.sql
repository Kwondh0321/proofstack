-- Keep authenticated retention text and its exact instant separate from the native timestamp.
-- The existing timestamptz projection cannot retain input spelling or submicrosecond precision.
ALTER TABLE public.proofstack_artifact_catalog
  ADD COLUMN expires_at_lexical text,
  ADD COLUMN expires_at_order_key numeric(50, 0);

-- ALTER TABLE holds ACCESS EXCLUSIVE until the migration transaction commits. Relax only the
-- forward-lifecycle guard for this backfill, restore it before commit, and retain source locks.
-- Existing valid millisecond ciphertext keeps the same AAD. Lost original spellings cannot be
-- reconstructed: this is the exact stored native instant, not a claim to repair broken envelopes.
ALTER TABLE public.proofstack_artifact_catalog
  DISABLE TRIGGER proofstack_artifact_catalog_mutation_guard;
UPDATE public.proofstack_artifact_catalog
SET expires_at_lexical = CASE
      WHEN date_trunc('milliseconds', expires_at) = expires_at
        THEN to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      ELSE to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
    END,
    expires_at_order_key = extract(epoch FROM expires_at) * 1000000000000000000000000000000
WHERE retention_mode = 'expire';
ALTER TABLE public.proofstack_artifact_catalog
  ENABLE TRIGGER proofstack_artifact_catalog_mutation_guard;

ALTER TABLE public.proofstack_artifact_catalog
  DROP CONSTRAINT proofstack_artifact_retention_shape,
  ADD CONSTRAINT proofstack_artifact_retention_shape CHECK ((
    (retention_mode = 'retain' AND expires_at IS NULL
      AND expires_at_lexical IS NULL AND expires_at_order_key IS NULL)
    OR
    (retention_mode = 'expire' AND expires_at IS NOT NULL
      AND expires_at_lexical IS NOT NULL AND length(expires_at_lexical) BETWEEN 20 AND 56
      AND expires_at_order_key IS NOT NULL
      AND expires_at_order_key > extract(epoch FROM created_at) * 1000000000000000000000000000000)
  ) IS TRUE);

CREATE INDEX proofstack_artifact_exact_expiration_idx
  ON public.proofstack_artifact_catalog (
    tenant_id, project_id, environment_id, expires_at_order_key, artifact_id
  ) WHERE state = 'available' AND retention_mode = 'expire';

CREATE FUNCTION public.proofstack_guard_artifact_timestamp_integrity()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  parts text[];
  expected_key numeric;
BEGIN
  IF TG_OP = 'UPDATE' AND (
    NEW.expires_at_lexical IS DISTINCT FROM OLD.expires_at_lexical
    OR NEW.expires_at_order_key IS DISTINCT FROM OLD.expires_at_order_key
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'Artifact retention identity is immutable';
  END IF;

  IF NEW.retention_mode = 'retain' THEN
    IF NEW.expires_at_lexical IS NOT NULL OR NEW.expires_at_order_key IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Retained artifacts cannot have expiry metadata';
    END IF;
    RETURN NEW;
  END IF;

  -- New writes must supply the ORIGINAL text before key wrapping. Never infer it from the
  -- rounded projection: an old application must fail closed instead of producing another bad AAD.
  parts := regexp_match(NEW.expires_at_lexical,
    '^([0-9]{4}-[0-9]{2}-[0-9]{2}T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9])(?:[.]([0-9]{1,30}))?(Z|[+-](?:0[0-9]|1[0-5]):[0-5][0-9])$');
  IF parts IS NULL OR left(parts[1], 4) = '0000' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Artifact expiry requires a supported exact timestamp';
  END IF;
  -- Cast WHOLE seconds only, then add the bounded fraction as an exact numeric integer.
  -- Casting the complete lexical value here would first round to PostgreSQL microseconds.
  expected_key := extract(epoch FROM (parts[1] || parts[3])::timestamptz)
    * 1000000000000000000000000000000
    + rpad(COALESCE(parts[2], ''), 30, '0')::numeric;
  IF NEW.expires_at IS DISTINCT FROM NEW.expires_at_lexical::timestamptz
    OR (NEW.expires_at_order_key IS NOT NULL AND NEW.expires_at_order_key <> expected_key)
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Artifact expiry projections do not match';
  END IF;
  NEW.expires_at_order_key := expected_key;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.proofstack_guard_artifact_timestamp_integrity() FROM PUBLIC;

CREATE TRIGGER proofstack_artifact_timestamp_integrity_guard
  BEFORE INSERT OR UPDATE ON public.proofstack_artifact_catalog
  FOR EACH ROW EXECUTE FUNCTION public.proofstack_guard_artifact_timestamp_integrity();
