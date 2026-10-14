-- Native immutable snapshot storage. Publication must retain the owning job/attempt and source
-- guards until its final native expiry check and history commit; these tables confer no authority.
CREATE TABLE public.proofstack_policy_evaluation_snapshots (
  tenant_id varchar(64) NOT NULL,
  project_id varchar(64) NOT NULL,
  environment_id varchar(64) NOT NULL,
  snapshot_id varchar(64) NOT NULL,
  job_id varchar(64) NOT NULL,
  attempt_id varchar(64) NOT NULL,
  definition_sha256 varchar(64) NOT NULL,
  request_id varchar(64) NOT NULL,
  request_sha256 varchar(64) NOT NULL,
  input_sha256 varchar(64) NOT NULL,
  input_byte_length integer NOT NULL,
  frame_count integer NOT NULL,
  page_count smallint NOT NULL,
  sealed_at timestamptz NOT NULL,
  canonical_utf8 text NOT NULL,
  snapshot jsonb NOT NULL,
  PRIMARY KEY (tenant_id, project_id, environment_id, snapshot_id),
  UNIQUE (tenant_id, project_id, environment_id, job_id),
  FOREIGN KEY (tenant_id, project_id, environment_id, job_id, attempt_id)
    REFERENCES public.proofstack_policy_evaluation_attempts,
  FOREIGN KEY (tenant_id, project_id, environment_id, request_id)
    REFERENCES public.proofstack_policy_evaluation_requests,
  CHECK ((snapshot_id ~ '^[a-z][a-z0-9_]{2,63}$'
    AND definition_sha256 ~ '^[0-9a-f]{64}$' AND request_sha256 ~ '^[0-9a-f]{64}$'
    AND input_sha256 ~ '^[0-9a-f]{64}$' AND input_byte_length BETWEEN 1 AND 67108864
    AND frame_count = (input_byte_length + 2047) / 2048
    AND page_count = (frame_count + 127) / 128 AND page_count BETWEEN 1 AND 256) IS TRUE),
  CHECK ((octet_length(canonical_utf8) <= 524288 AND octet_length(snapshot::text) <= 524288
    AND encode(sha256(convert_to(canonical_utf8, 'UTF8')), 'hex') = definition_sha256
    AND (canonical_utf8::jsonb)->>'definitionDomain' = 'proofstack.policy-evaluation-snapshot.v1'
    AND (canonical_utf8::jsonb)->>'encodingVersion' = 'proofstack.policy-evaluation-snapshot-jcs.v1'
    AND (canonical_utf8::jsonb)->'scope' = snapshot->'scope'
    AND ((canonical_utf8::jsonb)-ARRAY['scope','definitionDomain','encodingVersion']) =
      (snapshot-ARRAY['scope','schemaVersion','definitionSha256','sealedAt','sealedByPrincipalId',
        'jobId','attemptId','workerId','leaseId','fencingToken','recoveryEpoch','recordedAt'])
    AND snapshot->>'schemaVersion' = '0.1' AND snapshot->>'snapshotId' = snapshot_id
    AND snapshot->>'definitionSha256' = definition_sha256 AND snapshot->>'jobId' = job_id
    AND snapshot->>'attemptId' = attempt_id AND snapshot#>>'{request,evaluationRequestId}' = request_id
    AND snapshot#>>'{request,definitionSha256}' = request_sha256
    AND snapshot#>>'{scope,tenantId}' = tenant_id AND snapshot#>>'{scope,projectId}' = project_id
    AND snapshot#>>'{scope,environmentId}' = environment_id
    AND snapshot->>'inputSha256' = input_sha256
    AND (snapshot->>'inputByteLength')::integer = input_byte_length
    AND (snapshot->>'frameCount')::integer = frame_count
    AND jsonb_typeof(snapshot->'pages') = 'array' AND jsonb_array_length(snapshot->'pages') = page_count
    AND (snapshot->>'sealedAt')::timestamptz = sealed_at
    AND snapshot->>'sealedByPrincipalId' = snapshot->>'workerId'
    AND (snapshot->>'recordedAt')::timestamptz >= sealed_at
    AND sealed_at >= (snapshot->>'capturedAt')::timestamptz
    AND (snapshot->>'capturedAt')::timestamptz >= (snapshot->>'evaluationTime')::timestamptz) IS TRUE)
);

