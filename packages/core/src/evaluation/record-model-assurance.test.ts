import { readFileSync } from "node:fs";
import type { EvidenceScope, PrincipalContext } from "@proofstack/contracts";
import { describe, expect, it } from "vitest";
import { ForbiddenError } from "../errors.js";
import { FixedClock } from "../testing/fixed-clock.js";
import {
  InvalidModelAssuranceRecordInputError,
  type ModelAssuranceRecord,
  type ModelAssuranceRecordByKind,
  ModelAssuranceRecordConflictError,
  type ModelAssuranceRecordKind,
  type ModelAssuranceRepository,
  ModelAssuranceRepositoryContractError,
} from "./model-assurance-repository.js";
import {
  PublishModelAssuranceDefinition,
  ReadModelAssuranceRecord,
  RecordHumanReview,
  type RecordModelAssuranceCommand,
  type RecordModelAssuranceDependencies,
  type ModelAssurancePublicationKind,
  RecordModelAssuranceExecution,
} from "./record-model-assurance.js";

interface PublicVector {
  readonly input: { readonly definition: Record<string, unknown>; readonly scope: EvidenceScope };
}

interface UseCaseVector {
  readonly capability: "evaluation:human:review" | "evaluation:manage" | "evaluation:model:run";
  readonly expectedId: string;
  readonly filename: string;
  readonly kind: Exclude<ModelAssuranceRecordKind, "model_assurance_assessment">;
  readonly principalId: string;
  readonly timestamp: string;
}

const vectors: readonly UseCaseVector[] = [
  {
    capability: "evaluation:manage",
    expectedId: "mpv_safety_v1",
    filename: "evaluation-model-assurance-definition-v1.json",
    kind: "model_evaluator_profile",
    principalId: "usr_assurance_publisher",
    timestamp: "2026-09-01T23:59:59.000Z",
  },
  {
    capability: "evaluation:manage",
    expectedId: "evv_model_safety_v1",
    filename: "evaluation-model-assisted-spec-definition-v1.json",
    kind: "model_assisted_evaluator",
    principalId: "usr_assurance_publisher",
    timestamp: "2026-09-02T00:04:59.000Z",
  },
  {
    capability: "evaluation:manage",
    expectedId: "ind_model_safety_v1",
    filename: "evaluation-independence-definition-v1.json",
    kind: "independence_declaration",
    principalId: "usr_assurance_manager",
    timestamp: "2026-09-02T00:10:01.000Z",
  },
  {
    capability: "evaluation:manage",
    expectedId: "cal_model_safety_v1",
    filename: "evaluation-calibration-definition-v1.json",
    kind: "calibration_report",
    principalId: "usr_assurance_manager",
    timestamp: "2026-09-02T00:20:01.000Z",
  },
  {
    capability: "evaluation:manage",
    expectedId: "blv_safety_v1",
    filename: "evaluation-blinded-plan-definition-v1.json",
    kind: "blinded_evaluation_plan",
    principalId: "usr_assurance_publisher",
    timestamp: "2026-09-02T00:29:59.000Z",
  },
  {
    capability: "evaluation:model:run",
    expectedId: "blr_safety_v1",
    filename: "evaluation-blinded-result-definition-v1.json",
    kind: "blinded_evaluation_result",
    principalId: "wrk_model_runner",
    timestamp: "2026-09-02T00:45:02.000Z",
  },
  {
    capability: "evaluation:model:run",
    expectedId: "crq_observation_safety_v1",
    filename: "evaluation-independent-critique-definition-v1.json",
    kind: "independent_critique",
    principalId: "wrk_critique_runner",
    timestamp: "2026-09-02T01:01:01.000Z",
  },
  {
    capability: "evaluation:manage",
    expectedId: "hrv_agent_safety_v1",
    filename: "evaluation-human-review-protocol-definition-v1.json",
    kind: "human_review_protocol",
    principalId: "usr_assurance_publisher",
    timestamp: "2026-09-02T01:59:59.000Z",
  },
  {
    capability: "evaluation:manage",
    expectedId: "hri_reviewer_v1",
    filename: "evaluation-human-reviewer-independence-definition-v1.json",
    kind: "human_reviewer_independence",
    principalId: "usr_assurance_manager",
    timestamp: "2026-09-02T02:30:01.000Z",
  },
  {
    capability: "evaluation:human:review",
    expectedId: "hrr_agent_safety_reviewer_one",
    filename: "evaluation-human-review-record-definition-v1.json",
    kind: "human_review_record",
    principalId: "usr_independent_reviewer",
    timestamp: "2026-09-02T03:20:01.000Z",
  },
  {
    capability: "evaluation:manage",
    expectedId: "mqv_model_safety_v1",
    filename: "evaluation-model-qualification-suite-definition-v1.json",
    kind: "model_qualification_suite",
    principalId: "usr_assurance_publisher",
    timestamp: "2026-09-02T03:59:59.000Z",
  },
  {
    capability: "evaluation:model:run",
    expectedId: "mqr_model_safety_v1",
    filename: "evaluation-model-qualification-report-definition-v1.json",
    kind: "model_qualification_report",
    principalId: "wrk_model_qualification_runner",
    timestamp: "2026-09-02T05:30:01.000Z",
  },
] as const;

