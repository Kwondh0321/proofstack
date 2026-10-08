import {
  type EvidenceScope,
  EvidenceScopeSchema,
  OpaqueIdSchema,
  PolicyEvaluationTimeSchema,
  type PolicyInstallationBinding,
} from "@proofstack/contracts";
import {
  StaticPolicyInstallationBindingResolver,
  StaticRuntimeDefinitionCatalogue,
} from "@proofstack/core";
import {
  type PolicyEvaluationMetadataPorts,
  type PolicyEvaluationMetadataTransactions,
  PolicyEvaluationSourceRecheckError,
  type PolicyEvaluationSourceRecheckPorts,
  type PolicyEvaluationSourceTransactions,
} from "@proofstack/policy-evaluation";
import type { Pool } from "pg";
import { assertMigrationsCurrentOnClient } from "./migration-runner.js";
import { loadBundledMigrations } from "./migrations.js";
import { readPostgresArtifactCatalogOnClient } from "./postgres-artifact-catalog-repository.js";
import {
  listPostgresCriterionSetStatusesOnClient,
  readPostgresEvaluationRecordOnClient,
} from "./postgres-evaluation-repository.js";
import { createPostgresPolicyMetadataPorts } from "./postgres-policy-metadata-ports.js";
import {
  listPostgresReleasePolicyLifecycleEventsOnClient,
  readPostgresReleasePolicyOnClient,
} from "./postgres-release-policy-repository.js";
import { withExactReadCommittedScopeTransaction } from "./tenant-transaction.js";

export const MAX_POLICY_METADATA_INSTALLATION_BINDINGS = 256;

/** Immutable operator-owned inputs, copied at construction before any transaction. */
export interface PostgresPolicyMetadataCatalogues {
  readonly installationBindings?: readonly PolicyInstallationBinding[];
  readonly runtimeDefinitions?: readonly unknown[];
}

