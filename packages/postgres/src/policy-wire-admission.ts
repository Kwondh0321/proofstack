import type { Duplex } from "node:stream";
import { Client, type ClientConfig } from "pg";

export class PostgresPolicyWireError extends Error {
  readonly code = "wire_admission";
  constructor() {
    super("Policy PostgreSQL wire admission failed");
    this.name = "PostgresPolicyWireError";
  }
}
export const POLICY_WIRE_FRAME_BYTES = 1024 * 1024;
export const POLICY_WIRE_TRANSACTION_BYTES = 16 * 1024 * 1024;
export const POLICY_WIRE_TRANSACTION_ROWS = 32768;
export const POLICY_WIRE_RECOVERY_BYTES = 512 * 1024 * 1024;
export const POLICY_WIRE_RECOVERY_ROWS = 2000000;
export const POLICY_WIRE_SEAL_BYTES = 128 * 1024 * 1024;
export const POLICY_WIRE_SEAL_ROWS = 200000;

/** Fixed five-byte header storage; never retains a field, row body, credential or artifact. */
export class PolicyWireAdmission {
  private readonly header = Buffer.alloc(5);
  private headerLength = 0;
  private remaining = 0;
  private received = 0;
  private rows = 0;
  private messages = 0;
  private byteLimit = POLICY_WIRE_FRAME_BYTES;
  private rowLimit = POLICY_WIRE_TRANSACTION_ROWS;
  private blocked = false;
  private rejected: PostgresPolicyWireError | undefined;
  private failure: ((error: PostgresPolicyWireError) => void) | undefined;

  begin(recovery: boolean | "sealing", failure: (error: PostgresPolicyWireError) => void): void {
    // A decoder with an unfinished previous frame cannot become a new admitted operation.
    if (this.blocked || this.headerLength !== 0 || this.remaining !== 0)
      throw new PostgresPolicyWireError();
    this.received = this.rows = this.messages = 0;
    this.byteLimit =
      recovery === "sealing"
        ? POLICY_WIRE_SEAL_BYTES
        : recovery
          ? POLICY_WIRE_RECOVERY_BYTES
          : POLICY_WIRE_TRANSACTION_BYTES;
    this.rowLimit =
      recovery === "sealing"
        ? POLICY_WIRE_SEAL_ROWS
        : recovery
          ? POLICY_WIRE_RECOVERY_ROWS
          : POLICY_WIRE_TRANSACTION_ROWS;
    this.failure = failure;
  }
  finish(): void {
    this.failure = undefined;
    // Keep observing idle/startup traffic. Do not discard a partial protocol frame.
    this.received = this.rows = this.messages = 0;
    this.byteLimit = POLICY_WIRE_FRAME_BYTES;
    this.rowLimit = POLICY_WIRE_TRANSACTION_ROWS;
  }
  usage() {
    return {
      receivedProtocolBytes: this.received,
      rowHeaders: this.rows,
      messageHeaders: this.messages,
    };
  }
  hasTransaction(): boolean {
    return this.failure !== undefined;
  }
  reject(): PostgresPolicyWireError {
    if (!this.rejected) {
      this.blocked = true;
      this.rejected = new PostgresPolicyWireError();
      this.failure?.(this.rejected);
    }
    return this.rejected;
  }
  admit(chunk: Buffer): boolean {
    if (this.blocked) return false;
    try {
      if (!Buffer.isBuffer(chunk)) throw new PostgresPolicyWireError();
      this.received += chunk.byteLength;
      if (this.received > this.byteLimit) throw new PostgresPolicyWireError();
      let offset = 0;
      while (offset < chunk.byteLength) {
        if (this.remaining > 0) {
          const count = Math.min(this.remaining, chunk.byteLength - offset);
          this.remaining -= count;
          offset += count;
          continue;
        }
        const count = Math.min(5 - this.headerLength, chunk.byteLength - offset);
        chunk.copy(this.header, this.headerLength, offset, offset + count);
        this.headerLength += count;
        offset += count;
        if (this.headerLength !== 5) continue;
        const length = this.header.readUInt32BE(1);
        if (length < 4 || length + 1 > POLICY_WIRE_FRAME_BYTES) throw new PostgresPolicyWireError();
        this.messages++;
        if (this.header[0] === 68 && ++this.rows > this.rowLimit)
          throw new PostgresPolicyWireError();
        this.remaining = length - 4;
        this.headerLength = 0;
      }
      return true;
    } catch {
      throw this.reject();
    }
  }
}

const admissions = new WeakMap<Client, PolicyWireAdmission>();

/**
 * Dedicated server-owned pg8.23.0 client. Install before the first backend frame, including TLS
 * upgrade and authentication. The pinned driver's decoder never receives a rejected chunk.
 */
export class PolicyWireClient extends Client {
  constructor(config?: ClientConfig) {
    super(config);
    const admission = new PolicyWireAdmission();
    admissions.set(this, admission);
    // attachListeners is verified in the installed pinned pg implementation; it is not a SQL port.
    const connection = this.connection as typeof this.connection & {
      attachListeners(stream: Duplex): void;
    };
    const attach = connection.attachListeners;
    connection.attachListeners = (stream) => {
      if (stream.listenerCount("data") !== 0) {
        stream.destroy(new PostgresPolicyWireError());
        return;
      }
      try {
        attach.call(connection, stream);
      } catch {
        stream.destroy(admission.reject());
        return;
      }
      const decoders = stream.rawListeners("data");
      const decode = decoders[0] as ((chunk: Buffer) => void) | undefined;
      if (decoders.length !== 1 || !decode) {
        stream.destroy(new PostgresPolicyWireError());
        return;
      }
      stream.removeListener("data", decode);
      stream.on("data", (chunk: Buffer) => {
        try {
          if (admission.admit(chunk)) decode.call(stream, chunk);
        } catch {
          // A transaction's registered handler destroys/drains it. Idle/startup also fails closed.
          const error = admission.reject();
          if (!admission.hasTransaction()) stream.destroy(error);
        }
      });
    };
  }
}

/** Ordinary supplied pools retain their existing contract; only the dedicated factory is branded. */
export function beginPolicyWireTransaction(
  client: Client,
  recovery: boolean | "sealing",
  failure: (error: PostgresPolicyWireError) => void,
): (() => void) | undefined {
  const admission = admissions.get(client);
  if (!admission) return undefined;
  admission.begin(recovery, failure);
  return () => admission.finish();
}
