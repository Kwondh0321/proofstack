ALTER TABLE public.proofstack_evaluation_record_registry
  DROP CONSTRAINT proofstack_evaluation_record_registry_kind;
ALTER TABLE public.proofstack_evaluation_record_registry
  ADD CONSTRAINT proofstack_evaluation_record_registry_kind CHECK (
    record_kind IN (
      'aggregation_policy', 'assessment', 'criterion_set', 'criterion_set_status',
      'discovery_record', 'evaluation_aggregate', 'evaluation_run',
      'evaluation_run_rejection', 'evaluation_run_result', 'evaluator_spec', 'oracle_spec',
      'qualification_fixture_set', 'qualification_report', 'raw_observation', 'source_review',
      'source_snapshot', 'blinded_evaluation_plan', 'blinded_evaluation_result',
      'calibration_report', 'human_review_protocol', 'human_review_record',
      'human_reviewer_independence', 'independence_declaration', 'independent_critique',
      'model_assisted_evaluator', 'model_assurance_assessment', 'model_evaluator_profile',
      'model_qualification_report', 'model_qualification_suite'
    )
  );

CREATE TABLE public.proofstack_model_assurance_records (
  tenant_id varchar(64) NOT NULL,
  project_id varchar(64) NOT NULL,
  environment_id varchar(64) NOT NULL,
  record_kind varchar(48) NOT NULL,
  record_id varchar(64) NOT NULL,
  schema_version varchar(16) NOT NULL,
  definition_sha256 character(64) NOT NULL,
  recorded_at timestamptz NOT NULL,
  recorded_at_lexical text NOT NULL,
  actor_principal_id varchar(64),
  lifecycle_state varchar(48),
  lineage_count smallint NOT NULL,
  record jsonb NOT NULL,

  CONSTRAINT proofstack_model_assurance_records_pk PRIMARY KEY (
    tenant_id, record_kind, record_id
  ),
  CONSTRAINT proofstack_model_assurance_records_registry_fk FOREIGN KEY (
    tenant_id, project_id, environment_id, record_kind, record_id, definition_sha256
  ) REFERENCES public.proofstack_evaluation_record_registry (
    tenant_id, project_id, environment_id, record_kind, record_id, definition_sha256
  ) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT proofstack_model_assurance_records_common_projection CHECK (
    jsonb_typeof(record) = 'object'
    AND record ->> 'schemaVersion' = schema_version
    AND record ->> 'definitionSha256' = definition_sha256
    AND record #>> '{scope,tenantId}' = tenant_id
    AND record #>> '{scope,projectId}' = project_id
    AND record #>> '{scope,environmentId}' = environment_id
  ),
  CONSTRAINT proofstack_model_assurance_records_recorded_at CHECK (
    isfinite(recorded_at)
    AND recorded_at_lexical ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
    AND recorded_at = recorded_at_lexical::timestamptz
  ),
  CONSTRAINT proofstack_model_assurance_records_actor CHECK (
    actor_principal_id IS NULL OR actor_principal_id ~ '^[a-z][a-z0-9_]{2,63}$'
  ),
  CONSTRAINT proofstack_model_assurance_records_lineage_count CHECK (
    lineage_count BETWEEN 0 AND 4096
  )
) PARTITION BY LIST (record_kind);

CREATE TABLE public.proofstack_model_assurance_blinded_plans
  PARTITION OF public.proofstack_model_assurance_records
  FOR VALUES IN ('blinded_evaluation_plan');
CREATE TABLE public.proofstack_model_assurance_blinded_results
  PARTITION OF public.proofstack_model_assurance_records
  FOR VALUES IN ('blinded_evaluation_result');
CREATE TABLE public.proofstack_model_assurance_calibration_reports
  PARTITION OF public.proofstack_model_assurance_records FOR VALUES IN ('calibration_report');
CREATE TABLE public.proofstack_model_assurance_human_review_protocols
  PARTITION OF public.proofstack_model_assurance_records FOR VALUES IN ('human_review_protocol');
CREATE TABLE public.proofstack_model_assurance_human_review_records
  PARTITION OF public.proofstack_model_assurance_records FOR VALUES IN ('human_review_record');
