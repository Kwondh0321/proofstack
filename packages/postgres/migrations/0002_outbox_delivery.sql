CREATE TABLE public.proofstack_outbox (
  tenant_id varchar(64) NOT NULL,
  outbox_id bigint GENERATED ALWAYS AS IDENTITY,
  event_type varchar(128) NOT NULL,
  aggregate_type varchar(64) NOT NULL,
  aggregate_id varchar(64) NOT NULL,
  schema_version varchar(16) NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  attempt_count integer NOT NULL DEFAULT 0,
  lease_token uuid,
  lease_owner varchar(64),
  lease_expires_at timestamptz,
  published_at timestamptz,
  last_error varchar(2048),

  CONSTRAINT proofstack_outbox_pk PRIMARY KEY (tenant_id, outbox_id),
  CONSTRAINT proofstack_outbox_intent_unique UNIQUE (
    tenant_id,
    event_type,
    aggregate_type,
    aggregate_id
  ),
  CONSTRAINT proofstack_outbox_tenant_id_format CHECK (
    tenant_id ~ '^[a-z][a-z0-9_]{2,63}$'
  ),
  CONSTRAINT proofstack_outbox_event_type_format CHECK (
    event_type ~ '^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)+$'
  ),
  CONSTRAINT proofstack_outbox_aggregate_type_format CHECK (
    aggregate_type ~ '^[a-z][a-z0-9_.-]{2,63}$'
  ),
  CONSTRAINT proofstack_outbox_aggregate_id_format CHECK (
    aggregate_id ~ '^[a-z][a-z0-9_]{2,63}$'
  ),
  CONSTRAINT proofstack_outbox_schema_version_format CHECK (
    schema_version ~ '^[0-9]+\.[0-9]+$'
  ),
  CONSTRAINT proofstack_outbox_payload_object CHECK (
    jsonb_typeof(payload) = 'object'
  ),
  CONSTRAINT proofstack_outbox_attempt_range CHECK (
    attempt_count BETWEEN 0 AND 1000000
  ),
  CONSTRAINT proofstack_outbox_lease_owner_format CHECK (
    lease_owner IS NULL OR lease_owner ~ '^[a-z][a-z0-9_]{2,63}$'
  ),
  CONSTRAINT proofstack_outbox_lease_state CHECK (
    (
      lease_token IS NULL
      AND lease_owner IS NULL
      AND lease_expires_at IS NULL
    )
    OR (
      lease_token IS NOT NULL
      AND lease_owner IS NOT NULL
      AND lease_expires_at IS NOT NULL
      AND published_at IS NULL
    )
  )
);

CREATE INDEX proofstack_outbox_claim_idx
  ON public.proofstack_outbox (tenant_id, available_at, outbox_id)
  WHERE published_at IS NULL;

ALTER TABLE public.proofstack_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.proofstack_outbox FORCE ROW LEVEL SECURITY;

CREATE POLICY proofstack_outbox_tenant_select
  ON public.proofstack_outbox
  FOR SELECT
  USING (
    tenant_id = NULLIF(current_setting('proofstack.tenant_id', true), '')
  );

CREATE POLICY proofstack_outbox_tenant_insert
  ON public.proofstack_outbox
  FOR INSERT
  WITH CHECK (
    tenant_id = NULLIF(current_setting('proofstack.tenant_id', true), '')
  );

CREATE POLICY proofstack_outbox_tenant_update
  ON public.proofstack_outbox
  FOR UPDATE
  USING (
    tenant_id = NULLIF(current_setting('proofstack.tenant_id', true), '')
  )
  WITH CHECK (
    tenant_id = NULLIF(current_setting('proofstack.tenant_id', true), '')
  );

CREATE FUNCTION public.proofstack_guard_outbox_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'ProofStack outbox records cannot be deleted';
  END IF;

  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.outbox_id IS DISTINCT FROM OLD.outbox_id
    OR NEW.event_type IS DISTINCT FROM OLD.event_type
    OR NEW.aggregate_type IS DISTINCT FROM OLD.aggregate_type
    OR NEW.aggregate_id IS DISTINCT FROM OLD.aggregate_id
    OR NEW.schema_version IS DISTINCT FROM OLD.schema_version
    OR NEW.payload IS DISTINCT FROM OLD.payload
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'ProofStack outbox publication intent is immutable';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.proofstack_guard_outbox_mutation() FROM PUBLIC;

CREATE TRIGGER proofstack_outbox_mutation_guard
  BEFORE UPDATE OR DELETE ON public.proofstack_outbox
  FOR EACH ROW
  EXECUTE FUNCTION public.proofstack_guard_outbox_mutation();

