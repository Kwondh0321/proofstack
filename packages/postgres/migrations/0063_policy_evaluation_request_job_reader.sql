-- Exact immutable request ownership. No publication/worker mutation or absence guard is added.
CREATE FUNCTION public.proofstack_read_policy_evaluation_job_for_request(
  expected_request_id text, expected_request_sha256 text
)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  scoped jsonb := public.proofstack_policy_evaluation_scope();
  retained_request jsonb;
  owner_job_id text;
  owner_request_sha256 text;
  result_value jsonb;
BEGIN
  IF expected_request_id IS NULL OR expected_request_id !~ '^[a-z][a-z0-9_]{2,63}$'
    OR expected_request_sha256 IS NULL OR expected_request_sha256 !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Exact original policy request reference is required';
  END IF;
  SELECT request INTO retained_request FROM public.proofstack_policy_evaluation_requests
    WHERE tenant_id=scoped->>'tenantId' AND project_id=scoped->>'projectId'
      AND environment_id=scoped->>'environmentId' AND request_id=expected_request_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF retained_request->>'definitionSha256' IS DISTINCT FROM expected_request_sha256 THEN
    RAISE EXCEPTION USING ERRCODE='23505', MESSAGE='Original policy request definition conflicts';
  END IF;
  SELECT job_id, request_sha256 INTO owner_job_id, owner_request_sha256
    FROM public.proofstack_policy_evaluation_jobs
    WHERE tenant_id=scoped->>'tenantId' AND project_id=scoped->>'projectId'
      AND environment_id=scoped->>'environmentId' AND request_id=expected_request_id;
  IF NOT FOUND OR owner_request_sha256 IS DISTINCT FROM expected_request_sha256 THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Original policy request has no exact owning job';
  END IF;
  result_value := public.proofstack_read_policy_evaluation_job(owner_job_id);
  IF result_value IS NULL OR result_value->'request' IS DISTINCT FROM retained_request THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Original policy request differs from its owning graph';
  END IF;
  RETURN result_value;
END;
$$;
REVOKE ALL ON FUNCTION public.proofstack_read_policy_evaluation_job_for_request(text,text) FROM PUBLIC;
