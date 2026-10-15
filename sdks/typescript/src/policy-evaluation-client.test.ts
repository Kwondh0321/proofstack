import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it, vi, afterEach } from "vitest";
import {
  MAX_POLICY_EVALUATION_SNAPSHOT_INPUT_BYTES,
  OpaqueIdSchema,
  encodeEvaluationCanonicalJson,
  encodePolicyEvaluationSnapshotInputs,
  encodePolicyEvaluationSnapshotDefinition,
  encodePolicyEvaluationSnapshotPageDefinition,
  POLICY_EVALUATION_SNAPSHOT_FRAME_BYTES,
  POLICY_EVALUATION_SNAPSHOT_PAGE_SIZE,
  MAX_POLICY_EVALUATION_JOB_RESPONSE_BYTES,
  type EnqueuePolicyEvaluationRequest,
  type EvidenceScope,
  type PolicyEvaluationJobSnapshot,
  type PolicyEvaluationJobReference,
  type PolicyEvaluationSnapshot,
  type PolicyEvaluationSnapshotPage,
  type PolicyEvaluation,
  type PolicyEvaluationJobHistoryHead,
  type PolicyEvaluationJobHistoryPage,
  type PolicyEvaluationSnapshotInputs,
} from "@proofstack/contracts";
import {
  ProofStackPolicyEvaluationClient,
  type ProofStackPolicyEvaluationClientOptions,
} from "./policy-evaluation-client.js";
import { ProofStackApiError, ProofStackProblemError } from "./regression-client.js";
import { PolicyEvaluationTransport } from "./policy-evaluation-http.js";

