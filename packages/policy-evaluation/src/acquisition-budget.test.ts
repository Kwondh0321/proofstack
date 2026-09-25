import { PolicyEvaluationExecutionLimitsSchema } from "@proofstack/contracts";
import { describe, expect, it, vi } from "vitest";
import { AcquisitionBudget, PolicyRecordGraphError } from "./acquisition-budget.js";

const limits = PolicyEvaluationExecutionLimitsSchema.parse({
  heartbeatIntervalMilliseconds: 1000,
  leaseDurationMilliseconds: 3000,
  maxAcquisitionRecordBytes: 1024 * 1024,
  maxAcquisitionRecords: 1000,
  maxArtifactReadBytes: 0,
  maxAttempts: 1,
  maxRuleEvaluations: 1,
  perAttemptTimeoutMilliseconds: 10000,
  retryBackoffMilliseconds: 0,
  retryableErrors: [],
  totalDeadlineMilliseconds: 10000,
});

describe("record acquisition budget", () => {
  it("reserves exact trace rows before I/O, including absent observations", async () => {
    const budget = new AcquisitionBudget({ ...limits, maxAcquisitionRecords: 4 });
    const resolveExactEvents = vi.fn(async (_scope, _trace, _ids) => null);
    const port = budget.wrap({ resolveExactEvents });
    await port.resolveExactEvents({}, "trace", ["one", "two"]);
    expect(budget.usage()).toMatchObject({ records: 3, reads: 1, bytes: 4 });
    await expect(port.resolveExactEvents({}, "trace", ["one"])).rejects.toMatchObject({
      reason: "record_limit",
    });
    expect(resolveExactEvents).toHaveBeenCalledTimes(1);
  });

  it("charges oversized trace responses instead of trusting the requested row count", async () => {
    const budget = new AcquisitionBudget({ ...limits, maxAcquisitionRecords: 3 });
    const port = budget.wrap({
      async resolveExactEvents(_scope: unknown, _trace: string, _ids: string[]) {
        return [{}, {}, {}];
      },
    });
    await expect(port.resolveExactEvents({}, "trace", ["one"])).rejects.toMatchObject({
      reason: "record_limit",
    });
  });

  it("charges every exact trace row and its full response bytes", async () => {
    const budget = new AcquisitionBudget(limits);
    const rows = [{ id: "one" }, { id: "two" }];
    const port = budget.wrap({
      async resolveExactEvents(_scope: unknown, _trace: string, _ids: string[]) {
        return rows;
      },
    });
    await port.resolveExactEvents({}, "trace", ["one", "two"]);
    expect(budget.usage()).toMatchObject({
      records: 3,
      reads: 1,
      bytes: Buffer.byteLength(JSON.stringify(rows)),
    });
  });
  it.each([
    null,
    undefined,
    true,
    false,
    0,
    -0,
    1.25,
    '한글 🧪\n"\\\ud800',
    [],
    [undefined, 1, true],
    { a: undefined, b: null, c: ["한글", 2] },
  ])("matches JSON response bytes for %j", async (value) => {
    const budget = new AcquisitionBudget(limits);
    const source = {
      async find() {
        return value;
      },
    };
    expect(await budget.wrap(source).find()).toEqual(value);
    expect(budget.usage()).toEqual({
      reads: 1,
      records: 1,
      bytes: value === undefined ? 0 : Buffer.byteLength(JSON.stringify(value)),
      references: 0,
      referenceBytes: 0,
    });
  });

  it("preserves the method receiver and copies results without exposing mutable stored data", async () => {
    const budget = new AcquisitionBudget(limits);
    const source = {
      value: { nested: { value: "before" } },
      async find() {
        return this.value;
      },
    };
    const port = budget.wrap(source);
    const result = await port.find();
    result.nested.value = "after";
    expect(source.value.nested.value).toBe("before");
    expect(port.value).toBe(source.value);
  });

  it("counts actual null reads and rejects the next read before invoking storage", async () => {
    const budget = new AcquisitionBudget({ ...limits, maxAcquisitionRecords: 2 });
    const find = vi.fn(async () => null);
    const port = budget.wrap({ find });
    await port.find();
    await port.find();
    await expect(port.find()).rejects.toMatchObject({ reason: "record_limit" });
    expect(find).toHaveBeenCalledTimes(2);
    expect(budget.usage().records).toBe(2);
  });

  it("charges retained replay rows including cancellation and failed histories", async () => {
    const snapshot = {
      job: {},
      attempts: [{}, {}],
      budgetLedger: [{}],
      cancellationRequest: {},
      cancellationAcknowledgements: [{}],
      executionObservations: [{}, {}],
      usageObservations: [{}],
    };
    const budget = new AcquisitionBudget({ ...limits, maxAcquisitionRecords: 9 });
    await budget
      .wrap({
        async findJob() {
          return snapshot;
        },
      })
      .findJob();
    expect(budget.usage().records).toBe(9);
    const tooSmall = new AcquisitionBudget({ ...limits, maxAcquisitionRecords: 8 });
    await expect(
      tooSmall
        .wrap({
          async findJob() {
            return snapshot;
          },
        })
        .findJob(),
    ).rejects.toMatchObject({ reason: "record_limit" });
    const empty = new AcquisitionBudget(limits);
    await empty
      .wrap({
        async findJob() {
          return { job: {}, attempts: [], cancellationRequest: undefined };
        },
      })
      .findJob();
    expect(empty.usage().records).toBe(1);
  });

  it("shares the exact byte ceiling between raw responses and reference occurrences", async () => {
    const value = { text: "한글" };
    const bytes = Buffer.byteLength(JSON.stringify(value));
    const budget = new AcquisitionBudget({ ...limits, maxAcquisitionRecordBytes: bytes + 10 });
    budget.addReferences(2, 10);
    await budget
      .wrap({
        async find() {
          return value;
        },
      })
      .find();
    expect(budget.usage()).toMatchObject({ bytes, referenceBytes: 10, references: 2 });
    expect(() => budget.addReferences(1, 1)).toThrowError(
      expect.objectContaining({ reason: "byte_limit" }),
    );
    await expect(
      budget
        .wrap({
          async find() {
            return null;
          },
        })
        .find(),
    ).rejects.toMatchObject({ reason: "byte_limit" });
  });

  it("checks both early string admission and exact escaped UTF-8 bytes", async () => {
    for (const value of ["long ASCII value", "\u0000", "한글"]) {
      const bytes = Buffer.byteLength(JSON.stringify(value));
      const exact = new AcquisitionBudget({ ...limits, maxAcquisitionRecordBytes: bytes });
      await exact
        .wrap({
          async find() {
            return value;
          },
        })
        .find();
      const short = new AcquisitionBudget({ ...limits, maxAcquisitionRecordBytes: bytes - 1 });
      await expect(
        short
          .wrap({
            async find() {
              return value;
            },
          })
          .find(),
      ).rejects.toMatchObject({ reason: "byte_limit" });
    }
  });

  it("counts repeated reference occurrences separately and rejects reference overflow", () => {
    const budget = new AcquisitionBudget({ ...limits, maxAcquisitionRecords: 2 });
    budget.addReferences(2, 100);
    expect(() => budget.addReferences(1, 0)).toThrowError(
      expect.objectContaining({ reason: "reference_limit" }),
    );
  });

  it("charges shared objects per occurrence instead of silently deduplicating bytes", async () => {
    const child = { a: true };
    const value = [child, child];
    const budget = new AcquisitionBudget(limits);
    await budget
      .wrap({
        async find() {
          return value;
        },
      })
      .find();
    expect(budget.usage().bytes).toBe(Buffer.byteLength(JSON.stringify(value)));
  });

  it("rejects unmeasurable values, cycles, sparse arrays, hidden fields, and accessors", async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    const getter = vi.fn(() => "hidden");
    const accessor = Object.defineProperty({}, "value", { enumerable: true, get: getter });
    const hidden = Object.defineProperty({}, "value", { enumerable: false, value: true });
    const sparse = Array(2);
    sparse[1] = true;
    const named = Object.assign([true], { other: true });
    const deep: Record<string, unknown> = {};
    let pointer = deep;
    for (let index = 0; index < 130; index++) {
      const next = {};
      pointer["next"] = next;
      pointer = next;
    }
    for (const value of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      1n,
      Symbol("value"),
      () => 1,
      new Date(),
      new Uint8Array(1),
      cyclic,
      accessor,
      hidden,
      sparse,
      named,
      { [Symbol("hidden")]: true },
      deep,
    ]) {
      const budget = new AcquisitionBudget(limits);
      await expect(
        budget
          .wrap({
            async find() {
              return value;
            },
          })
          .find(),
      ).rejects.toMatchObject({
        code: "policy_record_graph_failed",
        reason: "unmeasurable_record",
      });
    }
    expect(getter).not.toHaveBeenCalled();
  });

  it("accepts null-prototype JSON records", async () => {
    const value = Object.assign(Object.create(null), { a: 1 });
    const budget = new AcquisitionBudget(limits);
    expect(
      await budget
        .wrap({
          async find() {
            return value;
          },
        })
        .find(),
    ).toEqual({ a: 1 });
    expect(budget.usage().bytes).toBe(7);
  });

  it("propagates storage failures and drains a concurrently pending sibling after failure", async () => {
    const budget = new AcquisitionBudget(limits);
    const failure = new Error("storage offline");
    let release!: (value: null) => void;
    const pending = new Promise<null>((resolve) => {
      release = resolve;
    });
    const ports = budget.wrap({
      async first() {
        return pending;
      },
      async second() {
        throw failure;
      },
    });
    const first = ports.first();
    await expect(ports.second()).rejects.toBe(failure);
    let settled = false;
    const drain = budget.settle().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    release(null);
    await first;
    await drain;
    expect(settled).toBe(true);
    expect(budget.usage().reads).toBe(2);
    expect(new PolicyRecordGraphError("reference_conflict").name).toBe("PolicyRecordGraphError");
  });
});
