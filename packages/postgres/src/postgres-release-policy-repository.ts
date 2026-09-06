import { Buffer } from "node:buffer";
import { isDeepStrictEqual } from "node:util";
import type {
  EvidenceScope,
  ReleasePolicy,
  ReleasePolicyLifecycleEvent,
  ReleasePolicyReference,
} from "@proofstack/contracts";
import {
  InvalidReleasePolicyLifecycleInputError,
  InvalidReleasePolicyRecordInputError,
  type PublishReleasePolicyLifecycleResult,
  type PublishReleasePolicyResult,
  ReleasePolicyLifecycleEventConflictError,
  ReleasePolicyLifecycleStateConflictError,
  ReleasePolicyLineageError,
  type ReleasePolicyRepository,
  ReleasePolicyRepositoryContractError,
  ReleasePolicyResourceConflictError,
  ReleasePolicyVersionConflictError,
  releasePolicyReference,
  validateReleasePolicyLifecycleEvent,
  validateReleasePolicyRecord,
} from "@proofstack/core";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { withExactScopeTransaction } from "./tenant-transaction.js";

interface StoredReleasePolicyRow extends QueryResultRow {
  readonly counterevidence_count: number;
  readonly counterevidence_projections: unknown;
  readonly definition_sha256: string;
  readonly effective_at_lexical: string;
  readonly environment_id: string;
  readonly expires_at_lexical: string;
  readonly lineage_count: number;
  readonly mode: string;
  readonly parent_definition_sha256: string | null;
  readonly parent_policy_version_id: string | null;
  readonly policy_id: string;
  readonly policy_version_id: string;
  readonly project_id: string;
  readonly published_at_lexical: string;
  readonly published_by_principal_id: string;
  readonly record: unknown;
  readonly root_definition_sha256: string;
  readonly root_lineage_count: number | null;
  readonly root_policy_id: string | null;
  readonly root_policy_version_id: string;
  readonly rule_count: number;
  readonly rule_projections: unknown;
  readonly rule_source_projections: unknown;
  readonly schema_version: string;
  readonly semantic_version: string;
  readonly source_count: number;
  readonly source_projections: unknown;
  readonly tenant_id: string;
}

interface StoredReleasePolicyLifecycleRow extends QueryResultRow {
  readonly actor_principal_id: string;
  readonly environment_id: string;
  readonly event_id: string;
  readonly kind: string;
  readonly occurred_at_lexical: string;
  readonly policy_definition_sha256: string;
  readonly policy_id: string;
  readonly policy_version_id: string;
  readonly project_id: string;
  readonly reason: string;
  readonly record: unknown;
  readonly schema_version: string;
  readonly successor_definition_sha256: string | null;
  readonly successor_policy_id: string | null;
  readonly successor_policy_version_id: string | null;
  readonly tenant_id: string;
}

interface OutboxIntentRow extends QueryResultRow {
  readonly status: string;
}

function clone<Value>(value: Value): Value {
  return structuredClone(value);
}

function scopesEqual(left: EvidenceScope, right: EvidenceScope): boolean {
  return (
    left.tenantId === right.tenantId &&
    left.projectId === right.projectId &&
    left.environmentId === right.environmentId
  );
}

function referencesEqual(left: ReleasePolicyReference, right: ReleasePolicyReference): boolean {
  return (
    left.policyId === right.policyId &&
    left.policyVersionId === right.policyVersionId &&
    left.definitionSha256 === right.definitionSha256
  );
}

function postgresCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}

function postgresMessage(error: unknown): string {
  return typeof error === "object" && error !== null && "message" in error
    ? String(error.message)
    : "";
}

function postgresConstraint(error: unknown): string {
  return typeof error === "object" && error !== null && "constraint" in error
    ? String(error.constraint)
    : "";
}

