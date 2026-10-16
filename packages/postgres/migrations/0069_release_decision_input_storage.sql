-- Original immutable planning storage only; no current authority or external job reservation.
CREATE FUNCTION public.proofstack_try_lock_release_decision_input(expected_scope jsonb)
RETURNS boolean LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF expected_scope IS DISTINCT FROM public.proofstack_release_selection_scope() THEN
    RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Exact decision input scope is required';
  END IF;
  IF current_setting('transaction_isolation')<>'read committed' THEN
    RAISE EXCEPTION USING ERRCODE='0A000',MESSAGE='Decision input guards require READ COMMITTED';
  END IF;
  RETURN pg_try_advisory_xact_lock_shared(hashtextextended(jsonb_build_array('proofstack.release-decision-input.v1',expected_scope->>'tenantId')::text,0));
END; $$;

CREATE TABLE public.proofstack_release_decision_inputs (
  tenant_id varchar(64) NOT NULL,project_id varchar(64) NOT NULL,environment_id varchar(64) NOT NULL,
  input_id varchar(64) NOT NULL,definition_sha256 char(64) NOT NULL,
  candidate_version_id varchar(64) NOT NULL,candidate_sha256 char(64) NOT NULL,
  selection_version_id varchar(64) NOT NULL,selection_sha256 char(64) NOT NULL,
  publisher_principal_id varchar(64) NOT NULL,publisher_type text NOT NULL,publisher_method text NOT NULL,
  publisher_credential_id varchar(64) NOT NULL,publisher_request_id text NOT NULL,publisher jsonb NOT NULL,
  authenticated_at_lexical text NOT NULL,created_at_lexical text NOT NULL,expires_at_lexical text NOT NULL,
  authenticated_at_key numeric(50,0) NOT NULL,created_at_key numeric(50,0) NOT NULL,expires_at_key numeric(50,0) NOT NULL,
  plan_count smallint NOT NULL,canonical_utf8 text NOT NULL,record jsonb NOT NULL,
  PRIMARY KEY(tenant_id,input_id),UNIQUE(tenant_id,project_id,environment_id,input_id,definition_sha256),
  CHECK((tenant_id ~ '^[a-z][a-z0-9_]{2,63}$' AND project_id ~ '^[a-z][a-z0-9_]{2,63}$'
    AND environment_id ~ '^[a-z][a-z0-9_]{2,63}$' AND input_id ~ '^[a-z][a-z0-9_]{2,63}$'
    AND candidate_version_id ~ '^[a-z][a-z0-9_]{2,63}$' AND selection_version_id ~ '^[a-z][a-z0-9_]{2,63}$'
    AND publisher_principal_id ~ '^[a-z][a-z0-9_]{2,63}$' AND publisher_credential_id ~ '^[a-z][a-z0-9_]{2,63}$'
    AND definition_sha256 ~ '^[0-9a-f]{64}$' AND candidate_sha256 ~ '^[0-9a-f]{64}$'
    AND selection_sha256 ~ '^[0-9a-f]{64}$' AND length(publisher_request_id) BETWEEN 1 AND 128) IS TRUE),
  CHECK((record->>'schemaVersion'='0.1' AND record->>'decisionInputRequestId'=input_id
    AND record->>'definitionSha256'=definition_sha256 AND record#>>'{scope,tenantId}'=tenant_id
    AND record#>>'{scope,projectId}'=project_id AND record#>>'{scope,environmentId}'=environment_id
    AND record#>>'{candidate,candidateVersionId}'=candidate_version_id AND record#>>'{candidate,definitionSha256}'=candidate_sha256
    AND record#>>'{selection,selectionVersionId}'=selection_version_id AND record#>>'{selection,definitionSha256}'=selection_sha256
    AND record->'publisher'=publisher AND publisher->>'principalId'=publisher_principal_id
    AND publisher->>'principalType'=publisher_type AND publisher->>'authenticationMethod'=publisher_method
    AND publisher->>'credentialId'=publisher_credential_id AND publisher->>'requestId'=publisher_request_id
    AND publisher->>'authenticatedAt'=authenticated_at_lexical
    AND ((publisher_type='user' AND publisher_method='oidc') OR (publisher_type='service' AND publisher_method='service_token'))
    AND record->>'createdAt'=created_at_lexical AND record->>'expiresAt'=expires_at_lexical
    AND plan_count BETWEEN 0 AND 16 AND plan_count=jsonb_array_length(record->'evaluations')) IS TRUE),
  CHECK((authenticated_at_lexical ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
    AND authenticated_at_key=public.proofstack_release_authority_time_key(authenticated_at_lexical)
    AND created_at_key=public.proofstack_release_authority_time_key(created_at_lexical)
    AND expires_at_key=public.proofstack_release_authority_time_key(expires_at_lexical)
    AND authenticated_at_key<=created_at_key AND created_at_key<expires_at_key
    AND expires_at_key-created_at_key<=3600000*power(10::numeric,27)) IS TRUE),
  CHECK((octet_length(canonical_utf8)<=73728 AND octet_length(record::text)<=81920
    AND encode(sha256(convert_to(canonical_utf8,'UTF8')),'hex')=definition_sha256
    AND canonical_utf8::jsonb=jsonb_build_object('schemaVersion','0.1',
      'definitionDomain','proofstack.release-decision-input.v1',
      'encodingVersion','proofstack.release-decision-input-definition-jcs.v1',
      'scope',record->'scope','definition',record-ARRAY['schemaVersion','definitionSha256'])) IS TRUE)
);

