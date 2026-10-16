import { ReleasePolicySelectionSchema } from "@proofstack/contracts";
import { validateReleasePolicyRecord } from "../policy/release-policy-record-validation.js";
import { validateReleaseCandidateRecord } from "./release-candidate-record-validation.js";
import {
  releasePolicySelectionReference,
  validateReleasePolicySelectionRecord,
} from "./release-authority-record-validation.js";
import { validateReleaseDecisionInputBindings } from "./release-decision-input-validation.js";
import {
  ReleaseDecisionInputRepositoryError,
  type ReleaseDecisionInputGraph,
} from "./release-decision-input-repository.js";

/** Complete original integrity only. No current lifecycle, authentication or external job lookup. */
export function validateReleaseDecisionInputGraph(raw: unknown): ReleaseDecisionInputGraph {
  try {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new TypeError("Invalid original input graph");
    const value = raw as Record<string, unknown>;
    if (
      Object.keys(value).length !== 4 ||
      !["request", "candidate", "selection", "policies"].every((key) =>
        Object.hasOwn(value, key),
      ) ||
      !Array.isArray(value["policies"])
    )
      throw new TypeError("Incomplete original input graph");
    const request = validateReleaseDecisionInputBindings({
      request: value["request"],
      candidate: value["candidate"],
      selection: value["selection"],
      policies: value["policies"],
    });
    const candidate = validateReleaseCandidateRecord(value["candidate"]);
    const parsed = ReleasePolicySelectionSchema.parse(value["selection"]);
    const selection = validateReleasePolicySelectionRecord({
      expected: { scope: request.scope, reference: releasePolicySelectionReference(parsed) },
      record: parsed,
    });
    const policies = value["policies"].map(validateReleasePolicyRecord);
    return { request, candidate, selection, policies };
  } catch (cause) {
    throw new ReleaseDecisionInputRepositoryError("storage_invalid", { cause });
  }
}
