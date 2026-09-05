import { readFileSync } from "node:fs";
import {
  ComparisonDefinitionRecordSchema,
  ComparisonEvidenceSnapshotSchema,
  type ComparisonRecordKind,
  ComparisonResultSchema,
  CreateComparisonEvidenceSnapshotRequestSchema,
  DeriveComparisonResultRequestSchema,
  type EvidenceScope,
  PublishComparisonDefinitionRequestSchema,
} from "@proofstack/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  MAX_COMPARISON_CONTROL_REDIRECTS,
  MAX_COMPARISON_CONTROL_RESPONSE_BYTES,
  ProofStackComparisonClient,
} from "./comparison-client.js";
import { ProofStackApiError, ProofStackProblemError } from "./regression-client.js";

interface StoredVector {
  readonly input: {
    readonly definition: Record<string, unknown>;
    readonly scope: EvidenceScope;
  };
  readonly kind: ComparisonRecordKind;
  readonly sha256: string;
}

const vectors = [
  "evaluation-comparison-definition-v1.json",
  "evaluation-comparison-snapshot-definition-v1.json",
  "evaluation-comparison-result-definition-v1.json",
].map((file) => {
  const document = JSON.parse(
    readFileSync(new URL(`../../../packages/contracts/vectors/${file}`, import.meta.url), "utf8"),
  ) as { readonly vectors: readonly StoredVector[] };
  const first = document.vectors[0];
  if (!first) throw new Error(`Expected ${file}`);
  return first;
});

function vector(kind: ComparisonRecordKind): StoredVector {
  const result = vectors.find((candidate) => candidate.kind === kind);
  if (!result) throw new Error(`Missing comparison vector for ${kind}`);
  return result;
}

const createdAt = "2026-09-04T00:00:00.000Z";
const createdByPrincipalId = "usr_comparison_sdk";

const definitionVector = vector("comparison_definition");
const snapshotVector = vector("comparison_evidence_snapshot");
const resultVector = vector("comparison_result");

const definitionRecord = ComparisonDefinitionRecordSchema.parse({
  ...structuredClone(definitionVector.input.definition),
  createdAt,
  createdByPrincipalId,
  definitionSha256: definitionVector.sha256,
  schemaVersion: "0.7",
  scope: definitionVector.input.scope,
});
const snapshotRecord = ComparisonEvidenceSnapshotSchema.parse({
  ...structuredClone(snapshotVector.input.definition),
  createdAt,
  createdByPrincipalId,
  definitionSha256: snapshotVector.sha256,
  schemaVersion: "0.3",
  scope: snapshotVector.input.scope,
});
const resultRecord = ComparisonResultSchema.parse({
  ...structuredClone(resultVector.input.definition),
  createdAt,
  createdByPrincipalId,
  definitionSha256: resultVector.sha256,
  schemaVersion: "0.6",
  scope: resultVector.input.scope,
});

const {
  comparisonId: definitionComparisonId,
  predecessor: definitionPredecessor,
  ...definitionRequestFields
} = definitionVector.input.definition;
if (typeof definitionComparisonId !== "string") {
  throw new Error("Comparison definition vector omitted comparisonId");
}
const definitionRequest = PublishComparisonDefinitionRequestSchema.parse({
  ...definitionRequestFields,
  ...(typeof definitionPredecessor === "object" && definitionPredecessor !== null
    ? {
        predecessorVersionId: Reflect.get(definitionPredecessor, "comparisonVersionId"),
      }
    : {}),
});
const snapshotRequest = CreateComparisonEvidenceSnapshotRequestSchema.parse({
  comparison: snapshotRecord.comparison,
  role: snapshotRecord.role,
  snapshotId: snapshotRecord.snapshotId,
});
const resultRequest = DeriveComparisonResultRequestSchema.parse({
  baselineSnapshot: resultRecord.baselineSnapshot,
  candidateSnapshot: resultRecord.candidateSnapshot,
  comparison: resultRecord.comparison,
  resultId: resultRecord.resultId,
});

const requestId = "req_comparison_sdk";
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

function mutationResponse(kind: ComparisonRecordKind, record: unknown, created = true): Response {
  return jsonResponse({ created, requestId, result: { kind, record } }, created ? 201 : 200);
}

function readResponse(kind: ComparisonRecordKind, record: unknown): Response {
  return jsonResponse({ requestId, result: { kind, record } });
}

