import {
  type EvidenceScope,
  type ReplayJobSnapshot as PublicReplayJobSnapshot,
  ReplayJobSnapshotSchema,
} from "@proofstack/contracts";
import { ReplayRepositoryContractError } from "./errors.js";

export function replayJobScopesEqual(left: EvidenceScope, right: EvidenceScope): boolean {
  return (
    left.tenantId === right.tenantId &&
    left.projectId === right.projectId &&
    left.environmentId === right.environmentId
  );
}

export function validatedReplayJobSnapshot(
  input: unknown,
  scope: EvidenceScope,
  jobId: string,
): PublicReplayJobSnapshot {
  let snapshot: PublicReplayJobSnapshot;
  try {
    snapshot = ReplayJobSnapshotSchema.parse(input);
  } catch (cause) {
    throw new ReplayRepositoryContractError(
      "The replay repository returned an invalid job snapshot",
      { cause },
    );
  }
  if (snapshot.job.jobId !== jobId || !replayJobScopesEqual(snapshot.job.scope, scope)) {
    throw new ReplayRepositoryContractError(
      "The replay repository substituted a job outside the exact query",
    );
  }
  return snapshot;
}
