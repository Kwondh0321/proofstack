import { describe, expect, it } from "vitest";
import {
  JsonValueSchema,
  MAX_JSON_ARRAY_ITEMS,
  MAX_JSON_DEPTH,
  MAX_JSON_NODES,
  MAX_JSON_OBJECT_KEY_LENGTH,
  MAX_JSON_OBJECT_KEYS,
} from "./primitives.js";

describe("JsonValueSchema", () => {
  it("accepts shared but non-circular objects", () => {
    const shared = { value: 1 };

    expect(JsonValueSchema.safeParse([shared, shared]).success).toBe(true);
  });

  it("rejects circular and excessively deep values without recursion overflow", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    let nested: unknown = "leaf";
    for (let depth = 0; depth <= MAX_JSON_DEPTH; depth += 1) nested = { child: nested };

    expect(JsonValueSchema.safeParse(circular).success).toBe(false);
    expect(JsonValueSchema.safeParse(nested).success).toBe(false);
  });

  it("bounds arrays, objects, and object keys", () => {
    const array = Array.from({ length: MAX_JSON_ARRAY_ITEMS + 1 }, () => null);
    const object = Object.fromEntries(
      Array.from({ length: MAX_JSON_OBJECT_KEYS + 1 }, (_, index) => [`key_${index}`, null]),
    );
    const longKey = "k".repeat(MAX_JSON_OBJECT_KEY_LENGTH + 1);

    expect(JsonValueSchema.safeParse(array).success).toBe(false);
    expect(JsonValueSchema.safeParse(object).success).toBe(false);
    expect(JsonValueSchema.safeParse({ [longKey]: null }).success).toBe(false);
  });

  it("bounds total traversal work", () => {
    const values = Array.from({ length: Math.ceil(MAX_JSON_NODES / MAX_JSON_ARRAY_ITEMS) }, () =>
      Array.from({ length: MAX_JSON_ARRAY_ITEMS }, () => null),
    );

    expect(JsonValueSchema.safeParse(values).success).toBe(false);
  });
});
