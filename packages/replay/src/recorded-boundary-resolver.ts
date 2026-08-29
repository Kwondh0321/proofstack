import {
  type RecordedBoundaryActualRequestMetadata,
  type RecordedBoundaryMismatchCode,
  type RecordedBoundaryReplayObservation,
  RecordedBoundaryReplayObservationSchema,
  type RecordedBoundaryRequest,
  RecordedBoundaryRequestSchema,
  type RecordedBoundaryResponse,
  RecordedBoundaryResponseSchema,
} from "@proofstack/contracts";
import {
  RecordedBoundaryMismatchError,
  RecordedBoundaryTargetContractError,
  type RecordedBoundaryTargetContractErrorCode,
} from "./errors.js";
import type { PreparedRecordedBoundaryReplay } from "./preflight.js";
import { digestNormalizedRequestBytes } from "./replay-digest.js";

function contractError(
  code: RecordedBoundaryTargetContractErrorCode,
  cause?: unknown,
): RecordedBoundaryTargetContractError {
  return new RecordedBoundaryTargetContractError(code, cause === undefined ? undefined : { cause });
}

export class RecordedBoundaryResolver {
  private closed = false;
  private consumed = 0;
  private contractFailure: RecordedBoundaryTargetContractError | undefined;
  private mismatch: RecordedBoundaryMismatchError | undefined;
  private readonly recordedObservations: RecordedBoundaryReplayObservation[] = [];
  private readonly requestIds = new Set<string>();

  constructor(private readonly prepared: PreparedRecordedBoundaryReplay) {}

  get consumedAttemptCount(): number {
    return this.consumed;
  }

  get expectedAttemptCount(): number {
    return this.prepared.attempts.length;
  }

  get hasContractFailure(): boolean {
    return this.contractFailure !== undefined;
  }

  get hasMismatch(): boolean {
    return this.mismatch !== undefined;
  }

  get observations(): readonly RecordedBoundaryReplayObservation[] {
    return structuredClone(this.recordedObservations);
  }

  close(): void {
    this.closed = true;
  }

  async resolve(input: RecordedBoundaryRequest): Promise<RecordedBoundaryResponse> {
    this.requireOpen();
    const parsed = RecordedBoundaryRequestSchema.safeParse(input);
    if (!parsed.success) {
      this.failContract("invalid_boundary_request", parsed.error);
    }
    const request = parsed.data;
    if (this.requestIds.has(request.boundaryRequestId)) {
      this.failContract("duplicate_boundary_request_id");
    }
    this.requestIds.add(request.boundaryRequestId);

    const normalizedBytes = Uint8Array.from(
      Buffer.from(request.normalizedRequest.bytes, "base64url"),
    );
    const actualRequest: RecordedBoundaryActualRequestMetadata = {
      adapterName: request.normalizedRequest.adapterName,
      adapterVersion: request.normalizedRequest.adapterVersion,
      boundaryRequestId: request.boundaryRequestId,
      kind: request.kind,
      normalizedRequestSha256: digestNormalizedRequestBytes(normalizedBytes),
      sizeBytes: normalizedBytes.byteLength,
    };
    const expectedAttempt = this.prepared.attempts[this.consumed];
    const mismatchCode = this.mismatchCode(actualRequest, expectedAttempt?.expectedRequest);
    if (mismatchCode !== undefined) {
      const observation = RecordedBoundaryReplayObservationSchema.parse({
        actualRequest,
        code: mismatchCode,
        expectedRequest: expectedAttempt?.expectedRequest ?? null,
        sequence: this.recordedObservations.length,
        status: "mismatch",
      });
      /* v8 ignore next -- Parsing a literal mismatch discriminator cannot return another union member. */
      if (observation.status !== "mismatch") {
        throw new Error("Recorded boundary mismatch observation lost its discriminator");
      }
      this.recordedObservations.push(observation);
      this.mismatch = new RecordedBoundaryMismatchError(mismatchCode, observation);
      this.closed = true;
      throw this.mismatch;
    }
    /* v8 ignore next -- mismatchCode returns extra_boundary_request whenever the expected attempt is absent. */
    if (!expectedAttempt) {
      throw new Error("Recorded boundary expectation disappeared after matching");
    }

    const response = RecordedBoundaryResponseSchema.parse({
      artifacts: expectedAttempt.returnedArtifacts,
      resolution: {
        actualRequest,
        expectedRequest: expectedAttempt.expectedRequest,
        recordedAttempt: expectedAttempt.recordedAttempt,
        returnedArtifacts: expectedAttempt.returnedArtifacts.map(({ binding }) => binding),
      },
      schemaVersion: "0.1",
    });
    const observation = RecordedBoundaryReplayObservationSchema.parse({
      resolution: response.resolution,
      sequence: this.recordedObservations.length,
      status: "matched",
    });
    this.recordedObservations.push(observation);
    this.consumed += 1;
    return response;
  }

  private failContract(code: RecordedBoundaryTargetContractErrorCode, cause?: unknown): never {
    this.contractFailure = contractError(code, cause);
    this.closed = true;
    throw this.contractFailure;
  }

  private mismatchCode(
    actual: RecordedBoundaryActualRequestMetadata,
    expected: PreparedRecordedBoundaryReplay["attempts"][number]["expectedRequest"] | undefined,
  ): RecordedBoundaryMismatchCode | undefined {
    if (!expected) return "extra_boundary_request";
    if (actual.kind !== expected.kind) return "wrong_boundary_kind";
    if (actual.adapterName !== expected.adapterName) return "wrong_adapter_name";
    if (actual.adapterVersion !== expected.adapterVersion) return "wrong_adapter_version";
    if (actual.normalizedRequestSha256 !== expected.normalizedRequestSha256) {
      return "normalized_request_digest_mismatch";
    }
    return undefined;
  }

  private requireOpen(): void {
    if (this.mismatch) throw this.mismatch;
    if (this.contractFailure) throw this.contractFailure;
    if (this.closed) throw contractError("resolver_closed");
  }
}