CREATE TABLE public.proofstack_model_assurance_human_reviewer_independence
  PARTITION OF public.proofstack_model_assurance_records
  FOR VALUES IN ('human_reviewer_independence');
CREATE TABLE public.proofstack_model_assurance_independence_declarations
  PARTITION OF public.proofstack_model_assurance_records
  FOR VALUES IN ('independence_declaration');
CREATE TABLE public.proofstack_model_assurance_independent_critiques
  PARTITION OF public.proofstack_model_assurance_records FOR VALUES IN ('independent_critique');
CREATE TABLE public.proofstack_model_assurance_model_evaluators
  PARTITION OF public.proofstack_model_assurance_records
  FOR VALUES IN ('model_assisted_evaluator');
CREATE TABLE public.proofstack_model_assurance_assessments
  PARTITION OF public.proofstack_model_assurance_records
  FOR VALUES IN ('model_assurance_assessment');
CREATE TABLE public.proofstack_model_assurance_model_profiles
  PARTITION OF public.proofstack_model_assurance_records
  FOR VALUES IN ('model_evaluator_profile');
CREATE TABLE public.proofstack_model_assurance_qualification_reports
  PARTITION OF public.proofstack_model_assurance_records
  FOR VALUES IN ('model_qualification_report');
CREATE TABLE public.proofstack_model_assurance_qualification_suites
  PARTITION OF public.proofstack_model_assurance_records
  FOR VALUES IN ('model_qualification_suite');

ALTER TABLE public.proofstack_model_assurance_blinded_plans
  ADD CONSTRAINT proofstack_model_assurance_blinded_plans_projection CHECK (
    record_id = record ->> 'blindedPlanVersionId'
    AND recorded_at_lexical = record ->> 'publishedAt'
    AND actor_principal_id = record ->> 'publishedByPrincipalId'
    AND lifecycle_state IS NULL
  );
ALTER TABLE public.proofstack_model_assurance_blinded_results
  ADD CONSTRAINT proofstack_model_assurance_blinded_results_projection CHECK (
    record_id = record ->> 'resultId'
    AND recorded_at_lexical = record ->> 'recordedAt'
    AND actor_principal_id = record ->> 'recordedByPrincipalId'
    AND lifecycle_state = record ->> 'status'
  );
ALTER TABLE public.proofstack_model_assurance_calibration_reports
  ADD CONSTRAINT proofstack_model_assurance_calibration_reports_projection CHECK (
    record_id = record ->> 'calibrationReportId'
    AND recorded_at_lexical = record ->> 'recordedAt'
    AND actor_principal_id = record ->> 'executedByPrincipalId'
    AND lifecycle_state = record ->> 'status'
  );
ALTER TABLE public.proofstack_model_assurance_human_review_protocols
  ADD CONSTRAINT proofstack_model_assurance_human_review_protocols_projection CHECK (
    record_id = record ->> 'protocolVersionId'
    AND recorded_at_lexical = record ->> 'publishedAt'
    AND actor_principal_id = record ->> 'publishedByPrincipalId'
    AND lifecycle_state IS NULL
  );
ALTER TABLE public.proofstack_model_assurance_human_review_records
  ADD CONSTRAINT proofstack_model_assurance_human_review_records_projection CHECK (
    record_id = record ->> 'reviewId'
    AND recorded_at_lexical = record ->> 'recordedAt'
    AND actor_principal_id = record #>> '{reviewer,principalId}'
    AND lifecycle_state = record ->> 'action'
  );
ALTER TABLE public.proofstack_model_assurance_human_reviewer_independence
  ADD CONSTRAINT proofstack_model_assurance_human_reviewer_independence_projection CHECK (
    record_id = record ->> 'declarationId'
    AND recorded_at_lexical = record ->> 'recordedAt'
    AND actor_principal_id = record ->> 'reviewedByPrincipalId'
    AND lifecycle_state = record ->> 'status'
  );
