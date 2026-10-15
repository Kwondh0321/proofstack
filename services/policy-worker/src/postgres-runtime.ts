import { randomUUID } from "node:crypto";
import {
  EvidenceScopeSchema,
  PrincipalContextSchema,
  PolicyEvaluationWorkerMutationFenceSchema,
  serializeEvaluationCanonicalJson,
  type EvidenceScope,
  type PrincipalContext,
} from "@proofstack/contracts";
import {
  ForbiddenError,
  SystemClock,
  requirePolicyEvaluationExecution,
  validatePolicyEvaluationRequestRecord,
  type Clock,
} from "@proofstack/core";
import type { ArtifactContentDecryptor } from "@proofstack/artifacts";
import {
  sealPolicyEvaluationSnapshot,
  type PolicyEvaluationSnapshotSealingTransactions,
} from "@proofstack/policy-evaluation";
import {
  assertMigrationsCurrent,
  createPolicyPostgresPool,
  createPostgresPolicyInitialSources,
  DEFAULT_RUNTIME_ROLE_NAMES,
  PostgresPolicyAcquisitionRepository,
  PostgresPolicyEvaluationJobWorkerRepository,
  PostgresPolicyEvaluationResultRepository,
  PostgresPolicySnapshotRepository,
  PostgresPolicySnapshotTransactions,
  validatePostgresConnectionString,
  type PostgresPolicyMetadataCatalogues,
} from "@proofstack/postgres";
import {
  createS3BoundedArtifactReader,
  type CreateS3ArtifactObjectStoreOptions,
  type S3BoundedArtifactReader,
} from "@proofstack/s3";
import type { PolicyWorkerAttemptPorts } from "./attempt.js";

export interface PolicyWorkerArtifactResources {
  readonly reader: Pick<S3BoundedArtifactReader, "get">;
  readonly encryption: ArtifactContentDecryptor;
  close(): void | Promise<void>;
}

/** Dedicated read-only, one-physical-attempt S3 client. Keys remain in the trusted decryptor. */
export function createS3PolicyWorkerArtifacts(
  options: CreateS3ArtifactObjectStoreOptions,
  encryption: ArtifactContentDecryptor,
): PolicyWorkerArtifactResources {
  const reader = createS3BoundedArtifactReader(options);
  return {
    reader: { get: (key, bound) => reader.get(key, bound) },
    encryption,
    close: () => reader.destroy(),
  };
}

export interface PostgresPolicyWorkerRuntimeOptions {
  readonly databaseUrl: string;
  readonly databaseRole?: string;
  readonly allowPlaintextLoopback?: boolean;
  readonly catalogues?: PostgresPolicyMetadataCatalogues;
  readonly clock?: Clock;
  readonly onIdleError: (error: Error) => void;
  /** Operator-owned factory, called only after execution authorization and DB readiness. */
  openArtifacts(): Promise<PolicyWorkerArtifactResources>;
  nextId?(kind: "allowance" | "manifest" | "snapshot" | "artifact_reservation"): string;
}

type Pool = ReturnType<typeof createPolicyPostgresPool>;
interface Dependencies {
  readonly createPool: typeof createPolicyPostgresPool;
  readonly assertCurrent: typeof assertMigrationsCurrent;
  readonly createInitialSources: typeof createPostgresPolicyInitialSources;
  readonly seal: typeof sealPolicyEvaluationSnapshot;
  readonly createTransactions: (
    pool: Pool,
    catalogues: PostgresPolicyMetadataCatalogues,
  ) => PolicyEvaluationSnapshotSealingTransactions;
}
const defaults: Dependencies = {
  createPool: createPolicyPostgresPool,
  assertCurrent: assertMigrationsCurrent,
  createInitialSources: createPostgresPolicyInitialSources,
  seal: sealPolicyEvaluationSnapshot,
  createTransactions: (pool, catalogues) =>
    new PostgresPolicySnapshotTransactions(pool, catalogues),
};
const same = (left: unknown, right: unknown) =>
  serializeEvaluationCanonicalJson(left) === serializeEvaluationCanonicalJson(right);

function databaseConnection(options: PostgresPolicyWorkerRuntimeOptions) {
  const role = options.databaseRole ?? DEFAULT_RUNTIME_ROLE_NAMES.policyEvaluator;
  if (!/^[a-z][a-z0-9_]{2,62}$/.test(role))
    throw new Error("Policy worker database role is invalid");
  if (options.databaseUrl.trim() !== options.databaseUrl)
    throw new Error("Policy worker database URL cannot have surrounding whitespace");
  const url = validatePostgresConnectionString(options.databaseUrl, {
    allowPlaintextLoopback: options.allowPlaintextLoopback === true,
  });
  let username: string;
  try {
    username = decodeURIComponent(new URL(url).username);
  } catch {
    throw new Error("Policy worker database role encoding is invalid");
  }
  if (username !== role) throw new Error("Policy worker requires its dedicated database role");
  return url;
}

