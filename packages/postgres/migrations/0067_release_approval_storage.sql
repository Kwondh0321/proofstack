-- Trusted original action/receipt storage only. Current OIDC/CSRF, reviewer/installation
-- authority and atomic decision publication remain separate. No existing runtime grants.
CREATE FUNCTION public.proofstack_try_lock_release_approval(expected_scope jsonb)
RETURNS boolean LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE scope jsonb:=public.proofstack_release_selection_scope();
BEGIN
  IF expected_scope IS DISTINCT FROM scope THEN
    RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Release approval lock scope mismatch';
  END IF;
  IF current_setting('transaction_isolation')<>'read committed' THEN
    RAISE EXCEPTION USING ERRCODE='0A000',MESSAGE='Release approval guards require READ COMMITTED';
  END IF;
  RETURN pg_try_advisory_xact_lock_shared(hashtextextended(
    jsonb_build_array('proofstack.release-approval.v1',scope->>'tenantId')::text,0));
END; $$;

CREATE TABLE public.proofstack_release_approvals (
  tenant_id varchar(64) NOT NULL,project_id varchar(64) NOT NULL,environment_id varchar(64) NOT NULL,
  approval_id varchar(64) NOT NULL,definition_sha256 char(64) NOT NULL,kind text NOT NULL,action text NOT NULL,
  subject jsonb NOT NULL,reviewer jsonb NOT NULL,authority jsonb NOT NULL,job_id varchar(64) NOT NULL,rule_id varchar(64) NOT NULL,
  reviewer_principal_id varchar(64) NOT NULL,credential_id varchar(64) NOT NULL,authentication_request_id text NOT NULL,
  authenticated_at_lexical text NOT NULL,recorded_at_lexical text NOT NULL,expires_at_lexical text NOT NULL,
  authenticated_at_key numeric(50,0) NOT NULL,recorded_at_key numeric(50,0) NOT NULL,expires_at_key numeric(50,0) NOT NULL,
  parent_approval_id varchar(64),parent_definition_sha256 char(64),
  condition_count smallint NOT NULL,conflict_count smallint NOT NULL,control_count smallint NOT NULL,
  canonical_utf8 text NOT NULL,record jsonb NOT NULL,
  PRIMARY KEY(tenant_id,approval_id),
  UNIQUE(tenant_id,project_id,environment_id,approval_id,definition_sha256),
  FOREIGN KEY(tenant_id,project_id,environment_id,parent_approval_id,parent_definition_sha256)
    REFERENCES public.proofstack_release_approvals(tenant_id,project_id,environment_id,approval_id,definition_sha256)
    DEFERRABLE INITIALLY DEFERRED,
  CHECK((tenant_id ~ '^[a-z][a-z0-9_]{2,63}$' AND project_id ~ '^[a-z][a-z0-9_]{2,63}$'
    AND environment_id ~ '^[a-z][a-z0-9_]{2,63}$' AND approval_id ~ '^[a-z][a-z0-9_]{2,63}$'
    AND reviewer_principal_id ~ '^[a-z][a-z0-9_]{2,63}$' AND credential_id ~ '^[a-z][a-z0-9_]{2,63}$'
    AND job_id ~ '^[a-z][a-z0-9_]{2,63}$' AND rule_id ~ '^[a-z][a-z0-9_]{2,63}$'
    AND length(authentication_request_id) BETWEEN 1 AND 128 AND definition_sha256 ~ '^[0-9a-f]{64}$'
    AND (parent_approval_id IS NULL)=(parent_definition_sha256 IS NULL)
    AND parent_approval_id IS DISTINCT FROM approval_id) IS TRUE),
  CHECK((record->>'schemaVersion'='0.1' AND record->>'approvalId'=approval_id AND record->>'definitionSha256'=definition_sha256
    AND record->>'kind'=kind AND record->>'action'=action AND record->'subject'=subject
    AND record->'reviewer'=reviewer AND record->'authority'=authority
    AND subject#>>'{scope,tenantId}'=tenant_id AND subject#>>'{scope,projectId}'=project_id
    AND subject#>>'{scope,environmentId}'=environment_id AND subject->>'jobId'=job_id AND subject->>'ruleId'=rule_id
    AND reviewer->>'principalId'=reviewer_principal_id AND reviewer->>'credentialId'=credential_id
    AND reviewer->>'requestId'=authentication_request_id AND reviewer->>'authenticatedAt'=authenticated_at_lexical
    AND reviewer->>'principalType'='user' AND reviewer->>'authenticationMethod'='oidc'
    AND authority->>'reviewerPrincipalId'=reviewer_principal_id
    AND authority->>'installationId'=subject#>>'{selection,installationId}'
    AND authority->>'gateTargetId'=subject#>>'{selection,gateTargetId}'
    AND record->>'recordedAt'=recorded_at_lexical AND record->>'expiresAt'=expires_at_lexical
    AND record#>>'{supersedes,approvalId}' IS NOT DISTINCT FROM parent_approval_id
    AND record#>>'{supersedes,definitionSha256}' IS NOT DISTINCT FROM parent_definition_sha256
    AND condition_count BETWEEN 0 AND 32 AND condition_count=jsonb_array_length(record->'conditions')
    AND conflict_count BETWEEN 0 AND 32 AND conflict_count=jsonb_array_length(record->'declaredConflicts')
    AND control_count BETWEEN 0 AND 16 AND control_count=jsonb_array_length(record->'compensatingControls')
    AND kind IN('normal_approval','rule_exception') AND action IN('approve','oppose','escalate','abstain')
    AND (kind<>'normal_approval' OR control_count=0)
    AND (kind<>'rule_exception' OR action<>'approve' OR control_count>0)) IS TRUE),
  CHECK((authenticated_at_lexical ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
    AND authenticated_at_key=public.proofstack_release_authority_time_key(authenticated_at_lexical)
    AND recorded_at_key=public.proofstack_release_authority_time_key(recorded_at_lexical)
    AND expires_at_key=public.proofstack_release_authority_time_key(expires_at_lexical)
    AND authenticated_at_key<=recorded_at_key AND recorded_at_key<expires_at_key) IS TRUE),
  CHECK((octet_length(canonical_utf8)<=73728 AND octet_length(record::text)<=81920
    AND encode(sha256(convert_to(canonical_utf8,'UTF8')),'hex')=definition_sha256
    AND canonical_utf8::jsonb=jsonb_build_object('schemaVersion','0.1',
      'definitionDomain','proofstack.release-approval.v1','encodingVersion','proofstack.release-approval-definition-jcs.v1',
      'scope',subject->'scope','definition',record-ARRAY['schemaVersion','definitionSha256'])) IS TRUE)
);
CREATE UNIQUE INDEX proofstack_release_approval_one_successor ON public.proofstack_release_approvals(tenant_id,parent_approval_id)
  WHERE parent_approval_id IS NOT NULL;
