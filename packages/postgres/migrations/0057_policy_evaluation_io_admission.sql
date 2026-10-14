-- Fresh native remaining-time admission for fixed worker operations. This read does not grant
-- authority after its transaction ends; every mutation still checks normalized state/fence/time.
CREATE FUNCTION public.proofstack_policy_evaluation_io_budget(expected_job_id text, expected_fence jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
  value jsonb:=public.proofstack_policy_evaluation_lock_job(expected_job_id);
  body jsonb:=value->'job'; lease jsonb:=body->'currentLease'; cut timestamptz:=clock_timestamp();
  expiry timestamptz:=(body->>'deadlineAt')::timestamptz; remaining integer;
BEGIN
  IF body->>'status' NOT IN ('queued','retry_ready','acquiring','sealed','running')
    OR cut<(body->>'updatedAt')::timestamptz THEN
    RAISE EXCEPTION USING ERRCODE='40001', MESSAGE='Policy I/O state or native time is inadmissible';
  END IF;
  IF expected_fence IS NOT NULL THEN PERFORM public.proofstack_policy_evaluation_assert_fence(value,expected_fence,cut); END IF;
  IF jsonb_typeof(lease)='object' THEN expiry:=LEAST(expiry,(lease->>'expiresAt')::timestamptz,(lease->>'attemptDeadlineAt')::timestamptz); END IF;
  IF cut>=expiry THEN RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='Policy I/O native execution window expired'; END IF;
  remaining:=LEAST(2000,floor(extract(epoch FROM (expiry-cut))*1000))::integer;
  IF remaining<=0 THEN RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='Policy I/O lacks one complete remaining millisecond'; END IF;
  RETURN jsonb_build_object('scope',body->'scope','job',jsonb_build_object('jobId',body->>'jobId','definitionSha256',body->>'definitionSha256'),'stateVersion',(body->>'stateVersion')::bigint,'observedAt',public.proofstack_policy_evaluation_utc(cut),'remainingMilliseconds',remaining);
END;
$$;
REVOKE ALL ON FUNCTION public.proofstack_policy_evaluation_io_budget(text,jsonb) FROM PUBLIC;
