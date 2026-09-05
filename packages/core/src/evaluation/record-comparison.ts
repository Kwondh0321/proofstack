import type {
  ComparisonDefinition,
  ComparisonEvidenceSnapshot,
  ComparisonEvidenceSnapshotDefinition,
  ComparisonResult,
  CreateComparisonEvidenceSnapshotRequest,
  DeriveComparisonResultRequest,
  EvidenceScope,
  PrincipalContext,
  PublishComparisonDefinitionRequest,
} from "@proofstack/contracts";
import {
  COMPARISON_DEFINITION_SCHEMA_VERSION,
  COMPARISON_EVIDENCE_SNAPSHOT_SCHEMA_VERSION,
  COMPARISON_RESULT_SCHEMA_VERSION,
  ComparisonDefinitionRecordSchema,
  ComparisonDefinitionSchema,
  ComparisonEvidenceSnapshotDefinitionSchema,
  ComparisonEvidenceSnapshotSchema,
  ComparisonResultSchema,
  CreateComparisonEvidenceSnapshotRequestSchema,
  DeriveComparisonResultRequestSchema,
  EvidenceScopeSchema,
  OpaqueIdSchema,
  PrincipalContextSchema,
  PublishComparisonDefinitionRequestSchema,
  UtcMillisecondTimestampSchema,
} from "@proofstack/contracts";
import { requireCapability, requireEnvironmentAccess } from "../auth/authorization.js";
import type { Clock } from "../clock.js";
import { deriveComparisonResultDefinition } from "./derive-comparison-result.js";
import {
  digestComparisonRecordDefinition,
  validateComparisonRecord,
} from "./comparison-record-validation.js";
import {
  ComparisonLineageError,
  ComparisonRecordConflictError,
  ComparisonRecordNotFoundError,
  ComparisonRepositoryContractError,
  ComparisonSourceUnavailableError,
  InvalidComparisonRecordInputError,
} from "./comparison-repository-errors.js";
import type {
  ComparisonRecord,
  ComparisonRecordKind,
  ComparisonRepository,
  PublishComparisonRecordResult,
} from "./comparison-repository.js";

interface ComparisonRoute {
  readonly environmentId: string;
  readonly principal: PrincipalContext;
  readonly projectId: string;
}

export interface PublishComparisonDefinitionCommand extends ComparisonRoute {
  readonly comparisonId: string;
  /** Exact HTTP route binding when invoked through a transport adapter. */
  readonly comparisonVersionId?: string;
  readonly input: PublishComparisonDefinitionRequest;
}

export interface CreateComparisonEvidenceSnapshotCommand extends ComparisonRoute {
  readonly input: CreateComparisonEvidenceSnapshotRequest;
  /** Exact HTTP route binding when invoked through a transport adapter. */
  readonly snapshotId?: string;
}

export interface DeriveComparisonResultCommand extends ComparisonRoute {
  readonly input: DeriveComparisonResultRequest;
  /** Exact HTTP route binding when invoked through a transport adapter. */
  readonly resultId?: string;
}

export interface ReadComparisonRecordCommand extends ComparisonRoute {
  readonly kind: ComparisonRecordKind;
  readonly recordId: string;
}

export type ComparisonEvidenceResolution = Omit<
  ComparisonEvidenceSnapshotDefinition,
  "comparison" | "role" | "snapshotId"
>;

export interface ResolveComparisonEvidenceCommand {
  readonly comparison: ComparisonDefinition;
  readonly role: "baseline" | "candidate";
  readonly scope: EvidenceScope;
}

/**
 * Server-side source resolver. Implementations must read exact immutable sources and return only a
 * bounded projection; HTTP callers never supply snapshot values, omissions, or integrity state.
 */
export interface ComparisonEvidenceResolver {
  resolve(command: ResolveComparisonEvidenceCommand): Promise<ComparisonEvidenceResolution>;
}

export interface RecordComparisonDependencies {
  readonly clock: Clock;
  readonly repository: ComparisonRepository;
}

export interface CreateComparisonEvidenceSnapshotDependencies extends RecordComparisonDependencies {
  readonly evidenceResolver: ComparisonEvidenceResolver;
}

