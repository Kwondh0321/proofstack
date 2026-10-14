-- Computation uses the original sealed snapshot and live attempt. No source recapture or result.
CREATE FUNCTION public.proofstack_start_policy_evaluation_computation(expected_fence jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE scoped jsonb:=public.proofstack_policy_evaluation_scope();
  value jsonb:=public.proofstack_policy_evaluation_lock_job(expected_fence->>'jobId');
  body jsonb:=value->'job'; latest jsonb:=value->'attempts'->((body->>'attemptCount')::integer-1);
  cut timestamptz:=clock_timestamp(); reference jsonb:=body->'snapshot';
BEGIN
  PERFORM public.proofstack_policy_evaluation_assert_fence(value,expected_fence,cut);
  IF body->>'status' IS DISTINCT FROM 'sealed' OR jsonb_typeof(reference) IS DISTINCT FROM 'object'
    OR latest->>'phase' IS DISTINCT FROM 'computing' OR latest->'closure' IS DISTINCT FROM 'null'::jsonb
    OR latest->'mutationFence' IS DISTINCT FROM expected_fence
    OR latest->'snapshot' IS DISTINCT FROM reference THEN
    RAISE EXCEPTION USING ERRCODE='40001', MESSAGE='Policy computation requires its sealed owning attempt';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.proofstack_policy_evaluation_snapshots
    WHERE tenant_id=scoped->>'tenantId' AND project_id=scoped->>'projectId'
      AND environment_id=scoped->>'environmentId' AND job_id=body->>'jobId'
      AND snapshot_id=reference->>'snapshotId' AND definition_sha256=reference->>'definitionSha256'
      AND request_id=body#>>'{request,evaluationRequestId}'
      AND request_sha256=body#>>'{request,definitionSha256}') THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Policy computation omitted its original stored snapshot';
  END IF;
  IF (body->>'stateVersion')::bigint=99999 THEN
    RETURN public.proofstack_policy_evaluation_history_limit(value,cut);
  END IF;
  body:=body||jsonb_build_object('status','running','stateVersion',(body->>'stateVersion')::bigint+1,
    'updatedAt',public.proofstack_policy_evaluation_utc(cut));
  value:=jsonb_set(value,'{job}',body,false);
  PERFORM public.proofstack_policy_evaluation_project_job(value);
  RETURN value;
END;
$$;
REVOKE ALL ON FUNCTION public.proofstack_start_policy_evaluation_computation(jsonb) FROM PUBLIC;

-- Started computation must still own its native fence at final commit, after deferred work.
CREATE FUNCTION public.proofstack_verify_policy_computation_commit_fence()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE value jsonb;
  original_tenant text:=current_setting('proofstack.tenant_id',true);
  original_project text:=current_setting('proofstack.project_id',true);
  original_environment text:=current_setting('proofstack.environment_id',true);
BEGIN
  PERFORM set_config('proofstack.tenant_id',NEW.tenant_id,true),
    set_config('proofstack.project_id',NEW.project_id,true),
    set_config('proofstack.environment_id',NEW.environment_id,true);
  value:=public.proofstack_read_policy_evaluation_job(NEW.job_id);
  IF value#>>'{job,status}' IS DISTINCT FROM 'running'
    OR (value#>>'{job,stateVersion}')::bigint IS DISTINCT FROM NEW.sequence+1 THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Policy computation history is not its final state';
  END IF;
  PERFORM public.proofstack_policy_evaluation_assert_fence(value,
    NEW.entry#>'{definition,operation,fence}',clock_timestamp());
  PERFORM set_config('proofstack.tenant_id',COALESCE(original_tenant,''),true),
    set_config('proofstack.project_id',COALESCE(original_project,''),true),
    set_config('proofstack.environment_id',COALESCE(original_environment,''),true);
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.proofstack_verify_policy_computation_commit_fence() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER proofstack_policy_computation_commit_fence
  AFTER INSERT ON public.proofstack_policy_evaluation_job_history
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.operation='start_computation')
  EXECUTE FUNCTION public.proofstack_verify_policy_computation_commit_fence();
