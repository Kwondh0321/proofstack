import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { PostgresDataIntegrityError } from "./postgres-evidence-repository.js";
import {
  MAX_OUTBOX_CLAIM_SIZE,
  MAX_OUTBOX_ERROR_LENGTH,
  MAX_OUTBOX_FAILURE_LIST_SIZE,
  MAX_OUTBOX_LEASE_DURATION_MS,
  MAX_OUTBOX_RETRY_DELAY_MS,
  PostgresOutboxRepository,
} from "./postgres-outbox-repository.js";

type QueryHandler = (
  text: string,
  values: readonly unknown[] | undefined,
) => { readonly rows: readonly Record<string, unknown>[] };

class FakeClient {
  readonly queries: Array<{ readonly text: string; readonly values?: readonly unknown[] }> = [];
  readonly releaseArguments: Array<boolean | undefined> = [];

  constructor(private readonly handler: QueryHandler) {}

  async query(text: string, values?: readonly unknown[]) {
    this.queries.push({ text, ...(values ? { values } : {}) });
    return this.handler(text, values);
  }

  release(argument?: boolean): void {
    this.releaseArguments.push(argument);
  }
}

function poolWith(client: FakeClient, connections: { count: number }): Pick<Pool, "connect"> {
  return {
    connect: async () => {
      connections.count += 1;
      return client;
    },
  } as unknown as Pick<Pool, "connect">;
}

const leaseToken = "11111111-1111-4111-8111-111111111111";

function storedRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    aggregate_id: "evt_outbox_001",
    aggregate_type: "evidence",
    attempt_count: 1,
    created_at: "2026-08-28T03:00:00.000Z",
    event_type: "evidence.appended",
    lease_expires_at: "2026-08-28T03:01:00.000Z",
    lease_owner: "wrk_primary",
    lease_token: leaseToken,
    outbox_id: "1",
    payload: { eventId: "evt_outbox_001" },
    schema_version: "0.1",
    tenant_id: "ten_local",
    ...overrides,
  };
}

function failedRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return storedRow({
    available_at: "2026-08-28T03:02:00.000Z",
    last_error: "publisher unavailable",
    lease_expires_at: null,
    lease_owner: null,
    lease_token: null,
    ...overrides,
  });
}

function harness(
  handler: QueryHandler,
  token: () => string = () => leaseToken,
): {
  readonly client: FakeClient;
  readonly connections: { count: number };
  readonly repository: PostgresOutboxRepository;
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
    repository: new PostgresOutboxRepository(poolWith(client, connections), token),
  };
}

