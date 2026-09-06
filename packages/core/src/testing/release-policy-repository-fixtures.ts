import {
  type EvidenceScope,
  RELEASE_POLICY_LIFECYCLE_SCHEMA_VERSION,
  RELEASE_POLICY_SCHEMA_VERSION,
  type ReleasePolicy,
  type ReleasePolicyDefinition,
  type ReleasePolicyLifecycleEvent,
  type ReleasePolicyReference,
} from "@proofstack/contracts";
import { digestReleasePolicyDefinition } from "../policy/release-policy-record-validation.js";
import type { ReleasePolicyRepository } from "../policy/release-policy-repository.js";
import { MemoryReleasePolicyRepository } from "./memory-release-policy-repository.js";
import { policyAuthorityFixture } from "./release-policy-fixtures.js";

function policyReference(policy: ReleasePolicy): ReleasePolicyReference {
  return {
    definitionSha256: policy.definitionSha256,
    policyId: policy.policyId,
    policyVersionId: policy.policyVersionId,
  };
}

function baseDefinition(): ReleasePolicyDefinition {
  const policy = structuredClone(policyAuthorityFixture().policy) as unknown as Record<
    string,
    unknown
  >;
  for (const key of [
    "definitionSha256",
    "publishedAt",
    "publishedByPrincipalId",
    "schemaVersion",
    "scope",
  ]) {
    delete policy[key];
  }
  return policy as unknown as ReleasePolicyDefinition;
}

const policyTemplate = baseDefinition();

export function releasePolicyFixtureScope(namespace: string, suffix = "primary"): EvidenceScope {
  return {
    environmentId: `env_${namespace}_${suffix}`,
    projectId: `prj_${namespace}_${suffix}`,
    tenantId: `ten_${namespace}`,
  };
}

export function releasePolicyRepositoryFixture(
  namespace: string,
  scope: EvidenceScope,
  options: {
    readonly changeRationale?: string;
    readonly policyId?: string;
    readonly policyVersionId?: string;
    readonly predecessor?: ReleasePolicyReference;
    readonly publishedAt?: string;
    readonly semanticVersion?: string;
  } = {},
): ReleasePolicy {
  const policyId = options.policyId ?? `policy_${namespace}`;
  const definition = {
    ...structuredClone(policyTemplate),
    changeRationale:
      options.changeRationale ?? "Establish the repository conformance release policy.",
    issuerPrincipalId: `principal_${namespace}`,
    policyId,
    policyVersionId:
      options.policyVersionId ??
      `${policyId}_${options.semanticVersion?.replaceAll(".", "_") ?? "v1"}`,
    ...(options.predecessor ? { predecessor: structuredClone(options.predecessor) } : {}),
    semanticVersion: options.semanticVersion ?? "1.0.0",
  } satisfies ReleasePolicyDefinition;
  return {
    ...definition,
    definitionSha256: digestReleasePolicyDefinition(scope, definition),
    publishedAt: options.publishedAt ?? "2026-09-07T01:00:00.000Z",
    publishedByPrincipalId: definition.issuerPrincipalId,
    schemaVersion: RELEASE_POLICY_SCHEMA_VERSION,
    scope: structuredClone(scope),
  };
}

export function releasePolicyLifecycleFixture(
  namespace: string,
  policy: ReleasePolicy,
  options:
    | {
        readonly actorPrincipalId?: string;
        readonly eventId?: string;
        readonly kind?: "withdrawn";
        readonly occurredAt?: string;
        readonly reason?: string;
      }
    | {
        readonly actorPrincipalId?: string;
        readonly eventId?: string;
        readonly kind: "superseded";
        readonly occurredAt?: string;
        readonly reason?: string;
        readonly successor: ReleasePolicy;
      } = {},
): ReleasePolicyLifecycleEvent {
  const shared = {
    actorPrincipalId: options.actorPrincipalId ?? `principal_${namespace}`,
    eventId: options.eventId ?? `policy_event_${namespace}`,
    occurredAt: options.occurredAt ?? "2026-09-07T03:00:00.000Z",
    policy: policyReference(policy),
    reason: options.reason ?? "Complete the repository conformance lifecycle transition.",
    schemaVersion: RELEASE_POLICY_LIFECYCLE_SCHEMA_VERSION,
    scope: structuredClone(policy.scope),
  };
  return options.kind === "superseded"
    ? {
        ...shared,
        kind: "superseded",
        successor: policyReference(options.successor),
      }
    : { ...shared, kind: "withdrawn" };
}

