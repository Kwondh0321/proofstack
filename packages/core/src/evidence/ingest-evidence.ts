import {
  EVIDENCE_SCHEMA_VERSION,
  type EvidenceEnvelope,
  type IngestEvidenceRequest,
  type PrincipalContext,
} from "@proofstack/contracts";
import { requireCapability, requireEnvironmentAccess } from "../auth/authorization.js";
import type { Clock } from "../clock.js";
import type { AppendEvidenceResult, EvidenceRepository } from "./evidence-repository.js";

export interface IngestEvidenceCommand {
  readonly environmentId: string;
  readonly principal: PrincipalContext;
  readonly projectId: string;
  readonly request: IngestEvidenceRequest;
}

export class IngestEvidence {
  constructor(
    private readonly repository: EvidenceRepository,
    private readonly clock: Clock,
  ) {}

  async execute(command: IngestEvidenceCommand): Promise<AppendEvidenceResult> {
    requireCapability(command.principal, "evidence:ingest");
    requireEnvironmentAccess(command.principal, command.projectId, command.environmentId);

    const receivedAt = this.clock.now().toISOString();
    const envelopes: EvidenceEnvelope[] = command.request.events.map((evidence) => ({
      evidence,
      receivedAt,
      schemaVersion: EVIDENCE_SCHEMA_VERSION,
      scope: {
        environmentId: command.environmentId,
        projectId: command.projectId,
        tenantId: command.principal.tenantId,
      },
    }));

    return this.repository.append(envelopes);
  }
}
