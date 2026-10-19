import { describe, expect, it } from "vitest";
import { releasePolicyRepositoryConformanceCases } from "./release-policy-repository-conformance.js";
import { createReleasePolicyRepositoryTestHarness } from "./release-policy-repository-fixtures.js";
import { MemoryReleasePolicyRepository } from "./memory-release-policy-repository.js";
import { releasePolicyLogicalRootConformanceCases } from "./release-policy-logical-root-conformance.js";

describe("MemoryReleasePolicyRepository conformance", () => {
  it("keeps tentative policy and lifecycle changes independent in both fork directions", async () => {
    const { policy, withdrawal, scope } = createReleasePolicyRepositoryTestHarness("fork");
    const original = new MemoryReleasePolicyRepository();
    await original.publishReleasePolicy(policy);
    const fork = original.fork();
    await fork.publishReleasePolicyLifecycleEvent(withdrawal);
    expect(await original.listReleasePolicyLifecycleEvents(scope, policy.policyVersionId)).toEqual(
      [],
    );
    expect(await fork.listReleasePolicyLifecycleEvents(scope, policy.policyVersionId)).toEqual([
      withdrawal,
    ]);
    const empty = new MemoryReleasePolicyRepository();
    const tentative = empty.fork();
    await empty.publishReleasePolicy(policy);
    expect(await tentative.findReleasePolicy(scope, policy.policyVersionId)).toBeNull();
    expect(await fork.findReleasePolicyLogicalRoot(scope, policy.policyVersionId)).toEqual(policy);
  });
  for (const conformanceCase of releasePolicyLogicalRootConformanceCases) {
    it(conformanceCase.name, async () => {
      await conformanceCase.run((namespace) => ({
        ...createReleasePolicyRepositoryTestHarness(namespace),
        repository: new MemoryReleasePolicyRepository(),
      }));
    });
  }
  for (const conformanceCase of releasePolicyRepositoryConformanceCases) {
    it(conformanceCase.name, async () => {
      await conformanceCase.run(createReleasePolicyRepositoryTestHarness);
    });
  }
});
