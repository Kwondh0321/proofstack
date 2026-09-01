import { z } from "zod";
import {
  CRITERION_SET_SCHEMA_VERSION,
  CRITERION_SET_STATUS_SCHEMA_VERSION,
  type CriterionSetDefinition,
  CriterionSetDefinitionSchema,
  type CriterionSetStatusDefinition,
  CriterionSetStatusDefinitionSchema,
} from "./evaluation-criteria.js";
import {
  DISCOVERY_RECORD_SCHEMA_VERSION,
  type DiscoveryRecordDefinition,
  DiscoveryRecordDefinitionSchema,
  SOURCE_REVIEW_SCHEMA_VERSION,
  SOURCE_SNAPSHOT_SCHEMA_VERSION,
  type SourceReviewDefinition,
  SourceReviewDefinitionSchema,
  type SourceSnapshotDefinition,
  SourceSnapshotDefinitionSchema,
} from "./evaluation-source.js";
import { type EvidenceScope, EvidenceScopeSchema } from "./evidence.js";

export const EVALUATION_DEFINITION_ENCODING_VERSION =
  "proofstack.evaluation-definition-jcs.v1" as const;
export const DISCOVERY_RECORD_DEFINITION_DOMAIN = "proofstack.discovery-record.v1" as const;
export const SOURCE_SNAPSHOT_DEFINITION_DOMAIN = "proofstack.source-snapshot.v1" as const;
export const SOURCE_REVIEW_DEFINITION_DOMAIN = "proofstack.source-review.v1" as const;
export const CRITERION_SET_DEFINITION_DOMAIN = "proofstack.criterion-set.v1" as const;
export const CRITERION_SET_STATUS_DEFINITION_DOMAIN = "proofstack.criterion-set-status.v1" as const;

const MAX_CANONICAL_NESTING_DEPTH = 64;

export interface ScopedEvaluationDefinition<Definition> {
  readonly definition: Definition;
  readonly scope: EvidenceScope;
}

function containsUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function canonicalJson(value: unknown, active: WeakSet<object>, depth: number): string {
  if (depth > MAX_CANONICAL_NESTING_DEPTH) {
    throw new RangeError(
      `Canonical evaluation definitions cannot exceed ${MAX_CANONICAL_NESTING_DEPTH} levels`,
    );
  }
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Canonical evaluation definitions require finite JSON numbers");
    }
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    if (containsUnpairedSurrogate(value)) {
      throw new TypeError("Canonical evaluation definitions require Unicode scalar strings");
    }
    return JSON.stringify(value);
  }
  if (typeof value !== "object") {
    throw new TypeError("Canonical evaluation definitions contain JSON values only");
  }
  if (active.has(value)) {
    throw new TypeError("Canonical evaluation definitions cannot contain circular references");
  }
  active.add(value);
  try {
    if (Array.isArray(value)) {
      const items: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          throw new TypeError("Canonical evaluation definitions cannot contain sparse arrays");
        }
        items.push(canonicalJson(value[index], active, depth + 1));
      }
      return `[${items.join(",")}]`;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Canonical evaluation definitions require plain JSON objects");
    }
    if (Reflect.ownKeys(value).some((key) => typeof key === "symbol")) {
      throw new TypeError("Canonical evaluation definitions cannot contain symbol keys");
    }
    const entries = Object.keys(value)
      .sort()
      .map((key) => {
        if (containsUnpairedSurrogate(key)) {
          throw new TypeError("Canonical evaluation definition keys require Unicode scalars");
        }
        return `${JSON.stringify(key)}:${canonicalJson(
          (value as Record<string, unknown>)[key],
          active,
          depth + 1,
        )}`;
      });
    return `{${entries.join(",")}}`;
  } finally {
    active.delete(value);
  }
}

