-- Metadata credit is reserved before acquisition and settled only from drained server-owned meters.
-- Historical graphs without this optional field keep their original canonical representation.
CREATE TABLE public.proofstack_policy_acquisition_allowances (
  tenant_id varchar(64) NOT NULL,project_id varchar(64) NOT NULL,environment_id varchar(64) NOT NULL,
  job_id varchar(64) NOT NULL,allowance_id varchar(64) NOT NULL,attempt_id varchar(64) NOT NULL,
  allowance jsonb NOT NULL,state varchar(16) NOT NULL DEFAULT 'reserved',
  observed_usage jsonb,closed_at timestamptz,
  requires_live_commit boolean NOT NULL DEFAULT true,
  native_lease_expires_at timestamptz NOT NULL,native_attempt_deadline_at timestamptz NOT NULL,native_job_deadline_at timestamptz NOT NULL,
  PRIMARY KEY(tenant_id,project_id,environment_id,job_id,allowance_id),
  FOREIGN KEY(tenant_id,project_id,environment_id,job_id,attempt_id) REFERENCES public.proofstack_policy_evaluation_attempts,
  CHECK(state IN ('reserved','observed','uncertain')),
  CHECK((state='reserved')=(closed_at IS NULL)),
  CHECK((state='observed')=(observed_usage IS NOT NULL)),
  CHECK((allowance->>'allowanceId'=allowance_id AND allowance#>>'{mutationFence,jobId}'=job_id
    AND allowance#>>'{mutationFence,attemptId}'=attempt_id AND allowance->>'schemaVersion'='0.1'
    AND octet_length(allowance::text)<=4096
    AND (allowance->>'reservedAt')::timestamptz<native_lease_expires_at
    AND native_lease_expires_at<=native_attempt_deadline_at AND native_attempt_deadline_at<=native_job_deadline_at) IS TRUE)
);
ALTER TABLE public.proofstack_policy_acquisition_allowances ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.proofstack_policy_acquisition_allowances FORCE ROW LEVEL SECURITY;
CREATE POLICY proofstack_policy_acquisition_allowance_scope ON public.proofstack_policy_acquisition_allowances
  USING(tenant_id=NULLIF(current_setting('proofstack.tenant_id',true),'')
    AND project_id=NULLIF(current_setting('proofstack.project_id',true),'') AND environment_id=NULLIF(current_setting('proofstack.environment_id',true),''));
REVOKE ALL ON TABLE public.proofstack_policy_acquisition_allowances FROM PUBLIC;
CREATE FUNCTION public.proofstack_protect_policy_acquisition_allowance()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Acquisition allowance history cannot be deleted'; END IF;
  IF (NEW.tenant_id,NEW.project_id,NEW.environment_id,NEW.job_id,NEW.allowance_id,NEW.attempt_id,NEW.allowance)
    IS DISTINCT FROM (OLD.tenant_id,OLD.project_id,OLD.environment_id,OLD.job_id,OLD.allowance_id,OLD.attempt_id,OLD.allowance) THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Original acquisition credit cannot change';
  END IF;
  IF OLD.state<>'reserved' AND NOT(OLD.state=NEW.state AND OLD.observed_usage IS NOT DISTINCT FROM NEW.observed_usage
    AND OLD.closed_at=NEW.closed_at AND NOT OLD.requires_live_commit AND NEW.requires_live_commit) THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Closed acquisition billing is immutable';
  END IF;
  RETURN NEW;
END; $$;
REVOKE ALL ON FUNCTION public.proofstack_protect_policy_acquisition_allowance() FROM PUBLIC;
CREATE TRIGGER proofstack_policy_acquisition_allowance_protect BEFORE UPDATE OR DELETE
  ON public.proofstack_policy_acquisition_allowances FOR EACH ROW EXECUTE FUNCTION public.proofstack_protect_policy_acquisition_allowance();
CREATE TRIGGER proofstack_policy_evaluation_metadata_write_lock AFTER INSERT OR UPDATE OR DELETE
  ON public.proofstack_policy_acquisition_allowances FOR EACH ROW EXECUTE FUNCTION public.proofstack_lock_policy_evaluation_metadata_write();

