import { createHash } from "node:crypto";
import {
  encodeEvaluationCanonicalJson,
  type ReleasePolicyLifecycleEvent,
} from "@proofstack/contracts";
import { describe, expect, it, vi } from "vitest";
import { MemoryReleasePolicyRepository } from "../testing/memory-release-policy-repository.js";
import {
  releasePolicyFixtureScope,
  releasePolicyLifecycleFixture,
  releasePolicyRepositoryFixture,
} from "../testing/release-policy-repository-fixtures.js";
import {
  inspectPolicyEvaluationControlRecord,
  type PolicyEvaluationControlRead,
} from "./policy-evaluation-control-record-reader.js";
import { readPolicyEvaluationLifecycle } from "./policy-evaluation-lifecycle-reader.js";
import { ReleasePolicyRepositoryContractError } from "./release-policy-errors.js";
import { releasePolicyReference } from "./release-policy-record-validation.js";

const evaluationTime = "2026-10-01T00:00:00.000Z";
const observedAt = "2026-10-01T02:00:00.000Z";
const digest = (record: unknown) =>
  createHash("sha256").update(encodeEvaluationCanonicalJson(record)).digest("hex");

async function fixture() {
  const scope = releasePolicyFixtureScope("lifecycle_reader");
  const policy = releasePolicyRepositoryFixture("lifecycle_reader", scope);
  const successor = releasePolicyRepositoryFixture("lifecycle_reader", scope, {
    predecessor: releasePolicyReference(policy),
    semanticVersion: "2.0.0",
    publishedAt: "2026-09-30T23:00:00.000Z",
  });
  const repository = new MemoryReleasePolicyRepository();
  await repository.publishReleasePolicy(policy);
  await repository.publishReleasePolicy(successor);
  const input = { scope, evaluationTime, policy: releasePolicyReference(policy) };
  const read = inspectPolicyEvaluationControlRecord(
    { scope, evaluationTime, source: { kind: "release_policy", reference: input.policy } },
    policy,
  );
  const history = vi.spyOn(repository, "listReleasePolicyLifecycleEvents");
  const find = vi.spyOn(repository, "findReleasePolicy");
  const clock = { now: vi.fn(() => new Date(observedAt)) };
  const event = (kind: "withdrawn" | "superseded" = "withdrawn") =>
    releasePolicyLifecycleFixture(
      "lifecycle_reader",
      policy,
      kind === "withdrawn"
        ? { occurredAt: evaluationTime }
        : { kind, successor, occurredAt: evaluationTime },
    );
  const run = (captured: PolicyEvaluationControlRead = read) =>
    readPolicyEvaluationLifecycle(input, captured, repository, clock);
  return { scope, policy, successor, input, read, repository, history, find, clock, event, run };
}

