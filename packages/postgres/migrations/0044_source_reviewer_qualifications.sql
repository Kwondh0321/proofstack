ALTER TABLE public.proofstack_evaluation_record_registry
  DROP CONSTRAINT proofstack_evaluation_record_registry_kind;
ALTER TABLE public.proofstack_evaluation_record_registry
  ADD CONSTRAINT proofstack_evaluation_record_registry_kind CHECK (
    record_kind IN (
      'aggregation_policy', 'assessment', 'criterion_set', 'criterion_set_status',
      'discovery_record', 'evaluation_aggregate', 'evaluation_run',
      'evaluation_run_rejection', 'evaluation_run_result', 'evaluator_spec', 'oracle_spec',
      'qualification_fixture_set', 'qualification_report', 'raw_observation', 'source_review',
      'source_reviewer_qualification', 'source_snapshot', 'blinded_evaluation_plan',
      'blinded_evaluation_result', 'calibration_report', 'human_review_protocol',
      'human_review_record', 'human_reviewer_independence', 'independence_declaration',
      'independent_critique', 'model_assisted_evaluator', 'model_assurance_assessment',
      'model_evaluator_profile', 'model_qualification_report', 'model_qualification_suite'
    )
  );

CREATE TABLE public.proofstack_evaluation_source_reviewer_qualifications
  PARTITION OF public.proofstack_evaluation_records
  FOR VALUES IN ('source_reviewer_qualification');

ALTER TABLE public.proofstack_evaluation_source_reviewer_qualifications
  ADD CONSTRAINT proofstack_evaluation_source_reviewer_qualifications_projection CHECK (
    record_id = record ->> 'qualificationId'
    AND resource_kind IS NULL
    AND recorded_at_lexical = record ->> 'recordedAt'
    AND actor_principal_id = record ->> 'verifiedByPrincipalId'
    AND lifecycle_state = record ->> 'status'
    AND verdict IS NULL AND run_id IS NULL
  );

