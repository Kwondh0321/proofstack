import { readFileSync } from "node:fs";
import type {
  ComparisonDefinitionInput,
  ComparisonEvidenceSnapshotDefinition,
} from "@proofstack/contracts";

interface StoredVector<Definition> {
  readonly input: { readonly definition: Definition };
}

function vector<Definition>(filename: string): Definition {
  const document = JSON.parse(
    readFileSync(
      new URL(`../../../packages/contracts/vectors/${filename}`, import.meta.url),
      "utf8",
    ),
  ) as { readonly vectors: readonly StoredVector<Definition>[] };
  const first = document.vectors[0];
  /* v8 ignore next -- Checked-in contract vectors are required build inputs and are never empty. */
  if (!first) throw new TypeError(`Missing ${filename}`);
  return structuredClone(first.input.definition);
}

export function comparisonDefinitionTemplate(): ComparisonDefinitionInput {
  return vector<ComparisonDefinitionInput>("evaluation-comparison-definition-v1.json");
}

export function comparisonSnapshotTemplate(): ComparisonEvidenceSnapshotDefinition {
  return vector<ComparisonEvidenceSnapshotDefinition>(
    "evaluation-comparison-snapshot-definition-v1.json",
  );
}
