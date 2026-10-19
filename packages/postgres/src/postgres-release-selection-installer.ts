import { isDeepStrictEqual } from "node:util";
import {
  encodeReleasePolicySelectionDefinition,
  encodeReleaseSelectionPublicationDefinition,
  PolicyEvaluationTimeSchema,
  PublishReleasePolicySelectionLifecycleRequestSchema,
  PublishReleasePolicySelectionRequestSchema,
  ReleaseApprovalReviewerReceiptSchema,
  ReleaseDecisionIdentityGrantSchema,
  ReleaseDecisionSessionStateSchema,
  ReleaseDecisionUserIdentityReferenceSchema,
  ReleasePolicySelectionDefinitionSchema,
  serializeEvaluationCanonicalJson,
  type EvidenceScope,
  type ReleaseApprovalReviewerReceipt,
  type ReleaseSelectionPublicationMaterial,
} from "@proofstack/contracts";
import {
  inspectCapturedReleaseIdentityState,
  prepareReleaseSelectionPublicationMaterial,
  ReleaseDecisionVerificationBudget,
  validateReleaseSelectionPublicationMaterial,
  releasePolicyReference,
} from "@proofstack/core";
import {
  readReleaseMutationAuthentication,
  ReleaseMutationAuthenticator,
  type ReleaseBrowserMutationCredentials,
} from "@proofstack/identity";
import type { PoolClient } from "pg";
import {
  withBoundedPolicyTransaction,
  type PolicyTransactionPool,
} from "./bounded-policy-transaction.js";
import { assertMigrationsCurrentOnClient } from "./migration-runner.js";
import { loadBundledMigrations } from "./migrations.js";
import { assertReleaseInstallerRoleOnClient } from "./release-installer-role.js";
import {
  assertReleaseInstallerSchemaOnClient,
  prepareReleaseInstallerSchema,
} from "./release-installer-schema.js";
import {
  listPostgresReleasePolicyLifecycleEventsForInstallerOnClient,
  readPostgresReleasePolicyForInstallerOnClient,
} from "./postgres-release-policy-repository.js";
import {
  readPostgresReleasePolicySelectionForInstallerOnClient,
  readPostgresReleaseSelectionLifecycleForInstallerOnClient,
} from "./postgres-release-policy-selection-repository.js";

