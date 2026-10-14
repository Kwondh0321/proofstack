-- Bind an observed operational graph to its immutable retained history version. This is not
-- current worker/publication authority; live mutations still lock and inspect normalized state.
CREATE FUNCTION public.proofstack_read_policy_evaluation_history_head_at(expected_job_id text, expected_sequence integer)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE scoped jsonb:=public.proofstack_policy_evaluation_scope(); result_value jsonb;
BEGIN
  IF expected_job_id IS NULL OR expected_job_id !~ '^[a-z][a-z0-9_]{2,63}$'
    OR expected_sequence IS NULL OR expected_sequence NOT BETWEEN 0 AND 99999 THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Policy exact history query is outside fixed admission';
  END IF;
  SELECT jsonb_build_object('scope',entry#>'{definition,scope}','job',entry#>'{definition,job}','sequence',sequence,'entrySha256',entry_sha256,'graphSha256',graph_sha256)
    INTO result_value FROM public.proofstack_policy_evaluation_job_history
    WHERE tenant_id=scoped->>'tenantId' AND project_id=scoped->>'projectId'
      AND environment_id=scoped->>'environmentId' AND job_id=expected_job_id AND sequence=expected_sequence;
  RETURN result_value;
END;
$$;
REVOKE ALL ON FUNCTION public.proofstack_read_policy_evaluation_history_head_at(text,integer) FROM PUBLIC;
