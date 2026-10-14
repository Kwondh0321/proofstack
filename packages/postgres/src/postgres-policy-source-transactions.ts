import { type EvidenceScope, EvidenceScopeSchema } from "@proofstack/contracts";
import type {
  PolicyEvaluationMetadataPorts,
  PolicyEvaluationMetadataTransactions,
  PolicyEvaluationSourceRecheckPorts,
  PolicyEvaluationSourceTransactions,
} from "@proofstack/policy-evaluation";
import type { Pool } from "pg";
import { loadBundledMigrations } from "./migrations.js";
import {
  copyPostgresPolicyMetadataCatalogues,
  createPostgresPolicySourcePorts,
  type PostgresPolicyMetadataCatalogues,
} from "./postgres-policy-source-ports.js";
import { withExactReadCommittedScopeTransaction } from "./tenant-transaction.js";

export {
  MAX_POLICY_METADATA_INSTALLATION_BINDINGS,
  type PostgresPolicyMetadataCatalogues,
} from "./postgres-policy-source-ports.js";

/** Trusted read-only adapter. A pool does not confer worker or snapshot-publication authority. */
export class PostgresPolicySourceTransactions
  implements PolicyEvaluationSourceTransactions, PolicyEvaluationMetadataTransactions
{
  private readonly catalogues;

  constructor(
    private readonly pool: Pick<Pool, "connect">,
    catalogues: PostgresPolicyMetadataCatalogues = {},
  ) {
    this.catalogues = copyPostgresPolicyMetadataCatalogues(catalogues);
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
      const { sources: ports, createMetadata } = createPostgresPolicySourcePorts(
        client,
        exact,
        call,
        this.catalogues,
        migrations,
      );
      try {
        const result = await operation(ports, createMetadata);
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
