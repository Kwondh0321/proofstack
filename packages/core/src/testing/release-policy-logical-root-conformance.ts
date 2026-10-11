import assert from "node:assert/strict";
import type {
  ReleasePolicyLogicalRootReader,
  ReleasePolicyRepository,
} from "../policy/release-policy-repository.js";
import {
  type ReleasePolicyRepositoryTestHarness,
  releasePolicyRepositoryFixture,
} from "./release-policy-repository-fixtures.js";

type Harness = Omit<ReleasePolicyRepositoryTestHarness, "repository"> & {
  readonly repository: ReleasePolicyRepository & ReleasePolicyLogicalRootReader;
};

export interface ReleasePolicyLogicalRootConformanceCase {
  readonly name: string;
  readonly run: (factory: (namespace: string) => Harness | Promise<Harness>) => Promise<void>;
}

async function withHarness(
  factory: (namespace: string) => Harness | Promise<Harness>,
  namespace: string,
  test: (harness: Harness) => Promise<void>,
): Promise<void> {
  const harness = await factory(namespace);
  try {
    await test(harness);
  } finally {
    await harness.dispose?.();
  }
}

export const releasePolicyLogicalRootConformanceCases: readonly ReleasePolicyLogicalRootConformanceCase[] =
  [
    {
      name: "observes exact logical roots while preserving absence and all scope dimensions",
      async run(factory) {
        await withHarness(
          factory,
          "root_scope",
          async ({ repository, policy, successor, scope }) => {
            assert.equal(
              await repository.findReleasePolicyLogicalRoot(scope, policy.policyVersionId),
              null,
            );
            await repository.publishReleasePolicy(policy);
            await repository.publishReleasePolicy(successor);
            assert.deepEqual(
              await repository.findReleasePolicyLogicalRoot(scope, policy.policyVersionId),
              policy,
            );
            assert.deepEqual(
              await repository.findReleasePolicyLogicalRoot(scope, successor.policyVersionId),
              policy,
            );
            for (const key of ["tenantId", "projectId", "environmentId"] as const) {
              const outside = { ...scope, [key]: `${scope[key]}_outside` };
              assert.equal(
                await repository.findReleasePolicyLogicalRoot(outside, successor.policyVersionId),
                null,
              );
            }
            assert.equal(
              await repository.findReleasePolicyLogicalRoot(scope, "missing_policy_version"),
              null,
            );
          },
        );
      },
    },
    {
      name: "retains the stored first root for independent versions despite earlier receipt timestamps",
      async run(factory) {
        await withHarness(factory, "root_independent", async ({ repository, policy, scope }) => {
          await repository.publishReleasePolicy(policy);
          const independent = releasePolicyRepositoryFixture("root_independent_child", scope, {
            policyId: policy.policyId,
            policyVersionId: "policy_root_independent_child",
            publishedAt: "2026-09-07T00:59:00.000Z",
          });
          assert.equal(independent.predecessor, undefined);
          await repository.publishReleasePolicy(independent);
          assert.deepEqual(
            await repository.findReleasePolicyLogicalRoot(scope, independent.policyVersionId),
            policy,
          );
          assert.deepEqual(
            await repository.findReleasePolicy(scope, independent.policyVersionId),
            independent,
          );
        });
      },
    },
    {
      name: "returns owned root bodies with original publication receipts after retries and lifecycle changes",
      async run(factory) {
        await withHarness(factory, "root_receipt", async (harness) => {
          const { repository, policy, successor, scope } = harness;
          await repository.publishReleasePolicy(policy);
          await repository.publishReleasePolicy(successor);
          await repository.publishReleasePolicy({
            ...policy,
            publishedAt: "2026-09-07T01:30:00.000Z",
          });
          await repository.publishReleasePolicyLifecycleEvent(harness.supersession);
          await repository.publishReleasePolicyLifecycleEvent({
            ...harness.withdrawal,
            eventId: "withdraw_successor",
            policy: {
              policyId: successor.policyId,
              policyVersionId: successor.policyVersionId,
              definitionSha256: successor.definitionSha256,
            },
          });
          const read = await repository.findReleasePolicyLogicalRoot(
            scope,
            successor.policyVersionId,
          );
          assert.deepEqual(read, policy);
          assert.ok(read);
          read.changeRationale = "Caller-mutated root body";
          read.scope.environmentId = "env_caller_mutation";
          assert.deepEqual(
            await repository.findReleasePolicyLogicalRoot(scope, successor.policyVersionId),
            policy,
          );
        });
      },
    },
    {
      name: "keeps colliding policy identities bound to their own tenant roots",
      async run(factory) {
        await withHarness(factory, "root_tenants", async ({ repository, policy, scope }) => {
          for (const tenantId of [
            scope.tenantId,
            `${scope.tenantId}_second`,
            `${scope.tenantId}_third`,
          ]) {
            const ownScope = { ...scope, tenantId };
            const root = releasePolicyRepositoryFixture("root_tenant", ownScope, {
              policyId: policy.policyId,
              policyVersionId: policy.policyVersionId,
            });
            await repository.publishReleasePolicy(root);
            const child = releasePolicyRepositoryFixture("root_tenant_child", ownScope, {
              policyId: policy.policyId,
              policyVersionId: "policy_root_tenant_child",
            });
            await repository.publishReleasePolicy(child);
            assert.deepEqual(
              await repository.findReleasePolicyLogicalRoot(ownScope, child.policyVersionId),
              root,
            );
          }
        });
      },
    },
    {
      name: "serializes competing independent first publications into one retained resource root",
      async run(factory) {
        await withHarness(factory, "root_competing", async ({ repository, policy, scope }) => {
          const other = releasePolicyRepositoryFixture("root_competing_other", scope, {
            policyId: policy.policyId,
            policyVersionId: "policy_root_competing_other",
          });
          await Promise.all([
            repository.publishReleasePolicy(policy),
            repository.publishReleasePolicy(other),
          ]);
          const left = await repository.findReleasePolicyLogicalRoot(scope, policy.policyVersionId);
          const right = await repository.findReleasePolicyLogicalRoot(scope, other.policyVersionId);
          assert.deepEqual(left, right);
          assert.ok(left);
          assert.ok(
            left.policyVersionId === policy.policyVersionId ||
              left.policyVersionId === other.policyVersionId,
          );
          assert.deepEqual(left, left.policyVersionId === policy.policyVersionId ? policy : other);
        });
      },
    },
  ];
