import { ProjectionCursorRegressionError } from "@proofstack/core";
import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { PostgresDataIntegrityError } from "./postgres-evidence-repository.js";
import {
  MAX_PROJECTION_CURSOR_GENERATION,
  PostgresProjectionCursorRepository,
} from "./postgres-projection-cursor-repository.js";

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

function storedRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    consumer_name: "trace.projector",
    generation: 1,
    last_outbox_id: "42",
    tenant_id: "ten_local",
    updated_at: "2026-08-28T03:00:00.000Z",
    ...overrides,
  };
}

function harness(handler: QueryHandler): {
  readonly client: FakeClient;
  readonly connections: { count: number };
  readonly repository: PostgresProjectionCursorRepository;
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
    repository: new PostgresProjectionCursorRepository(poolWith(client, connections)),
  };
}

describe("PostgresProjectionCursorRepository.get", () => {
  it("returns the tenant-scoped cursor", async () => {
    const testHarness = harness((text) => ({
      rows: text.includes("proofstack_projection_cursors") ? [storedRow()] : [],
    }));

    await expect(
      testHarness.repository.get("ten_local", {
        consumerName: "trace.projector",
        generation: 1,
      }),
    ).resolves.toEqual({
      consumerName: "trace.projector",
      generation: 1,
      lastOutboxId: "42",
      tenantId: "ten_local",
      updatedAt: "2026-08-28T03:00:00.000Z",
    });
    const query = testHarness.client.queries.find(({ text }) =>
      text.includes("proofstack_projection_cursors"),
    );
    expect(query?.values).toEqual(["ten_local", "trace.projector", 1]);
  });

  it("returns null when the cursor does not exist", async () => {
    const testHarness = harness(() => ({ rows: [] }));

    await expect(
      testHarness.repository.get("ten_local", {
        consumerName: "trace.projector",
        generation: 1,
      }),
    ).resolves.toBeNull();
  });

  it.each([
    ["tenant", { tenant_id: "ten_other" }],
    ["consumer", { consumer_name: "policy.projector" }],
    ["generation", { generation: 2 }],
    ["position", { last_outbox_id: "-1" }],
    ["update time", { updated_at: "now" }],
  ])("fails closed for an invalid stored %s", async (_label, overrides) => {
    const testHarness = harness((text) => ({
      rows: text.includes("proofstack_projection_cursors") ? [storedRow(overrides)] : [],
    }));

    await expect(
      testHarness.repository.get("ten_local", {
        consumerName: "trace.projector",
        generation: 1,
      }),
    ).rejects.toBeInstanceOf(PostgresDataIntegrityError);
  });
});

