DO $migration$
DECLARE
  function_definition text;
  function_signature CONSTANT regprocedure :=
    'public.proofstack_complete_replay_job(text,text,text,text,text,text,bigint,bigint,text,text,jsonb,jsonb)'::regprocedure;
  prior_condition CONSTANT text :=
    'IF expected_status <> ''budget_exhausted'' AND EXISTS (';
  repaired_condition CONSTANT text :=
    E'IF NOT cancellation_requested\n    AND expected_status <> ''budget_exhausted''\n    AND EXISTS (';
  replacement_count integer;
BEGIN
  function_definition := pg_get_functiondef(function_signature::oid);
  replacement_count := (
    length(function_definition) - length(replace(function_definition, prior_condition, ''))
  ) / length(prior_condition);

  IF replacement_count <> 1 THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'Replay completion budget guard does not match the expected prior definition';
  END IF;

  EXECUTE replace(function_definition, prior_condition, repaired_condition);
END;
$migration$;