describe("owning policy lifecycle reader", () => {
  it("retains an explicit empty observation bound to the exact original record", async () => {
    const h = await fixture();
    const result = await h.run();
    expect(result).toMatchObject({
      policy: h.input.policy,
      scope: h.scope,
      policyRecordSha256: digest(h.policy),
      state: "no_terminal_event_at_evaluation",
      history: [],
    });
    expect(h.history).toHaveBeenCalledExactlyOnceWith(h.scope, h.policy.policyVersionId);
    expect(h.find).not.toHaveBeenCalled();
  });

  for (const kind of ["withdrawn", "superseded"] as const) {
    it.each([
      ["2026-09-30T23:59:59.999999999999999999999999999999Z", "no_terminal_event_at_evaluation"],
      [evaluationTime, `${kind}_at_evaluation`],
      ["2026-10-01T00:00:00.000000000000000000000000000001Z", `${kind}_at_evaluation`],
    ])(`${kind} preserves exact evaluation edge %s`, async (at, state) => {
      const h = await fixture();
      const event = h.event(kind);
      await h.repository.publishReleasePolicyLifecycleEvent(event);
      h.input.evaluationTime = at;
      const result = await h.run();
      expect(result.state).toBe(state);
      expect(result.history[0]).toEqual({
        record: event,
        recordSha256: digest(event),
        successor:
          kind === "withdrawn" ? null : { record: h.successor, recordSha256: digest(h.successor) },
      });
    });
  }

  it.each(["missing", "source", "hash", "record", "scope"])(
    "rejects inconsistent captured %s before history I/O",
    async (kind) => {
      const h = await fixture();
      if (h.read.observation.status !== "verified") throw new Error("Expected verified fixture");
      let read = structuredClone(h.read);
      if (kind === "missing")
        read = { source: read.source, record: null, observation: { status: "missing" } };
      else if (kind === "source") read.source.reference.definitionSha256 = "f".repeat(64);
      else if (kind === "hash" && read.observation.status === "verified")
        read = {
          source: h.read.source,
          record: h.policy,
          observation: { status: "verified", recordSha256: "f".repeat(64) },
        };
      else if (kind === "record" && read.record) Object.assign(read.record, { extra: undefined });
      else h.input.scope.projectId = "other_project";
      await expect(h.run(read)).rejects.toBeInstanceOf(ReleasePolicyRepositoryContractError);
      expect(h.history).not.toHaveBeenCalled();
    },
  );

  it.each([null, undefined, {}, [null], [{ unknown: true }]])(
    "rejects malformed complete history %j",
    async (input) => {
      const h = await fixture();
      h.history.mockResolvedValue(input as unknown as ReleasePolicyLifecycleEvent[]);
      await expect(h.run()).rejects.toBeInstanceOf(ReleasePolicyRepositoryContractError);
    },
  );

  it.each(["duplicate", "scope", "reference", "early", "future"])(
    "rejects %s history",
    async (kind) => {
      const h = await fixture();
      const event = h.event();
      if (kind === "scope") event.scope.tenantId = "tenant_other";
      if (kind === "reference") event.policy.definitionSha256 = "f".repeat(64);
      if (kind === "early") event.occurredAt = "2026-09-01T00:00:00.000Z";
      if (kind === "future") event.occurredAt = "2026-10-01T02:00:00.001Z";
      h.history.mockResolvedValue(kind === "duplicate" ? [event, event] : [event]);
      await expect(h.run()).rejects.toBeInstanceOf(ReleasePolicyRepositoryContractError);
    },
  );

  it.each([
    "missing",
    "invalid",
    "reference",
    "predecessor",
    "no_predecessor",
    "scope",
    "early_event",
  ])("rejects successor %s", async (kind) => {
    const h = await fixture();
    const event = h.event("superseded");
    if (event.kind !== "superseded") throw new Error("Expected supersession");
    const successor = releasePolicyRepositoryFixture(
      "lifecycle_reader",
      kind === "scope" ? { ...h.scope, projectId: "project_other" } : h.scope,
      {
        semanticVersion: "2.0.0",
        publishedAt:
          kind === "early_event" ? "2026-10-01T00:00:00.001Z" : "2026-09-30T23:00:00.000Z",
        ...(kind === "no_predecessor"
          ? {}
          : {
              predecessor:
                kind === "predecessor"
                  ? { ...h.input.policy, definitionSha256: "e".repeat(64) }
                  : h.input.policy,
            }),
      },
    );
    event.successor = releasePolicyReference(successor);
    if (kind === "invalid") successor.definitionSha256 = "e".repeat(64);
    if (kind === "reference") event.successor.definitionSha256 = "f".repeat(64);
    h.history.mockResolvedValue([event]);
    h.find.mockResolvedValue(kind === "missing" ? null : successor);
    await expect(h.run()).rejects.toBeInstanceOf(ReleasePolicyRepositoryContractError);
  });

  it("does not query before the semantic time", async () => {
    const h = await fixture();
    h.input.evaluationTime = "2026-10-01T02:00:00.000000000000000000000000000001Z";
    await expect(h.run()).rejects.toBeInstanceOf(ReleasePolicyRepositoryContractError);
    expect(h.history).not.toHaveBeenCalled();
  });

  it.each(["history", "successor"])("preserves %s storage failures", async (source) => {
    const h = await fixture();
    const failure = new Error("repository failure");
    if (source === "history") h.history.mockRejectedValue(failure);
    else {
      h.history.mockResolvedValue([h.event("superseded")]);
      h.find.mockRejectedValue(failure);
    }
    await expect(h.run()).rejects.toBe(failure);
  });

  it("owns the input context across a mutating repository read", async () => {
    const h = await fixture();
    const expected = structuredClone(h.input);
    h.history.mockImplementation(async (scope) => {
      scope.projectId = "changed_argument";
      h.input.scope.tenantId = "changed_input";
      h.input.policy.policyVersionId = "changed_version";
      h.input.evaluationTime = "2028-01-01T00:00:00.000Z";
      return [];
    });
    expect(await h.run()).toMatchObject({
      scope: expected.scope,
      policy: expected.policy,
      evaluationTime: expected.evaluationTime,
    });
  });
});
