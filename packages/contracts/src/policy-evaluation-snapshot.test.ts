import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  POLICY_EVALUATION_SNAPSHOT_FRAME_BYTES,
  PolicyEvaluationSnapshotDefinitionSchema,
  PolicyEvaluationSnapshotPageDefinitionSchema,
  PolicyEvaluationSnapshotSchema,
  type PolicyEvaluationSnapshotDefinition,
} from "./policy-evaluation-snapshot.js";
import type { PolicyEvaluationSnapshotInputs } from "./policy-evaluation-snapshot-inputs.js";

const input = JSON.parse(
  readFileSync(
    new URL("../vectors/policy-evaluation-snapshot-inputs-v1.fixture.json", import.meta.url),
    "utf8",
  ),
) as PolicyEvaluationSnapshotInputs;
const oracle = JSON.parse(
  readFileSync(new URL("../vectors/policy-evaluation-snapshot-v1.json", import.meta.url), "utf8"),
) as {
  vectors: { inputByteLength: number; inputSha256: string; pages: { sha256: string }[] }[];
};
function definition(): PolicyEvaluationSnapshotDefinition {
  const vector = oracle.vectors[0]!;
  const frames = Math.ceil(vector.inputByteLength / POLICY_EVALUATION_SNAPSHOT_FRAME_BYTES);
  return {
    snapshotId: "snapshot_independent_vector",
    request: input.sources.records.request,
    candidate: input.request.candidate,
    policy: input.request.policy,
    algorithm: input.request.algorithm,
    evaluationTime: input.request.evaluationTime,
    capturedAt: input.capturedAt,
    manifest: {
      manifestId: input.manifest.manifest.manifestId,
      definitionSha256: input.manifest.manifest.definitionSha256,
    },
    inputSha256: vector.inputSha256,
    inputByteLength: vector.inputByteLength,
    frameCount: frames,
    pages: [
      {
        pageIndex: 0,
        definitionSha256: vector.pages[0]!.sha256,
        firstFrameIndex: 0,
        frameCount: frames,
      },
    ],
  };
}
function page(data: string, length: number) {
  return {
    snapshotId: "snapshot_frame_geometry",
    request: input.sources.records.request,
    inputSha256: "a".repeat(64),
    inputByteLength: length,
    frameCount: Math.ceil(length / POLICY_EVALUATION_SNAPSHOT_FRAME_BYTES),
    pageIndex: 0,
    frames: [{ frameIndex: 0, dataBase64url: data }],
  };
}
describe("bounded snapshot root and portable frame contracts", () => {
  it.each([
    ["AA", 1],
    ["AAA", 2],
    ["AAAA", 3],
  ] as const)("accepts canonical frame %s with %i decoded bytes", (data, length) => {
    expect(PolicyEvaluationSnapshotPageDefinitionSchema.parse(page(data, length))).toEqual(
      page(data, length),
    );
  });
  it.each(["A", "AB", "AAB", "AA=", "AA==", "A+", "A/", "AA\n", "AAA$"])(
    "rejects padding, noncanonical bits or invalid alphabet: %s",
    (data) => {
      expect(PolicyEvaluationSnapshotPageDefinitionSchema.safeParse(page(data, 1)).success).toBe(
        false,
      );
    },
  );
  it("accepts exactly one full frame and rejects one raw byte above its fixed bound", () => {
    const exact = Buffer.alloc(POLICY_EVALUATION_SNAPSHOT_FRAME_BYTES).toString("base64url");
    expect(
      PolicyEvaluationSnapshotPageDefinitionSchema.safeParse(
        page(exact, POLICY_EVALUATION_SNAPSHOT_FRAME_BYTES),
      ).success,
    ).toBe(true);
    const over = Buffer.alloc(POLICY_EVALUATION_SNAPSHOT_FRAME_BYTES + 1).toString("base64url");
    expect(
      PolicyEvaluationSnapshotPageDefinitionSchema.safeParse(
        page(over, POLICY_EVALUATION_SNAPSHOT_FRAME_BYTES + 1),
      ).success,
    ).toBe(false);
  });
  it("retains exact typed root geometry and requires publication receipt ordering", () => {
    const value = definition();
    expect(PolicyEvaluationSnapshotDefinitionSchema.parse(value)).toEqual(value);
    const record = {
      ...value,
      definitionSha256: "a".repeat(64),
      scope: input.request.scope,
      schemaVersion: "0.1",
      sealedAt: value.capturedAt,
      sealedByPrincipalId: "principal_snapshot",
      jobId: "job_snapshot",
      attemptId: "attempt_snapshot",
      workerId: "worker_snapshot",
      leaseId: "lease_snapshot",
      fencingToken: 1,
      recoveryEpoch: 0,
      recordedAt: value.capturedAt,
    };
    expect(PolicyEvaluationSnapshotSchema.parse(record)).toEqual(record);
    expect(
      PolicyEvaluationSnapshotSchema.safeParse({ ...record, sealedAt: "2026-10-01T00:00:00.000Z" })
        .success,
    ).toBe(false);
    expect(
      PolicyEvaluationSnapshotSchema.safeParse({
        ...record,
        recordedAt: "2026-10-01T00:00:00.000Z",
      }).success,
    ).toBe(false);
    expect(PolicyEvaluationSnapshotSchema.safeParse({ ...record, publish: true }).success).toBe(
      false,
    );
  });
  it.each(["cut", "frames", "pages", "index", "first", "count"] as const)(
    "rejects changed root %s",
    (field) => {
      const value = definition();
      if (field === "cut") value.capturedAt = "2026-09-30T00:00:00.000Z";
      else if (field === "frames") value.frameCount++;
      else if (field === "pages") value.pages.push(structuredClone(value.pages[0]!));
      else if (field === "index") value.pages[0]!.pageIndex = 1;
      else if (field === "first") value.pages[0]!.firstFrameIndex = 1;
      else value.pages[0]!.frameCount--;
      expect(PolicyEvaluationSnapshotDefinitionSchema.safeParse(value).success).toBe(false);
    },
  );
});
