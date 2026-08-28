CREATE FUNCTION public.proofstack_valid_workload_capabilities(value text[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = pg_catalog
AS $$
  SELECT
    cardinality(value) BETWEEN 1 AND 7
    AND value <@ ARRAY[
      'project:read',
      'evidence:ingest',
      'evidence:read',
      'evaluation:read',
      'evaluation:run',
      'release:read',
      'policy:evaluate'
    ]::text[]
    AND cardinality(value) = (
      SELECT count(DISTINCT capability)::integer
      FROM unnest(value) AS capabilities(capability)
    )
$$;

REVOKE ALL ON FUNCTION public.proofstack_valid_workload_capabilities(text[]) FROM PUBLIC;

CREATE FUNCTION public.proofstack_valid_resource_scope(value jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
STRICT
SET search_path = pg_catalog
AS $$
DECLARE
  environment jsonb;
  environment_id text;
  environment_ids text[];
  project jsonb;
  project_id text;
  project_ids text[] := ARRAY[]::text[];
  projects jsonb;
BEGIN
  IF jsonb_typeof(value) IS DISTINCT FROM 'object' THEN
    RETURN false;
  END IF;

  IF value ->> 'mode' = 'tenant' THEN
    RETURN value = jsonb_build_object('mode', 'tenant');
  END IF;

  IF value ->> 'mode' IS DISTINCT FROM 'restricted'
    OR value - ARRAY['mode', 'projects'] <> '{}'::jsonb
  THEN
    RETURN false;
  END IF;

  projects := value -> 'projects';
  IF jsonb_typeof(projects) IS DISTINCT FROM 'array'
    OR jsonb_array_length(projects) NOT BETWEEN 1 AND 100
  THEN
    RETURN false;
  END IF;

  FOR project IN
    SELECT item
    FROM jsonb_array_elements(projects) AS project_items(item)
  LOOP
    IF jsonb_typeof(project) IS DISTINCT FROM 'object'
      OR project - ARRAY['projectId', 'environmentIds'] <> '{}'::jsonb
      OR jsonb_typeof(project -> 'projectId') IS DISTINCT FROM 'string'
    THEN
      RETURN false;
    END IF;

    project_id := project ->> 'projectId';
    IF project_id !~ '^[a-z][a-z0-9_]{2,63}$'
      OR project_id = ANY(project_ids)
    THEN
      RETURN false;
    END IF;
    project_ids := array_append(project_ids, project_id);

    IF project ? 'environmentIds' THEN
      IF jsonb_typeof(project -> 'environmentIds') IS DISTINCT FROM 'array'
        OR jsonb_array_length(project -> 'environmentIds') NOT BETWEEN 1 AND 100
      THEN
        RETURN false;
      END IF;

      environment_ids := ARRAY[]::text[];
      FOR environment IN
        SELECT item
        FROM jsonb_array_elements(project -> 'environmentIds') AS environment_items(item)
      LOOP
        IF jsonb_typeof(environment) IS DISTINCT FROM 'string' THEN
          RETURN false;
        END IF;
        environment_id := environment #>> '{}';
        IF environment_id !~ '^[a-z][a-z0-9_]{2,63}$'
          OR environment_id = ANY(environment_ids)
        THEN
          RETURN false;
        END IF;
        environment_ids := array_append(environment_ids, environment_id);
      END LOOP;
    END IF;
  END LOOP;

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.proofstack_valid_resource_scope(jsonb) FROM PUBLIC;

CREATE TABLE public.proofstack_api_key_credentials (
  tenant_id varchar(64) NOT NULL,
  credential_id varchar(64) NOT NULL,
  key_prefix character(12) NOT NULL,
  principal_id varchar(64) NOT NULL,
  display_name varchar(128) NOT NULL,
  capabilities text[] NOT NULL,
  resource_scope jsonb NOT NULL,
  hash_algorithm varchar(16) NOT NULL,
  hash_cost integer NOT NULL,
  hash_block_size integer NOT NULL,
  hash_parallelization integer NOT NULL,
  hash_key_length integer NOT NULL,
  hash_salt character(22) NOT NULL,
  hash_digest character(43) NOT NULL,
  created_by_principal_id varchar(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoked_by_principal_id varchar(64),
  revocation_reason varchar(512),
  rotated_from_credential_id varchar(64),
  last_used_at timestamptz,
  use_count integer NOT NULL DEFAULT 0,

  CONSTRAINT proofstack_api_key_credentials_pk PRIMARY KEY (tenant_id, credential_id),
  CONSTRAINT proofstack_api_key_prefix_unique UNIQUE (key_prefix),
  CONSTRAINT proofstack_api_key_rotation_unique UNIQUE (
    tenant_id,
    rotated_from_credential_id
  ),
  CONSTRAINT proofstack_api_key_rotation_fk FOREIGN KEY (
    tenant_id,
    rotated_from_credential_id
  ) REFERENCES public.proofstack_api_key_credentials (tenant_id, credential_id),
  CONSTRAINT proofstack_api_key_tenant_format CHECK (
    tenant_id ~ '^[a-z][a-z0-9_]{2,63}$'
  ),
  CONSTRAINT proofstack_api_key_credential_format CHECK (
    credential_id ~ '^[a-z][a-z0-9_]{2,63}$'
  ),
  CONSTRAINT proofstack_api_key_prefix_format CHECK (
    key_prefix ~ '^[A-Za-z0-9_-]{12}$'
  ),
  CONSTRAINT proofstack_api_key_principal_format CHECK (
    principal_id ~ '^[a-z][a-z0-9_]{2,63}$'
  ),
  CONSTRAINT proofstack_api_key_name_format CHECK (
    length(display_name) BETWEEN 1 AND 128
    AND display_name = btrim(display_name)
    AND display_name !~ '[[:cntrl:]]'
  ),
  CONSTRAINT proofstack_api_key_capabilities_valid CHECK (
    public.proofstack_valid_workload_capabilities(capabilities)
  ),
  CONSTRAINT proofstack_api_key_scope_valid CHECK (
    public.proofstack_valid_resource_scope(resource_scope)
  ),
  CONSTRAINT proofstack_api_key_hash_profile CHECK (
    hash_algorithm = 'scrypt-v1'
    AND hash_cost = 32768
    AND hash_block_size = 8
    AND hash_parallelization = 1
    AND hash_key_length = 32
  ),
  CONSTRAINT proofstack_api_key_hash_encoding CHECK (
    hash_salt ~ '^[A-Za-z0-9_-]{22}$'
    AND hash_digest ~ '^[A-Za-z0-9_-]{43}$'
  ),
  CONSTRAINT proofstack_api_key_creator_format CHECK (
    created_by_principal_id ~ '^[a-z][a-z0-9_]{2,63}$'
  ),
  CONSTRAINT proofstack_api_key_expiration_range CHECK (
    expires_at >= created_at + interval '55 seconds'
    AND expires_at <= created_at + interval '365 days 5 minutes'
  ),
  CONSTRAINT proofstack_api_key_revocation_shape CHECK (
    (
      (
        revoked_at IS NULL
        AND revoked_by_principal_id IS NULL
        AND revocation_reason IS NULL
      )
      OR (
        revoked_at IS NOT NULL
        AND revoked_at >= created_at
        AND revoked_by_principal_id ~ '^[a-z][a-z0-9_]{2,63}$'
        AND length(revocation_reason) BETWEEN 1 AND 512
        AND revocation_reason = btrim(revocation_reason)
        AND revocation_reason !~ '[[:cntrl:]]'
      )
    ) IS TRUE
  ),
  CONSTRAINT proofstack_api_key_rotation_distinct CHECK (
    rotated_from_credential_id IS NULL
    OR rotated_from_credential_id <> credential_id
  ),
  CONSTRAINT proofstack_api_key_use_shape CHECK (
    use_count BETWEEN 0 AND 2147483647
    AND (
      (use_count = 0 AND last_used_at IS NULL)
      OR (use_count > 0 AND last_used_at IS NOT NULL AND last_used_at >= created_at)
    )
  )
);

CREATE INDEX proofstack_api_key_principal_idx
  ON public.proofstack_api_key_credentials (
    tenant_id,
    principal_id,
    created_at,
    credential_id
  );

CREATE INDEX proofstack_api_key_active_idx
  ON public.proofstack_api_key_credentials (tenant_id, expires_at, credential_id)
  WHERE revoked_at IS NULL;

ALTER TABLE public.proofstack_api_key_credentials ENABLE ROW LEVEL SECURITY;

CREATE POLICY proofstack_api_key_tenant_select
  ON public.proofstack_api_key_credentials
  FOR SELECT
  USING (
    tenant_id = NULLIF(current_setting('proofstack.tenant_id', true), '')
  );

CREATE POLICY proofstack_api_key_tenant_insert
  ON public.proofstack_api_key_credentials
  FOR INSERT
  WITH CHECK (
    tenant_id = NULLIF(current_setting('proofstack.tenant_id', true), '')
  );

CREATE POLICY proofstack_api_key_tenant_update
  ON public.proofstack_api_key_credentials
  FOR UPDATE
  USING (
    tenant_id = NULLIF(current_setting('proofstack.tenant_id', true), '')
  )
  WITH CHECK (
    tenant_id = NULLIF(current_setting('proofstack.tenant_id', true), '')
  );

CREATE FUNCTION public.proofstack_guard_api_key_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  revocation_changed boolean;
  use_metadata_changed boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'ProofStack API key credentials cannot be deleted';
  END IF;

  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.credential_id IS DISTINCT FROM OLD.credential_id
    OR NEW.key_prefix IS DISTINCT FROM OLD.key_prefix
    OR NEW.principal_id IS DISTINCT FROM OLD.principal_id
    OR NEW.display_name IS DISTINCT FROM OLD.display_name
    OR NEW.capabilities IS DISTINCT FROM OLD.capabilities
    OR NEW.resource_scope IS DISTINCT FROM OLD.resource_scope
    OR NEW.hash_algorithm IS DISTINCT FROM OLD.hash_algorithm
    OR NEW.hash_cost IS DISTINCT FROM OLD.hash_cost
    OR NEW.hash_block_size IS DISTINCT FROM OLD.hash_block_size
    OR NEW.hash_parallelization IS DISTINCT FROM OLD.hash_parallelization
    OR NEW.hash_key_length IS DISTINCT FROM OLD.hash_key_length
    OR NEW.hash_salt IS DISTINCT FROM OLD.hash_salt
    OR NEW.hash_digest IS DISTINCT FROM OLD.hash_digest
    OR NEW.created_by_principal_id IS DISTINCT FROM OLD.created_by_principal_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
    OR NEW.rotated_from_credential_id IS DISTINCT FROM OLD.rotated_from_credential_id
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'ProofStack API key credential identity is immutable';
  END IF;

  revocation_changed := (
    NEW.revoked_at IS DISTINCT FROM OLD.revoked_at
    OR NEW.revoked_by_principal_id IS DISTINCT FROM OLD.revoked_by_principal_id
    OR NEW.revocation_reason IS DISTINCT FROM OLD.revocation_reason
  );
  use_metadata_changed := (
    NEW.use_count IS DISTINCT FROM OLD.use_count
    OR NEW.last_used_at IS DISTINCT FROM OLD.last_used_at
  );

  IF revocation_changed AND use_metadata_changed THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'ProofStack API key state transitions must be isolated';
  END IF;

  IF revocation_changed AND (
    OLD.revoked_at IS NOT NULL
    OR NEW.revoked_at IS NULL
    OR NEW.revoked_by_principal_id IS NULL
    OR NEW.revocation_reason IS NULL
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'A revoked ProofStack API key credential is terminal';
  END IF;

  IF use_metadata_changed AND (
    NEW.last_used_at IS NULL
    OR (OLD.last_used_at IS NOT NULL AND NEW.last_used_at < OLD.last_used_at)
    OR (
      OLD.use_count < 2147483647
      AND NEW.use_count <> OLD.use_count + 1
    )
    OR (
      OLD.use_count = 2147483647
      AND NEW.use_count <> OLD.use_count
    )
  )
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'ProofStack API key use metadata must advance monotonically';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.proofstack_guard_api_key_mutation() FROM PUBLIC;

CREATE TRIGGER proofstack_api_key_mutation_guard
  BEFORE UPDATE OR DELETE ON public.proofstack_api_key_credentials
  FOR EACH ROW
  EXECUTE FUNCTION public.proofstack_guard_api_key_mutation();

CREATE TABLE public.proofstack_identity_audit_events (
  tenant_id varchar(64) NOT NULL,
  audit_id bigint GENERATED ALWAYS AS IDENTITY,
  event_type varchar(64) NOT NULL,
  actor_principal_id varchar(64) NOT NULL,
  target_principal_id varchar(64) NOT NULL,
  credential_id varchar(64) NOT NULL,
  related_credential_id varchar(64),
  outcome varchar(32) NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT proofstack_identity_audit_pk PRIMARY KEY (tenant_id, audit_id),
  CONSTRAINT proofstack_identity_audit_tenant_format CHECK (
    tenant_id ~ '^[a-z][a-z0-9_]{2,63}$'
  ),
  CONSTRAINT proofstack_identity_audit_event_format CHECK (
    event_type ~ '^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)+$'
  ),
  CONSTRAINT proofstack_identity_audit_actor_format CHECK (
    actor_principal_id ~ '^[a-z][a-z0-9_]{2,63}$'
  ),
  CONSTRAINT proofstack_identity_audit_target_format CHECK (
    target_principal_id ~ '^[a-z][a-z0-9_]{2,63}$'
  ),
  CONSTRAINT proofstack_identity_audit_credential_format CHECK (
    credential_id ~ '^[a-z][a-z0-9_]{2,63}$'
    AND (
      related_credential_id IS NULL
      OR related_credential_id ~ '^[a-z][a-z0-9_]{2,63}$'
    )
  ),
  CONSTRAINT proofstack_identity_audit_outcome_format CHECK (
    outcome ~ '^[a-z][a-z0-9_]{1,31}$'
  )
);

CREATE INDEX proofstack_identity_audit_timeline_idx
  ON public.proofstack_identity_audit_events (
    tenant_id,
    occurred_at DESC,
    audit_id DESC
  );

ALTER TABLE public.proofstack_identity_audit_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY proofstack_identity_audit_tenant_select
  ON public.proofstack_identity_audit_events
  FOR SELECT
  USING (
    tenant_id = NULLIF(current_setting('proofstack.tenant_id', true), '')
  );

CREATE FUNCTION public.proofstack_reject_identity_audit_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '55000',
    MESSAGE = 'ProofStack identity audit events are append-only';
END;
$$;

REVOKE ALL ON FUNCTION public.proofstack_reject_identity_audit_mutation() FROM PUBLIC;

CREATE TRIGGER proofstack_identity_audit_append_only
  BEFORE UPDATE OR DELETE ON public.proofstack_identity_audit_events
  FOR EACH ROW
  EXECUTE FUNCTION public.proofstack_reject_identity_audit_mutation();

CREATE FUNCTION public.proofstack_require_identity_tenant(p_tenant_id text)
RETURNS void
LANGUAGE plpgsql
STABLE
STRICT
SET search_path = pg_catalog
AS $$
BEGIN
  IF p_tenant_id !~ '^[a-z][a-z0-9_]{2,63}$'
    OR p_tenant_id IS DISTINCT FROM NULLIF(current_setting('proofstack.tenant_id', true), '')
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'ProofStack identity tenant context is missing or mismatched';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.proofstack_require_identity_tenant(text) FROM PUBLIC;

CREATE FUNCTION public.proofstack_write_identity_audit(
  p_tenant_id text,
  p_event_type text,
  p_actor_principal_id text,
  p_target_principal_id text,
  p_credential_id text,
  p_related_credential_id text,
  p_outcome text,
  p_occurred_at timestamptz
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  INSERT INTO public.proofstack_identity_audit_events (
    tenant_id,
    event_type,
    actor_principal_id,
    target_principal_id,
    credential_id,
    related_credential_id,
    outcome,
    occurred_at
  ) VALUES (
    p_tenant_id,
    p_event_type,
    p_actor_principal_id,
    p_target_principal_id,
    p_credential_id,
    p_related_credential_id,
    p_outcome,
    p_occurred_at
  )
$$;

REVOKE ALL ON FUNCTION public.proofstack_write_identity_audit(
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  timestamptz
) FROM PUBLIC;

CREATE FUNCTION public.proofstack_find_active_api_key(p_key_prefix text)
RETURNS TABLE (
  authenticated_at timestamptz,
  capabilities text[],
  credential_id text,
  hash_algorithm text,
  hash_block_size integer,
  hash_cost integer,
  hash_digest text,
  hash_key_length integer,
  hash_parallelization integer,
  hash_salt text,
  key_prefix text,
  principal_id text,
  resource_scope jsonb,
  tenant_id text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
BEGIN
  IF p_key_prefix !~ '^[A-Za-z0-9_-]{12}$' THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    v_now,
    credential.capabilities,
    credential.credential_id::text,
    credential.hash_algorithm::text,
    credential.hash_block_size,
    credential.hash_cost,
    credential.hash_digest::text,
    credential.hash_key_length,
    credential.hash_parallelization,
    credential.hash_salt::text,
    credential.key_prefix::text,
    credential.principal_id::text,
    credential.resource_scope,
    credential.tenant_id::text
  FROM public.proofstack_api_key_credentials AS credential
  WHERE credential.key_prefix = p_key_prefix
    AND credential.revoked_at IS NULL
    AND credential.expires_at > v_now;
END;
$$;

REVOKE ALL ON FUNCTION public.proofstack_find_active_api_key(text) FROM PUBLIC;

CREATE FUNCTION public.proofstack_find_api_key(
  p_tenant_id text,
  p_credential_id text
)
RETURNS TABLE (
  capabilities text[],
  created_at timestamptz,
  credential_id text,
  expires_at timestamptz,
  display_name text,
  key_prefix text,
  principal_id text,
  resource_scope jsonb,
  revoked_at timestamptz,
  rotated_from_credential_id text,
  tenant_id text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  PERFORM public.proofstack_require_identity_tenant(p_tenant_id);

  RETURN QUERY
  SELECT
    credential.capabilities,
    credential.created_at,
    credential.credential_id::text,
    credential.expires_at,
    credential.display_name::text,
    credential.key_prefix::text,
    credential.principal_id::text,
    credential.resource_scope,
    credential.revoked_at,
    credential.rotated_from_credential_id::text,
    credential.tenant_id::text
  FROM public.proofstack_api_key_credentials AS credential
  WHERE credential.tenant_id = p_tenant_id
    AND credential.credential_id = p_credential_id;
END;
$$;

REVOKE ALL ON FUNCTION public.proofstack_find_api_key(text, text) FROM PUBLIC;

CREATE FUNCTION public.proofstack_create_api_key(
  p_tenant_id text,
  p_credential_id text,
  p_key_prefix text,
  p_principal_id text,
  p_display_name text,
  p_capabilities text[],
  p_resource_scope jsonb,
  p_hash_algorithm text,
  p_hash_cost integer,
  p_hash_block_size integer,
  p_hash_parallelization integer,
  p_hash_key_length integer,
  p_hash_salt text,
  p_hash_digest text,
  p_expires_at timestamptz,
  p_actor_principal_id text
)
RETURNS TABLE (created_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_created_at timestamptz := clock_timestamp();
BEGIN
  PERFORM public.proofstack_require_identity_tenant(p_tenant_id);

  INSERT INTO public.proofstack_api_key_credentials (
    tenant_id,
    credential_id,
    key_prefix,
    principal_id,
    display_name,
    capabilities,
    resource_scope,
    hash_algorithm,
    hash_cost,
    hash_block_size,
    hash_parallelization,
    hash_key_length,
    hash_salt,
    hash_digest,
    created_by_principal_id,
    created_at,
    expires_at
  ) VALUES (
    p_tenant_id,
    p_credential_id,
    p_key_prefix,
    p_principal_id,
    p_display_name,
    p_capabilities,
    p_resource_scope,
    p_hash_algorithm,
    p_hash_cost,
    p_hash_block_size,
    p_hash_parallelization,
    p_hash_key_length,
    p_hash_salt,
    p_hash_digest,
    p_actor_principal_id,
    v_created_at,
    p_expires_at
  );

  PERFORM public.proofstack_write_identity_audit(
    p_tenant_id,
    'api_key.issued',
    p_actor_principal_id,
    p_principal_id,
    p_credential_id,
    NULL,
    'succeeded',
    v_created_at
  );

  RETURN QUERY SELECT v_created_at;
END;
$$;

REVOKE ALL ON FUNCTION public.proofstack_create_api_key(
  text,
  text,
  text,
  text,
  text,
  text[],
  jsonb,
  text,
  integer,
  integer,
  integer,
  integer,
  text,
  text,
  timestamptz,
  text
) FROM PUBLIC;

CREATE FUNCTION public.proofstack_rotate_api_key(
  p_tenant_id text,
  p_previous_credential_id text,
  p_credential_id text,
  p_key_prefix text,
  p_hash_algorithm text,
  p_hash_cost integer,
  p_hash_block_size integer,
  p_hash_parallelization integer,
  p_hash_key_length integer,
  p_hash_salt text,
  p_hash_digest text,
  p_expires_at timestamptz,
  p_actor_principal_id text
)
RETURNS TABLE (created_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_created_at timestamptz := clock_timestamp();
  v_previous public.proofstack_api_key_credentials%ROWTYPE;
BEGIN
  PERFORM public.proofstack_require_identity_tenant(p_tenant_id);

  SELECT *
  INTO v_previous
  FROM public.proofstack_api_key_credentials AS credential
  WHERE credential.tenant_id = p_tenant_id
    AND credential.credential_id = p_previous_credential_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0002',
      MESSAGE = 'ProofStack API key credential was not found';
  END IF;

  IF v_previous.revoked_at IS NOT NULL OR v_previous.expires_at <= v_created_at THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'ProofStack API key credential is not active';
  END IF;

  INSERT INTO public.proofstack_api_key_credentials (
    tenant_id,
    credential_id,
    key_prefix,
    principal_id,
    display_name,
    capabilities,
    resource_scope,
    hash_algorithm,
    hash_cost,
    hash_block_size,
    hash_parallelization,
    hash_key_length,
    hash_salt,
    hash_digest,
    created_by_principal_id,
    created_at,
    expires_at,
    rotated_from_credential_id
  ) VALUES (
    v_previous.tenant_id,
    p_credential_id,
    p_key_prefix,
    v_previous.principal_id,
    v_previous.display_name,
    v_previous.capabilities,
    v_previous.resource_scope,
    p_hash_algorithm,
    p_hash_cost,
    p_hash_block_size,
    p_hash_parallelization,
    p_hash_key_length,
    p_hash_salt,
    p_hash_digest,
    p_actor_principal_id,
    v_created_at,
    p_expires_at,
    v_previous.credential_id
  );

  UPDATE public.proofstack_api_key_credentials AS credential
  SET revoked_at = v_created_at,
      revoked_by_principal_id = p_actor_principal_id,
      revocation_reason = 'rotated'
  WHERE credential.tenant_id = p_tenant_id
    AND credential.credential_id = p_previous_credential_id;

  PERFORM public.proofstack_write_identity_audit(
    p_tenant_id,
    'api_key.rotated',
    p_actor_principal_id,
    v_previous.principal_id,
    p_credential_id,
    p_previous_credential_id,
    'succeeded',
    v_created_at
  );

  RETURN QUERY SELECT v_created_at;
END;
$$;

REVOKE ALL ON FUNCTION public.proofstack_rotate_api_key(
  text,
  text,
  text,
  text,
  text,
  integer,
  integer,
  integer,
  integer,
  text,
  text,
  timestamptz,
  text
) FROM PUBLIC;

CREATE FUNCTION public.proofstack_revoke_api_key(
  p_tenant_id text,
  p_credential_id text,
  p_actor_principal_id text,
  p_reason text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_credential public.proofstack_api_key_credentials%ROWTYPE;
  v_now timestamptz := clock_timestamp();
BEGIN
  PERFORM public.proofstack_require_identity_tenant(p_tenant_id);

  SELECT *
  INTO v_credential
  FROM public.proofstack_api_key_credentials AS credential
  WHERE credential.tenant_id = p_tenant_id
    AND credential.credential_id = p_credential_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0002',
      MESSAGE = 'ProofStack API key credential was not found';
  END IF;

  IF v_credential.revoked_at IS NOT NULL THEN
    PERFORM public.proofstack_write_identity_audit(
      p_tenant_id,
      'api_key.revoked',
      p_actor_principal_id,
      v_credential.principal_id,
      p_credential_id,
      NULL,
      'already_revoked',
      v_now
    );
    RETURN false;
  END IF;

  UPDATE public.proofstack_api_key_credentials AS credential
  SET revoked_at = v_now,
      revoked_by_principal_id = p_actor_principal_id,
      revocation_reason = p_reason
  WHERE credential.tenant_id = p_tenant_id
    AND credential.credential_id = p_credential_id;

  PERFORM public.proofstack_write_identity_audit(
    p_tenant_id,
    'api_key.revoked',
    p_actor_principal_id,
    v_credential.principal_id,
    p_credential_id,
    NULL,
    'succeeded',
    v_now
  );
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.proofstack_revoke_api_key(text, text, text, text) FROM PUBLIC;

CREATE FUNCTION public.proofstack_record_api_key_use(
  p_tenant_id text,
  p_credential_id text,
  p_key_prefix text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
BEGIN
  UPDATE public.proofstack_api_key_credentials AS credential
  SET last_used_at = v_now,
      use_count = LEAST(credential.use_count + 1, 2147483647)
  WHERE credential.tenant_id = p_tenant_id
    AND credential.credential_id = p_credential_id
    AND credential.key_prefix = p_key_prefix
    AND credential.revoked_at IS NULL
    AND credential.expires_at > v_now;

  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.proofstack_record_api_key_use(text, text, text) FROM PUBLIC;

REVOKE ALL ON TABLE public.proofstack_api_key_credentials FROM PUBLIC;
REVOKE ALL ON TABLE public.proofstack_identity_audit_events FROM PUBLIC;
REVOKE ALL ON SEQUENCE public.proofstack_identity_audit_events_audit_id_seq FROM PUBLIC;
