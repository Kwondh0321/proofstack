import type { EvidenceEnvelope, PrincipalContext } from "@proofstack/contracts";
import { requireCapability, requireEnvironmentAccess } from "../auth/authorization.js";
import { TraceNotFoundError } from "../errors.js";
import type { EvidenceRepository } from "./evidence-repository.js";

export interface ListTraceEvidenceQuery {
  readonly environmentId: string;
  readonly principal: PrincipalContext;
  readonly projectId: string;
  readonly traceId: string;
}

export class ListTraceEvidence {
  constructor(private readonly repository: EvidenceRepository) {}

  async execute(query: ListTraceEvidenceQuery): Promise<readonly EvidenceEnvelope[]> {
    requireCapability(query.principal, "evidence:read");
    requireEnvironmentAccess(query.principal, query.projectId, query.environmentId);

    const events = await this.repository.listByTrace(
      {
        environmentId: query.environmentId,
        projectId: query.projectId,
        tenantId: query.principal.tenantId,
      },
      query.traceId,
    );
    if (events.length === 0) throw new TraceNotFoundError(query.traceId);
    return events;
  }
}
