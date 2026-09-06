import type {
  PrincipalContext,
  PublishReleaseCandidateRequest,
  ReleaseCandidate,
} from "@proofstack/contracts";
import { describe, expect, it, vi } from "vitest";
import { ForbiddenError } from "../errors.js";
import { MemoryReleaseCandidateRepository } from "../testing/memory-release-candidate-repository.js";
import {
  releaseCandidateFixture,
  releaseCandidateFixtureScope,
} from "../testing/release-candidate-repository-fixtures.js";
import {
  InvalidReleaseCandidateCommandError,
  ReleaseCandidateLineageError,
  ReleaseCandidateNotFoundError,
  ReleaseCandidateRepositoryContractError,
  ReleaseCandidateSourceUnavailableError,
  ReleaseCandidateVersionConflictError,
} from "./release-candidate-errors.js";
import type { ReleaseCandidateRepository } from "./release-candidate-repository.js";
import {
  PublishReleaseCandidate,
  ReadReleaseCandidate,
  type ReleaseCandidateSourceResolver,
} from "./record-release-candidate.js";

function principal(capabilities: PrincipalContext["capabilities"]): PrincipalContext {
  return {
    authentication: { authenticatedAt: "2026-09-06T16:00:00.000Z", method: "development" },
    capabilities,
    principalId: "principal_release_manager",
    principalType: "user",
    requestId: "request_release_candidate_test",
    resourceScope: { mode: "tenant" },
    roles: ["admin"],
    tenantId: "ten_publisher",
  };
}

function publishInput(candidate: ReleaseCandidate): PublishReleaseCandidateRequest {
  const request = structuredClone(candidate) as unknown as Record<string, unknown>;
  for (const key of [
    "candidateId",
    "createdAt",
    "createdByPrincipalId",
    "definitionSha256",
    "schemaVersion",
    "scope",
    "predecessor",
  ] as const) {
    Reflect.deleteProperty(request, key);
  }
  if (candidate.predecessor) {
    Reflect.set(request, "predecessorVersionId", candidate.predecessor.candidateVersionId);
  }
  return request as PublishReleaseCandidateRequest;
}

function setup(namespace: string) {
  const scope = releaseCandidateFixtureScope(namespace);
  const candidate = releaseCandidateFixture(namespace, scope);
  const repository = new MemoryReleaseCandidateRepository();
  const isAvailable = vi.fn<ReleaseCandidateSourceResolver["isAvailable"]>(async () => true);
  const now = vi.fn(() => new Date("2026-09-06T16:00:01.000Z"));
  const publisher = new PublishReleaseCandidate({
    clock: { now },
    repository,
    sourceResolver: { isAvailable },
  });
  const command = {
    candidateId: candidate.candidateId,
    candidateVersionId: candidate.candidateVersionId,
    environmentId: scope.environmentId,
    input: publishInput(candidate),
    principal: { ...principal(["release:manage", "release:read"]), tenantId: scope.tenantId },
    projectId: scope.projectId,
  };
  return { candidate, command, isAvailable, now, publisher, repository, scope };
}