CREATE TABLE public.proofstack_release_decision_input_sources (
  tenant_id varchar(64) NOT NULL,project_id varchar(64) NOT NULL,environment_id varchar(64) NOT NULL,
  input_id varchar(64) NOT NULL,input_sha256 char(64) NOT NULL,kind text NOT NULL,ordinal smallint NOT NULL,
  source_id varchar(64) NOT NULL,source_sha256 char(64) NOT NULL,reference jsonb NOT NULL,record jsonb NOT NULL,
  PRIMARY KEY(tenant_id,input_id,kind,ordinal),
  FOREIGN KEY(tenant_id,project_id,environment_id,input_id,input_sha256)
    REFERENCES public.proofstack_release_decision_inputs(tenant_id,project_id,environment_id,input_id,definition_sha256)
    DEFERRABLE INITIALLY DEFERRED,
  CHECK((kind IN('candidate','selection','policy') AND ordinal BETWEEN 0 AND 15
    AND (kind='policy' OR ordinal=0) AND source_id ~ '^[a-z][a-z0-9_]{2,63}$'
    AND source_sha256 ~ '^[0-9a-f]{64}$' AND reference->>'definitionSha256'=source_sha256
    AND record->>'definitionSha256'=source_sha256 AND record->>'schemaVersion'='0.1'
    AND record#>>'{scope,tenantId}'=tenant_id AND record#>>'{scope,projectId}'=project_id
    AND record#>>'{scope,environmentId}'=environment_id
    AND source_id=CASE kind WHEN 'candidate' THEN record->>'candidateVersionId'
      WHEN 'selection' THEN record->>'selectionVersionId' WHEN 'policy' THEN record->>'policyVersionId' END
    AND source_id=CASE kind WHEN 'candidate' THEN reference->>'candidateVersionId'
      WHEN 'selection' THEN reference->>'selectionVersionId' WHEN 'policy' THEN reference->>'policyVersionId' END) IS TRUE)
);
CREATE TABLE public.proofstack_release_decision_input_plans (
  tenant_id varchar(64) NOT NULL,project_id varchar(64) NOT NULL,environment_id varchar(64) NOT NULL,
  input_id varchar(64) NOT NULL,input_sha256 char(64) NOT NULL,ordinal smallint NOT NULL,
  request_id varchar(64) NOT NULL,request_sha256 char(64) NOT NULL,policy_id varchar(64) NOT NULL,
  policy_version_id varchar(64) NOT NULL,policy_sha256 char(64) NOT NULL,mode text NOT NULL,planned jsonb NOT NULL,
  PRIMARY KEY(tenant_id,input_id,ordinal),UNIQUE(tenant_id,request_id),UNIQUE(tenant_id,input_id,policy_id),
  FOREIGN KEY(tenant_id,project_id,environment_id,input_id,input_sha256)
    REFERENCES public.proofstack_release_decision_inputs(tenant_id,project_id,environment_id,input_id,definition_sha256)
    DEFERRABLE INITIALLY DEFERRED,
  CHECK((ordinal BETWEEN 0 AND 15 AND request_id ~ '^[a-z][a-z0-9_]{2,63}$' AND policy_id ~ '^[a-z][a-z0-9_]{2,63}$'
    AND policy_version_id ~ '^[a-z][a-z0-9_]{2,63}$' AND request_sha256 ~ '^[0-9a-f]{64}$'
    AND policy_sha256 ~ '^[0-9a-f]{64}$' AND mode IN('mandatory','advisory')
    AND planned->>'mode'=mode AND planned->>'requestSha256'=request_sha256
    AND planned#>>'{request,evaluationRequestId}'=request_id AND planned#>>'{request,policy,policyId}'=policy_id
    AND planned#>>'{request,policy,policyVersionId}'=policy_version_id
    AND planned#>>'{request,policy,definitionSha256}'=policy_sha256) IS TRUE)
);

CREATE FUNCTION public.proofstack_lock_release_decision_input_write()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array('proofstack.release-decision-input.v1',NEW.tenant_id)::text,0));
  RETURN NULL;
