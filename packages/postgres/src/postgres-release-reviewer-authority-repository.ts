import { isDeepStrictEqual } from "node:util";
import {
  type EvidenceScope,
  EvidenceScopeSchema,
  encodeReleaseReviewerAuthorityDefinition,
  OpaqueIdSchema,
  policyEvaluationTimestampOrderKey,
  ReleaseDecisionReviewerRootReferenceSchema,
  type ReleaseReviewerAuthority,
  type ReleaseReviewerAuthorityLifecycleEvent,
  ReleaseReviewerAuthorityLifecycleEventSchema,
  ReleaseReviewerAuthoritySchema,
} from "@proofstack/contracts";
import {
  ReleaseDecisionVerificationBudget,
  ReleaseDecisionVerificationBudgetError,
  type ReleaseReviewerAuthorityRepository,
  ReleaseReviewerAuthorityRepositoryError,
  type ReleaseReviewerAuthorityTarget,
  releaseReviewerAuthorityReference,
  validateReleaseReviewerAuthorityRecord,
} from "@proofstack/core";
import type { Pool, PoolClient } from "pg";
import {
  withExactReadCommittedScopeTransaction,
  withExactScopeTransaction,
} from "./tenant-transaction.js";

import { readReviewerAdministratorRowsOnClient } from "./reviewer-administrator-read.js";

