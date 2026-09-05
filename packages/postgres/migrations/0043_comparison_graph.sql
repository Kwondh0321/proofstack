CREATE TABLE public.proofstack_comparison_record_registry (
  tenant_id varchar(64) NOT NULL,
  project_id varchar(64) NOT NULL,
  environment_id varchar(64) NOT NULL,
  record_kind varchar(48) NOT NULL,
  record_id varchar(64) NOT NULL,
  schema_version varchar(16) NOT NULL,
  definition_sha256 character(64) NOT NULL,

  CONSTRAINT proofstack_comparison_record_registry_pk PRIMARY KEY (
    tenant_id, record_kind, record_id
  ),
  CONSTRAINT proofstack_comparison_record_registry_scope_digest_unique UNIQUE (
    tenant_id, project_id, environment_id, record_kind, record_id, definition_sha256
  ),
  CONSTRAINT proofstack_comparison_record_registry_tenant_format CHECK (
    tenant_id ~ '^[a-z][a-z0-9_]{2,63}$'
  ),
  CONSTRAINT proofstack_comparison_record_registry_project_format CHECK (
    project_id ~ '^[a-z][a-z0-9_]{2,63}$'
  ),
  CONSTRAINT proofstack_comparison_record_registry_environment_format CHECK (
    environment_id ~ '^[a-z][a-z0-9_]{2,63}$'
  ),
  CONSTRAINT proofstack_comparison_record_registry_kind_version CHECK (
    (record_kind = 'comparison_definition' AND schema_version = '0.7')
    OR (record_kind = 'comparison_evidence_snapshot' AND schema_version = '0.3')
    OR (record_kind = 'comparison_result' AND schema_version = '0.6')
  ),
  CONSTRAINT proofstack_comparison_record_registry_id_format CHECK (
    record_id ~ '^[a-z][a-z0-9_]{2,63}$'
  ),
  CONSTRAINT proofstack_comparison_record_registry_digest CHECK (
    definition_sha256 ~ '^[0-9a-f]{64}$'
  )
);

CREATE TABLE public.proofstack_comparison_resource_bindings (
  tenant_id varchar(64) NOT NULL,
  project_id varchar(64) NOT NULL,
  environment_id varchar(64) NOT NULL,
  comparison_id varchar(64) NOT NULL,
  root_record_kind varchar(48) NOT NULL,
  root_record_id varchar(64) NOT NULL,
  root_definition_sha256 character(64) NOT NULL,

  CONSTRAINT proofstack_comparison_resource_bindings_pk PRIMARY KEY (
    tenant_id, comparison_id
  ),
  CONSTRAINT proofstack_comparison_resource_bindings_scope_unique UNIQUE (
    tenant_id, project_id, environment_id, comparison_id
  ),
  CONSTRAINT proofstack_comparison_resource_bindings_root_fk FOREIGN KEY (
    tenant_id,
    project_id,
    environment_id,
    root_record_kind,
    root_record_id,
    root_definition_sha256
  ) REFERENCES public.proofstack_comparison_record_registry (
    tenant_id,
    project_id,
    environment_id,
    record_kind,
    record_id,
    definition_sha256
  ) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT proofstack_comparison_resource_bindings_kind CHECK (
    root_record_kind = 'comparison_definition'
  ),
  CONSTRAINT proofstack_comparison_resource_bindings_id_format CHECK (
    comparison_id ~ '^[a-z][a-z0-9_]{2,63}$'
  )
);

