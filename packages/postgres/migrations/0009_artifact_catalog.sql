CREATE TABLE public.proofstack_artifact_catalog (
  tenant_id varchar(64) NOT NULL,
  project_id varchar(64) NOT NULL,
  environment_id varchar(64) NOT NULL,
  artifact_id varchar(64) NOT NULL,
  schema_version varchar(16) NOT NULL,
  state varchar(16) NOT NULL,
  classification varchar(16) NOT NULL,
  media_type varchar(255) NOT NULL,
  content_sha256 character(64) NOT NULL,
  content_size_bytes integer NOT NULL,
  redaction jsonb NOT NULL,
  retention_mode varchar(16) NOT NULL,
  expires_at timestamptz,
  created_at timestamptz NOT NULL,
  available_at timestamptz,
  tombstoned_at timestamptz,
  purged_at timestamptz,
  created_by_principal_id varchar(64) NOT NULL,
  object_key varchar(512) NOT NULL,
  encryption_version varchar(16) NOT NULL,
  content_nonce character(16) NOT NULL,
  wrapped_key_algorithm varchar(16) NOT NULL,
  wrapped_key_id varchar(64) NOT NULL,
  wrapped_key_ciphertext character(43) NOT NULL,
  wrapped_key_nonce character(16) NOT NULL,
  wrapped_key_tag character(22) NOT NULL,
  object_receipt_sha256 character(64),
  object_receipt_size_bytes integer,

  CONSTRAINT proofstack_artifact_catalog_pk PRIMARY KEY (tenant_id, artifact_id),
  CONSTRAINT proofstack_artifact_tenant_format CHECK (
    tenant_id ~ '^[a-z][a-z0-9_]{2,63}$'
  ),
  CONSTRAINT proofstack_artifact_project_format CHECK (
    project_id ~ '^[a-z][a-z0-9_]{2,63}$'
  ),
  CONSTRAINT proofstack_artifact_environment_format CHECK (
    environment_id ~ '^[a-z][a-z0-9_]{2,63}$'
  ),
  CONSTRAINT proofstack_artifact_id_format CHECK (
    artifact_id ~ '^[a-z][a-z0-9_]{2,63}$'
  ),
  CONSTRAINT proofstack_artifact_schema_version CHECK (
    schema_version = '0.1'
  ),
  CONSTRAINT proofstack_artifact_state CHECK (
    state IN ('reserved', 'available', 'tombstoned', 'purged')
  ),
  CONSTRAINT proofstack_artifact_classification CHECK (
    classification IN ('metadata', 'internal', 'confidential', 'restricted')
  ),
  CONSTRAINT proofstack_artifact_media_type CHECK (
    media_type ~ '^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$'
  ),
  CONSTRAINT proofstack_artifact_content_sha256 CHECK (
    content_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT proofstack_artifact_content_size CHECK (
    content_size_bytes BETWEEN 1 AND 16777216
  ),
  CONSTRAINT proofstack_artifact_redaction_shape CHECK (
    (
      jsonb_typeof(redaction) = 'object'
      AND redaction ->> 'status' IN ('not_performed', 'not_required', 'applied')
      AND pg_column_size(redaction) <= 131072
      AND (
        (
          redaction ->> 'status' IN ('not_performed', 'not_required')
          AND redaction = jsonb_build_object('status', redaction ->> 'status')
        )
        OR (
          redaction ->> 'status' = 'applied'
          AND redaction - ARRAY['status', 'records'] = '{}'::jsonb
          AND jsonb_typeof(redaction -> 'records') = 'array'
          AND jsonb_array_length(redaction -> 'records') BETWEEN 1 AND 16
        )
      )
    ) IS TRUE
  ),
  CONSTRAINT proofstack_artifact_retention_shape CHECK (
    (
      retention_mode = 'retain'
      AND expires_at IS NULL
    )
    OR (
      retention_mode = 'expire'
      AND expires_at IS NOT NULL
      AND expires_at > created_at
    )
  ),
  CONSTRAINT proofstack_artifact_lifecycle_shape CHECK (
    (
      (
        state = 'reserved'
        AND available_at IS NULL
        AND tombstoned_at IS NULL
        AND purged_at IS NULL
        AND object_receipt_sha256 IS NULL
        AND object_receipt_size_bytes IS NULL
      )
      OR (
        state = 'available'
        AND available_at >= created_at
        AND tombstoned_at IS NULL
        AND purged_at IS NULL
        AND object_receipt_sha256 IS NOT NULL
        AND object_receipt_size_bytes IS NOT NULL
      )
      OR (
        state = 'tombstoned'
        AND tombstoned_at >= COALESCE(available_at, created_at)
        AND purged_at IS NULL
        AND (
          (available_at IS NULL AND object_receipt_sha256 IS NULL AND object_receipt_size_bytes IS NULL)
          OR (
            available_at >= created_at
            AND object_receipt_sha256 IS NOT NULL
            AND object_receipt_size_bytes IS NOT NULL
          )
        )
      )
      OR (
        state = 'purged'
        AND tombstoned_at >= COALESCE(available_at, created_at)
        AND purged_at >= tombstoned_at
        AND (
          (available_at IS NULL AND object_receipt_sha256 IS NULL AND object_receipt_size_bytes IS NULL)
          OR (
            available_at >= created_at
            AND object_receipt_sha256 IS NOT NULL
            AND object_receipt_size_bytes IS NOT NULL
          )
        )
      )
    ) IS TRUE
  ),
  CONSTRAINT proofstack_artifact_creator_format CHECK (
    created_by_principal_id ~ '^[a-z][a-z0-9_]{2,63}$'
  ),
  CONSTRAINT proofstack_artifact_object_key_format CHECK (
    length(object_key) BETWEEN 1 AND 512
    AND object_key = btrim(object_key)
    AND object_key !~ '[[:cntrl:]]'
  ),
  CONSTRAINT proofstack_artifact_encryption_shape CHECK (
    encryption_version = 'a256gcm-v1'
    AND content_nonce ~ '^[A-Za-z0-9_-]{16}$'
    AND wrapped_key_algorithm = 'A256GCM'
    AND wrapped_key_id ~ '^[a-z][a-z0-9_]{2,63}$'
    AND wrapped_key_ciphertext ~ '^[A-Za-z0-9_-]{43}$'
    AND wrapped_key_nonce ~ '^[A-Za-z0-9_-]{16}$'
    AND wrapped_key_tag ~ '^[A-Za-z0-9_-]{22}$'
  ),
  CONSTRAINT proofstack_artifact_object_receipt_shape CHECK (
    (
      (object_receipt_sha256 IS NULL AND object_receipt_size_bytes IS NULL)
      OR (
        object_receipt_sha256 ~ '^[0-9a-f]{64}$'
        AND object_receipt_size_bytes = content_size_bytes + 20
      )
    ) IS TRUE
  )
);

CREATE INDEX proofstack_artifact_expiration_idx
  ON public.proofstack_artifact_catalog (
    tenant_id,
    project_id,
    environment_id,
    expires_at,
    artifact_id
  )
  WHERE state = 'available' AND retention_mode = 'expire';

CREATE INDEX proofstack_artifact_abandoned_idx
  ON public.proofstack_artifact_catalog (
    tenant_id,
    project_id,
    environment_id,
    created_at,
    artifact_id
  )
  WHERE state = 'reserved';

CREATE INDEX proofstack_artifact_pending_purge_idx
  ON public.proofstack_artifact_catalog (
    tenant_id,
    project_id,
    environment_id,
    tombstoned_at,
    artifact_id
  )
  WHERE state = 'tombstoned';

CREATE TABLE public.proofstack_artifact_tombstones (
  tenant_id varchar(64) NOT NULL,
  artifact_id varchar(64) NOT NULL,
  tombstone_id varchar(64) NOT NULL,
  actor_principal_id varchar(64) NOT NULL,
  tombstone_trigger varchar(16) NOT NULL,
  reason varchar(512) NOT NULL,
  occurred_at timestamptz NOT NULL,

  CONSTRAINT proofstack_artifact_tombstones_pk PRIMARY KEY (tenant_id, artifact_id),
  CONSTRAINT proofstack_artifact_tombstone_id_unique UNIQUE (tenant_id, tombstone_id),
  CONSTRAINT proofstack_artifact_tombstone_catalog_fk FOREIGN KEY (tenant_id, artifact_id)
    REFERENCES public.proofstack_artifact_catalog (tenant_id, artifact_id),
  CONSTRAINT proofstack_artifact_tombstone_tenant_format CHECK (
    tenant_id ~ '^[a-z][a-z0-9_]{2,63}$'
  ),
  CONSTRAINT proofstack_artifact_tombstone_artifact_format CHECK (
    artifact_id ~ '^[a-z][a-z0-9_]{2,63}$'
  ),
  CONSTRAINT proofstack_artifact_tombstone_id_format CHECK (
    tombstone_id ~ '^[a-z][a-z0-9_]{2,63}$'
  ),
  CONSTRAINT proofstack_artifact_tombstone_actor_format CHECK (
    actor_principal_id ~ '^[a-z][a-z0-9_]{2,63}$'
  ),
  CONSTRAINT proofstack_artifact_tombstone_trigger CHECK (
    tombstone_trigger IN ('manual', 'retention', 'abandoned')
  ),
  CONSTRAINT proofstack_artifact_tombstone_reason CHECK (
    length(reason) BETWEEN 1 AND 512
    AND reason = btrim(reason)
    AND reason !~ '[[:cntrl:]]'
  )
);

CREATE TABLE public.proofstack_artifact_purge_receipts (
  tenant_id varchar(64) NOT NULL,
  artifact_id varchar(64) NOT NULL,
  purge_id varchar(64) NOT NULL,
  object_was_present boolean NOT NULL,
  occurred_at timestamptz NOT NULL,

  CONSTRAINT proofstack_artifact_purge_receipts_pk PRIMARY KEY (tenant_id, artifact_id),
  CONSTRAINT proofstack_artifact_purge_id_unique UNIQUE (tenant_id, purge_id),
  CONSTRAINT proofstack_artifact_purge_catalog_fk FOREIGN KEY (tenant_id, artifact_id)
    REFERENCES public.proofstack_artifact_catalog (tenant_id, artifact_id),
  CONSTRAINT proofstack_artifact_purge_tenant_format CHECK (
    tenant_id ~ '^[a-z][a-z0-9_]{2,63}$'
  ),
  CONSTRAINT proofstack_artifact_purge_artifact_format CHECK (
    artifact_id ~ '^[a-z][a-z0-9_]{2,63}$'
  ),
  CONSTRAINT proofstack_artifact_purge_id_format CHECK (
    purge_id ~ '^[a-z][a-z0-9_]{2,63}$'
  )
);

ALTER TABLE public.proofstack_artifact_catalog ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.proofstack_artifact_catalog FORCE ROW LEVEL SECURITY;
ALTER TABLE public.proofstack_artifact_tombstones ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.proofstack_artifact_tombstones FORCE ROW LEVEL SECURITY;
ALTER TABLE public.proofstack_artifact_purge_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.proofstack_artifact_purge_receipts FORCE ROW LEVEL SECURITY;

CREATE POLICY proofstack_artifact_catalog_tenant_all
  ON public.proofstack_artifact_catalog
  USING (
    tenant_id = NULLIF(current_setting('proofstack.tenant_id', true), '')
  )
  WITH CHECK (
    tenant_id = NULLIF(current_setting('proofstack.tenant_id', true), '')
  );

CREATE POLICY proofstack_artifact_tombstone_tenant_all
  ON public.proofstack_artifact_tombstones
  USING (
    tenant_id = NULLIF(current_setting('proofstack.tenant_id', true), '')
  )
  WITH CHECK (
    tenant_id = NULLIF(current_setting('proofstack.tenant_id', true), '')
  );

CREATE POLICY proofstack_artifact_purge_tenant_all
  ON public.proofstack_artifact_purge_receipts
  USING (
    tenant_id = NULLIF(current_setting('proofstack.tenant_id', true), '')
  )
  WITH CHECK (
    tenant_id = NULLIF(current_setting('proofstack.tenant_id', true), '')
  );

CREATE FUNCTION public.proofstack_guard_artifact_catalog_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  lifecycle_receipt_present boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'ProofStack artifact catalog records cannot be deleted';
  END IF;

  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.environment_id IS DISTINCT FROM OLD.environment_id
    OR NEW.artifact_id IS DISTINCT FROM OLD.artifact_id
    OR NEW.schema_version IS DISTINCT FROM OLD.schema_version
    OR NEW.classification IS DISTINCT FROM OLD.classification
    OR NEW.media_type IS DISTINCT FROM OLD.media_type
    OR NEW.content_sha256 IS DISTINCT FROM OLD.content_sha256
    OR NEW.content_size_bytes IS DISTINCT FROM OLD.content_size_bytes
    OR NEW.redaction IS DISTINCT FROM OLD.redaction
    OR NEW.retention_mode IS DISTINCT FROM OLD.retention_mode
    OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.created_by_principal_id IS DISTINCT FROM OLD.created_by_principal_id
    OR NEW.object_key IS DISTINCT FROM OLD.object_key
    OR NEW.encryption_version IS DISTINCT FROM OLD.encryption_version
    OR NEW.content_nonce IS DISTINCT FROM OLD.content_nonce
    OR NEW.wrapped_key_algorithm IS DISTINCT FROM OLD.wrapped_key_algorithm
    OR NEW.wrapped_key_id IS DISTINCT FROM OLD.wrapped_key_id
    OR NEW.wrapped_key_ciphertext IS DISTINCT FROM OLD.wrapped_key_ciphertext
    OR NEW.wrapped_key_nonce IS DISTINCT FROM OLD.wrapped_key_nonce
    OR NEW.wrapped_key_tag IS DISTINCT FROM OLD.wrapped_key_tag
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'ProofStack artifact reservation metadata is immutable';
  END IF;

  IF OLD.state = 'reserved'
    AND NEW.state = 'available'
    AND OLD.available_at IS NULL
    AND NEW.available_at IS NOT NULL
    AND NEW.tombstoned_at IS NULL
    AND NEW.purged_at IS NULL
    AND OLD.object_receipt_sha256 IS NULL
    AND OLD.object_receipt_size_bytes IS NULL
    AND NEW.object_receipt_sha256 IS NOT NULL
    AND NEW.object_receipt_size_bytes IS NOT NULL
  THEN
    RETURN NEW;
  END IF;

  IF OLD.state IN ('reserved', 'available')
    AND NEW.state = 'tombstoned'
    AND NEW.available_at IS NOT DISTINCT FROM OLD.available_at
    AND NEW.object_receipt_sha256 IS NOT DISTINCT FROM OLD.object_receipt_sha256
    AND NEW.object_receipt_size_bytes IS NOT DISTINCT FROM OLD.object_receipt_size_bytes
    AND OLD.tombstoned_at IS NULL
    AND NEW.tombstoned_at IS NOT NULL
    AND NEW.purged_at IS NULL
  THEN
    SELECT EXISTS (
      SELECT 1
      FROM public.proofstack_artifact_tombstones AS tombstone
      WHERE tombstone.tenant_id = NEW.tenant_id
        AND tombstone.artifact_id = NEW.artifact_id
        AND tombstone.occurred_at = NEW.tombstoned_at
        AND (
          (OLD.state = 'reserved' AND tombstone.tombstone_trigger = 'abandoned')
          OR (OLD.state = 'available' AND tombstone.tombstone_trigger <> 'abandoned')
        )
    ) INTO lifecycle_receipt_present;
    IF lifecycle_receipt_present THEN RETURN NEW; END IF;
  END IF;

  IF OLD.state = 'tombstoned'
    AND NEW.state = 'purged'
    AND NEW.available_at IS NOT DISTINCT FROM OLD.available_at
    AND NEW.tombstoned_at IS NOT DISTINCT FROM OLD.tombstoned_at
    AND NEW.object_receipt_sha256 IS NOT DISTINCT FROM OLD.object_receipt_sha256
    AND NEW.object_receipt_size_bytes IS NOT DISTINCT FROM OLD.object_receipt_size_bytes
    AND OLD.purged_at IS NULL
    AND NEW.purged_at IS NOT NULL
  THEN
    SELECT EXISTS (
      SELECT 1
      FROM public.proofstack_artifact_purge_receipts AS receipt
      WHERE receipt.tenant_id = NEW.tenant_id
        AND receipt.artifact_id = NEW.artifact_id
        AND receipt.occurred_at = NEW.purged_at
    ) INTO lifecycle_receipt_present;
    IF lifecycle_receipt_present THEN RETURN NEW; END IF;
  END IF;

  RAISE EXCEPTION USING
    ERRCODE = '55000',
    MESSAGE = 'ProofStack artifact lifecycle transition is invalid';
END;
$$;

REVOKE ALL ON FUNCTION public.proofstack_guard_artifact_catalog_mutation() FROM PUBLIC;

CREATE TRIGGER proofstack_artifact_catalog_mutation_guard
  BEFORE UPDATE OR DELETE ON public.proofstack_artifact_catalog
  FOR EACH ROW
  EXECUTE FUNCTION public.proofstack_guard_artifact_catalog_mutation();

CREATE FUNCTION public.proofstack_reject_artifact_receipt_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '55000',
    MESSAGE = format('ProofStack artifact lifecycle records in %s cannot be changed', TG_TABLE_NAME);
END;
$$;

REVOKE ALL ON FUNCTION public.proofstack_reject_artifact_receipt_mutation() FROM PUBLIC;

CREATE TRIGGER proofstack_artifact_tombstone_append_only
  BEFORE UPDATE OR DELETE ON public.proofstack_artifact_tombstones
  FOR EACH ROW
  EXECUTE FUNCTION public.proofstack_reject_artifact_receipt_mutation();

CREATE TRIGGER proofstack_artifact_purge_receipt_append_only
  BEFORE UPDATE OR DELETE ON public.proofstack_artifact_purge_receipts
  FOR EACH ROW
  EXECUTE FUNCTION public.proofstack_reject_artifact_receipt_mutation();

CREATE FUNCTION public.proofstack_require_artifact_lifecycle_receipt()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  lifecycle_recorded boolean;
BEGIN
  IF TG_TABLE_NAME = 'proofstack_artifact_tombstones' THEN
    SELECT EXISTS (
      SELECT 1
      FROM public.proofstack_artifact_catalog AS artifact
      WHERE artifact.tenant_id = NEW.tenant_id
        AND artifact.artifact_id = NEW.artifact_id
        AND artifact.state IN ('tombstoned', 'purged')
        AND artifact.tombstoned_at = NEW.occurred_at
    ) INTO lifecycle_recorded;
  ELSE
    SELECT EXISTS (
      SELECT 1
      FROM public.proofstack_artifact_catalog AS artifact
      WHERE artifact.tenant_id = NEW.tenant_id
        AND artifact.artifact_id = NEW.artifact_id
        AND artifact.state = 'purged'
        AND artifact.purged_at = NEW.occurred_at
    ) INTO lifecycle_recorded;
  END IF;

  IF NOT lifecycle_recorded THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'ProofStack artifact lifecycle receipt must match the catalog state';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.proofstack_require_artifact_lifecycle_receipt() FROM PUBLIC;

CREATE CONSTRAINT TRIGGER proofstack_artifact_tombstone_consistency
  AFTER INSERT ON public.proofstack_artifact_tombstones
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION public.proofstack_require_artifact_lifecycle_receipt();

CREATE CONSTRAINT TRIGGER proofstack_artifact_purge_consistency
  AFTER INSERT ON public.proofstack_artifact_purge_receipts
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION public.proofstack_require_artifact_lifecycle_receipt();
