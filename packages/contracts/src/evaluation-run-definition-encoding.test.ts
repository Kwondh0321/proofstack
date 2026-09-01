import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  EVALUATION_RUN_RESULT_SCHEMA_VERSION,
  EVALUATION_RUN_SCHEMA_VERSION,
  type EvaluationRunDefinition,
  type EvaluationRunResultDefinition,
  RAW_OBSERVATION_SCHEMA_VERSION,
  type RawObservationDefinition,
} from "./evaluation-run.js";
import {
  encodeEvaluationRunDefinition,
  encodeEvaluationRunResultDefinition,
  encodeRawObservationDefinition,
  EVALUATION_RUN_DEFINITION_DOMAIN,
  EVALUATION_RUN_RESULT_DEFINITION_DOMAIN,
  RAW_OBSERVATION_DEFINITION_DOMAIN,
  type ScopedEvaluationDefinition,
} from "./evaluation-definition-encoding.js";

interface StaticVectorBase {
  readonly encodedByteLength: number;
  readonly name: string;
  readonly sha256: string;
}

interface RunVector extends StaticVectorBase {
  readonly input: ScopedEvaluationDefinition<EvaluationRunDefinition>;
  readonly kind: "evaluation_run";
}

interface ObservationVector extends StaticVectorBase {
  readonly input: ScopedEvaluationDefinition<RawObservationDefinition>;
  readonly kind: "raw_observation";
}

interface ResultVector extends StaticVectorBase {
  readonly input: ScopedEvaluationDefinition<EvaluationRunResultDefinition>;
  readonly kind: "evaluation_run_result";
}

type StaticVector = RunVector | ObservationVector | ResultVector;

const vectorsDocument = JSON.parse(
  readFileSync(new URL("../vectors/evaluation-run-definition-v1.json", import.meta.url), "utf8"),
) as {
  readonly format: string;
  readonly vectors: readonly StaticVector[];
};

function encode(vector: StaticVector): Uint8Array {
  switch (vector.kind) {
    case "evaluation_run":
      return encodeEvaluationRunDefinition(vector.input);
    case "raw_observation":
      return encodeRawObservationDefinition(vector.input);
    case "evaluation_run_result":
      return encodeEvaluationRunResultDefinition(vector.input);
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function requireVector<Kind extends StaticVector["kind"]>(kind: Kind) {
  const vector = vectorsDocument.vectors.find((candidate) => candidate.kind === kind);
  if (!vector) throw new Error(`Expected a ${kind} vector`);
  return vector as Extract<StaticVector, { readonly kind: Kind }>;
}

describe("canonical evaluation run definition encoding", () => {
  it("matches fixed UTF-8 and SHA-256 vectors", () => {
    expect(vectorsDocument.format).toBe("proofstack.evaluation-run-definition.v1");
    expect(vectorsDocument.vectors.map(({ kind }) => kind)).toEqual([
      "evaluation_run",
      "raw_observation",
      "evaluation_run_result",
    ]);
    for (const vector of vectorsDocument.vectors) {
      const encoded = encode(vector);
      expect(encoded.byteLength, vector.name).toBe(vector.encodedByteLength);
      expect(sha256(encoded), vector.name).toBe(vector.sha256);
    }
  });

  it("separates run, observation, and result domains with explicit schema lineage", () => {
    const runText = Buffer.from(encode(requireVector("evaluation_run"))).toString("utf8");
    const observationText = Buffer.from(encode(requireVector("raw_observation"))).toString("utf8");
    const resultText = Buffer.from(encode(requireVector("evaluation_run_result"))).toString("utf8");
    expect(runText).toContain(EVALUATION_RUN_DEFINITION_DOMAIN);
    expect(observationText).toContain(RAW_OBSERVATION_DEFINITION_DOMAIN);
    expect(resultText).toContain(EVALUATION_RUN_RESULT_DEFINITION_DOMAIN);
    expect(runText).toContain(`"schemaVersion":"${EVALUATION_RUN_SCHEMA_VERSION}"`);
    expect(observationText).toContain(`"schemaVersion":"${RAW_OBSERVATION_SCHEMA_VERSION}"`);
    expect(resultText).toContain(`"schemaVersion":"${EVALUATION_RUN_RESULT_SCHEMA_VERSION}"`);
  });

  it("changes bytes for applicability, attempts, replay, raw output, and terminal lineage", () => {
    const run = requireVector("evaluation_run");
    const originalRun = encode(run);
    const applicabilityChanged = structuredClone(run);
    applicabilityChanged.input.definition.applicability.context.locale = "ko-kr";
    expect(encode(applicabilityChanged)).not.toEqual(originalRun);
    const attemptChanged = structuredClone(run);
    const attempt = attemptChanged.input.definition.attempts[0];
    if (attempt?.seed.mode !== "fixed") throw new Error("Expected fixed attempt seed");
    attempt.seed.value = 99;
    expect(encode(attemptChanged)).not.toEqual(originalRun);
    const replayChanged = structuredClone(run);
    replayChanged.input.definition.replay.result.sha256 = "f".repeat(64);
    expect(encode(replayChanged)).not.toEqual(originalRun);

    const observation = requireVector("raw_observation");
    const outputChanged = structuredClone(observation);
    if (!outputChanged.input.definition.output.produced) throw new Error("Expected output");
    outputChanged.input.definition.output.sha256 = "e".repeat(64);
    expect(encode(outputChanged)).not.toEqual(encode(observation));

    const result = requireVector("evaluation_run_result");
    const lineageChanged = structuredClone(result);
    const reference = lineageChanged.input.definition.observations[0];
    if (!reference) throw new Error("Expected observation lineage");
    reference.definitionSha256 = "d".repeat(64);
    expect(encode(lineageChanged)).not.toEqual(encode(result));
  });

  it("rejects retry-until-pass mutation, forged outcomes, unknown fields, and receipts", () => {
    const run = requireVector("evaluation_run").input;
    const hiddenAttempt = structuredClone(run);
    const baseAttempt = hiddenAttempt.definition.attempts[0];
    if (!baseAttempt) throw new Error("Expected a predeclared attempt");
    hiddenAttempt.definition.attempts.push({
      ...baseAttempt,
      attemptId: "att_0_hidden",
      attemptSequence: 2,
    });
    expect(() => encodeEvaluationRunDefinition(hiddenAttempt)).toThrow();
    expect(() => encodeEvaluationRunDefinition({ ...run, createdAt: "hidden" } as never)).toThrow();

    const observation = requireVector("raw_observation").input;
    const forgedObservation = structuredClone(observation);
    forgedObservation.definition.verdict = "error";
    expect(() => encodeRawObservationDefinition(forgedObservation)).toThrow();
    expect(() =>
      encodeRawObservationDefinition({ ...observation, recordedAt: "hidden" } as never),
    ).toThrow();

    const result = requireVector("evaluation_run_result").input;
    expect(() =>
      encodeEvaluationRunResultDefinition({
        ...result,
        definition: { ...result.definition, releaseDecision: "allow" },
      } as never),
    ).toThrow();
  });
});