function publicVector(filename: string): PublicVector {
  const document = JSON.parse(
    readFileSync(new URL(`../../../contracts/vectors/${filename}`, import.meta.url), "utf8"),
  ) as { readonly vectors: readonly PublicVector[] };
  const value = document.vectors[0];
  if (!value) throw new Error(`Expected vector ${filename}`);
  return value;
}

function principal(
  vector: UseCaseVector,
  overrides: Partial<PrincipalContext> = {},
): PrincipalContext {
  const definition = publicVector(vector.filename).input.definition;
  const reviewer = definition.reviewer as
    | {
        readonly authenticatedAt: string;
        readonly authenticationMethod: "api_key" | "development" | "oidc" | "service_token";
        readonly credentialId: string;
        readonly requestId: string;
      }
    | undefined;
  return {
    authentication: {
      authenticatedAt: reviewer?.authenticatedAt ?? "2026-09-01T23:50:00.000Z",
      ...(reviewer ? { credentialId: reviewer.credentialId } : {}),
      method: reviewer?.authenticationMethod ?? "development",
    },
    capabilities: [vector.capability, "evaluation:read"],
    principalId: vector.principalId,
    principalType: vector.capability === "evaluation:model:run" ? "workload" : "user",
    requestId: reviewer?.requestId ?? `req_${vector.expectedId}`,
    resourceScope: { mode: "tenant" },
    roles: vector.capability === "evaluation:model:run" ? ["member"] : ["admin"],
    tenantId: publicVector(vector.filename).input.scope.tenantId,
    ...overrides,
  };
}

function command(
  vector: UseCaseVector,
): RecordModelAssuranceCommand<ModelAssurancePublicationKind> {
  const value = publicVector(vector.filename);
  return {
    definition: structuredClone(value.input.definition) as never,
    environmentId: value.input.scope.environmentId,
    kind: vector.kind,
    principal: principal(vector),
    projectId: value.input.scope.projectId,
    recordId: vector.expectedId,
  };
}

class RecordingRepository implements ModelAssuranceRepository {
  readonly records = new Map<string, ModelAssuranceRecord>();

  async find<K extends ModelAssuranceRecordKind>(
    _scope: EvidenceScope,
    kind: K,
    recordId: string,
  ): Promise<ModelAssuranceRecordByKind[K] | null> {
    return (structuredClone(this.records.get(`${kind}:${recordId}`)) ?? null) as
      | ModelAssuranceRecordByKind[K]
      | null;
  }

  async publish<K extends ModelAssuranceRecordKind>(
    kind: K,
    candidate: ModelAssuranceRecordByKind[K],
  ): Promise<{ readonly created: boolean; readonly record: ModelAssuranceRecordByKind[K] }> {
    const recordId = vectors.find(({ kind: candidateKind, expectedId }) => {
      return candidateKind === kind && Object.values(candidate).includes(expectedId);
    })?.expectedId;
    if (!recordId) throw new Error(`Missing test id for ${kind}`);
    const key = `${kind}:${recordId}`;
    const existing = this.records.get(key);
    if (existing) {
      return { created: false, record: structuredClone(existing) as ModelAssuranceRecordByKind[K] };
    }
    this.records.set(key, structuredClone(candidate));
    return { created: true, record: structuredClone(candidate) };
  }
}

function dependencies(vector: UseCaseVector, repository = new RecordingRepository()) {
  return {
    clock: new FixedClock(new Date(vector.timestamp)),
    repository,
  } satisfies RecordModelAssuranceDependencies;
}

async function execute(
  vector: UseCaseVector,
  value: RecordModelAssuranceCommand<ModelAssurancePublicationKind>,
  deps: RecordModelAssuranceDependencies,
) {
  if (vector.capability === "evaluation:human:review") {
    return new RecordHumanReview(deps).execute(value as never);
  }
  if (vector.capability === "evaluation:model:run") {
    return new RecordModelAssuranceExecution(deps).execute(value as never);
  }
  return new PublishModelAssuranceDefinition(deps).execute(value as never);
}

