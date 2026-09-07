import type {
  EvidenceScope,
  PrincipalContext,
  PublishReleasePolicyLifecycleRequest,
  PublishReleasePolicyRequest,
  ReleasePolicy,
  ReleasePolicyLifecycleEvent,
} from "@proofstack/contracts";
import { RELEASE_POLICY_LIFECYCLE_SCHEMA_VERSION } from "@proofstack/contracts";
import { describe, expect, it, vi } from "vitest";
import { ForbiddenError } from "../errors.js";
import {
  type PolicyAuthorityFixtureOptions,
  policyAuthorityFixture,
} from "../testing/release-policy-fixtures.js";
import {
  PublishReleasePolicy,
  PublishReleasePolicyLifecycle,
  ReadReleasePolicy,
  ReadReleasePolicyLifecycle,
} from "./record-release-policy.js";
import type { ReleasePolicyAuthorityEvidenceResolver } from "./release-policy-authority-resolver.js";
import {
  InvalidReleasePolicyCommandError,
  ReleasePolicyAuthorityRejectedError,
  ReleasePolicyAuthorityResolverContractError,
  ReleasePolicyLifecycleEventConflictError,
  ReleasePolicyLifecycleEventNotFoundError,
  ReleasePolicyLifecycleStateConflictError,
  ReleasePolicyLineageError,
  ReleasePolicyNotFoundError,
  ReleasePolicyRepositoryContractError,
  ReleasePolicyVersionConflictError,
} from "./release-policy-errors.js";
import type { ReleasePolicyRepository } from "./release-policy-repository.js";

function clone<Value>(value: Value): Value {
  return structuredClone(value);
}

function principal(
  tenantId: string,
  capabilities: PrincipalContext["capabilities"] = ["policy:author", "policy:read"],
  principalType: PrincipalContext["principalType"] = "user",
): PrincipalContext {
  return {
    authentication: { authenticatedAt: "2026-09-06T22:00:00.000Z", method: "development" },
    capabilities,
    principalId: "principal_policy_author",
    principalType,
    requestId: "request_release_policy_test",
    resourceScope: { mode: "tenant" },
    roles: ["admin"],
    tenantId,
  };
}

function publishInput(policy: ReleasePolicy): PublishReleasePolicyRequest {
  const request = clone(policy) as unknown as Record<string, unknown>;
  for (const key of [
    "definitionSha256",
    "issuerPrincipalId",
    "policyId",
    "predecessor",
    "publishedAt",
    "publishedByPrincipalId",
    "schemaVersion",
    "scope",
  ] as const) {
    Reflect.deleteProperty(request, key);
  }
  if (policy.predecessor) {
    Reflect.set(request, "predecessorVersionId", policy.predecessor.policyVersionId);
  }
  return request as PublishReleasePolicyRequest;
}

function memoryPort() {
  const policies = new Map<string, ReleasePolicy>();
  const events = new Map<string, ReleasePolicyLifecycleEvent>();
  const findReleasePolicy = vi.fn<ReleasePolicyRepository["findReleasePolicy"]>(
    async (scope, policyVersionId) => {
      const policy = policies.get(policyVersionId);
      return policy && sameScope(policy.scope, scope) ? clone(policy) : null;
    },
  );
  const findReleasePolicyLifecycleEvent = vi.fn<
    ReleasePolicyRepository["findReleasePolicyLifecycleEvent"]
  >(async (scope, eventId) => {
    const event = events.get(eventId);
    return event && sameScope(event.scope, scope) ? clone(event) : null;
  });
  const listReleasePolicyLifecycleEvents = vi.fn<
    ReleasePolicyRepository["listReleasePolicyLifecycleEvents"]
  >(async (scope, policyVersionId) =>
    [...events.values()]
      .filter(
        (event) =>
          sameScope(event.scope, scope) && event.policy.policyVersionId === policyVersionId,
      )
      .sort((left, right) =>
        `${left.occurredAt}:${left.eventId}`.localeCompare(`${right.occurredAt}:${right.eventId}`),
      )
      .map(clone),
  );
  const publishReleasePolicy = vi.fn<ReleasePolicyRepository["publishReleasePolicy"]>(
    async (policy) => {
      const existing = policies.get(policy.policyVersionId);
      if (existing) return { created: false, policy: clone(existing) };
      policies.set(policy.policyVersionId, clone(policy));
      return { created: true, policy: clone(policy) };
    },
  );
  const publishReleasePolicyLifecycleEvent = vi.fn<
    ReleasePolicyRepository["publishReleasePolicyLifecycleEvent"]
  >(async (event) => {
    const existing = events.get(event.eventId);
    if (existing) return { created: false, event: clone(existing) };
    events.set(event.eventId, clone(event));
    return { created: true, event: clone(event) };
  });
  const repository: ReleasePolicyRepository = {
    findReleasePolicy,
    findReleasePolicyLifecycleEvent,
    listReleasePolicyLifecycleEvents,
    publishReleasePolicy,
    publishReleasePolicyLifecycleEvent,
  };
  return {
    events,
    findReleasePolicy,
    findReleasePolicyLifecycleEvent,
    listReleasePolicyLifecycleEvents,
    policies,
    publishReleasePolicy,
    publishReleasePolicyLifecycleEvent,
    repository,
  };
}

