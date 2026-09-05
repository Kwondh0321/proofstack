import { OpaqueIdSchema } from "@proofstack/contracts";

export type ComparisonLookup =
  | { readonly status: "empty" }
  | { readonly status: "invalid"; readonly value: string }
  | { readonly resultId: string; readonly status: "valid" };

export function parseComparisonLookup(value: string | undefined): ComparisonLookup {
  if (value === undefined) return { status: "empty" };

  const normalized = value.trim();
  const parsed = OpaqueIdSchema.safeParse(normalized);
  if (!parsed.success) return { status: "invalid", value: normalized };
  return { resultId: parsed.data, status: "valid" };
}
