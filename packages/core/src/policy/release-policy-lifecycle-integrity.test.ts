import type { PrincipalContext, ReleasePolicyLifecycleEvent } from "@proofstack/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  createReleasePolicyRepositoryTestHarness,
  releasePolicyRepositoryFixture,
} from "../testing/release-policy-repository-fixtures.js";
import {
  PublishReleasePolicyLifecycle,
  ReadReleasePolicyLifecycle,
} from "./record-release-policy.js";
import { ReleasePolicyRepositoryContractError } from "./release-policy-errors.js";

type LifecycleKind = ReleasePolicyLifecycleEvent["kind"];

async function setup(kind: LifecycleKind, occurredAt?: string) {
  const harness = createReleasePolicyRepositoryTestHarness("history_integrity");
  await harness.repository.publishReleasePolicy(harness.policy);
  await harness.repository.publishReleasePolicy(harness.successor);
  const event = {
    ...(kind === "withdrawn" ? harness.withdrawal : harness.supersession),
    ...(occurredAt ? { occurredAt } : {}),
  };
  await harness.repository.publishReleasePolicyLifecycleEvent(event);
  const principal: PrincipalContext = {
    authentication: { authenticatedAt: "2026-09-07T00:00:00.000Z", method: "development" },
    capabilities: ["policy:author", "policy:read"],
    principalId: event.actorPrincipalId,
    principalType: "user",
    requestId: "request_policy_history_integrity",
    resourceScope: { mode: "tenant" },
    roles: ["admin"],
    tenantId: harness.scope.tenantId,
  };
  const route = {
    environmentId: harness.scope.environmentId,
    policyId: harness.policy.policyId,
    policyVersionId: harness.policy.policyVersionId,
    principal,
    projectId: harness.scope.projectId,
  };
  const input =
    event.kind === "superseded"
      ? {
          eventId: event.eventId,
          kind: event.kind,
          reason: event.reason,
          successorPolicyVersionId: event.successor.policyVersionId,
        }
      : { eventId: event.eventId, kind: event.kind, reason: event.reason };
  const now = vi.fn(() => new Date("2026-09-07T04:00:00.000Z"));
  const publish = vi.spyOn(harness.repository, "publishReleasePolicyLifecycleEvent");
  const publisher = new PublishReleasePolicyLifecycle({
    clock: { now },
    repository: harness.repository,
  });
  const reader = new ReadReleasePolicyLifecycle(harness.repository);
  return { ...harness, event, input, now, publish, publisher, reader, route };
}

const timeBoundaries = [
  { kind: "withdrawn", name: "withdrawal before target", receipt: "policy" },
  { kind: "superseded", name: "supersession before target", receipt: "policy" },
  { kind: "superseded", name: "supersession before successor", receipt: "successor" },
] as const;

