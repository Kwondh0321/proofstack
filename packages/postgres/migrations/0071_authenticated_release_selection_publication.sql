-- Authenticated installation is separate from historical trusted declaration storage.
-- Old graphs remain unchanged and have no authenticated publication profile.
CREATE FUNCTION public.proofstack_release_installer_context(expected_scope jsonb)
RETURNS text LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE scoped jsonb:=public.proofstack_release_selection_scope();role_value record;
BEGIN
  SELECT r.*,shobj_description(r.oid,'pg_authid') AS marker INTO role_value FROM pg_roles r WHERE r.rolname=session_user;
  IF role_value.marker IS DISTINCT FROM 'proofstack-managed-runtime-role:v1:releaseAuthority'
    OR NOT role_value.rolcanlogin OR role_value.rolsuper OR role_value.rolcreatedb OR role_value.rolcreaterole
    OR role_value.rolreplication OR role_value.rolbypassrls OR role_value.rolinherit
    OR EXISTS(SELECT 1 FROM pg_auth_members m WHERE m.member=role_value.oid OR m.roleid=role_value.oid) THEN
    RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Dedicated unshared installer runtime role is required';
  END IF;
  IF scoped IS DISTINCT FROM expected_scope OR current_setting('transaction_isolation')<>'read committed' THEN
    RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Exact READ COMMITTED installer scope is required';
  END IF;
  IF NOT public.proofstack_try_lock_policy_evaluation_metadata() OR NOT pg_try_advisory_xact_lock(
    hashtextextended(jsonb_build_array('proofstack.release-selection.v1',scoped->>'tenantId')::text,0)) THEN
    RAISE EXCEPTION USING ERRCODE='55P03',MESSAGE='Installer guards are contended; whole rollback required';
  END IF;
  RETURN public.proofstack_current_replay_recovery_epoch()::text;
END; $$;

