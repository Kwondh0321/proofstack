import { createHmac } from "node:crypto";
import type { RecordedBoundaryReplayRuntimeProfile } from "@proofstack/contracts";
import { RecordedBoundaryRuntimeControlError } from "./errors.js";
import type { RecordedBoundaryRuntimeControls } from "./target-adapter.js";

export const MAX_RANDOM_BYTES_PER_REQUEST = 65_536;
export const MAX_RANDOM_BYTES_PER_INVOCATION = 1_048_576;
export const RECORDED_REPLAY_RANDOM_DOMAIN = "proofstack.replay.random.v1" as const;

class HmacSha256CounterRuntimeControls implements RecordedBoundaryRuntimeControls {
  readonly contextValues: { readonly locale: string; readonly timeZone: string };
  private blockCounter = 0n;
  private closed = false;
  private clockReads = 0;
  private pending: Uint8Array = new Uint8Array(0);
  private randomBytesGenerated = 0;
  private randomRequests = 0;
  private runtimeViolated = false;
  private readonly seed: Uint8Array;

  constructor(private readonly profile: RecordedBoundaryReplayRuntimeProfile) {
    this.contextValues = Object.freeze({
      locale: profile.locale,
      timeZone: profile.timeZone,
    });
    this.seed = Uint8Array.from(Buffer.from(profile.random.seedHex, "hex"));
  }

  get violated(): boolean {
    return this.runtimeViolated;
  }

  close(): void {
    this.closed = true;
  }

  evidence() {
    return {
      fixedClockReadCount: this.clockReads,
      randomByteCount: this.randomBytesGenerated,
      randomRequestCount: this.randomRequests,
    };
  }

  now(): string {
    this.requireOpen();
    this.clockReads += 1;
    return this.profile.clock.instant;
  }

  randomBytes(length: number): Uint8Array {
    this.requireOpen();
    if (!Number.isInteger(length) || length < 1 || length > MAX_RANDOM_BYTES_PER_REQUEST) {
      this.runtimeViolated = true;
      throw new RecordedBoundaryRuntimeControlError("random_request_out_of_range");
    }
    if (this.randomBytesGenerated + length > MAX_RANDOM_BYTES_PER_INVOCATION) {
      this.runtimeViolated = true;
      throw new RecordedBoundaryRuntimeControlError("random_budget_exhausted");
    }

    const output = new Uint8Array(length);
    let offset = 0;
    while (offset < output.byteLength) {
      if (this.pending.byteLength === 0) this.pending = this.nextBlock();
      const count = Math.min(this.pending.byteLength, output.byteLength - offset);
      output.set(this.pending.subarray(0, count), offset);
      this.pending = this.pending.slice(count);
      offset += count;
    }
    this.randomBytesGenerated += length;
    this.randomRequests += 1;
    return output;
  }

  private nextBlock(): Uint8Array {
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(this.blockCounter);
    this.blockCounter += 1n;
    return Uint8Array.from(
      createHmac("sha256", this.seed)
        .update(RECORDED_REPLAY_RANDOM_DOMAIN, "utf8")
        .update(counter)
        .digest(),
    );
  }

  private requireOpen(): void {
    if (this.closed) {
      this.runtimeViolated = true;
      throw new RecordedBoundaryRuntimeControlError("runtime_controls_closed");
    }
  }
}

export function createRecordedBoundaryRuntimeControls(
  profile: RecordedBoundaryReplayRuntimeProfile,
): RecordedBoundaryRuntimeControls {
  return new HmacSha256CounterRuntimeControls(profile);
}
