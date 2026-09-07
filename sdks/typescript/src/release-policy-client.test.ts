import { readFileSync } from "node:fs";
import {
  type EvidenceScope,
  PublishReleasePolicyLifecycleRequestSchema,
  PublishReleasePolicyRequestSchema,
  RELEASE_POLICY_LIFECYCLE_SCHEMA_VERSION,
  RELEASE_POLICY_SCHEMA_VERSION,
  type ReleasePolicyDefinition,
  ReleasePolicyLifecycleEventSchema,
  ReleasePolicySchema,
} from "@proofstack/contracts";
import { describe, expect, it, vi } from "vitest";
import { ProofStackProblemError } from "./regression-client.js";
import {
  MAX_RELEASE_POLICY_REDIRECTS,
  MAX_RELEASE_POLICY_RESPONSE_BYTES,
  ProofStackReleasePolicyClient,
} from "./release-policy-client.js";

interface StoredVector {
  readonly input: {
    readonly definition: ReleasePolicyDefinition;
    readonly scope: EvidenceScope;
  };
  readonly kind: string;
  readonly sha256: string;
}

const vectorDocument = JSON.parse(
  readFileSync(
    new URL(
      "../../../packages/contracts/vectors/release-policy-definition-v1.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as { readonly vectors: readonly StoredVector[] };
const vector = vectorDocument.vectors.find(({ kind }) => kind === "release_policy");
if (!vector) throw new Error("Expected a release policy definition vector");

const policy = ReleasePolicySchema.parse({
  ...structuredClone(vector.input.definition),
  definitionSha256: vector.sha256,
  publishedAt: "2026-09-06T23:00:00.000Z",
  publishedByPrincipalId: vector.input.definition.issuerPrincipalId,
  schemaVersion: RELEASE_POLICY_SCHEMA_VERSION,
  scope: vector.input.scope,
});
const {
  issuerPrincipalId: _issuerPrincipalId,
  policyId,
  policyVersionId,
  predecessor,
  ...policyRequestFields
} = vector.input.definition;
const policyRequest = PublishReleasePolicyRequestSchema.parse({
  ...policyRequestFields,
  policyVersionId,
  ...(predecessor ? { predecessorVersionId: predecessor.policyVersionId } : {}),
});
const lifecycleRequest = PublishReleasePolicyLifecycleRequestSchema.parse({
  eventId: "policy_event_sdk_withdrawal",
  kind: "withdrawn",
  reason: "The exact policy version is no longer authorized for new release decisions.",
});
const lifecycleEvent = ReleasePolicyLifecycleEventSchema.parse({
  actorPrincipalId: policy.issuerPrincipalId,
  eventId: lifecycleRequest.eventId,
  kind: lifecycleRequest.kind,
  occurredAt: "2026-09-07T01:00:00.000Z",
  policy: {
    definitionSha256: policy.definitionSha256,
    policyId,
    policyVersionId,
  },
  reason: lifecycleRequest.reason,
  schemaVersion: RELEASE_POLICY_LIFECYCLE_SCHEMA_VERSION,
  scope: policy.scope,
});
const requestId = "req_release_policy_sdk";
const successHeaders = {
  "cache-control": "private, no-store",
  "content-type": "application/json; charset=utf-8",
};
const policyRoute = `release-policies/${policyId}/versions/${policyVersionId}`;
const lifecycleRoute = `${policyRoute}/lifecycle-events`;

function jsonResponse(
  body: unknown,
  status = 200,
  headers: HeadersInit = successHeaders,
): Response {
  return new Response(JSON.stringify(body), { headers, status });
}

function policyPublicationResponse(
  returnedPolicy: unknown = policy,
  created = true,
  status = created ? 201 : 200,
): Response {
  return jsonResponse({ created, policy: returnedPolicy, requestId }, status);
}

function policyReadResponse(returnedPolicy: unknown = policy): Response {
  return jsonResponse({ policy: returnedPolicy, requestId });
}

function lifecyclePublicationResponse(
  returnedEvent: unknown = lifecycleEvent,
  created = true,
  status = created ? 201 : 200,
): Response {
  return jsonResponse({ created, event: returnedEvent, requestId }, status);
}

function lifecycleReadResponse(returnedEvent: unknown = lifecycleEvent): Response {
  return jsonResponse({ event: returnedEvent, requestId });
}

function developmentClient(fetch: typeof globalThis.fetch, overrides = {}) {
  return new ProofStackReleasePolicyClient({
    authentication: { mode: "development" },
    endpoint: "http://127.0.0.1:4318/base?ignored=true#fragment",
    environmentId: policy.scope.environmentId,
    fetch,
    projectId: policy.scope.projectId,
    ...overrides,
  });
}

describe("ProofStackReleasePolicyClient", () => {
  it.each([0, 1])("enforces streamed response bytes at the hard limit plus %i", async (excess) => {
    const json = JSON.stringify({ policy, requestId: "검".repeat(128) });
    const bytes = new TextEncoder().encode(
      json +
        " ".repeat(
          MAX_RELEASE_POLICY_RESPONSE_BYTES + excess - new TextEncoder().encode(json).byteLength,
        ),
    );
    const chunks = [bytes.subarray(0, bytes.length - 1), bytes.subarray(bytes.length - 1)];
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>(
      {
        cancel,
        pull(controller) {
          const chunk = chunks.shift();
          if (chunk) controller.enqueue(chunk);
          else controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    const response = new Response(body, {
      // A false low declared size must never bypass the actual stream-byte limit.
      headers: { ...successHeaders, "content-length": "1" },
    });
    const client = developmentClient(
      vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(response),
    );
    const result = client.readPolicy({ policyId, policyVersionId });
    if (excess === 0) {
      await expect(result).resolves.toMatchObject({ policy });
      expect(cancel).not.toHaveBeenCalled();
    } else {
      await expect(result).rejects.toThrow(`exceeded ${MAX_RELEASE_POLICY_RESPONSE_BYTES} bytes`);
      expect(cancel).toHaveBeenCalledOnce();
    }
    expect(body.locked).toBe(false);
  });

  it("publishes, retries, and reads exact policy and lifecycle records", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(policyPublicationResponse())
      .mockResolvedValueOnce(policyPublicationResponse(policy, false))
      .mockResolvedValueOnce(policyReadResponse())
      .mockResolvedValueOnce(lifecyclePublicationResponse())
      .mockResolvedValueOnce(lifecyclePublicationResponse(lifecycleEvent, false))
      .mockResolvedValueOnce(lifecycleReadResponse());
    const client = developmentClient(fetch);

    await expect(client.publishPolicy({ policyId, request: policyRequest })).resolves.toMatchObject(
      {
        created: true,
      },
    );
    await expect(client.publishPolicy({ policyId, request: policyRequest })).resolves.toMatchObject(
      {
        created: false,
      },
    );
    await expect(client.readPolicy({ policyId, policyVersionId })).resolves.toMatchObject({
      policy: { policyId, policyVersionId },
    });
    await expect(
      client.publishLifecycleEvent({ policyId, policyVersionId, request: lifecycleRequest }),
    ).resolves.toMatchObject({ created: true });
    await expect(
      client.publishLifecycleEvent({ policyId, policyVersionId, request: lifecycleRequest }),
    ).resolves.toMatchObject({ created: false });
    await expect(
      client.readLifecycleEvent({
        eventId: lifecycleEvent.eventId,
        policyId,
        policyVersionId,
      }),
    ).resolves.toMatchObject({ event: { eventId: lifecycleEvent.eventId } });

    const base =
      `http://127.0.0.1:4318/base/v1/projects/${policy.scope.projectId}` +
      `/environments/${policy.scope.environmentId}`;
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
      `${base}/${policyRoute}`,
      `${base}/${policyRoute}`,
      `${base}/${policyRoute}`,
      `${base}/${lifecycleRoute}`,
      `${base}/${lifecycleRoute}`,
      `${base}/${lifecycleRoute}/${lifecycleEvent.eventId}`,
    ]);
    expect(fetch.mock.calls.map(([, init]) => init?.redirect)).toEqual([
      "manual",
      "manual",
      "manual",
      "manual",
      "manual",
      "manual",
    ]);
    expect(fetch.mock.calls.map(([, init]) => init?.credentials)).toEqual([
      "omit",
      "omit",
      "omit",
      "omit",
      "omit",
      "omit",
    ]);
    expect(fetch.mock.calls[0]?.[1]?.body).toBe(JSON.stringify(policyRequest));
    expect(fetch.mock.calls[3]?.[1]?.body).toBe(JSON.stringify(lifecycleRequest));
  });

  it("uses browser CSRF only for authoring and limits workloads to exact reads", async () => {
    const csrfToken = `psc_v1_${"A".repeat(42)}E`;
    const browserFetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(policyPublicationResponse())
      .mockResolvedValueOnce(policyReadResponse())
      .mockResolvedValueOnce(lifecyclePublicationResponse())
      .mockResolvedValueOnce(lifecycleReadResponse());
    const browser = new ProofStackReleasePolicyClient({
      authentication: { csrfToken, mode: "browser" },
      endpoint: "https://proofstack.example",
      environmentId: policy.scope.environmentId,
      fetch: browserFetch,
      projectId: policy.scope.projectId,
    });
    await browser.publishPolicy({ policyId, request: policyRequest });
    await browser.readPolicy({ policyId, policyVersionId });
    await browser.publishLifecycleEvent({ policyId, policyVersionId, request: lifecycleRequest });
    await browser.readLifecycleEvent({
      eventId: lifecycleEvent.eventId,
      policyId,
      policyVersionId,
    });
    expect(browserFetch.mock.calls.map(([, init]) => init?.credentials)).toEqual([
      "include",
      "include",
      "include",
      "include",
    ]);
    expect(browserFetch.mock.calls[0]?.[1]?.headers).toMatchObject({
      "x-proofstack-csrf": csrfToken,
    });
    expect(browserFetch.mock.calls[1]?.[1]?.headers).not.toHaveProperty("x-proofstack-csrf");
    expect(browserFetch.mock.calls[2]?.[1]?.headers).toMatchObject({
      "x-proofstack-csrf": csrfToken,
    });
    expect(browserFetch.mock.calls[3]?.[1]?.headers).not.toHaveProperty("x-proofstack-csrf");

    const apiKey = `psk_v1_${"A".repeat(12)}_${"B".repeat(42)}E`;
    const workloadFetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(policyReadResponse())
      .mockResolvedValueOnce(lifecycleReadResponse());
    const workload = new ProofStackReleasePolicyClient({
      authentication: { apiKey, mode: "workload" },
      endpoint: "https://proofstack.example",
      environmentId: policy.scope.environmentId,
      fetch: workloadFetch,
      projectId: policy.scope.projectId,
    });
    await workload.readPolicy({ policyId, policyVersionId });
    await workload.readLifecycleEvent({
      eventId: lifecycleEvent.eventId,
      policyId,
      policyVersionId,
    });
    await expect(workload.publishPolicy({ policyId, request: policyRequest })).rejects.toThrow(
      /not workload-delegable/,
    );
    await expect(
      workload.publishLifecycleEvent({ policyId, policyVersionId, request: lifecycleRequest }),
    ).rejects.toThrow(/not workload-delegable/);
    expect(workloadFetch).toHaveBeenCalledTimes(2);
    for (const [, init] of workloadFetch.mock.calls) {
      expect(init?.headers).toMatchObject({ authorization: `Bearer ${apiKey}` });
    }
  });

  it.each([
    ["digest", { ...policy, definitionSha256: "0".repeat(64) }, /invalid public definition digest/],
    ["logical identity", { ...policy, policyId: "policy_other" }, /identity that contradicts/],
    [
      "version identity",
      { ...policy, policyVersionId: "policy_other_v1" },
      /identity that contradicts/,
    ],
    [
      "scope",
      { ...policy, scope: { ...policy.scope, projectId: "project_other" } },
      /scope that contradicts/,
    ],
  ])("rejects a policy read response with contradictory %s", async (_name, returned, expected) => {
    const client = developmentClient(
      vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(policyReadResponse(returned)),
    );
    await expect(client.readPolicy({ policyId, policyVersionId })).rejects.toThrow(expected);
  });

  it("rejects policy publication responses with changed semantics, lineage, or status", async () => {
    const changedSemantics = developmentClient(
      vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(policyPublicationResponse()),
    );
    await expect(
      changedSemantics.publishPolicy({
        policyId,
        request: { ...policyRequest, name: "A different immutable policy" },
      }),
    ).rejects.toThrow(/semantics that contradict/);

    const changedLineage = developmentClient(
      vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(policyPublicationResponse()),
    );
    await expect(
      changedLineage.publishPolicy({
        policyId,
        request: { ...policyRequest, predecessorVersionId: "policy_predecessor_v1" },
      }),
    ).rejects.toThrow(/lineage that contradicts/);

    const changedStatus = developmentClient(
      vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(policyPublicationResponse(policy, true, 200)),
    );
    await expect(changedStatus.publishPolicy({ policyId, request: policyRequest })).rejects.toThrow(
      /inconsistent/,
    );
  });

  it("rejects lifecycle responses with contradictory identity, scope, semantics, or status", async () => {
    const cases = [
      { ...lifecycleEvent, eventId: "policy_event_other" },
      {
        ...lifecycleEvent,
        policy: { ...lifecycleEvent.policy, policyVersionId: "policy_other_v1" },
      },
      { ...lifecycleEvent, scope: { ...lifecycleEvent.scope, environmentId: "env_other" } },
    ];
    for (const returned of cases) {
      const client = developmentClient(
        vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(lifecycleReadResponse(returned)),
      );
      await expect(
        client.readLifecycleEvent({
          eventId: lifecycleEvent.eventId,
          policyId,
          policyVersionId,
        }),
      ).rejects.toThrow(/contradicts/);
    }

    const changedReason = developmentClient(
      vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(
          lifecyclePublicationResponse({ ...lifecycleEvent, reason: "Different reason." }),
        ),
    );
    await expect(
      changedReason.publishLifecycleEvent({ policyId, policyVersionId, request: lifecycleRequest }),
    ).rejects.toThrow(/semantics that contradict/);

    const supersededRequest = PublishReleasePolicyLifecycleRequestSchema.parse({
      eventId: "policy_event_sdk_superseded",
      kind: "superseded",
      reason: "A new exact policy version replaces this version.",
      successorPolicyVersionId: "policy_checkout_staging_v2",
    });
    const wrongSuccessor = ReleasePolicyLifecycleEventSchema.parse({
      ...lifecycleEvent,
      eventId: supersededRequest.eventId,
      kind: "superseded",
      reason: supersededRequest.reason,
      successor: {
        definitionSha256: "1".repeat(64),
        policyId,
        policyVersionId: "policy_checkout_staging_v3",
      },
    });
    const changedSuccessor = developmentClient(
      vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(lifecyclePublicationResponse(wrongSuccessor)),
    );
    await expect(
      changedSuccessor.publishLifecycleEvent({
        policyId,
        policyVersionId,
        request: supersededRequest,
      }),
    ).rejects.toThrow(/successor lineage that contradicts/);

    const changedStatus = developmentClient(
      vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(lifecyclePublicationResponse(lifecycleEvent, false, 201)),
    );
    await expect(
      changedStatus.publishLifecycleEvent({
        policyId,
        policyVersionId,
        request: lifecycleRequest,
      }),
    ).rejects.toThrow(/inconsistent/);
  });

  it("fails closed on redirects, caching, body bounds, media types, JSON, and problems", async () => {
    const read = (client: ProofStackReleasePolicyClient) =>
      client.readPolicy({ policyId, policyVersionId });

    const redirect = developmentClient(
      vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(new Response(null, { status: 302 })),
    );
    await expect(read(redirect)).rejects.toThrow(
      `permit ${MAX_RELEASE_POLICY_REDIRECTS} redirects`,
    );

    const cacheable = developmentClient(
      vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(
          jsonResponse({ policy, requestId }, 200, { "content-type": "application/json" }),
        ),
    );
    await expect(read(cacheable)).rejects.toThrow(/no-store/);

    const oversized = developmentClient(
      vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(
        new Response("{}", {
          headers: {
            "content-length": String(MAX_RELEASE_POLICY_RESPONSE_BYTES + 1),
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
        new Response(JSON.stringify({ policy, requestId }), {
          headers: { "cache-control": "no-store", "content-type": "text/plain" },
        }),
      ),
    );
    await expect(read(wrongMediaType)).rejects.toThrow(/unexpected media type/);

    const unexpectedStatus = developmentClient(
      vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(jsonResponse({ policy, requestId }, 202)),
    );
    await expect(read(unexpectedStatus)).rejects.toThrow(/unexpected HTTP 202/);

    const invalidContract = developmentClient(
      vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(jsonResponse({ requestId })),
    );
    await expect(read(invalidContract)).rejects.toThrow(/published release policy contract/);

    const problem = developmentClient(
      vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(
        jsonResponse(
          {
            code: "release_policy_not_found",
            detail: "Release policy unavailable",
            requestId,
            status: 404,
            title: "Release policy not found",
            type: "https://proofstack.dev/problems/release-policy-not-found",
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
      environmentId: policy.scope.environmentId,
      fetch: vi.fn<typeof globalThis.fetch>(),
      projectId: policy.scope.projectId,
    };
    expect(() => new ProofStackReleasePolicyClient({ ...common, endpoint: "relative" })).toThrow(
      /absolute URL/,
    );
    expect(
      () => new ProofStackReleasePolicyClient({ ...common, endpoint: "ftp://127.0.0.1" }),
    ).toThrow(/HTTP or HTTPS/);
    expect(
      () =>
        new ProofStackReleasePolicyClient({
          ...common,
          endpoint: "http://user:pass@127.0.0.1",
        }),
    ).toThrow(/embedded credentials/);
    expect(
      () =>
        new ProofStackReleasePolicyClient({
          ...common,
          endpoint: "http://proofstack.example",
        }),
    ).toThrow(/loopback/);
    expect(
      () =>
        new ProofStackReleasePolicyClient({
          ...common,
          endpoint: "https://proofstack.example",
        }),
    ).toThrow(/Development authentication/);
    expect(
      () =>
        new ProofStackReleasePolicyClient({
          ...common,
          authentication: { csrfToken: "invalid", mode: "browser" },
          endpoint: "https://proofstack.example",
        }),
    ).toThrow(/CSRF token/);
    expect(
      () =>
        new ProofStackReleasePolicyClient({
          ...common,
          authentication: { apiKey: "invalid", mode: "workload" },
          endpoint: "https://proofstack.example",
        }),
    ).toThrow(/API key/);
    expect(
      () =>
        new ProofStackReleasePolicyClient({
          ...common,
          authentication: { mode: "invalid" } as never,
          endpoint: "https://proofstack.example",
        }),
    ).toThrow(/authentication mode is invalid/);
    expect(
      () =>
        new ProofStackReleasePolicyClient({
          ...common,
          endpoint: "http://localhost",
          timeoutMs: 0,
        }),
    ).toThrow(/timeoutMs/);
    expect(
      () =>
        new ProofStackReleasePolicyClient({
          ...common,
          endpoint: "http://[::1]",
          maxResponseBytes: MAX_RELEASE_POLICY_RESPONSE_BYTES + 1,
        }),
    ).toThrow(/maxResponseBytes/);

    const fetch = vi.fn<typeof globalThis.fetch>();
    const client = developmentClient(fetch);
    await expect(client.readPolicy({ policyId: "INVALID", policyVersionId })).rejects.toThrow(
      /policyId failed local validation/,
    );
    await expect(client.readPolicy({ policyId, policyVersionId: "INVALID" })).rejects.toThrow(
      /policyVersionId failed local validation/,
    );
    await expect(
      client.readLifecycleEvent({ eventId: "INVALID", policyId, policyVersionId }),
    ).rejects.toThrow(/eventId failed local validation/);
    await expect(
      client.publishPolicy({ policyId: "INVALID", request: policyRequest }),
    ).rejects.toThrow(/policyId failed local validation/);
    await expect(
      client.publishPolicy({
        policyId,
        request: { ...policyRequest, releaseDecision: "allow" } as never,
      }),
    ).rejects.toThrow(/publication failed local validation/);
    await expect(
      client.publishLifecycleEvent({
        policyId,
        policyVersionId,
        request: { ...lifecycleRequest, deploy: true } as never,
      }),
    ).rejects.toThrow(/lifecycle publication failed local validation/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects construction without fetch and normalizes transport failures and timeouts", async () => {
    vi.stubGlobal("fetch", undefined);
    try {
      expect(
        () =>
          new ProofStackReleasePolicyClient({
            authentication: { mode: "development" },
            endpoint: "http://127.0.0.1",
            environmentId: policy.scope.environmentId,
            projectId: policy.scope.projectId,
          }),
      ).toThrow(/No fetch implementation/);
    } finally {
      vi.unstubAllGlobals();
    }

    const failed = developmentClient(
      vi.fn<typeof globalThis.fetch>().mockRejectedValueOnce(new Error("socket failed")),
    );
    await expect(failed.readPolicy({ policyId, policyVersionId })).rejects.toThrow(
      /request failed/,
    );

    const abortingFetch = vi.fn<typeof globalThis.fetch>((_url, init) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    });
    const timedOut = developmentClient(abortingFetch, { timeoutMs: 1 });
    await expect(timedOut.readPolicy({ policyId, policyVersionId })).rejects.toThrow(
      /timed out after 1ms/,
    );
  });
});
