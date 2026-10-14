-- Immutable historical results; publication alone owns its live native execution window.
CREATE TABLE public.proofstack_policy_evaluation_results (
  tenant_id varchar(64) NOT NULL, project_id varchar(64) NOT NULL, environment_id varchar(64) NOT NULL,
  evaluation_id varchar(64) NOT NULL, job_id varchar(64) NOT NULL, attempt_id varchar(64) NOT NULL,
  definition_sha256 varchar(64) NOT NULL, snapshot_id varchar(64) NOT NULL, snapshot_sha256 varchar(64) NOT NULL,
  request_id varchar(64) NOT NULL, request_sha256 varchar(64) NOT NULL, rule_count smallint NOT NULL,
  recorded_at timestamptz NOT NULL, native_lease_expires_at timestamptz NOT NULL,
  native_attempt_deadline_at timestamptz NOT NULL, native_job_deadline_at timestamptz NOT NULL,
  canonical_utf8 text NOT NULL, evaluation jsonb NOT NULL,
  PRIMARY KEY(tenant_id,project_id,environment_id,evaluation_id),
  UNIQUE(tenant_id,project_id,environment_id,job_id),
  FOREIGN KEY(tenant_id,project_id,environment_id,job_id,attempt_id) REFERENCES public.proofstack_policy_evaluation_attempts,
  FOREIGN KEY(tenant_id,project_id,environment_id,snapshot_id) REFERENCES public.proofstack_policy_evaluation_snapshots,
  CHECK ((evaluation_id~'^[a-z][a-z0-9_]{2,63}$' AND definition_sha256~'^[0-9a-f]{64}$'
    AND snapshot_sha256~'^[0-9a-f]{64}$' AND request_sha256~'^[0-9a-f]{64}$'
    AND rule_count BETWEEN 1 AND 128 AND recorded_at<native_lease_expires_at
    AND native_lease_expires_at<=native_attempt_deadline_at AND native_attempt_deadline_at<=native_job_deadline_at) IS TRUE),
  CHECK ((octet_length(canonical_utf8)<=524288 AND octet_length(evaluation::text)<=524288
    AND encode(sha256(convert_to(canonical_utf8,'UTF8')),'hex')=definition_sha256
    AND (canonical_utf8::jsonb)->>'definitionDomain'='proofstack.policy-evaluation-result.v1'
    AND (canonical_utf8::jsonb)->>'encodingVersion'='proofstack.policy-evaluation-result-definition-jcs.v1'
    AND (canonical_utf8::jsonb)->>'schemaVersion'='0.1'
    AND (canonical_utf8::jsonb)->'scope'=evaluation->'scope'
    AND (canonical_utf8::jsonb)->'definition'=(evaluation-ARRAY['scope','schemaVersion','definitionSha256',
      'recordedAt','recordedByPrincipalId','jobId','attemptId','workerId','leaseId','fencingToken','recoveryEpoch'])
    AND evaluation->>'schemaVersion'='0.1' AND evaluation->>'evaluationId'=evaluation_id
    AND evaluation->>'definitionSha256'=definition_sha256 AND evaluation->>'jobId'=job_id
    AND evaluation->>'attemptId'=attempt_id AND evaluation#>>'{snapshot,snapshotId}'=snapshot_id
    AND evaluation#>>'{snapshot,definitionSha256}'=snapshot_sha256
    AND evaluation#>>'{request,evaluationRequestId}'=request_id AND evaluation#>>'{request,definitionSha256}'=request_sha256
    AND evaluation#>>'{scope,tenantId}'=tenant_id AND evaluation#>>'{scope,projectId}'=project_id
    AND evaluation#>>'{scope,environmentId}'=environment_id
    AND evaluation->>'recordedByPrincipalId'=evaluation->>'workerId'
    AND (evaluation->>'recordedAt')::timestamptz=recorded_at
    AND (evaluation->>'ruleCount')::integer=rule_count AND jsonb_array_length(evaluation->'rules')=rule_count) IS TRUE)
);
ALTER TABLE public.proofstack_policy_evaluation_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.proofstack_policy_evaluation_results FORCE ROW LEVEL SECURITY;
CREATE POLICY proofstack_policy_evaluation_results_scope ON public.proofstack_policy_evaluation_results
  USING(tenant_id=NULLIF(current_setting('proofstack.tenant_id',true),'')
    AND project_id=NULLIF(current_setting('proofstack.project_id',true),'')
    AND environment_id=NULLIF(current_setting('proofstack.environment_id',true),''))
  WITH CHECK(tenant_id=NULLIF(current_setting('proofstack.tenant_id',true),'')
    AND project_id=NULLIF(current_setting('proofstack.project_id',true),'')
    AND environment_id=NULLIF(current_setting('proofstack.environment_id',true),''));
