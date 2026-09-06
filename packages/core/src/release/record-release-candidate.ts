import {
  EvidenceScopeSchema,
  OpaqueIdSchema,
  type PrincipalContext,
  PrincipalContextSchema,
  PublishReleaseCandidateRequestSchema,
  RELEASE_CANDIDATE_SCHEMA_VERSION,
  type ReleaseCandidate,
  type ReleaseCandidateDefinition,
  ReleaseCandidateDefinitionSchema,
  UtcMillisecondTimestampSchema,
} from "@proofstack/contracts";
import { requireCapability, requireEnvironmentAccess } from "../auth/authorization.js";
import type { Clock } from "../clock.js";
import {
  InvalidReleaseCandidateCommandError,
  ReleaseCandidateLineageError,
  ReleaseCandidateNotFoundError,
  ReleaseCandidateRepositoryContractError,
  ReleaseCandidateSourceUnavailableError,
  ReleaseCandidateVersionConflictError,
} from "./release-candidate-errors.js";
import {
  digestReleaseCandidateDefinition,
  releaseCandidateReference,
  validateReleaseCandidateRecord,
} from "./release-candidate-record-validation.js";
import type {
  PublishReleaseCandidateResult,
  ReleaseCandidateRepository,
} from "./release-candidate-repository.js";
import {
  releaseCandidateSourceReferenceId,
  releaseCandidateSourceReferences,
  type ReleaseCandidateSourceReference,
} from "./release-candidate-source-references.js";

interface ReleaseCandidateRoute {
  readonly environmentId: string;
  readonly principal: PrincipalContext;
  readonly projectId: string;
}

export interface PublishReleaseCandidateCommand extends ReleaseCandidateRoute {
  readonly candidateId: string;
  readonly candidateVersionId: string;
  readonly input: unknown;
}

export interface ReadReleaseCandidateCommand extends ReleaseCandidateRoute {
  readonly candidateVersionId: string;
}

export interface ReleaseCandidateSourceResolver {
  /** Reads one exact immutable source in the supplied scope; it performs no policy evaluation. */
  isAvailable(
    scope: ReleaseCandidate["scope"],
    reference: ReleaseCandidateSourceReference,
  ): Promise<boolean>;
}

export interface PublishReleaseCandidateDependencies {
  readonly clock: Clock;
  readonly repository: ReleaseCandidateRepository;
  readonly sourceResolver: ReleaseCandidateSourceResolver;
}

function invalidCommand(message: string, cause?: unknown): InvalidReleaseCandidateCommandError {
  return new InvalidReleaseCandidateCommandError(
    message,
    cause === undefined ? undefined : { cause },
  );
}

function authorizedScope(
  command: ReleaseCandidateRoute,
  capability: "release:manage" | "release:read",
): { readonly principal: PrincipalContext; readonly scope: ReleaseCandidate["scope"] } {
  let principal: PrincipalContext;
  try {
    principal = PrincipalContextSchema.parse(command.principal);
  } catch (cause) {
    throw invalidCommand("Release candidate principal is invalid", cause);
  }
  requireCapability(principal, capability);
  requireEnvironmentAccess(principal, command.projectId, command.environmentId);
  const scope = EvidenceScopeSchema.safeParse({
    environmentId: command.environmentId,
    projectId: command.projectId,
    tenantId: principal.tenantId,
  });
  if (!scope.success) throw invalidCommand("Release candidate route is invalid", scope.error);
  return { principal, scope: scope.data };
}

function sameScope(left: ReleaseCandidate["scope"], right: ReleaseCandidate["scope"]): boolean {
  return (
    left.tenantId === right.tenantId &&
    left.projectId === right.projectId &&
    left.environmentId === right.environmentId
  );
}

function validateRepositoryCandidate(
  input: unknown,
  scope: ReleaseCandidate["scope"],
  candidateVersionId: string,
): ReleaseCandidate {
  let candidate: ReleaseCandidate;
  try {
    candidate = validateReleaseCandidateRecord(input);
  } catch (cause) {
    throw new ReleaseCandidateRepositoryContractError(
      "Release candidate repository returned an invalid record",
      { cause },
    );
  }
  if (candidate.candidateVersionId !== candidateVersionId || !sameScope(candidate.scope, scope)) {
    throw new ReleaseCandidateRepositoryContractError(
      "Release candidate repository substituted a record outside the exact query",
    );
  }
  return candidate;
}

function validatePublicationResult(
  input: unknown,
  scope: ReleaseCandidate["scope"],
  candidateVersionId: string,
): PublishReleaseCandidateResult {
  if (typeof input !== "object" || input === null) {
    throw new ReleaseCandidateRepositoryContractError(
      "Release candidate repository returned an invalid publication result",
    );
  }
  let keys: readonly PropertyKey[];
  let candidate: unknown;
  let created: unknown;
  try {
    keys = Reflect.ownKeys(input);
    candidate = Reflect.get(input, "candidate");
    created = Reflect.get(input, "created");
  } catch (cause) {
    throw new ReleaseCandidateRepositoryContractError(
      "Release candidate repository result is unreadable",
      { cause },
    );
  }
  if (
    keys.length !== 2 ||
    !keys.includes("candidate") ||
    !keys.includes("created") ||
    typeof created !== "boolean"
  ) {
    throw new ReleaseCandidateRepositoryContractError(
      "Release candidate repository returned an invalid publication result",
    );
  }
  return { candidate: validateRepositoryCandidate(candidate, scope, candidateVersionId), created };
}