interface Vector {
  scope: EvidenceScope;
  job: PolicyEvaluationJobReference;
  request: EnqueuePolicyEvaluationRequest;
  queued: PolicyEvaluationJobSnapshot;
  sealed: PolicyEvaluationJobSnapshot;
  completed: PolicyEvaluationJobSnapshot;
  cancelled: PolicyEvaluationJobSnapshot;
  snapshot: PolicyEvaluationSnapshot;
  pages: PolicyEvaluationSnapshotPage[];
  inputs: PolicyEvaluationSnapshotInputs;
  evaluation: PolicyEvaluation;
  head: PolicyEvaluationJobHistoryHead;
  history: PolicyEvaluationJobHistoryPage;
  historyTwo: { head: PolicyEvaluationJobHistoryHead; pages: PolicyEvaluationJobHistoryPage[] };
}
const sourceVector = JSON.parse(
  readFileSync(
    new URL("../vectors/policy-evaluation-api-v1.fixture.json", import.meta.url),
    "utf8",
  ),
) as Omit<Vector, "inputs">;
const inputEnvelope = JSON.parse(
  Buffer.concat(
    sourceVector.pages.flatMap((page) =>
      page.frames.map((frame) => Buffer.from(frame.dataBase64url, "base64url")),
    ),
  ).toString("utf8"),
) as Record<string, unknown>;
const { definitionDomain: _domain, encodingVersion: _encoding, ...originalInputs } = inputEnvelope;
const vector: Vector = {
  ...sourceVector,
  inputs: originalInputs as PolicyEvaluationSnapshotInputs,
};
const copy = () => structuredClone(vector);
const nodeSha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function replaceInput(v: Vector, bytes: Uint8Array, declaredSha = nodeSha(bytes)) {
  const frameCount = Math.ceil(bytes.byteLength / POLICY_EVALUATION_SNAPSHOT_FRAME_BYTES);
  const frames = Array.from({ length: frameCount }, (_, frameIndex) => ({
    frameIndex,
    dataBase64url: Buffer.from(
      bytes.subarray(
        frameIndex * POLICY_EVALUATION_SNAPSHOT_FRAME_BYTES,
        (frameIndex + 1) * POLICY_EVALUATION_SNAPSHOT_FRAME_BYTES,
      ),
    ).toString("base64url"),
  }));
  const pages: PolicyEvaluationSnapshotPage[] = [];
  for (let start = 0; start < frames.length; start += POLICY_EVALUATION_SNAPSHOT_PAGE_SIZE) {
    const definition = {
      snapshotId: v.snapshot.snapshotId,
      request: v.snapshot.request,
      inputSha256: declaredSha,
      inputByteLength: bytes.byteLength,
      frameCount,
      pageIndex: pages.length,
      frames: frames.slice(start, start + POLICY_EVALUATION_SNAPSHOT_PAGE_SIZE),
    };
    pages.push({
      ...definition,
      scope: v.scope,
      schemaVersion: "0.1",
      definitionSha256: nodeSha(
        encodePolicyEvaluationSnapshotPageDefinition({ scope: v.scope, definition }),
      ),
    });
  }
  const definition = {
    snapshotId: v.snapshot.snapshotId,
    request: v.snapshot.request,
    candidate: v.snapshot.candidate,
    policy: v.snapshot.policy,
    algorithm: v.snapshot.algorithm,
    evaluationTime: v.snapshot.evaluationTime,
    capturedAt: v.snapshot.capturedAt,
    manifest: v.snapshot.manifest,
    inputSha256: declaredSha,
    inputByteLength: bytes.byteLength,
    frameCount,
    pages: pages.map((page) => ({
      pageIndex: page.pageIndex,
      definitionSha256: page.definitionSha256,
      firstFrameIndex: page.frames[0]!.frameIndex,
      frameCount: page.frames.length,
    })),
  };
  v.snapshot = {
    ...v.snapshot,
    ...definition,
    definitionSha256: nodeSha(
      encodePolicyEvaluationSnapshotDefinition({ scope: v.scope, definition }),
    ),
  };
  v.pages = pages;
  const reference = {
    snapshotId: v.snapshot.snapshotId,
    definitionSha256: v.snapshot.definitionSha256,
  };
  for (const graph of [v.sealed, v.completed]) {
    graph.job.snapshot = { ...reference };
    for (const attempt of graph.attempts) if (attempt.snapshot) attempt.snapshot = { ...reference };
  }
}
const requestId = "request_policy_sdk";
const token = `psk_v1_${"A".repeat(12)}_${"B".repeat(42)}E`;
const csrfToken = `psc_v1_${"A".repeat(43)}`;
function json(value: unknown, status = 200, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...extra },
  });
}
function server(v = copy(), phase: "queued" | "sealed" | "completed" | "cancelled" = "completed") {
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const url = new URL(String(input)),
      path = url.pathname;
    if (init?.method === "POST" && path.endsWith("/policy-evaluation-jobs"))
      return json({ created: true, snapshot: v.queued, requestId }, 201);
    if (path.endsWith("/cancellation")) {
      phase = "cancelled";
      return json({ snapshot: v.cancelled, requestId });
    }
    if (path.endsWith("/request")) return json({ request: v.queued.request, requestId });
    if (path.endsWith("/snapshot")) return json({ snapshot: v.snapshot, requestId });
    if (path.includes("/snapshot/pages/"))
      return json({
        snapshot: {
          snapshotId: v.snapshot.snapshotId,
          definitionSha256: v.snapshot.definitionSha256,
        },
        page: v.pages[Number(path.split("/").at(-1))],
        requestId,
      });
    if (path.endsWith("/result")) return json({ evaluation: v.evaluation, requestId });
    if (path.endsWith("/history")) return json({ head: v.head, requestId });
    if (path.includes("/history/pages/")) return json({ page: v.history, requestId });
    return json({ snapshot: v[phase], requestId });
  });
  return { fetch, v };
}
function client(
  fetch: typeof globalThis.fetch,
  options: Partial<ProofStackPolicyEvaluationClientOptions> = {},
) {
  return new ProofStackPolicyEvaluationClient({
    endpoint: "http://127.0.0.1:4318",
    scope: vector.scope,
    authentication: { mode: "development" },
    fetch,
    ...options,
  });
}
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("policy SDK bounded authenticated transport", () => {
  it("retains one deadline across header, owning graph and every page", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("crypto", {
      subtle: {
        digest: async (_algorithm: string, data: ArrayBuffer) =>
          Uint8Array.from(createHash("sha256").update(new Uint8Array(data)).digest()).buffer,
      },
    });
    const s = server();
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      return s.fetch(input, init);
    });
    let failure: unknown;
    const pending = client(fetch, { timeoutMs: 45 })
      .readCompleteSnapshot({ job: vector.job })
      .catch((cause) => {
        failure = cause;
      });
    await vi.advanceTimersByTimeAsync(45);
    expect(failure).toMatchObject({ message: expect.stringContaining("timed out") });
    expect(fetch).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(20);
    await pending;
    expect(fetch).toHaveBeenCalledTimes(5);
  });
  it("aborts during the actual pending reader and drains cancellation before returning", async () => {
    const controller = new AbortController();
    let started!: () => void,
      cancelled = 0;
    const reading = new Promise<void>((resolve) => {
      started = resolve;
    });
    const stream = new ReadableStream<Uint8Array>(
      {
        pull() {
          started();
          return new Promise<void>(() => {});
        },
        cancel() {
          cancelled++;
        },
      },
      { highWaterMark: 0 },
    );
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(stream, {
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      }),
    );
    const pending = client(fetch).readJob({ job: vector.job, signal: controller.signal });
    await reading;
    controller.abort();
    await expect(pending).rejects.toThrow("aborted");
    expect(cancelled).toBe(1);
    expect(stream.locked).toBe(false);
  });
  it("notices abort that occurs synchronously inside fetch and cancels the late response", async () => {
    const controller = new AbortController();
    let cancelled = 0;
    const stream = new ReadableStream({
      cancel() {
        cancelled++;
      },
    });
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      controller.abort();
      return new Response(stream);
    });
    await expect(
      client(fetch).readJob({ job: vector.job, signal: controller.signal }),
    ).rejects.toThrow("aborted");
    await Promise.resolve();
    expect(cancelled).toBe(1);
    expect(fetch).toHaveBeenCalledOnce();
  });
  it.each([301, 302, 303, 307, 308])(
    "rejects HTTP %i without another credential-bearing request",
    async (status) => {
      let cancelled = 0;
      const body = new ReadableStream({
        cancel() {
          cancelled++;
        },
      });
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(
          new Response(body, { status, headers: { location: "https://other.example.test" } }),
        );
      await expect(
        client(fetch, { authentication: { mode: "workload", apiKey: token } }).enqueue({
          request: vector.request,
        }),
      ).rejects.toThrow("redirect");
      expect(fetch).toHaveBeenCalledOnce();
      expect(cancelled).toBe(1);
      expect(body.locked).toBe(false);
    },
  );
  it.each(["redirected", "opaqueredirect"])(
    "rejects an already %s response and closes its body",
    async (kind) => {
      let cancelled = 0;
      const body = new ReadableStream({
          cancel() {
            cancelled++;
          },
        }),
        response = new Response(body);
      Object.defineProperty(response, kind === "redirected" ? "redirected" : "type", {
        value: kind === "redirected" ? true : kind,
      });
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response);
      await expect(client(fetch).readJob({ job: vector.job })).rejects.toThrow("redirect");
      expect(cancelled).toBe(1);
      expect(body.locked).toBe(false);
    },
  );
  it.each(
    [
      { "content-type": "text/html" },
      { "content-type": "application/problem+json" },
      { "cache-control": "private" },
      { "cache-control": "nostore" },
      { "content-length": "garbage" },
      { "content-length": "-1" },
      { "content-length": "01" },
      { "content-length": "1.5" },
      { "content-length": "99999999999999999999999999" },
      { "content-length": "65537" },
    ].map((headers, index) => ({ headers, index })),
  )("rejects invalid media/cache/advertised size $index", async ({ headers }) => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(json({ snapshot: vector.completed, requestId }, 200, headers));
    await expect(client(fetch).readJob({ job: vector.job })).rejects.toBeInstanceOf(
      ProofStackApiError,
    );
    expect(fetch).toHaveBeenCalledOnce();
  });
  it("requires no-store on problems and verifies the problem's HTTP status", async () => {
    const problem = {
      code: "policy_evaluation_job_not_found",
      detail: "Exact job absent",
      requestId,
      status: 404,
      title: "Not found",
      type: "https://proofstack.dev/problems/policy-evaluation-not-found",
    };
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        json(problem, 404, {
          "content-type": "application/problem+json",
          "cache-control": "private",
        }),
      )
      .mockResolvedValueOnce(
        json({ ...problem, status: 409 }, 404, { "content-type": "application/problem+json" }),
      )
      .mockResolvedValueOnce(json(problem, 404, { "content-type": "application/problem+json" }));
    const sdk = client(fetch);
    await expect(sdk.readJob({ job: vector.job })).rejects.toThrow("no-store");
    await expect(sdk.readJob({ job: vector.job })).rejects.toThrow("status differs");
    await expect(sdk.readJob({ job: vector.job })).rejects.toMatchObject({
      name: "ProofStackProblemError",
      status: 404,
      code: problem.code,
      requestId,
    });
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it.each([
    "missing body",
    "invalid JSON",
    "unexpected status",
    "malformed schema",
    "wrong declared length",
  ])("rejects %s", async (kind) => {
    let response: Response;
    if (kind === "missing body")
      response = new Response(null, {
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      });
    else if (kind === "invalid JSON")
      response = new Response("{", {
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      });
    else
      response = json(
        kind === "malformed schema" ? {} : { snapshot: vector.completed, requestId },
        kind === "unexpected status" ? 202 : 200,
        kind === "wrong declared length" ? { "content-length": "1" } : {},
      );
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response);
    await expect(client(fetch).readJob({ job: vector.job })).rejects.toBeInstanceOf(
      ProofStackApiError,
    );
  });
  it.each([-1, 0, 1])(
    "enforces actual request bytes before sending at offset %s",
    async (offset) => {
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json("accepted"));
      const transport = new PolicyEvaluationTransport({
        endpoint: "http://127.0.0.1",
        scope: vector.scope,
        authentication: { mode: "development" },
        fetch,
      });
      const body = "a".repeat(16 - 2 + offset);
      const run = transport.run(undefined, (operation) =>
        operation.request([], undefined, "POST", body, 16, 128, OpaqueIdSchema, [200]),
      );
      if (offset > 0) {
        await expect(run).rejects.toThrow("request exceeds");
        expect(fetch).not.toHaveBeenCalled();
      } else {
        expect((await run).value).toBe("accepted");
        expect(fetch).toHaveBeenCalledOnce();
      }
    },
  );
  it.each([-1, 0, 1])("enforces actual streamed response bytes at offset %s", async (offset) => {
    const body = JSON.stringify("a".repeat(16 - 2 + offset));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body));
        controller.close();
      },
    });
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(stream, {
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      }),
    );
    const transport = new PolicyEvaluationTransport({
      endpoint: "http://127.0.0.1",
      scope: vector.scope,
      authentication: { mode: "development" },
      fetch,
    });
    const run = transport.run(undefined, (operation) =>
      operation.request([], undefined, "GET", undefined, 0, 16, OpaqueIdSchema, [200]),
    );
    if (offset > 0) await expect(run).rejects.toThrow("streamed");
    else expect((await run).value).toBe("a".repeat(14 + offset));
    expect(stream.locked).toBe(false);
  });
  it("enforces the smaller route limit even with a larger configured response budget", async () => {
    const text = JSON.stringify({ snapshot: vector.completed, requestId });
    const body =
      text +
      " ".repeat(
        MAX_POLICY_EVALUATION_JOB_RESPONSE_BYTES + 1 - new TextEncoder().encode(text).byteLength,
      );
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(body, {
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      }),
    );
    await expect(
      client(fetch, { maxResponseBytes: 524288 }).readJob({ job: vector.job }),
    ).rejects.toThrow("streamed");
  });
  it("counts split UTF-8 by bytes and rejects malformed UTF-8 before JSON parsing", async () => {
    let cancelled = 0;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([0xff]));
      },
      cancel() {
        cancelled++;
      },
    });
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(stream, {
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      }),
    );
    await expect(client(fetch).readJob({ job: vector.job })).rejects.toThrow("operation failed");
    expect(cancelled).toBe(1);
    expect(stream.locked).toBe(false);
  });
  it.each([-1, 0, 1])(
    "preserves split multibyte UTF-8 and counts real response bytes at offset %s",
    async (offset) => {
      const problem = {
        code: "job_absent",
        detail: "한글",
        requestId,
        status: 404,
        title: "Not found",
        type: "https://proofstack.dev/problems/job-absent",
      };
      const bytes = new TextEncoder().encode(JSON.stringify(problem));
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
          controller.close();
        },
      });
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
        new Response(stream, {
          status: 404,
          headers: { "content-type": "application/problem+json", "cache-control": "no-store" },
        }),
      );
      const run = client(fetch, { maxResponseBytes: bytes.byteLength + offset }).readJob({
        job: vector.job,
      });
      if (offset < 0) await expect(run).rejects.toThrow("streamed");
      else
        await expect(run).rejects.toMatchObject({
          name: "ProofStackProblemError",
          detail: "한글",
          status: 404,
        });
      expect(stream.locked).toBe(false);
    },
  );
  it("does not fetch for an already aborted operation", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(),
      controller = new AbortController();
    controller.abort();
    await expect(
      client(fetch).readJob({ job: vector.job, signal: controller.signal }),
    ).rejects.toThrow("aborted");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("aborts a pending fetch and discards/cancels a late response without mutation retry", async () => {
    const controller = new AbortController();
    let resolve!: (response: Response) => void,
      cancelled = 0;
    const fetch = vi.fn<typeof globalThis.fetch>(
      () =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    );
    const run = client(fetch).enqueue({ request: vector.request, signal: controller.signal });
    controller.abort();
    await expect(run).rejects.toThrow("aborted");
    const stream = new ReadableStream({
      cancel() {
        cancelled++;
      },
    });
    resolve(new Response(stream));
    await Promise.resolve();
    await Promise.resolve();
    expect(cancelled).toBe(1);
    expect(fetch).toHaveBeenCalledOnce();
  });
  it("times out a stalled read, cancels/releases its reader and does not retry", async () => {
    let cancelled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull: () => new Promise<void>(() => {}),
      cancel() {
        cancelled++;
      },
    });
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(stream, {
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      }),
    );
    await expect(client(fetch, { timeoutMs: 20 }).readJob({ job: vector.job })).rejects.toThrow(
      "timed out",
    );
    expect(cancelled).toBe(1);
    expect(stream.locked).toBe(false);
    expect(fetch).toHaveBeenCalledOnce();
  });
  it("bounds stalled cancellation and releases the reader when the deadline expires", async () => {
    let cancelled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull: () => new Promise<void>(() => {}),
      cancel() {
        cancelled++;
        return new Promise<void>(() => {});
      },
    });
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(stream, {
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      }),
    );
    await expect(client(fetch, { timeoutMs: 20 }).readJob({ job: vector.job })).rejects.toThrow(
      "timed out",
    );
    expect(cancelled).toBe(1);
    expect(stream.locked).toBe(false);
    expect(fetch).toHaveBeenCalledOnce();
  });
  it("bounds stalled response disposal and preserves the original redirect rejection", async () => {
    let cancelled = 0;
    const stream = new ReadableStream({
      cancel() {
        cancelled++;
        return new Promise<void>(() => {});
      },
    });
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response(stream, { status: 302 }));
    await expect(client(fetch, { timeoutMs: 20 }).readJob({ job: vector.job })).rejects.toThrow(
      "redirect",
    );
    expect(cancelled).toBe(1);
    expect(stream.locked).toBe(false);
    expect(fetch).toHaveBeenCalledOnce();
  });
  it("preserves a request rejection and a distinct reader cleanup failure", async () => {
    const cleanup = new Error("test cancellation failed");
    const stream = new ReadableStream({
      cancel() {
        throw cleanup;
      },
    });
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response(stream, { status: 302 }));
    const failure = await client(fetch)
      .readJob({ job: vector.job })
      .catch((cause) => cause);
    expect(failure).toBeInstanceOf(ProofStackApiError);
    expect(failure.cause).toBeInstanceOf(AggregateError);
    expect(failure.cause.errors[0]).toMatchObject({ message: expect.stringContaining("redirect") });
    expect(failure.cause.errors[1]).toBe(cleanup);
    expect(stream.locked).toBe(false);
  });
  it("preserves an ordinary network failure without retry", async () => {
    const failure = new Error("test offline"),
      fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(failure);
    await expect(
      client(fetch).cancel({ job: vector.job, request: { reason: "operator_requested" } }),
    ).rejects.toMatchObject({ name: "ProofStackApiError", cause: failure });
    expect(fetch).toHaveBeenCalledOnce();
  });
  it("uses the default fetch only when an implementation exists", async () => {
    const s = server();
    vi.stubGlobal("fetch", s.fetch);
    const sdk = new ProofStackPolicyEvaluationClient({
      endpoint: "http://localhost",
      scope: vector.scope,
      authentication: { mode: "development" },
    });
    expect((await sdk.readJob({ job: vector.job })).snapshot).toEqual(vector.completed);
    vi.stubGlobal("fetch", undefined);
    expect(
      () =>
        new ProofStackPolicyEvaluationClient({
          endpoint: "http://localhost",
          scope: vector.scope,
          authentication: { mode: "development" },
        }),
    ).toThrow("No fetch");
  });
});