describe("retained release policy lifecycle integrity", () => {
  it.each(timeBoundaries)(
    "rejects $name on reads, retries, and history",
    async ({ kind, receipt }) => {
      const value = await setup(kind);
      const corrupt = {
        ...value.event,
        occurredAt: new Date(Date.parse(value[receipt].publishedAt) - 1).toISOString(),
      };
      const find = vi
        .spyOn(value.repository, "findReleasePolicyLifecycleEvent")
        .mockResolvedValue(corrupt);

      await expect(
        value.reader.execute({ ...value.route, eventId: value.event.eventId }),
      ).rejects.toBeInstanceOf(ReleasePolicyRepositoryContractError);
      await expect(
        value.publisher.execute({ ...value.route, input: value.input }),
      ).rejects.toBeInstanceOf(ReleasePolicyRepositoryContractError);

      find.mockResolvedValue(null);
      vi.spyOn(value.repository, "listReleasePolicyLifecycleEvents").mockResolvedValue([corrupt]);
      await expect(
        value.publisher.execute({ ...value.route, input: value.input }),
      ).rejects.toBeInstanceOf(ReleasePolicyRepositoryContractError);
      expect(value.now).not.toHaveBeenCalled();
      expect(value.publish).not.toHaveBeenCalled();
    },
  );

  it.each(timeBoundaries)(
    "rejects $name returned by a concurrent publication winner",
    async ({ kind, receipt }) => {
      const value = await setup(kind);
      vi.spyOn(value.repository, "findReleasePolicyLifecycleEvent").mockResolvedValue(null);
      vi.spyOn(value.repository, "listReleasePolicyLifecycleEvents").mockResolvedValue([]);
      value.publish.mockResolvedValue({
        created: false,
        event: {
          ...value.event,
          occurredAt: new Date(Date.parse(value[receipt].publishedAt) - 1).toISOString(),
        },
      });

      await expect(
        value.publisher.execute({ ...value.route, input: value.input }),
      ).rejects.toBeInstanceOf(ReleasePolicyRepositoryContractError);
      expect(value.publish).toHaveBeenCalledOnce();
    },
  );

  it.each(["missing", "wrong_digest", "wrong_predecessor"] as const)(
    "rejects a %s successor on exact reads and retained history",
    async (fault) => {
      const value = await setup("superseded");
      if (value.event.kind !== "superseded") throw new Error("Expected supersession fixture");
      const originalFind = value.repository.findReleasePolicy.bind(value.repository);
      let successor = value.successor;
      if (fault === "wrong_predecessor") {
        successor = releasePolicyRepositoryFixture("history_integrity", value.scope, {
          policyVersionId: value.successor.policyVersionId,
          predecessor: {
            definitionSha256: "e".repeat(64),
            policyId: value.policy.policyId,
            policyVersionId: "policy_other_predecessor",
          },
          publishedAt: value.successor.publishedAt,
          semanticVersion: value.successor.semanticVersion,
        });
      }
      vi.spyOn(value.repository, "findReleasePolicy").mockImplementation(
        async (scope, versionId) =>
          versionId === value.successor.policyVersionId
            ? fault === "missing"
              ? null
              : successor
            : originalFind(scope, versionId),
      );
      const corrupt = {
        ...value.event,
        successor: {
          ...value.event.successor,
          definitionSha256: fault === "wrong_digest" ? "f".repeat(64) : successor.definitionSha256,
        },
      };
      const find = vi
        .spyOn(value.repository, "findReleasePolicyLifecycleEvent")
        .mockResolvedValue(corrupt);
      await expect(
        value.reader.execute({ ...value.route, eventId: value.event.eventId }),
      ).rejects.toBeInstanceOf(ReleasePolicyRepositoryContractError);
      await expect(
        value.publisher.execute({ ...value.route, input: value.input }),
      ).rejects.toBeInstanceOf(ReleasePolicyRepositoryContractError);

      find.mockResolvedValue(null);
      vi.spyOn(value.repository, "listReleasePolicyLifecycleEvents").mockResolvedValue([corrupt]);
      await expect(
        value.publisher.execute({ ...value.route, input: value.input }),
      ).rejects.toBeInstanceOf(ReleasePolicyRepositoryContractError);
      expect(value.now).not.toHaveBeenCalled();
      expect(value.publish).not.toHaveBeenCalled();
    },
  );

  it("rejects multiple terminal events even when every event is individually valid", async () => {
    const value = await setup("withdrawn");
    vi.spyOn(value.repository, "findReleasePolicyLifecycleEvent").mockResolvedValue(null);
    vi.spyOn(value.repository, "listReleasePolicyLifecycleEvents").mockResolvedValue([
      value.event,
      {
        ...value.event,
        eventId: "policy_event_second_terminal",
        occurredAt: "2026-09-07T03:01:00.000Z",
      },
    ]);
    await expect(
      value.publisher.execute({ ...value.route, input: value.input }),
    ).rejects.toBeInstanceOf(ReleasePolicyRepositoryContractError);
    expect(value.now).not.toHaveBeenCalled();
    expect(value.publish).not.toHaveBeenCalled();
  });

  it.each(["withdrawn", "superseded"] as const)(
    "preserves the exact %s receipt on reads, retries, and stale-read races",
    async (kind) => {
      const occurredAt =
        kind === "withdrawn" ? "2026-09-07T01:00:00.000Z" : "2026-09-07T02:00:00.000Z";
      const value = await setup(kind, occurredAt);
      await expect(
        value.reader.execute({ ...value.route, eventId: value.event.eventId }),
      ).resolves.toEqual(value.event);
      await expect(
        value.publisher.execute({ ...value.route, input: value.input }),
      ).resolves.toEqual({ created: false, event: value.event });
      expect(value.now).not.toHaveBeenCalled();
      expect(value.publish).not.toHaveBeenCalled();

      vi.spyOn(value.repository, "findReleasePolicyLifecycleEvent").mockResolvedValue(null);
      vi.spyOn(value.repository, "listReleasePolicyLifecycleEvents").mockResolvedValue([]);
      await expect(
        value.publisher.execute({ ...value.route, input: value.input }),
      ).resolves.toEqual({ created: false, event: value.event });
      expect(value.publish).toHaveBeenCalledOnce();
      expect(value.now).toHaveBeenCalledOnce();
    },
  );
});
