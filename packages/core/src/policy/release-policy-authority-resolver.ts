import type {
  EvidenceScope,
  PolicyInstallationBinding,
  PolicyInstallationBindingReference,
  ReleasePolicyDefinition,
  SourceReviewerQualification,
  SourceReviewRecord,
  SourceSnapshot,
} from "@proofstack/contracts";
import {
  EvidenceScopeSchema,
  OpaqueIdSchema,
  PolicyInstallationBindingReferenceSchema,
  ReleasePolicyDefinitionSchema,
} from "@proofstack/contracts";
import {
  evaluationRecordId,
  validateEvaluationRecord,
} from "../evaluation/evaluation-record-validation.js";
import type {
  ReleasePolicyAuthorityArtifactAvailability,
  ResolvedReleasePolicySourceAuthority,
} from "./release-policy-authority.js";
import {
  InvalidReleasePolicyAuthorityInputError,
  ReleasePolicyAuthorityResolutionError,
  ReleasePolicyAuthorityResolverContractError,
} from "./release-policy-errors.js";
import { validatePolicyInstallationBindingRecord } from "./release-policy-record-validation.js";

type QualifiedSourceReference = ReleasePolicyDefinition["sources"][number];
type ArtifactReference = SourceSnapshot["content"];

export interface ResolvePolicyInstallationBindingCommand {
  readonly reference: PolicyInstallationBindingReference;
  readonly scope: EvidenceScope;
}

/** Installation-owned, exact-version policy publication authority boundary. */
export interface PolicyInstallationBindingResolver {
  resolve(
    command: ResolvePolicyInstallationBindingCommand,
  ): Promise<PolicyInstallationBinding | null>;
}

/** Narrow, read-only subset of the immutable evaluation repository used for policy sources. */
export interface ReleasePolicySourceAuthorityRepository {
  findSourceReview(
    scope: EvidenceScope,
    sourceReviewId: string,
  ): Promise<SourceReviewRecord | null>;
  findSourceReviewerQualification(
    scope: EvidenceScope,
    qualificationId: string,
  ): Promise<SourceReviewerQualification | null>;
  findSourceSnapshot(
    scope: EvidenceScope,
    sourceSnapshotId: string,
  ): Promise<SourceSnapshot | null>;
}

export interface ResolveReleasePolicyAuthorityArtifactsCommand {
  readonly references: readonly ArtifactReference[];
  readonly scope: EvidenceScope;
}

/** Exact retained-byte availability boundary; search results and metadata are insufficient. */
export interface ReleasePolicyAuthorityArtifactResolver {
  resolve(
    command: ResolveReleasePolicyAuthorityArtifactsCommand,
  ): Promise<readonly ReleasePolicyAuthorityArtifactAvailability[]>;
}

export interface ResolveReleasePolicyAuthorityEvidenceCommand {
  readonly definition: ReleasePolicyDefinition;
  readonly scope: EvidenceScope;
}

export interface ResolvedReleasePolicyAuthorityEvidence {
  readonly artifacts: readonly ReleasePolicyAuthorityArtifactAvailability[];
  readonly installationBinding: PolicyInstallationBinding | null;
  readonly sources: readonly ResolvedReleasePolicySourceAuthority[];
}

/** Server-side resolver consumed by policy publication after command authorization. */
export interface ReleasePolicyAuthorityEvidenceResolver {
  resolve(
    command: ResolveReleasePolicyAuthorityEvidenceCommand,
  ): Promise<ResolvedReleasePolicyAuthorityEvidence>;
}

export interface RepositoryReleasePolicyAuthorityResolverDependencies {
  readonly artifactResolver: ReleasePolicyAuthorityArtifactResolver;
  readonly installationBindingResolver: PolicyInstallationBindingResolver;
  readonly sourceRepository: ReleasePolicySourceAuthorityRepository;
}

function invalidInput(message: string, cause?: unknown): InvalidReleasePolicyAuthorityInputError {
  return new InvalidReleasePolicyAuthorityInputError(
    message,
    cause === undefined ? undefined : { cause },
  );
}

function contract(message: string, cause?: unknown): ReleasePolicyAuthorityResolverContractError {
  return new ReleasePolicyAuthorityResolverContractError(
    message,
    cause === undefined ? undefined : { cause },
  );
}

function unavailable(message: string, cause: unknown): ReleasePolicyAuthorityResolutionError {
  return new ReleasePolicyAuthorityResolutionError(message, { cause });
}

function sameScope(left: EvidenceScope, right: EvidenceScope): boolean {
  return (
    left.tenantId === right.tenantId &&
    left.projectId === right.projectId &&
    left.environmentId === right.environmentId
  );
}

function scopeKey(scope: EvidenceScope): string {
  return `${scope.tenantId}:${scope.projectId}:${scope.environmentId}`;
}

function bindingKey(scope: EvidenceScope, reference: PolicyInstallationBindingReference): string {
  return `${scopeKey(scope)}:${reference.installationId}:${reference.bindingVersionId}`;
}

