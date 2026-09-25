import { createHash } from "node:crypto";
import {
  type EvidenceEnvelope,
  EvidenceEnvelopeSchema,
  encodeEvaluationCanonicalJson,
  MAX_FIXTURE_SOURCE_EVENTS,
} from "@proofstack/contracts";
import { describe, expect, it, vi } from "vitest";
import { MemoryEvidenceRepository } from "../testing/memory-evidence-repository.js";
import {
  inspectPolicyEvaluationTrace,
  type PolicyEvaluationTraceReadInput,
  readPolicyEvaluationTrace,
} from "./policy-evaluation-trace-reader.js";

const scope = {
  tenantId: "tenant_trace",
  projectId: "project_trace",
  environmentId: "environment_trace",
};
const traceId = "0123456789abcdef0123456789abcdef";

function event(id = "event_one"): EvidenceEnvelope {
  return EvidenceEnvelopeSchema.parse({
    schemaVersion: "0.1",
    scope,
    receivedAt: "2026-09-07T00:00:00.000Z",
    evidence: {
      eventId: id,
      traceId,
      spanId: "0123456789abcdef",
      kind: "agent.run",
      name: "한글 trace",
      startedAt: "2026-09-06T23:00:00.000Z",
      source: { sdkName: "fixture", sdkVersion: "1.0.0", serviceName: "trace_fixture" },
    },
  });
}

function input(ids = ["event_one"]): PolicyEvaluationTraceReadInput {
  return {
    scope: structuredClone(scope),
    evaluationTime: "2026-09-07T02:00:00.000Z",
    selector: {
      kind: "trace_snapshot",
      traceId,
      capturedAt: "2026-09-07T01:00:00.000Z",
      eventIds: ids,
      observedEventCount: ids.length,
      sourceCompleteness: "observed_snapshot",
    },
  };
}

function digest(value: unknown): string {
  return createHash("sha256").update(encodeEvaluationCanonicalJson(value)).digest("hex");
}