function mapPolicyPersistenceError(error: unknown, policy: ReleasePolicy): never {
  if (
    error instanceof InvalidReleasePolicyRecordInputError ||
    error instanceof ReleasePolicyLineageError ||
    error instanceof ReleasePolicyRepositoryContractError ||
    error instanceof ReleasePolicyResourceConflictError ||
    error instanceof ReleasePolicyVersionConflictError
  ) {
    throw error;
  }

  const code = postgresCode(error);
  const message = postgresMessage(error);
  if (code === "23503" || (code === "23514" && /lineage/i.test(message))) {
    throw new ReleasePolicyLineageError(
      policy.policyVersionId,
      policy.predecessor?.policyVersionId ?? "missing_predecessor",
    );
  }
  if (code === "23505" && /release policy resource/i.test(message)) {
    throw new ReleasePolicyResourceConflictError(policy.policyId);
  }
  if (code === "23505") {
    throw new ReleasePolicyVersionConflictError(policy.policyVersionId);
  }
  if (code === "23514" || code === "22007" || code === "22P02") {
    throw new ReleasePolicyRepositoryContractError(
      "PostgreSQL rejected normalized release policy persistence",
      { cause: error },
    );
  }
  throw error;
}

function mapLifecyclePersistenceError(error: unknown, event: ReleasePolicyLifecycleEvent): never {
  if (
    error instanceof InvalidReleasePolicyLifecycleInputError ||
    error instanceof ReleasePolicyLifecycleEventConflictError ||
    error instanceof ReleasePolicyLifecycleStateConflictError ||
    error instanceof ReleasePolicyLineageError ||
    error instanceof ReleasePolicyRepositoryContractError
  ) {
    throw error;
  }

  const code = postgresCode(error);
  const constraint = postgresConstraint(error);
  if (code === "23503") {
    throw new ReleasePolicyLineageError(
      event.policy.policyVersionId,
      event.kind === "superseded" ? event.successor.policyVersionId : event.policy.policyVersionId,
    );
  }
  if (code === "23505" && constraint.endsWith("terminal_unique")) {
    throw new ReleasePolicyLifecycleStateConflictError(event.policy.policyVersionId);
  }
  if (code === "23505") {
    throw new ReleasePolicyLifecycleEventConflictError(event.eventId);
  }
  if (code === "23514" || code === "22007" || code === "22P02") {
    throw new ReleasePolicyRepositoryContractError(
      "PostgreSQL rejected normalized release policy lifecycle persistence",
      { cause: error },
    );
  }
  throw error;
}

async function acquireLocks(client: PoolClient, keys: readonly string[]): Promise<void> {
  const ordered = [...new Set(keys)].sort((left, right) =>
    Buffer.compare(Buffer.from(left), Buffer.from(right)),
  );
  for (const key of ordered) {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [key]);
  }
}

