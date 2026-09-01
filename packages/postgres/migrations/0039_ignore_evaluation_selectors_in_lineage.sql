-- Criteria selectors intentionally identify a future/external criterion version without its
-- definition digest. They are compatibility declarations, not immutable lineage edges. Keep
-- exact digest-bearing references and the one intentional ID-only edge from a terminal result
-- to its run, while ignoring selector-shaped identifiers.
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
    OR (
      root_record_kind = 'evaluation_run_result'
      AND candidate.record_kind = 'evaluation_run'
      AND candidate.record_id = record ->> 'evaluationRunId'
    )
  ORDER BY candidate.record_kind, candidate.record_id, candidate.digest NULLS FIRST
$$;

REVOKE ALL ON FUNCTION public.proofstack_evaluation_record_references(text, text, jsonb)
  FROM PUBLIC;
