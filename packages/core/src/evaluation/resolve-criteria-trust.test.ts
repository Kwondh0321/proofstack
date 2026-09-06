import type {
  CriterionSet,
  CriterionSetStatusRecord,
  EvaluationRecordKind,
  EvaluatorSpec,
  OracleSpec,
  PrincipalContext,
  QualificationFixtureSet,
  QualificationReport,
  SourceReviewerQualification,
  SourceReviewRecord,
  SourceSnapshot,
} from "@proofstack/contracts";
import { describe, expect, it, vi } from "vitest";
import { ForbiddenError } from "../errors.js";
import { createEvaluationRepositoryTestHarness } from "../testing/evaluation-repository-fixtures.js";
import { FixedClock } from "../testing/fixed-clock.js";
import { MemoryEvaluationRepository } from "../testing/memory-evaluation-repository.js";
import type { CriteriaTrustArtifactAvailability } from "./criteria-trust.js";
import {
  digestEvaluationRecordDefinition,
  type EvaluationStoredRecord,
} from "./evaluation-record-validation.js";
import type { EvaluationRepository } from "./evaluation-repository.js";
import {
  EvaluationRecordNotFoundError,
  EvaluationRepositoryContractError,
  InvalidEvaluationRecordInputError,
} from "./evaluation-repository-errors.js";
import {
  type CriteriaTrustArtifactResolver,
  ResolveCriteriaTrust,
  type ResolveCriteriaTrustArtifactsCommand,
  type ResolveCriteriaTrustCommand,
} from "./resolve-criteria-trust.js";

type RecordByKind = {
  criterion_set: CriterionSet;
  criterion_set_status: CriterionSetStatusRecord;
  evaluator_spec: EvaluatorSpec;
  oracle_spec: OracleSpec;
  qualification_fixture_set: QualificationFixtureSet;
  qualification_report: QualificationReport;
  source_review: SourceReviewRecord;
  source_reviewer_qualification: SourceReviewerQualification;
  source_snapshot: SourceSnapshot;
};

type Mutable<T> = T extends readonly (infer Item)[]
  ? Mutable<Item>[]
  : T extends object
    ? { -readonly [Key in keyof T]: Mutable<T[Key]> }
    : T;

const receiptKeys: Readonly<Record<keyof RecordByKind, readonly string[]>> = {
  criterion_set: [
    "definitionSha256",
    "publishedAt",
    "publishedByPrincipalId",
    "schemaVersion",
    "scope",
  ],
  criterion_set_status: [
    "definitionSha256",
    "recordedAt",
    "recordedByPrincipalId",
    "schemaVersion",
    "scope",
  ],
  evaluator_spec: [
    "definitionSha256",
    "publishedAt",
    "publishedByPrincipalId",
    "schemaVersion",
    "scope",
  ],
  oracle_spec: [
    "definitionSha256",
    "publishedAt",
    "publishedByPrincipalId",
    "schemaVersion",
    "scope",
  ],
  qualification_fixture_set: [
    "definitionSha256",
    "publishedAt",
    "publishedByPrincipalId",
    "schemaVersion",
    "scope",
  ],
  qualification_report: [
    "definitionSha256",
    "executedByPrincipalId",
    "recordedAt",
    "schemaVersion",
    "scope",
  ],
  source_review: [
    "definitionSha256",
    "reviewedAt",
    "reviewedByPrincipalId",
    "reviewerRole",
    "schemaVersion",
    "scope",
  ],
  source_reviewer_qualification: [
    "definitionSha256",
    "recordedAt",
    "schemaVersion",
    "scope",
    "verifiedByPrincipalId",
  ],
  source_snapshot: [
    "definitionSha256",
    "publishedByPrincipalId",
    "recordedAt",
    "schemaVersion",
    "scope",
  ],
};

function record<K extends keyof RecordByKind>(
  records: readonly { readonly kind: string; readonly record: unknown }[],
  kind: K,
  predicate?: (value: RecordByKind[K]) => boolean,
): RecordByKind[K] {
  const match = records.find(
    (value) => value.kind === kind && (!predicate || predicate(value.record as RecordByKind[K])),
  );
  if (!match) throw new Error(`Expected ${kind} fixture`);
  return match.record as RecordByKind[K];
}

function redigest<K extends keyof RecordByKind>(kind: K, value: RecordByKind[K]): void {
  const definition = structuredClone(value) as unknown as Record<string, unknown>;
  for (const key of receiptKeys[kind]) delete definition[key];
  (value as unknown as { definitionSha256: string }).definitionSha256 =
    digestEvaluationRecordDefinition(kind, value.scope, definition);
}

