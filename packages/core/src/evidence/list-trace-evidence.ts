import {
  DEFAULT_TRACE_PAGE_SIZE,
  type EvidenceEnvelope,
  MAX_TRACE_PAGE_SIZE,
  type PrincipalContext,
} from "@proofstack/contracts";
import { requireCapability, requireEnvironmentAccess } from "../auth/authorization.js";
import { InvalidTraceCursorError, TraceNotFoundError } from "../errors.js";
import type { EvidencePageCursor, EvidenceRepository } from "./evidence-repository.js";

export interface ListTraceEvidenceQuery {
  readonly after?: EvidencePageCursor;
  readonly environmentId: string;
  readonly limit?: number;
  readonly principal: PrincipalContext;
  readonly projectId: string;
  readonly traceId: string;
}

export interface ListTraceEvidenceResult {
  readonly events: readonly EvidenceEnvelope[];
  readonly hasMore: boolean;
}

export class ListTraceEvidence {
  constructor(private readonly repository: EvidenceRepository) {}

  async execute(query: ListTraceEvidenceQuery): Promise<ListTraceEvidenceResult> {
    requireCapability(query.principal, "evidence:read");
    requireEnvironmentAccess(query.principal, query.projectId, query.environmentId);

    const limit = query.limit ?? DEFAULT_TRACE_PAGE_SIZE;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_TRACE_PAGE_SIZE) {
      throw new RangeError(`Trace page limit must be between 1 and ${MAX_TRACE_PAGE_SIZE}`);
    }

    const page = await this.repository.listByTrace(
      {
        environmentId: query.environmentId,
        projectId: query.projectId,
        tenantId: query.principal.tenantId,
      },
      query.traceId,
      { limit, ...(query.after ? { after: query.after } : {}) },
    );
    if (!page.cursorFound) throw new InvalidTraceCursorError();
    if (page.events.length === 0) throw new TraceNotFoundError(query.traceId);
    return { events: page.events, hasMore: page.hasMore };
  }
}
