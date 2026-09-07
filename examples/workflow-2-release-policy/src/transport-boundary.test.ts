import { type ApiConfig, createApp } from "@proofstack/api/composition";
import {
  MAX_RELEASE_POLICY_REQUEST_BYTES,
  MAX_RELEASE_POLICY_RESPONSE_BYTES,
  PrincipalContextSchema,
  type PublishReleasePolicyRequest,
  PublishReleasePolicyRequestSchema,
} from "@proofstack/contracts";
import { MemoryReleasePolicyRepository } from "@proofstack/core";
import { policyAuthorityFixture } from "@proofstack/core/testing";
import { ProofStackReleasePolicyClient } from "@proofstack/sdk";
import { describe, expect, it, vi } from "vitest";

const requestLimit = MAX_RELEASE_POLICY_REQUEST_BYTES;
const fixture = policyAuthorityFixture();
const scope = fixture.policy.scope;
const policyId = fixture.policy.policyId;
const policyVersionId = fixture.policy.policyVersionId;
const config: ApiConfig = {
  authMode: "development",
  environment: "test",
  host: "127.0.0.1",
  logLevel: "silent",
  otlp: { compressedBodyLimitBytes: 1_048_576, decompressedBodyLimitBytes: 1_048_576 },
  port: 4318,
  storage: { mode: "memory" },
};

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function sizedRequest(targetBytes: number, compactCounts = false): PublishReleasePolicyRequest {
  const {
    definitionSha256: _digest,
    issuerPrincipalId: _issuer,
    policyId: _policyId,
    predecessor: _predecessor,
    publishedAt: _publishedAt,
    publishedByPrincipalId: _publisher,
    schemaVersion: _schemaVersion,
    scope: _scope,
    ...request
  } = structuredClone(fixture.policy);
  const threshold = request.rules.find(
    ({ predicate }) => predicate.kind === "comparison_threshold",
  );
  const approval = request.rules.find(({ predicate }) => predicate.kind === "approval_required");
  if (threshold?.predicate.kind !== "comparison_threshold" || !approval) {
    throw new Error("Expected threshold and independent approval rules");
  }
  const predicate = compactCounts
    ? {
        comparison: threshold.predicate.comparison,
        eventClass: "guardrail_check" as const,
        kind: "safety_event_ceiling" as const,
        maximumCount: 1e15,
        metricId: threshold.predicate.metricId,
        unit: "events" as const,
      }
    : threshold.predicate;
  const ruleCount = compactCounts ? 127 : 64;
  request.rules = [
    ...Array.from({ length: ruleCount }, (_, index) => ({
      ...structuredClone(threshold),
      predicate: structuredClone(predicate),
      rationale: "근거",
      ruleId: `rule_${String(index).padStart(3, "0")}`,
    })),
    { ...approval, ruleId: "rule_999" },
  ];
  for (const rule of request.rules.slice(0, ruleCount)) {
    const available = targetBytes - byteLength(request) + Buffer.byteLength(rule.rationale);
    const length = Math.min(4096, Math.floor(available / 4));
    if (length > 0) rule.rationale = "😀".repeat(length);
  }
  request.rationale += "x".repeat(targetBytes - byteLength(request));
  const parsed = PublishReleasePolicyRequestSchema.parse(request);
  expect(byteLength(parsed)).toBe(targetBytes);
  expect(JSON.stringify(parsed).length).toBeLessThan(targetBytes);
  return parsed;
}

async function harness() {
  const repository = new MemoryReleasePolicyRepository();
  const publish = vi.spyOn(repository, "publishReleasePolicy");
  const resolve = vi.fn(async () => ({
    artifacts: structuredClone(fixture.input.artifacts),
    installationBinding: structuredClone(fixture.binding),
    sources: structuredClone(fixture.input.sources),
  }));
  const app = await createApp(config, {
    authenticator: {
      authenticate: async (incoming) =>
        PrincipalContextSchema.parse({
          authentication: { authenticatedAt: fixture.input.at, method: "development" },
          capabilities: ["policy:author", "policy:read"],
          principalId: fixture.policy.issuerPrincipalId,
          principalType: "user",
          requestId: incoming.id,
          resourceScope: { mode: "tenant" },
          roles: ["owner"],
          tenantId: scope.tenantId,
        }),
    },
    clock: { now: () => new Date(fixture.input.at) },
    releasePolicyAuthorityResolver: { resolve },
    releasePolicyRepository: repository,
  });
  return { app, publish, repository, resolve };
}