async function publishRequiredGraph(
  repository: MemoryEvaluationRepository,
  records: readonly {
    readonly kind: EvaluationRecordKind;
    readonly record: EvaluationStoredRecord;
  }[],
): Promise<void> {
  for (const { kind, record: value } of records) {
    switch (kind) {
      case "discovery_record":
        await repository.publishDiscoveryRecord(value as never);
        break;
      case "source_snapshot":
        await repository.publishSourceSnapshot(value as SourceSnapshot);
        break;
      case "source_reviewer_qualification":
        await repository.publishSourceReviewerQualification(value as SourceReviewerQualification);
        break;
      case "source_review":
        await repository.publishSourceReview(value as SourceReviewRecord);
        break;
      case "qualification_fixture_set":
        await repository.publishQualificationFixtureSet(value as QualificationFixtureSet);
        break;
      case "oracle_spec":
        await repository.publishOracleSpec(value as OracleSpec);
        break;
      case "evaluator_spec":
        await repository.publishEvaluatorSpec(value as EvaluatorSpec);
        break;
      case "criterion_set":
        await repository.publishCriterionSet(value as CriterionSet);
        break;
      case "criterion_set_status":
        await repository.publishCriterionSetStatus(value as CriterionSetStatusRecord);
        break;
      case "qualification_report":
        await repository.publishQualificationReport(value as QualificationReport);
        break;
      default:
        break;
    }
  }
}

function principal(
  scope: CriterionSet["scope"],
  capabilities = ["evaluation:read"],
): PrincipalContext {
  return {
    authentication: { authenticatedAt: "2026-09-02T00:00:00.000Z", method: "development" },
    capabilities: capabilities as PrincipalContext["capabilities"],
    principalId: "usr_task_requester",
    principalType: "user",
    requestId: "req_criteria_trust_resolver",
    resourceScope: {
      mode: "restricted",
      projects: [{ environmentIds: [scope.environmentId], projectId: scope.projectId }],
    },
    roles: ["viewer"],
    tenantId: scope.tenantId,
  };
}

class AvailableArtifactResolver implements CriteriaTrustArtifactResolver {
  readonly calls: ResolveCriteriaTrustArtifactsCommand[] = [];

  async resolve(
    command: ResolveCriteriaTrustArtifactsCommand,
  ): Promise<readonly CriteriaTrustArtifactAvailability[]> {
    this.calls.push(structuredClone(command));
    return command.references.map((reference) => ({ ...reference, state: "available" }));
  }
}