function sameScope(left: EvidenceScope, right: EvidenceScope): boolean {
  return (
    left.tenantId === right.tenantId &&
    left.projectId === right.projectId &&
    left.environmentId === right.environmentId
  );
}

function setup(options: PolicyAuthorityFixtureOptions = {}) {
  const fixture = policyAuthorityFixture(options);
  const port = memoryPort();
  const resolve = vi.fn<ReleasePolicyAuthorityEvidenceResolver["resolve"]>(async () => ({
    artifacts: clone(fixture.input.artifacts),
    installationBinding: clone(fixture.binding),
    sources: clone(fixture.input.sources),
  }));
  const now = vi.fn(() => new Date(fixture.input.at));
  const publisher = new PublishReleasePolicy({
    authorityResolver: { resolve },
    clock: { now },
    repository: port.repository,
  });
  const command = {
    environmentId: fixture.input.scope.environmentId,
    input: publishInput(fixture.policy),
    policyId: fixture.policy.policyId,
    policyVersionId: fixture.policy.policyVersionId,
    principal: principal(fixture.input.scope.tenantId),
    projectId: fixture.input.scope.projectId,
  };
  return { command, fixture, now, port, publisher, resolve };
}

async function publishSuccessor(value: ReturnType<typeof setup>) {
  const input = clone(value.command.input);
  input.policyVersionId = "release_policy_checkout_v2";
  input.predecessorVersionId = value.command.policyVersionId;
  input.semanticVersion = "1.0.1";
  input.changeRationale = "Bind the successor to the accepted first policy version.";
  value.now.mockReturnValue(new Date("2026-09-06T23:01:00.000Z"));
  return value.publisher.execute({
    ...value.command,
    input,
    policyVersionId: input.policyVersionId,
  });
}

