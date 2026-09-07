import {
  EvidenceScopeSchema,
  evidenceTimestampOrderKey,
  OpaqueIdSchema,
  type PrincipalContext,
  PrincipalContextSchema,
  PublishReleasePolicyLifecycleRequestSchema,
  PublishReleasePolicyRequestSchema,
  RELEASE_POLICY_LIFECYCLE_SCHEMA_VERSION,
  RELEASE_POLICY_SCHEMA_VERSION,
  type ReleasePolicy,
  type ReleasePolicyDefinition,
  ReleasePolicyDefinitionSchema,
  type ReleasePolicyLifecycleEvent,
  type ReleasePolicyReference,
  UtcMillisecondTimestampSchema,
} from "@proofstack/contracts";
import { requireCapability, requireEnvironmentAccess } from "../auth/authorization.js";
import type { Clock } from "../clock.js";
import { ForbiddenError } from "../errors.js";
import { validateReleasePolicyAuthority } from "./release-policy-authority.js";
import type { ReleasePolicyAuthorityEvidenceResolver } from "./release-policy-authority-resolver.js";
import {
  InvalidReleasePolicyAuthorityInputError,
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
import {
  digestReleasePolicyDefinition,
  releasePolicyReference,
  validateReleasePolicyLifecycleEvent,
  validateReleasePolicyRecord,
} from "./release-policy-record-validation.js";
import type {
  PublishReleasePolicyLifecycleResult,
  PublishReleasePolicyResult,
  ReleasePolicyRepository,
} from "./release-policy-repository.js";

interface ReleasePolicyRoute {
  readonly environmentId: string;
  readonly policyId: string;
  readonly policyVersionId: string;
  readonly principal: PrincipalContext;
  readonly projectId: string;
}

export interface PublishReleasePolicyCommand extends ReleasePolicyRoute {
  readonly input: unknown;
}

export interface ReadReleasePolicyCommand extends ReleasePolicyRoute {}

export interface ReadReleasePolicyLifecycleCommand extends ReleasePolicyRoute {
  readonly eventId: string;
}

export interface PublishReleasePolicyLifecycleCommand extends ReleasePolicyRoute {
  readonly input: unknown;
}

export interface PublishReleasePolicyDependencies {
  readonly authorityResolver: ReleasePolicyAuthorityEvidenceResolver;
  readonly clock: Clock;
  readonly repository: ReleasePolicyRepository;
}

export interface PublishReleasePolicyLifecycleDependencies {
  readonly clock: Clock;
  readonly repository: ReleasePolicyRepository;
}

function invalidCommand(message: string, cause?: unknown): InvalidReleasePolicyCommandError {
  return new InvalidReleasePolicyCommandError(message, cause === undefined ? undefined : { cause });
}

function authorizedScope(
  command: ReleasePolicyRoute,
  capability: "policy:author" | "policy:read",
): { readonly principal: PrincipalContext; readonly scope: ReleasePolicy["scope"] } {
  let principal: PrincipalContext;
  try {
    principal = PrincipalContextSchema.parse(command.principal);
  } catch (cause) {
    throw invalidCommand("Release policy principal is invalid", cause);
  }
  requireCapability(principal, capability);
  if (capability === "policy:author" && principal.principalType === "workload") {
    throw new ForbiddenError("Workload principals cannot exercise non-delegable policy authority");
  }
  requireEnvironmentAccess(principal, command.projectId, command.environmentId);
  const scope = EvidenceScopeSchema.safeParse({
    environmentId: command.environmentId,
    projectId: command.projectId,
    tenantId: principal.tenantId,
  });
  if (!scope.success) throw invalidCommand("Release policy route is invalid", scope.error);
  return { principal, scope: scope.data };
}

function sameScope(left: ReleasePolicy["scope"], right: ReleasePolicy["scope"]): boolean {
  return (
    left.tenantId === right.tenantId &&
    left.projectId === right.projectId &&
    left.environmentId === right.environmentId
  );
}

function samePolicyReference(left: ReleasePolicyReference, right: ReleasePolicyReference): boolean {
  return (
    left.policyId === right.policyId &&
    left.policyVersionId === right.policyVersionId &&
    left.definitionSha256 === right.definitionSha256
  );
}

function validateRepositoryPolicy(
  input: unknown,
  scope: ReleasePolicy["scope"],
  policyVersionId: string,
): ReleasePolicy {
  let policy: ReleasePolicy;
  try {
    policy = validateReleasePolicyRecord(input);
  } catch (cause) {
    throw new ReleasePolicyRepositoryContractError(
      "Release policy repository returned an invalid immutable record",
      { cause },
    );
  }
  if (policy.policyVersionId !== policyVersionId || !sameScope(policy.scope, scope)) {
    throw new ReleasePolicyRepositoryContractError(
      "Release policy repository substituted a record outside the exact query",
    );
  }
  return policy;
}

function validateRepositoryLifecycleEvent(
  input: unknown,
  scope: ReleasePolicy["scope"],
  eventId: string,
): ReleasePolicyLifecycleEvent {
  let event: ReleasePolicyLifecycleEvent;
  try {
    event = validateReleasePolicyLifecycleEvent(input);
  } catch (cause) {
    throw new ReleasePolicyRepositoryContractError(
      "Release policy repository returned an invalid lifecycle event",
      { cause },
    );
  }
  if (event.eventId !== eventId || !sameScope(event.scope, scope)) {
    throw new ReleasePolicyRepositoryContractError(
      "Release policy repository substituted a lifecycle event outside the exact query",
    );
  }
  return event;
}

function resultObject(input: unknown, recordKey: "event" | "policy") {
  if (typeof input !== "object" || input === null) {
    throw new ReleasePolicyRepositoryContractError(
      "Release policy repository returned an invalid publication result",
    );
  }
  try {
    const keys = Reflect.ownKeys(input);
    const created = Reflect.get(input, "created");
    if (
      keys.length !== 2 ||
      !keys.includes("created") ||
      !keys.includes(recordKey) ||
      typeof created !== "boolean"
    ) {
      throw new ReleasePolicyRepositoryContractError(
        "Release policy repository returned an invalid publication result",
      );
    }
    return { created, record: Reflect.get(input, recordKey) };
  } catch (cause) {
    if (cause instanceof ReleasePolicyRepositoryContractError) throw cause;
    throw new ReleasePolicyRepositoryContractError(
      "Release policy repository result is unreadable",
      { cause },
    );
  }
}

function validatePolicyPublicationResult(
  input: unknown,
  scope: ReleasePolicy["scope"],
  policyId: string,
  policyVersionId: string,
  definitionSha256: string,
  publishedAt: string,
): PublishReleasePolicyResult {
  const result = resultObject(input, "policy");
  const policy = validateRepositoryPolicy(result.record, scope, policyVersionId);
  if (policy.policyId !== policyId || policy.definitionSha256 !== definitionSha256) {
    throw new ReleasePolicyRepositoryContractError(
      "Release policy publication substituted immutable semantics",
    );
  }
  if (result.created && policy.publishedAt !== publishedAt) {
    throw new ReleasePolicyRepositoryContractError(
      "Release policy publication substituted its server receipt",
    );
  }
  return { created: result.created, policy };
}

function validateLifecyclePublicationResult(
  input: unknown,
  scope: ReleasePolicy["scope"],
  expected: ReleasePolicyLifecycleEvent,
  target: ReleasePolicy,
  successor?: ReleasePolicy,
): PublishReleasePolicyLifecycleResult {
  const result = resultObject(input, "event");
  const event = validateRepositoryLifecycleEvent(result.record, scope, expected.eventId);
  if (
    !sameLifecycleIntent(event, expected) ||
    (result.created && event.actorPrincipalId !== expected.actorPrincipalId)
  ) {
    throw new ReleasePolicyRepositoryContractError(
      "Release policy lifecycle publication substituted immutable semantics",
    );
  }
  if (result.created && event.occurredAt !== expected.occurredAt) {
    throw new ReleasePolicyRepositoryContractError(
      "Release policy lifecycle publication substituted its server receipt",
    );
  }
  validateLifecyclePolicyRecords(event, target, successor);
  if (event.actorPrincipalId !== expected.actorPrincipalId) {
    // An identical intent can race in storage, which preserves the first actor's receipt.
    // The losing actor receives the same conflict as an already-visible event, not an outage.
    throw new ReleasePolicyLifecycleEventConflictError(expected.eventId);
  }
  return { created: result.created, event };
}

function serverTimestamp(clock: Clock): string {
  let value: string;
  try {
    value = clock.now().toISOString();
  } catch (cause) {
    throw invalidCommand("Release policy clock is invalid", cause);
  }
  const timestamp = UtcMillisecondTimestampSchema.safeParse(value);
  if (!timestamp.success) throw invalidCommand("Release policy clock is invalid", timestamp.error);
  return timestamp.data;
}

async function exactPolicy(
  repository: ReleasePolicyRepository,
  scope: ReleasePolicy["scope"],
  policyId: string,
  policyVersionId: string,
): Promise<ReleasePolicy> {
  const input = await repository.findReleasePolicy(structuredClone(scope), policyVersionId);
  if (input === null) throw new ReleasePolicyNotFoundError(policyVersionId);
  const policy = validateRepositoryPolicy(input, scope, policyVersionId);
  if (policy.policyId !== policyId) throw new ReleasePolicyNotFoundError(policyVersionId);
  return policy;
}

async function predecessorReference(
  repository: ReleasePolicyRepository,
  scope: ReleasePolicy["scope"],
  policyId: string,
  policyVersionId: string,
  predecessorVersionId: string,
): Promise<ReleasePolicyReference> {
  try {
    return releasePolicyReference(
      await exactPolicy(repository, scope, policyId, predecessorVersionId),
    );
  } catch (cause) {
    if (cause instanceof ReleasePolicyNotFoundError) {
      throw new ReleasePolicyLineageError(policyVersionId, predecessorVersionId);
    }
    throw cause;
  }
}

function validateLifecyclePolicyRecords(
  event: ReleasePolicyLifecycleEvent,
  target: ReleasePolicy,
  successor?: ReleasePolicy,
): void {
  if (
    !sameScope(event.scope, target.scope) ||
    !samePolicyReference(event.policy, releasePolicyReference(target)) ||
    (event.kind === "superseded" &&
      (!successor ||
        !sameScope(successor.scope, target.scope) ||
        !samePolicyReference(event.successor, releasePolicyReference(successor)) ||
        !successor.predecessor ||
        !samePolicyReference(successor.predecessor, releasePolicyReference(target))))
  ) {
    throw new ReleasePolicyRepositoryContractError(
      "Release policy lifecycle history references non-exact policy records",
    );
  }
  const occurredAt = evidenceTimestampOrderKey(event.occurredAt);
  if (
    occurredAt < evidenceTimestampOrderKey(target.publishedAt) ||
    (successor && occurredAt < evidenceTimestampOrderKey(successor.publishedAt))
  ) {
    throw new ReleasePolicyRepositoryContractError(
      "Release policy lifecycle history predates an authoritative policy receipt",
    );
  }
}

async function validateRetainedLifecycle(
  repository: ReleasePolicyRepository,
  event: ReleasePolicyLifecycleEvent,
  target: ReleasePolicy,
): Promise<void> {
  let successor: ReleasePolicy | undefined;
  if (event.kind === "superseded") {
    try {
      successor = await exactPolicy(
        repository,
        target.scope,
        target.policyId,
        event.successor.policyVersionId,
      );
    } catch (cause) {
      if (cause instanceof ReleasePolicyNotFoundError) {
        throw new ReleasePolicyRepositoryContractError(
          "Release policy lifecycle history references an unavailable successor",
          { cause },
        );
      }
      throw cause;
    }
  }
  validateLifecyclePolicyRecords(event, target, successor);
}

async function validateLifecycleHistory(
  repository: ReleasePolicyRepository,
  input: unknown,
  scope: ReleasePolicy["scope"],
  target: ReleasePolicy,
): Promise<readonly ReleasePolicyLifecycleEvent[]> {
  // This version permits one terminal event only; multiple individually valid events are corrupt.
  if (!Array.isArray(input) || input.length > 1) {
    throw new ReleasePolicyRepositoryContractError(
      "Release policy repository returned invalid lifecycle history",
    );
  }
  const history: ReleasePolicyLifecycleEvent[] = [];
  for (const candidate of input) {
    let event: ReleasePolicyLifecycleEvent;
    try {
      event = validateReleasePolicyLifecycleEvent(candidate);
    } catch (cause) {
      throw new ReleasePolicyRepositoryContractError(
        "Release policy repository returned invalid lifecycle history",
        { cause },
      );
    }
    if (
      !sameScope(event.scope, scope) ||
      !samePolicyReference(event.policy, releasePolicyReference(target))
    ) {
      throw new ReleasePolicyRepositoryContractError(
        "Release policy repository returned non-exact lifecycle history",
      );
    }
    await validateRetainedLifecycle(repository, event, target);
    history.push(event);
  }
  return history;
}

function sameLifecycleIntent(
  left: ReleasePolicyLifecycleEvent,
  right: ReleasePolicyLifecycleEvent,
): boolean {
  return (
    left.eventId === right.eventId &&
    left.kind === right.kind &&
    left.reason === right.reason &&
    sameScope(left.scope, right.scope) &&
    samePolicyReference(left.policy, right.policy) &&
    (left.kind !== "superseded" ||
      (right.kind === "superseded" && samePolicyReference(left.successor, right.successor)))
  );
}

export class PublishReleasePolicy {
  constructor(private readonly dependencies: PublishReleasePolicyDependencies) {}

  async execute(command: PublishReleasePolicyCommand): Promise<PublishReleasePolicyResult> {
    const { principal, scope } = authorizedScope(command, "policy:author");
    const policyId = OpaqueIdSchema.safeParse(command.policyId);
    const policyVersionId = OpaqueIdSchema.safeParse(command.policyVersionId);
    const input = PublishReleasePolicyRequestSchema.safeParse(command.input);
    if (!policyId.success || !policyVersionId.success || !input.success) {
      throw invalidCommand(
        "Release policy request is invalid",
        !policyId.success
          ? policyId.error
          : !policyVersionId.success
            ? policyVersionId.error
            : input.error,
      );
    }
    if (input.data.policyVersionId !== policyVersionId.data) {
      throw invalidCommand("Release policy route and immutable identifier do not match");
    }

    const { predecessorVersionId, ...requestDefinition } = input.data;
    const predecessor = predecessorVersionId
      ? await predecessorReference(
          this.dependencies.repository,
          scope,
          policyId.data,
          policyVersionId.data,
          predecessorVersionId,
        )
      : undefined;
    let definition: ReleasePolicyDefinition;
    try {
      definition = ReleasePolicyDefinitionSchema.parse({
        ...requestDefinition,
        issuerPrincipalId: principal.principalId,
        policyId: policyId.data,
        ...(predecessor ? { predecessor } : {}),
      });
    } catch (cause) {
      throw invalidCommand("Release policy definition is invalid", cause);
    }
    const definitionSha256 = digestReleasePolicyDefinition(scope, definition);

    const existingInput = await this.dependencies.repository.findReleasePolicy(
      structuredClone(scope),
      policyVersionId.data,
    );
    if (existingInput !== null) {
      const existing = validateRepositoryPolicy(existingInput, scope, policyVersionId.data);
      if (existing.policyId !== policyId.data) {
        throw new ReleasePolicyRepositoryContractError(
          "Release policy repository substituted a different logical policy",
        );
      }
      if (existing.definitionSha256 !== definitionSha256) {
        throw new ReleasePolicyVersionConflictError(policyVersionId.data);
      }
      return { created: false, policy: structuredClone(existing) };
    }

    const evidence = await this.dependencies.authorityResolver.resolve({
      definition: structuredClone(definition),
      scope: structuredClone(scope),
    });
    const publishedAt = serverTimestamp(this.dependencies.clock);
    let authority: ReturnType<typeof validateReleasePolicyAuthority>;
    try {
      authority = validateReleasePolicyAuthority({
        ...evidence,
        at: publishedAt,
        definition,
        publisherPrincipalId: principal.principalId,
        scope,
      });
    } catch (cause) {
      if (cause instanceof InvalidReleasePolicyAuthorityInputError) {
        throw new ReleasePolicyAuthorityResolverContractError(
          "Policy authority resolver output violates the validation contract",
          { cause },
        );
      }
      throw cause;
    }
    if (authority.status === "invalid") {
      throw new ReleasePolicyAuthorityRejectedError(authority.findings);
    }

    const policy = validateReleasePolicyRecord({
      ...definition,
      definitionSha256,
      publishedAt,
      publishedByPrincipalId: principal.principalId,
      schemaVersion: RELEASE_POLICY_SCHEMA_VERSION,
      scope,
    });
    const result = validatePolicyPublicationResult(
      await this.dependencies.repository.publishReleasePolicy(structuredClone(policy)),
      scope,
      policyId.data,
      policyVersionId.data,
      definitionSha256,
      publishedAt,
    );
    return { created: result.created, policy: structuredClone(result.policy) };
  }
}

export class ReadReleasePolicy {
  constructor(private readonly repository: ReleasePolicyRepository) {}

  async execute(command: ReadReleasePolicyCommand): Promise<ReleasePolicy> {
    const { scope } = authorizedScope(command, "policy:read");
    const policyId = OpaqueIdSchema.safeParse(command.policyId);
    const policyVersionId = OpaqueIdSchema.safeParse(command.policyVersionId);
    if (!policyId.success || !policyVersionId.success) {
      throw invalidCommand(
        "Release policy route is invalid",
        !policyId.success ? policyId.error : policyVersionId.error,
      );
    }
    return structuredClone(
      await exactPolicy(this.repository, scope, policyId.data, policyVersionId.data),
    );
  }
}

export class ReadReleasePolicyLifecycle {
  constructor(private readonly repository: ReleasePolicyRepository) {}

  async execute(command: ReadReleasePolicyLifecycleCommand): Promise<ReleasePolicyLifecycleEvent> {
    const { scope } = authorizedScope(command, "policy:read");
    const policyId = OpaqueIdSchema.safeParse(command.policyId);
    const policyVersionId = OpaqueIdSchema.safeParse(command.policyVersionId);
    const eventId = OpaqueIdSchema.safeParse(command.eventId);
    if (!policyId.success || !policyVersionId.success || !eventId.success) {
      throw invalidCommand(
        "Release policy lifecycle route is invalid",
        !policyId.success
          ? policyId.error
          : !policyVersionId.success
            ? policyVersionId.error
            : eventId.error,
      );
    }

    const policy = await exactPolicy(this.repository, scope, policyId.data, policyVersionId.data);
    const input = await this.repository.findReleasePolicyLifecycleEvent(
      structuredClone(scope),
      eventId.data,
    );
    if (input === null) throw new ReleasePolicyLifecycleEventNotFoundError(eventId.data);
    const event = validateRepositoryLifecycleEvent(input, scope, eventId.data);
    if (!samePolicyReference(event.policy, releasePolicyReference(policy))) {
      throw new ReleasePolicyLifecycleEventNotFoundError(eventId.data);
    }
    await validateRetainedLifecycle(this.repository, event, policy);
    return structuredClone(event);
  }
}

export class PublishReleasePolicyLifecycle {
  constructor(private readonly dependencies: PublishReleasePolicyLifecycleDependencies) {}

  async execute(
    command: PublishReleasePolicyLifecycleCommand,
  ): Promise<PublishReleasePolicyLifecycleResult> {
    const { principal, scope } = authorizedScope(command, "policy:author");
    const policyId = OpaqueIdSchema.safeParse(command.policyId);
    const policyVersionId = OpaqueIdSchema.safeParse(command.policyVersionId);
    const input = PublishReleasePolicyLifecycleRequestSchema.safeParse(command.input);
    if (!policyId.success || !policyVersionId.success || !input.success) {
      throw invalidCommand(
        "Release policy lifecycle request is invalid",
        !policyId.success
          ? policyId.error
          : !policyVersionId.success
            ? policyVersionId.error
            : input.error,
      );
    }

    const existingInput = await this.dependencies.repository.findReleasePolicyLifecycleEvent(
      structuredClone(scope),
      input.data.eventId,
    );
    if (existingInput !== null) {
      const existing = validateRepositoryLifecycleEvent(existingInput, scope, input.data.eventId);
      const sameRequest =
        existing.policy.policyId === policyId.data &&
        existing.policy.policyVersionId === policyVersionId.data &&
        existing.actorPrincipalId === principal.principalId &&
        existing.kind === input.data.kind &&
        existing.reason === input.data.reason &&
        (existing.kind !== "superseded" ||
          (input.data.kind === "superseded" &&
            existing.successor.policyVersionId === input.data.successorPolicyVersionId));
      if (!sameRequest) {
        throw new ReleasePolicyLifecycleEventConflictError(input.data.eventId);
      }
      const retryTarget = await exactPolicy(
        this.dependencies.repository,
        scope,
        policyId.data,
        policyVersionId.data,
      );
      await validateRetainedLifecycle(this.dependencies.repository, existing, retryTarget);
      return { created: false, event: structuredClone(existing) };
    }

    const target = await exactPolicy(
      this.dependencies.repository,
      scope,
      policyId.data,
      policyVersionId.data,
    );
    const history = await validateLifecycleHistory(
      this.dependencies.repository,
      await this.dependencies.repository.listReleasePolicyLifecycleEvents(
        structuredClone(scope),
        policyVersionId.data,
      ),
      scope,
      target,
    );
    if (history.length > 0) {
      throw new ReleasePolicyLifecycleStateConflictError(policyVersionId.data);
    }

    let successor: ReleasePolicy | undefined;
    if (input.data.kind === "superseded") {
      try {
        successor = await exactPolicy(
          this.dependencies.repository,
          scope,
          policyId.data,
          input.data.successorPolicyVersionId,
        );
      } catch (cause) {
        if (cause instanceof ReleasePolicyNotFoundError) {
          throw new ReleasePolicyLineageError(
            policyVersionId.data,
            input.data.successorPolicyVersionId,
          );
        }
        throw cause;
      }
      if (
        !successor.predecessor ||
        !samePolicyReference(successor.predecessor, releasePolicyReference(target))
      ) {
        throw new ReleasePolicyLineageError(
          policyVersionId.data,
          input.data.successorPolicyVersionId,
        );
      }
    }

    const occurredAt = serverTimestamp(this.dependencies.clock);
    if (
      evidenceTimestampOrderKey(occurredAt) < evidenceTimestampOrderKey(target.publishedAt) ||
      (successor &&
        evidenceTimestampOrderKey(occurredAt) < evidenceTimestampOrderKey(successor.publishedAt))
    ) {
      throw invalidCommand("Release policy lifecycle time precedes its immutable policy records");
    }
    const event = validateReleasePolicyLifecycleEvent({
      actorPrincipalId: principal.principalId,
      eventId: input.data.eventId,
      kind: input.data.kind,
      occurredAt,
      policy: releasePolicyReference(target),
      reason: input.data.reason,
      schemaVersion: RELEASE_POLICY_LIFECYCLE_SCHEMA_VERSION,
      scope,
      ...(successor ? { successor: releasePolicyReference(successor) } : {}),
    });
    const result = validateLifecyclePublicationResult(
      await this.dependencies.repository.publishReleasePolicyLifecycleEvent(structuredClone(event)),
      scope,
      event,
      target,
      successor,
    );
    return { created: result.created, event: structuredClone(result.event) };
  }
}
