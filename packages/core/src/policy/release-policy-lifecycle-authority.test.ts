import type {
  PrincipalContext,
  PublishReleasePolicyLifecycleRequest,
  ReleasePolicyLifecycleEvent,
} from "@proofstack/contracts";
import { describe, expect, it, vi } from "vitest";
import { ForbiddenError } from "../errors.js";
import { createReleasePolicyRepositoryTestHarness } from "../testing/release-policy-repository-fixtures.js";
import {
  PublishReleasePolicyLifecycle,
  ReadReleasePolicy,
  ReadReleasePolicyLifecycle,
} from "./record-release-policy.js";
import {
  ReleasePolicyLifecycleEventConflictError,
  ReleasePolicyRepositoryContractError,
} from "./release-policy-errors.js";

const kinds = ["withdrawn", "superseded"] as const;

async function setup(kind: ReleasePolicyLifecycleEvent["kind"]) {
  const harness = createReleasePolicyRepositoryTestHarness("lifecycle_authority");
  await harness.repository.publishReleasePolicy(harness.policy);
  if (kind === "superseded") await harness.repository.publishReleasePolicy(harness.successor);
  const principal: PrincipalContext = {
    authentication: { authenticatedAt: "2028-01-01T00:00:00.000Z", method: "development" },
    capabilities: ["policy:author", "policy:read"],
    principalId: "principal_current_operator",
    principalType: "user",
    requestId: "request_lifecycle_authority",
    resourceScope: {
      mode: "restricted",
      projects: [
        { projectId: harness.scope.projectId, environmentIds: [harness.scope.environmentId] },
      ],
    },
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
  const input: PublishReleasePolicyLifecycleRequest = {
    eventId: "policy_event_authority",
    reason: "A current scoped operator records the end of this immutable policy version.",
    ...(kind === "superseded"
      ? { kind, successorPolicyVersionId: harness.successor.policyVersionId }
      : { kind }),
  };
  const now = vi.fn(() => new Date("2028-01-01T00:00:00.000Z"));
  const publisher = new PublishReleasePolicyLifecycle({
    clock: { now },
    repository: harness.repository,
  });
  return { ...harness, command: { ...route, input }, now, publisher, route };
}

describe("release policy lifecycle actor authority", () => {
  it.each(kinds)(
    "allows an accountable replacement actor to record %s after expiry",
    async (kind) => {
      const value = await setup(kind);
      expect(Date.parse(value.policy.expiresAt)).toBeLessThan(value.now().getTime());
      expect(value.route.principal.principalId).not.toBe(value.policy.publishedByPrincipalId);
      const first = await value.publisher.execute(value.command);
      expect(first).toMatchObject({
        created: true,
        event: { actorPrincipalId: value.route.principal.principalId, kind },
      });
      value.now.mockImplementation(() => {
        throw new Error("An exact historical retry must not refresh the receipt clock");
      });
      await expect(value.publisher.execute(value.command)).resolves.toEqual({
        created: false,
        event: first.event,
      });
      await expect(new ReadReleasePolicy(value.repository).execute(value.route)).resolves.toEqual(
        value.policy,
      );
      await expect(
        new ReadReleasePolicyLifecycle(value.repository).execute({
          ...value.route,
          eventId: first.event.eventId,
        }),
      ).resolves.toEqual(first.event);
      await expect(
        value.publisher.execute({
          ...value.command,
          principal: { ...value.route.principal, principalId: value.policy.publishedByPrincipalId },
        }),
      ).rejects.toBeInstanceOf(ReleasePolicyLifecycleEventConflictError);
      expect(
        await value.repository.listReleasePolicyLifecycleEvents(
          value.scope,
          value.policy.policyVersionId,
        ),
      ).toEqual([first.event]);
    },
  );

  it.each(["read_only", "workload", "other_project", "other_environment"] as const)(
    "rejects %s mutation authority before a terminal-event retry touches storage",
    async (denial) => {
      const value = await setup("withdrawn");
      await value.publisher.execute(value.command);
      const denied = structuredClone(value.route.principal);
      if (denial === "read_only") denied.capabilities = ["policy:read"];
      if (denial === "workload") denied.principalType = "workload";
      if (denial === "other_project") {
        denied.resourceScope = { mode: "restricted", projects: [{ projectId: "project_other" }] };
      }
      if (denial === "other_environment") {
        denied.resourceScope = {
          mode: "restricted",
          projects: [{ projectId: value.scope.projectId, environmentIds: ["env_other"] }],
        };
      }
      const methods = [
        "findReleasePolicy",
        "findReleasePolicyLifecycleEvent",
        "listReleasePolicyLifecycleEvents",
        "publishReleasePolicy",
        "publishReleasePolicyLifecycleEvent",
      ] as const;
      const storage = methods.map((method) => vi.spyOn(value.repository, method));
      value.now.mockClear();
      await expect(
        value.publisher.execute({ ...value.command, principal: denied }),
      ).rejects.toBeInstanceOf(ForbiddenError);
      expect(value.now).not.toHaveBeenCalled();
      for (const spy of storage) expect(spy).not.toHaveBeenCalled();
    },
  );

  it.each(kinds.flatMap((kind) => [false, true].map((sameActor) => ({ kind, sameActor }))))(
    "preserves the first $kind receipt under a concurrent sameActor=$sameActor retry",
    async ({ kind, sameActor }) => {
      const value = await setup(kind);
      const list = value.repository.listReleasePolicyLifecycleEvents.bind(value.repository);
      const arrivals: Array<() => void> = [];
      const listSpy = vi
        .spyOn(value.repository, "listReleasePolicyLifecycleEvents")
        .mockImplementation(async (...args) => {
          const history = await list(...args);
          await new Promise<void>((resolve) => {
            arrivals.push(resolve);
            if (arrivals.length === 2) for (const release of arrivals) release();
          });
          return history;
        });
      const second = {
        ...value.command,
        principal: {
          ...value.route.principal,
          principalId: sameActor ? value.route.principal.principalId : "principal_second_operator",
        },
      };
      const commands = [value.command, second];
      const outcomes = await Promise.allSettled(
        commands.map((command) => value.publisher.execute(command)),
      );
      listSpy.mockRestore();
      const winner = outcomes.find(
        (outcome) => outcome.status === "fulfilled" && outcome.value.created,
      );
      if (winner?.status !== "fulfilled") throw new Error("Expected one winning receipt");
      expect(
        outcomes.filter((outcome) => outcome.status === "fulfilled" && outcome.value.created),
      ).toHaveLength(1);
      if (sameActor) {
        expect(outcomes).toEqual(
          expect.arrayContaining([
            { status: "fulfilled", value: { created: true, event: winner.value.event } },
            { status: "fulfilled", value: { created: false, event: winner.value.event } },
          ]),
        );
      } else {
        const rejected = outcomes.find((outcome) => outcome.status === "rejected");
        expect(rejected?.reason).toBeInstanceOf(ReleasePolicyLifecycleEventConflictError);
        const losingCommand =
          commands[outcomes.findIndex((outcome) => outcome.status === "rejected")];
        if (!losingCommand) throw new Error("Expected one losing actor");
        await expect(value.publisher.execute(losingCommand)).rejects.toBeInstanceOf(
          ReleasePolicyLifecycleEventConflictError,
        );
      }
      expect(await list(value.scope, value.policy.policyVersionId)).toEqual([winner.value.event]);
    },
  );

  it.each(["new_actor", "existing_early_time", "existing_wrong_digest"] as const)(
    "does not relabel a %s receipt substitution as an actor conflict",
    async (fault) => {
      const value = await setup("withdrawn");
      vi.spyOn(value.repository, "publishReleasePolicyLifecycleEvent").mockImplementation(
        async (event) => ({
          created: fault === "new_actor",
          event: {
            ...event,
            actorPrincipalId: "principal_substituted_actor",
            ...(fault === "existing_early_time" ? { occurredAt: "2020-01-01T00:00:00.000Z" } : {}),
            ...(fault === "existing_wrong_digest"
              ? { policy: { ...event.policy, definitionSha256: "f".repeat(64) } }
              : {}),
          },
        }),
      );
      await expect(value.publisher.execute(value.command)).rejects.toBeInstanceOf(
        ReleasePolicyRepositoryContractError,
      );
      expect(
        await value.repository.listReleasePolicyLifecycleEvents(
          value.scope,
          value.policy.policyVersionId,
        ),
      ).toEqual([]);
    },
  );
});
