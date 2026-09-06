CREATE TABLE public.proofstack_release_candidate_registry (
  tenant_id varchar(64) NOT NULL,
  project_id varchar(64) NOT NULL,
  environment_id varchar(64) NOT NULL,
  candidate_version_id varchar(64) NOT NULL,
  schema_version varchar(16) NOT NULL,
  definition_sha256 character(64) NOT NULL,

  CONSTRAINT proofstack_release_candidate_registry_pk PRIMARY KEY (
    tenant_id, candidate_version_id
  ),
  CONSTRAINT proofstack_release_candidate_registry_scope_digest_unique UNIQUE (
    tenant_id, project_id, environment_id, candidate_version_id, definition_sha256
  ),
  CONSTRAINT proofstack_release_candidate_registry_tenant_format CHECK (
    tenant_id ~ '^[a-z][a-z0-9_]{2,63}$'
  ),
  CONSTRAINT proofstack_release_candidate_registry_project_format CHECK (
    project_id ~ '^[a-z][a-z0-9_]{2,63}$'
  ),
  CONSTRAINT proofstack_release_candidate_registry_environment_format CHECK (
    environment_id ~ '^[a-z][a-z0-9_]{2,63}$'
  ),
  CONSTRAINT proofstack_release_candidate_registry_version CHECK (
    schema_version = '0.1'
  ),
  CONSTRAINT proofstack_release_candidate_registry_id_format CHECK (
    candidate_version_id ~ '^[a-z][a-z0-9_]{2,63}$'
  ),
  CONSTRAINT proofstack_release_candidate_registry_digest CHECK (
    definition_sha256 ~ '^[0-9a-f]{64}$'
  )
);

CREATE TABLE public.proofstack_release_candidate_resources (
  tenant_id varchar(64) NOT NULL,
  project_id varchar(64) NOT NULL,
  environment_id varchar(64) NOT NULL,
  candidate_id varchar(64) NOT NULL,
  root_candidate_version_id varchar(64) NOT NULL,
  root_definition_sha256 character(64) NOT NULL,

  CONSTRAINT proofstack_release_candidate_resources_pk PRIMARY KEY (
    tenant_id, candidate_id
  ),
  CONSTRAINT proofstack_release_candidate_resources_scope_unique UNIQUE (
    tenant_id, project_id, environment_id, candidate_id
  ),
  CONSTRAINT proofstack_release_candidate_resources_root_fk FOREIGN KEY (
    tenant_id,
    project_id,
    environment_id,
    root_candidate_version_id,
    root_definition_sha256
  ) REFERENCES public.proofstack_release_candidate_registry (
    tenant_id,
    project_id,
    environment_id,
    candidate_version_id,
    definition_sha256
  ) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT proofstack_release_candidate_resources_id_format CHECK (
    candidate_id ~ '^[a-z][a-z0-9_]{2,63}$'
  )
);

CREATE TABLE public.proofstack_release_candidate_lineage (
  tenant_id varchar(64) NOT NULL,
  project_id varchar(64) NOT NULL,
  environment_id varchar(64) NOT NULL,
  child_candidate_version_id varchar(64) NOT NULL,
  child_definition_sha256 character(64) NOT NULL,
  parent_candidate_version_id varchar(64) NOT NULL,
  parent_definition_sha256 character(64) NOT NULL,

  CONSTRAINT proofstack_release_candidate_lineage_pk PRIMARY KEY (
    tenant_id, child_candidate_version_id
  ),
  CONSTRAINT proofstack_release_candidate_lineage_child_fk FOREIGN KEY (
    tenant_id,
    project_id,
    environment_id,
    child_candidate_version_id,
    child_definition_sha256
  ) REFERENCES public.proofstack_release_candidate_registry (
    tenant_id,
    project_id,
    environment_id,
    candidate_version_id,
    definition_sha256
  ) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT proofstack_release_candidate_lineage_parent_fk FOREIGN KEY (
    tenant_id,
    project_id,
    environment_id,
    parent_candidate_version_id,
    parent_definition_sha256
  ) REFERENCES public.proofstack_release_candidate_registry (
    tenant_id,
    project_id,
    environment_id,
    candidate_version_id,
    definition_sha256
  ) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT proofstack_release_candidate_lineage_not_self CHECK (
    child_candidate_version_id IS DISTINCT FROM parent_candidate_version_id
  )
);