END; $$;
CREATE FUNCTION public.proofstack_verify_release_decision_input_graph()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE value public.proofstack_release_decision_inputs;candidate jsonb;selection jsonb;observed jsonb;item record;
BEGIN
  SELECT * INTO STRICT value FROM public.proofstack_release_decision_inputs WHERE tenant_id=NEW.tenant_id AND input_id=NEW.input_id;
  SELECT record INTO STRICT candidate FROM public.proofstack_release_decision_input_sources s WHERE s.tenant_id=value.tenant_id AND s.input_id=value.input_id AND s.kind='candidate';
  SELECT record INTO STRICT selection FROM public.proofstack_release_decision_input_sources s WHERE s.tenant_id=value.tenant_id AND s.input_id=value.input_id AND s.kind='selection';
  IF (SELECT count(*) FROM public.proofstack_release_decision_input_sources s WHERE s.tenant_id=value.tenant_id AND s.input_id=value.input_id)<>2+value.plan_count
    OR (SELECT reference FROM public.proofstack_release_decision_input_sources s WHERE s.tenant_id=value.tenant_id AND s.input_id=value.input_id AND s.kind='candidate') IS DISTINCT FROM value.record->'candidate'
    OR (SELECT reference FROM public.proofstack_release_decision_input_sources s WHERE s.tenant_id=value.tenant_id AND s.input_id=value.input_id AND s.kind='selection') IS DISTINCT FROM value.record->'selection'
    OR candidate->'target' IS DISTINCT FROM selection->'candidateTarget'
    OR selection->>'mode' IS DISTINCT FROM value.record->>'mode'
    OR NOT COALESCE(selection->'authorizedPublisherPrincipalIds' ? value.publisher_principal_id,false)
    OR jsonb_array_length(selection->'policies')<>value.plan_count THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Incomplete original decision input sources';
  END IF;
  SELECT COALESCE(jsonb_agg(p.planned ORDER BY p.ordinal),'[]'::jsonb) INTO observed FROM public.proofstack_release_decision_input_plans p WHERE p.tenant_id=value.tenant_id AND p.input_id=value.input_id;
  IF observed IS DISTINCT FROM value.record->'evaluations'
    OR EXISTS(SELECT 1 FROM (SELECT p.ordinal,row_number() OVER(ORDER BY p.ordinal)-1 AS expected FROM public.proofstack_release_decision_input_plans p WHERE p.tenant_id=value.tenant_id AND p.input_id=value.input_id) q WHERE q.ordinal<>q.expected)
    OR NOT EXISTS(SELECT 1 FROM public.proofstack_outbox o WHERE o.tenant_id=value.tenant_id AND o.aggregate_type='release_decision_input'
      AND o.aggregate_id=value.input_id AND o.event_type='release.decision.input.recorded' AND o.schema_version='0.1'
      AND o.payload=jsonb_build_object('recordKind','release_decision_input','record',value.record)
      AND o.created_at=value.created_at_lexical::timestamptz) THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Incomplete original decision input plans/intent';
  END IF;
  FOR item IN SELECT p.*,s.reference,s.record AS source_record FROM public.proofstack_release_decision_input_plans p
    LEFT JOIN public.proofstack_release_decision_input_sources s ON s.tenant_id=p.tenant_id AND s.input_id=p.input_id AND s.kind='policy' AND s.ordinal=p.ordinal
    WHERE p.tenant_id=value.tenant_id AND p.input_id=value.input_id LOOP
    IF item.reference IS DISTINCT FROM item.planned#>'{request,policy}'
      OR selection#>ARRAY['policies',item.ordinal::text,'policy'] IS DISTINCT FROM item.reference
      OR selection#>>ARRAY['policies',item.ordinal::text,'mode'] IS DISTINCT FROM item.mode
      OR item.source_record->>'mode' IS DISTINCT FROM item.mode
      OR item.planned#>'{request,candidate}' IS DISTINCT FROM value.record->'candidate'
      OR item.planned#>>'{request,evaluationTime}' IS DISTINCT FROM value.created_at_lexical THEN
      RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Invalid complete ordered original policy plan';
    END IF;
  END LOOP;
  RETURN NULL;
