import type {
  EvidenceScope,
  PublishReleaseCandidateRequest,
  RecordedInteractionFixtureVersion,
  ReleaseCandidate,
  ReleaseCandidateDefinition,
  ReleaseCandidateSource,
  TargetRelease,
} from "@proofstack/contracts";
import type { Workflow1AcceptanceSummary } from "@proofstack/example-workflow-1-acceptance/workflow";
import { digestReleaseCandidateDefinition } from "@proofstack/sdk";
import { describe, expect, it } from "vitest";
import {
  runWorkflow2ReleaseCandidate,
  WORKFLOW_2_REFERENCE_MODEL_ADAPTER,
  WORKFLOW_2_REFERENCE_MODEL_DECLARATION,
} from "./workflow.js";

const scope: EvidenceScope = {
  environmentId: "env_workflow_2_candidate",
  projectId: "prj_workflow_2_candidate",
  tenantId: "ten_workflow_2_candidate",
};
const source: ReleaseCandidateSource = {
  commit: { algorithm: "sha1", value: "1".repeat(40) },
  repositoryUrl: "https://github.com/Kwondh0321/proofstack",
  tree: { algorithm: "sha1", value: "2".repeat(40) },
};
const prompt = {
  artifactId: "art_workflow_2_prompt",
  classification: "confidential" as const,
  mediaType: "text/plain",
  sha256: "3".repeat(64),
  sizeBytes: 128,
};
const toolContract = {
  artifactId: "art_workflow_2_tool_contract",
  classification: "confidential" as const,
  mediaType: "application/json",
  sha256: "4".repeat(64),
  sizeBytes: 256,
};
const provenance = {
  artifactId: "art_workflow_2_provenance",
  classification: "internal" as const,
  mediaType: "application/json",
  sha256: "5".repeat(64),
  sizeBytes: 512,
};

function workflow1(): Workflow1AcceptanceSummary {
  return {
    durableReplay: {
      dataset: {
        datasetId: "dataset_workflow_2",
        datasetVersionId: "dataset_workflow_2_v1",
        definitionSha256: "6".repeat(64),
      },
      fixture: {
        fixtureId: "fixture_workflow_2",
        fixtureVersionId: "fixture_workflow_2_v1",
        definitionSha256: "7".repeat(64),
      },
      targetRelease: {
        targetId: "target_workflow_2",
        targetReleaseId: "target_workflow_2_v1",
        definitionSha256: "8".repeat(64),
      },
    },
    evaluation: {
      assessment: {
        assessmentId: "assessment_workflow_2",
        definitionSha256: "9".repeat(64),
      },
    },
    modelAssurance: {
      assessment: {
        assessmentExtensionId: "model_assessment_workflow_2",
        definitionSha256: "a".repeat(64),
      },
    },
    result: {
      definitionSha256: "b".repeat(64),
      resultId: "comparison_workflow_2",
    },
    scope,
  } as unknown as Workflow1AcceptanceSummary;
}

function fixture(
  artifacts = [
    { contentReference: prompt, role: "prompt.template" },
    { contentReference: toolContract, role: "tool.contract" },
  ],
): RecordedInteractionFixtureVersion {
  return {
    definitionSha256: "7".repeat(64),
    fixtureId: "fixture_workflow_2",
    fixtureVersionId: "fixture_workflow_2_v1",
    interactionCapture: { artifacts },
    scope,
  } as unknown as RecordedInteractionFixtureVersion;
}

function targetRelease(): TargetRelease {
  return {
    build: { provenance },
    definitionSha256: "8".repeat(64),
    scope,
    source: { repositoryUrl: source.repositoryUrl, revision: source.commit.value },
    targetAdapter: {
      name: "proofstack.reference.target",
      protocolVersion: "1.0.0",
      version: "1.0.0",
    },
    targetId: "target_workflow_2",
    targetReleaseId: "target_workflow_2_v1",
    workerProtocol: { name: "proofstack.reference.worker", version: "1.0.0" },
  } as unknown as TargetRelease;
}

interface CandidateHarnessOptions {
  readonly firstCreated?: boolean;
  readonly mutateRead?: (candidate: ReleaseCandidate) => ReleaseCandidate;
  readonly retryCreated?: boolean;
}

function candidateHarness(options: CandidateHarnessOptions = {}) {
  const requests: PublishReleaseCandidateRequest[] = [];
  let candidate: ReleaseCandidate | undefined;
  return {
    client: {
      async publishCandidate(input: {
        readonly candidateId: string;
        readonly request: PublishReleaseCandidateRequest;
      }) {
        requests.push(structuredClone(input.request));
        if (!candidate) {
          const { predecessorVersionId: _predecessorVersionId, ...requestDefinition } =
            input.request;
          const definition: ReleaseCandidateDefinition = {
            ...requestDefinition,
            candidateId: input.candidateId,
          };
          candidate = {
            ...definition,
            createdAt: "2026-09-06T18:00:00.000Z",
            createdByPrincipalId: "usr_workflow_2",
            definitionSha256: await digestReleaseCandidateDefinition(scope, definition),
            schemaVersion: "0.1",
            scope,
          };
          return {
            candidate: structuredClone(candidate),
            created: options.firstCreated ?? true,
            requestId: "req_workflow_2_publish",
          };
        }
        return {
          candidate: structuredClone(candidate),
          created: options.retryCreated ?? false,
          requestId: "req_workflow_2_retry",
        };
      },
      async readCandidate() {
        if (!candidate) throw new Error("Candidate must be published before read-back");
        return {
          candidate: options.mutateRead
            ? options.mutateRead(structuredClone(candidate))
            : structuredClone(candidate),
          requestId: "req_workflow_2_read",
        };
      },
    },
    requests,
  };
}

