CREATE TABLE public.proofstack_evaluation_record_registry (
  tenant_id varchar(64) NOT NULL,
  project_id varchar(64) NOT NULL,
  environment_id varchar(64) NOT NULL,
  record_kind varchar(48) NOT NULL,
  record_id varchar(64) NOT NULL,
  schema_version varchar(16) NOT NULL,
  definition_sha256 character(64) NOT NULL,

  CONSTRAINT proofstack_evaluation_record_registry_pk PRIMARY KEY (
    tenant_id,
    record_kind,
    record_id
  ),
  CONSTRAINT proofstack_evaluation_record_registry_scope_digest_unique UNIQUE (
    tenant_id,
    project_id,
    environment_id,
    record_kind,
    record_id,
    definition_sha256
  ),
  CONSTRAINT proofstack_evaluation_record_registry_tenant_format CHECK (
    tenant_id ~ '^[a-z][a-z0-9_]{2,63}$'
  ),
  CONSTRAINT proofstack_evaluation_record_registry_project_format CHECK (
    project_id ~ '^[a-z][a-z0-9_]{2,63}$'
  ),
  CONSTRAINT proofstack_evaluation_record_registry_environment_format CHECK (
    environment_id ~ '^[a-z][a-z0-9_]{2,63}$'
  ),
  CONSTRAINT proofstack_evaluation_record_registry_kind CHECK (
    record_kind IN (
      'aggregation_policy',
      'assessment',
      'criterion_set',
      'criterion_set_status',
      'discovery_record',
      'evaluation_aggregate',
      'evaluation_run',
      'evaluation_run_rejection',
      'evaluation_run_result',
      'evaluator_spec',
      'oracle_spec',
      'qualification_fixture_set',
      'qualification_report',
      'raw_observation',
      'source_review',
      'source_snapshot'
    )
  ),
  CONSTRAINT proofstack_evaluation_record_registry_id_format CHECK (
    record_id ~ '^[a-z][a-z0-9_]{2,63}$'
  ),
  CONSTRAINT proofstack_evaluation_record_registry_schema_version CHECK (
    schema_version = '0.1'
  ),
  CONSTRAINT proofstack_evaluation_record_registry_digest CHECK (
    definition_sha256 ~ '^[0-9a-f]{64}$'
  )
);

CREATE TABLE public.proofstack_evaluation_resource_bindings (
  tenant_id varchar(64) NOT NULL,
  project_id varchar(64) NOT NULL,
  environment_id varchar(64) NOT NULL,
  resource_kind varchar(48) NOT NULL,
  resource_id varchar(64) NOT NULL,
  root_record_kind varchar(48) NOT NULL,
  root_record_id varchar(64) NOT NULL,
  root_definition_sha256 character(64) NOT NULL,

  CONSTRAINT proofstack_evaluation_resource_bindings_pk PRIMARY KEY (
    tenant_id,
    resource_kind,
    resource_id
  ),
  CONSTRAINT proofstack_evaluation_resource_bindings_scope_unique UNIQUE (
    tenant_id,
    project_id,
    environment_id,
    resource_kind,
    resource_id
  ),
  CONSTRAINT proofstack_evaluation_resource_bindings_root_fk FOREIGN KEY (
    tenant_id,
    project_id,
    environment_id,
    root_record_kind,
    root_record_id,
    root_definition_sha256
  ) REFERENCES public.proofstack_evaluation_record_registry (
    tenant_id,
    project_id,
    environment_id,
    record_kind,
    record_id,
    definition_sha256
  ) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT proofstack_evaluation_resource_bindings_kind CHECK (
    (resource_kind = 'aggregation_policy' AND root_record_kind = 'aggregation_policy')
    OR (resource_kind = 'criterion_set' AND root_record_kind = 'criterion_set')
    OR (resource_kind = 'evaluator' AND root_record_kind = 'evaluator_spec')
    OR (resource_kind = 'oracle' AND root_record_kind = 'oracle_spec')
    OR (
      resource_kind = 'qualification_fixture_set'
      AND root_record_kind = 'qualification_fixture_set'
    )
  ),
  CONSTRAINT proofstack_evaluation_resource_bindings_id_format CHECK (
    resource_id ~ '^[a-z][a-z0-9_]{2,63}$'
  )
);

