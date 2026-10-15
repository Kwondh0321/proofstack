import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  MAX_RELEASE_POLICY_SELECTION_DEFINITION_BYTES,
  MAX_RELEASE_POLICY_SELECTION_POLICIES,
  MAX_RELEASE_POLICY_SELECTION_PUBLISHERS,
  MAX_RELEASE_POLICY_SELECTION_RESPONSE_BYTES,
  ReleasePolicyExceptionRequirementSchema,
  ReleasePolicySelectionDefinitionSchema,
  ReleasePolicySelectionLifecycleEventSchema,
  ReleasePolicySelectionReferenceSchema,
  ReleasePolicySelectionSchema,
} from "./release-policy-selection.js";

const vectors = JSON.parse(
  readFileSync(
    new URL("../vectors/release-policy-selection-definition-v1.json", import.meta.url),
    "utf8",
  ),
) as { readonly vectors: readonly { readonly input: { readonly definition: unknown } }[] };

function definition() {
  return ReleasePolicySelectionDefinitionSchema.parse(
    structuredClone(vectors.vectors[0]?.input.definition),
  );
}

function reference() {
  const value = definition();
  return {
    selectionId: value.selectionId,
    selectionVersionId: value.selectionVersionId,
    definitionSha256: "c".repeat(64),
    installationId: value.installationId,
    gateTargetId: value.gateTargetId,
  };
}

function record() {
  const value = definition();
  return {
    ...value,
    definitionSha256: "c".repeat(64),
    schemaVersion: "0.1",
    publishedAt: "2026-10-15T00:00:00.000002Z",
    publishedByPrincipalId: value.issuerPrincipalId,
  };
}

/** Independently measure transport bytes, including non-BMP scalar values, without the encoder. */
function byteBoundaryDefinition(bytes: number) {
  const value = definition();
  const labels = (prefix: string) =>
    Array.from({ length: 32 }, (_, index) =>
      `${prefix}_${index.toString().padStart(3, "0")}`.padEnd(64, "x"),
    );
  const groups = labels("group");
  value.policies = Array.from({ length: MAX_RELEASE_POLICY_SELECTION_POLICIES }, (_, index) => ({
    policy: {
      policyId: `policy_${index.toString().padStart(3, "0")}`.padEnd(64, "x"),
      policyVersionId: `version_${index.toString().padStart(3, "0")}`.padEnd(64, "x"),
      definitionSha256: "a".repeat(64),
    },
    mode: "mandatory",
    exceptionRequirement: {
      kind: "approval_required",
      conflictRule: "reject_declared_conflict",
      excludeCandidateAuthor: true,
      excludePolicyAuthor: true,
      quorum: 32,
      independenceGroupIds: [...groups],
      humanReviewerGroupIds: [...groups],
      reviewerRoleIds: labels("role"),
    },
  }));
  value.authorizedPublisherPrincipalIds = labels("publisher");
  value.rationale = "😀".repeat(4096);
  value.candidateTarget.purpose = "😀".repeat(4096);
  value.candidateTarget.populationTags = Array.from(
    { length: 64 },
    (_, index) => `tag_${index.toString().padStart(3, "0")}_`,
  );
  let remaining = bytes - Buffer.byteLength(JSON.stringify(value));
  for (let index = 0; index < value.candidateTarget.populationTags.length; index += 1) {
    const prefix = value.candidateTarget.populationTags[index] ?? "";
    const addition = Math.min(remaining, (512 - prefix.length - 3) * 4);
    if (addition < 0) throw new Error("Byte fixture base exceeds the requested boundary");
    value.candidateTarget.populationTags[index] =
      prefix + "😀".repeat(Math.floor(addition / 4)) + "x".repeat(addition % 4);
    remaining -= addition;
  }
  if (remaining !== 0) throw new Error("Insufficient valid scalar headroom for the byte fixture");
  expect(Buffer.byteLength(JSON.stringify(value))).toBe(bytes);
  return value;
}

