import { readFileSync } from "node:fs";
import type { PrincipalContext } from "@proofstack/contracts";
import type {
  EvaluationRecord,
  EvaluationRepository,
  RecordEvaluationCommand,
} from "@proofstack/core";
import type { Mock } from "vitest";
import { vi } from "vitest";

type WorkerKind =
  | "evaluation_aggregate"
  | "evaluation_run_result"
  | "qualification_report"
  | "raw_observation";

interface StoredVector {
  readonly input: { readonly definition: Record<string, unknown> };
  readonly kind: string;
}

const idFields: Record<WorkerKind, string> = {
  evaluation_aggregate: "aggregateId",
  evaluation_run_result: "resultId",
  qualification_report: "qualificationReportId",
  raw_observation: "observationId",
};

const vectorFiles = [
  "evaluation-qualification-definition-v1.json",
  "evaluation-run-definition-v1.json",
  "evaluation-assessment-definition-v1.json",
] as const;

const vectors = vectorFiles.flatMap(
  (file) =>
    (
      JSON.parse(
        readFileSync(
          new URL(`../../../packages/contracts/vectors/${file}`, import.meta.url),
          "utf8",
        ),
      ) as { readonly vectors: readonly StoredVector[] }
    ).vectors,
);

export const workerKinds: readonly WorkerKind[] = [
  "qualification_report",
  "raw_observation",
  "evaluation_run_result",
  "evaluation_aggregate",
] as const satisfies readonly WorkerKind[];

export function servicePrincipal(overrides: Partial<PrincipalContext> = {}): PrincipalContext {
  return {
    authentication: {
      authenticatedAt: "2026-09-02T00:00:00.000Z",
      credentialId: "cred_evaluation_worker",
      method: "service_token",
    },
    capabilities: ["evaluation:run"],
    principalId: "svc_evaluator",
    principalType: "service",
    requestId: "req_evaluation_worker",
    resourceScope: { mode: "tenant" },
    roles: ["member"],
    tenantId: "ten_evaluation",
    ...overrides,
  };
}

export function workerCommand<Kind extends WorkerKind>(
  kind: Kind,
  principal: PrincipalContext = servicePrincipal(),
): RecordEvaluationCommand<Kind> {
  const vector = vectors.find((candidate) => candidate.kind === kind);
  if (!vector) throw new TypeError(`Missing ${kind} contract vector`);
  const definition = structuredClone(vector.input.definition);
  const recordId = definition[idFields[kind]];
  if (typeof recordId !== "string") throw new TypeError(`Missing ${kind} record identifier`);
  return {
    definition: definition as never,
    environmentId: "env_evaluation",
    kind,
    principal,
    projectId: "prj_evaluation",
    recordId,
  };
}

export function passThroughRepository(onAccess?: (property: string) => void): EvaluationRepository {
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

export function repositoryFactory(repository: EvaluationRepository): Mock {
  return vi.fn(() => repository);
}