ALTER TABLE public.proofstack_model_assurance_independence_declarations
  ADD CONSTRAINT proofstack_model_assurance_independence_declarations_projection CHECK (
    record_id = record ->> 'independenceDeclarationId'
    AND recorded_at_lexical = record ->> 'recordedAt'
    AND actor_principal_id = record ->> 'reviewedByPrincipalId'
    AND lifecycle_state = record ->> 'reviewStatus'
  );
ALTER TABLE public.proofstack_model_assurance_independent_critiques
  ADD CONSTRAINT proofstack_model_assurance_independent_critiques_projection CHECK (
    record_id = record ->> 'critiqueId'
    AND recorded_at_lexical = record ->> 'recordedAt'
    AND actor_principal_id = record ->> 'recordedByPrincipalId'
    AND lifecycle_state = record #>> '{outcome,status}'
  );
ALTER TABLE public.proofstack_model_assurance_model_evaluators
  ADD CONSTRAINT proofstack_model_assurance_model_evaluators_projection CHECK (
    record_id = record ->> 'evaluatorVersionId'
    AND recorded_at_lexical = record ->> 'publishedAt'
    AND actor_principal_id = record ->> 'publishedByPrincipalId'
    AND lifecycle_state IS NULL
  );
ALTER TABLE public.proofstack_model_assurance_assessments
  ADD CONSTRAINT proofstack_model_assurance_assessments_projection CHECK (
    record_id = record ->> 'assessmentExtensionId'
    AND recorded_at_lexical = record ->> 'recordedAt'
    AND actor_principal_id IS NULL
    AND lifecycle_state = record ->> 'eligibility'
  );
ALTER TABLE public.proofstack_model_assurance_model_profiles
  ADD CONSTRAINT proofstack_model_assurance_model_profiles_projection CHECK (
    record_id = record ->> 'modelProfileVersionId'
    AND recorded_at_lexical = record ->> 'publishedAt'
    AND actor_principal_id = record ->> 'publishedByPrincipalId'
    AND lifecycle_state IS NULL
  );
ALTER TABLE public.proofstack_model_assurance_qualification_reports
  ADD CONSTRAINT proofstack_model_assurance_qualification_reports_projection CHECK (
    record_id = record ->> 'reportId'
    AND recorded_at_lexical = record ->> 'recordedAt'
    AND actor_principal_id = record ->> 'executedByPrincipalId'
    AND lifecycle_state = record ->> 'status'
  );
ALTER TABLE public.proofstack_model_assurance_qualification_suites
  ADD CONSTRAINT proofstack_model_assurance_qualification_suites_projection CHECK (
    record_id = record ->> 'suiteVersionId'
    AND recorded_at_lexical = record ->> 'publishedAt'
    AND actor_principal_id = record ->> 'publishedByPrincipalId'
    AND lifecycle_state IS NULL
  );