describe("release candidate use cases", () => {
  it("publishes one server-authored candidate only after resolving every exact source", async () => {
    const value = setup("publisher_happy");
    const result = await value.publisher.execute(value.command);
    expect(result.created).toBe(true);
    expect(result.candidate).toMatchObject({
      candidateId: value.candidate.candidateId,
      candidateVersionId: value.candidate.candidateVersionId,
      createdAt: "2026-09-06T16:00:01.000Z",
      createdByPrincipalId: "principal_release_manager",
      scope: value.scope,
    });
    expect(result.candidate.definitionSha256).toHaveLength(64);
    expect(value.isAvailable).toHaveBeenCalledTimes(13);
    expect(value.isAvailable.mock.calls.map(([, reference]) => reference.kind)).toEqual([
      "source_revision",
      "build_artifact",
      "build_artifact",
      "dataset_version",
      "assessment",
      "model_assurance_assessment",
      "comparison_result",
      "model_declaration",
      "runtime_adapter",
      "model_resolution_evidence",
      "prompt",
      "tool_contract",
      "target_release",
    ]);
    expect(
      await value.repository.findReleaseCandidate(value.scope, value.candidate.candidateVersionId),
    ).toEqual(result.candidate);
  });

  it("returns an exact retry without re-resolving sources or rewriting receipt metadata", async () => {
    const value = setup("publisher_retry");
    const first = await value.publisher.execute(value.command);
    value.now.mockReturnValue(new Date("2026-09-06T17:00:00.000Z"));
    value.isAvailable.mockRejectedValue(new Error("resolver is now unavailable"));
    const retry = await value.publisher.execute(value.command);
    expect(retry).toEqual({ candidate: first.candidate, created: false });
    expect(value.isAvailable).toHaveBeenCalledTimes(13);
    expect(value.now).toHaveBeenCalledTimes(1);

    const changedInput = structuredClone(value.command);
    changedInput.input.target.purpose = "Different immutable semantics.";
    await expect(value.publisher.execute(changedInput)).rejects.toBeInstanceOf(
      ReleaseCandidateVersionConflictError,
    );
    expect(value.isAvailable).toHaveBeenCalledTimes(13);
  });

  it("resolves the exact predecessor and rejects missing or cross-candidate lineage", async () => {
    const value = setup("publisher_lineage");
    const root = await value.publisher.execute(value.command);
    const successorFixture = releaseCandidateFixture("publisher_lineage", value.scope, {
      predecessor: {
        candidateId: root.candidate.candidateId,
        candidateVersionId: root.candidate.candidateVersionId,
        definitionSha256: root.candidate.definitionSha256,
      },
      version: "v2",
    });
    const successor = await value.publisher.execute({
      ...value.command,
      candidateVersionId: successorFixture.candidateVersionId,
      input: publishInput(successorFixture),
    });
    expect(successor.candidate.predecessor).toEqual({
      candidateId: root.candidate.candidateId,
      candidateVersionId: root.candidate.candidateVersionId,
      definitionSha256: root.candidate.definitionSha256,
    });

    const missingInput = publishInput(successorFixture);
    missingInput.predecessorVersionId = "candidate_missing_v1";
    await expect(
      value.publisher.execute({
        ...value.command,
        candidateVersionId: "candidate_publisher_lineage_v3",
        input: { ...missingInput, candidateVersionId: "candidate_publisher_lineage_v3" },
      }),
    ).rejects.toBeInstanceOf(ReleaseCandidateLineageError);
  });

  it("fails closed on an unavailable or failing source before timestamping or storage", async () => {
    const unavailable = setup("publisher_unavailable");
    unavailable.isAvailable.mockImplementation(
      async (_scope, reference) => reference.kind !== "comparison_result",
    );
    await expect(unavailable.publisher.execute(unavailable.command)).rejects.toMatchObject({
      code: "release_candidate_source_unavailable",
      sourceId: "comparison_candidate",
      sourceKind: "comparison_result",
    });
    expect(unavailable.now).not.toHaveBeenCalled();
    expect(
      await unavailable.repository.findReleaseCandidate(
        unavailable.scope,
        unavailable.candidate.candidateVersionId,
      ),
    ).toBeNull();

    const failing = setup("publisher_failing_source");
    failing.isAvailable.mockRejectedValueOnce(new Error("source backend failed"));
    await expect(failing.publisher.execute(failing.command)).rejects.toBeInstanceOf(
      ReleaseCandidateSourceUnavailableError,
    );
    expect(failing.now).not.toHaveBeenCalled();

    const malformed = setup("publisher_malformed_source_result");
    malformed.isAvailable.mockResolvedValue("true" as never);
    await expect(malformed.publisher.execute(malformed.command)).rejects.toBeInstanceOf(
      ReleaseCandidateSourceUnavailableError,
    );
    expect(malformed.now).not.toHaveBeenCalled();
  });

  it("checks authority before parsing input or touching dependencies", async () => {
    const findReleaseCandidate = vi.fn<ReleaseCandidateRepository["findReleaseCandidate"]>();
    const publishReleaseCandidate = vi.fn<ReleaseCandidateRepository["publishReleaseCandidate"]>();
    const isAvailable = vi.fn<ReleaseCandidateSourceResolver["isAvailable"]>();
    const now = vi.fn(() => new Date());
    const publisher = new PublishReleaseCandidate({
      clock: { now },
      repository: { findReleaseCandidate, publishReleaseCandidate },
      sourceResolver: { isAvailable },
    });
    await expect(
      publisher.execute({
        candidateId: "candidate_forbidden",
        candidateVersionId: "candidate_forbidden_v1",
        environmentId: "env_forbidden",
        input: { deploymentToken: "secret" },
        principal: principal(["release:read"]),
        projectId: "project_forbidden",
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(findReleaseCandidate).not.toHaveBeenCalled();
    expect(publishReleaseCandidate).not.toHaveBeenCalled();
    expect(isAvailable).not.toHaveBeenCalled();
    expect(now).not.toHaveBeenCalled();
  });

  it("rejects route mismatch and invalid repository output", async () => {
    const mismatch = setup("publisher_mismatch");
    await expect(
      mismatch.publisher.execute({
        ...mismatch.command,
        candidateVersionId: "candidate_different_v1",
      }),
    ).rejects.toBeInstanceOf(InvalidReleaseCandidateCommandError);
    expect(mismatch.isAvailable).not.toHaveBeenCalled();

    const wrongScopeCandidate = {
      ...mismatch.candidate,
      scope: { ...mismatch.candidate.scope, environmentId: "env_other" },
    };
    const publisher = new PublishReleaseCandidate({
      clock: { now: () => new Date() },
      repository: {
        findReleaseCandidate: async () => wrongScopeCandidate,
        publishReleaseCandidate: async (candidate) => ({ candidate, created: true }),
      },
      sourceResolver: { isAvailable: async () => true },
    });
    await expect(publisher.execute(mismatch.command)).rejects.toBeInstanceOf(
      ReleaseCandidateRepositoryContractError,
    );
  });

  it("rejects malformed identities, routes, and request bodies without resolving sources", async () => {
    const value = setup("publisher_invalid_commands");
    await expect(
      value.publisher.execute({
        ...value.command,
        principal: { ...value.command.principal, tenantId: "" },
      }),
    ).rejects.toBeInstanceOf(InvalidReleaseCandidateCommandError);
    await expect(
      value.publisher.execute({ ...value.command, environmentId: "" }),
    ).rejects.toBeInstanceOf(InvalidReleaseCandidateCommandError);
    await expect(
      value.publisher.execute({ ...value.command, candidateId: "" }),
    ).rejects.toBeInstanceOf(InvalidReleaseCandidateCommandError);
    await expect(
      value.publisher.execute({ ...value.command, candidateVersionId: "" }),
    ).rejects.toBeInstanceOf(InvalidReleaseCandidateCommandError);
    await expect(value.publisher.execute({ ...value.command, input: {} })).rejects.toBeInstanceOf(
      InvalidReleaseCandidateCommandError,
    );
    expect(value.isAvailable).not.toHaveBeenCalled();
    expect(value.now).not.toHaveBeenCalled();
  });

  it("fails closed when server time or publication output is not trustworthy", async () => {
    const invalidClock = setup("publisher_invalid_clock");
    invalidClock.now.mockImplementation(() => {
      throw new Error("clock failed");
    });
    await expect(invalidClock.publisher.execute(invalidClock.command)).rejects.toBeInstanceOf(
      InvalidReleaseCandidateCommandError,
    );
    expect(
      await invalidClock.repository.findReleaseCandidate(
        invalidClock.scope,
        invalidClock.candidate.candidateVersionId,
      ),
    ).toBeNull();

    const malformedResult = setup("publisher_malformed_result");
    const publisher = new PublishReleaseCandidate({
      clock: { now: malformedResult.now },
      repository: {
        findReleaseCandidate: async () => null,
        publishReleaseCandidate: async () => null as never,
      },
      sourceResolver: { isAvailable: malformedResult.isAvailable },
    });
    await expect(publisher.execute(malformedResult.command)).rejects.toBeInstanceOf(
      ReleaseCandidateRepositoryContractError,
    );
  });

  it("reads exact candidates with independent read authority and hides absence", async () => {
    const value = setup("publisher_read");
    const published = await value.publisher.execute(value.command);
    const reader = new ReadReleaseCandidate(value.repository);
    const readCommand = {
      candidateId: published.candidate.candidateId,
      candidateVersionId: published.candidate.candidateVersionId,
      environmentId: value.scope.environmentId,
      principal: { ...principal(["release:read"]), tenantId: value.scope.tenantId },
      projectId: value.scope.projectId,
    };
    expect(await reader.execute(readCommand)).toEqual(published.candidate);
    await expect(
      reader.execute({ ...readCommand, candidateVersionId: "candidate_absent_v1" }),
    ).rejects.toBeInstanceOf(ReleaseCandidateNotFoundError);
    await expect(
      reader.execute({ ...readCommand, principal: { ...readCommand.principal, capabilities: [] } }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(reader.execute({ ...readCommand, candidateVersionId: "" })).rejects.toBeInstanceOf(
      InvalidReleaseCandidateCommandError,
    );
    await expect(reader.execute({ ...readCommand, candidateId: "" })).rejects.toBeInstanceOf(
      InvalidReleaseCandidateCommandError,
    );
    await expect(
      reader.execute({ ...readCommand, candidateId: "candidate_wrong_identity" }),
    ).rejects.toBeInstanceOf(ReleaseCandidateNotFoundError);
  });
});