async function loadStoredPolicy(
  client: PoolClient,
  scope: EvidenceScope,
  policyVersionId: string,
): Promise<StoredReleasePolicyRow | null> {
  const result = await client.query<StoredReleasePolicyRow>(
    `SELECT
       policy.tenant_id,
       policy.project_id,
       policy.environment_id,
       policy.policy_id,
       policy.policy_version_id,
       policy.schema_version,
       policy.definition_sha256,
       policy.semantic_version,
       policy.mode,
       policy.effective_at_lexical,
       policy.expires_at_lexical,
       policy.published_at_lexical,
       policy.published_by_principal_id,
       policy.source_count,
       policy.counterevidence_count,
       policy.rule_count,
       policy.lineage_count,
       policy.record,
       resource.root_policy_version_id,
       resource.root_definition_sha256,
       (
         SELECT root.policy_id
         FROM public.proofstack_release_policies AS root
         WHERE root.tenant_id = resource.tenant_id
           AND root.project_id = resource.project_id
           AND root.environment_id = resource.environment_id
           AND root.policy_version_id = resource.root_policy_version_id
           AND root.definition_sha256 = resource.root_definition_sha256
       ) AS root_policy_id,
       (
         SELECT root.lineage_count
         FROM public.proofstack_release_policies AS root
         WHERE root.tenant_id = resource.tenant_id
           AND root.project_id = resource.project_id
           AND root.environment_id = resource.environment_id
           AND root.policy_version_id = resource.root_policy_version_id
           AND root.definition_sha256 = resource.root_definition_sha256
       ) AS root_lineage_count,
       lineage.parent_policy_version_id,
       lineage.parent_definition_sha256,
       COALESCE((
         SELECT jsonb_agg(source.reference ORDER BY source.source_position)
         FROM public.proofstack_release_policy_sources AS source
         WHERE source.tenant_id = policy.tenant_id
           AND source.project_id = policy.project_id
           AND source.environment_id = policy.environment_id
           AND source.policy_version_id = policy.policy_version_id
           AND source.policy_definition_sha256 = policy.definition_sha256
           AND source.collection = 'sources'
       ), '[]'::jsonb) AS source_projections,
       COALESCE((
         SELECT jsonb_agg(source.reference ORDER BY source.source_position)
         FROM public.proofstack_release_policy_sources AS source
         WHERE source.tenant_id = policy.tenant_id
           AND source.project_id = policy.project_id
           AND source.environment_id = policy.environment_id
           AND source.policy_version_id = policy.policy_version_id
           AND source.policy_definition_sha256 = policy.definition_sha256
           AND source.collection = 'counterevidence'
       ), '[]'::jsonb) AS counterevidence_projections,
       COALESCE((
         SELECT jsonb_agg(rule.rule ORDER BY rule.rule_position)
         FROM public.proofstack_release_policy_rules AS rule
         WHERE rule.tenant_id = policy.tenant_id
           AND rule.project_id = policy.project_id
           AND rule.environment_id = policy.environment_id
           AND rule.policy_version_id = policy.policy_version_id
           AND rule.policy_definition_sha256 = policy.definition_sha256
       ), '[]'::jsonb) AS rule_projections,
       COALESCE((
         SELECT jsonb_agg(
           jsonb_build_object(
             'rulePosition', source.rule_position,
             'sourcePosition', source.source_position,
             'reference', source.reference
           ) ORDER BY source.rule_position, source.source_position
         )
         FROM public.proofstack_release_policy_rule_sources AS source
         WHERE source.tenant_id = policy.tenant_id
           AND source.project_id = policy.project_id
           AND source.environment_id = policy.environment_id
           AND source.policy_version_id = policy.policy_version_id
           AND source.policy_definition_sha256 = policy.definition_sha256
       ), '[]'::jsonb) AS rule_source_projections
     FROM public.proofstack_release_policies AS policy
     JOIN public.proofstack_release_policy_registry AS registry
       ON registry.tenant_id = policy.tenant_id
      AND registry.project_id = policy.project_id
      AND registry.environment_id = policy.environment_id
      AND registry.policy_version_id = policy.policy_version_id
      AND registry.schema_version = policy.schema_version
      AND registry.definition_sha256 = policy.definition_sha256
     JOIN public.proofstack_release_policy_resources AS resource
       ON resource.tenant_id = policy.tenant_id
      AND resource.project_id = policy.project_id
      AND resource.environment_id = policy.environment_id
      AND resource.policy_id = policy.policy_id
     LEFT JOIN public.proofstack_release_policy_lineage AS lineage
       ON lineage.tenant_id = policy.tenant_id
      AND lineage.project_id = policy.project_id
      AND lineage.environment_id = policy.environment_id
      AND lineage.child_policy_version_id = policy.policy_version_id
      AND lineage.child_definition_sha256 = policy.definition_sha256
     WHERE policy.tenant_id = $1
       AND policy.project_id = $2
       AND policy.environment_id = $3
       AND policy.policy_version_id = $4`,
    [scope.tenantId, scope.projectId, scope.environmentId, policyVersionId],
  );
  return result.rows[0] ?? null;
}