CREATE FUNCTION public.proofstack_validate_policy_acquisition_allowance(value jsonb, closing boolean)
RETURNS void LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE a jsonb:=value->'acquisitionAllowance'; body jsonb:=value->'job'; u jsonb:=value->'usage';
  base jsonb; limits jsonb; original_limits jsonb:=value#>'{request,limits}';
BEGIN
  IF a IS NULL OR a='null'::jsonb THEN RETURN; END IF;
  base:=a->'usageAtReservation'; limits:=a->'limits';
  IF (jsonb_typeof(a)='object' AND (SELECT count(*) FROM jsonb_object_keys(a))=6
    AND a->>'schemaVersion'='0.1' AND a->>'allowanceId'~'^[a-z][a-z0-9_]{2,63}$'
    AND body->>'status'='acquiring' AND body->'snapshot'='null'::jsonb
    AND (closing OR value->'cancellation'='null'::jsonb)
    AND a->'mutationFence'=body#>'{currentLease,mutationFence}'
    AND a->>'reservedAt'~'^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,30})?Z$'
    AND (a->>'reservedAt')::timestamptz<=(body->>'updatedAt')::timestamptz
    AND (a->>'reservedAt')::timestamptz>=(value->'attempts'->((body->>'attemptCount')::integer-1)->>'startedAt')::timestamptz
    AND jsonb_typeof(base)='object' AND (SELECT count(*) FROM jsonb_object_keys(base))=5
    AND base=jsonb_build_object('reads',u->'reads','records',u->'records','references',u->'references','recordBytes',u->'recordBytes','referenceBytes',u->'referenceBytes')
    AND jsonb_typeof(limits)='object' AND (SELECT count(*) FROM jsonb_object_keys(limits))=4
    AND limits=jsonb_build_object('reads',(original_limits->>'maxAcquisitionRecords')::bigint-(u->>'reads')::bigint,
      'records',(original_limits->>'maxAcquisitionRecords')::bigint-(u->>'records')::bigint,
      'references',(original_limits->>'maxAcquisitionRecords')::bigint-(u->>'references')::bigint,
      'recordAndReferenceBytes',(original_limits->>'maxAcquisitionRecordBytes')::bigint-(u->>'recordBytes')::bigint-(u->>'referenceBytes')::bigint)) IS DISTINCT FROM true THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Acquisition allowance substituted its frozen owning budget';
  END IF;
END; $$;
REVOKE ALL ON FUNCTION public.proofstack_validate_policy_acquisition_allowance(jsonb,boolean) FROM PUBLIC;

