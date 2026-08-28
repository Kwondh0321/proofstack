import assert from "node:assert/strict";
import type { EvidenceEnvelope, EvidenceRecord, EvidenceScope } from "@proofstack/contracts";
import { EvidenceConflictError } from "../errors.js";
import type { EvidenceRepository } from "../evidence/evidence-repository.js";

export interface EvidenceRepositoryTestHarness {
  readonly dispose?: () => Promise<void>;
  readonly repository: EvidenceRepository;
}

export type EvidenceRepositoryTestFactory = (
  namespace: string,
) => Promise<EvidenceRepositoryTestHarness> | EvidenceRepositoryTestHarness;

export interface EvidenceRepositoryConformanceCase {
  readonly name: string;
  readonly run: (factory: EvidenceRepositoryTestFactory) => Promise<void>;
}

const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";

function scope(namespace: string, overrides: Partial<EvidenceScope> = {}): EvidenceScope {
  return {
    environmentId: `env_${namespace}`,
    projectId: `prj_${namespace}`,
    tenantId: `ten_${namespace}`,
    ...overrides,
  };
}

function record(eventId: string, overrides: Partial<EvidenceRecord> = {}): EvidenceRecord {
  return {
    attributes: {},
    contentReferences: [],
    eventId,
    extensions: {},
    kind: "agent.run",
    name: "repository-contract",
    source: {
      sdkName: "@proofstack/testkit",
      sdkVersion: "0.0.0",
      serviceName: "repository-contract",
    },
    spanId: "00f067aa0ba902b7",
    startedAt: "2026-08-28T02:59:59.000Z",
    status: "ok",
    traceId,
    ...overrides,
  };
}

function envelope(
  namespace: string,
  eventId: string,
  options: {
    readonly evidence?: Partial<EvidenceRecord>;
    readonly receivedAt?: string;
    readonly scope?: Partial<EvidenceScope>;
  } = {},
): EvidenceEnvelope {
  return {
    evidence: record(eventId, options.evidence),
    receivedAt: options.receivedAt ?? "2026-08-28T03:00:00.000Z",
    schemaVersion: "0.1",
    scope: scope(namespace, options.scope),
  };
}

async function withRepository(
  factory: EvidenceRepositoryTestFactory,
  namespace: string,
  test: (repository: EvidenceRepository) => Promise<void>,
): Promise<void> {
  const harness = await factory(namespace);
  try {
    await test(harness.repository);
  } finally {
    await harness.dispose?.();
  }
}