function parseStoredPolicy(row: StoredReleasePolicyRow): ReleasePolicy {
  try {
    const policy = validateReleasePolicyRecord(row.record);
    const predecessor = policy.predecessor;
    const expectedRuleSources = policy.rules.flatMap((rule, ruleIndex) =>
      rule.sources.map((reference, sourceIndex) => ({
        reference,
        rulePosition: ruleIndex + 1,
        sourcePosition: sourceIndex + 1,
      })),
    );
    const exactProjection =
      isDeepStrictEqual(row.source_projections, policy.sources) &&
      isDeepStrictEqual(row.counterevidence_projections, policy.counterevidence) &&
      isDeepStrictEqual(row.rule_projections, policy.rules) &&
      isDeepStrictEqual(row.rule_source_projections, expectedRuleSources);
    if (
      policy.scope.tenantId !== row.tenant_id ||
      policy.scope.projectId !== row.project_id ||
      policy.scope.environmentId !== row.environment_id ||
      policy.policyId !== row.policy_id ||
      policy.policyVersionId !== row.policy_version_id ||
      policy.schemaVersion !== row.schema_version ||
      policy.definitionSha256 !== row.definition_sha256 ||
      policy.semanticVersion !== row.semantic_version ||
      policy.mode !== row.mode ||
      policy.effectiveAt !== row.effective_at_lexical ||
      policy.expiresAt !== row.expires_at_lexical ||
      policy.publishedAt !== row.published_at_lexical ||
      policy.publishedByPrincipalId !== row.published_by_principal_id ||
      policy.sources.length !== row.source_count ||
      policy.counterevidence.length !== row.counterevidence_count ||
      policy.rules.length !== row.rule_count ||
      Number(predecessor !== undefined) !== row.lineage_count ||
      (predecessor?.policyVersionId ?? null) !== row.parent_policy_version_id ||
      (predecessor?.definitionSha256 ?? null) !== row.parent_definition_sha256 ||
      row.root_policy_id !== policy.policyId ||
      row.root_lineage_count !== 0 ||
      !exactProjection
    ) {
      throw new Error("normalized policy graph differs from the canonical record");
    }
    return policy;
  } catch (error) {
    throw new ReleasePolicyRepositoryContractError(
      "Stored release policy violates the canonical graph contract",
      { cause: error },
    );
  }
}

async function loadStoredLifecycleEvent(
  client: PoolClient,
  scope: EvidenceScope,
  eventId: string,
): Promise<StoredReleasePolicyLifecycleRow | null> {
  const result = await client.query<StoredReleasePolicyLifecycleRow>(
    `SELECT tenant_id, project_id, environment_id, event_id, schema_version, kind,
       policy_id, policy_version_id, policy_definition_sha256,
       successor_policy_id, successor_policy_version_id, successor_definition_sha256,
       actor_principal_id, occurred_at_lexical, reason, record
     FROM public.proofstack_release_policy_lifecycle_events
     WHERE tenant_id = $1 AND project_id = $2 AND environment_id = $3 AND event_id = $4`,
    [scope.tenantId, scope.projectId, scope.environmentId, eventId],
  );
  return result.rows[0] ?? null;
}

