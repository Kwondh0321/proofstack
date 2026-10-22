import { isDeepStrictEqual } from "node:util";
import {
  encodeReleaseReviewerAuthorityDefinition,
  encodeReleaseReviewerPublicationDefinition,
  PolicyEvaluationTimeSchema,
  PublishReleaseReviewerAuthorityLifecycleRequestSchema,
  PublishReleaseReviewerAuthorityRequestSchema,
  ReleaseApprovalReviewerReceiptSchema,
  ReleaseDecisionIdentityGrantSchema,
  ReleaseDecisionSessionStateSchema,
  ReleaseDecisionUserIdentityReferenceSchema,
  ReleaseReviewerAuthorityDefinitionSchema,
  serializeEvaluationCanonicalJson,
  type EvidenceScope,
  type ReleaseApprovalReviewerReceipt,
  type ReleaseReviewerPublicationMaterial,
} from "@proofstack/contracts";
import {
  inspectCapturedReleaseIdentityState,
  prepareReleaseReviewerPublicationMaterial,
  ReleaseDecisionVerificationBudget,
  validateReleaseReviewerPublicationMaterial,
} from "@proofstack/core";
import {
  readReleaseMutationAuthentication,
  ReleaseMutationAuthenticator,
  type ReleaseBrowserMutationCredentials,
  type ReleaseReviewerAdministrator,
  type ReleaseReviewerAdministratorResult,
} from "@proofstack/identity";
import type { PoolClient } from "pg";
import {
  withBoundedPolicyTransaction,
  type PolicyTransactionPool,
} from "./bounded-policy-transaction.js";
import { assertMigrationsCurrentOnClient } from "./migration-runner.js";
import { loadBundledMigrations } from "./migrations.js";
import { assertReviewerAdministratorRoleOnClient } from "./reviewer-administrator-role.js";
import {
  assertReviewerAdministratorSchemaOnClient,
  prepareReviewerAdministratorSchema,
} from "./reviewer-administrator-schema.js";

import {
  readPostgresReleaseReviewerAuthorityForAdministratorOnClient,
  readPostgresReleaseReviewerLifecycleForAdministratorOnClient,
  readPostgresReleaseReviewerTargetForAdministratorOnClient,
} from "./postgres-release-reviewer-authority-repository.js";