CREATE INDEX proofstack_release_candidate_lineage_parent_idx
  ON public.proofstack_release_candidate_lineage (
    tenant_id, parent_candidate_version_id
  );

CREATE TABLE public.proofstack_release_candidates (
  tenant_id varchar(64) NOT NULL,
  project_id varchar(64) NOT NULL,
  environment_id varchar(64) NOT NULL,
  candidate_id varchar(64) NOT NULL,
  candidate_version_id varchar(64) NOT NULL,
  schema_version varchar(16) NOT NULL,
  definition_sha256 character(64) NOT NULL,
  created_at timestamptz NOT NULL,
  created_at_lexical text NOT NULL,
  created_by_principal_id varchar(64) NOT NULL,
  lineage_count smallint NOT NULL,
  record jsonb NOT NULL,

  CONSTRAINT proofstack_release_candidates_pk PRIMARY KEY (
    tenant_id, candidate_version_id
  ),
  CONSTRAINT proofstack_release_candidates_registry_fk FOREIGN KEY (
    tenant_id,
    project_id,
    environment_id,
    candidate_version_id,
    definition_sha256
  ) REFERENCES public.proofstack_release_candidate_registry (
    tenant_id,
    project_id,
    environment_id,
    candidate_version_id,
    definition_sha256
  ) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT proofstack_release_candidates_common_projection CHECK (
    jsonb_typeof(record) = 'object'
    AND record ->> 'candidateId' = candidate_id
    AND record ->> 'candidateVersionId' = candidate_version_id
    AND record ->> 'schemaVersion' = schema_version
    AND record ->> 'definitionSha256' = definition_sha256
    AND jsonb_typeof(record -> 'scope') = 'object'
    AND record #>> '{scope,tenantId}' = tenant_id
    AND record #>> '{scope,projectId}' = project_id
    AND record #>> '{scope,environmentId}' = environment_id
    AND record #>> '{target,environmentId}' = environment_id
    AND record ->> 'createdAt' = created_at_lexical
    AND record ->> 'createdByPrincipalId' = created_by_principal_id
  ),
  CONSTRAINT proofstack_release_candidates_created_at CHECK (
    isfinite(created_at)
    AND created_at_lexical ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
    AND created_at = created_at_lexical::timestamptz
  ),
  CONSTRAINT proofstack_release_candidates_candidate_id_format CHECK (
    candidate_id ~ '^[a-z][a-z0-9_]{2,63}$'
  ),
  CONSTRAINT proofstack_release_candidates_principal_format CHECK (
    created_by_principal_id ~ '^[a-z][a-z0-9_]{2,63}$'
  ),
  CONSTRAINT proofstack_release_candidates_lineage_count CHECK (
    lineage_count IN (0, 1)
    AND lineage_count = CASE WHEN record ? 'predecessor' THEN 1 ELSE 0 END
  ),
  CONSTRAINT proofstack_release_candidates_predecessor_identity CHECK (
    NOT (record ? 'predecessor')
    OR record #>> '{predecessor,candidateId}' = candidate_id
  )
);

CREATE FUNCTION public.proofstack_verify_release_candidate_body()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.proofstack_release_candidates AS body
    WHERE body.tenant_id = NEW.tenant_id
      AND body.project_id = NEW.project_id
      AND body.environment_id = NEW.environment_id
      AND body.candidate_version_id = NEW.candidate_version_id
      AND body.definition_sha256 = NEW.definition_sha256
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Release candidate registry record requires one exact body';
  END IF;
  RETURN NULL;
END;
$$;