CREATE FUNCTION public.proofstack_model_assurance_record_references(
  root_record_kind text,
  root_record_id text,
  record jsonb
)
RETURNS TABLE (
  parent_record_kind text,
  parent_record_id text,
  parent_definition_sha256 text
)
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $$
  WITH RECURSIVE nodes(value, depth) AS (
    SELECT record, 0
    UNION ALL
    SELECT child.value, nodes.depth + 1
    FROM nodes
    CROSS JOIN LATERAL (
      SELECT value FROM jsonb_each(
        CASE WHEN jsonb_typeof(nodes.value) = 'object' THEN nodes.value ELSE '{}'::jsonb END
      )
      UNION ALL
      SELECT value FROM jsonb_array_elements(
        CASE WHEN jsonb_typeof(nodes.value) = 'array' THEN nodes.value ELSE '[]'::jsonb END
      )
    ) AS child
    WHERE nodes.depth < 64
  ), candidates AS (
    SELECT reference.record_kind, reference.record_id, nodes.value ->> 'definitionSha256' AS digest
    FROM nodes
    CROSS JOIN LATERAL (
      VALUES
        ('assessment', nodes.value ->> 'assessmentId'),
        ('criterion_set', nodes.value ->> 'criterionSetVersionId'),
        ('oracle_spec', nodes.value ->> 'oracleVersionId'),
        ('qualification_report', nodes.value ->> 'qualificationReportId'),
        ('raw_observation', nodes.value ->> 'observationId'),
        ('blinded_evaluation_plan', nodes.value ->> 'blindedPlanVersionId'),
        ('blinded_evaluation_result', nodes.value ->> 'resultId'),
        ('calibration_report', nodes.value ->> 'calibrationReportId'),
        ('human_review_protocol', nodes.value ->> 'protocolVersionId'),
        ('human_review_record', nodes.value ->> 'reviewId'),
        ('human_reviewer_independence', nodes.value ->> 'declarationId'),
        ('independence_declaration', nodes.value ->> 'independenceDeclarationId'),
        ('independent_critique', nodes.value ->> 'critiqueId'),
        ('model_assisted_evaluator', nodes.value ->> 'evaluatorVersionId'),
        ('model_assurance_assessment', nodes.value ->> 'assessmentExtensionId'),
        ('model_evaluator_profile', nodes.value ->> 'modelProfileVersionId'),
        ('model_qualification_report', nodes.value ->> 'reportId'),
        ('model_qualification_suite', nodes.value ->> 'suiteVersionId')
    ) AS reference(record_kind, record_id)
    WHERE jsonb_typeof(nodes.value) = 'object'
      AND nodes.depth > 0
      AND reference.record_id IS NOT NULL
      AND nodes.value ? 'definitionSha256'
      AND (reference.record_kind, reference.record_id) IS DISTINCT FROM
        (root_record_kind, root_record_id)
      AND CASE root_record_kind
        WHEN 'blinded_evaluation_plan' THEN reference.record_kind IN (
          'model_assisted_evaluator', 'model_evaluator_profile', 'independence_declaration',
          'calibration_report', 'blinded_evaluation_plan', 'criterion_set'
        )
        WHEN 'blinded_evaluation_result' THEN
          reference.record_kind = 'blinded_evaluation_plan'
        WHEN 'calibration_report' THEN reference.record_kind IN (
          'model_assisted_evaluator', 'model_evaluator_profile', 'calibration_report',
          'qualification_report', 'criterion_set'
        )
        WHEN 'human_review_protocol' THEN reference.record_kind IN (
          'human_review_protocol', 'criterion_set'
        )
        WHEN 'human_review_record' THEN reference.record_kind IN (
          'human_review_protocol', 'human_reviewer_independence', 'independent_critique',
          'human_review_record', 'assessment', 'raw_observation'
        )
        WHEN 'human_reviewer_independence' THEN
          reference.record_kind = 'human_reviewer_independence'
        WHEN 'independence_declaration' THEN reference.record_kind IN (
          'model_assisted_evaluator', 'model_evaluator_profile', 'independence_declaration'
        )
        WHEN 'independent_critique' THEN reference.record_kind IN (
          'model_assisted_evaluator', 'model_evaluator_profile', 'independence_declaration',
          'calibration_report', 'qualification_report', 'raw_observation', 'criterion_set'
        )
        WHEN 'model_assisted_evaluator' THEN reference.record_kind IN (
          'model_evaluator_profile', 'model_assisted_evaluator'
        )
        WHEN 'model_assurance_assessment' THEN reference.record_kind IN (
          'blinded_evaluation_plan', 'blinded_evaluation_result', 'calibration_report',
          'model_qualification_report', 'human_review_protocol', 'independent_critique',
          'independence_declaration', 'human_review_record', 'assessment', 'raw_observation',
          'oracle_spec'
        )
        WHEN 'model_evaluator_profile' THEN
          reference.record_kind = 'model_evaluator_profile'
        WHEN 'model_qualification_report' THEN reference.record_kind IN (
          'model_qualification_suite', 'model_assisted_evaluator', 'model_evaluator_profile',
          'independence_declaration', 'calibration_report', 'model_qualification_report',
          'qualification_report'
        )
        WHEN 'model_qualification_suite' THEN reference.record_kind IN (
          'model_assisted_evaluator', 'model_evaluator_profile', 'blinded_evaluation_plan',
          'model_qualification_suite', 'criterion_set'
        )
        ELSE false
      END
  )
  SELECT DISTINCT record_kind, record_id, digest
  FROM candidates
  ORDER BY record_kind, record_id, digest
