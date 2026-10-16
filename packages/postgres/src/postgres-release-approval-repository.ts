import { isDeepStrictEqual } from "node:util";
import {
  type EvidenceScope,
  EvidenceScopeSchema,
  OpaqueIdSchema,
  type ReleaseApproval,
  ReleaseApprovalSchema,
  type ReleaseApprovalSubject,
  ReleaseApprovalSubjectSchema,
  type ReleaseApprovalRevocation,
  ReleaseApprovalRevocationSchema,
  encodeReleaseApprovalDefinition,
  policyEvaluationTimestampOrderKey,
} from "@proofstack/contracts";
import {
  type ReleaseApprovalRepository,
  ReleaseApprovalRepositoryError,
  ReleaseDecisionVerificationBudget,
  ReleaseDecisionVerificationBudgetError,
  releaseApprovalReference,
  validateReleaseApprovalRecord,
  releaseApprovalRetryIntent,
} from "@proofstack/core";
import type { Pool, PoolClient } from "pg";
import {
  withExactReadCommittedScopeTransaction,
  withExactScopeTransaction,
} from "./tenant-transaction.js";

type Client = Pick<PoolClient, "query">;
interface Data extends Record<string, unknown> {
  readonly record?: unknown;
  readonly approval?: unknown;
  readonly parent?: unknown;
  readonly successor?: unknown;
  readonly sources?: unknown;
  readonly declarations?: unknown;
  readonly controls?: unknown;
  readonly intents?: unknown;
  readonly event?: unknown;
  readonly kind?: unknown;
  readonly subject?: unknown;
  readonly present?: unknown;
  readonly created?: unknown;
}
const same = isDeepStrictEqual;
function fail(reason: ReleaseApprovalRepositoryError["reason"] = "storage_invalid"): never {
  throw new ReleaseApprovalRepositoryError(reason);
}
function object(raw: unknown): Data {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail();
  return raw as Data;
}
function definition(row: ReleaseApproval) {
  const { schemaVersion: _version, definitionSha256: _sha, ...body } = row;
  return body;
}
function canonical(row: ReleaseApproval) {
  return Buffer.from(
    encodeReleaseApprovalDefinition({ scope: row.subject.scope, definition: definition(row) }),
  ).toString("utf8");
}
function valid(raw: unknown, scope: EvidenceScope): ReleaseApproval {
  // Normalize only JSON-absent optional undefined properties before native transport. The owning
  // schema validates first, and the original receipt/semantic fields remain unchanged.
  const row = ReleaseApprovalSchema.parse(
    JSON.parse(JSON.stringify(ReleaseApprovalSchema.parse(raw))),
  );
  return validateReleaseApprovalRecord({
    expected: { scope, reference: releaseApprovalReference(row) },
    record: row,
  });
}
function fields(row: ReleaseApproval) {
  return {
    tenant_id: row.subject.scope.tenantId,
    project_id: row.subject.scope.projectId,
    environment_id: row.subject.scope.environmentId,
    approval_id: row.approvalId,
    definition_sha256: row.definitionSha256,
    kind: row.kind,
    action: row.action,
    subject: row.subject,
    reviewer: row.reviewer,
    authority: row.authority,
    job_id: row.subject.jobId,
    rule_id: row.subject.ruleId,
    reviewer_principal_id: row.reviewer.principalId,
    credential_id: row.reviewer.credentialId,
    authentication_request_id: row.reviewer.requestId,
    authenticated_at_lexical: row.reviewer.authenticatedAt,
    recorded_at_lexical: row.recordedAt,
    expires_at_lexical: row.expiresAt,
    authenticated_at_key: policyEvaluationTimestampOrderKey(
      row.reviewer.authenticatedAt,
    ).toString(),
    recorded_at_key: policyEvaluationTimestampOrderKey(row.recordedAt).toString(),
    expires_at_key: policyEvaluationTimestampOrderKey(row.expiresAt).toString(),
    parent_approval_id: row.supersedes?.approvalId ?? null,
    parent_definition_sha256: row.supersedes?.definitionSha256 ?? null,
    condition_count: row.conditions.length,
    conflict_count: row.declaredConflicts.length,
    control_count: row.compensatingControls.length,
    canonical_utf8: canonical(row),
    record: row,
  };
}
function checkedRow(raw: unknown, scope: EvidenceScope) {
  const value = object(raw),
    row = valid(value.record, scope);
  if (!same(value, fields(row))) fail();
  return row;
}
function nativeTime(alias: "a" | "p" | "s") {
  return `to_jsonb(${alias})||jsonb_build_object('authenticated_at_key',${alias}.authenticated_at_key::text,'recorded_at_key',${alias}.recorded_at_key::text,'expires_at_key',${alias}.expires_at_key::text)`;
}
const viewSql = `SELECT ${nativeTime("a")} AS approval,${nativeTime("p")} AS parent,${nativeTime("s")} AS successor,
 (SELECT COALESCE(jsonb_agg(to_jsonb(c) ORDER BY c.kind COLLATE "C"),'[]'::jsonb) FROM public.proofstack_release_approval_sources c WHERE c.tenant_id=a.tenant_id AND c.approval_id=a.approval_id) AS sources,
 (SELECT COALESCE(jsonb_agg(to_jsonb(c) ORDER BY c.kind COLLATE "C",c.ordinal),'[]'::jsonb) FROM public.proofstack_release_approval_declarations c WHERE c.tenant_id=a.tenant_id AND c.approval_id=a.approval_id) AS declarations,
 (SELECT COALESCE(jsonb_agg(to_jsonb(c) ORDER BY c.ordinal),'[]'::jsonb) FROM public.proofstack_release_approval_controls c WHERE c.tenant_id=a.tenant_id AND c.approval_id=a.approval_id) AS controls,
 (SELECT COALESCE(jsonb_agg(jsonb_build_object('eventType',o.event_type,'schemaVersion',o.schema_version,'payload',o.payload,'timeMatches',o.created_at=a.recorded_at_lexical::timestamptz)),'[]'::jsonb) FROM public.proofstack_outbox o WHERE o.tenant_id=a.tenant_id AND o.aggregate_type='release_approval' AND o.aggregate_id=a.approval_id) AS intents
 FROM public.proofstack_release_approvals a
 LEFT JOIN public.proofstack_release_approvals p ON p.tenant_id=a.tenant_id AND p.approval_id=a.parent_approval_id
 LEFT JOIN public.proofstack_release_approvals s ON s.tenant_id=a.tenant_id AND s.parent_approval_id=a.approval_id
 WHERE a.tenant_id=$1 AND a.project_id=$2 AND a.environment_id=$3 AND a.approval_id=$4`;
