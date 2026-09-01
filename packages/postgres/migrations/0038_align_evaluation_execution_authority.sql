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
    'source_review', 'source_snapshot'
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'The API authority cannot persist this evaluation record kind';
  END IF;
  PERFORM public.proofstack_insert_evaluation_record(command);
END;
$$;

CREATE OR REPLACE FUNCTION public.proofstack_publish_evaluation_execution_record(command jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF command ->> 'recordKind' NOT IN (
    'evaluation_aggregate', 'evaluation_run_result', 'qualification_report', 'raw_observation'
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'The evaluation worker authority cannot persist this evaluation record kind';
  END IF;
  PERFORM public.proofstack_insert_evaluation_record(command);
END;
$$;

REVOKE ALL ON FUNCTION public.proofstack_publish_evaluation_control_record(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.proofstack_publish_evaluation_execution_record(jsonb) FROM PUBLIC;
