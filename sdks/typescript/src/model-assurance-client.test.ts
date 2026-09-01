import { readFileSync } from "node:fs";
import type { EvidenceScope, ModelAssuranceRecordKind } from "@proofstack/contracts";
import { describe, expect, it, vi } from "vitest";
import { ProofStackModelAssuranceClient } from "./model-assurance-client.js";
import { ProofStackApiError, ProofStackProblemError } from "./regression-client.js";

interface StoredVector {
  readonly input: { readonly definition: Record<string, unknown>; readonly scope: EvidenceScope };
  readonly kind: ModelAssuranceRecordKind | "model_assisted_evaluator_spec";
  readonly sha256: string;
}

const vectors = [
  "evaluation-blinded-plan-definition-v1.json",
  "evaluation-blinded-result-definition-v1.json",
  "evaluation-calibration-definition-v1.json",
  "evaluation-human-review-protocol-definition-v1.json",
  "evaluation-human-review-record-definition-v1.json",
  "evaluation-human-reviewer-independence-definition-v1.json",
  "evaluation-independence-definition-v1.json",
  "evaluation-independent-critique-definition-v1.json",
  "evaluation-model-assisted-spec-definition-v1.json",
  "evaluation-model-assurance-assessment-definition-v1.json",
  "evaluation-model-assurance-definition-v1.json",
  "evaluation-model-qualification-report-definition-v1.json",
  "evaluation-model-qualification-suite-definition-v1.json",
].flatMap(
  (file) =>
    (
      JSON.parse(
        readFileSync(
          new URL(`../../../packages/contracts/vectors/${file}`, import.meta.url),
          "utf8",
        ),
      ) as { readonly vectors: readonly StoredVector[] }
    ).vectors,
);

function kindOf(vector: StoredVector): ModelAssuranceRecordKind {
  return vector.kind === "model_assisted_evaluator_spec" ? "model_assisted_evaluator" : vector.kind;
}

function vector(kind: ModelAssuranceRecordKind): StoredVector {
  const value = vectors.find((candidate) => kindOf(candidate) === kind);
  if (!value) throw new Error(`Expected ${kind} vector`);
  return value;
}

function receipt(kind: ModelAssuranceRecordKind): Record<string, unknown> {
  switch (kind) {
    case "model_evaluator_profile":
      return { publishedAt: "2026-09-01T23:59:59.000Z", publishedByPrincipalId: "usr_sdk" };
    case "model_assisted_evaluator":
      return { publishedAt: "2026-09-02T00:04:59.000Z", publishedByPrincipalId: "usr_sdk" };
    case "independence_declaration":
      return { recordedAt: "2026-09-02T00:10:01.000Z" };
    case "calibration_report":
      return { recordedAt: "2026-09-02T00:20:01.000Z" };
    case "blinded_evaluation_plan":
      return { publishedAt: "2026-09-02T00:29:59.000Z", publishedByPrincipalId: "usr_sdk" };
    case "blinded_evaluation_result":
      return { recordedAt: "2026-09-02T00:45:02.000Z", recordedByPrincipalId: "wrk_sdk" };
    case "independent_critique":
      return { recordedAt: "2026-09-02T01:01:01.000Z", recordedByPrincipalId: "wrk_sdk" };
    case "human_review_protocol":
      return { publishedAt: "2026-09-02T01:59:59.000Z", publishedByPrincipalId: "usr_sdk" };
    case "human_reviewer_independence":
      return { recordedAt: "2026-09-02T02:30:01.000Z" };
    case "human_review_record":
      return { recordedAt: "2026-09-02T03:30:01.000Z" };
    case "model_qualification_suite":
      return { publishedAt: "2026-09-02T03:59:59.000Z", publishedByPrincipalId: "usr_sdk" };
    case "model_qualification_report":
      return { recordedAt: "2026-09-02T05:30:01.000Z" };
    case "model_assurance_assessment":
      return { recordedAt: "2026-09-02T06:00:01.000Z" };
  }
}

function storedRecord(value: StoredVector): Record<string, unknown> {
  return {
    ...structuredClone(value.input.definition),
    ...receipt(kindOf(value)),
    definitionSha256: value.sha256,
    schemaVersion: "0.1",
    scope: value.input.scope,
  };
}

