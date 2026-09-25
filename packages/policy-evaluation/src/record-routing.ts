import type { EvidenceScope, PolicyEvaluationSourceReference } from "@proofstack/contracts";
import {
  enumeratePolicyEvaluationControlReferences,
  enumeratePolicyEvaluationEvidenceReferences,
  enumeratePolicyEvaluationRuntimeReferences,
  type PolicyEvaluationControlRead,
  type PolicyEvaluationControlReaderDependencies,
  type PolicyEvaluationEvidenceRead,
  type PolicyEvaluationEvidenceReaderDependencies,
  type PolicyEvaluationEvidenceReference,
  type PolicyEvaluationEvidenceReferenceLimits,
  type PolicyEvaluationRuntimeRead,
  readPolicyEvaluationControlRecord,
  readPolicyEvaluationEvidence,
  readPolicyEvaluationRuntimeRecord,
} from "@proofstack/core";
import {
  enumeratePolicyEvaluationDatasetReferences,
  type PolicyEvaluationDatasetRead,
  readPolicyEvaluationDataset,
} from "@proofstack/datasets";
import {
  enumeratePolicyEvaluationReplayDefinitionReferences,
  enumeratePolicyEvaluationReplayResultReferences,
  type PolicyEvaluationReplayDefinitionRead,
  type PolicyEvaluationReplayResultRead,
  readPolicyEvaluationReplayDefinition,
  readPolicyEvaluationReplayResult,
} from "@proofstack/replay";

export interface PolicyRecordGraphRepositories {
  readonly control: PolicyEvaluationControlReaderDependencies;
  readonly evidence: PolicyEvaluationEvidenceReaderDependencies;
  readonly datasets: Parameters<typeof readPolicyEvaluationDataset>[1];
  readonly replayDefinitions: Parameters<typeof readPolicyEvaluationReplayDefinition>[1];
  readonly replayResults: Parameters<typeof readPolicyEvaluationReplayResult>[1];
  readonly runtimeDefinitions: Parameters<typeof readPolicyEvaluationRuntimeRecord>[1];
}

export type PolicyRecordRead =
  | PolicyEvaluationControlRead
  | PolicyEvaluationEvidenceRead
  | PolicyEvaluationRuntimeRead
  | PolicyEvaluationDatasetRead
  | PolicyEvaluationReplayDefinitionRead
  | PolicyEvaluationReplayResultRead;

export interface PolicyRecordExpansion {
  readonly read: PolicyRecordRead;
  /** Null means unreadable parent, not an empty successful dependency list. */
  readonly references: readonly PolicyEvaluationEvidenceReference[] | null;
}

interface Context {
  readonly evaluationTime: string;
  readonly scope: EvidenceScope;
  readonly source: PolicyEvaluationSourceReference;
}

function finish<R extends PolicyRecordRead>(
  read: R,
  enumerate: (read: R) => {
    readonly references: readonly PolicyEvaluationEvidenceReference[];
  },
): PolicyRecordExpansion {
  return {
    read,
    references: read.observation.status === "verified" ? enumerate(read).references : null,
  };
}

/** Fixed owning readers and validators, never a registry supplied by the evaluation requester. */
export async function readAndExpandPolicyRecord(
  context: Context,
  repositories: PolicyRecordGraphRepositories,
  limits: PolicyEvaluationEvidenceReferenceLimits,
  replayLimits: { readonly maximumRecords: number; readonly maximumRecordBytes: number },
): Promise<PolicyRecordExpansion> {
  const { source, scope, evaluationTime } = context;
  switch (source.kind) {
    case "comparison_definition":
    case "comparison_snapshot":
    case "comparison_result":
    case "release_candidate":
    case "release_policy":
    case "policy_installation_binding": {
      const input = { source, scope, evaluationTime };
      return finish(await readPolicyEvaluationControlRecord(input, repositories.control), (read) =>
        enumeratePolicyEvaluationControlReferences(input, read, limits),
      );
    }
    case "dataset_version":
    case "regression_fixture_version": {
      const input = { source, scope, evaluationTime };
      return finish(await readPolicyEvaluationDataset(input, repositories.datasets), (read) =>
        enumeratePolicyEvaluationDatasetReferences(input, read, limits),
      );
    }
    case "replay_plan":
    case "target_release": {
      const input = { source, scope, evaluationTime };
      return finish(
        await readPolicyEvaluationReplayDefinition(input, repositories.replayDefinitions),
        (read) => enumeratePolicyEvaluationReplayDefinitionReferences(input, read, limits),
      );
    }
    case "replay_result": {
      const input = { source, scope, evaluationTime, limits: replayLimits };
      return finish(
        await readPolicyEvaluationReplayResult(input, repositories.replayResults),
        (read) => enumeratePolicyEvaluationReplayResultReferences(input, read, limits),
      );
    }
    case "replay_runtime_profile":
    case "replay_isolation_profile":
    case "runtime_adapter": {
      const input = { source, scope, evaluationTime };
      return finish(
        await readPolicyEvaluationRuntimeRecord(input, repositories.runtimeDefinitions),
        (read) => enumeratePolicyEvaluationRuntimeReferences(input, read, limits),
      );
    }
    default: {
      // Adding a source kind outside the evidence domain makes this assignment fail typechecking.
      const input = { source, scope, evaluationTime };
      return finish(await readPolicyEvaluationEvidence(input, repositories.evidence), (read) =>
        enumeratePolicyEvaluationEvidenceReferences(input, read, limits),
      );
    }
  }
}