function artifactKey(reference: Pick<ArtifactReference, "artifactId" | "sha256">): string {
  return `${reference.artifactId}:${reference.sha256}`;
}

function sourceKey(reference: QualifiedSourceReference): string {
  return [
    reference.source.sourceSnapshotId,
    reference.source.definitionSha256,
    reference.review.sourceReviewId,
    reference.review.definitionSha256,
  ].join(":");
}

function parsedCommand(command: ResolveReleasePolicyAuthorityEvidenceCommand): {
  readonly definition: ReleasePolicyDefinition;
  readonly scope: EvidenceScope;
} {
  const definition = ReleasePolicyDefinitionSchema.safeParse(command.definition);
  const scope = EvidenceScopeSchema.safeParse(command.scope);
  if (!definition.success || !scope.success) {
    throw invalidInput(
      "Policy authority resolution input is invalid",
      definition.success ? scope.error : definition.error,
    );
  }
  return { definition: definition.data, scope: scope.data };
}

function exactEvaluationRecord<
  RecordType extends SourceReviewerQualification | SourceReviewRecord | SourceSnapshot,
>(
  kind: "source_reviewer_qualification" | "source_review" | "source_snapshot",
  input: unknown,
  scope: EvidenceScope,
  recordId: string,
): RecordType {
  let record: SourceReviewerQualification | SourceReviewRecord | SourceSnapshot;
  try {
    record = validateEvaluationRecord(kind, input) as typeof record;
  } catch (cause) {
    throw contract("Policy source repository returned an invalid immutable record", cause);
  }
  if (evaluationRecordId(kind, record) !== recordId || !sameScope(record.scope, scope)) {
    throw contract("Policy source repository substituted a record outside the exact query");
  }
  return structuredClone(record) as RecordType;
}

async function resolveRepositoryCall<Value>(
  operation: () => Promise<Value>,
  message: string,
): Promise<Value> {
  try {
    return await operation();
  } catch (cause) {
    if (cause instanceof ReleasePolicyAuthorityResolverContractError) throw cause;
    throw unavailable(message, cause);
  }
}

async function resolveSource(
  repository: ReleasePolicySourceAuthorityRepository,
  scope: EvidenceScope,
  reference: QualifiedSourceReference,
): Promise<ResolvedReleasePolicySourceAuthority> {
  const [sourceInput, reviewInput] = await Promise.all([
    resolveRepositoryCall(
      () =>
        repository.findSourceSnapshot(structuredClone(scope), reference.source.sourceSnapshotId),
      "Policy source snapshot resolution is unavailable",
    ),
    resolveRepositoryCall(
      () => repository.findSourceReview(structuredClone(scope), reference.review.sourceReviewId),
      "Policy source review resolution is unavailable",
    ),
  ]);
  const source =
    sourceInput === null
      ? null
      : exactEvaluationRecord<SourceSnapshot>(
          "source_snapshot",
          sourceInput,
          scope,
          reference.source.sourceSnapshotId,
        );
  const review =
    reviewInput === null
      ? null
      : exactEvaluationRecord<SourceReviewRecord>(
          "source_review",
          reviewInput,
          scope,
          reference.review.sourceReviewId,
        );
  let reviewerQualification: SourceReviewerQualification | null = null;
  const reviewerReference = review?.reviewerQualification;
  if (reviewerReference) {
    const qualificationInput = await resolveRepositoryCall(
      () =>
        repository.findSourceReviewerQualification(
          structuredClone(scope),
          reviewerReference.qualificationId,
        ),
      "Policy source reviewer qualification resolution is unavailable",
    );
    if (qualificationInput !== null) {
      reviewerQualification = exactEvaluationRecord<SourceReviewerQualification>(
        "source_reviewer_qualification",
        qualificationInput,
        scope,
        reviewerReference.qualificationId,
      );
    }
  }
  return { reference: structuredClone(reference), review, reviewerQualification, source };
}

function artifactReferences(
  installationBinding: PolicyInstallationBinding | null,
  sources: readonly ResolvedReleasePolicySourceAuthority[],
): ArtifactReference[] {
  const references = [
    ...(installationBinding ? [installationBinding.authorityEvidence] : []),
    ...sources.flatMap(({ review, reviewerQualification, source }) => [
      ...(source
        ? [
            source.content,
            ...(source.identityVerification.status === "verified"
              ? source.identityVerification.evidence
              : []),
          ]
        : []),
      ...(review ? review.reviewBasis : []),
      ...(reviewerQualification ? reviewerQualification.credentialEvidence : []),
    ]),
  ];
  return [
    ...new Map(references.map((reference) => [artifactKey(reference), reference])).values(),
  ].sort((left, right) => artifactKey(left).localeCompare(artifactKey(right)));
}

