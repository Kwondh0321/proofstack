import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  ComparisonDefinitionRecordSchema,
  ComparisonEvidenceSnapshotSchema,
  type ComparisonRecordKind,
  ComparisonResultSchema,
  type EvidenceScope,
  encodeComparisonDefinition,
  encodeComparisonEvidenceSnapshotDefinition,
  encodeComparisonResultDefinition,
} from "@proofstack/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getComparisonView, MAX_COMPARISON_RESPONSE_BYTES } from "./proofstack-api.js";

interface StoredVector {
  readonly input: {
    readonly definition: Record<string, unknown>;
    readonly scope: EvidenceScope;
  };
  readonly kind: ComparisonRecordKind;
}

function vector(filename: string): StoredVector {
  const document = JSON.parse(
    readFileSync(
      new URL(`../../../packages/contracts/vectors/${filename}`, import.meta.url),
      "utf8",
    ),
  ) as { readonly vectors: readonly StoredVector[] };
  const first = document.vectors[0];
  if (!first) throw new Error(`Expected ${filename}`);
  return first;
}

const definitionVector = vector("evaluation-comparison-definition-v1.json");
const snapshotVector = vector("evaluation-comparison-snapshot-definition-v1.json");
const resultVector = vector("evaluation-comparison-result-definition-v1.json");
const scope = definitionVector.input.scope;
const createdAt = "2026-09-04T00:00:00.000Z";
const createdByPrincipalId = "usr_comparison_web";

function digest(
  kind: ComparisonRecordKind,
  definition: Record<string, unknown>,
  recordScope = scope,
): string {
  const input = { definition, scope: recordScope };
  const encoded =
    kind === "comparison_definition"
      ? encodeComparisonDefinition(input as never)
      : kind === "comparison_evidence_snapshot"
        ? encodeComparisonEvidenceSnapshotDefinition(input as never)
        : encodeComparisonResultDefinition(input as never);
  return createHash("sha256").update(encoded).digest("hex");
}

const definitionDigest = digest("comparison_definition", definitionVector.input.definition);
const definitionRecord = ComparisonDefinitionRecordSchema.parse({
  ...structuredClone(definitionVector.input.definition),
  createdAt,
  createdByPrincipalId,
  definitionSha256: definitionDigest,
  schemaVersion: "0.7",
  scope,
});
const comparisonReference = {
  comparisonId: definitionRecord.comparisonId,
  comparisonVersionId: definitionRecord.comparisonVersionId,
  definitionSha256: definitionRecord.definitionSha256,
};

function snapshotRecord(role: "baseline" | "candidate") {
  const definition = {
    ...structuredClone(snapshotVector.input.definition),
    comparison: comparisonReference,
    role,
    snapshotId: `snapshot_${role}_web`,
  };
  return ComparisonEvidenceSnapshotSchema.parse({
    ...definition,
    createdAt,
    createdByPrincipalId,
    definitionSha256: digest("comparison_evidence_snapshot", definition),
    schemaVersion: "0.3",
    scope,
  });
}

const baselineRecord = snapshotRecord("baseline");
const candidateRecord = snapshotRecord("candidate");

function resultRecord(overrides: Record<string, unknown> = {}, recordScope = scope) {
  const definition = {
    ...structuredClone(resultVector.input.definition),
    baselineSnapshot: {
      definitionSha256: baselineRecord.definitionSha256,
      role: "baseline",
      snapshotId: baselineRecord.snapshotId,
    },
    candidateSnapshot: {
      definitionSha256: candidateRecord.definitionSha256,
      role: "candidate",
      snapshotId: candidateRecord.snapshotId,
    },
    comparison: comparisonReference,
    resultId: "result_comparison_web",
    ...overrides,
  };
  return ComparisonResultSchema.parse({
    ...definition,
    createdAt,
    createdByPrincipalId,
    definitionSha256: digest("comparison_result", definition, recordScope),
    schemaVersion: "0.6",
    scope: recordScope,
  });
}

const result = resultRecord();
const responseHeaders = {
  "cache-control": "private, no-store",
  "content-type": "application/json; charset=utf-8",
};

beforeEach(() => {
  vi.stubEnv("PROOFSTACK_ENVIRONMENT_ID", scope.environmentId);
  vi.stubEnv("PROOFSTACK_PROJECT_ID", scope.projectId);
});