export const evidenceRepositoryConformanceCases: readonly EvidenceRepositoryConformanceCase[] = [
  {
    name: "appends and orders evidence by the complete keyset",
    async run(factory) {
      await withRepository(factory, "contract_order", async (repository) => {
        const laterId = envelope("contract_order", "evt_contract_z", {
          evidence: { spanId: "10f067aa0ba902b7" },
        });
        const earlierId = envelope("contract_order", "evt_contract_a", {
          evidence: { spanId: "20f067aa0ba902b7" },
        });
        const laterSequence = envelope("contract_order", "evt_contract_m", {
          evidence: { sequence: 1, spanId: "30f067aa0ba902b7" },
        });

        const append = await repository.append([laterSequence, laterId, earlierId]);
        const page = await repository.listByTrace(scope("contract_order"), traceId, { limit: 10 });

        assert.deepEqual(append, {
          acceptedEventIds: ["evt_contract_m", "evt_contract_z", "evt_contract_a"],
          duplicateEventIds: [],
        });
        assert.deepEqual(
          page.events.map(({ evidence }) => evidence.eventId),
          ["evt_contract_a", "evt_contract_z", "evt_contract_m"],
        );
        assert.equal(page.cursorFound, true);
        assert.equal(page.hasMore, false);
      });
    },
  },
  {
    name: "treats a later receipt time and reordered object keys as an identical retry",
    async run(factory) {
      await withRepository(factory, "contract_retry", async (repository) => {
        const first = envelope("contract_retry", "evt_contract_retry", {
          evidence: { attributes: { alpha: 1, beta: 2 } },
        });
        const retry = envelope("contract_retry", "evt_contract_retry", {
          evidence: { attributes: { beta: 2, alpha: 1 } },
          receivedAt: "2026-08-28T03:01:00.000Z",
        });

        await repository.append([first]);
        const result = await repository.append([retry]);
        const stored = await repository.listByTrace(scope("contract_retry"), traceId, {
          limit: 10,
        });

        assert.deepEqual(result, {
          acceptedEventIds: [],
          duplicateEventIds: ["evt_contract_retry"],
        });
        assert.equal(stored.events[0]?.receivedAt, first.receivedAt);
      });
    },
  },
  {
    name: "rolls back the complete batch when an event identifier conflicts",
    async run(factory) {
      await withRepository(factory, "contract_conflict", async (repository) => {
        const original = envelope("contract_conflict", "evt_contract_original");
        await repository.append([original]);

        const newEvent = envelope("contract_conflict", "evt_contract_new", {
          evidence: { spanId: "10f067aa0ba902b7" },
        });
        const conflict = envelope("contract_conflict", "evt_contract_original", {
          evidence: { name: "changed" },
        });

        await assert.rejects(repository.append([newEvent, conflict]), EvidenceConflictError);
        const stored = await repository.listByTrace(scope("contract_conflict"), traceId, {
          limit: 10,
        });
        assert.deepEqual(
          stored.events.map(({ evidence }) => evidence.eventId),
          ["evt_contract_original"],
        );
      });
    },
  },
  {
    name: "isolates tenants, projects, and environments",
    async run(factory) {
      await withRepository(factory, "contract_scope", async (repository) => {
        const tenantEvent = envelope("contract_scope", "evt_contract_scope");
        const otherTenant = envelope("contract_scope", "evt_contract_scope", {
          scope: { tenantId: "ten_contract_other" },
        });
        const otherProject = envelope("contract_scope", "evt_contract_project", {
          evidence: { spanId: "10f067aa0ba902b7" },
          scope: { projectId: "prj_contract_other" },
        });
        const otherEnvironment = envelope("contract_scope", "evt_contract_environment", {
          evidence: { spanId: "20f067aa0ba902b7" },
          scope: { environmentId: "env_contract_other" },
        });

        await repository.append([tenantEvent, otherProject, otherEnvironment]);
        await repository.append([otherTenant]);

        const tenantPage = await repository.listByTrace(scope("contract_scope"), traceId, {
          limit: 10,
        });
        const otherTenantPage = await repository.listByTrace(
          scope("contract_scope", { tenantId: "ten_contract_other" }),
          traceId,
          { limit: 10 },
        );

        assert.deepEqual(
          tenantPage.events.map(({ evidence }) => evidence.eventId),
          ["evt_contract_scope"],
        );
        assert.deepEqual(
          otherTenantPage.events.map(({ evidence }) => evidence.eventId),
          ["evt_contract_scope"],
        );
      });
    },
  },
  {
    name: "paginates from an existing complete cursor and rejects an unknown cursor",
    async run(factory) {
      await withRepository(factory, "contract_cursor", async (repository) => {
        const first = envelope("contract_cursor", "evt_contract_cursor_a");
        const second = envelope("contract_cursor", "evt_contract_cursor_b", {
          evidence: { sequence: 1, spanId: "10f067aa0ba902b7" },
        });
        await repository.append([first, second]);

        const firstPage = await repository.listByTrace(scope("contract_cursor"), traceId, {
          limit: 1,
        });
        const secondPage = await repository.listByTrace(scope("contract_cursor"), traceId, {
          after: {
            eventId: first.evidence.eventId,
            sequence: first.evidence.sequence ?? 0,
            startedAt: first.evidence.startedAt,
          },
          limit: 1,
        });
        const invalidPage = await repository.listByTrace(scope("contract_cursor"), traceId, {
          after: {
            eventId: "evt_contract_missing",
            sequence: 0,
            startedAt: first.evidence.startedAt,
          },
          limit: 1,
        });

        assert.equal(firstPage.hasMore, true);
        assert.deepEqual(
          secondPage.events.map(({ evidence }) => evidence.eventId),
          [second.evidence.eventId],
        );
        assert.equal(secondPage.cursorFound, true);
        assert.deepEqual(invalidPage, { cursorFound: false, events: [], hasMore: false });
      });
    },
  },
];