CREATE TABLE public.proofstack_comparison_lineage (
  tenant_id varchar(64) NOT NULL,
  project_id varchar(64) NOT NULL,
  environment_id varchar(64) NOT NULL,
  child_record_kind varchar(48) NOT NULL,
  child_record_id varchar(64) NOT NULL,
  child_definition_sha256 character(64) NOT NULL,
  edge_position smallint NOT NULL,
  parent_record_kind varchar(48) NOT NULL,
  parent_record_id varchar(64) NOT NULL,
  parent_definition_sha256 character(64) NOT NULL,

  CONSTRAINT proofstack_comparison_lineage_pk PRIMARY KEY (
    tenant_id, child_record_kind, child_record_id, edge_position
  ),
  CONSTRAINT proofstack_comparison_lineage_parent_unique UNIQUE (
    tenant_id, child_record_kind, child_record_id, parent_record_kind, parent_record_id
  ),
  CONSTRAINT proofstack_comparison_lineage_child_fk FOREIGN KEY (
    tenant_id,
    project_id,
    environment_id,
    child_record_kind,
    child_record_id,
    child_definition_sha256
  ) REFERENCES public.proofstack_comparison_record_registry (
    tenant_id,
    project_id,
    environment_id,
    record_kind,
    record_id,
    definition_sha256
  ) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT proofstack_comparison_lineage_parent_fk FOREIGN KEY (
    tenant_id,
    project_id,
    environment_id,
    parent_record_kind,
    parent_record_id,
    parent_definition_sha256
  ) REFERENCES public.proofstack_comparison_record_registry (
    tenant_id,
    project_id,
    environment_id,
    record_kind,
    record_id,
    definition_sha256
  ) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT proofstack_comparison_lineage_position CHECK (
    edge_position BETWEEN 0 AND 2
  ),
  CONSTRAINT proofstack_comparison_lineage_not_self CHECK (
    (child_record_kind, child_record_id) IS DISTINCT FROM
      (parent_record_kind, parent_record_id)
  )
);

CREATE INDEX proofstack_comparison_lineage_parent_idx
  ON public.proofstack_comparison_lineage (
    tenant_id, parent_record_kind, parent_record_id
  );

CREATE TABLE public.proofstack_comparison_records (
  tenant_id varchar(64) NOT NULL,
  project_id varchar(64) NOT NULL,
  environment_id varchar(64) NOT NULL,
  record_kind varchar(48) NOT NULL,
  record_id varchar(64) NOT NULL,
  schema_version varchar(16) NOT NULL,
  definition_sha256 character(64) NOT NULL,
  created_at timestamptz NOT NULL,
  created_at_lexical text NOT NULL,
  actor_principal_id varchar(64) NOT NULL,
  comparison_id varchar(64) NOT NULL,
  comparison_version_id varchar(64) NOT NULL,
  comparison_role varchar(16),
  lineage_count smallint NOT NULL,
  record jsonb NOT NULL,

  CONSTRAINT proofstack_comparison_records_pk PRIMARY KEY (
    tenant_id, record_kind, record_id
  ),
  CONSTRAINT proofstack_comparison_records_registry_fk FOREIGN KEY (
    tenant_id,
    project_id,
    environment_id,
    record_kind,
    record_id,
    definition_sha256
  ) REFERENCES public.proofstack_comparison_record_registry (
    tenant_id,
    project_id,
    environment_id,
    record_kind,
    record_id,
    definition_sha256
  ) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT proofstack_comparison_records_common_projection CHECK (
    jsonb_typeof(record) = 'object'
    AND record ->> 'schemaVersion' = schema_version
    AND record ->> 'definitionSha256' = definition_sha256
    AND jsonb_typeof(record -> 'scope') = 'object'
    AND record #>> '{scope,tenantId}' = tenant_id
    AND record #>> '{scope,projectId}' = project_id
    AND record #>> '{scope,environmentId}' = environment_id
  ),
  CONSTRAINT proofstack_comparison_records_created_at CHECK (
    isfinite(created_at)
    AND created_at_lexical ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
    AND created_at = created_at_lexical::timestamptz
  ),
  CONSTRAINT proofstack_comparison_records_actor_format CHECK (
    actor_principal_id ~ '^[a-z][a-z0-9_]{2,63}$'
  ),
  CONSTRAINT proofstack_comparison_records_comparison_id_format CHECK (
    comparison_id ~ '^[a-z][a-z0-9_]{2,63}$'
  ),
  CONSTRAINT proofstack_comparison_records_version_id_format CHECK (
    comparison_version_id ~ '^[a-z][a-z0-9_]{2,63}$'
  ),
  CONSTRAINT proofstack_comparison_records_role CHECK (
    comparison_role IS NULL OR comparison_role IN ('baseline', 'candidate')
  ),
  CONSTRAINT proofstack_comparison_records_lineage_count CHECK (
    lineage_count BETWEEN 0 AND 3
  )
) PARTITION BY LIST (record_kind);

