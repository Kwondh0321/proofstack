import { createServer, type Socket } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { createPolicyPostgresPool } from "./database.js";
import {
  PolicyWireAdmission,
  POLICY_WIRE_FRAME_BYTES,
  POLICY_WIRE_TRANSACTION_BYTES,
  POLICY_WIRE_TRANSACTION_ROWS,
  POLICY_WIRE_RECOVERY_BYTES,
} from "./policy-wire-admission.js";

// Independent PostgreSQL backend frame construction. Admission never interprets field values.
function frame(type: string, payload = Buffer.alloc(0)) {
  const value = Buffer.alloc(5 + payload.byteLength);
  value.write(type, 0, "ascii");
  value.writeUInt32BE(payload.byteLength + 4, 1);
  payload.copy(value, 5);
  return value;
}
describe("PostgreSQL backend admission before driver decoding", () => {
  it.each(["oversized", "decoder_failure"])(
    "rejects a %s startup response before a query can run",
    async (kind) => {
      const sockets = new Set<Socket>();
      const server = createServer((socket) => {
        sockets.add(socket);
        socket.on("error", () => undefined);
        socket.on("close", () => sockets.delete(socket));
        socket.once("data", () => {
          if (kind === "decoder_failure") {
            // A complete DataRow declares a field but omits its length/value. The actual pinned
            // decoder throws; connection startup must fail rather than swallowing that exception.
            socket.write(frame("D", Buffer.from([0, 1])));
          } else {
            const header = Buffer.alloc(5);
            header[0] = 82;
            header.writeUInt32BE(POLICY_WIRE_FRAME_BYTES, 1);
            socket.write(header);
          }
        });
      });
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("Missing test listener");
      const pool = createPolicyPostgresPool({
        connectionString: `postgresql://fixture@127.0.0.1:${address.port}/proofstack_test?sslmode=disable`,
        maxConnections: 1,
        onIdleError: vi.fn(),
      });
      try {
        await expect(pool.connect()).rejects.toMatchObject({ code: "wire_admission" });
        expect(pool.waitingCount).toBe(0);
      } finally {
        await pool.end();
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );
  it("keeps one failure and taints even a caught decoder rejection", () => {
    const guard = new PolicyWireAdmission(),
      fail = vi.fn();
    guard.begin(false, fail);
    const original = guard.reject();
    expect(guard.reject()).toBe(original);
    expect(fail).toHaveBeenCalledExactlyOnceWith(original);
    expect(guard.admit(frame("Z"))).toBe(false);
    guard.finish();
    expect(() => guard.begin(false, fail)).toThrow("wire admission");
  });
  it("preserves every fragmentation boundary and coalesced frame without retaining a body", () => {
    const value = Buffer.concat([
      frame("T", Buffer.from("row description")),
      frame("D", Buffer.from("first row")),
      frame("D", Buffer.from("second row")),
      frame("Z", Buffer.from("I")),
    ]);
    for (let split = 0; split <= value.byteLength; split++) {
      const guard = new PolicyWireAdmission();
      const fail = vi.fn();
      guard.begin(false, fail);
      expect(guard.admit(value.subarray(0, split))).toBe(true);
      expect(guard.admit(value.subarray(split))).toBe(true);
      expect(guard.usage()).toEqual({
        receivedProtocolBytes: value.byteLength,
        rowHeaders: 2,
        messageHeaders: 4,
      });
      expect(fail).not.toHaveBeenCalled();
      guard.finish();
      expect(() => guard.begin(false, fail)).not.toThrow();
    }
  });
  it("admits exactly the frame ceiling and rejects an excess header before any body arrives", () => {
    const guard = new PolicyWireAdmission();
    const fail = vi.fn();
    guard.begin(false, fail);
    expect(guard.admit(frame("D", Buffer.alloc(POLICY_WIRE_FRAME_BYTES - 5)))).toBe(true);
    const excess = Buffer.alloc(5);
    excess[0] = 68;
    excess.writeUInt32BE(POLICY_WIRE_FRAME_BYTES, 1);
    expect(() => guard.admit(excess)).toThrow("wire admission");
    expect(fail).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ code: "wire_admission" }),
    );
    expect(guard.admit(frame("Z"))).toBe(false);
  });
  it.each([0, 1, 2, 3, 0xffffffff])("rejects an invalid backend length %s", (length) => {
    const guard = new PolicyWireAdmission();
    const header = Buffer.alloc(5);
    header[0] = 68;
    header.writeUInt32BE(length, 1);
    guard.begin(false, vi.fn());
    expect(() => guard.admit(header)).toThrow("wire admission");
  });
  it("bounds row collection before an excess DataRow header is decoded", () => {
    const guard = new PolicyWireAdmission();
    guard.begin(false, vi.fn());
    const rows = Buffer.concat(
      Array.from({ length: POLICY_WIRE_TRANSACTION_ROWS }, () => frame("D")),
    );
    expect(guard.admit(rows)).toBe(true);
    expect(() => guard.admit(frame("D"))).toThrow("wire admission");
  });
  it("shares cumulative protocol byte admission across frames and rejects one byte over", () => {
    const guard = new PolicyWireAdmission();
    guard.begin(false, vi.fn());
    const block = frame("D", Buffer.alloc(POLICY_WIRE_FRAME_BYTES - 5));
    for (let total = 0; total < POLICY_WIRE_TRANSACTION_BYTES; total += block.byteLength)
      expect(guard.admit(block)).toBe(true);
    expect(guard.usage().receivedProtocolBytes).toBe(POLICY_WIRE_TRANSACTION_BYTES);
    expect(() => guard.admit(Buffer.from([90]))).toThrow("wire admission");
    expect(guard.usage().receivedProtocolBytes).toBe(POLICY_WIRE_TRANSACTION_BYTES + 1);
  });
  it.each(["header", "body"])("cannot reset a partial %s into a new transaction", (kind) => {
    const guard = new PolicyWireAdmission();
    guard.begin(false, vi.fn());
    const value = frame("D", Buffer.from("body"));
    guard.admit(value.subarray(0, kind === "header" ? 2 : 6));
    guard.finish();
    expect(() => guard.begin(false, vi.fn())).toThrow("wire admission");
  });
  it("has a separate finite recovery ceiling and returns to bounded idle traffic", () => {
    const guard = new PolicyWireAdmission();
    guard.begin(true, vi.fn());
    const block = frame("D", Buffer.alloc(POLICY_WIRE_FRAME_BYTES - 5));
    for (let total = 0; total < POLICY_WIRE_RECOVERY_BYTES; total += block.byteLength)
      guard.admit(block);
    expect(() => guard.admit(Buffer.from([90]))).toThrow("wire admission");
    const idle = new PolicyWireAdmission();
    idle.begin(false, vi.fn());
    idle.admit(frame("Z"));
    idle.finish();
    idle.admit(block);
    expect(() => idle.admit(Buffer.from([90]))).toThrow("wire admission");
  });
});
