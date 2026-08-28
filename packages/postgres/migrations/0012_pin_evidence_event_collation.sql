DROP INDEX public.proofstack_evidence_trace_order_idx;

CREATE INDEX proofstack_evidence_trace_order_idx
  ON public.proofstack_evidence_events (
    tenant_id,
    project_id,
    environment_id,
    trace_id,
    started_at,
    sequence,
    event_id COLLATE "C"
  );