function options(
  overrides: {
    readonly candidateClient?: ReturnType<typeof candidateHarness>["client"];
    readonly fixture?: RecordedInteractionFixtureVersion;
    readonly source?: ReleaseCandidateSource;
    readonly targetRelease?: TargetRelease;
    readonly workflow1?: Workflow1AcceptanceSummary;
  } = {},
) {
  const harness = candidateHarness();
  return {
    candidateClient: overrides.candidateClient ?? harness.client,
    fixtureReader: {
      readRecordedInteractionFixtureMetadata: async () => ({
        version: overrides.fixture ?? fixture(),
      }),
    },
    namespace: "workflow_2_candidate",
    source: overrides.source ?? source,
    targetReleaseReader: {
      readTargetRelease: async () => ({ release: overrides.targetRelease ?? targetRelease() }),
    },
    workflow1: overrides.workflow1 ?? workflow1(),
  };
}

describe("runWorkflow2ReleaseCandidate", () => {
  it("binds exact retained sources and proves idempotent immutable read-back", async () => {
    const harness = candidateHarness();
    const summary = await runWorkflow2ReleaseCandidate(
      options({ candidateClient: harness.client }),
    );

    expect(summary.idempotentRetryConfirmed).toBe(true);
    expect(summary.exactReferences).toEqual({
      buildProvenanceArtifactId: provenance.artifactId,
      comparisonResultId: "comparison_workflow_2",
      datasetVersionId: "dataset_workflow_2_v1",
      promptArtifactId: prompt.artifactId,
      targetReleaseId: "target_workflow_2_v1",
      toolContractArtifactId: toolContract.artifactId,
    });
    expect(harness.requests).toHaveLength(2);
    expect(harness.requests[0]).toEqual(harness.requests[1]);
    expect(summary.candidate.runtimeComponents).toEqual([
      expect.objectContaining({
        adapter: WORKFLOW_2_REFERENCE_MODEL_ADAPTER,
        ...WORKFLOW_2_REFERENCE_MODEL_DECLARATION,
        kind: "model",
      }),
      expect.objectContaining({ content: prompt, kind: "prompt" }),
      expect.objectContaining({ content: toolContract, kind: "tool_contract" }),
    ]);
  });

  it.each([
    ["fixture scope", { fixture: { ...fixture(), scope: { ...scope, tenantId: "ten_other" } } }],
    ["fixture digest", { fixture: { ...fixture(), definitionSha256: "c".repeat(64) } }],
    [
      "target identity",
      { targetRelease: { ...targetRelease(), targetReleaseId: "target_workflow_2_other" } },
    ],
    ["target digest", { targetRelease: { ...targetRelease(), definitionSha256: "d".repeat(64) } }],
  ])("rejects a substituted %s", async (_label, override) => {
    await expect(runWorkflow2ReleaseCandidate(options(override))).rejects.toThrow(
      "no longer matches",
    );
  });

  it("rejects a candidate source that differs from the retained target revision", async () => {
    await expect(
      runWorkflow2ReleaseCandidate(
        options({ source: { ...source, commit: { algorithm: "sha1", value: "e".repeat(40) } } }),
      ),
    ).rejects.toThrow("must equal the retained target release source revision");
  });

  it.each([
    ["missing", [{ contentReference: toolContract, role: "tool.contract" }]],
    [
      "duplicate",
      [
        { contentReference: prompt, role: "prompt.template" },
        {
          contentReference: { ...prompt, artifactId: "art_workflow_2_prompt_other" },
          role: "prompt.template",
        },
        { contentReference: toolContract, role: "tool.contract" },
      ],
    ],
  ])("rejects %s required retained artifacts", async (_label, artifacts) => {
    await expect(
      runWorkflow2ReleaseCandidate(options({ fixture: fixture(artifacts) })),
    ).rejects.toThrow("must retain exactly one prompt.template artifact");
  });

  it("rejects non-idempotent publication and changed read-back identity", async () => {
    await expect(
      runWorkflow2ReleaseCandidate(
        options({ candidateClient: candidateHarness({ firstCreated: false }).client }),
      ),
    ).rejects.toThrow("First release candidate publication was not created");
    await expect(
      runWorkflow2ReleaseCandidate(
        options({ candidateClient: candidateHarness({ retryCreated: true }).client }),
      ),
    ).rejects.toThrow("Identical release candidate retry created a new record");
    await expect(
      runWorkflow2ReleaseCandidate(
        options({
          candidateClient: candidateHarness({
            mutateRead: (candidate) => ({ ...candidate, candidateVersionId: "candidate_changed" }),
          }).client,
        }),
      ),
    ).rejects.toThrow("read-back changed exact immutable identity");
  });
});
