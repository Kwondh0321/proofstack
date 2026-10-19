import { createHash } from "node:crypto";
import {
  encodeEvaluationCanonicalJson,
  encodeReleaseReviewerPublicationDefinition,
  ReleaseReviewerPublicationDefinitionSchema,
  ReleaseReviewerPublicationMaterialSchema,
  ReleaseReviewerPublicationSchema,
  serializeEvaluationCanonicalJson,
  type EvidenceScope,
  type ReleaseApprovalReviewerReceipt,
  type ReleaseDecisionIdentityGrant,
  type ReleaseDecisionSessionState,
  type ReleaseReviewerPublicationDefinition,
  type ReleaseReviewerPublicationMaterial,
} from "@proofstack/contracts";
import { inspectCapturedReleaseIdentityState } from "./captured-release-identity-state.js";
import {
  releaseReviewerAuthorityReference,
  validateReleaseReviewerAuthorityRecord,
} from "./release-authority-record-validation.js";
import { ReleaseDecisionVerificationBudget } from "./release-decision-verification-budget.js";

export class InvalidReleaseReviewerPublicationError extends Error {
  readonly code = "release_reviewer_publication_invalid";
  constructor(
    readonly reason:
      | "record_invalid"
      | "profile_mismatch"
      | "source_binding"
      | "identity_ineligible",
  ) {
    super(`Original reviewer administration publication was rejected: ${reason}`);
    this.name = "InvalidReleaseReviewerPublicationError";
  }
}
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const same = (a: unknown, b: unknown) =>
  serializeEvaluationCanonicalJson(a) === serializeEvaluationCanonicalJson(b);
export const digestReleaseReviewerPublicationRecord = (record: unknown): string =>
  hash(encodeEvaluationCanonicalJson(record));
export const digestReleaseReviewerPublicationDefinition = (
  scope: EvidenceScope,
  definition: ReleaseReviewerPublicationDefinition,
): string => hash(encodeReleaseReviewerPublicationDefinition({ scope, definition }));

/** Original bytes and eligibility at their original cut only. No authentication, expertise,
 * current basis content, owning source acquisition, approval or reusable publication authority.
 */
export function validateReleaseReviewerPublicationMaterial(
  raw: unknown,
  budget: ReleaseDecisionVerificationBudget,
): ReleaseReviewerPublicationMaterial {
  if (!(budget instanceof ReleaseDecisionVerificationBudget))
    throw new InvalidReleaseReviewerPublicationError("record_invalid");
  budget.snapshot();
  try {
    budget.observe(raw, "metadata", 4);
    const value = ReleaseReviewerPublicationMaterialSchema.parse(raw);
    const { publication: profile, source, grant, credential } = value;
    const { definitionSha256, schemaVersion: _version, ...definition } = profile;
    const fail = (reason: InvalidReleaseReviewerPublicationError["reason"]): never => {
      throw new InvalidReleaseReviewerPublicationError(reason);
    };
    if (
      digestReleaseReviewerPublicationDefinition(profile.scope, definition) !== definitionSha256 ||
      digestReleaseReviewerPublicationRecord(source.record) !== profile.subject.recordSha256 ||
      digestReleaseReviewerPublicationRecord(grant) !== profile.grantSha256 ||
      digestReleaseReviewerPublicationRecord(credential) !== profile.credentialSha256
    )
      fail("profile_mismatch");
    if (!same(profile.scope, source.record.scope) || !same(grant.identity, profile.identity))
      fail("source_binding");
    if (
      source.kind === "release_reviewer_authority" &&
      profile.subject.kind === "release_reviewer_authority"
    ) {
      validateReleaseReviewerAuthorityRecord({
        expected: { scope: profile.scope, reference: profile.subject.authority },
        record: source.record,
      });
      if (
        source.record.publishedAt !== profile.issuedAt ||
        source.record.publishedByPrincipalId !== profile.actor.principalId
      )
        fail("source_binding");
    } else if (
      source.kind === "release_reviewer_authority_lifecycle" &&
      profile.subject.kind === "release_reviewer_authority_lifecycle"
    ) {
      if (
        source.record.eventId !== profile.subject.eventId ||
        !same(source.record.authority, profile.subject.authority) ||
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
      operation: "manage_reviewer_authority",
      budget,
    });
    if (eligible.state !== "eligible") fail("identity_ineligible");
    return value;
  } catch (cause) {
    return budget.rejectSourceRead(
      cause instanceof InvalidReleaseReviewerPublicationError
        ? cause
        : new InvalidReleaseReviewerPublicationError("record_invalid"),
    );
  }
}

/** Internal construction from acquired original preimages; not an authenticator or publisher. */
export function prepareReleaseReviewerPublicationMaterial(input: {
  readonly scope: EvidenceScope;
  readonly source: ReleaseReviewerPublicationMaterial["source"];
  readonly actor: ReleaseApprovalReviewerReceipt;
  readonly identity: ReleaseReviewerPublicationDefinition["identity"];
  readonly grant: ReleaseDecisionIdentityGrant;
  readonly credential: ReleaseDecisionSessionState;
  readonly issuedAt: string;
  readonly budget: ReleaseDecisionVerificationBudget;
}): ReleaseReviewerPublicationMaterial {
  if (!(input.budget instanceof ReleaseDecisionVerificationBudget))
    throw new InvalidReleaseReviewerPublicationError("record_invalid");
  input.budget.snapshot();
  try {
    const { budget: _budget, ...observed } = input;
    input.budget.observe(observed, "metadata", 4);
    const source = input.source;
    const authority =
      source.kind === "release_reviewer_authority"
        ? releaseReviewerAuthorityReference(source.record)
        : source.record.authority;
    const recordSha256 = digestReleaseReviewerPublicationRecord(source.record);
    const definition = ReleaseReviewerPublicationDefinitionSchema.parse({
      scope: input.scope,
      subject:
        source.kind === "release_reviewer_authority"
          ? { kind: source.kind, authority, recordSha256 }
          : { kind: source.kind, authority, recordSha256, eventId: source.record.eventId },
      operation: "manage_reviewer_authority",
      actor: input.actor,
      identity: input.identity,
      grantSha256: digestReleaseReviewerPublicationRecord(input.grant),
      credentialSha256: digestReleaseReviewerPublicationRecord(input.credential),
      issuedAt: input.issuedAt,
    });
    return validateReleaseReviewerPublicationMaterial(
      {
        publication: ReleaseReviewerPublicationSchema.parse({
          ...definition,
          schemaVersion: "0.1",
          definitionSha256: digestReleaseReviewerPublicationDefinition(input.scope, definition),
        }),
        source,
        grant: input.grant,
        credential: input.credential,
      },
      input.budget,
    );
  } catch (cause) {
    return input.budget.rejectSourceRead(
      cause instanceof InvalidReleaseReviewerPublicationError
        ? cause
        : new InvalidReleaseReviewerPublicationError("record_invalid"),
    );
  }
}
