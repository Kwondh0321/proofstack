import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createComparisonLab, type ComparisonLabOptions } from "./lab-app.js";
import { runComparisonExperiment } from "./workflow.js";

let openServer: Server | undefined;

async function startLab(options: ComparisonLabOptions = {}): Promise<string> {
  openServer = createComparisonLab(options);
  await new Promise<void>((resolve, reject) => {
    openServer?.once("error", reject);
    openServer?.listen(0, "127.0.0.1", resolve);
  });
  const address = openServer.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  if (!openServer) return;
  openServer.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    openServer?.close((error) => (error ? reject(error) : resolve()));
  });
  openServer = undefined;
});

describe("comparison browser lab", () => {
  it("serves English by default, Korean on request, and external CSP-bound assets", async () => {
    const baseUrl = await startLab();
    const english = await fetch(baseUrl);
    const englishBody = await english.text();
    expect(english.status).toBe(200);
    expect(english.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(english.headers.get("cache-control")).toBe("no-store");
    expect(english.headers.get("x-frame-options")).toBe("DENY");
    expect(english.headers.get("permissions-policy")).toContain("camera=()");
    expect(english.headers.get("content-security-policy")).toBe(
      "default-src 'none'; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    );
    expect(englishBody).toContain('<html lang="en">');
    expect(englishBody).toContain("ProofStack comparison lab");
    expect(englishBody).toContain('<script src="/app.js" defer></script>');
    expect(englishBody).not.toContain("unsafe-inline");
    expect(englishBody).toContain("Direction (descriptive)");
    expect(englishBody).not.toMatch(/\b(pass|fail|approved|rejected)\b/i);

    const korean = await fetch(`${baseUrl}/?lang=ko`);
    const koreanBody = await korean.text();
    expect(koreanBody).toContain('<html lang="ko">');
    expect(koreanBody).toContain("ProofStack 비교 실험실");
    expect(koreanBody).toContain('href="/" hreflang="en"');

    const [styleResponse, scriptResponse] = await Promise.all([
      fetch(`${baseUrl}/styles.css`),
      fetch(`${baseUrl}/app.js`),
    ]);
    expect(styleResponse.headers.get("content-type")).toBe("text/css; charset=utf-8");
    expect(await styleResponse.text()).toContain(":focus-visible");
    expect(scriptResponse.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(await scriptResponse.text()).toContain("textContent");
  });

  it("runs the real comparison engine and returns exact read-back evidence", async () => {
    const run = vi.fn(runComparisonExperiment);
    const baseUrl = await startLab({ namespace: () => "browser", run });
    const response = await fetch(`${baseUrl}/run`, {
      body: JSON.stringify({ baselineMilliseconds: 125, candidateMilliseconds: 100 }),
      headers: { "content-type": "Application/JSON; charset=utf-8" },
      method: "POST",
    });
    const result = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(result).toMatchObject({
      evidence: {
        baselineMilliseconds: 125,
        candidateMilliseconds: 100,
        integrity: "verified",
        source: "synthetic",
      },
      outcome: {
        delta: { denominator: "1", numerator: "-25", unit: "milliseconds" },
        direction: "decreased",
        status: "available",
      },
      readBack: {
        resultId: "result_latency_browser",
        resultSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    expect(run).toHaveBeenCalledWith({
      baselineMilliseconds: 125,
      candidateMilliseconds: 100,
      namespace: "browser",
    });
  });

  it("uses a bounded default namespace for repeated real executions", async () => {
    const baseUrl = await startLab();
    const request = () =>
      fetch(`${baseUrl}/run`, {
        body: JSON.stringify({ baselineMilliseconds: 1, candidateMilliseconds: 1 }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
    const first = await (await request()).json();
    const second = await (await request()).json();
    expect(first.outcome).toMatchObject({
      delta: { numerator: "0" },
      direction: "unchanged",
    });
    expect(first.readBack.resultId).not.toBe(second.readBack.resultId);
    expect(first.readBack.resultId).toMatch(/^result_latency_[a-z0-9]{1,20}$/);
  });

  it.each([
    ["missing media type", undefined, "{}", /Content-Type/],
    ["wrong media type", "text/plain", "{}", /Content-Type/],
    ["invalid JSON", "application/json", "{", /valid JSON/],
    ["array body", "application/json", "[]", /must be an object/],
    ["null body", "application/json", "null", /must be an object/],
    [
      "unknown field",
      "application/json",
      JSON.stringify({ baselineMilliseconds: 1, candidateMilliseconds: 1, verdict: "pass" }),
      /unknown field/,
    ],
    [
      "missing value",
      "application/json",
      JSON.stringify({ baselineMilliseconds: 1 }),
      /non-negative safe integers/,
    ],
    [
      "negative value",
      "application/json",
      JSON.stringify({ baselineMilliseconds: -1, candidateMilliseconds: 1 }),
      /non-negative safe integers/,
    ],
    [
      "fractional value",
      "application/json",
      JSON.stringify({ baselineMilliseconds: 1.5, candidateMilliseconds: 1 }),
      /non-negative safe integers/,
    ],
    [
      "unsafe value",
      "application/json",
      JSON.stringify({
        baselineMilliseconds: Number.MAX_SAFE_INTEGER + 1,
        candidateMilliseconds: 1,
      }),
      /non-negative safe integers/,
    ],
  ])("rejects %s without invoking the comparison engine", async (_name, mediaType, body, error) => {
    const run = vi.fn(runComparisonExperiment);
    const baseUrl = await startLab({ namespace: () => "invalid", run });
    const response = await fetch(`${baseUrl}/run`, {
      body,
      headers: mediaType ? { "content-type": mediaType } : {},
      method: "POST",
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringMatching(error) });
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects oversized bodies before execution", async () => {
    const run = vi.fn(runComparisonExperiment);
    const baseUrl = await startLab({ namespace: () => "oversized", run });
    const response = await fetch(`${baseUrl}/run`, {
      body: JSON.stringify({ padding: "x".repeat(4_096) }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Request body is too large" });
    expect(run).not.toHaveBeenCalled();
  });

  it("does not disclose internal execution failures and returns stable not-found JSON", async () => {
    const baseUrl = await startLab({
      namespace: () => "failure",
      run: async () => {
        throw new Error("secret internal detail");
      },
    });
    const failure = await fetch(`${baseUrl}/run`, {
      body: JSON.stringify({ baselineMilliseconds: 1, candidateMilliseconds: 2 }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(failure.status).toBe(500);
    expect(await failure.json()).toEqual({ error: "Experiment execution failed" });

    const missing = await fetch(`${baseUrl}/missing`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "Not found" });
  });
});