CREATE TABLE public.proofstack_evaluation_lineage (
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

  CONSTRAINT proofstack_evaluation_lineage_pk PRIMARY KEY (
    tenant_id,
    child_record_kind,
    child_record_id,
    edge_position
  ),
  CONSTRAINT proofstack_evaluation_lineage_child_fk FOREIGN KEY (
    tenant_id,
    project_id,
    environment_id,
    child_record_kind,
    child_record_id,
    child_definition_sha256
  ) REFERENCES public.proofstack_evaluation_record_registry (
    tenant_id,
    project_id,
    environment_id,
    record_kind,
    record_id,
    definition_sha256
  ) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT proofstack_evaluation_lineage_parent_fk FOREIGN KEY (
    tenant_id,
    project_id,
    environment_id,
    parent_record_kind,
    parent_record_id,
    parent_definition_sha256
  ) REFERENCES public.proofstack_evaluation_record_registry (
    tenant_id,
    project_id,
    environment_id,
    record_kind,
    record_id,
    definition_sha256
  ) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT proofstack_evaluation_lineage_position CHECK (
    edge_position BETWEEN 0 AND 4095
  ),
  CONSTRAINT proofstack_evaluation_lineage_not_self CHECK (
    (child_record_kind, child_record_id) IS DISTINCT FROM
      (parent_record_kind, parent_record_id)
  )
);

CREATE INDEX proofstack_evaluation_lineage_parent_idx
  ON public.proofstack_evaluation_lineage (
    tenant_id,
    parent_record_kind,
    parent_record_id
  );

CREATE TABLE public.proofstack_evaluation_unique_bindings (
  tenant_id varchar(64) NOT NULL,
  project_id varchar(64) NOT NULL,
  environment_id varchar(64) NOT NULL,
  binding_kind varchar(48) NOT NULL,
  binding_key varchar(192) NOT NULL,
  record_kind varchar(48) NOT NULL,
  record_id varchar(64) NOT NULL,
  definition_sha256 character(64) NOT NULL,

  CONSTRAINT proofstack_evaluation_unique_bindings_pk PRIMARY KEY (
    tenant_id,
    binding_kind,
    binding_key
  ),
  CONSTRAINT proofstack_evaluation_unique_bindings_record_fk FOREIGN KEY (
    tenant_id,
    project_id,
    environment_id,
    record_kind,
    record_id,
    definition_sha256
  ) REFERENCES public.proofstack_evaluation_record_registry (
    tenant_id,
    project_id,
    environment_id,
    record_kind,
    record_id,
    definition_sha256
  ) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT proofstack_evaluation_unique_bindings_kind CHECK (
    (binding_kind = 'evaluation_run_result' AND record_kind = 'evaluation_run_result')
    OR (binding_kind = 'raw_observation_attempt' AND record_kind = 'raw_observation')
  ),
  CONSTRAINT proofstack_evaluation_unique_bindings_key CHECK (
    char_length(binding_key) BETWEEN 1 AND 192
    AND binding_key = btrim(binding_key)
  )
);

