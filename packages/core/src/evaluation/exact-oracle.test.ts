import { createHash } from "node:crypto";
import {
  encodeEvaluationCanonicalJson,
  encodeOracleSpecDefinition,
  ORACLE_SPEC_SCHEMA_VERSION,
  type OracleSpec,
  type OracleSpecDefinition,
} from "@proofstack/contracts";
import { describe, expect, it } from "vitest";
import {
  EXACT_ORACLE_ADAPTER_ID,
  EXACT_ORACLE_CONFIGURATION_SCHEMA_VERSION,
  ExactOracleAdapterError,
  type ExactOracleConfiguration,
  type ExactOracleExecutionRequest,
  executeExactOracle,
} from "./exact-oracle.js";

const textEncoder = new TextEncoder();
const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const repeatedSha = (character: string): string => character.repeat(64);

const scope = {
  environmentId: "env_local",
  projectId: "prj_local",
  tenantId: "ten_local",
} as const;

const artifact = (
  artifactId: string,
  digest: string,
  sizeBytes = 1_024,
  mediaType = "application/schema+json",
) => ({
  artifactId,
  classification: "internal" as const,
  mediaType,
  sha256: digest,
  sizeBytes,
});

const implementation = {
  dependencySnapshotSha256: repeatedSha("1"),
  entryPointId: "ent_exact_bytes",
  implementationId: "imp_exact_bytes",
  implementationSha256: repeatedSha("2"),
  implementationVersionId: "imv_exact_bytes_v1",
  runtime: {
    architecture: "x64" as const,
    family: "node" as const,
    platform: "portable" as const,
    version: "24.0.0",
  },
  sourceRevision: "a".repeat(40),
};

const inputSchema = artifact("art_exact_input_schema", repeatedSha("3"));
const outputSchema = artifact("art_exact_output_schema", repeatedSha("4"));
const expectedBytes = textEncoder.encode("approved response\n");
const expectedArtifact = artifact(
  "art_expected_response",
  sha(expectedBytes),
  expectedBytes.byteLength,
  "text/plain",
);

const configuration: ExactOracleConfiguration = {
  comparison: "exact_bytes",
  expected: expectedArtifact,
  schemaVersion: EXACT_ORACLE_CONFIGURATION_SCHEMA_VERSION,
};

function definition(override: Partial<OracleSpecDefinition> = {}): OracleSpecDefinition {
  return {
    budgets: {
      elapsedMilliseconds: 5_000,
      inputBytes: 1_048_576,
      memoryBytes: 268_435_456,
      outputBytes: 1_048_576,
    },
    configurationSha256: sha(encodeEvaluationCanonicalJson(configuration)),
    implementation,
    inputSchema,
    kind: "exact",
    knownLimitations: ["Exact byte equality does not establish factual correctness"],
    oracleId: "orc_exact_bytes",
    oracleVersionId: "orv_exact_bytes_v1",
    outputSchema,
    qualificationFixtureSet: {
      definitionSha256: repeatedSha("5"),
      fixtureSetId: "qfs_exact_bytes",
      fixtureSetVersionId: "qfv_exact_bytes_v1",
    },
    resultSemantics:
      "Pass only when actual bytes exactly match the digest-bound expected artifact.",
    runtimePolicy: {
      clock: { mode: "not_available" },
      dataEgress: "denied",
      locale: "en",
      network: "denied",
      seed: { mode: "not_used" },
      sideEffects: "denied",
    },
    supportedCriteria: [
      {
        criterionId: "crt_exact_response",
        criterionSet: {
          criterionSetId: "crs_response",
          criterionSetVersionId: "csv_response_v1",
          definitionSha256: repeatedSha("6"),
        },
      },
    ],
    ...override,
  };
}

function publish(value = definition()): OracleSpec {
  return {
    ...value,
    definitionSha256: sha(encodeOracleSpecDefinition({ definition: value, scope })),
    publishedAt: "2026-09-02T00:00:00.000Z",
    publishedByPrincipalId: "usr_oracle_publisher",
    schemaVersion: ORACLE_SPEC_SCHEMA_VERSION,
    scope,
  };
}

