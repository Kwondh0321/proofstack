import {
  ReleaseEvaluationActorProvenanceSchema,
  RELEASE_EVALUATION_SOURCE_ACTOR_FIELDS,
  serializeEvaluationCanonicalJson,
  policyEvaluationSourceReferenceKey,
  type ReleaseEvaluationActorProvenance,
  type ReleaseEvaluationActorSource,
} from "@proofstack/contracts";
import {
  inspectOwnedPolicyEvaluation,
  type ReleaseDecisionVerificationBudget,
} from "@proofstack/core";
import { inspectOriginalSourceActors } from "./inspect-original-source-actors.js";
import { readAndExpandPolicyRecord, type PolicyRecordGraphRepositories } from "./record-routing.js";

/**
 * Original graph input must be loaded by the server's exact owning request/job selector, never
 * accepted from a decision HTTP caller. Reinspect every original full-body witness through fixed
 * installed readers. This historical acquisition returns no current authority or publication port.
 */
export async function captureOriginalEvaluationActors(input: {
  readonly original: Omit<Parameters<typeof inspectOwnedPolicyEvaluation>[0], "budget">;
  readonly records: PolicyRecordGraphRepositories;
  readonly budget: ReleaseDecisionVerificationBudget;
}): Promise<ReleaseEvaluationActorProvenance> {
  const original = inspectOwnedPolicyEvaluation({ ...input.original, budget: input.budget });
  const request = original.request;
  const replayLimits = {
    maximumRecords: request.limits.maxAcquisitionRecords,
    maximumRecordBytes: request.limits.maxAcquisitionRecordBytes,
  };
  const limits = {
    maxReferences: request.limits.maxAcquisitionRecords,
    maxReferenceBytes: request.limits.maxAcquisitionRecordBytes,
  };
  const sources: ReleaseEvaluationActorSource[] = [];
  for (const witness of original.originalSourceWitnesses) {
    const source = witness.entry.source;
    let body: unknown = null;
    if (
      witness.storage !== null &&
      source.kind === "release_candidate" &&
      serializeEvaluationCanonicalJson(source.reference) ===
        serializeEvaluationCanonicalJson(request.candidate)
    ) {
      body = original.candidate;
    } else if (
      witness.storage !== null &&
      source.kind === "release_policy" &&
      serializeEvaluationCanonicalJson(source.reference) ===
        serializeEvaluationCanonicalJson(request.policy)
    ) {
      body = original.policy;
    } else if (witness.storage !== null) {
      // An attempt consumes admission before I/O, even if its owning port rejects or throws.
      // The owning fixture route checks both immutable fixture formats, including missing rows.
      input.budget.observe(
        { kind: "original_actor_read_attempt", source },
        "metadata",
        source.kind === "regression_fixture_version" ? 2 : 1,
      );
      try {
        const captured = await readAndExpandPolicyRecord(
          { scope: request.scope, evaluationTime: request.evaluationTime, source },
          input.records,
          limits,
          replayLimits,
        );
        body = captured.storage?.record ?? null;
      } catch (cause) {
        input.budget.rejectSourceRead(cause);
      }
    }
    // An absent original has no retained full SHA. Never query a newly created/latest body for it.
    sources.push(
      inspectOriginalSourceActors({
        scope: request.scope,
        evaluationTime: request.evaluationTime,
        witness,
        body,
        replayLimits,
        budget: input.budget,
      }),
    );
  }
  sources.sort((a, b) => {
    const left = policyEvaluationSourceReferenceKey(a.witness.entry.source),
      right = policyEvaluationSourceReferenceKey(b.witness.entry.source);
    return left < right ? -1 : left > right ? 1 : 0;
  });
  const evaluatorPrincipalIds = new Set([original.evaluation.recordedByPrincipalId]);
  // The strict contract independently derives both completeness states and the exact actor set.
  for (const source of sources) {
    if (source.state === "observed") {
      for (const actor of source.actors)
        if (actor.role === "evaluation_actor") evaluatorPrincipalIds.add(actor.principalId);
    }
  }
  // Missing non-evaluator records do not invent unknown execution actors. The source-state still
  // retains their unavailability separately; this does not establish complete current authority.
  const evaluationActorsComplete = sources.every(
    (source) =>
      source.state === "observed" ||
      !RELEASE_EVALUATION_SOURCE_ACTOR_FIELDS[source.witness.entry.source.kind].some(
        ({ role }) => role === "evaluation_actor",
      ),
  );
  return ReleaseEvaluationActorProvenanceSchema.parse({
    schemaVersion: "0.1",
    authorityBoundary: "original_evaluation_actors_only",
    scope: request.scope,
    original: {
      request: original.job.request,
      jobId: original.job.jobId,
      snapshot: original.evaluation.snapshot,
      evaluation: {
        evaluationId: original.evaluation.evaluationId,
        definitionSha256: original.evaluation.definitionSha256,
      },
      evaluationTime: request.evaluationTime,
      evaluatorPrincipalId: original.evaluation.recordedByPrincipalId,
      requesterPrincipalId: request.createdByPrincipalId,
    },
    candidate: {
      reference: request.candidate,
      authorPrincipalId: original.candidate.createdByPrincipalId,
    },
    policy: {
      reference: request.policy,
      authorPrincipalId: original.policy.publishedByPrincipalId,
    },
    sources,
    sourceState: sources.every(({ state }) => state === "observed") ? "complete" : "unavailable",
    evaluationActorState: evaluationActorsComplete ? "complete" : "unavailable",
    evaluatorPrincipalIds: [...evaluatorPrincipalIds].sort(),
  });
}