describe("installation-owned release policy selection contracts", () => {
  it("admits complete mandatory and explicit empty observation inventories", () => {
    expect(definition().policies).toHaveLength(1);
    const observation = ReleasePolicySelectionDefinitionSchema.parse(
      vectors.vectors[1]?.input.definition,
    );
    expect(observation.mode).toBe("observation_only");
    expect(observation.policies).toEqual([]);
    expect(ReleasePolicySelectionSchema.safeParse(record()).success).toBe(true);
    expect(ReleasePolicySelectionReferenceSchema.safeParse(reference()).success).toBe(true);
  });

  it("distinguishes missing selection authority from a declared empty inventory", () => {
    for (const input of [undefined, null, {}, { ...definition(), policies: undefined }])
      expect(ReleasePolicySelectionDefinitionSchema.safeParse(input).success).toBe(false);
  });

  it.each([
    { mode: "observation_only" },
    { policies: [] },
    { policies: [{ ...definition().policies[0], mode: "advisory" }] },
  ])("rejects a downgraded or empty mandatory gate: %j", (change) => {
    expect(
      ReleasePolicySelectionDefinitionSchema.safeParse({ ...definition(), ...change }).success,
    ).toBe(false);
  });

  it("accepts advisory-only observation while preserving its exact policy version", () => {
    const value = definition();
    value.mode = "observation_only";
    const policy = value.policies[0];
    if (!policy) throw new Error("Missing selected policy");
    policy.mode = "advisory";
    expect(ReleasePolicySelectionDefinitionSchema.parse(value).policies[0]?.policy).toEqual(
      policy.policy,
    );
  });

  it("rejects repeated logical policies, alternate versions and unordered inventories", () => {
    const value = definition();
    const first = value.policies[0];
    if (!first) throw new Error("Missing selected policy");
    for (const second of [
      first,
      { ...first, policy: { ...first.policy, policyVersionId: "version_other" } },
    ])
      expect(
        ReleasePolicySelectionDefinitionSchema.safeParse({ ...value, policies: [first, second] })
          .success,
      ).toBe(false);
    const next = { ...first, policy: { ...first.policy, policyId: "policy_zzz" } };
    expect(
      ReleasePolicySelectionDefinitionSchema.safeParse({ ...value, policies: [first, next] })
        .success,
    ).toBe(true);
    expect(
      ReleasePolicySelectionDefinitionSchema.safeParse({ ...value, policies: [next, first] })
        .success,
    ).toBe(false);
  });

  it("bounds policy and publisher counts without counting duplicate people as new authority", () => {
    const value = definition();
    const policy = value.policies[0];
    if (!policy) throw new Error("Missing selected policy");
    const policies = Array.from({ length: MAX_RELEASE_POLICY_SELECTION_POLICIES }, (_, i) => ({
      ...policy,
      policy: { ...policy.policy, policyId: `policy_${i.toString().padStart(3, "0")}` },
    }));
    expect(ReleasePolicySelectionDefinitionSchema.safeParse({ ...value, policies }).success).toBe(
      true,
    );
    expect(
      ReleasePolicySelectionDefinitionSchema.safeParse({
        ...value,
        policies: [
          ...policies,
          { ...policy, policy: { ...policy.policy, policyId: "policy_zzz" } },
        ],
      }).success,
    ).toBe(false);
    const publishers = Array.from(
      { length: MAX_RELEASE_POLICY_SELECTION_PUBLISHERS },
      (_, i) => `publisher_${i.toString().padStart(3, "0")}`,
    );
    expect(
      ReleasePolicySelectionDefinitionSchema.safeParse({
        ...value,
        authorizedPublisherPrincipalIds: publishers,
      }).success,
    ).toBe(true);
    for (const ids of [
      [],
      ["publisher_one", "publisher_one"],
      ["publisher_two", "publisher_one"],
      [...publishers, "publisher_zzz"],
    ])
      expect(
        ReleasePolicySelectionDefinitionSchema.safeParse({
          ...value,
          authorizedPublisherPrincipalIds: ids,
        }).success,
      ).toBe(false);
  });

  it.each(["tenantId", "projectId", "environmentId"] as const)(
    "requires the full %s scope",
    (key) => {
      const value = definition();
      const scope: Record<string, unknown> = { ...value.scope };
      delete scope[key];
      expect(ReleasePolicySelectionDefinitionSchema.safeParse({ ...value, scope }).success).toBe(
        false,
      );
    },
  );

  it("rejects a foreign target environment and executable gate target", () => {
    const value = definition();
    expect(
      ReleasePolicySelectionDefinitionSchema.safeParse({
        ...value,
        candidateTarget: { ...value.candidateTarget, environmentId: "env_other" },
      }).success,
    ).toBe(false);
    expect(
      ReleasePolicySelectionDefinitionSchema.safeParse({
        ...value,
        gateTargetId: "https://deployment.example/action",
      }).success,
    ).toBe(false);
  });

  it("compares native UTC precision without rounding or accepting invalid dates", () => {
    const value = definition();
    expect(
      ReleasePolicySelectionDefinitionSchema.safeParse({
        ...value,
        expiresAt: "2026-10-15T00:00:00.0000011Z",
      }).success,
    ).toBe(true);
    for (const expiresAt of [
      value.effectiveAt,
      "2026-10-15T00:00:00.0000009Z",
      "2026-02-30T00:00:00Z",
      "invalid",
      "2026-10-16T00:00:00+01:00",
    ])
      expect(
        ReleasePolicySelectionDefinitionSchema.safeParse({ ...value, expiresAt }).success,
      ).toBe(false);
  });

  it("requires independently scoped exception authority without changing normal approvals", () => {
    const requirement = definition().policies[0]?.exceptionRequirement;
    if (!requirement) throw new Error("Missing exception requirement");
    for (const changed of [
      { excludeCandidateAuthor: false },
      { excludePolicyAuthor: false },
      { humanReviewerGroupIds: [] },
      { quorum: 3 },
      { humanReviewerGroupIds: ["group_foreign"] },
    ])
      expect(
        ReleasePolicyExceptionRequirementSchema.safeParse({ ...requirement, ...changed }).success,
      ).toBe(false);
    const value = definition();
    value.policies = value.policies.map(({ policy, mode }) => ({ policy, mode }));
    expect(ReleasePolicySelectionDefinitionSchema.safeParse(value).success).toBe(true);
  });

  it("binds predecessor to the same logical installation target and a different version", () => {
    const value = definition();
    const predecessor = { ...reference(), selectionVersionId: "selection_previous" };
    expect(
      ReleasePolicySelectionDefinitionSchema.safeParse({ ...value, predecessor }).success,
    ).toBe(true);
    for (const change of [
      { selectionId: "selection_other" },
      { installationId: "installation_other" },
      { gateTargetId: "gate_other" },
      { selectionVersionId: value.selectionVersionId },
    ])
      expect(
        ReleasePolicySelectionDefinitionSchema.safeParse({
          ...value,
          predecessor: { ...predecessor, ...change },
        }).success,
      ).toBe(false);
  });

  it.each([
    "publishedAt",
    "definitionSha256",
    "decision",
    "latestEvaluation",
    "deploymentToken",
    "reviewerMembership",
    "callback",
  ])("rejects definition field smuggling: %s", (key) => {
    expect(
      ReleasePolicySelectionDefinitionSchema.safeParse({ ...definition(), [key]: "untrusted" })
        .success,
    ).toBe(false);
  });

  it("rejects nested authority and reference field smuggling", () => {
    const value = definition();
    expect(
      ReleasePolicySelectionDefinitionSchema.safeParse({
        ...value,
        policies: [{ ...value.policies[0], verdict: "satisfied" }],
      }).success,
    ).toBe(false);
    expect(
      ReleasePolicySelectionReferenceSchema.safeParse({ ...reference(), current: true }).success,
    ).toBe(false);
  });

  it("retains server issuer and expiry checks separately from definition admission", () => {
    const value = record();
    for (const change of [
      { publishedByPrincipalId: "user_other" },
      { publishedAt: value.expiresAt },
      { publishedAt: "2026-10-17T00:00:00Z" },
      { publishedAt: "invalid" },
      { schemaVersion: "99" },
    ])
      expect(ReleasePolicySelectionSchema.safeParse({ ...value, ...change }).success).toBe(false);
  });

  it("admits just-below/exact UTF-8 definitions and reserves receipt/envelope headroom", () => {
    for (const bytes of [
      MAX_RELEASE_POLICY_SELECTION_DEFINITION_BYTES - 1,
      MAX_RELEASE_POLICY_SELECTION_DEFINITION_BYTES,
    ]) {
      const value = byteBoundaryDefinition(bytes);
      expect(ReleasePolicySelectionDefinitionSchema.safeParse(value).success).toBe(true);
      const published = ReleasePolicySelectionSchema.parse({ ...record(), ...value });
      const wire = JSON.stringify({
        created: true,
        selection: published,
        requestId: "\u0000".repeat(128),
      });
      expect(Buffer.byteLength(wire)).toBeLessThanOrEqual(
        MAX_RELEASE_POLICY_SELECTION_RESPONSE_BYTES,
      );
    }
    const over = byteBoundaryDefinition(MAX_RELEASE_POLICY_SELECTION_DEFINITION_BYTES + 1);
    expect(ReleasePolicySelectionDefinitionSchema.safeParse(over).success).toBe(false);
    expect(ReleasePolicySelectionSchema.safeParse({ ...record(), ...over }).success).toBe(false);
  });

  it("admits explicit undefined optional fields as absent JSON", () => {
    const value = definition();
    value.policies = value.policies.map(({ policy, mode }) => ({
      policy,
      mode,
      exceptionRequirement: undefined,
    }));
    expect(
      ReleasePolicySelectionDefinitionSchema.safeParse({ ...value, predecessor: undefined })
        .success,
    ).toBe(true);
  });
});