function developmentClient(fetch: typeof globalThis.fetch, overrides = {}) {
  return new ProofStackComparisonClient({
    authentication: { mode: "development" },
    endpoint: "http://127.0.0.1:3010/base?ignored=true#fragment",
    environmentId: definitionRecord.scope.environmentId,
    fetch,
    projectId: definitionRecord.scope.projectId,
    ...overrides,
  });
}

describe("ProofStackComparisonClient", () => {
  it("crosses every exact comparison route and independently verifies all record kinds", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(mutationResponse("comparison_definition", definitionRecord))
      .mockResolvedValueOnce(mutationResponse("comparison_evidence_snapshot", snapshotRecord))
      .mockResolvedValueOnce(mutationResponse("comparison_result", resultRecord))
      .mockResolvedValueOnce(readResponse("comparison_definition", definitionRecord))
      .mockResolvedValueOnce(readResponse("comparison_evidence_snapshot", snapshotRecord))
      .mockResolvedValueOnce(readResponse("comparison_result", resultRecord));
    const client = developmentClient(fetch);

    await expect(
      client.publishDefinition({
        comparisonId: definitionComparisonId,
        request: definitionRequest,
      }),
    ).resolves.toMatchObject({ created: true, result: { kind: "comparison_definition" } });
    await expect(
      client.createEvidenceSnapshot({
        request: snapshotRequest,
        snapshotId: snapshotRecord.snapshotId,
      }),
    ).resolves.toMatchObject({ result: { kind: "comparison_evidence_snapshot" } });
    await expect(
      client.deriveResult({ request: resultRequest, resultId: resultRecord.resultId }),
    ).resolves.toMatchObject({ result: { kind: "comparison_result" } });
    await client.readRecord({
      kind: "comparison_definition",
      recordId: definitionRecord.comparisonVersionId,
    });
    await client.readRecord({
      kind: "comparison_evidence_snapshot",
      recordId: snapshotRecord.snapshotId,
    });
    await client.readRecord({ kind: "comparison_result", recordId: resultRecord.resultId });

    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
      `http://127.0.0.1:3010/base/v1/projects/${definitionRecord.scope.projectId}/environments/${definitionRecord.scope.environmentId}/comparisons/${definitionComparisonId}/definitions/${definitionRecord.comparisonVersionId}`,
      `http://127.0.0.1:3010/base/v1/projects/${definitionRecord.scope.projectId}/environments/${definitionRecord.scope.environmentId}/comparisons/evidence-snapshots/${snapshotRecord.snapshotId}`,
      `http://127.0.0.1:3010/base/v1/projects/${definitionRecord.scope.projectId}/environments/${definitionRecord.scope.environmentId}/comparisons/results/${resultRecord.resultId}`,
      `http://127.0.0.1:3010/base/v1/projects/${definitionRecord.scope.projectId}/environments/${definitionRecord.scope.environmentId}/comparisons/records/comparison_definition/${definitionRecord.comparisonVersionId}`,
      `http://127.0.0.1:3010/base/v1/projects/${definitionRecord.scope.projectId}/environments/${definitionRecord.scope.environmentId}/comparisons/records/comparison_evidence_snapshot/${snapshotRecord.snapshotId}`,
      `http://127.0.0.1:3010/base/v1/projects/${definitionRecord.scope.projectId}/environments/${definitionRecord.scope.environmentId}/comparisons/records/comparison_result/${resultRecord.resultId}`,
    ]);
    expect(fetch.mock.calls.slice(0, 3).map(([, init]) => init?.body)).toEqual([
      JSON.stringify(definitionRequest),
      JSON.stringify(snapshotRequest),
      JSON.stringify(resultRequest),
    ]);
    for (const [, init] of fetch.mock.calls) {
      expect(init).toMatchObject({ credentials: "omit", redirect: "manual" });
    }
  });

  it("sends browser CSRF only on mutations and never delegates management writes to workloads", async () => {
    const browserFetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(mutationResponse("comparison_definition", definitionRecord))
      .mockResolvedValueOnce(readResponse("comparison_definition", definitionRecord));
    const browser = new ProofStackComparisonClient({
      authentication: { csrfToken: `psc_v1_${"A".repeat(42)}E`, mode: "browser" },
      endpoint: "https://proofstack.example",
      environmentId: definitionRecord.scope.environmentId,
      fetch: browserFetch,
      projectId: definitionRecord.scope.projectId,
    });
    await browser.publishDefinition({
      comparisonId: definitionComparisonId,
      request: definitionRequest,
    });
    await browser.readRecord({
      kind: "comparison_definition",
      recordId: definitionRecord.comparisonVersionId,
    });
    expect(browserFetch.mock.calls[0]?.[1]).toMatchObject({
      credentials: "include",
      headers: expect.objectContaining({ "x-proofstack-csrf": expect.stringMatching(/^psc_v1_/) }),
    });
    expect(browserFetch.mock.calls[1]?.[1]?.headers).not.toHaveProperty("x-proofstack-csrf");

    const apiKey = `psk_v1_${"A".repeat(12)}_${"B".repeat(42)}E`;
    const workloadFetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(readResponse("comparison_result", resultRecord));
    const workload = new ProofStackComparisonClient({
      authentication: { apiKey, mode: "workload" },
      endpoint: "https://proofstack.example",
      environmentId: resultRecord.scope.environmentId,
      fetch: workloadFetch,
      projectId: resultRecord.scope.projectId,
    });
    await workload.readRecord({ kind: "comparison_result", recordId: resultRecord.resultId });
    await expect(
      workload.publishDefinition({
        comparisonId: definitionComparisonId,
        request: definitionRequest,
      }),
    ).rejects.toThrow(/not workload-delegable/);
    await expect(
      workload.createEvidenceSnapshot({
        request: snapshotRequest,
        snapshotId: snapshotRecord.snapshotId,
      }),
    ).rejects.toThrow(/not workload-delegable/);
    await expect(
      workload.deriveResult({ request: resultRequest, resultId: resultRecord.resultId }),
    ).rejects.toThrow(/not workload-delegable/);
    expect(workloadFetch).toHaveBeenCalledTimes(1);
    expect(workloadFetch.mock.calls[0]?.[1]?.headers).toMatchObject({
      authorization: `Bearer ${apiKey}`,
    });
  });

  it.each([
    [
      "definition digest",
      () => ({ ...definitionRecord, definitionSha256: "0".repeat(64) }),
      /invalid public definition digest/,
    ],
    [
      "resource identity",
      () => ({ ...definitionRecord, comparisonVersionId: "comparison_other_v1" }),
      /identity that contradicts/,
    ],
    [
      "scope",
      () => ({
        ...definitionRecord,
        scope: { ...definitionRecord.scope, projectId: "project_other" },
      }),
      /scope that contradicts/,
    ],
  ])("rejects a read response with a contradictory %s", async (_name, record, expected) => {
    const client = developmentClient(
      vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(readResponse("comparison_definition", record())),
    );
    await expect(
      client.readRecord({
        kind: "comparison_definition",
        recordId: definitionRecord.comparisonVersionId,
      }),
    ).rejects.toThrow(expected);
  });

  it("rejects mutation responses with contradictory lineage or creation status", async () => {
    const changedDefinition = {
      ...definitionRequest,
      description: "A caller request that the returned immutable record does not represent",
    };
    const definitionClient = developmentClient(
      vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(mutationResponse("comparison_definition", definitionRecord)),
    );
    await expect(
      definitionClient.publishDefinition({
        comparisonId: definitionComparisonId,
        request: changedDefinition,
      }),
    ).rejects.toThrow(/semantics that contradict the request/);

    const snapshotClient = developmentClient(
      vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(mutationResponse("comparison_evidence_snapshot", snapshotRecord)),
    );
    await expect(
      snapshotClient.createEvidenceSnapshot({
        request: { ...snapshotRequest, role: "candidate" },
        snapshotId: snapshotRecord.snapshotId,
      }),
    ).rejects.toThrow(/lineage that contradicts/);

    const resultClient = developmentClient(
      vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(mutationResponse("comparison_result", resultRecord)),
    );
    await expect(
      resultClient.deriveResult({
        request: {
          ...resultRequest,
          baselineSnapshot: {
            ...resultRequest.baselineSnapshot,
            snapshotId: "snapshot_other_baseline",
          },
        },
        resultId: resultRecord.resultId,
      }),
    ).rejects.toThrow(/lineage that contradicts/);

    const statusClient = developmentClient(
      vi.fn<typeof globalThis.fetch>().mockResolvedValue(
        jsonResponse(
          {
            created: true,
            requestId,
            result: { kind: "comparison_definition", record: definitionRecord },
          },
          200,
        ),
      ),
    );
    await expect(
      statusClient.publishDefinition({
        comparisonId: definitionComparisonId,
        request: definitionRequest,
      }),
    ).rejects.toThrow(/inconsistent/);
  });

  it("fails closed on redirects, cacheable or oversized responses, invalid JSON, and problems", async () => {
    const readDefinition = (client: ProofStackComparisonClient) =>
      client.readRecord({
        kind: "comparison_definition",
        recordId: definitionRecord.comparisonVersionId,
      });

    const redirect = developmentClient(
      vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(null, { status: 302 })),
    );
    await expect(readDefinition(redirect)).rejects.toThrow(
      `permit ${MAX_COMPARISON_CONTROL_REDIRECTS} redirects`,
    );

    const cacheable = developmentClient(
      vi.fn<typeof globalThis.fetch>().mockResolvedValue(
        jsonResponse(readResponse("comparison_definition", definitionRecord), 200, {
          "content-type": "application/json",
        }),
      ),
    );
    await expect(readDefinition(cacheable)).rejects.toThrow(/no-store/);

    const oversized = developmentClient(
      vi.fn<typeof globalThis.fetch>().mockResolvedValue(
        new Response("{}", {
          headers: {
            "content-length": String(MAX_COMPARISON_CONTROL_RESPONSE_BYTES + 1),
            "content-type": "application/json",
          },
        }),
      ),
    );
    await expect(readDefinition(oversized)).rejects.toThrow(/exceeded/);

    const oversizedStream = developmentClient(
      vi.fn<typeof globalThis.fetch>().mockResolvedValue(
        new Response("12345", {
          headers: { "content-type": "application/json" },
        }),
      ),
      { maxResponseBytes: 4 },
    );
    await expect(readDefinition(oversizedStream)).rejects.toThrow(/exceeded 4 bytes/);

    const invalidJson = developmentClient(
      vi.fn<typeof globalThis.fetch>().mockResolvedValue(
        new Response("not-json", {
          headers: successHeaders,
          status: 200,
        }),
      ),
    );
    await expect(readDefinition(invalidJson)).rejects.toThrow(/invalid JSON/);

    const wrongMediaType = developmentClient(
      vi.fn<typeof globalThis.fetch>().mockResolvedValue(
        new Response(JSON.stringify({ requestId }), {
          headers: { "cache-control": "no-store", "content-type": "text/plain" },
        }),
      ),
    );
    await expect(readDefinition(wrongMediaType)).rejects.toThrow(/unexpected media type/);

    const unexpectedStatus = developmentClient(
      vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(
          jsonResponse(
            { requestId, result: { kind: "comparison_definition", record: definitionRecord } },
            202,
          ),
        ),
    );
    await expect(readDefinition(unexpectedStatus)).rejects.toThrow(/unexpected HTTP 202/);

    const invalidContract = developmentClient(
      vi.fn<typeof globalThis.fetch>().mockResolvedValue(jsonResponse({ requestId })),
    );
    await expect(readDefinition(invalidContract)).rejects.toThrow(/published comparison contract/);

    const emptyBody = developmentClient(
      vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(new Response(null, { headers: successHeaders, status: 200 })),
    );
    await expect(readDefinition(emptyBody)).rejects.toThrow(/invalid JSON/);

    const problem = developmentClient(
      vi.fn<typeof globalThis.fetch>().mockResolvedValue(
        jsonResponse(
          {
            code: "comparison_record_not_found",
            detail: "Comparison record unavailable",
            requestId,
            status: 404,
            title: "Comparison record not found",
            type: "https://proofstack.dev/problems/comparison-record-not-found",
          },
          404,
        ),
      ),
    );
    await expect(readDefinition(problem)).rejects.toBeInstanceOf(ProofStackProblemError);

    const invalidProblemJson = developmentClient(
      vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(new Response("not-json", { headers: successHeaders, status: 500 })),
    );
    await expect(readDefinition(invalidProblemJson)).rejects.toMatchObject({ status: 500 });

    const invalidProblemContract = developmentClient(
      vi.fn<typeof globalThis.fetch>().mockResolvedValue(jsonResponse({ message: "no" }, 400)),
    );
    await expect(readDefinition(invalidProblemContract)).rejects.toMatchObject({ status: 400 });

    const wrongKind = developmentClient(
      vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(readResponse("comparison_result", resultRecord)),
    );
    await expect(readDefinition(wrongKind)).rejects.toThrow(/kind that contradicts/);
  });

  it("validates endpoints, authentication, options, identifiers, and request contracts locally", async () => {
    const common = {
      authentication: { mode: "development" } as const,
      environmentId: definitionRecord.scope.environmentId,
      fetch: vi.fn<typeof globalThis.fetch>(),
      projectId: definitionRecord.scope.projectId,
    };
    expect(() => new ProofStackComparisonClient({ ...common, endpoint: "relative" })).toThrow(
      /absolute URL/,
    );
    expect(
      () => new ProofStackComparisonClient({ ...common, endpoint: "ftp://127.0.0.1" }),
    ).toThrow(/HTTP or HTTPS/);
    expect(
      () => new ProofStackComparisonClient({ ...common, endpoint: "http://user:pass@127.0.0.1" }),
    ).toThrow(/embedded credentials/);
    expect(
      () => new ProofStackComparisonClient({ ...common, endpoint: "http://proofstack.example" }),
    ).toThrow(/loopback/);
    expect(
      () =>
        new ProofStackComparisonClient({
          ...common,
          endpoint: "https://proofstack.example",
        }),
    ).toThrow(/Development authentication/);
    expect(
      () =>
        new ProofStackComparisonClient({
          ...common,
          authentication: { csrfToken: "invalid", mode: "browser" },
          endpoint: "https://proofstack.example",
        }),
    ).toThrow(/CSRF token/);
    expect(
      () =>
        new ProofStackComparisonClient({
          ...common,
          authentication: { apiKey: "invalid", mode: "workload" },
          endpoint: "https://proofstack.example",
        }),
    ).toThrow(/API key/);
    expect(
      () =>
        new ProofStackComparisonClient({
          ...common,
          authentication: { mode: "invalid" } as never,
          endpoint: "https://proofstack.example",
        }),
    ).toThrow(/authentication mode is invalid/);
    expect(
      () =>
        new ProofStackComparisonClient({ ...common, endpoint: "http://localhost", timeoutMs: 0 }),
    ).toThrow(/timeoutMs/);
    expect(
      () =>
        new ProofStackComparisonClient({
          ...common,
          endpoint: "http://[::1]",
          maxResponseBytes: MAX_COMPARISON_CONTROL_RESPONSE_BYTES + 1,
        }),
    ).toThrow(/maxResponseBytes/);

    const fetch = vi.fn<typeof globalThis.fetch>();
    const client = developmentClient(fetch);
    await expect(
      client.readRecord({ kind: "comparison_definition", recordId: "INVALID" }),
    ).rejects.toBeInstanceOf(ProofStackApiError);
    await expect(
      client.readRecord({
        kind: "invalid" as never,
        recordId: definitionRecord.comparisonVersionId,
      }),
    ).rejects.toThrow(/kind failed local validation/);
    await expect(
      client.publishDefinition({ comparisonId: "INVALID", request: definitionRequest }),
    ).rejects.toThrow(/comparisonId failed local validation/);
    await expect(
      client.publishDefinition({
        comparisonId: definitionComparisonId,
        request: { ...definitionRequest, unknown: true } as never,
      }),
    ).rejects.toThrow(/publication failed local validation/);
    await expect(
      client.createEvidenceSnapshot({
        request: { ...snapshotRequest, unknown: true } as never,
        snapshotId: snapshotRecord.snapshotId,
      }),
    ).rejects.toThrow(/local validation/);
    await expect(
      client.deriveResult({ request: resultRequest, resultId: "INVALID" }),
    ).rejects.toThrow(/resultId failed local validation/);
    await expect(
      client.deriveResult({ request: resultRequest, resultId: "result_other" }),
    ).rejects.toThrow(/derivation failed local validation/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects construction when no fetch implementation exists", () => {
    vi.stubGlobal("fetch", undefined);
    try {
      expect(
        () =>
          new ProofStackComparisonClient({
            authentication: { mode: "development" },
            endpoint: "http://127.0.0.1",
            environmentId: definitionRecord.scope.environmentId,
            projectId: definitionRecord.scope.projectId,
          }),
      ).toThrow(/No fetch implementation/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("normalizes transport failures and abort-driven timeouts", async () => {
    const failed = developmentClient(
      vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error("socket failed")),
    );
    await expect(
      failed.readRecord({
        kind: "comparison_definition",
        recordId: definitionRecord.comparisonVersionId,
      }),
    ).rejects.toThrow(/request failed/);

    const abortingFetch = vi.fn<typeof globalThis.fetch>((_url, init) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    });
    const timedOut = developmentClient(abortingFetch, { timeoutMs: 1 });
    await expect(
      timedOut.readRecord({
        kind: "comparison_definition",
        recordId: definitionRecord.comparisonVersionId,
      }),
    ).rejects.toThrow(/timed out after 1ms/);
  });
});