CREATE INDEX proofstack_release_approval_subject_scan ON public.proofstack_release_approvals(tenant_id,kind,approval_id COLLATE "C");

CREATE TABLE public.proofstack_release_approval_sources (
  tenant_id varchar(64) NOT NULL,project_id varchar(64) NOT NULL,environment_id varchar(64) NOT NULL,
  approval_id varchar(64) NOT NULL,definition_sha256 char(64) NOT NULL,kind text NOT NULL,
  source_id varchar(64) NOT NULL,source_definition_sha256 char(64) NOT NULL,reference jsonb NOT NULL,
  PRIMARY KEY(tenant_id,approval_id,kind),
  FOREIGN KEY(tenant_id,project_id,environment_id,approval_id,definition_sha256)
    REFERENCES public.proofstack_release_approvals(tenant_id,project_id,environment_id,approval_id,definition_sha256)
    DEFERRABLE INITIALLY DEFERRED,
  CHECK((source_id ~ '^[a-z][a-z0-9_]{2,63}$' AND source_definition_sha256 ~ '^[0-9a-f]{64}$'
    AND kind IN('selection','candidate','policy','request','snapshot','evaluation')
    AND reference->>'definitionSha256'=source_definition_sha256
    AND source_id=CASE kind WHEN 'selection' THEN reference->>'selectionVersionId'
      WHEN 'candidate' THEN reference->>'candidateVersionId' WHEN 'policy' THEN reference->>'policyVersionId'
      WHEN 'request' THEN reference->>'evaluationRequestId' WHEN 'snapshot' THEN reference->>'snapshotId'
      WHEN 'evaluation' THEN reference->>'evaluationId' END) IS TRUE)
);
CREATE TABLE public.proofstack_release_approval_declarations (
  tenant_id varchar(64) NOT NULL,project_id varchar(64) NOT NULL,environment_id varchar(64) NOT NULL,
  approval_id varchar(64) NOT NULL,definition_sha256 char(64) NOT NULL,kind text NOT NULL,
  ordinal smallint NOT NULL,declaration text NOT NULL,
  PRIMARY KEY(tenant_id,approval_id,kind,ordinal),UNIQUE(tenant_id,approval_id,kind,declaration),
  FOREIGN KEY(tenant_id,project_id,environment_id,approval_id,definition_sha256)
    REFERENCES public.proofstack_release_approvals(tenant_id,project_id,environment_id,approval_id,definition_sha256)
    DEFERRABLE INITIALLY DEFERRED,
  CHECK((kind IN('condition','conflict') AND ordinal BETWEEN 0 AND 31 AND length(declaration) BETWEEN 1 AND 512) IS TRUE)
);
CREATE TABLE public.proofstack_release_approval_controls (
  tenant_id varchar(64) NOT NULL,project_id varchar(64) NOT NULL,environment_id varchar(64) NOT NULL,
  approval_id varchar(64) NOT NULL,definition_sha256 char(64) NOT NULL,ordinal smallint NOT NULL,
  artifact_id varchar(64) NOT NULL,artifact_sha256 char(64) NOT NULL,reference jsonb NOT NULL,
  PRIMARY KEY(tenant_id,approval_id,ordinal),UNIQUE(tenant_id,approval_id,artifact_id,artifact_sha256),
  FOREIGN KEY(tenant_id,project_id,environment_id,approval_id,definition_sha256)
    REFERENCES public.proofstack_release_approvals(tenant_id,project_id,environment_id,approval_id,definition_sha256)
    DEFERRABLE INITIALLY DEFERRED,
  CHECK((ordinal BETWEEN 0 AND 15 AND artifact_id ~ '^[a-z][a-z0-9_]{2,63}$' AND artifact_sha256 ~ '^[0-9a-f]{64}$'
    AND reference->>'artifactId'=artifact_id AND reference->>'sha256'=artifact_sha256) IS TRUE)
);
CREATE TABLE public.proofstack_release_approval_revocations (
  tenant_id varchar(64) NOT NULL,project_id varchar(64) NOT NULL,environment_id varchar(64) NOT NULL,
  event_id varchar(64) NOT NULL,approval_id varchar(64) NOT NULL,approval_definition_sha256 char(64) NOT NULL,
  reviewer_principal_id varchar(64) NOT NULL,reviewer jsonb NOT NULL,
  occurred_at_lexical text NOT NULL,occurred_at_key numeric(50,0) NOT NULL,record jsonb NOT NULL,
  PRIMARY KEY(tenant_id,event_id),UNIQUE(tenant_id,approval_id),
  FOREIGN KEY(tenant_id,project_id,environment_id,approval_id,approval_definition_sha256)
    REFERENCES public.proofstack_release_approvals(tenant_id,project_id,environment_id,approval_id,definition_sha256),
  CHECK((event_id ~ '^[a-z][a-z0-9_]{2,63}$' AND reviewer_principal_id ~ '^[a-z][a-z0-9_]{2,63}$'
    AND record->>'schemaVersion'='0.1' AND record->>'eventId'=event_id
    AND record#>>'{scope,tenantId}'=tenant_id AND record#>>'{scope,projectId}'=project_id
    AND record#>>'{scope,environmentId}'=environment_id
    AND record#>>'{approval,approvalId}'=approval_id AND record#>>'{approval,definitionSha256}'=approval_definition_sha256
    AND record->'reviewer'=reviewer AND reviewer->>'principalId'=reviewer_principal_id
    AND reviewer->>'principalType'='user' AND reviewer->>'authenticationMethod'='oidc'
    AND record->>'occurredAt'=occurred_at_lexical
    AND occurred_at_key=public.proofstack_release_authority_time_key(occurred_at_lexical)
    AND public.proofstack_release_authority_time_key(reviewer->>'authenticatedAt')<=occurred_at_key
    AND octet_length(record::text)<=16384) IS TRUE)
);
CREATE UNIQUE INDEX proofstack_release_approval_outbox_unique ON public.proofstack_outbox(tenant_id,aggregate_type,aggregate_id)
  WHERE aggregate_type IN('release_approval','release_approval_revocation');

