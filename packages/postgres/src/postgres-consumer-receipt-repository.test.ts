import { ConsumerReceiptConflictError } from "@proofstack/core";
import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import {
  MAX_CONSUMER_RECEIPT_ERROR_LENGTH,
  MAX_CONSUMER_RECEIPT_LEASE_DURATION_MS,
  MAX_CONSUMER_RECEIPT_RETRY_DELAY_MS,
  PostgresConsumerReceiptRepository,
} from "./postgres-consumer-receipt-repository.js";
import { PostgresDataIntegrityError } from "./postgres-evidence-repository.js";

type QueryHandler = (
  text: string,
  values: readonly unknown[] | undefined,
) => { readonly rows: readonly Record<string, unknown>[] };

class FakeClient {
  readonly queries: Array<{ readonly text: string; readonly values?: readonly unknown[] }> = [];

  constructor(private readonly handler: QueryHandler) {}

  async query(text: string, values?: readonly unknown[]) {
    this.queries.push({ text, ...(values ? { values } : {}) });
    return this.handler(text, values);
  }

  release(): void {}
}

function poolWith(client: FakeClient, connections: { count: number }): Pick<Pool, "connect"> {
  return {
    connect: async () => {
      connections.count += 1;
      return client;
    },
  } as unknown as Pick<Pool, "connect">;
}

const leaseToken = "20000000-0000-4000-8000-000000000001";
const payloadSha256 = "a".repeat(64);

function processingRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    attempt_count: 1,
    available_at: "2026-08-28T03:00:00.000Z",
    available_due: true,
    completed_at: null,
    consumer_name: "trace.projector",
    created_at: "2026-08-28T03:00:00.000Z",
    last_error: null,
    lease_current: true,
    lease_expires_at: "2026-08-28T03:01:00.000Z",
    lease_owner: "wrk_primary",
    lease_token: leaseToken,
    message_id: "message-001",
    payload_sha256: payloadSha256,
    state: "processing",
    tenant_id: "ten_local",
    ...overrides,
  };
}

function availableRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return processingRow({
    available_due: false,
    last_error: "handler failed",
    lease_current: null,
    lease_expires_at: null,
    lease_owner: null,
    lease_token: null,
    state: "available",
    ...overrides,
  });
}

function completedRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return processingRow({
    completed_at: "2026-08-28T03:02:00.000Z",
    lease_current: null,
    lease_expires_at: null,
    lease_owner: null,
    lease_token: null,
    state: "completed",
    ...overrides,
  });
}

function harness(
  handler: QueryHandler,
  token: () => string = () => leaseToken,
): {
  readonly client: FakeClient;
  readonly connections: { count: number };
  readonly repository: PostgresConsumerReceiptRepository;
} {
  const connections = { count: 0 };
  const client = new FakeClient((text, values) => {
    if (
      text === "BEGIN" ||
      text === "COMMIT" ||
      text === "ROLLBACK" ||
      text.includes("set_config")
    ) {
      return { rows: [] };
    }
    return handler(text, values);
  });
  return {
    client,
    connections,
    repository: new PostgresConsumerReceiptRepository(poolWith(client, connections), token),
  };
}

const key = { consumerName: "trace.projector", messageId: "message-001" };
const claimOptions = {
  ...key,
  leaseDurationMs: 60_000,
  payloadSha256,
  workerId: "wrk_primary",
};

describe("PostgresConsumerReceiptRepository.get", () => {
  it("returns a tenant-scoped receipt", async () => {
    const testHarness = harness((text) => ({
      rows: text.includes("proofstack_consumer_receipts") ? [processingRow()] : [],
    }));

    await expect(testHarness.repository.get("ten_local", key)).resolves.toEqual({
      attemptCount: 1,
      availableAt: "2026-08-28T03:00:00.000Z",
      completedAt: null,
      consumerName: "trace.projector",
      createdAt: "2026-08-28T03:00:00.000Z",
      lastError: null,
      lease: {
        expiresAt: "2026-08-28T03:01:00.000Z",
        owner: "wrk_primary",
        token: leaseToken,
      },
      messageId: "message-001",
      payloadSha256,
      state: "processing",
      tenantId: "ten_local",
    });
    const query = testHarness.client.queries.find(({ text }) =>
      text.includes("proofstack_consumer_receipts"),
    );
    expect(query?.values).toEqual(["ten_local", "trace.projector", "message-001"]);
  });

  it("returns null for an unknown receipt", async () => {
    const testHarness = harness(() => ({ rows: [] }));

    await expect(testHarness.repository.get("ten_local", key)).resolves.toBeNull();
  });

  it.each([
    ["tenant", { tenant_id: "ten_other" }],
    ["consumer", { consumer_name: "policy.projector" }],
    ["message", { message_id: "message-002" }],
    ["payload digest", { payload_sha256: "invalid" }],
    ["attempt count", { attempt_count: 0 }],
    ["creation time", { created_at: "now" }],
    ["availability time", { available_at: "later" }],
    ["availability flag", { available_due: null }],
    ["error summary", { last_error: "x".repeat(MAX_CONSUMER_RECEIPT_ERROR_LENGTH + 1) }],
    ["partial lease", { lease_owner: null }],
    ["lease token", { lease_token: "invalid" }],
    ["lease owner", { lease_owner: "INVALID" }],
    ["lease expiry", { lease_expires_at: "later" }],
    ["available shape", { state: "available" }],
    ["processing shape", { completed_at: "2026-08-28T03:02:00.000Z" }],
    ["completed shape", { state: "completed" }],
    ["state", { state: "unknown" }],
  ])("fails closed for an invalid stored %s", async (_label, overrides) => {
    const testHarness = harness((text) => ({
      rows: text.includes("proofstack_consumer_receipts") ? [processingRow(overrides)] : [],
    }));

    await expect(testHarness.repository.get("ten_local", key)).rejects.toBeInstanceOf(
      PostgresDataIntegrityError,
    );
  });
});

