import type {
  RecordedBoundaryReplayContext,
  RecordedBoundaryReplayTargetAdapter,
} from "@proofstack/replay";

export const PROVIDER_NEUTRAL_RECORDED_TARGET_REFERENCE = {
  name: "proofstack.reference_recorded_agent",
  version: "1.0.0",
} as const;

export interface ProviderNeutralRecordedTargetInput {
  readonly modelNormalizedRequest: Uint8Array;
  readonly toolNormalizedRequest: Uint8Array;
}

function encodedRequest(
  boundaryRequestId: string,
  kind: "model" | "tool",
  adapterName: string,
  bytes: Uint8Array,
) {
  return {
    boundaryRequestId,
    kind,
    normalizedRequest: {
      adapterName,
      adapterVersion: "1.0.0",
      bytes: Buffer.from(bytes).toString("base64url"),
      encoding: "base64url" as const,
    },
    schemaVersion: "0.1" as const,
  };
}

export function createProviderNeutralRecordedTarget(
  input: ProviderNeutralRecordedTargetInput,
): RecordedBoundaryReplayTargetAdapter {
  return {
    reference: PROVIDER_NEUTRAL_RECORDED_TARGET_REFERENCE,
    async run(context: RecordedBoundaryReplayContext): Promise<void> {
      context.now();
      context.randomBytes(16);
      const model = await context.resolveBoundary(
        encodedRequest(
          "brr_reference_model",
          "model",
          "proofstack.reference.model",
          input.modelNormalizedRequest,
        ),
      );
      if (
        model.resolution.recordedAttempt.kind !== "model" ||
        model.resolution.recordedAttempt.attempt.outcome !== "succeeded"
      ) {
        throw new Error("Reference target requires the recorded model attempt to succeed");
      }
      const tool = await context.resolveBoundary(
        encodedRequest(
          "brr_reference_tool",
          "tool",
          "proofstack.reference.tool",
          input.toolNormalizedRequest,
        ),
      );
      if (
        tool.resolution.recordedAttempt.kind !== "tool" ||
        tool.resolution.recordedAttempt.attempt.outcome !== "failed"
      ) {
        throw new Error("Reference target requires the recorded tool attempt to preserve failure");
      }
    },
  };
}