const parameters = (scope: EvidenceScope, id: string) => [
  scope.tenantId,
  scope.projectId,
  scope.environmentId,
  id,
];
function admit(raw: Data, budget?: ReleaseDecisionVerificationBudget) {
  if (!budget) return;
  const { approval, parent, successor, ...metadata } = raw;
  // Each actual approval observation is admitted independently. Packed normalized children are
  // metadata, never extra approval actors; raw bytes are encoded once per observed part.
  budget.observe(approval, "approval");
  for (const [kind, value] of [
    ["parent", parent],
    ["successor", successor],
  ] as const) {
    if (value === null) budget.observe({ relationship: kind, state: "missing" });
    else budget.observe(value, "approval");
  }
  const count = ["sources", "declarations", "controls", "intents"].reduce(
    (n, key) => n + Math.max(1, Array.isArray(metadata[key]) ? metadata[key].length : 1),
    0,
  );
  budget.observe(metadata, "metadata", count);
}
function intent(
  raw: unknown,
  kind: "release_approval" | "release_approval_revocation",
  row: unknown,
) {
  if (
    !same(raw, [
      {
        eventType:
          kind === "release_approval" ? "release.approval.recorded" : "release.approval.revoked",
        schemaVersion: "0.1",
        payload: { recordKind: kind, record: row },
        timeMatches: true,
      },
    ])
  )
    fail();
}
function relation(parent: ReleaseApproval, child: ReleaseApproval) {
  if (
    !same(child.supersedes, releaseApprovalReference(parent)) ||
    parent.kind !== child.kind ||
    !same(parent.subject, child.subject) ||
    parent.reviewer.principalId !== child.reviewer.principalId ||
    policyEvaluationTimestampOrderKey(parent.recordedAt) >
      policyEvaluationTimestampOrderKey(child.recordedAt)
  )
    fail();
}
function checkedView(raw: Data, scope: EvidenceScope, id: string) {
  const row = checkedRow(raw.approval, scope);
  if (row.approvalId !== id) fail();
  if (row.supersedes) relation(checkedRow(raw.parent, scope), row);
  else if (raw.parent !== null) fail();
  if (raw.successor !== null) relation(row, checkedRow(raw.successor, scope));
  const common = {
    tenant_id: scope.tenantId,
    project_id: scope.projectId,
    environment_id: scope.environmentId,
    approval_id: row.approvalId,
    definition_sha256: row.definitionSha256,
  };
  const subject = row.subject;
  const sources = (
    [
      ["candidate", subject.candidate.candidateVersionId, subject.candidate],
      ["evaluation", subject.evaluation.evaluationId, subject.evaluation],
      ["policy", subject.policy.policyVersionId, subject.policy],
      ["request", subject.request.evaluationRequestId, subject.request],
      ["selection", subject.selection.selectionVersionId, subject.selection],
      ["snapshot", subject.snapshot.snapshotId, subject.snapshot],
    ] as const
  ).map(([kind, source_id, reference]) => ({
    ...common,
    kind,
    source_id,
    source_definition_sha256: reference.definitionSha256,
    reference,
  }));
  const declarations = (
    [
      ["condition", row.conditions],
      ["conflict", row.declaredConflicts],
    ] as const
  ).flatMap(([kind, values]) =>
    values.map((declaration, ordinal) => ({ ...common, kind, ordinal, declaration })),
  );
  const controls = row.compensatingControls.map((reference, ordinal) => ({
    ...common,
    ordinal,
    reference,
    artifact_id: reference.artifactId,
    artifact_sha256: reference.sha256,
  }));
  if (
    !same(raw.sources, sources) ||
    !same(raw.declarations, declarations) ||
    !same(raw.controls, controls)
  )
    fail();
  intent(raw.intents, "release_approval", row);
  return row;
}

