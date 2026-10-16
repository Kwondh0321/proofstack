-- Trusted declaration storage, not installer authentication or complete decision publication.
-- Separate C4 domain: one tenant-wide selection guard protects the entire installed inventory,
-- including missing targets/versions/events. No production throughput claim is implied.
CREATE FUNCTION public.proofstack_release_selection_scope()
RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path = pg_catalog AS $$
DECLARE tenant text:=current_setting('proofstack.tenant_id',true);
  project text:=current_setting('proofstack.project_id',true);
  environment text:=current_setting('proofstack.environment_id',true);
BEGIN
  IF tenant IS NULL OR tenant !~ '^[a-z][a-z0-9_]{2,63}$'
    OR project IS NULL OR project !~ '^[a-z][a-z0-9_]{2,63}$'
    OR environment IS NULL OR environment !~ '^[a-z][a-z0-9_]{2,63}$' THEN
    RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Exact release selection scope is required';
  END IF;
  RETURN jsonb_build_object('tenantId',tenant,'projectId',project,'environmentId',environment);
END; $$;

CREATE FUNCTION public.proofstack_release_authority_time_key(value text)
RETURNS numeric LANGUAGE plpgsql IMMUTABLE STRICT SET search_path = pg_catalog AS $$
DECLARE parts text[]; seconds timestamptz;
BEGIN
  parts:=regexp_match(value,'^([0-9]{4}-[0-9]{2}-[0-9]{2}T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9])(?:[.]([0-9]{1,30}))?Z$');
  IF parts IS NULL OR left(parts[1],4)='0000' THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Exact UTC release authority time is required';
  END IF;
  seconds:=(parts[1]||'Z')::timestamptz;
  RETURN extract(epoch FROM seconds)*1000000000000000000000000000000
    +rpad(COALESCE(parts[2],''),30,'0')::numeric;
END; $$;

CREATE FUNCTION public.proofstack_try_lock_release_selection(expected_scope jsonb)
RETURNS boolean LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE scope jsonb:=public.proofstack_release_selection_scope();
BEGIN
  IF expected_scope IS DISTINCT FROM scope THEN
    RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Release selection lock scope mismatch';
  END IF;
  IF current_setting('transaction_isolation')<>'read committed' THEN
    RAISE EXCEPTION USING ERRCODE='0A000',MESSAGE='Release selection guards require READ COMMITTED';
  END IF;
  RETURN pg_try_advisory_xact_lock_shared(hashtextextended(
    jsonb_build_array('proofstack.release-selection.v1',scope->>'tenantId')::text,0));
END; $$;

