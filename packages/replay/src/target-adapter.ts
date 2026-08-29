import type {
  RecordedBoundaryReplayRuntimeEvidence,
  RecordedBoundaryRequest,
  RecordedBoundaryResponse,
  ReplayTargetAdapterReference,
} from "@proofstack/contracts";

export interface RecordedBoundaryReplayContext {
  readonly locale: string;
  readonly timeZone: string;
  now(): string;
  randomBytes(length: number): Uint8Array;
  resolveBoundary(request: RecordedBoundaryRequest): Promise<RecordedBoundaryResponse>;
}

export interface RecordedBoundaryReplayTargetAdapter {
  readonly reference: ReplayTargetAdapterReference;
  run(context: RecordedBoundaryReplayContext): Promise<void> | void;
}

export interface RecordedBoundaryRuntimeControls {
  readonly contextValues: Pick<RecordedBoundaryReplayContext, "locale" | "timeZone">;
  readonly violated: boolean;
  close(): void;
  evidence(): RecordedBoundaryReplayRuntimeEvidence;
  now(): string;
  randomBytes(length: number): Uint8Array;
}