CREATE TABLE public.proofstack_policy_evaluation_snapshot_pages (
  tenant_id varchar(64) NOT NULL,
  project_id varchar(64) NOT NULL,
  environment_id varchar(64) NOT NULL,
  snapshot_id varchar(64) NOT NULL,
  snapshot_sha256 varchar(64) NOT NULL,
  page_index smallint NOT NULL,
  definition_sha256 varchar(64) NOT NULL,
  canonical_utf8 text NOT NULL,
  page jsonb NOT NULL,
  PRIMARY KEY (tenant_id, project_id, environment_id, snapshot_id, page_index),
  FOREIGN KEY (tenant_id, project_id, environment_id, snapshot_id)
    REFERENCES public.proofstack_policy_evaluation_snapshots DEFERRABLE INITIALLY DEFERRED,
  CHECK ((page_index BETWEEN 0 AND 255 AND snapshot_sha256 ~ '^[0-9a-f]{64}$'
    AND definition_sha256 ~ '^[0-9a-f]{64}$' AND octet_length(canonical_utf8) <= 524288
    AND octet_length(page::text) <= 524288
    AND encode(sha256(convert_to(canonical_utf8, 'UTF8')), 'hex') = definition_sha256
    AND (canonical_utf8::jsonb)->>'definitionDomain' = 'proofstack.policy-evaluation-snapshot-page.v1'
    AND (canonical_utf8::jsonb)->>'encodingVersion' = 'proofstack.policy-evaluation-snapshot-page-jcs.v1'
    AND ((canonical_utf8::jsonb)-ARRAY['definitionDomain','encodingVersion']) =
      (page-ARRAY['schemaVersion','definitionSha256'])
    AND page->>'schemaVersion' = '0.1' AND page->>'snapshotId' = snapshot_id
    AND page->>'definitionSha256' = definition_sha256 AND (page->>'pageIndex')::integer = page_index
    AND page#>>'{scope,tenantId}' = tenant_id AND page#>>'{scope,projectId}' = project_id
    AND page#>>'{scope,environmentId}' = environment_id
    AND jsonb_typeof(page->'frames') = 'array' AND jsonb_array_length(page->'frames') BETWEEN 1 AND 128
    AND (page->>'inputByteLength')::integer BETWEEN 1 AND 67108864
    AND (page->>'frameCount')::integer = ((page->>'inputByteLength')::integer + 2047) / 2048) IS TRUE)
);

DO $$
DECLARE relation text;
BEGIN
  FOREACH relation IN ARRAY ARRAY['proofstack_policy_evaluation_snapshots',
    'proofstack_policy_evaluation_snapshot_pages'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', relation);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', relation);
    EXECUTE format('CREATE POLICY %I ON public.%I USING (tenant_id = NULLIF(current_setting(''proofstack.tenant_id'',true),'''') AND project_id = NULLIF(current_setting(''proofstack.project_id'',true),'''') AND environment_id = NULLIF(current_setting(''proofstack.environment_id'',true),'''')) WITH CHECK (tenant_id = NULLIF(current_setting(''proofstack.tenant_id'',true),'''') AND project_id = NULLIF(current_setting(''proofstack.project_id'',true),'''') AND environment_id = NULLIF(current_setting(''proofstack.environment_id'',true),''''))', relation||'_scope', relation);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.proofstack_reject_append_only_mutation()', relation||'_append_only', relation);
    EXECUTE format('CREATE TRIGGER proofstack_policy_evaluation_metadata_write_lock AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.proofstack_lock_policy_evaluation_metadata_write()', relation);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC', relation);
  END LOOP;
END;
$$;

