import { type ApiConfig, type AppDependencies, createApp } from "@proofstack/api/composition";
import {
  PrincipalContextSchema,
  PublishReleasePolicyLifecycleRequestSchema,
  type PublishReleasePolicyRequest,
  PublishReleasePolicyRequestSchema,
  RELEASE_POLICY_LIFECYCLE_SCHEMA_VERSION,
  type ReleasePolicy,
  type ReleasePolicyLifecycleEvent,
  ReleasePolicyLifecycleEventSchema,
} from "@proofstack/contracts";
import { policyAuthorityFixture } from "@proofstack/core/testing";
import { ProofStackReleasePolicyClient } from "@proofstack/sdk";
import { describe, expect, it, vi } from "vitest";
import { runWorkflow2ReleasePolicy } from "./workflow.js";

const fixture = policyAuthorityFixture();
const scope = fixture.policy.scope;
const policyId = fixture.policy.policyId;

function requestFor(policy: ReleasePolicy): PublishReleasePolicyRequest {
  const {
    definitionSha256: _definitionSha256,
    issuerPrincipalId: _issuerPrincipalId,
    policyId: _policyId,
    predecessor,
    publishedAt: _publishedAt,
    publishedByPrincipalId: _publishedByPrincipalId,
    schemaVersion: _schemaVersion,
    scope: _scope,
    ...definition
  } = structuredClone(policy);
  return PublishReleasePolicyRequestSchema.parse({
    ...definition,
    ...(predecessor ? { predecessorVersionId: predecessor.policyVersionId } : {}),
  });
}

const request = requestFor(fixture.policy);
const lifecycleRequest = PublishReleasePolicyLifecycleRequestSchema.parse({
  eventId: "policy_event_workflow_2_withdrawal",
  kind: "withdrawn",
  reason: "This exact policy version is no longer authorized for new release decisions.",
});
const lifecycleEvent = ReleasePolicyLifecycleEventSchema.parse({
  actorPrincipalId: fixture.policy.issuerPrincipalId,
  eventId: lifecycleRequest.eventId,
  kind: lifecycleRequest.kind,
  occurredAt: "2026-09-07T01:00:00.000Z",
  policy: {
    definitionSha256: fixture.policy.definitionSha256,
    policyId,
    policyVersionId: fixture.policy.policyVersionId,
  },
  reason: lifecycleRequest.reason,
  schemaVersion: RELEASE_POLICY_LIFECYCLE_SCHEMA_VERSION,
  scope,
});

type PolicyMutation = (policy: ReleasePolicy) => ReleasePolicy;
type LifecycleMutation = (event: ReleasePolicyLifecycleEvent) => ReleasePolicyLifecycleEvent;

interface HarnessOptions {
  readonly lifecycleFirstCreated?: boolean;
  readonly lifecyclePublication?: LifecycleMutation;
  readonly lifecycleRead?: LifecycleMutation;
  readonly lifecycleRetry?: LifecycleMutation;
  readonly lifecycleRetryCreated?: boolean;
  readonly policyFirstCreated?: boolean;
  readonly policyPublication?: PolicyMutation;
  readonly policyRead?: PolicyMutation;
  readonly policyRetry?: PolicyMutation;
  readonly policyRetryCreated?: boolean;
}

function mutate<Value>(value: Value, mutation: ((value: Value) => Value) | undefined): Value {
  const clone = structuredClone(value);
  return mutation ? mutation(clone) : clone;
}

function clientHarness(options: HarnessOptions = {}) {
  let policyPublicationCount = 0;
  let lifecyclePublicationCount = 0;
  return {
    async publishLifecycleEvent() {
      lifecyclePublicationCount += 1;
      const first = lifecyclePublicationCount === 1;
      return {
        created: first
          ? (options.lifecycleFirstCreated ?? true)
          : (options.lifecycleRetryCreated ?? false),
        event: mutate(
          lifecycleEvent,
          first ? options.lifecyclePublication : options.lifecycleRetry,
        ),
        requestId: `req_lifecycle_${lifecyclePublicationCount}`,
      };
    },
    async publishPolicy() {
      policyPublicationCount += 1;
      const first = policyPublicationCount === 1;
      return {
        created: first
          ? (options.policyFirstCreated ?? true)
          : (options.policyRetryCreated ?? false),
        policy: mutate(fixture.policy, first ? options.policyPublication : options.policyRetry),
        requestId: `req_policy_${policyPublicationCount}`,
      };
    },
    async readLifecycleEvent() {
      return {
        event: mutate(lifecycleEvent, options.lifecycleRead),
        requestId: "req_lifecycle_read",
      };
    },
    async readPolicy() {
      return {
        policy: mutate(fixture.policy, options.policyRead),
        requestId: "req_policy_read",
      };
    },
  };
}

function runHarness(options: HarnessOptions = {}) {
  return runWorkflow2ReleasePolicy({
    client: clientHarness(options),
    lifecycleRequest,
    policyId,
    request,
  });
}

const apiConfig: ApiConfig = {
  authMode: "development",
  environment: "test",
  host: "127.0.0.1",
  logLevel: "silent",
  otlp: { compressedBodyLimitBytes: 1_048_576, decompressedBodyLimitBytes: 1_048_576 },
  port: 4318,
  storage: { mode: "memory" },
};

