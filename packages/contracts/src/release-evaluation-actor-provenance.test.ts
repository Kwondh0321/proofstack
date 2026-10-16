import { describe, expect, it } from "vitest";
import {
  RELEASE_EVALUATION_SOURCE_ACTOR_FIELDS,
  ReleaseEvaluationActorProvenanceSchema,
  ReleaseEvaluationActorSourceSchema,
  type ReleaseEvaluationActorProvenance,
  type ReleaseEvaluationActorSource,
} from "./release-evaluation-actor-provenance.js";
import {
  PolicyEvaluationSourceReferenceSchema,
  policyEvaluationSourceReferenceKey,
  type PolicyEvaluationSourceReference,
} from "./policy-evaluation-source-reference.js";
import { PolicyEvaluationRecordWitnessSchema } from "./policy-evaluation-snapshot-records.js";

const sha = "a".repeat(64);
const candidate = {
  candidateId: "candidate_original",
  candidateVersionId: "candidate_original_v1",
  definitionSha256: sha,
};
const policy = {
  policyId: "policy_original",
  policyVersionId: "policy_original_v1",
  definitionSha256: sha,
};
function observed(
  source: PolicyEvaluationSourceReference,
  principals: readonly string[],
): ReleaseEvaluationActorSource {
  return ReleaseEvaluationActorSourceSchema.parse({
    state: "observed",
    witness: {
      entry: { source, observation: { status: "verified", recordSha256: sha } },
      storage: { recordSha256: sha, receiptTime: "2026-10-15T10:00:00.000Z" },
      origins: [{ kind: "semantic_node", nodeIndex: 0 }],
    },
    actors: RELEASE_EVALUATION_SOURCE_ACTOR_FIELDS[source.kind].map((field, index) => ({
      ...field,
      principalId: principals[index],
    })),
  });
}
function fixture(): ReleaseEvaluationActorProvenance {
  return ReleaseEvaluationActorProvenanceSchema.parse({
    schemaVersion: "0.1",
    authorityBoundary: "original_evaluation_actors_only",
    scope: {
      tenantId: "tenant_example",
      projectId: "project_example",
      environmentId: "env_staging",
    },
    original: {
      request: { evaluationRequestId: "request_original", definitionSha256: sha },
      jobId: "job_original",
      snapshot: { snapshotId: "snapshot_original", definitionSha256: sha },
      evaluation: { evaluationId: "evaluation_original", definitionSha256: sha },
      evaluationTime: "2026-10-15T10:00:00.000001Z",
      evaluatorPrincipalId: "worker_original",
      requesterPrincipalId: "user_requester",
    },
    candidate: { reference: candidate, authorPrincipalId: "user_candidate_author" },
    policy: { reference: policy, authorPrincipalId: "user_policy_author" },
    sources: [
      observed({ kind: "release_candidate", reference: candidate }, ["user_candidate_author"]),
      observed({ kind: "release_policy", reference: policy }, ["user_policy_author"]),
    ],
    sourceState: "complete",
    evaluationActorState: "complete",
    evaluatorPrincipalIds: ["worker_original"],
  });
}
function add(value: ReleaseEvaluationActorProvenance, source: ReleaseEvaluationActorSource) {
  value.sources.push(source);
  value.sources.sort((a, b) => {
    const left = policyEvaluationSourceReferenceKey(a.witness.entry.source),
      right = policyEvaluationSourceReferenceKey(b.witness.entry.source);
    return left < right ? -1 : left > right ? 1 : 0;
  });
}
describe("strict original evaluation actor provenance, not authentication or current authority", () => {
  it("covers all 48 installed owning kinds with frozen fixed paths rather than a caller registry", () => {
    expect(PolicyEvaluationSourceReferenceSchema.options).toHaveLength(48);
    expect(new Set(Object.keys(RELEASE_EVALUATION_SOURCE_ACTOR_FIELDS))).toEqual(
      new Set(PolicyEvaluationSourceReferenceSchema.options.map(({ shape }) => shape.kind.value)),
    );
    expect(Object.isFrozen(RELEASE_EVALUATION_SOURCE_ACTOR_FIELDS)).toBe(true);
    for (const fields of Object.values(RELEASE_EVALUATION_SOURCE_ACTOR_FIELDS)) {
      expect(Object.isFrozen(fields)).toBe(true);
      for (const field of fields) expect(Object.isFrozen(field)).toBe(true);
    }
  });
  it("retains actual subject authors without calling a requester an evaluator", () => {
    const value = fixture();
    const before = structuredClone(value);
    expect(ReleaseEvaluationActorProvenanceSchema.parse(value)).toEqual(before);
    expect(value.evaluatorPrincipalIds).not.toContain(value.original.requesterPrincipalId);
    expect(value.evaluatorPrincipalIds).not.toContain(value.candidate.authorPrincipalId);
    expect(value.evaluatorPrincipalIds).not.toContain(value.policy.authorPrincipalId);
  });
  it("derives actual execution principals and retains every exact source/original occurrence", () => {
    const value = fixture();
    const source = observed(
      {
        kind: "raw_observation",
        reference: { observationId: "observation_original", definitionSha256: sha },
      },
      ["actor_measurement"],
    );
    source.witness.origins.push({ kind: "stored_node", nodeIndex: 5 });
    add(value, source);
    value.evaluatorPrincipalIds = ["actor_measurement", "worker_original"];
    const result = ReleaseEvaluationActorProvenanceSchema.parse(value);
    expect(result.sources[0]?.witness.origins).toHaveLength(2);
    expect(result.original.evaluationTime).toBe("2026-10-15T10:00:00.000001Z");
  });
  it("does not promote an enqueue actor or a declared reviewer profile subject into execution", () => {
    const value = fixture();
    add(
      value,
      observed(
        {
          kind: "evaluation_run",
          reference: { evaluationRunId: "run_original", definitionSha256: sha },
        },
        ["user_enqueue"],
      ),
    );
    add(
      value,
      observed(
        {
          kind: "human_reviewer_independence",
          reference: { declarationId: "independence_original", definitionSha256: sha },
        },
        ["actor_independence_review", "user_profile_subject"],
      ),
    );
    value.evaluatorPrincipalIds = ["actor_independence_review", "worker_original"];
    expect(ReleaseEvaluationActorProvenanceSchema.parse(value).evaluatorPrincipalIds).toEqual(
      value.evaluatorPrincipalIds,
    );
    value.evaluatorPrincipalIds.push("user_profile_subject");
    value.evaluatorPrincipalIds.sort();
    expect(ReleaseEvaluationActorProvenanceSchema.safeParse(value).success).toBe(false);
  });
  it("distinguishes unknown evaluator provenance from an unavailable source-author record", () => {
    const value = fixture();
    const source = observed(
      {
        kind: "raw_observation",
        reference: { observationId: "observation_original", definitionSha256: sha },
      },
      ["actor_measurement"],
    );
    add(value, {
      state: "unavailable",
      witness: source.witness,
      reason: "owning_source_unavailable",
    });
    value.sourceState = "unavailable";
    value.evaluationActorState = "unavailable";
    expect(ReleaseEvaluationActorProvenanceSchema.parse(value).evaluationActorState).toBe(
      "unavailable",
    );
    value.evaluationActorState = "complete";
    expect(ReleaseEvaluationActorProvenanceSchema.safeParse(value).success).toBe(false);
    const author = fixture();
    const run = observed(
      {
        kind: "evaluation_run",
        reference: { evaluationRunId: "run_original", definitionSha256: sha },
      },
      ["user_enqueue"],
    );
    add(author, {
      state: "unavailable",
      witness: run.witness,
      reason: "owning_source_unavailable",
    });
    author.sourceState = "unavailable";
    expect(ReleaseEvaluationActorProvenanceSchema.parse(author).evaluationActorState).toBe(
      "complete",
    );
  });
  it.each(["field", "role", "omitted", "extra", "unknown"] as const)(
    "rejects substituted %s in a fixed owning projection",
    (kind) => {
      const source = observed(
        {
          kind: "raw_observation",
          reference: { observationId: "observation_original", definitionSha256: sha },
        },
        ["actor_measurement"],
      );
      if (source.state !== "observed") throw new Error("Missing observed fixture");
      const actor = source.actors[0];
      if (!actor) throw new Error("Missing actor fixture");
      if (kind === "field") actor.field = "/publishedByPrincipalId";
      if (kind === "role") actor.role = "source_author";
      if (kind === "omitted") source.actors = [];
      if (kind === "extra") source.actors.push(actor);
      if (kind === "unknown") Reflect.set(source, "authenticated", true);
      expect(ReleaseEvaluationActorSourceSchema.safeParse(source).success).toBe(false);
    },
  );
  it("cannot claim an observed actor when no original full body was retained", () => {
    const source = observed(
      {
        kind: "raw_observation",
        reference: { observationId: "observation_original", definitionSha256: sha },
      },
      ["actor_measurement"],
    );
    source.witness = PolicyEvaluationRecordWitnessSchema.parse({
      ...source.witness,
      entry: { ...source.witness.entry, observation: { status: "missing" } },
      storage: null,
    });
    expect(ReleaseEvaluationActorSourceSchema.safeParse(source).success).toBe(false);
  });
  it.each([
    "candidate_author",
    "policy_author",
    "root_reference",
    "root_omitted",
    "duplicate_source",
    "order",
    "worker_omitted",
    "extra_principal",
    "source_state",
    "schema_version",
    "unknown",
  ] as const)("rejects substituted %s without an owning original graph", (kind) => {
    const value = fixture();
    if (kind === "candidate_author") value.candidate.authorPrincipalId = "user_other";
    if (kind === "policy_author") value.policy.authorPrincipalId = "user_other";
    if (kind === "root_reference") value.candidate.reference.definitionSha256 = "b".repeat(64);
    if (kind === "root_omitted") value.sources.shift();
    if (kind === "duplicate_source") {
      const source = value.sources[0];
      if (source) value.sources.push(source);
    }
    if (kind === "order") value.sources.reverse();
    if (kind === "worker_omitted") value.evaluatorPrincipalIds = ["user_fake"];
    if (kind === "extra_principal") value.evaluatorPrincipalIds = ["user_fake", "worker_original"];
    if (kind === "source_state") value.sourceState = "unavailable";
    if (kind === "schema_version") Reflect.set(value, "schemaVersion", "0.2");
    if (kind === "unknown") Reflect.set(value.original, "privateProof", "caller_assertion");
    expect(ReleaseEvaluationActorProvenanceSchema.safeParse(value).success).toBe(false);
  });
});