type Client = Pick<PoolClient, "query">;
interface Data extends Record<string, unknown> {
  readonly record?: unknown;
  readonly version?: unknown;
  readonly root_version?: unknown;
  readonly root?: unknown;
  readonly predecessor?: unknown;
  readonly memberships?: unknown;
  readonly declarations?: unknown;
  readonly basis?: unknown;
  readonly intents?: unknown;
  readonly event?: unknown;
  readonly orphan?: unknown;
  readonly root_version_id?: unknown;
  readonly created?: unknown;
}
const PAGE_SIZE = 16;
function fail(
  reason: ReleaseReviewerAuthorityRepositoryError["reason"] = "storage_invalid",
): never {
  throw new ReleaseReviewerAuthorityRepositoryError(reason);
}
function object(value: unknown): Data {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  return value as Data;
}
function same(a: unknown, b: unknown) {
  return isDeepStrictEqual(a, b);
}
function definition(record: ReleaseReviewerAuthority) {
  const {
    schemaVersion: _version,
    definitionSha256: _sha,
    publishedAt: _at,
    publishedByPrincipalId: _by,
    ...value
  } = record;
  return value;
}
function canonical(record: ReleaseReviewerAuthority) {
  return Buffer.from(
    encodeReleaseReviewerAuthorityDefinition({
      scope: record.scope,
      definition: definition(record),
    }),
  ).toString("utf8");
}
function validated(raw: unknown, scope: EvidenceScope): ReleaseReviewerAuthority {
  const parsed = ReleaseReviewerAuthoritySchema.parse(raw);
  return validateReleaseReviewerAuthorityRecord({
    expected: { scope, reference: releaseReviewerAuthorityReference(parsed) },
    record: parsed,
  });
}
function versionFields(record: ReleaseReviewerAuthority) {
  return {
    tenant_id: record.scope.tenantId,
    project_id: record.scope.projectId,
    environment_id: record.scope.environmentId,
    authority_id: record.authorityId,
    version_id: record.authorityVersionId,
    installation_id: record.installationId,
    gate_target_id: record.gateTargetId,
    reviewer_principal_id: record.reviewerPrincipalId,
    definition_sha256: record.definitionSha256,
    reviewer_kind: record.reviewerKind,
    assurance: record.assurance,
    status: record.status,
    effective_at_lexical: record.effectiveAt,
    expires_at_lexical: record.expiresAt,
    published_at_lexical: record.publishedAt,
    effective_at_key: policyEvaluationTimestampOrderKey(record.effectiveAt).toString(),
    expires_at_key: policyEvaluationTimestampOrderKey(record.expiresAt).toString(),
    published_at_key: policyEvaluationTimestampOrderKey(record.publishedAt).toString(),
    published_by_principal_id: record.publishedByPrincipalId,
    parent_version_id: record.predecessor?.authorityVersionId ?? null,
    parent_definition_sha256: record.predecessor?.definitionSha256 ?? null,
    role_count: record.roleIds.length,
    group_count: record.independenceGroupIds.length,
    basis_count: record.reviewBasis.length,
    canonical_utf8: canonical(record),
    record,
  };
}
function checkedVersion(value: unknown, scope: EvidenceScope) {
  const row = object(value),
    record = validated(row.record, scope);
  if (!same(row, versionFields(record))) fail();
  return record;
}
function rootFields(root: ReleaseReviewerAuthority) {
  return {
    tenant_id: root.scope.tenantId,
    project_id: root.scope.projectId,
    environment_id: root.scope.environmentId,
    authority_id: root.authorityId,
    installation_id: root.installationId,
    gate_target_id: root.gateTargetId,
    reviewer_principal_id: root.reviewerPrincipalId,
    root_version_id: root.authorityVersionId,
    root_definition_sha256: root.definitionSha256,
  };
}
function normalizedTime(alias: "v" | "rv" | "pv") {
  // Internal fixed aliases only; never a request-supplied identifier.
  return `to_jsonb(${alias}) || jsonb_build_object('effective_at_key',${alias}.effective_at_key::text,
    'expires_at_key',${alias}.expires_at_key::text,'published_at_key',${alias}.published_at_key::text)`;
}
const viewSql = `SELECT ${normalizedTime("v")} AS version, to_jsonb(r) AS root,
  ${normalizedTime("rv")} AS root_version, ${normalizedTime("pv")} AS predecessor,
  (SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY p.kind COLLATE "C",p.ordinal),'[]'::jsonb)
    FROM public.proofstack_release_reviewer_memberships p WHERE p.tenant_id=v.tenant_id AND p.version_id=v.version_id) AS memberships,
  (SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY p.kind COLLATE "C",p.ordinal),'[]'::jsonb)
    FROM public.proofstack_release_reviewer_declarations p WHERE p.tenant_id=v.tenant_id AND p.version_id=v.version_id) AS declarations,
  (SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY p.ordinal),'[]'::jsonb)
    FROM public.proofstack_release_reviewer_basis p WHERE p.tenant_id=v.tenant_id AND p.version_id=v.version_id) AS basis,
  (SELECT COALESCE(jsonb_agg(jsonb_build_object('eventType',o.event_type,'schemaVersion',o.schema_version,
    'payload',o.payload,'timeMatches',o.created_at=v.published_at_lexical::timestamptz)),'[]'::jsonb)
    FROM public.proofstack_outbox o WHERE o.tenant_id=v.tenant_id AND o.aggregate_type='release_reviewer_authority' AND o.aggregate_id=v.version_id) AS intents
  FROM public.proofstack_release_reviewer_authorities v
  LEFT JOIN public.proofstack_release_reviewer_roots r ON r.tenant_id=v.tenant_id AND r.authority_id=v.authority_id
  LEFT JOIN public.proofstack_release_reviewer_authorities rv ON rv.tenant_id=r.tenant_id AND rv.version_id=r.root_version_id
  LEFT JOIN public.proofstack_release_reviewer_authorities pv ON pv.tenant_id=v.tenant_id AND pv.version_id=v.parent_version_id
  WHERE v.tenant_id=$1 AND v.project_id=$2 AND v.environment_id=$3 AND v.version_id=$4`;
