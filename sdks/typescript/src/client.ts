import {
  type EvidenceRecord,
  type EvidenceRecordInput,
  EvidenceRecordSchema,
  type EvidenceSource,
} from "@proofstack/contracts";
import { createEventId, createSpanId, createTraceId } from "./ids.js";
import { type EvidenceTransport, HttpEvidenceTransport } from "./transport.js";

const SDK_NAME = "@proofstack/sdk";
const SDK_VERSION = "0.0.0";

export interface ProofStackClientOptions {
  readonly apiKey?: string;
  readonly endpoint: string | URL;
  readonly environmentId: string;
  readonly failOpen?: boolean;
  readonly fetch?: typeof globalThis.fetch;
  readonly flushIntervalMs?: number;
  readonly maxBatchSize?: number;
  readonly maxQueueSize?: number;
  readonly onError?: (error: Error) => void;
  readonly projectId: string;
  readonly source: Omit<EvidenceSource, "sdkName" | "sdkVersion">;
  readonly timeoutMs?: number;
  readonly transport?: EvidenceTransport;
}

export type EmitEvidenceInput = Omit<
  EvidenceRecordInput,
  "eventId" | "source" | "spanId" | "startedAt" | "traceId"
> & {
  readonly eventId?: string;
  readonly spanId?: string;
  readonly startedAt?: string;
  readonly traceId?: string;
};

export interface FlushResult {
  readonly pendingCount: number;
  readonly sentCount: number;
  readonly success: boolean;
}

export class QueueCapacityError extends Error {
  constructor(readonly maxQueueSize: number) {
    super(`ProofStack telemetry queue reached its ${maxQueueSize} event limit`);
    this.name = "QueueCapacityError";
  }
}

export class ClientClosedError extends Error {
  constructor() {
    super("ProofStack client is closed and cannot accept new evidence");
    this.name = "ClientClosedError";
  }
}

export class ProofStackClient {
  private readonly failOpen: boolean;
  private readonly maxBatchSize: number;
  private readonly maxQueueSize: number;
  private readonly onError: (error: Error) => void;
  private readonly queue: EvidenceRecord[] = [];
  private readonly source: EvidenceSource;
  private readonly transport: EvidenceTransport;
  private acceptingEvents = true;
  private closeInFlight: Promise<FlushResult> | undefined;
  private closed = false;
  private inFlightEventCount = 0;
  private flushInFlight: Promise<FlushResult> | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(options: ProofStackClientOptions) {
    this.maxBatchSize = positiveInteger(options.maxBatchSize ?? 50, "maxBatchSize");
    this.maxQueueSize = positiveInteger(options.maxQueueSize ?? 1_000, "maxQueueSize");
    if (this.maxBatchSize > this.maxQueueSize) {
      throw new RangeError("maxBatchSize cannot exceed maxQueueSize");
    }

    this.failOpen = options.failOpen ?? true;
    this.onError = options.onError ?? (() => undefined);
    this.source = {
      ...options.source,
      sdkName: SDK_NAME,
      sdkVersion: SDK_VERSION,
    };
    this.transport =
      options.transport ??
      new HttpEvidenceTransport({
        endpoint: options.endpoint,
        environmentId: options.environmentId,
        projectId: options.projectId,
        ...(options.apiKey ? { apiKey: options.apiKey } : {}),
        ...(options.fetch ? { fetch: options.fetch } : {}),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      });

    const flushIntervalMs = nonnegativeInteger(options.flushIntervalMs ?? 1_000, "flushIntervalMs");
    if (flushIntervalMs > 0) {
      this.timer = setInterval(() => {
        void this.flush().catch((error: unknown) => this.reportError(asError(error)));
      }, flushIntervalMs);
      unrefTimer(this.timer);
    }
  }

  emit(input: EmitEvidenceInput): EvidenceRecord {
    if (!this.acceptingEvents) {
      const error = new ClientClosedError();
      this.reportError(error);
      if (!this.failOpen) throw error;
      return this.createRecord(input);
    }

    if (this.pendingCount() >= this.maxQueueSize) {
      const error = new QueueCapacityError(this.maxQueueSize);
      this.reportError(error);
      if (!this.failOpen) throw error;
      return this.createRecord(input);
    }

    const record = this.createRecord(input);
    this.queue.push(record);

    if (this.queue.length >= this.maxBatchSize) {
      void this.flush().catch((error: unknown) => this.reportError(asError(error)));
    }

    return record;
  }

  async flush(): Promise<FlushResult> {
    if (this.flushInFlight) return this.flushInFlight;
    if (this.queue.length === 0) return { pendingCount: 0, sentCount: 0, success: true };

    this.flushInFlight = this.flushOneBatch();
    try {
      return await this.flushInFlight;
    } finally {
      this.flushInFlight = undefined;
    }
  }

  async close(): Promise<FlushResult> {
    this.acceptingEvents = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;

    if (this.closed) return { pendingCount: 0, sentCount: 0, success: true };
    if (this.closeInFlight) return this.closeInFlight;

    this.closeInFlight = this.drain();
    try {
      const result = await this.closeInFlight;
      if (result.success && result.pendingCount === 0) this.closed = true;
      return result;
    } finally {
      this.closeInFlight = undefined;
    }
  }

  private async drain(): Promise<FlushResult> {
    let sentCount = 0;
    if (this.flushInFlight) {
      const inFlightResult = await this.flushInFlight;
      sentCount += inFlightResult.sentCount;
      if (!inFlightResult.success) return { ...inFlightResult, sentCount };
    }

    while (this.queue.length > 0) {
      const result = await this.flush();
      sentCount += result.sentCount;
      if (!result.success) return { ...result, sentCount };
    }

    return { pendingCount: 0, sentCount, success: true };
  }

  pendingCount(): number {
    return this.queue.length + this.inFlightEventCount;
  }

  private createRecord(input: EmitEvidenceInput): EvidenceRecord {
    return EvidenceRecordSchema.parse({
      ...input,
      eventId: input.eventId ?? createEventId(),
      source: this.source,
      spanId: input.spanId ?? createSpanId(),
      startedAt: input.startedAt ?? new Date().toISOString(),
      traceId: input.traceId ?? createTraceId(),
    });
  }

  private async flushOneBatch(): Promise<FlushResult> {
    const batch = this.queue.splice(0, this.maxBatchSize);
    this.inFlightEventCount = batch.length;
    try {
      await this.transport.send(batch);
      this.inFlightEventCount = 0;
      return { pendingCount: this.queue.length, sentCount: batch.length, success: true };
    } catch (cause) {
      this.queue.unshift(...batch);
      this.inFlightEventCount = 0;
      const error =
        cause instanceof Error ? cause : new Error("Unknown ProofStack transport failure");
      this.reportError(error);
      if (!this.failOpen) throw error;
      return { pendingCount: this.queue.length, sentCount: 0, success: false };
    }
  }

  private reportError(error: Error): void {
    try {
      this.onError(error);
    } catch {
      // Error reporting must never break the observed application.
    }
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error("Unknown ProofStack SDK failure");
}

function unrefTimer(timer: ReturnType<typeof setInterval>): void {
  const unref = (timer as unknown as { unref?: () => void }).unref;
  unref?.call(timer);
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0)
    throw new RangeError(`${name} must be a positive integer`);
  return value;
}

function nonnegativeInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer`);
  }
  return value;
}
