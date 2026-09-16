import type { ReplayJobSnapshot, ReplayPlan, TargetRelease } from "@proofstack/contracts";
import {
  type PolicyEvaluationDefinitionReadInput,
  PolicyEvaluationEvidenceReferenceError,
  type PolicyEvaluationEvidenceReferenceLimits,
  PolicyEvaluationReferenceCollector,
  revalidatePolicyEvaluationCapturedRecord,
} from "@proofstack/core";
import {
  inspectPolicyEvaluationReplayDefinition,
  type PolicyEvaluationReplayDefinitionRead,
  type PolicyEvaluationReplayDefinitionSource,
} from "./policy-evaluation-replay-definition-reader.js";
import {
  inspectPolicyEvaluationReplayResult,
  type PolicyEvaluationReplayResultRead,
  type PolicyEvaluationReplayResultReadInput,
  type PolicyEvaluationReplayResultSource,
} from "./policy-evaluation-replay-result-reader.js";

function planReferences(record: ReplayPlan, out: PolicyEvaluationReferenceCollector): void {
  record.boundaries.forEach((boundary, index) => {
    const path = `/boundaries/${index}`;
    switch (boundary.mode) {
      case "recorded_stub":
        out.record(
          `${path}/invocation/fixture`,
          "regression_fixture_version",
          boundary.invocation.fixture,
        );
        out.replayDeclaration(`${path}/invocation/targetAdapter`, {
          kind: "recorded_adapter",
          reference: boundary.invocation.targetAdapter,
        });
        out.replayDeclaration(`${path}/invocationDefinitionSha256`, {
          kind: "digest",
          reference: boundary.invocationDefinitionSha256,
        });
        break;
      case "simulation":
        out.replayDeclaration(`${path}/configurationSha256`, {
          kind: "digest",
          reference: boundary.configurationSha256,
        });
        out.artifact(`${path}/qualification`, boundary.qualification);
        out.record(`${path}/simulatorRelease`, "target_release", boundary.simulatorRelease);
        break;
      case "live_provider":
        out.replayDeclaration(`${path}/credential`, {
          kind: "credential_selector",
          reference: boundary.credential,
        });
        out.replayDeclaration(`${path}/endpointProfile`, {
          kind: "endpoint_profile",
          reference: boundary.endpointProfile,
        });
        if (boundary.sideEffect.kind === "non_idempotent_write")
          out.artifact(`${path}/sideEffect/riskAcceptance`, boundary.sideEffect.riskAcceptance);
        break;
    }
  });
  out.record("/dataset", "dataset_version", record.dataset);
  out.record("/isolationProfile", "replay_isolation_profile", record.isolationProfile);
  out.record("/runtimeProfile", "replay_runtime_profile", record.runtimeProfile);
  out.record("/targetRelease", "target_release", record.targetRelease);
  out.replayDeclaration("/workerProtocol", {
    kind: "worker_protocol",
    reference: record.workerProtocol,
  });
}

function targetReferences(record: TargetRelease, out: PolicyEvaluationReferenceCollector): void {
  for (const field of ["dependencySnapshotSha256", "executableSha256", "invocationSha256"] as const)
    out.replayDeclaration(`/build/${field}`, { kind: "digest", reference: record.build[field] });
  out.artifact("/build/provenance", record.build.provenance);
  if (record.execution.kind === "artifact")
    out.artifact("/execution/artifact", record.execution.artifact);
  else
    out.replayDeclaration("/execution", {
      kind: "preinstalled_target",
      reference: record.execution,
    });
  if (record.subprocessPolicy.mode === "allowlisted")
    record.subprocessPolicy.allowedImplementations.forEach((reference, index) => {
      out.replayDeclaration(`/subprocessPolicy/allowedImplementations/${index}`, {
        kind: "subprocess_implementation",
        reference,
      });
    });
  out.replayDeclaration("/targetAdapter", {
    kind: "target_adapter",
    reference: record.targetAdapter,
  });
  out.replayDeclaration("/workerProtocol", {
    kind: "worker_protocol",
    reference: record.workerProtocol,
  });
}

