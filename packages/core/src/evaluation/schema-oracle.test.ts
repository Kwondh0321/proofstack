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
  executeSchemaOracle,
  MAX_SCHEMA_ORACLE_DOCUMENT_NODES,
  MAX_SCHEMA_ORACLE_REPORTED_VIOLATIONS,
  MAX_SCHEMA_ORACLE_SCHEMA_NODES,
  SCHEMA_ORACLE_ADAPTER_ID,
  SCHEMA_ORACLE_CONFIGURATION_SCHEMA_VERSION,
  SCHEMA_ORACLE_DIALECT,
  SchemaOracleAdapterError,
  type SchemaOracleConfiguration,
  type SchemaOracleExecutionRequest,
} from "./schema-oracle.js";

const encoder = new TextEncoder();
const jsonBytes = (value: unknown): Uint8Array => encoder.encode(JSON.stringify(value));
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
  sizeBytes: number,
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
  entryPointId: "ent_json_schema",
  implementationId: "imp_json_schema",
  implementationSha256: repeatedSha("2"),
  implementationVersionId: "imv_json_schema_v1",
  runtime: {
    architecture: "x64" as const,
    family: "node" as const,
    platform: "portable" as const,
    version: "24.0.0",
  },
  sourceRevision: "b".repeat(40),
};

const validationSchema = {
  $schema: SCHEMA_ORACLE_DIALECT,
  additionalProperties: false,
  properties: {
    age: { minimum: 0, type: "integer" },
    name: { minLength: 1, type: "string" },
    tags: {
      items: { type: "string" },
      maxItems: 3,
      type: "array",
    },
  },
  required: ["age", "name", "tags"],
  type: "object",
} as const;
const defaultSchemaBytes = jsonBytes(validationSchema);
const outputSchema = artifact("art_schema_result", repeatedSha("4"), 1_024);

const configuration: SchemaOracleConfiguration = {
  dialect: SCHEMA_ORACLE_DIALECT,
  maximumErrors: 64,
  schemaVersion: SCHEMA_ORACLE_CONFIGURATION_SCHEMA_VERSION,
};