const parameters = (scope: EvidenceScope, id: string) => [
  scope.tenantId,
  scope.projectId,
  scope.environmentId,
  id,
];
function admitView(raw: Data, budget?: ReleaseDecisionVerificationBudget) {
  const count = ["memberships", "declarations", "basis", "intents"].reduce(
    (sum, key) => sum + Math.max(1, Array.isArray(raw[key]) ? raw[key].length : 1),
    4,
  );
  budget?.observe(raw, "metadata", count);
}
function checkIntent(
  raw: unknown,
  kind: "release_reviewer_authority" | "release_reviewer_authority_lifecycle",
  record: unknown,
) {
  const expected = {
    eventType:
      kind === "release_reviewer_authority"
        ? "release.reviewer-authority.published"
        : "release.reviewer-authority.lifecycle_recorded",
    schemaVersion: "0.1",
    payload: { recordKind: kind, record },
    timeMatches: true,
  };
  if (!same(raw, [expected])) fail();
}
function checkView(raw: Data, scope: EvidenceScope, id: string): ReleaseReviewerAuthority {
  const record = checkedVersion(raw.version, scope),
    root = checkedVersion(raw.root_version, scope);
  if (
    record.authorityVersionId !== id ||
    root.predecessor ||
    !same(raw.root, rootFields(root)) ||
    record.authorityId !== root.authorityId ||
    record.installationId !== root.installationId ||
    record.gateTargetId !== root.gateTargetId ||
    record.reviewerPrincipalId !== root.reviewerPrincipalId ||
    policyEvaluationTimestampOrderKey(record.publishedAt) <
      policyEvaluationTimestampOrderKey(root.publishedAt)
  )
    fail();
  if (record.predecessor) {
    const parent = checkedVersion(raw.predecessor, scope);
    if (
      !same(releaseReviewerAuthorityReference(parent), record.predecessor) ||
      policyEvaluationTimestampOrderKey(parent.publishedAt) >
        policyEvaluationTimestampOrderKey(record.publishedAt)
    )
      fail();
  } else if (raw.predecessor !== null) fail();
  const common = {
    tenant_id: scope.tenantId,
    project_id: scope.projectId,
    environment_id: scope.environmentId,
    version_id: record.authorityVersionId,
    definition_sha256: record.definitionSha256,
  };
  const memberships = (
    [
      ["independence_group", record.independenceGroupIds],
      ["role", record.roleIds],
    ] as const
  ).flatMap(([kind, ids]) =>
    ids.map((member_id, ordinal) => ({ ...common, kind, ordinal, member_id })),
  );
  const declarations = (
    [
      ["affiliation", record.affiliations],
      ["conflict", record.conflicts],
      ["relationship", record.relationships],
      ["status_reason", record.statusReasons],
    ] as const
  ).flatMap(([kind, values]) =>
    values.map((declaration, ordinal) => ({ ...common, kind, ordinal, declaration })),
  );
  const basis = record.reviewBasis.map((reference, ordinal) => ({
    ...common,
    ordinal,
    reference,
    artifact_id: reference.artifactId,
    artifact_sha256: reference.sha256,
  }));
  if (
    !same(raw.memberships, memberships) ||
    !same(raw.declarations, declarations) ||
    !same(raw.basis, basis)
  )
    fail();
  checkIntent(raw.intents, "release_reviewer_authority", record);
  return record;
}

/** Owning immutable projection/intent read on the supplied client, not current issuer authority. */
async function readAuthority(
  client: Client,
  scopeInput: EvidenceScope,
  versionInput: string,
  budget?: ReleaseDecisionVerificationBudget,
  administrator = false,
) {
  if (budget !== undefined && !(budget instanceof ReleaseDecisionVerificationBudget)) fail();
  budget?.snapshot();
  try {
    const scope = EvidenceScopeSchema.parse(scopeInput),
      id = OpaqueIdSchema.parse(versionInput);
    const result =
      administrator && budget
        ? {
            rows: await readReviewerAdministratorRowsOnClient<Data>(
              client,
              { scope, budget },
              "authority_view",
              id,
            ),
          }
        : await client.query(viewSql, parameters(scope, id));
    if (!administrator) for (const raw of result.rows) admitView(raw, budget);
    if (result.rows.length > 1) fail();
    const raw = result.rows[0];
    if (!raw) {
      budget?.observe({ scope, versionId: id, state: "missing" });
      return null;
    }
    return checkView(raw, scope, id);
  } catch (cause) {
    if (budget) return budget.rejectSourceRead(cause);
    throw cause;
  }
}

