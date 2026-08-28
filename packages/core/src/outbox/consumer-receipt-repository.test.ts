import { describe, expect, it } from "vitest";
import { ConsumerReceiptConflictError } from "./consumer-receipt-repository.js";

describe("ConsumerReceiptConflictError", () => {
  it("identifies the receipt whose payload identity conflicted", () => {
    const error = new ConsumerReceiptConflictError("trace.projector", "message-001");

    expect(error).toMatchObject({
      consumerName: "trace.projector",
      message: "Consumer receipt trace.projector/message-001 is bound to a different payload",
      messageId: "message-001",
      name: "ConsumerReceiptConflictError",
    });
  });
});
