import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  MAX_POLICY_RULES,
  PublishReleasePolicyLifecycleRequestSchema,
  PublishReleasePolicyRequestSchema,
  RELEASE_POLICY_LIFECYCLE_SCHEMA_VERSION,
  RELEASE_POLICY_SCHEMA_VERSION,
  type ReleasePolicy,
  type ReleasePolicyLifecycleEvent,
} from "./release-policy.js";
import {
  MAX_RELEASE_POLICY_REQUEST_BYTES,
  MAX_RELEASE_POLICY_RESPONSE_BYTES,
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
  it.each([false, true])(
    "bounds maximum policy receipt metadata with predecessor=%s",
    (lineage) => {
      const id = "a".repeat(64);
      const policy: ReleasePolicy = {
        ...policyRecord(),
        issuerPrincipalId: id,
        policyId: id,
        policyVersionId: id,
        publishedByPrincipalId: id,
        scope: { environmentId: id, projectId: id, tenantId: id },
        ...(lineage
          ? {
              predecessor: {
                definitionSha256: "f".repeat(64),
                policyId: id,
                policyVersionId: "b".repeat(64),
              },
            }
          : {}),
      };
      const {
        definitionSha256: _digest,
        issuerPrincipalId: _issuer,
        policyId: _id,
        predecessor,
        publishedAt: _at,
        publishedByPrincipalId: _publisher,
        schemaVersion: _version,
        scope: _scope,
        ...fields
      } = policy;
      const request = PublishReleasePolicyRequestSchema.parse({
        ...fields,
        ...(predecessor ? { predecessorVersionId: predecessor.policyVersionId } : {}),
      });
      // Request IDs permit 128 UTF-16 code units. JSON's six-byte control-character escape
      // costs more per unit than either ASCII, BMP text, or a supplementary Unicode scalar.
      const requestId = "\u0000".repeat(128);
      const responses = [
        PublishReleasePolicyResponseSchema.parse({ created: false, policy, requestId }),
        ReadReleasePolicyResponseSchema.parse({ policy, requestId }),
      ];
      expect(MAX_RELEASE_POLICY_REQUEST_BYTES).toBe(1_048_576);
      for (const response of responses) {
        const overhead =
          Buffer.byteLength(JSON.stringify(response)) - Buffer.byteLength(JSON.stringify(request));
        expect(overhead).toBeGreaterThan(0);
        // Each finite predicate can expand by at most 12 bytes: 1e15 -> 1000000000000000.
        // The two bounded basis-point operands together expand less than that single count.
        expect(overhead + MAX_POLICY_RULES * 12).toBeLessThanOrEqual(
          MAX_RELEASE_POLICY_RESPONSE_BYTES - MAX_RELEASE_POLICY_REQUEST_BYTES,
        );
      }
    },
  );

  it.each(["withdrawn", "superseded"] as const)("bounds maximum %s receipt metadata", (kind) => {
    const id = "a".repeat(64);
    const reference = { definitionSha256: "f".repeat(64), policyId: id, policyVersionId: id };
    const event = {
      ...lifecycleEvent(policyRecord()),
      actorPrincipalId: id,
      eventId: id,
      kind,
      policy: reference,
      scope: { environmentId: id, projectId: id, tenantId: id },
      ...(kind === "superseded"
        ? { successor: { ...reference, policyVersionId: "b".repeat(64) } }
        : {}),
    };
    const request = PublishReleasePolicyLifecycleRequestSchema.parse({
      eventId: event.eventId,
      kind,
      reason: event.reason,
      ...(kind === "superseded" ? { successorPolicyVersionId: "b".repeat(64) } : {}),
    });
    const requestId = "\u0000".repeat(128);
    const responses = [
      PublishReleasePolicyLifecycleResponseSchema.parse({ created: false, event, requestId }),
      ReadReleasePolicyLifecycleResponseSchema.parse({ event, requestId }),
    ];
    for (const response of responses) {
      const overhead =
        Buffer.byteLength(JSON.stringify(response)) - Buffer.byteLength(JSON.stringify(request));
      expect(overhead).toBeGreaterThan(0);
      expect(overhead).toBeLessThanOrEqual(
        MAX_RELEASE_POLICY_RESPONSE_BYTES - MAX_RELEASE_POLICY_REQUEST_BYTES,
      );
    }
  });

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