type SourceKind = ReleaseSelectionPublicationMaterial["source"]["kind"];
export interface PostgresReleaseSelectionInstallerResult {
  readonly created: boolean;
  readonly record: ReleaseSelectionPublicationMaterial["source"]["record"];
  readonly publication: ReleaseSelectionPublicationMaterial["publication"];
  readonly usage: {
    readonly records: number;
    readonly recordBytes: number;
    readonly approvalRecords: number;
  };
}
const limits = {
  maxAcquisitionRecords: 10000,
  maxAcquisitionRecordBytes: 16 * 1024 * 1024,
  maxApprovalRecords: 0,
} as const;
export class PostgresReleaseSelectionInstallerError extends Error {
  readonly code = "release_selection_installer_rejected";
  constructor() {
    super("Authenticated selection installation was rejected");
    this.name = "PostgresReleaseSelectionInstallerError";
  }
}
function fail(): never {
  throw new PostgresReleaseSelectionInstallerError();
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
    "SELECT public.proofstack_read_selection_publication_part($1::jsonb,$2,$3,$4) AS value",
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
    operation: "manage_selection",
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
    ? validateReleaseSelectionPublicationMaterial(
        { publication: header["publication"], source, grant, credential },
        budget,
      )
    : prepareReleaseSelectionPublicationMaterial({
        scope,
        source: source as ReleaseSelectionPublicationMaterial["source"],
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
    kind === "release_policy_selection"
      ? await readPostgresReleasePolicySelectionForInstallerOnClient(client, scope, id, budget)
      : await readPostgresReleaseSelectionLifecycleForInstallerOnClient(client, scope, id, budget);
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
        Buffer.from(encodeReleaseSelectionPublicationDefinition({ scope, definition })).toString(
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
 * dedicated role and one bounded guarded connection own source/profile/outbox publication.
 * Returned provenance is historical evidence, never current decision/publication authority.
 */
export class PostgresReleaseSelectionInstaller {
  constructor(
    private readonly pool: PolicyTransactionPool,
    private readonly authentication: ReleaseMutationAuthenticator,
  ) {
    if (!(authentication instanceof ReleaseMutationAuthenticator)) fail();
  }
  publishSelection(
    credentials: ReleaseBrowserMutationCredentials,
    intent: unknown,
  ): Promise<PostgresReleaseSelectionInstallerResult> {
    return this.publish(credentials, intent, "release_policy_selection");
  }
  publishLifecycle(
    credentials: ReleaseBrowserMutationCredentials,
    intent: unknown,
  ): Promise<PostgresReleaseSelectionInstallerResult> {
    return this.publish(credentials, intent, "release_policy_selection_lifecycle");
  }
  private async publish(
    credentials: ReleaseBrowserMutationCredentials,
    raw: unknown,
    kind: SourceKind,
  ) {
    const proof = await this.authentication.authenticateSelectionInstaller(credentials);
    const authenticated = readReleaseMutationAuthentication(proof, {
      operation: "manage_selection",
      scope: credentials.scope,
      requestId: credentials.requestId,
    });
    const actor = ReleaseApprovalReviewerReceiptSchema.parse(authenticated.receipt),
      scope = authenticated.scope;
    const selection =
      kind === "release_policy_selection"
        ? ReleasePolicySelectionDefinitionSchema.parse({
            ...PublishReleasePolicySelectionRequestSchema.parse(raw),
            scope,
            issuerPrincipalId: actor.principalId,
          })
        : null;
    const lifecycle =
      kind === "release_policy_selection_lifecycle"
        ? PublishReleasePolicySelectionLifecycleRequestSchema.parse(raw)
        : null;
    const id = selection?.selectionVersionId ?? lifecycle?.eventId;
    if (!id) fail();
    const migrations = await loadBundledMigrations(),
      budget = new ReleaseDecisionVerificationBudget(limits);
    const expectedSchema = prepareReleaseInstallerSchema(migrations);
    return withBoundedPolicyTransaction(
      this.pool,
      async (client) => {
        try {
          const epoch = await one(
            client,
            budget,
            "SELECT public.proofstack_release_installer_context($1::jsonb) AS value",
            [JSON.stringify(scope)],
          );
          if (typeof epoch !== "string" || !/^[0-9]+$/.test(epoch)) fail();
          await assertMigrationsCurrentOnClient(client, migrations);
          await assertReleaseInstallerSchemaOnClient(client, expectedSchema, budget);
          await assertReleaseInstallerRoleOnClient(client, budget);
          const currentIdentity = await one(
            client,
            budget,
            "SELECT public.proofstack_recheck_release_installer($1::jsonb,$2::jsonb) AS value",
            [JSON.stringify(scope), JSON.stringify(actor)],
          );
          inspectIdentity(currentIdentity, scope, actor, budget);
          const existing = await part(client, scope, kind, id, "header", budget);
          // Exact historical retry retains the original cut. New publications inspect owning policy
          // graphs and complete lifecycle projections before native mutation under the held guards.
          if (existing === null && selection) {
            for (const chosen of selection.policies) {
              const policy = await readPostgresReleasePolicyForInstallerOnClient(
                client,
                scope,
                chosen.policy.policyVersionId,
                budget,
              );
              if (
                !policy ||
                !isDeepStrictEqual(releasePolicyReference(policy), chosen.policy) ||
                policy.mode !== chosen.mode ||
                policy.installationBinding.installationId !== selection.installationId
              )
                fail();
              await listPostgresReleasePolicyLifecycleEventsForInstallerOnClient(
                client,
                scope,
                chosen.policy.policyVersionId,
                budget,
              );
            }
            if (
              selection.predecessor &&
              !(await readMaterial(
                client,
                scope,
                "release_policy_selection",
                selection.predecessor.selectionVersionId,
                budget,
                true,
              ))
            )
              fail();
          }
          if (existing === null && lifecycle) {
            for (const ref of [
              lifecycle.selection,
              ...(lifecycle.kind === "superseded" ? [lifecycle.successor] : []),
            ]) {
              const retained = await readMaterial(
                client,
                scope,
                "release_policy_selection",
                ref.selectionVersionId,
                budget,
                true,
              );
              if (!retained || !isDeepStrictEqual(retained.publication.subject.selection, ref))
                fail();
            }
          }
          const begun = object(
            selection
              ? await one(
                  client,
                  budget,
                  "SELECT public.proofstack_begin_authenticated_selection($1::jsonb,$2::jsonb,$3,$4::jsonb) AS value",
                  [
                    JSON.stringify(scope),
                    JSON.stringify(selection),
                    Buffer.from(
                      encodeReleasePolicySelectionDefinition({ scope, definition: selection }),
                    ).toString("utf8"),
                    JSON.stringify(actor),
                  ],
                )
              : await one(
                  client,
                  budget,
                  "SELECT public.proofstack_begin_authenticated_selection_lifecycle($1::jsonb,$2::jsonb,$3::jsonb) AS value",
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
              "SELECT public.proofstack_finish_selection_publication($1::jsonb,$2,$3,$4::jsonb,$5,$6,$7,$8) AS value",
              [
                JSON.stringify(scope),
                kind,
                id,
                JSON.stringify(material.publication),
                Buffer.from(
                  encodeReleaseSelectionPublicationDefinition({ scope, definition }),
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
