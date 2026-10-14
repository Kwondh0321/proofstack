-- Durable operational policy jobs. Snapshot/result publication is a separate held-guard protocol.
CREATE TABLE public.proofstack_policy_evaluation_requests (
  tenant_id varchar(64) NOT NULL,
  project_id varchar(64) NOT NULL,
  environment_id varchar(64) NOT NULL,
  request_id varchar(64) NOT NULL,
  definition_sha256 char(64) NOT NULL,
  created_at timestamptz NOT NULL,
  created_at_lexical text NOT NULL,
  created_by_principal_id varchar(64) NOT NULL,
  request jsonb NOT NULL,
  PRIMARY KEY (tenant_id, project_id, environment_id, request_id),
  UNIQUE (tenant_id, project_id, environment_id, request_id, definition_sha256),
  CHECK ((definition_sha256 ~ '^[0-9a-f]{64}$') IS TRUE),
  CHECK ((request ->> 'schemaVersion' = '0.1') IS TRUE),
  CHECK ((request ->> 'evaluationRequestId' = request_id) IS TRUE),
  CHECK ((request ->> 'definitionSha256' = definition_sha256) IS TRUE),
  CHECK ((request #>> '{scope,tenantId}' = tenant_id AND request #>> '{scope,projectId}' = project_id AND request #>> '{scope,environmentId}' = environment_id) IS TRUE),
  CHECK ((request ->> 'createdAt' = created_at_lexical AND created_at_lexical::timestamptz = created_at) IS TRUE),
  CHECK ((request ->> 'createdByPrincipalId' = created_by_principal_id) IS TRUE),
  CHECK ((jsonb_typeof(request) = 'object' AND octet_length(request::text) <= 16384) IS TRUE)
);

CREATE TABLE public.proofstack_policy_evaluation_jobs (
  tenant_id varchar(64) NOT NULL,
  project_id varchar(64) NOT NULL,
  environment_id varchar(64) NOT NULL,
  job_id varchar(64) NOT NULL,
  request_id varchar(64) NOT NULL,
  request_sha256 char(64) NOT NULL,
  definition_sha256 char(64) NOT NULL,
  status varchar(32) NOT NULL,
  state_version bigint NOT NULL,
  recovery_epoch bigint NOT NULL,
  last_fencing_token bigint NOT NULL,
  attempt_count smallint NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  deadline_at timestamptz NOT NULL,
  attempt_id varchar(64),
  lease_id varchar(64),
  worker_id varchar(64),
  lease_expires_at timestamptz,
  attempt_deadline_at timestamptz,
  retry_at timestamptz,
  usage_reads bigint NOT NULL,
  usage_records bigint NOT NULL,
  usage_record_bytes bigint NOT NULL,
  usage_references bigint NOT NULL,
  usage_reference_bytes bigint NOT NULL,
  usage_artifact_bytes bigint NOT NULL,
  usage_rule_evaluations bigint NOT NULL,
  snapshot jsonb NOT NULL,
  PRIMARY KEY (tenant_id, project_id, environment_id, job_id),
  UNIQUE (tenant_id, project_id, environment_id, job_id, definition_sha256),
  UNIQUE (tenant_id, project_id, environment_id, request_id),
  FOREIGN KEY (tenant_id, project_id, environment_id, request_id, request_sha256)
    REFERENCES public.proofstack_policy_evaluation_requests (tenant_id, project_id, environment_id, request_id, definition_sha256),
  CHECK ((definition_sha256 ~ '^[0-9a-f]{64}$') IS TRUE),
  CHECK ((state_version BETWEEN 1 AND 100000 AND recovery_epoch BETWEEN 0 AND 9007199254740991 AND last_fencing_token BETWEEN 0 AND 9007199254740991 AND attempt_count BETWEEN 0 AND 8) IS TRUE),
  CHECK ((status IN ('queued','acquiring','sealed','running','retry_ready','completed','failed','timed_out','budget_exhausted','cancelled')) IS TRUE),
  CHECK ((deadline_at > created_at AND updated_at >= created_at AND isfinite(deadline_at)) IS TRUE),
  CHECK ((usage_reads BETWEEN 0 AND 100000 AND usage_records BETWEEN 0 AND 100000 AND usage_references BETWEEN 0 AND 100000 AND usage_record_bytes BETWEEN 0 AND 67108864 AND usage_reference_bytes BETWEEN 0 AND 67108864 AND usage_record_bytes + usage_reference_bytes <= 67108864 AND usage_artifact_bytes BETWEEN 0 AND 268435456 AND usage_rule_evaluations BETWEEN 0 AND 1024) IS TRUE),
  CHECK ((snapshot #>> '{job,jobId}' = job_id AND snapshot #>> '{job,definitionSha256}' = definition_sha256 AND snapshot #>> '{job,status}' = status) IS TRUE),
  CHECK (((snapshot #>> '{job,stateVersion}')::bigint = state_version AND (snapshot #>> '{job,recoveryEpoch}')::bigint = recovery_epoch AND (snapshot #>> '{job,lastFencingToken}')::bigint = last_fencing_token AND (snapshot #>> '{job,attemptCount}')::int = attempt_count) IS TRUE),
  CHECK ((snapshot #>> '{job,scope,tenantId}' = tenant_id AND snapshot #>> '{job,scope,projectId}' = project_id AND snapshot #>> '{job,scope,environmentId}' = environment_id) IS TRUE),
  CHECK (((snapshot #>> '{job,createdAt}')::timestamptz = created_at AND (snapshot #>> '{job,updatedAt}')::timestamptz = updated_at AND (snapshot #>> '{job,deadlineAt}')::timestamptz = deadline_at) IS TRUE),
  CHECK (((snapshot #>> '{usage,reads}')::bigint = usage_reads AND (snapshot #>> '{usage,records}')::bigint = usage_records AND (snapshot #>> '{usage,recordBytes}')::bigint = usage_record_bytes AND (snapshot #>> '{usage,references}')::bigint = usage_references AND (snapshot #>> '{usage,referenceBytes}')::bigint = usage_reference_bytes AND (snapshot #>> '{usage,artifactReadBytes}')::bigint = usage_artifact_bytes AND (snapshot #>> '{usage,ruleEvaluations}')::bigint = usage_rule_evaluations) IS TRUE),
  CHECK ((jsonb_typeof(snapshot) = 'object' AND octet_length(snapshot::text) <= 65536) IS TRUE)
);

CREATE TABLE public.proofstack_policy_evaluation_attempts (
  tenant_id varchar(64) NOT NULL,
  project_id varchar(64) NOT NULL,
  environment_id varchar(64) NOT NULL,
  job_id varchar(64) NOT NULL,
  attempt_id varchar(64) NOT NULL,
  attempt_sequence smallint NOT NULL,
  lease_id varchar(64) NOT NULL,
  worker_id varchar(64) NOT NULL,
  fencing_token bigint NOT NULL,
  recovery_epoch bigint NOT NULL,
  started_at timestamptz NOT NULL,
  deadline_at timestamptz NOT NULL,
  closed_at timestamptz,
  attempt jsonb NOT NULL,
  PRIMARY KEY (tenant_id, project_id, environment_id, job_id, attempt_id),
  UNIQUE (tenant_id, project_id, environment_id, job_id, attempt_sequence),
  UNIQUE (tenant_id, project_id, environment_id, job_id, lease_id),
  FOREIGN KEY (tenant_id, project_id, environment_id, job_id) REFERENCES public.proofstack_policy_evaluation_jobs,
  CHECK ((attempt_sequence BETWEEN 0 AND 7 AND fencing_token BETWEEN 1 AND 9007199254740991 AND recovery_epoch BETWEEN 0 AND 9007199254740991 AND deadline_at > started_at) IS TRUE),
  CHECK ((attempt #>> '{mutationFence,jobId}' = job_id AND attempt #>> '{mutationFence,attemptId}' = attempt_id AND attempt #>> '{mutationFence,leaseId}' = lease_id AND attempt #>> '{mutationFence,workerId}' = worker_id AND (attempt #>> '{mutationFence,fencingToken}')::bigint = fencing_token AND (attempt #>> '{mutationFence,recoveryEpoch}')::bigint = recovery_epoch) IS TRUE),
  CHECK (((attempt ->> 'attemptSequence')::int = attempt_sequence AND (attempt ->> 'startedAt')::timestamptz = started_at AND (attempt ->> 'deadlineAt')::timestamptz = deadline_at) IS TRUE),
  CHECK ((jsonb_typeof(attempt) = 'object' AND octet_length(attempt::text) <= 4096) IS TRUE)
);

CREATE TABLE public.proofstack_policy_evaluation_cancellations (
  tenant_id varchar(64) NOT NULL,
  project_id varchar(64) NOT NULL,
  environment_id varchar(64) NOT NULL,
  job_id varchar(64) NOT NULL,
  cancellation_id varchar(64) NOT NULL,
  principal_id varchar(64) NOT NULL,
  reason varchar(32) NOT NULL,
  requested_at timestamptz NOT NULL,
  intent jsonb NOT NULL,
  PRIMARY KEY (tenant_id, project_id, environment_id, job_id),
  FOREIGN KEY (tenant_id, project_id, environment_id, job_id) REFERENCES public.proofstack_policy_evaluation_jobs,
  CHECK ((intent ->> 'jobId' = job_id AND intent ->> 'cancellationId' = cancellation_id AND intent ->> 'requestedByPrincipalId' = principal_id AND intent ->> 'reason' = reason AND (intent ->> 'requestedAt')::timestamptz = requested_at) IS TRUE),
  CHECK ((jsonb_typeof(intent) = 'object' AND octet_length(intent::text) <= 2048) IS TRUE)
);

CREATE TABLE public.proofstack_policy_evaluation_job_history (
  tenant_id varchar(64) NOT NULL,
  project_id varchar(64) NOT NULL,
  environment_id varchar(64) NOT NULL,
  job_id varchar(64) NOT NULL,
  sequence integer NOT NULL,
  entry_sha256 char(64) NOT NULL,
  previous_entry_sha256 char(64),
  graph_sha256 char(64) NOT NULL,
  committed_at timestamptz NOT NULL,
  operation varchar(32) NOT NULL,
  canonical_utf8 text NOT NULL,
  entry jsonb NOT NULL,
  PRIMARY KEY (tenant_id, project_id, environment_id, job_id, sequence),
  FOREIGN KEY (tenant_id, project_id, environment_id, job_id) REFERENCES public.proofstack_policy_evaluation_jobs,
  CHECK ((sequence BETWEEN 0 AND 99999 AND entry_sha256 ~ '^[0-9a-f]{64}$' AND graph_sha256 ~ '^[0-9a-f]{64}$') IS TRUE),
  CHECK (((entry #>> '{definition,sequence}')::int = sequence AND entry ->> 'entrySha256' = entry_sha256 AND entry #>> '{definition,graphSha256}' = graph_sha256 AND entry #>> '{definition,operation,kind}' = operation AND (entry #>> '{definition,committedAt}')::timestamptz = committed_at) IS TRUE),
  CHECK ((entry #>> '{definition,predecessorEntrySha256}' IS NOT DISTINCT FROM previous_entry_sha256) IS TRUE),
  CHECK ((encode(sha256(convert_to(canonical_utf8, 'UTF8')), 'hex') = entry_sha256) IS TRUE),
  CHECK ((canonical_utf8::jsonb -> 'definition' = entry -> 'definition') IS TRUE),
  CHECK ((octet_length(canonical_utf8) <= 4096 AND octet_length(entry::text) <= 4096) IS TRUE)
);

CREATE TABLE public.proofstack_policy_evaluation_reservations (
  tenant_id varchar(64) NOT NULL,
  project_id varchar(64) NOT NULL,
  environment_id varchar(64) NOT NULL,
  job_id varchar(64) NOT NULL,
  reservation_id varchar(64) NOT NULL,
  history_sequence integer NOT NULL,
  PRIMARY KEY (tenant_id, project_id, environment_id, job_id, reservation_id),
  FOREIGN KEY (tenant_id, project_id, environment_id, job_id, history_sequence)
    REFERENCES public.proofstack_policy_evaluation_job_history (tenant_id, project_id, environment_id, job_id, sequence)
);

-- All new tenant roots participate in the already installed metadata writer protocol.
ALTER TABLE public.proofstack_policy_evaluation_jobs ADD CONSTRAINT proofstack_policy_job_projection_complete CHECK ((
  snapshot ?& ARRAY['job','request','attempts','cancellation','usage']
  AND (snapshot->'job') ?& ARRAY['schemaVersion','request','createdByPrincipalId','currentLease','snapshot','result','retryAt','terminal']
  AND snapshot#>>'{job,schemaVersion}'='0.1'
  AND snapshot#>'{job,scope}'=snapshot#>'{request,scope}'
  AND snapshot#>>'{job,request,evaluationRequestId}'=request_id
  AND snapshot#>>'{job,request,definitionSha256}'=request_sha256
  AND snapshot#>>'{request,evaluationRequestId}'=request_id
  AND snapshot#>>'{request,definitionSha256}'=request_sha256
  AND snapshot#>>'{job,createdByPrincipalId}'=snapshot#>>'{request,createdByPrincipalId}'
  AND jsonb_typeof(snapshot->'attempts')='array'
  AND jsonb_array_length(snapshot->'attempts')=attempt_count
  AND (snapshot#>>'{job,currentLease,mutationFence,attemptId}') IS NOT DISTINCT FROM attempt_id
  AND (snapshot#>>'{job,currentLease,mutationFence,leaseId}') IS NOT DISTINCT FROM lease_id
  AND (snapshot#>>'{job,currentLease,mutationFence,workerId}') IS NOT DISTINCT FROM worker_id
  AND (snapshot#>>'{job,currentLease,expiresAt}')::timestamptz IS NOT DISTINCT FROM lease_expires_at
  AND (snapshot#>>'{job,currentLease,attemptDeadlineAt}')::timestamptz IS NOT DISTINCT FROM attempt_deadline_at
  AND (snapshot#>>'{job,retryAt}')::timestamptz IS NOT DISTINCT FROM retry_at
  AND (status IN ('acquiring','sealed','running'))=(snapshot#>'{job,currentLease}'<>'null'::jsonb)
  AND (status IN ('completed','failed','timed_out','budget_exhausted','cancelled'))=(snapshot#>'{job,terminal}'<>'null'::jsonb)
  AND (status='retry_ready')=(retry_at IS NOT NULL)
  AND (snapshot#>'{job,currentLease}'='null'::jsonb OR (
    snapshot#>>'{job,currentLease,mutationFence,jobId}'=job_id
    AND (snapshot#>>'{job,currentLease,mutationFence,fencingToken}')::bigint=last_fencing_token
    AND (snapshot#>>'{job,currentLease,mutationFence,recoveryEpoch}')::bigint=recovery_epoch
    AND lease_expires_at<=attempt_deadline_at AND attempt_deadline_at<=deadline_at
    AND lease_expires_at>updated_at
  ))
) IS TRUE);

ALTER TABLE public.proofstack_policy_evaluation_attempts ADD CONSTRAINT proofstack_policy_attempt_closure_complete CHECK ((
  attempt ?& ARRAY['mutationFence','attemptSequence','startedAt','deadlineAt','phase','snapshot','closure','usageAtClose']
  AND (attempt->'closure'='null'::jsonb)=(closed_at IS NULL)
  AND (attempt#>>'{closure,committedAt}')::timestamptz IS NOT DISTINCT FROM closed_at
  AND (attempt->'closure'='null'::jsonb)=(attempt->'usageAtClose'='null'::jsonb)
) IS TRUE);

ALTER TABLE public.proofstack_policy_evaluation_job_history ADD CONSTRAINT proofstack_policy_history_projection_complete CHECK ((
  entry->>'schemaVersion'='0.1'
  AND (entry->'definition') ?& ARRAY['scope','job','sequence','stateVersion','predecessorEntrySha256','previousGraphSha256','previousStatus','graphSha256','status','committedAt','operation']
  AND entry#>>'{definition,scope,tenantId}'=tenant_id
  AND entry#>>'{definition,scope,projectId}'=project_id
  AND entry#>>'{definition,scope,environmentId}'=environment_id
  AND entry#>>'{definition,job,jobId}'=job_id
  AND (entry#>>'{definition,stateVersion}')::bigint=sequence+1
  AND (canonical_utf8::jsonb)->>'definitionDomain'='proofstack.policy-evaluation-job-history.v1'
  AND (canonical_utf8::jsonb)->>'encodingVersion'='proofstack.policy-evaluation-job-history-jcs.v1'
  AND (canonical_utf8::jsonb)->>'schemaVersion'='0.1'
  AND (sequence=0)=(previous_entry_sha256 IS NULL)
  AND (sequence=0)=(operation='created')
  AND operation IN ('created','claim','heartbeat','reserve','interrupt','reclaim','cancel','history_limit','recovery')
) IS TRUE);

CREATE FUNCTION public.proofstack_guard_policy_evaluation_job_projection()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Policy job deletion is prohibited'; END IF;
  IF ROW(NEW.tenant_id,NEW.project_id,NEW.environment_id,NEW.job_id,NEW.request_id,NEW.request_sha256,NEW.definition_sha256,NEW.created_at,NEW.deadline_at)
    IS DISTINCT FROM ROW(OLD.tenant_id,OLD.project_id,OLD.environment_id,OLD.job_id,OLD.request_id,OLD.request_sha256,OLD.definition_sha256,OLD.created_at,OLD.deadline_at)
    OR NEW.snapshot->'request' IS DISTINCT FROM OLD.snapshot->'request'
    OR NEW.snapshot#>>'{job,createdAt}' IS DISTINCT FROM OLD.snapshot#>>'{job,createdAt}'
    OR NEW.snapshot#>>'{job,createdByPrincipalId}' IS DISTINCT FROM OLD.snapshot#>>'{job,createdByPrincipalId}'
    OR NEW.state_version<>OLD.state_version+1 OR NEW.updated_at<OLD.updated_at
    OR NEW.recovery_epoch<OLD.recovery_epoch OR NEW.last_fencing_token<OLD.last_fencing_token
    OR NEW.attempt_count<OLD.attempt_count OR NEW.attempt_count>OLD.attempt_count+1
    OR NEW.usage_reads<OLD.usage_reads OR NEW.usage_records<OLD.usage_records
    OR NEW.usage_record_bytes<OLD.usage_record_bytes OR NEW.usage_references<OLD.usage_references
    OR NEW.usage_reference_bytes<OLD.usage_reference_bytes OR NEW.usage_artifact_bytes<OLD.usage_artifact_bytes
    OR NEW.usage_rule_evaluations<OLD.usage_rule_evaluations
    OR (OLD.snapshot#>'{job,snapshot}'<>'null'::jsonb AND NEW.snapshot#>'{job,snapshot}' IS DISTINCT FROM OLD.snapshot#>'{job,snapshot}')
    OR (OLD.snapshot#>'{job,result}'<>'null'::jsonb AND NEW.snapshot#>'{job,result}' IS DISTINCT FROM OLD.snapshot#>'{job,result}')
    OR OLD.snapshot#>'{job,terminal}'<>'null'::jsonb THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Policy job immutable input, monotone usage or terminal projection was changed';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.proofstack_guard_policy_evaluation_job_projection() FROM PUBLIC;
CREATE TRIGGER proofstack_policy_job_projection_guard BEFORE UPDATE OR DELETE ON public.proofstack_policy_evaluation_jobs FOR EACH ROW EXECUTE FUNCTION public.proofstack_guard_policy_evaluation_job_projection();

CREATE FUNCTION public.proofstack_guard_policy_evaluation_attempt_projection()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Policy attempt deletion is prohibited'; END IF;
  IF (to_jsonb(NEW)-ARRAY['closed_at','attempt']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['closed_at','attempt'])
    OR (NEW.attempt-ARRAY['closure','usageAtClose']) IS DISTINCT FROM (OLD.attempt-ARRAY['closure','usageAtClose'])
    OR OLD.closed_at IS NOT NULL OR NEW.closed_at IS NULL OR NEW.closed_at<OLD.started_at THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Policy attempt identity or retained closure was changed';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.proofstack_guard_policy_evaluation_attempt_projection() FROM PUBLIC;
CREATE TRIGGER proofstack_policy_attempt_projection_guard BEFORE UPDATE OR DELETE ON public.proofstack_policy_evaluation_attempts FOR EACH ROW EXECUTE FUNCTION public.proofstack_guard_policy_evaluation_attempt_projection();

DO $$
DECLARE relation text;
BEGIN
  FOREACH relation IN ARRAY ARRAY['proofstack_policy_evaluation_requests','proofstack_policy_evaluation_jobs','proofstack_policy_evaluation_attempts','proofstack_policy_evaluation_cancellations','proofstack_policy_evaluation_job_history','proofstack_policy_evaluation_reservations'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', relation);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', relation);
    EXECUTE format('CREATE POLICY %I ON public.%I USING (tenant_id = NULLIF(current_setting(''proofstack.tenant_id'', true), '''') AND project_id = NULLIF(current_setting(''proofstack.project_id'', true), '''') AND environment_id = NULLIF(current_setting(''proofstack.environment_id'', true), '''')) WITH CHECK (tenant_id = NULLIF(current_setting(''proofstack.tenant_id'', true), '''') AND project_id = NULLIF(current_setting(''proofstack.project_id'', true), '''') AND environment_id = NULLIF(current_setting(''proofstack.environment_id'', true), ''''))', relation || '_scope', relation);
    EXECUTE format('CREATE TRIGGER proofstack_policy_evaluation_metadata_write_lock AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.proofstack_lock_policy_evaluation_metadata_write()', relation);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC', relation);
    IF relation NOT IN ('proofstack_policy_evaluation_jobs','proofstack_policy_evaluation_attempts') THEN
      EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.proofstack_reject_append_only_mutation()', relation || '_append_only', relation);
    END IF;
  END LOOP;
END;
$$;

CREATE FUNCTION public.proofstack_policy_evaluation_scope()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  tenant text := NULLIF(current_setting('proofstack.tenant_id', true), '');
  project text := NULLIF(current_setting('proofstack.project_id', true), '');
  environment text := NULLIF(current_setting('proofstack.environment_id', true), '');
BEGIN
  IF tenant IS NULL OR project IS NULL OR environment IS NULL OR tenant !~ '^[a-z][a-z0-9_]{2,63}$' OR project !~ '^[a-z][a-z0-9_]{2,63}$' OR environment !~ '^[a-z][a-z0-9_]{2,63}$' THEN
    RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='Exact policy job scope is required';
  END IF;
  RETURN jsonb_build_object('tenantId',tenant,'projectId',project,'environmentId',environment);
END;
$$;
REVOKE ALL ON FUNCTION public.proofstack_policy_evaluation_scope() FROM PUBLIC;

CREATE FUNCTION public.proofstack_policy_evaluation_utc(value timestamptz)
RETURNS text LANGUAGE sql IMMUTABLE STRICT SET search_path = pg_catalog AS $$
  SELECT to_char(value AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.') ||
    CASE WHEN rtrim(to_char(value AT TIME ZONE 'UTC','US'),'0') = '' THEN '000'
      ELSE rtrim(to_char(value AT TIME ZONE 'UTC','US'),'0') END || 'Z'
$$;
REVOKE ALL ON FUNCTION public.proofstack_policy_evaluation_utc(timestamptz) FROM PUBLIC;

CREATE FUNCTION public.proofstack_policy_evaluation_zero_usage()
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT jsonb_build_object('reads',0,'records',0,'recordBytes',0,'references',0,'referenceBytes',0,'artifactReadBytes',0,'ruleEvaluations',0)
$$;
REVOKE ALL ON FUNCTION public.proofstack_policy_evaluation_zero_usage() FROM PUBLIC;

CREATE FUNCTION public.proofstack_policy_evaluation_project_job(value jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  scoped jsonb := public.proofstack_policy_evaluation_scope();
  body jsonb := value -> 'job';
  lease jsonb := body -> 'currentLease';
  usage jsonb := value -> 'usage';
BEGIN
  IF body -> 'scope' IS DISTINCT FROM scoped OR value #>> '{request,evaluationRequestId}' IS DISTINCT FROM body #>> '{request,evaluationRequestId}' OR value #>> '{request,definitionSha256}' IS DISTINCT FROM body #>> '{request,definitionSha256}' THEN
    RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='Policy job projection is outside exact request/scope';
  END IF;
  UPDATE public.proofstack_policy_evaluation_jobs SET
    status=body->>'status', state_version=(body->>'stateVersion')::bigint,
    recovery_epoch=(body->>'recoveryEpoch')::bigint, last_fencing_token=(body->>'lastFencingToken')::bigint,
    attempt_count=(body->>'attemptCount')::smallint, updated_at=(body->>'updatedAt')::timestamptz,
    attempt_id=lease#>>'{mutationFence,attemptId}',lease_id=lease#>>'{mutationFence,leaseId}',worker_id=lease#>>'{mutationFence,workerId}',
    lease_expires_at=(lease->>'expiresAt')::timestamptz,attempt_deadline_at=(lease->>'attemptDeadlineAt')::timestamptz,
    retry_at=(body->>'retryAt')::timestamptz,
    usage_reads=(usage->>'reads')::bigint,usage_records=(usage->>'records')::bigint,usage_record_bytes=(usage->>'recordBytes')::bigint,
    usage_references=(usage->>'references')::bigint,usage_reference_bytes=(usage->>'referenceBytes')::bigint,
    usage_artifact_bytes=(usage->>'artifactReadBytes')::bigint,usage_rule_evaluations=(usage->>'ruleEvaluations')::bigint,
    snapshot=value
  WHERE tenant_id=scoped->>'tenantId' AND project_id=scoped->>'projectId' AND environment_id=scoped->>'environmentId' AND job_id=body->>'jobId';
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0002', MESSAGE='Policy job not found'; END IF;
END;
$$;
-- Only fixed entry points call this helper; no runtime role receives its EXECUTE grant.
REVOKE ALL ON FUNCTION public.proofstack_policy_evaluation_project_job(jsonb) FROM PUBLIC;

CREATE FUNCTION public.proofstack_policy_evaluation_lock_job(expected_job_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE scoped jsonb := public.proofstack_policy_evaluation_scope(); current_snapshot jsonb;
BEGIN
  IF expected_job_id IS NULL OR expected_job_id !~ '^[a-z][a-z0-9_]{2,63}$' THEN RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Invalid policy job identity'; END IF;
  SELECT snapshot INTO current_snapshot FROM public.proofstack_policy_evaluation_jobs
  WHERE tenant_id=scoped->>'tenantId' AND project_id=scoped->>'projectId' AND environment_id=scoped->>'environmentId' AND job_id=expected_job_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0002', MESSAGE='Policy job not found'; END IF;
  IF NOT pg_try_advisory_xact_lock_shared(hashtextextended('proofstack:replay-recovery-epoch',0)) THEN
    RAISE EXCEPTION USING ERRCODE='55P03', MESSAGE='Policy recovery guard is unavailable';
  END IF;
  IF current_snapshot#>'{job,terminal}'='null'::jsonb THEN
    PERFORM public.proofstack_assert_current_replay_recovery_epoch((current_snapshot#>>'{job,recoveryEpoch}')::bigint);
  END IF;
  RETURN current_snapshot;
END;
$$;
REVOKE ALL ON FUNCTION public.proofstack_policy_evaluation_lock_job(text) FROM PUBLIC;

CREATE FUNCTION public.proofstack_policy_evaluation_assert_fence(value jsonb, expected_fence jsonb, cut timestamptz)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE body jsonb := value->'job'; lease jsonb := body->'currentLease';
BEGIN
  IF body->>'status' NOT IN ('acquiring','sealed','running') OR lease IS NULL OR jsonb_typeof(lease) <> 'object' OR lease->'mutationFence' IS DISTINCT FROM expected_fence THEN
    RAISE EXCEPTION USING ERRCODE='40001', MESSAGE='Policy worker fence/state is stale';
  END IF;
  PERFORM public.proofstack_assert_current_replay_recovery_epoch((expected_fence->>'recoveryEpoch')::bigint);
  IF cut >= (lease->>'expiresAt')::timestamptz OR cut >= (lease->>'attemptDeadlineAt')::timestamptz OR cut >= (body->>'deadlineAt')::timestamptz THEN
    RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='Policy worker lease has expired';
  END IF;
  IF cut < (body->>'updatedAt')::timestamptz THEN RAISE EXCEPTION USING ERRCODE='40001', MESSAGE='Policy receipt order moved backward'; END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.proofstack_policy_evaluation_assert_fence(jsonb,jsonb,timestamptz) FROM PUBLIC;

CREATE FUNCTION public.proofstack_create_policy_evaluation_job(input_request jsonb, expected_job_id text, expected_job_digest text)
RETURNS TABLE(created boolean, snapshot jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  scoped jsonb := public.proofstack_policy_evaluation_scope();
  request_id_value text := input_request->>'evaluationRequestId';
  cut timestamptz;
  request_cut timestamptz;
  request_value jsonb;
  job_value jsonb;
  result_value jsonb;
  stored public.proofstack_policy_evaluation_jobs%ROWTYPE;
  current_epoch bigint;
BEGIN
  IF jsonb_typeof(input_request) IS DISTINCT FROM 'object' OR input_request->'scope' IS DISTINCT FROM scoped OR expected_job_id IS NULL OR expected_job_id !~ '^[a-z][a-z0-9_]{2,63}$' OR expected_job_digest IS NULL OR expected_job_digest !~ '^[0-9a-f]{64}$' OR request_id_value IS NULL OR request_id_value !~ '^[a-z][a-z0-9_]{2,63}$' THEN
    RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='Policy request creation is malformed or outside exact scope';
  END IF;
  -- Request identities serialize duplicate creation, including calls carrying different new job IDs.
  PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array('proofstack.policy-job-request.v1',scoped,request_id_value)::text,0));
  SELECT * INTO stored FROM public.proofstack_policy_evaluation_jobs
    WHERE tenant_id=scoped->>'tenantId' AND project_id=scoped->>'projectId' AND environment_id=scoped->>'environmentId' AND request_id=request_id_value FOR UPDATE;
  IF FOUND THEN
    IF stored.request_sha256 IS DISTINCT FROM input_request->>'definitionSha256' THEN RAISE EXCEPTION USING ERRCODE='23505', MESSAGE='Policy request identity conflict'; END IF;
    RETURN QUERY SELECT false,stored.snapshot;
    RETURN;
  END IF;
  IF NOT pg_try_advisory_xact_lock_shared(hashtextextended('proofstack:replay-recovery-epoch',0)) THEN RAISE EXCEPTION USING ERRCODE='55P03', MESSAGE='Policy recovery guard is unavailable'; END IF;
  current_epoch := public.proofstack_current_replay_recovery_epoch();
  cut := clock_timestamp();
  request_cut := date_trunc('milliseconds',cut);
  request_value := jsonb_set(input_request,'{createdAt}',to_jsonb(to_char(request_cut AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),false);
  job_value := jsonb_build_object(
    'schemaVersion','0.1','jobId',expected_job_id,'scope',scoped,
    'request',jsonb_build_object('evaluationRequestId',request_id_value,'definitionSha256',request_value->>'definitionSha256'),
    'definitionSha256',expected_job_digest,'createdAt',public.proofstack_policy_evaluation_utc(cut),
    'createdByPrincipalId',request_value->>'createdByPrincipalId','updatedAt',public.proofstack_policy_evaluation_utc(cut),
    'deadlineAt',public.proofstack_policy_evaluation_utc(request_cut+(request_value#>>'{limits,totalDeadlineMilliseconds}')::bigint*interval '1 millisecond'),
    'stateVersion',1,'recoveryEpoch',current_epoch,'lastFencingToken',0,'attemptCount',0,'status','queued',
    'currentLease',NULL,'snapshot',NULL,'result',NULL,'retryAt',NULL,'terminal',NULL);
  result_value := jsonb_build_object('request',request_value,'job',job_value,'attempts','[]'::jsonb,'cancellation',NULL,'usage',public.proofstack_policy_evaluation_zero_usage());
  INSERT INTO public.proofstack_policy_evaluation_requests VALUES (
    scoped->>'tenantId',scoped->>'projectId',scoped->>'environmentId',request_id_value,request_value->>'definitionSha256',request_cut,request_value->>'createdAt',request_value->>'createdByPrincipalId',request_value);
  INSERT INTO public.proofstack_policy_evaluation_jobs (
    tenant_id,project_id,environment_id,job_id,request_id,request_sha256,definition_sha256,status,state_version,recovery_epoch,last_fencing_token,attempt_count,created_at,updated_at,deadline_at,
    usage_reads,usage_records,usage_record_bytes,usage_references,usage_reference_bytes,usage_artifact_bytes,usage_rule_evaluations,snapshot
  ) VALUES (
    scoped->>'tenantId',scoped->>'projectId',scoped->>'environmentId',expected_job_id,request_id_value,request_value->>'definitionSha256',expected_job_digest,'queued',1,current_epoch,0,0,cut,cut,(job_value->>'deadlineAt')::timestamptz,
    0,0,0,0,0,0,0,result_value);
  RETURN QUERY SELECT true,result_value;
END;
$$;
REVOKE ALL ON FUNCTION public.proofstack_create_policy_evaluation_job(jsonb,text,text) FROM PUBLIC;

CREATE FUNCTION public.proofstack_read_policy_evaluation_job(expected_job_id text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE scoped jsonb := public.proofstack_policy_evaluation_scope(); result_value jsonb; retained_request jsonb; retained_attempts jsonb; retained_cancellation jsonb;
BEGIN
  SELECT snapshot INTO result_value FROM public.proofstack_policy_evaluation_jobs
  WHERE tenant_id=scoped->>'tenantId' AND project_id=scoped->>'projectId' AND environment_id=scoped->>'environmentId' AND job_id=expected_job_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT request INTO retained_request FROM public.proofstack_policy_evaluation_requests
    WHERE tenant_id=scoped->>'tenantId' AND project_id=scoped->>'projectId' AND environment_id=scoped->>'environmentId' AND request_id=result_value#>>'{request,evaluationRequestId}';
  SELECT COALESCE(jsonb_agg(attempt ORDER BY attempt_sequence),'[]'::jsonb) INTO retained_attempts FROM public.proofstack_policy_evaluation_attempts
    WHERE tenant_id=scoped->>'tenantId' AND project_id=scoped->>'projectId' AND environment_id=scoped->>'environmentId' AND job_id=expected_job_id;
  SELECT intent INTO retained_cancellation FROM public.proofstack_policy_evaluation_cancellations
    WHERE tenant_id=scoped->>'tenantId' AND project_id=scoped->>'projectId' AND environment_id=scoped->>'environmentId' AND job_id=expected_job_id;
  IF retained_request IS DISTINCT FROM result_value->'request' OR retained_attempts IS DISTINCT FROM result_value->'attempts' OR COALESCE(retained_cancellation,'null'::jsonb) IS DISTINCT FROM result_value->'cancellation' THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Policy job graph differs from normalized owning records';
  END IF;
  RETURN result_value;
END;
$$;
REVOKE ALL ON FUNCTION public.proofstack_read_policy_evaluation_job(text) FROM PUBLIC;

CREATE FUNCTION public.proofstack_claim_policy_evaluation_job(expected_job_id text, expected_worker_id text, expected_attempt_id text, expected_lease_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  value jsonb := public.proofstack_policy_evaluation_lock_job(expected_job_id);
  body jsonb := value->'job'; limits jsonb := value#>'{request,limits}';
  cut timestamptz := clock_timestamp(); lexical text; sequence_value integer;
  attempt_deadline timestamptz; lease_expiry timestamptz;
  fence jsonb; attempt_value jsonb; lease_value jsonb;
BEGIN
  IF expected_worker_id IS NULL OR expected_worker_id !~ '^[a-z][a-z0-9_]{2,63}$' OR expected_attempt_id IS NULL OR expected_attempt_id !~ '^[a-z][a-z0-9_]{2,63}$' OR expected_lease_id IS NULL OR expected_lease_id !~ '^[a-z][a-z0-9_]{2,63}$' THEN RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Invalid policy worker claim identity'; END IF;
  IF body->>'status' NOT IN ('queued','retry_ready') THEN RAISE EXCEPTION USING ERRCODE='40001', MESSAGE='Policy job is not claimable'; END IF;
  IF cut < (body->>'updatedAt')::timestamptz OR cut >= (body->>'deadlineAt')::timestamptz THEN RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='Policy claim deadline/order rejected'; END IF;
  IF body->>'retryAt' IS NOT NULL AND cut < (body->>'retryAt')::timestamptz THEN RAISE EXCEPTION USING ERRCODE='40001', MESSAGE='Policy retry is not ready'; END IF;
  sequence_value := (body->>'attemptCount')::int;
  IF sequence_value >= (limits->>'maxAttempts')::int THEN RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='Policy attempt limit reached'; END IF;
  IF (body->>'lastFencingToken')::bigint >= 9007199254740991 OR (body->>'stateVersion')::bigint >= 100000 THEN RAISE EXCEPTION USING ERRCODE='22003', MESSAGE='Policy counter exhausted'; END IF;
  IF (body->>'stateVersion')::bigint=99999 THEN RETURN public.proofstack_policy_evaluation_history_limit(value,cut); END IF;
  lexical := public.proofstack_policy_evaluation_utc(cut);
  attempt_deadline := LEAST(cut+(limits->>'perAttemptTimeoutMilliseconds')::bigint*interval '1 millisecond',(body->>'deadlineAt')::timestamptz);
  lease_expiry := LEAST(cut+(limits->>'leaseDurationMilliseconds')::bigint*interval '1 millisecond',attempt_deadline);
  fence := jsonb_build_object('jobId',expected_job_id,'attemptId',expected_attempt_id,'leaseId',expected_lease_id,'workerId',expected_worker_id,'fencingToken',(body->>'lastFencingToken')::bigint+1,'recoveryEpoch',(body->>'recoveryEpoch')::bigint);
  attempt_value := jsonb_build_object('schemaVersion','0.1','scope',body->'scope','mutationFence',fence,'attemptSequence',sequence_value,'startedAt',lexical,'deadlineAt',public.proofstack_policy_evaluation_utc(attempt_deadline),'phase',CASE WHEN body->'snapshot'='null'::jsonb THEN 'acquiring' ELSE 'computing' END,'snapshot',body->'snapshot','usageAtStart',value->'usage','usageAtClose',NULL,'closure',NULL);
  lease_value := jsonb_build_object('schemaVersion','0.1','scope',body->'scope','mutationFence',fence,'attemptSequence',sequence_value,'acquiredAt',lexical,'heartbeatAt',lexical,'expiresAt',public.proofstack_policy_evaluation_utc(lease_expiry),'attemptDeadlineAt',public.proofstack_policy_evaluation_utc(attempt_deadline),'jobDeadlineAt',body->>'deadlineAt');
  body := body || jsonb_build_object('currentLease',lease_value,'status',CASE WHEN body->'snapshot'='null'::jsonb THEN 'acquiring' ELSE 'running' END,'attemptCount',sequence_value+1,'lastFencingToken',(fence->>'fencingToken')::bigint,'stateVersion',(body->>'stateVersion')::bigint+1,'updatedAt',lexical,'retryAt',NULL);
  value := value || jsonb_build_object('job',body,'attempts',(value->'attempts')||jsonb_build_array(attempt_value));
  INSERT INTO public.proofstack_policy_evaluation_attempts VALUES (body#>>'{scope,tenantId}',body#>>'{scope,projectId}',body#>>'{scope,environmentId}',expected_job_id,expected_attempt_id,sequence_value,expected_lease_id,expected_worker_id,(fence->>'fencingToken')::bigint,(fence->>'recoveryEpoch')::bigint,cut,attempt_deadline,NULL,attempt_value);
  PERFORM public.proofstack_policy_evaluation_project_job(value);
  RETURN value;
END;
$$;
REVOKE ALL ON FUNCTION public.proofstack_claim_policy_evaluation_job(text,text,text,text) FROM PUBLIC;

CREATE FUNCTION public.proofstack_policy_evaluation_close_attempt(value jsonb, closure_value jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE body jsonb := value->'job'; attempts_value jsonb := value->'attempts'; latest jsonb; index_value integer;
BEGIN
  index_value := jsonb_array_length(attempts_value)-1;
  IF index_value < 0 THEN RETURN value; END IF;
  latest := attempts_value->index_value;
  IF latest->'closure' <> 'null'::jsonb THEN RETURN value; END IF;
  latest := latest || jsonb_build_object('closure',closure_value,'usageAtClose',value->'usage');
  UPDATE public.proofstack_policy_evaluation_attempts SET attempt=latest,closed_at=(closure_value->>'committedAt')::timestamptz
    WHERE tenant_id=body#>>'{scope,tenantId}' AND project_id=body#>>'{scope,projectId}' AND environment_id=body#>>'{scope,environmentId}' AND job_id=body->>'jobId' AND attempt_id=latest#>>'{mutationFence,attemptId}' AND closed_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Policy open attempt projection is missing'; END IF;
  RETURN jsonb_set(value,ARRAY['attempts',index_value::text],latest,false);
END;
$$;
REVOKE ALL ON FUNCTION public.proofstack_policy_evaluation_close_attempt(jsonb,jsonb) FROM PUBLIC;

CREATE FUNCTION public.proofstack_policy_evaluation_history_limit(value jsonb, cut timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE body jsonb := value->'job'; latest jsonb; lexical text := public.proofstack_policy_evaluation_utc(cut);
BEGIN
  IF (body->>'stateVersion')::bigint <> 99999 OR body->'terminal' <> 'null'::jsonb THEN RAISE EXCEPTION USING ERRCODE='22003', MESSAGE='Policy history final slot is unavailable'; END IF;
  value := public.proofstack_policy_evaluation_close_attempt(value,jsonb_build_object('status','budget_exhausted','reason','budget_limit_reached','committedAt',lexical));
  latest := (value->'attempts')->(jsonb_array_length(value->'attempts')-1);
  body := body || jsonb_build_object('status','budget_exhausted','currentLease',NULL,'retryAt',NULL,'updatedAt',lexical,'stateVersion',100000,'terminal',jsonb_build_object('status','budget_exhausted','code','budget_limit_reached','attemptId',latest#>>'{mutationFence,attemptId}','committedAt',lexical));
  value := jsonb_set(value,'{job}',body,false);
  PERFORM public.proofstack_policy_evaluation_project_job(value);
  RETURN value;
END;
$$;
REVOKE ALL ON FUNCTION public.proofstack_policy_evaluation_history_limit(jsonb,timestamptz) FROM PUBLIC;

CREATE FUNCTION public.proofstack_heartbeat_policy_evaluation_job(expected_fence jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  value jsonb := public.proofstack_policy_evaluation_lock_job(expected_fence->>'jobId');
  body jsonb := value->'job'; lease jsonb := body->'currentLease'; limits jsonb := value#>'{request,limits}';
  cut timestamptz := clock_timestamp(); expiry timestamptz; lexical text;
BEGIN
  PERFORM public.proofstack_policy_evaluation_assert_fence(value,expected_fence,cut);
  IF cut < (lease->>'heartbeatAt')::timestamptz+(limits->>'heartbeatIntervalMilliseconds')::bigint*interval '1 millisecond' THEN RAISE EXCEPTION USING ERRCODE='40001', MESSAGE='Policy heartbeat is not ready'; END IF;
  IF (body->>'stateVersion')::bigint=99999 THEN RETURN public.proofstack_policy_evaluation_history_limit(value,cut); END IF;
  expiry := LEAST(cut+(limits->>'leaseDurationMilliseconds')::bigint*interval '1 millisecond',(lease->>'attemptDeadlineAt')::timestamptz);
  lexical := public.proofstack_policy_evaluation_utc(cut);
  lease := lease || jsonb_build_object('heartbeatAt',lexical,'expiresAt',public.proofstack_policy_evaluation_utc(expiry));
  body := body || jsonb_build_object('currentLease',lease,'updatedAt',lexical,'stateVersion',(body->>'stateVersion')::bigint+1);
  value := jsonb_set(value,'{job}',body,false);
  PERFORM public.proofstack_policy_evaluation_project_job(value);
  RETURN value;
END;
$$;
REVOKE ALL ON FUNCTION public.proofstack_heartbeat_policy_evaluation_job(jsonb) FROM PUBLIC;

CREATE FUNCTION public.proofstack_reserve_policy_evaluation_work(expected_fence jsonb, expected_reservation_id text, delta jsonb)
RETURNS TABLE(created boolean,snapshot jsonb,reservation jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  value jsonb := public.proofstack_policy_evaluation_lock_job(expected_fence->>'jobId');
  body jsonb := value->'job'; limits jsonb := value#>'{request,limits}'; scoped jsonb := body->'scope';
  cut timestamptz := clock_timestamp(); previous_entry jsonb; usage_value jsonb := value->'usage';
  dimensions text[] := ARRAY['reads','records','recordBytes','references','referenceBytes','artifactReadBytes','ruleEvaluations'];
  dimension text; amount bigint; total bigint := 0;
BEGIN
  PERFORM public.proofstack_policy_evaluation_assert_fence(value,expected_fence,cut);
  IF expected_reservation_id IS NULL OR expected_reservation_id !~ '^[a-z][a-z0-9_]{2,63}$' OR jsonb_typeof(delta) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(delta)) <> 7 THEN RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Invalid policy work reservation'; END IF;
  FOREACH dimension IN ARRAY dimensions LOOP
    IF jsonb_typeof(delta->dimension) IS DISTINCT FROM 'number' OR delta->>dimension !~ '^(0|[1-9][0-9]*)$' THEN RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Reservation requires exact nonnegative integer amounts'; END IF;
    amount := (delta->>dimension)::bigint;
    IF amount > 268435456 THEN RAISE EXCEPTION USING ERRCODE='22003', MESSAGE='Reservation amount exceeds fixed admission'; END IF;
    total := total+amount;
  END LOOP;
  IF total=0 THEN RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Policy reservation is empty'; END IF;
  SELECT h.entry INTO previous_entry FROM public.proofstack_policy_evaluation_reservations r JOIN public.proofstack_policy_evaluation_job_history h USING(tenant_id,project_id,environment_id,job_id)
    WHERE r.tenant_id=scoped->>'tenantId' AND r.project_id=scoped->>'projectId' AND r.environment_id=scoped->>'environmentId' AND r.job_id=body->>'jobId' AND r.reservation_id=expected_reservation_id AND h.sequence=r.history_sequence;
  IF FOUND THEN
    IF previous_entry#>'{definition,operation,fence}' IS DISTINCT FROM expected_fence OR previous_entry#>'{definition,operation,delta}' IS DISTINCT FROM delta THEN RAISE EXCEPTION USING ERRCODE='23505', MESSAGE='Policy reservation identity conflict'; END IF;
    RETURN QUERY SELECT false,value,previous_entry;
    RETURN;
  END IF;
  IF (delta->>'ruleEvaluations')::bigint > 0 AND body->>'status'<>'running' THEN RAISE EXCEPTION USING ERRCODE='40001', MESSAGE='Policy rule work requires computing state'; END IF;
  FOREACH dimension IN ARRAY dimensions LOOP
    usage_value := jsonb_set(usage_value,ARRAY[dimension],to_jsonb((usage_value->>dimension)::bigint+(delta->>dimension)::bigint),false);
  END LOOP;
  IF (usage_value->>'reads')::bigint>(limits->>'maxAcquisitionRecords')::bigint OR (usage_value->>'records')::bigint>(limits->>'maxAcquisitionRecords')::bigint OR (usage_value->>'references')::bigint>(limits->>'maxAcquisitionRecords')::bigint OR (usage_value->>'recordBytes')::bigint+(usage_value->>'referenceBytes')::bigint>(limits->>'maxAcquisitionRecordBytes')::bigint OR (usage_value->>'artifactReadBytes')::bigint>(limits->>'maxArtifactReadBytes')::bigint OR (usage_value->>'ruleEvaluations')::bigint>(limits->>'maxRuleEvaluations')::bigint THEN RAISE EXCEPTION USING ERRCODE='22003', MESSAGE='Policy cumulative budget limit reached'; END IF;
  IF (body->>'stateVersion')::bigint=99999 THEN RETURN QUERY SELECT false,public.proofstack_policy_evaluation_history_limit(value,cut),NULL::jsonb; RETURN; END IF;
  body := body || jsonb_build_object('updatedAt',public.proofstack_policy_evaluation_utc(cut),'stateVersion',(body->>'stateVersion')::bigint+1);
  value := value || jsonb_build_object('job',body,'usage',usage_value);
  PERFORM public.proofstack_policy_evaluation_project_job(value);
  RETURN QUERY SELECT true,value,NULL::jsonb;
END;
$$;
REVOKE ALL ON FUNCTION public.proofstack_reserve_policy_evaluation_work(jsonb,text,jsonb) FROM PUBLIC;

CREATE FUNCTION public.proofstack_cancel_policy_evaluation_job(expected_job_id text, expected_cancellation_id text, expected_principal_id text, expected_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  value jsonb := public.proofstack_policy_evaluation_lock_job(expected_job_id);
  body jsonb := value->'job'; intent jsonb := value->'cancellation'; latest jsonb;
  cut timestamptz := clock_timestamp(); lexical text;
BEGIN
  IF expected_cancellation_id IS NULL OR expected_cancellation_id !~ '^[a-z][a-z0-9_]{2,63}$' OR expected_principal_id IS NULL OR expected_principal_id !~ '^[a-z][a-z0-9_]{2,63}$' OR expected_reason IS NULL OR expected_reason NOT IN ('operator_requested','superseded_request','incident_response') THEN RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Invalid policy cancellation intent'; END IF;
  IF intent <> 'null'::jsonb THEN
    IF intent->>'reason' IS DISTINCT FROM expected_reason OR intent->>'requestedByPrincipalId' IS DISTINCT FROM expected_principal_id THEN RAISE EXCEPTION USING ERRCODE='23505', MESSAGE='Policy cancellation intent conflict'; END IF;
    RETURN value;
  END IF;
  IF body->>'status' NOT IN ('queued','acquiring','sealed','running','retry_ready') OR cut < (body->>'updatedAt')::timestamptz THEN RAISE EXCEPTION USING ERRCODE='40001', MESSAGE='Policy cancellation state/order rejected'; END IF;
  IF (body->>'stateVersion')::bigint>=100000 THEN RAISE EXCEPTION USING ERRCODE='22003', MESSAGE='Policy history exhausted'; END IF;
  lexical := public.proofstack_policy_evaluation_utc(cut);
  intent := jsonb_build_object('scope',body->'scope','jobId',expected_job_id,'cancellationId',expected_cancellation_id,'requestedByPrincipalId',expected_principal_id,'reason',expected_reason,'requestedAt',lexical);
  value := public.proofstack_policy_evaluation_close_attempt(value,jsonb_build_object('status','cancelled','reason','cancellation_committed','committedAt',lexical));
  latest := (value->'attempts')->(jsonb_array_length(value->'attempts')-1);
  body := body || jsonb_build_object('status','cancelled','currentLease',NULL,'retryAt',NULL,'updatedAt',lexical,'stateVersion',(body->>'stateVersion')::bigint+1,'terminal',jsonb_build_object('status','cancelled','code','cancellation_committed','attemptId',latest#>>'{mutationFence,attemptId}','committedAt',lexical));
  value := value || jsonb_build_object('job',body,'cancellation',intent);
  INSERT INTO public.proofstack_policy_evaluation_cancellations VALUES (body#>>'{scope,tenantId}',body#>>'{scope,projectId}',body#>>'{scope,environmentId}',expected_job_id,expected_cancellation_id,expected_principal_id,expected_reason,cut,intent);
  PERFORM public.proofstack_policy_evaluation_project_job(value);
  RETURN value;
END;
$$;
REVOKE ALL ON FUNCTION public.proofstack_cancel_policy_evaluation_job(text,text,text,text) FROM PUBLIC;

CREATE FUNCTION public.proofstack_policy_evaluation_close_for_retry(value jsonb, reason_value text, cut timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  body jsonb := value->'job'; limits jsonb := value#>'{request,limits}'; latest jsonb;
  lexical text := public.proofstack_policy_evaluation_utc(cut); retry_cut timestamptz;
BEGIN
  IF (body->>'stateVersion')::bigint=99999 THEN RETURN public.proofstack_policy_evaluation_history_limit(value,cut); END IF;
  IF (body->>'stateVersion')::bigint>=100000 THEN RAISE EXCEPTION USING ERRCODE='22003', MESSAGE='Policy history exhausted'; END IF;
  value := public.proofstack_policy_evaluation_close_attempt(value,jsonb_build_object('status','interrupted','reason',reason_value,'committedAt',lexical));
  latest := (value->'attempts')->(jsonb_array_length(value->'attempts')-1);
  retry_cut := LEAST(cut+(limits->>'retryBackoffMilliseconds')::bigint*interval '1 millisecond',(body->>'deadlineAt')::timestamptz);
  body := body || jsonb_build_object('currentLease',NULL,'updatedAt',lexical,'stateVersion',(body->>'stateVersion')::bigint+1);
  IF retry_cut >= (body->>'deadlineAt')::timestamptz OR (body->>'attemptCount')::int >= (limits->>'maxAttempts')::int OR NOT (limits->'retryableErrors' ? reason_value) THEN
    body := body || jsonb_build_object('status','failed','retryAt',NULL,'terminal',jsonb_build_object('status','failed','code','retries_exhausted','attemptId',latest#>>'{mutationFence,attemptId}','committedAt',lexical));
  ELSE
    body := body || jsonb_build_object('status','retry_ready','retryAt',public.proofstack_policy_evaluation_utc(retry_cut));
  END IF;
  value := jsonb_set(value,'{job}',body,false);
  PERFORM public.proofstack_policy_evaluation_project_job(value);
  RETURN value;
END;
$$;
REVOKE ALL ON FUNCTION public.proofstack_policy_evaluation_close_for_retry(jsonb,text,timestamptz) FROM PUBLIC;

CREATE FUNCTION public.proofstack_interrupt_policy_evaluation_job(expected_fence jsonb, expected_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE value jsonb := public.proofstack_policy_evaluation_lock_job(expected_fence->>'jobId'); cut timestamptz := clock_timestamp();
BEGIN
  PERFORM public.proofstack_policy_evaluation_assert_fence(value,expected_fence,cut);
  IF expected_reason IS NULL OR expected_reason NOT IN ('source_revision_changed','source_temporarily_unavailable','worker_interrupted') THEN RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Invalid fixed policy interruption'; END IF;
  IF value#>'{job,snapshot}' <> 'null'::jsonb AND expected_reason='source_revision_changed' THEN RAISE EXCEPTION USING ERRCODE='40001', MESSAGE='Sealed policy work cannot recapture sources'; END IF;
  RETURN public.proofstack_policy_evaluation_close_for_retry(value,expected_reason,cut);
END;
$$;
REVOKE ALL ON FUNCTION public.proofstack_interrupt_policy_evaluation_job(jsonb,text) FROM PUBLIC;

CREATE FUNCTION public.proofstack_reclaim_policy_evaluation_job(expected_job_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  value jsonb := public.proofstack_policy_evaluation_lock_job(expected_job_id);
  body jsonb := value->'job'; cut timestamptz := clock_timestamp(); lexical text; latest jsonb;
BEGIN
  IF body->'terminal' <> 'null'::jsonb THEN RETURN value; END IF;
  IF cut < (body->>'updatedAt')::timestamptz THEN RAISE EXCEPTION USING ERRCODE='40001', MESSAGE='Policy receipt order moved backward'; END IF;
  IF cut >= (body->>'deadlineAt')::timestamptz THEN
    lexical := public.proofstack_policy_evaluation_utc(cut);
    value := public.proofstack_policy_evaluation_close_attempt(value,jsonb_build_object('status','timed_out','reason','deadline_reached','committedAt',lexical));
    latest := (value->'attempts')->(jsonb_array_length(value->'attempts')-1);
    body := body || jsonb_build_object('status','timed_out','currentLease',NULL,'retryAt',NULL,'updatedAt',lexical,'stateVersion',(body->>'stateVersion')::bigint+1,'terminal',jsonb_build_object('status','timed_out','code','deadline_reached','attemptId',latest#>>'{mutationFence,attemptId}','committedAt',lexical));
    value := jsonb_set(value,'{job}',body,false);
    PERFORM public.proofstack_policy_evaluation_project_job(value);
    RETURN value;
  END IF;
  IF jsonb_typeof(body->'currentLease') IS DISTINCT FROM 'object' OR cut < (body#>>'{currentLease,expiresAt}')::timestamptz THEN RAISE EXCEPTION USING ERRCODE='40001', MESSAGE='Policy job is not expired'; END IF;
  RETURN public.proofstack_policy_evaluation_close_for_retry(value,'lease_expired',cut);
END;
$$;
REVOKE ALL ON FUNCTION public.proofstack_reclaim_policy_evaluation_job(text) FROM PUBLIC;

CREATE FUNCTION public.proofstack_append_policy_evaluation_job_history(input_entry jsonb, canonical_value text, graph_canonical_value text, input_intents jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  scoped jsonb := public.proofstack_policy_evaluation_scope(); definition jsonb := input_entry->'definition';
  value jsonb := public.proofstack_policy_evaluation_lock_job(definition#>>'{job,jobId}'); body jsonb := value->'job';
  sequence_value integer := (definition->>'sequence')::integer;
  preceding public.proofstack_policy_evaluation_job_history%ROWTYPE;
  intent jsonb; canonical_record jsonb; graph_record jsonb;
BEGIN
  IF jsonb_typeof(input_entry) IS DISTINCT FROM 'object' OR octet_length(input_entry::text)>4096 OR octet_length(canonical_value)>4096 OR octet_length(graph_canonical_value)>98304 OR jsonb_typeof(input_intents) IS DISTINCT FROM 'array' OR jsonb_array_length(input_intents)>3 THEN RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Policy history metadata admission failed'; END IF;
  canonical_record := canonical_value::jsonb;
  graph_record := graph_canonical_value::jsonb;
  IF definition->'scope' IS DISTINCT FROM scoped OR definition#>>'{job,jobId}' IS DISTINCT FROM body->>'jobId' OR definition#>>'{job,definitionSha256}' IS DISTINCT FROM body->>'definitionSha256' OR sequence_value IS DISTINCT FROM (body->>'stateVersion')::integer-1 OR definition->>'status' IS DISTINCT FROM body->>'status' OR definition->>'committedAt' IS DISTINCT FROM body->>'updatedAt' OR (definition->>'stateVersion')::bigint IS DISTINCT FROM (body->>'stateVersion')::bigint THEN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Policy history does not bind current normalized job'; END IF;
  IF canonical_record->'definition' IS DISTINCT FROM definition OR canonical_record->>'definitionDomain' IS DISTINCT FROM 'proofstack.policy-evaluation-job-history.v1' OR canonical_record->>'encodingVersion' IS DISTINCT FROM 'proofstack.policy-evaluation-job-history-jcs.v1' OR canonical_record->>'schemaVersion' IS DISTINCT FROM '0.1' OR encode(sha256(convert_to(canonical_value,'UTF8')),'hex') IS DISTINCT FROM input_entry->>'entrySha256' THEN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Policy history canonical bytes mismatch'; END IF;
  IF graph_record->'snapshot' IS DISTINCT FROM value OR graph_record->>'definitionDomain' IS DISTINCT FROM 'proofstack.policy-evaluation-job-graph.v1' OR graph_record->>'schemaVersion' IS DISTINCT FROM '0.1' OR encode(sha256(convert_to(graph_canonical_value,'UTF8')),'hex') IS DISTINCT FROM definition->>'graphSha256' THEN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Policy history graph bytes mismatch'; END IF;
  SELECT * INTO preceding FROM public.proofstack_policy_evaluation_job_history WHERE tenant_id=scoped->>'tenantId' AND project_id=scoped->>'projectId' AND environment_id=scoped->>'environmentId' AND job_id=body->>'jobId' ORDER BY sequence DESC LIMIT 1;
  IF sequence_value=0 THEN
    IF FOUND OR definition#>>'{operation,kind}' IS DISTINCT FROM 'created' OR definition->>'predecessorEntrySha256' IS NOT NULL OR definition->>'previousGraphSha256' IS NOT NULL OR definition->>'previousStatus' IS NOT NULL THEN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Policy creation history is detached'; END IF;
  ELSE
    IF NOT FOUND OR preceding.sequence<>sequence_value-1 OR definition->>'predecessorEntrySha256' IS DISTINCT FROM preceding.entry_sha256 OR definition->>'previousGraphSha256' IS DISTINCT FROM preceding.graph_sha256 OR definition->>'previousStatus' IS DISTINCT FROM preceding.entry#>>'{definition,status}' OR preceding.committed_at>(definition->>'committedAt')::timestamptz THEN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Policy history predecessor is detached'; END IF;
  END IF;
  INSERT INTO public.proofstack_policy_evaluation_job_history VALUES (scoped->>'tenantId',scoped->>'projectId',scoped->>'environmentId',body->>'jobId',sequence_value,input_entry->>'entrySha256',definition->>'predecessorEntrySha256',definition->>'graphSha256',(definition->>'committedAt')::timestamptz,definition#>>'{operation,kind}',canonical_value,input_entry);
  IF definition#>>'{operation,kind}'='reserve' THEN
    INSERT INTO public.proofstack_policy_evaluation_reservations VALUES (scoped->>'tenantId',scoped->>'projectId',scoped->>'environmentId',body->>'jobId',definition#>>'{operation,reservationId}',sequence_value);
  END IF;
  FOR intent IN SELECT element FROM jsonb_array_elements(input_intents) AS rows(element) LOOP
    IF intent->>'tenantId' IS DISTINCT FROM scoped->>'tenantId' OR intent->>'aggregateId' IS DISTINCT FROM 'pej_'||left(body->>'definitionSha256',60) OR intent->>'aggregateType' IS DISTINCT FROM 'policy.evaluation.job' OR intent->>'schemaVersion' IS DISTINCT FROM '0.1' OR intent->>'eventType' NOT IN ('policy.evaluation.job.created','policy.evaluation.job.cancellation-requested','policy.evaluation.job.terminal') OR octet_length(intent::text)>4096 THEN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Policy outbox intent is outside its exact subject'; END IF;
    INSERT INTO public.proofstack_outbox (tenant_id,schema_version,event_type,aggregate_type,aggregate_id,payload,created_at)
      VALUES (scoped->>'tenantId','0.1',intent->>'eventType','policy.evaluation.job',intent->>'aggregateId',intent->'payload',(intent->>'createdAt')::timestamptz);
  END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION public.proofstack_append_policy_evaluation_job_history(jsonb,text,text,jsonb) FROM PUBLIC;

CREATE FUNCTION public.proofstack_policy_evaluation_history_complete()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  stored public.proofstack_policy_evaluation_jobs%ROWTYPE; latest public.proofstack_policy_evaluation_job_history%ROWTYPE; intent_value jsonb;
  original_tenant text:=current_setting('proofstack.tenant_id',true);
  original_project text:=current_setting('proofstack.project_id',true);
  original_environment text:=current_setting('proofstack.environment_id',true);
BEGIN
  -- Owner recovery visits several scopes in one transaction. A deferred check must bind NEW's
  -- exact scope rather than the last application's GUCs, then restore that caller context.
  PERFORM set_config('proofstack.tenant_id',NEW.tenant_id,true),set_config('proofstack.project_id',NEW.project_id,true),set_config('proofstack.environment_id',NEW.environment_id,true);
  SELECT * INTO stored FROM public.proofstack_policy_evaluation_jobs WHERE tenant_id=NEW.tenant_id AND project_id=NEW.project_id AND environment_id=NEW.environment_id AND job_id=NEW.job_id;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Policy history has no job'; END IF;
  PERFORM public.proofstack_read_policy_evaluation_job(stored.job_id);
  SELECT * INTO latest FROM public.proofstack_policy_evaluation_job_history WHERE tenant_id=NEW.tenant_id AND project_id=NEW.project_id AND environment_id=NEW.environment_id AND job_id=NEW.job_id ORDER BY sequence DESC LIMIT 1;
  IF NOT FOUND OR latest.sequence<>stored.state_version-1 OR latest.entry#>>'{definition,status}' IS DISTINCT FROM stored.status OR (latest.entry#>>'{definition,committedAt}')::timestamptz IS DISTINCT FROM stored.updated_at THEN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Policy job/history atomic commit is incomplete'; END IF;
  FOR intent_value IN SELECT jsonb_array_elements(public.proofstack_policy_evaluation_expected_intents(stored.snapshot)) LOOP
    IF public.proofstack_policy_evaluation_intent_status(stored.job_id,intent_value->>'eventType',intent_value->'payload',(intent_value->>'createdAt')::timestamptz) IS DISTINCT FROM 'canonical' THEN
      RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Policy canonical outbox intent is absent or conflicting';
    END IF;
  END LOOP;
  PERFORM set_config('proofstack.tenant_id',COALESCE(original_tenant,''),true),set_config('proofstack.project_id',COALESCE(original_project,''),true),set_config('proofstack.environment_id',COALESCE(original_environment,''),true);
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.proofstack_policy_evaluation_history_complete() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER proofstack_policy_evaluation_jobs_history_complete AFTER INSERT OR UPDATE ON public.proofstack_policy_evaluation_jobs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.proofstack_policy_evaluation_history_complete();

CREATE FUNCTION public.proofstack_read_policy_evaluation_history_head(expected_job_id text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE scoped jsonb := public.proofstack_policy_evaluation_scope(); result_value jsonb;
BEGIN
  SELECT jsonb_build_object('scope',h.entry#>'{definition,scope}','job',h.entry#>'{definition,job}','sequence',h.sequence,'entrySha256',h.entry_sha256,'graphSha256',h.graph_sha256) INTO result_value FROM public.proofstack_policy_evaluation_job_history h
    WHERE tenant_id=scoped->>'tenantId' AND project_id=scoped->>'projectId' AND environment_id=scoped->>'environmentId' AND job_id=expected_job_id ORDER BY sequence DESC LIMIT 1;
  RETURN result_value;
END;
$$;
REVOKE ALL ON FUNCTION public.proofstack_read_policy_evaluation_history_head(text) FROM PUBLIC;

CREATE FUNCTION public.proofstack_read_policy_evaluation_history_page(expected_head jsonb, expected_page integer)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE scoped jsonb := public.proofstack_policy_evaluation_scope(); rows_value jsonb; count_value integer;
BEGIN
  IF expected_head->'scope' IS DISTINCT FROM scoped OR expected_page IS NULL OR expected_page NOT BETWEEN 0 AND 999 OR (expected_head->>'sequence')::int NOT BETWEEN 0 AND 99999 THEN RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='Policy history page is outside exact scope/admission'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.proofstack_policy_evaluation_job_history WHERE tenant_id=scoped->>'tenantId' AND project_id=scoped->>'projectId' AND environment_id=scoped->>'environmentId' AND job_id=expected_head#>>'{job,jobId}' AND sequence=(expected_head->>'sequence')::int AND entry_sha256=expected_head->>'entrySha256' AND graph_sha256=expected_head->>'graphSha256' AND entry#>>'{definition,job,definitionSha256}'=expected_head#>>'{job,definitionSha256}') THEN RAISE EXCEPTION USING ERRCODE='P0002', MESSAGE='Policy history head is not an exact retained prefix'; END IF;
  SELECT jsonb_agg(entry ORDER BY sequence),count(*) INTO rows_value,count_value FROM public.proofstack_policy_evaluation_job_history WHERE tenant_id=scoped->>'tenantId' AND project_id=scoped->>'projectId' AND environment_id=scoped->>'environmentId' AND job_id=expected_head#>>'{job,jobId}' AND sequence BETWEEN expected_page*100 AND LEAST(expected_page*100+99,(expected_head->>'sequence')::int);
  IF count_value<>LEAST(100,(expected_head->>'sequence')::int+1-expected_page*100) OR count_value=0 THEN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Policy history fixed page is incomplete'; END IF;
  RETURN jsonb_build_object('head',expected_head,'pageIndex',expected_page,'entries',rows_value);
END;
$$;
REVOKE ALL ON FUNCTION public.proofstack_read_policy_evaluation_history_page(jsonb,integer) FROM PUBLIC;

CREATE FUNCTION public.proofstack_prepare_policy_evaluation_job_mutation(expected_job_id text)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT public.proofstack_policy_evaluation_lock_job(expected_job_id)
$$;
REVOKE ALL ON FUNCTION public.proofstack_prepare_policy_evaluation_job_mutation(text) FROM PUBLIC;

CREATE FUNCTION public.proofstack_policy_evaluation_intent_status(expected_job_id text, expected_event text, expected_payload jsonb, expected_created_at timestamptz)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE scoped jsonb := public.proofstack_policy_evaluation_scope(); digest_value text; aggregate text;
BEGIN
  SELECT definition_sha256 INTO digest_value FROM public.proofstack_policy_evaluation_jobs WHERE tenant_id=scoped->>'tenantId' AND project_id=scoped->>'projectId' AND environment_id=scoped->>'environmentId' AND job_id=expected_job_id;
  IF NOT FOUND THEN RETURN 'absent'; END IF;
  aggregate := 'pej_'||left(digest_value,60);
  IF NOT EXISTS(SELECT 1 FROM public.proofstack_outbox WHERE tenant_id=scoped->>'tenantId' AND aggregate_id=aggregate AND aggregate_type='policy.evaluation.job' AND event_type=expected_event) THEN RETURN 'absent'; END IF;
  IF EXISTS(SELECT 1 FROM public.proofstack_outbox WHERE tenant_id=scoped->>'tenantId' AND aggregate_id=aggregate AND aggregate_type='policy.evaluation.job' AND event_type=expected_event AND payload=expected_payload AND created_at=expected_created_at AND schema_version='0.1') THEN RETURN 'canonical'; END IF;
  RETURN 'conflict';
END;
$$;
REVOKE ALL ON FUNCTION public.proofstack_policy_evaluation_intent_status(text,text,jsonb,timestamptz) FROM PUBLIC;

CREATE FUNCTION public.proofstack_policy_evaluation_expected_intents(value jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE
  body jsonb:=value->'job'; cancellation jsonb:=value->'cancellation'; terminal jsonb:=body->'terminal';
  payload jsonb; result_value jsonb; terminal_payload jsonb;
BEGIN
  payload:=jsonb_build_object('environmentId',body#>>'{scope,environmentId}','projectId',body#>>'{scope,projectId}','jobId',body->>'jobId','jobDefinitionSha256',body->>'definitionSha256','evaluationRequestId',body#>>'{request,evaluationRequestId}','requestDefinitionSha256',body#>>'{request,definitionSha256}');
  result_value:=jsonb_build_array(jsonb_build_object('eventType','policy.evaluation.job.created','createdAt',body->>'createdAt','payload',payload));
  IF cancellation<>'null'::jsonb THEN
    result_value:=result_value||jsonb_build_array(jsonb_build_object('eventType','policy.evaluation.job.cancellation-requested','createdAt',cancellation->>'requestedAt','payload',payload||jsonb_build_object('cancellationId',cancellation->>'cancellationId','requestedByPrincipalId',cancellation->>'requestedByPrincipalId','reason',cancellation->>'reason')));
  END IF;
  IF terminal<>'null'::jsonb THEN
    terminal_payload:=payload||jsonb_build_object('status',terminal->>'status','code',terminal->>'code','stateVersion',(body->>'stateVersion')::bigint);
    IF body->'result'<>'null'::jsonb THEN terminal_payload:=terminal_payload||jsonb_build_object('resultId',body#>>'{result,evaluationId}','resultDefinitionSha256',body#>>'{result,definitionSha256}'); END IF;
    result_value:=result_value||jsonb_build_array(jsonb_build_object('eventType','policy.evaluation.job.terminal','createdAt',terminal->>'committedAt','payload',terminal_payload));
  END IF;
  RETURN result_value;
END;
$$;
REVOKE ALL ON FUNCTION public.proofstack_policy_evaluation_expected_intents(jsonb) FROM PUBLIC;

CREATE FUNCTION public.proofstack_recover_policy_evaluation_job(expected_job_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  scoped jsonb := public.proofstack_policy_evaluation_scope(); value jsonb; body jsonb; limits jsonb; latest jsonb;
  epoch bigint; cut timestamptz; lexical text;
  was_active boolean; retry_cut timestamptz; terminal_status text; terminal_code text;
BEGIN
  -- This function is owner-only. A recovery coordinator retains the global exclusive epoch lock.
  PERFORM pg_advisory_xact_lock(hashtextextended('proofstack:replay-recovery-epoch',0));
  SELECT snapshot INTO value FROM public.proofstack_policy_evaluation_jobs WHERE tenant_id=scoped->>'tenantId' AND project_id=scoped->>'projectId' AND environment_id=scoped->>'environmentId' AND job_id=expected_job_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0002', MESSAGE='Policy recovery job not found'; END IF;
  epoch:=public.proofstack_current_replay_recovery_epoch();
  cut:=clock_timestamp();
  body:=value->'job';limits:=value#>'{request,limits}';
  IF body->'terminal'<>'null'::jsonb OR (body->>'recoveryEpoch')::bigint=epoch THEN RETURN value; END IF;
  IF epoch<=(body->>'recoveryEpoch')::bigint OR cut<(body->>'updatedAt')::timestamptz OR (body->>'stateVersion')::bigint>=100000 THEN RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='Policy recovery epoch/order/capacity rejected'; END IF;
  lexical:=public.proofstack_policy_evaluation_utc(cut);
  was_active:=jsonb_typeof(body->'currentLease')='object';
  IF cut>=(body->>'deadlineAt')::timestamptz THEN terminal_status:='timed_out';terminal_code:='deadline_reached';
  ELSIF (body->>'stateVersion')::bigint=99999 THEN terminal_status:='budget_exhausted';terminal_code:='budget_limit_reached'; END IF;
  IF terminal_status IS NOT NULL THEN
    value:=public.proofstack_policy_evaluation_close_attempt(value,jsonb_build_object('status',terminal_status,'reason',terminal_code,'committedAt',lexical));
  ELSIF was_active THEN
    value:=public.proofstack_policy_evaluation_close_attempt(value,jsonb_build_object('status','interrupted','reason','worker_interrupted','committedAt',lexical));
  END IF;
  latest:=(value->'attempts')->(jsonb_array_length(value->'attempts')-1);
  body:=body||jsonb_build_object('recoveryEpoch',epoch,'currentLease',NULL,'updatedAt',lexical,'stateVersion',(body->>'stateVersion')::bigint+1);
  IF terminal_status IS NOT NULL THEN
    body:=body||jsonb_build_object('status',terminal_status,'retryAt',NULL,'terminal',jsonb_build_object('status',terminal_status,'code',terminal_code,'attemptId',latest#>>'{mutationFence,attemptId}','committedAt',lexical));
  ELSIF was_active THEN
    retry_cut:=LEAST(cut+(limits->>'retryBackoffMilliseconds')::bigint*interval '1 millisecond',(body->>'deadlineAt')::timestamptz);
    IF retry_cut>=(body->>'deadlineAt')::timestamptz OR (body->>'attemptCount')::int>=(limits->>'maxAttempts')::int OR NOT(limits->'retryableErrors'?'worker_interrupted') THEN
      body:=body||jsonb_build_object('status','failed','retryAt',NULL,'terminal',jsonb_build_object('status','failed','code','retries_exhausted','attemptId',latest#>>'{mutationFence,attemptId}','committedAt',lexical));
    ELSE body:=body||jsonb_build_object('status','retry_ready','retryAt',public.proofstack_policy_evaluation_utc(retry_cut)); END IF;
  ELSIF body->>'status'='retry_ready' AND (body->>'retryAt')::timestamptz<cut THEN body:=body||jsonb_build_object('retryAt',lexical);
  END IF;
  value:=jsonb_set(value,'{job}',body,false);
  PERFORM public.proofstack_policy_evaluation_project_job(value);
  RETURN value;
END;
$$;
REVOKE ALL ON FUNCTION public.proofstack_recover_policy_evaluation_job(text) FROM PUBLIC;
