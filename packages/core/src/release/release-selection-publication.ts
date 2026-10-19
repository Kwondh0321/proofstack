import { createHash } from "node:crypto";
import {
  encodeEvaluationCanonicalJson,
  encodeReleaseSelectionPublicationDefinition,
  ReleaseSelectionPublicationDefinitionSchema,
  ReleaseSelectionPublicationMaterialSchema,
  ReleaseSelectionPublicationSchema,
  serializeEvaluationCanonicalJson,
  type EvidenceScope,
  type ReleaseApprovalReviewerReceipt,
  type ReleaseDecisionIdentityGrant,
  type ReleaseDecisionSessionState,
  type ReleaseSelectionPublicationDefinition,
  type ReleaseSelectionPublicationMaterial,
} from "@proofstack/contracts";
import { inspectCapturedReleaseIdentityState } from "./captured-release-identity-state.js";
import {
  releasePolicySelectionReference,
  validateReleasePolicySelectionRecord,
} from "./release-authority-record-validation.js";
import { ReleaseDecisionVerificationBudget } from "./release-decision-verification-budget.js";

export class InvalidReleaseSelectionPublicationError extends Error {
  readonly code = "release_selection_publication_invalid";
  constructor(
    readonly reason:
      | "record_invalid"
      | "profile_mismatch"
      | "source_binding"
      | "identity_ineligible",
  ) {
    super(`Original selection publication was rejected: ${reason}`);
    this.name = "InvalidReleaseSelectionPublicationError";
  }
}
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const same = (a: unknown, b: unknown) =>
  serializeEvaluationCanonicalJson(a) === serializeEvaluationCanonicalJson(b);
export const digestReleaseSelectionPublicationRecord = (record: unknown): string =>
  hash(encodeEvaluationCanonicalJson(record));
export const digestReleaseSelectionPublicationDefinition = (
  scope: EvidenceScope,
  definition: ReleaseSelectionPublicationDefinition,
): string => hash(encodeReleaseSelectionPublicationDefinition({ scope, definition }));

/** Original safe preimages and eligibility at their original cut only. Not actual authentication,
 * current grants, owning native reads or a reusable publication seal. Use the original meter.
 */
export function validateReleaseSelectionPublicationMaterial(
  raw: unknown,
  budget: ReleaseDecisionVerificationBudget,
): ReleaseSelectionPublicationMaterial {
  if (!(budget instanceof ReleaseDecisionVerificationBudget))
    throw new InvalidReleaseSelectionPublicationError("record_invalid");
  budget.snapshot();
  try {
    budget.observe(raw, "metadata", 4);
    const value = ReleaseSelectionPublicationMaterialSchema.parse(raw);
    const { publication: profile, source, grant, credential } = value;
    const { definitionSha256, schemaVersion: _version, ...definition } = profile;
    const fail = (reason: InvalidReleaseSelectionPublicationError["reason"]): never => {
      throw new InvalidReleaseSelectionPublicationError(reason);
    };
    if (
      digestReleaseSelectionPublicationDefinition(profile.scope, definition) !== definitionSha256 ||
      digestReleaseSelectionPublicationRecord(source.record) !== profile.subject.recordSha256 ||
      digestReleaseSelectionPublicationRecord(grant) !== profile.grantSha256 ||
      digestReleaseSelectionPublicationRecord(credential) !== profile.credentialSha256
    )
      fail("profile_mismatch");
    if (!same(profile.scope, source.record.scope) || !same(grant.identity, profile.identity))
      fail("source_binding");
    if (
      source.kind === "release_policy_selection" &&
      profile.subject.kind === "release_policy_selection"
    ) {
      validateReleasePolicySelectionRecord({
        expected: { scope: profile.scope, reference: profile.subject.selection },
        record: source.record,
      });
      if (
        source.record.publishedAt !== profile.issuedAt ||
        source.record.publishedByPrincipalId !== profile.actor.principalId
      )
        fail("source_binding");
    } else if (
      source.kind === "release_policy_selection_lifecycle" &&
      profile.subject.kind === "release_policy_selection_lifecycle"
    ) {
      if (
        source.record.eventId !== profile.subject.eventId ||
        !same(source.record.selection, profile.subject.selection) ||
        source.record.occurredAt !== profile.issuedAt ||
        source.record.actorPrincipalId !== profile.actor.principalId
      )
        fail("source_binding");
    } else fail("source_binding");
    const eligible = inspectCapturedReleaseIdentityState({
      scope: profile.scope,
      receipt: profile.actor,
      identity: profile.identity,
      grant: { state: "observed", reference: profile.identity, record: grant },
      credential: {
        state: "observed",
        reference: {
          kind: "oidc_session",
          principalId: profile.actor.principalId,
          credentialId: profile.actor.credentialId,
        },
        record: credential,
      },
      capturedAt: profile.issuedAt,
      operation: "manage_selection",
      budget,
    });
    if (eligible.state !== "eligible") fail("identity_ineligible");
    return value;
  } catch (cause) {
    return budget.rejectSourceRead(
      cause instanceof InvalidReleaseSelectionPublicationError
        ? cause
        : new InvalidReleaseSelectionPublicationError("record_invalid"),
    );
  }
}

/** Internal construction from already acquired native preimages. This function does not
 * authenticate a caller, acquire a guard, select current records or publish anything.
 */
export function prepareReleaseSelectionPublicationMaterial(input: {
  readonly scope: EvidenceScope;
  readonly source: ReleaseSelectionPublicationMaterial["source"];
  readonly actor: ReleaseApprovalReviewerReceipt;
  readonly identity: ReleaseSelectionPublicationDefinition["identity"];
  readonly grant: ReleaseDecisionIdentityGrant;
  readonly credential: ReleaseDecisionSessionState;
  readonly issuedAt: string;
  readonly budget: ReleaseDecisionVerificationBudget;
}): ReleaseSelectionPublicationMaterial {
  if (!(input.budget instanceof ReleaseDecisionVerificationBudget))
    throw new InvalidReleaseSelectionPublicationError("record_invalid");
  input.budget.snapshot();
  try {
    const { budget: _budget, ...observed } = input;
    input.budget.observe(observed, "metadata", 4);
    const { source } = input;
    const selection =
      source.kind === "release_policy_selection"
        ? releasePolicySelectionReference(source.record)
        : source.record.selection;
    const recordSha256 = digestReleaseSelectionPublicationRecord(source.record);
    const definition = ReleaseSelectionPublicationDefinitionSchema.parse({
      scope: input.scope,
      subject:
        source.kind === "release_policy_selection"
          ? { kind: source.kind, selection, recordSha256 }
          : { kind: source.kind, selection, recordSha256, eventId: source.record.eventId },
      operation: "manage_selection",
      actor: input.actor,
      identity: input.identity,
      grantSha256: digestReleaseSelectionPublicationRecord(input.grant),
      credentialSha256: digestReleaseSelectionPublicationRecord(input.credential),
      issuedAt: input.issuedAt,
    });
    return validateReleaseSelectionPublicationMaterial(
      {
        publication: ReleaseSelectionPublicationSchema.parse({
          ...definition,
          schemaVersion: "0.1",
          definitionSha256: digestReleaseSelectionPublicationDefinition(input.scope, definition),
        }),
        source,
        grant: input.grant,
        credential: input.credential,
      },
      input.budget,
    );
  } catch (cause) {
    return input.budget.rejectSourceRead(
      cause instanceof InvalidReleaseSelectionPublicationError
        ? cause
        : new InvalidReleaseSelectionPublicationError("record_invalid"),
    );
  }
}