-- Qualification references are immutable authority edges. A source review may cite one exact
-- qualification, and a replacement qualification may cite one exact predecessor.
CREATE OR REPLACE FUNCTION public.proofstack_evaluation_record_references(
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
      SELECT object_child.value
      FROM jsonb_each(
        CASE WHEN jsonb_typeof(nodes.value) = 'object' THEN nodes.value ELSE '{}'::jsonb END
      ) AS object_child(key, value)
      UNION ALL
      SELECT array_child.value
      FROM jsonb_array_elements(
        CASE WHEN jsonb_typeof(nodes.value) = 'array' THEN nodes.value ELSE '[]'::jsonb END
      ) AS array_child(value)
    ) AS child
    WHERE nodes.depth < 64
  ), candidates AS (
    SELECT
      reference.record_kind,
      reference.record_id,
      CASE
        WHEN nodes.depth = 0 THEN NULL
        WHEN reference.record_id = COALESCE(
          nodes.value ->> 'assessmentId',
          nodes.value ->> 'aggregateId',
          nodes.value ->> 'resultId',
          nodes.value ->> 'observationId',
          nodes.value ->> 'qualificationReportId',
          nodes.value ->> 'statusRecordId',
          nodes.value ->> 'sourceReviewId',
          nodes.value ->> 'qualificationId',
          nodes.value ->> 'sourceSnapshotId',
          nodes.value ->> 'discoveryId',
          nodes.value ->> 'evaluatorVersionId',
          nodes.value ->> 'oracleVersionId',
          nodes.value ->> 'fixtureSetVersionId',
          nodes.value ->> 'criterionSetVersionId',
          nodes.value ->> 'policyVersionId',
          nodes.value ->> 'evaluationRunId'
        ) THEN nodes.value ->> 'definitionSha256'
        ELSE NULL
      END AS digest
    FROM nodes
    CROSS JOIN LATERAL (
      VALUES
        ('aggregation_policy', nodes.value ->> 'policyVersionId'),
        ('assessment', nodes.value ->> 'assessmentId'),
        ('criterion_set', nodes.value ->> 'criterionSetVersionId'),
        ('criterion_set_status', nodes.value ->> 'statusRecordId'),
        ('discovery_record', nodes.value ->> 'discoveryId'),
        ('evaluation_aggregate', nodes.value ->> 'aggregateId'),
        ('evaluation_run', nodes.value ->> 'evaluationRunId'),
        ('evaluation_run_rejection', nodes.value ->> 'rejectionId'),
        ('evaluation_run_result', nodes.value ->> 'resultId'),
        ('evaluator_spec', nodes.value ->> 'evaluatorVersionId'),
        ('oracle_spec', nodes.value ->> 'oracleVersionId'),
        ('qualification_fixture_set', nodes.value ->> 'fixtureSetVersionId'),
        ('qualification_report', nodes.value ->> 'qualificationReportId'),
        ('raw_observation', nodes.value ->> 'observationId'),
        ('source_review', nodes.value ->> 'sourceReviewId'),
        ('source_reviewer_qualification', nodes.value ->> 'qualificationId'),
        ('source_snapshot', nodes.value ->> 'sourceSnapshotId')
    ) AS reference(record_kind, record_id)
    WHERE jsonb_typeof(nodes.value) = 'object'
      AND reference.record_id IS NOT NULL
      AND (reference.record_kind, reference.record_id) IS DISTINCT FROM
        (root_record_kind, root_record_id)
      AND CASE root_record_kind
        WHEN 'assessment' THEN reference.record_kind IN (
          'aggregation_policy', 'criterion_set', 'criterion_set_status',
          'evaluation_aggregate', 'evaluation_run', 'qualification_report',
          'raw_observation', 'source_review', 'source_snapshot'
        )
        WHEN 'criterion_set' THEN reference.record_kind IN (
          'criterion_set', 'source_review', 'source_snapshot'
        )
        WHEN 'criterion_set_status' THEN reference.record_kind IN (
          'criterion_set', 'criterion_set_status'
        )
        WHEN 'evaluation_aggregate' THEN reference.record_kind IN (
          'aggregation_policy', 'criterion_set', 'evaluation_run', 'evaluation_run_result'
        )
        WHEN 'evaluation_run' THEN reference.record_kind IN (
          'aggregation_policy', 'criterion_set', 'criterion_set_status', 'evaluator_spec',
          'oracle_spec', 'qualification_report', 'source_review'
        )
        WHEN 'evaluation_run_rejection' THEN reference.record_kind IN (
          'criterion_set', 'criterion_set_status', 'source_review'
        )
        WHEN 'evaluation_run_result' THEN reference.record_kind IN (
          'evaluation_run', 'raw_observation'
        )
        WHEN 'evaluator_spec' THEN reference.record_kind IN (
          'criterion_set', 'evaluator_spec', 'oracle_spec', 'qualification_fixture_set'
        )
        WHEN 'oracle_spec' THEN reference.record_kind IN (
          'criterion_set', 'oracle_spec', 'qualification_fixture_set'
        )
        WHEN 'qualification_fixture_set' THEN
          reference.record_kind = 'qualification_fixture_set'
        WHEN 'qualification_report' THEN reference.record_kind IN (
          'evaluator_spec', 'oracle_spec', 'qualification_fixture_set'
        )
        WHEN 'raw_observation' THEN reference.record_kind = 'evaluation_run'
        WHEN 'source_review' THEN reference.record_kind IN (
          'source_review', 'source_reviewer_qualification', 'source_snapshot'
        )
        WHEN 'source_reviewer_qualification' THEN
          reference.record_kind = 'source_reviewer_qualification'
        WHEN 'source_snapshot' THEN reference.record_kind IN (
          'discovery_record', 'source_snapshot'
        )
        ELSE false
      END
  )
  SELECT DISTINCT candidate.record_kind, candidate.record_id, candidate.digest
  FROM candidates AS candidate
  WHERE candidate.digest IS NOT NULL
    OR (
      root_record_kind = 'evaluation_run_result'
      AND candidate.record_kind = 'evaluation_run'
      AND candidate.record_id = record ->> 'evaluationRunId'
    )
  ORDER BY candidate.record_kind, candidate.record_id, candidate.digest NULLS FIRST
$$;