describe("release policy publication", () => {
  it("publishes one server-authored policy only after trusted authority validation", async () => {
    const value = setup();
    const result = await value.publisher.execute(value.command);

    expect(result).toMatchObject({
      created: true,
      policy: {
        issuerPrincipalId: value.command.principal.principalId,
        policyId: value.command.policyId,
        policyVersionId: value.command.policyVersionId,
        publishedAt: value.fixture.input.at,
        publishedByPrincipalId: value.command.principal.principalId,
        scope: value.fixture.input.scope,
      },
    });
    expect(result.policy.definitionSha256).toHaveLength(64);
    expect(value.resolve).toHaveBeenCalledOnce();
    expect(value.resolve.mock.calls[0]?.[0]).toMatchObject({
      definition: {
        issuerPrincipalId: value.command.principal.principalId,
        policyId: value.command.policyId,
      },
      scope: value.fixture.input.scope,
    });
    expect(value.port.publishReleasePolicy).toHaveBeenCalledOnce();
  });

  it("returns the original receipt on an exact retry and rejects semantic rebinding", async () => {
    const value = setup();
    const first = await value.publisher.execute(value.command);
    value.now.mockReturnValue(new Date("2026-09-07T02:00:00.000Z"));
    value.resolve.mockRejectedValue(new Error("authority backend should not be revisited"));

    await expect(value.publisher.execute(value.command)).resolves.toEqual({
      created: false,
      policy: first.policy,
    });
    expect(value.now).toHaveBeenCalledTimes(1);
    expect(value.resolve).toHaveBeenCalledTimes(1);
    expect(value.port.publishReleasePolicy).toHaveBeenCalledTimes(1);

    const changed = clone(value.command);
    changed.input.changeRationale = "Conflicting immutable policy semantics.";
    await expect(value.publisher.execute(changed)).rejects.toBeInstanceOf(
      ReleasePolicyVersionConflictError,
    );
    expect(value.resolve).toHaveBeenCalledTimes(1);
  });

  it.each(["2025-01-01T00:00:00.000Z", "2026-09-06T23:00:00.001Z"])(
    "rejects a first-publication receipt substituted with %s",
    async (publishedAt) => {
      const value = setup();
      value.port.publishReleasePolicy.mockImplementation(async (policy) => ({
        created: true,
        policy: { ...policy, publishedAt },
      }));

      await expect(value.publisher.execute(value.command)).rejects.toBeInstanceOf(
        ReleasePolicyRepositoryContractError,
      );
      expect(value.port.publishReleasePolicy).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ publishedAt: value.fixture.input.at }),
      );
    },
  );

  it("preserves the winning receipt when a concurrent publication follows a stale read", async () => {
    const value = setup();
    const first = await value.publisher.execute(value.command);
    const retryAt = "2026-09-07T02:00:00.000Z";
    value.now.mockReturnValue(new Date(retryAt));
    value.port.findReleasePolicy.mockResolvedValueOnce(null);

    await expect(value.publisher.execute(value.command)).resolves.toEqual({
      created: false,
      policy: first.policy,
    });
    expect(value.resolve).toHaveBeenCalledTimes(2);
    expect(value.now).toHaveBeenCalledTimes(2);
    expect(value.port.publishReleasePolicy).toHaveBeenCalledTimes(2);
    expect(value.port.publishReleasePolicy).toHaveBeenLastCalledWith(
      expect.objectContaining({ publishedAt: retryAt }),
    );
    expect(value.port.policies.get(value.command.policyVersionId)).toEqual(first.policy);
  });

  it("fails closed on rejected authority without persisting a policy", async () => {
    const value = setup();
    value.resolve.mockResolvedValue({
      artifacts: [],
      installationBinding: null,
      sources: value.fixture.input.sources,
    });
    await expect(value.publisher.execute(value.command)).rejects.toMatchObject({
      code: "release_policy_authority_rejected",
      findings: expect.arrayContaining([
        expect.objectContaining({ reason: "installation_binding_unavailable" }),
      ]),
    });
    await expect(value.publisher.execute(value.command)).rejects.toBeInstanceOf(
      ReleasePolicyAuthorityRejectedError,
    );
    expect(value.port.publishReleasePolicy).not.toHaveBeenCalled();
  });

  it("publishes a source without a declared expiry only under complete finite review authority", async () => {
    const mutateSource: NonNullable<PolicyAuthorityFixtureOptions["mutateSource"]> = (source) => {
      delete source.expiresAt;
    };
    const value = setup({ mutateSource });
    const result = await value.publisher.execute(value.command);
    expect(result.created).toBe(true);
    expect(result.policy.sources).toEqual(value.fixture.policy.sources);
    expect(value.fixture.source).not.toHaveProperty("expiresAt");
    expect(value.resolve).toHaveBeenCalledOnce();
    expect(value.port.publishReleasePolicy).toHaveBeenCalledOnce();

    const expiredReview = setup({
      mutateSource,
      mutateReview(review) {
        review.validUntil = "2027-01-01T00:00:00Z";
      },
    });
    await expect(expiredReview.publisher.execute(expiredReview.command)).rejects.toMatchObject({
      code: "release_policy_authority_rejected",
      findings: expect.arrayContaining([
        expect.objectContaining({ reason: "source_review_not_current" }),
      ]),
    });
    expect(expiredReview.port.publishReleasePolicy).not.toHaveBeenCalled();
  });

  it("resolves exact predecessor lineage and rejects missing lineage", async () => {
    const value = setup();
    const root = await value.publisher.execute(value.command);
    const successor = await publishSuccessor(value);
    expect(successor.policy.predecessor).toEqual({
      definitionSha256: root.policy.definitionSha256,
      policyId: root.policy.policyId,
      policyVersionId: root.policy.policyVersionId,
    });

    const missing = clone(value.command.input);
    missing.policyVersionId = "release_policy_checkout_v3";
    missing.predecessorVersionId = "release_policy_missing";
    missing.semanticVersion = "1.0.2";
    await expect(
      value.publisher.execute({
        ...value.command,
        input: missing,
        policyVersionId: missing.policyVersionId,
      }),
    ).rejects.toBeInstanceOf(ReleasePolicyLineageError);
  });

  it("authorizes before parsing or touching time, authority evidence, and storage", async () => {
    for (const deniedPrincipal of [
      principal("tenant_example", ["policy:read"]),
      principal("tenant_example", ["policy:author"], "workload"),
    ]) {
      const value = setup();
      await expect(
        value.publisher.execute({
          ...value.command,
          input: { deploymentToken: "secret" },
          principal: deniedPrincipal,
        }),
      ).rejects.toBeInstanceOf(ForbiddenError);
      expect(value.port.findReleasePolicy).not.toHaveBeenCalled();
      expect(value.resolve).not.toHaveBeenCalled();
      expect(value.now).not.toHaveBeenCalled();
    }
  });

  it("rejects invalid routes, bodies, clocks, and repository output", async () => {
    const value = setup();
    await expect(
      value.publisher.execute({ ...value.command, policyVersionId: "different_policy_version" }),
    ).rejects.toBeInstanceOf(InvalidReleasePolicyCommandError);
    await expect(
      value.publisher.execute({ ...value.command, environmentId: "invalid ID" }),
    ).rejects.toBeInstanceOf(InvalidReleasePolicyCommandError);
    await expect(value.publisher.execute({ ...value.command, input: {} })).rejects.toBeInstanceOf(
      InvalidReleasePolicyCommandError,
    );
    expect(value.resolve).not.toHaveBeenCalled();

    const invalidClock = setup();
    invalidClock.now.mockImplementation(() => {
      throw new Error("clock unavailable");
    });
    await expect(invalidClock.publisher.execute(invalidClock.command)).rejects.toBeInstanceOf(
      InvalidReleasePolicyCommandError,
    );
    expect(invalidClock.port.publishReleasePolicy).not.toHaveBeenCalled();

    const malformed = setup();
    malformed.port.publishReleasePolicy.mockResolvedValue(null as never);
    await expect(malformed.publisher.execute(malformed.command)).rejects.toBeInstanceOf(
      ReleasePolicyRepositoryContractError,
    );
  });

  it("fails closed on corrupt stored records, authority output, and result semantics", async () => {
    const corruptStored = setup();
    corruptStored.port.policies.set(corruptStored.command.policyVersionId, {
      ...corruptStored.fixture.policy,
      definitionSha256: "0".repeat(64),
    });
    await expect(corruptStored.publisher.execute(corruptStored.command)).rejects.toBeInstanceOf(
      ReleasePolicyRepositoryContractError,
    );

    const corruptAuthority = setup();
    corruptAuthority.resolve.mockResolvedValue({
      artifacts: "invalid",
      installationBinding: corruptAuthority.fixture.binding,
      sources: corruptAuthority.fixture.input.sources,
    } as never);
    await expect(
      corruptAuthority.publisher.execute(corruptAuthority.command),
    ).rejects.toBeInstanceOf(ReleasePolicyAuthorityResolverContractError);

    const malformedShape = setup();
    malformedShape.port.publishReleasePolicy.mockResolvedValue({
      created: "true",
      policy: malformedShape.fixture.policy,
    } as never);
    await expect(malformedShape.publisher.execute(malformedShape.command)).rejects.toBeInstanceOf(
      ReleasePolicyRepositoryContractError,
    );

    const substituted = setup();
    const otherPolicy = policyAuthorityFixture({
      mutatePolicy: (definition) => {
        definition.policyId = "policy_substituted";
      },
    }).policy;
    substituted.port.publishReleasePolicy.mockResolvedValue({
      created: true,
      policy: otherPolicy,
    });
    await expect(substituted.publisher.execute(substituted.command)).rejects.toBeInstanceOf(
      ReleasePolicyRepositoryContractError,
    );
  });
});

