import { PostgresTimestampSchema } from "./primitives.js";

/** Semantic input uses UTC and retains every supported fractional digit, without clock access. */
export const PolicyEvaluationTimeSchema = PostgresTimestampSchema.regex(/Z$/u, {
  message: "Policy evaluation time must use UTC",
});

export const POLICY_EVALUATION_TIME_UNITS_PER_MILLISECOND = 10n ** 27n;
const INSTANT_PARTS =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,30}))?(Z|[+-]\d{2}:\d{2})$/u;

/**
 * Exact semantic instant ordering for retained source timestamps, including supported offsets.
 * Unlike evidenceTimestampOrderKey (a database cursor key), this never rounds to PostgreSQL
 * microseconds. Date.parse receives whole seconds only; fractions are converted as bounded integers.
 * Do not persist this key as a timestamptz or replace the source timestamp covered by its digest.
 */
export function policyEvaluationTimestampOrderKey(value: string): bigint {
  const parsed = PostgresTimestampSchema.parse(value);
  const parts = INSTANT_PARTS.exec(parsed);
  if (!parts) throw new TypeError("Expected a supported policy-evaluation instant");
  const wholeMilliseconds = Date.parse(`${parts[1]}${parts[3]}`);
  return (
    BigInt(wholeMilliseconds) * POLICY_EVALUATION_TIME_UNITS_PER_MILLISECOND +
    BigInt((parts[2] ?? "").padEnd(30, "0"))
  );
}
