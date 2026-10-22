import { describe, expect, it } from "vitest";
import { MemoryReleaseCandidateRepository } from "./memory-release-candidate-repository.js";
import {
  releaseCandidateLogicalRootConformanceCases,
  releaseCandidateRepositoryConformanceCases,
} from "./release-candidate-repository-conformance.js";
import { createReleaseCandidateRepositoryTestHarness } from "./release-candidate-repository-fixtures.js";

describe("MemoryReleaseCandidateRepository conformance", () => {
  it("keeps tentative versions and logical roots independent through abandoned branches", async () => {
    const f = createReleaseCandidateRepositoryTestHarness("fork_candidate"),
      original = new MemoryReleaseCandidateRepository();
    await original.publishReleaseCandidate(f.candidate);
    const next = original.fork();
    await next.publishReleaseCandidate(f.successor);
    expect(await original.findReleaseCandidate(f.scope, f.successor.candidateVersionId)).toBeNull();
    expect(
      await next.findReleaseCandidateLogicalRoot(f.scope, f.successor.candidateVersionId),
    ).toEqual(f.candidate);
    const branch = next.fork();
    const state = (
      branch as unknown as {
        tenants: Map<
          string,
          { records: Map<string, typeof f.candidate>; resources: Map<string, typeof f.candidate> }
        >;
      }
    ).tenants.get(f.scope.tenantId);
    if (!state) throw new Error("Missing tentative candidate state");
    const record = state.records.get(f.candidate.candidateVersionId);
    if (!record) throw new Error("Missing candidate root");
    record.target.purpose = "Owner-only abandoned branch corruption.";
    state.resources.clear();
    await expect(
      branch.findReleaseCandidateLogicalRoot(f.scope, f.successor.candidateVersionId),
    ).rejects.toBeDefined();
    expect(
      await next.findReleaseCandidateLogicalRoot(f.scope, f.successor.candidateVersionId),
    ).toEqual(f.candidate);
    expect(await original.findReleaseCandidate(f.scope, f.candidate.candidateVersionId)).toEqual(
      f.candidate,
    );
  });
  for (const conformanceCase of [
    ...releaseCandidateRepositoryConformanceCases,
    ...releaseCandidateLogicalRootConformanceCases,
  ]) {
    it(conformanceCase.name, async () => {
      await conformanceCase.run((namespace) => ({
        ...createReleaseCandidateRepositoryTestHarness(namespace),
        repository: new MemoryReleaseCandidateRepository(),
      }));
    });
  }
});