/** Owning original/normalized/lineage/intent read on the supplied client, not current approval authority. */
export async function readPostgresReleaseApprovalOnClient(
  client: Client,
  scopeInput: EvidenceScope,
  idInput: string,
  budget?: ReleaseDecisionVerificationBudget,
) {
  if (budget !== undefined && !(budget instanceof ReleaseDecisionVerificationBudget)) fail();
  budget?.snapshot();
  try {
    const scope = EvidenceScopeSchema.parse(scopeInput),
      id = OpaqueIdSchema.parse(idInput);
    const result = await client.query(viewSql, parameters(scope, id));
    for (const raw of result.rows) admit(raw, budget);
    if (result.rows.length > 1) fail();
    const raw = result.rows[0];
    if (!raw) {
      budget?.observe({ scope, approvalId: id, state: "missing" }, "approval");
      return null;
    }
    return checkedView(raw, scope, id);
  } catch (cause) {
    if (budget) return budget.rejectSourceRead(cause);
    throw cause;
  }
}
const eventSql = `SELECT to_jsonb(e)||jsonb_build_object('occurred_at_key',e.occurred_at_key::text) AS event,
 (SELECT COALESCE(jsonb_agg(jsonb_build_object('eventType',o.event_type,'schemaVersion',o.schema_version,'payload',o.payload,'timeMatches',o.created_at=e.occurred_at_lexical::timestamptz)),'[]'::jsonb) FROM public.proofstack_outbox o WHERE o.tenant_id=e.tenant_id AND o.aggregate_type='release_approval_revocation' AND o.aggregate_id=e.event_id) AS intents
 FROM public.proofstack_release_approval_revocations e WHERE e.tenant_id=$1 AND e.project_id=$2 AND e.environment_id=$3 AND e.event_id=$4`;