-- Only sanitized contract preimages cross this boundary. No cookie/CSRF/verifier field is returned.
-- Actual cookie possession and CSRF are verified by the fixed owning authenticator before SQL.
CREATE FUNCTION public.proofstack_recheck_release_installer(expected_scope jsonb,actor jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE scoped jsonb:=public.proofstack_release_selection_scope();
  session_value public.proofstack_browser_sessions;binding_value public.proofstack_oidc_bindings;
  binding_id_value text;cut timestamptz;at_text text;identity_value jsonb;grant_value jsonb;credential_value jsonb;
  allowed boolean;
BEGIN
  PERFORM public.proofstack_release_installer_context(expected_scope);
  IF scoped IS DISTINCT FROM expected_scope OR actor->>'principalType' IS DISTINCT FROM 'user'
    OR actor->>'authenticationMethod' IS DISTINCT FROM 'oidc'
    OR actor->>'credentialId' IS NULL OR actor->>'principalId' IS NULL
    OR actor->>'requestId' IS NULL OR length(actor->>'requestId') NOT BETWEEN 1 AND 128 THEN
    RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Actual installer authentication is required';
  END IF;
  IF NOT public.proofstack_try_lock_release_oidc_source('oidc_session',actor->>'credentialId') THEN
    RAISE EXCEPTION USING ERRCODE='55P03',MESSAGE='Installer session guard is contended';
  END IF;
  SELECT binding_id INTO binding_id_value FROM public.proofstack_browser_sessions
    WHERE tenant_id=scoped->>'tenantId' AND session_id=actor->>'credentialId';
  IF NOT FOUND OR NOT public.proofstack_try_lock_release_oidc_source('oidc_binding',binding_id_value) THEN
    RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Installer identity is unavailable';
  END IF;
  SELECT * INTO session_value FROM public.proofstack_browser_sessions
    WHERE tenant_id=scoped->>'tenantId' AND session_id=actor->>'credentialId';
  SELECT * INTO binding_value FROM public.proofstack_oidc_bindings
    WHERE tenant_id=scoped->>'tenantId' AND binding_id=binding_id_value;
  cut:=clock_timestamp();at_text:=to_char(cut AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"');
  allowed:=binding_value.resource_scope->>'mode'='tenant' OR (
    binding_value.resource_scope->>'mode'='restricted' AND EXISTS(
      SELECT 1 FROM jsonb_array_elements(binding_value.resource_scope->'projects') p
      WHERE p->>'projectId'=scoped->>'projectId' AND
        (NOT (p ? 'environmentIds') OR p->'environmentIds' ? (scoped->>'environmentId'))));
  IF session_value.binding_id IS DISTINCT FROM binding_id_value
    OR binding_value.principal_id IS DISTINCT FROM actor->>'principalId'
    OR binding_value.disabled_at IS NOT NULL OR allowed IS DISTINCT FROM true
    OR NOT COALESCE('release:selection:manage'=ANY(binding_value.capabilities),false)
    OR session_value.revoked_at IS NOT NULL OR session_value.use_count<1
    OR cut<session_value.created_at OR cut>=session_value.absolute_expires_at OR cut>=session_value.idle_expires_at
    OR actor->>'authenticatedAt' IS DISTINCT FROM to_char(session_value.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') THEN
    RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Current installer authority was rejected';
  END IF;
  IF actor IS DISTINCT FROM jsonb_build_object('principalType','user','authenticationMethod','oidc',
    'principalId',binding_value.principal_id,'credentialId',session_value.session_id,
    'authenticatedAt',to_char(session_value.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'requestId',actor->>'requestId') THEN
    RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Installer actor must be its exact native authentication receipt';
  END IF;
  identity_value:=jsonb_build_object('kind','oidc_binding','principalId',binding_value.principal_id,'bindingId',binding_id_value);
  grant_value:=jsonb_build_object('identity',identity_value,'tenantId',scoped->>'tenantId',
    'state','active','revision',binding_value.authorization_version,
    'updatedAt',to_char(GREATEST(binding_value.updated_at,binding_value.disabled_at) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'roles',(SELECT jsonb_agg(v ORDER BY v COLLATE "C") FROM unnest(binding_value.roles) v),
    'capabilities',(SELECT jsonb_agg(v ORDER BY v COLLATE "C") FROM unnest(binding_value.capabilities) v),
    'resourceScope',binding_value.resource_scope);
  credential_value:=jsonb_build_object('schemaVersion','0.1','kind','oidc_session',
    'tenantId',scoped->>'tenantId','principalId',binding_value.principal_id,'bindingId',binding_id_value,
    'credentialId',session_value.session_id,
    'createdAt',to_char(session_value.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'absoluteExpiresAt',to_char(session_value.absolute_expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'idleExpiresAt',to_char(session_value.idle_expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'lastUsedAt',to_char(session_value.last_used_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'idleLifetimeSeconds',session_value.idle_lifetime_seconds,'useCount',session_value.use_count,
    'revokedAt',NULL,'revocationReason',NULL);
  RETURN jsonb_build_object('actor',actor,'identity',identity_value,'grant',grant_value,
    'credential',credential_value,'capturedAt',at_text,
    'bindingObservation',jsonb_build_object('credentialId',session_value.session_id,'bindingId',binding_id_value),
    'guards',jsonb_build_array(jsonb_build_object('kind','oidc_session','id',session_value.session_id,'acquired',true),
      jsonb_build_object('kind','oidc_binding','id',binding_id_value,'acquired',true)));
END; $$;

CREATE TABLE public.proofstack_release_selection_publications (
  tenant_id varchar(64) NOT NULL,project_id varchar(64) NOT NULL,environment_id varchar(64) NOT NULL,
  source_kind varchar(48) NOT NULL,source_id varchar(64) NOT NULL,source_record jsonb NOT NULL,
  actor jsonb NOT NULL,identity_record jsonb NOT NULL,grant_record jsonb NOT NULL,credential_record jsonb NOT NULL,
  issued_at_lexical text NOT NULL,issued_at_key numeric(50,0) NOT NULL,
  origin_xid bigint NOT NULL,origin_pid integer NOT NULL,origin_epoch bigint NOT NULL,
  completed boolean NOT NULL DEFAULT false,publication jsonb,
  canonical_utf8 text,source_canonical_utf8 text,grant_canonical_utf8 text,credential_canonical_utf8 text,
  PRIMARY KEY(tenant_id,source_kind,source_id),
  CHECK((tenant_id ~ '^[a-z][a-z0-9_]{2,63}$' AND project_id ~ '^[a-z][a-z0-9_]{2,63}$'
    AND environment_id ~ '^[a-z][a-z0-9_]{2,63}$' AND source_id ~ '^[a-z][a-z0-9_]{2,63}$'
    AND source_kind IN('release_policy_selection','release_policy_selection_lifecycle')
    AND origin_xid>0 AND origin_pid>0 AND origin_epoch>=0
    AND issued_at_key=public.proofstack_release_authority_time_key(issued_at_lexical)) IS TRUE),
  CHECK((octet_length(source_record::text)<=270336 AND octet_length(grant_record::text)<=540672
    AND octet_length(credential_record::text)<=8192 AND octet_length(actor::text)<=4096) IS TRUE),
  CHECK((NOT completed AND publication IS NULL AND canonical_utf8 IS NULL AND source_canonical_utf8 IS NULL
      AND grant_canonical_utf8 IS NULL AND credential_canonical_utf8 IS NULL)
    OR (completed AND publication IS NOT NULL AND canonical_utf8 IS NOT NULL AND source_canonical_utf8 IS NOT NULL
      AND grant_canonical_utf8 IS NOT NULL AND credential_canonical_utf8 IS NOT NULL
      AND octet_length(canonical_utf8)<=12288 AND octet_length(source_canonical_utf8)<=270336
      AND octet_length(grant_canonical_utf8)<=524288 AND octet_length(credential_canonical_utf8)<=8192))
);
ALTER TABLE public.proofstack_release_selection_publications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.proofstack_release_selection_publications FORCE ROW LEVEL SECURITY;
CREATE POLICY proofstack_release_selection_publications_scope ON public.proofstack_release_selection_publications
  USING(tenant_id=current_setting('proofstack.tenant_id',true) AND project_id=current_setting('proofstack.project_id',true)
    AND environment_id=current_setting('proofstack.environment_id',true))
  WITH CHECK(tenant_id=current_setting('proofstack.tenant_id',true) AND project_id=current_setting('proofstack.project_id',true)
    AND environment_id=current_setting('proofstack.environment_id',true));
REVOKE ALL ON public.proofstack_release_selection_publications FROM PUBLIC;

CREATE FUNCTION public.proofstack_guard_selection_publication()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Original publication provenance is immutable'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array('proofstack.release-selection.v1',NEW.tenant_id)::text,0));
  IF TG_OP='UPDATE' AND (OLD.completed OR NOT NEW.completed OR OLD.origin_xid<>txid_current() OR OLD.origin_pid<>pg_backend_pid()
    OR to_jsonb(OLD)-ARRAY['completed','publication','canonical_utf8','source_canonical_utf8','grant_canonical_utf8','credential_canonical_utf8']
      IS DISTINCT FROM to_jsonb(NEW)-ARRAY['completed','publication','canonical_utf8','source_canonical_utf8','grant_canonical_utf8','credential_canonical_utf8']) THEN
    RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Publication completion cannot change original native preimages';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER proofstack_release_selection_publication_guard BEFORE INSERT OR UPDATE OR DELETE
  ON public.proofstack_release_selection_publications FOR EACH ROW EXECUTE FUNCTION public.proofstack_guard_selection_publication();

CREATE FUNCTION public.proofstack_verify_selection_publication()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE value public.proofstack_release_selection_publications;source_value jsonb;scoped jsonb;subject jsonb;
  expected_definition jsonb;expected_envelope jsonb;expected_profile jsonb;digest_value text;aggregate_value text;
BEGIN
  SELECT * INTO STRICT value FROM public.proofstack_release_selection_publications
    WHERE tenant_id=NEW.tenant_id AND source_kind=NEW.source_kind AND source_id=NEW.source_id;
  IF NOT value.completed THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Incomplete authenticated selection publication'; END IF;
  scoped:=jsonb_build_object('tenantId',value.tenant_id,'projectId',value.project_id,'environmentId',value.environment_id);
  IF value.source_kind='release_policy_selection' THEN
    SELECT record INTO source_value FROM public.proofstack_release_policy_selections WHERE tenant_id=value.tenant_id
      AND project_id=value.project_id AND environment_id=value.environment_id AND version_id=value.source_id;
    subject:=jsonb_build_object('kind',value.source_kind,'selection',jsonb_build_object(
      'selectionId',source_value->>'selectionId','selectionVersionId',source_value->>'selectionVersionId',
      'installationId',source_value->>'installationId','gateTargetId',source_value->>'gateTargetId',
      'definitionSha256',source_value->>'definitionSha256'));
    IF source_value->>'publishedAt' IS DISTINCT FROM value.issued_at_lexical
      OR source_value->>'publishedByPrincipalId' IS DISTINCT FROM value.actor->>'principalId' THEN
      RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Publication source receipt mismatch';
    END IF;
  ELSE
    SELECT record INTO source_value FROM public.proofstack_release_selection_lifecycle WHERE tenant_id=value.tenant_id
      AND project_id=value.project_id AND environment_id=value.environment_id AND event_id=value.source_id;
    subject:=jsonb_build_object('kind',value.source_kind,'selection',source_value->'selection','eventId',value.source_id);
    IF source_value->>'occurredAt' IS DISTINCT FROM value.issued_at_lexical
      OR source_value->>'actorPrincipalId' IS DISTINCT FROM value.actor->>'principalId' THEN
      RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Publication lifecycle receipt mismatch';
    END IF;
  END IF;
  IF source_value IS NULL OR source_value IS DISTINCT FROM value.source_record
    OR value.source_canonical_utf8::jsonb IS DISTINCT FROM value.source_record
    OR value.grant_canonical_utf8::jsonb IS DISTINCT FROM value.grant_record
    OR value.credential_canonical_utf8::jsonb IS DISTINCT FROM value.credential_record THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Publication original preimage mismatch';
  END IF;
  subject:=subject||jsonb_build_object('recordSha256',encode(sha256(convert_to(value.source_canonical_utf8,'UTF8')),'hex'));
  expected_definition:=jsonb_build_object('scope',scoped,'subject',subject,'operation','manage_selection',
    'actor',value.actor,'identity',value.identity_record,'issuedAt',value.issued_at_lexical,
    'grantSha256',encode(sha256(convert_to(value.grant_canonical_utf8,'UTF8')),'hex'),
    'credentialSha256',encode(sha256(convert_to(value.credential_canonical_utf8,'UTF8')),'hex'));
  expected_envelope:=jsonb_build_object('scope',scoped,'definition',expected_definition,
    'definitionDomain','proofstack.release-selection-publication.v1','encodingVersion','proofstack.release-selection-publication-jcs.v1','schemaVersion','0.1');
  digest_value:=encode(sha256(convert_to(value.canonical_utf8,'UTF8')),'hex');
  expected_profile:=expected_definition||jsonb_build_object('schemaVersion','0.1','definitionSha256',digest_value);
  IF value.canonical_utf8::jsonb IS DISTINCT FROM expected_envelope OR value.publication IS DISTINCT FROM expected_profile THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Publication canonical provenance mismatch';
  END IF;
  aggregate_value:='rsp_'||left(digest_value,60);
  IF NOT EXISTS(SELECT 1 FROM public.proofstack_outbox o WHERE o.tenant_id=value.tenant_id
    AND o.aggregate_type='release_selection_publication' AND o.aggregate_id=aggregate_value
    AND o.event_type='release.selection.authentication_recorded' AND o.schema_version='0.1'
    AND o.payload=jsonb_build_object('recordKind','release_selection_publication','record',expected_profile)
    AND o.created_at=value.issued_at_lexical::timestamptz) THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Publication canonical intent is missing or conflicting';
  END IF;
  RETURN NEW;
END; $$;
CREATE CONSTRAINT TRIGGER proofstack_release_selection_publication_complete AFTER INSERT OR UPDATE
  ON public.proofstack_release_selection_publications DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.proofstack_verify_selection_publication();

REVOKE ALL ON FUNCTION public.proofstack_release_installer_context(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.proofstack_recheck_release_installer(jsonb,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.proofstack_guard_selection_publication() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.proofstack_verify_selection_publication() FROM PUBLIC;

CREATE FUNCTION public.proofstack_begin_authenticated_selection(expected_scope jsonb,definition jsonb,canonical text,actor jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE scoped jsonb:=public.proofstack_release_selection_scope();epoch text;
  auth jsonb;prior public.proofstack_release_policy_selections;root public.proofstack_release_selection_roots;
  proof public.proofstack_release_selection_publications;policy public.proofstack_release_policies;
  item jsonb;body jsonb;result jsonb;cut_key numeric;id text:=definition->>'selectionVersionId';
  observations jsonb:='[]'::jsonb;
BEGIN
  epoch:=public.proofstack_release_installer_context(expected_scope);
  auth:=public.proofstack_recheck_release_installer(scoped,actor);
  IF definition->'scope' IS DISTINCT FROM scoped OR definition->>'issuerPrincipalId' IS DISTINCT FROM actor->>'principalId'
    OR id IS NULL OR id !~ '^[a-z][a-z0-9_]{2,63}$'
    OR canonical::jsonb IS DISTINCT FROM jsonb_build_object('scope',scoped,'definition',definition,
      'definitionDomain','proofstack.release-policy-selection.v1',
      'encodingVersion','proofstack.release-policy-selection-definition-jcs.v1','schemaVersion','0.1') THEN
    RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Installer definition must bind its actual scope and actor';
  END IF;
  SELECT * INTO prior FROM public.proofstack_release_policy_selections WHERE tenant_id=scoped->>'tenantId' AND version_id=id;
  IF FOUND THEN
    SELECT * INTO proof FROM public.proofstack_release_selection_publications WHERE tenant_id=scoped->>'tenantId'
      AND project_id=scoped->>'projectId' AND environment_id=scoped->>'environmentId'
      AND source_kind='release_policy_selection' AND source_id=id;
    IF NOT FOUND OR NOT proof.completed THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='release_installer:legacy_origin_unproven'; END IF;
    IF prior.project_id<>scoped->>'projectId' OR prior.environment_id<>scoped->>'environmentId'
      OR prior.record-ARRAY['schemaVersion','definitionSha256','publishedAt','publishedByPrincipalId'] IS DISTINCT FROM definition THEN
      RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='release_selection:version_conflict';
    END IF;
    RETURN jsonb_build_object('created',false,'sourceKind','release_policy_selection','sourceId',id,
      'identityObservation',auth,'policyObservations',observations);
  END IF;
  SELECT * INTO root FROM public.proofstack_release_selection_roots WHERE tenant_id=scoped->>'tenantId'
    AND (selection_id=definition->>'selectionId' OR (installation_id=definition->>'installationId' AND gate_target_id=definition->>'gateTargetId'));
  IF FOUND AND NOT EXISTS(SELECT 1 FROM public.proofstack_release_selection_publications p
    WHERE p.tenant_id=root.tenant_id AND p.project_id=root.project_id AND p.environment_id=root.environment_id
      AND p.source_kind='release_policy_selection' AND p.source_id=root.root_version_id AND p.completed) THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='release_installer:legacy_target_unproven';
  END IF;
  IF definition ? 'predecessor' AND NOT EXISTS(SELECT 1 FROM public.proofstack_release_selection_publications p
    WHERE p.tenant_id=scoped->>'tenantId' AND p.project_id=scoped->>'projectId' AND p.environment_id=scoped->>'environmentId'
      AND p.source_kind='release_policy_selection' AND p.source_id=definition#>>'{predecessor,selectionVersionId}' AND p.completed) THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='release_installer:legacy_parent_unproven';
  END IF;
  IF jsonb_typeof(definition->'policies') IS DISTINCT FROM 'array' OR jsonb_array_length(definition->'policies')>16 THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Complete finite installed policy inventory is required';
  END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(definition->'policies') LOOP
    SELECT * INTO policy FROM public.proofstack_release_policies WHERE tenant_id=scoped->>'tenantId'
      AND project_id=scoped->>'projectId' AND environment_id=scoped->>'environmentId'
      AND policy_version_id=item#>>'{policy,policyVersionId}';
    IF NOT FOUND OR policy.policy_id IS DISTINCT FROM item#>>'{policy,policyId}'
      OR policy.definition_sha256 IS DISTINCT FROM item#>>'{policy,definitionSha256}'
      OR policy.mode IS DISTINCT FROM item->>'mode'
      OR policy.record#>>'{installationBinding,installationId}' IS DISTINCT FROM definition->>'installationId' THEN
      RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='release_installer:policy_binding_invalid';
    END IF;
    observations:=observations||jsonb_build_array(jsonb_build_object('policyId',policy.policy_id,
      'policyVersionId',policy.policy_version_id,'definitionSha256',policy.definition_sha256,'mode',policy.mode));
  END LOOP;
  -- Reinspect natural expiry/current credentials immediately at the native mutation cut.
  auth:=public.proofstack_recheck_release_installer(scoped,actor);
  cut_key:=public.proofstack_release_authority_time_key(auth->>'capturedAt');
  IF public.proofstack_release_authority_time_key(definition->>'expiresAt')<=cut_key THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='release_installer:selection_expired';
  END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(definition->'policies') LOOP
    SELECT * INTO STRICT policy FROM public.proofstack_release_policies WHERE tenant_id=scoped->>'tenantId'
      AND project_id=scoped->>'projectId' AND environment_id=scoped->>'environmentId'
      AND policy_version_id=item#>>'{policy,policyVersionId}';
    IF public.proofstack_release_authority_time_key(policy.effective_at_lexical)>cut_key
      OR public.proofstack_release_authority_time_key(policy.expires_at_lexical)<=cut_key
      OR public.proofstack_release_authority_time_key(policy.published_at_lexical)>cut_key
      OR EXISTS(SELECT 1 FROM public.proofstack_release_policy_lifecycle_events e
        WHERE e.tenant_id=policy.tenant_id AND e.project_id=policy.project_id AND e.environment_id=policy.environment_id
          AND e.policy_version_id=policy.policy_version_id AND e.occurred_at<= (auth->>'capturedAt')::timestamptz) THEN
      RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='release_installer:policy_not_current';
    END IF;
  END LOOP;
  body:=definition||jsonb_build_object('schemaVersion','0.1',
    'definitionSha256',encode(sha256(convert_to(canonical,'UTF8')),'hex'),
    'publishedAt',auth->>'capturedAt','publishedByPrincipalId',actor->>'principalId');
  result:=public.proofstack_store_release_policy_selection(body,canonical);
  IF result->'created' IS DISTINCT FROM 'true'::jsonb OR result->'record' IS DISTINCT FROM body THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Installer original publication receipt changed';
  END IF;
  INSERT INTO public.proofstack_release_selection_publications(tenant_id,project_id,environment_id,
    source_kind,source_id,source_record,actor,identity_record,grant_record,credential_record,
    issued_at_lexical,issued_at_key,origin_xid,origin_pid,origin_epoch)
    VALUES(scoped->>'tenantId',scoped->>'projectId',scoped->>'environmentId','release_policy_selection',id,body,
      actor,auth->'identity',auth->'grant',auth->'credential',auth->>'capturedAt',cut_key,txid_current(),pg_backend_pid(),epoch::bigint);
  RETURN jsonb_build_object('created',true,'sourceKind','release_policy_selection','sourceId',id,
    'identityObservation',auth,'policyObservations',observations);
END; $$;

CREATE FUNCTION public.proofstack_begin_authenticated_selection_lifecycle(expected_scope jsonb,intent jsonb,actor jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE scoped jsonb:=public.proofstack_release_selection_scope();epoch text;auth jsonb;id text:=intent->>'eventId';
  prior public.proofstack_release_selection_lifecycle;proof public.proofstack_release_selection_publications;
  body jsonb;result jsonb;cut_key numeric;
BEGIN
  epoch:=public.proofstack_release_installer_context(expected_scope);
  auth:=public.proofstack_recheck_release_installer(scoped,actor);
  IF id IS NULL OR id !~ '^[a-z][a-z0-9_]{2,63}$' OR intent->>'kind' IS NULL OR intent->>'kind' NOT IN('withdrawn','superseded') THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Exact installer lifecycle intent is required';
  END IF;
  SELECT * INTO prior FROM public.proofstack_release_selection_lifecycle WHERE tenant_id=scoped->>'tenantId' AND event_id=id;
  IF FOUND THEN
    SELECT * INTO proof FROM public.proofstack_release_selection_publications WHERE tenant_id=scoped->>'tenantId'
      AND project_id=scoped->>'projectId' AND environment_id=scoped->>'environmentId'
      AND source_kind='release_policy_selection_lifecycle' AND source_id=id;
    IF NOT FOUND OR NOT proof.completed THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='release_installer:legacy_origin_unproven'; END IF;
    IF prior.project_id<>scoped->>'projectId' OR prior.environment_id<>scoped->>'environmentId'
      OR prior.record->>'actorPrincipalId' IS DISTINCT FROM actor->>'principalId'
      OR prior.record-ARRAY['schemaVersion','scope','actorPrincipalId','occurredAt'] IS DISTINCT FROM intent THEN
      RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='release_selection:event_conflict';
    END IF;
    RETURN jsonb_build_object('created',false,'sourceKind','release_policy_selection_lifecycle','sourceId',id,
      'identityObservation',auth,'policyObservations','[]'::jsonb);
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.proofstack_release_selection_publications p WHERE p.tenant_id=scoped->>'tenantId'
    AND p.project_id=scoped->>'projectId' AND p.environment_id=scoped->>'environmentId'
    AND p.source_kind='release_policy_selection' AND p.source_id=intent#>>'{selection,selectionVersionId}' AND p.completed)
    OR (intent->>'kind'='superseded' AND NOT EXISTS(SELECT 1 FROM public.proofstack_release_selection_publications p
      WHERE p.tenant_id=scoped->>'tenantId' AND p.project_id=scoped->>'projectId' AND p.environment_id=scoped->>'environmentId'
        AND p.source_kind='release_policy_selection' AND p.source_id=intent#>>'{successor,selectionVersionId}' AND p.completed)) THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='release_installer:legacy_target_unproven';
  END IF;
  auth:=public.proofstack_recheck_release_installer(scoped,actor);
  cut_key:=public.proofstack_release_authority_time_key(auth->>'capturedAt');
  body:=intent||jsonb_build_object('scope',scoped,'schemaVersion','0.1','actorPrincipalId',actor->>'principalId','occurredAt',auth->>'capturedAt');
  result:=public.proofstack_store_release_selection_lifecycle(body);
  IF result->'created' IS DISTINCT FROM 'true'::jsonb OR result->'record' IS DISTINCT FROM body THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Installer original lifecycle receipt changed';
  END IF;
  INSERT INTO public.proofstack_release_selection_publications(tenant_id,project_id,environment_id,
    source_kind,source_id,source_record,actor,identity_record,grant_record,credential_record,
    issued_at_lexical,issued_at_key,origin_xid,origin_pid,origin_epoch)
    VALUES(scoped->>'tenantId',scoped->>'projectId',scoped->>'environmentId','release_policy_selection_lifecycle',id,body,
      actor,auth->'identity',auth->'grant',auth->'credential',auth->>'capturedAt',cut_key,txid_current(),pg_backend_pid(),epoch::bigint);
  RETURN jsonb_build_object('created',true,'sourceKind','release_policy_selection_lifecycle','sourceId',id,
    'identityObservation',auth,'policyObservations','[]'::jsonb);
END; $$;

-- Each safe preimage is read separately to keep the wire frame finite; no token/hash verifier is present.
CREATE FUNCTION public.proofstack_read_selection_publication_part(expected_scope jsonb,kind text,id text,part text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE scoped jsonb:=public.proofstack_release_selection_scope();value public.proofstack_release_selection_publications;
BEGIN
  IF expected_scope IS DISTINCT FROM scoped OR current_setting('transaction_isolation')<>'read committed'
    OR kind IS NULL OR kind NOT IN('release_policy_selection','release_policy_selection_lifecycle')
    OR id IS NULL OR id !~ '^[a-z][a-z0-9_]{2,63}$'
    OR part IS NULL OR part NOT IN('source','grant','credential','header','source_encoding','grant_encoding','credential_encoding','publication_encoding') THEN
    RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Exact publication read scope/part is required';
  END IF;
  PERFORM public.proofstack_release_installer_context(expected_scope);
  IF NOT public.proofstack_try_lock_release_selection(scoped) THEN
    RAISE EXCEPTION USING ERRCODE='55P03',MESSAGE='Publication read guard is contended';
  END IF;
  SELECT * INTO value FROM public.proofstack_release_selection_publications WHERE tenant_id=scoped->>'tenantId'
    AND project_id=scoped->>'projectId' AND environment_id=scoped->>'environmentId' AND source_kind=kind AND source_id=id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  CASE part
    WHEN 'source' THEN RETURN jsonb_build_object('kind',kind,'record',value.source_record);
    WHEN 'grant' THEN RETURN value.grant_record;
    WHEN 'credential' THEN RETURN value.credential_record;
    WHEN 'source_encoding' THEN RETURN to_jsonb(value.source_canonical_utf8);
    WHEN 'grant_encoding' THEN RETURN to_jsonb(value.grant_canonical_utf8);
    WHEN 'credential_encoding' THEN RETURN to_jsonb(value.credential_canonical_utf8);
    WHEN 'publication_encoding' THEN RETURN to_jsonb(value.canonical_utf8);
    ELSE RETURN jsonb_build_object('completed',value.completed,'actor',value.actor,'identity',value.identity_record,
      'issuedAt',value.issued_at_lexical,'publication',value.publication,'originEpoch',value.origin_epoch::text,
      'canonicalIntent',value.completed AND EXISTS(SELECT 1 FROM public.proofstack_outbox o
        WHERE o.tenant_id=value.tenant_id AND o.aggregate_type='release_selection_publication'
          AND o.aggregate_id='rsp_'||left(value.publication->>'definitionSha256',60)
          AND o.event_type='release.selection.authentication_recorded' AND o.schema_version='0.1'
          AND o.payload=jsonb_build_object('recordKind','release_selection_publication','record',value.publication)
          AND o.created_at=value.issued_at_lexical::timestamptz));
  END CASE;
END; $$;

CREATE FUNCTION public.proofstack_finish_selection_publication(expected_scope jsonb,kind text,id text,
  profile jsonb,canonical text,source_canonical text,grant_canonical text,credential_canonical text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE scoped jsonb:=public.proofstack_release_selection_scope();value public.proofstack_release_selection_publications;
  digest_value text;
BEGIN
  PERFORM public.proofstack_release_installer_context(expected_scope);
  SELECT * INTO value FROM public.proofstack_release_selection_publications WHERE tenant_id=scoped->>'tenantId'
    AND project_id=scoped->>'projectId' AND environment_id=scoped->>'environmentId' AND source_kind=kind AND source_id=id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0002',MESSAGE='Pending installer publication not found'; END IF;
  IF value.completed THEN
    IF value.publication IS DISTINCT FROM profile OR value.canonical_utf8 IS DISTINCT FROM canonical
      OR value.source_canonical_utf8 IS DISTINCT FROM source_canonical OR value.grant_canonical_utf8 IS DISTINCT FROM grant_canonical
      OR value.credential_canonical_utf8 IS DISTINCT FROM credential_canonical THEN
      RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='release_installer:publication_conflict';
    END IF;
    RETURN value.publication;
  END IF;
  IF value.origin_xid<>txid_current() OR value.origin_pid<>pg_backend_pid() THEN
    RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Publication completion requires its original held transaction';
  END IF;
  UPDATE public.proofstack_release_selection_publications SET completed=true,publication=profile,canonical_utf8=canonical,
    source_canonical_utf8=source_canonical,grant_canonical_utf8=grant_canonical,credential_canonical_utf8=credential_canonical
    WHERE tenant_id=value.tenant_id AND source_kind=value.source_kind AND source_id=value.source_id;
  digest_value:=encode(sha256(convert_to(canonical,'UTF8')),'hex');
  INSERT INTO public.proofstack_outbox(tenant_id,aggregate_type,aggregate_id,event_type,payload,schema_version,created_at)
    VALUES(value.tenant_id,'release_selection_publication','rsp_'||left(digest_value,60),'release.selection.authentication_recorded',
      jsonb_build_object('recordKind','release_selection_publication','record',profile),'0.1',value.issued_at_lexical::timestamptz);
  SET CONSTRAINTS ALL IMMEDIATE;
  RETURN profile;
END; $$;

REVOKE ALL ON FUNCTION public.proofstack_begin_authenticated_selection(jsonb,jsonb,text,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.proofstack_begin_authenticated_selection_lifecycle(jsonb,jsonb,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.proofstack_read_selection_publication_part(jsonb,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.proofstack_finish_selection_publication(jsonb,text,text,jsonb,text,text,text,text) FROM PUBLIC;

-- The fixed projections mirror owning normalized readers; this is no arbitrary SQL interface.
-- Fragment complete source rows so a valid large original never needs an unbounded wire frame.
CREATE FUNCTION public.proofstack_read_installer_projection(expected_scope jsonb,requested_kind text,requested_id text)
RETURNS SETOF jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE scoped jsonb:=public.proofstack_release_selection_scope();material jsonb;bytes bytea;offset_value integer:=0;
  digest_value text;records_value bigint;total integer;
BEGIN
  IF requested_id IS NULL OR requested_id !~ '^[a-z][a-z0-9_]{2,63}$' THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Exact owning projection identity is required';
  END IF;
  PERFORM public.proofstack_release_installer_context(expected_scope);
  CASE requested_kind

    WHEN 'policy_record' THEN
      SELECT COALESCE(jsonb_agg(to_jsonb(q)),'[]'::jsonb) INTO material FROM (
SELECT
       policy.tenant_id,
       policy.project_id,
       policy.environment_id,
       policy.policy_id,
       policy.policy_version_id,
       policy.schema_version,
       policy.definition_sha256,
       policy.semantic_version,
       policy.mode,
       policy.effective_at_lexical,
       policy.expires_at_lexical,
       policy.published_at_lexical,
       policy.published_by_principal_id,
       policy.source_count,
       policy.counterevidence_count,
       policy.rule_count,
       policy.lineage_count,
       policy.record,
       resource.root_policy_version_id,
       resource.root_definition_sha256,
       (
         SELECT root.policy_id
         FROM public.proofstack_release_policies AS root
         WHERE root.tenant_id = resource.tenant_id
           AND root.project_id = resource.project_id
           AND root.environment_id = resource.environment_id
           AND root.policy_version_id = resource.root_policy_version_id
           AND root.definition_sha256 = resource.root_definition_sha256
       ) AS root_policy_id,
       (
         SELECT root.lineage_count
         FROM public.proofstack_release_policies AS root
         WHERE root.tenant_id = resource.tenant_id
           AND root.project_id = resource.project_id
           AND root.environment_id = resource.environment_id
           AND root.policy_version_id = resource.root_policy_version_id
           AND root.definition_sha256 = resource.root_definition_sha256
       ) AS root_lineage_count,
       lineage.parent_policy_version_id,
       lineage.parent_definition_sha256,
       COALESCE((
         SELECT jsonb_agg(source.reference ORDER BY source.source_position)
         FROM public.proofstack_release_policy_sources AS source
         WHERE source.tenant_id = policy.tenant_id
           AND source.project_id = policy.project_id
           AND source.environment_id = policy.environment_id
           AND source.policy_version_id = policy.policy_version_id
           AND source.policy_definition_sha256 = policy.definition_sha256
           AND source.collection = 'sources'
       ), '[]'::jsonb) AS source_projections,
       COALESCE((
         SELECT jsonb_agg(source.reference ORDER BY source.source_position)
         FROM public.proofstack_release_policy_sources AS source
         WHERE source.tenant_id = policy.tenant_id
           AND source.project_id = policy.project_id
           AND source.environment_id = policy.environment_id
           AND source.policy_version_id = policy.policy_version_id
           AND source.policy_definition_sha256 = policy.definition_sha256
           AND source.collection = 'counterevidence'
       ), '[]'::jsonb) AS counterevidence_projections,
       COALESCE((
         SELECT jsonb_agg(rule.rule ORDER BY rule.rule_position)
         FROM public.proofstack_release_policy_rules AS rule
         WHERE rule.tenant_id = policy.tenant_id
           AND rule.project_id = policy.project_id
           AND rule.environment_id = policy.environment_id
           AND rule.policy_version_id = policy.policy_version_id
           AND rule.policy_definition_sha256 = policy.definition_sha256
       ), '[]'::jsonb) AS rule_projections,
       COALESCE((
         SELECT jsonb_agg(
           jsonb_build_object(
             'rulePosition', source.rule_position,
             'sourcePosition', source.source_position,
             'reference', source.reference
           ) ORDER BY source.rule_position, source.source_position
         )
         FROM public.proofstack_release_policy_rule_sources AS source
         WHERE source.tenant_id = policy.tenant_id
           AND source.project_id = policy.project_id
           AND source.environment_id = policy.environment_id
           AND source.policy_version_id = policy.policy_version_id
           AND source.policy_definition_sha256 = policy.definition_sha256
       ), '[]'::jsonb) AS rule_source_projections
     FROM public.proofstack_release_policies AS policy
     JOIN public.proofstack_release_policy_registry AS registry
       ON registry.tenant_id = policy.tenant_id
      AND registry.project_id = policy.project_id
      AND registry.environment_id = policy.environment_id
      AND registry.policy_version_id = policy.policy_version_id
      AND registry.schema_version = policy.schema_version
      AND registry.definition_sha256 = policy.definition_sha256
     JOIN public.proofstack_release_policy_resources AS resource
       ON resource.tenant_id = policy.tenant_id
      AND resource.project_id = policy.project_id
      AND resource.environment_id = policy.environment_id
      AND resource.policy_id = policy.policy_id
     LEFT JOIN public.proofstack_release_policy_lineage AS lineage
       ON lineage.tenant_id = policy.tenant_id
      AND lineage.project_id = policy.project_id
      AND lineage.environment_id = policy.environment_id
      AND lineage.child_policy_version_id = policy.policy_version_id
      AND lineage.child_definition_sha256 = policy.definition_sha256
     WHERE policy.tenant_id = (scoped->>'tenantId')
       AND policy.project_id = (scoped->>'projectId')
       AND policy.environment_id = (scoped->>'environmentId')
       AND policy.policy_version_id = requested_id
      ) q;
    WHEN 'policy_presence' THEN
      SELECT COALESCE(jsonb_agg(to_jsonb(q)),'[]'::jsonb) INTO material FROM (
SELECT EXISTS (
       SELECT 1 FROM public.proofstack_release_policies
       WHERE tenant_id=(scoped->>'tenantId') AND project_id=(scoped->>'projectId') AND environment_id=(scoped->>'environmentId') AND policy_version_id=requested_id
     ) AS retained_policy_body, EXISTS (
       SELECT 1 FROM public.proofstack_release_policy_registry
       WHERE tenant_id=(scoped->>'tenantId') AND project_id=(scoped->>'projectId') AND environment_id=(scoped->>'environmentId') AND policy_version_id=requested_id
     ) OR EXISTS (
       SELECT 1 FROM public.proofstack_release_policy_lineage
       WHERE tenant_id=(scoped->>'tenantId') AND project_id=(scoped->>'projectId') AND environment_id=(scoped->>'environmentId') AND child_policy_version_id=requested_id
     ) OR EXISTS (
       SELECT 1 FROM public.proofstack_release_policy_resources
       WHERE tenant_id=(scoped->>'tenantId') AND project_id=(scoped->>'projectId') AND environment_id=(scoped->>'environmentId') AND root_policy_version_id=requested_id
     ) OR EXISTS (
       SELECT 1 FROM public.proofstack_release_policy_sources
       WHERE tenant_id=(scoped->>'tenantId') AND project_id=(scoped->>'projectId') AND environment_id=(scoped->>'environmentId') AND policy_version_id=requested_id
     ) OR EXISTS (
       SELECT 1 FROM public.proofstack_release_policy_rules
       WHERE tenant_id=(scoped->>'tenantId') AND project_id=(scoped->>'projectId') AND environment_id=(scoped->>'environmentId') AND policy_version_id=requested_id
     ) OR EXISTS (
       SELECT 1 FROM public.proofstack_release_policy_rule_sources
       WHERE tenant_id=(scoped->>'tenantId') AND project_id=(scoped->>'projectId') AND environment_id=(scoped->>'environmentId') AND policy_version_id=requested_id
     ) AS retained_policy_storage
      ) q;
    WHEN 'policy_lifecycle' THEN
      SELECT COALESCE(jsonb_agg(to_jsonb(q)),'[]'::jsonb) INTO material FROM (
SELECT tenant_id, project_id, environment_id, event_id, schema_version, kind,
       policy_id, policy_version_id, policy_definition_sha256,
       successor_policy_id, successor_policy_version_id, successor_definition_sha256,
       actor_principal_id, occurred_at_lexical, reason, record
     FROM public.proofstack_release_policy_lifecycle_events
     WHERE tenant_id = (scoped->>'tenantId') AND project_id = (scoped->>'projectId') AND environment_id = (scoped->>'environmentId') AND event_id = requested_id
      ) q;
    WHEN 'policy_events' THEN
      SELECT COALESCE(jsonb_agg(to_jsonb(q)),'[]'::jsonb) INTO material FROM (
SELECT tenant_id, project_id, environment_id, event_id, schema_version, kind,
       policy_id, policy_version_id, policy_definition_sha256,
       successor_policy_id, successor_policy_version_id, successor_definition_sha256,
       actor_principal_id, occurred_at_lexical, reason, record
     FROM public.proofstack_release_policy_lifecycle_events
     WHERE tenant_id = (scoped->>'tenantId') AND project_id = (scoped->>'projectId') AND environment_id = (scoped->>'environmentId')
       AND policy_version_id = requested_id
     ORDER BY occurred_at ASC, event_id ASC
      ) q;
    WHEN 'selection_view' THEN
      SELECT COALESCE(jsonb_agg(to_jsonb(q)),'[]'::jsonb) INTO material FROM (
SELECT to_jsonb(v) || jsonb_build_object('effective_at_key',v.effective_at_key::text,'expires_at_key',v.expires_at_key::text,'published_at_key',v.published_at_key::text) AS version, to_jsonb(r) AS root,
  to_jsonb(rv) || jsonb_build_object('effective_at_key',rv.effective_at_key::text,'expires_at_key',rv.expires_at_key::text,'published_at_key',rv.published_at_key::text) AS root_version, to_jsonb(pv) || jsonb_build_object('effective_at_key',pv.effective_at_key::text,'expires_at_key',pv.expires_at_key::text,'published_at_key',pv.published_at_key::text) AS predecessor,
  (SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY p.ordinal),'[]'::jsonb)
    FROM public.proofstack_release_selection_policies p WHERE p.tenant_id=v.tenant_id AND p.version_id=v.version_id) AS policies,
  (SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY p.ordinal),'[]'::jsonb)
    FROM public.proofstack_release_selection_publishers p WHERE p.tenant_id=v.tenant_id AND p.version_id=v.version_id) AS publishers,
  (SELECT COALESCE(jsonb_agg(jsonb_build_object('eventType',o.event_type,'schemaVersion',o.schema_version,
    'payload',o.payload,'timeMatches',o.created_at=v.published_at_lexical::timestamptz)),'[]'::jsonb)
    FROM public.proofstack_outbox o WHERE o.tenant_id=v.tenant_id AND o.aggregate_type='release_policy_selection' AND o.aggregate_id=v.version_id) AS intents
  FROM public.proofstack_release_policy_selections v
  LEFT JOIN public.proofstack_release_selection_roots r ON r.tenant_id=v.tenant_id AND r.selection_id=v.selection_id
  LEFT JOIN public.proofstack_release_policy_selections rv ON rv.tenant_id=r.tenant_id AND rv.version_id=r.root_version_id
  LEFT JOIN public.proofstack_release_policy_selections pv ON pv.tenant_id=v.tenant_id AND pv.version_id=v.parent_version_id
  WHERE v.tenant_id=(scoped->>'tenantId') AND v.project_id=(scoped->>'projectId') AND v.environment_id=(scoped->>'environmentId') AND v.version_id=requested_id
      ) q;
    WHEN 'selection_event_view' THEN
      SELECT COALESCE(jsonb_agg(to_jsonb(q)),'[]'::jsonb) INTO material FROM (
SELECT to_jsonb(e)||jsonb_build_object('occurred_at_key',e.occurred_at_key::text) AS event,
  (SELECT COALESCE(jsonb_agg(jsonb_build_object('eventType',o.event_type,'schemaVersion',o.schema_version,
    'payload',o.payload,'timeMatches',o.created_at=e.occurred_at_lexical::timestamptz)),'[]'::jsonb)
    FROM public.proofstack_outbox o WHERE o.tenant_id=e.tenant_id AND o.aggregate_type='release_policy_selection_lifecycle' AND o.aggregate_id=e.event_id) AS intents
  FROM public.proofstack_release_selection_lifecycle e
  WHERE e.tenant_id=(scoped->>'tenantId') AND e.project_id=(scoped->>'projectId') AND e.environment_id=(scoped->>'environmentId') AND e.event_id=requested_id
      ) q;
    ELSE RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Unsupported owning installer projection';
  END CASE;
  bytes:=convert_to(material::text,'UTF8');total:=octet_length(bytes);
  IF total>16777216 THEN RAISE EXCEPTION USING ERRCODE='54000',MESSAGE='Owning source projection byte admission exhausted'; END IF;
  -- Conservatively count every retained object, including repeated normalized witnesses.
  SELECT count(*) INTO records_value FROM jsonb_path_query(material,'strict $.** ? (@.type() == "object")');
  records_value:=GREATEST(records_value,1);
  IF records_value>10000 THEN RAISE EXCEPTION USING ERRCODE='54000',MESSAGE='Owning source projection record admission exhausted'; END IF;
  digest_value:=encode(sha256(bytes),'hex');
  WHILE offset_value<total LOOP
    RETURN NEXT jsonb_build_object('scope',scoped,'projection',requested_kind,'offset',offset_value,
      'totalBytes',total,'sha256',digest_value,'records',CASE WHEN offset_value=0 THEN records_value ELSE 0 END,
      'chunkBase64',replace(encode(substring(bytes FROM offset_value+1 FOR 65536),'base64'),chr(10),''));
    offset_value:=offset_value+65536;
  END LOOP;
END; $$;
REVOKE ALL ON FUNCTION public.proofstack_read_installer_projection(jsonb,text,text) FROM PUBLIC;
