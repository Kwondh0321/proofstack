import { z } from "zod";

export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export type JsonObject = { readonly [key: string]: JsonValue };

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

export const OpaqueIdSchema = z.string().regex(/^[a-z][a-z0-9_]{2,63}$/);
export const TraceIdSchema = z.string().regex(/^(?!0{32}$)[0-9a-f]{32}$/);
export const SpanIdSchema = z.string().regex(/^(?!0{16}$)[0-9a-f]{16}$/);
export const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
export const TimestampSchema = z.iso.datetime({ offset: true });
export const NamespacedExtensionKeySchema = z.string().regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)+$/);