function encodeUtf8(value: string): Uint8Array {
  const bytes: number[] = [];
  for (const character of value) {
    const codePoint = character.codePointAt(0) as number;
    if (codePoint <= 0x7f) {
      bytes.push(codePoint);
    } else if (codePoint <= 0x7ff) {
      bytes.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f));
    } else if (codePoint <= 0xffff) {
      bytes.push(
        0xe0 | (codePoint >> 12),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    } else {
      bytes.push(
        0xf0 | (codePoint >> 18),
        0x80 | ((codePoint >> 12) & 0x3f),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    }
  }
  return Uint8Array.from(bytes);
}

/**
 * Encodes one bounded JSON value using RFC 8785 property ordering and ECMAScript number
 * serialization, then emits exact UTF-8 bytes. Strings are not normalized: callers must retain
 * their original scalar value, and schemas that require NFC must enforce it before this boundary.
 */
export function encodeEvaluationCanonicalJson(value: unknown): Uint8Array {
  return encodeUtf8(canonicalJson(value, new WeakSet<object>(), 0));
}

function scopedDefinitionSchema<Definition extends z.ZodType>(definition: Definition) {
  return z.object({ definition, scope: EvidenceScopeSchema }).strict();
}

function encodeDefinition(
  definitionDomain: string,
  schemaVersion: string,
  scope: EvidenceScope,
  definition: unknown,
): Uint8Array {
  return encodeEvaluationCanonicalJson({
    definition,
    definitionDomain,
    encodingVersion: EVALUATION_DEFINITION_ENCODING_VERSION,
    schemaVersion,
    scope,
  });
}

export function encodeDiscoveryRecordDefinition(
  input: ScopedEvaluationDefinition<DiscoveryRecordDefinition>,
): Uint8Array {
  const parsed = scopedDefinitionSchema(DiscoveryRecordDefinitionSchema).parse(input);
  return encodeDefinition(
    DISCOVERY_RECORD_DEFINITION_DOMAIN,
    DISCOVERY_RECORD_SCHEMA_VERSION,
    parsed.scope,
    parsed.definition,
  );
}

export function encodeSourceSnapshotDefinition(
  input: ScopedEvaluationDefinition<SourceSnapshotDefinition>,
): Uint8Array {
  const parsed = scopedDefinitionSchema(SourceSnapshotDefinitionSchema).parse(input);
  return encodeDefinition(
    SOURCE_SNAPSHOT_DEFINITION_DOMAIN,
    SOURCE_SNAPSHOT_SCHEMA_VERSION,
    parsed.scope,
    parsed.definition,
  );
}

export function encodeSourceReviewDefinition(
  input: ScopedEvaluationDefinition<SourceReviewDefinition>,
): Uint8Array {
  const parsed = scopedDefinitionSchema(SourceReviewDefinitionSchema).parse(input);
  return encodeDefinition(
    SOURCE_REVIEW_DEFINITION_DOMAIN,
    SOURCE_REVIEW_SCHEMA_VERSION,
    parsed.scope,
    parsed.definition,
  );
}

export function encodeCriterionSetDefinition(
  input: ScopedEvaluationDefinition<CriterionSetDefinition>,
): Uint8Array {
  const parsed = scopedDefinitionSchema(CriterionSetDefinitionSchema).parse(input);
  return encodeDefinition(
    CRITERION_SET_DEFINITION_DOMAIN,
    CRITERION_SET_SCHEMA_VERSION,
    parsed.scope,
    parsed.definition,
  );
}

export function encodeCriterionSetStatusDefinition(
  input: ScopedEvaluationDefinition<CriterionSetStatusDefinition>,
): Uint8Array {
  const parsed = scopedDefinitionSchema(CriterionSetStatusDefinitionSchema).parse(input);
  return encodeDefinition(
    CRITERION_SET_STATUS_DEFINITION_DOMAIN,
    CRITERION_SET_STATUS_SCHEMA_VERSION,
    parsed.scope,
    parsed.definition,
  );
}