function serverTimestamp(clock: Clock): string {
  let value: string;
  try {
    value = clock.now().toISOString();
  } catch (cause) {
    throw invalidCommand("Release candidate clock is invalid", cause);
  }
  const parsed = UtcMillisecondTimestampSchema.safeParse(value);
  if (!parsed.success) throw invalidCommand("Release candidate clock is invalid", parsed.error);
  return parsed.data;
}

async function exactPredecessor(
  repository: ReleaseCandidateRepository,
  scope: ReleaseCandidate["scope"],
  candidateId: string,
  candidateVersionId: string,
  predecessorVersionId: string,
) {
  const input = await repository.findReleaseCandidate(structuredClone(scope), predecessorVersionId);
  if (input === null) {
    throw new ReleaseCandidateLineageError(candidateVersionId, predecessorVersionId);
  }
  const predecessor = validateRepositoryCandidate(input, scope, predecessorVersionId);
  if (predecessor.candidateId !== candidateId) {
    throw new ReleaseCandidateLineageError(candidateVersionId, predecessorVersionId);
  }
  return releaseCandidateReference(predecessor);
}

async function resolveSources(
  resolver: ReleaseCandidateSourceResolver,
  scope: ReleaseCandidate["scope"],
  definition: ReleaseCandidateDefinition,
): Promise<void> {
  for (const reference of releaseCandidateSourceReferences(definition)) {
    let available: boolean;
    try {
      available = await resolver.isAvailable(structuredClone(scope), structuredClone(reference));
    } catch (cause) {
      throw new ReleaseCandidateSourceUnavailableError(
        reference.kind,
        releaseCandidateSourceReferenceId(reference),
        { cause },
      );
    }
    if (!available) {
      throw new ReleaseCandidateSourceUnavailableError(
        reference.kind,
        releaseCandidateSourceReferenceId(reference),
      );
    }
  }
}

export class PublishReleaseCandidate {
  constructor(private readonly dependencies: PublishReleaseCandidateDependencies) {}

  async execute(command: PublishReleaseCandidateCommand): Promise<PublishReleaseCandidateResult> {
    const { principal, scope } = authorizedScope(command, "release:manage");
    const candidateId = OpaqueIdSchema.safeParse(command.candidateId);
    const candidateVersionId = OpaqueIdSchema.safeParse(command.candidateVersionId);
    const input = PublishReleaseCandidateRequestSchema.safeParse(command.input);
    if (!candidateId.success || !candidateVersionId.success || !input.success) {
      throw invalidCommand(
        "Release candidate request is invalid",
        !candidateId.success
          ? candidateId.error
          : !candidateVersionId.success
            ? candidateVersionId.error
            : input.error,
      );
    }
    if (input.data.candidateVersionId !== candidateVersionId.data) {
      throw invalidCommand("Release candidate route and immutable identifier do not match");
    }

    const { predecessorVersionId, ...requestDefinition } = input.data;
    const predecessor = predecessorVersionId
      ? await exactPredecessor(
          this.dependencies.repository,
          scope,
          candidateId.data,
          candidateVersionId.data,
          predecessorVersionId,
        )
      : undefined;
    let definition: ReleaseCandidateDefinition;
    try {
      definition = ReleaseCandidateDefinitionSchema.parse({
        ...requestDefinition,
        candidateId: candidateId.data,
        ...(predecessor ? { predecessor } : {}),
      });
    } catch (cause) {
      throw invalidCommand("Release candidate definition is invalid", cause);
    }
    const definitionSha256 = digestReleaseCandidateDefinition(scope, definition);

    const existingInput = await this.dependencies.repository.findReleaseCandidate(
      structuredClone(scope),
      candidateVersionId.data,
    );
    if (existingInput !== null) {
      const existing = validateRepositoryCandidate(existingInput, scope, candidateVersionId.data);
      if (existing.definitionSha256 !== definitionSha256) {
        throw new ReleaseCandidateVersionConflictError(candidateVersionId.data);
      }
      return { candidate: structuredClone(existing), created: false };
    }

    await resolveSources(this.dependencies.sourceResolver, scope, definition);
    const candidate = validateReleaseCandidateRecord({
      ...definition,
      createdAt: serverTimestamp(this.dependencies.clock),
      createdByPrincipalId: principal.principalId,
      definitionSha256,
      schemaVersion: RELEASE_CANDIDATE_SCHEMA_VERSION,
      scope,
    });
    const result = validatePublicationResult(
      await this.dependencies.repository.publishReleaseCandidate(structuredClone(candidate)),
      scope,
      candidateVersionId.data,
    );
    if (result.candidate.definitionSha256 !== definitionSha256) {
      throw new ReleaseCandidateRepositoryContractError(
        "Release candidate publication substituted immutable semantics",
      );
    }
    return { candidate: structuredClone(result.candidate), created: result.created };
  }
}

export class ReadReleaseCandidate {
  constructor(private readonly repository: ReleaseCandidateRepository) {}

  async execute(command: ReadReleaseCandidateCommand): Promise<ReleaseCandidate> {
    const { scope } = authorizedScope(command, "release:read");
    const candidateVersionId = OpaqueIdSchema.safeParse(command.candidateVersionId);
    if (!candidateVersionId.success) {
      throw invalidCommand("Release candidate route is invalid", candidateVersionId.error);
    }
    const input = await this.repository.findReleaseCandidate(
      structuredClone(scope),
      candidateVersionId.data,
    );
    if (input === null) throw new ReleaseCandidateNotFoundError(candidateVersionId.data);
    return structuredClone(validateRepositoryCandidate(input, scope, candidateVersionId.data));
  }
}