CREATE TRIGGER proofstack_policy_evaluation_results_append_only BEFORE UPDATE OR DELETE
  ON public.proofstack_policy_evaluation_results FOR EACH ROW EXECUTE FUNCTION public.proofstack_reject_append_only_mutation();
CREATE TRIGGER proofstack_policy_evaluation_metadata_write_lock AFTER INSERT OR UPDATE OR DELETE
  ON public.proofstack_policy_evaluation_results FOR EACH ROW EXECUTE FUNCTION public.proofstack_lock_policy_evaluation_metadata_write();
REVOKE ALL ON TABLE public.proofstack_policy_evaluation_results FROM PUBLIC;

DO $$ DECLARE original_check text; BEGIN
  SELECT pg_get_constraintdef(oid) INTO original_check FROM pg_constraint
    WHERE conrelid='public.proofstack_policy_evaluation_job_history'::regclass
      AND conname='proofstack_policy_history_projection_complete';
  IF original_check IS NULL OR position('(''start_computation''::character varying)::text' in original_check)=0 THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Original computation history constraint is missing';
  END IF;
  original_check:=replace(original_check,'(''start_computation''::character varying)::text',
    '(''start_computation''::character varying)::text, (''complete''::character varying)::text');
  EXECUTE 'ALTER TABLE public.proofstack_policy_evaluation_job_history DROP CONSTRAINT proofstack_policy_history_projection_complete';
  EXECUTE 'ALTER TABLE public.proofstack_policy_evaluation_job_history ADD CONSTRAINT proofstack_policy_history_projection_complete '||original_check;
END; $$;

