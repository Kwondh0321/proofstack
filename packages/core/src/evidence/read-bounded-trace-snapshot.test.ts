import {
  EVIDENCE_SCHEMA_VERSION,
  type EvidenceEnvelope,
  type EvidenceScope,
} from "@proofstack/contracts";
import { describe, expect, it, vi } from "vitest";
import { EvidenceRepositoryContractError } from "../errors.js";
import type { EvidencePage, EvidenceRepository } from "./evidence-repository.js";
import { readBoundedTraceSnapshot } from "./read-bounded-trace-snapshot.js";

const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const scope: EvidenceScope = {
  environmentId: "env_snapshot",
  projectId: "prj_snapshot",
  tenantId: "ten_snapshot",
};

function envelope(
  eventId: string,
  evidence: Partial<EvidenceEnvelope["evidence"]> = {},
): EvidenceEnvelope {
  return {
    evidence: {
      attributes: {},
      contentReferences: [],
      eventId,
      extensions: {},
      kind: "agent.run",
      name: "snapshot-source",
      source: {
        sdkName: "@proofstack/testkit",
        sdkVersion: "0.0.0",
        serviceName: "snapshot-source",
      },
      spanId: "00f067aa0ba902b7",
      startedAt: "2026-08-28T02:59:59.000Z",
      status: "ok",
      traceId: TRACE_ID,
      ...evidence,
    },
    receivedAt: "2026-08-28T03:00:00.000Z",
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    scope,
  };
}

function repositoryReturning(page: EvidencePage): {
  readonly listByTrace: ReturnType<typeof vi.fn<EvidenceRepository["listByTrace"]>>;
  readonly repository: EvidenceRepository;
} {
  const listByTrace = vi.fn<EvidenceRepository["listByTrace"]>().mockResolvedValue(page);
  return {
    listByTrace,
    repository: {
      append: vi.fn<EvidenceRepository["append"]>().mockResolvedValue({
        acceptedEventIds: [],
        duplicateEventIds: [],
      }),
      listByTrace,
    },
  };
}