/** Trusted read-only adapter. A pool does not confer worker or snapshot-publication authority. */
export class PostgresPolicySourceTransactions
  implements PolicyEvaluationSourceTransactions, PolicyEvaluationMetadataTransactions
{
  private readonly catalogues;

  constructor(
    private readonly pool: Pick<Pool, "connect">,
    catalogues: PostgresPolicyMetadataCatalogues = {},
  ) {
    const bindings =
      catalogues.installationBindings === undefined ? [] : catalogues.installationBindings;
    if (!Array.isArray(bindings) || bindings.length > MAX_POLICY_METADATA_INSTALLATION_BINDINGS)
      throw new TypeError("Policy metadata installation catalogue exceeds its entry limit");
    this.catalogues = {
      installationBinding: new StaticPolicyInstallationBindingResolver(bindings),
      runtimeDefinitions: new StaticRuntimeDefinitionCatalogue(
        catalogues.runtimeDefinitions === undefined ? [] : catalogues.runtimeDefinitions,
      ),
    };
  }

  async run<T>(
    scope: EvidenceScope,
    operation: (ports: PolicyEvaluationSourceRecheckPorts) => Promise<T>,
  ): Promise<T> {
    return this.transact(scope, (ports) => operation(ports));
  }

  async runMetadata<T>(
    scope: EvidenceScope,
    operation: (ports: PolicyEvaluationMetadataPorts) => Promise<T>,
  ): Promise<T> {
    return this.transact(scope, async (sources, createMetadata) => {
      await sources.tryMetadataGuard();
      return operation({ sources, ...createMetadata() });
    });
  }

  private async transact<T>(
    scope: EvidenceScope,
    operation: (
      ports: PolicyEvaluationSourceRecheckPorts,
      createMetadata: () => Omit<PolicyEvaluationMetadataPorts, "sources">,
    ) => Promise<T>,
  ): Promise<T> {
    const exact = EvidenceScopeSchema.parse(scope);
    // Filesystem work precedes the transaction; schema verification itself runs under its guards.
    const migrations = await loadBundledMigrations();
    return withExactReadCommittedScopeTransaction(this.pool, exact, async (client) => {
      let active = true;
      let failed = false;
      let failure: unknown;
      const pending = new Set<Promise<unknown>>();
      const call = <Result>(work: () => Promise<Result>): Promise<Result> => {
        if (!active)
          return Promise.reject(new Error("Policy source transaction ports have expired"));
        if (failed) return Promise.reject(failure);
        const task = work();
        pending.add(task);
        void task.then(
          () => pending.delete(task),
          (error: unknown) => {
            pending.delete(task);
            if (!failed) {
              failed = true;
              failure = error;
            }
          },
        );
        return task;
      };
      const id = (value: string) => OpaqueIdSchema.parse(value);
      let metadataGuarded = false;
      const requireMetadataGuard = () => {
        if (!metadataGuarded)
          throw new PolicyEvaluationSourceRecheckError("guard_unavailable", "metadata");
      };
      const ports: PolicyEvaluationSourceRecheckPorts = {
        tryMetadataGuard: () =>
          call(async () => {
            const result = await client.query<{ acquired: unknown }>(
              "SELECT public.proofstack_try_lock_policy_evaluation_metadata() AS acquired",
            );
            const acquired = result.rows.length === 1 ? result.rows[0]?.acquired : undefined;
            if (acquired !== true)
              throw new PolicyEvaluationSourceRecheckError(
                acquired === false ? "guard_unavailable" : "guard_invalid",
                "metadata",
              );
            await assertMigrationsCurrentOnClient(client, migrations);
            metadataGuarded = true;
            return true;
          }),
        findCriterion: (value) =>
          call(async () => {
            requireMetadataGuard();
            return readPostgresEvaluationRecordOnClient(client, exact, "criterion_set", id(value));
          }),
        listCriterionSetStatuses: (limits) =>
          call(async () => {
            requireMetadataGuard();
            return listPostgresCriterionSetStatusesOnClient(client, exact, limits);
          }),
        tryGuard: (kind, value) =>
          call(async () => {
            if (kind !== "artifact" && kind !== "release_policy")
              throw new TypeError("Unsupported policy source guard kind");
            const resourceId = id(value);
            const result = await client.query<{ acquired: unknown }>(
              "SELECT public.proofstack_try_lock_policy_evaluation_source($1, $2) AS acquired",
              [kind, resourceId],
            );
            const acquired = result.rows.length === 1 ? result.rows[0]?.acquired : undefined;
            if (acquired !== true)
              throw new PolicyEvaluationSourceRecheckError(
                acquired === false ? "guard_unavailable" : "guard_invalid",
                JSON.stringify([kind, resourceId]),
              );
            return true;
          }),
        findArtifact: (value) =>
          call(async () => readPostgresArtifactCatalogOnClient(client, exact, id(value))),
        findPolicy: (value) =>
          call(async () => readPostgresReleasePolicyOnClient(client, exact, id(value))),
        listPolicyHistory: (value) =>
          call(async () =>
            listPostgresReleasePolicyLifecycleEventsOnClient(client, exact, id(value)),
          ),
        observationTime: () =>
          call(async () => {
            const result = await client.query<{ observed_at: unknown }>(
              `SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS observed_at`,
            );
            return PolicyEvaluationTimeSchema.parse(
              result.rows.length === 1 ? result.rows[0]?.observed_at : undefined,
            );
          }),
      };
      try {
        const result = await operation(ports, () =>
          createPostgresPolicyMetadataPorts(client, exact, call, this.catalogues),
        );
        // Do not let a caught or unawaited port failure commit, or release a connection while
        // started reads are still using it. The domain composer remains sequential and bounded.
        active = false;
        await Promise.allSettled([...pending]);
        if (failed) throw failure;
        return result;
      } finally {
        active = false;
        await Promise.allSettled([...pending]);
      }
    });
  }
}