CREATE TABLE public.proofstack_evaluation_records (
  tenant_id varchar(64) NOT NULL,
  project_id varchar(64) NOT NULL,
  environment_id varchar(64) NOT NULL,
  record_kind varchar(48) NOT NULL,
  record_id varchar(64) NOT NULL,
  schema_version varchar(16) NOT NULL,
  definition_sha256 character(64) NOT NULL,
  recorded_at timestamptz NOT NULL,
  recorded_at_lexical text NOT NULL,
  actor_principal_id varchar(64) NOT NULL,
  resource_kind varchar(48),
  resource_id varchar(64),
  lifecycle_state varchar(48),
  verdict varchar(32),
  run_id varchar(64),
  attempt_id varchar(64),
  attempt_sequence smallint,
  lineage_count smallint NOT NULL,
  record jsonb NOT NULL,

  CONSTRAINT proofstack_evaluation_records_pk PRIMARY KEY (
    tenant_id,
    record_kind,
    record_id
  ),
  CONSTRAINT proofstack_evaluation_records_registry_fk FOREIGN KEY (
    tenant_id,
    project_id,
    environment_id,
    record_kind,
    record_id,
    definition_sha256
  ) REFERENCES public.proofstack_evaluation_record_registry (
    tenant_id,
    project_id,
    environment_id,
    record_kind,
    record_id,
    definition_sha256
  ) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT proofstack_evaluation_records_common_projection CHECK (
    jsonb_typeof(record) = 'object'
    AND record ->> 'schemaVersion' = schema_version
    AND record ->> 'definitionSha256' = definition_sha256
    AND jsonb_typeof(record -> 'scope') = 'object'
    AND record #>> '{scope,tenantId}' = tenant_id
    AND record #>> '{scope,projectId}' = project_id
    AND record #>> '{scope,environmentId}' = environment_id
  ),
  CONSTRAINT proofstack_evaluation_records_recorded_at CHECK (
    isfinite(recorded_at)
    AND recorded_at_lexical ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
    AND recorded_at = recorded_at_lexical::timestamptz
  ),
  CONSTRAINT proofstack_evaluation_records_actor_format CHECK (
    actor_principal_id ~ '^[a-z][a-z0-9_]{2,63}$'
  ),
  CONSTRAINT proofstack_evaluation_records_resource_pair CHECK (
    (resource_kind IS NULL) = (resource_id IS NULL)
  ),
  CONSTRAINT proofstack_evaluation_records_resource_id CHECK (
    resource_id IS NULL OR resource_id ~ '^[a-z][a-z0-9_]{2,63}$'
  ),
  CONSTRAINT proofstack_evaluation_records_run_id CHECK (
    run_id IS NULL OR run_id ~ '^[a-z][a-z0-9_]{2,63}$'
  ),
  CONSTRAINT proofstack_evaluation_records_attempt CHECK (
    (attempt_id IS NULL AND attempt_sequence IS NULL)
    OR (
      attempt_id ~ '^[a-z][a-z0-9_]{2,63}$'
      AND attempt_sequence BETWEEN 0 AND 63
    )
  ),
  CONSTRAINT proofstack_evaluation_records_lineage_count CHECK (
    lineage_count BETWEEN 0 AND 4096
  )
) PARTITION BY LIST (record_kind);

CREATE TABLE public.proofstack_evaluation_aggregation_policies
  PARTITION OF public.proofstack_evaluation_records FOR VALUES IN ('aggregation_policy');
CREATE TABLE public.proofstack_evaluation_assessments
  PARTITION OF public.proofstack_evaluation_records FOR VALUES IN ('assessment');
CREATE TABLE public.proofstack_evaluation_criterion_sets
  PARTITION OF public.proofstack_evaluation_records FOR VALUES IN ('criterion_set');
CREATE TABLE public.proofstack_evaluation_criterion_set_statuses
  PARTITION OF public.proofstack_evaluation_records FOR VALUES IN ('criterion_set_status');
CREATE TABLE public.proofstack_evaluation_discovery_records
  PARTITION OF public.proofstack_evaluation_records FOR VALUES IN ('discovery_record');
CREATE TABLE public.proofstack_evaluation_aggregates
  PARTITION OF public.proofstack_evaluation_records FOR VALUES IN ('evaluation_aggregate');
CREATE TABLE public.proofstack_evaluation_runs
  PARTITION OF public.proofstack_evaluation_records FOR VALUES IN ('evaluation_run');
CREATE TABLE public.proofstack_evaluation_run_rejections
  PARTITION OF public.proofstack_evaluation_records FOR VALUES IN ('evaluation_run_rejection');
CREATE TABLE public.proofstack_evaluation_run_results
  PARTITION OF public.proofstack_evaluation_records FOR VALUES IN ('evaluation_run_result');
CREATE TABLE public.proofstack_evaluation_evaluator_specs
  PARTITION OF public.proofstack_evaluation_records FOR VALUES IN ('evaluator_spec');
CREATE TABLE public.proofstack_evaluation_oracle_specs
  PARTITION OF public.proofstack_evaluation_records FOR VALUES IN ('oracle_spec');
