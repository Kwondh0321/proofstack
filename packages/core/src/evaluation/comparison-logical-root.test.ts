import { describe, expect, it } from "vitest";
import { requireComparisonLogicalRootKind } from "./comparison-logical-root.js";
import { InvalidComparisonRecordInputError } from "./comparison-repository-errors.js";

describe("comparison logical-root kind admission", () => {
  it.each(["comparison_definition", "comparison_evidence_snapshot", "comparison_result"])(
    "admits the fixed owning record kind %s",
    (kind) => expect(requireComparisonLogicalRootKind(kind)).toBe(kind),
  );
  it.each([
    "comparison_snapshot",
    "release_candidate",
    "__proto__",
    "constructor",
    "",
    null,
    undefined,
    1,
    {},
  ])("rejects unsupported or malformed runtime kinds %j", (kind) =>
    expect(() => requireComparisonLogicalRootKind(kind)).toThrow(InvalidComparisonRecordInputError),
  );
});