describe("release policy transport byte boundary", () => {
  it("admits compact JSON counts at the HTTP limit and retains a readable expanded receipt", async () => {
    const request = sizedRequest(requestLimit + 127 * 12, true);
    const body = JSON.stringify(request).replaceAll(
      '"maximumCount":1000000000000000',
      '"maximumCount":1e15',
    );
    expect(Buffer.byteLength(body)).toBe(requestLimit);
    expect(JSON.parse(body)).toEqual(request);
    const { app, publish, resolve } = await harness();
    try {
      const endpoint = await app.listen({ host: "127.0.0.1", port: 0 });
      const url =
        `${endpoint}/v1/projects/${scope.projectId}/environments/${scope.environmentId}` +
        `/release-policies/${policyId}/versions/${policyVersionId}`;
      const publication = await fetch(url, {
        body,
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      expect(publication.status).toBe(201);
      const receipt = await publication.json();
      expect(byteLength(receipt)).toBeGreaterThan(requestLimit);
      expect(byteLength(receipt)).toBeLessThanOrEqual(MAX_RELEASE_POLICY_RESPONSE_BYTES);
      const client = new ProofStackReleasePolicyClient({
        authentication: { mode: "development" },
        endpoint,
        environmentId: scope.environmentId,
        projectId: scope.projectId,
      });
      await expect(client.readPolicy({ policyId, policyVersionId })).resolves.toMatchObject({
        policy: receipt.policy,
      });
      const retry = await fetch(url, {
        body,
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      expect(retry.status).toBe(200);
      expect(await retry.json()).toMatchObject({ created: false, policy: receipt.policy });
      expect(resolve).toHaveBeenCalledOnce();
      expect(publish).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });

  it.each([-1, 0])("round-trips a UTF-8 request at the limit plus %i byte(s)", async (offset) => {
    const request = sizedRequest(requestLimit + offset);
    const { app, publish, resolve } = await harness();
    try {
      const endpoint = await app.listen({ host: "127.0.0.1", port: 0 });
      const lengths: number[] = [];
      const statuses: number[] = [];
      const client = new ProofStackReleasePolicyClient({
        authentication: { mode: "development" },
        endpoint,
        environmentId: scope.environmentId,
        fetch: async (input, init) => {
          const response = await fetch(input, init);
          lengths.push(Number(response.headers.get("content-length")));
          statuses.push(response.status);
          return response;
        },
        projectId: scope.projectId,
      });
      const publication = await client.publishPolicy({ policyId, request });
      const read = await client.readPolicy({ policyId, policyVersionId });
      const retry = await client.publishPolicy({ policyId, request });
      expect(publication.created).toBe(true);
      expect(retry.created).toBe(false);
      expect(read.policy).toEqual(publication.policy);
      expect(retry.policy).toEqual(publication.policy);
      expect(publication.policy.rules).toEqual(request.rules);
      expect(statuses).toEqual([201, 200, 200]);
      expect(lengths.every((length) => length > requestLimit)).toBe(true);
      expect(lengths.every((length) => length <= MAX_RELEASE_POLICY_RESPONSE_BYTES)).toBe(true);
      expect(resolve).toHaveBeenCalledOnce();
      expect(publish).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });

  it("rejects one excess UTF-8 byte before SDK fetch or HTTP authority and storage", async () => {
    const request = sizedRequest(requestLimit + 1);
    const { app, publish, repository, resolve } = await harness();
    try {
      const sdkFetch = vi.fn<typeof globalThis.fetch>();
      const client = new ProofStackReleasePolicyClient({
        authentication: { mode: "development" },
        endpoint: "http://127.0.0.1",
        environmentId: scope.environmentId,
        fetch: sdkFetch,
        projectId: scope.projectId,
      });
      await expect(client.publishPolicy({ policyId, request })).rejects.toThrow(
        `request exceeded ${requestLimit} bytes`,
      );
      expect(sdkFetch).not.toHaveBeenCalled();
      const response = await app.inject({
        body: JSON.stringify(request),
        headers: { "content-type": "application/json" },
        method: "POST",
        url:
          `/v1/projects/${scope.projectId}/environments/${scope.environmentId}` +
          `/release-policies/${policyId}/versions/${policyVersionId}`,
      });
      expect(response.statusCode).toBe(413);
      expect(response.json()).toMatchObject({ status: 413 });
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(resolve).not.toHaveBeenCalled();
      expect(publish).not.toHaveBeenCalled();
      await expect(repository.findReleasePolicy(scope, policyVersionId)).resolves.toBeNull();
    } finally {
      await app.close();
    }
  });
});