CREATE TABLE public.proofstack_evaluation_qualification_fixture_sets
  PARTITION OF public.proofstack_evaluation_records FOR VALUES IN ('qualification_fixture_set');
CREATE TABLE public.proofstack_evaluation_qualification_reports
  PARTITION OF public.proofstack_evaluation_records FOR VALUES IN ('qualification_report');
CREATE TABLE public.proofstack_evaluation_raw_observations
  PARTITION OF public.proofstack_evaluation_records FOR VALUES IN ('raw_observation');
CREATE TABLE public.proofstack_evaluation_source_reviews
  PARTITION OF public.proofstack_evaluation_records FOR VALUES IN ('source_review');
CREATE TABLE public.proofstack_evaluation_source_snapshots
  PARTITION OF public.proofstack_evaluation_records FOR VALUES IN ('source_snapshot');

ALTER TABLE public.proofstack_evaluation_aggregation_policies
  ADD CONSTRAINT proofstack_evaluation_aggregation_policies_projection CHECK (
    record_id = record ->> 'policyVersionId'
    AND resource_kind = 'aggregation_policy'
    AND resource_id = record ->> 'policyId'
    AND recorded_at_lexical = record ->> 'publishedAt'
    AND actor_principal_id = record ->> 'publishedByPrincipalId'
    AND lifecycle_state IS NULL AND verdict IS NULL AND run_id IS NULL
  );
ALTER TABLE public.proofstack_evaluation_assessments
  ADD CONSTRAINT proofstack_evaluation_assessments_projection CHECK (
    record_id = record ->> 'assessmentId'
    AND resource_kind IS NULL
    AND recorded_at_lexical = record ->> 'createdAt'
    AND actor_principal_id = record ->> 'createdByPrincipalId'
    AND lifecycle_state = record #>> '{eligibility,status}'
    AND verdict = record ->> 'supportStatus'
    AND run_id IS NULL
  );
ALTER TABLE public.proofstack_evaluation_criterion_sets
  ADD CONSTRAINT proofstack_evaluation_criterion_sets_projection CHECK (
    record_id = record ->> 'criterionSetVersionId'
    AND resource_kind = 'criterion_set'
    AND resource_id = record ->> 'criterionSetId'
    AND recorded_at_lexical = record ->> 'publishedAt'
    AND actor_principal_id = record ->> 'publishedByPrincipalId'
    AND lifecycle_state IS NULL AND verdict IS NULL AND run_id IS NULL
  );
ALTER TABLE public.proofstack_evaluation_criterion_set_statuses
  ADD CONSTRAINT proofstack_evaluation_criterion_set_statuses_projection CHECK (
    record_id = record ->> 'statusRecordId'
    AND resource_kind IS NULL
    AND recorded_at_lexical = record ->> 'recordedAt'
    AND actor_principal_id = record ->> 'recordedByPrincipalId'
    AND lifecycle_state = record ->> 'status'
    AND verdict IS NULL AND run_id IS NULL
  );
ALTER TABLE public.proofstack_evaluation_discovery_records
  ADD CONSTRAINT proofstack_evaluation_discovery_records_projection CHECK (
    record_id = record ->> 'discoveryId'
    AND resource_kind IS NULL
    AND recorded_at_lexical = record ->> 'recordedAt'
    AND actor_principal_id = record ->> 'recordedByPrincipalId'
    AND lifecycle_state IS NULL AND verdict IS NULL AND run_id IS NULL
  );
ALTER TABLE public.proofstack_evaluation_aggregates
  ADD CONSTRAINT proofstack_evaluation_aggregates_projection CHECK (
    record_id = record ->> 'aggregateId'
    AND resource_kind IS NULL
    AND recorded_at_lexical = record ->> 'createdAt'
    AND actor_principal_id = record ->> 'createdByPrincipalId'
    AND lifecycle_state IS NULL AND verdict IS NULL AND run_id IS NULL
  );