type SourceKind = ReleaseReviewerPublicationMaterial["source"]["kind"];
export type PostgresReleaseReviewerAdministratorResult = ReleaseReviewerAdministratorResult;
const limits = {
  maxAcquisitionRecords: 10000,
  maxAcquisitionRecordBytes: 16 * 1024 * 1024,
  maxApprovalRecords: 0,
} as const;
export class PostgresReleaseReviewerAdministratorError extends Error {
  readonly code = "release_reviewer_administrator_rejected";
  constructor() {
    super("Authenticated reviewer administration was rejected");
    this.name = "PostgresReleaseReviewerAdministratorError";
  }
}
function fail(): never {
  throw new PostgresReleaseReviewerAdministratorError();
}
function object(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail();
  return raw as Record<string, unknown>;
}
async function one(
  client: PoolClient,
  budget: ReleaseDecisionVerificationBudget,
  sql: string,
  values: readonly unknown[],
): Promise<unknown> {
  const result = await client.query<{ value: unknown }>(sql, [...values]);
  for (const row of result.rows) budget.observe(row);
  if (
    result.rows.length !== 1 ||
    !result.rows[0] ||
    !isDeepStrictEqual(Object.keys(result.rows[0]), ["value"])
  )
    fail();
  return result.rows[0].value;
}
async function part(
  client: PoolClient,
  scope: EvidenceScope,
  kind: SourceKind,
  id: string,
  name: string,
  budget: ReleaseDecisionVerificationBudget,
) {
  return one(
    client,
    budget,
    "SELECT public.proofstack_read_reviewer_publication_part($1::jsonb,$2,$3,$4) AS value",
    [JSON.stringify(scope), kind, id, name],
  );
}
function inspectIdentity(
  raw: unknown,
  scope: EvidenceScope,
  actor: ReleaseApprovalReviewerReceipt,
  budget: ReleaseDecisionVerificationBudget,
) {
  const value = object(raw);
  const receipt = ReleaseApprovalReviewerReceiptSchema.parse(value["actor"]);
  const identity = ReleaseDecisionUserIdentityReferenceSchema.parse(value["identity"]);
  const grant = ReleaseDecisionIdentityGrantSchema.parse(value["grant"]);
  const credential = ReleaseDecisionSessionStateSchema.parse(value["credential"]);
  const capturedAt = PolicyEvaluationTimeSchema.parse(value["capturedAt"]);
  if (!isDeepStrictEqual(receipt, actor)) fail();
  const eligible = inspectCapturedReleaseIdentityState({
    scope,
    receipt,
    identity,
    grant: { state: "observed", reference: identity, record: grant },
    credential: {
      state: "observed",
      reference: {
        kind: "oidc_session",
        principalId: actor.principalId,
        credentialId: actor.credentialId,
      },
      record: credential,
    },
    capturedAt,
    operation: "manage_reviewer_authority",
    budget,
  });
  if (eligible.state !== "eligible") fail();
}
async function readMaterial(
  client: PoolClient,
  scope: EvidenceScope,
  kind: SourceKind,
  id: string,
  budget: ReleaseDecisionVerificationBudget,
  complete: boolean,
) {
  const rawHeader = await part(client, scope, kind, id, "header", budget);
  if (rawHeader === null) return null;
  const header = object(rawHeader);
  if (complete && header["canonicalIntent"] !== true) fail();
  if (
    header["completed"] !== complete ||
    typeof header["originEpoch"] !== "string" ||
    !/^[0-9]+$/.test(header["originEpoch"])
  )
    fail();
  const source = await part(client, scope, kind, id, "source", budget);
  const grant = await part(client, scope, kind, id, "grant", budget);
  const credential = await part(client, scope, kind, id, "credential", budget);
  const material = complete
    ? validateReleaseReviewerPublicationMaterial(
        { publication: header["publication"], source, grant, credential },
        budget,
      )
    : prepareReleaseReviewerPublicationMaterial({
        scope,
        source: source as ReleaseReviewerPublicationMaterial["source"],
        actor: ReleaseApprovalReviewerReceiptSchema.parse(header["actor"]),
        identity: ReleaseDecisionUserIdentityReferenceSchema.parse(header["identity"]),
        grant: ReleaseDecisionIdentityGrantSchema.parse(grant),
        credential: ReleaseDecisionSessionStateSchema.parse(credential),
        issuedAt: PolicyEvaluationTimeSchema.parse(header["issuedAt"]),
        budget,
      });
  if (
    !isDeepStrictEqual(material.publication.scope, scope) ||
    material.source.kind !== kind ||
    !isDeepStrictEqual(material.publication.actor, header["actor"]) ||
    !isDeepStrictEqual(material.publication.identity, header["identity"]) ||
    material.publication.issuedAt !== header["issuedAt"]
  )
    fail();
  const own =
    kind === "release_reviewer_authority"
      ? await readPostgresReleaseReviewerAuthorityForAdministratorOnClient(
          client,
          scope,
          id,
          budget,
        )
      : await readPostgresReleaseReviewerLifecycleForAdministratorOnClient(
          client,
          scope,
          id,
          budget,
        );
  if (!own || !isDeepStrictEqual(own, material.source.record)) fail();
  if (complete) {
    const {
      schemaVersion: _version,
      definitionSha256: _hash,
      ...definition
    } = material.publication;
    const encodings = [
      ["source_encoding", serializeEvaluationCanonicalJson(material.source.record)],
      ["grant_encoding", serializeEvaluationCanonicalJson(material.grant)],
      ["credential_encoding", serializeEvaluationCanonicalJson(material.credential)],
      [
        "publication_encoding",
        Buffer.from(encodeReleaseReviewerPublicationDefinition({ scope, definition })).toString(
          "utf8",
        ),
      ],
    ] as const;
    for (const [name, canonical] of encodings)
      if ((await part(client, scope, kind, id, name, budget)) !== canonical) fail();
  }
  return material;
}

/** Server composition only. Actual cookie/CSRF authentication precedes body parsing. The native
 * dedicated reviewer administrator role and one bounded guarded connection own source/profile/outbox publication.
 * Returned provenance is historical evidence, never current decision/publication authority.
 */
