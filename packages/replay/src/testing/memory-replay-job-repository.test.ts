import type { EvidenceScope, ReplayPlan, TargetRelease } from "@proofstack/contracts";
import { describe, it } from "vitest";
import type { ReplayDefinitionRepository } from "../replay-definition-repository.js";
import { MemoryReplayDefinitionRepository } from "./memory-replay-definition-repository.js";
import { MemoryReplayJobRepository } from "./memory-replay-job-repository.js";
import { replayJobRepositoryConformanceCases } from "./replay-job-repository-conformance.js";

type DefinitionKind = "replay_plan" | "target_release";

class MaskingReplayDefinitionRepository implements ReplayDefinitionRepository {
  private hiddenKind: DefinitionKind | null = null;

  constructor(private readonly inner: ReplayDefinitionRepository) {}

  async findReplayPlan(scope: EvidenceScope, planVersionId: string): Promise<ReplayPlan | null> {
    if (this.consume("replay_plan")) return null;
    return this.inner.findReplayPlan(scope, planVersionId);
  }

  async findTargetRelease(
    scope: EvidenceScope,
    targetReleaseId: string,
  ): Promise<TargetRelease | null> {
    if (this.consume("target_release")) return null;
    return this.inner.findTargetRelease(scope, targetReleaseId);
  }

  hideNextLookup(kind: DefinitionKind): void {
    this.hiddenKind = kind;
  }

  publishReplayPlan(candidate: ReplayPlan) {
    return this.inner.publishReplayPlan(candidate);
  }

  publishTargetRelease(candidate: TargetRelease) {
    return this.inner.publishTargetRelease(candidate);
  }

  private consume(kind: DefinitionKind): boolean {
    if (this.hiddenKind !== kind) return false;
    this.hiddenKind = null;
    return true;
  }
}

describe("MemoryReplayJobRepository conformance", () => {
  for (const testCase of replayJobRepositoryConformanceCases) {
    it(testCase.name, async () => {
      await testCase.run(() => {
        let now = "2026-08-29T12:00:01.000Z";
        const definitions = new MaskingReplayDefinitionRepository(
          new MemoryReplayDefinitionRepository(),
        );
        const repository = new MemoryReplayJobRepository({ definitions, now: () => now });
        return {
          definitions,
          failNextIntent: (kind) => repository.failNextIntent(kind),
          hideNextDefinitionLookup: (kind) => definitions.hideNextLookup(kind),
          publishedIntents: (tenantId) => repository.publishedIntents(tenantId),
          removeIntent: (kind, tenantId, jobId) => repository.removeIntent(kind, tenantId, jobId),
          repository,
          setNow: (value) => {
            now = value;
          },
        };
      });
    });
  }
});
