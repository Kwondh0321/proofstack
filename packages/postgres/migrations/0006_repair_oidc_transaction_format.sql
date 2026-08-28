ALTER TABLE public.proofstack_oidc_login_transactions
  DROP CONSTRAINT proofstack_oidc_login_payload_format;

ALTER TABLE public.proofstack_oidc_login_transactions
  ADD CONSTRAINT proofstack_oidc_login_payload_format CHECK (
    length(protected_payload) BETWEEN 48 AND 4143
    AND protected_payload ~ '^otx_v1_[A-Za-z0-9_-]{16}_[A-Za-z0-9_-]+_[A-Za-z0-9_-]{22}$'
  );