export interface RecordComparisonResult<Record extends ComparisonRecord> {
  readonly created: boolean;
  readonly record: Record;
}

function invalidInput(message: string, cause: unknown): InvalidComparisonRecordInputError {
  return new InvalidComparisonRecordInputError(message, { cause });
}

function authorizedScope(
  command: ComparisonRoute,
  capability: "comparison:manage" | "comparison:read",
): { readonly principal: PrincipalContext; readonly scope: EvidenceScope } {
  let principal: PrincipalContext;
  try {
    principal = PrincipalContextSchema.parse(command.principal);
  } catch (cause) {
    throw invalidInput("Comparison principal is invalid", cause);
  }
  requireCapability(principal, capability);
  requireEnvironmentAccess(principal, command.projectId, command.environmentId);
  const scope = EvidenceScopeSchema.safeParse({
    environmentId: command.environmentId,
    projectId: command.projectId,
    tenantId: principal.tenantId,
  });
  if (!scope.success) throw invalidInput("Comparison route is invalid", scope.error);
  return { principal, scope: scope.data };
}

function serverTimestamp(clock: Clock): string {
  let value: string;
  try {
    value = clock.now().toISOString();
  } catch (cause) {
    throw invalidInput("Comparison clock is invalid", cause);
  }
  const parsed = UtcMillisecondTimestampSchema.safeParse(value);
  if (!parsed.success) throw invalidInput("Comparison clock is invalid", parsed.error);
  return parsed.data;
}