CREATE TABLE public.proofstack_release_selection_roots (
  tenant_id varchar(64) NOT NULL, project_id varchar(64) NOT NULL, environment_id varchar(64) NOT NULL,
  selection_id varchar(64) NOT NULL, installation_id varchar(64) NOT NULL, gate_target_id varchar(64) NOT NULL,
  root_version_id varchar(64) NOT NULL, root_definition_sha256 char(64) NOT NULL,
  PRIMARY KEY(tenant_id,selection_id),
  UNIQUE(tenant_id,installation_id,gate_target_id),
  UNIQUE(tenant_id,project_id,environment_id,selection_id,installation_id,gate_target_id),
  CHECK((tenant_id ~ '^[a-z][a-z0-9_]{2,63}$' AND project_id ~ '^[a-z][a-z0-9_]{2,63}$'
    AND environment_id ~ '^[a-z][a-z0-9_]{2,63}$' AND selection_id ~ '^[a-z][a-z0-9_]{2,63}$'
    AND installation_id ~ '^[a-z][a-z0-9_]{2,63}$' AND gate_target_id ~ '^[a-z][a-z0-9_]{2,63}$'
    AND root_version_id ~ '^[a-z][a-z0-9_]{2,63}$' AND root_definition_sha256 ~ '^[0-9a-f]{64}$') IS TRUE)
);
CREATE TABLE public.proofstack_release_policy_selections (
  tenant_id varchar(64) NOT NULL, project_id varchar(64) NOT NULL, environment_id varchar(64) NOT NULL,
  selection_id varchar(64) NOT NULL, version_id varchar(64) NOT NULL,
  installation_id varchar(64) NOT NULL, gate_target_id varchar(64) NOT NULL,
  definition_sha256 char(64) NOT NULL, mode text NOT NULL,
  effective_at_lexical text NOT NULL, expires_at_lexical text NOT NULL, published_at_lexical text NOT NULL,
  effective_at_key numeric(50,0) NOT NULL, expires_at_key numeric(50,0) NOT NULL, published_at_key numeric(50,0) NOT NULL,
  published_by_principal_id varchar(64) NOT NULL,
  parent_version_id varchar(64), parent_definition_sha256 char(64),
  policy_count smallint NOT NULL, publisher_count smallint NOT NULL,
  canonical_utf8 text NOT NULL, record jsonb NOT NULL,
  PRIMARY KEY(tenant_id,version_id),
  UNIQUE(tenant_id,project_id,environment_id,version_id,definition_sha256),
  FOREIGN KEY(tenant_id,project_id,environment_id,selection_id,installation_id,gate_target_id)
    REFERENCES public.proofstack_release_selection_roots(tenant_id,project_id,environment_id,selection_id,installation_id,gate_target_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(tenant_id,project_id,environment_id,parent_version_id,parent_definition_sha256)
    REFERENCES public.proofstack_release_policy_selections(tenant_id,project_id,environment_id,version_id,definition_sha256)
    DEFERRABLE INITIALLY DEFERRED,
  CHECK((version_id ~ '^[a-z][a-z0-9_]{2,63}$' AND definition_sha256 ~ '^[0-9a-f]{64}$'
    AND published_by_principal_id ~ '^[a-z][a-z0-9_]{2,63}$'
    AND (parent_version_id IS NULL)=(parent_definition_sha256 IS NULL)
    AND parent_version_id IS DISTINCT FROM version_id) IS TRUE),
  CHECK((record->>'schemaVersion'='0.1' AND record->>'selectionId'=selection_id
    AND record->>'selectionVersionId'=version_id AND record->>'definitionSha256'=definition_sha256
    AND record->>'installationId'=installation_id AND record->>'gateTargetId'=gate_target_id
    AND record#>>'{scope,tenantId}'=tenant_id AND record#>>'{scope,projectId}'=project_id
    AND record#>>'{scope,environmentId}'=environment_id AND record->>'mode'=mode
    AND record->>'publishedByPrincipalId'=published_by_principal_id
    AND record->>'issuerPrincipalId'=published_by_principal_id
    AND record->>'effectiveAt'=effective_at_lexical AND record->>'expiresAt'=expires_at_lexical
    AND record->>'publishedAt'=published_at_lexical
    AND record#>>'{predecessor,selectionVersionId}' IS NOT DISTINCT FROM parent_version_id
    AND record#>>'{predecessor,definitionSha256}' IS NOT DISTINCT FROM parent_definition_sha256
    AND policy_count BETWEEN 0 AND 16 AND policy_count=jsonb_array_length(record->'policies')
    AND publisher_count BETWEEN 1 AND 32 AND publisher_count=jsonb_array_length(record->'authorizedPublisherPrincipalIds')
    AND mode IN('observation_only','enforce')) IS TRUE),
  CHECK((effective_at_key=public.proofstack_release_authority_time_key(effective_at_lexical)
    AND expires_at_key=public.proofstack_release_authority_time_key(expires_at_lexical)
    AND published_at_key=public.proofstack_release_authority_time_key(published_at_lexical)
    AND effective_at_key<expires_at_key AND published_at_key<expires_at_key) IS TRUE),
  CHECK((octet_length(canonical_utf8)<=266240 AND octet_length(record::text)<=270336
    AND encode(sha256(convert_to(canonical_utf8,'UTF8')),'hex')=definition_sha256
    AND canonical_utf8::jsonb=jsonb_build_object(
      'schemaVersion','0.1','definitionDomain','proofstack.release-policy-selection.v1',
      'encodingVersion','proofstack.release-policy-selection-definition-jcs.v1','scope',record->'scope',
      'definition',record-ARRAY['schemaVersion','definitionSha256','publishedAt','publishedByPrincipalId'])) IS TRUE)
);
ALTER TABLE public.proofstack_release_selection_roots ADD FOREIGN KEY(
  tenant_id,project_id,environment_id,root_version_id,root_definition_sha256)
  REFERENCES public.proofstack_release_policy_selections(tenant_id,project_id,environment_id,version_id,definition_sha256)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE public.proofstack_release_selection_policies (
  tenant_id varchar(64) NOT NULL,project_id varchar(64) NOT NULL,environment_id varchar(64) NOT NULL,
  version_id varchar(64) NOT NULL,definition_sha256 char(64) NOT NULL,ordinal smallint NOT NULL,
  policy_id varchar(64) NOT NULL,policy_version_id varchar(64) NOT NULL,policy_definition_sha256 char(64) NOT NULL,
  mode text NOT NULL,projection jsonb NOT NULL,
  PRIMARY KEY(tenant_id,version_id,ordinal),UNIQUE(tenant_id,version_id,policy_id),
  FOREIGN KEY(tenant_id,project_id,environment_id,version_id,definition_sha256)
    REFERENCES public.proofstack_release_policy_selections(tenant_id,project_id,environment_id,version_id,definition_sha256)
    DEFERRABLE INITIALLY DEFERRED,
  CHECK((ordinal BETWEEN 0 AND 15 AND policy_id ~ '^[a-z][a-z0-9_]{2,63}$'
    AND policy_version_id ~ '^[a-z][a-z0-9_]{2,63}$' AND policy_definition_sha256 ~ '^[0-9a-f]{64}$'
    AND projection#>>'{policy,policyId}'=policy_id AND projection#>>'{policy,policyVersionId}'=policy_version_id
    AND projection#>>'{policy,definitionSha256}'=policy_definition_sha256 AND projection->>'mode'=mode
    AND mode IN('advisory','mandatory')) IS TRUE)
);
CREATE TABLE public.proofstack_release_selection_publishers (
  tenant_id varchar(64) NOT NULL,project_id varchar(64) NOT NULL,environment_id varchar(64) NOT NULL,
  version_id varchar(64) NOT NULL,definition_sha256 char(64) NOT NULL,ordinal smallint NOT NULL,principal_id varchar(64) NOT NULL,
  PRIMARY KEY(tenant_id,version_id,ordinal),UNIQUE(tenant_id,version_id,principal_id),
  FOREIGN KEY(tenant_id,project_id,environment_id,version_id,definition_sha256)
    REFERENCES public.proofstack_release_policy_selections(tenant_id,project_id,environment_id,version_id,definition_sha256)
    DEFERRABLE INITIALLY DEFERRED,
  CHECK((ordinal BETWEEN 0 AND 31 AND principal_id ~ '^[a-z][a-z0-9_]{2,63}$') IS TRUE)
);
CREATE TABLE public.proofstack_release_selection_lifecycle (
  tenant_id varchar(64) NOT NULL,project_id varchar(64) NOT NULL,environment_id varchar(64) NOT NULL,
  event_id varchar(64) NOT NULL,version_id varchar(64) NOT NULL,definition_sha256 char(64) NOT NULL,
  successor_version_id varchar(64),successor_definition_sha256 char(64),
  occurred_at_lexical text NOT NULL,occurred_at_key numeric(50,0) NOT NULL,record jsonb NOT NULL,
  PRIMARY KEY(tenant_id,event_id),UNIQUE(tenant_id,version_id),
  FOREIGN KEY(tenant_id,project_id,environment_id,version_id,definition_sha256)
    REFERENCES public.proofstack_release_policy_selections(tenant_id,project_id,environment_id,version_id,definition_sha256),
  FOREIGN KEY(tenant_id,project_id,environment_id,successor_version_id,successor_definition_sha256)
    REFERENCES public.proofstack_release_policy_selections(tenant_id,project_id,environment_id,version_id,definition_sha256),
  CHECK((event_id ~ '^[a-z][a-z0-9_]{2,63}$' AND record->>'schemaVersion'='0.1' AND record->>'eventId'=event_id
    AND record#>>'{scope,tenantId}'=tenant_id AND record#>>'{scope,projectId}'=project_id
    AND record#>>'{scope,environmentId}'=environment_id
    AND record#>>'{selection,selectionVersionId}'=version_id AND record#>>'{selection,definitionSha256}'=definition_sha256
    AND record#>>'{successor,selectionVersionId}' IS NOT DISTINCT FROM successor_version_id
    AND record#>>'{successor,definitionSha256}' IS NOT DISTINCT FROM successor_definition_sha256
    AND (record->>'kind'='superseded')=(successor_version_id IS NOT NULL)
    AND record->>'kind' IN('withdrawn','superseded')
    AND (successor_version_id IS NULL)=(successor_definition_sha256 IS NULL)
    AND record->>'occurredAt'=occurred_at_lexical
    AND occurred_at_key=public.proofstack_release_authority_time_key(occurred_at_lexical)
    AND octet_length(record::text)<=12288) IS TRUE)
);
CREATE UNIQUE INDEX proofstack_release_selection_outbox_unique ON public.proofstack_outbox(
  tenant_id,aggregate_type,aggregate_id)
  WHERE aggregate_type IN('release_policy_selection','release_policy_selection_lifecycle');

CREATE FUNCTION public.proofstack_lock_release_selection_write()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(
    jsonb_build_array('proofstack.release-selection.v1',NEW.tenant_id)::text,0));
  RETURN NEW;