describe("PostgresConsumerReceiptRepository.claim", () => {
  it("inserts and acquires a new processing receipt", async () => {
    const testHarness = harness((text) => {
      if (text.includes("FOR UPDATE")) return { rows: [] };
      if (text.includes("INSERT INTO")) return { rows: [processingRow()] };
      return { rows: [] };
    });

    await expect(testHarness.repository.claim("ten_local", claimOptions)).resolves.toMatchObject({
      receipt: { attemptCount: 1, lease: { token: leaseToken }, state: "processing" },
      status: "acquired",
    });
    const insert = testHarness.client.queries.find(({ text }) => text.includes("INSERT INTO"));
    expect(insert?.values).toEqual([
      "ten_local",
      "trace.projector",
      "message-001",
      payloadSha256,
      leaseToken,
      "wrk_primary",
      60_000,
    ]);
  });

  it("reports an unexpired concurrent claim as busy", async () => {
    let lockCount = 0;
    const testHarness = harness((text) => {
      if (text.includes("FOR UPDATE")) {
        lockCount += 1;
        return { rows: lockCount === 1 ? [] : [processingRow()] };
      }
      return { rows: [] };
    });

    await expect(testHarness.repository.claim("ten_local", claimOptions)).resolves.toMatchObject({
      receipt: { state: "processing" },
      status: "busy",
    });
  });

  it("reports a completed matching receipt without reclaiming it", async () => {
    const testHarness = harness((text) => ({
      rows: text.includes("FOR UPDATE") ? [completedRow()] : [],
    }));

    await expect(testHarness.repository.claim("ten_local", claimOptions)).resolves.toMatchObject({
      receipt: { state: "completed" },
      status: "completed",
    });
  });

  it("reports a receipt still in backoff as deferred", async () => {
    const testHarness = harness((text) => ({
      rows: text.includes("FOR UPDATE") ? [availableRow()] : [],
    }));

    await expect(testHarness.repository.claim("ten_local", claimOptions)).resolves.toMatchObject({
      receipt: { state: "available" },
      status: "deferred",
    });
  });

  it.each([
    ["available receipt", availableRow({ available_due: true })],
    ["expired receipt", processingRow({ lease_current: false })],
  ])("reclaims an eligible %s", async (_label, current) => {
    const testHarness = harness((text) => {
      if (text.includes("FOR UPDATE")) return { rows: [current] };
      if (text.includes("SET state = 'processing'")) {
        return { rows: [processingRow({ attempt_count: 2 })] };
      }
      return { rows: [] };
    });

    await expect(testHarness.repository.claim("ten_local", claimOptions)).resolves.toMatchObject({
      receipt: { attemptCount: 2, state: "processing" },
      status: "acquired",
    });
    const update = testHarness.client.queries.find(({ text }) =>
      text.includes("SET state = 'processing'"),
    );
    expect(update?.values).toEqual([
      "ten_local",
      "trace.projector",
      "message-001",
      leaseToken,
      "wrk_primary",
      60_000,
    ]);
  });

  it("rejects a message identifier reused for another payload", async () => {
    const testHarness = harness((text) => ({
      rows: text.includes("FOR UPDATE") ? [completedRow()] : [],
    }));

    await expect(
      testHarness.repository.claim("ten_local", {
        ...claimOptions,
        payloadSha256: "b".repeat(64),
      }),
    ).rejects.toBeInstanceOf(ConsumerReceiptConflictError);
  });

  it("fails closed when a receipt disappears after an insert conflict", async () => {
    const testHarness = harness(() => ({ rows: [] }));

    await expect(testHarness.repository.claim("ten_local", claimOptions)).rejects.toThrow(
      "disappeared",
    );
  });

  it("fails closed when an eligible locked receipt cannot be reclaimed", async () => {
    const testHarness = harness((text) => ({
      rows: text.includes("FOR UPDATE") ? [processingRow({ lease_current: false })] : [],
    }));

    await expect(testHarness.repository.claim("ten_local", claimOptions)).rejects.toThrow(
      "could not be reclaimed",
    );
  });
});

