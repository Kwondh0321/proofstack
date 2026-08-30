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

export interface ValidatedReplayJobMutationResult {
  readonly created: boolean;
  readonly snapshot: PublicReplayJobSnapshot;
}

export function validatedReplayJobMutationResult(
  input: unknown,
  scope: EvidenceScope,
  jobId: string,
): ValidatedReplayJobMutationResult {
  if (typeof input !== "object" || input === null) {
    throw new ReplayRepositoryContractError(
      "Replay job mutation result violates the repository contract",
    );
  }
  let keys: readonly PropertyKey[];
  let created: unknown;
  let snapshot: unknown;
  try {
    keys = Reflect.ownKeys(input);
    created = Reflect.get(input, "created");
    snapshot = Reflect.get(input, "snapshot");
  } catch (cause) {
    throw new ReplayRepositoryContractError(
      "Replay job mutation result violates the repository contract",
      { cause },
    );
  }
  if (
    keys.length !== 2 ||
    !keys.includes("created") ||
    !keys.includes("snapshot") ||
    typeof created !== "boolean"
  ) {
    throw new ReplayRepositoryContractError(
      "Replay job mutation result violates the repository contract",
    );
  }
  return { created, snapshot: validatedReplayJobSnapshot(snapshot, scope, jobId) };
}