CREATE TABLE public.proofstack_comparison_definitions
  PARTITION OF public.proofstack_comparison_records
  FOR VALUES IN ('comparison_definition');
CREATE TABLE public.proofstack_comparison_evidence_snapshots
  PARTITION OF public.proofstack_comparison_records
  FOR VALUES IN ('comparison_evidence_snapshot');
CREATE TABLE public.proofstack_comparison_results
  PARTITION OF public.proofstack_comparison_records
  FOR VALUES IN ('comparison_result');

ALTER TABLE public.proofstack_comparison_definitions
  ADD CONSTRAINT proofstack_comparison_definitions_projection CHECK (
    record_id = record ->> 'comparisonVersionId'
    AND comparison_id = record ->> 'comparisonId'
    AND comparison_version_id = record_id
    AND comparison_role IS NULL
    AND created_at_lexical = record ->> 'createdAt'
    AND actor_principal_id = record ->> 'createdByPrincipalId'
  );
ALTER TABLE public.proofstack_comparison_evidence_snapshots
  ADD CONSTRAINT proofstack_comparison_evidence_snapshots_projection CHECK (
    record_id = record ->> 'snapshotId'
    AND comparison_id = record #>> '{comparison,comparisonId}'
    AND comparison_version_id = record #>> '{comparison,comparisonVersionId}'
    AND comparison_role = record ->> 'role'
    AND created_at_lexical = record ->> 'createdAt'
    AND actor_principal_id = record ->> 'createdByPrincipalId'
  );
ALTER TABLE public.proofstack_comparison_results
  ADD CONSTRAINT proofstack_comparison_results_projection CHECK (
    record_id = record ->> 'resultId'
    AND comparison_id = record #>> '{comparison,comparisonId}'
    AND comparison_version_id = record #>> '{comparison,comparisonVersionId}'
    AND comparison_role IS NULL
    AND created_at_lexical = record ->> 'createdAt'
    AND actor_principal_id = record ->> 'createdByPrincipalId'
  );

CREATE FUNCTION public.proofstack_comparison_record_references(
  root_record_kind text,
  record jsonb
)
RETURNS TABLE (
  edge_position smallint,
  parent_record_kind text,
  parent_record_id text,
  parent_definition_sha256 text
)
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT reference.edge_position, reference.record_kind, reference.record_id, reference.digest
  FROM (
    VALUES
      (
        0::smallint,
        'comparison_definition'::text,
        CASE root_record_kind
          WHEN 'comparison_definition' THEN record #>> '{predecessor,comparisonVersionId}'
          WHEN 'comparison_evidence_snapshot' THEN record #>> '{comparison,comparisonVersionId}'
          WHEN 'comparison_result' THEN record #>> '{comparison,comparisonVersionId}'
        END,
        CASE root_record_kind
          WHEN 'comparison_definition' THEN record #>> '{predecessor,definitionSha256}'
          WHEN 'comparison_evidence_snapshot' THEN record #>> '{comparison,definitionSha256}'
          WHEN 'comparison_result' THEN record #>> '{comparison,definitionSha256}'
        END
      ),
      (
        1::smallint,
        'comparison_evidence_snapshot'::text,
        CASE WHEN root_record_kind = 'comparison_result'
          THEN record #>> '{baselineSnapshot,snapshotId}' END,
        CASE WHEN root_record_kind = 'comparison_result'
          THEN record #>> '{baselineSnapshot,definitionSha256}' END
      ),
      (
        2::smallint,
        'comparison_evidence_snapshot'::text,
        CASE WHEN root_record_kind = 'comparison_result'
          THEN record #>> '{candidateSnapshot,snapshotId}' END,
        CASE WHEN root_record_kind = 'comparison_result'
          THEN record #>> '{candidateSnapshot,definitionSha256}' END
      )
  ) AS reference(edge_position, record_kind, record_id, digest)
  WHERE reference.record_id IS NOT NULL AND reference.digest IS NOT NULL
  ORDER BY reference.edge_position
