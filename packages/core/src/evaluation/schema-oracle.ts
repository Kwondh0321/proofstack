import { createHash } from "node:crypto";
import {
  ArtifactContentReferenceSchema,
  encodeEvaluationCanonicalJson,
  encodeOracleSpecDefinition,
  type OracleSpec,
  OracleSpecSchema,
  RegisteredEvaluationImplementationSchema,
} from "@proofstack/contracts";
import { Ajv2020, type AnySchema, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import { BoundedJsonParseError, parseBoundedJson } from "./bounded-json.js";

type ArtifactContentReference = ReturnType<typeof ArtifactContentReferenceSchema.parse>;
type RegisteredEvaluationImplementation = ReturnType<
  typeof RegisteredEvaluationImplementationSchema.parse
>;

export const SCHEMA_ORACLE_ADAPTER_ID = "proofstack.json-schema-2020-12.v1" as const;
export const SCHEMA_ORACLE_CONFIGURATION_SCHEMA_VERSION = "0.1" as const;
export const SCHEMA_ORACLE_DIALECT = "https://json-schema.org/draft/2020-12/schema" as const;
export const MAX_SCHEMA_ORACLE_SCHEMA_NODES = 1_024;
export const MAX_SCHEMA_ORACLE_DOCUMENT_NODES = 8_192;
export const MAX_SCHEMA_ORACLE_REPORTED_VIOLATIONS = 256;

const forbiddenSchemaKeywords = new Set([
  "$anchor",
  "$async",
  "$dynamicAnchor",
  "$dynamicRef",
  "$id",
  "$recursiveAnchor",
  "$recursiveRef",
  "$ref",
  "$vocabulary",
  "contentEncoding",
  "contentMediaType",
  "contentSchema",
  "format",
  "pattern",
  "patternProperties",
  "uniqueItems",
]);

export type SchemaOracleAdapterErrorCode =
  | "budget_exhausted"
  | "configuration_digest_mismatch"
  | "definition_digest_mismatch"
  | "implementation_mismatch"
  | "invalid_configuration"
  | "invalid_registration"
  | "invalid_specification"
  | "kind_mismatch"
  | "schema_artifact_mismatch"
  | "schema_invalid"
  | "schema_mismatch"
  | "schema_profile_unsupported";

export class SchemaOracleAdapterError extends Error {
  constructor(
    readonly code: SchemaOracleAdapterErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SchemaOracleAdapterError";
  }
}

export interface SchemaOracleRegistration {
  readonly implementation: RegisteredEvaluationImplementation;
  readonly inputSchema: ArtifactContentReference;
  readonly outputSchema: ArtifactContentReference;
}

export interface SchemaOracleConfiguration {
  readonly dialect: typeof SCHEMA_ORACLE_DIALECT;
  readonly maximumErrors: number;
  readonly schemaVersion: typeof SCHEMA_ORACLE_CONFIGURATION_SCHEMA_VERSION;
}

export interface SchemaOracleExecutionRequest {
  readonly configuration: SchemaOracleConfiguration;
  readonly document: Uint8Array;
  readonly registration: SchemaOracleRegistration;
  readonly schema: Uint8Array;
  readonly specification: OracleSpec;
}

export interface SchemaOracleViolation {
  readonly instancePath: string;
  readonly keyword: string;
  readonly message: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly schemaPath: string;
}

interface SchemaOracleResultBase {
  readonly adapterId: typeof SCHEMA_ORACLE_ADAPTER_ID;
  readonly document: {
    readonly sha256: string;
    readonly sizeBytes: number;
  };
  readonly implementationSha256: string;
  readonly oracle: {
    readonly definitionSha256: string;
    readonly oracleId: string;
    readonly oracleVersionId: string;
  };
  readonly schema: {
    readonly artifact: ArtifactContentReference;
    readonly sha256: string;
    readonly sizeBytes: number;
  };
  readonly usage: {
    readonly documentNodes: number | null;
    readonly inputBytes: number;
    readonly minimumWorkingSetBytes: number;
    readonly outputBytes: number;
    readonly schemaNodes: number;
  };
}

export type SchemaOracleExecutionResult = SchemaOracleResultBase &
  (
    | {
        readonly error: {
          readonly characterOffset: number;
          readonly code: "document_malformed";
          readonly message: string;
        };
        readonly valid: null;
        readonly verdict: "error";
        readonly violationCount: 0;
        readonly violations: readonly [];
        readonly violationsTruncated: false;
      }
    | {
        readonly valid: boolean;
        readonly verdict: "fail" | "pass";
        readonly violationCount: number;
        readonly violations: readonly SchemaOracleViolation[];
        readonly violationsTruncated: boolean;
      }
  );

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
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

function equalCanonicalJson(left: unknown, right: unknown): boolean {
  return Buffer.from(encodeEvaluationCanonicalJson(left)).equals(
    Buffer.from(encodeEvaluationCanonicalJson(right)),
  );
}

function parseConfiguration(input: unknown): SchemaOracleConfiguration {
  if (!isStrictRecord(input, ["dialect", "maximumErrors", "schemaVersion"])) {
    throw new SchemaOracleAdapterError(
      "invalid_configuration",
      "The schema oracle configuration must contain only its declared fields",
    );
  }
  const maximumErrors = input["maximumErrors"];
  if (
    input["dialect"] !== SCHEMA_ORACLE_DIALECT ||
    input["schemaVersion"] !== SCHEMA_ORACLE_CONFIGURATION_SCHEMA_VERSION ||
    !Number.isInteger(maximumErrors) ||
    (maximumErrors as number) < 1 ||
    (maximumErrors as number) > MAX_SCHEMA_ORACLE_REPORTED_VIOLATIONS
  ) {
    throw new SchemaOracleAdapterError(
      "invalid_configuration",
      "The schema oracle configuration uses an unsupported or unbounded profile",
    );
  }
  return {
    dialect: SCHEMA_ORACLE_DIALECT,
    maximumErrors: maximumErrors as number,
    schemaVersion: SCHEMA_ORACLE_CONFIGURATION_SCHEMA_VERSION,
  };
}

function parseRegistration(input: unknown): SchemaOracleRegistration {
  if (!isStrictRecord(input, ["implementation", "inputSchema", "outputSchema"])) {
    throw new SchemaOracleAdapterError(
      "invalid_registration",
      "The schema oracle registration must contain only its declared fields",
    );
  }
  const implementation = RegisteredEvaluationImplementationSchema.safeParse(
    input["implementation"],
  );
  const inputSchema = ArtifactContentReferenceSchema.safeParse(input["inputSchema"]);
  const outputSchema = ArtifactContentReferenceSchema.safeParse(input["outputSchema"]);
  if (!implementation.success || !inputSchema.success || !outputSchema.success) {
    throw new SchemaOracleAdapterError(
      "invalid_registration",
      "The schema oracle registration is malformed",
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
    throw new SchemaOracleAdapterError(
      "invalid_specification",
      "The schema oracle specification is invalid",
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
  registration: SchemaOracleRegistration,
): void {
  if (!equalCanonicalJson(specification.implementation, registration.implementation)) {
    throw new SchemaOracleAdapterError(
      "implementation_mismatch",
      "The loaded implementation does not match the registered schema oracle implementation",
    );
  }
  if (!equalCanonicalJson(specification.inputSchema, registration.inputSchema)) {
    throw new SchemaOracleAdapterError(
      "schema_mismatch",
      "The loaded validation schema reference does not match the specification",
    );
  }
  if (!equalCanonicalJson(specification.outputSchema, registration.outputSchema)) {
    throw new SchemaOracleAdapterError(
      "schema_mismatch",
      "The loaded result schema reference does not match the specification",
    );
  }
}

function assertBudget(limit: number, used: number, label: string): void {
  if (used > limit) {
    throw new SchemaOracleAdapterError(
      "budget_exhausted",
      `The schema oracle ${label} budget was exhausted`,
    );
  }
}

function assertBytes(value: unknown, label: "document" | "schema"): asserts value is Uint8Array {
  if (!(value instanceof Uint8Array)) {
    throw new SchemaOracleAdapterError(
      "invalid_configuration",
      `The schema oracle ${label} must be bytes`,
    );
  }
}

function inspectSchemaProfile(schema: unknown): void {
  if (
    schema === null ||
    typeof schema !== "object" ||
    Array.isArray(schema) ||
    !isStrictRecord(schema, Object.keys(schema))
  ) {
    throw new SchemaOracleAdapterError(
      "schema_profile_unsupported",
      "The bounded schema profile requires an object schema at the root",
    );
  }
  if (schema["$schema"] !== SCHEMA_ORACLE_DIALECT) {
    throw new SchemaOracleAdapterError(
      "schema_profile_unsupported",
      "The schema must explicitly declare the configured 2020-12 dialect",
    );
  }

  const visit = (value: unknown, root: boolean): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item, false);
      return;
    }
    if (value === null || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (forbiddenSchemaKeywords.has(key)) {
        throw new SchemaOracleAdapterError(
          "schema_profile_unsupported",
          `The bounded schema profile forbids keyword ${key}`,
        );
      }
      if (!root && key === "$schema") {
        throw new SchemaOracleAdapterError(
          "schema_profile_unsupported",
          "Nested schema dialect changes are forbidden",
        );
      }
      visit(child, false);
    }
  };
  visit(schema, true);
}

function normalizeViolation(error: ErrorObject): SchemaOracleViolation {
  const params = error.params as Readonly<Record<string, unknown>>;
  encodeEvaluationCanonicalJson(params);
  return {
    instancePath: error.instancePath,
    keyword: error.keyword,
    message: error.message ?? "Schema validation failed",
    params,
    schemaPath: error.schemaPath,
  };
}

function compareCanonical(left: unknown, right: unknown): number {
  return Buffer.compare(
    Buffer.from(encodeEvaluationCanonicalJson(left)),
    Buffer.from(encodeEvaluationCanonicalJson(right)),
  );
}

function withMeasuredOutput<
  Result extends Omit<SchemaOracleExecutionResult, "usage"> & {
    readonly usage: Omit<SchemaOracleResultBase["usage"], "outputBytes">;
  },
>(result: Result, outputBudget: number): SchemaOracleExecutionResult {
  let outputBytes = 0;
  for (;;) {
    const measured = encodeEvaluationCanonicalJson({
      ...result,
      usage: { ...result.usage, outputBytes },
    }).byteLength;
    if (measured === outputBytes) break;
    outputBytes = measured;
  }
  assertBudget(outputBudget, outputBytes, "output byte");
  return { ...result, usage: { ...result.usage, outputBytes } } as SchemaOracleExecutionResult;
}

/**
 * Validates strict JSON bytes against a digest-bound JSON Schema 2020-12 document. The initial
 * bounded profile intentionally rejects references, regexes, formats, content decoding, and
 * uniqueness scans. Worker-level elapsed-time enforcement and process isolation wrap this pure
 * adapter; no schema can request network access, callbacks, mutation, defaults, or coercion.
 */
export function executeSchemaOracle(
  input: SchemaOracleExecutionRequest,
): SchemaOracleExecutionResult {
  if (
    !isStrictRecord(input, ["configuration", "document", "registration", "schema", "specification"])
  ) {
    throw new SchemaOracleAdapterError(
      "invalid_configuration",
      "The schema oracle request must contain only its declared fields",
    );
  }
  const specification = parseSpecification(input.specification);
  if (specification.kind !== "schema") {
    throw new SchemaOracleAdapterError(
      "kind_mismatch",
      "The schema oracle adapter only executes specifications of kind schema",
    );
  }
  const definitionSha256 = sha256(encodeOracleSpecDefinition(oracleDefinition(specification)));
  if (definitionSha256 !== specification.definitionSha256) {
    throw new SchemaOracleAdapterError(
      "definition_digest_mismatch",
      "The oracle specification definition digest does not match its canonical content",
    );
  }

  const registration = parseRegistration(input.registration);
  assertRegistrationMatches(specification, registration);
  const configuration = parseConfiguration(input.configuration);
  const configurationBytes = encodeEvaluationCanonicalJson(configuration);
  if (sha256(configurationBytes) !== specification.configurationSha256) {
    throw new SchemaOracleAdapterError(
      "configuration_digest_mismatch",
      "The schema oracle configuration digest does not match the specification",
    );
  }

  assertBytes(input.schema, "schema");
  assertBytes(input.document, "document");
  const inputBytes =
    configurationBytes.byteLength + input.schema.byteLength + input.document.byteLength;
  assertBudget(specification.budgets.inputBytes, inputBytes, "input byte");
  assertBudget(specification.budgets.memoryBytes, inputBytes, "minimum working set");
  if (
    input.schema.byteLength !== specification.inputSchema.sizeBytes ||
    sha256(input.schema) !== specification.inputSchema.sha256
  ) {
    throw new SchemaOracleAdapterError(
      "schema_artifact_mismatch",
      "The validation schema bytes do not match the specification artifact",
    );
  }

  let parsedSchema: ReturnType<typeof parseBoundedJson>;
  try {
    parsedSchema = parseBoundedJson(input.schema, MAX_SCHEMA_ORACLE_SCHEMA_NODES);
    encodeEvaluationCanonicalJson(parsedSchema.value);
    inspectSchemaProfile(parsedSchema.value);
  } catch (error) {
    if (error instanceof SchemaOracleAdapterError) throw error;
    throw new SchemaOracleAdapterError(
      "schema_invalid",
      "The registered validation schema is not valid bounded JSON",
      { cause: error },
    );
  }

  let validate: ValidateFunction;
  try {
    const ajv = new Ajv2020({
      allErrors: true,
      allowUnionTypes: false,
      coerceTypes: false,
      messages: true,
      ownProperties: true,
      removeAdditional: false,
      strict: true,
      unicodeRegExp: true,
      useDefaults: false,
      validateFormats: false,
    });
    validate = ajv.compile(parsedSchema.value as AnySchema);
  } catch (error) {
    throw new SchemaOracleAdapterError(
      "schema_invalid",
      "The registered validation schema does not compile under the bounded profile",
      { cause: error },
    );
  }

  const documentDigest = sha256(input.document);
  const base = {
    adapterId: SCHEMA_ORACLE_ADAPTER_ID,
    document: { sha256: documentDigest, sizeBytes: input.document.byteLength },
    implementationSha256: specification.implementation.implementationSha256,
    oracle: {
      definitionSha256: specification.definitionSha256,
      oracleId: specification.oracleId,
      oracleVersionId: specification.oracleVersionId,
    },
    schema: {
      artifact: specification.inputSchema,
      sha256: specification.inputSchema.sha256,
      sizeBytes: input.schema.byteLength,
    },
  } as const;

  let document: ReturnType<typeof parseBoundedJson>;
  try {
    document = parseBoundedJson(input.document, MAX_SCHEMA_ORACLE_DOCUMENT_NODES);
    encodeEvaluationCanonicalJson(document.value);
  } catch (error) {
    const malformed =
      error instanceof BoundedJsonParseError
        ? error
        : new BoundedJsonParseError(0, "Document is not canonical JSON", { cause: error });
    return withMeasuredOutput(
      {
        ...base,
        error: {
          characterOffset: malformed.characterOffset,
          code: "document_malformed" as const,
          message: malformed.message,
        },
        usage: {
          documentNodes: null,
          inputBytes,
          minimumWorkingSetBytes: inputBytes,
          schemaNodes: parsedSchema.nodeCount,
        },
        valid: null,
        verdict: "error" as const,
        violationCount: 0 as const,
        violations: [] as const,
        violationsTruncated: false as const,
      },
      specification.budgets.outputBytes,
    );
  }

  const valid = validate(document.value) as boolean;
  const allViolations = valid
    ? []
    : (validate.errors ?? []).map(normalizeViolation).sort(compareCanonical);
  const violations = allViolations.slice(0, configuration.maximumErrors);
  return withMeasuredOutput(
    {
      ...base,
      usage: {
        documentNodes: document.nodeCount,
        inputBytes,
        minimumWorkingSetBytes: inputBytes,
        schemaNodes: parsedSchema.nodeCount,
      },
      valid,
      verdict: valid ? ("pass" as const) : ("fail" as const),
      violationCount: allViolations.length,
      violations,
      violationsTruncated: violations.length < allViolations.length,
    },
    specification.budgets.outputBytes,
  );
}
