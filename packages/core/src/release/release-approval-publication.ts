import { createHash } from "node:crypto";
import {
  encodeEvaluationCanonicalJson,
  encodeReleaseApprovalPublicationDefinition,
  ReleaseApprovalPublicationDefinitionSchema,
  ReleaseApprovalPublicationMaterialSchema,
  ReleaseApprovalPublicationSchema,
  serializeEvaluationCanonicalJson,
  type EvidenceScope,
  type ReleaseApprovalReviewerReceipt,
  type ReleaseDecisionIdentityGrant,
  type ReleaseDecisionSessionState,
  type ReleaseApprovalPublicationDefinition,
  type ReleaseApprovalPublicationMaterial,
} from "@proofstack/contracts";
import { inspectCapturedReleaseIdentityState } from "./captured-release-identity-state.js";
import {
  releaseApprovalReference,
  validateReleaseApprovalRecord,
} from "./release-authority-record-validation.js";
import { ReleaseDecisionVerificationBudget } from "./release-decision-verification-budget.js";

export class InvalidReleaseApprovalPublicationError extends Error {
  readonly code = "release_approval_publication_invalid";
  constructor(
    readonly reason:
      | "record_invalid"
      | "profile_mismatch"
      | "source_binding"
      | "identity_ineligible",
  ) {
    super(`Original approval publication was rejected: ${reason}`);
    this.name = "InvalidReleaseApprovalPublicationError";
  }
}
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const same = (a: unknown, b: unknown) =>
  serializeEvaluationCanonicalJson(a) === serializeEvaluationCanonicalJson(b);
export const digestReleaseApprovalPublicationRecord = (record: unknown): string =>
  hash(encodeEvaluationCanonicalJson(record));
export const digestReleaseApprovalPublicationDefinition = (
  scope: EvidenceScope,
  definition: ReleaseApprovalPublicationDefinition,
): string => hash(encodeReleaseApprovalPublicationDefinition({ scope, definition }));

/** Original bytes and identity eligibility at their original cut only. No authentication, reviewer
 * expertise, current basis content, quorum or reusable release publication authority.
 */
export function validateReleaseApprovalPublicationMaterial(
  raw: unknown,
  budget: ReleaseDecisionVerificationBudget,
): ReleaseApprovalPublicationMaterial {
  if (!(budget instanceof ReleaseDecisionVerificationBudget))
    throw new InvalidReleaseApprovalPublicationError("record_invalid");
  budget.snapshot();
  try {
    budget.observe(raw, "metadata", 4);
    const value = ReleaseApprovalPublicationMaterialSchema.parse(raw);
    const { publication: profile, source, grant, credential } = value;
    if (source.kind === "release_approval") budget.observe(source.record, "approval");
    const { definitionSha256, schemaVersion: _version, ...definition } = profile;
    const fail = (reason: InvalidReleaseApprovalPublicationError["reason"]): never => {
      throw new InvalidReleaseApprovalPublicationError(reason);
    };
    if (
      digestReleaseApprovalPublicationDefinition(profile.scope, definition) !== definitionSha256 ||
      digestReleaseApprovalPublicationRecord(source.record) !== profile.subject.recordSha256 ||
      digestReleaseApprovalPublicationRecord(grant) !== profile.grantSha256 ||
      digestReleaseApprovalPublicationRecord(credential) !== profile.credentialSha256
    )
      fail("profile_mismatch");
    if (
      !same(
        profile.scope,
        source.kind === "release_approval" ? source.record.subject.scope : source.record.scope,
      ) ||
      !same(grant.identity, profile.identity) ||
      !same(profile.actor, source.record.reviewer)
    )
      fail("source_binding");
    if (source.kind === "release_approval" && profile.subject.kind === "release_approval") {
      validateReleaseApprovalRecord({
        expected: { scope: profile.scope, reference: profile.subject.approval },
        record: source.record,
      });
      if (source.record.recordedAt !== profile.issuedAt) fail("source_binding");
    } else if (
      source.kind === "release_approval_revocation" &&
      profile.subject.kind === "release_approval_revocation"
    ) {
      if (
        source.record.eventId !== profile.subject.eventId ||
        !same(source.record.approval, profile.subject.approval) ||
        source.record.occurredAt !== profile.issuedAt
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
      operation: "create_approval",
      budget,
    });
    if (eligible.state !== "eligible") fail("identity_ineligible");
    return value;
  } catch (cause) {
    return budget.rejectSourceRead(
      cause instanceof InvalidReleaseApprovalPublicationError
        ? cause
        : new InvalidReleaseApprovalPublicationError("record_invalid"),
    );
  }
}

/** Internal construction from acquired original preimages; not an authenticator or publisher. */
export function prepareReleaseApprovalPublicationMaterial(input: {
  readonly scope: EvidenceScope;
  readonly source: ReleaseApprovalPublicationMaterial["source"];
  readonly actor: ReleaseApprovalReviewerReceipt;
  readonly identity: ReleaseApprovalPublicationDefinition["identity"];
  readonly grant: ReleaseDecisionIdentityGrant;
  readonly credential: ReleaseDecisionSessionState;
  readonly issuedAt: string;
  readonly budget: ReleaseDecisionVerificationBudget;
}): ReleaseApprovalPublicationMaterial {
  if (!(input.budget instanceof ReleaseDecisionVerificationBudget))
    throw new InvalidReleaseApprovalPublicationError("record_invalid");
  input.budget.snapshot();
  try {
    const { budget: _budget, ...observed } = input;
    input.budget.observe(observed, "metadata", 4);
    const source = input.source;
    const approval =
      source.kind === "release_approval"
        ? releaseApprovalReference(source.record)
        : source.record.approval;
    const recordSha256 = digestReleaseApprovalPublicationRecord(source.record);
    const definition = ReleaseApprovalPublicationDefinitionSchema.parse({
      scope: input.scope,
      subject:
        source.kind === "release_approval"
          ? { kind: source.kind, approval, recordSha256 }
          : { kind: source.kind, approval, recordSha256, eventId: source.record.eventId },
      operation: "record_approval",
      actor: input.actor,
      identity: input.identity,
      grantSha256: digestReleaseApprovalPublicationRecord(input.grant),
      credentialSha256: digestReleaseApprovalPublicationRecord(input.credential),
      issuedAt: input.issuedAt,
    });
    return validateReleaseApprovalPublicationMaterial(
      {
        publication: ReleaseApprovalPublicationSchema.parse({
          ...definition,
          schemaVersion: "0.1",
          definitionSha256: digestReleaseApprovalPublicationDefinition(input.scope, definition),
        }),
        source,
        grant: input.grant,
        credential: input.credential,
      },
      input.budget,
    );
  } catch (cause) {
    return input.budget.rejectSourceRead(
      cause instanceof InvalidReleaseApprovalPublicationError
        ? cause
        : new InvalidReleaseApprovalPublicationError("record_invalid"),
    );
  }
}