CREATE FUNCTION public.proofstack_verify_release_candidate_lineage()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  actual_count integer;
BEGIN
  SELECT count(*)::integer
  INTO actual_count
  FROM public.proofstack_release_candidate_lineage AS edge
  WHERE edge.tenant_id = NEW.tenant_id
    AND edge.child_candidate_version_id = NEW.candidate_version_id;

  IF actual_count IS DISTINCT FROM NEW.lineage_count THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Release candidate lineage does not match its immutable record';
  END IF;
  RETURN NULL;
END;
$$;

CREATE FUNCTION public.proofstack_insert_release_candidate(command jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  tenant text := command ->> 'tenantId';
  project text := command ->> 'projectId';
  environment text := command ->> 'environmentId';
  candidate text := command ->> 'candidateId';
  candidate_version text := command ->> 'candidateVersionId';
  digest text := command ->> 'definitionSha256';
  body jsonb := command -> 'record';
  predecessor_version text := body #>> '{predecessor,candidateVersionId}';
  predecessor_digest text := body #>> '{predecessor,definitionSha256}';
  reference_count smallint := CASE WHEN body ? 'predecessor' THEN 1 ELSE 0 END;
BEGIN
  IF jsonb_typeof(command) IS DISTINCT FROM 'object'
    OR tenant IS NULL
    OR tenant IS DISTINCT FROM NULLIF(current_setting('proofstack.tenant_id', true), '')
    OR jsonb_typeof(body) IS DISTINCT FROM 'object'
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'Release candidate persistence command is malformed or outside the active tenant';
  END IF;

  INSERT INTO public.proofstack_release_candidate_registry (
    tenant_id, project_id, environment_id, candidate_version_id,
    schema_version, definition_sha256
  ) VALUES (
    tenant, project, environment, candidate_version,
    command ->> 'schemaVersion', digest
  );

  IF body ? 'predecessor' AND NOT EXISTS (
    SELECT 1
    FROM public.proofstack_release_candidates AS predecessor
    WHERE predecessor.tenant_id = tenant
      AND predecessor.project_id = project
      AND predecessor.environment_id = environment
      AND predecessor.candidate_id = candidate
      AND predecessor.candidate_version_id = predecessor_version
      AND predecessor.definition_sha256 = predecessor_digest
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23503',
      MESSAGE = 'Release candidate contains unavailable or conflicting exact lineage';
  END IF;

  IF body ? 'predecessor' THEN
    INSERT INTO public.proofstack_release_candidate_lineage (
      tenant_id, project_id, environment_id, child_candidate_version_id,
      child_definition_sha256, parent_candidate_version_id, parent_definition_sha256
    ) VALUES (
      tenant, project, environment, candidate_version, digest,
      predecessor_version, predecessor_digest
    );
  END IF;

  INSERT INTO public.proofstack_release_candidates (
    tenant_id, project_id, environment_id, candidate_id, candidate_version_id,
    schema_version, definition_sha256, created_at, created_at_lexical,
    created_by_principal_id, lineage_count, record
  ) VALUES (
    tenant, project, environment, candidate, candidate_version,
    command ->> 'schemaVersion', digest, (command ->> 'createdAt')::timestamptz,
    command ->> 'createdAt', command ->> 'createdByPrincipalId', reference_count, body
  );

  INSERT INTO public.proofstack_release_candidate_resources (
    tenant_id, project_id, environment_id, candidate_id,
    root_candidate_version_id, root_definition_sha256
  ) VALUES (
    tenant, project, environment, candidate, candidate_version, digest
  ) ON CONFLICT (tenant_id, candidate_id) DO NOTHING;

  IF NOT EXISTS (
    SELECT 1
    FROM public.proofstack_release_candidate_resources AS binding
    WHERE binding.tenant_id = tenant
      AND binding.project_id = project
      AND binding.environment_id = environment
      AND binding.candidate_id = candidate
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23505',
      MESSAGE = 'Release candidate resource is already bound to another exact scope';
  END IF;

  INSERT INTO public.proofstack_outbox (
    tenant_id, event_type, aggregate_type, aggregate_id, schema_version, payload, created_at
  ) VALUES (
    tenant, 'release.candidate.published', 'release_candidate', candidate_version,
    command ->> 'schemaVersion',
    jsonb_build_object('recordKind', 'release_candidate', 'record', body),
    (command ->> 'createdAt')::timestamptz
  );
END;
$$;

CREATE FUNCTION public.proofstack_publish_release_candidate(command jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  PERFORM public.proofstack_insert_release_candidate(command);
END;
$$;

CREATE FUNCTION public.proofstack_release_candidate_intent_status(
  requested_aggregate_id text,
  requested_schema_version text,
  requested_payload jsonb,
  requested_created_at timestamptz
)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT CASE
    WHEN NULLIF(current_setting('proofstack.tenant_id', true), '') IS NULL THEN 'unauthorized'
    WHEN NOT EXISTS (
      SELECT 1
      FROM public.proofstack_outbox AS intent
      WHERE intent.tenant_id = NULLIF(current_setting('proofstack.tenant_id', true), '')
        AND intent.event_type = 'release.candidate.published'
        AND intent.aggregate_type = 'release_candidate'
        AND intent.aggregate_id = requested_aggregate_id
    ) THEN 'absent'
    WHEN EXISTS (
      SELECT 1
      FROM public.proofstack_outbox AS intent
      WHERE intent.tenant_id = NULLIF(current_setting('proofstack.tenant_id', true), '')
        AND intent.event_type = 'release.candidate.published'
        AND intent.aggregate_type = 'release_candidate'
        AND intent.aggregate_id = requested_aggregate_id
        AND intent.schema_version = requested_schema_version
        AND intent.payload = requested_payload
        AND intent.created_at = requested_created_at
    ) THEN 'canonical'
    ELSE 'conflict'
  END
$$;

REVOKE ALL ON FUNCTION public.proofstack_verify_release_candidate_body() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.proofstack_verify_release_candidate_lineage() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.proofstack_insert_release_candidate(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.proofstack_publish_release_candidate(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.proofstack_release_candidate_intent_status(
  text, text, jsonb, timestamptz
) FROM PUBLIC;

CREATE CONSTRAINT TRIGGER proofstack_release_candidate_registry_body_complete
  AFTER INSERT ON public.proofstack_release_candidate_registry
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.proofstack_verify_release_candidate_body();

CREATE CONSTRAINT TRIGGER proofstack_release_candidate_lineage_complete
  AFTER INSERT ON public.proofstack_release_candidates
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.proofstack_verify_release_candidate_lineage();

CREATE TRIGGER proofstack_release_candidate_registry_append_only
  BEFORE UPDATE OR DELETE ON public.proofstack_release_candidate_registry
  FOR EACH ROW EXECUTE FUNCTION public.proofstack_reject_append_only_mutation();
CREATE TRIGGER proofstack_release_candidate_resources_append_only
  BEFORE UPDATE OR DELETE ON public.proofstack_release_candidate_resources
  FOR EACH ROW EXECUTE FUNCTION public.proofstack_reject_append_only_mutation();
CREATE TRIGGER proofstack_release_candidate_lineage_append_only
  BEFORE UPDATE OR DELETE ON public.proofstack_release_candidate_lineage
  FOR EACH ROW EXECUTE FUNCTION public.proofstack_reject_append_only_mutation();
CREATE TRIGGER proofstack_release_candidates_append_only
  BEFORE UPDATE OR DELETE ON public.proofstack_release_candidates
  FOR EACH ROW EXECUTE FUNCTION public.proofstack_reject_append_only_mutation();

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'proofstack_release_candidate_registry',
    'proofstack_release_candidate_resources',
    'proofstack_release_candidate_lineage',
    'proofstack_release_candidates'
  ]
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT '
      'USING (tenant_id = NULLIF(current_setting(''proofstack.tenant_id'', true), ''''))',
      table_name || '_tenant_select', table_name
    );
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR INSERT '
      'WITH CHECK (tenant_id = NULLIF(current_setting(''proofstack.tenant_id'', true), ''''))',
      table_name || '_tenant_insert', table_name
    );
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC', table_name);
  END LOOP;
END;
$$;