CREATE FUNCTION public.proofstack_charge_unknown_policy_acquisition(value jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE a jsonb:=value->'acquisitionAllowance'; u jsonb:=value->'usage'; limits jsonb;
BEGIN
  IF a IS NULL OR a='null'::jsonb THEN RETURN value; END IF;
  PERFORM public.proofstack_validate_policy_acquisition_allowance(value,true);
  limits:=a->'limits';
  u:=u||jsonb_build_object('reads',(u->>'reads')::bigint+(limits->>'reads')::bigint,
    'records',(u->>'records')::bigint+(limits->>'records')::bigint,
    'references',(u->>'references')::bigint+(limits->>'references')::bigint,
    'recordBytes',(u->>'recordBytes')::bigint+(limits->>'recordAndReferenceBytes')::bigint);
  RETURN jsonb_set(jsonb_set(value,'{usage}',u,false),'{acquisitionAllowance}','null'::jsonb,false);
END; $$;
REVOKE ALL ON FUNCTION public.proofstack_charge_unknown_policy_acquisition(jsonb) FROM PUBLIC;

CREATE FUNCTION public.proofstack_close_policy_acquisition_ledger(value jsonb,closure_value jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE a jsonb:=value->'acquisitionAllowance';body jsonb:=value->'job';BEGIN
  IF a IS NULL OR a='null'::jsonb THEN RETURN;END IF;
  UPDATE public.proofstack_policy_acquisition_allowances SET state='uncertain',closed_at=(closure_value->>'committedAt')::timestamptz,requires_live_commit=false
    WHERE tenant_id=body#>>'{scope,tenantId}' AND project_id=body#>>'{scope,projectId}' AND environment_id=body#>>'{scope,environmentId}'
      AND job_id=body->>'jobId' AND allowance_id=a->>'allowanceId' AND allowance=a AND state='reserved';
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Original acquisition credit ledger is missing';END IF;
END; $$;
REVOKE ALL ON FUNCTION public.proofstack_close_policy_acquisition_ledger(jsonb,jsonb) FROM PUBLIC;

CREATE FUNCTION public.proofstack_check_policy_acquisition_commit()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE retained public.proofstack_policy_acquisition_allowances%ROWTYPE;cut timestamptz:=clock_timestamp();
BEGIN
  SELECT * INTO retained FROM public.proofstack_policy_acquisition_allowances WHERE tenant_id=NEW.tenant_id AND project_id=NEW.project_id
    AND environment_id=NEW.environment_id AND job_id=NEW.job_id AND allowance_id=NEW.allowance_id;
  IF retained.requires_live_commit THEN
    PERFORM public.proofstack_assert_current_replay_recovery_epoch((retained.allowance#>>'{mutationFence,recoveryEpoch}')::bigint);
    IF cut>=retained.native_lease_expires_at OR cut>=retained.native_attempt_deadline_at OR cut>=retained.native_job_deadline_at THEN
      RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='Acquisition execution window expired before commit';
    END IF;
  END IF;
  RETURN NULL;
END; $$;
REVOKE ALL ON FUNCTION public.proofstack_check_policy_acquisition_commit() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER proofstack_policy_acquisition_commit AFTER INSERT OR UPDATE ON public.proofstack_policy_acquisition_allowances
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.proofstack_check_policy_acquisition_commit();

-- Preserve all existing admission, scope, projection and close logic. Fail if its exact splice
-- point is absent rather than silently installing a weakened or version-dependent replacement.
DO $$ DECLARE original text; replacement text; marker text; BEGIN
  SELECT pg_get_functiondef('public.proofstack_policy_evaluation_project_job(jsonb)'::regprocedure) INTO original;
  marker:='usage jsonb := value -> ''usage'';'||chr(10)||'BEGIN';
  replacement:=replace(original,marker,marker||chr(10)||'  PERFORM public.proofstack_validate_policy_acquisition_allowance(value,false);');
  IF original=replacement THEN RAISE EXCEPTION 'Original policy projection splice is missing'; END IF;
  EXECUTE replacement;
  SELECT pg_get_functiondef('public.proofstack_policy_evaluation_close_attempt(jsonb,jsonb)'::regprocedure) INTO original;
  marker:='  index_value := jsonb_array_length(attempts_value)-1;';
  replacement:=replace(original,marker,'  PERFORM public.proofstack_close_policy_acquisition_ledger(value,closure_value);'||chr(10)||'  value := public.proofstack_charge_unknown_policy_acquisition(value);'||chr(10)||marker);
  IF original=replacement THEN RAISE EXCEPTION 'Original attempt close splice is missing'; END IF;
  EXECUTE replacement;

  SELECT pg_get_functiondef('public.proofstack_policy_evaluation_close_for_retry(jsonb,text,timestamp with time zone)'::regprocedure) INTO original;
  marker:='  body jsonb := value->''job''; limits jsonb := value#>''{request,limits}''; latest jsonb;';
  replacement:=replace(original,marker,marker||chr(10)||'  acquisition_pending boolean := COALESCE(value->''acquisitionAllowance'',''null''::jsonb)<>''null''::jsonb;');
  IF original=replacement THEN RAISE EXCEPTION 'Original retry declaration splice is missing'; END IF;
  original:=replacement;
  marker:='  value := jsonb_set(value,''{job}'',body,false);';
  replacement:=replace(original,marker,'  IF acquisition_pending THEN body:=body||jsonb_build_object(''status'',''budget_exhausted'',''retryAt'',NULL,''terminal'',jsonb_build_object(''status'',''budget_exhausted'',''code'',''budget_limit_reached'',''attemptId'',latest#>>''{mutationFence,attemptId}'',''committedAt'',lexical)); END IF;'||chr(10)||marker);
  IF original=replacement THEN RAISE EXCEPTION 'Original retry publication splice is missing'; END IF;
  EXECUTE replacement;

  SELECT pg_get_functiondef('public.proofstack_recover_policy_evaluation_job(text)'::regprocedure) INTO original;
  marker:='  was_active boolean; retry_cut timestamptz; terminal_status text; terminal_code text;';
  replacement:=replace(original,marker,marker||chr(10)||'  acquisition_pending boolean;');
  IF original=replacement THEN RAISE EXCEPTION 'Original recovery declaration splice is missing'; END IF;
  original:=replacement;
  marker:='  was_active:=jsonb_typeof(body->''currentLease'')=''object'';';
  replacement:=replace(original,marker,marker||chr(10)||'  acquisition_pending:=COALESCE(value->''acquisitionAllowance'',''null''::jsonb)<>''null''::jsonb;');
  IF original=replacement THEN RAISE EXCEPTION 'Original recovery observation splice is missing'; END IF;
  original:=replacement;
  marker:='  body:=body||jsonb_build_object(''recoveryEpoch'',epoch,';
  replacement:=replace(original,marker,'  IF acquisition_pending AND terminal_status IS NULL THEN terminal_status:=''budget_exhausted'';terminal_code:=''budget_limit_reached''; END IF;'||chr(10)||marker);
  IF original=replacement THEN RAISE EXCEPTION 'Original recovery publication splice is missing'; END IF;
  EXECUTE replacement;

  SELECT pg_get_constraintdef(oid) INTO original FROM pg_constraint
    WHERE conrelid='public.proofstack_policy_evaluation_job_history'::regclass
      AND conname='proofstack_policy_history_projection_complete';
  marker:='(''complete''::character varying)::text';
  replacement:=replace(original,marker,marker||', (''reserve_acquisition''::character varying)::text, (''settle_acquisition''::character varying)::text');
  IF original IS NULL OR original=replacement THEN RAISE EXCEPTION 'Original completion history constraint is missing'; END IF;
  EXECUTE 'ALTER TABLE public.proofstack_policy_evaluation_job_history DROP CONSTRAINT proofstack_policy_history_projection_complete';
  EXECUTE 'ALTER TABLE public.proofstack_policy_evaluation_job_history ADD CONSTRAINT proofstack_policy_history_projection_complete '||replacement;
END; $$;

CREATE FUNCTION public.proofstack_reserve_policy_acquisition(expected_fence jsonb,expected_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE value jsonb:=public.proofstack_policy_evaluation_lock_job(expected_fence->>'jobId');
  body jsonb:=value->'job'; u jsonb:=value->'usage'; l jsonb:=value#>'{request,limits}';
  cut timestamptz:=clock_timestamp(); a jsonb; limits jsonb; lexical text;
BEGIN
  PERFORM public.proofstack_policy_evaluation_assert_fence(value,expected_fence,cut);
  IF expected_id IS NULL OR expected_id!~'^[a-z][a-z0-9_]{2,63}$' OR body->>'status'<>'acquiring'
    OR body->'snapshot'<>'null'::jsonb THEN
    RAISE EXCEPTION USING ERRCODE='40001',MESSAGE='Acquisition requires one original acquiring attempt';
  END IF;
  a:=value->'acquisitionAllowance';
  IF a IS NOT NULL AND a<>'null'::jsonb THEN
    PERFORM public.proofstack_validate_policy_acquisition_allowance(value,false);
    IF a->>'allowanceId' IS DISTINCT FROM expected_id OR a->'mutationFence' IS DISTINCT FROM expected_fence THEN
      RAISE EXCEPTION USING ERRCODE='23505',MESSAGE='Another acquisition allowance is already open';
    END IF;
    RETURN jsonb_build_object('created',false,'snapshot',value,'allowance',a);
  END IF;
  IF EXISTS(SELECT 1 FROM public.proofstack_policy_evaluation_job_history h
    WHERE h.tenant_id=body#>>'{scope,tenantId}' AND h.project_id=body#>>'{scope,projectId}' AND h.environment_id=body#>>'{scope,environmentId}' AND h.job_id=body->>'jobId'
      AND h.entry#>>'{definition,operation,kind}'='reserve_acquisition' AND h.entry#>>'{definition,operation,allowanceId}'=expected_id) THEN
    RAISE EXCEPTION USING ERRCODE='23505',MESSAGE='A closed acquisition occurrence cannot be reused';
  END IF;
  IF (body->>'stateVersion')::bigint=99999 THEN
    RETURN jsonb_build_object('created',false,'snapshot',public.proofstack_policy_evaluation_history_limit(value,cut),'allowance',NULL);
  END IF;
  limits:=jsonb_build_object('reads',(l->>'maxAcquisitionRecords')::bigint-(u->>'reads')::bigint,
    'records',(l->>'maxAcquisitionRecords')::bigint-(u->>'records')::bigint,
    'references',(l->>'maxAcquisitionRecords')::bigint-(u->>'references')::bigint,
    'recordAndReferenceBytes',(l->>'maxAcquisitionRecordBytes')::bigint-(u->>'recordBytes')::bigint-(u->>'referenceBytes')::bigint);
  IF (limits->>'reads')::bigint<1 OR (limits->>'records')::bigint<1 OR (limits->>'recordAndReferenceBytes')::bigint<1
    OR (body->>'stateVersion')::bigint>=100000 THEN
    RAISE EXCEPTION USING ERRCODE='22003',MESSAGE='Acquisition remaining budget or history is exhausted';
  END IF;
  lexical:=public.proofstack_policy_evaluation_utc(cut);
  a:=jsonb_build_object('schemaVersion','0.1','allowanceId',expected_id,'mutationFence',expected_fence,'reservedAt',lexical,
    'usageAtReservation',jsonb_build_object('reads',u->'reads','records',u->'records','references',u->'references','recordBytes',u->'recordBytes','referenceBytes',u->'referenceBytes'),'limits',limits);
  INSERT INTO public.proofstack_policy_acquisition_allowances(tenant_id,project_id,environment_id,job_id,allowance_id,attempt_id,allowance,
    native_lease_expires_at,native_attempt_deadline_at,native_job_deadline_at)
    VALUES(body#>>'{scope,tenantId}',body#>>'{scope,projectId}',body#>>'{scope,environmentId}',body->>'jobId',expected_id,expected_fence->>'attemptId',a,
      (body#>>'{currentLease,expiresAt}')::timestamptz,(body#>>'{currentLease,attemptDeadlineAt}')::timestamptz,(body->>'deadlineAt')::timestamptz);
  value:=jsonb_set(value,'{acquisitionAllowance}',a,true);
  body:=body||jsonb_build_object('updatedAt',lexical,'stateVersion',(body->>'stateVersion')::bigint+1);
  value:=jsonb_set(value,'{job}',body,false);PERFORM public.proofstack_policy_evaluation_project_job(value);
  RETURN jsonb_build_object('created',true,'snapshot',value,'allowance',a);
END; $$;
REVOKE ALL ON FUNCTION public.proofstack_reserve_policy_acquisition(jsonb,text) FROM PUBLIC;

CREATE FUNCTION public.proofstack_settle_policy_acquisition(expected_fence jsonb,expected_id text,observed jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE value jsonb:=public.proofstack_policy_evaluation_lock_job(expected_fence->>'jobId');
  body jsonb:=value->'job'; a jsonb:=value->'acquisitionAllowance'; u jsonb:=value->'usage';
  lease jsonb:=body->'currentLease';
  cut timestamptz:=clock_timestamp(); lexical text; key text; amount bigint; latest jsonb;
BEGIN
  PERFORM public.proofstack_policy_evaluation_assert_fence(value,expected_fence,cut);
  PERFORM public.proofstack_validate_policy_acquisition_allowance(value,false);
  IF a IS NULL OR a='null'::jsonb OR a->>'allowanceId' IS DISTINCT FROM expected_id OR a->'mutationFence' IS DISTINCT FROM expected_fence
    OR (body->>'stateVersion')::bigint>=100000 THEN
    RAISE EXCEPTION USING ERRCODE='40001',MESSAGE='Acquisition settlement has no matching open allowance';
  END IF;
  lexical:=public.proofstack_policy_evaluation_utc(cut);
  IF (body->>'stateVersion')::bigint=99999 THEN
    RETURN public.proofstack_policy_evaluation_history_limit(value,cut);
  END IF;
  IF observed IS NULL OR observed='null'::jsonb THEN
    value:=public.proofstack_policy_evaluation_close_attempt(value,jsonb_build_object('status','budget_exhausted','reason','budget_limit_reached','committedAt',lexical));
    latest:=value->'attempts'->((body->>'attemptCount')::integer-1);
    body:=body||jsonb_build_object('status','budget_exhausted','currentLease',NULL,'retryAt',NULL,
      'terminal',jsonb_build_object('status','budget_exhausted','code','budget_limit_reached','attemptId',latest#>>'{mutationFence,attemptId}','committedAt',lexical));
    UPDATE public.proofstack_policy_acquisition_allowances SET requires_live_commit=true,
      native_lease_expires_at=(lease->>'expiresAt')::timestamptz,
      native_attempt_deadline_at=(lease->>'attemptDeadlineAt')::timestamptz,native_job_deadline_at=(body->>'deadlineAt')::timestamptz
      WHERE tenant_id=body#>>'{scope,tenantId}' AND project_id=body#>>'{scope,projectId}' AND environment_id=body#>>'{scope,environmentId}'
        AND job_id=body->>'jobId' AND allowance_id=expected_id AND state='uncertain';
  ELSE
    IF jsonb_typeof(observed)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(observed))<>5
      OR NOT observed?&ARRAY['reads','records','references','recordBytes','referenceBytes'] THEN
      RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Acquisition observed costs are not strict';
    END IF;
    FOREACH key IN ARRAY ARRAY['reads','records','references','recordBytes','referenceBytes'] LOOP
      IF jsonb_typeof(observed->key)<>'number' OR observed->>key!~'^[0-9]+$' THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Acquisition observed costs must be exact nonnegative integers'; END IF;
      amount:=(observed->>key)::bigint;
      IF key IN ('reads','records','references') AND amount>(a#>>ARRAY['limits',key])::bigint THEN RAISE EXCEPTION USING ERRCODE='22003',MESSAGE='Acquisition count allowance exceeded'; END IF;
      u:=jsonb_set(u,ARRAY[key],to_jsonb((u->>key)::bigint+amount),false);
    END LOOP;
    IF (observed->>'recordBytes')::bigint+(observed->>'referenceBytes')::bigint>(a#>>'{limits,recordAndReferenceBytes}')::bigint THEN
      RAISE EXCEPTION USING ERRCODE='22003',MESSAGE='Acquisition shared byte allowance exceeded';
    END IF;
    value:=jsonb_set(jsonb_set(value,'{usage}',u,false),'{acquisitionAllowance}','null'::jsonb,false);
    UPDATE public.proofstack_policy_acquisition_allowances SET state='observed',observed_usage=observed,closed_at=cut,
      native_lease_expires_at=(body#>>'{currentLease,expiresAt}')::timestamptz,
      native_attempt_deadline_at=(body#>>'{currentLease,attemptDeadlineAt}')::timestamptz,native_job_deadline_at=(body->>'deadlineAt')::timestamptz
      WHERE tenant_id=body#>>'{scope,tenantId}' AND project_id=body#>>'{scope,projectId}' AND environment_id=body#>>'{scope,environmentId}'
        AND job_id=body->>'jobId' AND allowance_id=expected_id AND allowance=a AND state='reserved';
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Original acquisition billing ledger is missing';END IF;
  END IF;
  body:=body||jsonb_build_object('updatedAt',lexical,'stateVersion',(body->>'stateVersion')::bigint+1);
  value:=jsonb_set(value,'{job}',body,false);PERFORM public.proofstack_policy_evaluation_project_job(value);
  RETURN value;
END; $$;
REVOKE ALL ON FUNCTION public.proofstack_settle_policy_acquisition(jsonb,text,jsonb) FROM PUBLIC;
