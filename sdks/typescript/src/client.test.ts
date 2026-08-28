import type { EvidenceRecord } from "@proofstack/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClientClosedError, ProofStackClient, QueueCapacityError } from "./client.js";
import type { EvidenceTransport } from "./transport.js";

class RecordingTransport implements EvidenceTransport {
  readonly batches: EvidenceRecord[][] = [];
  failure: Error | undefined;

  async send(events: readonly EvidenceRecord[]): Promise<void> {
    if (this.failure) throw this.failure;
    this.batches.push([...events]);
  }
}

const clients: ProofStackClient[] = [];

function client(
  transport: EvidenceTransport,
  overrides: Partial<ConstructorParameters<typeof ProofStackClient>[0]> = {},
) {
  const instance = new ProofStackClient({
    endpoint: "http://localhost:4318",
    environmentId: "env_local",
    flushIntervalMs: 0,
    projectId: "prj_local",
    source: { serviceName: "test-agent" },
    transport,
    ...overrides,
  });
  clients.push(instance);
  return instance;
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((instance) => instance.close()));
  vi.useRealTimers();
});

describe("ProofStackClient", () => {
  it("creates a valid metadata-only record with generated identity", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-28T05:00:00.000Z"));
    const transport = new RecordingTransport();
    const instance = client(transport);

    const record = instance.emit({ kind: "agent.run", name: "support-agent" });

    expect(record).toMatchObject({
      attributes: {},
      contentReferences: [],
      eventId: expect.stringMatching(/^evt_[0-9a-f]{32}$/),
      source: {
        sdkName: "@proofstack/sdk",
        sdkVersion: "0.0.0",
        serviceName: "test-agent",
      },
      spanId: expect.stringMatching(/^[0-9a-f]{16}$/),
      startedAt: "2026-08-28T05:00:00.000Z",
      traceId: expect.stringMatching(/^[0-9a-f]{32}$/),
    });
  });

  it("flushes bounded batches without losing order", async () => {
    const transport = new RecordingTransport();
    const instance = client(transport, { maxBatchSize: 2, maxQueueSize: 4 });

    instance.emit({ eventId: "evt_first", kind: "custom", name: "first" });
    instance.emit({ eventId: "evt_second", kind: "custom", name: "second" });
    instance.emit({ eventId: "evt_third", kind: "custom", name: "third" });
    await instance.close();

    expect(transport.batches.map((batch) => batch.map((event) => event.eventId))).toEqual([
      ["evt_first", "evt_second"],
      ["evt_third"],
    ]);
  });

  it("requeues failed batches in fail-open mode", async () => {
    const transport = new RecordingTransport();
    transport.failure = new Error("offline");
    const onError = vi.fn();
    const instance = client(transport, { onError });
    instance.emit({ kind: "custom", name: "offline-event" });

    const result = await instance.flush();

    expect(result).toEqual({ pendingCount: 1, sentCount: 0, success: false });
    expect(instance.pendingCount()).toBe(1);
    expect(onError).toHaveBeenCalledWith(transport.failure);

    transport.failure = undefined;
    await expect(instance.close()).resolves.toMatchObject({ pendingCount: 0, sentCount: 1 });
  });

  it("rejects failed flushes in fail-closed mode", async () => {
    const transport = new RecordingTransport();
    transport.failure = new Error("offline");
    const instance = client(transport, { failOpen: false, onError: () => undefined });
    instance.emit({ kind: "custom", name: "required-event" });

    await expect(instance.flush()).rejects.toThrow("offline");
    expect(instance.pendingCount()).toBe(1);

    transport.failure = undefined;
  });

  it("isolates failures thrown by the error callback", async () => {
    const transport: EvidenceTransport = {
      send: async () => {
        throw "offline";
      },
    };
    const instance = client(transport, {
      onError: () => {
        throw new Error("callback failed");
      },
    });
    instance.emit({ kind: "custom", name: "isolated-error" });

    await expect(instance.flush()).resolves.toEqual({
      pendingCount: 1,
      sentCount: 0,
      success: false,
    });
  });

  it("reports queue pressure without blocking the observed application", () => {
    const transport = new RecordingTransport();
    const onError = vi.fn();
    const instance = client(transport, {
      maxBatchSize: 2,
      maxQueueSize: 2,
      onError,
    });

    instance.emit({ kind: "custom", name: "one" });
    instance.emit({ kind: "custom", name: "two" });
    instance.emit({ kind: "custom", name: "dropped" });

    expect(instance.pendingCount()).toBe(2);
    expect(onError).toHaveBeenCalledWith(expect.any(QueueCapacityError));
  });

  it("throws on queue pressure in fail-closed mode", async () => {
    let release: () => void = () => undefined;
    const transport: EvidenceTransport = {
      send: () =>
        new Promise<void>((resolve) => {
          release = () => resolve();
        }),
    };
    const instance = client(transport, {
      failOpen: false,
      maxBatchSize: 1,
      maxQueueSize: 1,
      onError: () => undefined,
    });

    instance.emit({ kind: "custom", name: "in-flight" });
    expect(() => instance.emit({ kind: "custom", name: "over-capacity" })).toThrow(
      QueueCapacityError,
    );

    release();
    await expect(instance.close()).resolves.toMatchObject({ pendingCount: 0, sentCount: 1 });
  });

  it("flushes on the configured interval", async () => {
    vi.useFakeTimers();
    const transport = new RecordingTransport();
    const instance = client(transport, { flushIntervalMs: 100 });
    instance.emit({ kind: "custom", name: "timer-event" });

    await vi.advanceTimersByTimeAsync(100);

    expect(transport.batches).toHaveLength(1);
    expect(instance.pendingCount()).toBe(0);
  });

  it("returns immediately when there is nothing to flush", async () => {
    const instance = client(new RecordingTransport());

    await expect(instance.flush()).resolves.toEqual({
      pendingCount: 0,
      sentCount: 0,
      success: true,
    });
  });

  it("drops evidence reported after close in fail-open mode", async () => {
    const onError = vi.fn();
    const instance = client(new RecordingTransport(), { onError });
    await instance.close();

    const record = instance.emit({ kind: "custom", name: "too-late" });

    expect(record.name).toBe("too-late");
    expect(instance.pendingCount()).toBe(0);
    expect(onError).toHaveBeenCalledWith(expect.any(ClientClosedError));
  });

  it("rejects evidence reported after close in fail-closed mode", async () => {
    const instance = client(new RecordingTransport(), { failOpen: false });
    await instance.close();

    expect(() => instance.emit({ kind: "custom", name: "too-late" })).toThrow(ClientClosedError);
  });

  it("allows a failed close to retry its pending evidence", async () => {
    const transport = new RecordingTransport();
    transport.failure = new Error("offline");
    const instance = client(transport);
    instance.emit({ kind: "custom", name: "retry-on-close" });

    await expect(instance.close()).resolves.toMatchObject({ pendingCount: 1, success: false });
    transport.failure = undefined;

    await expect(instance.close()).resolves.toMatchObject({ pendingCount: 0, sentCount: 1 });
  });

  it("coalesces concurrent close operations", async () => {
    let release: () => void = () => undefined;
    const send = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const instance = client({ send });
    instance.emit({ kind: "custom", name: "concurrent-close" });

    const first = instance.close();
    const second = instance.close();
    release();

    await expect(Promise.all([first, second])).resolves.toEqual([
      { pendingCount: 0, sentCount: 1, success: true },
      { pendingCount: 0, sentCount: 1, success: true },
    ]);
    expect(send).toHaveBeenCalledOnce();
  });

  it("validates batching options", () => {
    const transport = new RecordingTransport();

    expect(() => client(transport, { maxBatchSize: 0 })).toThrow("positive integer");
    expect(() => client(transport, { maxBatchSize: 2, maxQueueSize: 1 })).toThrow("cannot exceed");
    expect(() => client(transport, { flushIntervalMs: -1 })).toThrow("non-negative integer");
  });
});