$$;

CREATE OR REPLACE FUNCTION public.proofstack_verify_evaluation_record_body()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.proofstack_evaluation_records AS body
    WHERE body.tenant_id = NEW.tenant_id AND body.project_id = NEW.project_id
      AND body.environment_id = NEW.environment_id AND body.record_kind = NEW.record_kind
      AND body.record_id = NEW.record_id AND body.definition_sha256 = NEW.definition_sha256
    UNION ALL
    SELECT 1 FROM public.proofstack_model_assurance_records AS body
    WHERE body.tenant_id = NEW.tenant_id AND body.project_id = NEW.project_id
      AND body.environment_id = NEW.environment_id AND body.record_kind = NEW.record_kind
      AND body.record_id = NEW.record_id AND body.definition_sha256 = NEW.definition_sha256
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Evaluation registry record requires one exact typed body';
  END IF;
  RETURN NULL;
END;
$$;

CREATE FUNCTION public.proofstack_insert_model_assurance_record(command jsonb)
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
  v_event_type text;
  reference_count integer;
BEGIN
  IF jsonb_typeof(command) IS DISTINCT FROM 'object'
    OR tenant IS NULL
    OR tenant IS DISTINCT FROM NULLIF(current_setting('proofstack.tenant_id', true), '')
    OR jsonb_typeof(body) IS DISTINCT FROM 'object'
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'Model-assurance persistence command is malformed or outside the active tenant';
  END IF;

  v_event_type := CASE
    WHEN kind = 'human_review_record' THEN 'model_assurance.human_review.recorded'
    WHEN kind = 'model_assurance_assessment' THEN 'model_assurance.assessment.recorded'
    WHEN kind IN (
      'blinded_evaluation_result', 'calibration_report', 'independent_critique',
      'model_qualification_report'
    ) THEN 'model_assurance.result.recorded'
    ELSE 'model_assurance.definition.published'
  END;

  INSERT INTO public.proofstack_evaluation_record_registry (
    tenant_id, project_id, environment_id, record_kind, record_id,
    schema_version, definition_sha256
  ) VALUES (
    tenant, project, environment, kind, id, command ->> 'schemaVersion', digest
  );

  IF EXISTS (
    SELECT 1
    FROM public.proofstack_model_assurance_record_references(kind, id, body) AS reference
    LEFT JOIN public.proofstack_evaluation_record_registry AS parent
      ON parent.tenant_id = tenant AND parent.project_id = project
      AND parent.environment_id = environment
      AND parent.record_kind = reference.parent_record_kind
      AND parent.record_id = reference.parent_record_id
      AND parent.definition_sha256 = reference.parent_definition_sha256
    WHERE parent.record_id IS NULL
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23503',
      MESSAGE = 'Model-assurance record contains unavailable or conflicting lineage';
  END IF;

  INSERT INTO public.proofstack_evaluation_lineage (
    tenant_id, project_id, environment_id, child_record_kind, child_record_id,
    child_definition_sha256, edge_position, parent_record_kind, parent_record_id,
    parent_definition_sha256
  )
  SELECT tenant, project, environment, kind, id, digest,
    (row_number() OVER (
      ORDER BY reference.parent_record_kind, reference.parent_record_id,
        reference.parent_definition_sha256
    ) - 1)::smallint,
    reference.parent_record_kind, reference.parent_record_id,
    reference.parent_definition_sha256
  FROM public.proofstack_model_assurance_record_references(kind, id, body) AS reference;
  GET DIAGNOSTICS reference_count = ROW_COUNT;

  INSERT INTO public.proofstack_model_assurance_records (
    tenant_id, project_id, environment_id, record_kind, record_id, schema_version,
    definition_sha256, recorded_at, recorded_at_lexical, actor_principal_id,
    lifecycle_state, lineage_count, record
  ) VALUES (
    tenant, project, environment, kind, id, command ->> 'schemaVersion', digest,
    (command ->> 'recordedAt')::timestamptz, command ->> 'recordedAt',
    command ->> 'actorPrincipalId', command ->> 'lifecycleState', reference_count::smallint, body
  );

  INSERT INTO public.proofstack_outbox (
    tenant_id, event_type, aggregate_type, aggregate_id, schema_version, payload, created_at
  ) VALUES (
    tenant, v_event_type, 'model_assurance_' || kind, id, command ->> 'schemaVersion',
    jsonb_build_object('recordKind', kind, 'record', body),
    (command ->> 'recordedAt')::timestamptz
  );
END;
$$;

CREATE FUNCTION public.proofstack_publish_model_assurance_control_record(command jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF command ->> 'recordKind' NOT IN (
    'blinded_evaluation_plan', 'calibration_report', 'human_review_protocol',
    'human_reviewer_independence', 'independence_declaration', 'model_assisted_evaluator',
    'model_assurance_assessment', 'model_evaluator_profile', 'model_qualification_suite'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'The control-plane authority cannot persist this model-assurance record kind';
  END IF;
  PERFORM public.proofstack_insert_model_assurance_record(command);
END;
$$;

CREATE FUNCTION public.proofstack_publish_model_assurance_execution_record(command jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF command ->> 'recordKind' NOT IN (
    'blinded_evaluation_result', 'independent_critique', 'model_qualification_report'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'The model-evaluation authority cannot persist this record kind';
  END IF;
  PERFORM public.proofstack_insert_model_assurance_record(command);
END;
$$;

CREATE FUNCTION public.proofstack_publish_model_assurance_human_review_record(command jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF command ->> 'recordKind' IS DISTINCT FROM 'human_review_record' THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'The human-review authority can persist only human review records';
  END IF;
  PERFORM public.proofstack_insert_model_assurance_record(command);
END;
$$;

REVOKE ALL ON FUNCTION public.proofstack_model_assurance_record_references(text, text, jsonb)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.proofstack_insert_model_assurance_record(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.proofstack_publish_model_assurance_control_record(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.proofstack_publish_model_assurance_execution_record(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.proofstack_publish_model_assurance_human_review_record(jsonb)
  FROM PUBLIC;

CREATE TRIGGER proofstack_model_assurance_records_append_only
  BEFORE UPDATE OR DELETE ON public.proofstack_model_assurance_records
  FOR EACH ROW EXECUTE FUNCTION public.proofstack_reject_append_only_mutation();

ALTER TABLE public.proofstack_model_assurance_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.proofstack_model_assurance_records FORCE ROW LEVEL SECURITY;
CREATE POLICY proofstack_model_assurance_records_tenant_select
  ON public.proofstack_model_assurance_records FOR SELECT
  USING (tenant_id = NULLIF(current_setting('proofstack.tenant_id', true), ''));
CREATE POLICY proofstack_model_assurance_records_tenant_insert
  ON public.proofstack_model_assurance_records FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('proofstack.tenant_id', true), ''));

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'proofstack_model_assurance_blinded_plans',
    'proofstack_model_assurance_blinded_results',
    'proofstack_model_assurance_calibration_reports',
    'proofstack_model_assurance_human_review_protocols',
    'proofstack_model_assurance_human_review_records',
    'proofstack_model_assurance_human_reviewer_independence',
    'proofstack_model_assurance_independence_declarations',
    'proofstack_model_assurance_independent_critiques',
    'proofstack_model_assurance_model_evaluators',
    'proofstack_model_assurance_assessments',
    'proofstack_model_assurance_model_profiles',
    'proofstack_model_assurance_qualification_reports',
    'proofstack_model_assurance_qualification_suites'
  ]
  LOOP
    EXECUTE format(
      'CREATE CONSTRAINT TRIGGER %I AFTER INSERT ON public.%I '
      'DEFERRABLE INITIALLY DEFERRED FOR EACH ROW '
      'EXECUTE FUNCTION public.proofstack_verify_evaluation_lineage_count()',
      table_name || '_lineage_complete', table_name
    );
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

REVOKE ALL ON TABLE public.proofstack_model_assurance_records FROM PUBLIC;
