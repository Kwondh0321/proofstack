import { readFileSync } from "node:fs";
import type { PrincipalContext } from "@proofstack/contracts";
import type {
  ModelAssuranceRecord,
  ModelAssuranceRepository,
  RecordModelAssuranceCommand,
} from "@proofstack/core";
import type { Mock } from "vitest";
import { vi } from "vitest";

export type WorkerKind =
  | "blinded_evaluation_result"
  | "independent_critique"
  | "model_qualification_report";

interface StoredVector {
  readonly input: { readonly definition: Record<string, unknown> };
}

const vectorFiles: Record<WorkerKind, string> = {
  blinded_evaluation_result: "evaluation-blinded-result-definition-v1.json",
  independent_critique: "evaluation-independent-critique-definition-v1.json",
  model_qualification_report: "evaluation-model-qualification-report-definition-v1.json",
};

const idFields: Record<WorkerKind, string> = {
  blinded_evaluation_result: "resultId",
  independent_critique: "critiqueId",
  model_qualification_report: "reportId",
};

export const workerKinds = Object.keys(vectorFiles) as WorkerKind[];

export function servicePrincipal(overrides: Partial<PrincipalContext> = {}): PrincipalContext {
  return {
    authentication: {
      authenticatedAt: "2026-09-02T00:00:00.000Z",
      credentialId: "cred_model_evaluation_worker",
      method: "service_token",
    },
    capabilities: ["evaluation:model:run"],
    principalId: "svc_model_evaluator",
    principalType: "service",
    requestId: "req_model_evaluation_worker",
    resourceScope: { mode: "tenant" },
    roles: ["member"],
    tenantId: "ten_assurance",
    ...overrides,
  };
}

export function workerCommand<Kind extends WorkerKind>(
  kind: Kind,
  principal: PrincipalContext = servicePrincipal(),
): RecordModelAssuranceCommand<Kind> {
  const document = JSON.parse(
    readFileSync(
      new URL(`../../../packages/contracts/vectors/${vectorFiles[kind]}`, import.meta.url),
      "utf8",
    ),
  ) as { readonly vectors: readonly StoredVector[] };
  const definition = structuredClone(document.vectors[0]?.input.definition);
  if (!definition) throw new TypeError(`Missing ${kind} contract vector`);
  if (kind === "model_qualification_report") {
    definition["executedByPrincipalId"] = principal.principalId;
  }
  const recordId = definition[idFields[kind]];
  if (typeof recordId !== "string") throw new TypeError(`Missing ${kind} identifier`);
  return {
    definition: definition as never,
    environmentId: "env_assurance",
    kind,
    principal,
    projectId: "prj_assurance",
    recordId,
  };
}

export function passThroughRepository(
  onAccess?: (property: string) => void,
): ModelAssuranceRepository {
  return new Proxy(
    {},
    {
      get(_target, property) {
        const name = String(property);
        onAccess?.(name);
        if (name === "find") return async () => null;
        if (name === "publish") {
          return async (_kind: string, record: ModelAssuranceRecord) => ({
            created: true,
            record: structuredClone(record),
          });
        }
        return undefined;
      },
    },
  ) as ModelAssuranceRepository;
}

export function repositoryFactory(repository: ModelAssuranceRepository): Mock {
  return vi.fn(() => repository);
}