END; $$;

CREATE FUNCTION public.proofstack_verify_release_selection_graph()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE version text:=COALESCE(to_jsonb(NEW)->>'root_version_id',to_jsonb(NEW)->>'version_id');
  value public.proofstack_release_policy_selections;root public.proofstack_release_selection_roots;
  first_value public.proofstack_release_policy_selections;parent public.proofstack_release_policy_selections;
BEGIN
  SELECT * INTO STRICT value FROM public.proofstack_release_policy_selections
    WHERE tenant_id=NEW.tenant_id AND version_id=version;
  SELECT * INTO STRICT root FROM public.proofstack_release_selection_roots
    WHERE tenant_id=value.tenant_id AND selection_id=value.selection_id;
  SELECT * INTO STRICT first_value FROM public.proofstack_release_policy_selections
    WHERE tenant_id=root.tenant_id AND version_id=root.root_version_id;
  IF first_value.parent_version_id IS NOT NULL OR first_value.selection_id<>root.selection_id
    OR first_value.definition_sha256<>root.root_definition_sha256 OR first_value.published_at_key>value.published_at_key
    OR (SELECT COALESCE(jsonb_agg(p.projection ORDER BY p.ordinal),'[]'::jsonb)
      FROM public.proofstack_release_selection_policies p WHERE p.tenant_id=value.tenant_id AND p.version_id=value.version_id)
      IS DISTINCT FROM value.record->'policies'
    OR (SELECT COALESCE(jsonb_agg(p.principal_id ORDER BY p.ordinal),'[]'::jsonb)
      FROM public.proofstack_release_selection_publishers p WHERE p.tenant_id=value.tenant_id AND p.version_id=value.version_id)
      IS DISTINCT FROM value.record->'authorizedPublisherPrincipalIds'
    OR EXISTS(SELECT 1 FROM (SELECT p.ordinal,row_number() OVER(ORDER BY p.ordinal)-1 AS expected
      FROM public.proofstack_release_selection_policies p WHERE p.tenant_id=value.tenant_id AND p.version_id=value.version_id) q
      WHERE q.ordinal<>q.expected)
    OR EXISTS(SELECT 1 FROM (SELECT p.ordinal,row_number() OVER(ORDER BY p.ordinal)-1 AS expected
      FROM public.proofstack_release_selection_publishers p WHERE p.tenant_id=value.tenant_id AND p.version_id=value.version_id) q
      WHERE q.ordinal<>q.expected)
    OR NOT EXISTS(SELECT 1 FROM public.proofstack_outbox o WHERE o.tenant_id=value.tenant_id
      AND o.aggregate_type='release_policy_selection' AND o.aggregate_id=value.version_id
      AND o.event_type='release.selection.published' AND o.schema_version='0.1'
      AND o.payload=jsonb_build_object('recordKind','release_policy_selection','record',value.record)
      AND o.created_at=value.published_at_lexical::timestamptz) THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Incomplete normalized release selection graph/intent';
  END IF;
  IF value.parent_version_id IS NOT NULL THEN
    SELECT * INTO STRICT parent FROM public.proofstack_release_policy_selections
      WHERE tenant_id=value.tenant_id AND version_id=value.parent_version_id;
    IF parent.selection_id<>value.selection_id OR parent.installation_id<>value.installation_id
      OR parent.gate_target_id<>value.gate_target_id OR parent.published_at_key>value.published_at_key
      OR value.record->'predecessor' IS DISTINCT FROM jsonb_build_object('selectionId',parent.selection_id,
        'selectionVersionId',parent.version_id,'definitionSha256',parent.definition_sha256,
        'installationId',parent.installation_id,'gateTargetId',parent.gate_target_id) THEN
      RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Invalid exact release selection lineage';
    END IF;
  END IF;
  RETURN NULL;
