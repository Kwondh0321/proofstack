import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CreateReleaseDecisionInputRequestSchema,
  MAX_RELEASE_DECISION_INPUT_DEFINITION_BYTES,
  MAX_RELEASE_DECISION_INPUT_RESPONSE_BYTES,
  ReleaseDecisionInputDefinitionSchema,
  ReleaseDecisionInputReferenceSchema,
  ReleaseDecisionInputSchema,
  ReleaseDecisionPublisherReceiptSchema,
  ReleaseDecisionVerificationLimitsSchema,
} from "./release-decision-input.js";

const document = JSON.parse(
  readFileSync(
    new URL("../vectors/release-decision-input-definition-v1.json", import.meta.url),
    "utf8",
  ),
) as { vectors: { input: { definition: unknown } }[] };

function definition(index = 0) {
  return ReleaseDecisionInputDefinitionSchema.parse(
    structuredClone(document.vectors[index]?.input.definition),
  );
}

describe("predeclared complete decision inputs", () => {
  it.each([0, 1])(
    "rejects malformed scalar receipt strings without throwing for actor %i",
    (index) => {
      const value = definition(index);
      for (const requestId of [String.fromCharCode(0xd800), String.fromCharCode(0xdfff)]) {
        expect(
          ReleaseDecisionInputDefinitionSchema.safeParse({
            ...value,
            publisher: { ...value.publisher, requestId },
          }).success,
        ).toBe(false);
        expect(
          ReleaseDecisionPublisherReceiptSchema.safeParse({ ...value.publisher, requestId })
            .success,
        ).toBe(false);
      }
      expect(
        ReleaseDecisionPublisherReceiptSchema.safeParse({
          ...value.publisher,
          requestId: "😀".repeat(64),
        }).success,
      ).toBe(true);
    },
  );
  it.each([0, 1, 2])(
    "admits the explicit reference mode %i without claiming authority",
    (index) => {
      const value = definition(index);
      expect(
        ReleaseDecisionInputSchema.parse({
          ...value,
          schemaVersion: "0.1",
          definitionSha256: "d".repeat(64),
        }),
      ).toMatchObject(value);
    },
  );

  it("restricts public intent to candidate, selection, request identity and rationale", () => {
    const value = definition();
    const intent = {
      decisionInputRequestId: value.decisionInputRequestId,
      candidate: value.candidate,
      selection: value.selection,
      rationale: value.rationale,
    };
    expect(CreateReleaseDecisionInputRequestSchema.parse(intent)).toEqual(intent);
    for (const field of [
      "scope",
      "evaluations",
      "createdAt",
      "expiresAt",
      "publisher",
      "verificationLimits",
      "result",
      "disposition",
      "workerId",
      "currentAuthority",
    ]) {
      expect(
        CreateReleaseDecisionInputRequestSchema.safeParse({ ...intent, [field]: true }).success,
        field,
      ).toBe(false);
    }
  });

  it.each(["workload", "development", "model"])(
    "rejects %s as a decision publisher",
    (principalType) => {
      expect(
        ReleaseDecisionPublisherReceiptSchema.safeParse({
          ...definition().publisher,
          principalType,
        }).success,
      ).toBe(false);
    },
  );

  it("binds the actual credential kind and excludes secret proofs", () => {
    const value = definition().publisher;
    for (const changed of [
      { authenticationMethod: "oidc" },
      { token: "secret" },
      { sessionDigest: "a".repeat(64) },
      { authenticatedAt: "2026-10-15T12:00:00.000001Z" },
    ]) {
      expect(
        ReleaseDecisionPublisherReceiptSchema.safeParse({ ...value, ...changed }).success,
      ).toBe(false);
    }
  });

  it("rejects missing, duplicated, descending or conflicting logical policies", () => {
    const value = definition();
    const first = value.evaluations[0];
    if (!first) throw new Error("Missing planned policy fixture");
    expect(
      ReleaseDecisionInputDefinitionSchema.safeParse({ ...value, evaluations: [] }).success,
    ).toBe(false);
    expect(
      ReleaseDecisionInputDefinitionSchema.safeParse({ ...value, evaluations: [first, first] })
        .success,
    ).toBe(false);
    expect(
      ReleaseDecisionInputDefinitionSchema.safeParse({
        ...value,
        evaluations: [...value.evaluations].reverse(),
      }).success,
    ).toBe(false);
    const otherVersion = structuredClone(first);
    otherVersion.request.policy.policyVersionId = "policy_another_version";
    otherVersion.request.evaluationRequestId = "another_request";
    expect(
      ReleaseDecisionInputDefinitionSchema.safeParse({
        ...value,
        evaluations: [first, otherVersion],
      }).success,
    ).toBe(false);
  });

  it("cannot silently share request IDs across different selected policies", () => {
    const value = definition();
    const first = value.evaluations[0];
    const second = value.evaluations[1];
    if (!first || !second) throw new Error("Missing two-policy fixture");
    second.request.evaluationRequestId = first.request.evaluationRequestId;
    expect(ReleaseDecisionInputDefinitionSchema.safeParse(value).success).toBe(false);
  });

  it.each(["candidateId", "candidateVersionId", "definitionSha256"] as const)(
    "binds exact candidate %s",
    (field) => {
      const value = definition();
      const first = value.evaluations[0];
      if (!first) throw new Error("Missing planned policy fixture");
      first.request.candidate[field] =
        field === "definitionSha256" ? "e".repeat(64) : "candidate_changed";
      expect(ReleaseDecisionInputDefinitionSchema.safeParse(value).success).toBe(false);
    },
  );

  it("retains the same full-precision semantic cut and rejects equal-instant text substitution", () => {
    const value = definition();
    const first = value.evaluations[0];
    if (!first) throw new Error("Missing planned policy fixture");
    for (const time of [
      "2026-10-15T12:00:00.000Z",
      `${value.createdAt.slice(0, -1)}0Z`,
      "2026-10-15T12:00:00.000002Z",
    ]) {
      first.request.evaluationTime = time;
      expect(ReleaseDecisionInputDefinitionSchema.safeParse(value).success, time).toBe(false);
    }
  });

  it("does not downgrade mandatory policies into observation", () => {
    const value = definition();
    expect(
      ReleaseDecisionInputDefinitionSchema.safeParse({ ...value, mode: "observation_only" })
        .success,
    ).toBe(false);
    expect(
      ReleaseDecisionInputDefinitionSchema.safeParse({
        ...value,
        evaluations: value.evaluations.map((entry) => ({ ...entry, mode: "advisory" })),
      }).success,
    ).toBe(false);
  });

  it("retains positive bounded validity without rounding native or authentication time", () => {
    const value = definition();
    for (const expiresAt of [
      value.createdAt,
      "2026-10-15T12:00:00.000000999999999999999999999999Z",
      "2026-10-15T13:00:00.000001000000000000000000000001Z",
    ]) {
      expect(ReleaseDecisionInputDefinitionSchema.safeParse({ ...value, expiresAt }).success).toBe(
        false,
      );
    }
    expect(
      ReleaseDecisionInputDefinitionSchema.safeParse({
        ...value,
        expiresAt: "2026-10-15T13:00:00.000001Z",
      }).success,
    ).toBe(true);
    expect(
      ReleaseDecisionInputDefinitionSchema.safeParse({
        ...value,
        publisher: { ...value.publisher, authenticatedAt: "2026-10-15T12:00:00.001Z" },
      }).success,
    ).toBe(false);
  });

  it.each([
    ["maxAcquisitionRecords", 2, 100_000],
    ["maxAcquisitionRecordBytes", 1, 67_108_864],
    ["maxApprovalRecords", 0, 4_096],
  ] as const)(
    "bounds the aggregate %s without per-policy multiplication",
    (field, minimum, maximum) => {
      const limits = definition().verificationLimits;
      for (const value of [minimum, maximum])
        expect(
          ReleaseDecisionVerificationLimitsSchema.safeParse({ ...limits, [field]: value }).success,
        ).toBe(true);
      for (const value of [minimum - 1, maximum + 1, 1.5, Number.NaN])
        expect(
          ReleaseDecisionVerificationLimitsSchema.safeParse({ ...limits, [field]: value }).success,
        ).toBe(false);
    },
  );

  it("admits all sixteen largest planned definitions and independently proves response headroom", () => {
    const value = definition();
    const template = value.evaluations[0];
    if (!template) throw new Error("Missing planned policy fixture");
    const id = (prefix: string) => prefix.padEnd(64, "x");
    value.decisionInputRequestId = id("decision_input");
    value.candidate = {
      candidateId: id("candidate"),
      candidateVersionId: id("version"),
      definitionSha256: "a".repeat(64),
    };
    value.scope = {
      tenantId: id("tenant"),
      projectId: id("project"),
      environmentId: id("environment"),
    };
    value.selection = {
      selectionId: id("selection"),
      selectionVersionId: id("version"),
      installationId: id("installation"),
      gateTargetId: id("gate"),
      definitionSha256: "b".repeat(64),
    };
    value.rationale = "😀".repeat(4096);
    value.publisher = {
      ...value.publisher,
      principalId: id("principal"),
      credentialId: id("credential"),
      requestId: String.fromCharCode(0).repeat(128),
    };
    value.createdAt = "2026-10-15T12:00:00.000001000000000000000000000000Z";
    value.expiresAt = "2026-10-15T13:00:00.000001000000000000000000000000Z";
    value.evaluations = Array.from({ length: 16 }, (_, index) => ({
      ...structuredClone(template),
      request: {
        ...structuredClone(template.request),
        candidate: value.candidate,
        evaluationTime: value.createdAt,
        evaluationRequestId: id(`request_${index.toString().padStart(2, "0")}`),
        limits: {
          heartbeatIntervalMilliseconds: 10_000,
          leaseDurationMilliseconds: 60_000,
          maxAcquisitionRecordBytes: 67_108_864,
          maxAcquisitionRecords: 100_000,
          maxArtifactReadBytes: 268_435_456,
          maxAttempts: 8,
          maxRuleEvaluations: 1_024,
          perAttemptTimeoutMilliseconds: 900_000,
          retryBackoffMilliseconds: 60_000,
          retryableErrors: [
            "lease_expired",
            "source_revision_changed",
            "source_temporarily_unavailable",
            "worker_interrupted",
          ],
          totalDeadlineMilliseconds: 3_600_000,
        },
        policy: {
          policyId: id(`policy_${index.toString().padStart(2, "0")}`),
          policyVersionId: id("version"),
          definitionSha256: "c".repeat(64),
        },
      },
    }));
    expect(ReleaseDecisionInputDefinitionSchema.parse(value)).toEqual(value);
    const definitionBytes = Buffer.byteLength(JSON.stringify(value));
    expect(definitionBytes).toBeLessThan(MAX_RELEASE_DECISION_INPUT_DEFINITION_BYTES);
    const response = {
      request: { ...value, schemaVersion: "0.1", definitionSha256: "d".repeat(64) },
      requestId: String.fromCharCode(0).repeat(128),
    };
    expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThan(
      MAX_RELEASE_DECISION_INPUT_RESPONSE_BYTES,
    );
    const extra = structuredClone(value.evaluations[15]);
    if (!extra) throw new Error("Missing sixteenth fixture");
    extra.request.policy.policyId = id("policy_16");
    extra.request.evaluationRequestId = id("request_16");
    expect(
      ReleaseDecisionInputDefinitionSchema.safeParse({
        ...value,
        evaluations: [...value.evaluations, extra],
      }).success,
    ).toBe(false);
  });

  it("strictly versions records and references and rejects nested result/authority injection", () => {
    const value = definition();
    const reference = {
      decisionInputRequestId: value.decisionInputRequestId,
      definitionSha256: "d".repeat(64),
    };
    expect(ReleaseDecisionInputReferenceSchema.parse(reference)).toEqual(reference);
    expect(
      ReleaseDecisionInputReferenceSchema.safeParse({ ...reference, result: "proceed" }).success,
    ).toBe(false);
    for (const changed of [
      { schemaVersion: "0.2" },
      { definitionSha256: "bad" },
      { currentAuthority: true },
    ]) {
      expect(
        ReleaseDecisionInputSchema.safeParse({
          ...value,
          schemaVersion: "0.1",
          definitionSha256: "d".repeat(64),
          ...changed,
        }).success,
      ).toBe(false);
    }
    const first = value.evaluations[0];
    expect(
      ReleaseDecisionInputDefinitionSchema.safeParse({
        ...value,
        evaluations: [{ ...first, result: "satisfied" }],
      }).success,
    ).toBe(false);
    expect(
      ReleaseDecisionInputDefinitionSchema.safeParse({ ...value, rationale: "😀".repeat(4097) })
        .success,
    ).toBe(false);
  });
});
