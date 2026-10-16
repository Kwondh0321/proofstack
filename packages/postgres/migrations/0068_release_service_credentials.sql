-- Private, non-delegated publisher authentication. No existing runtime grants and no human
-- approval power. Current installation/source authority and atomic decisions remain separate.
CREATE TABLE public.proofstack_release_service_credentials (
  tenant_id varchar(64) NOT NULL, credential_id varchar(64) NOT NULL,
  principal_id varchar(64) NOT NULL, token_prefix text NOT NULL UNIQUE,
  password_hash jsonb NOT NULL, resource_scope jsonb NOT NULL,
  created_at_lexical text NOT NULL, expires_at_lexical text NOT NULL,
  created_at_key numeric(50,0) NOT NULL, expires_at_key numeric(50,0) NOT NULL,
  revoked_at_lexical text, revoked_at_key numeric(50,0), revocation_reason text,
  PRIMARY KEY(tenant_id,credential_id),
  CHECK((tenant_id ~ '^[a-z][a-z0-9_]{2,63}$' AND credential_id ~ '^[a-z][a-z0-9_]{2,63}$'
    AND principal_id ~ '^[a-z][a-z0-9_]{2,63}$' AND token_prefix ~ '^[A-Za-z0-9_-]{22}$'
    AND rtrim(translate(encode(decode(translate(token_prefix||'==','-_','+/'),'base64'),'base64'),'+/','-_'),'=')=token_prefix) IS TRUE),
  CHECK((password_hash=jsonb_build_object('algorithm','scrypt-v1','blockSize',8,'cost',32768,
    'digest',password_hash->>'digest','keyLength',32,'parallelization',1,'salt',password_hash->>'salt')
    AND password_hash->>'digest' ~ '^[A-Za-z0-9_-]{43}$' AND password_hash->>'salt' ~ '^[A-Za-z0-9_-]{22}$'
    AND rtrim(translate(encode(decode(translate((password_hash->>'digest')||'=','-_','+/'),'base64'),'base64'),'+/','-_'),'=')=password_hash->>'digest'
    AND rtrim(translate(encode(decode(translate((password_hash->>'salt')||'==','-_','+/'),'base64'),'base64'),'+/','-_'),'=')=password_hash->>'salt') IS TRUE),
  CHECK((resource_scope->>'mode'='restricted' AND jsonb_typeof(resource_scope->'projects')='array'
    AND jsonb_array_length(resource_scope->'projects') BETWEEN 1 AND 100
    AND octet_length(resource_scope::text)<=1048576) IS TRUE),
  CHECK((created_at_key=public.proofstack_release_authority_time_key(created_at_lexical)
    AND expires_at_key=public.proofstack_release_authority_time_key(expires_at_lexical)
    AND created_at_key<expires_at_key AND (revoked_at_lexical IS NULL)=(revoked_at_key IS NULL)
    AND (revoked_at_lexical IS NULL)=(revocation_reason IS NULL)
    AND (revoked_at_lexical IS NULL OR (revoked_at_key=public.proofstack_release_authority_time_key(revoked_at_lexical)
      AND revoked_at_key>=created_at_key AND revocation_reason IN('administrative','rotation')))) IS TRUE)
);

