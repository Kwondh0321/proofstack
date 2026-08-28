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
    name: "orders evidence with PostgreSQL microsecond rounding",
    async run(factory) {
      await withRepository(factory, "contract_precision", async (repository) => {
        const values = [
          envelope("contract_precision", "evt_precision_a", {
            evidence: { spanId: "10f067aa0ba902b7", startedAt: "2026-08-28T02:59:59.0000025Z" },
          }),
          envelope("contract_precision", "evt_precision_m", {
            evidence: { spanId: "20f067aa0ba902b7", startedAt: "2026-08-28T02:59:59.000002Z" },
          }),
          envelope("contract_precision", "evt_precision_z", {
            evidence: { spanId: "30f067aa0ba902b7", startedAt: "2026-08-28T02:59:59.0000015Z" },
          }),
          envelope("contract_precision", "evt_greater_a", {
            evidence: { spanId: "40f067aa0ba902b7", startedAt: "2026-08-28T02:59:59.000003Z" },
          }),
          envelope("contract_precision", "evt_greater_z", {
            evidence: {
              spanId: "50f067aa0ba902b7",
              startedAt: "2026-08-28T02:59:59.000002500001Z",
            },
          }),
          envelope("contract_precision", "evt_carry_a", {
            evidence: { spanId: "60f067aa0ba902b7", startedAt: "2026-08-28T03:00:00Z" },
          }),
          envelope("contract_precision", "evt_carry_z", {
            evidence: { spanId: "70f067aa0ba902b7", startedAt: "2026-08-28T02:59:59.9999995Z" },
          }),
        ];

        await repository.append([...values].reverse());
        const page = await repository.listByTrace(scope("contract_precision"), traceId, {
          limit: 10,
        });

        assert.deepEqual(
          page.events.map(({ evidence }) => evidence.eventId),
          [
            "evt_precision_a",
            "evt_precision_m",
            "evt_precision_z",
            "evt_greater_a",
            "evt_greater_z",
            "evt_carry_a",
            "evt_carry_z",
          ],
        );
      });
    },
  },
  {
    name: "orders and paginates event identifiers bytewise",
    async run(factory) {
      await withRepository(factory, "contract_bytewise_order", async (repository) => {
        const values = [
          envelope("contract_bytewise_order", "evt_a", {
            evidence: { spanId: "30f067aa0ba902b7" },
          }),
          envelope("contract_bytewise_order", "evt__", {
            evidence: { spanId: "20f067aa0ba902b7" },
          }),
          envelope("contract_bytewise_order", "evt_0", {
            evidence: { spanId: "10f067aa0ba902b7" },
          }),
        ];
        await repository.append(values);

        const firstPage = await repository.listByTrace(scope("contract_bytewise_order"), traceId, {
          limit: 1,
        });
        assert.equal(firstPage.cursorFound, true);
        assert.equal(firstPage.hasMore, true);
        assert.deepEqual(
          firstPage.events.map(({ evidence }) => evidence.eventId),
          ["evt_0"],
        );

        const cursorEvent = firstPage.events[0];
        assert.ok(cursorEvent);
        const secondPage = await repository.listByTrace(scope("contract_bytewise_order"), traceId, {
          after: {
            eventId: cursorEvent.evidence.eventId,
            sequence: cursorEvent.evidence.sequence ?? 0,
            startedAt: cursorEvent.evidence.startedAt,
          },
          limit: 3,
        });
        assert.equal(secondPage.cursorFound, true);
        assert.equal(secondPage.hasMore, false);
        assert.deepEqual(
          secondPage.events.map(({ evidence }) => evidence.eventId),
          ["evt__", "evt_a"],
        );
      });
    },
  },
  {
    name: "owns immutable evidence values across writes and reads",
    async run(factory) {
      await withRepository(factory, "contract_ownership", async (repository) => {
        const expectedScope = scope("contract_ownership");
        const original = envelope("contract_ownership", "evt_contract_ownership", {
          evidence: { attributes: { nested: { value: "original" } } },
        });
        await repository.append([original]);
        original.evidence.name = "mutated-after-append";
        original.scope.projectId = "prj_mutated_after_append";
        const originalNested = (original.evidence.attributes as Readonly<Record<"nested", unknown>>)
          .nested;
        assert.ok(typeof originalNested === "object" && originalNested !== null);
        (originalNested as { value: string }).value = "mutated-after-append";

        const firstRead = await repository.listByTrace(expectedScope, traceId, {
          limit: 10,
        });
        const firstEvent = firstRead.events[0];
        assert.ok(firstEvent);
        assert.equal(firstEvent.evidence.name, "repository-contract");
        assert.equal(firstEvent.scope.projectId, expectedScope.projectId);
        assert.deepEqual(firstEvent.evidence.attributes, { nested: { value: "original" } });
        firstEvent.evidence.name = "mutated-after-read";
        firstEvent.scope.projectId = "prj_mutated_after_read";
        const firstReadNested = (
          firstEvent.evidence.attributes as Readonly<Record<"nested", unknown>>
        ).nested;
        assert.ok(typeof firstReadNested === "object" && firstReadNested !== null);
        (firstReadNested as { value: string }).value = "mutated-after-read";

        const secondRead = await repository.listByTrace(expectedScope, traceId, {
          limit: 10,
        });
        assert.equal(secondRead.events[0]?.evidence.name, "repository-contract");
        assert.equal(secondRead.events[0]?.scope.projectId, expectedScope.projectId);
        assert.deepEqual(secondRead.events[0]?.evidence.attributes, {
          nested: { value: "original" },
        });
      });
    },
  },
  {
    name: "treats a later receipt time and reordered object keys as an identical retry",
    async run(factory) {
      await withRepository(factory, "contract_retry", async (repository) => {
        const first = envelope("contract_retry", "evt_contract_retry", {
          evidence: { attributes: { alpha: 1, beta: 2, zero: -0 } },
        });
        const retry = envelope("contract_retry", "evt_contract_retry", {
          evidence: { attributes: { zero: 0, beta: 2, alpha: 1 } },
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
        const storedEvent = stored.events[0];
        assert.ok(storedEvent);
        assert.equal(storedEvent.receivedAt, first.receivedAt);
        const storedZero = (storedEvent.evidence.attributes as Readonly<Record<"zero", unknown>>)
          .zero;
        assert.equal(storedZero, 0);
        assert.equal(Object.is(storedZero, -0), false);
      });
    },
  },
  {
    name: "accepts equivalent cursor timestamp spellings",
    async run(factory) {
      await withRepository(factory, "contract_cursor_equivalence", async (repository) => {
        const first = envelope("contract_cursor_equivalence", "evt_cursor_equivalent", {
          evidence: { spanId: "10f067aa0ba902b7", startedAt: "2026-08-28T02:59:59.000125500Z" },
        });
        const second = envelope("contract_cursor_equivalence", "evt_cursor_later", {
          evidence: { spanId: "20f067aa0ba902b7", startedAt: "2026-08-28T02:59:59.000126Z" },
        });
        await repository.append([first, second]);

        const page = await repository.listByTrace(scope("contract_cursor_equivalence"), traceId, {
          after: {
            eventId: first.evidence.eventId,
            sequence: first.evidence.sequence ?? 0,
            startedAt: "2026-08-28T11:59:59.000125+09:00",
          },
          limit: 10,
        });

        assert.equal(page.cursorFound, true);
        assert.deepEqual(
          page.events.map(({ evidence }) => evidence.eventId),
          [second.evidence.eventId],
        );
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
