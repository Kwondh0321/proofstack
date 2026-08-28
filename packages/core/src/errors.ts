export class ForbiddenError extends Error {
  readonly code = "forbidden";

  constructor(message = "The principal is not allowed to perform this operation") {
    super(message);
    this.name = "ForbiddenError";
  }
}

export class EvidenceConflictError extends Error {
  readonly code = "evidence_conflict";

  constructor(readonly eventId: string) {
    super(`Event ${eventId} was already ingested with different evidence`);
    this.name = "EvidenceConflictError";
  }
}

export class TraceNotFoundError extends Error {
  readonly code = "trace_not_found";

  constructor(readonly traceId: string) {
    super(`Trace ${traceId} was not found`);
    this.name = "TraceNotFoundError";
  }
}