export function readPostgresReleaseReviewerAuthorityOnClient(
  client: Client,
  scope: EvidenceScope,
  versionId: string,
  budget?: ReleaseDecisionVerificationBudget,
) {
  return readAuthority(client, scope, versionId, budget);
}
/** Fixed narrow-role reader; reuse the owning normalized and canonical-intent validator. */
export function readPostgresReleaseReviewerAuthorityForAdministratorOnClient(
  client: Client,
  scope: EvidenceScope,
  versionId: string,
  budget: ReleaseDecisionVerificationBudget,
) {
  if (!(budget instanceof ReleaseDecisionVerificationBudget)) fail();
  return readAuthority(client, scope, versionId, budget, true);
}

const eventSql = `SELECT to_jsonb(e)||jsonb_build_object('occurred_at_key',e.occurred_at_key::text) AS event,
  (SELECT COALESCE(jsonb_agg(jsonb_build_object('eventType',o.event_type,'schemaVersion',o.schema_version,
    'payload',o.payload,'timeMatches',o.created_at=e.occurred_at_lexical::timestamptz)),'[]'::jsonb)
    FROM public.proofstack_outbox o WHERE o.tenant_id=e.tenant_id AND o.aggregate_type='release_reviewer_authority_lifecycle' AND o.aggregate_id=e.event_id) AS intents
  FROM public.proofstack_release_reviewer_lifecycle e
  WHERE e.tenant_id=$1 AND e.project_id=$2 AND e.environment_id=$3 AND e.event_id=$4`;
function checkedEvent(
  raw: Data,
  scope: EvidenceScope,
  id: string,
  records: ReadonlyMap<string, ReleaseReviewerAuthority>,
) {
  const row = object(raw.event),
    event = ReleaseReviewerAuthorityLifecycleEventSchema.parse(row.record);
  const current = records.get(event.authority.authorityVersionId);
  if (
    event.eventId !== id ||
    !same(event.scope, scope) ||
    !current ||
    !same(event.authority, releaseReviewerAuthorityReference(current))
  )
    fail();
  const expected = {
    tenant_id: scope.tenantId,
    project_id: scope.projectId,
    environment_id: scope.environmentId,
    event_id: event.eventId,
    version_id: event.authority.authorityVersionId,
    definition_sha256: event.authority.definitionSha256,
    successor_version_id: event.kind === "superseded" ? event.successor.authorityVersionId : null,
    successor_definition_sha256:
      event.kind === "superseded" ? event.successor.definitionSha256 : null,
    occurred_at_lexical: event.occurredAt,
    occurred_at_key: policyEvaluationTimestampOrderKey(event.occurredAt).toString(),
    record: event,
  };
  if (
    !same(row, expected) ||
    policyEvaluationTimestampOrderKey(event.occurredAt) <
      policyEvaluationTimestampOrderKey(current.publishedAt)
  )
    fail();
  if (event.kind === "superseded") {
    const successor = records.get(event.successor.authorityVersionId);
    if (
      !successor ||
      !same(event.successor, releaseReviewerAuthorityReference(successor)) ||
      !same(successor.predecessor, event.authority) ||
      policyEvaluationTimestampOrderKey(event.occurredAt) <
        policyEvaluationTimestampOrderKey(successor.publishedAt)
    )
      fail();
  }
  checkIntent(raw.intents, "release_reviewer_authority_lifecycle", event);
  return event;
}
async function eventView(
  client: Client,
  scope: EvidenceScope,
  id: string,
  budget?: ReleaseDecisionVerificationBudget,
  administrator = false,
) {
  const result =
    administrator && budget
      ? {
          rows: await readReviewerAdministratorRowsOnClient<Data>(
            client,
            { scope, budget },
            "authority_event_view",
            id,
          ),
        }
      : await client.query(eventSql, parameters(scope, id));
  for (const raw of result.rows)
    budget?.observe(
      raw,
      "metadata",
      1 + Math.max(1, Array.isArray(raw.intents) ? raw.intents.length : 1),
    );
  if (result.rows.length > 1) fail();
  if (!result.rows[0]) {
    budget?.observe({ scope, eventId: id, state: "missing" });
    return null;
  }
  return result.rows[0];
}
async function readLifecycle(
  client: Client,
  scopeInput: EvidenceScope,
  eventInput: string,
  budget?: ReleaseDecisionVerificationBudget,
  administrator = false,
) {
  const scope = EvidenceScopeSchema.parse(scopeInput),
    id = OpaqueIdSchema.parse(eventInput);
  const raw = await eventView(client, scope, id, budget, administrator);
  if (!raw) return null;
  const event = ReleaseReviewerAuthorityLifecycleEventSchema.parse(object(raw.event).record);
  const records = new Map<string, ReleaseReviewerAuthority>();
  for (const ref of [event.authority, ...(event.kind === "superseded" ? [event.successor] : [])]) {
    const record = await readAuthority(
      client,
      scope,
      ref.authorityVersionId,
      budget,
      administrator,
    );
    if (!record) fail();
    records.set(record.authorityVersionId, record);
  }
  return checkedEvent(raw, scope, id, records);
}

