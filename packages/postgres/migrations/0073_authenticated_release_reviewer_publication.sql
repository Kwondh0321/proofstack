-- Authenticated reviewer administration is separate from historical trusted declaration storage.
-- Old graphs remain unchanged and have no authenticated publication profile.
CREATE FUNCTION public.proofstack_reviewer_administrator_context(expected_scope jsonb)
RETURNS text LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE scoped jsonb:=public.proofstack_release_selection_scope();role_value record;
BEGIN
  SELECT r.*,pg_catalog.shobj_description(r.oid,'pg_authid') AS marker INTO role_value FROM pg_catalog.pg_roles r WHERE r.rolname=session_user;
  IF role_value.marker IS DISTINCT FROM 'proofstack-managed-runtime-role:v1:reviewerAuthority'
    OR NOT role_value.rolcanlogin OR role_value.rolsuper OR role_value.rolcreatedb OR role_value.rolcreaterole
    OR role_value.rolreplication OR role_value.rolbypassrls OR role_value.rolinherit
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.member=role_value.oid OR m.roleid=role_value.oid) THEN
    RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Dedicated unshared reviewer administrator runtime role is required';
  END IF;
  IF scoped IS DISTINCT FROM expected_scope OR current_setting('transaction_isolation')<>'read committed' THEN
    RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Exact READ COMMITTED reviewer administrator scope is required';
  END IF;
  IF NOT public.proofstack_try_lock_policy_evaluation_metadata() OR NOT pg_try_advisory_xact_lock(
    hashtextextended(jsonb_build_array('proofstack.release-reviewer.v1',scoped->>'tenantId')::text,0)) THEN
    RAISE EXCEPTION USING ERRCODE='55P03',MESSAGE='Reviewer administrator guards are contended; whole rollback required';
  END IF;
  RETURN public.proofstack_current_replay_recovery_epoch()::text;
END; $$;

