import { createHash } from "node:crypto";
import { encodeEvaluationCanonicalJson } from "@proofstack/contracts";

/** Full canonical material hash only; not a definition domain, authority claim or signature. */
export function hashEvaluationCanonicalJson(value: unknown): string {
  return createHash("sha256").update(encodeEvaluationCanonicalJson(value)).digest("hex");
}
