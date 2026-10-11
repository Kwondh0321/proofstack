import { describe, it } from "vitest";
import { evaluationLogicalRootConformanceCases } from "./evaluation-logical-root-conformance.js";
import { evaluationRepositoryConformanceCases } from "./evaluation-repository-conformance.js";
import { createEvaluationRepositoryTestHarness } from "./evaluation-repository-fixtures.js";
import { MemoryEvaluationRepository } from "./memory-evaluation-repository.js";

describe("MemoryEvaluationRepository conformance", () => {
  for (const conformanceCase of evaluationLogicalRootConformanceCases) {
    it(conformanceCase.name, async () => {
      await conformanceCase.run((namespace) => ({
        ...createEvaluationRepositoryTestHarness(namespace),
        repository: new MemoryEvaluationRepository(),
      }));
    });
  }
  for (const conformanceCase of evaluationRepositoryConformanceCases) {
    it(conformanceCase.name, async () => {
      await conformanceCase.run(createEvaluationRepositoryTestHarness);
    });
  }
});