-- A single same-attempt binding is permitted. Admission identity and a retained closure stay fixed.
CREATE OR REPLACE FUNCTION public.proofstack_guard_policy_evaluation_attempt_projection()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Policy attempt deletion is prohibited'; END IF;
  IF (to_jsonb(NEW)-ARRAY['closed_at','attempt']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['closed_at','attempt'])
    OR OLD.closed_at IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Policy attempt identity or retained closure was changed';
  END IF;
  IF NEW.closed_at IS NULL THEN
    IF (NEW.attempt-ARRAY['phase','snapshot']) IS DISTINCT FROM (OLD.attempt-ARRAY['phase','snapshot'])
      OR OLD.attempt->>'phase' IS DISTINCT FROM 'acquiring' OR OLD.attempt->'snapshot' IS DISTINCT FROM 'null'::jsonb
      OR NEW.attempt->>'phase' IS DISTINCT FROM 'computing' OR jsonb_typeof(NEW.attempt->'snapshot') IS DISTINCT FROM 'object'
      OR NEW.attempt->'closure' IS DISTINCT FROM 'null'::jsonb OR NEW.attempt->'usageAtClose' IS DISTINCT FROM 'null'::jsonb THEN
      RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Policy attempt permits only one admitted snapshot binding';
    END IF;
  ELSIF (NEW.attempt-ARRAY['closure','usageAtClose']) IS DISTINCT FROM (OLD.attempt-ARRAY['closure','usageAtClose'])
    OR NEW.closed_at<OLD.started_at THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Policy attempt identity or retained closure was changed';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.proofstack_guard_policy_evaluation_attempt_projection() FROM PUBLIC;

