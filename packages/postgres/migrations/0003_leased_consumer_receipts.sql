DROP TRIGGER proofstack_consumer_receipt_append_only
  ON public.proofstack_consumer_receipts;
DROP FUNCTION public.proofstack_reject_append_only_mutation();

ALTER TABLE public.proofstack_consumer_receipts
  ADD COLUMN state varchar(16) NOT NULL DEFAULT 'completed',
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  ADD COLUMN available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  ADD COLUMN attempt_count integer NOT NULL DEFAULT 1,
  ADD COLUMN lease_token uuid,
  ADD COLUMN lease_owner varchar(64),
  ADD COLUMN lease_expires_at timestamptz,
  ADD COLUMN last_error varchar(2048);

UPDATE public.proofstack_consumer_receipts
SET created_at = completed_at,
    available_at = completed_at;

ALTER TABLE public.proofstack_consumer_receipts
  ALTER COLUMN state DROP DEFAULT,
  ALTER COLUMN completed_at DROP DEFAULT,
  ALTER COLUMN completed_at DROP NOT NULL,
  ADD CONSTRAINT proofstack_consumer_receipt_state_value CHECK (
    state IN ('available', 'processing', 'completed')
  ),
  ADD CONSTRAINT proofstack_consumer_receipt_attempt_range CHECK (
    attempt_count BETWEEN 1 AND 1000000
  ),
  ADD CONSTRAINT proofstack_consumer_receipt_lease_owner_format CHECK (
    lease_owner IS NULL OR lease_owner ~ '^[a-z][a-z0-9_]{2,63}$'
  ),
  ADD CONSTRAINT proofstack_consumer_receipt_last_error_length CHECK (
    last_error IS NULL OR length(last_error) BETWEEN 1 AND 2048
  ),
  ADD CONSTRAINT proofstack_consumer_receipt_completion_time CHECK (
    completed_at IS NULL OR completed_at >= created_at
  ),
  ADD CONSTRAINT proofstack_consumer_receipt_state_shape CHECK (
    (
      state = 'available'
      AND lease_token IS NULL
      AND lease_owner IS NULL
      AND lease_expires_at IS NULL
      AND completed_at IS NULL
      AND last_error IS NOT NULL
    )
    OR (
      state = 'processing'
      AND lease_token IS NOT NULL
      AND lease_owner IS NOT NULL
      AND lease_expires_at IS NOT NULL
      AND completed_at IS NULL
    )
    OR (
      state = 'completed'
      AND lease_token IS NULL
      AND lease_owner IS NULL
      AND lease_expires_at IS NULL
      AND completed_at IS NOT NULL
      AND last_error IS NULL
    )
  );

CREATE INDEX proofstack_consumer_receipt_recovery_idx
  ON public.proofstack_consumer_receipts (
    tenant_id,
    consumer_name,
    state,
    available_at,
    lease_expires_at
  )
  WHERE state <> 'completed';

CREATE POLICY proofstack_consumer_receipt_tenant_update
  ON public.proofstack_consumer_receipts
  FOR UPDATE
  USING (
    tenant_id = NULLIF(current_setting('proofstack.tenant_id', true), '')
  )
  WITH CHECK (
    tenant_id = NULLIF(current_setting('proofstack.tenant_id', true), '')
  );

CREATE FUNCTION public.proofstack_guard_consumer_receipt_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'ProofStack consumer receipts cannot be deleted';
  END IF;

  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.consumer_name IS DISTINCT FROM OLD.consumer_name
    OR NEW.message_id IS DISTINCT FROM OLD.message_id
    OR NEW.payload_sha256 IS DISTINCT FROM OLD.payload_sha256
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'ProofStack consumer receipt identity is immutable';
  END IF;

  IF OLD.state = 'completed' THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'A completed ProofStack consumer receipt is terminal';
  END IF;

  IF OLD.state = 'available' THEN
    IF NEW.state <> 'processing'
      OR NEW.attempt_count <> OLD.attempt_count + 1
      OR NEW.available_at IS DISTINCT FROM OLD.available_at
      OR OLD.available_at > clock_timestamp()
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '55000',
        MESSAGE = 'An available ProofStack consumer receipt can only enter processing';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.state = 'processing' AND NEW.state = 'processing' THEN
    IF OLD.lease_expires_at > clock_timestamp()
      OR NEW.attempt_count <> OLD.attempt_count + 1
      OR NEW.available_at IS DISTINCT FROM OLD.available_at
      OR NEW.lease_token IS NOT DISTINCT FROM OLD.lease_token
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '55000',
        MESSAGE = 'A processing ProofStack consumer receipt can only be reclaimed after expiry';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.state = 'processing' AND NEW.state IN ('available', 'completed') THEN
    IF OLD.lease_expires_at <= clock_timestamp()
      OR NEW.attempt_count <> OLD.attempt_count
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '55000',
        MESSAGE = 'Only a current ProofStack consumer receipt lease can finish processing';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION USING
    ERRCODE = '55000',
    MESSAGE = 'Illegal ProofStack consumer receipt state transition';
END;
$$;

REVOKE ALL ON FUNCTION public.proofstack_guard_consumer_receipt_transition() FROM PUBLIC;

CREATE TRIGGER proofstack_consumer_receipt_transition_guard
  BEFORE UPDATE OR DELETE ON public.proofstack_consumer_receipts
  FOR EACH ROW
  EXECUTE FUNCTION public.proofstack_guard_consumer_receipt_transition();