CREATE OR REPLACE FUNCTION public.proofstack_insert_evaluation_record(command jsonb)
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
  v_resource_kind text;
  v_resource_id text;
  v_binding_kind text;
  v_binding_key text;
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
      MESSAGE = 'Evaluation persistence command is malformed or outside the active tenant';
  END IF;

  v_resource_kind := CASE kind
    WHEN 'aggregation_policy' THEN 'aggregation_policy'
    WHEN 'criterion_set' THEN 'criterion_set'
    WHEN 'evaluator_spec' THEN 'evaluator'
    WHEN 'oracle_spec' THEN 'oracle'
    WHEN 'qualification_fixture_set' THEN 'qualification_fixture_set'
    ELSE NULL
  END;
  v_resource_id := CASE kind
    WHEN 'aggregation_policy' THEN body ->> 'policyId'
    WHEN 'criterion_set' THEN body ->> 'criterionSetId'
    WHEN 'evaluator_spec' THEN body ->> 'evaluatorId'
    WHEN 'oracle_spec' THEN body ->> 'oracleId'
    WHEN 'qualification_fixture_set' THEN body ->> 'fixtureSetId'
    ELSE NULL
  END;
  v_binding_kind := CASE kind
    WHEN 'evaluation_run_result' THEN 'evaluation_run_result'
    WHEN 'raw_observation' THEN 'raw_observation_attempt'
    ELSE NULL
  END;
  v_binding_key := CASE kind
    WHEN 'evaluation_run_result' THEN
      'evaluation_run_result:run:' || (body ->> 'evaluationRunId')
    WHEN 'raw_observation' THEN
      'raw_observation:attempt:' || (body #>> '{run,evaluationRunId}') || ':' ||
        (body ->> 'attemptId')
    ELSE NULL
  END;
  v_event_type := CASE
    WHEN kind IN (
      'aggregation_policy', 'criterion_set', 'evaluator_spec', 'oracle_spec',
      'qualification_fixture_set'
    ) THEN 'evaluation.definition.published'
    WHEN kind IN (
      'discovery_record', 'source_review', 'source_reviewer_qualification', 'source_snapshot'
    ) THEN 'evaluation.source.recorded'
    WHEN kind = 'criterion_set_status' THEN 'evaluation.criterion.status_recorded'
    WHEN kind IN ('evaluation_run', 'evaluation_run_rejection') THEN 'evaluation.run.recorded'
    WHEN kind IN ('evaluation_run_result', 'qualification_report', 'raw_observation')
      THEN 'evaluation.result.recorded'
    ELSE 'evaluation.assessment.recorded'
  END;

  INSERT INTO public.proofstack_evaluation_record_registry (
    tenant_id, project_id, environment_id, record_kind, record_id,
    schema_version, definition_sha256
  ) VALUES (
    tenant, project, environment, kind, id,
    command ->> 'schemaVersion', digest
  );

  IF v_resource_kind IS NOT NULL THEN
    INSERT INTO public.proofstack_evaluation_resource_bindings (
      tenant_id, project_id, environment_id, resource_kind, resource_id,
      root_record_kind, root_record_id, root_definition_sha256
    ) VALUES (
      tenant, project, environment, v_resource_kind, v_resource_id,
      kind, id, digest
    ) ON CONFLICT (tenant_id, resource_kind, resource_id) DO NOTHING;

    IF NOT EXISTS (
      SELECT 1
      FROM public.proofstack_evaluation_resource_bindings AS binding
      WHERE binding.tenant_id = tenant
        AND binding.project_id = project
        AND binding.environment_id = environment
        AND binding.resource_kind = v_resource_kind
        AND binding.resource_id = v_resource_id
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23505',
        MESSAGE = 'Evaluation resource is already bound to another scope';
    END IF;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.proofstack_evaluation_record_references(kind, id, body) AS reference
    LEFT JOIN public.proofstack_evaluation_record_registry AS parent
      ON parent.tenant_id = tenant
      AND parent.project_id = project
      AND parent.environment_id = environment
      AND parent.record_kind = reference.parent_record_kind
      AND parent.record_id = reference.parent_record_id
      AND (
        reference.parent_definition_sha256 IS NULL
        OR parent.definition_sha256 = reference.parent_definition_sha256
      )
    WHERE parent.record_id IS NULL
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23503',
      MESSAGE = 'Evaluation record contains unavailable or conflicting lineage';
  END IF;

  IF kind = 'source_review'
    AND body ? 'reviewerQualification'
    AND NOT EXISTS (
      SELECT 1
      FROM public.proofstack_evaluation_records AS qualification
      WHERE qualification.tenant_id = tenant
        AND qualification.project_id = project
        AND qualification.environment_id = environment
        AND qualification.record_kind = 'source_reviewer_qualification'
        AND qualification.record_id = body #>> '{reviewerQualification,qualificationId}'
        AND qualification.definition_sha256 =
          body #>> '{reviewerQualification,definitionSha256}'
        AND qualification.record ->> 'reviewerPrincipalId' = body ->> 'reviewedByPrincipalId'
    )
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23503',
      MESSAGE = 'Source review qualification does not belong to the authenticated reviewer';
  END IF;

  INSERT INTO public.proofstack_evaluation_lineage (
    tenant_id, project_id, environment_id,
    child_record_kind, child_record_id, child_definition_sha256, edge_position,
    parent_record_kind, parent_record_id, parent_definition_sha256
  )
  SELECT
    tenant, project, environment,
    kind, id, digest,
    (row_number() OVER (
      ORDER BY reference.parent_record_kind, reference.parent_record_id,
        parent.definition_sha256
    ) - 1)::smallint,
    reference.parent_record_kind, reference.parent_record_id, parent.definition_sha256
  FROM public.proofstack_evaluation_record_references(kind, id, body) AS reference
  JOIN public.proofstack_evaluation_record_registry AS parent
    ON parent.tenant_id = tenant
    AND parent.project_id = project
    AND parent.environment_id = environment
    AND parent.record_kind = reference.parent_record_kind
    AND parent.record_id = reference.parent_record_id
    AND (
      reference.parent_definition_sha256 IS NULL
      OR parent.definition_sha256 = reference.parent_definition_sha256
    );
  GET DIAGNOSTICS reference_count = ROW_COUNT;

  IF v_binding_kind IS NOT NULL THEN
    INSERT INTO public.proofstack_evaluation_unique_bindings (
      tenant_id, project_id, environment_id, binding_kind, binding_key,
      record_kind, record_id, definition_sha256
    ) VALUES (
      tenant, project, environment,
      v_binding_kind, v_binding_key, kind, id, digest
    );
  END IF;

  INSERT INTO public.proofstack_evaluation_records (
    tenant_id, project_id, environment_id, record_kind, record_id,
    schema_version, definition_sha256, recorded_at, recorded_at_lexical,
    actor_principal_id, resource_kind, resource_id, lifecycle_state, verdict,
    run_id, attempt_id, attempt_sequence, lineage_count, record
  ) VALUES (
    tenant, project, environment, kind, id,
    command ->> 'schemaVersion', digest,
    (command ->> 'recordedAt')::timestamptz, command ->> 'recordedAt',
    command ->> 'actorPrincipalId', v_resource_kind, v_resource_id,
    command ->> 'lifecycleState', command ->> 'verdict', command ->> 'runId',
    command ->> 'attemptId', (command ->> 'attemptSequence')::smallint,
    reference_count::smallint, body
  );

  INSERT INTO public.proofstack_outbox (
    tenant_id, event_type, aggregate_type, aggregate_id, schema_version, payload, created_at
  ) VALUES (
    tenant,
    v_event_type,
    'evaluation_' || kind,
    id,
    command ->> 'schemaVersion',
    jsonb_build_object('recordKind', kind, 'record', body),
    (command ->> 'recordedAt')::timestamptz
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.proofstack_publish_evaluation_control_record(command jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF command ->> 'recordKind' NOT IN (
    'aggregation_policy', 'assessment', 'criterion_set', 'criterion_set_status',
    'discovery_record', 'evaluation_run', 'evaluation_run_rejection',
    'evaluator_spec', 'oracle_spec', 'qualification_fixture_set',
    'source_review', 'source_reviewer_qualification', 'source_snapshot'
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'The API authority cannot persist this evaluation record kind';
  END IF;
  PERFORM public.proofstack_insert_evaluation_record(command);
END;
$$;

CREATE CONSTRAINT TRIGGER proofstack_source_reviewer_qualifications_lineage_complete
  AFTER INSERT ON public.proofstack_evaluation_source_reviewer_qualifications
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION public.proofstack_verify_evaluation_lineage_count();

ALTER TABLE public.proofstack_evaluation_source_reviewer_qualifications
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.proofstack_evaluation_source_reviewer_qualifications
  FORCE ROW LEVEL SECURITY;

CREATE POLICY proofstack_source_reviewer_qualifications_tenant_select
  ON public.proofstack_evaluation_source_reviewer_qualifications FOR SELECT
  USING (tenant_id = NULLIF(current_setting('proofstack.tenant_id', true), ''));
CREATE POLICY proofstack_source_reviewer_qualifications_tenant_insert
  ON public.proofstack_evaluation_source_reviewer_qualifications FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('proofstack.tenant_id', true), ''));

REVOKE ALL ON TABLE public.proofstack_evaluation_source_reviewer_qualifications FROM PUBLIC;
REVOKE ALL ON FUNCTION public.proofstack_evaluation_record_references(text, text, jsonb)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.proofstack_insert_evaluation_record(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.proofstack_publish_evaluation_control_record(jsonb) FROM PUBLIC;