describe("policy evaluation SDK exact records", () => {
  it("links consecutive pages through a retained predecessor and the original terminal head", async () => {
    const v = copy(),
      head = v.historyTwo.head;
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const index = Number(new URL(String(input)).pathname.split("/").at(-1));
      return json({ page: v.historyTwo.pages[index], requestId });
    });
    const sdk = client(fetch);
    const first = (await sdk.readHistoryPage({ job: v.job, head, pageIndex: 0 })).page;
    expect(first.entries).toHaveLength(100);
    const second = (
      await sdk.readHistoryPage({
        job: v.job,
        head,
        pageIndex: 1,
        predecessor: first.entries.at(-1)!,
      })
    ).page;
    expect(second.entries).toHaveLength(1);
    expect(second.entries.at(-1)!.entrySha256).toBe(head.entrySha256);
    expect(second.entries[0]!.definition.predecessorEntrySha256).toBe(
      first.entries.at(-1)!.entrySha256,
    );
  });
  it("retains the seven-rule independently captured canonical input and all original pages", async () => {
    const s = server(),
      sdk = client(s.fetch);
    const result = await sdk.readCompleteSnapshot({ job: vector.job });
    expect(result.snapshot).toEqual(vector.snapshot);
    expect(result.pageSet.pages).toEqual(vector.pages);
    expect(result.inputs).toEqual(vector.inputs);
    expect(result.snapshot.inputSha256).toBe(
      "13a252ac9d42d18574bada286bbd85a2ed6c0f21bd84ef285804d617931074bd",
    );
    expect(result.snapshot.inputByteLength).toBe(560089);
    expect(s.fetch).toHaveBeenCalledTimes(2 + vector.pages.length);
  });
  it("verifies result identity, original rule order and distinct sealing/deciding receipts", async () => {
    const s = server(),
      sdk = client(s.fetch);
    expect((await sdk.readResult({ job: vector.job })).evaluation).toEqual(vector.evaluation);
    expect(vector.evaluation.ruleCount).toBe(7);
    expect(vector.evaluation.attemptId).not.toBe(vector.snapshot.attemptId);
    expect(vector.evaluation.workerId).not.toBe(vector.snapshot.workerId);
    expect(vector.evaluation.fencingToken).toBeGreaterThan(vector.snapshot.fencingToken);
    expect(s.fetch).toHaveBeenCalledTimes(4 + vector.pages.length);
  });
  it("enqueues one server-owned job and reads its original job/request", async () => {
    const s = server(copy(), "queued"),
      sdk = client(s.fetch);
    const created = await sdk.enqueue({ request: vector.request });
    expect(created.created).toBe(true);
    expect(created.snapshot).toEqual(vector.queued);
    expect((await sdk.readJob({ job: vector.job })).snapshot).toEqual(vector.queued);
    expect((await sdk.readRequest({ job: vector.job })).request).toEqual(vector.queued.request);
    const [url, init] = s.fetch.mock.calls[0]!;
    expect(new URL(String(url)).pathname).toBe(
      `/v1/projects/${vector.scope.projectId}/environments/${vector.scope.environmentId}/policy-evaluation-jobs`,
    );
    expect(JSON.parse(String(init?.body))).toEqual(vector.request);
    expect(init).toMatchObject({ method: "POST", redirect: "manual", credentials: "omit" });
  });
  it("accepts an exact retry that retains a completed original job", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(json({ created: false, snapshot: vector.completed, requestId }));
    const result = await client(fetch).enqueue({ request: vector.request });
    expect(result.created).toBe(false);
    expect(result.snapshot).toEqual(vector.completed);
    expect(fetch).toHaveBeenCalledOnce();
  });
  it("cancels with a reason-only body and retains the original intent", async () => {
    const s = server(copy(), "queued"),
      sdk = client(s.fetch);
    const result = await sdk.cancel({ job: vector.job, request: { reason: "operator_requested" } });
    expect(result.snapshot).toEqual(vector.cancelled);
    expect(JSON.parse(String(s.fetch.mock.calls[0]![1]?.body))).toEqual({
      reason: "operator_requested",
    });
    expect((await sdk.readJob({ job: vector.job })).snapshot).toEqual(vector.cancelled);
  });
  it("reads the original head/page and preserves every canonical history entry", async () => {
    const s = server(),
      sdk = client(s.fetch);
    expect((await sdk.readHistoryHead({ job: vector.job })).head).toEqual(vector.head);
    expect(
      (await sdk.readHistoryPage({ job: vector.job, head: vector.head, pageIndex: 0 })).page,
    ).toEqual(vector.history);
    const url = new URL(String(s.fetch.mock.calls[1]![0]));
    expect(Object.fromEntries(url.searchParams)).toEqual({
      jobDefinitionSha256: vector.job.definitionSha256,
      sequence: String(vector.head.sequence),
      entrySha256: vector.head.entrySha256,
      graphSha256: vector.head.graphSha256,
    });
  });
  it("binds a page to its retained original header and descriptor", async () => {
    const s = server(),
      sdk = client(s.fetch);
    const read = await sdk.readSnapshotPage({
      job: vector.job,
      snapshot: vector.snapshot,
      pageIndex: 1,
    });
    expect(read.page).toEqual(vector.pages[1]);
    const url = new URL(String(s.fetch.mock.calls[0]![0]));
    expect(Object.fromEntries(url.searchParams)).toEqual({
      snapshotId: vector.snapshot.snapshotId,
      definitionSha256: vector.snapshot.definitionSha256,
    });
  });
  it("sends only validated workload authentication without browser credentials", async () => {
    const s = server(),
      sdk = client(s.fetch, {
        endpoint: "https://api.example.test/prefix/?ignored=true#ignored",
        authentication: { mode: "workload", apiKey: token },
      });
    await sdk.readJob({ job: vector.job });
    const [url, init] = s.fetch.mock.calls[0]!;
    expect(new URL(String(url)).pathname).toContain("/prefix/v1/projects/");
    expect(String(url)).not.toContain("ignored");
    expect(init).toMatchObject({
      credentials: "omit",
      headers: { authorization: `Bearer ${token}` },
    });
  });
  it("sends browser CSRF only for mutation and copies admitted authentication", async () => {
    const s = server(copy(), "queued"),
      authentication = { mode: "browser" as const, csrfToken },
      sdk = client(s.fetch, { authentication });
    authentication.csrfToken = "changed-after-admission";
    await sdk.readJob({ job: vector.job });
    await sdk.cancel({ job: vector.job, request: { reason: "operator_requested" } });
    expect(s.fetch.mock.calls[0]![1]).toMatchObject({ credentials: "include" });
    expect(new Headers(s.fetch.mock.calls[0]![1]?.headers).has("x-proofstack-csrf")).toBe(false);
    expect(new Headers(s.fetch.mock.calls[1]![1]?.headers).get("x-proofstack-csrf")).toBe(
      csrfToken,
    );
  });
  it.each(
    [
      { endpoint: "relative" },
      { endpoint: "ftp://api.example.test" },
      { endpoint: "https://user:password@api.example.test" },
      { endpoint: "http://api.example.test" },
      { endpoint: "https://api.example.test" },
      { scope: { ...vector.scope, tenantId: "" } },
      ...[0, -1, 0.5, 60001, Number.POSITIVE_INFINITY].map((timeoutMs) => ({ timeoutMs })),
      ...[0, -1, 0.5, 524289].map((maxResponseBytes) => ({ maxResponseBytes })),
      ...[0, -1, 0.5, MAX_POLICY_EVALUATION_SNAPSHOT_INPUT_BYTES + 1].map(
        (maxSnapshotInputBytes) => ({ maxSnapshotInputBytes }),
      ),
      { authentication: { mode: "workload", apiKey: "invalid" } },
      { authentication: { mode: "browser", csrfToken: "invalid" } },
      { authentication: { mode: "unknown" } },
      { authentication: null },
    ].map((options, index) => ({ options, index })),
  )("rejects invalid local options before fetch $index", ({ options }) => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    expect(() =>
      client(fetch, options as Partial<ProofStackPolicyEvaluationClientOptions>),
    ).toThrow(ProofStackApiError);
    expect(fetch).not.toHaveBeenCalled();
  });
});

