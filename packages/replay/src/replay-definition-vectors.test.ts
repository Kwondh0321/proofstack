import { readFileSync } from "node:fs";
import type { ReplayPlanDefinition, TargetReleaseDefinition } from "@proofstack/contracts";
import { describe, expect, it } from "vitest";
import {
  digestReplayPlanDefinition,
  digestTargetReleaseDefinition,
  encodeReplayPlanDefinition,
  encodeTargetReleaseDefinition,
} from "./replay-definition-digest.js";
import { digestRecordedBoundaryReplayInvocationDefinition } from "./replay-digest.js";

interface TargetReleaseVector {
  readonly encodedByteLength: number;
  readonly encodedHex: string;
  readonly input: TargetReleaseDefinition;
  readonly kind: "target_release";
  readonly name: string;
  readonly sha256: string;
}

interface ReplayPlanVector {
  readonly encodedByteLength: number;
  readonly encodedHex: string;
  readonly input: ReplayPlanDefinition;
  readonly kind: "replay_plan";
  readonly name: string;
  readonly sha256: string;
}

const document = JSON.parse(
  readFileSync(new URL("../vectors/replay-definition-v1.json", import.meta.url), "utf8"),
) as {
  readonly format: string;
  readonly vectors: readonly [TargetReleaseVector, ReplayPlanVector];
};

const [targetVector, planVector] = document.vectors;
const hex = (value: Uint8Array): string => Buffer.from(value).toString("hex");

describe("public durable replay definition vectors", () => {
  it("publishes fixed domain-separated target and plan anchors", () => {
    expect(document.format).toBe("proofstack.replay-definition-vectors.v1");
    expect(targetVector).toMatchObject({
      encodedByteLength: 894,
      kind: "target_release",
      name: "minimal preinstalled recorded target release",
      sha256: "d0c74eaac166b7cd62081cadb5c8d1c22a72fa48aefa8f6fef94764c9b6041dd",
    });
    expect(planVector).toMatchObject({
      encodedByteLength: 1_482,
      kind: "replay_plan",
      name: "minimal exact recorded replay plan",
      sha256: "b28e23f2ebb37f751b0577ca19ac67a80fd66eba2b9ade45038056e9814c48c0",
    });
  });

  it("reproduces exact target-release bytes and SHA-256", () => {
    const encoded = encodeTargetReleaseDefinition(targetVector.input);
    expect(encoded.byteLength).toBe(targetVector.encodedByteLength);
    expect(hex(encoded)).toBe(targetVector.encodedHex);
    expect(digestTargetReleaseDefinition(targetVector.input)).toBe(targetVector.sha256);
  });

  it("reproduces exact plan bytes and every referenced definition digest", () => {
    const encoded = encodeReplayPlanDefinition(planVector.input);
    expect(encoded.byteLength).toBe(planVector.encodedByteLength);
    expect(hex(encoded)).toBe(planVector.encodedHex);
    expect(digestReplayPlanDefinition(planVector.input)).toBe(planVector.sha256);
    expect(planVector.input.targetRelease.definitionSha256).toBe(targetVector.sha256);
    const recordedBoundary = planVector.input.boundaries[0];
    if (recordedBoundary?.mode !== "recorded_stub") {
      throw new Error("The public replay plan requires its recorded boundary anchor");
    }
    expect(recordedBoundary.invocationDefinitionSha256).toBe(
      digestRecordedBoundaryReplayInvocationDefinition(recordedBoundary.invocation),
    );
  });
});
