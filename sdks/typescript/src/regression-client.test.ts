import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ProofStackApiError,
  ProofStackProblemError,
  ProofStackRegressionClient,
  type ProofStackRegressionClientOptions,
} from "./regression-client.js";

const apiKey = `psk_v1_ABCDEFGHIJKL_${"A".repeat(43)}`;
const csrfToken = `psc_v1_${"E".repeat(43)}`;
const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
const fixtureRequest = {
  fixtureVersionId: "fixv_checkout_001",
  name: "Checkout incident",
  source: { kind: "trace_snapshot", traceId },
} as const;
const datasetRequest = {
  datasetVersionId: "datv_checkout_001",
  fixtureVersions: [
    {
      fixtureId: "fix_checkout",
      fixtureVersionId: fixtureRequest.fixtureVersionId,
    },
  ],
  name: "Checkout regressions",
};
const fixtureVersion = {
  createdAt: "2026-08-28T05:00:00.200Z",
  createdByPrincipalId: "usr_sdk_test",
  definitionSha256: "a".repeat(64),
  fixtureId: "fix_checkout",
  fixtureVersionId: fixtureRequest.fixtureVersionId,
  name: fixtureRequest.name,
  replayability: "evidence_only",
  schemaVersion: "0.1",
  scope: {
    environmentId: "env_local",
    projectId: "prj_local",
    tenantId: "ten_sdk_test",
  },
  source: {
    capturedAt: "2026-08-28T05:00:00.100Z",
    eventIds: ["evt_sdk_test"],
    kind: "trace_snapshot",
    observedEventCount: 1,
    sourceCompleteness: "observed_snapshot",
    traceId,
  },
} as const;
const datasetVersion = {
  createdAt: "2026-08-28T05:00:00.300Z",
  createdByPrincipalId: "usr_sdk_test",
  datasetId: "dat_checkout",
  datasetVersionId: datasetRequest.datasetVersionId,
  definitionSha256: "b".repeat(64),
  fixtureVersions: [
    {
      definitionSha256: fixtureVersion.definitionSha256,
      fixtureId: fixtureVersion.fixtureId,
      fixtureVersionId: fixtureVersion.fixtureVersionId,
    },
  ],
  name: datasetRequest.name,
  schemaVersion: "0.1",
  scope: fixtureVersion.scope,
} as const;

function client(
  fetch: typeof globalThis.fetch,
  overrides: Partial<ProofStackRegressionClientOptions> = {},
) {
  return new ProofStackRegressionClient({
    authentication: { csrfToken, mode: "browser" },
    endpoint: "https://proofstack.example/base/?debug=true#fragment",
    environmentId: "env_local",
    fetch,
    projectId: "prj_local",
    ...overrides,
  });
}

function fixtureResponse(created: boolean, status: number): Response {
  return Response.json(
    { created, requestId: "req_sdk_fixture", version: fixtureVersion },
    { status },
  );
}

