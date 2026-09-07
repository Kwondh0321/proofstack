import type {
  PublishReleasePolicyLifecycleRequest,
  PublishReleasePolicyLifecycleResponse,
  PublishReleasePolicyRequest,
  PublishReleasePolicyResponse,
  ReadReleasePolicyLifecycleResponse,
  ReadReleasePolicyResponse,
  ReleasePolicy,
  ReleasePolicyLifecycleEvent,
} from "@proofstack/contracts";
import type { ProofStackReleasePolicyClient } from "@proofstack/sdk";

type ReleasePolicyClient = Pick<
  ProofStackReleasePolicyClient,
  "publishLifecycleEvent" | "publishPolicy" | "readLifecycleEvent" | "readPolicy"
>;

export interface RunWorkflow2ReleasePolicyOptions {
  readonly client: ReleasePolicyClient;
  readonly lifecycleRequest: PublishReleasePolicyLifecycleRequest;
  readonly policyId: string;
  readonly request: PublishReleasePolicyRequest;
}

export interface Workflow2ReleasePolicySummary {
  readonly immutableHistoryVerified: true;
  readonly lifecycle: {
    readonly eventId: string;
    readonly kind: ReleasePolicyLifecycleEvent["kind"];
    readonly retryCreated: false;
  };
  readonly policy: {
    readonly definitionSha256: string;
    readonly policyId: string;
    readonly policyVersionId: string;
    readonly retryCreated: false;
  };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return `${JSON.stringify(value)}`;
}

function assertSameRecord(left: unknown, right: unknown, label: string): void {
  if (stableJson(left) !== stableJson(right)) {
    throw new TypeError(`${label} changed immutable record content`);
  }
}

function assertInitialCreation(response: { readonly created: boolean }, label: string): void {
  if (!response.created) throw new TypeError(`${label} must create fresh disposable state`);
}

function assertIdempotentRetry(response: { readonly created: boolean }, label: string): void {
  if (response.created) throw new TypeError(`${label} retry must return created=false`);
}

function assertPolicyIdentity(
  policy: ReleasePolicy,
  policyId: string,
  policyVersionId: string,
): void {
  if (policy.policyId !== policyId || policy.policyVersionId !== policyVersionId) {
    throw new TypeError("Policy publication changed the exact requested identity");
  }
}

function assertLifecycleBinding(
  event: ReleasePolicyLifecycleEvent,
  policy: ReleasePolicy,
  request: PublishReleasePolicyLifecycleRequest,
): void {
  if (
    event.eventId !== request.eventId ||
    event.policy.policyId !== policy.policyId ||
    event.policy.policyVersionId !== policy.policyVersionId ||
    event.policy.definitionSha256 !== policy.definitionSha256
  ) {
    throw new TypeError("Lifecycle publication changed the exact policy binding");
  }
}

async function publishAndVerifyPolicy(
  client: ReleasePolicyClient,
  policyId: string,
  request: PublishReleasePolicyRequest,
): Promise<PublishReleasePolicyResponse & { readonly policy: ReleasePolicy }> {
  const publication = await client.publishPolicy({ policyId, request });
  assertInitialCreation(publication, "Policy publication");
  assertPolicyIdentity(publication.policy, policyId, request.policyVersionId);

  const retry = await client.publishPolicy({ policyId, request });
  assertIdempotentRetry(retry, "Policy publication");
  assertSameRecord(retry.policy, publication.policy, "Policy retry");

  const read: ReadReleasePolicyResponse = await client.readPolicy({
    policyId,
    policyVersionId: request.policyVersionId,
  });
  assertSameRecord(read.policy, publication.policy, "Policy read-back");
  return publication;
}

async function publishAndVerifyLifecycle(
  client: ReleasePolicyClient,
  policy: ReleasePolicy,
  request: PublishReleasePolicyLifecycleRequest,
): Promise<
  PublishReleasePolicyLifecycleResponse & { readonly event: ReleasePolicyLifecycleEvent }
> {
  const identity = {
    policyId: policy.policyId,
    policyVersionId: policy.policyVersionId,
  };
  const publication = await client.publishLifecycleEvent({ ...identity, request });
  assertInitialCreation(publication, "Lifecycle publication");
  assertLifecycleBinding(publication.event, policy, request);

  const retry = await client.publishLifecycleEvent({ ...identity, request });
  assertIdempotentRetry(retry, "Lifecycle publication");
  assertSameRecord(retry.event, publication.event, "Lifecycle retry");

  const read: ReadReleasePolicyLifecycleResponse = await client.readLifecycleEvent({
    ...identity,
    eventId: request.eventId,
  });
  assertSameRecord(read.event, publication.event, "Lifecycle read-back");
  return publication;
}

/**
 * Crosses the public SDK and HTTP boundary while preserving one exact immutable policy history.
 * This workflow only publishes and reads a policy definition and one lifecycle event. It does not
 * evaluate a candidate, select a policy, record an approval, decide a release, or deploy anything.
 */
export async function runWorkflow2ReleasePolicy(
  options: RunWorkflow2ReleasePolicyOptions,
): Promise<Workflow2ReleasePolicySummary> {
  const policyPublication = await publishAndVerifyPolicy(
    options.client,
    options.policyId,
    options.request,
  );
  const lifecyclePublication = await publishAndVerifyLifecycle(
    options.client,
    policyPublication.policy,
    options.lifecycleRequest,
  );

  return {
    immutableHistoryVerified: true,
    lifecycle: {
      eventId: lifecyclePublication.event.eventId,
      kind: lifecyclePublication.event.kind,
      retryCreated: false,
    },
    policy: {
      definitionSha256: policyPublication.policy.definitionSha256,
      policyId: policyPublication.policy.policyId,
      policyVersionId: policyPublication.policy.policyVersionId,
      retryCreated: false,
    },
  };
}
