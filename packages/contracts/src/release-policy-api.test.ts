import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  RELEASE_POLICY_LIFECYCLE_SCHEMA_VERSION,
  RELEASE_POLICY_SCHEMA_VERSION,
  type ReleasePolicy,
  type ReleasePolicyLifecycleEvent,
} from "./release-policy.js";
import {
  PublishReleasePolicyLifecycleResponseSchema,
  PublishReleasePolicyResponseSchema,
  ReadReleasePolicyLifecycleResponseSchema,
  ReadReleasePolicyResponseSchema,
} from "./release-policy-api.js";

interface ReleasePolicyVectorDocument {
  readonly vectors: readonly {
    readonly input: {
      readonly definition: Readonly<Record<string, unknown>>;
      readonly scope: Readonly<Record<string, unknown>>;
    };
    readonly kind: string;
    readonly sha256: string;
  }[];
}

function policyRecord(): ReleasePolicy {
  const document = JSON.parse(
    readFileSync(new URL("../vectors/release-policy-definition-v1.json", import.meta.url), "utf8"),
  ) as ReleasePolicyVectorDocument;
  const vector = document.vectors.find(({ kind }) => kind === "release_policy");
  if (!vector) throw new Error("Expected a release policy definition vector");
  return {
    ...structuredClone(vector.input.definition),
    definitionSha256: vector.sha256,
    publishedAt: "2026-09-06T23:00:00.000Z",
    publishedByPrincipalId: "principal_policy_author",
    schemaVersion: RELEASE_POLICY_SCHEMA_VERSION,
    scope: structuredClone(vector.input.scope),
  } as ReleasePolicy;
}

function lifecycleEvent(policy: ReleasePolicy): ReleasePolicyLifecycleEvent {
  return {
    actorPrincipalId: "principal_policy_author",
    eventId: "policy_event_api_withdrawal",
    kind: "withdrawn",
    occurredAt: "2026-09-07T01:00:00.000Z",
    policy: {
      definitionSha256: policy.definitionSha256,
      policyId: policy.policyId,
      policyVersionId: policy.policyVersionId,
    },
    reason: "The immutable policy version is no longer authorized for new decisions.",
    schemaVersion: RELEASE_POLICY_LIFECYCLE_SCHEMA_VERSION,
    scope: policy.scope,
  };
}

describe("release policy API contracts", () => {
  it("accepts exact policy publication and read receipts", () => {
    const policy = policyRecord();
    expect(
      PublishReleasePolicyResponseSchema.parse({
        created: true,
        policy,
        requestId: "request_release_policy_api",
      }),
    ).toEqual({ created: true, policy, requestId: "request_release_policy_api" });
    expect(
      ReadReleasePolicyResponseSchema.parse({
        policy,
        requestId: "request_release_policy_api",
      }),
    ).toEqual({ policy, requestId: "request_release_policy_api" });
  });

  it("accepts exact lifecycle publication and read receipts", () => {
    const event = lifecycleEvent(policyRecord());
    expect(
      PublishReleasePolicyLifecycleResponseSchema.parse({
        created: false,
        event,
        requestId: "request_release_policy_lifecycle_api",
      }),
    ).toEqual({ created: false, event, requestId: "request_release_policy_lifecycle_api" });
    expect(
      ReadReleasePolicyLifecycleResponseSchema.parse({
        event,
        requestId: "request_release_policy_lifecycle_api",
      }),
    ).toEqual({ event, requestId: "request_release_policy_lifecycle_api" });
  });

  it("rejects unknown decision fields and malformed immutable receipts", () => {
    const policy = policyRecord();
    const event = lifecycleEvent(policy);
    expect(() =>
      PublishReleasePolicyResponseSchema.parse({
        created: true,
        policy,
        releaseDecision: "allow",
        requestId: "request_release_policy_api",
      }),
    ).toThrow();
    expect(() =>
      ReadReleasePolicyResponseSchema.parse({
        policy: { ...policy, definitionSha256: "not-a-digest" },
        requestId: "request_release_policy_api",
      }),
    ).toThrow();
    expect(() =>
      ReadReleasePolicyLifecycleResponseSchema.parse({
        event: { ...event, actorPrincipalId: "" },
        requestId: "request_release_policy_lifecycle_api",
      }),
    ).toThrow();
    expect(() =>
      PublishReleasePolicyLifecycleResponseSchema.parse({
        created: true,
        event,
        enforcementStatus: "active",
        requestId: "request_release_policy_lifecycle_api",
      }),
    ).toThrow();
  });
});
