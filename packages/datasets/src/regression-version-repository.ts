import type {
  EvidenceScope,
  RegressionDatasetVersion,
  RegressionFixtureVersion,
  RegressionFixtureVersionReference,
  RequestedRegressionFixtureVersionReference,
} from "@proofstack/contracts";

export interface PublishRegressionVersionResult<Version> {
  readonly created: boolean;
  readonly version: Version;
}

/**
 * An ordered, authoritative resolution of every requested exact fixture reference, or `null` when
 * any requested reference is unavailable in the authenticated scope. Implementations never return
 * a partial result and never reorder the references.
 */
export type ResolveRegressionFixtureVersionReferencesResult =
  | readonly RegressionFixtureVersionReference[]
  | null;

/**
 * Persistence boundary for immutable fixture and dataset versions.
 *
 * Every method receives a scope that has already been authenticated and authorized by the calling
 * use case. Reads must hide records outside that exact tenant, project, and environment. Writes
 * must additionally enforce tenant-wide version and logical-resource identities so a caller cannot
 * rebind an identifier through another project or environment.
 */
export interface RegressionVersionRepository {
  /** Returns whether the logical dataset is already bound to this exact authorized scope. */
  datasetResourceExists(scope: EvidenceScope, datasetId: string): Promise<boolean>;

  /**
   * Finds a caller-supplied exact dataset version identifier in the authorized scope. The caller
   * deliberately compares the returned logical identifier with its route before deciding whether
   * a timed-out publication is an idempotent retry or a conflict.
   */
  findDatasetVersion(
    scope: EvidenceScope,
    datasetVersionId: string,
  ): Promise<RegressionDatasetVersion | null>;

  /**
   * Finds a caller-supplied exact fixture version identifier in the authorized scope. The caller
   * deliberately compares the returned logical identifier with its route before recapturing source
   * evidence.
   */
  findFixtureVersion(
    scope: EvidenceScope,
    fixtureVersionId: string,
  ): Promise<RegressionFixtureVersion | null>;

  /** Returns whether the logical fixture is already bound to this exact authorized scope. */
  fixtureResourceExists(scope: EvidenceScope, fixtureId: string): Promise<boolean>;

  /**
   * Atomically publishes an immutable dataset version. A new publication must validate tenant-wide
   * identities, exact predecessor lineage, and every ordered authoritative fixture membership,
   * then persist the logical resource, version header, ordered membership, and exactly one canonical
   * publication outbox intent in one transaction. An identical retry returns the originally stored
   * version and provenance with `created: false` and writes no additional outbox intent. Any
   * conflict or failed invariant writes nothing.
   */
  publishDatasetVersion(
    candidate: RegressionDatasetVersion,
  ): Promise<PublishRegressionVersionResult<RegressionDatasetVersion>>;

  /**
   * Atomically publishes an immutable fixture version. A new publication must validate tenant-wide
   * identities and exact predecessor lineage, then persist the logical resource, version, and
   * exactly one canonical publication outbox intent in one transaction. An identical retry returns
   * the originally stored version and provenance with `created: false` and writes no additional
   * outbox intent. Any conflict or failed invariant writes nothing.
   */
  publishFixtureVersion(
    candidate: RegressionFixtureVersion,
  ): Promise<PublishRegressionVersionResult<RegressionFixtureVersion>>;

  /**
   * Resolves all requested exact fixture references using their authoritative stored digests. The
   * successful array has the same length and order as `references`; if any logical/version pair is
   * missing or outside the exact scope, the method returns `null` rather than partial data.
   */
  resolveFixtureVersionReferences(
    scope: EvidenceScope,
    references: readonly RequestedRegressionFixtureVersionReference[],
  ): Promise<ResolveRegressionFixtureVersionReferencesResult>;
}
