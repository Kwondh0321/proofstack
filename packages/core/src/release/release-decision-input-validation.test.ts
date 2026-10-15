import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  encodePolicyEvaluationRequestDefinition,
  encodeReleasePolicySelectionDefinition,
  type ReleasePolicy,
  ReleasePolicyDefinitionSchema,
  ReleasePolicySelectionDefinitionSchema,
  ReleaseDecisionInputDefinitionSchema,
} from "@proofstack/contracts";
import { describe, expect, it } from "vitest";
import { digestReleasePolicyDefinition } from "../policy/release-policy-record-validation.js";
import { releaseCandidateFixture } from "../testing/release-candidate-repository-fixtures.js";
import { releasePolicyRepositoryFixture } from "../testing/release-policy-repository-fixtures.js";
import { releaseCandidateReference } from "./release-candidate-record-validation.js";
import {
  digestReleaseDecisionInputDefinition,
  InvalidReleaseDecisionInputError,
  validateReleaseDecisionInputBindings,
} from "./release-decision-input-validation.js";

function vector(name: string): unknown {
  const doc = JSON.parse(
    readFileSync(
      new URL(`../../../contracts/vectors/${name}-definition-v1.json`, import.meta.url),
      "utf8",
    ),
  ) as { vectors: { input: { definition: unknown } }[] };
  return structuredClone(doc.vectors[0]?.input.definition);
}
function sha(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}
function policyReference(policy: ReleasePolicy) {
  return {
    policyId: policy.policyId,
    policyVersionId: policy.policyVersionId,
    definitionSha256: policy.definitionSha256,
  };
}
function replacePolicyMode(policy: ReleasePolicy, mode: "advisory" | "mandatory"): ReleasePolicy {
  const {
    definitionSha256: _digest,
    schemaVersion: _version,
    publishedAt: _at,
    publishedByPrincipalId: _publisher,
    scope: _scope,
    ...original
  } = policy;
  const definition = ReleasePolicyDefinitionSchema.parse({ ...original, mode });
  return {
    ...policy,
    ...definition,
    definitionSha256: digestReleasePolicyDefinition(policy.scope, definition),
  };
}
function fixture() {
  const definition = ReleaseDecisionInputDefinitionSchema.parse(vector("release-decision-input"));
  const scope = definition.scope;
  const candidate = releaseCandidateFixture("input_candidate", scope);
  const policies = [
    replacePolicyMode(releasePolicyRepositoryFixture("input_policy_a", scope), "mandatory"),
    replacePolicyMode(releasePolicyRepositoryFixture("input_policy_b", scope), "advisory"),
  ];
  const selectionDefinition = ReleasePolicySelectionDefinitionSchema.parse({
    ...ReleasePolicySelectionDefinitionSchema.parse(vector("release-policy-selection")),
    candidateTarget: candidate.target,
    installationId: policies[0]?.installationBinding.installationId,
    authorizedPublisherPrincipalIds: [definition.publisher.principalId],
    policies: policies.map((policy) => ({ policy: policyReference(policy), mode: policy.mode })),
  });
  const selection = {
    ...selectionDefinition,
    schemaVersion: "0.1" as const,
    publishedAt: "2026-10-15T00:00:00.000001Z",
    publishedByPrincipalId: selectionDefinition.issuerPrincipalId,
    definitionSha256: sha(
      encodeReleasePolicySelectionDefinition({ scope, definition: selectionDefinition }),
    ),
  };
  definition.candidate = releaseCandidateReference(candidate);
  definition.selection = {
    selectionId: selection.selectionId,
    selectionVersionId: selection.selectionVersionId,
    installationId: selection.installationId,
    gateTargetId: selection.gateTargetId,
    definitionSha256: selection.definitionSha256,
  };
  definition.evaluations = definition.evaluations.map((planned, index) => {
    const policy = policies[index];
    if (!policy) throw new Error("Missing installed policy fixture");
    const request = {
      ...planned.request,
      candidate: definition.candidate,
      policy: policyReference(policy),
    };
    return {
      mode: policy.mode,
      request,
      requestSha256: sha(encodePolicyEvaluationRequestDefinition({ scope, definition: request })),
    };
  });
  return {
    candidate,
    policies,
    selection,
    request: {
      ...definition,
      schemaVersion: "0.1" as const,
      definitionSha256: digestReleaseDecisionInputDefinition(scope, definition),
    },
  };
}
type Fixture = ReturnType<typeof fixture>;
function rehashRequest(input: Fixture): void {
  const { schemaVersion: _version, definitionSha256: _sha, ...definition } = input.request;
  input.request.definitionSha256 = digestReleaseDecisionInputDefinition(
    input.request.scope,
    definition,
  );
}
function rehashSelection(input: Fixture): void {
  const {
    schemaVersion: _version,
    definitionSha256: _sha,
    publishedAt: _at,
    publishedByPrincipalId: _publisher,
    ...definition
  } = input.selection;
  input.selection.definitionSha256 = sha(
    encodeReleasePolicySelectionDefinition({ scope: input.selection.scope, definition }),
  );
  input.request.selection.definitionSha256 = input.selection.definitionSha256;
  rehashRequest(input);
}

