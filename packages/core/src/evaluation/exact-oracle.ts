import { createHash } from "node:crypto";
import {
  ArtifactContentReferenceSchema,
  encodeEvaluationCanonicalJson,
  encodeOracleSpecDefinition,
  type OracleSpec,
  OracleSpecSchema,
  RegisteredEvaluationImplementationSchema,
} from "@proofstack/contracts";

type ArtifactContentReference = ReturnType<typeof ArtifactContentReferenceSchema.parse>;
type RegisteredEvaluationImplementation = ReturnType<
  typeof RegisteredEvaluationImplementationSchema.parse
>;

export const EXACT_ORACLE_ADAPTER_ID = "proofstack.exact-bytes.v1" as const;
export const EXACT_ORACLE_CONFIGURATION_SCHEMA_VERSION = "0.1" as const;

export type ExactOracleAdapterErrorCode =
  | "budget_exhausted"
  | "configuration_digest_mismatch"
  | "definition_digest_mismatch"
  | "expected_artifact_mismatch"
  | "implementation_mismatch"
  | "invalid_configuration"
  | "invalid_registration"
  | "invalid_specification"
  | "kind_mismatch"
  | "schema_mismatch";

export class ExactOracleAdapterError extends Error {
  constructor(
    readonly code: ExactOracleAdapterErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ExactOracleAdapterError";
  }
}

export interface ExactOracleRegistration {
  readonly implementation: RegisteredEvaluationImplementation;
  readonly inputSchema: ArtifactContentReference;
  readonly outputSchema: ArtifactContentReference;
}

export interface ExactOracleConfiguration {
  readonly comparison: "exact_bytes";
  readonly expected: ArtifactContentReference;
  readonly schemaVersion: typeof EXACT_ORACLE_CONFIGURATION_SCHEMA_VERSION;
}

export interface ExactOracleExecutionRequest {
  readonly actual: Uint8Array;
  readonly configuration: ExactOracleConfiguration;
  readonly expected: Uint8Array;
  readonly registration: ExactOracleRegistration;
  readonly specification: OracleSpec;
}

export interface ExactOracleExecutionResult {
  readonly actual: {
    readonly sha256: string;
    readonly sizeBytes: number;
  };
  readonly adapterId: typeof EXACT_ORACLE_ADAPTER_ID;
  readonly expected: {
    readonly artifact: ArtifactContentReference;
    readonly sha256: string;
    readonly sizeBytes: number;
  };
  readonly implementationSha256: string;
  readonly matched: boolean;
  readonly oracle: {
    readonly definitionSha256: string;
    readonly oracleId: string;
    readonly oracleVersionId: string;
  };
  readonly usage: {
    readonly inputBytes: number;
    readonly minimumWorkingSetBytes: number;
    readonly outputBytes: number;
  };
  readonly verdict: "fail" | "pass";
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function equalCanonicalJson(left: unknown, right: unknown): boolean {
  const leftBytes = encodeEvaluationCanonicalJson(left);
  const rightBytes = encodeEvaluationCanonicalJson(right);
  return Buffer.from(leftBytes).equals(Buffer.from(rightBytes));
}

function isStrictRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key === "symbol")) return false;
  const actualKeys = (ownKeys as string[]).sort();
  const expectedKeys = [...keys].sort();
  return (
    actualKeys.length === expectedKeys.length &&
    actualKeys.every((key, index) => key === expectedKeys[index])
  );
}

function parseConfiguration(input: unknown): ExactOracleConfiguration {
  if (!isStrictRecord(input, ["comparison", "expected", "schemaVersion"])) {
    throw new ExactOracleAdapterError(
      "invalid_configuration",
      "The exact oracle configuration must contain only its declared fields",
    );
  }
  if (
    input["comparison"] !== "exact_bytes" ||
    input["schemaVersion"] !== EXACT_ORACLE_CONFIGURATION_SCHEMA_VERSION
  ) {
    throw new ExactOracleAdapterError(
      "invalid_configuration",
      "The exact oracle configuration uses an unsupported profile",
    );
  }
  const expected = ArtifactContentReferenceSchema.safeParse(input["expected"]);
  if (!expected.success) {
    throw new ExactOracleAdapterError(
      "invalid_configuration",
      "The expected artifact reference is invalid",
      { cause: expected.error },
    );
  }
  return {
    comparison: input["comparison"],
    expected: expected.data,
    schemaVersion: input["schemaVersion"],
  };
}

function parseRegistration(input: unknown): ExactOracleRegistration {
  if (!isStrictRecord(input, ["implementation", "inputSchema", "outputSchema"])) {
    throw new ExactOracleAdapterError(
      "invalid_registration",
      "The exact oracle registration must contain only its declared fields",
    );
  }
  const implementation = RegisteredEvaluationImplementationSchema.safeParse(
    input["implementation"],
  );
  const inputSchema = ArtifactContentReferenceSchema.safeParse(input["inputSchema"]);
  const outputSchema = ArtifactContentReferenceSchema.safeParse(input["outputSchema"]);
  if (!implementation.success || !inputSchema.success || !outputSchema.success) {
    throw new ExactOracleAdapterError(
      "invalid_registration",
      "The exact oracle registration is malformed",
      {
        cause: !implementation.success
          ? implementation.error
          : !inputSchema.success
            ? inputSchema.error
            : outputSchema.error,
      },
    );
  }
  return {
    implementation: implementation.data,
    inputSchema: inputSchema.data,
    outputSchema: outputSchema.data,
  };
}

function parseSpecification(input: unknown): OracleSpec {
  const specification = OracleSpecSchema.safeParse(input);
  if (!specification.success) {
    throw new ExactOracleAdapterError(
      "invalid_specification",
      "The exact oracle specification is invalid",
      { cause: specification.error },
    );
  }
  return specification.data;
}

