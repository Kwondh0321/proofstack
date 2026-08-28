CREATE FUNCTION public.proofstack_valid_user_roles(value text[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = pg_catalog
AS $$
  SELECT
    cardinality(value) BETWEEN 1 AND 5
    AND value <@ ARRAY['owner', 'admin', 'member', 'viewer', 'ingest']::text[]
    AND cardinality(value) = (
      SELECT count(DISTINCT role_name)::integer
      FROM unnest(value) AS role_names(role_name)
    )
$$;

REVOKE ALL ON FUNCTION public.proofstack_valid_user_roles(text[]) FROM PUBLIC;

CREATE FUNCTION public.proofstack_valid_user_capabilities(value text[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = pg_catalog
AS $$
  SELECT
    cardinality(value) BETWEEN 0 AND 14
    AND value <@ ARRAY[
      'project:read',
      'project:manage',
      'evidence:ingest',
      'evidence:read',
      'evaluation:read',
      'evaluation:run',
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

CREATE TABLE public.proofstack_oidc_bindings (
  tenant_id varchar(64) NOT NULL,
  binding_id varchar(64) NOT NULL,
  identity_digest character(64) NOT NULL,
  issuer varchar(2048) COLLATE "C" NOT NULL,
  subject varchar(512) COLLATE "C" NOT NULL,
  principal_id varchar(64) NOT NULL,
  roles text[] NOT NULL,
  capabilities text[] NOT NULL,
  resource_scope jsonb NOT NULL,
  authorization_version integer NOT NULL DEFAULT 1,
  created_by_principal_id varchar(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_by_principal_id varchar(64) NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  disabled_at timestamptz,
  disabled_by_principal_id varchar(64),
  disable_reason varchar(512),

  CONSTRAINT proofstack_oidc_bindings_pk PRIMARY KEY (tenant_id, binding_id),
  CONSTRAINT proofstack_oidc_binding_id_unique UNIQUE (binding_id),
  CONSTRAINT proofstack_oidc_binding_identity_digest_unique UNIQUE (identity_digest),
  CONSTRAINT proofstack_oidc_binding_identity_unique UNIQUE (issuer, subject),
  CONSTRAINT proofstack_oidc_binding_tenant_format CHECK (
    tenant_id ~ '^[a-z][a-z0-9_]{2,63}$'
  ),
  CONSTRAINT proofstack_oidc_binding_id_format CHECK (
    binding_id ~ '^[a-z][a-z0-9_]{2,63}$'
  ),
  CONSTRAINT proofstack_oidc_binding_identity_digest_format CHECK (
    identity_digest ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT proofstack_oidc_binding_issuer_format CHECK (
    length(issuer) BETWEEN 1 AND 2048
    AND octet_length(issuer) <= 2048
    AND issuer ~ '^https://[^[:space:]]+$'
    AND issuer !~ '[[:cntrl:]]'
    AND issuer !~ '[?#\\]'
    AND issuer !~ '^https://[^/]*@'
  ),
  CONSTRAINT proofstack_oidc_binding_subject_format CHECK (
    length(subject) BETWEEN 1 AND 512
    AND octet_length(subject) <= 512
    AND subject !~ '[[:cntrl:]]'
  ),
  CONSTRAINT proofstack_oidc_binding_principal_format CHECK (
    principal_id ~ '^[a-z][a-z0-9_]{2,63}$'
  ),
  CONSTRAINT proofstack_oidc_binding_roles_valid CHECK (
    public.proofstack_valid_user_roles(roles)
  ),
  CONSTRAINT proofstack_oidc_binding_capabilities_valid CHECK (
    public.proofstack_valid_user_capabilities(capabilities)
  ),
  CONSTRAINT proofstack_oidc_binding_scope_valid CHECK (
    public.proofstack_valid_resource_scope(resource_scope)
  ),
  CONSTRAINT proofstack_oidc_binding_version_valid CHECK (
    authorization_version BETWEEN 1 AND 2147483647
  ),
  CONSTRAINT proofstack_oidc_binding_creation_shape CHECK (
    created_by_principal_id ~ '^[a-z][a-z0-9_]{2,63}$'
    AND updated_by_principal_id ~ '^[a-z][a-z0-9_]{2,63}$'
    AND updated_at >= created_at
  ),
  CONSTRAINT proofstack_oidc_binding_disable_shape CHECK (
    (
      (
        disabled_at IS NULL
        AND disabled_by_principal_id IS NULL
        AND disable_reason IS NULL
      )
      OR (
        disabled_at IS NOT NULL
        AND disabled_at >= created_at
        AND disabled_by_principal_id ~ '^[a-z][a-z0-9_]{2,63}$'
        AND length(disable_reason) BETWEEN 1 AND 512
        AND disable_reason = btrim(disable_reason)
        AND disable_reason !~ '[[:cntrl:]]'
      )
    ) IS TRUE
  )
);

CREATE INDEX proofstack_oidc_binding_principal_idx
  ON public.proofstack_oidc_bindings (tenant_id, principal_id, binding_id);

ALTER TABLE public.proofstack_oidc_bindings ENABLE ROW LEVEL SECURITY;

CREATE POLICY proofstack_oidc_binding_tenant_select
  ON public.proofstack_oidc_bindings
  FOR SELECT
  USING (
    tenant_id = NULLIF(current_setting('proofstack.tenant_id', true), '')
  );

CREATE POLICY proofstack_oidc_binding_tenant_insert
  ON public.proofstack_oidc_bindings
  FOR INSERT
  WITH CHECK (
    tenant_id = NULLIF(current_setting('proofstack.tenant_id', true), '')
  );

CREATE POLICY proofstack_oidc_binding_tenant_update
  ON public.proofstack_oidc_bindings
  FOR UPDATE
  USING (
    tenant_id = NULLIF(current_setting('proofstack.tenant_id', true), '')
  )
  WITH CHECK (
    tenant_id = NULLIF(current_setting('proofstack.tenant_id', true), '')
  );

CREATE FUNCTION public.proofstack_guard_oidc_binding_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  authorization_changed boolean;
  disable_changed boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'ProofStack OIDC bindings cannot be deleted';
  END IF;

  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.binding_id IS DISTINCT FROM OLD.binding_id
    OR NEW.identity_digest IS DISTINCT FROM OLD.identity_digest
    OR NEW.issuer IS DISTINCT FROM OLD.issuer
    OR NEW.subject IS DISTINCT FROM OLD.subject
    OR NEW.principal_id IS DISTINCT FROM OLD.principal_id
    OR NEW.created_by_principal_id IS DISTINCT FROM OLD.created_by_principal_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'ProofStack OIDC binding identity is immutable';
  END IF;

  authorization_changed := (
    NEW.roles IS DISTINCT FROM OLD.roles
    OR NEW.capabilities IS DISTINCT FROM OLD.capabilities
    OR NEW.resource_scope IS DISTINCT FROM OLD.resource_scope
    OR NEW.authorization_version IS DISTINCT FROM OLD.authorization_version
    OR NEW.updated_by_principal_id IS DISTINCT FROM OLD.updated_by_principal_id
    OR NEW.updated_at IS DISTINCT FROM OLD.updated_at
  );
  disable_changed := (
    NEW.disabled_at IS DISTINCT FROM OLD.disabled_at
    OR NEW.disabled_by_principal_id IS DISTINCT FROM OLD.disabled_by_principal_id
    OR NEW.disable_reason IS DISTINCT FROM OLD.disable_reason
  );

  IF authorization_changed AND disable_changed THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'ProofStack OIDC binding transitions must be isolated';
  END IF;

  IF authorization_changed AND (
    OLD.disabled_at IS NOT NULL
    OR NEW.authorization_version <> OLD.authorization_version + 1
    OR NEW.updated_at < OLD.updated_at
    OR NEW.updated_by_principal_id IS NULL
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'ProofStack OIDC binding authorization must advance monotonically';
  END IF;

  IF disable_changed AND (
    OLD.disabled_at IS NOT NULL
    OR NEW.disabled_at IS NULL
    OR NEW.disabled_by_principal_id IS NULL
    OR NEW.disable_reason IS NULL
    OR NEW.roles IS DISTINCT FROM OLD.roles
    OR NEW.capabilities IS DISTINCT FROM OLD.capabilities
    OR NEW.resource_scope IS DISTINCT FROM OLD.resource_scope
    OR NEW.authorization_version IS DISTINCT FROM OLD.authorization_version
    OR NEW.updated_by_principal_id IS DISTINCT FROM OLD.updated_by_principal_id
    OR NEW.updated_at IS DISTINCT FROM OLD.updated_at
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'A disabled ProofStack OIDC binding is terminal';
  END IF;

  IF NOT authorization_changed AND NOT disable_changed THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'ProofStack OIDC binding updates must change one lifecycle state';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.proofstack_guard_oidc_binding_mutation() FROM PUBLIC;

CREATE TRIGGER proofstack_oidc_binding_mutation_guard
  BEFORE UPDATE OR DELETE ON public.proofstack_oidc_bindings
  FOR EACH ROW
  EXECUTE FUNCTION public.proofstack_guard_oidc_binding_mutation();

CREATE TABLE public.proofstack_oidc_login_transactions (
  state_digest character(64) NOT NULL,
  protected_payload text NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,

  CONSTRAINT proofstack_oidc_login_transactions_pk PRIMARY KEY (state_digest),
  CONSTRAINT proofstack_oidc_login_state_digest_format CHECK (
    state_digest ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT proofstack_oidc_login_payload_format CHECK (
    length(protected_payload) BETWEEN 48 AND 4144
    AND protected_payload ~ '^otx_v1_[A-Za-z0-9_-]{16}_[A-Za-z0-9_-]{1,4096}_[A-Za-z0-9_-]{22}$'
  ),
  CONSTRAINT proofstack_oidc_login_expiration_range CHECK (
    expires_at >= created_at + interval '60 seconds'
    AND expires_at <= created_at + interval '15 minutes'
  ),
  CONSTRAINT proofstack_oidc_login_consumption_shape CHECK (
    consumed_at IS NULL OR consumed_at >= created_at
  )
);

CREATE INDEX proofstack_oidc_login_retention_idx
  ON public.proofstack_oidc_login_transactions (expires_at, state_digest);

ALTER TABLE public.proofstack_oidc_login_transactions ENABLE ROW LEVEL SECURITY;

CREATE FUNCTION public.proofstack_guard_oidc_login_transaction_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.expires_at > clock_timestamp() - interval '1 day'
      AND (
        OLD.consumed_at IS NULL
        OR OLD.consumed_at > clock_timestamp() - interval '1 day'
      )
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '55000',
        MESSAGE = 'Active ProofStack OIDC login transactions cannot be deleted';
    END IF;
    RETURN OLD;
  END IF;

  IF NEW.state_digest IS DISTINCT FROM OLD.state_digest
    OR NEW.protected_payload IS DISTINCT FROM OLD.protected_payload
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
    OR OLD.consumed_at IS NOT NULL
    OR NEW.consumed_at IS NULL
    OR NEW.consumed_at < OLD.created_at
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'ProofStack OIDC login transaction state is immutable after consumption';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.proofstack_guard_oidc_login_transaction_mutation() FROM PUBLIC;

CREATE TRIGGER proofstack_oidc_login_transaction_mutation_guard
  BEFORE UPDATE OR DELETE ON public.proofstack_oidc_login_transactions
  FOR EACH ROW
  EXECUTE FUNCTION public.proofstack_guard_oidc_login_transaction_mutation();

CREATE TABLE public.proofstack_browser_sessions (
  tenant_id varchar(64) NOT NULL,
  session_id varchar(64) NOT NULL,
  session_digest character(64) NOT NULL,
  csrf_digest character(64) NOT NULL,
  binding_id varchar(64) NOT NULL,
  created_at timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  idle_lifetime_seconds integer NOT NULL,
  idle_expires_at timestamptz NOT NULL,
  last_used_at timestamptz,
  use_count integer NOT NULL DEFAULT 0,
  revoked_at timestamptz,
  revocation_reason varchar(64),

  CONSTRAINT proofstack_browser_sessions_pk PRIMARY KEY (tenant_id, session_id),
  CONSTRAINT proofstack_browser_session_id_unique UNIQUE (session_id),
  CONSTRAINT proofstack_browser_session_digest_unique UNIQUE (session_digest),
  CONSTRAINT proofstack_browser_session_binding_fk FOREIGN KEY (tenant_id, binding_id)
    REFERENCES public.proofstack_oidc_bindings (tenant_id, binding_id),
  CONSTRAINT proofstack_browser_session_tenant_format CHECK (
    tenant_id ~ '^[a-z][a-z0-9_]{2,63}$'
  ),
  CONSTRAINT proofstack_browser_session_id_format CHECK (
    session_id ~ '^[a-z][a-z0-9_]{2,63}$'
  ),
  CONSTRAINT proofstack_browser_session_digest_format CHECK (
    session_digest ~ '^[0-9a-f]{64}$'
    AND csrf_digest ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT proofstack_browser_session_binding_format CHECK (
    binding_id ~ '^[a-z][a-z0-9_]{2,63}$'
  ),
  CONSTRAINT proofstack_browser_session_absolute_expiration CHECK (
    absolute_expires_at >= created_at + interval '60 seconds'
    AND absolute_expires_at <= created_at + interval '24 hours'
  ),
  CONSTRAINT proofstack_browser_session_idle_lifetime CHECK (
    idle_lifetime_seconds BETWEEN 60 AND 86400
    AND idle_expires_at = LEAST(
      absolute_expires_at,
      COALESCE(last_used_at, created_at) + idle_lifetime_seconds * interval '1 second'
    )
  ),
  CONSTRAINT proofstack_browser_session_use_shape CHECK (
    use_count BETWEEN 0 AND 2147483647
    AND (
      (use_count = 0 AND last_used_at IS NULL)
      OR (use_count > 0 AND last_used_at IS NOT NULL AND last_used_at >= created_at)
    )
  ),
  CONSTRAINT proofstack_browser_session_revocation_shape CHECK (
    (
      (revoked_at IS NULL AND revocation_reason IS NULL)
      OR (
        revoked_at IS NOT NULL
        AND revoked_at >= created_at
        AND revocation_reason IN ('logout', 'binding_disabled', 'administrative')
      )
    ) IS TRUE
  )
);

CREATE INDEX proofstack_browser_session_binding_idx
  ON public.proofstack_browser_sessions (tenant_id, binding_id, created_at, session_id);

CREATE INDEX proofstack_browser_session_retention_idx
  ON public.proofstack_browser_sessions (absolute_expires_at, session_id);

ALTER TABLE public.proofstack_browser_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY proofstack_browser_session_tenant_select
  ON public.proofstack_browser_sessions
  FOR SELECT
  USING (
    tenant_id = NULLIF(current_setting('proofstack.tenant_id', true), '')
  );

CREATE FUNCTION public.proofstack_guard_browser_session_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  revocation_changed boolean;
  use_metadata_changed boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.absolute_expires_at > clock_timestamp() - interval '30 days'
      AND (
        OLD.revoked_at IS NULL
        OR OLD.revoked_at > clock_timestamp() - interval '30 days'
      )
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '55000',
        MESSAGE = 'Retained ProofStack browser sessions cannot be deleted';
    END IF;
    RETURN OLD;
  END IF;

  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.session_id IS DISTINCT FROM OLD.session_id
    OR NEW.session_digest IS DISTINCT FROM OLD.session_digest
    OR NEW.csrf_digest IS DISTINCT FROM OLD.csrf_digest
    OR NEW.binding_id IS DISTINCT FROM OLD.binding_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.absolute_expires_at IS DISTINCT FROM OLD.absolute_expires_at
    OR NEW.idle_lifetime_seconds IS DISTINCT FROM OLD.idle_lifetime_seconds
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'ProofStack browser session identity is immutable';
  END IF;

  revocation_changed := (
    NEW.revoked_at IS DISTINCT FROM OLD.revoked_at
    OR NEW.revocation_reason IS DISTINCT FROM OLD.revocation_reason
  );
  use_metadata_changed := (
    NEW.idle_expires_at IS DISTINCT FROM OLD.idle_expires_at
    OR NEW.last_used_at IS DISTINCT FROM OLD.last_used_at
    OR NEW.use_count IS DISTINCT FROM OLD.use_count
  );

  IF revocation_changed AND use_metadata_changed THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'ProofStack browser session transitions must be isolated';
  END IF;

  IF revocation_changed AND (
    OLD.revoked_at IS NOT NULL
    OR NEW.revoked_at IS NULL
    OR NEW.revocation_reason IS NULL
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'A revoked ProofStack browser session is terminal';
  END IF;

  IF use_metadata_changed AND (
    NEW.last_used_at IS NULL
    OR (OLD.last_used_at IS NOT NULL AND NEW.last_used_at < OLD.last_used_at)
    OR NEW.idle_expires_at < OLD.idle_expires_at
    OR NEW.idle_expires_at > NEW.absolute_expires_at
    OR (
      OLD.use_count < 2147483647
      AND NEW.use_count <> OLD.use_count + 1
    )
    OR (
      OLD.use_count = 2147483647
      AND NEW.use_count <> OLD.use_count
    )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'ProofStack browser session use metadata must advance monotonically';
  END IF;

  IF NOT revocation_changed AND NOT use_metadata_changed THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'ProofStack browser session updates must change one lifecycle state';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.proofstack_guard_browser_session_mutation() FROM PUBLIC;

CREATE TRIGGER proofstack_browser_session_mutation_guard
  BEFORE UPDATE OR DELETE ON public.proofstack_browser_sessions
  FOR EACH ROW
  EXECUTE FUNCTION public.proofstack_guard_browser_session_mutation();

CREATE FUNCTION public.proofstack_create_oidc_binding(
  p_tenant_id text,
  p_binding_id text,
  p_identity_digest text,
  p_issuer text,
  p_subject text,
  p_principal_id text,
  p_roles text[],
  p_capabilities text[],
  p_resource_scope jsonb,
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

  INSERT INTO public.proofstack_oidc_bindings (
    tenant_id,
    binding_id,
    identity_digest,
    issuer,
    subject,
    principal_id,
    roles,
    capabilities,
    resource_scope,
    created_by_principal_id,
    created_at,
    updated_by_principal_id,
    updated_at
  ) VALUES (
    p_tenant_id,
    p_binding_id,
    p_identity_digest,
    p_issuer,
    p_subject,
    p_principal_id,
    p_roles,
    p_capabilities,
    p_resource_scope,
    p_actor_principal_id,
    v_created_at,
    p_actor_principal_id,
    v_created_at
  );

  PERFORM public.proofstack_write_identity_audit(
    p_tenant_id,
    'oidc_binding.created',
    p_actor_principal_id,
    p_principal_id,
    p_binding_id,
    NULL,
    'succeeded',
    v_created_at
  );

  RETURN QUERY SELECT v_created_at;
END;
$$;

REVOKE ALL ON FUNCTION public.proofstack_create_oidc_binding(
  text,
  text,
  text,
  text,
  text,
  text,
  text[],
  text[],
  jsonb,
  text
) FROM PUBLIC;

CREATE FUNCTION public.proofstack_find_active_oidc_binding(
  p_identity_digest text,
  p_issuer text,
  p_subject text
)
RETURNS TABLE (
  binding_id text,
  capabilities text[],
  issuer text,
  principal_id text,
  resource_scope jsonb,
  roles text[],
  subject text,
  tenant_id text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT
    binding.binding_id::text,
    binding.capabilities,
    binding.issuer::text,
    binding.principal_id::text,
    binding.resource_scope,
    binding.roles,
    binding.subject::text,
    binding.tenant_id::text
  FROM public.proofstack_oidc_bindings AS binding
  WHERE binding.identity_digest = p_identity_digest
    AND binding.issuer = p_issuer
    AND binding.subject = p_subject
    AND binding.disabled_at IS NULL
$$;

REVOKE ALL ON FUNCTION public.proofstack_find_active_oidc_binding(text, text, text) FROM PUBLIC;

CREATE FUNCTION public.proofstack_update_oidc_binding(
  p_tenant_id text,
  p_binding_id text,
  p_roles text[],
  p_capabilities text[],
  p_resource_scope jsonb,
  p_actor_principal_id text
)
RETURNS TABLE (updated_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_principal_id text;
  v_updated_at timestamptz := clock_timestamp();
BEGIN
  PERFORM public.proofstack_require_identity_tenant(p_tenant_id);

  UPDATE public.proofstack_oidc_bindings AS binding
  SET roles = p_roles,
      capabilities = p_capabilities,
      resource_scope = p_resource_scope,
      authorization_version = binding.authorization_version + 1,
      updated_by_principal_id = p_actor_principal_id,
      updated_at = v_updated_at
  WHERE binding.tenant_id = p_tenant_id
    AND binding.binding_id = p_binding_id
    AND binding.disabled_at IS NULL
    AND binding.authorization_version < 2147483647
  RETURNING binding.principal_id INTO v_principal_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0002',
      MESSAGE = 'ProofStack OIDC binding was not found or active';
  END IF;

  PERFORM public.proofstack_write_identity_audit(
    p_tenant_id,
    'oidc_binding.updated',
    p_actor_principal_id,
    v_principal_id,
    p_binding_id,
    NULL,
    'succeeded',
    v_updated_at
  );

  RETURN QUERY SELECT v_updated_at;
END;
$$;

REVOKE ALL ON FUNCTION public.proofstack_update_oidc_binding(
  text,
  text,
  text[],
  text[],
  jsonb,
  text
) FROM PUBLIC;

CREATE FUNCTION public.proofstack_disable_oidc_binding(
  p_tenant_id text,
  p_binding_id text,
  p_actor_principal_id text,
  p_reason text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_principal_id text;
BEGIN
  PERFORM public.proofstack_require_identity_tenant(p_tenant_id);

  UPDATE public.proofstack_oidc_bindings AS binding
  SET disabled_at = v_now,
      disabled_by_principal_id = p_actor_principal_id,
      disable_reason = p_reason
  WHERE binding.tenant_id = p_tenant_id
    AND binding.binding_id = p_binding_id
    AND binding.disabled_at IS NULL
  RETURNING binding.principal_id INTO v_principal_id;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  UPDATE public.proofstack_browser_sessions AS session
  SET revoked_at = v_now,
      revocation_reason = 'binding_disabled'
  WHERE session.tenant_id = p_tenant_id
    AND session.binding_id = p_binding_id
    AND session.revoked_at IS NULL;

  PERFORM public.proofstack_write_identity_audit(
    p_tenant_id,
    'oidc_binding.disabled',
    p_actor_principal_id,
    v_principal_id,
    p_binding_id,
    NULL,
    'succeeded',
    v_now
  );
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.proofstack_disable_oidc_binding(text, text, text, text) FROM PUBLIC;

CREATE FUNCTION public.proofstack_create_oidc_login_transaction(
  p_state_digest text,
  p_protected_payload text,
  p_lifetime_seconds integer
)
RETURNS TABLE (created_at timestamptz, expires_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_created_at timestamptz := clock_timestamp();
  v_expires_at timestamptz;
BEGIN
  IF p_lifetime_seconds NOT BETWEEN 60 AND 900 THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'ProofStack OIDC login transaction lifetime is invalid';
  END IF;
  v_expires_at := v_created_at + p_lifetime_seconds * interval '1 second';

  INSERT INTO public.proofstack_oidc_login_transactions (
    state_digest,
    protected_payload,
    created_at,
    expires_at
  ) VALUES (
    p_state_digest,
    p_protected_payload,
    v_created_at,
    v_expires_at
  );

  RETURN QUERY SELECT v_created_at, v_expires_at;
END;
$$;

REVOKE ALL ON FUNCTION public.proofstack_create_oidc_login_transaction(
  text,
  text,
  integer
) FROM PUBLIC;

CREATE FUNCTION public.proofstack_consume_oidc_login_transaction(p_state_digest text)
RETURNS TABLE (protected_payload text, state_digest text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
BEGIN
  RETURN QUERY
  UPDATE public.proofstack_oidc_login_transactions AS login_transaction
  SET consumed_at = v_now
  WHERE login_transaction.state_digest = p_state_digest
    AND login_transaction.consumed_at IS NULL
    AND login_transaction.expires_at > v_now
  RETURNING login_transaction.protected_payload, login_transaction.state_digest::text;
END;
$$;

REVOKE ALL ON FUNCTION public.proofstack_consume_oidc_login_transaction(text) FROM PUBLIC;

CREATE FUNCTION public.proofstack_purge_oidc_login_transactions()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_deleted integer;
  v_now timestamptz := clock_timestamp();
BEGIN
  DELETE FROM public.proofstack_oidc_login_transactions AS login_transaction
  WHERE login_transaction.ctid IN (
    SELECT candidate.ctid
    FROM public.proofstack_oidc_login_transactions AS candidate
    WHERE candidate.expires_at <= v_now - interval '1 day'
      OR candidate.consumed_at <= v_now - interval '1 day'
    ORDER BY candidate.expires_at, candidate.state_digest
    LIMIT 1000
  );
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

REVOKE ALL ON FUNCTION public.proofstack_purge_oidc_login_transactions() FROM PUBLIC;

CREATE FUNCTION public.proofstack_create_browser_session(
  p_session_id text,
  p_session_digest text,
  p_csrf_digest text,
  p_binding_id text,
  p_absolute_lifetime_seconds integer,
  p_idle_lifetime_seconds integer
)
RETURNS TABLE (
  absolute_expires_at timestamptz,
  created_at timestamptz,
  idle_expires_at timestamptz,
  session_id text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_absolute_expires_at timestamptz;
  v_binding public.proofstack_oidc_bindings%ROWTYPE;
  v_created_at timestamptz := clock_timestamp();
  v_idle_expires_at timestamptz;
BEGIN
  IF p_absolute_lifetime_seconds NOT BETWEEN 60 AND 86400
    OR p_idle_lifetime_seconds NOT BETWEEN 60 AND p_absolute_lifetime_seconds
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'ProofStack browser session lifetime is invalid';
  END IF;

  SELECT *
  INTO v_binding
  FROM public.proofstack_oidc_bindings AS binding
  WHERE binding.binding_id = p_binding_id
    AND binding.disabled_at IS NULL
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0002',
      MESSAGE = 'ProofStack OIDC binding was not found or active';
  END IF;

  v_absolute_expires_at :=
    v_created_at + p_absolute_lifetime_seconds * interval '1 second';
  v_idle_expires_at := v_created_at + p_idle_lifetime_seconds * interval '1 second';

  INSERT INTO public.proofstack_browser_sessions (
    tenant_id,
    session_id,
    session_digest,
    csrf_digest,
    binding_id,
    created_at,
    absolute_expires_at,
    idle_lifetime_seconds,
    idle_expires_at
  ) VALUES (
    v_binding.tenant_id,
    p_session_id,
    p_session_digest,
    p_csrf_digest,
    v_binding.binding_id,
    v_created_at,
    v_absolute_expires_at,
    p_idle_lifetime_seconds,
    v_idle_expires_at
  );

  PERFORM public.proofstack_write_identity_audit(
    v_binding.tenant_id,
    'browser_session.created',
    v_binding.principal_id,
    v_binding.principal_id,
    p_session_id,
    v_binding.binding_id,
    'succeeded',
    v_created_at
  );

  RETURN QUERY
  SELECT v_absolute_expires_at, v_created_at, v_idle_expires_at, p_session_id;
END;
$$;

REVOKE ALL ON FUNCTION public.proofstack_create_browser_session(
  text,
  text,
  text,
  text,
  integer,
  integer
) FROM PUBLIC;

CREATE FUNCTION public.proofstack_find_and_touch_active_browser_session(p_session_digest text)
RETURNS TABLE (
  capabilities text[],
  created_at timestamptz,
  csrf_digest text,
  principal_id text,
  resource_scope jsonb,
  roles text[],
  session_digest text,
  session_id text,
  tenant_id text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
BEGIN
  RETURN QUERY
  UPDATE public.proofstack_browser_sessions AS session
  SET last_used_at = v_now,
      use_count = CASE
        WHEN session.use_count < 2147483647 THEN session.use_count + 1
        ELSE session.use_count
      END,
      idle_expires_at = LEAST(
        session.absolute_expires_at,
        v_now + session.idle_lifetime_seconds * interval '1 second'
      )
  FROM public.proofstack_oidc_bindings AS binding
  WHERE session.session_digest = p_session_digest
    AND session.revoked_at IS NULL
    AND session.absolute_expires_at > v_now
    AND session.idle_expires_at > v_now
    AND binding.tenant_id = session.tenant_id
    AND binding.binding_id = session.binding_id
    AND binding.disabled_at IS NULL
  RETURNING
    binding.capabilities,
    session.created_at,
    session.csrf_digest::text,
    binding.principal_id::text,
    binding.resource_scope,
    binding.roles,
    session.session_digest::text,
    session.session_id::text,
    session.tenant_id::text;
END;
$$;

REVOKE ALL ON FUNCTION public.proofstack_find_and_touch_active_browser_session(text) FROM PUBLIC;

CREATE FUNCTION public.proofstack_revoke_browser_session(p_session_digest text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_binding_id text;
  v_now timestamptz := clock_timestamp();
  v_principal_id text;
  v_session_id text;
  v_tenant_id text;
BEGIN
  UPDATE public.proofstack_browser_sessions AS session
  SET revoked_at = v_now,
      revocation_reason = 'logout'
  FROM public.proofstack_oidc_bindings AS binding
  WHERE session.session_digest = p_session_digest
    AND session.revoked_at IS NULL
    AND binding.tenant_id = session.tenant_id
    AND binding.binding_id = session.binding_id
  RETURNING
    session.binding_id,
    binding.principal_id,
    session.session_id,
    session.tenant_id
  INTO v_binding_id, v_principal_id, v_session_id, v_tenant_id;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  PERFORM public.proofstack_write_identity_audit(
    v_tenant_id,
    'browser_session.revoked',
    v_principal_id,
    v_principal_id,
    v_session_id,
    v_binding_id,
    'succeeded',
    v_now
  );
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.proofstack_revoke_browser_session(text) FROM PUBLIC;

CREATE FUNCTION public.proofstack_purge_browser_sessions()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_deleted integer;
  v_now timestamptz := clock_timestamp();
BEGIN
  DELETE FROM public.proofstack_browser_sessions AS session
  WHERE session.ctid IN (
    SELECT candidate.ctid
    FROM public.proofstack_browser_sessions AS candidate
    WHERE candidate.absolute_expires_at <= v_now - interval '30 days'
      OR candidate.revoked_at <= v_now - interval '30 days'
    ORDER BY candidate.absolute_expires_at, candidate.session_id
    LIMIT 1000
  );
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

REVOKE ALL ON FUNCTION public.proofstack_purge_browser_sessions() FROM PUBLIC;

REVOKE ALL ON TABLE public.proofstack_oidc_bindings FROM PUBLIC;
REVOKE ALL ON TABLE public.proofstack_oidc_login_transactions FROM PUBLIC;
REVOKE ALL ON TABLE public.proofstack_browser_sessions FROM PUBLIC;