describe("PostgresOutboxRepository.claim", () => {
  it("claims a tenant-scoped batch with one database-time lease", async () => {
    const testHarness = harness((text) => {
      if (text.includes("FOR UPDATE SKIP LOCKED")) return { rows: [storedRow()] };
      return { rows: [] };
    });

    await expect(
      testHarness.repository.claim("ten_local", {
        leaseDurationMs: 60_000,
        limit: 10,
        workerId: "wrk_primary",
      }),
    ).resolves.toEqual([
      {
        aggregateId: "evt_outbox_001",
        aggregateType: "evidence",
        attemptCount: 1,
        createdAt: "2026-08-28T03:00:00.000Z",
        eventType: "evidence.appended",
        lease: {
          expiresAt: "2026-08-28T03:01:00.000Z",
          owner: "wrk_primary",
          token: leaseToken,
        },
        outboxId: "1",
        payload: { eventId: "evt_outbox_001" },
        schemaVersion: "0.1",
        tenantId: "ten_local",
      },
    ]);
    const claim = testHarness.client.queries.find(({ text }) =>
      text.includes("FOR UPDATE SKIP LOCKED"),
    );
    expect(claim?.values).toEqual(["ten_local", 10, leaseToken, "wrk_primary", 60_000]);
    expect(testHarness.client.queries.map(({ text }) => text.trim())).toEqual([
      "BEGIN",
      "SELECT set_config('proofstack.tenant_id', $1, true)",
      expect.stringContaining("WITH candidates AS"),
      "COMMIT",
    ]);
    expect(testHarness.client.releaseArguments).toEqual([undefined]);
  });

  it("returns an empty batch and supports the secure default token generator", async () => {
    const connections = { count: 0 };
    const client = new FakeClient((text, values) => {
      if (text.includes("FOR UPDATE SKIP LOCKED")) {
        expect(values?.[2]).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
        );
      }
      return { rows: [] };
    });
    const repository = new PostgresOutboxRepository(poolWith(client, connections));

    await expect(
      repository.claim("ten_local", {
        leaseDurationMs: MAX_OUTBOX_LEASE_DURATION_MS,
        limit: MAX_OUTBOX_CLAIM_SIZE,
        workerId: "wrk_primary",
      }),
    ).resolves.toEqual([]);
  });

  it.each([
    ["tenant scope", "Stored outbox tenant", { tenant_id: "ten_other" }],
    ["aggregate identifier", "aggregate identifier", { aggregate_id: "INVALID" }],
    ["aggregate type", "aggregate type", { aggregate_type: "x" }],
    ["event type", "event type", { event_type: "INVALID" }],
    ["schema version", "schema version", { schema_version: "latest" }],
    ["creation time", "creation time", { created_at: "yesterday" }],
    ["lease expiry", "lease expiry", { lease_expires_at: "tomorrow" }],
    ["lease owner", "lease owner", { lease_owner: "INVALID" }],
    ["lease token", "lease token", { lease_token: "not-a-uuid" }],
    ["outbox identifier", "outbox identifier", { outbox_id: "0" }],
    ["attempt count", "attempt count", { attempt_count: 0 }],
  ])("fails closed for an invalid stored %s", async (_label, message, overrides) => {
    const testHarness = harness((text) => ({
      rows: text.includes("FOR UPDATE SKIP LOCKED") ? [storedRow(overrides)] : [],
    }));

    await expect(
      testHarness.repository.claim("ten_local", {
        leaseDurationMs: 1,
        limit: 1,
        workerId: "wrk_primary",
      }),
    ).rejects.toThrow(message);
    expect(testHarness.client.queries.map(({ text }) => text.trim())).toContain("ROLLBACK");
  });

  it.each([null, [], { nested: Number.POSITIVE_INFINITY }])(
    "rejects a non-canonical stored payload",
    async (payload) => {
      const testHarness = harness((text) => ({
        rows: text.includes("FOR UPDATE SKIP LOCKED") ? [storedRow({ payload })] : [],
      }));

      await expect(
        testHarness.repository.claim("ten_local", {
          leaseDurationMs: 1,
          limit: 1,
          workerId: "wrk_primary",
        }),
      ).rejects.toBeInstanceOf(PostgresDataIntegrityError);
    },
  );

  it.each([
    ["tenant", "INVALID", { leaseDurationMs: 1, limit: 1, workerId: "wrk_primary" }],
    ["worker", "ten_local", { leaseDurationMs: 1, limit: 1, workerId: "INVALID" }],
    ["limit minimum", "ten_local", { leaseDurationMs: 1, limit: 0, workerId: "wrk_primary" }],
    [
      "limit maximum",
      "ten_local",
      { leaseDurationMs: 1, limit: MAX_OUTBOX_CLAIM_SIZE + 1, workerId: "wrk_primary" },
    ],
    [
      "lease duration",
      "ten_local",
      { leaseDurationMs: MAX_OUTBOX_LEASE_DURATION_MS + 1, limit: 1, workerId: "wrk_primary" },
    ],
    ["integer fields", "ten_local", { leaseDurationMs: 1.5, limit: 1, workerId: "wrk_primary" }],
  ])("rejects invalid %s input before connecting", async (_label, tenantId, options) => {
    const testHarness = harness(() => ({ rows: [] }));

    await expect(testHarness.repository.claim(tenantId, options)).rejects.toThrow();
    expect(testHarness.connections.count).toBe(0);
  });

  it("rejects an invalid generated lease token before connecting", async () => {
    const testHarness = harness(
      () => ({ rows: [] }),
      () => "invalid",
    );

    await expect(
      testHarness.repository.claim("ten_local", {
        leaseDurationMs: 1,
        limit: 1,
        workerId: "wrk_primary",
      }),
    ).rejects.toThrow("leaseToken");
    expect(testHarness.connections.count).toBe(0);
  });
});

describe("PostgresOutboxRepository.acknowledge", () => {
  it.each([true, false])("returns whether the current lease changed a row", async (changed) => {
    const testHarness = harness((text) => ({
      rows: text.includes("SET published_at") && changed ? [{ changed: true }] : [],
    }));

    await expect(
      testHarness.repository.acknowledge("ten_local", { leaseToken, outboxId: "42" }),
    ).resolves.toBe(changed);
    const mutation = testHarness.client.queries.find(({ text }) =>
      text.includes("SET published_at"),
    );
    expect(mutation?.values).toEqual(["ten_local", "42", leaseToken]);
  });

  it.each([
    ["tenant", "INVALID", "42", leaseToken],
    ["outbox format", "ten_local", "0", leaseToken],
    ["outbox range", "ten_local", "9223372036854775808", leaseToken],
    ["lease token", "ten_local", "42", "invalid"],
  ])("rejects an invalid %s before connecting", async (_label, tenantId, outboxId, token) => {
    const testHarness = harness(() => ({ rows: [] }));

    await expect(
      testHarness.repository.acknowledge(tenantId, { leaseToken: token, outboxId }),
    ).rejects.toThrow();
    expect(testHarness.connections.count).toBe(0);
  });
});

