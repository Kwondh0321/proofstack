#!/usr/bin/env python3
"""Independent finite decision-table oracle; no ProofStack runtime imports or authority claims."""
import hashlib
import itertools
import json

POLICY_STATES = ["active", "not_effective", "expired", "withdrawn", "superseded", "authority_unavailable"]
REVIEW_STATES = ["unavailable", "insufficient", "conditions_unresolved", "conflicted", "opposed", "escalated", "matched"]
APPLICABILITY = ["match", "mismatch", "unknown"]
CANDIDATE_AUTHORITY = ["qualified", "unqualified", "unavailable"]
PREDICATES = ["comparison_threshold", "coverage_floor", "uncertainty_bound", "eligibility_required", "artifact_required", "safety_event_ceiling", "approval_required"]
OUTCOMES = ["satisfied", "violated", "indeterminate", "not_applicable"]


def expected(predicate, outcome, original, current, candidate_authority, applicability, normal, exception, non_waivable):
    approval_rule = predicate == "approval_required"
    usable = original == current == "active" and candidate_authority == "qualified" and applicability == "match" and outcome != "not_applicable"
    known_violation = usable and not approval_rule and outcome == "violated"
    resolved = usable and ((approval_rule and normal == "matched") or
                           (not approval_rule and outcome == "satisfied") or
                           (known_violation and not non_waivable and exception == "matched"))
    status = "non_waivable_violation" if known_violation and non_waivable else "satisfied" if resolved else "unresolved"
    # Ordered diagnostic precedence from the protocol; original evidence remains separately retained.
    diagnostics = [
        (original != "active", "original_policy_unavailable"),
        (current != "active", "current_policy_unavailable"),
        (candidate_authority != "qualified", "candidate_authority_unverified"),
        (applicability == "mismatch" or outcome == "not_applicable", "policy_inapplicable"),
        (applicability == "unknown", "policy_applicability_unknown"),
        (approval_rule and normal == "opposed", "review_opposed"),
        (approval_rule and normal == "escalated", "review_escalated"),
        (approval_rule and normal == "matched", "normal_approval_applied"),
        (approval_rule, "normal_approval_unavailable"),
        (outcome == "satisfied", "evaluation_satisfied"),
        (outcome == "indeterminate", "evidence_indeterminate"),
        (non_waivable, "non_waivable_violation"),
        (exception == "opposed", "review_opposed"),
        (exception == "escalated", "review_escalated"),
        (exception == "matched", "scoped_exception_applied"),
        (True, "exception_unavailable"),
    ]
    return status, next(reason for matches, reason in diagnostics if matches)


def document():
    vectors = []
    for predicate in PREDICATES:
        for outcome in OUTCOMES:
            if predicate == "approval_required" and outcome != "indeterminate":
                continue
            digest = hashlib.sha256()
            counts = {}
            cases = 0
            for original, current, candidate_authority, applicability, normal, exception, non_waivable in itertools.product(
                    POLICY_STATES, POLICY_STATES, CANDIDATE_AUTHORITY, APPLICABILITY, REVIEW_STATES, REVIEW_STATES, [False, True]):
                status, reason = expected(predicate, outcome, original, current, candidate_authority, applicability, normal, exception, non_waivable)
                digest.update(f"{cases}|{status}|{reason}|{outcome}\n".encode("utf-8"))
                counts[status] = counts.get(status, 0) + 1
                cases += 1
            vectors.append({"predicateKind": predicate, "originalOutcome": outcome,
                            "cases": cases, "classificationCounts": counts, "sha256": digest.hexdigest()})
    return {"format": "proofstack.release-rule-decision-table-oracle.v1",
            "basis": "Independent Python boolean satisfaction/violation formula and ordered normative diagnostics; synthetic observations, not current authority",
            "policyStates": POLICY_STATES, "reviewStates": REVIEW_STATES,
            "applicability": APPLICABILITY, "candidateAuthority": CANDIDATE_AUTHORITY, "nonWaivable": [False, True], "vectors": vectors}


if __name__ == "__main__":
    print(json.dumps(document(), ensure_ascii=False, indent=2))
