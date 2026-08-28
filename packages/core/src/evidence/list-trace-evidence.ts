import type { EvidenceEnvelope, PrincipalContext } from "@proofstack/contracts";
import { requireCapability, requireProjectAccess } from "../auth/authorization.js";
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
    requireProjectAccess(query.principal, query.projectId);

    return this.repository.listByTrace(
      {
        environmentId: query.environmentId,
        projectId: query.projectId,
        tenantId: query.principal.tenantId,
      },
      query.traceId,
    );
  }
}
