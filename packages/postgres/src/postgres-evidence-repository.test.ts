import type { EvidenceEnvelope } from "@proofstack/contracts";
import { EvidenceConflictError } from "@proofstack/core";
import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import {
  PostgresDataIntegrityError,
  PostgresEvidenceRepository,
} from "./postgres-evidence-repository.js";

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

function envelope(overrides: Partial<EvidenceEnvelope> = {}): EvidenceEnvelope {
  return {
    evidence: {
      attributes: {},
      contentReferences: [],
      eventId: "evt_repository_001",
      extensions: {},
      kind: "agent.run",
      name: "repository-test",
      source: {
        sdkName: "@proofstack/sdk",
        sdkVersion: "0.0.0",
        serviceName: "repository-test",
      },
      spanId: "00f067aa0ba902b7",
      startedAt: "2026-08-28T02:59:59.000Z",
      status: "ok",
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
    },
    receivedAt: "2026-08-28T03:00:00.000Z",
    schemaVersion: "0.1",
    scope: {
      environmentId: "env_local",
      projectId: "prj_local",
      tenantId: "ten_local",
    },
    ...overrides,
  };
}

function storedRow(value: EvidenceEnvelope = envelope()): Record<string, unknown> {
  return {
    environment_id: value.scope.environmentId,
    evidence: value.evidence,
    project_id: value.scope.projectId,
    received_at: value.receivedAt,
    schema_version: value.schemaVersion,
    tenant_id: value.scope.tenantId,
  };
}

function transactionRows(handler: QueryHandler): {
  readonly client: FakeClient;
  readonly connections: { count: number };
  readonly repository: PostgresEvidenceRepository;
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
    repository: new PostgresEvidenceRepository(poolWith(client, connections)),
  };
}

describe("PostgresEvidenceRepository.append", () => {
  it("returns immediately for an empty batch", async () => {
    const harness = transactionRows(() => ({ rows: [] }));

    await expect(harness.repository.append([])).resolves.toEqual({
      acceptedEventIds: [],
      duplicateEventIds: [],
    });
    expect(harness.connections.count).toBe(0);
  });

  it("rejects a batch spanning multiple tenants before opening a transaction", async () => {
    const harness = transactionRows(() => ({ rows: [] }));
    const otherTenant = envelope({
      scope: { environmentId: "env_local", projectId: "prj_local", tenantId: "ten_other" },
    });

    await expect(harness.repository.append([envelope(), otherTenant])).rejects.toBeInstanceOf(
      TypeError,
    );
    expect(harness.connections.count).toBe(0);
  });

  it("reports accepted and structurally identical duplicate events", async () => {
    let insertCount = 0;
    const harness = transactionRows((text) => {
      if (text.includes("INSERT INTO public.proofstack_evidence_events")) {
        insertCount += 1;
        return { rows: insertCount === 1 ? [{ event_id: "evt_repository_001" }] : [] };
      }
      if (text.includes("proofstack_outbox")) return { rows: [] };
      if (text.includes("AS identical")) return { rows: [{ identical: true }] };
      return { rows: [] };
    });
    const second = envelope({
      evidence: { ...envelope().evidence, eventId: "evt_repository_002" },
    });

    await expect(harness.repository.append([envelope(), second])).resolves.toEqual({
      acceptedEventIds: ["evt_repository_001"],
      duplicateEventIds: ["evt_repository_002"],
    });
    expect(harness.client.queries.map(({ text }) => text.trim())).toContain("COMMIT");
    const outboxQueries = harness.client.queries.filter(({ text }) =>
      text.includes("proofstack_outbox"),
    );
    expect(outboxQueries).toHaveLength(1);
    expect(outboxQueries[0]?.values).toEqual([
      "ten_local",
      "evt_repository_001",
      "0.1",
      JSON.stringify(envelope()),
      "2026-08-28T03:00:00.000Z",
    ]);
  });

  it("rolls back evidence when its publication intent cannot be recorded", async () => {
    const harness = transactionRows((text) => {
      if (text.includes("INSERT INTO public.proofstack_evidence_events")) {
        return { rows: [{ event_id: "evt_repository_001" }] };
      }
      if (text.includes("proofstack_outbox")) throw new Error("outbox unavailable");
      return { rows: [] };
    });

    await expect(harness.repository.append([envelope()])).rejects.toThrow("outbox unavailable");
    expect(harness.client.queries.map(({ text }) => text.trim())).toContain("ROLLBACK");
  });

  it("rolls back a conflicting event", async () => {
    const harness = transactionRows((text) => {
      if (text.includes("INSERT INTO")) return { rows: [] };
      if (text.includes("AS identical")) return { rows: [{ identical: false }] };
      return { rows: [] };
    });

    await expect(harness.repository.append([envelope()])).rejects.toBeInstanceOf(
      EvidenceConflictError,
    );
    expect(harness.client.queries.map(({ text }) => text.trim())).toContain("ROLLBACK");
  });

  it("fails closed when a conflicting row is unexpectedly invisible", async () => {
    const harness = transactionRows(() => ({ rows: [] }));

    await expect(harness.repository.append([envelope()])).rejects.toBeInstanceOf(
      PostgresDataIntegrityError,
    );
  });
});

