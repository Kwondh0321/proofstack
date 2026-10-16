import { isDeepStrictEqual } from "node:util";
import {
  type EvidenceScope,
  EvidenceScopeSchema,
  encodeReleasePolicySelectionDefinition,
  OpaqueIdSchema,
  policyEvaluationTimestampOrderKey,
  ReleaseDecisionSelectionRootReferenceSchema,
  type ReleasePolicySelection,
  type ReleasePolicySelectionLifecycleEvent,
  ReleasePolicySelectionLifecycleEventSchema,
  ReleasePolicySelectionSchema,
} from "@proofstack/contracts";
import {
  ReleaseDecisionVerificationBudget,
  ReleaseDecisionVerificationBudgetError,
  type ReleasePolicySelectionRepository,
  ReleasePolicySelectionRepositoryError,
  type ReleasePolicySelectionTarget,
  releasePolicySelectionReference,
  validateReleasePolicySelectionRecord,
} from "@proofstack/core";
import type { Pool, PoolClient } from "pg";
import {
  withExactReadCommittedScopeTransaction,
  withExactScopeTransaction,
} from "./tenant-transaction.js";

type Client = Pick<PoolClient, "query">;
interface Data extends Record<string, unknown> {
  readonly record?: unknown;
  readonly version?: unknown;
  readonly root_version?: unknown;
  readonly root?: unknown;
  readonly predecessor?: unknown;
  readonly policies?: unknown;
  readonly publishers?: unknown;
  readonly intents?: unknown;
  readonly event?: unknown;
  readonly orphan?: unknown;
  readonly root_version_id?: unknown;
  readonly created?: unknown;
}
const PAGE_SIZE = 16;
function fail(reason: ReleasePolicySelectionRepositoryError["reason"] = "storage_invalid"): never {
  throw new ReleasePolicySelectionRepositoryError(reason);
}
function object(value: unknown): Data {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  return value as Data;
}
function same(a: unknown, b: unknown) {
  return isDeepStrictEqual(a, b);
}
function definition(record: ReleasePolicySelection) {
  const {
    schemaVersion: _version,
    definitionSha256: _sha,
    publishedAt: _at,
    publishedByPrincipalId: _by,
    ...value
  } = record;
  return value;
}
function canonical(record: ReleasePolicySelection) {
  return Buffer.from(
    encodeReleasePolicySelectionDefinition({ scope: record.scope, definition: definition(record) }),
  ).toString("utf8");
}
function validated(raw: unknown, scope: EvidenceScope): ReleasePolicySelection {
  const parsed = ReleasePolicySelectionSchema.parse(raw);
  return validateReleasePolicySelectionRecord({
    expected: { scope, reference: releasePolicySelectionReference(parsed) },
    record: parsed,
  });
}
function versionFields(record: ReleasePolicySelection) {
  return {
    tenant_id: record.scope.tenantId,
    project_id: record.scope.projectId,
    environment_id: record.scope.environmentId,
    selection_id: record.selectionId,
    version_id: record.selectionVersionId,
    installation_id: record.installationId,
    gate_target_id: record.gateTargetId,
    definition_sha256: record.definitionSha256,
    mode: record.mode,
    effective_at_lexical: record.effectiveAt,
    expires_at_lexical: record.expiresAt,
    published_at_lexical: record.publishedAt,
    effective_at_key: policyEvaluationTimestampOrderKey(record.effectiveAt).toString(),
    expires_at_key: policyEvaluationTimestampOrderKey(record.expiresAt).toString(),
    published_at_key: policyEvaluationTimestampOrderKey(record.publishedAt).toString(),
    published_by_principal_id: record.publishedByPrincipalId,
    parent_version_id: record.predecessor?.selectionVersionId ?? null,
    parent_definition_sha256: record.predecessor?.definitionSha256 ?? null,
    policy_count: record.policies.length,
    publisher_count: record.authorizedPublisherPrincipalIds.length,
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
function rootFields(root: ReleasePolicySelection) {
  return {
    tenant_id: root.scope.tenantId,
    project_id: root.scope.projectId,
    environment_id: root.scope.environmentId,
    selection_id: root.selectionId,
    installation_id: root.installationId,
    gate_target_id: root.gateTargetId,
    root_version_id: root.selectionVersionId,
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
  (SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY p.ordinal),'[]'::jsonb)
    FROM public.proofstack_release_selection_policies p WHERE p.tenant_id=v.tenant_id AND p.version_id=v.version_id) AS policies,
  (SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY p.ordinal),'[]'::jsonb)
    FROM public.proofstack_release_selection_publishers p WHERE p.tenant_id=v.tenant_id AND p.version_id=v.version_id) AS publishers,
  (SELECT COALESCE(jsonb_agg(jsonb_build_object('eventType',o.event_type,'schemaVersion',o.schema_version,
    'payload',o.payload,'timeMatches',o.created_at=v.published_at_lexical::timestamptz)),'[]'::jsonb)
    FROM public.proofstack_outbox o WHERE o.tenant_id=v.tenant_id AND o.aggregate_type='release_policy_selection' AND o.aggregate_id=v.version_id) AS intents
  FROM public.proofstack_release_policy_selections v
  LEFT JOIN public.proofstack_release_selection_roots r ON r.tenant_id=v.tenant_id AND r.selection_id=v.selection_id
  LEFT JOIN public.proofstack_release_policy_selections rv ON rv.tenant_id=r.tenant_id AND rv.version_id=r.root_version_id
  LEFT JOIN public.proofstack_release_policy_selections pv ON pv.tenant_id=v.tenant_id AND pv.version_id=v.parent_version_id
  WHERE v.tenant_id=$1 AND v.project_id=$2 AND v.environment_id=$3 AND v.version_id=$4`;
const parameters = (scope: EvidenceScope, id: string) => [
  scope.tenantId,
  scope.projectId,
  scope.environmentId,
  id,
];
function admitView(raw: Data, budget?: ReleaseDecisionVerificationBudget) {
  const count = ["policies", "publishers", "intents"].reduce(
    (sum, key) => sum + Math.max(1, Array.isArray(raw[key]) ? raw[key].length : 1),
    4,
  );
  budget?.observe(raw, "metadata", count);
}
function checkIntent(
  raw: unknown,
  kind: "release_policy_selection" | "release_policy_selection_lifecycle",
  record: unknown,
) {
  const expected = {
    eventType:
      kind === "release_policy_selection"
        ? "release.selection.published"
        : "release.selection.lifecycle_recorded",
    schemaVersion: "0.1",
    payload: { recordKind: kind, record },
    timeMatches: true,
  };
  if (!same(raw, [expected])) fail();
}
function checkView(raw: Data, scope: EvidenceScope, id: string): ReleasePolicySelection {
  const record = checkedVersion(raw.version, scope),
    root = checkedVersion(raw.root_version, scope);
  if (
    record.selectionVersionId !== id ||
    root.predecessor ||
    !same(raw.root, rootFields(root)) ||
    record.selectionId !== root.selectionId ||
    record.installationId !== root.installationId ||
    record.gateTargetId !== root.gateTargetId ||
    policyEvaluationTimestampOrderKey(record.publishedAt) <
      policyEvaluationTimestampOrderKey(root.publishedAt)
  )
    fail();
  if (record.predecessor) {
    const parent = checkedVersion(raw.predecessor, scope);
    if (
      !same(releasePolicySelectionReference(parent), record.predecessor) ||
      policyEvaluationTimestampOrderKey(parent.publishedAt) >
        policyEvaluationTimestampOrderKey(record.publishedAt)
    )
      fail();
  } else if (raw.predecessor !== null) fail();
  const common = {
    tenant_id: scope.tenantId,
    project_id: scope.projectId,
    environment_id: scope.environmentId,
    version_id: record.selectionVersionId,
    definition_sha256: record.definitionSha256,
  };
  const policies = record.policies.map((projection, ordinal) => ({
    ...common,
    ordinal,
    projection,
    policy_id: projection.policy.policyId,
    policy_version_id: projection.policy.policyVersionId,
    policy_definition_sha256: projection.policy.definitionSha256,
    mode: projection.mode,
  }));
  const publishers = record.authorizedPublisherPrincipalIds.map((principal_id, ordinal) => ({
    ...common,
    ordinal,
    principal_id,
  }));
  if (!same(raw.policies, policies) || !same(raw.publishers, publishers)) fail();
  checkIntent(raw.intents, "release_policy_selection", record);
  return record;
}

/** Owning immutable projection/intent read on the supplied client, not current installer authority. */
export async function readPostgresReleasePolicySelectionOnClient(
  client: Client,
  scopeInput: EvidenceScope,
  versionInput: string,
  budget?: ReleaseDecisionVerificationBudget,
) {
  if (budget !== undefined && !(budget instanceof ReleaseDecisionVerificationBudget)) fail();
  budget?.snapshot();
  try {
    const scope = EvidenceScopeSchema.parse(scopeInput),
      id = OpaqueIdSchema.parse(versionInput);
    const result = await client.query(viewSql, parameters(scope, id));
    for (const raw of result.rows) admitView(raw, budget);
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

const eventSql = `SELECT to_jsonb(e)||jsonb_build_object('occurred_at_key',e.occurred_at_key::text) AS event,
  (SELECT COALESCE(jsonb_agg(jsonb_build_object('eventType',o.event_type,'schemaVersion',o.schema_version,
    'payload',o.payload,'timeMatches',o.created_at=e.occurred_at_lexical::timestamptz)),'[]'::jsonb)
    FROM public.proofstack_outbox o WHERE o.tenant_id=e.tenant_id AND o.aggregate_type='release_policy_selection_lifecycle' AND o.aggregate_id=e.event_id) AS intents
  FROM public.proofstack_release_selection_lifecycle e
  WHERE e.tenant_id=$1 AND e.project_id=$2 AND e.environment_id=$3 AND e.event_id=$4`;
function checkedEvent(
  raw: Data,
  scope: EvidenceScope,
  id: string,
  records: ReadonlyMap<string, ReleasePolicySelection>,
) {
  const row = object(raw.event),
    event = ReleasePolicySelectionLifecycleEventSchema.parse(row.record);
  const current = records.get(event.selection.selectionVersionId);
  if (
    event.eventId !== id ||
    !same(event.scope, scope) ||
    !current ||
    !same(event.selection, releasePolicySelectionReference(current))
  )
    fail();
  const expected = {
    tenant_id: scope.tenantId,
    project_id: scope.projectId,
    environment_id: scope.environmentId,
    event_id: event.eventId,
    version_id: event.selection.selectionVersionId,
    definition_sha256: event.selection.definitionSha256,
    successor_version_id: event.kind === "superseded" ? event.successor.selectionVersionId : null,
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
    const successor = records.get(event.successor.selectionVersionId);
    if (
      !successor ||
      !same(event.successor, releasePolicySelectionReference(successor)) ||
      !same(successor.predecessor, event.selection) ||
      policyEvaluationTimestampOrderKey(event.occurredAt) <
        policyEvaluationTimestampOrderKey(successor.publishedAt)
    )
      fail();
  }
  checkIntent(raw.intents, "release_policy_selection_lifecycle", event);
  return event;
}
async function eventView(
  client: Client,
  scope: EvidenceScope,
  id: string,
  budget?: ReleaseDecisionVerificationBudget,
) {
  const result = await client.query(eventSql, parameters(scope, id));
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
export async function readPostgresReleaseSelectionLifecycleOnClient(
  client: Client,
  scopeInput: EvidenceScope,
  eventInput: string,
) {
  const scope = EvidenceScopeSchema.parse(scopeInput),
    id = OpaqueIdSchema.parse(eventInput);
  const raw = await eventView(client, scope, id);
  if (!raw) return null;
  const event = ReleasePolicySelectionLifecycleEventSchema.parse(object(raw.event).record);
  const records = new Map<string, ReleasePolicySelection>();
  for (const ref of [event.selection, ...(event.kind === "superseded" ? [event.successor] : [])]) {
    const record = await readPostgresReleasePolicySelectionOnClient(
      client,
      scope,
      ref.selectionVersionId,
    );
    if (!record) fail();
    records.set(record.selectionVersionId, record);
  }
  return checkedEvent(raw, scope, id, records);
}

/** Complete target-owned guarded inventory. Its guard remains CALLER-held; never publish later
 * from a detached returned report. The fixed future publisher still validates complete authority.
 */
export async function readPostgresReleaseSelectionTargetOnClient(
  client: Client,
  scopeInput: EvidenceScope,
  targetInput: ReleasePolicySelectionTarget,
  budget: ReleaseDecisionVerificationBudget,
) {
  if (!(budget instanceof ReleaseDecisionVerificationBudget)) fail();
  try {
    const scope = EvidenceScopeSchema.parse(scopeInput),
      target = ReleaseDecisionSelectionRootReferenceSchema.parse(targetInput);
    budget.snapshot();
    const roots = await client.query<{ value: unknown }>(
      "SELECT public.proofstack_read_release_selection_root($1::jsonb,$2,$3) AS value",
      [JSON.stringify(scope), target.installationId, target.gateTargetId],
    );
    for (const row of roots.rows) budget.observe(row.value);
    if (roots.rows.length !== 1) fail();
    const observation = object(roots.rows[0]?.value);
    if (observation.orphan !== false) fail();
    if (observation.root === null) return { root: null, records: [], lifecycle: [] };
    const rootProjection = object(observation.root),
      rootId = OpaqueIdSchema.parse(rootProjection.root_version_id);
    const root = await readPostgresReleasePolicySelectionOnClient(client, scope, rootId, budget);
    if (
      !root ||
      !same(rootProjection, rootFields(root)) ||
      root.installationId !== target.installationId ||
      root.gateTargetId !== target.gateTargetId ||
      root.predecessor
    )
      fail();
    const records: ReleasePolicySelection[] = [],
      seen = new Set<string>();
    let after = "";
    for (;;) {
      const page = await client.query<{ version_id: unknown }>(
        `SELECT version_id FROM public.proofstack_release_policy_selections
        WHERE tenant_id=$1 AND selection_id=$2 AND version_id COLLATE "C">$3 COLLATE "C" ORDER BY version_id COLLATE "C" LIMIT 16`,
        [scope.tenantId, root.selectionId, after],
      );
      if (page.rows.length > PAGE_SIZE) fail();
      if (page.rows.length === 0)
        budget.observe({ scope, selectionId: root.selectionId, after, versions: [] });
      for (const raw of page.rows) {
        budget.observe(raw);
        const id = OpaqueIdSchema.parse(raw.version_id);
        if (id <= after || seen.has(id)) fail();
        seen.add(id);
        after = id;
        const row =
          id === rootId
            ? root
            : await readPostgresReleasePolicySelectionOnClient(client, scope, id, budget);
        if (!row || row.selectionId !== root.selectionId) fail();
        records.push(row);
      }
      if (page.rows.length < PAGE_SIZE) break;
    }
    if (!seen.has(rootId)) fail();
    const byId = new Map(records.map((row) => [row.selectionVersionId, row]));
    const lifecycle: ReleasePolicySelectionLifecycleEvent[] = [];
    after = "";
    const terminals = new Set<string>();
    for (;;) {
      const page = await client.query<{ event_id: unknown }>(
        `SELECT e.event_id FROM public.proofstack_release_selection_lifecycle e
        JOIN public.proofstack_release_policy_selections v ON v.tenant_id=e.tenant_id AND v.version_id=e.version_id
        WHERE e.tenant_id=$1 AND v.selection_id=$2 AND e.event_id COLLATE "C">$3 COLLATE "C" ORDER BY e.event_id COLLATE "C" LIMIT 16`,
        [scope.tenantId, root.selectionId, after],
      );
      if (page.rows.length > PAGE_SIZE) fail();
      if (page.rows.length === 0)
        budget.observe({ scope, selectionId: root.selectionId, after, events: [] });
      for (const raw of page.rows) {
        budget.observe(raw);
        const id = OpaqueIdSchema.parse(raw.event_id);
        if (id <= after) fail();
        after = id;
        const view = await eventView(client, scope, id, budget);
        if (!view) fail();
        const event = checkedEvent(view, scope, id, byId);
        if (terminals.has(event.selection.selectionVersionId)) fail();
        terminals.add(event.selection.selectionVersionId);
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

function persistenceError(cause: unknown): never {
  const error =
    cause && typeof cause === "object"
      ? (cause as { code?: unknown; message?: unknown; constraint?: unknown })
      : {};
  if (error.code === "P0001" && typeof error.message === "string") {
    const reason = error.message.replace(/^release_selection:/, "");
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
      throw new ReleasePolicySelectionRepositoryError(
        reason as ReleasePolicySelectionRepositoryError["reason"],
        { cause },
      );
  }
  if (["23514", "23503", "23505", "22023", "22P02", "P0002"].includes(String(error.code)))
    throw new ReleasePolicySelectionRepositoryError("storage_invalid", { cause });
  throw cause;
}

/** Trusted declaration storage only. No installer authentication, native role/grant or decision
 * authority is conferred by constructing a pool/repository or supplying an attributable record.
 */
export class PostgresReleasePolicySelectionRepository implements ReleasePolicySelectionRepository {
  constructor(private readonly pool: Pick<Pool, "connect">) {}
  findReleasePolicySelection(scope: EvidenceScope, id: string) {
    return withExactScopeTransaction(this.pool, EvidenceScopeSchema.parse(scope), (client) =>
      readPostgresReleasePolicySelectionOnClient(client, scope, id),
    );
  }
  findReleasePolicySelectionLifecycleEvent(scope: EvidenceScope, id: string) {
    return withExactScopeTransaction(this.pool, EvidenceScopeSchema.parse(scope), (client) =>
      readPostgresReleaseSelectionLifecycleOnClient(client, scope, id),
    );
  }
  async publishReleasePolicySelection(input: ReleasePolicySelection) {
    const record = validated(input, input.scope);
    try {
      return await withExactReadCommittedScopeTransaction(
        this.pool,
        record.scope,
        async (client) => {
          const response = await client.query<{ value: unknown }>(
            "SELECT public.proofstack_store_release_policy_selection($1::jsonb,$2) AS value",
            [JSON.stringify(record), canonical(record)],
          );
          if (response.rows.length !== 1) fail();
          const result = object(response.rows[0]?.value);
          const stored = await readPostgresReleasePolicySelectionOnClient(
            client,
            record.scope,
            record.selectionVersionId,
          );
          if (
            typeof result.created !== "boolean" ||
            !stored ||
            !same(stored, result.record) ||
            stored.definitionSha256 !== record.definitionSha256
          )
            fail();
          return { created: result.created, selection: stored };
        },
      );
    } catch (cause) {
      return persistenceError(cause);
    }
  }
  async publishReleasePolicySelectionLifecycleEvent(input: ReleasePolicySelectionLifecycleEvent) {
    const event = ReleasePolicySelectionLifecycleEventSchema.parse(input);
    try {
      return await withExactReadCommittedScopeTransaction(
        this.pool,
        event.scope,
        async (client) => {
          const response = await client.query<{ value: unknown }>(
            "SELECT public.proofstack_store_release_selection_lifecycle($1::jsonb) AS value",
            [JSON.stringify(event)],
          );
          if (response.rows.length !== 1) fail();
          const result = object(response.rows[0]?.value);
          const stored = await readPostgresReleaseSelectionLifecycleOnClient(
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
  readReleasePolicySelectionTarget(
    scope: EvidenceScope,
    target: ReleasePolicySelectionTarget,
    budget: ReleaseDecisionVerificationBudget,
  ) {
    if (!(budget instanceof ReleaseDecisionVerificationBudget)) fail();
    budget.snapshot();
    return withExactReadCommittedScopeTransaction(
      this.pool,
      EvidenceScopeSchema.parse(scope),
      (client) => readPostgresReleaseSelectionTargetOnClient(client, scope, target, budget),
    ).catch((cause: unknown) => budget.rejectSourceRead(cause));
  }
}
