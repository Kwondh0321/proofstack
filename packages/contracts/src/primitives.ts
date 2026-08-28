import { z } from "zod";

export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export type JsonObject = { readonly [key: string]: JsonValue };

export const MAX_JSON_ARRAY_ITEMS = 256;
export const MAX_JSON_DEPTH = 20;
export const MAX_JSON_NODES = 10_000;
export const MAX_JSON_OBJECT_KEYS = 256;
export const MAX_JSON_OBJECT_KEY_LENGTH = 128;

interface JsonTraversalFrame {
  readonly depth: number;
  readonly leaving?: boolean;
  readonly value: unknown;
}

export function jsonComplexityViolation(value: unknown): string | undefined {
  const activeObjects = new WeakSet<object>();
  const stack: JsonTraversalFrame[] = [{ depth: 0, value }];
  let visitedNodes = 0;

  while (stack.length > 0) {
    const frame = stack.pop();
    if (!frame) break;

    if (frame.leaving) {
      if (typeof frame.value === "object" && frame.value !== null) {
        activeObjects.delete(frame.value);
      }
      continue;
    }

    visitedNodes += 1;
    if (visitedNodes > MAX_JSON_NODES) {
      return `JSON values cannot contain more than ${MAX_JSON_NODES} nodes`;
    }
    if (frame.depth > MAX_JSON_DEPTH) {
      return `JSON values cannot exceed ${MAX_JSON_DEPTH} levels`;
    }
    if (typeof frame.value !== "object" || frame.value === null) continue;
    if (activeObjects.has(frame.value)) return "JSON values must not contain circular references";

    const children = Array.isArray(frame.value) ? frame.value : Object.values(frame.value);
    if (Array.isArray(frame.value) && children.length > MAX_JSON_ARRAY_ITEMS) {
      return `JSON arrays cannot contain more than ${MAX_JSON_ARRAY_ITEMS} items`;
    }
    if (!Array.isArray(frame.value) && children.length > MAX_JSON_OBJECT_KEYS) {
      return `JSON objects cannot contain more than ${MAX_JSON_OBJECT_KEYS} keys`;
    }

    activeObjects.add(frame.value);
    stack.push({ ...frame, leaving: true });
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push({ depth: frame.depth + 1, value: children[index] });
    }
  }

  return undefined;
}

const JsonValueRecursiveSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(JsonValueRecursiveSchema).max(MAX_JSON_ARRAY_ITEMS),
    z
      .record(z.string().min(1).max(MAX_JSON_OBJECT_KEY_LENGTH), JsonValueRecursiveSchema)
      .refine((value) => Object.keys(value).length <= MAX_JSON_OBJECT_KEYS, {
        message: `JSON objects cannot contain more than ${MAX_JSON_OBJECT_KEYS} keys`,
      }),
  ]),
);

export const JsonValueSchema: z.ZodType<JsonValue> = z.preprocess((value, context) => {
  const violation = jsonComplexityViolation(value);
  if (violation) context.addIssue({ code: "custom", message: violation });
  return value;
}, JsonValueRecursiveSchema) as z.ZodType<JsonValue>;

export const OpaqueIdSchema = z.string().regex(/^[a-z][a-z0-9_]{2,63}$/);
export const TraceIdSchema = z.string().regex(/^(?!0{32}$)[0-9a-f]{32}$/);
export const SpanIdSchema = z.string().regex(/^(?!0{16}$)[0-9a-f]{16}$/);
export const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
export const TimestampSchema = z.iso.datetime({ offset: true });
export const NamespacedExtensionKeySchema = z.string().regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)+$/);