END; $$;

CREATE FUNCTION public.proofstack_verify_release_selection_lifecycle()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE value public.proofstack_release_policy_selections;successor public.proofstack_release_policy_selections;
BEGIN
  SELECT * INTO STRICT value FROM public.proofstack_release_policy_selections WHERE tenant_id=NEW.tenant_id AND version_id=NEW.version_id;
  IF NEW.record->'selection' IS DISTINCT FROM jsonb_build_object('selectionId',value.selection_id,
    'selectionVersionId',value.version_id,'definitionSha256',value.definition_sha256,
    'installationId',value.installation_id,'gateTargetId',value.gate_target_id)
    OR NEW.occurred_at_key<value.published_at_key THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Invalid exact selection lifecycle receipt';
  END IF;
  IF NEW.successor_version_id IS NOT NULL THEN
    SELECT * INTO STRICT successor FROM public.proofstack_release_policy_selections WHERE tenant_id=NEW.tenant_id AND version_id=NEW.successor_version_id;
    IF successor.record->'predecessor' IS DISTINCT FROM NEW.record->'selection'
      OR NEW.record->'successor' IS DISTINCT FROM jsonb_build_object('selectionId',successor.selection_id,
        'selectionVersionId',successor.version_id,'definitionSha256',successor.definition_sha256,
        'installationId',successor.installation_id,'gateTargetId',successor.gate_target_id)
      OR NEW.occurred_at_key<successor.published_at_key THEN
      RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Invalid exact selection lifecycle successor';
    END IF;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.proofstack_outbox o WHERE o.tenant_id=NEW.tenant_id
    AND o.aggregate_type='release_policy_selection_lifecycle' AND o.aggregate_id=NEW.event_id
    AND o.event_type='release.selection.lifecycle_recorded' AND o.schema_version='0.1'
    AND o.payload=jsonb_build_object('recordKind','release_policy_selection_lifecycle','record',NEW.record)
    AND o.created_at=NEW.occurred_at_lexical::timestamptz) THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Incomplete release selection lifecycle intent';
  END IF;
  RETURN NULL;
