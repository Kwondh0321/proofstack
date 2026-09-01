import { readFileSync } from "node:fs";
import {
  AssessmentDefinitionSchema,
  AssessmentSchema,
  CriterionSetDefinitionSchema,
  CriterionSetSchema,
  CriterionSetStatusDefinitionSchema,
  CriterionSetStatusRecordSchema,
  type EvaluationRecordKind,
  EvaluationRunDefinitionSchema,
  EvaluationRunSchema,
  type EvidenceScope,
} from "@proofstack/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  MAX_EVALUATION_CONTROL_RESPONSE_BYTES,
  ProofStackEvaluationClient,
} from "./evaluation-client.js";
import { ProofStackApiError, ProofStackProblemError } from "./regression-client.js";

interface StoredVector {
  readonly input: {
    readonly definition: unknown;
    readonly scope: EvidenceScope;
  };
  readonly kind: EvaluationRecordKind;
  readonly sha256: string;
}

const vectors = [
  "evaluation-source-definition-v1.json",
  "evaluation-criteria-definition-v1.json",
  "evaluation-spec-definition-v1.json",
  "evaluation-qualification-definition-v1.json",
  "evaluation-run-definition-v1.json",
  "evaluation-assessment-definition-v1.json",
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

function vector(kind: EvaluationRecordKind): StoredVector {
  const result = vectors.find((candidate) => candidate.kind === kind);
  if (!result) throw new Error(`Missing evaluation vector for ${kind}`);
  return result;
}

function receipt(kind: EvaluationRecordKind): Record<string, unknown> {
  const principalId = "usr_evaluation_sdk";
  const timestamp = "2026-09-02T02:00:00.000Z";
  switch (kind) {
    case "aggregation_policy":
    case "criterion_set":
    case "evaluator_spec":
    case "oracle_spec":
    case "qualification_fixture_set":
      return { publishedAt: timestamp, publishedByPrincipalId: principalId };
    case "assessment":
    case "evaluation_aggregate":
    case "evaluation_run":
      return { createdAt: timestamp, createdByPrincipalId: principalId };
    case "criterion_set_status":
    case "discovery_record":
    case "evaluation_run_result":
      return { recordedAt: timestamp, recordedByPrincipalId: principalId };
    case "evaluation_run_rejection":
      return { recordedAt: timestamp, requestedByPrincipalId: principalId };
    case "qualification_report":
      return { executedByPrincipalId: principalId, recordedAt: timestamp };
    case "raw_observation":
      return { recordedAt: timestamp };
    case "source_review":
      return {
        reviewedAt: timestamp,
        reviewedByPrincipalId: principalId,
        reviewerRole: "Independent SDK verification reviewer",
      };
    case "source_snapshot":
      return { publishedByPrincipalId: principalId, recordedAt: timestamp };
  }
}

function storedRecord(value: StoredVector): Record<string, unknown> {
  return {
    ...(structuredClone(value.input.definition) as Record<string, unknown>),
    ...receipt(value.kind),
    definitionSha256: value.sha256,
    schemaVersion: "0.1",
    scope: value.input.scope,
  };
}

function storedRecordId(kind: EvaluationRecordKind, record: Record<string, unknown>): string {
  const keys: Record<EvaluationRecordKind, string> = {
    aggregation_policy: "policyVersionId",
    assessment: "assessmentId",
    criterion_set: "criterionSetVersionId",
    criterion_set_status: "statusRecordId",
    discovery_record: "discoveryId",
    evaluation_aggregate: "aggregateId",
    evaluation_run: "evaluationRunId",
    evaluation_run_rejection: "rejectionId",
    evaluation_run_result: "resultId",
    evaluator_spec: "evaluatorVersionId",
    oracle_spec: "oracleVersionId",
    qualification_fixture_set: "fixtureSetVersionId",
    qualification_report: "qualificationReportId",
    raw_observation: "observationId",
    source_review: "sourceReviewId",
    source_snapshot: "sourceSnapshotId",
  };
  const value = record[keys[kind]];
  if (typeof value !== "string") throw new Error(`Stored ${kind} vector omitted its identifier`);
  return value;
}

const criterionVector = vector("criterion_set");
const statusVector = vector("criterion_set_status");
const runVector = vector("evaluation_run");
const assessmentVector = vector("assessment");
const criterionDefinition = CriterionSetDefinitionSchema.parse(criterionVector.input.definition);
const statusDefinition = CriterionSetStatusDefinitionSchema.parse(statusVector.input.definition);
const runDefinition = EvaluationRunDefinitionSchema.parse(runVector.input.definition);
const assessmentDefinition = AssessmentDefinitionSchema.parse(assessmentVector.input.definition);
const criterion = CriterionSetSchema.parse({
  ...criterionDefinition,
  definitionSha256: criterionVector.sha256,
  publishedAt: "2026-09-02T02:00:00.000Z",
  publishedByPrincipalId: "usr_evaluation_sdk",
  schemaVersion: "0.1",
  scope: criterionVector.input.scope,
});
const statusRecord = CriterionSetStatusRecordSchema.parse({
  ...statusDefinition,
  definitionSha256: statusVector.sha256,
  recordedAt: "2026-09-02T02:00:01.000Z",
  recordedByPrincipalId: "usr_evaluation_sdk",
  schemaVersion: "0.1",
  scope: statusVector.input.scope,
});
const run = EvaluationRunSchema.parse({
  ...runDefinition,
  createdAt: "2026-09-02T02:00:02.000Z",
  createdByPrincipalId: "usr_evaluation_sdk",
  definitionSha256: runVector.sha256,
  schemaVersion: "0.1",
  scope: runVector.input.scope,
});
const assessment = AssessmentSchema.parse({
  ...assessmentDefinition,
  createdAt: "2026-09-02T02:00:03.000Z",
  createdByPrincipalId: "usr_evaluation_sdk",
  definitionSha256: assessmentVector.sha256,
  schemaVersion: "0.1",
  scope: assessmentVector.input.scope,
});

const requestId = "req_evaluation_sdk";
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

function mutationResponse(kind: EvaluationRecordKind, record: unknown, created = true): Response {
  return jsonResponse({ created, requestId, result: { kind, record } }, created ? 201 : 200);
}

function developmentClient(fetch: typeof globalThis.fetch, overrides = {}) {
  return new ProofStackEvaluationClient({
    authentication: { mode: "development" },
    endpoint: "http://127.0.0.1:3010/base?ignored=true#fragment",
    environmentId: criterion.scope.environmentId,
    fetch,
    projectId: criterion.scope.projectId,
    ...overrides,
  });
}

describe("ProofStackEvaluationClient", () => {
  it("reads and verifies all 16 immutable record kinds", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    for (const item of vectors) {
      fetch.mockResolvedValueOnce(
        jsonResponse({ requestId, result: { kind: item.kind, record: storedRecord(item) } }),
      );
    }
    const client = developmentClient(fetch);

    for (const item of vectors) {
      const record = storedRecord(item);
      await expect(
        client.readRecord({ kind: item.kind, recordId: storedRecordId(item.kind, record) }),
        item.kind,
      ).resolves.toMatchObject({ result: { kind: item.kind } });
    }
    expect(fetch).toHaveBeenCalledTimes(16);
  });

  it("crosses every public exact route and independently verifies responses", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(mutationResponse("criterion_set", criterion))
      .mockResolvedValueOnce(mutationResponse("criterion_set_status", statusRecord))
      .mockResolvedValueOnce(mutationResponse("evaluation_run", run))
      .mockResolvedValueOnce(mutationResponse("assessment", assessment))
      .mockResolvedValueOnce(
        jsonResponse({ requestId, result: { kind: "criterion_set", record: criterion } }),
      );
    const client = developmentClient(fetch);

    await expect(
      client.publishDefinition({
        recordId: criterion.criterionSetVersionId,
        request: { definition: criterionDefinition, kind: "criterion_set" },
      }),
    ).resolves.toMatchObject({ created: true, result: { kind: "criterion_set" } });
    await expect(
      client.recordCriterionSetStatus({
        recordId: statusRecord.statusRecordId,
        request: { definition: statusDefinition, kind: "criterion_set_status" },
      }),
    ).resolves.toMatchObject({ result: { kind: "criterion_set_status" } });
    await expect(
      client.recordRunDecision({
        recordId: run.evaluationRunId,
        request: { definition: runDefinition, kind: "evaluation_run" },
      }),
    ).resolves.toMatchObject({ result: { kind: "evaluation_run" } });
    await expect(
      client.createAssessment({
        recordId: assessment.assessmentId,
        request: { definition: assessmentDefinition, kind: "assessment" },
      }),
    ).resolves.toMatchObject({ result: { kind: "assessment" } });
    await expect(
      client.readRecord({ kind: "criterion_set", recordId: criterion.criterionSetVersionId }),
    ).resolves.toMatchObject({ result: { record: { definitionSha256: criterionVector.sha256 } } });

    expect(fetch).toHaveBeenCalledTimes(5);
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
      `http://127.0.0.1:3010/base/v1/projects/prj_local/environments/env_local/evaluations/definitions/${criterion.criterionSetVersionId}`,
      `http://127.0.0.1:3010/base/v1/projects/prj_local/environments/env_local/evaluations/criterion-set-statuses/${statusRecord.statusRecordId}`,
      `http://127.0.0.1:3010/base/v1/projects/prj_local/environments/env_local/evaluations/run-decisions/${run.evaluationRunId}`,
      `http://127.0.0.1:3010/base/v1/projects/prj_local/environments/env_local/evaluations/assessments/${assessment.assessmentId}`,
      `http://127.0.0.1:3010/base/v1/projects/prj_local/environments/env_local/evaluations/records/criterion_set/${criterion.criterionSetVersionId}`,
    ]);
    for (const [, init] of fetch.mock.calls) {
      expect(init).toMatchObject({ credentials: "omit", redirect: "manual" });
    }
    expect(fetch.mock.calls[0]?.[1]?.body).toBe(
      JSON.stringify({ definition: criterionDefinition, kind: "criterion_set" }),
    );
  });

  it("preserves browser CSRF and allows workloads only on delegated run and read operations", async () => {
    const browserFetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(mutationResponse("criterion_set", criterion));
    const browser = new ProofStackEvaluationClient({
      authentication: { csrfToken: `psc_v1_${"A".repeat(42)}E`, mode: "browser" },
      endpoint: "https://proofstack.example",
      environmentId: criterion.scope.environmentId,
      fetch: browserFetch,
      projectId: criterion.scope.projectId,
    });
    await browser.publishDefinition({
      recordId: criterion.criterionSetVersionId,
      request: { definition: criterionDefinition, kind: "criterion_set" },
    });
    expect(browserFetch).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({
        credentials: "include",
        headers: expect.objectContaining({
          "x-proofstack-csrf": expect.stringMatching(/^psc_v1_/),
        }),
      }),
    );

    const workloadFetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(mutationResponse("evaluation_run", run))
      .mockResolvedValueOnce(
        jsonResponse({ requestId, result: { kind: "evaluation_run", record: run } }),
      );
    const apiKey = `psk_v1_${"A".repeat(12)}_${"B".repeat(42)}E`;
    const workload = new ProofStackEvaluationClient({
      authentication: { apiKey, mode: "workload" },
      endpoint: "https://proofstack.example",
      environmentId: run.scope.environmentId,
      fetch: workloadFetch,
      projectId: run.scope.projectId,
    });
    await workload.recordRunDecision({
      recordId: run.evaluationRunId,
      request: { definition: runDefinition, kind: "evaluation_run" },
    });
    await workload.readRecord({ kind: "evaluation_run", recordId: run.evaluationRunId });
    await expect(
      workload.publishDefinition({
        recordId: criterion.criterionSetVersionId,
        request: { definition: criterionDefinition, kind: "criterion_set" },
      }),
    ).rejects.toThrow(/not workload-delegable/);
    await expect(
      workload.createAssessment({
        recordId: assessment.assessmentId,
        request: { definition: assessmentDefinition, kind: "assessment" },
      }),
    ).rejects.toThrow(/not workload-delegable/);
    expect(workloadFetch).toHaveBeenCalledTimes(2);
    for (const [, init] of workloadFetch.mock.calls) {
      expect(init?.headers).toMatchObject({ authorization: `Bearer ${apiKey}` });
    }
  });

  it.each([
    [
      "definition digest",
      () => ({ ...criterion, definitionSha256: "0".repeat(64) }),
      /invalid public definition digest/,
    ],
    [
      "resource identity",
      () => ({ ...criterion, criterionSetVersionId: "csv_other" }),
      /identity that contradicts/,
    ],
    [
      "scope",
      () => ({ ...criterion, scope: { ...criterion.scope, projectId: "prj_other" } }),
      /scope that contradicts/,
    ],
  ])("rejects a response with a contradictory %s", async (_name, record, expected) => {
    const client = developmentClient(
      vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(
          jsonResponse({ requestId, result: { kind: "criterion_set", record: record() } }),
        ),
    );

    await expect(
      client.readRecord({ kind: "criterion_set", recordId: criterion.criterionSetVersionId }),
    ).rejects.toThrow(expected);
  });

  it("rejects a mutation response that contradicts the requested definition or created status", async () => {
    const changedDefinition = { ...criterionDefinition, changeRationale: "Contradictory response" };
    const contradictory = developmentClient(
      vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(mutationResponse("criterion_set", criterion)),
    );
    await expect(
      contradictory.publishDefinition({
        recordId: criterion.criterionSetVersionId,
        request: { definition: changedDefinition, kind: "criterion_set" },
      }),
    ).rejects.toThrow(/invalid public definition digest/);

    const inconsistent = developmentClient(
      vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(
          jsonResponse(
            { created: true, requestId, result: { kind: "criterion_set", record: criterion } },
            200,
          ),
        ),
    );
    await expect(
      inconsistent.publishDefinition({
        recordId: criterion.criterionSetVersionId,
        request: { definition: criterionDefinition, kind: "criterion_set" },
      }),
    ).rejects.toThrow(/inconsistent/);
  });

  it("fails closed on redirects, cacheable responses, oversized bodies, and stable problems", async () => {
    const redirect = developmentClient(
      vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(null, { status: 302 })),
    );
    await expect(
      redirect.readRecord({ kind: "criterion_set", recordId: criterion.criterionSetVersionId }),
    ).rejects.toThrow(/permit 0 redirects/);

    const cacheable = developmentClient(
      vi.fn<typeof globalThis.fetch>().mockResolvedValue(
        jsonResponse({ requestId, result: { kind: "criterion_set", record: criterion } }, 200, {
          "content-type": "application/json",
        }),
      ),
    );
    await expect(
      cacheable.readRecord({ kind: "criterion_set", recordId: criterion.criterionSetVersionId }),
    ).rejects.toThrow(/no-store/);

    const oversized = developmentClient(
      vi.fn<typeof globalThis.fetch>().mockResolvedValue(
        new Response("{}", {
          headers: {
            "content-length": String(MAX_EVALUATION_CONTROL_RESPONSE_BYTES + 1),
            "content-type": "application/json",
          },
        }),
      ),
    );
    await expect(
      oversized.readRecord({ kind: "criterion_set", recordId: criterion.criterionSetVersionId }),
    ).rejects.toThrow(/exceeded/);

    const problem = developmentClient(
      vi.fn<typeof globalThis.fetch>().mockResolvedValue(
        jsonResponse(
          {
            code: "evaluation_record_not_found",
            detail: "Record unavailable",
            requestId,
            status: 404,
            title: "Evaluation record not found",
            type: "https://proofstack.dev/problems/evaluation-record-not-found",
          },
          404,
        ),
      ),
    );
    await expect(
      problem.readRecord({ kind: "criterion_set", recordId: criterion.criterionSetVersionId }),
    ).rejects.toBeInstanceOf(ProofStackProblemError);
  });

  it("validates locally and exposes no worker-owned write methods", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const client = developmentClient(fetch);

    await expect(
      client.readRecord({ kind: "criterion_set", recordId: "INVALID" }),
    ).rejects.toBeInstanceOf(ProofStackApiError);
    await expect(
      client.publishDefinition({
        recordId: criterion.criterionSetVersionId,
        request: { definition: runDefinition, kind: "evaluation_run" } as never,
      }),
    ).rejects.toThrow(/local validation/);
    expect(fetch).not.toHaveBeenCalled();
    const publicSurface = client as unknown as Record<string, unknown>;
    const method = (name: string) => publicSurface[name];
    expect(method("recordRawObservation")).toBeUndefined();
    expect(method("recordQualificationReport")).toBeUndefined();
    expect(method("createAggregate")).toBeUndefined();
  });
});