describe("model-assurance recording use cases", () => {
  it("binds server scope, time, actor, digest, and exact route for every public definition", async () => {
    for (const vector of vectors) {
      const result = await execute(vector, command(vector), dependencies(vector));
      expect(result.created).toBe(true);
      expect(result.record).toMatchObject({
        definitionSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        scope: publicVector(vector.filename).input.scope,
      });
      if (
        [
          "blinded_evaluation_plan",
          "human_review_protocol",
          "model_assisted_evaluator",
          "model_evaluator_profile",
          "model_qualification_suite",
        ].includes(vector.kind)
      ) {
        expect(result.record).toMatchObject({
          publishedAt: vector.timestamp,
          publishedByPrincipalId: vector.principalId,
        });
      } else {
        expect(result.record).toMatchObject({ recordedAt: vector.timestamp });
      }
      if (
        vector.capability === "evaluation:model:run" &&
        vector.kind !== "model_qualification_report"
      ) {
        expect(result.record).toMatchObject({ recordedByPrincipalId: vector.principalId });
      }
    }
  });

  it("returns the authoritative original on an identical retry and exact read", async () => {
    const vector = vectors[0];
    if (!vector) throw new Error("Expected a vector");
    const repository = new RecordingRepository();
    const deps = dependencies(vector, repository);
    const input = command(vector);
    const first = await execute(vector, input, deps);
    const retry = await execute(vector, input, deps);
    expect(retry).toEqual({ created: false, record: first.record });
    await expect(
      new ReadModelAssuranceRecord(repository).execute({
        environmentId: input.environmentId,
        kind: vector.kind,
        principal: input.principal,
        projectId: input.projectId,
        recordId: input.recordId,
      }),
    ).resolves.toEqual(first.record);
  });

  it("authorizes before clock and storage and keeps human review user-only", async () => {
    const human = vectors.find(({ kind }) => kind === "human_review_record");
    if (!human) throw new Error("Expected human review vector");
    const input = command(human);
    let storageAccessed = false;
    const repository = new Proxy(new RecordingRepository(), {
      get(target, property, receiver) {
        if (property === "find" || property === "publish") storageAccessed = true;
        return Reflect.get(target, property, receiver);
      },
    });
    const deps = {
      clock: {
        now: () => {
          throw new Error("clock must not be read");
        },
      },
      repository,
    } satisfies RecordModelAssuranceDependencies;
    await expect(
      new RecordHumanReview(deps).execute({
        ...input,
        principal: principal(human, { capabilities: ["evaluation:read"] }),
      } as never),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      new RecordHumanReview(deps).execute({
        ...input,
        principal: principal(human, { principalType: "service" }),
      } as never),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(storageAccessed).toBe(false);
  });

  it("rejects route conflicts, actor substitution, semantic conflicts, and corrupt adapters", async () => {
    const execution = vectors.find(({ kind }) => kind === "model_qualification_report");
    if (!execution) throw new Error("Expected qualification vector");
    const routeMismatch = { ...command(execution), recordId: "mqr_other" };
    await expect(execute(execution, routeMismatch, dependencies(execution))).rejects.toBeInstanceOf(
      InvalidModelAssuranceRecordInputError,
    );

    const actorMismatch = {
      ...command(execution),
      principal: principal(execution, { principalId: "wrk_other" }),
    };
    await expect(execute(execution, actorMismatch, dependencies(execution))).rejects.toBeInstanceOf(
      InvalidModelAssuranceRecordInputError,
    );

    const human = vectors.find(({ kind }) => kind === "human_review_record");
    if (!human) throw new Error("Expected human review vector");
    const substitutedSession = {
      ...command(human),
      principal: principal(human, {
        authentication: {
          authenticatedAt: "2026-09-02T03:00:00.000Z",
          credentialId: "oidc_other_credential",
          method: "oidc",
        },
      }),
    };
    await expect(execute(human, substitutedSession, dependencies(human))).rejects.toBeInstanceOf(
      InvalidModelAssuranceRecordInputError,
    );

    const profileVector = vectors[0];
    if (!profileVector) throw new Error("Expected profile vector");
    const repository = new RecordingRepository();
    const deps = dependencies(profileVector, repository);
    const first = command(profileVector);
    await execute(profileVector, first, deps);
    const conflicting = command(profileVector);
    (conflicting.definition as { knownLimitations: string[] }).knownLimitations = [
      "A changed immutable limitation",
    ];
    await expect(execute(profileVector, conflicting, deps)).rejects.toBeInstanceOf(
      ModelAssuranceRecordConflictError,
    );

    const corrupt = new Proxy(repository, {
      get(target, property, receiver) {
        if (property === "find") return async () => ({ broken: true });
        return Reflect.get(target, property, receiver);
      },
    });
    await expect(
      new ReadModelAssuranceRecord(corrupt).execute({
        environmentId: first.environmentId,
        kind: profileVector.kind,
        principal: first.principal,
        projectId: first.projectId,
        recordId: first.recordId,
      }),
    ).rejects.toBeInstanceOf(ModelAssuranceRepositoryContractError);
  });
});