ALTER TABLE public.proofstack_evaluation_runs
  ADD CONSTRAINT proofstack_evaluation_runs_projection CHECK (
    record_id = record ->> 'evaluationRunId'
    AND resource_kind IS NULL
    AND recorded_at_lexical = record ->> 'createdAt'
    AND actor_principal_id = record ->> 'createdByPrincipalId'
    AND lifecycle_state = record #>> '{applicability,result}'
    AND verdict IS NULL AND run_id = record_id
  );
ALTER TABLE public.proofstack_evaluation_run_rejections
  ADD CONSTRAINT proofstack_evaluation_run_rejections_projection CHECK (
    record_id = record ->> 'rejectionId'
    AND resource_kind IS NULL
    AND recorded_at_lexical = record ->> 'recordedAt'
    AND actor_principal_id = record ->> 'requestedByPrincipalId'
    AND lifecycle_state = record ->> 'resolution'
    AND verdict IS NULL AND run_id IS NULL
  );
ALTER TABLE public.proofstack_evaluation_run_results
  ADD CONSTRAINT proofstack_evaluation_run_results_projection CHECK (
    record_id = record ->> 'resultId'
    AND resource_kind IS NULL
    AND recorded_at_lexical = record ->> 'recordedAt'
    AND actor_principal_id = record ->> 'recordedByPrincipalId'
    AND lifecycle_state = record ->> 'terminalReason'
    AND verdict = record ->> 'verdict'
    AND run_id = record ->> 'evaluationRunId'
  );
ALTER TABLE public.proofstack_evaluation_evaluator_specs
  ADD CONSTRAINT proofstack_evaluation_evaluator_specs_projection CHECK (
    record_id = record ->> 'evaluatorVersionId'
    AND resource_kind = 'evaluator'
    AND resource_id = record ->> 'evaluatorId'
    AND recorded_at_lexical = record ->> 'publishedAt'
    AND actor_principal_id = record ->> 'publishedByPrincipalId'
    AND lifecycle_state IS NULL AND verdict IS NULL AND run_id IS NULL
  );
ALTER TABLE public.proofstack_evaluation_oracle_specs
  ADD CONSTRAINT proofstack_evaluation_oracle_specs_projection CHECK (
    record_id = record ->> 'oracleVersionId'
    AND resource_kind = 'oracle'
    AND resource_id = record ->> 'oracleId'
    AND recorded_at_lexical = record ->> 'publishedAt'
    AND actor_principal_id = record ->> 'publishedByPrincipalId'
    AND lifecycle_state IS NULL AND verdict IS NULL AND run_id IS NULL
  );
ALTER TABLE public.proofstack_evaluation_qualification_fixture_sets
  ADD CONSTRAINT proofstack_evaluation_qualification_fixture_sets_projection CHECK (
    record_id = record ->> 'fixtureSetVersionId'
    AND resource_kind = 'qualification_fixture_set'
    AND resource_id = record ->> 'fixtureSetId'
    AND recorded_at_lexical = record ->> 'publishedAt'
    AND actor_principal_id = record ->> 'publishedByPrincipalId'
    AND lifecycle_state IS NULL AND verdict IS NULL AND run_id IS NULL
  );
ALTER TABLE public.proofstack_evaluation_qualification_reports
  ADD CONSTRAINT proofstack_evaluation_qualification_reports_projection CHECK (
    record_id = record ->> 'qualificationReportId'
    AND resource_kind IS NULL
    AND recorded_at_lexical = record ->> 'recordedAt'
    AND actor_principal_id = record ->> 'executedByPrincipalId'
    AND lifecycle_state = record ->> 'status'
    AND verdict IS NULL AND run_id IS NULL
  );
ALTER TABLE public.proofstack_evaluation_raw_observations
  ADD CONSTRAINT proofstack_evaluation_raw_observations_projection CHECK (
    record_id = record ->> 'observationId'
    AND resource_kind IS NULL
    AND recorded_at_lexical = record ->> 'recordedAt'
    AND actor_principal_id = record ->> 'executedByPrincipalId'
    AND lifecycle_state IS NULL
    AND verdict = record ->> 'verdict'
    AND run_id = record #>> '{run,evaluationRunId}'
    AND attempt_id = record ->> 'attemptId'
    AND attempt_sequence = (record ->> 'attemptSequence')::smallint
  );
