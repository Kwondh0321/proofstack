import {
  PolicyEvaluationTimeSchema,
  POLICY_EVALUATION_TIME_UNITS_PER_MILLISECOND,
  policyEvaluationTimestampOrderKey,
} from "@proofstack/contracts";

const unitsPerSecond = POLICY_EVALUATION_TIME_UNITS_PER_MILLISECOND * 1000n;
/** Exact server-receipt arithmetic, not semantic-source normalization or an expiry authority. */
export function addPolicyEvaluationMilliseconds(value: string, duration: number): string {
  if (!Number.isSafeInteger(duration) || duration < 0)
    throw new RangeError("Expected a bounded nonnegative integer duration");
  const key =
    policyEvaluationTimestampOrderKey(PolicyEvaluationTimeSchema.parse(value)) +
    BigInt(duration) * POLICY_EVALUATION_TIME_UNITS_PER_MILLISECOND;
  // BigInt division truncates toward zero. Floor for pre-epoch receipts before extracting
  // the positive fractional remainder; Date receives whole seconds only, never fractional time.
  let seconds = key / unitsPerSecond;
  let fraction = key % unitsPerSecond;
  if (fraction < 0n) {
    seconds--;
    fraction += unitsPerSecond;
  }
  const whole = new Date(Number(seconds) * 1000).toISOString().slice(0, 19);
  const digits = fraction.toString().padStart(30, "0").replace(/0+$/u, "");
  return PolicyEvaluationTimeSchema.parse(`${whole}${digits ? `.${digits}` : ".000"}Z`);
}
/** Return the original receipt text at the earlier instant, preserving its exact representation. */
export function earlierPolicyEvaluationTime(left: string, right: string): string {
  return policyEvaluationTimestampOrderKey(left) <= policyEvaluationTimestampOrderKey(right)
    ? left
    : right;
}
/** Compare before formatting so an otherwise valid near-year-9999 job can cap its next lease. */
export function addPolicyEvaluationMillisecondsUpTo(
  value: string,
  duration: number,
  ceiling: string,
): string {
  if (!Number.isSafeInteger(duration) || duration < 0)
    throw new RangeError("Expected a bounded nonnegative integer duration");
  const limit = PolicyEvaluationTimeSchema.parse(ceiling);
  const target =
    policyEvaluationTimestampOrderKey(PolicyEvaluationTimeSchema.parse(value)) +
    BigInt(duration) * POLICY_EVALUATION_TIME_UNITS_PER_MILLISECOND;
  return target >= policyEvaluationTimestampOrderKey(limit)
    ? limit
    : addPolicyEvaluationMilliseconds(value, duration);
}