describe("exact policy trace acquisition", () => {
  it("uses only the retained ordered IDs, not a latest trace page or another event", async () => {
    const repository = new MemoryEvidenceRepository();
    await repository.append([event(), event("event_two"), event("event_later")]);
    const exact = vi.spyOn(repository, "resolveExactEvents");
    const pages = vi.spyOn(repository, "listByTrace");
    const query = input(["event_two", "event_one"]);
    const result = await readPolicyEvaluationTrace(query, repository);
    expect(result.events).toEqual([event("event_two"), event()]);
    expect(result.observation).toEqual({
      status: "verified",
      eventsSha256: digest(result.events),
      eventSha256: [digest(event("event_two")), digest(event())],
    });
    expect(exact).toHaveBeenCalledExactlyOnceWith(scope, traceId, query.selector.eventIds);
    expect(pages).not.toHaveBeenCalled();
    expect(result).toEqual(inspectPolicyEvaluationTrace(query, result.events));
  });

  it("hashes complete envelopes including receipts and retains defensive copies", async () => {
    const body = event();
    const query = input();
    const repository = { resolveExactEvents: vi.fn(async () => [body]) };
    const first = await readPolicyEvaluationTrace(query, repository);
    body.receivedAt = "2026-09-07T00:30:00.000Z";
    query.selector.eventIds[0] = "event_changed";
    const second = inspectPolicyEvaluationTrace(input(), [body]);
    expect(first.observation).not.toEqual(second.observation);
    expect(first.events).toEqual([event()]);
    expect(first.selector.eventIds).toEqual(["event_one"]);
    expect(first.scope).not.toBe(scope);
  });

  it("owns scope, selector and time before the port can mutate its arguments or original input", async () => {
    const query = input();
    const repository = {
      resolveExactEvents: vi.fn(async (passedScope, _trace, ids) => {
        passedScope.tenantId = "tenant_changed";
        ids[0] = "event_changed";
        query.scope.projectId = "project_changed";
        query.selector.capturedAt = "2020-01-01T00:00:00.000Z";
        Object.assign(query, { evaluationTime: "2020-01-01T00:00:00.000Z" });
        return [event()];
      }),
    };
    const result = await readPolicyEvaluationTrace(query, repository);
    expect(result.observation.status).toBe("verified");
    expect(result.scope).toEqual(scope);
    expect(result.selector).toEqual(input().selector);
  });

  it("keeps authoritative absence distinct from an invalid empty or partial response", async () => {
    const repository = new MemoryEvidenceRepository();
    const result = await readPolicyEvaluationTrace(input(), repository);
    expect(result).toMatchObject({ events: null, observation: { status: "missing" } });
    for (const raw of [[], [event()]]) {
      const query = input(["event_one", "event_two"]);
      expect(inspectPolicyEvaluationTrace(query, raw)).toMatchObject({
        events: null,
        observation: { status: "unavailable", reason: "reference_mismatch" },
      });
    }
  });

  it.each([
    undefined,
    {},
    "events",
    [null],
    [{ ...event(), unknown: undefined }],
    [{ ...event(), receivedAt: "invalid" }],
  ])("does not turn malformed response %j into absence", (raw) => {
    expect(inspectPolicyEvaluationTrace(input(), raw)).toMatchObject({
      events: null,
      observation: { status: "unavailable", reason: "record_invalid" },
    });
  });

  it.each(["tenantId", "projectId", "environmentId", "traceId", "eventId"] as const)(
    "rejects substituted %s without retaining out-of-scope bodies",
    (key) => {
      const body = event();
      if (key === "traceId") body.evidence.traceId = "abcdef0123456789abcdef0123456789";
      else if (key === "eventId") body.evidence.eventId = "event_other";
      else body.scope[key] = "other_scope";
      expect(inspectPolicyEvaluationTrace(input(), [body])).toMatchObject({
        events: null,
        observation: { status: "unavailable", reason: "reference_mismatch" },
      });
    },
  );

  it("rejects duplicated, reordered and extra records instead of sorting or truncating them", () => {
    for (const events of [
      [event(), event()],
      [event("event_two"), event()],
      [event(), event("event_two"), event("extra")],
    ]) {
      expect(inspectPolicyEvaluationTrace(input(["event_one", "event_two"]), events)).toMatchObject(
        { events: null, observation: { status: "unavailable", reason: "reference_mismatch" } },
      );
    }
  });

  it("rejects a future selector before any evidence lookup", async () => {
    const query = input();
    query.selector.capturedAt = "2026-09-08T00:00:00.000Z";
    const repository = { resolveExactEvents: vi.fn(async () => [event()]) };
    expect(await readPolicyEvaluationTrace(query, repository)).toMatchObject({
      events: null,
      observation: { status: "unavailable", reason: "not_yet_available" },
    });
    expect(repository.resolveExactEvents).not.toHaveBeenCalled();
  });

  it.each([
    ["2026-09-07T03:00:00.000Z", "not_yet_available"],
    ["2026-09-07T01:00:00.000000000000000000000000000001Z", "snapshot_cut_mismatch"],
  ])("preserves receipt boundary %s", (receivedAt, reason) => {
    expect(inspectPolicyEvaluationTrace(input(), [{ ...event(), receivedAt }])).toMatchObject({
      events: null,
      observation: { status: "unavailable", reason },
    });
  });

  it("compares offset timestamps at full precision instead of database microsecond rounding", () => {
    const query = input();
    query.selector.capturedAt = "2026-09-07T01:00:00.000000000000000000000000000001+01:00";
    Object.assign(query, { evaluationTime: "2026-09-07T00:00:00.000000000000000000000000000002Z" });
    const equal = { ...event(), receivedAt: "2026-09-07T00:00:00.000000000000000000000000000001Z" };
    expect(inspectPolicyEvaluationTrace(query, [equal]).observation.status).toBe("verified");
    expect(
      inspectPolicyEvaluationTrace(query, [{ ...equal, receivedAt: query.evaluationTime }])
        .observation,
    ).toEqual({ status: "unavailable", reason: "snapshot_cut_mismatch" });
  });

  it("validates before omitting permitted optional undefined fields", () => {
    const body = event();
    body.evidence.endedAt = undefined;
    expect(inspectPolicyEvaluationTrace(input(), [body])).toEqual(
      inspectPolicyEvaluationTrace(input(), [event()]),
    );
    Object.assign(body.evidence, { unknown: undefined });
    expect(inspectPolicyEvaluationTrace(input(), [body]).observation).toEqual({
      status: "unavailable",
      reason: "record_invalid",
    });
  });

  it.each(["extra", "scope", "time", "selector", "duplicates", "count", "limit"])(
    "rejects %s input before I/O",
    async (kind) => {
      const query = input();
      if (kind === "extra") Object.assign(query, { authority: true });
      if (kind === "scope") Object.assign(query.scope, { unknown: true });
      if (kind === "time") Object.assign(query, { evaluationTime: "2026-09-07T02:00:00+00:00" });
      if (kind === "selector") Object.assign(query.selector, { kind: "latest" });
      if (kind === "duplicates") query.selector.eventIds = ["event_one", "event_one"];
      if (kind === "count") query.selector.observedEventCount = 2;
      if (kind === "limit")
        query.selector.eventIds = Array.from(
          { length: MAX_FIXTURE_SOURCE_EVENTS + 1 },
          (_, i) => `event_${i}`,
        );
      const repository = { resolveExactEvents: vi.fn(async () => null) };
      await expect(readPolicyEvaluationTrace(query, repository)).rejects.toMatchObject({
        code: "policy_evaluation_trace_read_input_invalid",
      });
      expect(repository.resolveExactEvents).not.toHaveBeenCalled();
    },
  );

  it("propagates operational and unexpected inspection failures", async () => {
    const failure = new Error("storage unavailable");
    await expect(
      readPolicyEvaluationTrace(input(), {
        resolveExactEvents: async () => {
          throw failure;
        },
      }),
    ).rejects.toBe(failure);
    const body = Object.defineProperty(event(), "evidence", {
      get() {
        throw failure;
      },
    });
    expect(() => inspectPolicyEvaluationTrace(input(), [body])).toThrow(failure);
  });
});
