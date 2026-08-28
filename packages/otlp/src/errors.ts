export type OtlpDecodeErrorCode =
  | "invalid_json"
  | "invalid_json_mapping"
  | "invalid_protobuf"
  | "unsupported_encoding";

export class OtlpDecodeError extends Error {
  constructor(
    readonly code: OtlpDecodeErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "OtlpDecodeError";
  }
}