CREATE FUNCTION public.proofstack_validate_release_service_credential()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE project jsonb;environment jsonb;projects text[]:='{}';environments text[];
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='Service credentials are retained'; END IF;
  IF TG_OP='UPDATE' THEN
    IF to_jsonb(NEW)-ARRAY['revoked_at_lexical','revoked_at_key','revocation_reason'] IS DISTINCT FROM
       to_jsonb(OLD)-ARRAY['revoked_at_lexical','revoked_at_key','revocation_reason']
      OR OLD.revoked_at_lexical IS NOT NULL OR NEW.revoked_at_lexical IS NULL THEN
      RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='Service identity and grants are immutable';
    END IF;
  END IF;
  IF NEW.resource_scope IS DISTINCT FROM jsonb_build_object('mode','restricted','projects',NEW.resource_scope->'projects') THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Invalid private service resource scope';
  END IF;
  FOR project IN SELECT value FROM jsonb_array_elements(NEW.resource_scope->'projects') LOOP
    IF project IS DISTINCT FROM jsonb_build_object('projectId',project->>'projectId','environmentIds',project->'environmentIds')
      OR NOT COALESCE(project->>'projectId' ~ '^[a-z][a-z0-9_]{2,63}$',false)
      OR jsonb_typeof(project->'environmentIds') IS DISTINCT FROM 'array'
      OR jsonb_array_length(project->'environmentIds') NOT BETWEEN 1 AND 100
      OR project->>'projectId'=ANY(projects) THEN
      RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Invalid private service project scope';
    END IF;
    projects:=array_append(projects,project->>'projectId');environments:='{}';
    FOR environment IN SELECT value FROM jsonb_array_elements(project->'environmentIds') LOOP
      IF jsonb_typeof(environment) IS DISTINCT FROM 'string'
        OR NOT COALESCE(environment#>>'{}' ~ '^[a-z][a-z0-9_]{2,63}$',false)
        OR environment#>>'{}'=ANY(environments) THEN
        RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Invalid private service environment scope';
      END IF;
      environments:=array_append(environments,environment#>>'{}');
    END LOOP;
  END LOOP;
  RETURN NEW;
END; $$;
CREATE TRIGGER proofstack_release_service_credentials_validate BEFORE INSERT OR UPDATE OR DELETE
  ON public.proofstack_release_service_credentials FOR EACH ROW EXECUTE FUNCTION public.proofstack_validate_release_service_credential();

CREATE FUNCTION public.proofstack_lock_release_service_credential_write()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(
    jsonb_build_array('proofstack.release-service.v1',NEW.tenant_id,NEW.credential_id)::text,0));
  RETURN NULL;
END; $$;
CREATE TRIGGER proofstack_release_service_credentials_write_guard AFTER INSERT OR UPDATE
  ON public.proofstack_release_service_credentials FOR EACH ROW EXECUTE FUNCTION public.proofstack_lock_release_service_credential_write();
CREATE FUNCTION public.proofstack_try_lock_release_service_credential(expected_scope jsonb,credential text)
RETURNS boolean LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF expected_scope IS DISTINCT FROM public.proofstack_release_selection_scope()
    OR credential IS NULL OR credential !~ '^[a-z][a-z0-9_]{2,63}$' THEN
    RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Exact private service credential scope is required';
  END IF;
  IF current_setting('transaction_isolation')<>'read committed' THEN
    RAISE EXCEPTION USING ERRCODE='0A000',MESSAGE='Private service guards require READ COMMITTED';
  END IF;
  RETURN pg_try_advisory_xact_lock_shared(hashtextextended(
    jsonb_build_array('proofstack.release-service.v1',expected_scope->>'tenantId',credential)::text,0));
END; $$;

ALTER TABLE public.proofstack_release_service_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.proofstack_release_service_credentials FORCE ROW LEVEL SECURITY;
CREATE POLICY proofstack_release_service_credentials_scope ON public.proofstack_release_service_credentials
  FOR ALL USING(tenant_id=NULLIF(current_setting('proofstack.tenant_id',true),'')
    AND EXISTS(SELECT 1 FROM jsonb_array_elements(resource_scope->'projects') p
      WHERE p->>'projectId'=NULLIF(current_setting('proofstack.project_id',true),'')
      AND p->'environmentIds' ? NULLIF(current_setting('proofstack.environment_id',true),'')))
  WITH CHECK(tenant_id=NULLIF(current_setting('proofstack.tenant_id',true),'')
    AND EXISTS(SELECT 1 FROM jsonb_array_elements(resource_scope->'projects') p
      WHERE p->>'projectId'=NULLIF(current_setting('proofstack.project_id',true),'')
      AND p->'environmentIds' ? NULLIF(current_setting('proofstack.environment_id',true),'')));

-- Trusted administrative provisioning only. No raw token, chosen creation receipt or runtime grant.
CREATE FUNCTION public.proofstack_create_release_service_credential(expected_scope jsonb,body jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE prior public.proofstack_release_service_credentials;at_text text;scope jsonb:=public.proofstack_release_selection_scope();
BEGIN
  IF expected_scope IS DISTINCT FROM scope OR body IS DISTINCT FROM jsonb_build_object(
    'credentialId',body->>'credentialId','principalId',body->>'principalId','prefix',body->>'prefix',
    'passwordHash',body->'passwordHash','resourceScope',body->'resourceScope','expiresAt',body->>'expiresAt')
    OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(body#>'{resourceScope,projects}') p
      WHERE p->>'projectId'=scope->>'projectId' AND p->'environmentIds' ? (scope->>'environmentId')) THEN
    RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Exact private service provisioning scope is required';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array('proofstack.release-service.v1',scope->>'tenantId',body->>'credentialId')::text,0));
  SELECT * INTO prior FROM public.proofstack_release_service_credentials c WHERE c.tenant_id=scope->>'tenantId' AND c.credential_id=body->>'credentialId';
  IF FOUND THEN
    IF jsonb_build_object('credentialId',prior.credential_id,'principalId',prior.principal_id,
      'prefix',prior.token_prefix,'passwordHash',prior.password_hash,'resourceScope',prior.resource_scope,
      'expiresAt',prior.expires_at_lexical) IS DISTINCT FROM body THEN
      RAISE EXCEPTION USING ERRCODE='23505',MESSAGE='Private service credential intent conflicts';
    END IF;
    RETURN false;
  END IF;
  at_text:=to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"');
  INSERT INTO public.proofstack_release_service_credentials VALUES(scope->>'tenantId',body->>'credentialId',
    body->>'principalId',body->>'prefix',body->'passwordHash',body->'resourceScope',at_text,body->>'expiresAt',
    public.proofstack_release_authority_time_key(at_text),public.proofstack_release_authority_time_key(body->>'expiresAt'),NULL,NULL,NULL);
  RETURN true;
END; $$;
CREATE FUNCTION public.proofstack_revoke_release_service_credential(expected_scope jsonb,requested_id text,reason text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE prior public.proofstack_release_service_credentials;at_text text;scope jsonb:=public.proofstack_release_selection_scope();
BEGIN
  IF expected_scope IS DISTINCT FROM scope OR reason IS NULL OR reason NOT IN('administrative','rotation') THEN
    RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Exact private service revocation scope is required';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array('proofstack.release-service.v1',scope->>'tenantId',requested_id)::text,0));
  SELECT * INTO prior FROM public.proofstack_release_service_credentials c WHERE c.tenant_id=scope->>'tenantId' AND c.credential_id=requested_id
    AND EXISTS(SELECT 1 FROM jsonb_array_elements(c.resource_scope->'projects') p WHERE p->>'projectId'=scope->>'projectId' AND p->'environmentIds' ? (scope->>'environmentId'));
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Private service credential is unavailable'; END IF;
  IF prior.revoked_at_lexical IS NOT NULL THEN
    IF prior.revocation_reason<>reason THEN RAISE EXCEPTION USING ERRCODE='23505',MESSAGE='Private service revocation intent conflicts'; END IF;
    RETURN false;
  END IF;
  at_text:=to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"');
  UPDATE public.proofstack_release_service_credentials SET revoked_at_lexical=at_text,
    revoked_at_key=public.proofstack_release_authority_time_key(at_text),revocation_reason=reason
    WHERE tenant_id=scope->>'tenantId' AND credential_id=requested_id;
  RETURN true;
END; $$;

-- Only the private authenticator sees this verifier. No source observation, outbox or public
-- authority material contains a prefix, salt or verifier. Password verification runs outside guards.
CREATE FUNCTION public.proofstack_find_active_release_service_credential(prefix text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE value public.proofstack_release_service_credentials;at_text text;
BEGIN
  IF prefix IS NULL OR prefix !~ '^[A-Za-z0-9_-]{22}$' THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid private service prefix';
  END IF;
  at_text:=to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"');
  SELECT * INTO value FROM public.proofstack_release_service_credentials c WHERE c.token_prefix=prefix
    AND c.revoked_at_lexical IS NULL AND c.created_at_key<=public.proofstack_release_authority_time_key(at_text)
    AND c.expires_at_key>public.proofstack_release_authority_time_key(at_text);
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN jsonb_build_object('kind','service_token','authenticatedAt',
    to_char(at_text::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'credentialId',value.credential_id,'principalId',value.principal_id,'tenantId',value.tenant_id,
    'prefix',value.token_prefix,'passwordHash',value.password_hash,'capabilities',jsonb_build_array('release:decision:publish'),
    'resourceScope',value.resource_scope);
END; $$;
CREATE FUNCTION public.proofstack_confirm_release_service_use(expected jsonb)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE observed jsonb;
BEGIN
  observed:=public.proofstack_find_active_release_service_credential(expected->>'prefix');
  -- The secret verifier AND the complete immutable principal/grants are rechecked after scrypt.
  RETURN observed IS NOT NULL AND observed-'authenticatedAt'=expected;
END; $$;

REVOKE ALL ON TABLE public.proofstack_release_service_credentials FROM PUBLIC;
REVOKE ALL ON FUNCTION public.proofstack_validate_release_service_credential() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.proofstack_lock_release_service_credential_write() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.proofstack_try_lock_release_service_credential(jsonb,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.proofstack_find_active_release_service_credential(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.proofstack_confirm_release_service_use(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.proofstack_create_release_service_credential(jsonb,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.proofstack_revoke_release_service_credential(jsonb,text,text) FROM PUBLIC;