async function eventView(
  client: Client,
  scope: EvidenceScope,
  id: string,
  budget?: ReleaseDecisionVerificationBudget,
) {
  const result = await client.query(eventSql, parameters(scope, id));
  for (const raw of result.rows) {
    const { event, ...metadata } = raw;
    budget?.observe(event);
    budget?.observe(
      metadata,
      "metadata",
      Math.max(1, Array.isArray(raw.intents) ? raw.intents.length : 1),
    );
  }
  if (result.rows.length > 1) fail();
  if (!result.rows[0]) {
    budget?.observe({ scope, eventId: id, state: "missing" });
    return null;
  }
  return result.rows[0];
}
function checkedEvent(raw: Data, scope: EvidenceScope, id: string, original: ReleaseApproval) {
  const value = object(raw.event),
    event = ReleaseApprovalRevocationSchema.parse(value.record);
  const expected = {
    tenant_id: scope.tenantId,
    project_id: scope.projectId,
    environment_id: scope.environmentId,
    event_id: event.eventId,
    approval_id: event.approval.approvalId,
    approval_definition_sha256: event.approval.definitionSha256,
    reviewer_principal_id: event.reviewer.principalId,
    reviewer: event.reviewer,
    occurred_at_lexical: event.occurredAt,
    occurred_at_key: policyEvaluationTimestampOrderKey(event.occurredAt).toString(),
    record: event,
  };
  if (
    !same(value, expected) ||
    event.eventId !== id ||
    !same(event.scope, scope) ||
    !same(event.approval, releaseApprovalReference(original)) ||
    event.reviewer.principalId !== original.reviewer.principalId ||
    policyEvaluationTimestampOrderKey(original.recordedAt) >
      policyEvaluationTimestampOrderKey(event.occurredAt)
  )
    fail();
  intent(raw.intents, "release_approval_revocation", event);
  return event;
}
export async function readPostgresReleaseApprovalRevocationOnClient(
  client: Client,
  scopeInput: EvidenceScope,
  idInput: string,
  budget?: ReleaseDecisionVerificationBudget,
) {
  if (budget !== undefined && !(budget instanceof ReleaseDecisionVerificationBudget)) fail();
  budget?.snapshot();
  try {
    const scope = EvidenceScopeSchema.parse(scopeInput),
      id = OpaqueIdSchema.parse(idInput),
      raw = await eventView(client, scope, id, budget);
    if (!raw) return null;
    const event = ReleaseApprovalRevocationSchema.parse(object(raw.event).record),
      original = await readPostgresReleaseApprovalOnClient(
        client,
        scope,
        event.approval.approvalId,
        budget,
      );
    if (!original) fail();
    return checkedEvent(raw, scope, id, original);
  } catch (cause) {
    if (budget) return budget.rejectSourceRead(cause);
    throw cause;
  }
}

/** Complete exact kind/subject inventory. Its native guard remains CALLER-held. A detached
 * returned census never authorizes subsequent publication or supplies actual OIDC authentication.
 */