function parseStoredLifecycleEvent(
  row: StoredReleasePolicyLifecycleRow,
): ReleasePolicyLifecycleEvent {
  try {
    const event = validateReleasePolicyLifecycleEvent(row.record);
    const successor = event.kind === "superseded" ? event.successor : undefined;
    if (
      event.scope.tenantId !== row.tenant_id ||
      event.scope.projectId !== row.project_id ||
      event.scope.environmentId !== row.environment_id ||
      event.eventId !== row.event_id ||
      event.schemaVersion !== row.schema_version ||
      event.kind !== row.kind ||
      event.policy.policyId !== row.policy_id ||
      event.policy.policyVersionId !== row.policy_version_id ||
      event.policy.definitionSha256 !== row.policy_definition_sha256 ||
      (successor?.policyId ?? null) !== row.successor_policy_id ||
      (successor?.policyVersionId ?? null) !== row.successor_policy_version_id ||
      (successor?.definitionSha256 ?? null) !== row.successor_definition_sha256 ||
      event.actorPrincipalId !== row.actor_principal_id ||
      event.occurredAt !== row.occurred_at_lexical ||
      event.reason !== row.reason
    ) {
      throw new Error("normalized lifecycle projection differs from the canonical record");
    }
    return event;
  } catch (error) {
    throw new ReleasePolicyRepositoryContractError(
      "Stored release policy lifecycle event violates the canonical contract",
      { cause: error },
    );
  }
}

function policyOutboxPayload(policy: ReleasePolicy): Readonly<Record<string, unknown>> {
  return { record: clone(policy), recordKind: "release_policy" };
}

function lifecycleOutboxPayload(
  event: ReleasePolicyLifecycleEvent,
): Readonly<Record<string, unknown>> {
  return { record: clone(event), recordKind: "release_policy_lifecycle" };
}

async function requireCanonicalPolicyOutbox(
  client: PoolClient,
  policy: ReleasePolicy,
): Promise<void> {
  const result = await client.query<OutboxIntentRow>(
    `SELECT public.proofstack_release_policy_intent_status(
       $1, $2, $3::jsonb, $4::timestamptz
     ) AS status`,
    [
      policy.policyVersionId,
      policy.schemaVersion,
      JSON.stringify(policyOutboxPayload(policy)),
      policy.publishedAt,
    ],
  );
  if (result.rows[0]?.status !== "canonical") {
    throw new ReleasePolicyRepositoryContractError(
      `Stored release policy ${policy.policyVersionId} is missing its canonical outbox intent`,
    );
  }
}

async function requireCanonicalLifecycleOutbox(
  client: PoolClient,
  event: ReleasePolicyLifecycleEvent,
): Promise<void> {
  const result = await client.query<OutboxIntentRow>(
    `SELECT public.proofstack_release_policy_lifecycle_intent_status(
       $1, $2, $3::jsonb, $4::timestamptz
     ) AS status`,
    [
      event.eventId,
      event.schemaVersion,
      JSON.stringify(lifecycleOutboxPayload(event)),
      event.occurredAt,
    ],
  );
  if (result.rows[0]?.status !== "canonical") {
    throw new ReleasePolicyRepositoryContractError(
      `Stored release policy lifecycle event ${event.eventId} is missing its canonical outbox intent`,
    );
  }
}

function lifecycleSemantics(event: ReleasePolicyLifecycleEvent): unknown {
  const semantics = clone(event) as unknown as Record<string, unknown>;
  for (const key of ["actorPrincipalId", "occurredAt", "schemaVersion"]) delete semantics[key];
  return semantics;
}

function assertExactReference(
  policy: ReleasePolicy | null,
  scope: EvidenceScope,
  reference: ReleasePolicyReference,
): ReleasePolicy {
  if (
    !policy ||
    !scopesEqual(policy.scope, scope) ||
    !referencesEqual(releasePolicyReference(policy), reference)
  ) {
    throw new ReleasePolicyLineageError(reference.policyVersionId, reference.policyVersionId);
  }
  return policy;
}

export class PostgresReleasePolicyRepository implements ReleasePolicyRepository {
  constructor(private readonly pool: Pick<Pool, "connect">) {}

  async findReleasePolicy(
    scope: EvidenceScope,
    policyVersionId: string,
  ): Promise<ReleasePolicy | null> {
    return withExactScopeTransaction(this.pool, scope, async (client) => {
      const row = await loadStoredPolicy(client, scope, policyVersionId);
      return row ? clone(parseStoredPolicy(row)) : null;
    });
  }

