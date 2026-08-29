import type { JsonObject } from "@proofstack/contracts";
import {
  validateAndProjectReplayPlan,
  validateAndProjectTargetRelease,
} from "./replay-definition.js";

export const REPLAY_DEFINITION_OUTBOX_SCHEMA_VERSION = "0.1" as const;
export const TARGET_RELEASE_AGGREGATE_TYPE = "replay.target-release" as const;
export const REPLAY_PLAN_AGGREGATE_TYPE = "replay.plan" as const;
export const TARGET_RELEASE_PUBLISHED_EVENT_TYPE = "replay.target-release.published" as const;
export const REPLAY_PLAN_PUBLISHED_EVENT_TYPE = "replay.plan.published" as const;

export interface ReplayDefinitionPublicationOutboxIntent<
  AggregateType extends string = string,
  EventType extends string = string,
  Payload extends JsonObject = JsonObject,
> {
  readonly aggregateId: string;
  readonly aggregateType: AggregateType;
  readonly createdAt: string;
  readonly eventType: EventType;
  readonly payload: Payload;
  readonly schemaVersion: typeof REPLAY_DEFINITION_OUTBOX_SCHEMA_VERSION;
  readonly tenantId: string;
}

export type TargetReleasePublishedOutboxIntent = ReplayDefinitionPublicationOutboxIntent<
  typeof TARGET_RELEASE_AGGREGATE_TYPE,
  typeof TARGET_RELEASE_PUBLISHED_EVENT_TYPE,
  {
    readonly definitionSha256: string;
    readonly environmentId: string;
    readonly projectId: string;
    readonly targetId: string;
    readonly targetReleaseId: string;
  }
>;

export type ReplayPlanPublishedOutboxIntent = ReplayDefinitionPublicationOutboxIntent<
  typeof REPLAY_PLAN_AGGREGATE_TYPE,
  typeof REPLAY_PLAN_PUBLISHED_EVENT_TYPE,
  {
    readonly definitionSha256: string;
    readonly environmentId: string;
    readonly planId: string;
    readonly planVersionId: string;
    readonly projectId: string;
    readonly targetReleaseId: string;
  }
>;

export type PublishedReplayDefinitionOutboxIntent =
  | ReplayPlanPublishedOutboxIntent
  | TargetReleasePublishedOutboxIntent;

export function buildTargetReleasePublishedOutboxIntent(
  input: unknown,
): TargetReleasePublishedOutboxIntent {
  const { release } = validateAndProjectTargetRelease(input);
  return {
    aggregateId: release.targetReleaseId,
    aggregateType: TARGET_RELEASE_AGGREGATE_TYPE,
    createdAt: release.createdAt,
    eventType: TARGET_RELEASE_PUBLISHED_EVENT_TYPE,
    payload: {
      definitionSha256: release.definitionSha256,
      environmentId: release.scope.environmentId,
      projectId: release.scope.projectId,
      targetId: release.targetId,
      targetReleaseId: release.targetReleaseId,
    },
    schemaVersion: REPLAY_DEFINITION_OUTBOX_SCHEMA_VERSION,
    tenantId: release.scope.tenantId,
  };
}

export function buildReplayPlanPublishedOutboxIntent(
  input: unknown,
): ReplayPlanPublishedOutboxIntent {
  const { plan } = validateAndProjectReplayPlan(input);
  return {
    aggregateId: plan.planVersionId,
    aggregateType: REPLAY_PLAN_AGGREGATE_TYPE,
    createdAt: plan.createdAt,
    eventType: REPLAY_PLAN_PUBLISHED_EVENT_TYPE,
    payload: {
      definitionSha256: plan.definitionSha256,
      environmentId: plan.scope.environmentId,
      planId: plan.planId,
      planVersionId: plan.planVersionId,
      projectId: plan.scope.projectId,
      targetReleaseId: plan.targetRelease.targetReleaseId,
    },
    schemaVersion: REPLAY_DEFINITION_OUTBOX_SCHEMA_VERSION,
    tenantId: plan.scope.tenantId,
  };
}
