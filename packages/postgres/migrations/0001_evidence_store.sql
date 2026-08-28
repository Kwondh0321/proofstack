CREATE TABLE public.proofstack_evidence_events (
  tenant_id varchar(64) NOT NULL,
  project_id varchar(64) NOT NULL,
  environment_id varchar(64) NOT NULL,
  event_id varchar(64) NOT NULL,
  trace_id character(32) NOT NULL,
  span_id character(16) NOT NULL,
  parent_span_id character(16),
  started_at timestamptz NOT NULL,
  sequence bigint NOT NULL DEFAULT 0,
  received_at timestamptz NOT NULL,
  schema_version varchar(16) NOT NULL,
  evidence jsonb NOT NULL,

  CONSTRAINT proofstack_evidence_events_pk PRIMARY KEY (tenant_id, event_id),
  CONSTRAINT proofstack_evidence_tenant_id_format CHECK (
    tenant_id ~ '^[a-z][a-z0-9_]{2,63}$'
  ),
  CONSTRAINT proofstack_evidence_project_id_format CHECK (
    project_id ~ '^[a-z][a-z0-9_]{2,63}$'
  ),
  CONSTRAINT proofstack_evidence_environment_id_format CHECK (
    environment_id ~ '^[a-z][a-z0-9_]{2,63}$'
  ),
  CONSTRAINT proofstack_evidence_event_id_format CHECK (
    event_id ~ '^[a-z][a-z0-9_]{2,63}$'
  ),
  CONSTRAINT proofstack_evidence_trace_id_format CHECK (
    trace_id ~ '^(?!0{32}$)[0-9a-f]{32}$'
  ),
  CONSTRAINT proofstack_evidence_span_id_format CHECK (
    span_id ~ '^(?!0{16}$)[0-9a-f]{16}$'
  ),
  CONSTRAINT proofstack_evidence_parent_span_id_format CHECK (
    parent_span_id IS NULL OR parent_span_id ~ '^(?!0{16}$)[0-9a-f]{16}$'
  ),
  CONSTRAINT proofstack_evidence_parent_is_distinct CHECK (
    parent_span_id IS NULL OR parent_span_id <> span_id
  ),
  CONSTRAINT proofstack_evidence_sequence_range CHECK (
    sequence BETWEEN 0 AND 9007199254740991
  ),
  CONSTRAINT proofstack_evidence_schema_version_format CHECK (
    schema_version ~ '^[0-9]+\.[0-9]+$'
  ),
  CONSTRAINT proofstack_evidence_payload_object CHECK (
    jsonb_typeof(evidence) = 'object'
  ),
  CONSTRAINT proofstack_evidence_event_id_matches CHECK (
    (
      jsonb_typeof(evidence -> 'eventId') = 'string'
      AND evidence ->> 'eventId' = event_id
    ) IS TRUE
  ),
  CONSTRAINT proofstack_evidence_trace_id_matches CHECK (
    (
      jsonb_typeof(evidence -> 'traceId') = 'string'
      AND evidence ->> 'traceId' = trace_id
    ) IS TRUE
  ),
  CONSTRAINT proofstack_evidence_span_id_matches CHECK (
    (
      jsonb_typeof(evidence -> 'spanId') = 'string'
      AND evidence ->> 'spanId' = span_id
    ) IS TRUE
  ),
  CONSTRAINT proofstack_evidence_parent_span_id_matches CHECK (
    (
      (parent_span_id IS NULL AND NOT (evidence ? 'parentSpanId'))
      OR (
        parent_span_id IS NOT NULL
        AND jsonb_typeof(evidence -> 'parentSpanId') = 'string'
        AND evidence ->> 'parentSpanId' = parent_span_id
      )
    ) IS TRUE
  ),
  CONSTRAINT proofstack_evidence_started_at_matches CHECK (
    (
      jsonb_typeof(evidence -> 'startedAt') = 'string'
      AND (evidence ->> 'startedAt')::timestamptz = started_at
    ) IS TRUE
  ),
  CONSTRAINT proofstack_evidence_sequence_matches CHECK (
    (
      (NOT (evidence ? 'sequence') AND sequence = 0)
      OR (
        jsonb_typeof(evidence -> 'sequence') = 'number'
        AND (evidence ->> 'sequence')::bigint = sequence
      )
    ) IS TRUE
  )
);

CREATE INDEX proofstack_evidence_trace_order_idx
  ON public.proofstack_evidence_events (
    tenant_id,
    project_id,
    environment_id,
    trace_id,
    started_at,
    sequence,
    event_id
  );

ALTER TABLE public.proofstack_evidence_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.proofstack_evidence_events FORCE ROW LEVEL SECURITY;

CREATE POLICY proofstack_evidence_tenant_select
  ON public.proofstack_evidence_events
  FOR SELECT
  USING (
    tenant_id = NULLIF(current_setting('proofstack.tenant_id', true), '')
  );

CREATE POLICY proofstack_evidence_tenant_insert
  ON public.proofstack_evidence_events
  FOR INSERT
  WITH CHECK (
    tenant_id = NULLIF(current_setting('proofstack.tenant_id', true), '')
  );

CREATE FUNCTION public.proofstack_reject_evidence_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '55000',
    MESSAGE = 'ProofStack evidence is append-only';
END;
$$;

REVOKE ALL ON FUNCTION public.proofstack_reject_evidence_mutation() FROM PUBLIC;

CREATE TRIGGER proofstack_evidence_append_only
  BEFORE UPDATE OR DELETE ON public.proofstack_evidence_events
  FOR EACH ROW
  EXECUTE FUNCTION public.proofstack_reject_evidence_mutation();