function normalizedArtifactAvailability(
  references: readonly ArtifactReference[],
  input: readonly unknown[],
): ReleasePolicyAuthorityArtifactAvailability[] {
  const expected = new Map(references.map((reference) => [artifactKey(reference), reference]));
  const resolved = new Map<string, "available" | "unavailable">();
  for (const candidate of input) {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
      throw contract("Policy artifact resolver returned invalid availability evidence");
    }
    const item = candidate as Partial<ReleasePolicyAuthorityArtifactAvailability>;
    const artifactId = OpaqueIdSchema.safeParse(item.artifactId);
    const sha256 = typeof item.sha256 === "string" ? item.sha256 : "";
    const key = `${item.artifactId ?? ""}:${sha256}`;
    if (
      !artifactId.success ||
      !/^[a-f0-9]{64}$/u.test(sha256) ||
      (item.state !== "available" && item.state !== "unavailable") ||
      !expected.has(key) ||
      resolved.has(key)
    ) {
      throw contract("Policy artifact resolver returned invalid availability evidence");
    }
    resolved.set(key, item.state);
  }
  return references.map((reference) => ({
    ...reference,
    state: resolved.get(artifactKey(reference)) ?? "unavailable",
  }));
}

/**
 * Resolves an exact installation binding and immutable qualified-source chain. It never searches,
 * browses, ranks, refreshes, or treats source metadata as retained artifact bytes.
 */
export class RepositoryReleasePolicyAuthorityResolver
  implements ReleasePolicyAuthorityEvidenceResolver
{
  constructor(
    private readonly dependencies: RepositoryReleasePolicyAuthorityResolverDependencies,
  ) {}

  async resolve(
    command: ResolveReleasePolicyAuthorityEvidenceCommand,
  ): Promise<ResolvedReleasePolicyAuthorityEvidence> {
    const { definition, scope } = parsedCommand(command);
    const installationInput = await resolveRepositoryCall(
      () =>
        this.dependencies.installationBindingResolver.resolve({
          reference: structuredClone(definition.installationBinding),
          scope: structuredClone(scope),
        }),
      "Policy installation binding resolution is unavailable",
    );
    let installationBinding: PolicyInstallationBinding | null = null;
    if (installationInput !== null) {
      try {
        installationBinding = validatePolicyInstallationBindingRecord(installationInput);
      } catch (cause) {
        throw contract("Policy installation resolver returned an invalid binding", cause);
      }
      if (
        installationBinding.installationId !== definition.installationBinding.installationId ||
        installationBinding.bindingVersionId !== definition.installationBinding.bindingVersionId ||
        !sameScope(installationBinding.scope, scope)
      ) {
        throw contract(
          "Policy installation resolver substituted a binding outside the exact query",
        );
      }
    }

    const references = [...definition.sources, ...definition.counterevidence];
    const sources = await Promise.all(
      references.map((reference) =>
        resolveSource(this.dependencies.sourceRepository, scope, reference),
      ),
    );
    const requestedArtifacts = artifactReferences(installationBinding, sources);
    let artifactInput: readonly ReleasePolicyAuthorityArtifactAvailability[];
    try {
      artifactInput =
        requestedArtifacts.length === 0
          ? []
          : await this.dependencies.artifactResolver.resolve({
              references: structuredClone(requestedArtifacts),
              scope: structuredClone(scope),
            });
    } catch (cause) {
      if (cause instanceof ReleasePolicyAuthorityResolverContractError) throw cause;
      throw unavailable("Policy authority artifact resolution is unavailable", cause);
    }
    if (!Array.isArray(artifactInput)) {
      throw contract("Policy artifact resolver returned non-array availability evidence");
    }
    return {
      artifacts: normalizedArtifactAvailability(requestedArtifacts, artifactInput),
      installationBinding: installationBinding ? structuredClone(installationBinding) : null,
      sources: structuredClone(sources).sort((left, right) =>
        sourceKey(left.reference).localeCompare(sourceKey(right.reference)),
      ),
    };
  }
}

/** Immutable, in-process reference registry owned by installation composition, not policy input. */
export class StaticPolicyInstallationBindingResolver implements PolicyInstallationBindingResolver {
  private readonly records = new Map<string, PolicyInstallationBinding>();

  constructor(records: readonly PolicyInstallationBinding[]) {
    if (!Array.isArray(records)) throw contract("Static policy installation registry is invalid");
    for (const input of records) {
      let record: PolicyInstallationBinding;
      try {
        record = validatePolicyInstallationBindingRecord(input);
      } catch (cause) {
        throw contract("Static policy installation registry contains an invalid binding", cause);
      }
      const key = bindingKey(record.scope, record);
      if (this.records.has(key)) {
        throw contract("Static policy installation registry contains a duplicate binding");
      }
      this.records.set(key, structuredClone(record));
    }
  }

  async resolve(
    command: ResolvePolicyInstallationBindingCommand,
  ): Promise<PolicyInstallationBinding | null> {
    const scope = EvidenceScopeSchema.safeParse(command.scope);
    const reference = PolicyInstallationBindingReferenceSchema.safeParse(command.reference);
    if (!scope.success || !reference.success) {
      throw invalidInput(
        "Policy installation binding query is invalid",
        scope.success ? reference.error : scope.error,
      );
    }
    const record = this.records.get(bindingKey(scope.data, reference.data));
    return record ? structuredClone(record) : null;
  }
}