/** Server composition only. No control pool, SQL, object mutations or keys enter job delivery. */
export async function createPostgresPolicyWorkerRuntime(
  input: { readonly scope: EvidenceScope; readonly principal: PrincipalContext },
  options: PostgresPolicyWorkerRuntimeOptions,
  overrides: Partial<Dependencies> = {},
): Promise<PolicyWorkerAttemptPorts> {
  const principal = PrincipalContextSchema.parse(input.principal);
  requirePolicyEvaluationExecution(principal, input.scope);
  const scope = EvidenceScopeSchema.parse(input.scope);
  const databaseUrl = databaseConnection(options);
  const catalogues = structuredClone(options.catalogues ?? {});
  const dependencies = { ...defaults, ...overrides };
  const nextId =
    options.nextId ?? ((kind: string) => `policy_${kind}_${randomUUID().replaceAll("-", "")}`);
  const clock = options.clock ?? new SystemClock();
  const pool = dependencies.createPool({
    applicationName: "proofstack-policy-worker",
    connectionString: databaseUrl,
    connectionTimeoutMilliseconds: 500,
    maxConnections: 4,
    onIdleError: options.onIdleError,
  });
  let artifacts: PolicyWorkerArtifactResources | undefined;
  let closing = false;
  let closed: Promise<void> | undefined;
  const active = new Set<Promise<unknown>>();
  const ensureOpen = () => {
    if (closing) throw new Error("Policy worker runtime is closed");
  };
  const close = () => {
    closing = true;
    if (closed) return closed;
    closed = (async () => {
      // Draining an already-started operation is not a scheduler cancellation or refunded work.
      await Promise.allSettled([...active]);
      const results = await Promise.allSettled([
        Promise.resolve().then(() => artifacts?.close()),
        Promise.resolve().then(() => pool.end()),
      ]);
      const errors = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (errors.length) throw new AggregateError(errors, "Policy worker resource cleanup failed");
    })();
    return closed;
  };
  try {
    await dependencies.assertCurrent(pool);
    const transactions = dependencies.createTransactions(pool, catalogues);
    const worker = new PostgresPolicyEvaluationJobWorkerRepository(pool);
    const acquisition = new PostgresPolicyAcquisitionRepository(pool);
    const snapshots = new PostgresPolicySnapshotRepository(pool);
    const results = new PostgresPolicyEvaluationResultRepository(pool);
    artifacts = await options.openArtifacts();
    const ownedArtifacts = artifacts;
    return {
      worker,
      snapshots,
      results,
      close,
      seal(input) {
        ensureOpen();
        const actor = PrincipalContextSchema.parse(input.principal);
        if (!same(actor, principal)) throw new ForbiddenError("Policy runtime actor changed");
        const request = validatePolicyEvaluationRequestRecord(input.request);
        const fence = PolicyEvaluationWorkerMutationFenceSchema.parse(input.fence);
        if (!same(request.scope, scope) || fence.workerId !== principal.principalId)
          throw new ForbiddenError("Policy runtime seal changed its owning scope or worker");
        const allowanceId = nextId("allowance");
        const initial = dependencies.createInitialSources(
          pool,
          { scope, fence, allowanceId },
          catalogues,
        );
        const operation = dependencies.seal(
          request,
          actor,
          initial.repositories,
          initial.evidence,
          {
            catalog: initial.catalog,
            clock,
            encryption: ownedArtifacts.encryption,
            objects: {
              async get() {
                throw new Error("Policy worker forbids unreserved object reads");
              },
            },
          },
          {
            fence,
            manifestId: nextId("manifest"),
            snapshotId: nextId("snapshot"),
            transactions,
            acquisitionAdmission: { repository: acquisition, allowanceId },
            artifactByteAdmission: {
              repository: worker,
              objectReader: ownedArtifacts.reader,
              nextReservationId: () => nextId("artifact_reservation"),
            },
          },
        );
        active.add(operation);
        void operation.then(
          () => active.delete(operation),
          () => active.delete(operation),
        );
        return operation;
      },
    };
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Policy worker initialization and cleanup failed",
      );
    }
    throw error;
  }
}
