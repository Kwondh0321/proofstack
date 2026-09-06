import { readFileSync } from "node:fs";
import {
  RELEASE_CANDIDATE_SCHEMA_VERSION,
  type EvidenceScope,
  type ReleaseCandidate,
  type ReleaseCandidateDefinition,
  type ReleaseCandidateReference,
} from "@proofstack/contracts";
import { digestReleaseCandidateDefinition } from "../release/release-candidate-record-validation.js";
import type { ReleaseCandidateRepository } from "../release/release-candidate-repository.js";
import { MemoryReleaseCandidateRepository } from "./memory-release-candidate-repository.js";

interface VectorDocument {
  readonly vectors: readonly {
    readonly input: { readonly definition: ReleaseCandidateDefinition };
  }[];
}

const document = JSON.parse(
  readFileSync(
    new URL("../../../contracts/vectors/release-candidate-definition-v1.json", import.meta.url),
    "utf8",
  ),
) as VectorDocument;

function requireCandidateTemplate(): ReleaseCandidateDefinition {
  const candidate = document.vectors[0]?.input.definition;
  if (!candidate) throw new Error("Expected a release candidate definition vector");
  return candidate;
}

const candidateTemplate: ReleaseCandidateDefinition = requireCandidateTemplate();

export function releaseCandidateFixtureScope(namespace: string, suffix = "primary"): EvidenceScope {
  return {
    environmentId: `env_${namespace}_${suffix}`,
    projectId: `prj_${namespace}_${suffix}`,
    tenantId: `ten_${namespace}`,
  };
}

export function releaseCandidateFixture(
  namespace: string,
  recordScope: EvidenceScope,
  options: {
    readonly candidateId?: string;
    readonly candidateVersionId?: string;
    readonly predecessor?: ReleaseCandidateReference;
    readonly purpose?: string;
    readonly version?: string;
  } = {},
): ReleaseCandidate {
  const candidateId = options.candidateId ?? `candidate_${namespace}`;
  const definition = {
    ...structuredClone(candidateTemplate),
    candidateId,
    candidateVersionId: options.candidateVersionId ?? `${candidateId}_${options.version ?? "v1"}`,
    ...(options.predecessor ? { predecessor: structuredClone(options.predecessor) } : {}),
    target: {
      ...structuredClone(candidateTemplate.target),
      environmentId: recordScope.environmentId,
      purpose: options.purpose ?? "Repository conformance release candidate.",
    },
  } satisfies ReleaseCandidateDefinition;
  return {
    ...definition,
    createdAt: "2026-09-06T15:00:00.000Z",
    createdByPrincipalId: `principal_${namespace}`,
    definitionSha256: digestReleaseCandidateDefinition(recordScope, definition),
    schemaVersion: RELEASE_CANDIDATE_SCHEMA_VERSION,
    scope: structuredClone(recordScope),
  };
}

function reference(candidate: ReleaseCandidate): ReleaseCandidateReference {
  return {
    candidateId: candidate.candidateId,
    candidateVersionId: candidate.candidateVersionId,
    definitionSha256: candidate.definitionSha256,
  };
}

export interface ReleaseCandidateRepositoryTestHarness {
  readonly candidate: ReleaseCandidate;
  readonly conflictingPredecessor: ReleaseCandidate;
  readonly dispose?: () => Promise<void>;
  readonly lineageProbe: ReleaseCandidate;
  readonly otherScope: EvidenceScope;
  readonly recordConflict: ReleaseCandidate;
  readonly repository: ReleaseCandidateRepository;
  readonly resourceConflict: ReleaseCandidate;
  readonly scope: EvidenceScope;
  readonly successor: ReleaseCandidate;
  readonly unrelatedCandidate: ReleaseCandidate;
}

export function createReleaseCandidateRepositoryTestHarness(
  namespace: string,
): ReleaseCandidateRepositoryTestHarness {
  const scope = releaseCandidateFixtureScope(namespace);
  const candidate = releaseCandidateFixture(namespace, scope);
  const successor = releaseCandidateFixture(namespace, scope, {
    predecessor: reference(candidate),
    version: "v2",
  });
  const unrelatedCandidate = releaseCandidateFixture(`${namespace}_unrelated`, scope);
  const otherScope = releaseCandidateFixtureScope(namespace, "other");
  return {
    candidate,
    conflictingPredecessor: releaseCandidateFixture(namespace, scope, {
      predecessor: {
        candidateId: candidate.candidateId,
        candidateVersionId: unrelatedCandidate.candidateVersionId,
        definitionSha256: unrelatedCandidate.definitionSha256,
      },
      version: "v4",
    }),
    lineageProbe: releaseCandidateFixture(namespace, scope, {
      predecessor: {
        candidateId: candidate.candidateId,
        candidateVersionId: `${candidate.candidateId}_missing`,
        definitionSha256: "f".repeat(64),
      },
      version: "v3",
    }),
    otherScope,
    recordConflict: releaseCandidateFixture(namespace, scope, {
      purpose: "Different immutable release candidate semantics.",
    }),
    repository: new MemoryReleaseCandidateRepository(),
    resourceConflict: releaseCandidateFixture(`${namespace}_other_scope`, otherScope, {
      candidateId: candidate.candidateId,
      version: "other_scope_v1",
    }),
    scope,
    successor,
    unrelatedCandidate,
  };
}