describe("readBoundedTraceSnapshot", () => {
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "rejects an invalid limit %s before repository access",
    async (maximumEvents) => {
      const harness = repositoryReturning({ cursorFound: true, events: [], hasMore: false });

      await expect(
        readBoundedTraceSnapshot(harness.repository, { maximumEvents, scope, traceId: TRACE_ID }),
      ).rejects.toBeInstanceOf(RangeError);
      expect(harness.listByTrace).not.toHaveBeenCalled();
    },
  );

  it("uses one cursorless read and preserves the repository order", async () => {
    const events = [envelope("evt_snapshot_a"), envelope("evt_snapshot_b")];
    const harness = repositoryReturning({ cursorFound: true, events, hasMore: false });

    const result = await readBoundedTraceSnapshot(harness.repository, {
      maximumEvents: 17,
      scope,
      traceId: TRACE_ID,
    });

    expect(harness.listByTrace).toHaveBeenCalledTimes(1);
    expect(harness.listByTrace).toHaveBeenCalledWith(scope, TRACE_ID, { limit: 17 });
    expect(result).toEqual({ events, status: "found" });
  });

  it("accepts canonical keys using normalized instants, default sequence, and bytewise ids", async () => {
    const events = [
      envelope("evt_0", { startedAt: "2026-08-28T02:59:59.000000Z" }),
      envelope("evt__", { sequence: 0, startedAt: "2026-08-28T11:59:59+09:00" }),
      envelope("evt_a", { sequence: 1, startedAt: "2026-08-28T02:59:59Z" }),
    ];
    const harness = repositoryReturning({ cursorFound: true, events, hasMore: false });

    await expect(
      readBoundedTraceSnapshot(harness.repository, {
        maximumEvents: 3,
        scope,
        traceId: TRACE_ID,
      }),
    ).resolves.toEqual({ events, status: "found" });
  });

  it("accepts a caller-owned bound at fixture scale", async () => {
    const events = Array.from({ length: 1_000 }, (_, index) =>
      envelope(`evt_snapshot_${index.toString().padStart(4, "0")}`),
    );
    const harness = repositoryReturning({ cursorFound: true, events, hasMore: false });

    await expect(
      readBoundedTraceSnapshot(harness.repository, {
        maximumEvents: 1_000,
        scope,
        traceId: TRACE_ID,
      }),
    ).resolves.toEqual({ events, status: "found" });
    expect(harness.listByTrace).toHaveBeenCalledWith(scope, TRACE_ID, {
      limit: 1_000,
    });
  });

  it("reports an absent trace without conflating it with an invalid cursor", async () => {
    const harness = repositoryReturning({ cursorFound: true, events: [], hasMore: false });

    await expect(
      readBoundedTraceSnapshot(harness.repository, {
        maximumEvents: 1_000,
        scope,
        traceId: TRACE_ID,
      }),
    ).resolves.toEqual({ status: "not_found" });
  });

  it("discards the partial prefix of a trace above the bound", async () => {
    const events = [envelope("evt_snapshot_a"), envelope("evt_snapshot_b")];
    const harness = repositoryReturning({ cursorFound: true, events, hasMore: true });

    const result = await readBoundedTraceSnapshot(harness.repository, {
      maximumEvents: 2,
      scope,
      traceId: TRACE_ID,
    });

    expect(result).toEqual({ maximumEvents: 2, status: "too_large" });
    expect(result).not.toHaveProperty("events");
    expect(harness.listByTrace).toHaveBeenCalledTimes(1);
  });

  it("fails closed when a cursorless read reports a missing cursor", async () => {
    const harness = repositoryReturning({ cursorFound: false, events: [], hasMore: false });

    await expect(
      readBoundedTraceSnapshot(harness.repository, {
        maximumEvents: 1_000,
        scope,
        traceId: TRACE_ID,
      }),
    ).rejects.toBeInstanceOf(EvidenceRepositoryContractError);
  });

  it("fails closed when a repository returns more events than requested", async () => {
    const harness = repositoryReturning({
      cursorFound: true,
      events: [envelope("evt_snapshot_a"), envelope("evt_snapshot_b")],
      hasMore: false,
    });

    await expect(
      readBoundedTraceSnapshot(harness.repository, {
        maximumEvents: 1,
        scope,
        traceId: TRACE_ID,
      }),
    ).rejects.toBeInstanceOf(EvidenceRepositoryContractError);
  });

  it("fails closed when a repository reports overflow after a short page", async () => {
    const harness = repositoryReturning({
      cursorFound: true,
      events: [envelope("evt_snapshot_partial")],
      hasMore: true,
    });

    await expect(
      readBoundedTraceSnapshot(harness.repository, {
        maximumEvents: 2,
        scope,
        traceId: TRACE_ID,
      }),
    ).rejects.toBeInstanceOf(EvidenceRepositoryContractError);
  });

  it.each([
    { scope: { ...scope, tenantId: "ten_other" } },
    { scope: { ...scope, projectId: "prj_other" } },
    { scope: { ...scope, environmentId: "env_other" } },
    { traceId: "5bf92f3577b34da6a3ce929d0e0e4736" },
  ])("fails closed for an event outside the requested boundary %#", async (override) => {
    const harness = repositoryReturning({
      cursorFound: true,
      events: [
        {
          ...envelope("evt_snapshot_foreign"),
          ...("scope" in override ? { scope: override.scope } : {}),
          evidence: {
            ...envelope("evt_snapshot_foreign").evidence,
            ...("traceId" in override ? { traceId: override.traceId } : {}),
          },
        },
      ],
      hasMore: false,
    });

    await expect(
      readBoundedTraceSnapshot(harness.repository, {
        maximumEvents: 1_000,
        scope,
        traceId: TRACE_ID,
      }),
    ).rejects.toBeInstanceOf(EvidenceRepositoryContractError);
  });

  it.each([
    {
      events: [
        envelope("evt_snapshot_a", { startedAt: "2026-08-28T03:00:00Z" }),
        envelope("evt_snapshot_b", { startedAt: "2026-08-28T02:59:59Z" }),
      ],
      key: "timestamp",
    },
    {
      events: [
        envelope("evt_snapshot_a", { sequence: 1 }),
        envelope("evt_snapshot_b", { sequence: 0 }),
      ],
      key: "sequence",
    },
    {
      events: [envelope("evt_a"), envelope("evt__")],
      key: "event identifier",
    },
  ])("fails closed for noncanonical $key order", async ({ events }) => {
    const harness = repositoryReturning({ cursorFound: true, events, hasMore: false });

    await expect(
      readBoundedTraceSnapshot(harness.repository, {
        maximumEvents: events.length,
        scope,
        traceId: TRACE_ID,
      }),
    ).rejects.toBeInstanceOf(EvidenceRepositoryContractError);
  });

  it("fails closed for duplicate event identifiers", async () => {
    const harness = repositoryReturning({
      cursorFound: true,
      events: [
        envelope("evt_snapshot_duplicate"),
        envelope("evt_snapshot_duplicate", { startedAt: "2026-08-28T03:00:00Z" }),
      ],
      hasMore: false,
    });

    await expect(
      readBoundedTraceSnapshot(harness.repository, {
        maximumEvents: 2,
        scope,
        traceId: TRACE_ID,
      }),
    ).rejects.toBeInstanceOf(EvidenceRepositoryContractError);
  });

  it("wraps an invalid repository ordering key as a contract violation", async () => {
    const harness = repositoryReturning({
      cursorFound: true,
      events: [envelope("evt_snapshot_invalid", { startedAt: "not-an-instant" })],
      hasMore: false,
    });

    await expect(
      readBoundedTraceSnapshot(harness.repository, {
        maximumEvents: 1,
        scope,
        traceId: TRACE_ID,
      }),
    ).rejects.toMatchObject({
      cause: expect.any(TypeError),
      code: "evidence_repository_contract_violation",
    });
  });

  it("does not translate repository failures", async () => {
    const failure = new Error("repository unavailable");
    const listByTrace = vi.fn<EvidenceRepository["listByTrace"]>().mockRejectedValue(failure);
    const repository: EvidenceRepository = {
      append: vi.fn<EvidenceRepository["append"]>(),
      listByTrace,
    };

    await expect(
      readBoundedTraceSnapshot(repository, {
        maximumEvents: 1_000,
        scope,
        traceId: TRACE_ID,
      }),
    ).rejects.toBe(failure);
    expect(listByTrace).toHaveBeenCalledTimes(1);
  });
});