export interface ReleasePolicyRepositoryTestHarness {
  readonly conflictingPredecessor: ReleasePolicy;
  readonly dispose?: () => Promise<void>;
  readonly eventConflict: ReleasePolicyLifecycleEvent;
  readonly lineageProbe: ReleasePolicy;
  readonly otherScope: EvidenceScope;
  readonly policy: ReleasePolicy;
  readonly recordConflict: ReleasePolicy;
  readonly repository: ReleasePolicyRepository;
  readonly resourceConflict: ReleasePolicy;
  readonly scope: EvidenceScope;
  readonly successor: ReleasePolicy;
  readonly supersession: Extract<ReleasePolicyLifecycleEvent, { readonly kind: "superseded" }>;
  readonly unrelatedPolicy: ReleasePolicy;
  readonly withdrawal: Extract<ReleasePolicyLifecycleEvent, { readonly kind: "withdrawn" }>;
}

export function createReleasePolicyRepositoryTestHarness(
  namespace: string,
): ReleasePolicyRepositoryTestHarness {
  const scope = releasePolicyFixtureScope(namespace);
  const policy = releasePolicyRepositoryFixture(namespace, scope);
  const successor = releasePolicyRepositoryFixture(namespace, scope, {
    changeRationale: "Replace the accepted policy with its exact successor.",
    predecessor: policyReference(policy),
    publishedAt: "2026-09-07T02:00:00.000Z",
    semanticVersion: "1.0.1",
  });
  const unrelatedPolicy = releasePolicyRepositoryFixture(`${namespace}_unrelated`, scope);
  const otherScope = releasePolicyFixtureScope(namespace, "other");
  const withdrawal = releasePolicyLifecycleFixture(`${namespace}_withdrawn`, policy);
  return {
    conflictingPredecessor: releasePolicyRepositoryFixture(namespace, scope, {
      changeRationale: "Attempt to disguise another policy as this policy's predecessor.",
      predecessor: {
        definitionSha256: unrelatedPolicy.definitionSha256,
        policyId: policy.policyId,
        policyVersionId: unrelatedPolicy.policyVersionId,
      },
      semanticVersion: "1.0.3",
    }),
    eventConflict: releasePolicyLifecycleFixture(`${namespace}_withdrawn`, policy, {
      eventId: withdrawal.eventId,
      reason: "Bind the same event identifier to different lifecycle semantics.",
    }),
    lineageProbe: releasePolicyRepositoryFixture(namespace, scope, {
      changeRationale: "Probe an unavailable predecessor.",
      predecessor: {
        definitionSha256: "f".repeat(64),
        policyId: policy.policyId,
        policyVersionId: `${policy.policyId}_missing`,
      },
      semanticVersion: "1.0.2",
    }),
    otherScope,
    policy,
    recordConflict: releasePolicyRepositoryFixture(namespace, scope, {
      changeRationale: "Bind the same version identifier to different immutable semantics.",
      policyVersionId: policy.policyVersionId,
    }),
    repository: new MemoryReleasePolicyRepository(),
    resourceConflict: releasePolicyRepositoryFixture(`${namespace}_other_scope`, otherScope, {
      policyId: policy.policyId,
      policyVersionId: `${policy.policyId}_other_scope_v1`,
    }),
    scope,
    successor,
    supersession: releasePolicyLifecycleFixture(`${namespace}_superseded`, policy, {
      kind: "superseded",
      successor,
    }) as Extract<ReleasePolicyLifecycleEvent, { readonly kind: "superseded" }>,
    unrelatedPolicy,
    withdrawal: withdrawal as Extract<ReleasePolicyLifecycleEvent, { readonly kind: "withdrawn" }>,
  };
}