describe("PostgresProjectionCursorRepository.advance", () => {
  it("creates a missing cursor", async () => {
    const testHarness = harness((text) => {
      if (text.includes("FOR UPDATE")) return { rows: [] };
      if (text.includes("INSERT INTO")) return { rows: [storedRow()] };
      return { rows: [] };
    });

    await expect(
      testHarness.repository.advance("ten_local", {
        consumerName: "trace.projector",
        generation: 1,
        lastOutboxId: "42",
      }),
    ).resolves.toMatchObject({
      advanced: true,
      cursor: { lastOutboxId: "42" },
    });
    const insert = testHarness.client.queries.find(({ text }) => text.includes("INSERT INTO"));
    expect(insert?.values).toEqual(["ten_local", "trace.projector", 1, "42"]);
  });

  it("treats the current position as an idempotent no-op", async () => {
    const testHarness = harness((text) => ({
      rows: text.includes("FOR UPDATE") ? [storedRow()] : [],
    }));

    await expect(
      testHarness.repository.advance("ten_local", {
        consumerName: "trace.projector",
        generation: 1,
        lastOutboxId: "42",
      }),
    ).resolves.toMatchObject({ advanced: false, cursor: { lastOutboxId: "42" } });
    expect(testHarness.client.queries.some(({ text }) => text.includes("UPDATE public"))).toBe(
      false,
    );
  });

  it("rejects a cursor regression and rolls back", async () => {
    const testHarness = harness((text) => ({
      rows: text.includes("FOR UPDATE") ? [storedRow()] : [],
    }));

    await expect(
      testHarness.repository.advance("ten_local", {
        consumerName: "trace.projector",
        generation: 1,
        lastOutboxId: "41",
      }),
    ).rejects.toMatchObject({
      currentOutboxId: "42",
      requestedOutboxId: "41",
    });
    await expect(
      testHarness.repository.advance("ten_local", {
        consumerName: "trace.projector",
        generation: 1,
        lastOutboxId: "41",
      }),
    ).rejects.toBeInstanceOf(ProjectionCursorRegressionError);
    expect(testHarness.client.queries.map(({ text }) => text.trim())).toContain("ROLLBACK");
  });

  it("advances a locked cursor", async () => {
    const testHarness = harness((text) => {
      if (text.includes("FOR UPDATE")) return { rows: [storedRow()] };
      if (text.includes("UPDATE public")) {
        return { rows: [storedRow({ last_outbox_id: "43" })] };
      }
      return { rows: [] };
    });

    await expect(
      testHarness.repository.advance("ten_local", {
        consumerName: "trace.projector",
        generation: 1,
        lastOutboxId: "43",
      }),
    ).resolves.toMatchObject({ advanced: true, cursor: { lastOutboxId: "43" } });
    const update = testHarness.client.queries.find(({ text }) => text.includes("UPDATE public"));
    expect(update?.values).toEqual(["ten_local", "trace.projector", 1, "43"]);
  });

  it("recovers an initial insert race and continues advancing", async () => {
    let lockCount = 0;
    const testHarness = harness((text) => {
      if (text.includes("FOR UPDATE")) {
        lockCount += 1;
        return { rows: lockCount === 1 ? [] : [storedRow()] };
      }
      if (text.includes("INSERT INTO")) return { rows: [] };
      if (text.includes("UPDATE public")) {
        return { rows: [storedRow({ last_outbox_id: "50" })] };
      }
      return { rows: [] };
    });

    await expect(
      testHarness.repository.advance("ten_local", {
        consumerName: "trace.projector",
        generation: 1,
        lastOutboxId: "50",
      }),
    ).resolves.toMatchObject({ advanced: true, cursor: { lastOutboxId: "50" } });
  });

  it("fails closed when a cursor disappears after an insert conflict", async () => {
    const testHarness = harness(() => ({ rows: [] }));

    await expect(
      testHarness.repository.advance("ten_local", {
        consumerName: "trace.projector",
        generation: 1,
        lastOutboxId: "42",
      }),
    ).rejects.toThrow("disappeared");
  });

  it("fails closed when a locked cursor cannot be updated", async () => {
    const testHarness = harness((text) => ({
      rows: text.includes("FOR UPDATE") ? [storedRow()] : [],
    }));

    await expect(
      testHarness.repository.advance("ten_local", {
        consumerName: "trace.projector",
        generation: 1,
        lastOutboxId: "43",
      }),
    ).rejects.toThrow("could not be advanced");
  });
});

describe("PostgresProjectionCursorRepository input validation", () => {
  it.each([
    ["tenant", "INVALID", { consumerName: "trace.projector", generation: 1 }],
    ["consumer", "ten_local", { consumerName: "INVALID", generation: 1 }],
    ["generation minimum", "ten_local", { consumerName: "trace.projector", generation: 0 }],
    [
      "generation maximum",
      "ten_local",
      { consumerName: "trace.projector", generation: MAX_PROJECTION_CURSOR_GENERATION + 1 },
    ],
    ["generation integer", "ten_local", { consumerName: "trace.projector", generation: 1.5 }],
  ])("rejects an invalid get %s before connecting", async (_label, tenantId, key) => {
    const testHarness = harness(() => ({ rows: [] }));

    await expect(testHarness.repository.get(tenantId, key)).rejects.toThrow();
    expect(testHarness.connections.count).toBe(0);
  });

  it.each([
    ["position format", "-1"],
    ["position range", "9223372036854775808"],
  ])("rejects an invalid advance %s before connecting", async (_label, lastOutboxId) => {
    const testHarness = harness(() => ({ rows: [] }));

    await expect(
      testHarness.repository.advance("ten_local", {
        consumerName: "trace.projector",
        generation: 1,
        lastOutboxId,
      }),
    ).rejects.toThrow();
    expect(testHarness.connections.count).toBe(0);
  });
});
