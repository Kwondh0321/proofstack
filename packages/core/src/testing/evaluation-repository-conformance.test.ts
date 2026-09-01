import { describe, it } from "vitest";
import { evaluationRepositoryConformanceCases } from "./evaluation-repository-conformance.js";
import { createEvaluationRepositoryTestHarness } from "./evaluation-repository-fixtures.js";

describe("MemoryEvaluationRepository conformance", () => {
  for (const conformanceCase of evaluationRepositoryConformanceCases) {
    it(conformanceCase.name, async () => {
      await conformanceCase.run(createEvaluationRepositoryTestHarness);
    });
  }
});