function sameScope(left: EvidenceScope, right: EvidenceScope): boolean {
  return (
    left.tenantId === right.tenantId &&
    left.projectId === right.projectId &&
    left.environmentId === right.environmentId
  );
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function recordId(kind: ComparisonRecordKind, record: ComparisonRecord): string {
  switch (kind) {
    case "comparison_definition":
      return (record as ComparisonDefinition).comparisonVersionId;
    case "comparison_evidence_snapshot":
      return (record as ComparisonEvidenceSnapshot).snapshotId;
    case "comparison_result":
      return (record as ComparisonResult).resultId;
  }
}

async function findRecord(
  repository: ComparisonRepository,
  kind: ComparisonRecordKind,
  scope: EvidenceScope,
  id: string,
): Promise<ComparisonRecord | null> {
  switch (kind) {
    case "comparison_definition":
      return repository.findComparisonDefinition(scope, id);
    case "comparison_evidence_snapshot":
      return repository.findComparisonEvidenceSnapshot(scope, id);
    case "comparison_result":
      return repository.findComparisonResult(scope, id);
  }
}

async function publishRecord(
  repository: ComparisonRepository,
  kind: ComparisonRecordKind,
  record: ComparisonRecord,
): Promise<PublishComparisonRecordResult<ComparisonRecord>> {
  switch (kind) {
    case "comparison_definition":
      return repository.publishComparisonDefinition(record as ComparisonDefinition);
    case "comparison_evidence_snapshot":
      return repository.publishComparisonEvidenceSnapshot(record as ComparisonEvidenceSnapshot);
    case "comparison_result":
      return repository.publishComparisonResult(record as ComparisonResult);
  }
}

function validateRepositoryRecord(
  input: unknown,
  kind: ComparisonRecordKind,
  scope: EvidenceScope,
  id: string,
): ComparisonRecord {
  let record: ComparisonRecord;
  try {
    record = validateComparisonRecord(kind, input);
  } catch (cause) {
    throw new ComparisonRepositoryContractError(
      "Comparison repository returned an invalid record",
      { cause },
    );
  }
  if (recordId(kind, record) !== id || !sameScope(record.scope, scope)) {
    throw new ComparisonRepositoryContractError(
      "Comparison repository substituted a record outside the exact query",
    );
  }
  return record;
}

function validatePublicationResult(
  input: unknown,
  kind: ComparisonRecordKind,
  scope: EvidenceScope,
  id: string,
): PublishComparisonRecordResult<ComparisonRecord> {
  if (typeof input !== "object" || input === null) {
    throw new ComparisonRepositoryContractError("Comparison repository returned an invalid result");
  }
  let keys: readonly PropertyKey[];
  let created: unknown;
  let record: unknown;
  try {
    keys = Reflect.ownKeys(input);
    created = Reflect.get(input, "created");
    record = Reflect.get(input, "record");
  } catch (cause) {
    throw new ComparisonRepositoryContractError("Comparison repository result is unreadable", {
      cause,
    });
  }
  if (
    keys.length !== 2 ||
    !keys.includes("created") ||
    !keys.includes("record") ||
    typeof created !== "boolean"
  ) {
    throw new ComparisonRepositoryContractError("Comparison repository returned an invalid result");
  }
  return { created, record: validateRepositoryRecord(record, kind, scope, id) };
}

async function publishCandidate<Record extends ComparisonRecord>(
  repository: ComparisonRepository,
  kind: ComparisonRecordKind,
  scope: EvidenceScope,
  candidate: Record,
): Promise<RecordComparisonResult<Record>> {
  const id = recordId(kind, candidate);
  const result = validatePublicationResult(
    await publishRecord(repository, kind, structuredClone(candidate)),
    kind,
    scope,
    id,
  );
  if (result.record.definitionSha256 !== candidate.definitionSha256) {
    throw new ComparisonRepositoryContractError("Comparison publication substituted semantics");
  }
  return { created: result.created, record: structuredClone(result.record) as Record };
}

async function exactDefinition(
  repository: ComparisonRepository,
  scope: EvidenceScope,
  reference: {
    readonly comparisonId: string;
    readonly comparisonVersionId: string;
    readonly definitionSha256: string;
  },
): Promise<ComparisonDefinition> {
  const input = await repository.findComparisonDefinition(
    structuredClone(scope),
    reference.comparisonVersionId,
  );
  if (input === null) {
    throw new ComparisonSourceUnavailableError(
      "comparison_definition",
      reference.comparisonVersionId,
    );
  }
  const record = validateRepositoryRecord(
    input,
    "comparison_definition",
    scope,
    reference.comparisonVersionId,
  ) as ComparisonDefinition;
  if (
    record.comparisonId !== reference.comparisonId ||
    record.definitionSha256 !== reference.definitionSha256
  ) {
    throw new ComparisonSourceUnavailableError(
      "comparison_definition",
      reference.comparisonVersionId,
    );
  }
  return record;
}

async function exactSnapshot(
  repository: ComparisonRepository,
  scope: EvidenceScope,
  reference: {
    readonly definitionSha256: string;
    readonly role: "baseline" | "candidate";
    readonly snapshotId: string;
  },
): Promise<ComparisonEvidenceSnapshot> {
  const input = await repository.findComparisonEvidenceSnapshot(
    structuredClone(scope),
    reference.snapshotId,
  );
  if (input === null) {
    throw new ComparisonSourceUnavailableError(
      "comparison_evidence_snapshot",
      reference.snapshotId,
    );
  }
  const record = validateRepositoryRecord(
    input,
    "comparison_evidence_snapshot",
    scope,
    reference.snapshotId,
  ) as ComparisonEvidenceSnapshot;
  if (record.role !== reference.role || record.definitionSha256 !== reference.definitionSha256) {
    throw new ComparisonSourceUnavailableError(
      "comparison_evidence_snapshot",
      reference.snapshotId,
    );
  }
  return record;
}

function exactFixtureKey(fixture: {
  readonly fixtureId: string;
  readonly fixtureVersionId: string;
  readonly definitionSha256: string;
}): string {
  return `${fixture.fixtureId}:${fixture.fixtureVersionId}:${fixture.definitionSha256}`;
}

function exactReplayKey(replay: {
  readonly attemptId: string;
  readonly jobId: string;
  readonly result: { readonly sha256: string };
}): string {
  return `${replay.jobId}:${replay.attemptId}:${replay.result.sha256}`;
}

function assertResolvedSubject(
  comparison: ComparisonDefinition,
  role: "baseline" | "candidate",
  resolution: ComparisonEvidenceResolution,
): void {
  const subject = comparison[role];
  if (!sameJson(resolution.dataset, subject.dataset)) {
    throw new ComparisonRepositoryContractError(
      "Comparison evidence resolver substituted the exact dataset",
    );
  }
  if (resolution.fixtures.length !== subject.fixtures.length) {
    throw new ComparisonRepositoryContractError(
      "Comparison evidence resolver changed exact fixture membership",
    );
  }
  for (const [index, expected] of subject.fixtures.entries()) {
    const resolved = resolution.fixtures[index];
    if (
      !resolved ||
      exactFixtureKey(resolved.fixture) !== exactFixtureKey(expected.fixture) ||
      exactReplayKey(resolved.replay) !== exactReplayKey(expected.replay) ||
      !sameJson(resolved.replay, expected.replay)
    ) {
      throw new ComparisonRepositoryContractError(
        "Comparison evidence resolver substituted exact fixture or replay lineage",
      );
    }
  }
}

function comparisonReference(record: ComparisonDefinition) {
  return {
    comparisonId: record.comparisonId,
    comparisonVersionId: record.comparisonVersionId,
    definitionSha256: record.definitionSha256,
  } as const;
}

export class PublishComparisonDefinition {
  constructor(private readonly dependencies: RecordComparisonDependencies) {}

  async execute(
    command: PublishComparisonDefinitionCommand,
  ): Promise<RecordComparisonResult<ComparisonDefinition>> {
    const { principal, scope } = authorizedScope(command, "comparison:manage");
    const comparisonId = OpaqueIdSchema.safeParse(command.comparisonId);
    const comparisonVersionId =
      command.comparisonVersionId === undefined
        ? undefined
        : OpaqueIdSchema.safeParse(command.comparisonVersionId);
    const parsed = PublishComparisonDefinitionRequestSchema.safeParse(command.input);
    if (!comparisonId.success || comparisonVersionId?.success === false || !parsed.success) {
      throw invalidInput(
        "Comparison definition request is invalid",
        !comparisonId.success
          ? comparisonId.error
          : comparisonVersionId?.success === false
            ? comparisonVersionId.error
            : parsed.error,
      );
    }
    if (
      comparisonVersionId?.success === true &&
      parsed.data.comparisonVersionId !== comparisonVersionId.data
    ) {
      throw invalidInput(
        "Comparison definition route and immutable version identifier do not match",
        undefined,
      );
    }
    let predecessor: ComparisonDefinition["predecessor"];
    if (parsed.data.predecessorVersionId) {
      const input = await this.dependencies.repository.findComparisonDefinition(
        structuredClone(scope),
        parsed.data.predecessorVersionId,
      );
      if (input === null) {
        throw new ComparisonSourceUnavailableError(
          "comparison_definition",
          parsed.data.predecessorVersionId,
        );
      }
      const record = validateRepositoryRecord(
        input,
        "comparison_definition",
        scope,
        parsed.data.predecessorVersionId,
      ) as ComparisonDefinition;
      if (record.comparisonId !== comparisonId.data) {
        throw new ComparisonSourceUnavailableError(
          "comparison_definition",
          parsed.data.predecessorVersionId,
        );
      }
      predecessor = {
        comparisonVersionId: record.comparisonVersionId,
        definitionSha256: record.definitionSha256,
      };
    }
    const { predecessorVersionId: _predecessorVersionId, ...request } = parsed.data;
    let candidate: ComparisonDefinition;
    try {
      const body = ComparisonDefinitionSchema.parse({
        ...request,
        comparisonId: comparisonId.data,
        ...(predecessor ? { predecessor } : {}),
      });
      candidate = ComparisonDefinitionRecordSchema.parse({
        ...body,
        createdAt: serverTimestamp(this.dependencies.clock),
        createdByPrincipalId: principal.principalId,
        definitionSha256: digestComparisonRecordDefinition("comparison_definition", scope, body),
        schemaVersion: COMPARISON_DEFINITION_SCHEMA_VERSION,
        scope,
      });
    } catch (cause) {
      if (cause instanceof InvalidComparisonRecordInputError) throw cause;
      throw invalidInput("Invalid comparison definition", cause);
    }
    const existingInput = await this.dependencies.repository.findComparisonDefinition(
      structuredClone(scope),
      candidate.comparisonVersionId,
    );
    if (existingInput !== null) {
      const existing = validateRepositoryRecord(
        existingInput,
        "comparison_definition",
        scope,
        candidate.comparisonVersionId,
      ) as ComparisonDefinition;
      if (existing.definitionSha256 !== candidate.definitionSha256) {
        throw new ComparisonRecordConflictError(
          "comparison_definition",
          candidate.comparisonVersionId,
        );
      }
      const retry = await publishCandidate(
        this.dependencies.repository,
        "comparison_definition",
        scope,
        existing,
      );
      if (retry.created || !sameJson(retry.record, existing)) {
        throw new ComparisonRepositoryContractError(
          "Comparison definition retry violated repository semantics",
        );
      }
      return retry;
    }
    return publishCandidate(
      this.dependencies.repository,
      "comparison_definition",
      scope,
      candidate,
    );
  }
}

export class CreateComparisonEvidenceSnapshot {
  constructor(private readonly dependencies: CreateComparisonEvidenceSnapshotDependencies) {}

  async execute(
    command: CreateComparisonEvidenceSnapshotCommand,
  ): Promise<RecordComparisonResult<ComparisonEvidenceSnapshot>> {
    const { principal, scope } = authorizedScope(command, "comparison:manage");
    const snapshotId =
      command.snapshotId === undefined ? undefined : OpaqueIdSchema.safeParse(command.snapshotId);
    const parsed = CreateComparisonEvidenceSnapshotRequestSchema.safeParse(command.input);
    if (snapshotId?.success === false || !parsed.success) {
      throw invalidInput(
        "Comparison snapshot request is invalid",
        snapshotId?.success === false ? snapshotId.error : parsed.error,
      );
    }
    if (snapshotId?.success === true && parsed.data.snapshotId !== snapshotId.data) {
      throw invalidInput(
        "Comparison snapshot route and immutable identifier do not match",
        undefined,
      );
    }
    const comparison = await exactDefinition(
      this.dependencies.repository,
      scope,
      parsed.data.comparison,
    );
    const existingInput = await this.dependencies.repository.findComparisonEvidenceSnapshot(
      structuredClone(scope),
      parsed.data.snapshotId,
    );
    if (existingInput !== null) {
      const existing = validateRepositoryRecord(
        existingInput,
        "comparison_evidence_snapshot",
        scope,
        parsed.data.snapshotId,
      ) as ComparisonEvidenceSnapshot;
      if (
        existing.role !== parsed.data.role ||
        !sameJson(existing.comparison, parsed.data.comparison)
      ) {
        throw new ComparisonRecordConflictError(
          "comparison_evidence_snapshot",
          parsed.data.snapshotId,
        );
      }
      const retry = await publishCandidate(
        this.dependencies.repository,
        "comparison_evidence_snapshot",
        scope,
        existing,
      );
      if (retry.created || !sameJson(retry.record, existing)) {
        throw new ComparisonRepositoryContractError(
          "Comparison snapshot retry violated repository semantics",
        );
      }
      return retry;
    }
    let candidate: ComparisonEvidenceSnapshot;
    try {
      const resolution = structuredClone(
        await this.dependencies.evidenceResolver.resolve({
          comparison: structuredClone(comparison),
          role: parsed.data.role,
          scope: structuredClone(scope),
        }),
      );
      const body = ComparisonEvidenceSnapshotDefinitionSchema.parse({
        ...resolution,
        comparison: comparisonReference(comparison),
        role: parsed.data.role,
        snapshotId: parsed.data.snapshotId,
      });
      assertResolvedSubject(comparison, parsed.data.role, body);
      candidate = ComparisonEvidenceSnapshotSchema.parse({
        ...body,
        createdAt: serverTimestamp(this.dependencies.clock),
        createdByPrincipalId: principal.principalId,
        definitionSha256: digestComparisonRecordDefinition(
          "comparison_evidence_snapshot",
          scope,
          body,
        ),
        schemaVersion: COMPARISON_EVIDENCE_SNAPSHOT_SCHEMA_VERSION,
        scope,
      });
    } catch (cause) {
      if (cause instanceof ComparisonSourceUnavailableError) throw cause;
      if (cause instanceof ComparisonRepositoryContractError) throw cause;
      throw new ComparisonRepositoryContractError(
        "Comparison evidence resolver returned an invalid projection",
        { cause },
      );
    }
    return publishCandidate(
      this.dependencies.repository,
      "comparison_evidence_snapshot",
      scope,
      candidate,
    );
  }
}

export class DeriveComparisonResult {
  constructor(private readonly dependencies: RecordComparisonDependencies) {}

  async execute(
    command: DeriveComparisonResultCommand,
  ): Promise<RecordComparisonResult<ComparisonResult>> {
    const { principal, scope } = authorizedScope(command, "comparison:manage");
    const resultId =
      command.resultId === undefined ? undefined : OpaqueIdSchema.safeParse(command.resultId);
    const parsed = DeriveComparisonResultRequestSchema.safeParse(command.input);
    if (resultId?.success === false || !parsed.success) {
      throw invalidInput(
        "Comparison result request is invalid",
        resultId?.success === false ? resultId.error : parsed.error,
      );
    }
    if (resultId?.success === true && parsed.data.resultId !== resultId.data) {
      throw invalidInput(
        "Comparison result route and immutable identifier do not match",
        undefined,
      );
    }
    const comparison = await exactDefinition(
      this.dependencies.repository,
      scope,
      parsed.data.comparison,
    );
    const baseline = await exactSnapshot(
      this.dependencies.repository,
      scope,
      parsed.data.baselineSnapshot,
    );
    const candidateSnapshot = await exactSnapshot(
      this.dependencies.repository,
      scope,
      parsed.data.candidateSnapshot,
    );
    if (
      !sameJson(baseline.comparison, parsed.data.comparison) ||
      !sameJson(candidateSnapshot.comparison, parsed.data.comparison)
    ) {
      throw new ComparisonLineageError(
        "comparison_result",
        parsed.data.resultId,
        "comparison_definition",
        comparison.comparisonVersionId,
      );
    }
    const existingInput = await this.dependencies.repository.findComparisonResult(
      structuredClone(scope),
      parsed.data.resultId,
    );
    if (existingInput !== null) {
      const existing = validateRepositoryRecord(
        existingInput,
        "comparison_result",
        scope,
        parsed.data.resultId,
      ) as ComparisonResult;
      if (
        !sameJson(existing.comparison, parsed.data.comparison) ||
        !sameJson(existing.baselineSnapshot, parsed.data.baselineSnapshot) ||
        !sameJson(existing.candidateSnapshot, parsed.data.candidateSnapshot)
      ) {
        throw new ComparisonRecordConflictError("comparison_result", parsed.data.resultId);
      }
      const retry = await publishCandidate(
        this.dependencies.repository,
        "comparison_result",
        scope,
        existing,
      );
      if (retry.created || !sameJson(retry.record, existing)) {
        throw new ComparisonRepositoryContractError(
          "Comparison result retry violated repository semantics",
        );
      }
      return retry;
    }
    let result: ComparisonResult;
    try {
      const body = deriveComparisonResultDefinition({
        baseline,
        candidate: candidateSnapshot,
        comparison,
        resultId: parsed.data.resultId,
      });
      result = ComparisonResultSchema.parse({
        ...body,
        createdAt: serverTimestamp(this.dependencies.clock),
        createdByPrincipalId: principal.principalId,
        definitionSha256: digestComparisonRecordDefinition("comparison_result", scope, body),
        schemaVersion: COMPARISON_RESULT_SCHEMA_VERSION,
        scope,
      });
    } catch (cause) {
      if (cause instanceof InvalidComparisonRecordInputError) throw cause;
      throw invalidInput("Comparison result could not be derived", cause);
    }
    return publishCandidate(this.dependencies.repository, "comparison_result", scope, result);
  }
}

export class ReadComparisonRecord {
  constructor(private readonly repository: ComparisonRepository) {}

  async execute(command: ReadComparisonRecordCommand): Promise<ComparisonRecord> {
    const { scope } = authorizedScope(command, "comparison:read");
    const id = OpaqueIdSchema.safeParse(command.recordId);
    if (!id.success) throw invalidInput("Comparison route is invalid", id.error);
    const input = await findRecord(this.repository, command.kind, structuredClone(scope), id.data);
    if (input === null) throw new ComparisonRecordNotFoundError(command.kind, id.data);
    return structuredClone(validateRepositoryRecord(input, command.kind, scope, id.data));
  }
}