CREATE FUNCTION public.proofstack_lock_release_approval_write()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(
    jsonb_build_array('proofstack.release-approval.v1',NEW.tenant_id)::text,0));
  RETURN NEW;
END; $$;

REVOKE ALL ON FUNCTION public.proofstack_try_lock_release_approval(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.proofstack_lock_release_approval_write() FROM PUBLIC;

CREATE FUNCTION public.proofstack_verify_release_approval_graph()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE value public.proofstack_release_approvals;parent public.proofstack_release_approvals;
  category text;field_name text;observed jsonb;
BEGIN
  SELECT * INTO STRICT value FROM public.proofstack_release_approvals WHERE tenant_id=NEW.tenant_id AND approval_id=NEW.approval_id;
  IF (SELECT count(*) FROM public.proofstack_release_approval_sources s WHERE s.tenant_id=value.tenant_id AND s.approval_id=value.approval_id)<>6
    OR EXISTS(SELECT 1 FROM public.proofstack_release_approval_sources s
      WHERE s.tenant_id=value.tenant_id AND s.approval_id=value.approval_id AND s.reference IS DISTINCT FROM value.subject->s.kind)
    OR (SELECT COALESCE(jsonb_agg(c.reference ORDER BY c.ordinal),'[]'::jsonb)
      FROM public.proofstack_release_approval_controls c WHERE c.tenant_id=value.tenant_id AND c.approval_id=value.approval_id)
      IS DISTINCT FROM value.record->'compensatingControls'
    OR EXISTS(SELECT 1 FROM (SELECT c.ordinal,row_number() OVER(ORDER BY c.ordinal)-1 AS expected
      FROM public.proofstack_release_approval_controls c WHERE c.tenant_id=value.tenant_id AND c.approval_id=value.approval_id) q WHERE q.ordinal<>q.expected)
    OR EXISTS(SELECT 1 FROM (SELECT d.ordinal,row_number() OVER(PARTITION BY d.kind ORDER BY d.ordinal)-1 AS expected
      FROM public.proofstack_release_approval_declarations d WHERE d.tenant_id=value.tenant_id AND d.approval_id=value.approval_id) q WHERE q.ordinal<>q.expected)
    OR NOT EXISTS(SELECT 1 FROM public.proofstack_outbox o WHERE o.tenant_id=value.tenant_id
      AND o.aggregate_type='release_approval' AND o.aggregate_id=value.approval_id
      AND o.event_type='release.approval.recorded' AND o.schema_version='0.1'
      AND o.payload=jsonb_build_object('recordKind','release_approval','record',value.record)
      AND o.created_at=value.recorded_at_lexical::timestamptz) THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Incomplete normalized approval graph/intent';
  END IF;
  FOR category,field_name IN SELECT * FROM (VALUES('condition','conditions'),('conflict','declaredConflicts')) fields LOOP
    SELECT COALESCE(jsonb_agg(d.declaration ORDER BY d.ordinal),'[]'::jsonb) INTO observed
      FROM public.proofstack_release_approval_declarations d WHERE d.tenant_id=value.tenant_id AND d.approval_id=value.approval_id AND d.kind=category;
    IF observed IS DISTINCT FROM value.record->field_name THEN
      RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Incomplete normalized approval declarations';
    END IF;
  END LOOP;
  IF value.parent_approval_id IS NOT NULL THEN
    SELECT * INTO STRICT parent FROM public.proofstack_release_approvals WHERE tenant_id=value.tenant_id AND approval_id=value.parent_approval_id;
    IF parent.kind<>value.kind OR parent.subject<>value.subject OR parent.reviewer_principal_id<>value.reviewer_principal_id
      OR parent.recorded_at_key>value.recorded_at_key OR value.record->'supersedes' IS DISTINCT FROM
        jsonb_build_object('approvalId',parent.approval_id,'definitionSha256',parent.definition_sha256) THEN
      RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Invalid exact approval supersession lineage';
    END IF;
  END IF;
  RETURN NULL;
END; $$;

CREATE FUNCTION public.proofstack_verify_release_approval_revocation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE value public.proofstack_release_approvals;
BEGIN
  SELECT * INTO STRICT value FROM public.proofstack_release_approvals WHERE tenant_id=NEW.tenant_id AND approval_id=NEW.approval_id;
  IF value.reviewer_principal_id<>NEW.reviewer_principal_id OR value.recorded_at_key>NEW.occurred_at_key
    OR NEW.record->'approval' IS DISTINCT FROM jsonb_build_object('approvalId',value.approval_id,'definitionSha256',value.definition_sha256)
    OR NOT EXISTS(SELECT 1 FROM public.proofstack_outbox o WHERE o.tenant_id=NEW.tenant_id
      AND o.aggregate_type='release_approval_revocation' AND o.aggregate_id=NEW.event_id
      AND o.event_type='release.approval.revoked' AND o.schema_version='0.1'
      AND o.payload=jsonb_build_object('recordKind','release_approval_revocation','record',NEW.record)
      AND o.created_at=NEW.occurred_at_lexical::timestamptz) THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Invalid original approval revocation/intent';
  END IF;
  RETURN NULL;
END; $$;

DO $$ DECLARE name text; BEGIN
  FOREACH name IN ARRAY ARRAY['proofstack_release_approvals','proofstack_release_approval_sources',
    'proofstack_release_approval_declarations','proofstack_release_approval_controls','proofstack_release_approval_revocations'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.proofstack_reject_append_only_mutation()',name||'_append_only',name);
    EXECUTE format('CREATE TRIGGER %I AFTER INSERT ON public.%I FOR EACH ROW EXECUTE FUNCTION public.proofstack_lock_release_approval_write()',name||'_write_guard',name);
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',name);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR ALL USING(tenant_id=NULLIF(current_setting(''proofstack.tenant_id'',true),'''') AND project_id=NULLIF(current_setting(''proofstack.project_id'',true),'''') AND environment_id=NULLIF(current_setting(''proofstack.environment_id'',true),'''')) WITH CHECK(tenant_id=NULLIF(current_setting(''proofstack.tenant_id'',true),'''') AND project_id=NULLIF(current_setting(''proofstack.project_id'',true),'''') AND environment_id=NULLIF(current_setting(''proofstack.environment_id'',true),''''))',name||'_scope',name);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC',name);
    IF name<>'proofstack_release_approval_revocations' THEN
      EXECUTE format('CREATE CONSTRAINT TRIGGER %I AFTER INSERT ON public.%I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.proofstack_verify_release_approval_graph()',name||'_complete',name);
    END IF;
  END LOOP;
END; $$;
CREATE CONSTRAINT TRIGGER proofstack_release_approval_revocations_complete AFTER INSERT ON public.proofstack_release_approval_revocations
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.proofstack_verify_release_approval_revocation();
REVOKE ALL ON FUNCTION public.proofstack_verify_release_approval_graph() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.proofstack_verify_release_approval_revocation() FROM PUBLIC;

CREATE FUNCTION public.proofstack_store_release_approval(body jsonb,canonical text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE scope jsonb:=public.proofstack_release_selection_scope();tenant text:=scope->>'tenantId';
  prior public.proofstack_release_approvals;parent public.proofstack_release_approvals;
  item jsonb;ordinal_value integer;category text;field_name text;
BEGIN
  IF body#>'{subject,scope}' IS DISTINCT FROM scope THEN
    RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Release approval storage scope mismatch';
  END IF;
  IF current_setting('transaction_isolation')<>'read committed' THEN
    RAISE EXCEPTION USING ERRCODE='0A000',MESSAGE='Release approval storage requires READ COMMITTED';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array('proofstack.release-approval.v1',tenant)::text,0));
  SELECT * INTO prior FROM public.proofstack_release_approvals WHERE tenant_id=tenant AND approval_id=body->>'approvalId';
  IF FOUND THEN
    -- Compare immutable caller intent plus authenticated principal, not fresh derived authority,
    -- login/recording receipts or the full definition hash that deliberately binds those receipts.
    IF jsonb_build_object('intent',prior.record-ARRAY['schemaVersion','definitionSha256','reviewer','authority','recordedAt'],
        'reviewerPrincipalId',prior.reviewer_principal_id) IS DISTINCT FROM
      jsonb_build_object('intent',body-ARRAY['schemaVersion','definitionSha256','reviewer','authority','recordedAt'],
        'reviewerPrincipalId',body#>>'{reviewer,principalId}') THEN
      RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='release_approval:approval_conflict';
    END IF;
    RETURN jsonb_build_object('created',false,'record',prior.record);
  END IF;
  IF body ? 'supersedes' THEN
    SELECT * INTO parent FROM public.proofstack_release_approvals WHERE tenant_id=tenant
      AND approval_id=body#>>'{supersedes,approvalId}' AND definition_sha256=body#>>'{supersedes,definitionSha256}'
      AND project_id=scope->>'projectId' AND environment_id=scope->>'environmentId'
      AND kind=body->>'kind' AND subject=body->'subject' AND reviewer_principal_id=body#>>'{reviewer,principalId}';
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='release_approval:lineage_invalid'; END IF;
    IF parent.recorded_at_key>public.proofstack_release_authority_time_key(body->>'recordedAt') THEN
      RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='release_approval:receipt_invalid';
    END IF;
    IF EXISTS(SELECT 1 FROM public.proofstack_release_approvals WHERE tenant_id=tenant AND parent_approval_id=parent.approval_id) THEN
      RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='release_approval:supersession_conflict';
    END IF;
  END IF;
  INSERT INTO public.proofstack_release_approvals VALUES(tenant,scope->>'projectId',scope->>'environmentId',body->>'approvalId',body->>'definitionSha256',
    body->>'kind',body->>'action',body->'subject',body->'reviewer',body->'authority',body#>>'{subject,jobId}',body#>>'{subject,ruleId}',
    body#>>'{reviewer,principalId}',body#>>'{reviewer,credentialId}',body#>>'{reviewer,requestId}',body#>>'{reviewer,authenticatedAt}',
    body->>'recordedAt',body->>'expiresAt',public.proofstack_release_authority_time_key(body#>>'{reviewer,authenticatedAt}'),
    public.proofstack_release_authority_time_key(body->>'recordedAt'),public.proofstack_release_authority_time_key(body->>'expiresAt'),
    body#>>'{supersedes,approvalId}',body#>>'{supersedes,definitionSha256}',jsonb_array_length(body->'conditions'),
    jsonb_array_length(body->'declaredConflicts'),jsonb_array_length(body->'compensatingControls'),canonical,body);
  FOR category,field_name IN SELECT * FROM (VALUES('selection','selectionVersionId'),('candidate','candidateVersionId'),
    ('policy','policyVersionId'),('request','evaluationRequestId'),('snapshot','snapshotId'),('evaluation','evaluationId')) fields LOOP
    item:=body#>ARRAY['subject',category];
    INSERT INTO public.proofstack_release_approval_sources VALUES(tenant,scope->>'projectId',scope->>'environmentId',body->>'approvalId',body->>'definitionSha256',
      category,item->>field_name,item->>'definitionSha256',item);
  END LOOP;
  FOR category,field_name IN SELECT * FROM (VALUES('condition','conditions'),('conflict','declaredConflicts')) fields LOOP
    FOR item,ordinal_value IN SELECT value,ordinality::integer-1 FROM jsonb_array_elements(body->field_name) WITH ORDINALITY LOOP
      INSERT INTO public.proofstack_release_approval_declarations VALUES(tenant,scope->>'projectId',scope->>'environmentId',
        body->>'approvalId',body->>'definitionSha256',category,ordinal_value,item#>>'{}');
    END LOOP;
  END LOOP;
  FOR item,ordinal_value IN SELECT value,ordinality::integer-1 FROM jsonb_array_elements(body->'compensatingControls') WITH ORDINALITY LOOP
    INSERT INTO public.proofstack_release_approval_controls VALUES(tenant,scope->>'projectId',scope->>'environmentId',
      body->>'approvalId',body->>'definitionSha256',ordinal_value,item->>'artifactId',item->>'sha256',item);
  END LOOP;
  INSERT INTO public.proofstack_outbox(tenant_id,event_type,aggregate_type,aggregate_id,schema_version,payload,created_at)
    VALUES(tenant,'release.approval.recorded','release_approval',body->>'approvalId','0.1',
      jsonb_build_object('recordKind','release_approval','record',body),(body->>'recordedAt')::timestamptz);
  RETURN jsonb_build_object('created',true,'record',body);
END; $$;
REVOKE ALL ON FUNCTION public.proofstack_store_release_approval(jsonb,text) FROM PUBLIC;

CREATE FUNCTION public.proofstack_store_release_approval_revocation(body jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE scope jsonb:=public.proofstack_release_selection_scope();tenant text:=scope->>'tenantId';
  prior public.proofstack_release_approval_revocations;original public.proofstack_release_approvals;
  at_key numeric:=public.proofstack_release_authority_time_key(body->>'occurredAt');
BEGIN
  IF body->'scope' IS DISTINCT FROM scope THEN
    RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Approval revocation storage scope mismatch';
  END IF;
  IF current_setting('transaction_isolation')<>'read committed' THEN
    RAISE EXCEPTION USING ERRCODE='0A000',MESSAGE='Approval storage requires READ COMMITTED';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array('proofstack.release-approval.v1',tenant)::text,0));
  -- Validate the original actor/reference/causal receipt BEFORE admitting even an existing
  -- event retry. The trusted owner separately authenticates CURRENT OIDC/CSRF before this port.
  SELECT * INTO original FROM public.proofstack_release_approvals WHERE tenant_id=tenant
    AND project_id=scope->>'projectId' AND environment_id=scope->>'environmentId'
    AND approval_id=body#>>'{approval,approvalId}' AND definition_sha256=body#>>'{approval,definitionSha256}'
    AND reviewer_principal_id=body#>>'{reviewer,principalId}';
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='release_approval:lineage_invalid'; END IF;
  IF original.recorded_at_key>at_key THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='release_approval:receipt_invalid';
  END IF;
  SELECT * INTO prior FROM public.proofstack_release_approval_revocations WHERE tenant_id=tenant AND event_id=body->>'eventId';
  IF FOUND THEN
    IF jsonb_build_object('intent',prior.record-ARRAY['occurredAt','reviewer'],'reviewerPrincipalId',prior.reviewer_principal_id)
      IS DISTINCT FROM jsonb_build_object('intent',body-ARRAY['occurredAt','reviewer'],'reviewerPrincipalId',body#>>'{reviewer,principalId}') THEN
      RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='release_approval:revocation_conflict';
    END IF;
    RETURN jsonb_build_object('created',false,'record',prior.record);
  END IF;
  IF EXISTS(SELECT 1 FROM public.proofstack_release_approval_revocations WHERE tenant_id=tenant AND approval_id=original.approval_id) THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='release_approval:revocation_state_conflict';
  END IF;
  INSERT INTO public.proofstack_release_approval_revocations VALUES(tenant,scope->>'projectId',scope->>'environmentId',
    body->>'eventId',original.approval_id,original.definition_sha256,body#>>'{reviewer,principalId}',body->'reviewer',body->>'occurredAt',at_key,body);
  INSERT INTO public.proofstack_outbox(tenant_id,event_type,aggregate_type,aggregate_id,schema_version,payload,created_at)
    VALUES(tenant,'release.approval.revoked','release_approval_revocation',body->>'eventId','0.1',
      jsonb_build_object('recordKind','release_approval_revocation','record',body),(body->>'occurredAt')::timestamptz);
  RETURN jsonb_build_object('created',true,'record',body);
END; $$;
REVOKE ALL ON FUNCTION public.proofstack_store_release_approval_revocation(jsonb) FROM PUBLIC;

CREATE FUNCTION public.proofstack_read_release_approval_subject(expected_scope jsonb,requested_kind text,subject_value jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE scope jsonb:=public.proofstack_release_selection_scope();present boolean;
BEGIN
  IF expected_scope IS DISTINCT FROM scope OR subject_value->'scope' IS DISTINCT FROM scope
    OR requested_kind IS NULL OR requested_kind NOT IN('normal_approval','rule_exception') THEN
    RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Exact approval subject scope/kind is required';
  END IF;
  IF NOT public.proofstack_try_lock_release_approval(scope) THEN
    RAISE EXCEPTION USING ERRCODE='40001',MESSAGE='Approval source guard contended; whole rollback required';
  END IF;
  -- This VOLATILE SPI snapshot is acquired AFTER the retained shared guard. It observes exact
  -- subject/kind absence; subsequent fixed pages use the same still-held READ COMMITTED client.
  SELECT EXISTS(SELECT 1 FROM public.proofstack_release_approvals a WHERE a.tenant_id=scope->>'tenantId'
    AND a.project_id=scope->>'projectId' AND a.environment_id=scope->>'environmentId'
    AND a.kind=requested_kind AND a.subject=subject_value) INTO present;
  RETURN jsonb_build_object('kind',requested_kind,'subject',subject_value,'present',present);
END; $$;
REVOKE ALL ON FUNCTION public.proofstack_read_release_approval_subject(jsonb,text,jsonb) FROM PUBLIC;
