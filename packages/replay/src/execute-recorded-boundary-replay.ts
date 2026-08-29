import {
  type RecordedBoundaryReplayLimitation,
  type RecordedBoundaryRequest,
  type RecordedBoundaryReplayResult,
  RecordedBoundaryReplayResultSchema,
  type RecordedBoundaryReplayResultStatus,
  type RecordedBoundaryReplayVerifiedControl,
} from "@proofstack/contracts";
import { RecordedBoundaryReplayPreflightError } from "./errors.js";
import { prepareRecordedBoundaryReplay } from "./preflight.js";
import { RecordedBoundaryResolver } from "./recorded-boundary-resolver.js";
import { createRecordedBoundaryRuntimeControls } from "./runtime-controls.js";
import type {
  RecordedBoundaryReplayContext,
  RecordedBoundaryReplayTargetAdapter,
} from "./target-adapter.js";

const BASE_LIMITATIONS: readonly RecordedBoundaryReplayLimitation[] = [
  "target_runtime_not_isolated",
  "ambient_filesystem_not_controlled",
  "process_egress_not_enforced",
  "dependency_snapshot_not_verified",
  "runtime_controls_are_cooperative",
];

const COMPLETED_CONTROLS: readonly RecordedBoundaryReplayVerifiedControl[] = [
  "artifact_bytes_verified",
  "normalized_requests_matched",
  "recorded_attempt_order_consumed",
  "resolver_has_no_live_fallback",
  "runtime_interfaces_supplied",
];

const PARTIAL_CONTROLS: readonly RecordedBoundaryReplayVerifiedControl[] = [
  "artifact_bytes_verified",
  "resolver_has_no_live_fallback",
  "runtime_interfaces_supplied",
];

function targetReference(target: unknown): unknown {
  if (typeof target !== "object" || target === null || !("reference" in target)) return undefined;
  return target.reference;
}

function targetRunner(target: unknown): RecordedBoundaryReplayTargetAdapter["run"] | undefined {
  if (typeof target !== "object" || target === null || !("run" in target)) return undefined;
  return typeof target.run === "function"
    ? (target.run as RecordedBoundaryReplayTargetAdapter["run"])
    : undefined;
}

function terminalLimitation(
  status: Exclude<RecordedBoundaryReplayResultStatus, "completed">,
): RecordedBoundaryReplayLimitation {
  return {
    incomplete: "recorded_attempts_unconsumed",
    mismatch: "boundary_request_mismatch",
    target_failed: "target_adapter_failed",
  }[status] as RecordedBoundaryReplayLimitation;
}

export async function executeRecordedBoundaryReplay(input: {
  readonly contentExport: unknown;
  readonly invocation: unknown;
  readonly target: RecordedBoundaryReplayTargetAdapter;
}): Promise<RecordedBoundaryReplayResult> {
  const run = targetRunner(input.target);
  if (!run) throw new RecordedBoundaryReplayPreflightError("invalid_target_adapter");
  const prepared = prepareRecordedBoundaryReplay({
    contentExport: input.contentExport,
    invocation: input.invocation,
    targetAdapter: targetReference(input.target),
  });
  const resolver = new RecordedBoundaryResolver(prepared);
  const controls = createRecordedBoundaryRuntimeControls(prepared.invocation.runtime);
  const context: RecordedBoundaryReplayContext = Object.freeze({
    ...controls.contextValues,
    now: () => controls.now(),
    randomBytes: (length: number) => controls.randomBytes(length),
    resolveBoundary: (request: RecordedBoundaryRequest) => resolver.resolve(request),
  });

  let targetFailed = false;
  try {
    await run.call(input.target, context);
  } catch {
    targetFailed = true;
  } finally {
    resolver.close();
    controls.close();
  }

  let status: RecordedBoundaryReplayResultStatus;
  if (resolver.hasMismatch) {
    status = "mismatch";
  } else if (targetFailed || resolver.hasContractFailure || controls.violated) {
    status = "target_failed";
  } else if (resolver.consumedAttemptCount !== resolver.expectedAttemptCount) {
    status = "incomplete";
  } else {
    status = "completed";
  }

  const limitations: RecordedBoundaryReplayLimitation[] = [...BASE_LIMITATIONS];
  if (status !== "completed") limitations.push(terminalLimitation(status));
  return RecordedBoundaryReplayResultSchema.parse({
    consumedAttemptCount: resolver.consumedAttemptCount,
    expectedAttemptCount: resolver.expectedAttemptCount,
    invocation: prepared.invocation,
    invocationDefinitionSha256: prepared.invocationDefinitionSha256,
    observations: resolver.observations,
    reproducibility: {
      classification: status === "completed" ? "bounded" : "unknown",
      limitations,
      verifiedControls: status === "completed" ? COMPLETED_CONTROLS : PARTIAL_CONTROLS,
    },
    runtimeEvidence: controls.evidence(),
    schemaVersion: "0.1",
    status,
  });
}