export function readPostgresReleaseReviewerLifecycleOnClient(
  client: Client,
  scope: EvidenceScope,
  eventId: string,
) {
  return readLifecycle(client, scope, eventId);
}
export async function readPostgresReleaseReviewerLifecycleForAdministratorOnClient(
  client: Client,
  scope: EvidenceScope,
  eventId: string,
  budget: ReleaseDecisionVerificationBudget,
) {
  if (!(budget instanceof ReleaseDecisionVerificationBudget)) fail();
  budget.snapshot();
  try {
    return await readLifecycle(client, scope, eventId, budget, true);
  } catch (cause) {
    return budget.rejectSourceRead(cause);
  }
}

/** Complete target-owned guarded inventory. Its guard remains CALLER-held; never publish later
 * from a detached returned report. The fixed future publisher still validates complete authority.
 */
async function readTarget(
  client: Client,
  scopeInput: EvidenceScope,
  targetInput: ReleaseReviewerAuthorityTarget,
  budget: ReleaseDecisionVerificationBudget,
  administrator = false,
) {
  if (!(budget instanceof ReleaseDecisionVerificationBudget)) fail();
  try {
    const scope = EvidenceScopeSchema.parse(scopeInput),
      target = ReleaseDecisionReviewerRootReferenceSchema.parse(targetInput);
    budget.snapshot();
    const roots = administrator
      ? {
          rows: await readReviewerAdministratorRowsOnClient<{ value: unknown }>(
            client,
            { scope, budget },
            "authority_root",
            target.installationId,
            target.gateTargetId,
            target.reviewerPrincipalId,
          ),
        }
      : await client.query<{ value: unknown }>(
          "SELECT public.proofstack_read_release_reviewer_root($1::jsonb,$2,$3,$4) AS value",
          [
            JSON.stringify(scope),
            target.installationId,
            target.gateTargetId,
            target.reviewerPrincipalId,
          ],
        );
    for (const row of roots.rows) budget.observe(row.value);
    if (roots.rows.length !== 1) fail();
    const observation = object(roots.rows[0]?.value);
    if (observation.orphan !== false) fail();
    if (observation.root === null) return { root: null, records: [], lifecycle: [] };
    const rootProjection = object(observation.root),
      rootId = OpaqueIdSchema.parse(rootProjection.root_version_id);
    const root = await readAuthority(client, scope, rootId, budget, administrator);
    if (
      !root ||
      !same(rootProjection, rootFields(root)) ||
      root.installationId !== target.installationId ||
      root.gateTargetId !== target.gateTargetId ||
      root.reviewerPrincipalId !== target.reviewerPrincipalId ||
      root.predecessor
    )
      fail();
    const records: ReleaseReviewerAuthority[] = [],
      seen = new Set<string>();
    let after = "";
    for (;;) {
      const page = administrator
        ? {
            rows: await readReviewerAdministratorRowsOnClient<{ version_id: unknown }>(
              client,
              { scope, budget },
              "authority_versions",
              root.authorityId,
              after,
            ),
          }
        : await client.query<{ version_id: unknown }>(
            `SELECT version_id FROM public.proofstack_release_reviewer_authorities
        WHERE tenant_id=$1 AND authority_id=$2 AND version_id COLLATE "C">$3 COLLATE "C" ORDER BY version_id COLLATE "C" LIMIT 16`,
            [scope.tenantId, root.authorityId, after],
          );
      if (page.rows.length > PAGE_SIZE) fail();
      if (page.rows.length === 0)
        budget.observe({ scope, authorityId: root.authorityId, after, versions: [] });
      for (const raw of page.rows) {
        budget.observe(raw);
        const id = OpaqueIdSchema.parse(raw.version_id);
        if (id <= after || seen.has(id)) fail();
        seen.add(id);
        after = id;
        const row =
          id === rootId ? root : await readAuthority(client, scope, id, budget, administrator);
        if (!row || row.authorityId !== root.authorityId) fail();
        records.push(row);
      }
      if (page.rows.length < PAGE_SIZE) break;
    }
    if (!seen.has(rootId)) fail();
    const byId = new Map(records.map((row) => [row.authorityVersionId, row]));
    const lifecycle: ReleaseReviewerAuthorityLifecycleEvent[] = [];
    after = "";
    const terminals = new Set<string>();
    for (;;) {
      const page = administrator
        ? {
            rows: await readReviewerAdministratorRowsOnClient<{ event_id: unknown }>(
              client,
              { scope, budget },
              "authority_events",
              root.authorityId,
              after,
            ),
          }
        : await client.query<{ event_id: unknown }>(
            `SELECT e.event_id FROM public.proofstack_release_reviewer_lifecycle e
        JOIN public.proofstack_release_reviewer_authorities v ON v.tenant_id=e.tenant_id AND v.version_id=e.version_id
        WHERE e.tenant_id=$1 AND v.authority_id=$2 AND e.event_id COLLATE "C">$3 COLLATE "C" ORDER BY e.event_id COLLATE "C" LIMIT 16`,
            [scope.tenantId, root.authorityId, after],
          );
      if (page.rows.length > PAGE_SIZE) fail();
      if (page.rows.length === 0)
        budget.observe({ scope, authorityId: root.authorityId, after, events: [] });
      for (const raw of page.rows) {
        budget.observe(raw);
        const id = OpaqueIdSchema.parse(raw.event_id);
        if (id <= after) fail();
        after = id;
        const view = await eventView(client, scope, id, budget, administrator);
        if (!view) fail();
        const event = checkedEvent(view, scope, id, byId);
        if (terminals.has(event.authority.authorityVersionId)) fail();
        terminals.add(event.authority.authorityVersionId);
        lifecycle.push(event);
      }
      if (page.rows.length < PAGE_SIZE) break;
    }
    lifecycle.sort((a, b) => {
      const x = policyEvaluationTimestampOrderKey(a.occurredAt),
        y = policyEvaluationTimestampOrderKey(b.occurredAt);
      return x < y ? -1 : x > y ? 1 : a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0;
    });
    return { root, records, lifecycle };
  } catch (cause) {
    if (cause instanceof ReleaseDecisionVerificationBudgetError) throw cause;
    return budget.rejectSourceRead(cause);
  }
}