function definition(
  schemaBytes = defaultSchemaBytes,
  override: Partial<OracleSpecDefinition> = {},
): OracleSpecDefinition {
  return {
    budgets: {
      elapsedMilliseconds: 5_000,
      inputBytes: 1_048_576,
      memoryBytes: 268_435_456,
      outputBytes: 1_048_576,
    },
    configurationSha256: sha(encodeEvaluationCanonicalJson(configuration)),
    implementation,
    inputSchema: artifact("art_validation_schema", sha(schemaBytes), schemaBytes.byteLength),
    kind: "schema",
    knownLimitations: [
      "The bounded profile excludes references, regexes, formats, content decoding, and uniqueness",
    ],
    oracleId: "orc_json_schema",
    oracleVersionId: "orv_json_schema_v1",
    outputSchema,
    qualificationFixtureSet: {
      definitionSha256: repeatedSha("5"),
      fixtureSetId: "qfs_json_schema",
      fixtureSetVersionId: "qfv_json_schema_v1",
    },
    resultSemantics: "Pass only when strict JSON satisfies the exact registered schema artifact.",
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
        criterionId: "crt_structured_response",
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

function publish(
  schemaBytes = defaultSchemaBytes,
  override: Partial<OracleSpecDefinition> = {},
): OracleSpec {
  const value = definition(schemaBytes, override);
  return {
    ...value,
    definitionSha256: sha(encodeOracleSpecDefinition({ definition: value, scope })),
    publishedAt: "2026-09-02T01:00:00.000Z",
    publishedByPrincipalId: "usr_oracle_publisher",
    schemaVersion: ORACLE_SPEC_SCHEMA_VERSION,
    scope,
  };
}

function request(
  override: Partial<SchemaOracleExecutionRequest> = {},
): SchemaOracleExecutionRequest {
  const specification = override.specification ?? publish();
  return {
    configuration,
    document: jsonBytes({ age: 37, name: "Ada", tags: ["safe", "typed"] }),
    registration: {
      implementation: specification.implementation,
      inputSchema: specification.inputSchema,
      outputSchema: specification.outputSchema,
    },
    schema: defaultSchemaBytes,
    specification,
    ...override,
  };
}

function expectCode(operation: () => unknown, code: string): void {
  try {
    operation();
    throw new Error("Expected the schema oracle operation to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(SchemaOracleAdapterError);
    expect((error as SchemaOracleAdapterError).code).toBe(code);
  }
}

describe("bounded JSON Schema oracle adapter", () => {
  it("returns a reconstructable pass for strict JSON satisfying the registered schema", () => {
    const value = request();
    const result = executeSchemaOracle(value);

    expect(result).toMatchObject({
      adapterId: SCHEMA_ORACLE_ADAPTER_ID,
      document: { sha256: sha(value.document), sizeBytes: value.document.byteLength },
      implementationSha256: implementation.implementationSha256,
      schema: {
        artifact: value.specification.inputSchema,
        sha256: sha(defaultSchemaBytes),
        sizeBytes: defaultSchemaBytes.byteLength,
      },
      valid: true,
      verdict: "pass",
      violationCount: 0,
      violations: [],
      violationsTruncated: false,
    });
    expect(result.usage.documentNodes).toBe(6);
    expect(result.usage.schemaNodes).toBeGreaterThan(10);
    expect(result.usage.outputBytes).toBe(encodeEvaluationCanonicalJson(result).byteLength);
  });

  it("returns every deterministic violation without converting invalid data to an error", () => {
    const document = jsonBytes({ age: -1, extra: true, name: "", tags: ["ok", 3, 4, 5] });
    const result = executeSchemaOracle(request({ document }));

    expect(result.verdict).toBe("fail");
    expect(result.valid).toBe(false);
    expect(result.violationCount).toBe(7);
    expect(result.violationsTruncated).toBe(false);
    expect(result.violations).toEqual(
      [...result.violations].sort((left, right) =>
        Buffer.compare(
          Buffer.from(encodeEvaluationCanonicalJson(left)),
          Buffer.from(encodeEvaluationCanonicalJson(right)),
        ),
      ),
    );
    expect(result.violations.map(({ instancePath, keyword }) => [instancePath, keyword])).toEqual(
      expect.arrayContaining([
        ["", "additionalProperties"],
        ["/age", "minimum"],
        ["/name", "minLength"],
        ["/tags", "maxItems"],
        ["/tags/1", "type"],
        ["/tags/2", "type"],
      ]),
    );
  });

  it("truncates only the reported violation list while preserving the exact total", () => {
    const limitedConfiguration = { ...configuration, maximumErrors: 1 };
    const specification = publish(defaultSchemaBytes, {
      configurationSha256: sha(encodeEvaluationCanonicalJson(limitedConfiguration)),
    });
    const result = executeSchemaOracle(
      request({
        configuration: limitedConfiguration,
        document: jsonBytes({ age: -1, name: "", tags: [1, 2, 3, 4] }),
        specification,
      }),
    );

    expect(result.verdict).toBe("fail");
    expect(result.violationCount).toBeGreaterThan(1);
    expect(result.violations).toHaveLength(1);
    expect(result.violationsTruncated).toBe(true);
  });

  it.each([
    ['{"age":1,"age":2}', "Duplicate object property"],
    ['{"age":1,}', "Expected an object property name"],
    ['"\\uD800"', "represented canonically"],
    ["1e9999", "represented canonically"],
  ])("preserves malformed document outcome for %j", (source, message) => {
    const document = encoder.encode(source);
    const result = executeSchemaOracle(request({ document }));

    expect(result).toMatchObject({
      document: { sha256: sha(document), sizeBytes: document.byteLength },
      error: { code: "document_malformed", message: expect.stringContaining(message) },
      valid: null,
      verdict: "error",
      violationCount: 0,
      violations: [],
      violationsTruncated: false,
    });
    expect(result.usage.documentNodes).toBeNull();
  });

  it("reports malformed UTF-8 and structural limits as explicit document errors", () => {
    const invalidUtf8 = executeSchemaOracle(request({ document: Uint8Array.of(0xc3, 0x28) }));
    expect(invalidUtf8.verdict).toBe("error");
    if (invalidUtf8.verdict === "error") {
      expect(invalidUtf8.error.message).toContain("valid UTF-8");
    }

    const oversized = jsonBytes(Array.from({ length: MAX_SCHEMA_ORACLE_DOCUMENT_NODES }, () => 0));
    const limited = executeSchemaOracle(request({ document: oversized }));
    expect(limited.verdict).toBe("error");
    if (limited.verdict === "error") {
      expect(limited.error.message).toContain("node limit exceeded");
    }
  });

  it("binds the canonical specification, configuration, implementation, and schemas", () => {
    expectCode(
      () =>
        executeSchemaOracle(
          request({ specification: { ...publish(), definitionSha256: repeatedSha("f") } }),
        ),
      "definition_digest_mismatch",
    );
    expectCode(
      () => executeSchemaOracle(request({ configuration: { ...configuration, maximumErrors: 2 } })),
      "configuration_digest_mismatch",
    );
    expectCode(
      () =>
        executeSchemaOracle(
          request({
            registration: {
              implementation: { ...implementation, implementationSha256: repeatedSha("9") },
              inputSchema: publish().inputSchema,
              outputSchema,
            },
          }),
        ),
      "implementation_mismatch",
    );
    expectCode(
      () =>
        executeSchemaOracle(
          request({
            registration: {
              implementation,
              inputSchema: { ...publish().inputSchema, sha256: repeatedSha("8") },
              outputSchema,
            },
          }),
        ),
      "schema_mismatch",
    );
    expectCode(
      () =>
        executeSchemaOracle(
          request({
            registration: {
              implementation,
              inputSchema: publish().inputSchema,
              outputSchema: { ...outputSchema, sha256: repeatedSha("7") },
            },
          }),
        ),
      "schema_mismatch",
    );
  });

  it("rejects substituted schema bytes before parsing or compilation", () => {
    const sameLength = Uint8Array.from(defaultSchemaBytes);
    const changedIndex = sameLength.length - 2;
    sameLength[changedIndex] = (sameLength[changedIndex] ?? 0) ^ 1;
    expectCode(
      () => executeSchemaOracle(request({ schema: sameLength })),
      "schema_artifact_mismatch",
    );
    expectCode(
      () => executeSchemaOracle(request({ schema: encoder.encode("{}") })),
      "schema_artifact_mismatch",
    );
  });

  it.each([
    ["remote or local references", { $ref: "https://schemas.example.test/value" }],
    ["regular expressions", { pattern: "^(a+)+$", type: "string" }],
    ["formats", { format: "email", type: "string" }],
    ["uniqueness scans", { type: "array", uniqueItems: true }],
    ["content decoding", { contentEncoding: "base64", type: "string" }],
  ])("rejects %s in the bounded schema profile", (_label, fragment) => {
    const schema = jsonBytes({ $schema: SCHEMA_ORACLE_DIALECT, ...fragment });
    const specification = publish(schema);
    expectCode(
      () => executeSchemaOracle(request({ schema, specification })),
      "schema_profile_unsupported",
    );
  });

  it("rejects absent, nested, non-object, oversized, and unknown-keyword schemas", () => {
    const cases: readonly [Uint8Array, string][] = [
      [jsonBytes({ type: "string" }), "schema_profile_unsupported"],
      [
        jsonBytes({
          $schema: SCHEMA_ORACLE_DIALECT,
          properties: { value: { $schema: SCHEMA_ORACLE_DIALECT, type: "string" } },
        }),
        "schema_profile_unsupported",
      ],
      [jsonBytes(true), "schema_profile_unsupported"],
      [
        jsonBytes({ $schema: SCHEMA_ORACLE_DIALECT, definitelyNotAKeyword: true }),
        "schema_invalid",
      ],
      [
        jsonBytes({
          $schema: SCHEMA_ORACLE_DIALECT,
          allOf: Array.from({ length: MAX_SCHEMA_ORACLE_SCHEMA_NODES }, () => ({ type: "null" })),
        }),
        "schema_invalid",
      ],
    ];
    for (const [schema, code] of cases) {
      const specification = publish(schema);
      expectCode(() => executeSchemaOracle(request({ schema, specification })), code);
    }
  });

  it("rejects non-schema specifications and malformed published records", () => {
    expectCode(
      () =>
        executeSchemaOracle(
          request({ specification: publish(defaultSchemaBytes, { kind: "exact" }) }),
        ),
      "kind_mismatch",
    );
    expectCode(
      () =>
        executeSchemaOracle(
          request({
            specification: { ...publish(), runtimePolicy: { network: "allowed" } } as never,
          }),
        ),
      "invalid_specification",
    );
  });

  it("fails closed at input, minimum working-set, and output byte budgets", () => {
    for (const [field, value] of [
      ["inputBytes", 1],
      ["memoryBytes", 1],
      ["outputBytes", 1],
    ] as const) {
      const base = definition();
      const specification = publish(defaultSchemaBytes, {
        budgets: { ...base.budgets, [field]: value },
      });
      expectCode(() => executeSchemaOracle(request({ specification })), "budget_exhausted");
    }
  });

  it("rejects unbounded configuration, executable content, unknown request fields, and non-bytes", () => {
    for (const maximumErrors of [0, MAX_SCHEMA_ORACLE_REPORTED_VIOLATIONS + 1, 1.5]) {
      expectCode(
        () => executeSchemaOracle(request({ configuration: { ...configuration, maximumErrors } })),
        "invalid_configuration",
      );
    }
    expectCode(
      () =>
        executeSchemaOracle(
          request({ configuration: { ...configuration, dialect: "draft-07" } as never }),
        ),
      "invalid_configuration",
    );
    expectCode(
      () =>
        executeSchemaOracle(
          request({ configuration: { ...configuration, schemaVersion: "999" } as never }),
        ),
      "invalid_configuration",
    );
    expectCode(
      () =>
        executeSchemaOracle(
          request({ configuration: { ...configuration, callback: () => true } as never }),
        ),
      "invalid_configuration",
    );
    expectCode(
      () => executeSchemaOracle({ ...request(), execute: () => true } as never),
      "invalid_configuration",
    );
    expectCode(
      () => executeSchemaOracle(request({ document: { age: 37 } as never })),
      "invalid_configuration",
    );
    expectCode(
      () => executeSchemaOracle(request({ schema: validationSchema as never })),
      "invalid_configuration",
    );
    expectCode(
      () =>
        executeSchemaOracle(
          request({
            registration: { ...request().registration, command: "node arbitrary.js" } as never,
          }),
        ),
      "invalid_registration",
    );
    expectCode(
      () =>
        executeSchemaOracle(
          request({
            registration: {
              ...request().registration,
              implementation: { ...implementation, sourceRevision: "not-a-revision" },
            } as never,
          }),
        ),
      "invalid_registration",
    );

    const symbolRequest = request() as SchemaOracleExecutionRequest & Record<symbol, unknown>;
    symbolRequest[Symbol("execute")] = () => true;
    expectCode(() => executeSchemaOracle(symbolRequest), "invalid_configuration");
  });

  it("is deterministic across repetitions and document property order", () => {
    const first = executeSchemaOracle(
      request({ document: encoder.encode('{"age":-1,"name":"","tags":[1]}') }),
    );
    const second = executeSchemaOracle(
      request({ document: encoder.encode('{"tags":[1],"name":"","age":-1}') }),
    );
    expect(second.verdict).toBe(first.verdict);
    expect(second.violationCount).toBe(first.violationCount);
    expect(second.violations).toEqual(first.violations);
    expect(executeSchemaOracle(request())).toEqual(executeSchemaOracle(request()));
  });

  it("does not mutate schema, document, registration, or specification inputs", () => {
    const value = request();
    const schemaBefore = Uint8Array.from(value.schema);
    const documentBefore = Uint8Array.from(value.document);
    const registrationBefore = structuredClone(value.registration);
    const specificationBefore = structuredClone(value.specification);

    executeSchemaOracle(value);

    expect(value.schema).toEqual(schemaBefore);
    expect(value.document).toEqual(documentBefore);
    expect(value.registration).toEqual(registrationBefore);
    expect(value.specification).toEqual(specificationBefore);
  });
});
