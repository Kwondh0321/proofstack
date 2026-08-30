import { readFileSync } from "node:fs";
import {
  ReplayJobSnapshotSchema,
  ReplayPlanDefinitionSchema,
  TargetReleaseDefinitionSchema,
} from "@proofstack/contracts";
import { describe, expect, it, vi } from "vitest";
import { ProofStackApiError, ProofStackProblemError } from "./regression-client.js";
import { MAX_REPLAY_CONTROL_RESPONSE_BYTES, ProofStackReplayClient } from "./replay-client.js";

interface DefinitionVector {
  readonly input: unknown;
  readonly kind: "replay_plan" | "target_release";
  readonly sha256: string;
}

const vectors = (
  JSON.parse(
    readFileSync(
      new URL("../../../packages/replay/vectors/replay-definition-v1.json", import.meta.url),
      "utf8",
    ),
  ) as { readonly vectors: readonly DefinitionVector[] }
).vectors;
const targetVector = vectors.find(({ kind }) => kind === "target_release");
const planVector = vectors.find(({ kind }) => kind === "replay_plan");
if (!targetVector || !planVector) throw new Error("Replay definition vectors are incomplete");

const targetDefinition = TargetReleaseDefinitionSchema.parse(targetVector.input);
const planDefinition = ReplayPlanDefinitionSchema.parse(planVector.input);
const release = {
  ...targetDefinition,
  createdAt: "2026-08-31T00:00:00.000Z",
  createdByPrincipalId: "usr_replay_test",
  definitionSha256: targetVector.sha256,
};
const plan = {
  ...planDefinition,
  createdAt: "2026-08-31T00:00:01.000Z",
  createdByPrincipalId: "usr_replay_test",
  definitionSha256: planVector.sha256,
};
const jobId = "job_replay_sdk_test";
const cancellationId = "can_replay_sdk_test";
const jobRequest = {
  jobId,
  plan: {
    definitionSha256: plan.definitionSha256,
    planId: plan.planId,
    planVersionId: plan.planVersionId,
  },
};
const queuedSnapshot = ReplayJobSnapshotSchema.parse({
  attempts: [],
  budgetLedger: [],
  cancellationAcknowledgements: [],
  cancellationRequest: null,
  executionObservations: [],
  job: {
    createdAt: "2026-08-31T00:00:02.000Z",
    createdByPrincipalId: "usr_replay_test",
    jobId,
    lastFencingToken: 0,
    plan: jobRequest.plan,
    recoveryEpoch: 0,
    schemaVersion: "0.1",
    scope: targetDefinition.scope,
    stateVersion: 1,
    status: "queued",
  },
  usageObservations: [],
});
const cancellationRequest = {
  cancellationId,
  reason: "Stop the replay without starting new work.",
  reasonCode: "operator_request" as const,
};
const cancelledSnapshot = ReplayJobSnapshotSchema.parse({
  ...queuedSnapshot,
  cancellationRequest: {
    ...cancellationRequest,
    jobId,
    requestedAt: "2026-08-31T00:00:03.000Z",
    requestedByPrincipalId: "usr_replay_test",
    schemaVersion: "0.1",
    scope: targetDefinition.scope,
  },
  job: {
    ...queuedSnapshot.job,
    stateVersion: 2,
    status: "cancelled",
    terminal: {
      code: "cancellation_committed",
      committedAt: "2026-08-31T00:00:03.000Z",
      status: "cancelled",
    },
  },
});

const requestId = "req_replay_sdk_test";
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

function developmentClient(fetch: typeof globalThis.fetch, overrides = {}) {
  return new ProofStackReplayClient({
    authentication: { mode: "development" },
    endpoint: "http://127.0.0.1:3010/base?ignored=true#fragment",
    environmentId: targetDefinition.scope.environmentId,
    fetch,
    projectId: targetDefinition.scope.projectId,
    ...overrides,
  });
}

