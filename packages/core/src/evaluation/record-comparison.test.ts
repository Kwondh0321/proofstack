import { readFileSync } from "node:fs";
import type {
  ComparisonDefinitionInput,
  ComparisonEvidenceSnapshotDefinition,
  PrincipalContext,
  PublishComparisonDefinitionRequest,
} from "@proofstack/contracts";
import { describe, expect, it, vi } from "vitest";
import { ForbiddenError } from "../errors.js";
import { FixedClock } from "../testing/fixed-clock.js";
import { MemoryComparisonRepository } from "../testing/memory-comparison-repository.js";
import {
  ComparisonRecordConflictError,
  ComparisonRecordNotFoundError,
  ComparisonRepositoryContractError,
  ComparisonSourceUnavailableError,
  InvalidComparisonRecordInputError,
} from "./comparison-repository-errors.js";
import type { ComparisonRepository } from "./comparison-repository.js";
import {
  CreateComparisonEvidenceSnapshot,
  DeriveComparisonResult,
  PublishComparisonDefinition,
  ReadComparisonRecord,
  type ComparisonEvidenceResolution,
  type ComparisonEvidenceResolver,
} from "./record-comparison.js";

interface Vector<Definition> {
  readonly input: { readonly definition: Definition };
}

function vector<Definition>(filename: string): Definition {
  const document = JSON.parse(
    readFileSync(new URL(`../../../contracts/vectors/${filename}`, import.meta.url), "utf8"),
  ) as { readonly vectors: readonly Vector<Definition>[] };
  const first = document.vectors[0];
  if (!first) throw new Error(`Expected a vector in ${filename}`);
  return first.input.definition;
}

const definitionTemplate = vector<ComparisonDefinitionInput>(
  "evaluation-comparison-definition-v1.json",
);
const snapshotTemplate = vector<ComparisonEvidenceSnapshotDefinition>(
  "evaluation-comparison-snapshot-definition-v1.json",
);
const now = new Date("2026-09-02T04:00:00.000Z");

function principal(overrides: Partial<PrincipalContext> = {}): PrincipalContext {
  return {
    authentication: { authenticatedAt: "2026-09-02T03:00:00.000Z", method: "development" },
    capabilities: ["comparison:manage", "comparison:read"],
    principalId: "usr_comparison",
    principalType: "user",
    requestId: "req_comparison_test",
    resourceScope: { mode: "tenant" },
    roles: ["admin"],
    tenantId: "ten_comparison",
    ...overrides,
  };
}

function definitionRequest(
  overrides: Partial<PublishComparisonDefinitionRequest> = {},
): PublishComparisonDefinitionRequest {
  const {
    comparisonId: _comparisonId,
    predecessor: _predecessor,
    ...request
  } = structuredClone(definitionTemplate);
  return { ...request, ...overrides };
}

function route() {
  return {
    environmentId: "env_comparison",
    principal: principal(),
    projectId: "prj_comparison",
  } as const;
}

function resolution(
  comparison: Parameters<ComparisonEvidenceResolver["resolve"]>[0]["comparison"],
  role: "baseline" | "candidate",
): ComparisonEvidenceResolution {
  const subject = comparison[role];
  const templateFixture = snapshotTemplate.fixtures[0];
  const subjectFixture = subject.fixtures[0];
  if (!templateFixture || !subjectFixture) throw new Error("Expected single fixture vectors");
  const criterion = templateFixture.evaluationOutcomes[0]?.criterion;
  if (!criterion) throw new Error("Expected criterion vector");
  return {
    dataset: structuredClone(subject.dataset),
    fixtures: [
      {
        artifacts: [
          { artifact: structuredClone(subjectFixture.replay.result), availability: "available" },
        ],
        assurance: [
          ...subjectFixture.assessments.map((reference) => ({
            eligibility: "ineligible" as const,
            kind: "assessment" as const,
            reasons: ["human_review_required" as const],
            reference: structuredClone(reference),
          })),
          ...subjectFixture.modelAssuranceAssessments.map((reference) => ({
            eligibility: "eligible" as const,
            kind: "model_assurance" as const,
            reasons: [],
            reference: structuredClone(reference),
          })),
        ],
        evaluationOutcomes: subjectFixture.assessments.map((assessment) => ({
          assessment: structuredClone(assessment),
          counts:
            role === "baseline"
              ? { abstain: 0, error: 0, fail: 1, notApplicable: 0, pass: 0, total: 1 }
              : { abstain: 0, error: 0, fail: 0, notApplicable: 0, pass: 1, total: 1 },
          criterion: structuredClone(criterion),
        })),
        fixture: structuredClone(subjectFixture.fixture),
        numericObservations: [],
        replay: structuredClone(subjectFixture.replay),
        safetyEvents: [],
        trace: structuredClone(templateFixture.trace),
        usage: [
          {
            dimension: "elapsedMilliseconds",
            value: {
              amount: role === "baseline" ? 125 : 100,
              observedCount: 1,
              sources: ["measured"],
              status: "available",
              unavailableCount: 0,
            },
          },
        ],
      },
    ],
    integrity: "verified",
    knownLimitations: ["Synthetic source adapter used by the core contract test"],
    omissions: [],
    sourceCutoff: subjectFixture.replay.completedAt,
  };
}