describe("PostgresEvidenceRepository.listByTrace", () => {
  it("returns a bounded first page and validates stored envelopes", async () => {
    const second = envelope({
      evidence: { ...envelope().evidence, eventId: "evt_repository_002" },
    });
    const harness = transactionRows((text) => {
      if (text.includes("ORDER BY started_at")) return { rows: [storedRow(), storedRow(second)] };
      return { rows: [] };
    });

    const page = await harness.repository.listByTrace(
      envelope().scope,
      envelope().evidence.traceId,
      {
        limit: 1,
      },
    );

    expect(page).toEqual({ cursorFound: true, events: [envelope()], hasMore: true });
    const listQuery = harness.client.queries.find(({ text }) =>
      text.includes("ORDER BY started_at"),
    );
    expect(listQuery?.values?.at(-1)).toBe(2);
    expect(listQuery?.text).toContain('ORDER BY started_at, sequence, event_id COLLATE "C"');
  });

  it("rejects an unknown complete cursor without running the page query", async () => {
    const harness = transactionRows((text) => {
      if (text.includes("SELECT EXISTS")) return { rows: [{ cursor_found: false }] };
      if (text.includes("ORDER BY started_at")) throw new Error("page query must not execute");
      return { rows: [] };
    });

    await expect(
      harness.repository.listByTrace(envelope().scope, envelope().evidence.traceId, {
        after: {
          eventId: envelope().evidence.eventId,
          sequence: 0,
          startedAt: envelope().evidence.startedAt,
        },
        limit: 10,
      }),
    ).resolves.toEqual({ cursorFound: false, events: [], hasMore: false });
    const cursorQuery = harness.client.queries.find(({ text }) => text.includes("SELECT EXISTS"));
    expect(cursorQuery?.text).toContain('event_id COLLATE "C" = $7::varchar COLLATE "C"');
  });

  it("reads the page after an existing complete cursor", async () => {
    const harness = transactionRows((text) => {
      if (text.includes("SELECT EXISTS")) return { rows: [{ cursor_found: true }] };
      if (text.includes("ORDER BY started_at")) return { rows: [storedRow()] };
      return { rows: [] };
    });

    const page = await harness.repository.listByTrace(
      envelope().scope,
      envelope().evidence.traceId,
      {
        after: {
          eventId: "evt_repository_previous",
          sequence: 0,
          startedAt: envelope().evidence.startedAt,
        },
        limit: 10,
      },
    );

    expect(page.events).toEqual([envelope()]);
    const listQuery = harness.client.queries.find(({ text }) =>
      text.includes("ORDER BY started_at"),
    );
    expect(listQuery?.values).toEqual([
      "ten_local",
      "prj_local",
      "env_local",
      envelope().evidence.traceId,
      envelope().evidence.startedAt,
      0,
      "evt_repository_previous",
      11,
    ]);
    expect(listQuery?.text).toContain('(started_at, sequence, event_id COLLATE "C")');
    expect(listQuery?.text).toContain('$7::varchar COLLATE "C"');
    expect(listQuery?.text).toContain('ORDER BY started_at, sequence, event_id COLLATE "C"');
  });

  it("fails closed when stored JSON violates the canonical contract", async () => {
    const harness = transactionRows((text) => {
      if (text.includes("ORDER BY started_at")) {
        return { rows: [{ ...storedRow(), evidence: { invalid: true } }] };
      }
      return { rows: [] };
    });

    await expect(
      harness.repository.listByTrace(envelope().scope, envelope().evidence.traceId, { limit: 10 }),
    ).rejects.toBeInstanceOf(PostgresDataIntegrityError);
  });
});