END; $$;

DO $$ DECLARE name text; BEGIN
  FOREACH name IN ARRAY ARRAY['proofstack_release_decision_inputs','proofstack_release_decision_input_sources','proofstack_release_decision_input_plans'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.proofstack_reject_append_only_mutation()',name||'_append_only',name);
    EXECUTE format('CREATE TRIGGER %I AFTER INSERT ON public.%I FOR EACH ROW EXECUTE FUNCTION public.proofstack_lock_release_decision_input_write()',name||'_write_guard',name);
    EXECUTE format('CREATE CONSTRAINT TRIGGER %I AFTER INSERT ON public.%I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.proofstack_verify_release_decision_input_graph()',name||'_complete',name);
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',name);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR ALL USING(tenant_id=NULLIF(current_setting(''proofstack.tenant_id'',true),'''') AND project_id=NULLIF(current_setting(''proofstack.project_id'',true),'''') AND environment_id=NULLIF(current_setting(''proofstack.environment_id'',true),'''')) WITH CHECK(tenant_id=NULLIF(current_setting(''proofstack.tenant_id'',true),'''') AND project_id=NULLIF(current_setting(''proofstack.project_id'',true),'''') AND environment_id=NULLIF(current_setting(''proofstack.environment_id'',true),''''))',name||'_scope',name);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC',name);
  END LOOP;
END; $$;