async function publishDefinition(repository: ComparisonRepository) {
  return new PublishComparisonDefinition({ clock: new FixedClock(now), repository }).execute({
    ...route(),
    comparisonId: "comparison_login",
    input: definitionRequest(),
  });
}

async function createSnapshots(
  repository: ComparisonRepository,
  definition: Awaited<ReturnType<typeof publishDefinition>>["record"],
  suffix = "primary",
) {
  const comparison = {
    comparisonId: definition.comparisonId,
    comparisonVersionId: definition.comparisonVersionId,
    definitionSha256: definition.definitionSha256,
  };
  const useCase = new CreateComparisonEvidenceSnapshot({
    clock: new FixedClock(now),
    evidenceResolver: {
      resolve: async ({ comparison: source, role }) => resolution(source, role),
    },
    repository,
  });
  const baseline = await useCase.execute({
    ...route(),
    input: { comparison, role: "baseline", snapshotId: `snapshot_baseline_${suffix}` },
  });
  const candidate = await useCase.execute({
    ...route(),
    input: { comparison, role: "candidate", snapshotId: `snapshot_candidate_${suffix}` },
  });
  return { baseline, candidate, comparison };
}

describe("comparison recording use cases", () => {
  it("server-authors one immutable definition and preserves its original receipt on retry", async () => {
    const repository = new MemoryComparisonRepository();
    const first = await publishDefinition(repository);
    const retry = await new PublishComparisonDefinition({
      clock: new FixedClock(new Date("2026-09-02T05:00:00.000Z")),
      repository,
    }).execute({
      ...route(),
      comparisonId: "comparison_login",
      input: definitionRequest(),
    });
    expect(first.created).toBe(true);
    expect(first.record).toMatchObject({
      comparisonId: "comparison_login",
      createdAt: now.toISOString(),
      createdByPrincipalId: "usr_comparison",
      scope: {
        environmentId: "env_comparison",
        projectId: "prj_comparison",
        tenantId: "ten_comparison",
      },
    });
    expect(retry).toEqual({ created: false, record: first.record });

    await expect(
      new PublishComparisonDefinition({ clock: new FixedClock(now), repository }).execute({
        ...route(),
        comparisonId: "comparison_login",
        input: definitionRequest({ description: "Conflicting comparison semantics" }),
      }),
    ).rejects.toBeInstanceOf(ComparisonRecordConflictError);
  });

  it("freezes resolver-owned baseline and candidate evidence then derives an exact result", async () => {
    const repository = new MemoryComparisonRepository();
    const definition = (await publishDefinition(repository)).record;
    const evidenceResolver: ComparisonEvidenceResolver = {
      resolve: async ({ comparison, role }) => resolution(comparison, role),
    };
    const snapshots = new CreateComparisonEvidenceSnapshot({
      clock: new FixedClock(now),
      evidenceResolver,
      repository,
    });
    const comparison = {
      comparisonId: definition.comparisonId,
      comparisonVersionId: definition.comparisonVersionId,
      definitionSha256: definition.definitionSha256,
    };
    const baseline = await snapshots.execute({
      ...route(),
      input: { comparison, role: "baseline", snapshotId: "snapshot_baseline" },
    });
    const candidate = await snapshots.execute({
      ...route(),
      input: { comparison, role: "candidate", snapshotId: "snapshot_candidate" },
    });
    expect(baseline.record.fixtures[0]?.usage[0]).toMatchObject({
      dimension: "elapsedMilliseconds",
      value: { amount: 125, status: "available" },
    });
    expect(candidate.record.fixtures[0]?.usage[0]).toMatchObject({
      dimension: "elapsedMilliseconds",
      value: { amount: 100, status: "available" },
    });

    const result = await new DeriveComparisonResult({
      clock: new FixedClock(now),
      repository,
    }).execute({
      ...route(),
      input: {
        baselineSnapshot: {
          definitionSha256: baseline.record.definitionSha256,
          role: "baseline",
          snapshotId: baseline.record.snapshotId,
        },
        candidateSnapshot: {
          definitionSha256: candidate.record.definitionSha256,
          role: "candidate",
          snapshotId: candidate.record.snapshotId,
        },
        comparison,
        resultId: "result_login",
      },
    });
    expect(result.created).toBe(true);
    expect(result.record.pairing).toEqual({
      baselineOnlyCount: 0,
      candidateOnlyCount: 0,
      invalidCount: 0,
      pairedCount: 1,
      requestedCount: 1,
    });
    expect(result.record.metricResults).toHaveLength(2);
    expect(result.record.metricResults[0]).toMatchObject({
      kind: "replay_usage",
      metricId: "metric_elapsed",
      value: {
        delta: {
          denominator: "1",
          numerator: "-25",
          representation: "rational",
          unit: "milliseconds",
        },
        direction: "decreased",
        status: "available",
      },
    });
    await expect(
      new ReadComparisonRecord(repository).execute({
        ...route(),
        kind: "comparison_result",
        recordId: "result_login",
      }),
    ).resolves.toEqual(result.record);
  });

  it("returns an existing exact snapshot without consulting a source adapter again", async () => {
    const repository = new MemoryComparisonRepository();
    const definition = (await publishDefinition(repository)).record;
    const resolve = vi.fn(async ({ comparison, role }) => resolution(comparison, role));
    const useCase = new CreateComparisonEvidenceSnapshot({
      clock: new FixedClock(now),
      evidenceResolver: { resolve },
      repository,
    });
    const input = {
      comparison: {
        comparisonId: definition.comparisonId,
        comparisonVersionId: definition.comparisonVersionId,
        definitionSha256: definition.definitionSha256,
      },
      role: "baseline" as const,
      snapshotId: "snapshot_retry",
    };
    const first = await useCase.execute({ ...route(), input });
    const retry = await useCase.execute({ ...route(), input });
    expect(retry).toEqual({ created: false, record: first.record });
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("rejects a resolver that substitutes source lineage", async () => {
    const repository = new MemoryComparisonRepository();
    const definition = (await publishDefinition(repository)).record;
    await expect(
      new CreateComparisonEvidenceSnapshot({
        clock: new FixedClock(now),
        evidenceResolver: {
          resolve: async ({ comparison, role }) => ({
            ...resolution(comparison, role),
            dataset: { ...comparison[role].dataset, datasetVersionId: "dataset_substituted" },
          }),
        },
        repository,
      }).execute({
        ...route(),
        input: {
          comparison: {
            comparisonId: definition.comparisonId,
            comparisonVersionId: definition.comparisonVersionId,
            definitionSha256: definition.definitionSha256,
          },
          role: "baseline",
          snapshotId: "snapshot_substituted",
        },
      }),
    ).rejects.toThrow("substituted the exact dataset");
  });

  it("authorizes before touching an input, clock, resolver, or repository", async () => {
    const inaccessibleInput = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("input touched");
        },
      },
    );
    const repository = new Proxy(
      {},
      {
        get() {
          throw new Error("repository touched");
        },
      },
    ) as ComparisonRepository;
    await expect(
      new CreateComparisonEvidenceSnapshot({
        clock: {
          now: () => {
            throw new Error("clock touched");
          },
        },
        evidenceResolver: {
          resolve: async () => {
            throw new Error("resolver touched");
          },
        },
        repository,
      }).execute({
        ...route(),
        input: inaccessibleInput as never,
        principal: principal({ capabilities: [] }),
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("hides absent records and rejects malformed repository output", async () => {
    const repository = new MemoryComparisonRepository();
    await expect(
      new ReadComparisonRecord(repository).execute({
        ...route(),
        kind: "comparison_result",
        recordId: "result_absent",
      }),
    ).rejects.toBeInstanceOf(ComparisonRecordNotFoundError);

    const malformed = new Proxy(repository, {
      get(target, property, receiver) {
        if (property === "findComparisonResult") {
          return async () => ({ secret: "corrupt" });
        }
        return Reflect.get(target, property, receiver);
      },
    });
    await expect(
      new ReadComparisonRecord(malformed).execute({
        ...route(),
        kind: "comparison_result",
        recordId: "result_corrupt",
      }),
    ).rejects.toBeInstanceOf(ComparisonRepositoryContractError);
  });

  it("publishes a successor only from the exact predecessor of the same comparison", async () => {
    const repository = new MemoryComparisonRepository();
    const first = await publishDefinition(repository);
    const successor = await new PublishComparisonDefinition({
      clock: new FixedClock(now),
      repository,
    }).execute({
      ...route(),
      comparisonId: first.record.comparisonId,
      input: definitionRequest({
        comparisonVersionId: "comparison_login_v2",
        predecessorVersionId: first.record.comparisonVersionId,
      }),
    });
    expect(successor.record.predecessor).toEqual({
      comparisonVersionId: first.record.comparisonVersionId,
      definitionSha256: first.record.definitionSha256,
    });

    await expect(
      new PublishComparisonDefinition({ clock: new FixedClock(now), repository }).execute({
        ...route(),
        comparisonId: first.record.comparisonId,
        input: definitionRequest({
          comparisonVersionId: "comparison_login_v3",
          predecessorVersionId: "comparison_missing",
        }),
      }),
    ).rejects.toBeInstanceOf(ComparisonSourceUnavailableError);

    const other = await new PublishComparisonDefinition({
      clock: new FixedClock(now),
      repository,
    }).execute({
      ...route(),
      comparisonId: "comparison_other",
      input: definitionRequest({ comparisonVersionId: "comparison_other_v1" }),
    });
    await expect(
      new PublishComparisonDefinition({ clock: new FixedClock(now), repository }).execute({
        ...route(),
        comparisonId: first.record.comparisonId,
        input: definitionRequest({
          comparisonVersionId: "comparison_login_v3",
          predecessorVersionId: other.record.comparisonVersionId,
        }),
      }),
    ).rejects.toBeInstanceOf(ComparisonSourceUnavailableError);
  });

  it("rejects invalid principals, routes, requests, and server clocks", async () => {
    const repository = new MemoryComparisonRepository();
    const useCase = new PublishComparisonDefinition({ clock: new FixedClock(now), repository });
    await expect(
      useCase.execute({
        ...route(),
        comparisonId: "comparison_login",
        input: definitionRequest(),
        principal: { secret: "invalid" } as never,
      }),
    ).rejects.toBeInstanceOf(InvalidComparisonRecordInputError);
    await expect(
      useCase.execute({
        ...route(),
        comparisonId: "comparison_login",
        input: definitionRequest(),
        projectId: "",
      }),
    ).rejects.toBeInstanceOf(InvalidComparisonRecordInputError);
    await expect(
      useCase.execute({ ...route(), comparisonId: "", input: definitionRequest() }),
    ).rejects.toBeInstanceOf(InvalidComparisonRecordInputError);
    await expect(
      useCase.execute({
        ...route(),
        comparisonId: "comparison_login",
        input: { ...definitionRequest(), unexpected: true } as never,
      }),
    ).rejects.toBeInstanceOf(InvalidComparisonRecordInputError);
    await expect(
      new PublishComparisonDefinition({
        clock: { now: () => new Date(Number.NaN) },
        repository,
      }).execute({ ...route(), comparisonId: "comparison_login", input: definitionRequest() }),
    ).rejects.toBeInstanceOf(InvalidComparisonRecordInputError);
    await expect(
      new PublishComparisonDefinition({
        clock: { now: () => ({ toISOString: () => "not-a-timestamp" }) as Date },
        repository,
      }).execute({ ...route(), comparisonId: "comparison_login", input: definitionRequest() }),
    ).rejects.toBeInstanceOf(InvalidComparisonRecordInputError);
  });

  it("rejects invalid snapshot requests, missing definitions, and malformed projections", async () => {
    const repository = new MemoryComparisonRepository();
    const definition = (await publishDefinition(repository)).record;
    const exact = {
      comparisonId: definition.comparisonId,
      comparisonVersionId: definition.comparisonVersionId,
      definitionSha256: definition.definitionSha256,
    };
    const validResolver: ComparisonEvidenceResolver = {
      resolve: async ({ comparison, role }) => resolution(comparison, role),
    };
    const useCase = new CreateComparisonEvidenceSnapshot({
      clock: new FixedClock(now),
      evidenceResolver: validResolver,
      repository,
    });
    await expect(
      useCase.execute({ ...route(), input: { comparison: exact, role: "baseline" } as never }),
    ).rejects.toBeInstanceOf(InvalidComparisonRecordInputError);
    await expect(
      useCase.execute({
        ...route(),
        input: {
          comparison: { ...exact, comparisonVersionId: "comparison_missing" },
          role: "baseline",
          snapshotId: "snapshot_missing_definition",
        },
      }),
    ).rejects.toBeInstanceOf(ComparisonSourceUnavailableError);
    await expect(
      useCase.execute({
        ...route(),
        input: {
          comparison: { ...exact, definitionSha256: "0".repeat(64) },
          role: "baseline",
          snapshotId: "snapshot_wrong_definition_digest",
        },
      }),
    ).rejects.toBeInstanceOf(ComparisonSourceUnavailableError);

    await expect(
      new CreateComparisonEvidenceSnapshot({
        clock: new FixedClock(now),
        evidenceResolver: { resolve: async () => ({ malformed: true }) as never },
        repository,
      }).execute({
        ...route(),
        input: { comparison: exact, role: "baseline", snapshotId: "snapshot_malformed" },
      }),
    ).rejects.toBeInstanceOf(ComparisonRepositoryContractError);
    await expect(
      new CreateComparisonEvidenceSnapshot({
        clock: new FixedClock(now),
        evidenceResolver: {
          resolve: async ({ comparison, role }) => ({
            ...resolution(comparison, role),
            fixtures: [],
          }),
        },
        repository,
      }).execute({
        ...route(),
        input: { comparison: exact, role: "baseline", snapshotId: "snapshot_empty" },
      }),
    ).rejects.toBeInstanceOf(ComparisonRepositoryContractError);
    await expect(
      new CreateComparisonEvidenceSnapshot({
        clock: new FixedClock(now),
        evidenceResolver: {
          resolve: async ({ comparison, role }) => {
            const value = resolution(comparison, role);
            const fixture = value.fixtures[0];
            if (!fixture) throw new Error("Expected fixture");
            return {
              ...value,
              fixtures: [
                {
                  ...fixture,
                  replay: { ...fixture.replay, jobId: "job_substituted" },
                },
              ],
            };
          },
        },
        repository,
      }).execute({
        ...route(),
        input: { comparison: exact, role: "baseline", snapshotId: "snapshot_wrong_replay" },
      }),
    ).rejects.toThrow("substituted exact fixture or replay lineage");
  });

  it("rejects snapshot identifier conflicts and malformed retry behavior", async () => {
    const repository = new MemoryComparisonRepository();
    const definition = (await publishDefinition(repository)).record;
    const { baseline, comparison } = await createSnapshots(repository, definition, "conflict");
    const useCase = new CreateComparisonEvidenceSnapshot({
      clock: new FixedClock(now),
      evidenceResolver: {
        resolve: async ({ comparison: source, role }) => resolution(source, role),
      },
      repository,
    });
    await expect(
      useCase.execute({
        ...route(),
        input: {
          comparison,
          role: "candidate",
          snapshotId: baseline.record.snapshotId,
        },
      }),
    ).rejects.toBeInstanceOf(ComparisonRecordConflictError);

    const malformedRetry = new Proxy(repository, {
      get(target, property, receiver) {
        if (property === "publishComparisonEvidenceSnapshot") {
          return async (
            record: Parameters<ComparisonRepository["publishComparisonEvidenceSnapshot"]>[0],
          ) => {
            const result = await target.publishComparisonEvidenceSnapshot(record);
            return { ...result, created: true };
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });
    await expect(
      new CreateComparisonEvidenceSnapshot({
        clock: new FixedClock(now),
        evidenceResolver: {
          resolve: async ({ comparison: source, role }) => resolution(source, role),
        },
        repository: malformedRetry,
      }).execute({
        ...route(),
        input: {
          comparison,
          role: "baseline",
          snapshotId: baseline.record.snapshotId,
        },
      }),
    ).rejects.toThrow("snapshot retry violated");
  });

  it("validates exact result sources, idempotent retries, and identifier conflicts", async () => {
    const repository = new MemoryComparisonRepository();
    const definition = (await publishDefinition(repository)).record;
    const first = await createSnapshots(repository, definition, "result_a");
    const derive = new DeriveComparisonResult({ clock: new FixedClock(now), repository });
    const input = {
      baselineSnapshot: {
        definitionSha256: first.baseline.record.definitionSha256,
        role: "baseline" as const,
        snapshotId: first.baseline.record.snapshotId,
      },
      candidateSnapshot: {
        definitionSha256: first.candidate.record.definitionSha256,
        role: "candidate" as const,
        snapshotId: first.candidate.record.snapshotId,
      },
      comparison: first.comparison,
      resultId: "result_retry",
    };
    const created = await derive.execute({ ...route(), input });
    await expect(derive.execute({ ...route(), input })).resolves.toEqual({
      created: false,
      record: created.record,
    });
    await expect(
      derive.execute({ ...route(), input: { ...input, unexpected: true } as never }),
    ).rejects.toBeInstanceOf(InvalidComparisonRecordInputError);
    await expect(
      derive.execute({
        ...route(),
        input: {
          ...input,
          baselineSnapshot: { ...input.baselineSnapshot, snapshotId: "snapshot_absent" },
          resultId: "result_absent_snapshot",
        },
      }),
    ).rejects.toBeInstanceOf(ComparisonSourceUnavailableError);
    await expect(
      derive.execute({
        ...route(),
        input: {
          ...input,
          baselineSnapshot: { ...input.baselineSnapshot, definitionSha256: "0".repeat(64) },
          resultId: "result_wrong_snapshot_digest",
        },
      }),
    ).rejects.toBeInstanceOf(ComparisonSourceUnavailableError);

    const second = await createSnapshots(repository, definition, "result_b");
    await expect(
      derive.execute({
        ...route(),
        input: {
          ...input,
          baselineSnapshot: {
            definitionSha256: second.baseline.record.definitionSha256,
            role: "baseline",
            snapshotId: second.baseline.record.snapshotId,
          },
          candidateSnapshot: {
            definitionSha256: second.candidate.record.definitionSha256,
            role: "candidate",
            snapshotId: second.candidate.record.snapshotId,
          },
        },
      }),
    ).rejects.toBeInstanceOf(ComparisonRecordConflictError);
  });

  it("reads every exact record kind and validates requested identifiers", async () => {
    const repository = new MemoryComparisonRepository();
    const definition = (await publishDefinition(repository)).record;
    const snapshots = await createSnapshots(repository, definition, "read");
    const read = new ReadComparisonRecord(repository);
    await expect(
      read.execute({
        ...route(),
        kind: "comparison_definition",
        recordId: definition.comparisonVersionId,
      }),
    ).resolves.toEqual(definition);
    await expect(
      read.execute({
        ...route(),
        kind: "comparison_evidence_snapshot",
        recordId: snapshots.baseline.record.snapshotId,
      }),
    ).resolves.toEqual(snapshots.baseline.record);
    await expect(
      read.execute({ ...route(), kind: "comparison_result", recordId: "" }),
    ).rejects.toBeInstanceOf(InvalidComparisonRecordInputError);

    const substituted = new Proxy(repository, {
      get(target, property, receiver) {
        if (property === "findComparisonDefinition") return async () => definition;
        return Reflect.get(target, property, receiver);
      },
    });
    await expect(
      new ReadComparisonRecord(substituted).execute({
        ...route(),
        kind: "comparison_definition",
        recordId: "comparison_different",
      }),
    ).rejects.toThrow("outside the exact query");
  });

  it("rejects structurally invalid publication adapter responses", async () => {
    const cases = [
      async () => null,
      async (record: unknown) => ({ created: true, extra: true, record }),
      async () =>
        new Proxy(
          {},
          {
            ownKeys() {
              throw new Error("unreadable result");
            },
          },
        ),
    ];
    for (const publishComparisonDefinition of cases) {
      const repository = new Proxy(new MemoryComparisonRepository(), {
        get(target, property, receiver) {
          if (property === "publishComparisonDefinition") return publishComparisonDefinition;
          return Reflect.get(target, property, receiver);
        },
      });
      await expect(publishDefinition(repository)).rejects.toBeInstanceOf(
        ComparisonRepositoryContractError,
      );
    }
  });
});