  async findReleasePolicyLifecycleEvent(
    scope: EvidenceScope,
    eventId: string,
  ): Promise<ReleasePolicyLifecycleEvent | null> {
    return withExactScopeTransaction(this.pool, scope, async (client) => {
      const row = await loadStoredLifecycleEvent(client, scope, eventId);
      return row ? clone(parseStoredLifecycleEvent(row)) : null;
    });
  }

  async listReleasePolicyLifecycleEvents(
    scope: EvidenceScope,
    policyVersionId: string,
  ): Promise<readonly ReleasePolicyLifecycleEvent[]> {
    return withExactScopeTransaction(this.pool, scope, async (client) => {
      const result = await client.query<StoredReleasePolicyLifecycleRow>(
        `SELECT tenant_id, project_id, environment_id, event_id, schema_version, kind,
           policy_id, policy_version_id, policy_definition_sha256,
           successor_policy_id, successor_policy_version_id, successor_definition_sha256,
           actor_principal_id, occurred_at_lexical, reason, record
         FROM public.proofstack_release_policy_lifecycle_events
         WHERE tenant_id = $1 AND project_id = $2 AND environment_id = $3
           AND policy_version_id = $4
         ORDER BY occurred_at ASC, event_id ASC`,
        [scope.tenantId, scope.projectId, scope.environmentId, policyVersionId],
      );
      return result.rows.map((row) => clone(parseStoredLifecycleEvent(row)));
    });
  }

  async publishReleasePolicy(policyInput: ReleasePolicy): Promise<PublishReleasePolicyResult> {
    const policy = validateReleasePolicyRecord(policyInput);
    const lockPrefix = `proofstack:release-policy:${policy.scope.tenantId}`;
    const lockKeys = [
      `${lockPrefix}:resource:${policy.policyId}`,
      `${lockPrefix}:version:${policy.policyVersionId}`,
      ...(policy.predecessor
        ? [`${lockPrefix}:version:${policy.predecessor.policyVersionId}`]
        : []),
    ];

    try {
      return await withExactScopeTransaction(this.pool, policy.scope, async (client) => {
        await acquireLocks(client, lockKeys);
        const existingRow = await loadStoredPolicy(client, policy.scope, policy.policyVersionId);
        if (existingRow) {
          const existing = parseStoredPolicy(existingRow);
          if (
            existing.policyId !== policy.policyId ||
            existing.definitionSha256 !== policy.definitionSha256
          ) {
            throw new ReleasePolicyVersionConflictError(policy.policyVersionId);
          }
          await requireCanonicalPolicyOutbox(client, existing);
          return { created: false, policy: clone(existing) };
        }

        const command = {
          definitionSha256: policy.definitionSha256,
          environmentId: policy.scope.environmentId,
          policyId: policy.policyId,
          policyVersionId: policy.policyVersionId,
          projectId: policy.scope.projectId,
          publishedAt: policy.publishedAt,
          publishedByPrincipalId: policy.publishedByPrincipalId,
          record: policy,
          schemaVersion: policy.schemaVersion,
          tenantId: policy.scope.tenantId,
        };
        await client.query("SELECT public.proofstack_publish_release_policy($1::jsonb)", [
          JSON.stringify(command),
        ]);

        const storedRow = await loadStoredPolicy(client, policy.scope, policy.policyVersionId);
        if (!storedRow) {
          throw new ReleasePolicyRepositoryContractError(
            "PostgreSQL accepted release policy publication without retaining its exact graph",
          );
        }
        const stored = parseStoredPolicy(storedRow);
        await requireCanonicalPolicyOutbox(client, stored);
        return { created: true, policy: clone(stored) };
      });
    } catch (error) {
      mapPolicyPersistenceError(error, policy);
    }
  }

