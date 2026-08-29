import { readFileSync } from "node:fs";
import type {
  RecordedBoundaryReplayInvocationDefinition,
  RecordedBoundaryRequest,
} from "@proofstack/contracts";
import { describe, expect, it } from "vitest";
import {
  digestNormalizedRequestBytes,
  digestRecordedBoundaryReplayInvocationDefinition,
  digestRecordedBoundaryRequest,
  encodeRecordedBoundaryReplayInvocationDefinition,
  encodeRecordedBoundaryRequest,
  RECORDED_BOUNDARY_REPLAY_INVOCATION_DOMAIN,
  RECORDED_BOUNDARY_REQUEST_DOMAIN,
} from "./replay-digest.js";

interface InvocationVector {
  readonly encodedByteLength: number;
  readonly encodedHex: string;
  readonly input: RecordedBoundaryReplayInvocationDefinition;
  readonly kind: "invocation";
  readonly name: string;
  readonly sha256: string;
}

interface BoundaryRequestVector {
  readonly encodedByteLength: number;
  readonly encodedHex: string;
  readonly input: RecordedBoundaryRequest;
  readonly kind: "boundary_request";
  readonly name: string;
  readonly normalizedRequestSha256: string;
  readonly sha256: string;
}

const document = JSON.parse(
  readFileSync(new URL("../vectors/recorded-boundary-replay-v1.json", import.meta.url), "utf8"),
) as {
  readonly format: string;
  readonly vectors: readonly [InvocationVector, BoundaryRequestVector];
};

const invocationVector = document.vectors[0];
const requestVector = document.vectors[1];
const hex = (value: Uint8Array): string => Buffer.from(value).toString("hex");

describe("public recorded-boundary replay vectors", () => {
  it("publishes domain-separated immutable anchors", () => {
    expect(document.format).toBe("proofstack.recorded-boundary-replay-vectors.v1");
    expect(RECORDED_BOUNDARY_REPLAY_INVOCATION_DOMAIN).toBe(
      "proofstack.recorded-boundary-replay.v1",
    );
    expect(RECORDED_BOUNDARY_REQUEST_DOMAIN).toBe("proofstack.recorded-boundary-request.v1");
    expect(invocationVector).toMatchObject({
      encodedByteLength: 424,
      kind: "invocation",
      name: "minimal recorded boundary invocation",
      sha256: "84ec0f0af6ff16f8beb3ca595ca5d3c50e322ce2556cef39645925c15a4d0c2f",
    });
    expect(requestVector).toMatchObject({
      encodedByteLength: 137,
      kind: "boundary_request",
      name: "minimal model boundary request",
      sha256: "41fbcc316ce816837fb1af756a448c82b7c6cf0172d4bae66384edacc1122ce6",
    });
  });

  it("matches exact invocation bytes and SHA-256", () => {
    const encoded = encodeRecordedBoundaryReplayInvocationDefinition(invocationVector.input);
    expect(encoded.byteLength).toBe(invocationVector.encodedByteLength);
    expect(hex(encoded)).toBe(invocationVector.encodedHex);
    expect(digestRecordedBoundaryReplayInvocationDefinition(invocationVector.input)).toBe(
      invocationVector.sha256,
    );
  });

  it("matches exact boundary request bytes and both request digests", () => {
    const encoded = encodeRecordedBoundaryRequest(requestVector.input);
    const normalizedBytes = Buffer.from(requestVector.input.normalizedRequest.bytes, "base64url");
    expect(encoded.byteLength).toBe(requestVector.encodedByteLength);
    expect(hex(encoded)).toBe(requestVector.encodedHex);
    expect(digestRecordedBoundaryRequest(requestVector.input)).toBe(requestVector.sha256);
    expect(digestNormalizedRequestBytes(normalizedBytes)).toBe(
      requestVector.normalizedRequestSha256,
    );
  });
});

describe("recorded-boundary replay digest sensitivity", () => {
  it("changes for every mutable invocation lineage field", () => {
    const original = invocationVector.input;
    const mutations: readonly RecordedBoundaryReplayInvocationDefinition[] = [
      { ...original, invocationId: "rpi_vector_002" },
      { ...original, fixture: { ...original.fixture, fixtureId: "fix_changed" } },
      {
        ...original,
        fixture: { ...original.fixture, fixtureVersionId: "fiv_vector_002" },
      },
      {
        ...original,
        fixture: { ...original.fixture, definitionSha256: "c".repeat(64) },
      },
      {
        ...original,
        targetAdapter: { ...original.targetAdapter, name: "proofstack.changed_target" },
      },
      {
        ...original,
        targetAdapter: { ...original.targetAdapter, version: "2.0.0" },
      },
      {
        ...original,
        runtime: {
          ...original.runtime,
          clock: { ...original.runtime.clock, instant: "2026-08-29T00:00:01.000Z" },
        },
      },
      {
        ...original,
        runtime: {
          ...original.runtime,
          random: { ...original.runtime.random, seedHex: "d".repeat(64) },
        },
      },
      { ...original, runtime: { ...original.runtime, locale: "ko-KR" } },
      { ...original, runtime: { ...original.runtime, timeZone: "Asia/Seoul" } },
    ];
    const originalDigest = digestRecordedBoundaryReplayInvocationDefinition(original);
    expect(new Set(mutations.map(digestRecordedBoundaryReplayInvocationDefinition)).size).toBe(
      mutations.length,
    );
    for (const mutation of mutations) {
      expect(digestRecordedBoundaryReplayInvocationDefinition(mutation)).not.toBe(originalDigest);
    }
  });

  it("changes for request identity, kind, adapter, version, and exact bytes", () => {
    const original = requestVector.input;
    const mutations: readonly RecordedBoundaryRequest[] = [
      { ...original, boundaryRequestId: "req_vector_002" },
      { ...original, kind: "tool" },
      {
        ...original,
        normalizedRequest: {
          ...original.normalizedRequest,
          adapterName: "proofstack.reference.changed",
        },
      },
      {
        ...original,
        normalizedRequest: { ...original.normalizedRequest, adapterVersion: "2.0.0" },
      },
      {
        ...original,
        normalizedRequest: { ...original.normalizedRequest, bytes: "e30" },
      },
    ];
    const originalDigest = digestRecordedBoundaryRequest(original);
    expect(new Set(mutations.map(digestRecordedBoundaryRequest)).size).toBe(mutations.length);
    for (const mutation of mutations) {
      expect(digestRecordedBoundaryRequest(mutation)).not.toBe(originalDigest);
    }
  });

  it("rejects invalid inputs rather than producing a digest", () => {
    expect(() =>
      digestRecordedBoundaryReplayInvocationDefinition({
        ...invocationVector.input,
        runtime: { ...invocationVector.input.runtime, boundaryMode: "live_provider" as never },
      }),
    ).toThrow();
    expect(() =>
      digestRecordedBoundaryRequest({
        ...requestVector.input,
        normalizedRequest: { ...requestVector.input.normalizedRequest, bytes: "not=canonical" },
      }),
    ).toThrow();
  });
});