const idFields: Record<ModelAssuranceRecordKind, string> = {
  blinded_evaluation_plan: "blindedPlanVersionId",
  blinded_evaluation_result: "resultId",
  calibration_report: "calibrationReportId",
  human_review_protocol: "protocolVersionId",
  human_review_record: "reviewId",
  human_reviewer_independence: "declarationId",
  independence_declaration: "independenceDeclarationId",
  independent_critique: "critiqueId",
  model_assisted_evaluator: "evaluatorVersionId",
  model_assurance_assessment: "assessmentExtensionId",
  model_evaluator_profile: "modelProfileVersionId",
  model_qualification_report: "reportId",
  model_qualification_suite: "suiteVersionId",
};

function storedId(kind: ModelAssuranceRecordKind, record: Record<string, unknown>): string {
  const value = record[idFields[kind]];
  if (typeof value !== "string") throw new Error(`Expected ${kind} identifier`);
  return value;
}

const profileVector = vector("model_evaluator_profile");
const critiqueVector = vector("independent_critique");
const reviewVector = vector("human_review_record");
const assessmentVector = vector("model_assurance_assessment");
const profile = storedRecord(profileVector);
const critique = storedRecord(critiqueVector);
const review = storedRecord(reviewVector);
const assessment = storedRecord(assessmentVector);
const assessmentInput = structuredClone(assessmentVector.input.definition);
Reflect.deleteProperty(assessmentInput, "eligibility");
Reflect.deleteProperty(assessmentInput, "evaluatedAt");
Reflect.deleteProperty(assessmentInput, "reasons");

const requestId = "req_model_assurance_sdk";
const successHeaders = {
  "cache-control": "private, no-store",
  "content-type": "application/json; charset=utf-8",
};

function jsonResponse(
  body: unknown,
  status = 200,
  headers: HeadersInit = successHeaders,
): Response {
  return new Response(JSON.stringify(body), { headers, status });
}

function mutationResponse(
  kind: ModelAssuranceRecordKind,
  record: unknown,
  created = true,
): Response {
  return jsonResponse({ created, requestId, result: { kind, record } }, created ? 201 : 200);
}

function developmentClient(fetch: typeof globalThis.fetch) {
  return new ProofStackModelAssuranceClient({
    authentication: { mode: "development" },
    endpoint: "http://127.0.0.1:3010/base?ignored=true#fragment",
    environmentId: profileVector.input.scope.environmentId,
    fetch,
    projectId: profileVector.input.scope.projectId,
  });
}