CREATE TABLE public.proofstack_projection_cursors (
  tenant_id varchar(64) NOT NULL,
  consumer_name varchar(128) NOT NULL,
  generation integer NOT NULL DEFAULT 1,
  last_outbox_id bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT proofstack_projection_cursors_pk PRIMARY KEY (
    tenant_id,
    consumer_name,
    generation
  ),
  CONSTRAINT proofstack_projection_cursor_tenant_id_format CHECK (
    tenant_id ~ '^[a-z][a-z0-9_]{2,63}$'
  ),
  CONSTRAINT proofstack_projection_cursor_consumer_format CHECK (
    consumer_name ~ '^[a-z][a-z0-9_.-]{2,127}$'
  ),
  CONSTRAINT proofstack_projection_cursor_generation_range CHECK (
    generation BETWEEN 1 AND 1000000
  ),
  CONSTRAINT proofstack_projection_cursor_position_range CHECK (
    last_outbox_id >= 0
  )
);

ALTER TABLE public.proofstack_projection_cursors ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.proofstack_projection_cursors FORCE ROW LEVEL SECURITY;

CREATE POLICY proofstack_projection_cursor_tenant_select
  ON public.proofstack_projection_cursors
  FOR SELECT
  USING (
    tenant_id = NULLIF(current_setting('proofstack.tenant_id', true), '')
  );

CREATE POLICY proofstack_projection_cursor_tenant_insert
  ON public.proofstack_projection_cursors
  FOR INSERT
  WITH CHECK (
    tenant_id = NULLIF(current_setting('proofstack.tenant_id', true), '')
  );

CREATE POLICY proofstack_projection_cursor_tenant_update
  ON public.proofstack_projection_cursors
  FOR UPDATE
  USING (
    tenant_id = NULLIF(current_setting('proofstack.tenant_id', true), '')
  )
  WITH CHECK (
    tenant_id = NULLIF(current_setting('proofstack.tenant_id', true), '')
  );

CREATE FUNCTION public.proofstack_guard_projection_cursor()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'ProofStack projection cursors cannot be deleted';
  END IF;

  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.consumer_name IS DISTINCT FROM OLD.consumer_name
    OR NEW.generation IS DISTINCT FROM OLD.generation
    OR NEW.last_outbox_id < OLD.last_outbox_id
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'ProofStack projection cursors are monotonic';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.proofstack_guard_projection_cursor() FROM PUBLIC;

CREATE TRIGGER proofstack_projection_cursor_guard
  BEFORE UPDATE OR DELETE ON public.proofstack_projection_cursors
  FOR EACH ROW
  EXECUTE FUNCTION public.proofstack_guard_projection_cursor();

CREATE TABLE public.proofstack_consumer_receipts (
  tenant_id varchar(64) NOT NULL,
  consumer_name varchar(128) NOT NULL,
  message_id varchar(128) NOT NULL,
  payload_sha256 character(64) NOT NULL,
  completed_at timestamptz NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT proofstack_consumer_receipts_pk PRIMARY KEY (
    tenant_id,
    consumer_name,
    message_id
  ),
  CONSTRAINT proofstack_consumer_receipt_tenant_id_format CHECK (
    tenant_id ~ '^[a-z][a-z0-9_]{2,63}$'
  ),
  CONSTRAINT proofstack_consumer_receipt_consumer_format CHECK (
    consumer_name ~ '^[a-z][a-z0-9_.-]{2,127}$'
  ),
  CONSTRAINT proofstack_consumer_receipt_message_id_format CHECK (
    length(message_id) BETWEEN 1 AND 128
  ),
  CONSTRAINT proofstack_consumer_receipt_sha256_format CHECK (
    payload_sha256 ~ '^[0-9a-f]{64}$'
  )
);

ALTER TABLE public.proofstack_consumer_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.proofstack_consumer_receipts FORCE ROW LEVEL SECURITY;

CREATE POLICY proofstack_consumer_receipt_tenant_select
  ON public.proofstack_consumer_receipts
  FOR SELECT
  USING (
    tenant_id = NULLIF(current_setting('proofstack.tenant_id', true), '')
  );

CREATE POLICY proofstack_consumer_receipt_tenant_insert
  ON public.proofstack_consumer_receipts
  FOR INSERT
  WITH CHECK (
    tenant_id = NULLIF(current_setting('proofstack.tenant_id', true), '')
  );

CREATE FUNCTION public.proofstack_reject_append_only_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '55000',
    MESSAGE = format('ProofStack append-only records in %s cannot be changed', TG_TABLE_NAME);
END;
$$;

REVOKE ALL ON FUNCTION public.proofstack_reject_append_only_mutation() FROM PUBLIC;

CREATE TRIGGER proofstack_consumer_receipt_append_only
  BEFORE UPDATE OR DELETE ON public.proofstack_consumer_receipts
  FOR EACH ROW
  EXECUTE FUNCTION public.proofstack_reject_append_only_mutation();
