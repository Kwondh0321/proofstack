import { describe, expect, it } from "vitest";
import { ReplayRepositoryContractError } from "../errors.js";
import { MemoryReplayDefinitionRepository } from "./memory-replay-definition-repository.js";
import { replayDefinitionRepositoryConformanceCases } from "./replay-definition-repository-conformance.js";

describe("MemoryReplayDefinitionRepository conformance", () => {
  for (const testCase of replayDefinitionRepositoryConformanceCases) {
    it(testCase.name, async () => {
      await testCase.run(() => {
        const repository = new MemoryReplayDefinitionRepository();
        return {
          failNextPublicationIntent: (kind) => repository.failNextPublicationIntent(kind),
          publishedIntents: (tenantId) => repository.publishedIntents(tenantId),
          removePublicationIntent: (kind, tenantId, aggregateId) =>
            repository.removePublicationIntent(kind, tenantId, aggregateId),
          repository,
        };
      });
    });
  }
});

describe("MemoryReplayDefinitionRepository internal integrity", () => {
  it("treats removal from an absent test namespace as a no-op", () => {
    const repository = new MemoryReplayDefinitionRepository();
    expect(() =>
      repository.removePublicationIntent("target_release", "ten_absent", "trg_absent"),
    ).not.toThrow();
  });

  it("exposes repository contract failures as a stable error", () => {
    expect(new ReplayRepositoryContractError("missing intent")).toMatchObject({
      code: "replay_repository_contract_violation",
      name: "ReplayRepositoryContractError",
    });
  });
});