describe("append-only selection lifecycle shapes", () => {
  const event = () => ({
    eventId: "event_selection_withdrawn",
    selection: reference(),
    scope: definition().scope,
    reason: "The installation withdrew this exact target selection.",
    actorPrincipalId: "user_installation_owner",
    occurredAt: "2026-10-15T12:00:00.123456Z",
    schemaVersion: "0.1",
    kind: "withdrawn",
  });

  it("admits withdrawal and exact-target supersession without a decision", () => {
    expect(ReleasePolicySelectionLifecycleEventSchema.safeParse(event()).success).toBe(true);
    expect(
      ReleasePolicySelectionLifecycleEventSchema.safeParse({
        ...event(),
        kind: "superseded",
        successor: { ...reference(), selectionVersionId: "selection_v2" },
      }).success,
    ).toBe(true);
  });

  it.each([
    { selectionId: "selection_other" },
    { installationId: "installation_other" },
    { gateTargetId: "gate_other" },
    {},
  ])("rejects foreign or self supersession: %j", (change) => {
    expect(
      ReleasePolicySelectionLifecycleEventSchema.safeParse({
        ...event(),
        kind: "superseded",
        successor: { ...reference(), ...change },
      }).success,
    ).toBe(false);
  });

  it("rejects reactivation, missing successors and mutable authority assertions", () => {
    for (const changed of [
      { kind: "reactivated" },
      { kind: "superseded" },
      { current: true },
      { kind: "withdrawn", successor: reference() },
    ])
      expect(
        ReleasePolicySelectionLifecycleEventSchema.safeParse({ ...event(), ...changed }).success,
      ).toBe(false);
  });
});