CREATE FUNCTION public.proofstack_read_policy_evaluation_result(expected_id text,expected_sha text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE scoped jsonb:=public.proofstack_policy_evaluation_scope(); answer jsonb;
BEGIN
  SELECT evaluation INTO answer FROM public.proofstack_policy_evaluation_results
    WHERE tenant_id=scoped->>'tenantId' AND project_id=scoped->>'projectId' AND environment_id=scoped->>'environmentId'
      AND evaluation_id=expected_id AND definition_sha256=expected_sha;
  RETURN answer;
END; $$;
REVOKE ALL ON FUNCTION public.proofstack_read_policy_evaluation_result(text,text) FROM PUBLIC;

CREATE FUNCTION public.proofstack_publish_policy_evaluation_result(expected_fence jsonb,canonical_value text,expected_sha text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE scoped jsonb:=public.proofstack_policy_evaluation_scope();
  value jsonb:=public.proofstack_policy_evaluation_lock_job(expected_fence->>'jobId');
  body jsonb:=value->'job'; latest jsonb:=value->'attempts'->((body->>'attemptCount')::integer-1);
  lease jsonb:=body->'currentLease'; envelope jsonb; definition jsonb; record_value jsonb; reference jsonb;
  cut timestamptz:=clock_timestamp(); lexical text; rules integer; intent jsonb;
  stored public.proofstack_policy_evaluation_results%ROWTYPE;
BEGIN
  IF canonical_value IS NULL OR octet_length(canonical_value)>524288 OR expected_sha IS NULL
    OR expected_sha!~'^[0-9a-f]{64}$' OR encode(sha256(convert_to(canonical_value,'UTF8')),'hex') IS DISTINCT FROM expected_sha THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Policy result canonical admission rejected';
  END IF;
  envelope:=canonical_value::jsonb; definition:=envelope->'definition'; rules:=(definition->>'ruleCount')::integer;
  IF envelope->'scope' IS DISTINCT FROM scoped
    OR envelope->>'definitionDomain' IS DISTINCT FROM 'proofstack.policy-evaluation-result.v1'
    OR envelope->>'encodingVersion' IS DISTINCT FROM 'proofstack.policy-evaluation-result-definition-jcs.v1'
    OR envelope->>'schemaVersion' IS DISTINCT FROM '0.1'
    OR definition->'request' IS DISTINCT FROM body->'request' OR definition->'snapshot' IS DISTINCT FROM body->'snapshot'
    OR definition->'candidate' IS DISTINCT FROM value#>'{request,candidate}' OR definition->'policy' IS DISTINCT FROM value#>'{request,policy}'
    OR definition->'algorithm' IS DISTINCT FROM value#>'{request,algorithm}'
    OR definition->>'evaluationTime' IS DISTINCT FROM value#>>'{request,evaluationTime}'
    OR (rules BETWEEN 1 AND 128) IS DISTINCT FROM true OR jsonb_array_length(definition->'rules') IS DISTINCT FROM rules THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Policy result substituted immutable sealed inputs';
  END IF;
  SELECT * INTO stored FROM public.proofstack_policy_evaluation_results
    WHERE tenant_id=scoped->>'tenantId' AND project_id=scoped->>'projectId' AND environment_id=scoped->>'environmentId' AND job_id=body->>'jobId';
  IF FOUND THEN
    IF body->>'status' IS DISTINCT FROM 'completed' OR stored.definition_sha256 IS DISTINCT FROM expected_sha
      OR stored.canonical_utf8 IS DISTINCT FROM canonical_value
      OR body->'result' IS DISTINCT FROM jsonb_build_object('evaluationId',stored.evaluation_id,'definitionSha256',stored.definition_sha256)
      OR expected_fence IS DISTINCT FROM jsonb_build_object('jobId',stored.job_id,'attemptId',stored.attempt_id,
        'workerId',stored.evaluation->>'workerId','leaseId',stored.evaluation->>'leaseId',
        'fencingToken',(stored.evaluation->>'fencingToken')::bigint,'recoveryEpoch',(stored.evaluation->>'recoveryEpoch')::bigint) THEN
      RAISE EXCEPTION USING ERRCODE='23505', MESSAGE='Policy result completion identity conflict';
    END IF;
    FOR intent IN SELECT jsonb_array_elements(public.proofstack_policy_evaluation_expected_intents(value)) LOOP
      IF public.proofstack_policy_evaluation_intent_status(body->>'jobId',intent->>'eventType',intent->'payload',(intent->>'createdAt')::timestamptz) IS DISTINCT FROM 'canonical' THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Policy completion retry omitted original canonical intent';
      END IF;
    END LOOP;
    RETURN jsonb_build_object('created',false,'evaluation',stored.evaluation,'job',value);
  END IF;
  PERFORM public.proofstack_policy_evaluation_assert_fence(value,expected_fence,cut);
  IF body->>'status' IS DISTINCT FROM 'running' OR latest->>'phase' IS DISTINCT FROM 'computing'
    OR latest->'closure' IS DISTINCT FROM 'null'::jsonb OR latest->'snapshot' IS DISTINCT FROM body->'snapshot'
    OR (value#>>'{usage,ruleEvaluations}')::bigint-(latest#>>'{usageAtStart,ruleEvaluations}')::bigint<rules
    OR (body->>'stateVersion')::integer>=100000 THEN
    RAISE EXCEPTION USING ERRCODE='40001', MESSAGE='Policy result requires the original prepaid computing attempt';
  END IF;
  lexical:=public.proofstack_policy_evaluation_utc(cut);
  record_value:=definition||jsonb_build_object('scope',scoped,'schemaVersion','0.1','definitionSha256',expected_sha,
    'recordedAt',lexical,'recordedByPrincipalId',expected_fence->>'workerId')||expected_fence;
  INSERT INTO public.proofstack_policy_evaluation_results VALUES(scoped->>'tenantId',scoped->>'projectId',scoped->>'environmentId',
    definition->>'evaluationId',body->>'jobId',expected_fence->>'attemptId',expected_sha,
    definition#>>'{snapshot,snapshotId}',definition#>>'{snapshot,definitionSha256}',
    definition#>>'{request,evaluationRequestId}',definition#>>'{request,definitionSha256}',rules,cut,
    (lease->>'expiresAt')::timestamptz,(lease->>'attemptDeadlineAt')::timestamptz,(body->>'deadlineAt')::timestamptz,
    canonical_value,record_value);
  value:=public.proofstack_policy_evaluation_close_attempt(value,jsonb_build_object('status','completed','committedAt',lexical));
  reference:=jsonb_build_object('evaluationId',definition->>'evaluationId','definitionSha256',expected_sha);
  body:=body||jsonb_build_object('status','completed','result',reference,'currentLease',NULL,'retryAt',NULL,
    'updatedAt',lexical,'stateVersion',(body->>'stateVersion')::bigint+1,'terminal',jsonb_build_object('status','completed',
      'code','evaluation_completed','attemptId',expected_fence->>'attemptId','committedAt',lexical));
  value:=jsonb_set(value,'{job}',body,false); PERFORM public.proofstack_policy_evaluation_project_job(value);
  RETURN jsonb_build_object('created',true,'evaluation',record_value,'job',value);
END; $$;
REVOKE ALL ON FUNCTION public.proofstack_publish_policy_evaluation_result(jsonb,text,text) FROM PUBLIC;

CREATE FUNCTION public.proofstack_verify_policy_result_commit()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE value jsonb; cut timestamptz; intent jsonb;
  original_tenant text:=current_setting('proofstack.tenant_id',true); original_project text:=current_setting('proofstack.project_id',true);
  original_environment text:=current_setting('proofstack.environment_id',true);
BEGIN
  PERFORM set_config('proofstack.tenant_id',NEW.tenant_id,true),set_config('proofstack.project_id',NEW.project_id,true),set_config('proofstack.environment_id',NEW.environment_id,true);
  value:=public.proofstack_read_policy_evaluation_job(NEW.job_id); cut:=clock_timestamp();
  IF value#>>'{job,status}' IS DISTINCT FROM 'completed'
    OR value#>'{job,result}' IS DISTINCT FROM jsonb_build_object('evaluationId',NEW.evaluation_id,'definitionSha256',NEW.definition_sha256)
    OR value#>>'{job,terminal,committedAt}' IS DISTINCT FROM NEW.evaluation->>'recordedAt'
    OR value#>>'{job,terminal,attemptId}' IS DISTINCT FROM NEW.attempt_id
    OR value#>'{job,currentLease}' IS DISTINCT FROM 'null'::jsonb THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Policy result is not bound to its atomically completed job';
  END IF;
  PERFORM public.proofstack_assert_current_replay_recovery_epoch((NEW.evaluation->>'recoveryEpoch')::bigint);
  IF cut>=NEW.native_lease_expires_at OR cut>=NEW.native_attempt_deadline_at OR cut>=NEW.native_job_deadline_at THEN
    RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='Policy result native execution window expired before commit';
  END IF;
  FOR intent IN SELECT jsonb_array_elements(public.proofstack_policy_evaluation_expected_intents(value)) LOOP
    IF public.proofstack_policy_evaluation_intent_status(NEW.job_id,intent->>'eventType',intent->'payload',(intent->>'createdAt')::timestamptz) IS DISTINCT FROM 'canonical' THEN
      RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Policy completion omitted canonical atomic intent';
    END IF;
  END LOOP;
  PERFORM set_config('proofstack.tenant_id',COALESCE(original_tenant,''),true),set_config('proofstack.project_id',COALESCE(original_project,''),true),set_config('proofstack.environment_id',COALESCE(original_environment,''),true);
  RETURN NULL;
END; $$;
REVOKE ALL ON FUNCTION public.proofstack_verify_policy_result_commit() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER proofstack_policy_result_commit AFTER INSERT ON public.proofstack_policy_evaluation_results
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.proofstack_verify_policy_result_commit();