export function readPostgresReleaseReviewerTargetOnClient(
  client: Client,
  scope: EvidenceScope,
  target: ReleaseReviewerAuthorityTarget,
  budget: ReleaseDecisionVerificationBudget,
) {
  return readTarget(client, scope, target, budget);
}
/** Complete owning target census through fixed narrow-role pages on this held client. */
export function readPostgresReleaseReviewerTargetForAdministratorOnClient(
  client: Client,
  scope: EvidenceScope,
  target: ReleaseReviewerAuthorityTarget,
  budget: ReleaseDecisionVerificationBudget,
) {
  return readTarget(client, scope, target, budget, true);
}

function persistenceError(cause: unknown): never {
  const error =
    cause && typeof cause === "object"
      ? (cause as { code?: unknown; message?: unknown; constraint?: unknown })
      : {};
  if (error.code === "P0001" && typeof error.message === "string") {
    const reason = error.message.replace(/^release_reviewer:/, "");
    if (
      [
        "version_conflict",
        "target_conflict",
        "lineage_invalid",
        "event_conflict",
        "terminal_conflict",
        "receipt_invalid",
      ].includes(reason)
    )
      throw new ReleaseReviewerAuthorityRepositoryError(
        reason as ReleaseReviewerAuthorityRepositoryError["reason"],
        { cause },
      );
  }
  if (["23514", "23503", "23505", "22023", "22P02", "P0002"].includes(String(error.code)))
    throw new ReleaseReviewerAuthorityRepositoryError("storage_invalid", { cause });
  throw cause;
}