  async publishReleasePolicyLifecycleEvent(
    eventInput: ReleasePolicyLifecycleEvent,
  ): Promise<PublishReleasePolicyLifecycleResult> {
    const event = validateReleasePolicyLifecycleEvent(eventInput);
    const lockPrefix = `proofstack:release-policy:${event.scope.tenantId}`;
    const lockKeys = [
      `${lockPrefix}:event:${event.eventId}`,
      `${lockPrefix}:terminal:${event.policy.policyVersionId}`,
      `${lockPrefix}:version:${event.policy.policyVersionId}`,
      ...(event.kind === "superseded"
        ? [`${lockPrefix}:version:${event.successor.policyVersionId}`]
        : []),
    ];

    try {
      return await withExactScopeTransaction(this.pool, event.scope, async (client) => {
        await acquireLocks(client, lockKeys);
        const existingRow = await loadStoredLifecycleEvent(client, event.scope, event.eventId);
        if (existingRow) {
          const existing = parseStoredLifecycleEvent(existingRow);
          if (!isDeepStrictEqual(lifecycleSemantics(existing), lifecycleSemantics(event))) {
            throw new ReleasePolicyLifecycleEventConflictError(event.eventId);
          }
          await requireCanonicalLifecycleOutbox(client, existing);
          return { created: false, event: clone(existing) };
        }

        const targetRow = await loadStoredPolicy(client, event.scope, event.policy.policyVersionId);
        const target = assertExactReference(
          targetRow ? parseStoredPolicy(targetRow) : null,
          event.scope,
          event.policy,
        );
        let successor: ReleasePolicy | undefined;
        if (event.kind === "superseded") {
          const successorRow = await loadStoredPolicy(
            client,
            event.scope,
            event.successor.policyVersionId,
          );
          successor = assertExactReference(
            successorRow ? parseStoredPolicy(successorRow) : null,
            event.scope,
            event.successor,
          );
          if (!successor.predecessor || !referencesEqual(successor.predecessor, event.policy)) {
            throw new ReleasePolicyLineageError(
              event.policy.policyVersionId,
              event.successor.policyVersionId,
            );
          }
        }
        if (
          event.occurredAt < target.publishedAt ||
          (successor && event.occurredAt < successor.publishedAt)
        ) {
          throw new InvalidReleasePolicyLifecycleInputError(
            `Release policy lifecycle event ${event.eventId} predates an authoritative policy receipt`,
          );
        }

        const terminal = await client.query<{ readonly event_id: string }>(
          `SELECT event_id
           FROM public.proofstack_release_policy_lifecycle_events
           WHERE tenant_id = $1 AND project_id = $2 AND environment_id = $3
             AND policy_version_id = $4`,
          [
            event.scope.tenantId,
            event.scope.projectId,
            event.scope.environmentId,
            event.policy.policyVersionId,
          ],
        );
        if (terminal.rows.length > 0) {
          throw new ReleasePolicyLifecycleStateConflictError(event.policy.policyVersionId);
        }

        const command = {
          actorPrincipalId: event.actorPrincipalId,
          environmentId: event.scope.environmentId,
          eventId: event.eventId,
          occurredAt: event.occurredAt,
          projectId: event.scope.projectId,
          record: event,
          schemaVersion: event.schemaVersion,
          tenantId: event.scope.tenantId,
        };
        await client.query("SELECT public.proofstack_publish_release_policy_lifecycle($1::jsonb)", [
          JSON.stringify(command),
        ]);

        const storedRow = await loadStoredLifecycleEvent(client, event.scope, event.eventId);
        if (!storedRow) {
          throw new ReleasePolicyRepositoryContractError(
            "PostgreSQL accepted release policy lifecycle publication without retaining its record",
          );
        }
        const stored = parseStoredLifecycleEvent(storedRow);
        await requireCanonicalLifecycleOutbox(client, stored);
        return { created: true, event: clone(stored) };
      });
    } catch (error) {
      mapLifecyclePersistenceError(error, event);
    }
  }
}