export async function readPostgresReleaseApprovalSubjectOnClient(
  client: Client,
  scopeInput: EvidenceScope,
  kind: ReleaseApproval["kind"],
  subjectInput: ReleaseApprovalSubject,
  budget: ReleaseDecisionVerificationBudget,
) {
  if (!(budget instanceof ReleaseDecisionVerificationBudget)) fail();
  budget.snapshot();
  try {
    const scope = EvidenceScopeSchema.parse(scopeInput),
      subject = ReleaseApprovalSubjectSchema.parse(subjectInput);
    if ((kind !== "normal_approval" && kind !== "rule_exception") || !same(scope, subject.scope))
      fail("scope_mismatch");
    const probe = await client.query<{ value: unknown }>(
      "SELECT public.proofstack_read_release_approval_subject($1::jsonb,$2,$3::jsonb) AS value",
      [JSON.stringify(scope), kind, JSON.stringify(subject)],
    );
    for (const row of probe.rows) budget.observe(row.value);
    if (probe.rows.length !== 1) fail();
    const observed = object(probe.rows[0]?.value);
    if (
      !same(observed.kind, kind) ||
      !same(observed.subject, subject) ||
      typeof observed.present !== "boolean"
    )
      fail();
    if (!observed.present) return { records: [], revocations: [] };
    const records: ReleaseApproval[] = [],
      seen = new Set<string>();
    let after = "";
    for (;;) {
      const page = await client.query<{ approval_id: unknown }>(
        `SELECT approval_id FROM public.proofstack_release_approvals WHERE tenant_id=$1 AND project_id=$2 AND environment_id=$3 AND kind=$4 AND subject=$5::jsonb AND approval_id COLLATE "C">$6 COLLATE "C" ORDER BY approval_id COLLATE "C" LIMIT 16`,
        [
          scope.tenantId,
          scope.projectId,
          scope.environmentId,
          kind,
          JSON.stringify(subject),
          after,
        ],
      );
      if (page.rows.length > 16) fail();
      if (!page.rows.length) budget.observe({ kind, subject, after, approvals: [] });
      for (const raw of page.rows) {
        budget.observe(raw);
        const id = OpaqueIdSchema.parse(raw.approval_id);
        if (id <= after || seen.has(id)) fail();
        seen.add(id);
        after = id;
        const row = await readPostgresReleaseApprovalOnClient(client, scope, id, budget);
        if (!row || row.kind !== kind || !same(row.subject, subject)) fail();
        records.push(row);
      }
      if (page.rows.length < 16) break;
    }
    if (!records.length) fail();
    const byId = new Map(records.map((row) => [row.approvalId, row])),
      parents = new Set<string>();
    for (const row of records)
      if (row.supersedes) {
        const parent = byId.get(row.supersedes.approvalId);
        if (!parent || parents.has(parent.approvalId)) fail();
        relation(parent, row);
        parents.add(parent.approvalId);
      }
    const revocations: ReleaseApprovalRevocation[] = [],
      revoked = new Set<string>();
    after = "";
    for (;;) {
      const page = await client.query<{ event_id: unknown }>(
        `SELECT e.event_id FROM public.proofstack_release_approval_revocations e JOIN public.proofstack_release_approvals a ON a.tenant_id=e.tenant_id AND a.approval_id=e.approval_id WHERE a.tenant_id=$1 AND a.project_id=$2 AND a.environment_id=$3 AND a.kind=$4 AND a.subject=$5::jsonb AND e.event_id COLLATE "C">$6 COLLATE "C" ORDER BY e.event_id COLLATE "C" LIMIT 16`,
        [
          scope.tenantId,
          scope.projectId,
          scope.environmentId,
          kind,
          JSON.stringify(subject),
          after,
        ],
      );
      if (page.rows.length > 16) fail();
      if (!page.rows.length) budget.observe({ kind, subject, after, revocations: [] });
      for (const raw of page.rows) {
        budget.observe(raw);
        const id = OpaqueIdSchema.parse(raw.event_id);
        if (id <= after) fail();
        after = id;
        const view = await eventView(client, scope, id, budget);
        if (!view) fail();
        const event = ReleaseApprovalRevocationSchema.parse(object(view.event).record),
          original = byId.get(event.approval.approvalId);
        if (!original || revoked.has(original.approvalId)) fail();
        revoked.add(original.approvalId);
        revocations.push(checkedEvent(view, scope, id, original));
      }
      if (page.rows.length < 16) break;
    }
    revocations.sort((a, b) => {
      const x = policyEvaluationTimestampOrderKey(a.occurredAt),
        y = policyEvaluationTimestampOrderKey(b.occurredAt);
      return x < y ? -1 : x > y ? 1 : a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0;
    });
    return { records, revocations };
  } catch (cause) {
    if (cause instanceof ReleaseDecisionVerificationBudgetError) throw cause;
    return budget.rejectSourceRead(cause);
  }
}
function persistenceError(cause: unknown): never {
  const value =
    cause && typeof cause === "object" ? (cause as { code?: unknown; message?: unknown }) : {};
  if (value.code === "P0001" && typeof value.message === "string") {
    const reason = value.message.replace(/^release_approval:/, "");
    if (
      [
        "approval_conflict",
        "supersession_conflict",
        "revocation_conflict",
        "revocation_state_conflict",
        "lineage_invalid",
        "receipt_invalid",
        "scope_mismatch",
      ].includes(reason)
    )
      throw new ReleaseApprovalRepositoryError(reason as ReleaseApprovalRepositoryError["reason"], {
        cause,
      });
  }
  if (["23514", "23503", "23505", "22023", "22P02", "P0002"].includes(String(value.code)))
    throw new ReleaseApprovalRepositoryError("storage_invalid", { cause });
  throw cause;
}
function revokeIntent(event: ReleaseApprovalRevocation) {
  const { occurredAt: _at, reviewer, ...body } = event;
  return { ...body, reviewerPrincipalId: reviewer.principalId };
}

