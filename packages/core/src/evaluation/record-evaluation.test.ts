import { readFileSync } from "node:fs";
import type { PrincipalContext, RawObservationDefinition } from "@proofstack/contracts";
import { describe, expect, it } from "vitest";
import { ForbiddenError } from "../errors.js";
import { FixedClock } from "../testing/fixed-clock.js";
import { MemoryEvaluationRepository } from "../testing/memory-evaluation-repository.js";
import {
  EvaluationRecordConflictError,
  EvaluationRecordNotFoundError,
  EvaluationRepositoryContractError,
  InvalidEvaluationRecordInputError,
  type EvaluationRecordKind,
} from "./evaluation-repository-errors.js";
import type { EvaluationRecord, EvaluationRepository } from "./evaluation-repository.js";
import { validateEvaluationRecord } from "./evaluation-record-validation.js";
import {
  CreateAssessment,
  CreateEvaluationAggregate,
  PublishEvaluationDefinition,
  ReadEvaluationRecord,
  RecordCriterionSetStatus,
  RecordEvaluationRunDecision,
  RecordEvaluationRunResult,
  RecordRawObservation,
  type RecordEvaluationCommand,
  type RecordEvaluationDependencies,
} from "./record-evaluation.js";

interface StoredVector {
  readonly input: { readonly definition: Record<string, unknown> };
  readonly kind: EvaluationRecordKind;
}

const vectorFiles = [
  "evaluation-source-definition-v1.json",
  "evaluation-criteria-definition-v1.json",
  "evaluation-spec-definition-v1.json",
  "evaluation-qualification-definition-v1.json",
  "evaluation-run-definition-v1.json",
  "evaluation-assessment-definition-v1.json",
] as const;

const vectors = vectorFiles.flatMap(
  (file) =>
    (
      JSON.parse(
        readFileSync(new URL(`../../../contracts/vectors/${file}`, import.meta.url), "utf8"),
      ) as { readonly vectors: readonly StoredVector[] }
    ).vectors,
);

function principal(overrides: Partial<PrincipalContext> = {}): PrincipalContext {
  return {
    authentication: { authenticatedAt: "2026-09-02T00:00:00.000Z", method: "development" },
    capabilities: ["evaluation:manage", "evaluation:read", "evaluation:run"],
    principalId: "usr_evaluation",
    principalType: "user",
    requestId: "req_evaluation_test",
    resourceScope: { mode: "tenant" },
    roles: ["admin"],
    tenantId: "ten_evaluation",
    ...overrides,
  };
}

function recordId(
  kind: EvaluationRecordKind,
  definition: Readonly<Record<string, unknown>>,
): string {
  const field: Record<EvaluationRecordKind, string> = {
    aggregation_policy: "policyVersionId",
    assessment: "assessmentId",
    criterion_set: "criterionSetVersionId",
    criterion_set_status: "statusRecordId",
    discovery_record: "discoveryId",
    evaluation_aggregate: "aggregateId",
    evaluation_run: "evaluationRunId",
    evaluation_run_rejection: "rejectionId",
    evaluation_run_result: "resultId",
    evaluator_spec: "evaluatorVersionId",
    oracle_spec: "oracleVersionId",
    qualification_fixture_set: "fixtureSetVersionId",
    qualification_report: "qualificationReportId",
    raw_observation: "observationId",
    source_review: "sourceReviewId",
    source_snapshot: "sourceSnapshotId",
  };
  const value = definition[field[kind]];
  if (typeof value !== "string") throw new TypeError(`Definition omitted ${field[kind]}`);
  return value;
}

function command(vector: StoredVector): RecordEvaluationCommand<EvaluationRecordKind> {
  const definition = structuredClone(vector.input.definition);
  if (vector.kind === "raw_observation") {
    definition["executedByPrincipalId"] = "usr_evaluation";
  }
  return {
    definition: definition as never,
    environmentId: "env_evaluation",
    kind: vector.kind,
    principal: principal(),
    projectId: "prj_evaluation",
    recordId: recordId(vector.kind, definition),
  };
}

function passThroughRepository(onAccess?: (property: string) => void): EvaluationRepository {
  return new Proxy(
    {},
    {
      get(_target, property) {
        const name = String(property);
        onAccess?.(name);
        if (name.startsWith("find")) return async () => null;
        if (name.startsWith("publish")) {
          return async (record: EvaluationRecord) => ({
            created: true,
            record: structuredClone(record),
          });
        }
        return undefined;
      },
    },
  ) as EvaluationRepository;
}

async function executeVector(vector: StoredVector, dependencies: RecordEvaluationDependencies) {
  const input = command(vector);
  switch (vector.kind) {
    case "aggregation_policy":
    case "criterion_set":
    case "discovery_record":
    case "evaluator_spec":
    case "oracle_spec":
    case "qualification_fixture_set":
    case "qualification_report":
    case "source_review":
    case "source_snapshot":
      return new PublishEvaluationDefinition(dependencies).execute(input as never);
    case "criterion_set_status":
      return new RecordCriterionSetStatus(dependencies).execute(input as never);
    case "evaluation_run":
    case "evaluation_run_rejection":
      return new RecordEvaluationRunDecision(dependencies).execute(input as never);
    case "raw_observation":
      return new RecordRawObservation(dependencies).execute(input as never);
    case "evaluation_run_result":
      return new RecordEvaluationRunResult(dependencies).execute(input as never);
    case "evaluation_aggregate":
      return new CreateEvaluationAggregate(dependencies).execute(input as never);
    case "assessment":
      return new CreateAssessment(dependencies).execute(input as never);
  }
}