describe("release policy exact reads", () => {
  it("uses independent read authority and hides absent or mismatched identities", async () => {
    const value = setup();
    const published = await value.publisher.execute(value.command);
    const reader = new ReadReleasePolicy(value.port.repository);
    const readCommand = { ...value.command, input: undefined };
    expect(await reader.execute(readCommand)).toEqual(published.policy);
    await expect(
      reader.execute({ ...readCommand, policyId: "policy_other" }),
    ).rejects.toBeInstanceOf(ReleasePolicyNotFoundError);
    await expect(
      reader.execute({ ...readCommand, policyVersionId: "policy_absent" }),
    ).rejects.toBeInstanceOf(ReleasePolicyNotFoundError);
    await expect(
      reader.execute({
        ...readCommand,
        principal: principal(value.fixture.input.scope.tenantId, ["policy:author"]),
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(reader.execute({ ...readCommand, policyId: "invalid ID" })).rejects.toBeInstanceOf(
      InvalidReleasePolicyCommandError,
    );
    await expect(
      reader.execute({ ...readCommand, policyVersionId: "invalid ID" }),
    ).rejects.toBeInstanceOf(InvalidReleasePolicyCommandError);
  });

  it("reads one exact lifecycle event without leaking another policy identity", async () => {
    const value = setup();
    const published = await value.publisher.execute(value.command);
    value.now.mockReturnValue(new Date("2026-09-06T23:02:00.000Z"));
    const lifecycle = new PublishReleasePolicyLifecycle({
      clock: { now: value.now },
      repository: value.port.repository,
    });
    const publication = await lifecycle.execute({
      ...value.command,
      input: {
        eventId: "policy_event_exact_read",
        kind: "withdrawn",
        reason: "The exact lifecycle event must remain independently readable.",
      },
    });
    const reader = new ReadReleasePolicyLifecycle(value.port.repository);
    const { input: _input, ...route } = value.command;
    const command = {
      ...route,
      eventId: publication.event.eventId,
    };

    await expect(reader.execute(command)).resolves.toEqual(publication.event);
    expect(value.port.findReleasePolicyLifecycleEvent).toHaveBeenLastCalledWith(
      published.policy.scope,
      publication.event.eventId,
    );
    await expect(
      reader.execute({ ...command, eventId: "policy_event_absent" }),
    ).rejects.toBeInstanceOf(ReleasePolicyLifecycleEventNotFoundError);
    await expect(reader.execute({ ...command, policyId: "policy_other" })).rejects.toBeInstanceOf(
      ReleasePolicyNotFoundError,
    );

    const mismatchedEventId = "policy_event_other_resource";
    value.port.events.set(mismatchedEventId, {
      ...publication.event,
      eventId: mismatchedEventId,
      policy: {
        definitionSha256: "a".repeat(64),
        policyId: "policy_other",
        policyVersionId: "policy_other_v1",
      },
    });
    await expect(reader.execute({ ...command, eventId: mismatchedEventId })).rejects.toBeInstanceOf(
      ReleasePolicyLifecycleEventNotFoundError,
    );
  });

  it("authorizes lifecycle reads before validating route identifiers", async () => {
    const value = setup();
    const reader = new ReadReleasePolicyLifecycle(value.port.repository);
    const unauthorized = principal(value.fixture.input.scope.tenantId, ["policy:author"]);
    const { input: _input, ...route } = value.command;
    await expect(
      reader.execute({
        ...route,
        eventId: "invalid ID",
        policyId: "invalid ID",
        policyVersionId: "invalid ID",
        principal: unauthorized,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(value.port.findReleasePolicy).not.toHaveBeenCalled();
    expect(value.port.findReleasePolicyLifecycleEvent).not.toHaveBeenCalled();

    for (const command of [
      { ...route, eventId: "invalid ID" },
      { ...route, eventId: "policy_event", policyId: "invalid ID" },
      {
        ...route,
        eventId: "policy_event",
        policyVersionId: "invalid ID",
      },
    ]) {
      await expect(reader.execute(command)).rejects.toBeInstanceOf(
        InvalidReleasePolicyCommandError,
      );
    }
  });
});

describe("release policy lifecycle publication", () => {
  const magnitudes = Array.from({ length: 6 }, (_, index) => 2 ** index);
  const offsets = [...magnitudes.map((value) => -value), 0, ...magnitudes];
  // Every clock offset is independently timed, including on coverage-enabled shared CI workers.
  const timeCases = (["withdrawn", "superseded"] as const).flatMap((kind) =>
    offsets.map((offset) => ({ kind, offset })),
  );
  it.each(timeCases)(
    "preserves the inclusive $kind time boundary at offset $offset ms",
    async ({ kind, offset }) => {
      const value = setup();
      const target = await value.publisher.execute(value.command);
      const successor = kind === "superseded" ? await publishSuccessor(value) : undefined;
      const lowerBound = successor?.policy.publishedAt ?? target.policy.publishedAt;
      const occurredAt = new Date(Date.parse(lowerBound) + offset).toISOString();
      value.now.mockReturnValue(new Date(occurredAt));
      const lifecycle = new PublishReleasePolicyLifecycle({
        clock: { now: value.now },
        repository: value.port.repository,
      });
      const event = {
        eventId: "policy_event_generated_boundary",
        reason: "Verify the server clock against every policy receipt in the transition.",
      };
      const input = successor
        ? {
            ...event,
            kind: "superseded" as const,
            successorPolicyVersionId: successor.policy.policyVersionId,
          }
        : { ...event, kind: "withdrawn" as const };
      if (offset < 0) {
        await expect(lifecycle.execute({ ...value.command, input })).rejects.toBeInstanceOf(
          InvalidReleasePolicyCommandError,
        );
        expect(value.port.publishReleasePolicyLifecycleEvent).not.toHaveBeenCalled();
        expect(value.port.events.size).toBe(0);
      } else {
        await expect(lifecycle.execute({ ...value.command, input })).resolves.toMatchObject({
          created: true,
          event: { kind, occurredAt },
        });
        expect(value.port.publishReleasePolicyLifecycleEvent).toHaveBeenCalledOnce();
      }
    },
  );

  it("withdraws once, preserves the first receipt on retry, and blocks another terminal event", async () => {
    const value = setup();
    const published = await value.publisher.execute(value.command);
    value.now.mockReturnValue(new Date("2026-09-06T23:02:00.000Z"));
    const lifecycle = new PublishReleasePolicyLifecycle({
      clock: { now: value.now },
      repository: value.port.repository,
    });
    const input: PublishReleasePolicyLifecycleRequest = {
      eventId: "policy_event_withdraw_checkout_v1",
      kind: "withdrawn",
      reason: "The policy is no longer authorized for new release decisions.",
    };
    const command = { ...value.command, input };
    const first = await lifecycle.execute(command);
    expect(first).toMatchObject({
      created: true,
      event: {
        actorPrincipalId: value.command.principal.principalId,
        kind: "withdrawn",
        occurredAt: "2026-09-06T23:02:00.000Z",
        policy: {
          definitionSha256: published.policy.definitionSha256,
          policyId: published.policy.policyId,
          policyVersionId: published.policy.policyVersionId,
        },
      },
    });
    value.now.mockReturnValue(new Date("2026-09-07T00:00:00.000Z"));
    await expect(lifecycle.execute(command)).resolves.toEqual({
      created: false,
      event: first.event,
    });
    expect(value.now).toHaveBeenCalledTimes(2);

    await expect(
      lifecycle.execute({
        ...command,
        input: {
          eventId: "policy_event_withdraw_checkout_v2",
          kind: "withdrawn",
          reason: "A second terminal transition must fail.",
        },
      }),
    ).rejects.toBeInstanceOf(ReleasePolicyLifecycleStateConflictError);
  });

  it("supersedes only through an exact successor whose predecessor is the target", async () => {
    const value = setup();
    const root = await value.publisher.execute(value.command);
    const successor = await publishSuccessor(value);
    value.now.mockReturnValue(new Date("2026-09-06T23:02:00.000Z"));
    const lifecycle = new PublishReleasePolicyLifecycle({
      clock: { now: value.now },
      repository: value.port.repository,
    });
    const command = {
      ...value.command,
      input: {
        eventId: "policy_event_supersede_checkout",
        kind: "superseded",
        reason: "The exact successor replaces this policy version.",
        successorPolicyVersionId: successor.policy.policyVersionId,
      },
    };
    const result = await lifecycle.execute(command);
    expect(result.event).toMatchObject({
      kind: "superseded",
      policy: { definitionSha256: root.policy.definitionSha256 },
      successor: {
        definitionSha256: successor.policy.definitionSha256,
        policyId: successor.policy.policyId,
        policyVersionId: successor.policy.policyVersionId,
      },
    });
    await expect(lifecycle.execute(command)).resolves.toEqual({
      created: false,
      event: result.event,
    });

    const unrelated = setup();
    await unrelated.publisher.execute(unrelated.command);
    const unrelatedSuccessor = policyAuthorityFixture({
      mutatePolicy: (definition) => {
        definition.policyVersionId = "policy_unrelated_successor";
        definition.semanticVersion = "1.0.1";
      },
    }).policy;
    unrelated.port.policies.set(unrelatedSuccessor.policyVersionId, unrelatedSuccessor);
    const invalidLifecycle = new PublishReleasePolicyLifecycle({
      clock: { now: unrelated.now },
      repository: unrelated.port.repository,
    });
    await expect(
      invalidLifecycle.execute({
        ...unrelated.command,
        input: {
          eventId: "policy_event_invalid_successor",
          kind: "superseded",
          reason: "An unrelated version cannot be treated as a successor.",
          successorPolicyVersionId: "policy_unrelated_successor",
        },
      }),
    ).rejects.toBeInstanceOf(ReleasePolicyLineageError);
  });

  it("rejects unavailable successors and invalid lifecycle route inputs", async () => {
    const value = setup();
    await value.publisher.execute(value.command);
    const lifecycle = new PublishReleasePolicyLifecycle({
      clock: { now: value.now },
      repository: value.port.repository,
    });
    const validInput = {
      eventId: "policy_event_missing_successor",
      kind: "superseded" as const,
      reason: "A missing successor cannot terminate an immutable policy version.",
      successorPolicyVersionId: "policy_successor_missing",
    };
    await expect(lifecycle.execute({ ...value.command, input: validInput })).rejects.toBeInstanceOf(
      ReleasePolicyLineageError,
    );

    for (const command of [
      { ...value.command, input: validInput, policyId: "invalid ID" },
      { ...value.command, input: validInput, policyVersionId: "invalid ID" },
      { ...value.command, input: {} },
    ]) {
      await expect(lifecycle.execute(command)).rejects.toBeInstanceOf(
        InvalidReleasePolicyCommandError,
      );
    }
  });

  it("rejects conflicting event retries, pre-publication clocks, and malformed history", async () => {
    const value = setup();
    await value.publisher.execute(value.command);
    value.now.mockReturnValue(new Date("2026-09-06T23:02:00.000Z"));
    const lifecycle = new PublishReleasePolicyLifecycle({
      clock: { now: value.now },
      repository: value.port.repository,
    });
    const command = {
      ...value.command,
      input: {
        eventId: "policy_event_conflict",
        kind: "withdrawn" as const,
        reason: "First immutable lifecycle meaning.",
      },
    };
    await lifecycle.execute(command);
    await expect(
      lifecycle.execute({
        ...command,
        input: { ...command.input, reason: "Conflicting lifecycle meaning." },
      }),
    ).rejects.toBeInstanceOf(ReleasePolicyLifecycleEventConflictError);

    const early = setup();
    await early.publisher.execute(early.command);
    early.now.mockReturnValue(new Date("2026-09-06T22:59:59.000Z"));
    const earlyLifecycle = new PublishReleasePolicyLifecycle({
      clock: { now: early.now },
      repository: early.port.repository,
    });
    await expect(
      earlyLifecycle.execute({
        ...early.command,
        input: {
          eventId: "policy_event_early",
          kind: "withdrawn",
          reason: "This server time predates the policy publication receipt.",
        },
      }),
    ).rejects.toBeInstanceOf(InvalidReleasePolicyCommandError);

    const malformed = setup();
    await malformed.publisher.execute(malformed.command);
    malformed.port.listReleasePolicyLifecycleEvents.mockResolvedValue("invalid" as never);
    const malformedLifecycle = new PublishReleasePolicyLifecycle({
      clock: { now: malformed.now },
      repository: malformed.port.repository,
    });
    await expect(
      malformedLifecycle.execute({
        ...malformed.command,
        input: {
          eventId: "policy_event_malformed_history",
          kind: "withdrawn",
          reason: "Invalid repository output must fail closed.",
        },
      }),
    ).rejects.toBeInstanceOf(ReleasePolicyRepositoryContractError);
  });

  it("rejects malformed or substituted lifecycle publication records", async () => {
    for (const mutate of [
      (event: ReleasePolicyLifecycleEvent) => ({ ...event, reason: "Substituted reason." }),
      (event: ReleasePolicyLifecycleEvent) => ({
        ...event,
        occurredAt: "2026-09-06T23:02:01.000Z",
      }),
      (event: ReleasePolicyLifecycleEvent) => ({ ...event, secret: "unexpected" }),
    ]) {
      const value = setup();
      await value.publisher.execute(value.command);
      value.now.mockReturnValue(new Date("2026-09-06T23:02:00.000Z"));
      value.port.publishReleasePolicyLifecycleEvent.mockImplementation(async (event) => ({
        created: true,
        event: mutate(event) as ReleasePolicyLifecycleEvent,
      }));
      const lifecycle = new PublishReleasePolicyLifecycle({
        clock: { now: value.now },
        repository: value.port.repository,
      });
      await expect(
        lifecycle.execute({
          ...value.command,
          input: {
            eventId: "policy_event_substituted_result",
            kind: "withdrawn",
            reason: "The original lifecycle request semantics.",
          },
        }),
      ).rejects.toBeInstanceOf(ReleasePolicyRepositoryContractError);
    }
  });

  it("rejects corrupt entries inside otherwise array-shaped lifecycle history", async () => {
    const value = setup();
    const published = await value.publisher.execute(value.command);
    value.port.listReleasePolicyLifecycleEvents.mockResolvedValue([
      {
        actorPrincipalId: value.command.principal.principalId,
        eventId: "policy_event_wrong_history",
        kind: "withdrawn",
        occurredAt: "2026-09-06T23:02:00.000Z",
        policy: {
          definitionSha256: "0".repeat(64),
          policyId: published.policy.policyId,
          policyVersionId: published.policy.policyVersionId,
        },
        reason: "This valid event shape references the wrong immutable policy digest.",
        schemaVersion: RELEASE_POLICY_LIFECYCLE_SCHEMA_VERSION,
        scope: published.policy.scope,
      },
    ]);
    const lifecycle = new PublishReleasePolicyLifecycle({
      clock: { now: value.now },
      repository: value.port.repository,
    });
    await expect(
      lifecycle.execute({
        ...value.command,
        input: {
          eventId: "policy_event_after_wrong_history",
          kind: "withdrawn",
          reason: "Non-exact lifecycle history must fail closed.",
        },
      }),
    ).rejects.toBeInstanceOf(ReleasePolicyRepositoryContractError);

    value.port.listReleasePolicyLifecycleEvents.mockResolvedValue([{ invalid: true } as never]);
    await expect(
      lifecycle.execute({
        ...value.command,
        input: {
          eventId: "policy_event_after_malformed_history",
          kind: "withdrawn",
          reason: "Malformed lifecycle records must fail closed.",
        },
      }),
    ).rejects.toBeInstanceOf(ReleasePolicyRepositoryContractError);
  });
});