describe("ProofStackReplayClient", () => {
  it("crosses every exact route and verifies definitions, snapshots, and cancellation", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(jsonResponse({ created: true, release, requestId }, 201))
      .mockResolvedValueOnce(jsonResponse({ release, requestId }))
      .mockResolvedValueOnce(jsonResponse({ created: true, plan, requestId }, 201))
      .mockResolvedValueOnce(jsonResponse({ plan, requestId }))
      .mockResolvedValueOnce(
        jsonResponse({ created: true, requestId, snapshot: queuedSnapshot }, 201),
      )
      .mockResolvedValueOnce(jsonResponse({ requestId, snapshot: queuedSnapshot }))
      .mockResolvedValueOnce(
        jsonResponse({ created: true, requestId, snapshot: cancelledSnapshot }, 201),
      );
    const client = developmentClient(fetch);

    await expect(
      client.publishTargetRelease({ definition: targetDefinition }),
    ).resolves.toMatchObject({
      created: true,
      release: { definitionSha256: targetVector.sha256 },
    });
    await expect(
      client.readTargetRelease({
        targetId: targetDefinition.targetId,
        targetReleaseId: targetDefinition.targetReleaseId,
      }),
    ).resolves.toMatchObject({ release: { targetId: targetDefinition.targetId } });
    await expect(client.publishReplayPlan({ definition: planDefinition })).resolves.toMatchObject({
      created: true,
      plan: { definitionSha256: planVector.sha256 },
    });
    await expect(
      client.readReplayPlan({ planId: plan.planId, planVersionId: plan.planVersionId }),
    ).resolves.toMatchObject({ plan: { planVersionId: plan.planVersionId } });
    await expect(client.createReplayJob({ jobId, request: jobRequest })).resolves.toMatchObject({
      snapshot: { job: { status: "queued" } },
    });
    await expect(client.readReplayJob({ jobId })).resolves.toMatchObject({
      snapshot: { job: { jobId } },
    });
    await expect(
      client.requestReplayCancellation({ jobId, request: cancellationRequest }),
    ).resolves.toMatchObject({
      snapshot: { cancellationRequest: { cancellationId }, job: { status: "cancelled" } },
    });

    expect(fetch).toHaveBeenCalledTimes(7);
    const calls = fetch.mock.calls;
    expect(calls.map(([url]) => String(url))).toEqual([
      `http://127.0.0.1:3010/base/v1/projects/prj_vector/environments/env_vector/replay-targets/${targetDefinition.targetId}/releases/${targetDefinition.targetReleaseId}`,
      `http://127.0.0.1:3010/base/v1/projects/prj_vector/environments/env_vector/replay-targets/${targetDefinition.targetId}/releases/${targetDefinition.targetReleaseId}`,
      `http://127.0.0.1:3010/base/v1/projects/prj_vector/environments/env_vector/replay-plans/${plan.planId}/versions/${plan.planVersionId}`,
      `http://127.0.0.1:3010/base/v1/projects/prj_vector/environments/env_vector/replay-plans/${plan.planId}/versions/${plan.planVersionId}`,
      `http://127.0.0.1:3010/base/v1/projects/prj_vector/environments/env_vector/replay-jobs/${jobId}`,
      `http://127.0.0.1:3010/base/v1/projects/prj_vector/environments/env_vector/replay-jobs/${jobId}`,
      `http://127.0.0.1:3010/base/v1/projects/prj_vector/environments/env_vector/replay-jobs/${jobId}/cancellation-requests/${cancellationId}`,
    ]);
    for (const [, init] of calls) {
      expect(init).toMatchObject({ credentials: "omit", redirect: "manual" });
    }
  });

  it("preserves browser cookies and CSRF while preventing workload management publication", async () => {
    const browserFetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(jsonResponse({ created: false, release, requestId }));
    const browser = new ProofStackReplayClient({
      authentication: { csrfToken: `psc_v1_${"A".repeat(42)}E`, mode: "browser" },
      endpoint: "https://proofstack.example",
      environmentId: targetDefinition.scope.environmentId,
      fetch: browserFetch,
      projectId: targetDefinition.scope.projectId,
    });
    await browser.publishTargetRelease({ definition: targetDefinition });
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
      .mockResolvedValue(jsonResponse({ release, requestId }));
    const apiKey = `psk_v1_${"A".repeat(12)}_${"B".repeat(42)}E`;
    const workload = new ProofStackReplayClient({
      authentication: { apiKey, mode: "workload" },
      endpoint: "https://proofstack.example",
      environmentId: targetDefinition.scope.environmentId,
      fetch: workloadFetch,
      projectId: targetDefinition.scope.projectId,
    });
    await workload.readTargetRelease({
      targetId: release.targetId,
      targetReleaseId: release.targetReleaseId,
    });
    expect(workloadFetch).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({
        credentials: "omit",
        headers: expect.objectContaining({ authorization: `Bearer ${apiKey}` }),
      }),
    );
    await expect(workload.publishReplayPlan({ definition: planDefinition })).rejects.toThrow(
      /not workload-delegable/,
    );
    expect(workloadFetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      "definition digest",
      () => ({ release: { ...release, definitionSha256: "0".repeat(64) }, requestId }),
      /invalid public definition digest/,
    ],
    [
      "resource identity",
      () => ({ release: { ...release, targetReleaseId: "trg_other" }, requestId }),
      /identity that contradicts/,
    ],
    [
      "tenant scope",
      () => ({
        release: { ...release, scope: { ...release.scope, projectId: "prj_other" } },
        requestId,
      }),
      /scope that contradicts/,
    ],
  ])("rejects a response with a contradictory %s", async (_name, response, expected) => {
    const client = developmentClient(
      vi.fn<typeof globalThis.fetch>().mockResolvedValue(jsonResponse(response())),
    );

    await expect(
      client.readTargetRelease({
        targetId: targetDefinition.targetId,
        targetReleaseId: targetDefinition.targetReleaseId,
      }),
    ).rejects.toThrow(expected);
  });

  it("rejects a replay plan with a contradictory digest or exact identity", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ plan: { ...plan, definitionSha256: "0".repeat(64) }, requestId }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ plan: { ...plan, planVersionId: "plv_other" }, requestId }),
      );
    const client = developmentClient(fetch);

    await expect(
      client.readReplayPlan({ planId: plan.planId, planVersionId: plan.planVersionId }),
    ).rejects.toThrow(/invalid public definition digest/);
    await expect(
      client.readReplayPlan({ planId: plan.planId, planVersionId: plan.planVersionId }),
    ).rejects.toThrow(/identity that contradicts/);
  });

  it("rejects a replay snapshot whose exact job identity contradicts its route", async () => {
    const client = developmentClient(
      vi.fn<typeof globalThis.fetch>().mockResolvedValue(
        jsonResponse({
          requestId,
          snapshot: {
            ...queuedSnapshot,
            job: { ...queuedSnapshot.job, jobId: "job_other" },
          },
        }),
      ),
    );

    await expect(client.readReplayJob({ jobId })).rejects.toThrow(/identity that contradicts/);
  });

  it("rejects creation lineage, status markers, and cancellation contradictions", async () => {
    const wrongPlanSnapshot = {
      ...queuedSnapshot,
      job: { ...queuedSnapshot.job, plan: { ...queuedSnapshot.job.plan, planId: "plan_other" } },
    };
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(jsonResponse({ created: true, requestId, snapshot: queuedSnapshot }))
      .mockResolvedValueOnce(
        jsonResponse({ created: true, requestId, snapshot: wrongPlanSnapshot }, 201),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          {
            created: true,
            requestId,
            snapshot: { ...queuedSnapshot, cancellationRequest: null },
          },
          201,
        ),
      );
    const client = developmentClient(fetch);

    await expect(client.createReplayJob({ jobId, request: jobRequest })).rejects.toThrow(
      /inconsistent replay-job creation status/,
    );
    await expect(client.createReplayJob({ jobId, request: jobRequest })).rejects.toThrow(
      /pinned to a plan that contradicts/,
    );
    await expect(
      client.requestReplayCancellation({ jobId, request: cancellationRequest }),
    ).rejects.toThrow(/without a durable request/);
  });

  it("rejects redirects before forwarding credentials", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(
        new Response(null, { headers: { location: "https://evil.example" }, status: 307 }),
      );
    const client = developmentClient(fetch);

    await expect(client.readReplayJob({ jobId })).rejects.toThrow(/permit 0 redirects/);
    expect(fetch.mock.calls[0]?.[1]?.redirect).toBe("manual");
  });

  it.each([
    [
      "media type",
      jsonResponse({ requestId, snapshot: queuedSnapshot }, 200, {
        "cache-control": "no-store",
        "content-type": "text/plain",
      }),
      /unexpected media type/,
    ],
    [
      "cache boundary",
      jsonResponse({ requestId, snapshot: queuedSnapshot }, 200, {
        "content-type": "application/json",
      }),
      /no-store cache boundary/,
    ],
    [
      "contract",
      jsonResponse({ requestId, snapshot: { secret: "invalid" } }),
      /violates the published replay contract/,
    ],
    ["JSON", new Response("not-json", { headers: successHeaders, status: 200 }), /invalid JSON/],
    ["status", jsonResponse({ requestId, snapshot: queuedSnapshot }, 202), /unexpected HTTP 202/],
  ])("fails closed on an invalid success %s", async (_name, response, expected) => {
    const client = developmentClient(vi.fn<typeof globalThis.fetch>().mockResolvedValue(response));
    await expect(client.readReplayJob({ jobId })).rejects.toThrow(expected);
  });

  it("parses bounded problem documents without exposing arbitrary failure bodies", async () => {
    const problem = {
      code: "replay_definition_conflict",
      detail: "The immutable definition conflicts.",
      requestId,
      status: 409,
      title: "Replay definition conflict",
      type: "https://proofstack.dev/problems/replay-definition-conflict",
    };
    const validClient = developmentClient(
      vi.fn<typeof globalThis.fetch>().mockResolvedValue(
        new Response(JSON.stringify(problem), {
          headers: { "content-type": "application/problem+json" },
          status: 409,
        }),
      ),
    );
    await expect(validClient.readReplayJob({ jobId })).rejects.toBeInstanceOf(
      ProofStackProblemError,
    );

    const invalidClient = developmentClient(
      vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(new Response("upstream secret", { status: 502 })),
    );
    await expect(invalidClient.readReplayJob({ jobId })).rejects.toMatchObject({
      message: "ProofStack API rejected the request with HTTP 502",
      status: 502,
    });

    const mismatchedProblemClient = developmentClient(
      vi.fn<typeof globalThis.fetch>().mockResolvedValue(
        new Response(JSON.stringify({ ...problem, status: 400 }), {
          headers: { "content-type": "application/problem+json" },
          status: 409,
        }),
      ),
    );
    await expect(mismatchedProblemClient.readReplayJob({ jobId })).rejects.toMatchObject({
      message: "ProofStack API rejected the request with HTTP 409",
      status: 409,
    });
  });

  it("bounds declared and streamed response bodies", async () => {
    const declaredClient = developmentClient(
      vi.fn<typeof globalThis.fetch>().mockResolvedValue(
        new Response("too large", {
          headers: { ...successHeaders, "content-length": "65" },
          status: 200,
        }),
      ),
      { maxResponseBytes: 64 },
    );
    await expect(declaredClient.readReplayJob({ jobId })).rejects.toThrow(/exceeded 64 bytes/);

    const streamedClient = developmentClient(
      vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(new Response("x".repeat(65), { headers: successHeaders, status: 200 })),
      { maxResponseBytes: 64 },
    );
    await expect(streamedClient.readReplayJob({ jobId })).rejects.toThrow(/exceeded 64 bytes/);
  });

  it("turns timeout and network failures into stable API errors", async () => {
    const timeoutFetch = vi.fn<typeof globalThis.fetch>(
      async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const timeoutClient = developmentClient(timeoutFetch, { timeoutMs: 1 });
    await expect(timeoutClient.readReplayJob({ jobId })).rejects.toThrow(/timed out after 1ms/);

    const networkClient = developmentClient(
      vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error("credential-bearing URL")),
    );
    await expect(networkClient.readReplayJob({ jobId })).rejects.toMatchObject({
      message: "ProofStack replay request failed",
    });
  });

  it("never retries a rejected control-plane mutation automatically", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response("temporarily unavailable", { status: 503 }));
    const client = developmentClient(fetch);

    await expect(client.createReplayJob({ jobId, request: jobRequest })).rejects.toMatchObject({
      status: 503,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ endpoint: "relative" }, /absolute URL/],
    [{ endpoint: "ftp://proofstack.example" }, /HTTP or HTTPS/],
    [{ endpoint: "https://user:secret@proofstack.example" }, /embedded credentials/],
    [{ endpoint: "http://proofstack.example" }, /explicit loopback/],
    [{ endpoint: "https://proofstack.example" }, /Development authentication requires/],
    [{ environmentId: "INVALID" }, /environmentId failed local validation/],
    [{ timeoutMs: 0 }, /timeoutMs must be a positive integer/],
    [{ maxResponseBytes: MAX_REPLAY_CONTROL_RESPONSE_BYTES + 1 }, /maxResponseBytes/],
  ])("rejects unsafe or invalid construction options %#", (override, expected) => {
    expect(() => developmentClient(vi.fn<typeof globalThis.fetch>(), override)).toThrow(expected);
  });

  it("validates exact local mutation input before making a request", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const client = developmentClient(fetch);

    await expect(
      client.createReplayJob({ jobId, request: { ...jobRequest, jobId: "job_other" } }),
    ).rejects.toBeInstanceOf(ProofStackApiError);
    await expect(
      client.requestReplayCancellation({
        jobId,
        request: { ...cancellationRequest, cancellationId: "INVALID" },
      }),
    ).rejects.toBeInstanceOf(ProofStackApiError);
    await expect(
      client.publishTargetRelease({ definition: { ...targetDefinition, latest: true } as never }),
    ).rejects.toBeInstanceOf(ProofStackApiError);
    await expect(
      client.publishReplayPlan({
        definition: {
          ...planDefinition,
          scope: { ...planDefinition.scope, projectId: "prj_other" },
        },
      }),
    ).rejects.toThrow(/scope that contradicts/);
    expect(fetch).not.toHaveBeenCalled();
  });
});