END; $$;

DO $$ DECLARE name text; BEGIN
  FOREACH name IN ARRAY ARRAY['proofstack_release_selection_roots','proofstack_release_policy_selections',
    'proofstack_release_selection_policies','proofstack_release_selection_publishers','proofstack_release_selection_lifecycle'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.proofstack_reject_append_only_mutation()',name||'_append_only',name);
    EXECUTE format('CREATE TRIGGER %I AFTER INSERT ON public.%I FOR EACH ROW EXECUTE FUNCTION public.proofstack_lock_release_selection_write()',name||'_write_guard',name);
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',name);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR ALL USING(tenant_id=NULLIF(current_setting(''proofstack.tenant_id'',true),'''') AND project_id=NULLIF(current_setting(''proofstack.project_id'',true),'''') AND environment_id=NULLIF(current_setting(''proofstack.environment_id'',true),'''')) WITH CHECK(tenant_id=NULLIF(current_setting(''proofstack.tenant_id'',true),'''') AND project_id=NULLIF(current_setting(''proofstack.project_id'',true),'''') AND environment_id=NULLIF(current_setting(''proofstack.environment_id'',true),''''))',name||'_scope',name);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC',name);
    IF name<>'proofstack_release_selection_lifecycle' THEN
      EXECUTE format('CREATE CONSTRAINT TRIGGER %I AFTER INSERT ON public.%I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.proofstack_verify_release_selection_graph()',name||'_complete',name);
    END IF;
  END LOOP;
