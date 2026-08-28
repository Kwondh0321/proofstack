import { TraceIdSchema } from "@proofstack/contracts";

export type TraceLookup =
  | { readonly status: "empty" }
  | { readonly status: "invalid"; readonly value: string }
  | { readonly status: "valid"; readonly traceId: string };

export function parseTraceLookup(value: string | undefined): TraceLookup {
  if (value === undefined) return { status: "empty" };

  const normalized = value.trim();
  const parsed = TraceIdSchema.safeParse(normalized);
  if (!parsed.success) return { status: "invalid", value: normalized };
  return { status: "valid", traceId: parsed.data };
}
