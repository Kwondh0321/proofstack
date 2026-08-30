import { createHash } from "node:crypto";

export type ReplayTargetOutputStream = "stderr" | "stdout";

export interface ReplayTargetOutputEvidence {
  readonly capturedBytes: number;
  readonly contentSha256: string;
  readonly evidenceSha256: string;
  readonly limitBytes: number;
  readonly observedAtLeastBytes: number;
  readonly stream: ReplayTargetOutputStream;
  readonly truncated: boolean;
}

function digestEvidence(evidence: Omit<ReplayTargetOutputEvidence, "evidenceSha256">): string {
  return createHash("sha256").update(JSON.stringify(evidence), "utf8").digest("hex");
}

export class BoundedReplayTargetOutput {
  private capturedBytes = 0;
  private closed = false;
  private readonly contentHash = createHash("sha256");
  private observedAtLeastBytes = 0;
  private result: ReplayTargetOutputEvidence | undefined;
  private truncated = false;

  constructor(
    private readonly stream: ReplayTargetOutputStream,
    private readonly limitBytes: number,
  ) {
    if (!Number.isSafeInteger(limitBytes) || limitBytes < 0) {
      throw new RangeError("Replay target output limit must be a safe nonnegative integer");
    }
  }

  write(chunk: Uint8Array): boolean {
    if (this.closed) throw new Error("Replay target output recorder is closed");
    if (chunk.byteLength === 0 || this.truncated) return false;
    const remaining = this.limitBytes - this.capturedBytes;
    const accepted = chunk.subarray(0, Math.max(0, remaining));
    if (accepted.byteLength > 0) {
      this.contentHash.update(accepted);
      this.capturedBytes += accepted.byteLength;
    }
    const overflowed = chunk.byteLength > remaining;
    this.observedAtLeastBytes = overflowed ? this.limitBytes + 1 : this.capturedBytes;
    this.truncated = overflowed;
    return overflowed;
  }

  finish(): ReplayTargetOutputEvidence {
    if (this.result) return this.result;
    this.closed = true;
    const evidence = Object.freeze({
      capturedBytes: this.capturedBytes,
      contentSha256: this.contentHash.digest("hex"),
      limitBytes: this.limitBytes,
      observedAtLeastBytes: this.observedAtLeastBytes,
      stream: this.stream,
      truncated: this.truncated,
    });
    this.result = Object.freeze({
      ...evidence,
      evidenceSha256: digestEvidence(evidence),
    });
    return this.result;
  }
}