describe("complete immutable decision input bindings", () => {
  it("recomputes all owning digests and returns an independently owned strict record", () => {
    const input = fixture();
    const result = validateReleaseDecisionInputBindings(input);
    expect(result).toEqual(input.request);
    result.rationale = "Changed returned copy.";
    expect(input.request.rationale).not.toBe(result.rationale);
  });

  it("retains an explicit empty observation inventory rather than inventing evidence", () => {
    const input = fixture();
    input.selection.mode = "observation_only";
    input.selection.policies = [];
    input.request.mode = "observation_only";
    input.request.evaluations = [];
    input.policies = [];
    rehashSelection(input);
    expect(validateReleaseDecisionInputBindings(input).evaluations).toEqual([]);
  });

  it.each(["tenantId", "projectId", "environmentId"] as const)(
    "rejects a self-hashed input in a different %s",
    (field) => {
      const input = fixture();
      input.request.scope[field] = "different_scope";
      rehashRequest(input);
      expect(() => validateReleaseDecisionInputBindings(input)).toThrow(
        /exact complete selection and scope/,
      );
    },
  );

  it("rejects omission of advisory members even when the mandatory member remains", () => {
    const input = fixture();
    input.request.evaluations.splice(1, 1);
    rehashRequest(input);
    expect(() => validateReleaseDecisionInputBindings(input)).toThrow(/every selected policy/);
  });

  it.each(["missing", "extra", "reordered"])("rejects %s owning policy inventory", (kind) => {
    const input = fixture();
    if (kind === "missing") input.policies.pop();
    if (kind === "extra") input.policies.push(input.policies[0] as ReleasePolicy);
    if (kind === "reordered") input.policies.reverse();
    expect(() => validateReleaseDecisionInputBindings(input)).toThrow(
      InvalidReleaseDecisionInputError,
    );
  });

  it.each(["input", "selection", "candidate", "policy", "child"])(
    "rejects a forged %s digest",
    (kind) => {
      const input = fixture();
      if (kind === "input") input.request.definitionSha256 = "0".repeat(64);
      if (kind === "selection") input.selection.definitionSha256 = "0".repeat(64);
      if (kind === "candidate") input.candidate.definitionSha256 = "0".repeat(64);
      const first = input.policies[0];
      const planned = input.request.evaluations[0];
      if (!first || !planned) throw new Error("Missing first policy fixture");
      if (kind === "policy") first.definitionSha256 = "0".repeat(64);
      if (kind === "child") {
        planned.requestSha256 = "0".repeat(64);
        rehashRequest(input);
      }
      expect(() => validateReleaseDecisionInputBindings(input)).toThrow(
        InvalidReleaseDecisionInputError,
      );
    },
  );

  it("rejects self-consistent request substitution against the installed original policy", () => {
    const input = fixture();
    const first = input.request.evaluations[0];
    if (!first) throw new Error("Missing planned policy fixture");
    first.request.policy.policyVersionId = "policy_substituted";
    first.requestSha256 = sha(
      encodePolicyEvaluationRequestDefinition({
        scope: input.request.scope,
        definition: first.request,
      }),
    );
    rehashRequest(input);
    expect(() => validateReleaseDecisionInputBindings(input)).toThrow(
      /exact ordered installed policy/,
    );
  });

  it("rejects self-consistent candidate substitution and target narrowing", () => {
    for (const kind of ["candidate", "target"]) {
      const input = fixture();
      if (kind === "candidate") {
        input.request.candidate.candidateVersionId = "candidate_substituted";
        for (const planned of input.request.evaluations)
          planned.request.candidate.candidateVersionId = "candidate_substituted";
        rehashRequest(input);
      } else {
        input.selection.candidateTarget.purpose = "A narrower unrelated purpose.";
        rehashSelection(input);
      }
      expect(() => validateReleaseDecisionInputBindings(input)).toThrow(
        /original candidate and complete installation target/,
      );
    }
  });

  it.each(["mode", "scope", "installation"])(
    "rejects a self-hashed owning policy with substituted %s",
    (kind) => {
      const input = fixture();
      const original = input.policies[0];
      const planned = input.request.evaluations[0];
      const selected = input.selection.policies[0];
      if (!original || !planned || !selected) throw new Error("Missing installed policy fixture");
      const changed = structuredClone(original);
      if (kind === "mode") changed.mode = "advisory";
      if (kind === "scope") changed.scope.projectId = "project_another";
      if (kind === "installation")
        changed.installationBinding.installationId = "installation_another";
      const policy = replacePolicyMode(changed, changed.mode);
      input.policies[0] = policy;
      selected.policy = policyReference(policy);
      planned.request.policy = policyReference(policy);
      planned.requestSha256 = sha(
        encodePolicyEvaluationRequestDefinition({
          scope: input.request.scope,
          definition: planned.request,
        }),
      );
      rehashSelection(input);
      expect(() => validateReleaseDecisionInputBindings(input)).toThrow(
        /exact ordered installed policy/,
      );
    },
  );

  it("rejects absent publisher assignment and candidate/policy authors", () => {
    for (const actor of ["principal_unassigned", "candidate_author", "policy_author"]) {
      const input = fixture();
      if (actor === "principal_unassigned") {
        input.request.publisher.principalId = actor;
        rehashRequest(input);
      }
      if (actor === "candidate_author")
        input.candidate.createdByPrincipalId = input.request.publisher.principalId;
      if (actor === "policy_author") {
        const first = input.policies[0];
        if (!first) throw new Error("Missing first policy fixture");
        input.request.publisher.principalId = first.publishedByPrincipalId;
        input.selection.authorizedPublisherPrincipalIds = [first.publishedByPrincipalId];
        rehashSelection(input);
      }
      expect(() => validateReleaseDecisionInputBindings(input)).toThrow(/publisher/);
    }
  });

  it("enforces exact source intervals and rejects records published after the original cut", () => {
    for (const kind of [
      "selection_future",
      "selection_not_effective",
      "selection_expires",
      "candidate_future",
      "policy_future",
      "policy_expires",
    ]) {
      const input = fixture();
      if (kind === "selection_future") input.selection.publishedAt = "2026-10-15T12:00:00.000002Z";
      if (kind === "selection_not_effective") {
        input.selection.effectiveAt = "2026-10-15T12:00:00.000002Z";
        rehashSelection(input);
      }
      if (kind === "selection_expires") {
        input.selection.expiresAt = "2026-10-15T12:10:00.000000999999999999999999999999Z";
        rehashSelection(input);
      }
      if (kind === "candidate_future") input.candidate.createdAt = "2026-10-15T12:00:00.001Z";
      const first = input.policies[0];
      if (!first) throw new Error("Missing first policy fixture");
      if (kind === "policy_future") first.publishedAt = "2026-10-15T12:00:00.001Z";
      if (kind === "policy_expires") {
        first.expiresAt = "2026-10-15T12:10:00.000Z";
        const changed = replacePolicyMode(first, first.mode);
        input.policies[0] = changed;
        const planned = input.request.evaluations[0];
        const selected = input.selection.policies[0];
        if (!planned || !selected) throw new Error("Missing installed policy fixture");
        planned.request.policy = policyReference(changed);
        planned.requestSha256 = sha(
          encodePolicyEvaluationRequestDefinition({
            scope: input.request.scope,
            definition: planned.request,
          }),
        );
        selected.policy = policyReference(changed);
        rehashSelection(input);
      }
      expect(() => validateReleaseDecisionInputBindings(input)).toThrow(
        InvalidReleaseDecisionInputError,
      );
    }
  });

  it("wraps malformed source records without accepting an authority-shaped object", () => {
    const input = fixture();
    expect(() =>
      validateReleaseDecisionInputBindings({
        ...input,
        request: { ...input.request, currentAuthority: true },
      }),
    ).toThrow(InvalidReleaseDecisionInputError);
    expect(() => validateReleaseDecisionInputBindings({ ...input, selection: null })).toThrow(
      InvalidReleaseDecisionInputError,
    );
  });
});
