import {
  EvidenceScopeSchema,
  OpaqueIdSchema,
  PolicyEvaluationRecordWitnessSchema,
  PolicyEvaluationTimeSchema,
  RELEASE_EVALUATION_SOURCE_ACTOR_FIELDS,
  ReleaseEvaluationActorSourceSchema,
  serializeEvaluationCanonicalJson,
  type EvidenceScope,
  type PolicyEvaluationRecordWitness,
  type ReleaseEvaluationActorSource,
  type ReleaseEvaluationSourceActor,
} from "@proofstack/contracts";
import {
  ReleaseDecisionVerificationBudgetError,
  type ReleaseDecisionVerificationBudget,
} from "@proofstack/core";
import {
  inspectRetainedPolicyRecord,
  type PolicyRecordContext,
} from "./retained-record-routing.js";

export class InvalidOriginalSourceActorsError extends Error {
  readonly code = "original_source_actors_invalid";
  constructor(options?: ErrorOptions) {
    super("Invalid exact original source actor inspection", options);
    this.name = "InvalidOriginalSourceActorsError";
  }
}
function principalAt(record: unknown, field: string): string {
  let current = record;
  for (const part of field.split("/").slice(1)) {
    if (
      !current ||
      typeof current !== "object" ||
      Array.isArray(current) ||
      !Object.hasOwn(current, part)
    )
      throw new InvalidOriginalSourceActorsError();
    current = Reflect.get(current, part);
  }
  return OpaqueIdSchema.parse(current);
}

/** Replay storage contains the complete owning job history, not one synthetic result row. */
function normalizedRecords(kind: string, body: unknown): number {
  if (kind !== "replay_result" || !body || typeof body !== "object") return 1;
  let count = Reflect.get(body, "cancellationRequest") == null ? 1 : 2;
  for (const key of [
    "attempts",
    "budgetLedger",
    "cancellationAcknowledgements",
    "executionObservations",
    "usageObservations",
  ]) {
    const rows: unknown = Reflect.get(body, key);
    if (Array.isArray(rows)) count += rows.length;
  }
  return count;
}

/**
 * Fixed owning reinspection at the ORIGINAL semantic cut, not a supplied actor extractor or current
 * authority report. Full original storage SHA/receipt, not just definition SHA, binds receipt actors.
 * No repository/content/key I/O is performed; the owning composer supplies one bounded raw read.
 */
export function inspectOriginalSourceActors(input: {
  readonly scope: EvidenceScope;
  readonly evaluationTime: string;
  readonly witness: PolicyEvaluationRecordWitness;
  readonly body: unknown;
  readonly replayLimits: NonNullable<PolicyRecordContext["replayLimits"]>;
  readonly budget: ReleaseDecisionVerificationBudget;
}): ReleaseEvaluationActorSource {
  try {
    const scope = EvidenceScopeSchema.parse(input.scope);
    const evaluationTime = PolicyEvaluationTimeSchema.parse(input.evaluationTime);
    const witness = PolicyEvaluationRecordWitnessSchema.parse(input.witness);
    const body = input.body;
    input.budget.observe(
      { source: witness.entry.source, body },
      "metadata",
      normalizedRecords(witness.entry.source.kind, body),
    );
    const unavailable = (
      reason: Extract<ReleaseEvaluationActorSource, { state: "unavailable" }>["reason"],
    ) => ReleaseEvaluationActorSourceSchema.parse({ state: "unavailable", witness, reason });
    if (witness.storage === null) return unavailable("original_body_unavailable");
    const retained = inspectRetainedPolicyRecord(
      { scope, evaluationTime, source: witness.entry.source, replayLimits: input.replayLimits },
      body,
    );
    if (!retained || retained.storage === null) return unavailable("owning_source_unavailable");
    const storage = retained.storage;
    if (
      retained.storage.recordSha256 !== witness.storage.recordSha256 ||
      retained.storage.receiptTime !== witness.storage.receiptTime ||
      serializeEvaluationCanonicalJson(retained.read.source) !==
        serializeEvaluationCanonicalJson(witness.entry.source) ||
      serializeEvaluationCanonicalJson(retained.read.observation) !==
        serializeEvaluationCanonicalJson(witness.entry.observation)
    )
      return unavailable("original_body_mismatch");
    const actors: ReleaseEvaluationSourceActor[] = RELEASE_EVALUATION_SOURCE_ACTOR_FIELDS[
      witness.entry.source.kind
    ].map(({ field, role }) => ({
      field,
      role,
      principalId: principalAt(storage.record, field),
    }));
    return ReleaseEvaluationActorSourceSchema.parse({ state: "observed", witness, actors });
  } catch (cause) {
    if (
      cause instanceof InvalidOriginalSourceActorsError ||
      cause instanceof ReleaseDecisionVerificationBudgetError
    )
      throw cause;
    throw new InvalidOriginalSourceActorsError({ cause });
  }
}