describe("runWorkflow2ReleasePolicy", () => {
  it("crosses a real HTTP API and SDK boundary without evaluating the policy", async () => {
    const authority = vi.fn(async () => ({
      artifacts: structuredClone(fixture.input.artifacts),
      installationBinding: structuredClone(fixture.binding),
      sources: structuredClone(fixture.input.sources),
    }));
    const authenticator: NonNullable<AppDependencies["authenticator"]> = {
      authenticate: async (incoming) =>
        PrincipalContextSchema.parse({
          authentication: {
            authenticatedAt: "2026-09-06T22:00:00.000Z",
            method: "development",
          },
          capabilities: ["policy:author", "policy:read"],
          principalId: fixture.policy.issuerPrincipalId,
          principalType: "user",
          requestId: incoming.id,
          resourceScope: {
            mode: "restricted",
            projects: [{ environmentIds: [scope.environmentId], projectId: scope.projectId }],
          },
          roles: ["owner"],
          tenantId: scope.tenantId,
        }),
    };
    const app = await createApp(apiConfig, {
      authenticator,
      clock: { now: () => new Date(fixture.input.at) },
      releasePolicyAuthorityResolver: { resolve: authority },
    });

    try {
      const endpoint = await app.listen({ host: "127.0.0.1", port: 0 });
      const client = new ProofStackReleasePolicyClient({
        authentication: { mode: "development" },
        endpoint,
        environmentId: scope.environmentId,
        projectId: scope.projectId,
      });

      await expect(
        runWorkflow2ReleasePolicy({ client, lifecycleRequest, policyId, request }),
      ).resolves.toEqual({
        immutableHistoryVerified: true,
        lifecycle: {
          eventId: lifecycleRequest.eventId,
          kind: "withdrawn",
          retryCreated: false,
        },
        policy: {
          definitionSha256: fixture.policy.definitionSha256,
          policyId,
          policyVersionId: fixture.policy.policyVersionId,
          retryCreated: false,
        },
      });
      expect(authority).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });

  it.each([
    [
      "a non-creating first policy receipt",
      { policyFirstCreated: false },
      "Policy publication must create fresh disposable state",
    ],
    [
      "a substituted policy id",
      { policyPublication: (policy: ReleasePolicy) => ({ ...policy, policyId: "policy_other" }) },
      "Policy publication changed the exact requested identity",
    ],
    [
      "a substituted policy version id",
      {
        policyPublication: (policy: ReleasePolicy) => ({
          ...policy,
          policyVersionId: "policy_version_other",
        }),
      },
      "Policy publication changed the exact requested identity",
    ],
    [
      "a creating policy retry",
      { policyRetryCreated: true },
      "Policy publication retry must return created=false",
    ],
    [
      "a changed policy retry",
      {
        policyRetry: (policy: ReleasePolicy) => ({
          ...policy,
          knownLimitations: [...policy.knownLimitations, "Mutated retry"],
        }),
      },
      "Policy retry changed immutable record content",
    ],
    [
      "a changed policy read-back",
      {
        policyRead: (policy: ReleasePolicy) => ({
          ...policy,
          assumptions: [...policy.assumptions, "Mutated read-back"],
        }),
      },
      "Policy read-back changed immutable record content",
    ],
  ] as const)("rejects %s", async (_label, options, message) => {
    await expect(runHarness(options)).rejects.toThrow(message);
  });

  it.each([
    [
      "a non-creating first lifecycle receipt",
      { lifecycleFirstCreated: false },
      "Lifecycle publication must create fresh disposable state",
    ],
    [
      "a substituted lifecycle event id",
      {
        lifecyclePublication: (event: ReleasePolicyLifecycleEvent) => ({
          ...event,
          eventId: "policy_event_other",
        }),
      },
      "Lifecycle publication changed the exact policy binding",
    ],
  ] as const)("rejects %s", async (_label, options, message) => {
    await expect(runHarness(options)).rejects.toThrow(message);
  });

  it.each([
    [
      "policy id",
      (event: ReleasePolicyLifecycleEvent) => ({
        ...event,
        policy: { ...event.policy, policyId: "policy_other" },
      }),
    ],
    [
      "policy version id",
      (event: ReleasePolicyLifecycleEvent) => ({
        ...event,
        policy: { ...event.policy, policyVersionId: "policy_version_other" },
      }),
    ],
    [
      "policy digest",
      (event: ReleasePolicyLifecycleEvent) => ({
        ...event,
        policy: { ...event.policy, definitionSha256: "f".repeat(64) },
      }),
    ],
  ] as const)("rejects a lifecycle event with a substituted %s", async (_label, mutation) => {
    await expect(runHarness({ lifecyclePublication: mutation })).rejects.toThrow(
      "Lifecycle publication changed the exact policy binding",
    );
  });

  it.each([
    [
      "a creating lifecycle retry",
      { lifecycleRetryCreated: true },
      "Lifecycle publication retry must return created=false",
    ],
    [
      "a changed lifecycle retry",
      {
        lifecycleRetry: (event: ReleasePolicyLifecycleEvent) => ({
          ...event,
          reason: "Mutated lifecycle retry",
        }),
      },
      "Lifecycle retry changed immutable record content",
    ],
    [
      "a changed lifecycle read-back",
      {
        lifecycleRead: (event: ReleasePolicyLifecycleEvent) => ({
          ...event,
          occurredAt: "2026-09-07T02:00:00.000Z",
        }),
      },
      "Lifecycle read-back changed immutable record content",
    ],
  ] as const)("rejects %s", async (_label, options, message) => {
    await expect(runHarness(options)).rejects.toThrow(message);
  });
});