describe("PostgresOutboxRepository.listFailures", () => {
  it("returns bounded unleased and actively leased failures", async () => {
    const testHarness = harness((text) => ({
      rows: text.includes("last_error IS NOT NULL")
        ? [
            failedRow({
              attempt_count: 3,
              lease_expires_at: "2026-08-28T03:03:00.000Z",
              lease_owner: "wrk_recovery",
              lease_token: leaseToken,
              outbox_id: "2",
            }),
            failedRow({ attempt_count: 2 }),
          ]
        : [],
    }));

    await expect(
      testHarness.repository.listFailures("ten_local", { limit: 20, minimumAttempts: 2 }),
    ).resolves.toEqual([
      {
        aggregateId: "evt_outbox_001",
        aggregateType: "evidence",
        attemptCount: 3,
        availableAt: "2026-08-28T03:02:00.000Z",
        createdAt: "2026-08-28T03:00:00.000Z",
        eventType: "evidence.appended",
        lastError: "publisher unavailable",
        lease: {
          expiresAt: "2026-08-28T03:03:00.000Z",
          owner: "wrk_recovery",
          token: leaseToken,
        },
        outboxId: "2",
        schemaVersion: "0.1",
        tenantId: "ten_local",
      },
      {
        aggregateId: "evt_outbox_001",
        aggregateType: "evidence",
        attemptCount: 2,
        availableAt: "2026-08-28T03:02:00.000Z",
        createdAt: "2026-08-28T03:00:00.000Z",
        eventType: "evidence.appended",
        lastError: "publisher unavailable",
        lease: null,
        outboxId: "1",
        schemaVersion: "0.1",
        tenantId: "ten_local",
      },
    ]);
    const query = testHarness.client.queries.find(({ text }) =>
      text.includes("last_error IS NOT NULL"),
    );
    expect(query?.values).toEqual(["ten_local", 2, 20]);
  });

  it.each([
    ["availability", { available_at: "later" }],
    ["error summary", { last_error: "" }],
    ["partial lease", { lease_token: leaseToken }],
    [
      "lease token",
      {
        lease_expires_at: "2026-08-28T03:03:00.000Z",
        lease_owner: "wrk_recovery",
        lease_token: "invalid",
      },
    ],
    [
      "lease owner",
      {
        lease_expires_at: "2026-08-28T03:03:00.000Z",
        lease_owner: "INVALID",
        lease_token: leaseToken,
      },
    ],
    [
      "lease expiry",
      {
        lease_expires_at: "later",
        lease_owner: "wrk_recovery",
        lease_token: leaseToken,
      },
    ],
  ])("fails closed for an invalid stored failure %s", async (_label, overrides) => {
    const testHarness = harness((text) => ({
      rows: text.includes("last_error IS NOT NULL") ? [failedRow(overrides)] : [],
    }));

    await expect(
      testHarness.repository.listFailures("ten_local", { limit: 1, minimumAttempts: 1 }),
    ).rejects.toBeInstanceOf(PostgresDataIntegrityError);
  });

  it.each([
    ["tenant", "INVALID", { limit: 1, minimumAttempts: 1 }],
    ["minimum attempts", "ten_local", { limit: 1, minimumAttempts: 0 }],
    ["minimum attempts integer", "ten_local", { limit: 1, minimumAttempts: 1.5 }],
    ["limit minimum", "ten_local", { limit: 0, minimumAttempts: 1 }],
    ["limit maximum", "ten_local", { limit: MAX_OUTBOX_FAILURE_LIST_SIZE + 1, minimumAttempts: 1 }],
  ])("rejects an invalid %s before connecting", async (_label, tenantId, options) => {
    const testHarness = harness(() => ({ rows: [] }));

    await expect(testHarness.repository.listFailures(tenantId, options)).rejects.toThrow();
    expect(testHarness.connections.count).toBe(0);
  });
});

describe("PostgresOutboxRepository.retry", () => {
  it.each([true, false])("records a bounded retry when the lease is current", async (changed) => {
    const testHarness = harness((text) => ({
      rows: text.includes("SET available_at") && changed ? [{ changed: true }] : [],
    }));

    await expect(
      testHarness.repository.retry("ten_local", {
        error: "publisher unavailable",
        leaseToken,
        outboxId: "42",
        retryDelayMs: MAX_OUTBOX_RETRY_DELAY_MS,
      }),
    ).resolves.toBe(changed);
    const mutation = testHarness.client.queries.find(({ text }) =>
      text.includes("SET available_at"),
    );
    expect(mutation?.values).toEqual([
      "ten_local",
      "42",
      leaseToken,
      MAX_OUTBOX_RETRY_DELAY_MS,
      "publisher unavailable",
    ]);
  });

  it.each([
    ["delay below range", -1, "failure", leaseToken, "42"],
    ["delay above range", MAX_OUTBOX_RETRY_DELAY_MS + 1, "failure", leaseToken, "42"],
    ["integer delay", 1.5, "failure", leaseToken, "42"],
    ["empty error", 0, "", leaseToken, "42"],
    ["long error", 0, "x".repeat(MAX_OUTBOX_ERROR_LENGTH + 1), leaseToken, "42"],
    ["lease token", 0, "failure", "invalid", "42"],
    ["outbox identifier", 0, "failure", leaseToken, "nope"],
  ])(
    "rejects an invalid %s before connecting",
    async (_label, retryDelayMs, error, token, outboxId) => {
      const testHarness = harness(() => ({ rows: [] }));

      await expect(
        testHarness.repository.retry("ten_local", {
          error,
          leaseToken: token,
          outboxId,
          retryDelayMs,
        }),
      ).rejects.toThrow();
      expect(testHarness.connections.count).toBe(0);
    },
  );
});