export class PostgresReleaseReviewerAdministrator implements ReleaseReviewerAdministrator {
  constructor(
    private readonly pool: PolicyTransactionPool,
    private readonly authentication: ReleaseMutationAuthenticator,
  ) {
    if (!(authentication instanceof ReleaseMutationAuthenticator)) fail();
  }
  publishReviewerAuthority(
    credentials: ReleaseBrowserMutationCredentials,
    intent: unknown,
  ): Promise<PostgresReleaseReviewerAdministratorResult> {
    return this.publish(credentials, intent, "release_reviewer_authority");
  }
  publishReviewerAuthorityLifecycle(
    credentials: ReleaseBrowserMutationCredentials,
    intent: unknown,
  ): Promise<PostgresReleaseReviewerAdministratorResult> {
    return this.publish(credentials, intent, "release_reviewer_authority_lifecycle");
  }
  private async publish(
    credentials: ReleaseBrowserMutationCredentials,
    raw: unknown,
    kind: SourceKind,
  ) {
    const proof = await this.authentication.authenticateReviewerAuthorityAdministrator(credentials);
    const authenticated = readReleaseMutationAuthentication(proof, {
      operation: "manage_reviewer_authority",
      scope: credentials.scope,
      requestId: credentials.requestId,
    });
    const actor = ReleaseApprovalReviewerReceiptSchema.parse(authenticated.receipt),
      scope = authenticated.scope;
    const authority =
      kind === "release_reviewer_authority"
        ? ReleaseReviewerAuthorityDefinitionSchema.parse({
            ...PublishReleaseReviewerAuthorityRequestSchema.parse(raw),
            scope,
            issuerPrincipalId: actor.principalId,
          })
        : null;
    const lifecycle =
      kind === "release_reviewer_authority_lifecycle"
        ? PublishReleaseReviewerAuthorityLifecycleRequestSchema.parse(raw)
        : null;
    const id = authority?.authorityVersionId ?? lifecycle?.eventId;
    if (!id) fail();
    const migrations = await loadBundledMigrations(),
      budget = new ReleaseDecisionVerificationBudget(limits);
    const expectedSchema = prepareReviewerAdministratorSchema(migrations);
    return withBoundedPolicyTransaction(
      this.pool,
      async (client) => {
        try {
          const epoch = await one(
            client,
            budget,
            "SELECT public.proofstack_reviewer_administrator_context($1::jsonb) AS value",
            [JSON.stringify(scope)],
          );
          if (typeof epoch !== "string" || !/^[0-9]+$/.test(epoch)) fail();
          await assertMigrationsCurrentOnClient(client, migrations);
          await assertReviewerAdministratorSchemaOnClient(client, expectedSchema, budget);
          await assertReviewerAdministratorRoleOnClient(client, budget);
          const currentIdentity = await one(
            client,
            budget,
            "SELECT public.proofstack_recheck_reviewer_administrator($1::jsonb,$2::jsonb) AS value",
            [JSON.stringify(scope), JSON.stringify(actor)],
          );
          inspectIdentity(currentIdentity, scope, actor, budget);
          const existing = await part(client, scope, kind, id, "header", budget);
          // Reinspect the complete owning target and original root/parent profiles under the
          // held reviewer guard. Later administrator logout cannot rewrite historical origins.
          if (existing === null && authority) {
            const target = await readPostgresReleaseReviewerTargetForAdministratorOnClient(
              client,
              scope,
              {
                installationId: authority.installationId,
                gateTargetId: authority.gateTargetId,
                reviewerPrincipalId: authority.reviewerPrincipalId,
              },
              budget,
            );
            for (const id of new Set([
              ...(target.root ? [target.root.authorityVersionId] : []),
              ...(authority.predecessor ? [authority.predecessor.authorityVersionId] : []),
            ])) {
              if (
                !(await readMaterial(client, scope, "release_reviewer_authority", id, budget, true))
              )
                fail();
            }
          }
          if (existing === null && lifecycle) {
            for (const ref of [
              lifecycle.authority,
              ...(lifecycle.kind === "superseded" ? [lifecycle.successor] : []),
            ]) {
              const retained = await readMaterial(
                client,
                scope,
                "release_reviewer_authority",
                ref.authorityVersionId,
                budget,
                true,
              );
              if (!retained || !isDeepStrictEqual(retained.publication.subject.authority, ref))
                fail();
            }
          }
          const begun = object(
            authority
              ? await one(
                  client,
                  budget,
                  "SELECT public.proofstack_begin_authenticated_reviewer_authority($1::jsonb,$2::jsonb,$3,$4::jsonb) AS value",
                  [
                    JSON.stringify(scope),
                    JSON.stringify(authority),
                    Buffer.from(
                      encodeReleaseReviewerAuthorityDefinition({ scope, definition: authority }),
                    ).toString("utf8"),
                    JSON.stringify(actor),
                  ],
                )
              : await one(
                  client,
                  budget,
                  "SELECT public.proofstack_begin_authenticated_reviewer_authority_lifecycle($1::jsonb,$2::jsonb,$3::jsonb) AS value",
                  [JSON.stringify(scope), JSON.stringify(lifecycle), JSON.stringify(actor)],
                ),
          );
          if (
            typeof begun["created"] !== "boolean" ||
            begun["sourceKind"] !== kind ||
            begun["sourceId"] !== id ||
            begun["created"] !== (existing === null)
          )
            fail();
          inspectIdentity(begun["identityObservation"], scope, actor, budget);
          let material = await readMaterial(client, scope, kind, id, budget, !begun["created"]);
          if (!material) fail();
          if (begun["created"]) {
            const {
              schemaVersion: _version,
              definitionSha256: _hash,
              ...definition
            } = material.publication;
            const finished = await one(
              client,
              budget,
              "SELECT public.proofstack_finish_reviewer_publication($1::jsonb,$2,$3,$4::jsonb,$5,$6,$7,$8) AS value",
              [
                JSON.stringify(scope),
                kind,
                id,
                JSON.stringify(material.publication),
                Buffer.from(
                  encodeReleaseReviewerPublicationDefinition({ scope, definition }),
                ).toString("utf8"),
                serializeEvaluationCanonicalJson(material.source.record),
                serializeEvaluationCanonicalJson(material.grant),
                serializeEvaluationCanonicalJson(material.credential),
              ],
            );
            if (!isDeepStrictEqual(finished, material.publication)) fail();
            material = await readMaterial(client, scope, kind, id, budget, true);
            if (!material) fail();
          }
          return {
            created: begun["created"],
            record: material.source.record,
            publication: material.publication,
            usage: budget.snapshot(),
          };
        } catch (cause) {
          return budget.rejectSourceRead(cause);
        }
      },
      { scope, requireWire: true },
    );
  }
}
