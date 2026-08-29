import { readFile, writeFile } from "node:fs/promises";
import {
  digestRecordedBoundaryReplayInvocationDefinition,
  digestReplayPlanDefinition,
  digestTargetReleaseDefinition,
  encodeReplayPlanDefinition,
  encodeTargetReleaseDefinition,
} from "../dist/index.js";

const vectorUrl = new URL("../vectors/replay-definition-v1.json", import.meta.url);
const document = JSON.parse(await readFile(vectorUrl, "utf8"));
const targetVector = document.vectors.find(({ kind }) => kind === "target_release");
const planVector = document.vectors.find(({ kind }) => kind === "replay_plan");
if (!targetVector || !planVector) throw new Error("Both replay definition vectors are required");

const targetBytes = encodeTargetReleaseDefinition(targetVector.input);
const targetSha256 = digestTargetReleaseDefinition(targetVector.input);
planVector.input.targetRelease.definitionSha256 = targetSha256;
for (const boundary of planVector.input.boundaries) {
  if (boundary.mode === "recorded_stub") {
    boundary.invocationDefinitionSha256 = digestRecordedBoundaryReplayInvocationDefinition(
      boundary.invocation,
    );
  }
}
const planBytes = encodeReplayPlanDefinition(planVector.input);

const generated = {
  format: "proofstack.replay-definition-vectors.v1",
  vectors: [
    {
      ...targetVector,
      encodedByteLength: targetBytes.byteLength,
      encodedHex: Buffer.from(targetBytes).toString("hex"),
      sha256: targetSha256,
    },
    {
      ...planVector,
      encodedByteLength: planBytes.byteLength,
      encodedHex: Buffer.from(planBytes).toString("hex"),
      sha256: digestReplayPlanDefinition(planVector.input),
    },
  ],
};

await writeFile(vectorUrl, `${JSON.stringify(generated, undefined, 2)}\n`, "utf8");