function recordResponse(kind: ComparisonRecordKind, record: unknown): Response {
  return Response.json(
    { requestId: "req_comparison_web", result: { kind, record } },
    { headers: responseHeaders },
  );
}

function bundleFetch(overrides: Partial<Record<ComparisonRecordKind, Response>> = {}) {
  return vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(
      overrides.comparison_result ?? recordResponse("comparison_result", result),
    )
    .mockResolvedValueOnce(
      overrides.comparison_definition ?? recordResponse("comparison_definition", definitionRecord),
    )
    .mockResolvedValueOnce(
      overrides.comparison_evidence_snapshot ??
        recordResponse("comparison_evidence_snapshot", baselineRecord),
    )
    .mockResolvedValueOnce(recordResponse("comparison_evidence_snapshot", candidateRecord));
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("getComparisonView", () => {
  it("loads and verifies the exact result, definition, and both evidence snapshots", async () => {
    const fetcher = bundleFetch();
    const browserSessionToken = `pss_v1_${"A".repeat(42)}E`;

    await expect(
      getComparisonView(result.resultId, fetcher, { browserSessionToken }),
    ).resolves.toMatchObject({
      data: {
        baseline: { role: "baseline", snapshotId: baselineRecord.snapshotId },
        candidate: { role: "candidate", snapshotId: candidateRecord.snapshotId },
        definition: { comparisonVersionId: definitionRecord.comparisonVersionId },
        result: { resultId: result.resultId },
      },
      ok: true,
    });

    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      `http://127.0.0.1:4318/v1/projects/${scope.projectId}/environments/${scope.environmentId}/comparisons/records/comparison_result/${result.resultId}`,
      `http://127.0.0.1:4318/v1/projects/${scope.projectId}/environments/${scope.environmentId}/comparisons/records/comparison_definition/${definitionRecord.comparisonVersionId}`,
      `http://127.0.0.1:4318/v1/projects/${scope.projectId}/environments/${scope.environmentId}/comparisons/records/comparison_evidence_snapshot/${baselineRecord.snapshotId}`,
      `http://127.0.0.1:4318/v1/projects/${scope.projectId}/environments/${scope.environmentId}/comparisons/records/comparison_evidence_snapshot/${candidateRecord.snapshotId}`,
    ]);
    for (const [, init] of fetcher.mock.calls) {
      expect(init).toMatchObject({
        cache: "no-store",
        headers: { cookie: `__Host-proofstack_session=${browserSessionToken}` },
      });
    }
  });

  it("rejects malformed identifiers, session tokens, and configured scopes before fetching", async () => {
    const fetcher = vi.fn<typeof globalThis.fetch>();
    await expect(getComparisonView("INVALID", fetcher)).resolves.toMatchObject({
      kind: "invalid_response",
      ok: false,
    });
    await expect(
      getComparisonView(result.resultId, fetcher, { browserSessionToken: "invalid" }),
    ).resolves.toMatchObject({ kind: "invalid_response", ok: false });
    vi.stubEnv("PROOFSTACK_PROJECT_ID", "INVALID");
    await expect(getComparisonView(result.resultId, fetcher)).resolves.toMatchObject({
      kind: "unavailable",
      message: "Configured project or environment ID is invalid",
      ok: false,
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("distinguishes an absent result from an unavailable referenced source", async () => {
    const missingResult = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response(null, { status: 404 }));
    await expect(getComparisonView(result.resultId, missingResult)).resolves.toMatchObject({
      kind: "not_found",
      message: "Comparison result was not found",
    });

    const missingSource = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(recordResponse("comparison_result", result))
      .mockResolvedValue(new Response(null, { status: 404 }));
    await expect(getComparisonView(result.resultId, missingSource)).resolves.toMatchObject({
      kind: "invalid_response",
      message: "A referenced comparison record is unavailable",
    });
  });

  it.each([
    [
      "an upstream failure",
      new Response(null, { status: 503 }),
      "unavailable",
      "Comparison API returned HTTP 503",
    ],
    [
      "an unsafe media type",
      new Response("{}", {
        headers: { "cache-control": "no-store", "content-type": "text/plain" },
      }),
      "invalid_response",
      "unexpected media type",
    ],
    [
      "a cacheable response",
      new Response("{}", { headers: { "content-type": "application/json" } }),
      "invalid_response",
      "no-store",
    ],
    [
      "an empty response",
      new Response(null, { headers: responseHeaders }),
      "invalid_response",
      "empty",
    ],
    [
      "invalid JSON",
      new Response("not-json", { headers: responseHeaders }),
      "invalid_response",
      "invalid JSON",
    ],
    [
      "an invalid contract",
      Response.json({ requestId: "req_comparison_web" }, { headers: responseHeaders }),
      "invalid_response",
      "contract validation",
    ],
    [
      "an oversized declared response",
      new Response("{}", {
        headers: {
          ...responseHeaders,
          "content-length": String(MAX_COMPARISON_RESPONSE_BYTES + 1),
        },
      }),
      "invalid_response",
      "too large",
    ],
  ])("fails closed on %s", async (_name, response, kind, message) => {
    const fetcher = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response);
    await expect(getComparisonView(result.resultId, fetcher)).resolves.toMatchObject({
      kind,
      message: expect.stringContaining(message),
      ok: false,
    });
  });

  it("bounds a streamed response even without a declared content length", async () => {
    const fetcher = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response("x".repeat(MAX_COMPARISON_RESPONSE_BYTES + 1), {
        headers: responseHeaders,
      }),
    );
    await expect(getComparisonView(result.resultId, fetcher)).resolves.toMatchObject({
      kind: "invalid_response",
      message: "Comparison API response is too large",
    });
  });

  it("rejects record identity, scope, digest, and kind substitutions", async () => {
    const variants = [
      recordResponse("comparison_result", { ...result, definitionSha256: "0".repeat(64) }),
      recordResponse("comparison_result", {
        ...result,
        scope: { ...result.scope, projectId: "project_other" },
      }),
      recordResponse("comparison_definition", definitionRecord),
    ];
    for (const response of variants) {
      await expect(
        getComparisonView(
          result.resultId,
          vi.fn<typeof globalThis.fetch>().mockResolvedValue(response),
        ),
      ).resolves.toMatchObject({ kind: "invalid_response", ok: false });
    }
  });

  it("rejects individually valid records with contradictory cross-record lineage", async () => {
    const mismatchedCandidateDefinition = {
      ...structuredClone(snapshotVector.input.definition),
      comparison: { ...comparisonReference, comparisonId: "comparison_other" },
      role: "candidate",
      snapshotId: candidateRecord.snapshotId,
    };
    const mismatchedCandidate = ComparisonEvidenceSnapshotSchema.parse({
      ...mismatchedCandidateDefinition,
      createdAt,
      createdByPrincipalId,
      definitionSha256: digest("comparison_evidence_snapshot", mismatchedCandidateDefinition),
      schemaVersion: "0.3",
      scope,
    });
    const mismatchedResult = resultRecord({
      candidateSnapshot: {
        definitionSha256: mismatchedCandidate.definitionSha256,
        role: "candidate",
        snapshotId: mismatchedCandidate.snapshotId,
      },
    });
    const fetcher = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(recordResponse("comparison_result", mismatchedResult))
      .mockResolvedValueOnce(recordResponse("comparison_definition", definitionRecord))
      .mockResolvedValueOnce(recordResponse("comparison_evidence_snapshot", baselineRecord))
      .mockResolvedValueOnce(recordResponse("comparison_evidence_snapshot", mismatchedCandidate));

    await expect(getComparisonView(result.resultId, fetcher)).resolves.toMatchObject({
      kind: "invalid_response",
      message: "Comparison records have contradictory immutable lineage",
    });
  });

  it("normalizes network failures and bounds requests with a timeout", async () => {
    await expect(
      getComparisonView(
        result.resultId,
        vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error("offline")),
      ),
    ).resolves.toMatchObject({
      kind: "unavailable",
      message: "API is not reachable",
    });

    vi.useFakeTimers();
    const hangingFetch = vi.fn<typeof globalThis.fetch>(
      async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const pending = getComparisonView(result.resultId, hangingFetch, { timeoutMs: 10 });
    await vi.advanceTimersByTimeAsync(10);
    await expect(pending).resolves.toMatchObject({
      kind: "unavailable",
      message: "ProofStack API request timed out after 10ms",
    });
  });
});