/** Trusted declaration storage. Current private authentication/authorization precedes admission
 * in the future owning service; neither stored receipts nor this repository supplies that proof.
 */
export class PostgresReleaseApprovalRepository implements ReleaseApprovalRepository {
  constructor(private readonly pool: Pick<Pool, "connect">) {}
  findReleaseApproval(scope: EvidenceScope, id: string) {
    return withExactScopeTransaction(this.pool, EvidenceScopeSchema.parse(scope), (client) =>
      readPostgresReleaseApprovalOnClient(client, scope, id),
    );
  }
  findReleaseApprovalRevocation(scope: EvidenceScope, id: string) {
    return withExactScopeTransaction(this.pool, EvidenceScopeSchema.parse(scope), (client) =>
      readPostgresReleaseApprovalRevocationOnClient(client, scope, id),
    );
  }
  async publishReleaseApproval(input: ReleaseApproval) {
    const row = valid(input, input.subject.scope);
    try {
      return await withExactReadCommittedScopeTransaction(
        this.pool,
        row.subject.scope,
        async (client) => {
          const result = await client.query<{ value: unknown }>(
            "SELECT public.proofstack_store_release_approval($1::jsonb,$2) AS value",
            [JSON.stringify(row), canonical(row)],
          );
          if (result.rows.length !== 1) fail();
          const ack = object(result.rows[0]?.value),
            stored = await readPostgresReleaseApprovalOnClient(
              client,
              row.subject.scope,
              row.approvalId,
            );
          if (
            typeof ack.created !== "boolean" ||
            !stored ||
            !same(stored, ack.record) ||
            !same(releaseApprovalRetryIntent(stored), releaseApprovalRetryIntent(row)) ||
            (ack.created && stored.definitionSha256 !== row.definitionSha256)
          )
            fail();
          return { created: ack.created, approval: stored };
        },
      );
    } catch (cause) {
      return persistenceError(cause);
    }
  }
  async publishReleaseApprovalRevocation(input: ReleaseApprovalRevocation) {
    const event = ReleaseApprovalRevocationSchema.parse(
      JSON.parse(JSON.stringify(ReleaseApprovalRevocationSchema.parse(input))),
    );
    try {
      return await withExactReadCommittedScopeTransaction(
        this.pool,
        event.scope,
        async (client) => {
          const result = await client.query<{ value: unknown }>(
            "SELECT public.proofstack_store_release_approval_revocation($1::jsonb) AS value",
            [JSON.stringify(event)],
          );
          if (result.rows.length !== 1) fail();
          const ack = object(result.rows[0]?.value),
            stored = await readPostgresReleaseApprovalRevocationOnClient(
              client,
              event.scope,
              event.eventId,
            );
          if (
            typeof ack.created !== "boolean" ||
            !stored ||
            !same(stored, ack.record) ||
            !same(revokeIntent(stored), revokeIntent(event)) ||
            (ack.created && !same(stored, event))
          )
            fail();
          return { created: ack.created, event: stored };
        },
      );
    } catch (cause) {
      return persistenceError(cause);
    }
  }
  readReleaseApprovalSubject(
    scope: EvidenceScope,
    kind: ReleaseApproval["kind"],
    subject: ReleaseApprovalSubject,
    budget: ReleaseDecisionVerificationBudget,
  ) {
    if (!(budget instanceof ReleaseDecisionVerificationBudget)) fail();
    budget.snapshot();
    try {
      return withExactReadCommittedScopeTransaction(
        this.pool,
        EvidenceScopeSchema.parse(scope),
        (client) =>
          readPostgresReleaseApprovalSubjectOnClient(client, scope, kind, subject, budget),
      ).catch((cause: unknown) => budget.rejectSourceRead(cause));
    } catch (cause) {
      return budget.rejectSourceRead(cause);
    }
  }
}