$$;

CREATE FUNCTION public.proofstack_verify_comparison_record_body()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.proofstack_comparison_records AS body
    WHERE body.tenant_id = NEW.tenant_id
      AND body.project_id = NEW.project_id
      AND body.environment_id = NEW.environment_id
      AND body.record_kind = NEW.record_kind
      AND body.record_id = NEW.record_id
      AND body.definition_sha256 = NEW.definition_sha256
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Comparison registry record requires one exact typed body';
  END IF;
  RETURN NULL;
END;
$$;

CREATE FUNCTION public.proofstack_verify_comparison_lineage_count()
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
  FROM public.proofstack_comparison_lineage AS edge
  WHERE edge.tenant_id = NEW.tenant_id
    AND edge.child_record_kind = NEW.record_kind
    AND edge.child_record_id = NEW.record_id;

  IF actual_count IS DISTINCT FROM NEW.lineage_count THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Comparison lineage edge count does not match its immutable record';
  END IF;
  RETURN NULL;
END;
$$;

CREATE FUNCTION public.proofstack_insert_comparison_record(command jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  tenant text := command ->> 'tenantId';
  project text := command ->> 'projectId';
  environment text := command ->> 'environmentId';
  kind text := command ->> 'recordKind';
  id text := command ->> 'recordId';
  digest text := command ->> 'definitionSha256';
  body jsonb := command -> 'record';
  comparison text := command ->> 'comparisonId';
  comparison_version text := command ->> 'comparisonVersionId';
  comparison_role text := command ->> 'comparisonRole';
  reference_count integer;
  v_event_type text;
BEGIN
  IF jsonb_typeof(command) IS DISTINCT FROM 'object'
    OR tenant IS NULL
    OR tenant IS DISTINCT FROM NULLIF(current_setting('proofstack.tenant_id', true), '')
    OR kind IS NULL
    OR kind NOT IN (
      'comparison_definition', 'comparison_evidence_snapshot', 'comparison_result'
    )
    OR jsonb_typeof(body) IS DISTINCT FROM 'object'
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'Comparison persistence command is malformed or outside the active tenant';
  END IF;

  INSERT INTO public.proofstack_comparison_record_registry (
    tenant_id, project_id, environment_id, record_kind, record_id,
    schema_version, definition_sha256
  ) VALUES (
    tenant, project, environment, kind, id, command ->> 'schemaVersion', digest
  );

  IF EXISTS (
    SELECT 1
    FROM public.proofstack_comparison_record_references(kind, body) AS reference
    LEFT JOIN public.proofstack_comparison_record_registry AS parent
      ON parent.tenant_id = tenant
      AND parent.project_id = project
      AND parent.environment_id = environment
      AND parent.record_kind = reference.parent_record_kind
      AND parent.record_id = reference.parent_record_id
      AND parent.definition_sha256 = reference.parent_definition_sha256
    WHERE parent.record_id IS NULL
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23503',
      MESSAGE = 'Comparison record contains unavailable or conflicting exact lineage';
  END IF;

  IF kind = 'comparison_definition' AND body ? 'predecessor' AND NOT EXISTS (
    SELECT 1
    FROM public.proofstack_comparison_records AS predecessor
    WHERE predecessor.tenant_id = tenant
      AND predecessor.project_id = project
      AND predecessor.environment_id = environment
      AND predecessor.record_kind = 'comparison_definition'
      AND predecessor.record_id = body #>> '{predecessor,comparisonVersionId}'
      AND predecessor.definition_sha256 = body #>> '{predecessor,definitionSha256}'
      AND predecessor.comparison_id = comparison
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23503',
      MESSAGE = 'Comparison definition predecessor belongs to another comparison resource';
  END IF;

  IF kind = 'comparison_evidence_snapshot' AND NOT EXISTS (
    SELECT 1
    FROM public.proofstack_comparison_records AS definition
    WHERE definition.tenant_id = tenant
      AND definition.project_id = project
      AND definition.environment_id = environment
      AND definition.record_kind = 'comparison_definition'
      AND definition.record_id = comparison_version
      AND definition.definition_sha256 = body #>> '{comparison,definitionSha256}'
      AND definition.comparison_id = comparison
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23503',
      MESSAGE = 'Comparison snapshot does not match its exact comparison definition';
  END IF;

  IF kind = 'comparison_result' AND NOT EXISTS (
    SELECT 1
    FROM public.proofstack_comparison_records AS definition
    JOIN public.proofstack_comparison_records AS baseline
      ON baseline.tenant_id = tenant
      AND baseline.project_id = project
      AND baseline.environment_id = environment
      AND baseline.record_kind = 'comparison_evidence_snapshot'
      AND baseline.record_id = body #>> '{baselineSnapshot,snapshotId}'
      AND baseline.definition_sha256 = body #>> '{baselineSnapshot,definitionSha256}'
      AND baseline.comparison_role = 'baseline'
      AND baseline.comparison_id = comparison
      AND baseline.comparison_version_id = comparison_version
    JOIN public.proofstack_comparison_records AS candidate
      ON candidate.tenant_id = tenant
      AND candidate.project_id = project
      AND candidate.environment_id = environment
      AND candidate.record_kind = 'comparison_evidence_snapshot'
      AND candidate.record_id = body #>> '{candidateSnapshot,snapshotId}'
      AND candidate.definition_sha256 = body #>> '{candidateSnapshot,definitionSha256}'
      AND candidate.comparison_role = 'candidate'
      AND candidate.comparison_id = comparison
      AND candidate.comparison_version_id = comparison_version
    WHERE definition.tenant_id = tenant
      AND definition.project_id = project
      AND definition.environment_id = environment
      AND definition.record_kind = 'comparison_definition'
      AND definition.record_id = comparison_version
      AND definition.definition_sha256 = body #>> '{comparison,definitionSha256}'
      AND definition.comparison_id = comparison
      AND baseline.record_id IS DISTINCT FROM candidate.record_id
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23503',
      MESSAGE = 'Comparison result does not match its exact definition and role-bound snapshots';
  END IF;

  INSERT INTO public.proofstack_comparison_lineage (
    tenant_id, project_id, environment_id, child_record_kind, child_record_id,
    child_definition_sha256, edge_position, parent_record_kind, parent_record_id,
    parent_definition_sha256
  )
  SELECT tenant, project, environment, kind, id, digest, reference.edge_position,
    reference.parent_record_kind, reference.parent_record_id,
    reference.parent_definition_sha256
  FROM public.proofstack_comparison_record_references(kind, body) AS reference;
  GET DIAGNOSTICS reference_count = ROW_COUNT;

  INSERT INTO public.proofstack_comparison_records (
    tenant_id, project_id, environment_id, record_kind, record_id, schema_version,
    definition_sha256, created_at, created_at_lexical, actor_principal_id,
    comparison_id, comparison_version_id, comparison_role, lineage_count, record
  ) VALUES (
    tenant, project, environment, kind, id, command ->> 'schemaVersion', digest,
    (command ->> 'createdAt')::timestamptz, command ->> 'createdAt',
    command ->> 'actorPrincipalId', comparison, comparison_version, comparison_role,
    reference_count::smallint, body
  );

  IF kind = 'comparison_definition' THEN
    INSERT INTO public.proofstack_comparison_resource_bindings (
      tenant_id, project_id, environment_id, comparison_id, root_record_kind,
      root_record_id, root_definition_sha256
    ) VALUES (
      tenant, project, environment, comparison, kind, id, digest
    ) ON CONFLICT (tenant_id, comparison_id) DO NOTHING;

    IF NOT EXISTS (
      SELECT 1
      FROM public.proofstack_comparison_resource_bindings AS binding
      WHERE binding.tenant_id = tenant
        AND binding.project_id = project
        AND binding.environment_id = environment
        AND binding.comparison_id = comparison
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23505',
        MESSAGE = 'Comparison resource is already bound to another exact scope';
    END IF;
  END IF;

  v_event_type := CASE kind
    WHEN 'comparison_definition' THEN 'comparison.definition.published'
    WHEN 'comparison_evidence_snapshot' THEN 'comparison.snapshot.recorded'
    WHEN 'comparison_result' THEN 'comparison.result.recorded'
  END;

  INSERT INTO public.proofstack_outbox (
    tenant_id, event_type, aggregate_type, aggregate_id, schema_version, payload, created_at
  ) VALUES (
    tenant, v_event_type, kind, id, command ->> 'schemaVersion',
    jsonb_build_object('recordKind', kind, 'record', body),
    (command ->> 'createdAt')::timestamptz
  );
END;
$$;

CREATE FUNCTION public.proofstack_publish_comparison_record(command jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  PERFORM public.proofstack_insert_comparison_record(command);
END;
$$;

REVOKE ALL ON FUNCTION public.proofstack_comparison_record_references(text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.proofstack_verify_comparison_record_body() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.proofstack_verify_comparison_lineage_count() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.proofstack_insert_comparison_record(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.proofstack_publish_comparison_record(jsonb) FROM PUBLIC;

CREATE CONSTRAINT TRIGGER proofstack_comparison_registry_body_complete
  AFTER INSERT ON public.proofstack_comparison_record_registry
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.proofstack_verify_comparison_record_body();

CREATE TRIGGER proofstack_comparison_registry_append_only
  BEFORE UPDATE OR DELETE ON public.proofstack_comparison_record_registry
  FOR EACH ROW EXECUTE FUNCTION public.proofstack_reject_append_only_mutation();
CREATE TRIGGER proofstack_comparison_resource_bindings_append_only
  BEFORE UPDATE OR DELETE ON public.proofstack_comparison_resource_bindings
  FOR EACH ROW EXECUTE FUNCTION public.proofstack_reject_append_only_mutation();
CREATE TRIGGER proofstack_comparison_lineage_append_only
  BEFORE UPDATE OR DELETE ON public.proofstack_comparison_lineage
  FOR EACH ROW EXECUTE FUNCTION public.proofstack_reject_append_only_mutation();
CREATE TRIGGER proofstack_comparison_records_append_only
  BEFORE UPDATE OR DELETE ON public.proofstack_comparison_records
  FOR EACH ROW EXECUTE FUNCTION public.proofstack_reject_append_only_mutation();

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'proofstack_comparison_record_registry',
    'proofstack_comparison_resource_bindings',
    'proofstack_comparison_lineage',
    'proofstack_comparison_records',
    'proofstack_comparison_definitions',
    'proofstack_comparison_evidence_snapshots',
    'proofstack_comparison_results'
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

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'proofstack_comparison_definitions',
    'proofstack_comparison_evidence_snapshots',
    'proofstack_comparison_results'
  ]
  LOOP
    EXECUTE format(
      'CREATE CONSTRAINT TRIGGER %I AFTER INSERT ON public.%I '
      'DEFERRABLE INITIALLY DEFERRED FOR EACH ROW '
      'EXECUTE FUNCTION public.proofstack_verify_comparison_lineage_count()',
      table_name || '_lineage_complete', table_name
    );
  END LOOP;
END;
$$;