function datasetResponse(created: boolean, status: number): Response {
  return Response.json(
    { created, requestId: "req_sdk_dataset", version: datasetVersion },
    { status },
  );
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("ProofStackRegressionClient", () => {
  it("publishes and reads exact fixture and dataset versions through canonical scoped URLs", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(fixtureResponse(true, 201))
      .mockResolvedValueOnce(
        Response.json({ requestId: "req_sdk_fixture_read", version: fixtureVersion }),
      )
      .mockResolvedValueOnce(datasetResponse(false, 200))
      .mockResolvedValueOnce(
        Response.json({ requestId: "req_sdk_dataset_read", version: datasetVersion }),
      );
    const sdk = client(fetch);

    const publishedFixture = await sdk.publishFixtureVersion({
      fixtureId: "fix_checkout",
      request: fixtureRequest,
    });
    const readFixture = await sdk.readFixtureVersion({
      fixtureId: "fix_checkout",
      fixtureVersionId: fixtureRequest.fixtureVersionId,
    });
    const publishedDataset = await sdk.publishDatasetVersion({
      datasetId: "dat_checkout",
      request: datasetRequest,
    });
    const readDataset = await sdk.readDatasetVersion({
      datasetId: "dat_checkout",
      datasetVersionId: datasetRequest.datasetVersionId,
    });

    expect(publishedFixture).toMatchObject({ created: true, version: fixtureVersion });
    expect(readFixture).toMatchObject({ version: fixtureVersion });
    expect(publishedDataset).toMatchObject({ created: false, version: datasetVersion });
    expect(readDataset).toMatchObject({ version: datasetVersion });
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
      "https://proofstack.example/base/v1/projects/prj_local/environments/env_local/regression-fixtures/fix_checkout/versions",
      "https://proofstack.example/base/v1/projects/prj_local/environments/env_local/regression-fixtures/fix_checkout/versions/fixv_checkout_001",
      "https://proofstack.example/base/v1/projects/prj_local/environments/env_local/regression-datasets/dat_checkout/versions",
      "https://proofstack.example/base/v1/projects/prj_local/environments/env_local/regression-datasets/dat_checkout/versions/datv_checkout_001",
    ]);
    const fixturePublication = fetch.mock.calls[0]?.[1];
    const fixtureRead = fetch.mock.calls[1]?.[1];
    expect(fixturePublication).toMatchObject({
      body: JSON.stringify(fixtureRequest),
      credentials: "include",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-proofstack-csrf": csrfToken,
      },
      method: "POST",
    });
    expect(fixtureRead).toMatchObject({
      credentials: "include",
      headers: { accept: "application/json" },
      method: "GET",
    });
    expect(fixtureRead).not.toHaveProperty("body");
  });

  it("supports unauthenticated loopback development without emitting an authorization header", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(Response.json({ requestId: "req_local", version: fixtureVersion }));
    const sdk = new ProofStackRegressionClient({
      authentication: { mode: "development" },
      endpoint: "http://127.0.0.1:3010",
      environmentId: "env_local",
      fetch,
      projectId: "prj_local",
    });

    await sdk.readFixtureVersion({
      fixtureId: "fix_checkout",
      fixtureVersionId: fixtureRequest.fixtureVersionId,
    });

    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      credentials: "omit",
      headers: { accept: "application/json" },
    });
    expect(fetch.mock.calls[0]?.[1]?.headers).not.toHaveProperty("authorization");
  });

  it("uses workload credentials only for exact reads and rejects publication before fetch", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(Response.json({ requestId: "req_workload", version: fixtureVersion }));
    const sdk = client(fetch, { authentication: { apiKey, mode: "workload" } });

    await sdk.readFixtureVersion({
      fixtureId: "fix_checkout",
      fixtureVersionId: fixtureRequest.fixtureVersionId,
    });
    await expect(
      sdk.publishFixtureVersion({ fixtureId: "fix_checkout", request: fixtureRequest }),
    ).rejects.toThrow("workload keys are read-only");

    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      credentials: "omit",
      headers: { accept: "application/json", authorization: `Bearer ${apiKey}` },
      method: "GET",
    });
  });

  it("validates configuration before retaining an unsafe endpoint or credential", () => {
    const fetch = vi.fn<typeof globalThis.fetch>();

    expect(() => client(fetch, { endpoint: "/relative" })).toThrow("absolute URL");
    expect(() => client(fetch, { endpoint: "file:///tmp/proofstack" })).toThrow("HTTP or HTTPS");
    expect(() => client(fetch, { endpoint: "https://user:secret@proofstack.example" })).toThrow(
      "embedded credentials",
    );
    expect(() => client(fetch, { endpoint: "http://proofstack.internal" })).toThrow(
      "explicit loopback",
    );
    expect(() => client(fetch, { projectId: "INVALID" })).toThrow(
      "projectId failed local validation",
    );
    expect(() => client(fetch, { environmentId: "INVALID" })).toThrow(
      "environmentId failed local validation",
    );
    expect(() =>
      client(fetch, { authentication: { apiKey: "not-a-key", mode: "workload" } }),
    ).toThrow("Workload API key failed local validation");
    expect(() =>
      client(fetch, { authentication: { csrfToken: "not-a-token", mode: "browser" } }),
    ).toThrow("Browser CSRF token failed local validation");
    expect(() =>
      client(fetch, {
        authentication: { mode: "development" },
        endpoint: "https://proofstack.example",
      }),
    ).toThrow("Development authentication requires an explicit loopback endpoint");
    expect(() => client(fetch, { authentication: { mode: "unknown" } as never })).toThrow(
      "authentication mode is invalid",
    );
    expect(() => client(fetch, { timeoutMs: 0 })).toThrow("positive integer");
  });

  it("requires a fetch implementation", () => {
    vi.stubGlobal("fetch", undefined);

    expect(
      () =>
        new ProofStackRegressionClient({
          authentication: { csrfToken, mode: "browser" },
          endpoint: "https://proofstack.example",
          environmentId: "env_local",
          projectId: "prj_local",
        }),
    ).toThrow("No fetch implementation");
  });

  it("rejects invalid resource identifiers and publication requests before network access", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const sdk = client(fetch);

    await expect(
      sdk.publishFixtureVersion({ fixtureId: "INVALID", request: fixtureRequest }),
    ).rejects.toThrow("fixtureId failed local validation");
    await expect(
      sdk.publishFixtureVersion({
        fixtureId: "fix_checkout",
        request: { ...fixtureRequest, unexpected: true } as never,
      }),
    ).rejects.toThrow("fixture publication failed local validation");
    await expect(
      sdk.readFixtureVersion({ fixtureId: "fix_checkout", fixtureVersionId: "INVALID" }),
    ).rejects.toThrow("fixtureVersionId failed local validation");
    await expect(
      sdk.publishDatasetVersion({
        datasetId: "dat_checkout",
        request: { ...datasetRequest, fixtureVersions: [] },
      }),
    ).rejects.toThrow("dataset publication failed local validation");
    await expect(
      sdk.readDatasetVersion({ datasetId: "INVALID", datasetVersionId: "INVALID" }),
    ).rejects.toThrow("datasetId failed local validation");
    await expect(
      sdk.readDatasetVersion({ datasetId: "dat_checkout", datasetVersionId: "INVALID" }),
    ).rejects.toThrow("datasetVersionId failed local validation");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("surfaces a validated problem document as a structured error", async () => {
    const problem = {
      code: "regression_version_conflict",
      detail: "Regression version is already bound to a different immutable definition",
      requestId: "req_sdk_problem",
      status: 409,
      title: "Regression version conflict",
      type: "https://proofstack.dev/problems/regression-version-conflict",
    };
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(Response.json(problem, { status: 409 }));
    const sdk = client(fetch);

    const promise = sdk.publishFixtureVersion({
      fixtureId: "fix_checkout",
      request: fixtureRequest,
    });

    await expect(promise).rejects.toBeInstanceOf(ProofStackProblemError);
    await expect(promise).rejects.toMatchObject({
      code: problem.code,
      detail: problem.detail,
      problemType: problem.type,
      requestId: problem.requestId,
      status: problem.status,
      title: problem.title,
    });
  });

  it("bounds untrusted rejection bodies without reflecting their contents", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(Response.json({ secret: "do-not-reflect" }, { status: 503 }));
    const sdk = client(fetch);

    const promise = sdk.readDatasetVersion({
      datasetId: "dat_checkout",
      datasetVersionId: datasetRequest.datasetVersionId,
    });

    await expect(promise).rejects.toBeInstanceOf(ProofStackApiError);
    await expect(promise).rejects.toMatchObject({ status: 503 });
    await expect(promise).rejects.not.toThrow("do-not-reflect");
  });

  it("reduces non-JSON rejection bodies to their HTTP status", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response("gateway-secret", { status: 502 }));
    const sdk = client(fetch);

    const promise = sdk.readFixtureVersion({
      fixtureId: "fix_checkout",
      fixtureVersionId: fixtureRequest.fixtureVersionId,
    });

    await expect(promise).rejects.toMatchObject({
      message: "ProofStack API rejected the request with HTTP 502",
      status: 502,
    });
    await expect(promise).rejects.not.toThrow("gateway-secret");
  });

  it("rejects problem documents whose embedded status contradicts HTTP", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      Response.json(
        {
          code: "regression_version_not_found",
          detail: "Not found",
          requestId: "req_wrong_status",
          status: 404,
          title: "Not found",
          type: "https://proofstack.dev/problems/regression-version-not-found",
        },
        { status: 409 },
      ),
    );
    const sdk = client(fetch);

    const promise = sdk.readFixtureVersion({
      fixtureId: "fix_checkout",
      fixtureVersionId: fixtureRequest.fixtureVersionId,
    });

    await expect(promise).rejects.toBeInstanceOf(ProofStackApiError);
    await expect(promise).rejects.not.toBeInstanceOf(ProofStackProblemError);
    await expect(promise).rejects.toMatchObject({ status: 409 });
  });

  it.each([
    ["unexpected success status", () => fixtureResponse(true, 202), "unexpected HTTP 202"],
    [
      "unexpected success media type",
      () =>
        new Response(JSON.stringify({ requestId: "req_media", version: fixtureVersion }), {
          headers: { "content-type": "text/plain" },
          status: 200,
        }),
      "unexpected media type",
    ],
    [
      "invalid success JSON",
      () =>
        new Response("not-json", {
          headers: { "content-type": "application/json" },
          status: 200,
        }),
      "invalid JSON",
    ],
    [
      "contract-breaking response",
      () => Response.json({ requestId: "req_invalid", version: { corrupt: true } }),
      "violates the published contract",
    ],
  ])("rejects %s", async (_name, response, expectedMessage) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response());
    const sdk = client(fetch);

    await expect(
      sdk.readFixtureVersion({
        fixtureId: "fix_checkout",
        fixtureVersionId: fixtureRequest.fixtureVersionId,
      }),
    ).rejects.toThrow(expectedMessage);
  });

  it("rejects publication markers that contradict HTTP creation status", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(fixtureResponse(false, 201));
    const sdk = client(fetch);

    await expect(
      sdk.publishFixtureVersion({ fixtureId: "fix_checkout", request: fixtureRequest }),
    ).rejects.toThrow("inconsistent regression publication status");
  });

  it("bounds successful response bodies before parsing", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response("x".repeat(1024 * 1024 + 1), { status: 200 }));
    const sdk = client(fetch);

    await expect(
      sdk.readDatasetVersion({
        datasetId: "dat_checkout",
        datasetVersionId: datasetRequest.datasetVersionId,
      }),
    ).rejects.toThrow("response exceeded 1048576 bytes");
  });

  it("rejects an empty successful response body", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(null, {
        headers: { "content-type": "application/json" },
        status: 200,
      }),
    );
    const sdk = client(fetch);

    await expect(
      sdk.readFixtureVersion({
        fixtureId: "fix_checkout",
        fixtureVersionId: fixtureRequest.fixtureVersionId,
      }),
    ).rejects.toThrow("invalid JSON");
  });

  it("fails closed on network errors without automatically retrying mutations", async () => {
    const failure = new Error("socket unavailable");
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(failure);
    const sdk = client(fetch);

    const promise = sdk.publishDatasetVersion({
      datasetId: "dat_checkout",
      request: datasetRequest,
    });

    await expect(promise).rejects.toMatchObject({
      cause: failure,
      message: "ProofStack API request failed",
    });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("aborts a request at the configured timeout", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(
      async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const sdk = client(fetch, { timeoutMs: 10 });

    const assertion = expect(
      sdk.readFixtureVersion({
        fixtureId: "fix_checkout",
        fixtureVersionId: fixtureRequest.fixtureVersionId,
      }),
    ).rejects.toThrow("timed out after 10ms");
    await vi.advanceTimersByTimeAsync(10);

    await assertion;
  });
});