function oracleDefinition(specification: OracleSpec) {
  const {
    definitionSha256: _definitionSha256,
    publishedAt: _publishedAt,
    publishedByPrincipalId: _publishedByPrincipalId,
    schemaVersion: _schemaVersion,
    scope,
    ...definition
  } = specification;
  return { definition, scope };
}

function assertRegistrationMatches(
  specification: OracleSpec,
  registration: ExactOracleRegistration,
): void {
  if (!equalCanonicalJson(specification.implementation, registration.implementation)) {
    throw new ExactOracleAdapterError(
      "implementation_mismatch",
      "The loaded implementation does not match the registered oracle implementation",
    );
  }
  if (!equalCanonicalJson(specification.inputSchema, registration.inputSchema)) {
    throw new ExactOracleAdapterError(
      "schema_mismatch",
      "The loaded exact oracle input schema does not match the specification",
    );
  }
  if (!equalCanonicalJson(specification.outputSchema, registration.outputSchema)) {
    throw new ExactOracleAdapterError(
      "schema_mismatch",
      "The loaded exact oracle output schema does not match the specification",
    );
  }
}

function assertBudget(limit: number, used: number, label: string): void {
  if (used > limit) {
    throw new ExactOracleAdapterError(
      "budget_exhausted",
      `The exact oracle ${label} budget was exhausted`,
    );
  }
}

function assertBytes(value: unknown, label: "actual" | "expected"): asserts value is Uint8Array {
  if (!(value instanceof Uint8Array)) {
    throw new ExactOracleAdapterError(
      "invalid_configuration",
      `The exact oracle ${label} value must be bytes`,
    );
  }
}

/**
 * Executes the built-in exact-byte oracle after binding every executable input to a published
 * specification. This adapter performs no I/O and accepts no caller-supplied executable code.
 * Elapsed-time enforcement and process-level memory isolation remain the responsibility of the
 * worker that invokes this bounded synchronous adapter.
 */
export function executeExactOracle(input: ExactOracleExecutionRequest): ExactOracleExecutionResult {
  if (
    !isStrictRecord(input, ["actual", "configuration", "expected", "registration", "specification"])
  ) {
    throw new ExactOracleAdapterError(
      "invalid_configuration",
      "The exact oracle request must contain only its declared fields",
    );
  }
  const specification = parseSpecification(input.specification);
  if (specification.kind !== "exact") {
    throw new ExactOracleAdapterError(
      "kind_mismatch",
      "The exact oracle adapter only executes specifications of kind exact",
    );
  }

  const definitionSha256 = sha256(encodeOracleSpecDefinition(oracleDefinition(specification)));
  if (definitionSha256 !== specification.definitionSha256) {
    throw new ExactOracleAdapterError(
      "definition_digest_mismatch",
      "The oracle specification definition digest does not match its canonical content",
    );
  }

  const registration = parseRegistration(input.registration);
  assertRegistrationMatches(specification, registration);
  const configuration = parseConfiguration(input.configuration);
  const configurationBytes = encodeEvaluationCanonicalJson(configuration);
  if (sha256(configurationBytes) !== specification.configurationSha256) {
    throw new ExactOracleAdapterError(
      "configuration_digest_mismatch",
      "The exact oracle configuration digest does not match the specification",
    );
  }

  assertBytes(input.actual, "actual");
  assertBytes(input.expected, "expected");
  const inputBytes =
    configurationBytes.byteLength + input.actual.byteLength + input.expected.byteLength;
  assertBudget(specification.budgets.inputBytes, inputBytes, "input byte");
  if (input.expected.byteLength !== configuration.expected.sizeBytes) {
    throw new ExactOracleAdapterError(
      "expected_artifact_mismatch",
      "The expected bytes do not match the configured artifact size",
    );
  }
  const expectedDigest = sha256(input.expected);
  if (expectedDigest !== configuration.expected.sha256) {
    throw new ExactOracleAdapterError(
      "expected_artifact_mismatch",
      "The expected bytes do not match the configured artifact digest",
    );
  }

  const minimumWorkingSetBytes = inputBytes;
  assertBudget(specification.budgets.memoryBytes, minimumWorkingSetBytes, "minimum working set");
  const actualBytes = Uint8Array.from(input.actual);
  const expectedBytes = Uint8Array.from(input.expected);
  const actualDigest = sha256(actualBytes);
  const matched = Buffer.from(actualBytes).equals(Buffer.from(expectedBytes));
  const resultWithoutUsage = {
    actual: { sha256: actualDigest, sizeBytes: actualBytes.byteLength },
    adapterId: EXACT_ORACLE_ADAPTER_ID,
    expected: {
      artifact: configuration.expected,
      sha256: expectedDigest,
      sizeBytes: expectedBytes.byteLength,
    },
    implementationSha256: specification.implementation.implementationSha256,
    matched,
    oracle: {
      definitionSha256: specification.definitionSha256,
      oracleId: specification.oracleId,
      oracleVersionId: specification.oracleVersionId,
    },
    verdict: matched ? ("pass" as const) : ("fail" as const),
  };
  let outputBytes = 0;
  for (;;) {
    const measured = encodeEvaluationCanonicalJson({
      ...resultWithoutUsage,
      usage: {
        inputBytes,
        minimumWorkingSetBytes,
        outputBytes,
      },
    }).byteLength;
    if (measured === outputBytes) break;
    outputBytes = measured;
  }
  assertBudget(specification.budgets.outputBytes, outputBytes, "output byte");

  return {
    ...resultWithoutUsage,
    usage: {
      inputBytes,
      minimumWorkingSetBytes,
      outputBytes,
    },
  };
}
