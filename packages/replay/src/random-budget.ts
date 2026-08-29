import { RecordedBoundaryRuntimeControlError } from "./errors.js";

export const MAX_RANDOM_BYTES_PER_REQUEST = 65_536;
export const MAX_RANDOM_BYTES_PER_INVOCATION = 1_048_576;

export function validateRecordedReplayRandomRequest(
  randomBytesGenerated: number,
  length: number,
): number {
  if (!Number.isInteger(length) || length < 1 || length > MAX_RANDOM_BYTES_PER_REQUEST) {
    throw new RecordedBoundaryRuntimeControlError("random_request_out_of_range");
  }
  const nextRandomBytesGenerated = randomBytesGenerated + length;
  if (nextRandomBytesGenerated > MAX_RANDOM_BYTES_PER_INVOCATION) {
    throw new RecordedBoundaryRuntimeControlError("random_budget_exhausted");
  }
  return nextRandomBytesGenerated;
}
