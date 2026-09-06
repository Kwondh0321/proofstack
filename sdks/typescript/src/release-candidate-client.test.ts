import { readFileSync } from "node:fs";
import {
  type EvidenceScope,
  PublishReleaseCandidateRequestSchema,
  type ReleaseCandidateDefinition,
  ReleaseCandidateSchema,
} from "@proofstack/contracts";
import { describe, expect, it, vi } from "vitest";
import { ProofStackProblemError } from "./regression-client.js";
import {
  MAX_RELEASE_CANDIDATE_REDIRECTS,
  MAX_RELEASE_CANDIDATE_RESPONSE_BYTES,
  ProofStackReleaseCandidateClient,
} from "./release-candidate-client.js";

interface StoredVector {
  readonly input: {
    readonly definition: ReleaseCandidateDefinition;
    readonly scope: EvidenceScope;
  };
  readonly sha256: string;
}

const document = JSON.parse(
  readFileSync(
    new URL(
      "../../../packages/contracts/vectors/release-candidate-definition-v1.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as { readonly vectors: readonly StoredVector[] };
const vector = document.vectors[0];
if (!vector) throw new Error("Expected a release candidate definition vector");

const candidate = ReleaseCandidateSchema.parse({
  ...structuredClone(vector.input.definition),
  createdAt: "2026-09-06T15:00:00.000Z",
  createdByPrincipalId: "usr_release_sdk",
  definitionSha256: vector.sha256,
  schemaVersion: "0.1",
  scope: vector.input.scope,
});
const { candidateId, predecessor, ...requestFields } = vector.input.definition;
const request = PublishReleaseCandidateRequestSchema.parse({
  ...requestFields,
  ...(predecessor ? { predecessorVersionId: predecessor.candidateVersionId } : {}),
});
const requestId = "req_release_sdk";
const successHeaders = {
  "cache-control": "private, no-store",
  "content-type": "application/json; charset=utf-8",
};
const route = `release-candidates/${candidateId}/versions/${candidate.candidateVersionId}`;

function jsonResponse(
  body: unknown,
  status = 200,
  headers: HeadersInit = successHeaders,
): Response {
  return new Response(JSON.stringify(body), { headers, status });
}

function publicationResponse(
  returnedCandidate: unknown = candidate,
  created = true,
  status = created ? 201 : 200,
): Response {
  return jsonResponse({ candidate: returnedCandidate, created, requestId }, status);
}

function readResponse(returnedCandidate: unknown = candidate): Response {
  return jsonResponse({ candidate: returnedCandidate, requestId });
}

function developmentClient(fetch: typeof globalThis.fetch, overrides = {}) {
  return new ProofStackReleaseCandidateClient({
    authentication: { mode: "development" },
    endpoint: "http://127.0.0.1:4318/base?ignored=true#fragment",
    environmentId: candidate.scope.environmentId,
    fetch,
    projectId: candidate.scope.projectId,
    ...overrides,
  });
}

describe("ProofStackReleaseCandidateClient", () => {
  it("publishes, retries, and reads one exact independently verified candidate", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(publicationResponse())
      .mockResolvedValueOnce(publicationResponse(candidate, false))
      .mockResolvedValueOnce(readResponse());
    const client = developmentClient(fetch);

    await expect(client.publishCandidate({ candidateId, request })).resolves.toMatchObject({
      created: true,
    });
    await expect(client.publishCandidate({ candidateId, request })).resolves.toMatchObject({
      created: false,
    });
    await expect(
      client.readCandidate({
        candidateId,
        candidateVersionId: candidate.candidateVersionId,
      }),
    ).resolves.toMatchObject({ candidate: { candidateId } });

    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
      `http://127.0.0.1:4318/base/v1/projects/${candidate.scope.projectId}/environments/${candidate.scope.environmentId}/${route}`,
      `http://127.0.0.1:4318/base/v1/projects/${candidate.scope.projectId}/environments/${candidate.scope.environmentId}/${route}`,
      `http://127.0.0.1:4318/base/v1/projects/${candidate.scope.projectId}/environments/${candidate.scope.environmentId}/${route}`,
    ]);
    expect(fetch.mock.calls.slice(0, 2).map(([, init]) => init?.body)).toEqual([
      JSON.stringify(request),
      JSON.stringify(request),
    ]);
    expect(fetch.mock.calls.map(([, init]) => init?.credentials)).toEqual(["omit", "omit", "omit"]);
    expect(fetch.mock.calls.map(([, init]) => init?.redirect)).toEqual([
      "manual",
      "manual",
      "manual",
    ]);
  });

  it("uses browser CSRF only for publication and limits workloads to exact reads", async () => {
    const csrfToken = `psc_v1_${"A".repeat(42)}E`;
    const browserFetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(publicationResponse())
      .mockResolvedValueOnce(readResponse());
    const browser = new ProofStackReleaseCandidateClient({
      authentication: { csrfToken, mode: "browser" },
      endpoint: "https://proofstack.example",
      environmentId: candidate.scope.environmentId,
      fetch: browserFetch,
      projectId: candidate.scope.projectId,
    });
    await browser.publishCandidate({ candidateId, request });
    await browser.readCandidate({
      candidateId,
      candidateVersionId: candidate.candidateVersionId,
    });
    expect(browserFetch.mock.calls[0]?.[1]).toMatchObject({
      credentials: "include",
      headers: expect.objectContaining({ "x-proofstack-csrf": csrfToken }),
    });
    expect(browserFetch.mock.calls[1]?.[1]?.headers).not.toHaveProperty("x-proofstack-csrf");

    const apiKey = `psk_v1_${"A".repeat(12)}_${"B".repeat(42)}E`;
    const workloadFetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(readResponse());
    const workload = new ProofStackReleaseCandidateClient({
      authentication: { apiKey, mode: "workload" },
      endpoint: "https://proofstack.example",
      environmentId: candidate.scope.environmentId,
      fetch: workloadFetch,
      projectId: candidate.scope.projectId,
    });
    await workload.readCandidate({
      candidateId,
      candidateVersionId: candidate.candidateVersionId,
    });
    await expect(workload.publishCandidate({ candidateId, request })).rejects.toThrow(
      /not workload-delegable/,
    );
    expect(workloadFetch).toHaveBeenCalledOnce();
    expect(workloadFetch.mock.calls[0]?.[1]?.headers).toMatchObject({
      authorization: `Bearer ${apiKey}`,
    });
  });

  it.each([
    [
      "digest",
      { ...candidate, definitionSha256: "0".repeat(64) },
      /invalid public definition digest/,
    ],
    [
      "logical identity",
      { ...candidate, candidateId: "candidate_other" },
      /identity that contradicts/,
    ],
    [
      "version identity",
      { ...candidate, candidateVersionId: "candidate_other_v1" },
      /identity that contradicts/,
    ],
    [
      "scope",
      { ...candidate, scope: { ...candidate.scope, projectId: "project_other" } },
      /scope that contradicts/,
    ],
  ])("rejects a read response with contradictory %s", async (_name, returned, expected) => {
    const client = developmentClient(
      vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(readResponse(returned)),
    );
    await expect(
      client.readCandidate({
        candidateId,
        candidateVersionId: candidate.candidateVersionId,
      }),
    ).rejects.toThrow(expected);
  });

  it("rejects publication responses with changed semantics, lineage, or status", async () => {
    const changedRequest = { ...request, name: "A different release candidate" };
    const changedSemantics = developmentClient(
      vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(publicationResponse()),
    );
    await expect(
      changedSemantics.publishCandidate({ candidateId, request: changedRequest }),
    ).rejects.toThrow(/semantics that contradict/);

    const changedLineage = developmentClient(
      vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(publicationResponse()),
    );
    await expect(
      changedLineage.publishCandidate({
        candidateId,
        request: { ...request, predecessorVersionId: "candidate_predecessor_v1" },
      }),
    ).rejects.toThrow(/lineage that contradicts/);

    const changedStatus = developmentClient(
      vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(publicationResponse(candidate, true, 200)),
    );
    await expect(changedStatus.publishCandidate({ candidateId, request })).rejects.toThrow(
      /inconsistent/,
    );
  });

  it("fails closed on redirects, caching, body bounds, media types, JSON, and problems", async () => {
    const read = (client: ProofStackReleaseCandidateClient) =>
      client.readCandidate({
        candidateId,
        candidateVersionId: candidate.candidateVersionId,
      });

    const redirect = developmentClient(
      vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(new Response(null, { status: 302 })),
    );
    await expect(read(redirect)).rejects.toThrow(
      `permit ${MAX_RELEASE_CANDIDATE_REDIRECTS} redirects`,
    );

    const cacheable = developmentClient(
      vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(
          jsonResponse({ candidate, requestId }, 200, { "content-type": "application/json" }),
        ),
    );
    await expect(read(cacheable)).rejects.toThrow(/no-store/);

    const oversized = developmentClient(
      vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(
        new Response("{}", {
          headers: {
            "content-length": String(MAX_RELEASE_CANDIDATE_RESPONSE_BYTES + 1),
            "content-type": "application/json",
          },
        }),
      ),
    );
    await expect(read(oversized)).rejects.toThrow(/exceeded/);

    const oversizedStream = developmentClient(
      vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(
          new Response("12345", { headers: { "content-type": "application/json" } }),
        ),
      { maxResponseBytes: 4 },
    );
    await expect(read(oversizedStream)).rejects.toThrow(/exceeded 4 bytes/);

    const invalidJson = developmentClient(
      vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(new Response("not-json", { headers: successHeaders, status: 200 })),
    );
    await expect(read(invalidJson)).rejects.toThrow(/invalid JSON/);

    const wrongMediaType = developmentClient(
      vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(
        new Response(JSON.stringify({ candidate, requestId }), {
          headers: { "cache-control": "no-store", "content-type": "text/plain" },
        }),
      ),
    );
    await expect(read(wrongMediaType)).rejects.toThrow(/unexpected media type/);

    const unexpectedStatus = developmentClient(
      vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(jsonResponse({ candidate, requestId }, 202)),
    );
    await expect(read(unexpectedStatus)).rejects.toThrow(/unexpected HTTP 202/);

    const invalidContract = developmentClient(
      vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(jsonResponse({ requestId })),
    );
    await expect(read(invalidContract)).rejects.toThrow(/published release candidate contract/);

    const problem = developmentClient(
      vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(
        jsonResponse(
          {
            code: "release_candidate_not_found",
            detail: "Release candidate unavailable",
            requestId,
            status: 404,
            title: "Release candidate not found",
            type: "https://proofstack.dev/problems/release-candidate-not-found",
          },
          404,
        ),
      ),
    );
    await expect(read(problem)).rejects.toBeInstanceOf(ProofStackProblemError);

    const invalidProblem = developmentClient(
      vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(jsonResponse({ message: "no" }, 400)),
    );
    await expect(read(invalidProblem)).rejects.toMatchObject({ status: 400 });

    const invalidProblemJson = developmentClient(
      vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(new Response("not-json", { headers: successHeaders, status: 500 })),
    );
    await expect(read(invalidProblemJson)).rejects.toMatchObject({ status: 500 });
  });

  it("validates endpoints, credentials, options, identifiers, and requests locally", async () => {
    const common = {
      authentication: { mode: "development" } as const,
      environmentId: candidate.scope.environmentId,
      fetch: vi.fn<typeof globalThis.fetch>(),
      projectId: candidate.scope.projectId,
    };
    expect(() => new ProofStackReleaseCandidateClient({ ...common, endpoint: "relative" })).toThrow(
      /absolute URL/,
    );
    expect(
      () => new ProofStackReleaseCandidateClient({ ...common, endpoint: "ftp://127.0.0.1" }),
    ).toThrow(/HTTP or HTTPS/);
    expect(
      () =>
        new ProofStackReleaseCandidateClient({
          ...common,
          endpoint: "http://user:pass@127.0.0.1",
        }),
    ).toThrow(/embedded credentials/);
    expect(
      () =>
        new ProofStackReleaseCandidateClient({
          ...common,
          endpoint: "http://proofstack.example",
        }),
    ).toThrow(/loopback/);
    expect(
      () =>
        new ProofStackReleaseCandidateClient({
          ...common,
          endpoint: "https://proofstack.example",
        }),
    ).toThrow(/Development authentication/);
    expect(
      () =>
        new ProofStackReleaseCandidateClient({
          ...common,
          authentication: { csrfToken: "invalid", mode: "browser" },
          endpoint: "https://proofstack.example",
        }),
    ).toThrow(/CSRF token/);
    expect(
      () =>
        new ProofStackReleaseCandidateClient({
          ...common,
          authentication: { apiKey: "invalid", mode: "workload" },
          endpoint: "https://proofstack.example",
        }),
    ).toThrow(/API key/);
    expect(
      () =>
        new ProofStackReleaseCandidateClient({
          ...common,
          authentication: { mode: "invalid" } as never,
          endpoint: "https://proofstack.example",
        }),
    ).toThrow(/authentication mode is invalid/);
    expect(
      () =>
        new ProofStackReleaseCandidateClient({
          ...common,
          endpoint: "http://localhost",
          timeoutMs: 0,
        }),
    ).toThrow(/timeoutMs/);
    expect(
      () =>
        new ProofStackReleaseCandidateClient({
          ...common,
          endpoint: "http://[::1]",
          maxResponseBytes: MAX_RELEASE_CANDIDATE_RESPONSE_BYTES + 1,
        }),
    ).toThrow(/maxResponseBytes/);

    const fetch = vi.fn<typeof globalThis.fetch>();
    const client = developmentClient(fetch);
    await expect(
      client.readCandidate({ candidateId: "INVALID", candidateVersionId: "candidate_v1" }),
    ).rejects.toThrow(/candidateId failed local validation/);
    await expect(
      client.readCandidate({ candidateId, candidateVersionId: "INVALID" }),
    ).rejects.toThrow(/candidateVersionId failed local validation/);
    await expect(client.publishCandidate({ candidateId: "INVALID", request })).rejects.toThrow(
      /candidateId failed local validation/,
    );
    await expect(
      client.publishCandidate({
        candidateId,
        request: { ...request, decision: "allow" } as never,
      }),
    ).rejects.toThrow(/publication failed local validation/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects construction without fetch and normalizes transport failures and timeouts", async () => {
    vi.stubGlobal("fetch", undefined);
    try {
      expect(
        () =>
          new ProofStackReleaseCandidateClient({
            authentication: { mode: "development" },
            endpoint: "http://127.0.0.1",
            environmentId: candidate.scope.environmentId,
            projectId: candidate.scope.projectId,
          }),
      ).toThrow(/No fetch implementation/);
    } finally {
      vi.unstubAllGlobals();
    }

    const failed = developmentClient(
      vi.fn<typeof globalThis.fetch>().mockRejectedValueOnce(new Error("socket failed")),
    );
    await expect(
      failed.readCandidate({
        candidateId,
        candidateVersionId: candidate.candidateVersionId,
      }),
    ).rejects.toThrow(/request failed/);

    const abortingFetch = vi.fn<typeof globalThis.fetch>((_url, init) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    });
    const timedOut = developmentClient(abortingFetch, { timeoutMs: 1 });
    await expect(
      timedOut.readCandidate({
        candidateId,
        candidateVersionId: candidate.candidateVersionId,
      }),
    ).rejects.toThrow(/timed out after 1ms/);
  });
});