const timestamp = new Date("2026-09-02T00:00:00.000Z");

describe("evaluation recording use cases", () => {
  it("server-authors and validates every evaluation record kind through its bounded use case", async () => {
    const dependencies = {
      clock: new FixedClock(timestamp),
      repository: passThroughRepository(),
    };
    expect(vectors).toHaveLength(16);
    for (const vector of vectors) {
      const result = await executeVector(vector, dependencies);
      expect(result.created, vector.kind).toBe(true);
      expect(result.record.scope, vector.kind).toEqual({
        environmentId: "env_evaluation",
        projectId: "prj_evaluation",
        tenantId: "ten_evaluation",
      });
      expect(validateEvaluationRecord(vector.kind, result.record), vector.kind).toEqual(
        result.record,
      );
      expect(JSON.stringify(result.record), vector.kind).toContain("usr_evaluation");
    }
  });

  it("authorizes exact scope before touching route identifiers, definitions, clocks, or repositories", async () => {
    let repositoryAccesses = 0;
    const repository = passThroughRepository(() => {
      repositoryAccesses += 1;
    });
    const inaccessibleDefinition = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("definition touched");
        },
      },
    );
    const useCase = new PublishEvaluationDefinition({
      clock: {
        now: () => {
          throw new Error("clock touched");
        },
      },
      repository,
    });
    await expect(
      useCase.execute({
        definition: inaccessibleDefinition as never,
        environmentId: "env_forbidden",
        kind: "discovery_record",
        principal: principal({ capabilities: [] }),
        projectId: "prj_forbidden",
        recordId: "not valid",
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(repositoryAccesses).toBe(0);
  });

  it("returns the original server receipt on retry and rejects a semantic conflict", async () => {
    const vector = vectors.find(({ kind }) => kind === "discovery_record");
    if (!vector) throw new Error("Expected discovery vector");
    const repository = new MemoryEvaluationRepository();
    const first = await executeVector(vector, {
      clock: new FixedClock(new Date("2026-09-02T00:00:01.000Z")),
      repository,
    });
    const retry = await executeVector(vector, {
      clock: new FixedClock(new Date("2026-09-02T00:00:02.000Z")),
      repository,
    });
    expect(first.created).toBe(true);
    expect(retry).toEqual({ created: false, record: first.record });

    const conflicting = structuredClone(vector);
    conflicting.input.definition["query"] = "Different immutable discovery semantics";
    await expect(
      executeVector(conflicting, {
        clock: new FixedClock(new Date("2026-09-02T00:00:03.000Z")),
        repository,
      }),
    ).rejects.toBeInstanceOf(EvaluationRecordConflictError);
  });

  it("rejects spoofed observation executors and malformed repository results", async () => {
    const observation = vectors.find(({ kind }) => kind === "raw_observation");
    const discovery = vectors.find(({ kind }) => kind === "discovery_record");
    if (!observation || !discovery) throw new Error("Expected vectors");
    const spoofed = command(observation);
    (spoofed.definition as RawObservationDefinition).executedByPrincipalId = "svc_spoofed";
    await expect(
      new RecordRawObservation({
        clock: new FixedClock(timestamp),
        repository: passThroughRepository(),
      }).execute(spoofed as never),
    ).rejects.toBeInstanceOf(InvalidEvaluationRecordInputError);

    const malformed = new Proxy(passThroughRepository(), {
      get(target, property, receiver) {
        if (String(property) === "publishDiscoveryRecord") {
          return async (record: EvaluationRecord) => ({ created: true, extra: true, record });
        }
        return Reflect.get(target, property, receiver);
      },
    });
    await expect(
      executeVector(discovery, {
        clock: new FixedClock(timestamp),
        repository: malformed,
      }),
    ).rejects.toBeInstanceOf(EvaluationRepositoryContractError);
  });

  it("reads one exact authorized record and hides missing or out-of-scope records", async () => {
    const vector = vectors.find(({ kind }) => kind === "discovery_record");
    if (!vector) throw new Error("Expected discovery vector");
    const repository = new MemoryEvaluationRepository();
    const published = await executeVector(vector, {
      clock: new FixedClock(timestamp),
      repository,
    });
    const read = new ReadEvaluationRecord(repository);
    const route = {
      environmentId: "env_evaluation",
      kind: vector.kind,
      principal: principal(),
      projectId: "prj_evaluation",
      recordId: recordId(vector.kind, vector.input.definition),
    } as const;

    const result = await read.execute(route);
    expect(result).toEqual(published.record);
    expect(result).not.toBe(published.record);
    await expect(
      read.execute({ ...route, recordId: "dsc_missing" }),
    ).rejects.toBeInstanceOf(EvaluationRecordNotFoundError);
    await expect(
      read.execute({ ...route, environmentId: "env_other" }),
    ).rejects.toBeInstanceOf(EvaluationRecordNotFoundError);
  });

  it("authorizes evaluation reads before parsing route identifiers or touching storage", async () => {
    let repositoryAccesses = 0;
    const read = new ReadEvaluationRecord(
      passThroughRepository(() => {
        repositoryAccesses += 1;
      }),
    );
    await expect(
      read.execute({
        environmentId: "env_forbidden",
        kind: "discovery_record",
        principal: principal({ capabilities: [] }),
        projectId: "prj_forbidden",
        recordId: "not valid",
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(repositoryAccesses).toBe(0);
  });
});