type Operation =
  | "enqueue"
  | "job"
  | "request"
  | "header"
  | "page"
  | "complete"
  | "result"
  | "head"
  | "history"
  | "cancel";
function exercise(sdk: ProofStackPolicyEvaluationClient, operation: Operation) {
  switch (operation) {
    case "enqueue":
      return sdk.enqueue({ request: vector.request });
    case "job":
      return sdk.readJob({ job: vector.job });
    case "request":
      return sdk.readRequest({ job: vector.job });
    case "header":
      return sdk.readSnapshot({ job: vector.job });
    case "page":
      return sdk.readSnapshotPage({ job: vector.job, snapshot: vector.snapshot, pageIndex: 0 });
    case "complete":
      return sdk.readCompleteSnapshot({ job: vector.job });
    case "result":
      return sdk.readResult({ job: vector.job });
    case "head":
      return sdk.readHistoryHead({ job: vector.job });
    case "history":
      return sdk.readHistoryPage({ job: vector.job, head: vector.head, pageIndex: 0 });
    case "cancel":
      return sdk.cancel({ job: vector.job, request: { reason: "operator_requested" } });
  }
}
const mutations: Array<{ name: string; operation: Operation; mutate(value: Vector): void }> = [
  {
    name: "request scope",
    operation: "request",
    mutate(v) {
      v.queued.request.scope.tenantId = "tenant_other";
    },
  },
  {
    name: "request canonical definition",
    operation: "request",
    mutate(v) {
      v.queued.request.evaluationTime = "2026-09-07T11:59:59.999Z";
    },
  },
  {
    name: "server job digest",
    operation: "enqueue",
    mutate(v) {
      v.queued.job.definitionSha256 = "f".repeat(64);
    },
  },
  {
    name: "enqueue semantic input",
    operation: "enqueue",
    mutate(v) {
      v.queued.request.evaluationTime = "2026-09-07T11:59:59.999Z";
    },
  },
  {
    name: "returned job identity",
    operation: "job",
    mutate(v) {
      v.completed.job.jobId = "job_substituted";
      for (const attempt of v.completed.attempts) attempt.mutationFence.jobId = "job_substituted";
    },
  },
  {
    name: "header original job",
    operation: "header",
    mutate(v) {
      v.snapshot.jobId = "job_substituted";
    },
  },
  {
    name: "header source scope",
    operation: "header",
    mutate(v) {
      v.snapshot.scope.tenantId = "tenant_other";
    },
  },
  {
    name: "header request binding",
    operation: "header",
    mutate(v) {
      v.snapshot.request.definitionSha256 = "f".repeat(64);
    },
  },
  {
    name: "header canonical definition",
    operation: "header",
    mutate(v) {
      v.snapshot.manifest.definitionSha256 = "f".repeat(64);
    },
  },
  {
    name: "sealing identity",
    operation: "header",
    mutate(v) {
      v.snapshot.sealedByPrincipalId = "worker_substituted";
    },
  },
  {
    name: "original sealing attempt",
    operation: "header",
    mutate(v) {
      v.snapshot.attemptId = "attempt_substituted";
    },
  },
  {
    name: "original sealing fence",
    operation: "header",
    mutate(v) {
      v.snapshot.fencingToken++;
    },
  },
  {
    name: "original sealing receipt",
    operation: "header",
    mutate(v) {
      v.snapshot.recordedAt = new Date(Date.parse(v.snapshot.recordedAt) + 1).toISOString();
    },
  },
  {
    name: "original snapshot reference",
    operation: "header",
    mutate(v) {
      v.completed.job.snapshot!.definitionSha256 = "f".repeat(64);
      v.completed.attempts[0]!.snapshot!.definitionSha256 = "f".repeat(64);
    },
  },
  {
    name: "page header reference",
    operation: "page",
    mutate(v) {
      v.snapshot.definitionSha256 = "f".repeat(64);
    },
  },
  {
    name: "page scope",
    operation: "page",
    mutate(v) {
      v.pages[0]!.scope.tenantId = "tenant_other";
    },
  },
  {
    name: "page request",
    operation: "page",
    mutate(v) {
      v.pages[0]!.request.definitionSha256 = "f".repeat(64);
    },
  },
  {
    name: "page descriptor",
    operation: "page",
    mutate(v) {
      v.pages[0] = structuredClone(v.pages[1]!);
    },
  },
  {
    name: "page digest",
    operation: "page",
    mutate(v) {
      const frame = v.pages[0]!.frames[0]!;
      frame.dataBase64url =
        (frame.dataBase64url[0] === "A" ? "B" : "A") + frame.dataBase64url.slice(1);
    },
  },
  {
    name: "result job",
    operation: "result",
    mutate(v) {
      v.evaluation.jobId = "job_substituted";
    },
  },
  {
    name: "result deciding identity",
    operation: "result",
    mutate(v) {
      v.evaluation.recordedByPrincipalId = "worker_substituted";
    },
  },
  {
    name: "result snapshot",
    operation: "result",
    mutate(v) {
      v.evaluation.snapshot.definitionSha256 = "f".repeat(64);
    },
  },
  {
    name: "result candidate",
    operation: "result",
    mutate(v) {
      v.evaluation.candidate.candidateVersionId = "candidate_version_other";
    },
  },
  {
    name: "result deciding fence",
    operation: "result",
    mutate(v) {
      v.evaluation.fencingToken++;
    },
  },
  {
    name: "result completion receipt",
    operation: "result",
    mutate(v) {
      v.evaluation.recordedAt = new Date(Date.parse(v.evaluation.recordedAt) + 1).toISOString();
    },
  },
  {
    name: "result complete ordered rules",
    operation: "result",
    mutate(v) {
      const last = v.evaluation.rules.pop()!;
      v.evaluation.ruleCount--;
      v.evaluation.outcomeCounts[last.outcome]--;
    },
  },
  {
    name: "result rule identity",
    operation: "result",
    mutate(v) {
      v.evaluation.rules.at(-1)!.ruleId = "zzzz_substituted_rule";
    },
  },
  {
    name: "result canonical digest",
    operation: "result",
    mutate(v) {
      v.evaluation.definitionSha256 = "f".repeat(64);
      v.completed.job.result!.definitionSha256 = "f".repeat(64);
    },
  },
  {
    name: "head scope",
    operation: "head",
    mutate(v) {
      v.head.scope.tenantId = "tenant_other";
    },
  },
  {
    name: "head exact job",
    operation: "head",
    mutate(v) {
      v.head.job.jobId = "job_substituted";
    },
  },
  {
    name: "history exact head",
    operation: "history",
    mutate(v) {
      v.history.head.graphSha256 = "f".repeat(64);
    },
  },
  {
    name: "history operation digest",
    operation: "history",
    mutate(v) {
      const entry = v.history.entries.find(
        (entry) => entry.definition.operation.kind === "reserve",
      )!;
      if (entry.definition.operation.kind !== "reserve")
        throw new Error("Missing original reserve operation");
      entry.definition.operation.delta.reads++;
    },
  },
  {
    name: "cancellation reason",
    operation: "cancel",
    mutate(v) {
      v.cancelled.cancellation!.reason = "incident_response";
    },
  },
];
describe("policy SDK hostile exact records", () => {
  it.each([
    { name: "invalid UTF-8", bytes: () => new Uint8Array([255]), message: "UTF-8 JSON" },
    { name: "truncated JSON", bytes: () => new TextEncoder().encode("{"), message: "UTF-8 JSON" },
    {
      name: "nonobject JSON",
      bytes: () => new TextEncoder().encode("[]"),
      message: "canonical object",
    },
    {
      name: "foreign encoding domain",
      bytes: () => {
        const data = JSON.parse(
          new TextDecoder().decode(encodePolicyEvaluationSnapshotInputs(vector.inputs)),
        );
        data.definitionDomain = "foreign.domain";
        return encodeEvaluationCanonicalJson(data);
      },
      message: "canonical domain",
    },
    {
      name: "foreign encoding version",
      bytes: () => {
        const data = JSON.parse(
          new TextDecoder().decode(encodePolicyEvaluationSnapshotInputs(vector.inputs)),
        );
        data.encodingVersion = "foreign.version";
        return encodeEvaluationCanonicalJson(data);
      },
      message: "canonical domain",
    },
    {
      name: "noncanonical whitespace",
      bytes: () =>
        new TextEncoder().encode(
          JSON.stringify(
            JSON.parse(
              new TextDecoder().decode(encodePolicyEvaluationSnapshotInputs(vector.inputs)),
            ),
            null,
            2,
          ),
        ),
      message: "exact canonical bytes",
    },
    {
      name: "unknown semantic field",
      bytes: () => {
        const data = JSON.parse(
          new TextDecoder().decode(encodePolicyEvaluationSnapshotInputs(vector.inputs)),
        );
        data.callerAuthority = true;
        return encodeEvaluationCanonicalJson(data);
      },
      message: "strict contract",
    },
  ])("rejects coherently rehashed $name", async ({ bytes, message }) => {
    const v = copy();
    replaceInput(v, bytes());
    await expect(client(server(v).fetch).readCompleteSnapshot({ job: v.job })).rejects.toThrow(
      message,
    );
  });
  it("verifies the reconstructed input digest independently of every advertised page digest", async () => {
    const v = copy();
    replaceInput(v, encodePolicyEvaluationSnapshotInputs(v.inputs), "f".repeat(64));
    await expect(client(server(v).fetch).readCompleteSnapshot({ job: v.job })).rejects.toThrow(
      "canonical digest",
    );
  });
  it("requires Web Crypto and preserves digest failures", async () => {
    const original = globalThis.crypto;
    vi.stubGlobal("crypto", undefined);
    await expect(client(server().fetch).readJob({ job: vector.job })).rejects.toThrow("Web Crypto");
    vi.stubGlobal("crypto", {
      subtle: {
        digest: async () => {
          throw new Error("test digest unavailable");
        },
      },
    });
    await expect(client(server().fetch).readJob({ job: vector.job })).rejects.toThrow(
      "digest calculation failed",
    );
    vi.stubGlobal("crypto", original);
  });
  it.each(mutations)("rejects substituted $name", async ({ operation, mutate }) => {
    const v = copy();
    mutate(v);
    await expect(exercise(client(server(v).fetch), operation)).rejects.toBeInstanceOf(
      ProofStackApiError,
    );
  });
  it.each([false, true])("rejects a creation flag/status mismatch (%s)", async (created) => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(
        json({ created, snapshot: vector.queued, requestId }, created ? 200 : 201),
      );
    await expect(client(fetch).enqueue({ request: vector.request })).rejects.toThrow(
      "creation flag",
    );
  });
  it("rejects a created response that incorrectly retains completed state", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(json({ created: true, snapshot: vector.completed, requestId }, 201));
    await expect(client(fetch).enqueue({ request: vector.request })).rejects.toThrow(
      "creation state",
    );
  });
  it.each([-1, 0.5, 99999])(
    "rejects an invalid snapshot page %s before fetching",
    async (pageIndex) => {
      const fetch = vi.fn<typeof globalThis.fetch>();
      await expect(
        client(fetch).readSnapshotPage({ job: vector.job, snapshot: vector.snapshot, pageIndex }),
      ).rejects.toBeInstanceOf(ProofStackApiError);
      expect(fetch).not.toHaveBeenCalled();
    },
  );
  it("refuses an absent descriptor or insufficient whole-input budget without reading pages", async () => {
    const s = server(),
      sdk = client(s.fetch);
    await expect(
      sdk.readSnapshotPage({
        job: vector.job,
        snapshot: vector.snapshot,
        pageIndex: vector.pages.length,
      }),
    ).rejects.toThrow("outside");
    expect(s.fetch).not.toHaveBeenCalled();
    await expect(
      client(s.fetch, {
        maxSnapshotInputBytes: vector.snapshot.inputByteLength - 1,
      }).readCompleteSnapshot({ job: vector.job }),
    ).rejects.toThrow("byte budget");
    expect(s.fetch).toHaveBeenCalledTimes(2);
  });
  it("rejects caller worker identity and an invalid retained job before any request", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(),
      sdk = client(fetch);
    await expect(
      sdk.enqueue({
        request: { ...vector.request, workerId: "caller" } as EnqueuePolicyEvaluationRequest,
      }),
    ).rejects.toBeInstanceOf(ProofStackApiError);
    await expect(sdk.readJob({ job: { ...vector.job, jobId: "" } })).rejects.toBeInstanceOf(
      ProofStackApiError,
    );
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects history outside its head or a substituted predecessor", async () => {
    const s = server(),
      sdk = client(s.fetch);
    await expect(
      sdk.readHistoryPage({ job: vector.job, head: vector.head, pageIndex: 1 }),
    ).rejects.toThrow("outside");
    expect(s.fetch).not.toHaveBeenCalled();
    await expect(
      sdk.readHistoryPage({
        job: vector.job,
        head: vector.head,
        pageIndex: 0,
        predecessor: vector.history.entries[0]!,
      }),
    ).rejects.toThrow("predecessor");
  });
});