END; $$;
CREATE CONSTRAINT TRIGGER proofstack_release_selection_lifecycle_complete AFTER INSERT ON public.proofstack_release_selection_lifecycle
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.proofstack_verify_release_selection_lifecycle();

REVOKE ALL ON FUNCTION public.proofstack_release_selection_scope() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.proofstack_release_authority_time_key(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.proofstack_try_lock_release_selection(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.proofstack_lock_release_selection_write() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.proofstack_verify_release_selection_graph() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.proofstack_verify_release_selection_lifecycle() FROM PUBLIC;

CREATE FUNCTION public.proofstack_store_release_policy_selection(body jsonb,canonical text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE scope jsonb:=public.proofstack_release_selection_scope();tenant text:=scope->>'tenantId';
  prior public.proofstack_release_policy_selections;root public.proofstack_release_selection_roots;
  parent public.proofstack_release_policy_selections;item jsonb;ordinal_value integer;
BEGIN
  IF body->'scope' IS DISTINCT FROM scope THEN
    RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Release selection storage scope mismatch';
  END IF;
  IF current_setting('transaction_isolation')<>'read committed' THEN
    RAISE EXCEPTION USING ERRCODE='0A000',MESSAGE='Release selection storage requires READ COMMITTED';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array('proofstack.release-selection.v1',tenant)::text,0));
  SELECT * INTO prior FROM public.proofstack_release_policy_selections
    WHERE tenant_id=tenant AND version_id=body->>'selectionVersionId';
  IF FOUND THEN
    IF prior.record-ARRAY['publishedAt','publishedByPrincipalId'] IS DISTINCT FROM body-ARRAY['publishedAt','publishedByPrincipalId'] THEN
      RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='release_selection:version_conflict';
    END IF;
    RETURN jsonb_build_object('created',false,'record',prior.record);
  END IF;
  SELECT * INTO root FROM public.proofstack_release_selection_roots
    WHERE tenant_id=tenant AND (selection_id=body->>'selectionId'
      OR (installation_id=body->>'installationId' AND gate_target_id=body->>'gateTargetId'));
  IF FOUND AND (root.selection_id<>body->>'selectionId' OR root.installation_id<>body->>'installationId'
    OR root.gate_target_id<>body->>'gateTargetId' OR root.project_id<>scope->>'projectId' OR root.environment_id<>scope->>'environmentId') THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='release_selection:target_conflict';
  END IF;
  IF root.root_version_id IS NOT NULL AND public.proofstack_release_authority_time_key(body->>'publishedAt')<
    (SELECT published_at_key FROM public.proofstack_release_policy_selections WHERE tenant_id=tenant AND version_id=root.root_version_id) THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='release_selection:receipt_invalid';
  END IF;
  IF body ? 'predecessor' THEN
    SELECT * INTO parent FROM public.proofstack_release_policy_selections WHERE tenant_id=tenant
      AND version_id=body#>>'{predecessor,selectionVersionId}' AND definition_sha256=body#>>'{predecessor,definitionSha256}'
      AND project_id=scope->>'projectId' AND environment_id=scope->>'environmentId'
      AND selection_id=body->>'selectionId' AND installation_id=body->>'installationId' AND gate_target_id=body->>'gateTargetId';
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='release_selection:lineage_invalid'; END IF;
    IF parent.published_at_key>public.proofstack_release_authority_time_key(body->>'publishedAt') THEN
      RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='release_selection:receipt_invalid';
    END IF;
  END IF;
  IF root.root_version_id IS NULL THEN
    IF body ? 'predecessor' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='release_selection:lineage_invalid'; END IF;
    INSERT INTO public.proofstack_release_selection_roots VALUES(tenant,scope->>'projectId',scope->>'environmentId',
      body->>'selectionId',body->>'installationId',body->>'gateTargetId',body->>'selectionVersionId',body->>'definitionSha256');
  END IF;
  INSERT INTO public.proofstack_release_policy_selections VALUES(tenant,scope->>'projectId',scope->>'environmentId',
    body->>'selectionId',body->>'selectionVersionId',body->>'installationId',body->>'gateTargetId',body->>'definitionSha256',body->>'mode',
    body->>'effectiveAt',body->>'expiresAt',body->>'publishedAt',public.proofstack_release_authority_time_key(body->>'effectiveAt'),
    public.proofstack_release_authority_time_key(body->>'expiresAt'),public.proofstack_release_authority_time_key(body->>'publishedAt'),
    body->>'publishedByPrincipalId',body#>>'{predecessor,selectionVersionId}',body#>>'{predecessor,definitionSha256}',
    jsonb_array_length(body->'policies'),jsonb_array_length(body->'authorizedPublisherPrincipalIds'),canonical,body);
  FOR item,ordinal_value IN SELECT value,ordinality::integer-1 FROM jsonb_array_elements(body->'policies') WITH ORDINALITY LOOP
    INSERT INTO public.proofstack_release_selection_policies VALUES(tenant,scope->>'projectId',scope->>'environmentId',
      body->>'selectionVersionId',body->>'definitionSha256',ordinal_value,item#>>'{policy,policyId}',item#>>'{policy,policyVersionId}',
      item#>>'{policy,definitionSha256}',item->>'mode',item);
  END LOOP;
  FOR item,ordinal_value IN SELECT value,ordinality::integer-1 FROM jsonb_array_elements(body->'authorizedPublisherPrincipalIds') WITH ORDINALITY LOOP
    INSERT INTO public.proofstack_release_selection_publishers VALUES(tenant,scope->>'projectId',scope->>'environmentId',
      body->>'selectionVersionId',body->>'definitionSha256',ordinal_value,item#>>'{}');
  END LOOP;
  INSERT INTO public.proofstack_outbox(tenant_id,event_type,aggregate_type,aggregate_id,schema_version,payload,created_at)
    VALUES(tenant,'release.selection.published','release_policy_selection',body->>'selectionVersionId','0.1',
      jsonb_build_object('recordKind','release_policy_selection','record',body),(body->>'publishedAt')::timestamptz);
  RETURN jsonb_build_object('created',true,'record',body);
END; $$;

CREATE FUNCTION public.proofstack_store_release_selection_lifecycle(body jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE scope jsonb:=public.proofstack_release_selection_scope();tenant text:=scope->>'tenantId';
  prior public.proofstack_release_selection_lifecycle;value public.proofstack_release_policy_selections;
  successor public.proofstack_release_policy_selections;at_key numeric:=public.proofstack_release_authority_time_key(body->>'occurredAt');
BEGIN
  IF body->'scope' IS DISTINCT FROM scope THEN
    RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Release selection lifecycle scope mismatch';
  END IF;
  IF current_setting('transaction_isolation')<>'read committed' THEN
    RAISE EXCEPTION USING ERRCODE='0A000',MESSAGE='Release selection storage requires READ COMMITTED';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array('proofstack.release-selection.v1',tenant)::text,0));
  SELECT * INTO prior FROM public.proofstack_release_selection_lifecycle WHERE tenant_id=tenant AND event_id=body->>'eventId';
  IF FOUND THEN
    IF prior.record-ARRAY['occurredAt','actorPrincipalId'] IS DISTINCT FROM body-ARRAY['occurredAt','actorPrincipalId'] THEN
      RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='release_selection:event_conflict';
    END IF;
    RETURN jsonb_build_object('created',false,'record',prior.record);
  END IF;
  SELECT * INTO value FROM public.proofstack_release_policy_selections WHERE tenant_id=tenant
    AND version_id=body#>>'{selection,selectionVersionId}' AND definition_sha256=body#>>'{selection,definitionSha256}'
    AND project_id=scope->>'projectId' AND environment_id=scope->>'environmentId'
    AND selection_id=body#>>'{selection,selectionId}' AND installation_id=body#>>'{selection,installationId}'
    AND gate_target_id=body#>>'{selection,gateTargetId}';
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='release_selection:lineage_invalid'; END IF;
  IF at_key<value.published_at_key THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='release_selection:receipt_invalid'; END IF;
  IF body->>'kind'='superseded' THEN
    SELECT * INTO successor FROM public.proofstack_release_policy_selections WHERE tenant_id=tenant
      AND version_id=body#>>'{successor,selectionVersionId}' AND definition_sha256=body#>>'{successor,definitionSha256}'
      AND project_id=scope->>'projectId' AND environment_id=scope->>'environmentId'
      AND selection_id=value.selection_id AND installation_id=value.installation_id AND gate_target_id=value.gate_target_id;
    IF NOT FOUND OR successor.record->'predecessor' IS DISTINCT FROM body->'selection' THEN
      RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='release_selection:lineage_invalid';
    END IF;
    IF at_key<successor.published_at_key THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='release_selection:receipt_invalid'; END IF;
  END IF;
  IF EXISTS(SELECT 1 FROM public.proofstack_release_selection_lifecycle WHERE tenant_id=tenant AND version_id=value.version_id) THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='release_selection:terminal_conflict';
  END IF;
  INSERT INTO public.proofstack_release_selection_lifecycle VALUES(tenant,scope->>'projectId',scope->>'environmentId',
    body->>'eventId',value.version_id,value.definition_sha256,body#>>'{successor,selectionVersionId}',body#>>'{successor,definitionSha256}',
    body->>'occurredAt',at_key,body);
  INSERT INTO public.proofstack_outbox(tenant_id,event_type,aggregate_type,aggregate_id,schema_version,payload,created_at)
    VALUES(tenant,'release.selection.lifecycle_recorded','release_policy_selection_lifecycle',body->>'eventId','0.1',
      jsonb_build_object('recordKind','release_policy_selection_lifecycle','record',body),(body->>'occurredAt')::timestamptz);
  RETURN jsonb_build_object('created',true,'record',body);
END; $$;
REVOKE ALL ON FUNCTION public.proofstack_store_release_policy_selection(jsonb,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.proofstack_store_release_selection_lifecycle(jsonb) FROM PUBLIC;

CREATE FUNCTION public.proofstack_read_release_selection_root(expected_scope jsonb,installation text,gate text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE scope jsonb:=public.proofstack_release_selection_scope();root jsonb;orphan boolean;
BEGIN
  IF expected_scope IS DISTINCT FROM scope OR installation IS NULL OR gate IS NULL
    OR installation !~ '^[a-z][a-z0-9_]{2,63}$' OR gate !~ '^[a-z][a-z0-9_]{2,63}$' THEN
    RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Exact release selection target scope is required';
  END IF;
  IF NOT public.proofstack_try_lock_release_selection(scope) THEN
    RAISE EXCEPTION USING ERRCODE='40001',MESSAGE='Release selection guard contended; whole rollback required';
  END IF;
  -- VOLATILE SPI reads take their READ COMMITTED snapshots AFTER guard acquisition. Do not fold
  -- this into a shared outer-statement snapshot or read before a potentially committing writer.
  SELECT to_jsonb(r) INTO root FROM public.proofstack_release_selection_roots r
    WHERE r.tenant_id=scope->>'tenantId' AND r.project_id=scope->>'projectId'
      AND r.environment_id=scope->>'environmentId' AND r.installation_id=installation AND r.gate_target_id=gate;
  SELECT EXISTS(SELECT 1 FROM public.proofstack_release_policy_selections v
    WHERE v.tenant_id=scope->>'tenantId' AND v.project_id=scope->>'projectId'
      AND v.environment_id=scope->>'environmentId' AND v.installation_id=installation AND v.gate_target_id=gate
      AND (root IS NULL OR v.selection_id IS DISTINCT FROM root->>'selection_id')) INTO orphan;
  RETURN jsonb_build_object('root',root,'orphan',orphan);
END; $$;
REVOKE ALL ON FUNCTION public.proofstack_read_release_selection_root(jsonb,text,text) FROM PUBLIC;