function resultReferences(
  record: ReplayJobSnapshot,
  out: PolicyEvaluationReferenceCollector,
): void {
  record.attempts.forEach((attempt, index) => {
    const path = `/attempts/${index}`;
    if (attempt.error?.detailsSha256)
      out.replayDeclaration(`${path}/error/detailsSha256`, {
        kind: "digest",
        reference: attempt.error.detailsSha256,
      });
    const safety = attempt.error?.effectRetrySafety;
    if (safety && safety.kind !== "not_retryable") {
      out.replayDeclaration(`${path}/error/effectRetrySafety/evidenceSha256`, {
        kind: "digest",
        reference: safety.evidenceSha256,
      });
      if (safety.kind === "destination_idempotency_verified")
        out.replayDeclaration(`${path}/error/effectRetrySafety/idempotencyKeySha256`, {
          kind: "digest",
          reference: safety.idempotencyKeySha256,
        });
    }
    out.record(`${path}/isolationProfile`, "replay_isolation_profile", attempt.isolationProfile);
    out.record(`${path}/plan`, "replay_plan", attempt.plan);
    if (attempt.result) out.artifact(`${path}/result`, attempt.result);
    out.record(`${path}/runtimeProfile`, "replay_runtime_profile", attempt.runtimeProfile);
    out.record(`${path}/targetRelease`, "target_release", attempt.targetRelease);
    out.replayDeclaration(`${path}/workerBuildSha256`, {
      kind: "digest",
      reference: attempt.workerBuildSha256,
    });
    out.replayDeclaration(`${path}/workerProtocol`, {
      kind: "worker_protocol",
      reference: attempt.workerProtocol,
    });
  });
  record.budgetLedger.forEach((entry, index) => {
    if (entry.entryType === "reservation" && entry.work.kind === "artifact_emission")
      out.replayDeclaration(`/budgetLedger/${index}/work/artifactId`, {
        kind: "artifact_identity",
        reference: entry.work.artifactId,
      });
  });
  record.executionObservations.forEach((entry, index) => {
    out.replayDeclaration(`/executionObservations/${index}/payload/evidenceSha256`, {
      kind: "digest",
      reference: entry.payload.evidenceSha256,
    });
  });
  out.record("/job/plan", "replay_plan", record.job.plan);
  record.usageObservations.forEach((entry, index) => {
    out.replayDeclaration(`/usageObservations/${index}/sourceEventSha256`, {
      kind: "digest",
      reference: entry.sourceEventSha256,
    });
  });
}

/** Direct occurrence inventory only; no child acquisition, installed authority, or execution. */
export function enumeratePolicyEvaluationReplayDefinitionReferences(
  input: PolicyEvaluationDefinitionReadInput<PolicyEvaluationReplayDefinitionSource>,
  evidence: PolicyEvaluationReplayDefinitionRead,
  limits: PolicyEvaluationEvidenceReferenceLimits,
) {
  const out = new PolicyEvaluationReferenceCollector(limits);
  try {
    const checked = revalidatePolicyEvaluationCapturedRecord<
      PolicyEvaluationDefinitionReadInput<PolicyEvaluationReplayDefinitionSource>,
      ReplayPlan | TargetRelease,
      PolicyEvaluationReplayDefinitionSource
    >(input, evidence, inspectPolicyEvaluationReplayDefinition);
    if ("planVersionId" in checked.record) planReferences(checked.record, out);
    else targetReferences(checked.record, out);
    return {
      ...out.result(),
      recordSha256: checked.observation.recordSha256,
      source: checked.source,
    };
  } catch (cause) {
    if (cause instanceof PolicyEvaluationEvidenceReferenceError) throw cause;
    throw new PolicyEvaluationEvidenceReferenceError("input_invalid", { cause });
  }
}

/** Includes failed attempts and repeated references; declarations are not retained-record proofs. */
export function enumeratePolicyEvaluationReplayResultReferences(
  input: PolicyEvaluationReplayResultReadInput,
  evidence: PolicyEvaluationReplayResultRead,
  limits: PolicyEvaluationEvidenceReferenceLimits,
) {
  const out = new PolicyEvaluationReferenceCollector(limits);
  try {
    const checked = revalidatePolicyEvaluationCapturedRecord<
      PolicyEvaluationReplayResultReadInput,
      ReplayJobSnapshot,
      PolicyEvaluationReplayResultSource
    >(input, evidence, inspectPolicyEvaluationReplayResult);
    resultReferences(checked.record, out);
    return {
      ...out.result(),
      recordSha256: checked.observation.recordSha256,
      source: checked.source,
    };
  } catch (cause) {
    if (cause instanceof PolicyEvaluationEvidenceReferenceError) throw cause;
    throw new PolicyEvaluationEvidenceReferenceError("input_invalid", { cause });
  }
}