describe("PostgresConsumerReceiptRepository completion", () => {
  it.each([true, false])(
    "returns whether completion changed the current lease",
    async (changed) => {
      const testHarness = harness((text) => ({
        rows: text.includes("SET state = 'completed'") && changed ? [{ changed: true }] : [],
      }));

      await expect(
        testHarness.repository.complete("ten_local", { ...key, leaseToken }),
      ).resolves.toBe(changed);
      const update = testHarness.client.queries.find(({ text }) =>
        text.includes("SET state = 'completed'"),
      );
      expect(update?.values).toEqual(["ten_local", "trace.projector", "message-001", leaseToken]);
    },
  );

  it.each([true, false])("returns whether release changed the current lease", async (changed) => {
    const testHarness = harness((text) => ({
      rows: text.includes("SET state = 'available'") && changed ? [{ changed: true }] : [],
    }));

    await expect(
      testHarness.repository.release("ten_local", {
        ...key,
        error: "handler failed",
        leaseToken,
        retryDelayMs: 1_000,
      }),
    ).resolves.toBe(changed);
    const update = testHarness.client.queries.find(({ text }) =>
      text.includes("SET state = 'available'"),
    );
    expect(update?.values).toEqual([
      "ten_local",
      "trace.projector",
      "message-001",
      leaseToken,
      1_000,
      "handler failed",
    ]);
  });
});

describe("PostgresConsumerReceiptRepository input validation", () => {
  it.each([
    ["tenant", "INVALID", key],
    ["consumer", "ten_local", { ...key, consumerName: "INVALID" }],
    ["empty message", "ten_local", { ...key, messageId: "" }],
    ["long message", "ten_local", { ...key, messageId: "x".repeat(129) }],
  ])("rejects an invalid get %s before connecting", async (_label, tenantId, invalidKey) => {
    const testHarness = harness(() => ({ rows: [] }));

    await expect(testHarness.repository.get(tenantId, invalidKey)).rejects.toThrow();
    expect(testHarness.connections.count).toBe(0);
  });

  it.each([
    ["payload digest", { ...claimOptions, payloadSha256: "invalid" }],
    ["worker", { ...claimOptions, workerId: "INVALID" }],
    ["lease minimum", { ...claimOptions, leaseDurationMs: 0 }],
    [
      "lease maximum",
      { ...claimOptions, leaseDurationMs: MAX_CONSUMER_RECEIPT_LEASE_DURATION_MS + 1 },
    ],
    ["integer lease", { ...claimOptions, leaseDurationMs: 1.5 }],
  ])("rejects an invalid claim %s before connecting", async (_label, options) => {
    const testHarness = harness(() => ({ rows: [] }));

    await expect(testHarness.repository.claim("ten_local", options)).rejects.toThrow();
    expect(testHarness.connections.count).toBe(0);
  });

  it("rejects an invalid generated token before connecting", async () => {
    const testHarness = harness(
      () => ({ rows: [] }),
      () => "invalid",
    );

    await expect(testHarness.repository.claim("ten_local", claimOptions)).rejects.toThrow(
      "leaseToken",
    );
    expect(testHarness.connections.count).toBe(0);
  });

  it("supports the secure default token generator", async () => {
    const connections = { count: 0 };
    const client = new FakeClient((text, values) => {
      if (text.includes("INSERT INTO")) {
        expect(values?.[4]).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
        );
        return { rows: [processingRow({ lease_token: values?.[4] })] };
      }
      return { rows: [] };
    });
    const repository = new PostgresConsumerReceiptRepository(poolWith(client, connections));

    await expect(repository.claim("ten_local", claimOptions)).resolves.toMatchObject({
      status: "acquired",
    });
  });

  it.each([
    ["completion token", () => ({ ...key, leaseToken: "invalid" })],
    ["release delay minimum", () => ({ ...key, error: "failure", leaseToken, retryDelayMs: -1 })],
    [
      "release delay maximum",
      () => ({
        ...key,
        error: "failure",
        leaseToken,
        retryDelayMs: MAX_CONSUMER_RECEIPT_RETRY_DELAY_MS + 1,
      }),
    ],
    ["release delay integer", () => ({ ...key, error: "failure", leaseToken, retryDelayMs: 1.5 })],
    ["empty release error", () => ({ ...key, error: "", leaseToken, retryDelayMs: 0 })],
    [
      "long release error",
      () => ({
        ...key,
        error: "x".repeat(MAX_CONSUMER_RECEIPT_ERROR_LENGTH + 1),
        leaseToken,
        retryDelayMs: 0,
      }),
    ],
  ])("rejects an invalid %s before connecting", async (label, options) => {
    const testHarness = harness(() => ({ rows: [] }));
    const value = options();

    if (label === "completion token") {
      await expect(testHarness.repository.complete("ten_local", value)).rejects.toThrow();
    } else {
      await expect(testHarness.repository.release("ten_local", value as never)).rejects.toThrow();
    }
    expect(testHarness.connections.count).toBe(0);
  });
});