describe("ProofStackModelAssuranceClient", () => {
  it("reads and independently verifies all 13 immutable record kinds", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    for (const item of vectors) {
      fetch.mockResolvedValueOnce(
        jsonResponse({
          requestId,
          result: { kind: kindOf(item), record: storedRecord(item) },
        }),
      );
    }
    const client = developmentClient(fetch);

    for (const item of vectors) {
      const kind = kindOf(item);
      const record = storedRecord(item);
      await expect(
        client.readRecord({ kind, recordId: storedId(kind, record) }),
        kind,
      ).resolves.toMatchObject({ result: { kind } });
    }
    expect(fetch).toHaveBeenCalledTimes(13);
  });

  it("crosses each authority-specific exact route and verifies its response", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(mutationResponse("model_evaluator_profile", profile))
      .mockResolvedValueOnce(mutationResponse("independent_critique", critique))
      .mockResolvedValueOnce(mutationResponse("human_review_record", review))
      .mockResolvedValueOnce(mutationResponse("model_assurance_assessment", assessment));
    const client = developmentClient(fetch);

    await client.publishDefinition({
      recordId: storedId("model_evaluator_profile", profile),
      request: {
        definition: profileVector.input.definition as never,
        kind: "model_evaluator_profile",
      },
    });
    await client.recordExecution({
      recordId: storedId("independent_critique", critique),
      request: {
        definition: critiqueVector.input.definition as never,
        kind: "independent_critique",
      },
    });
    await client.recordHumanReview({
      recordId: storedId("human_review_record", review),
      request: {
        definition: reviewVector.input.definition as never,
        kind: "human_review_record",
      },
    });
    await client.createAssessment({
      recordId: storedId("model_assurance_assessment", assessment),
      request: { definition: assessmentInput as never, kind: "model_assurance_assessment" },
    });

    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
      "http://127.0.0.1:3010/base/v1/projects/prj_assurance/environments/env_assurance/model-assurance/definitions/mpv_safety_v1",
      "http://127.0.0.1:3010/base/v1/projects/prj_assurance/environments/env_assurance/model-assurance/executions/crq_observation_safety_v1",
      "http://127.0.0.1:3010/base/v1/projects/prj_assurance/environments/env_assurance/model-assurance/human-reviews/hrr_agent_safety_reviewer_one",
      "http://127.0.0.1:3010/base/v1/projects/prj_assurance/environments/env_assurance/model-assurance/assessments/maa_agent_safety_v1",
    ]);
  });

  it("enforces user, human, and workload client boundaries before network access", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const workload = new ProofStackModelAssuranceClient({
      authentication: { apiKey: `psk_v1_${"A".repeat(12)}_${"B".repeat(42)}E`, mode: "workload" },
      endpoint: "https://proofstack.example",
      environmentId: profileVector.input.scope.environmentId,
      fetch,
      projectId: profileVector.input.scope.projectId,
    });
    await expect(
      workload.publishDefinition({
        recordId: "mpv_safety_v1",
        request: {
          definition: profileVector.input.definition as never,
          kind: "model_evaluator_profile",
        },
      }),
    ).rejects.toThrow(/not workload-delegable/);
    await expect(
      workload.recordHumanReview({
        recordId: "hrr_observation_safety_v1",
        request: {
          definition: reviewVector.input.definition as never,
          kind: "human_review_record",
        },
      }),
    ).rejects.toThrow(/not workload-delegable/);

    const browser = new ProofStackModelAssuranceClient({
      authentication: { csrfToken: `psc_v1_${"A".repeat(42)}E`, mode: "browser" },
      endpoint: "https://proofstack.example",
      environmentId: profileVector.input.scope.environmentId,
      fetch,
      projectId: profileVector.input.scope.projectId,
    });
    await expect(
      browser.recordExecution({
        recordId: "crq_observation_safety_v1",
        request: {
          definition: critiqueVector.input.definition as never,
          kind: "independent_critique",
        },
      }),
    ).rejects.toThrow(/requires workload authority/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects tampering, redirects, missing cache boundaries, and stable problem responses", async () => {
    const tampered = { ...profile, knownLimitations: ["Tampered after publication"] };
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          requestId,
          result: { kind: "model_evaluator_profile", record: tampered },
        }),
      )
      .mockResolvedValueOnce(
        new Response(null, { headers: { location: "https://evil.test" }, status: 302 }),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          { requestId, result: { kind: "model_evaluator_profile", record: profile } },
          200,
          { "content-type": "application/json" },
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          {
            code: "model_assurance_record_not_found",
            detail: "missing",
            requestId,
            status: 404,
            title: "Not found",
            type: "https://proofstack.dev/problems/model-assurance-record-not-found",
          },
          404,
        ),
      );
    const client = developmentClient(fetch);
    const input = { kind: "model_evaluator_profile" as const, recordId: "mpv_safety_v1" };

    await expect(client.readRecord(input)).rejects.toThrow(/invalid public definition digest/);
    await expect(client.readRecord(input)).rejects.toThrow(/permit 0 redirects/);
    await expect(client.readRecord(input)).rejects.toThrow(/no-store/);
    await expect(client.readRecord(input)).rejects.toBeInstanceOf(ProofStackProblemError);
  });

  it("validates endpoint, authentication, identifiers, and transport limits locally", async () => {
    for (const endpoint of [
      "relative",
      "ftp://proofstack.example",
      "https://user:secret@proofstack.example",
    ]) {
      expect(
        () =>
          new ProofStackModelAssuranceClient({
            authentication: {
              mode: "workload",
              apiKey: `psk_v1_${"A".repeat(12)}_${"B".repeat(42)}E`,
            },
            endpoint,
            environmentId: "env_assurance",
            projectId: "prj_assurance",
          }),
      ).toThrow(ProofStackApiError);
    }
    expect(
      () =>
        new ProofStackModelAssuranceClient({
          authentication: { mode: "development" },
          endpoint: "http://proofstack.example",
          environmentId: "env_assurance",
          projectId: "prj_assurance",
        }),
    ).toThrow(ProofStackApiError);
    expect(
      () =>
        new ProofStackModelAssuranceClient({
          authentication: { apiKey: "invalid", mode: "workload" },
          endpoint: "https://proofstack.example",
          environmentId: "env_assurance",
          projectId: "prj_assurance",
        }),
    ).toThrow(/API key/);
    expect(
      () =>
        new ProofStackModelAssuranceClient({
          authentication: { mode: "development" },
          endpoint: "http://127.0.0.1:3010",
          environmentId: "INVALID",
          projectId: "prj_assurance",
        }),
    ).toThrow(/environmentId/);
    expect(
      () =>
        new ProofStackModelAssuranceClient({
          authentication: { csrfToken: "invalid", mode: "browser" },
          endpoint: "https://proofstack.example",
          environmentId: "env_assurance",
          projectId: "prj_assurance",
        }),
    ).toThrow(/CSRF/);
    for (const limits of [{ timeoutMs: 0 }, { maxResponseBytes: 0 }]) {
      expect(
        () =>
          new ProofStackModelAssuranceClient({
            authentication: { mode: "development" },
            endpoint: "http://127.0.0.1:3010",
            environmentId: "env_assurance",
            projectId: "prj_assurance",
            ...limits,
          }),
      ).toThrow(ProofStackApiError);
    }
  });

  it("fails closed across malformed, oversized, unexpected, and unavailable transports", async () => {
    const oversizedHeaders = {
      ...successHeaders,
      "content-length": "1025",
    };
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response("{", { headers: successHeaders, status: 200 }))
      .mockResolvedValueOnce(new Response("x", { headers: oversizedHeaders, status: 200 }))
      .mockResolvedValueOnce(jsonResponse({}, 202))
      .mockResolvedValueOnce(
        new Response("{}", { headers: { "cache-control": "no-store" }, status: 200 }),
      )
      .mockResolvedValueOnce(jsonResponse({}, 200))
      .mockRejectedValueOnce(new Error("offline"));
    const client = new ProofStackModelAssuranceClient({
      authentication: { mode: "development" },
      endpoint: "http://127.0.0.1:3010",
      environmentId: "env_assurance",
      fetch,
      maxResponseBytes: 1024,
      projectId: "prj_assurance",
    });
    const input = { kind: "model_evaluator_profile" as const, recordId: "mpv_safety_v1" };

    await expect(client.readRecord(input)).rejects.toThrow(/invalid JSON/);
    await expect(client.readRecord(input)).rejects.toThrow(/exceeded 1024 bytes/);
    await expect(client.readRecord(input)).rejects.toThrow(/unexpected HTTP 202/);
    await expect(client.readRecord(input)).rejects.toThrow(/media type/);
    await expect(client.readRecord(input)).rejects.toThrow(/published model-assurance contract/);
    await expect(client.readRecord(input)).rejects.toThrow(/request failed/);
  });

  it("rejects malformed mutations and inconsistent idempotency status before trust", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(
      jsonResponse(
        {
          created: false,
          requestId,
          result: { kind: "model_evaluator_profile", record: profile },
        },
        201,
      ),
    );
    const client = developmentClient(fetch);
    await expect(
      client.publishDefinition({
        recordId: "mpv_safety_v1",
        request: { definition: {}, kind: "model_evaluator_profile" } as never,
      }),
    ).rejects.toThrow(/local validation/);
    await expect(
      client.publishDefinition({
        recordId: "mpv_safety_v1",
        request: {
          definition: profileVector.input.definition as never,
          kind: "model_evaluator_profile",
        },
      }),
    ).rejects.toThrow(/inconsistent/);
    expect(fetch).toHaveBeenCalledOnce();
  });
});