-- Only sanitized contract preimages cross this boundary. No cookie/CSRF/verifier field is returned.
-- Actual cookie possession and CSRF are verified by the fixed owning authenticator before SQL.
CREATE FUNCTION public.proofstack_recheck_reviewer_administrator(expected_scope jsonb,actor jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE scoped jsonb:=public.proofstack_release_selection_scope();
  session_value public.proofstack_browser_sessions;binding_value public.proofstack_oidc_bindings;
  binding_id_value text;cut timestamptz;at_text text;identity_value jsonb;grant_value jsonb;credential_value jsonb;
  allowed boolean;
BEGIN
  PERFORM public.proofstack_reviewer_administrator_context(expected_scope);
  IF scoped IS DISTINCT FROM expected_scope OR actor->>'principalType' IS DISTINCT FROM 'user'
    OR actor->>'authenticationMethod' IS DISTINCT FROM 'oidc'
    OR actor->>'credentialId' IS NULL OR actor->>'principalId' IS NULL
    OR actor->>'requestId' IS NULL OR length(actor->>'requestId') NOT BETWEEN 1 AND 128 THEN
    RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Actual reviewer administrator authentication is required';
  END IF;
  IF NOT public.proofstack_try_lock_release_oidc_source('oidc_session',actor->>'credentialId') THEN
    RAISE EXCEPTION USING ERRCODE='55P03',MESSAGE='Reviewer administrator session guard is contended';
  END IF;
  SELECT binding_id INTO binding_id_value FROM public.proofstack_browser_sessions
    WHERE tenant_id=scoped->>'tenantId' AND session_id=actor->>'credentialId';
  IF NOT FOUND OR NOT public.proofstack_try_lock_release_oidc_source('oidc_binding',binding_id_value) THEN
    RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Reviewer administrator identity is unavailable';
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
    OR NOT COALESCE('approval:authority:manage'=ANY(binding_value.capabilities),false)
    OR session_value.revoked_at IS NOT NULL OR session_value.use_count<1
    OR cut<session_value.created_at OR cut>=session_value.absolute_expires_at OR cut>=session_value.idle_expires_at
    OR actor->>'authenticatedAt' IS DISTINCT FROM to_char(session_value.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') THEN
    RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Current reviewer administrator authority was rejected';
  END IF;
  IF actor IS DISTINCT FROM jsonb_build_object('principalType','user','authenticationMethod','oidc',
    'principalId',binding_value.principal_id,'credentialId',session_value.session_id,
    'authenticatedAt',to_char(session_value.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'requestId',actor->>'requestId') THEN
    RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Reviewer administrator actor must be its exact native authentication receipt';
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

CREATE TABLE public.proofstack_release_reviewer_publications (
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
    AND source_kind IN('release_reviewer_authority','release_reviewer_authority_lifecycle')
    AND origin_xid>0 AND origin_pid>0 AND origin_epoch>=0
    AND issued_at_key=public.proofstack_release_authority_time_key(issued_at_lexical)) IS TRUE),
  CHECK((octet_length(source_record::text)<=69632 AND octet_length(grant_record::text)<=540672
    AND octet_length(credential_record::text)<=8192 AND octet_length(actor::text)<=4096) IS TRUE),
  CHECK((NOT completed AND publication IS NULL AND canonical_utf8 IS NULL AND source_canonical_utf8 IS NULL
      AND grant_canonical_utf8 IS NULL AND credential_canonical_utf8 IS NULL)
    OR (completed AND publication IS NOT NULL AND canonical_utf8 IS NOT NULL AND source_canonical_utf8 IS NOT NULL
      AND grant_canonical_utf8 IS NOT NULL AND credential_canonical_utf8 IS NOT NULL
      AND octet_length(canonical_utf8)<=12288 AND octet_length(source_canonical_utf8)<=69632
      AND octet_length(grant_canonical_utf8)<=524288 AND octet_length(credential_canonical_utf8)<=8192))
);
ALTER TABLE public.proofstack_release_reviewer_publications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.proofstack_release_reviewer_publications FORCE ROW LEVEL SECURITY;
CREATE POLICY proofstack_release_reviewer_publications_scope ON public.proofstack_release_reviewer_publications
  USING(tenant_id=current_setting('proofstack.tenant_id',true) AND project_id=current_setting('proofstack.project_id',true)
    AND environment_id=current_setting('proofstack.environment_id',true))
  WITH CHECK(tenant_id=current_setting('proofstack.tenant_id',true) AND project_id=current_setting('proofstack.project_id',true)
    AND environment_id=current_setting('proofstack.environment_id',true));
REVOKE ALL ON public.proofstack_release_reviewer_publications FROM PUBLIC;

CREATE FUNCTION public.proofstack_guard_reviewer_publication()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Original publication provenance is immutable'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array('proofstack.release-reviewer.v1',NEW.tenant_id)::text,0));
  IF TG_OP='UPDATE' AND (OLD.completed OR NOT NEW.completed OR OLD.origin_xid<>txid_current() OR OLD.origin_pid<>pg_backend_pid()
    OR to_jsonb(OLD)-ARRAY['completed','publication','canonical_utf8','source_canonical_utf8','grant_canonical_utf8','credential_canonical_utf8']
      IS DISTINCT FROM to_jsonb(NEW)-ARRAY['completed','publication','canonical_utf8','source_canonical_utf8','grant_canonical_utf8','credential_canonical_utf8']) THEN
    RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Publication completion cannot change original native preimages';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER proofstack_release_reviewer_publication_guard BEFORE INSERT OR UPDATE OR DELETE
  ON public.proofstack_release_reviewer_publications FOR EACH ROW EXECUTE FUNCTION public.proofstack_guard_reviewer_publication();

CREATE FUNCTION public.proofstack_verify_reviewer_publication()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE value public.proofstack_release_reviewer_publications;source_value jsonb;scoped jsonb;subject jsonb;
  expected_definition jsonb;expected_envelope jsonb;expected_profile jsonb;digest_value text;aggregate_value text;
BEGIN
  SELECT * INTO STRICT value FROM public.proofstack_release_reviewer_publications
    WHERE tenant_id=NEW.tenant_id AND source_kind=NEW.source_kind AND source_id=NEW.source_id;
  IF NOT value.completed THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Incomplete authenticated reviewer publication'; END IF;
  scoped:=jsonb_build_object('tenantId',value.tenant_id,'projectId',value.project_id,'environmentId',value.environment_id);
  IF value.source_kind='release_reviewer_authority' THEN
    SELECT record INTO source_value FROM public.proofstack_release_reviewer_authorities WHERE tenant_id=value.tenant_id
      AND project_id=value.project_id AND environment_id=value.environment_id AND version_id=value.source_id;
    subject:=jsonb_build_object('kind',value.source_kind,'authority',jsonb_build_object(
      'authorityId',source_value->>'authorityId','authorityVersionId',source_value->>'authorityVersionId',
      'installationId',source_value->>'installationId','gateTargetId',source_value->>'gateTargetId','reviewerPrincipalId',source_value->>'reviewerPrincipalId',
      'definitionSha256',source_value->>'definitionSha256'));
    IF source_value->>'publishedAt' IS DISTINCT FROM value.issued_at_lexical
      OR source_value->>'publishedByPrincipalId' IS DISTINCT FROM value.actor->>'principalId' THEN
      RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Publication source receipt mismatch';
    END IF;
  ELSE
    SELECT record INTO source_value FROM public.proofstack_release_reviewer_lifecycle WHERE tenant_id=value.tenant_id
      AND project_id=value.project_id AND environment_id=value.environment_id AND event_id=value.source_id;
    subject:=jsonb_build_object('kind',value.source_kind,'authority',source_value->'authority','eventId',value.source_id);
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
  expected_definition:=jsonb_build_object('scope',scoped,'subject',subject,'operation','manage_reviewer_authority',
    'actor',value.actor,'identity',value.identity_record,'issuedAt',value.issued_at_lexical,
    'grantSha256',encode(sha256(convert_to(value.grant_canonical_utf8,'UTF8')),'hex'),
    'credentialSha256',encode(sha256(convert_to(value.credential_canonical_utf8,'UTF8')),'hex'));
  expected_envelope:=jsonb_build_object('scope',scoped,'definition',expected_definition,
    'definitionDomain','proofstack.release-reviewer-publication.v1','encodingVersion','proofstack.release-reviewer-publication-jcs.v1','schemaVersion','0.1');
  digest_value:=encode(sha256(convert_to(value.canonical_utf8,'UTF8')),'hex');
  expected_profile:=expected_definition||jsonb_build_object('schemaVersion','0.1','definitionSha256',digest_value);
  IF value.canonical_utf8::jsonb IS DISTINCT FROM expected_envelope OR value.publication IS DISTINCT FROM expected_profile THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Publication canonical provenance mismatch';
  END IF;
  aggregate_value:='rrp_'||left(digest_value,60);
  IF NOT EXISTS(SELECT 1 FROM public.proofstack_outbox o WHERE o.tenant_id=value.tenant_id
    AND o.aggregate_type='release_reviewer_publication' AND o.aggregate_id=aggregate_value
    AND o.event_type='release.reviewer-authority.authentication_recorded' AND o.schema_version='0.1'
    AND o.payload=jsonb_build_object('recordKind','release_reviewer_publication','record',expected_profile)
    AND o.created_at=value.issued_at_lexical::timestamptz) THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Publication canonical intent is missing or conflicting';
  END IF;
  RETURN NEW;
END; $$;
CREATE CONSTRAINT TRIGGER proofstack_release_reviewer_publication_complete AFTER INSERT OR UPDATE
  ON public.proofstack_release_reviewer_publications DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.proofstack_verify_reviewer_publication();

REVOKE ALL ON FUNCTION public.proofstack_reviewer_administrator_context(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.proofstack_recheck_reviewer_administrator(jsonb,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.proofstack_guard_reviewer_publication() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.proofstack_verify_reviewer_publication() FROM PUBLIC;

CREATE FUNCTION public.proofstack_begin_authenticated_reviewer_authority(expected_scope jsonb,definition jsonb,canonical text,actor jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE scoped jsonb:=public.proofstack_release_selection_scope();epoch text;
  auth jsonb;prior public.proofstack_release_reviewer_authorities;root public.proofstack_release_reviewer_roots;
  proof public.proofstack_release_reviewer_publications;
  body jsonb;result jsonb;cut_key numeric;id text:=definition->>'authorityVersionId';

BEGIN
  epoch:=public.proofstack_reviewer_administrator_context(expected_scope);
  auth:=public.proofstack_recheck_reviewer_administrator(scoped,actor);
  IF definition->'scope' IS DISTINCT FROM scoped OR definition->>'issuerPrincipalId' IS DISTINCT FROM actor->>'principalId'
    OR id IS NULL OR id !~ '^[a-z][a-z0-9_]{2,63}$'
    OR canonical::jsonb IS DISTINCT FROM jsonb_build_object('scope',scoped,'definition',definition,
      'definitionDomain','proofstack.release-reviewer-authority.v1',
      'encodingVersion','proofstack.release-reviewer-authority-definition-jcs.v1','schemaVersion','0.1') THEN
    RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Reviewer administrator definition must bind its actual scope and actor';
  END IF;
  SELECT * INTO prior FROM public.proofstack_release_reviewer_authorities WHERE tenant_id=scoped->>'tenantId' AND version_id=id;
  IF FOUND THEN
    SELECT * INTO proof FROM public.proofstack_release_reviewer_publications WHERE tenant_id=scoped->>'tenantId'
      AND project_id=scoped->>'projectId' AND environment_id=scoped->>'environmentId'
      AND source_kind='release_reviewer_authority' AND source_id=id;
    IF NOT FOUND OR NOT proof.completed THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='release_reviewer_administrator:legacy_origin_unproven'; END IF;
    IF prior.project_id<>scoped->>'projectId' OR prior.environment_id<>scoped->>'environmentId'
      OR prior.record-ARRAY['schemaVersion','definitionSha256','publishedAt','publishedByPrincipalId'] IS DISTINCT FROM definition THEN
      RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='release_reviewer:version_conflict';
    END IF;
    RETURN jsonb_build_object('created',false,'sourceKind','release_reviewer_authority','sourceId',id,
      'identityObservation',auth);
  END IF;
  SELECT * INTO root FROM public.proofstack_release_reviewer_roots WHERE tenant_id=scoped->>'tenantId'
    AND (authority_id=definition->>'authorityId' OR (installation_id=definition->>'installationId' AND gate_target_id=definition->>'gateTargetId' AND reviewer_principal_id=definition->>'reviewerPrincipalId'));
  IF FOUND AND NOT EXISTS(SELECT 1 FROM public.proofstack_release_reviewer_publications p
    WHERE p.tenant_id=root.tenant_id AND p.project_id=root.project_id AND p.environment_id=root.environment_id
      AND p.source_kind='release_reviewer_authority' AND p.source_id=root.root_version_id AND p.completed) THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='release_reviewer_administrator:legacy_target_unproven';
  END IF;
  IF definition ? 'predecessor' AND NOT EXISTS(SELECT 1 FROM public.proofstack_release_reviewer_publications p
    WHERE p.tenant_id=scoped->>'tenantId' AND p.project_id=scoped->>'projectId' AND p.environment_id=scoped->>'environmentId'
      AND p.source_kind='release_reviewer_authority' AND p.source_id=definition#>>'{predecessor,authorityVersionId}' AND p.completed) THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='release_reviewer_administrator:legacy_parent_unproven';
  END IF;
  auth:=public.proofstack_recheck_reviewer_administrator(scoped,actor);
  cut_key:=public.proofstack_release_authority_time_key(auth->>'capturedAt');
  body:=definition||jsonb_build_object('schemaVersion','0.1',
    'definitionSha256',encode(sha256(convert_to(canonical,'UTF8')),'hex'),
    'publishedAt',auth->>'capturedAt','publishedByPrincipalId',actor->>'principalId');
  result:=public.proofstack_store_release_reviewer_authority(body,canonical);
  IF result->'created' IS DISTINCT FROM 'true'::jsonb OR result->'record' IS DISTINCT FROM body THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Reviewer administrator original publication receipt changed';
  END IF;
  INSERT INTO public.proofstack_release_reviewer_publications(tenant_id,project_id,environment_id,
    source_kind,source_id,source_record,actor,identity_record,grant_record,credential_record,
    issued_at_lexical,issued_at_key,origin_xid,origin_pid,origin_epoch)
    VALUES(scoped->>'tenantId',scoped->>'projectId',scoped->>'environmentId','release_reviewer_authority',id,body,
      actor,auth->'identity',auth->'grant',auth->'credential',auth->>'capturedAt',cut_key,txid_current(),pg_backend_pid(),epoch::bigint);
  RETURN jsonb_build_object('created',true,'sourceKind','release_reviewer_authority','sourceId',id,
    'identityObservation',auth);
END; $$;

CREATE FUNCTION public.proofstack_begin_authenticated_reviewer_authority_lifecycle(expected_scope jsonb,intent jsonb,actor jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE scoped jsonb:=public.proofstack_release_selection_scope();epoch text;auth jsonb;id text:=intent->>'eventId';
  prior public.proofstack_release_reviewer_lifecycle;proof public.proofstack_release_reviewer_publications;
  body jsonb;result jsonb;cut_key numeric;
BEGIN
  epoch:=public.proofstack_reviewer_administrator_context(expected_scope);
  auth:=public.proofstack_recheck_reviewer_administrator(scoped,actor);
  IF id IS NULL OR id !~ '^[a-z][a-z0-9_]{2,63}$' OR intent->>'kind' IS NULL OR intent->>'kind' NOT IN('revoked','superseded') THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Exact reviewer administrator lifecycle intent is required';
  END IF;
  SELECT * INTO prior FROM public.proofstack_release_reviewer_lifecycle WHERE tenant_id=scoped->>'tenantId' AND event_id=id;
  IF FOUND THEN
    SELECT * INTO proof FROM public.proofstack_release_reviewer_publications WHERE tenant_id=scoped->>'tenantId'
      AND project_id=scoped->>'projectId' AND environment_id=scoped->>'environmentId'
      AND source_kind='release_reviewer_authority_lifecycle' AND source_id=id;
    IF NOT FOUND OR NOT proof.completed THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='release_reviewer_administrator:legacy_origin_unproven'; END IF;
    IF prior.project_id<>scoped->>'projectId' OR prior.environment_id<>scoped->>'environmentId'
      OR prior.record->>'actorPrincipalId' IS DISTINCT FROM actor->>'principalId'
      OR prior.record-ARRAY['schemaVersion','scope','actorPrincipalId','occurredAt'] IS DISTINCT FROM intent THEN
      RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='release_reviewer:event_conflict';
    END IF;
    RETURN jsonb_build_object('created',false,'sourceKind','release_reviewer_authority_lifecycle','sourceId',id,
      'identityObservation',auth);
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.proofstack_release_reviewer_publications p WHERE p.tenant_id=scoped->>'tenantId'
    AND p.project_id=scoped->>'projectId' AND p.environment_id=scoped->>'environmentId'
    AND p.source_kind='release_reviewer_authority' AND p.source_id=intent#>>'{authority,authorityVersionId}' AND p.completed)
    OR (intent->>'kind'='superseded' AND NOT EXISTS(SELECT 1 FROM public.proofstack_release_reviewer_publications p
      WHERE p.tenant_id=scoped->>'tenantId' AND p.project_id=scoped->>'projectId' AND p.environment_id=scoped->>'environmentId'
        AND p.source_kind='release_reviewer_authority' AND p.source_id=intent#>>'{successor,authorityVersionId}' AND p.completed)) THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='release_reviewer_administrator:legacy_target_unproven';
  END IF;
  auth:=public.proofstack_recheck_reviewer_administrator(scoped,actor);
  cut_key:=public.proofstack_release_authority_time_key(auth->>'capturedAt');
  body:=intent||jsonb_build_object('scope',scoped,'schemaVersion','0.1','actorPrincipalId',actor->>'principalId','occurredAt',auth->>'capturedAt');
  result:=public.proofstack_store_release_reviewer_lifecycle(body);
  IF result->'created' IS DISTINCT FROM 'true'::jsonb OR result->'record' IS DISTINCT FROM body THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Reviewer administrator original lifecycle receipt changed';
  END IF;
  INSERT INTO public.proofstack_release_reviewer_publications(tenant_id,project_id,environment_id,
    source_kind,source_id,source_record,actor,identity_record,grant_record,credential_record,
    issued_at_lexical,issued_at_key,origin_xid,origin_pid,origin_epoch)
    VALUES(scoped->>'tenantId',scoped->>'projectId',scoped->>'environmentId','release_reviewer_authority_lifecycle',id,body,
      actor,auth->'identity',auth->'grant',auth->'credential',auth->>'capturedAt',cut_key,txid_current(),pg_backend_pid(),epoch::bigint);
  RETURN jsonb_build_object('created',true,'sourceKind','release_reviewer_authority_lifecycle','sourceId',id,
    'identityObservation',auth);
END; $$;

-- Each safe preimage is read separately to keep the wire frame finite; no token/hash verifier is present.
CREATE FUNCTION public.proofstack_read_reviewer_publication_part(expected_scope jsonb,kind text,id text,part text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE scoped jsonb:=public.proofstack_release_selection_scope();value public.proofstack_release_reviewer_publications;
BEGIN
  IF expected_scope IS DISTINCT FROM scoped OR current_setting('transaction_isolation')<>'read committed'
    OR kind IS NULL OR kind NOT IN('release_reviewer_authority','release_reviewer_authority_lifecycle')
    OR id IS NULL OR id !~ '^[a-z][a-z0-9_]{2,63}$'
    OR part IS NULL OR part NOT IN('source','grant','credential','header','source_encoding','grant_encoding','credential_encoding','publication_encoding') THEN
    RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Exact publication read scope/part is required';
  END IF;
  PERFORM public.proofstack_reviewer_administrator_context(expected_scope);
  IF NOT public.proofstack_try_lock_release_reviewer(scoped) THEN
    RAISE EXCEPTION USING ERRCODE='55P03',MESSAGE='Publication read guard is contended';
  END IF;
  SELECT * INTO value FROM public.proofstack_release_reviewer_publications WHERE tenant_id=scoped->>'tenantId'
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
        WHERE o.tenant_id=value.tenant_id AND o.aggregate_type='release_reviewer_publication'
          AND o.aggregate_id='rrp_'||left(value.publication->>'definitionSha256',60)
          AND o.event_type='release.reviewer-authority.authentication_recorded' AND o.schema_version='0.1'
          AND o.payload=jsonb_build_object('recordKind','release_reviewer_publication','record',value.publication)
          AND o.created_at=value.issued_at_lexical::timestamptz));
  END CASE;
END; $$;

CREATE FUNCTION public.proofstack_finish_reviewer_publication(expected_scope jsonb,kind text,id text,
  profile jsonb,canonical text,source_canonical text,grant_canonical text,credential_canonical text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE scoped jsonb:=public.proofstack_release_selection_scope();value public.proofstack_release_reviewer_publications;
  digest_value text;
BEGIN
  PERFORM public.proofstack_reviewer_administrator_context(expected_scope);
  SELECT * INTO value FROM public.proofstack_release_reviewer_publications WHERE tenant_id=scoped->>'tenantId'
    AND project_id=scoped->>'projectId' AND environment_id=scoped->>'environmentId' AND source_kind=kind AND source_id=id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0002',MESSAGE='Pending reviewer administrator publication not found'; END IF;
  IF value.completed THEN
    IF value.publication IS DISTINCT FROM profile OR value.canonical_utf8 IS DISTINCT FROM canonical
      OR value.source_canonical_utf8 IS DISTINCT FROM source_canonical OR value.grant_canonical_utf8 IS DISTINCT FROM grant_canonical
      OR value.credential_canonical_utf8 IS DISTINCT FROM credential_canonical THEN
      RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='release_reviewer_administrator:publication_conflict';
    END IF;
    RETURN value.publication;
  END IF;
  IF value.origin_xid<>txid_current() OR value.origin_pid<>pg_backend_pid() THEN
    RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Publication completion requires its original held transaction';
  END IF;
  PERFORM public.proofstack_recheck_reviewer_administrator(expected_scope,value.actor);
  IF value.origin_epoch<>public.proofstack_current_replay_recovery_epoch() THEN
    RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Original reviewer publication recovery epoch changed';
  END IF;
  UPDATE public.proofstack_release_reviewer_publications SET completed=true,publication=profile,canonical_utf8=canonical,
    source_canonical_utf8=source_canonical,grant_canonical_utf8=grant_canonical,credential_canonical_utf8=credential_canonical
    WHERE tenant_id=value.tenant_id AND source_kind=value.source_kind AND source_id=value.source_id;
  digest_value:=encode(sha256(convert_to(canonical,'UTF8')),'hex');
  INSERT INTO public.proofstack_outbox(tenant_id,aggregate_type,aggregate_id,event_type,payload,schema_version,created_at)
    VALUES(value.tenant_id,'release_reviewer_publication','rrp_'||left(digest_value,60),'release.reviewer-authority.authentication_recorded',
      jsonb_build_object('recordKind','release_reviewer_publication','record',profile),'0.1',value.issued_at_lexical::timestamptz);
  SET CONSTRAINTS ALL IMMEDIATE;
  RETURN profile;
END; $$;

REVOKE ALL ON FUNCTION public.proofstack_begin_authenticated_reviewer_authority(jsonb,jsonb,text,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.proofstack_begin_authenticated_reviewer_authority_lifecycle(jsonb,jsonb,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.proofstack_read_reviewer_publication_part(jsonb,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.proofstack_finish_reviewer_publication(jsonb,text,text,jsonb,text,text,text,text) FROM PUBLIC;

-- Fixed owning projections. No caller SQL, caller role, or content/key port is exposed.
CREATE FUNCTION public.proofstack_read_reviewer_administrator_projection(expected_scope jsonb,requested_kind text,requested_id text,secondary_id text,tertiary_id text)
RETURNS SETOF jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE scoped jsonb:=public.proofstack_release_selection_scope();material jsonb;bytes bytea;offset_value integer:=0;
  digest_value text;records_value bigint;total integer;
BEGIN
  PERFORM public.proofstack_reviewer_administrator_context(expected_scope);
  IF requested_id IS NULL OR requested_id !~ '^[a-z][a-z0-9_]{2,63}$'
    OR secondary_id IS NULL OR tertiary_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Exact reviewer projection identifiers are required';
  END IF;
  IF (requested_kind IN('authority_view','authority_event_view') AND (secondary_id<>'' OR tertiary_id<>''))
    OR (requested_kind IN('authority_versions','authority_events') AND (tertiary_id<>'' OR (secondary_id<>'' AND secondary_id !~ '^[a-z][a-z0-9_]{2,63}$')))
    OR (requested_kind='authority_root' AND (secondary_id !~ '^[a-z][a-z0-9_]{2,63}$' OR tertiary_id !~ '^[a-z][a-z0-9_]{2,63}$')) THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Exact reviewer projection selector is required';
  END IF;
  CASE requested_kind
    WHEN 'authority_view' THEN
      SELECT COALESCE(jsonb_agg(to_jsonb(q)),'[]'::jsonb) INTO material FROM (
SELECT to_jsonb(v) || jsonb_build_object('effective_at_key',v.effective_at_key::text,'expires_at_key',v.expires_at_key::text,'published_at_key',v.published_at_key::text) AS version, to_jsonb(r) AS root,
  to_jsonb(rv) || jsonb_build_object('effective_at_key',rv.effective_at_key::text,'expires_at_key',rv.expires_at_key::text,'published_at_key',rv.published_at_key::text) AS root_version, to_jsonb(pv) || jsonb_build_object('effective_at_key',pv.effective_at_key::text,'expires_at_key',pv.expires_at_key::text,'published_at_key',pv.published_at_key::text) AS predecessor,
  (SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY p.kind COLLATE "C",p.ordinal),'[]'::jsonb)
    FROM public.proofstack_release_reviewer_memberships p WHERE p.tenant_id=v.tenant_id AND p.version_id=v.version_id) AS memberships,
  (SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY p.kind COLLATE "C",p.ordinal),'[]'::jsonb)
    FROM public.proofstack_release_reviewer_declarations p WHERE p.tenant_id=v.tenant_id AND p.version_id=v.version_id) AS declarations,
  (SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY p.ordinal),'[]'::jsonb)
    FROM public.proofstack_release_reviewer_basis p WHERE p.tenant_id=v.tenant_id AND p.version_id=v.version_id) AS basis,
  (SELECT COALESCE(jsonb_agg(jsonb_build_object('eventType',o.event_type,'schemaVersion',o.schema_version,
    'payload',o.payload,'timeMatches',o.created_at=v.published_at_lexical::timestamptz)),'[]'::jsonb)
    FROM public.proofstack_outbox o WHERE o.tenant_id=v.tenant_id AND o.aggregate_type='release_reviewer_authority' AND o.aggregate_id=v.version_id) AS intents
  FROM public.proofstack_release_reviewer_authorities v
  LEFT JOIN public.proofstack_release_reviewer_roots r ON r.tenant_id=v.tenant_id AND r.authority_id=v.authority_id
  LEFT JOIN public.proofstack_release_reviewer_authorities rv ON rv.tenant_id=r.tenant_id AND rv.version_id=r.root_version_id
  LEFT JOIN public.proofstack_release_reviewer_authorities pv ON pv.tenant_id=v.tenant_id AND pv.version_id=v.parent_version_id
  WHERE v.tenant_id=(scoped->>'tenantId') AND v.project_id=(scoped->>'projectId') AND v.environment_id=(scoped->>'environmentId') AND v.version_id=requested_id
      ) q;
    WHEN 'authority_event_view' THEN
      SELECT COALESCE(jsonb_agg(to_jsonb(q)),'[]'::jsonb) INTO material FROM (
SELECT to_jsonb(e)||jsonb_build_object('occurred_at_key',e.occurred_at_key::text) AS event,
  (SELECT COALESCE(jsonb_agg(jsonb_build_object('eventType',o.event_type,'schemaVersion',o.schema_version,
    'payload',o.payload,'timeMatches',o.created_at=e.occurred_at_lexical::timestamptz)),'[]'::jsonb)
    FROM public.proofstack_outbox o WHERE o.tenant_id=e.tenant_id AND o.aggregate_type='release_reviewer_authority_lifecycle' AND o.aggregate_id=e.event_id) AS intents
  FROM public.proofstack_release_reviewer_lifecycle e
  WHERE e.tenant_id=(scoped->>'tenantId') AND e.project_id=(scoped->>'projectId') AND e.environment_id=(scoped->>'environmentId') AND e.event_id=requested_id
      ) q;
    WHEN 'authority_root' THEN
      SELECT COALESCE(jsonb_agg(to_jsonb(q)),'[]'::jsonb) INTO material FROM (
SELECT public.proofstack_read_release_reviewer_root(scoped,requested_id,secondary_id,tertiary_id) AS value
      ) q;
    WHEN 'authority_versions' THEN
      SELECT COALESCE(jsonb_agg(to_jsonb(q)),'[]'::jsonb) INTO material FROM (
SELECT version_id FROM public.proofstack_release_reviewer_authorities WHERE tenant_id=scoped->>'tenantId' AND project_id=scoped->>'projectId' AND environment_id=scoped->>'environmentId' AND authority_id=requested_id AND version_id COLLATE "C">secondary_id COLLATE "C" ORDER BY version_id COLLATE "C" LIMIT 16
      ) q;
    WHEN 'authority_events' THEN
      SELECT COALESCE(jsonb_agg(to_jsonb(q)),'[]'::jsonb) INTO material FROM (
SELECT e.event_id FROM public.proofstack_release_reviewer_lifecycle e JOIN public.proofstack_release_reviewer_authorities v ON v.tenant_id=e.tenant_id AND v.version_id=e.version_id WHERE e.tenant_id=scoped->>'tenantId' AND e.project_id=scoped->>'projectId' AND e.environment_id=scoped->>'environmentId' AND v.authority_id=requested_id AND e.event_id COLLATE "C">secondary_id COLLATE "C" ORDER BY e.event_id COLLATE "C" LIMIT 16
      ) q;
    ELSE RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Unsupported owning reviewer projection';
  END CASE;
  bytes:=convert_to(material::text,'UTF8');total:=octet_length(bytes);
  IF total>16777216 THEN RAISE EXCEPTION USING ERRCODE='54000',MESSAGE='Owning reviewer projection byte admission exhausted'; END IF;
  SELECT count(*) INTO records_value FROM jsonb_path_query(material,'strict $.** ? (@.type() == "object")');
  records_value:=GREATEST(records_value,1);
  IF records_value>10000 THEN RAISE EXCEPTION USING ERRCODE='54000',MESSAGE='Owning reviewer projection record admission exhausted'; END IF;
  digest_value:=encode(sha256(bytes),'hex');
  WHILE offset_value<total LOOP
    RETURN NEXT jsonb_build_object('scope',scoped,'projection',requested_kind,'offset',offset_value,
      'totalBytes',total,'sha256',digest_value,'records',CASE WHEN offset_value=0 THEN records_value ELSE 0 END,
      'chunkBase64',replace(encode(substring(bytes FROM offset_value+1 FOR 65536),'base64'),chr(10),''));
    offset_value:=offset_value+65536;
  END LOOP;
END; $$;
REVOKE ALL ON FUNCTION public.proofstack_read_reviewer_administrator_projection(jsonb,text,text,text,text) FROM PUBLIC;