/** Trusted declaration storage only. No issuer authentication, native role/grant or decision
 * authority is conferred by constructing a pool/repository or supplying an attributable record.
 */
export class PostgresReleaseReviewerAuthorityRepository
  implements ReleaseReviewerAuthorityRepository
{
  constructor(private readonly pool: Pick<Pool, "connect">) {}
  findReleaseReviewerAuthority(scope: EvidenceScope, id: string) {
    return withExactScopeTransaction(this.pool, EvidenceScopeSchema.parse(scope), (client) =>
      readPostgresReleaseReviewerAuthorityOnClient(client, scope, id),
    );
  }
  findReleaseReviewerAuthorityLifecycleEvent(scope: EvidenceScope, id: string) {
    return withExactScopeTransaction(this.pool, EvidenceScopeSchema.parse(scope), (client) =>
      readPostgresReleaseReviewerLifecycleOnClient(client, scope, id),
    );
  }
  async publishReleaseReviewerAuthority(input: ReleaseReviewerAuthority) {
    const record = validated(input, input.scope);
    try {
      return await withExactReadCommittedScopeTransaction(
        this.pool,
        record.scope,
        async (client) => {
          const response = await client.query<{ value: unknown }>(
            "SELECT public.proofstack_store_release_reviewer_authority($1::jsonb,$2) AS value",
            [JSON.stringify(record), canonical(record)],
          );
          if (response.rows.length !== 1) fail();
          const result = object(response.rows[0]?.value);
          const stored = await readPostgresReleaseReviewerAuthorityOnClient(
            client,
            record.scope,
            record.authorityVersionId,
          );
          if (
            typeof result.created !== "boolean" ||
            !stored ||
            !same(stored, result.record) ||
            stored.definitionSha256 !== record.definitionSha256
          )
            fail();
          return { created: result.created, authority: stored };
        },
      );
    } catch (cause) {
      return persistenceError(cause);
    }
  }
  async publishReleaseReviewerAuthorityLifecycleEvent(
    input: ReleaseReviewerAuthorityLifecycleEvent,
  ) {
    const event = ReleaseReviewerAuthorityLifecycleEventSchema.parse(input);
    try {
      return await withExactReadCommittedScopeTransaction(
        this.pool,
        event.scope,
        async (client) => {
          const response = await client.query<{ value: unknown }>(
            "SELECT public.proofstack_store_release_reviewer_lifecycle($1::jsonb) AS value",
            [JSON.stringify(event)],
          );
          if (response.rows.length !== 1) fail();
          const result = object(response.rows[0]?.value);
          const stored = await readPostgresReleaseReviewerLifecycleOnClient(
            client,
            event.scope,
            event.eventId,
          );
          if (typeof result.created !== "boolean" || !stored || !same(stored, result.record))
            fail();
          return { created: result.created, event: stored };
        },
      );
    } catch (cause) {
      return persistenceError(cause);
    }
  }
  readReleaseReviewerAuthorityTarget(
    scope: EvidenceScope,
    target: ReleaseReviewerAuthorityTarget,
    budget: ReleaseDecisionVerificationBudget,
  ) {
    if (!(budget instanceof ReleaseDecisionVerificationBudget)) fail();
    budget.snapshot();
    return withExactReadCommittedScopeTransaction(
      this.pool,
      EvidenceScopeSchema.parse(scope),
      (client) => readPostgresReleaseReviewerTargetOnClient(client, scope, target, budget),
    ).catch((cause: unknown) => budget.rejectSourceRead(cause));
  }
}