ALTER TABLE public.proofstack_evaluation_source_reviews
  ADD CONSTRAINT proofstack_evaluation_source_reviews_projection CHECK (
    record_id = record ->> 'sourceReviewId'
    AND resource_kind IS NULL
    AND recorded_at_lexical = record ->> 'reviewedAt'
    AND actor_principal_id = record ->> 'reviewedByPrincipalId'
    AND lifecycle_state = record ->> 'outcome'
    AND verdict IS NULL AND run_id IS NULL
  );
ALTER TABLE public.proofstack_evaluation_source_snapshots
  ADD CONSTRAINT proofstack_evaluation_source_snapshots_projection CHECK (
    record_id = record ->> 'sourceSnapshotId'
    AND resource_kind IS NULL
    AND recorded_at_lexical = record ->> 'recordedAt'
    AND actor_principal_id = record ->> 'publishedByPrincipalId'
    AND lifecycle_state IS NULL AND verdict IS NULL AND run_id IS NULL
  );

CREATE FUNCTION public.proofstack_guard_evaluation_lineage_cycle()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF EXISTS (
    WITH RECURSIVE ancestors(record_kind, record_id) AS (
      SELECT NEW.parent_record_kind, NEW.parent_record_id
      UNION
      SELECT edge.parent_record_kind, edge.parent_record_id
      FROM public.proofstack_evaluation_lineage AS edge
      JOIN ancestors
        ON edge.tenant_id = NEW.tenant_id
        AND edge.child_record_kind = ancestors.record_kind
        AND edge.child_record_id = ancestors.record_id
    )
    SELECT 1
    FROM ancestors
    WHERE record_kind = NEW.child_record_kind
      AND record_id = NEW.child_record_id
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Evaluation lineage must remain acyclic';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.proofstack_verify_evaluation_record_body()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.proofstack_evaluation_records AS body
    WHERE body.tenant_id = NEW.tenant_id
      AND body.project_id = NEW.project_id
      AND body.environment_id = NEW.environment_id
      AND body.record_kind = NEW.record_kind
      AND body.record_id = NEW.record_id
      AND body.definition_sha256 = NEW.definition_sha256
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Evaluation registry record requires one exact typed body';
  END IF;
  RETURN NULL;
END;
$$;

CREATE FUNCTION public.proofstack_verify_evaluation_lineage_count()
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
  FROM public.proofstack_evaluation_lineage AS edge
  WHERE edge.tenant_id = NEW.tenant_id
    AND edge.child_record_kind = NEW.record_kind
    AND edge.child_record_id = NEW.record_id;

  IF actual_count IS DISTINCT FROM NEW.lineage_count THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Evaluation lineage edge count does not match its immutable record';
  END IF;
  RETURN NULL;
END;
$$;

CREATE FUNCTION public.proofstack_evaluation_record_references(
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
        WHEN 'source_review' THEN reference.record_kind IN ('source_review', 'source_snapshot')
        WHEN 'source_snapshot' THEN reference.record_kind IN (
          'discovery_record', 'source_snapshot'
        )
        ELSE false
      END
  )
  SELECT DISTINCT candidate.record_kind, candidate.record_id, candidate.digest
  FROM candidates AS candidate
  WHERE candidate.digest IS NOT NULL
    OR NOT EXISTS (
      SELECT 1
      FROM candidates AS exact_candidate
      WHERE exact_candidate.record_kind = candidate.record_kind
        AND exact_candidate.record_id = candidate.record_id
        AND exact_candidate.digest IS NOT NULL
    )
  ORDER BY candidate.record_kind, candidate.record_id, candidate.digest NULLS FIRST
$$;

CREATE FUNCTION public.proofstack_insert_evaluation_record(command jsonb)
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
    WHEN kind IN ('discovery_record', 'source_review', 'source_snapshot')
      THEN 'evaluation.source.recorded'
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

CREATE FUNCTION public.proofstack_publish_evaluation_control_record(command jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF command ->> 'recordKind' NOT IN (
    'aggregation_policy', 'assessment', 'criterion_set', 'criterion_set_status',
    'discovery_record', 'evaluation_aggregate', 'evaluation_run',
    'evaluation_run_rejection', 'evaluator_spec', 'oracle_spec',
    'qualification_fixture_set', 'source_review', 'source_snapshot'
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'The API authority cannot persist this evaluation record kind';
  END IF;
  PERFORM public.proofstack_insert_evaluation_record(command);
END;
$$;

CREATE FUNCTION public.proofstack_publish_evaluation_execution_record(command jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF command ->> 'recordKind' NOT IN (
    'evaluation_run_result', 'qualification_report', 'raw_observation'
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'The evaluation worker authority cannot persist this evaluation record kind';
  END IF;
  PERFORM public.proofstack_insert_evaluation_record(command);
END;
$$;

CREATE FUNCTION public.proofstack_evaluation_intent_status(
  requested_event_type text,
  requested_aggregate_type text,
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
        AND intent.event_type = requested_event_type
        AND intent.aggregate_type = requested_aggregate_type
        AND intent.aggregate_id = requested_aggregate_id
    ) THEN 'absent'
    WHEN EXISTS (
      SELECT 1
      FROM public.proofstack_outbox AS intent
      WHERE intent.tenant_id = NULLIF(current_setting('proofstack.tenant_id', true), '')
        AND intent.event_type = requested_event_type
        AND intent.aggregate_type = requested_aggregate_type
        AND intent.aggregate_id = requested_aggregate_id
        AND intent.schema_version = requested_schema_version
        AND intent.payload = requested_payload
        AND intent.created_at = requested_created_at
    ) THEN 'canonical'
    ELSE 'conflict'
  END
$$;

REVOKE ALL ON FUNCTION public.proofstack_guard_evaluation_lineage_cycle() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.proofstack_evaluation_record_references(text, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.proofstack_evaluation_intent_status(
  text, text, text, text, jsonb, timestamptz
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.proofstack_insert_evaluation_record(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.proofstack_publish_evaluation_control_record(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.proofstack_publish_evaluation_execution_record(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.proofstack_verify_evaluation_record_body() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.proofstack_verify_evaluation_lineage_count() FROM PUBLIC;

CREATE TRIGGER proofstack_evaluation_lineage_cycle_guard
  BEFORE INSERT ON public.proofstack_evaluation_lineage
  FOR EACH ROW
  EXECUTE FUNCTION public.proofstack_guard_evaluation_lineage_cycle();

CREATE CONSTRAINT TRIGGER proofstack_evaluation_registry_body_complete
  AFTER INSERT ON public.proofstack_evaluation_record_registry
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION public.proofstack_verify_evaluation_record_body();

CREATE TRIGGER proofstack_evaluation_registry_append_only
  BEFORE UPDATE OR DELETE ON public.proofstack_evaluation_record_registry
  FOR EACH ROW EXECUTE FUNCTION public.proofstack_reject_append_only_mutation();
CREATE TRIGGER proofstack_evaluation_resources_append_only
  BEFORE UPDATE OR DELETE ON public.proofstack_evaluation_resource_bindings
  FOR EACH ROW EXECUTE FUNCTION public.proofstack_reject_append_only_mutation();
CREATE TRIGGER proofstack_evaluation_lineage_append_only
  BEFORE UPDATE OR DELETE ON public.proofstack_evaluation_lineage
  FOR EACH ROW EXECUTE FUNCTION public.proofstack_reject_append_only_mutation();
CREATE TRIGGER proofstack_evaluation_unique_bindings_append_only
  BEFORE UPDATE OR DELETE ON public.proofstack_evaluation_unique_bindings
  FOR EACH ROW EXECUTE FUNCTION public.proofstack_reject_append_only_mutation();
CREATE TRIGGER proofstack_evaluation_records_append_only
  BEFORE UPDATE OR DELETE ON public.proofstack_evaluation_records
  FOR EACH ROW EXECUTE FUNCTION public.proofstack_reject_append_only_mutation();

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'proofstack_evaluation_aggregation_policies',
    'proofstack_evaluation_assessments',
    'proofstack_evaluation_criterion_sets',
    'proofstack_evaluation_criterion_set_statuses',
    'proofstack_evaluation_discovery_records',
    'proofstack_evaluation_aggregates',
    'proofstack_evaluation_runs',
    'proofstack_evaluation_run_rejections',
    'proofstack_evaluation_run_results',
    'proofstack_evaluation_evaluator_specs',
    'proofstack_evaluation_oracle_specs',
    'proofstack_evaluation_qualification_fixture_sets',
    'proofstack_evaluation_qualification_reports',
    'proofstack_evaluation_raw_observations',
    'proofstack_evaluation_source_reviews',
    'proofstack_evaluation_source_snapshots'
  ]
  LOOP
    EXECUTE format(
      'CREATE CONSTRAINT TRIGGER %I AFTER INSERT ON public.%I '
      'DEFERRABLE INITIALLY DEFERRED FOR EACH ROW '
      'EXECUTE FUNCTION public.proofstack_verify_evaluation_lineage_count()',
      table_name || '_lineage_complete',
      table_name
    );
  END LOOP;
END;
$$;

ALTER TABLE public.proofstack_evaluation_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.proofstack_evaluation_records FORCE ROW LEVEL SECURITY;

CREATE POLICY proofstack_evaluation_records_tenant_select
  ON public.proofstack_evaluation_records FOR SELECT
  USING (tenant_id = NULLIF(current_setting('proofstack.tenant_id', true), ''));
CREATE POLICY proofstack_evaluation_records_tenant_insert
  ON public.proofstack_evaluation_records FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('proofstack.tenant_id', true), ''));

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'proofstack_evaluation_record_registry',
    'proofstack_evaluation_resource_bindings',
    'proofstack_evaluation_lineage',
    'proofstack_evaluation_unique_bindings',
    'proofstack_evaluation_aggregation_policies',
    'proofstack_evaluation_assessments',
    'proofstack_evaluation_criterion_sets',
    'proofstack_evaluation_criterion_set_statuses',
    'proofstack_evaluation_discovery_records',
    'proofstack_evaluation_aggregates',
    'proofstack_evaluation_runs',
    'proofstack_evaluation_run_rejections',
    'proofstack_evaluation_run_results',
    'proofstack_evaluation_evaluator_specs',
    'proofstack_evaluation_oracle_specs',
    'proofstack_evaluation_qualification_fixture_sets',
    'proofstack_evaluation_qualification_reports',
    'proofstack_evaluation_raw_observations',
    'proofstack_evaluation_source_reviews',
    'proofstack_evaluation_source_snapshots'
  ]
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT '
      'USING (tenant_id = NULLIF(current_setting(''proofstack.tenant_id'', true), ''''))',
      table_name || '_tenant_select',
      table_name
    );
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR INSERT '
      'WITH CHECK (tenant_id = NULLIF(current_setting(''proofstack.tenant_id'', true), ''''))',
      table_name || '_tenant_insert',
      table_name
    );
  END LOOP;
END;
$$;

REVOKE ALL ON TABLE
  public.proofstack_evaluation_record_registry,
  public.proofstack_evaluation_resource_bindings,
  public.proofstack_evaluation_lineage,
  public.proofstack_evaluation_unique_bindings,
  public.proofstack_evaluation_records,
  public.proofstack_evaluation_aggregation_policies,
  public.proofstack_evaluation_assessments,
  public.proofstack_evaluation_criterion_sets,
  public.proofstack_evaluation_criterion_set_statuses,
  public.proofstack_evaluation_discovery_records,
  public.proofstack_evaluation_aggregates,
  public.proofstack_evaluation_runs,
  public.proofstack_evaluation_run_rejections,
  public.proofstack_evaluation_run_results,
  public.proofstack_evaluation_evaluator_specs,
  public.proofstack_evaluation_oracle_specs,
  public.proofstack_evaluation_qualification_fixture_sets,
  public.proofstack_evaluation_qualification_reports,
  public.proofstack_evaluation_raw_observations,
  public.proofstack_evaluation_source_reviews,
  public.proofstack_evaluation_source_snapshots
FROM PUBLIC;