-- Retain every existing history projection check and extend only the fixed operation vocabulary.
DO $$
DECLARE original_check text; extended_check text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO original_check FROM pg_constraint
    WHERE conrelid='public.proofstack_policy_evaluation_job_history'::regclass
      AND conname='proofstack_policy_history_projection_complete';
  IF original_check IS NULL OR position('''recovery''::character varying' in original_check)=0 THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Original policy history constraint is missing';
  END IF;
  extended_check := replace(original_check, '''recovery''::character varying',
    '''recovery''::character varying, ''seal''::character varying, ''start_computation''::character varying');
  EXECUTE 'ALTER TABLE public.proofstack_policy_evaluation_job_history DROP CONSTRAINT proofstack_policy_history_projection_complete';
  EXECUTE 'ALTER TABLE public.proofstack_policy_evaluation_job_history ADD CONSTRAINT proofstack_policy_history_projection_complete '||extended_check;
END;
$$;

CREATE FUNCTION public.proofstack_policy_snapshot_prepare(expected_fence jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE value jsonb; scoped jsonb:=public.proofstack_policy_evaluation_scope(); cut timestamptz;
BEGIN
  value:=public.proofstack_policy_evaluation_lock_job(expected_fence->>'jobId');
  PERFORM 1 FROM public.proofstack_policy_evaluation_attempts
    WHERE tenant_id=scoped->>'tenantId' AND project_id=scoped->>'projectId'
      AND environment_id=scoped->>'environmentId' AND job_id=expected_fence->>'jobId'
      AND attempt_id=expected_fence->>'attemptId' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='40001', MESSAGE='Policy sealing attempt is absent'; END IF;
  cut:=clock_timestamp();
  PERFORM public.proofstack_policy_evaluation_assert_fence(value,expected_fence,cut);
  IF value#>>'{job,status}' IS DISTINCT FROM 'acquiring' OR value#>'{job,snapshot}' IS DISTINCT FROM 'null'::jsonb THEN
    RAISE EXCEPTION USING ERRCODE='40001', MESSAGE='Policy sealing requires an unsealed acquiring job';
  END IF;
  RETURN value;
END;
$$;
REVOKE ALL ON FUNCTION public.proofstack_policy_snapshot_prepare(jsonb) FROM PUBLIC;

CREATE FUNCTION public.proofstack_policy_snapshot_io_budget(expected_fence jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE value jsonb:=public.proofstack_policy_snapshot_prepare(expected_fence); body jsonb:=value->'job';
  lease jsonb:=body->'currentLease'; cut timestamptz:=clock_timestamp(); expiry timestamptz; remaining integer;
BEGIN
  expiry:=LEAST((body->>'deadlineAt')::timestamptz,(lease->>'expiresAt')::timestamptz,(lease->>'attemptDeadlineAt')::timestamptz);
  PERFORM public.proofstack_policy_evaluation_assert_fence(value,expected_fence,cut);
  remaining:=LEAST(15000,floor(extract(epoch FROM (expiry-cut))*1000))::integer;
  IF remaining<=0 THEN RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='Policy sealing lacks one complete native millisecond'; END IF;
  RETURN jsonb_build_object('scope',body->'scope','job',jsonb_build_object('jobId',body->>'jobId','definitionSha256',body->>'definitionSha256'),
    'stateVersion',(body->>'stateVersion')::bigint,'observedAt',public.proofstack_policy_evaluation_utc(cut),'remainingMilliseconds',remaining);
END;
$$;
REVOKE ALL ON FUNCTION public.proofstack_policy_snapshot_io_budget(jsonb) FROM PUBLIC;

-- Fenced wrappers leave the original unbound reader guards private.
CREATE FUNCTION public.proofstack_try_lock_policy_snapshot_metadata(expected_fence jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE value jsonb:=public.proofstack_policy_snapshot_prepare(expected_fence);
BEGIN
  RETURN public.proofstack_try_lock_policy_evaluation_metadata();
END;
$$;
REVOKE ALL ON FUNCTION public.proofstack_try_lock_policy_snapshot_metadata(jsonb) FROM PUBLIC;

CREATE FUNCTION public.proofstack_try_lock_policy_snapshot_source(expected_fence jsonb, source_kind text, source_id text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE value jsonb:=public.proofstack_policy_evaluation_lock_job(expected_fence->>'jobId');
BEGIN
  PERFORM public.proofstack_policy_evaluation_assert_fence(value,expected_fence,clock_timestamp());
  IF value#>>'{job,status}' IS DISTINCT FROM 'acquiring' THEN
    RAISE EXCEPTION USING ERRCODE='40001', MESSAGE='Policy source guards require acquiring state';
  END IF;
  RETURN public.proofstack_try_lock_policy_evaluation_source(source_kind,source_id);
END;
$$;
REVOKE ALL ON FUNCTION public.proofstack_try_lock_policy_snapshot_source(jsonb,text,text) FROM PUBLIC;

CREATE FUNCTION public.proofstack_assert_policy_snapshot_metadata_guard()
RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE scoped jsonb:=public.proofstack_policy_evaluation_scope(); resource bigint;
BEGIN
  resource:=hashtextextended(jsonb_build_array('proofstack.policy-evaluation-metadata.v1',scoped->>'tenantId')::text,0);
  IF current_setting('transaction_isolation')<>'read committed' OR NOT EXISTS (
    SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory'
      AND classid::bigint=((resource>>32)&4294967295) AND objid::bigint=(resource&4294967295)
      AND objsubid=1 AND mode='ExclusiveLock' AND granted) THEN
    RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='Policy publication requires its still-held metadata guard';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.proofstack_assert_policy_snapshot_metadata_guard() FROM PUBLIC;

CREATE FUNCTION public.proofstack_stage_policy_snapshot_page(
  expected_fence jsonb, expected_snapshot_sha256 text, canonical_value text, expected_page_sha256 text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE scoped jsonb:=public.proofstack_policy_evaluation_scope(); value jsonb;
  definition jsonb; body jsonb;
BEGIN
  PERFORM public.proofstack_assert_policy_snapshot_metadata_guard();
  value:=public.proofstack_policy_evaluation_lock_job(expected_fence->>'jobId');
  PERFORM public.proofstack_policy_evaluation_assert_fence(value,expected_fence,clock_timestamp());
  IF value#>>'{job,status}' IS DISTINCT FROM 'acquiring' OR octet_length(canonical_value)>524288 THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Policy snapshot page admission failed';
  END IF;
  definition:=canonical_value::jsonb;
  IF definition->'scope' IS DISTINCT FROM scoped OR definition->'request' IS DISTINCT FROM value#>'{job,request}' THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Policy page substituted exact scope or owning request';
  END IF;
  body:=(definition-ARRAY['definitionDomain','encodingVersion'])||jsonb_build_object(
    'schemaVersion','0.1','definitionSha256',expected_page_sha256);
  INSERT INTO public.proofstack_policy_evaluation_snapshot_pages VALUES (
    scoped->>'tenantId',scoped->>'projectId',scoped->>'environmentId',body->>'snapshotId',
    expected_snapshot_sha256,(body->>'pageIndex')::smallint,expected_page_sha256,canonical_value,body);
END;
$$;
REVOKE ALL ON FUNCTION public.proofstack_stage_policy_snapshot_page(jsonb,text,text,text) FROM PUBLIC;

CREATE FUNCTION public.proofstack_publish_policy_snapshot(
  expected_fence jsonb, canonical_value text, expected_snapshot_sha256 text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE scoped jsonb:=public.proofstack_policy_evaluation_scope(); value jsonb; definition jsonb;
  body jsonb; attempt_value jsonb; reference jsonb; cut timestamptz; lexical text;
BEGIN
  PERFORM public.proofstack_assert_policy_snapshot_metadata_guard();
  value:=public.proofstack_policy_evaluation_lock_job(expected_fence->>'jobId');
  cut:=clock_timestamp();
  PERFORM public.proofstack_policy_evaluation_assert_fence(value,expected_fence,cut);
  IF value#>>'{job,status}' IS DISTINCT FROM 'acquiring' OR value#>'{job,snapshot}' IS DISTINCT FROM 'null'::jsonb
    OR (value#>>'{job,stateVersion}')::integer>=99999 OR octet_length(canonical_value)>524288 THEN
    RAISE EXCEPTION USING ERRCODE='40001', MESSAGE='Policy snapshot publication state/admission rejected';
  END IF;
  definition:=canonical_value::jsonb;
  IF definition->'scope' IS DISTINCT FROM scoped OR definition->'request' IS DISTINCT FROM value#>'{job,request}'
    OR definition->'candidate' IS DISTINCT FROM value#>'{request,candidate}'
    OR definition->'policy' IS DISTINCT FROM value#>'{request,policy}'
    OR definition->'algorithm' IS DISTINCT FROM value#>'{request,algorithm}'
    OR definition->>'evaluationTime' IS DISTINCT FROM value#>>'{request,evaluationTime}'
    OR (definition->>'capturedAt')::timestamptz>(cut) THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Policy snapshot substituted immutable request inputs';
  END IF;
  lexical:=public.proofstack_policy_evaluation_utc(cut);
  body:=(definition-ARRAY['definitionDomain','encodingVersion'])||jsonb_build_object(
    'schemaVersion','0.1','definitionSha256',expected_snapshot_sha256,'sealedAt',lexical,'recordedAt',lexical,
    'sealedByPrincipalId',expected_fence->>'workerId','jobId',expected_fence->>'jobId',
    'attemptId',expected_fence->>'attemptId','workerId',expected_fence->>'workerId',
    'leaseId',expected_fence->>'leaseId','fencingToken',(expected_fence->>'fencingToken')::bigint,
    'recoveryEpoch',(expected_fence->>'recoveryEpoch')::bigint);
  INSERT INTO public.proofstack_policy_evaluation_snapshots VALUES (
    scoped->>'tenantId',scoped->>'projectId',scoped->>'environmentId',body->>'snapshotId',
    expected_fence->>'jobId',expected_fence->>'attemptId',expected_snapshot_sha256,
    body#>>'{request,evaluationRequestId}',body#>>'{request,definitionSha256}',body->>'inputSha256',
    (body->>'inputByteLength')::integer,(body->>'frameCount')::integer,jsonb_array_length(body->'pages'),
    cut,canonical_value,body);
  reference:=jsonb_build_object('snapshotId',body->>'snapshotId','definitionSha256',expected_snapshot_sha256);
  attempt_value:=value->'attempts'->((value#>>'{job,attemptCount}')::integer-1);
  IF attempt_value->>'phase' IS DISTINCT FROM 'acquiring' OR attempt_value->'snapshot' IS DISTINCT FROM 'null'::jsonb THEN
    RAISE EXCEPTION USING ERRCODE='40001', MESSAGE='Policy seal cannot replace its original attempt binding';
  END IF;
  attempt_value:=attempt_value||jsonb_build_object('phase','computing','snapshot',reference);
  UPDATE public.proofstack_policy_evaluation_attempts SET attempt=attempt_value
    WHERE tenant_id=scoped->>'tenantId' AND project_id=scoped->>'projectId' AND environment_id=scoped->>'environmentId'
      AND job_id=expected_fence->>'jobId' AND attempt_id=expected_fence->>'attemptId';
  value:=jsonb_set(value,ARRAY['attempts',((value#>>'{job,attemptCount}')::integer-1)::text],attempt_value,false);
  value:=jsonb_set(value,'{job}',(value->'job')||jsonb_build_object('snapshot',reference,'status','sealed',
    'stateVersion',(value#>>'{job,stateVersion}')::bigint+1,'updatedAt',lexical),false);
  PERFORM public.proofstack_policy_evaluation_project_job(value);
  RETURN jsonb_build_object('snapshot',body,'job',value);
END;
$$;
REVOKE ALL ON FUNCTION public.proofstack_publish_policy_snapshot(jsonb,text,text) FROM PUBLIC;

CREATE FUNCTION public.proofstack_verify_policy_snapshot_page()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE root public.proofstack_policy_evaluation_snapshots%ROWTYPE; descriptor jsonb;
  frame jsonb; frame_position integer:=0; expected_index integer; encoded text; decoded bytea;
  original_tenant text:=current_setting('proofstack.tenant_id',true);
  original_project text:=current_setting('proofstack.project_id',true);
  original_environment text:=current_setting('proofstack.environment_id',true);
BEGIN
  PERFORM set_config('proofstack.tenant_id',NEW.tenant_id,true),set_config('proofstack.project_id',NEW.project_id,true),set_config('proofstack.environment_id',NEW.environment_id,true);
  SELECT * INTO root FROM public.proofstack_policy_evaluation_snapshots WHERE tenant_id=NEW.tenant_id
    AND project_id=NEW.project_id AND environment_id=NEW.environment_id AND snapshot_id=NEW.snapshot_id;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Policy snapshot page has no owning root'; END IF;
  descriptor:=root.snapshot->'pages'->NEW.page_index;
  IF NEW.snapshot_sha256 IS DISTINCT FROM root.definition_sha256
    OR NEW.page->'request' IS DISTINCT FROM root.snapshot->'request'
    OR NEW.page->>'inputSha256' IS DISTINCT FROM root.input_sha256
    OR (NEW.page->>'inputByteLength')::integer IS DISTINCT FROM root.input_byte_length
    OR (NEW.page->>'frameCount')::integer IS DISTINCT FROM root.frame_count
    OR (descriptor->>'pageIndex')::integer IS DISTINCT FROM NEW.page_index
    OR descriptor->>'definitionSha256' IS DISTINCT FROM NEW.definition_sha256
    OR (descriptor->>'firstFrameIndex')::integer IS DISTINCT FROM NEW.page_index*128
    OR (descriptor->>'frameCount')::integer IS DISTINCT FROM LEAST(128,root.frame_count-NEW.page_index*128)
    OR jsonb_array_length(NEW.page->'frames') IS DISTINCT FROM (descriptor->>'frameCount')::integer THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Policy snapshot page differs from its complete root descriptor';
  END IF;
  FOR frame IN SELECT item FROM jsonb_array_elements(NEW.page->'frames') AS rows(item) LOOP
    expected_index:=NEW.page_index*128+frame_position;
    encoded:=frame->>'dataBase64url';
    IF (frame->>'frameIndex')::integer IS DISTINCT FROM expected_index OR encoded IS NULL
      OR length(encoded) NOT BETWEEN 2 AND 2731 OR encoded !~ '^[A-Za-z0-9_-]+$' OR length(encoded)%4=1 THEN
      RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Policy snapshot frame coordinates or alphabet are invalid';
    END IF;
    decoded:=decode(translate(encoded,'-_','+/')||repeat('=',(4-length(encoded)%4)%4),'base64');
    IF octet_length(decoded)<>LEAST(2048,root.input_byte_length-expected_index*2048)
      OR translate(rtrim(replace(encode(decoded,'base64'),chr(10),''),'='),'+/','-_')<>encoded THEN
      RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Policy snapshot frame is not canonical or has substituted length';
    END IF;
    frame_position:=frame_position+1;
  END LOOP;
  PERFORM set_config('proofstack.tenant_id',COALESCE(original_tenant,''),true),set_config('proofstack.project_id',COALESCE(original_project,''),true),set_config('proofstack.environment_id',COALESCE(original_environment,''),true);
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.proofstack_verify_policy_snapshot_page() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER proofstack_policy_snapshot_page_complete AFTER INSERT ON public.proofstack_policy_evaluation_snapshot_pages
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.proofstack_verify_policy_snapshot_page();

CREATE FUNCTION public.proofstack_verify_policy_snapshot_root()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE value jsonb; fence jsonb; retained_request jsonb; input_bytes bytea; inputs jsonb;
  pages integer; frames integer; cut timestamptz;
  original_tenant text:=current_setting('proofstack.tenant_id',true);
  original_project text:=current_setting('proofstack.project_id',true);
  original_environment text:=current_setting('proofstack.environment_id',true);
BEGIN
  PERFORM set_config('proofstack.tenant_id',NEW.tenant_id,true),set_config('proofstack.project_id',NEW.project_id,true),set_config('proofstack.environment_id',NEW.environment_id,true);
  SELECT count(*) INTO pages FROM public.proofstack_policy_evaluation_snapshot_pages
    WHERE tenant_id=NEW.tenant_id AND project_id=NEW.project_id AND environment_id=NEW.environment_id
      AND snapshot_id=NEW.snapshot_id;
  IF pages<>NEW.page_count THEN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Policy snapshot omitted or added a page'; END IF;
  SELECT count(*),string_agg(decode(translate(frame->>'dataBase64url','-_','+/')||
      repeat('=',(4-length(frame->>'dataBase64url')%4)%4),'base64'),''::bytea ORDER BY p.page_index,ordinal)
    INTO frames,input_bytes
    FROM public.proofstack_policy_evaluation_snapshot_pages p
    CROSS JOIN LATERAL jsonb_array_elements(p.page->'frames') WITH ORDINALITY AS rows(frame,ordinal)
    WHERE p.tenant_id=NEW.tenant_id AND p.project_id=NEW.project_id AND p.environment_id=NEW.environment_id
      AND p.snapshot_id=NEW.snapshot_id;
  IF frames<>NEW.frame_count OR octet_length(input_bytes) IS DISTINCT FROM NEW.input_byte_length
    OR encode(sha256(input_bytes),'hex') IS DISTINCT FROM NEW.input_sha256 THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Policy snapshot input bytes do not match its retained identity';
  END IF;
  inputs:=convert_from(input_bytes,'UTF8')::jsonb;
  SELECT request INTO retained_request FROM public.proofstack_policy_evaluation_requests
    WHERE tenant_id=NEW.tenant_id AND project_id=NEW.project_id AND environment_id=NEW.environment_id
      AND request_id=NEW.request_id;
  IF inputs->>'schemaVersion' IS DISTINCT FROM '0.2'
    OR inputs->>'definitionDomain' IS DISTINCT FROM 'proofstack.policy-evaluation-snapshot-inputs.v2'
    OR inputs->>'encodingVersion' IS DISTINCT FROM 'proofstack.policy-evaluation-snapshot-inputs-jcs.v2'
    OR inputs->'request' IS DISTINCT FROM retained_request
    OR inputs->>'capturedAt' IS DISTINCT FROM NEW.snapshot->>'capturedAt'
    OR inputs#>>'{sources,logicalRoots,configuration}' IS DISTINCT FROM 'configured' THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Policy seal requires current complete versioned request inputs';
  END IF;
  value:=public.proofstack_read_policy_evaluation_job(NEW.job_id);
  fence:=jsonb_build_object('jobId',NEW.job_id,'attemptId',NEW.attempt_id,'workerId',NEW.snapshot->>'workerId',
    'leaseId',NEW.snapshot->>'leaseId','fencingToken',(NEW.snapshot->>'fencingToken')::bigint,
    'recoveryEpoch',(NEW.snapshot->>'recoveryEpoch')::bigint);
  IF value#>>'{job,status}' IS DISTINCT FROM 'sealed'
    OR value#>'{job,snapshot}' IS DISTINCT FROM jsonb_build_object('snapshotId',NEW.snapshot_id,'definitionSha256',NEW.definition_sha256)
    OR value#>>'{job,updatedAt}' IS DISTINCT FROM NEW.snapshot->>'sealedAt' THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Policy snapshot is not bound to its atomically sealed job';
  END IF;
  PERFORM public.proofstack_assert_policy_snapshot_metadata_guard();
  cut:=clock_timestamp();
  PERFORM public.proofstack_policy_evaluation_assert_fence(value,fence,cut);
  PERFORM set_config('proofstack.tenant_id',COALESCE(original_tenant,''),true),set_config('proofstack.project_id',COALESCE(original_project,''),true),set_config('proofstack.environment_id',COALESCE(original_environment,''),true);
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.proofstack_verify_policy_snapshot_root() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER proofstack_policy_snapshot_root_complete AFTER INSERT ON public.proofstack_policy_evaluation_snapshots
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.proofstack_verify_policy_snapshot_root();

-- Enqueued by the final history INSERT, after page/root/job integrity checks. Fresh authority
-- must survive all deferred work, not just the earlier application-level publication receipt.
CREATE FUNCTION public.proofstack_verify_policy_snapshot_commit_fence()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE value jsonb; cut timestamptz;
  original_tenant text:=current_setting('proofstack.tenant_id',true);
  original_project text:=current_setting('proofstack.project_id',true);
  original_environment text:=current_setting('proofstack.environment_id',true);
BEGIN
  PERFORM set_config('proofstack.tenant_id',NEW.tenant_id,true),set_config('proofstack.project_id',NEW.project_id,true),set_config('proofstack.environment_id',NEW.environment_id,true);
  value:=public.proofstack_read_policy_evaluation_job(NEW.job_id);
  IF value#>>'{job,status}' IS DISTINCT FROM 'sealed'
    OR (value#>>'{job,stateVersion}')::bigint IS DISTINCT FROM NEW.sequence+1
    OR value#>'{job,snapshot}' IS DISTINCT FROM NEW.entry#>'{definition,operation,snapshot}' THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Policy seal history is not the final publication state';
  END IF;
  PERFORM public.proofstack_assert_policy_snapshot_metadata_guard();
  cut:=clock_timestamp();
  PERFORM public.proofstack_policy_evaluation_assert_fence(value,NEW.entry#>'{definition,operation,fence}',cut);
  PERFORM set_config('proofstack.tenant_id',COALESCE(original_tenant,''),true),set_config('proofstack.project_id',COALESCE(original_project,''),true),set_config('proofstack.environment_id',COALESCE(original_environment,''),true);
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.proofstack_verify_policy_snapshot_commit_fence() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER proofstack_policy_snapshot_commit_fence AFTER INSERT ON public.proofstack_policy_evaluation_job_history
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.operation='seal')
  EXECUTE FUNCTION public.proofstack_verify_policy_snapshot_commit_fence();

CREATE FUNCTION public.proofstack_read_policy_snapshot(expected_snapshot_id text, expected_snapshot_sha256 text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE scoped jsonb:=public.proofstack_policy_evaluation_scope(); body jsonb; value jsonb;
BEGIN
  SELECT snapshot INTO body FROM public.proofstack_policy_evaluation_snapshots
    WHERE tenant_id=scoped->>'tenantId' AND project_id=scoped->>'projectId'
      AND environment_id=scoped->>'environmentId' AND snapshot_id=expected_snapshot_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF body->>'definitionSha256' IS DISTINCT FROM expected_snapshot_sha256 THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Policy snapshot reference hash is substituted';
  END IF;
  value:=public.proofstack_read_policy_evaluation_job(body->>'jobId');
  IF value#>'{job,snapshot}' IS DISTINCT FROM jsonb_build_object('snapshotId',expected_snapshot_id,'definitionSha256',expected_snapshot_sha256)
    OR value#>'{job,request}' IS DISTINCT FROM body->'request' THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Policy snapshot owning job/request binding is invalid';
  END IF;
  RETURN body;
END;
$$;
REVOKE ALL ON FUNCTION public.proofstack_read_policy_snapshot(text,text) FROM PUBLIC;

CREATE FUNCTION public.proofstack_read_policy_snapshot_page(
  expected_snapshot_id text, expected_snapshot_sha256 text, expected_page_index integer)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE scoped jsonb:=public.proofstack_policy_evaluation_scope(); root jsonb; body jsonb;
BEGIN
  root:=public.proofstack_read_policy_snapshot(expected_snapshot_id,expected_snapshot_sha256);
  IF root IS NULL THEN RETURN NULL; END IF;
  IF expected_page_index IS NULL OR expected_page_index<0 OR expected_page_index>=jsonb_array_length(root->'pages') THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Policy snapshot page index is outside its exact root';
  END IF;
  SELECT page INTO body FROM public.proofstack_policy_evaluation_snapshot_pages
    WHERE tenant_id=scoped->>'tenantId' AND project_id=scoped->>'projectId'
      AND environment_id=scoped->>'environmentId' AND snapshot_id=expected_snapshot_id AND page_index=expected_page_index;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Policy snapshot page is missing'; END IF;
  IF body->>'definitionSha256' IS DISTINCT FROM root->'pages'->expected_page_index->>'definitionSha256' THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Policy snapshot page descriptor is substituted';
  END IF;
  RETURN body;
END;
$$;
REVOKE ALL ON FUNCTION public.proofstack_read_policy_snapshot_page(text,text,integer) FROM PUBLIC;