function request(override: Partial<ExactOracleExecutionRequest> = {}): ExactOracleExecutionRequest {
  return {
    actual: expectedBytes,
    configuration,
    expected: expectedBytes,
    registration: { implementation, inputSchema, outputSchema },
    specification: publish(),
    ...override,
  };
}

function expectCode(operation: () => unknown, code: string): void {
  try {
    operation();
    throw new Error("Expected the exact oracle operation to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(ExactOracleAdapterError);
    expect((error as ExactOracleAdapterError).code).toBe(code);
  }
}

describe("exact byte oracle adapter", () => {
  it("returns a reconstructable pass result for exact registered bytes", () => {
    const result = executeExactOracle(request());

    expect(result).toMatchObject({
      actual: { sha256: expectedArtifact.sha256, sizeBytes: expectedBytes.byteLength },
      adapterId: EXACT_ORACLE_ADAPTER_ID,
      expected: {
        artifact: expectedArtifact,
        sha256: expectedArtifact.sha256,
        sizeBytes: expectedBytes.byteLength,
      },
      implementationSha256: implementation.implementationSha256,
      matched: true,
      verdict: "pass",
    });
    const configurationBytes = encodeEvaluationCanonicalJson(configuration).byteLength;
    expect(result.usage.inputBytes).toBe(configurationBytes + expectedBytes.byteLength * 2);
    expect(result.usage.minimumWorkingSetBytes).toBe(result.usage.inputBytes);
    expect(result.usage.outputBytes).toBe(encodeEvaluationCanonicalJson(result).byteLength);
  });

  it("preserves exact mismatch digests without converting failure to an error", () => {
    const actual = textEncoder.encode("rejected response\n");
    const result = executeExactOracle(request({ actual }));

    expect(result.verdict).toBe("fail");
    expect(result.matched).toBe(false);
    expect(result.actual).toEqual({ sha256: sha(actual), sizeBytes: actual.byteLength });
    expect(result.expected.sha256).toBe(expectedArtifact.sha256);
  });

  it("is deterministic for copied bytes and canonically reordered records", () => {
    const reorderedConfiguration = Object.fromEntries(
      Object.entries(configuration).reverse(),
    ) as unknown as ExactOracleConfiguration;
    const first = executeExactOracle(request());
    const second = executeExactOracle(
      request({
        actual: Uint8Array.from(expectedBytes),
        configuration: reorderedConfiguration,
        expected: Uint8Array.from(expectedBytes),
      }),
    );
    expect(second).toEqual(first);
  });

  it("does not mutate request bytes or published records", () => {
    const value = request();
    const actualBefore = Uint8Array.from(value.actual);
    const expectedBefore = Uint8Array.from(value.expected);
    const recordBefore = structuredClone(value.specification);

    executeExactOracle(value);

    expect(value.actual).toEqual(actualBefore);
    expect(value.expected).toEqual(expectedBefore);
    expect(value.specification).toEqual(recordBefore);
  });

  it("rejects a specification whose canonical definition digest was forged", () => {
    expectCode(
      () =>
        executeExactOracle(
          request({ specification: { ...publish(), definitionSha256: repeatedSha("f") } }),
        ),
      "definition_digest_mismatch",
    );
  });

  it("rejects configuration content not bound by the specification", () => {
    const changed = {
      ...configuration,
      expected: { ...expectedArtifact, artifactId: "art_other_expected" },
    };
    expectCode(
      () => executeExactOracle(request({ configuration: changed })),
      "configuration_digest_mismatch",
    );
  });

  it("rejects unregistered implementations and schema substitutions", () => {
    expectCode(
      () =>
        executeExactOracle(
          request({
            registration: {
              implementation: { ...implementation, implementationSha256: repeatedSha("9") },
              inputSchema,
              outputSchema,
            },
          }),
        ),
      "implementation_mismatch",
    );
    expectCode(
      () =>
        executeExactOracle(
          request({
            registration: {
              implementation,
              inputSchema: { ...inputSchema, sha256: repeatedSha("8") },
              outputSchema,
            },
          }),
        ),
      "schema_mismatch",
    );
    expectCode(
      () =>
        executeExactOracle(
          request({
            registration: {
              implementation,
              inputSchema,
              outputSchema: { ...outputSchema, sha256: repeatedSha("7") },
            },
          }),
        ),
      "schema_mismatch",
    );
  });

  it("rejects non-exact and structurally invalid specifications", () => {
    expectCode(
      () => executeExactOracle(request({ specification: publish(definition({ kind: "schema" })) })),
      "kind_mismatch",
    );
    expectCode(
      () =>
        executeExactOracle(
          request({
            specification: { ...publish(), runtimePolicy: { network: "allowed" } } as never,
          }),
        ),
      "invalid_specification",
    );
  });

  it("rejects expected bytes whose size or digest does not match the configured artifact", () => {
    expectCode(
      () => executeExactOracle(request({ expected: textEncoder.encode("short") })),
      "expected_artifact_mismatch",
    );
    const sameSize = Uint8Array.from(expectedBytes, (byte, index) =>
      index === 0 ? byte ^ 0xff : byte,
    );
    expectCode(
      () => executeExactOracle(request({ expected: sameSize })),
      "expected_artifact_mismatch",
    );
  });

  it("fails closed at input, minimum working-set, and output byte budgets", () => {
    const inputLimited = publish(
      definition({ budgets: { ...definition().budgets, inputBytes: 1 } }),
    );
    expectCode(
      () => executeExactOracle(request({ specification: inputLimited })),
      "budget_exhausted",
    );

    const memoryLimited = publish(
      definition({ budgets: { ...definition().budgets, memoryBytes: 1 } }),
    );
    expectCode(
      () => executeExactOracle(request({ specification: memoryLimited })),
      "budget_exhausted",
    );

    const outputLimited = publish(
      definition({ budgets: { ...definition().budgets, outputBytes: 1 } }),
    );
    expectCode(
      () => executeExactOracle(request({ specification: outputLimited })),
      "budget_exhausted",
    );
  });

  it("rejects executable, unknown, malformed, and non-byte request content", () => {
    expectCode(
      () =>
        executeExactOracle(
          request({ configuration: { ...configuration, execute: () => true } as never }),
        ),
      "invalid_configuration",
    );
    expectCode(
      () => executeExactOracle({ ...request(), callback: () => true } as never),
      "invalid_configuration",
    );
    expectCode(
      () => executeExactOracle(request({ actual: "approved response\n" as never })),
      "invalid_configuration",
    );
    expectCode(
      () =>
        executeExactOracle(
          request({ configuration: { ...configuration, comparison: "semantic" } as never }),
        ),
      "invalid_configuration",
    );
    expectCode(
      () =>
        executeExactOracle(
          request({
            configuration: {
              ...configuration,
              expected: { ...expectedArtifact, sha256: "not-a-digest" },
            } as never,
          }),
        ),
      "invalid_configuration",
    );
    expectCode(
      () =>
        executeExactOracle(
          request({
            registration: { ...request().registration, command: "node arbitrary.js" } as never,
          }),
        ),
      "invalid_registration",
    );
    expectCode(
      () =>
        executeExactOracle(
          request({
            registration: {
              ...request().registration,
              implementation: { ...implementation, sourceRevision: "not-a-revision" },
            } as never,
          }),
        ),
      "invalid_registration",
    );

    const symbolRequest = request() as ExactOracleExecutionRequest & Record<symbol, unknown>;
    symbolRequest[Symbol("execute")] = () => true;
    expectCode(() => executeExactOracle(symbolRequest), "invalid_configuration");
  });
});