function repositoryWith(
  repository: EvaluationRepository,
  overrides: Partial<EvaluationRepository>,
): EvaluationRepository {
  return new Proxy(repository, {
    get(target, property, receiver) {
      const override = Reflect.get(overrides, property, overrides) as unknown;
      if (override !== undefined) return override;
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function fixture(): Promise<{
  readonly artifactResolver: AvailableArtifactResolver;
  readonly command: ResolveCriteriaTrustCommand;
  readonly repository: MemoryEvaluationRepository;
}> {
  const harness = createEvaluationRepositoryTestHarness("criteria_trust_resolution");
  const records = structuredClone(harness.records) as Mutable<typeof harness.records>;
  const criterionSet = record(records, "criterion_set") as Mutable<CriterionSet>;
  criterionSet.publishedByPrincipalId = "usr_criterion_author";
  const criterionStatus = record(
    records,
    "criterion_set_status",
    (value) => value.status === "approved",
  ) as Mutable<CriterionSetStatusRecord>;
  const draftCriterionStatus = record(
    records,
    "criterion_set_status",
    (value) => value.status === "draft",
  ) as Mutable<CriterionSetStatusRecord>;
  const reviewerQualification = record(
    records,
    "source_reviewer_qualification",
  ) as Mutable<SourceReviewerQualification>;
  reviewerQualification.reviewerPrincipalId = "usr_source_reviewer";
  redigest("source_reviewer_qualification", reviewerQualification);
  const review = record(records, "source_review") as Mutable<SourceReviewRecord>;
  review.reviewedByPrincipalId = "usr_source_reviewer";
  review.reviewerQualification = {
    definitionSha256: reviewerQualification.definitionSha256,
    qualificationId: reviewerQualification.qualificationId,
  };
  review.declaredRelationships = [];
  redigest("source_review", review);
  const sourceReference = criterionSet.sources[0];
  if (!sourceReference) throw new Error("Expected criterion source reference");
  sourceReference.review.definitionSha256 = review.definitionSha256;
  redigest("criterion_set", criterionSet);
  draftCriterionStatus.criterionSet.definitionSha256 = criterionSet.definitionSha256;
  redigest("criterion_set_status", draftCriterionStatus);
  criterionStatus.criterionSet.definitionSha256 = criterionSet.definitionSha256;
  if (!criterionStatus.previousStatus) throw new Error("Expected prior criterion status");
  criterionStatus.previousStatus.definitionSha256 = draftCriterionStatus.definitionSha256;
  redigest("criterion_set_status", criterionStatus);

  const evaluator = record(records, "evaluator_spec") as Mutable<EvaluatorSpec>;
  evaluator.publishedByPrincipalId = "usr_evaluator_author";
  const oracle = record(records, "oracle_spec") as Mutable<OracleSpec>;
  oracle.publishedByPrincipalId = "usr_oracle_author";
  const evaluatorReport = record(
    records,
    "qualification_report",
    (value) => value.subject.kind === "evaluator",
  ) as Mutable<QualificationReport>;
  evaluatorReport.executedByPrincipalId = "wrk_evaluator_qualifier";
  const oracleReport = record(
    records,
    "qualification_report",
    (value) => value.subject.kind === "oracle",
  ) as Mutable<QualificationReport>;
  oracleReport.executedByPrincipalId = "wrk_oracle_qualifier";

  const repository = new MemoryEvaluationRepository();
  await publishRequiredGraph(repository, records);
  const artifactResolver = new AvailableArtifactResolver();
  return {
    artifactResolver,
    command: {
      context: {
        environmentId: "env_local",
        jurisdiction: "kr",
        locale: "ko-kr",
        populationTags: ["adult users"],
        riskTier: "high",
        taskKind: "task_support",
      },
      criterionSetVersionId: criterionSet.criterionSetVersionId,
      criterionStatusRecordId: criterionStatus.statusRecordId,
      environmentId: criterionSet.scope.environmentId,
      principal: principal(criterionSet.scope),
      projectId: criterionSet.scope.projectId,
      qualificationReportIds: [
        oracleReport.qualificationReportId,
        evaluatorReport.qualificationReportId,
      ],
    },
    repository,
  };
}

describe("ResolveCriteriaTrust", () => {
  it("derives an eligible decision from exact server-side records and artifact checks", async () => {
    const setup = await fixture();
    const result = await new ResolveCriteriaTrust({
      artifactResolver: setup.artifactResolver,
      clock: new FixedClock(new Date("2026-09-02T00:01:00.000Z")),
      repository: setup.repository,
    }).execute(setup.command);

    expect(result).toEqual({
      evaluatedAt: "2026-09-02T00:01:00.000Z",
      reasons: [],
      status: "eligible",
    });
    expect(setup.artifactResolver.calls).toHaveLength(1);
    const references = setup.artifactResolver.calls[0]?.references ?? [];
    expect(references.length).toBeGreaterThan(0);
    expect(new Set(references.map((value) => `${value.artifactId}:${value.sha256}`)).size).toBe(
      references.length,
    );
    expect(references.map((value) => `${value.artifactId}:${value.sha256}`)).toEqual(
      [...references]
        .map((value) => `${value.artifactId}:${value.sha256}`)
        .sort((left, right) => left.localeCompare(right)),
    );
  });

  it("fails closed when retained artifact resolution is unavailable", async () => {
    const setup = await fixture();
    const result = await new ResolveCriteriaTrust({
      artifactResolver: { resolve: vi.fn().mockRejectedValue(new Error("object store offline")) },
      clock: new FixedClock(new Date("2026-09-02T00:01:00.000Z")),
      repository: setup.repository,
    }).execute(setup.command);

    expect(result.status).toBe("unverifiable");
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        "qualification_evidence_unavailable",
        "reviewer_qualification_evidence_unavailable",
        "source_content_unavailable",
        "source_identity_evidence_unavailable",
        "source_review_basis_unavailable",
      ]),
    );
  });

  it("keeps missing status, reports, reviewer qualifications, and artifacts unavailable", async () => {
    const setup = await fixture();
    const repository = repositoryWith(setup.repository, {
      findCriterionSetStatus: vi.fn().mockResolvedValue(null),
      findQualificationReport: vi.fn().mockResolvedValue(null),
      findSourceReviewerQualification: vi.fn().mockResolvedValue(null),
    });
    const result = await new ResolveCriteriaTrust({
      artifactResolver: { resolve: vi.fn().mockResolvedValue([]) },
      clock: new FixedClock(new Date("2026-09-02T00:01:00.000Z")),
      repository,
    }).execute(setup.command);

    expect(result.status).toBe("unverifiable");
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        "criterion_status_unavailable",
        "qualification_report_unavailable",
        "reviewer_qualification_unavailable",
        "source_content_unavailable",
      ]),
    );
  });

  it("rejects repository substitution under an exact criterion dependency", async () => {
    const setup = await fixture();
    const original = await setup.repository.findSourceSnapshot(
      {
        environmentId: setup.command.environmentId,
        projectId: setup.command.projectId,
        tenantId: setup.command.principal.tenantId,
      },
      "src_primary",
    );
    if (!original) throw new Error("Expected source fixture");
    const substituted = structuredClone(original) as Mutable<SourceSnapshot>;
    substituted.scope.environmentId = "env_substituted";
    const repository = repositoryWith(setup.repository, {
      findSourceSnapshot: vi.fn().mockResolvedValue(substituted),
    });

    await expect(
      new ResolveCriteriaTrust({
        artifactResolver: setup.artifactResolver,
        clock: new FixedClock(new Date("2026-09-02T00:01:00.000Z")),
        repository,
      }).execute(setup.command),
    ).rejects.toBeInstanceOf(EvaluationRepositoryContractError);
    expect(setup.artifactResolver.calls).toHaveLength(0);
  });

  it("returns not found when the selected criterion set is absent", async () => {
    const setup = await fixture();
    await expect(
      new ResolveCriteriaTrust({
        artifactResolver: setup.artifactResolver,
        clock: new FixedClock(new Date("2026-09-02T00:01:00.000Z")),
        repository: repositoryWith(setup.repository, {
          findCriterionSet: vi.fn().mockResolvedValue(null),
        }),
      }).execute(setup.command),
    ).rejects.toBeInstanceOf(EvaluationRecordNotFoundError);
  });

  it("authorizes before parsing selectors or touching time, storage, and artifacts", async () => {
    const setup = await fixture();
    const now = vi.fn(() => new Date("2026-09-02T00:01:00.000Z"));
    const findCriterionSet = vi.fn();
    const artifactResolver = { resolve: vi.fn() };
    await expect(
      new ResolveCriteriaTrust({
        artifactResolver,
        clock: { now },
        repository: repositoryWith(setup.repository, { findCriterionSet }),
      }).execute({
        ...setup.command,
        criterionSetVersionId: "invalid id",
        principal: principal(
          {
            environmentId: setup.command.environmentId,
            projectId: setup.command.projectId,
            tenantId: setup.command.principal.tenantId,
          },
          [],
        ),
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(now).not.toHaveBeenCalled();
    expect(findCriterionSet).not.toHaveBeenCalled();
    expect(artifactResolver.resolve).not.toHaveBeenCalled();
  });

  it.each([
    { label: "invalid criterion selector", patch: { criterionSetVersionId: "invalid id" } },
    {
      label: "invalid status selector",
      patch: { criterionStatusRecordId: "invalid id" },
    },
    {
      label: "invalid applicability context",
      patch: { context: { populationTags: [], riskTier: "invalid" } },
    },
    {
      label: "duplicate qualification reports",
      patch: { qualificationReportIds: ["qlr_oracle", "qlr_oracle"] },
    },
    {
      label: "invalid qualification report",
      patch: { qualificationReportIds: ["invalid id"] },
    },
  ])("rejects $label before consulting the clock or repository", async ({ patch }) => {
    const setup = await fixture();
    const now = vi.fn(() => new Date("2026-09-02T00:01:00.000Z"));
    const findCriterionSet = vi.fn();
    await expect(
      new ResolveCriteriaTrust({
        artifactResolver: setup.artifactResolver,
        clock: { now },
        repository: repositoryWith(setup.repository, { findCriterionSet }),
      }).execute({ ...setup.command, ...patch } as ResolveCriteriaTrustCommand),
    ).rejects.toBeInstanceOf(InvalidEvaluationRecordInputError);
    expect(now).not.toHaveBeenCalled();
    expect(findCriterionSet).not.toHaveBeenCalled();
  });

  it("rejects malformed or contradictory artifact resolver output", async () => {
    const setup = await fixture();
    const first = new AvailableArtifactResolver();
    await new ResolveCriteriaTrust({
      artifactResolver: first,
      clock: new FixedClock(new Date("2026-09-02T00:01:00.000Z")),
      repository: setup.repository,
    }).execute(setup.command);
    const reference = first.calls[0]?.references[0];
    if (!reference) throw new Error("Expected artifact reference");

    for (const result of [
      [{ ...reference, artifactId: "invalid id", state: "available" as const }],
      [
        { ...reference, state: "available" as const },
        { ...reference, state: "unavailable" as const },
      ],
    ]) {
      await expect(
        new ResolveCriteriaTrust({
          artifactResolver: { resolve: vi.fn().mockResolvedValue(result) },
          clock: new FixedClock(new Date("2026-09-02T00:01:00.000Z")),
          repository: setup.repository,
        }).execute(setup.command),
      ).rejects.toBeInstanceOf(EvaluationRepositoryContractError);
    }
  });
});
