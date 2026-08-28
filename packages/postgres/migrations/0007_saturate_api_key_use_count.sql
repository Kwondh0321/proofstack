CREATE OR REPLACE FUNCTION public.proofstack_record_api_key_use(
  p_tenant_id text,
  p_credential_id text,
  p_key_prefix text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
BEGIN
  UPDATE public.proofstack_api_key_credentials AS credential
  SET last_used_at = v_now,
      use_count = CASE
        WHEN credential.use_count = 2147483647 THEN credential.use_count
        ELSE credential.use_count + 1
      END
  WHERE credential.tenant_id = p_tenant_id
    AND credential.credential_id = p_credential_id
    AND credential.key_prefix = p_key_prefix
    AND credential.revoked_at IS NULL
    AND credential.expires_at > v_now;

  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.proofstack_record_api_key_use(text, text, text) FROM PUBLIC;