CREATE FUNCTION public.proofstack_store_release_decision_input(body jsonb,canonical text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE scope jsonb:=public.proofstack_release_selection_scope();value jsonb:=body->'request';prior public.proofstack_release_decision_inputs;
  item jsonb;ordinal_value integer;category text;source_value jsonb;reference_value jsonb;source_id_value text;
BEGIN
  IF value->'scope' IS DISTINCT FROM scope OR body IS DISTINCT FROM jsonb_build_object('request',value,'candidate',body->'candidate','selection',body->'selection','policies',body->'policies') THEN
    RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Exact original decision input scope is required';
  END IF;
  IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION USING ERRCODE='0A000',MESSAGE='Original decision input storage requires READ COMMITTED'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array('proofstack.release-decision-input.v1',scope->>'tenantId')::text,0));
  SELECT * INTO prior FROM public.proofstack_release_decision_inputs r WHERE r.tenant_id=scope->>'tenantId' AND r.input_id=value->>'decisionInputRequestId';
  IF FOUND THEN
    IF jsonb_build_object('scope',prior.record->'scope','inputId',prior.input_id,'candidate',prior.record->'candidate','selection',prior.record->'selection','rationale',prior.record->>'rationale',
      'publisher',prior.publisher-ARRAY['authenticatedAt','credentialId','requestId']) IS DISTINCT FROM
      jsonb_build_object('scope',value->'scope','inputId',value->>'decisionInputRequestId','candidate',value->'candidate','selection',value->'selection','rationale',value->>'rationale',
      'publisher',(value->'publisher')-ARRAY['authenticatedAt','credentialId','requestId']) THEN
      RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='release_decision_input:input_conflict';
    END IF;
    RETURN false;
  END IF;
  IF EXISTS(SELECT 1 FROM public.proofstack_release_decision_input_plans p JOIN jsonb_array_elements(value->'evaluations') AS q(planned_item) ON p.request_id=q.planned_item#>>'{request,evaluationRequestId}' WHERE p.tenant_id=scope->>'tenantId') THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='release_decision_input:planned_request_conflict';
  END IF;
  INSERT INTO public.proofstack_release_decision_inputs VALUES(scope->>'tenantId',scope->>'projectId',scope->>'environmentId',value->>'decisionInputRequestId',value->>'definitionSha256',
    value#>>'{candidate,candidateVersionId}',value#>>'{candidate,definitionSha256}',value#>>'{selection,selectionVersionId}',value#>>'{selection,definitionSha256}',
    value#>>'{publisher,principalId}',value#>>'{publisher,principalType}',value#>>'{publisher,authenticationMethod}',value#>>'{publisher,credentialId}',value#>>'{publisher,requestId}',value->'publisher',
    value#>>'{publisher,authenticatedAt}',value->>'createdAt',value->>'expiresAt',public.proofstack_release_authority_time_key(value#>>'{publisher,authenticatedAt}'),
    public.proofstack_release_authority_time_key(value->>'createdAt'),public.proofstack_release_authority_time_key(value->>'expiresAt'),jsonb_array_length(value->'evaluations'),canonical,value);
  FOREACH category IN ARRAY ARRAY['candidate','selection'] LOOP
    source_value:=body->category;reference_value:=value->category;
    source_id_value:=CASE category WHEN 'candidate' THEN reference_value->>'candidateVersionId' ELSE reference_value->>'selectionVersionId' END;
    INSERT INTO public.proofstack_release_decision_input_sources VALUES(scope->>'tenantId',scope->>'projectId',scope->>'environmentId',value->>'decisionInputRequestId',value->>'definitionSha256',category,0,
      source_id_value,reference_value->>'definitionSha256',reference_value,source_value);
  END LOOP;
  FOR item,ordinal_value IN SELECT q.planned_item,q.position::integer-1 FROM jsonb_array_elements(value->'evaluations') WITH ORDINALITY AS q(planned_item,position) LOOP
    INSERT INTO public.proofstack_release_decision_input_plans VALUES(scope->>'tenantId',scope->>'projectId',scope->>'environmentId',value->>'decisionInputRequestId',value->>'definitionSha256',ordinal_value,
      item#>>'{request,evaluationRequestId}',item->>'requestSha256',item#>>'{request,policy,policyId}',item#>>'{request,policy,policyVersionId}',item#>>'{request,policy,definitionSha256}',item->>'mode',item);
    reference_value:=item#>'{request,policy}';
    INSERT INTO public.proofstack_release_decision_input_sources VALUES(scope->>'tenantId',scope->>'projectId',scope->>'environmentId',value->>'decisionInputRequestId',value->>'definitionSha256','policy',ordinal_value,
      reference_value->>'policyVersionId',reference_value->>'definitionSha256',reference_value,body#>ARRAY['policies',ordinal_value::text]);
  END LOOP;
  INSERT INTO public.proofstack_outbox(tenant_id,event_type,aggregate_type,aggregate_id,schema_version,payload,created_at)
    VALUES(scope->>'tenantId','release.decision.input.recorded','release_decision_input',value->>'decisionInputRequestId','0.1',jsonb_build_object('recordKind','release_decision_input','record',value),(value->>'createdAt')::timestamptz);
  RETURN true;
END; $$;

REVOKE ALL ON FUNCTION public.proofstack_try_lock_release_decision_input(jsonb) FROM PUBLIC;
CREATE FUNCTION public.proofstack_read_release_decision_input(expected_scope jsonb,requested_id text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE scope jsonb:=public.proofstack_release_selection_scope();value jsonb;
BEGIN
  IF requested_id IS NULL OR requested_id !~ '^[a-z][a-z0-9_]{2,63}$' THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid exact decision input ID';
  END IF;
  IF public.proofstack_try_lock_release_decision_input(expected_scope) IS NOT TRUE THEN
    RAISE EXCEPTION USING ERRCODE='55P03',MESSAGE='Original decision input guard is contended';
  END IF;
  SELECT to_jsonb(r)||jsonb_build_object('authenticated_at_key',r.authenticated_at_key::text,
    'created_at_key',r.created_at_key::text,'expires_at_key',r.expires_at_key::text) INTO value
    FROM public.proofstack_release_decision_inputs r WHERE r.tenant_id=scope->>'tenantId'
      AND r.project_id=scope->>'projectId' AND r.environment_id=scope->>'environmentId' AND r.input_id=requested_id;
  RETURN value;
END; $$;
REVOKE ALL ON FUNCTION public.proofstack_read_release_decision_input(jsonb,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.proofstack_lock_release_decision_input_write() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.proofstack_verify_release_decision_input_graph() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.proofstack_store_release_decision_input(jsonb,text) FROM PUBLIC;
