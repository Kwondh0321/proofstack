import { createHash, randomUUID } from "node:crypto";
import type { EvidenceScope } from "@proofstack/contracts";
import { ReleaseCandidateRepositoryContractError } from "@proofstack/core";
import {
  createReleaseCandidateRepositoryTestHarness,
  releaseCandidateFixture,
} from "@proofstack/core/testing";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateDatabase } from "./migration-runner.js";
import {
  PostgresReleaseCandidateRepository,
  readPostgresReleaseCandidateOnClient,
} from "./postgres-release-candidate-repository.js";
import { provisionRuntimeRoles, type RuntimeRoleProvisioningOptions } from "./runtime-roles.js";
import { withExactScopeTransaction } from "./tenant-transaction.js";

const databaseUrl = process.env["PROOFSTACK_TEST_DATABASE_URL"];
if (!databaseUrl) throw new Error("PROOFSTACK_TEST_DATABASE_URL is required");
const key = randomUUID().replaceAll("-", "").slice(0, 12);
const credentials = Object.fromEntries(
  [
    "api",
    "artifact",
    "consumer",
    "evaluationWorker",
    "humanReviewer",
    "identity",
    "modelEvaluationWorker",
    "policyAuthor",
    "publisher",
    "replayWorker",
  ].map((kind) => [
    kind,
    {
      name: `ps_cphys_${kind.toLowerCase()}_${key}`,
      password: `proofstack-candidate-fixture-${key}`,
    },
  ]),
) as unknown as RuntimeRoleProvisioningOptions;
const admin = new Pool({ connectionString: databaseUrl, max: 2 });
const apiUrl = new URL(databaseUrl);
apiUrl.username = credentials.api.name;
apiUrl.password = credentials.api.password;
const api = new Pool({ connectionString: apiUrl.toString(), max: 2 });
const repository = new PostgresReleaseCandidateRepository(api);
const h = createReleaseCandidateRepositoryTestHarness(`pc_${key}`);
const sibling = releaseCandidateFixture(`pc_${key}`, h.scope, { version: "v3" });
const tables = [
  "proofstack_release_candidates",
  "proofstack_release_candidate_registry",
  "proofstack_release_candidate_resources",
  "proofstack_release_candidate_lineage",
  "proofstack_outbox",
];

beforeAll(async () => {
  expect((await admin.query("SELECT current_database() AS name")).rows[0]?.name).toBe(
    "proofstack_test",
  );
  await migrateDatabase(admin);
  await provisionRuntimeRoles(admin, credentials);
  for (const record of [h.candidate, h.successor, sibling, h.unrelatedCandidate])
    await repository.publishReleaseCandidate(record);
});
afterAll(async () => {
  await api.end();
  for (const role of Object.values(credentials)) {
    await admin.query(`DROP OWNED BY "${role.name}"`);
    await admin.query(`DROP ROLE "${role.name}"`);
  }
  await admin.end();
});

async function fingerprint() {
  const state = [];
  for (const table of tables)
    state.push(
      (
        await admin.query(
          `SELECT to_jsonb(item) AS record FROM public.${table} AS item WHERE tenant_id = $1 ORDER BY to_jsonb(item)::text`,
          [h.scope.tenantId],
        )
      ).rows,
    );
  return createHash("sha256").update(JSON.stringify(state)).digest("hex");
}
async function damaged(
  mutate: (client: PoolClient) => Promise<void>,
  inspect: (client: PoolClient) => Promise<void>,
  scope: EvidenceScope = h.scope,
) {
  const before = await fingerprint();
  try {
    await withExactScopeTransaction(admin, scope, async (client) => {
      await client.query("SAVEPOINT retained_original");
      try {
        // Only administrator-owned disposable damage. CHECKs stay enabled; all mutations roll back.
        await client.query("SET LOCAL session_replication_role = 'replica'");
        await mutate(client);
        await client.query(`SET LOCAL ROLE "${credentials.api.name}"`);
        await inspect(client);
      } finally {
        await client.query("ROLLBACK TO SAVEPOINT retained_original");
      }
    });
  } finally {
    expect(await fingerprint()).toBe(before);
    await expect(
      repository.findReleaseCandidate(h.scope, h.candidate.candidateVersionId),
    ).resolves.toEqual(h.candidate);
    await expect(
      repository.findReleaseCandidate(h.scope, h.successor.candidateVersionId),
    ).resolves.toEqual(h.successor);
  }
}
async function rejectSuccessor(client: PoolClient) {
  await expect(
    readPostgresReleaseCandidateOnClient(client, h.scope, h.successor.candidateVersionId),
  ).rejects.toBeInstanceOf(ReleaseCandidateRepositoryContractError);
}
async function remove(client: PoolClient, table: string, column: string, id: string) {
  expect(
    (
      await client.query(`DELETE FROM public.${table} WHERE tenant_id = $1 AND ${column} = $2`, [
        h.scope.tenantId,
        id,
      ])
    ).rowCount,
  ).toBe(1);
}

describe("owning release candidate physical and scoped presence integrity", () => {
  it("retains canonical roots, successors, independent versions and original retry receipts", async () => {
    for (const record of [h.candidate, h.successor, sibling]) {
      await expect(
        repository.findReleaseCandidate(h.scope, record.candidateVersionId),
      ).resolves.toEqual(record);
      const retry = {
        ...record,
        createdAt: "2026-09-06T15:00:01.000Z",
        createdByPrincipalId: "principal_retry",
      };
      await expect(repository.publishReleaseCandidate(retry)).resolves.toEqual({
        candidate: record,
        created: false,
      });
    }
  });
  for (const target of [
    "child_registry",
    "parent_registry",
    "predecessor_edge",
    "logical_resource",
    "original_intent",
    "root_body",
    "root_intent",
  ] as const) {
    it(`rejects a missing ${target} on the same API-role backend`, async () => {
      await damaged(async (client) => {
        switch (target) {
          case "child_registry":
            return remove(
              client,
              "proofstack_release_candidate_registry",
              "candidate_version_id",
              h.successor.candidateVersionId,
            );
          case "parent_registry":
            return remove(
              client,
              "proofstack_release_candidate_registry",
              "candidate_version_id",
              h.candidate.candidateVersionId,
            );
          case "predecessor_edge":
            return remove(
              client,
              "proofstack_release_candidate_lineage",
              "child_candidate_version_id",
              h.successor.candidateVersionId,
            );
          case "logical_resource":
            return remove(
              client,
              "proofstack_release_candidate_resources",
              "candidate_id",
              h.candidate.candidateId,
            );
          case "original_intent":
            return remove(
              client,
              "proofstack_outbox",
              "aggregate_id",
              h.successor.candidateVersionId,
            );
          case "root_body":
            return remove(
              client,
              "proofstack_release_candidates",
              "candidate_version_id",
              h.candidate.candidateVersionId,
            );
          case "root_intent":
            return remove(
              client,
              "proofstack_outbox",
              "aggregate_id",
              h.candidate.candidateVersionId,
            );
        }
      }, rejectSuccessor);
    });
  }
  for (const owner of ["child", "parent"] as const) {
    for (const column of ["project_id", "environment_id", "definition_sha256"] as const) {
      it(`rejects ${owner} registry ${column} disagreement`, async () => {
        await damaged(async (client) => {
          const id =
            owner === "child" ? h.successor.candidateVersionId : h.candidate.candidateVersionId;
          const value = column === "definition_sha256" ? "f".repeat(64) : "scope_other";
          expect(
            (
              await client.query(
                `UPDATE public.proofstack_release_candidate_registry SET ${column} = $3::text WHERE tenant_id = $1 AND candidate_version_id = $2`,
                [h.scope.tenantId, id, value],
              )
            ).rowCount,
          ).toBe(1);
        }, rejectSuccessor);
      });
    }
  }
  for (const column of [
    "project_id",
    "environment_id",
    "child_definition_sha256",
    "parent_definition_sha256",
  ] as const) {
    it(`rejects predecessor edge ${column} disagreement`, async () => {
      await damaged(async (client) => {
        const value = column.includes("sha256") ? "f".repeat(64) : "scope_other";
        expect(
          (
            await client.query(
              `UPDATE public.proofstack_release_candidate_lineage SET ${column} = $3::text WHERE tenant_id = $1 AND child_candidate_version_id = $2`,
              [h.scope.tenantId, h.successor.candidateVersionId, value],
            )
          ).rowCount,
        ).toBe(1);
      }, rejectSuccessor);
    });
  }
  it("does not accept a valid but different parent registry as the canonical predecessor", async () => {
    await damaged(async (client) => {
      expect(
        (
          await client.query(
            `UPDATE public.proofstack_release_candidate_lineage SET parent_candidate_version_id = $3, parent_definition_sha256 = $4 WHERE tenant_id = $1 AND child_candidate_version_id = $2`,
            [
              h.scope.tenantId,
              h.successor.candidateVersionId,
              h.unrelatedCandidate.candidateVersionId,
              h.unrelatedCandidate.definitionSha256,
            ],
          )
        ).rowCount,
      ).toBe(1);
    }, rejectSuccessor);
  });
  for (const column of ["project_id", "environment_id", "root_definition_sha256"] as const) {
    it(`rejects logical resource ${column} disagreement`, async () => {
      await damaged(async (client) => {
        const value = column.includes("sha256") ? "f".repeat(64) : "scope_other";
        expect(
          (
            await client.query(
              `UPDATE public.proofstack_release_candidate_resources SET ${column} = $3::text WHERE tenant_id = $1 AND candidate_id = $2`,
              [h.scope.tenantId, h.candidate.candidateId, value],
            )
          ).rowCount,
        ).toBe(1);
      }, rejectSuccessor);
    });
  }
  it("rejects a successor or unrelated canonical body as the resource root", async () => {
    for (const root of [h.successor, h.unrelatedCandidate]) {
      await damaged(async (client) => {
        expect(
          (
            await client.query(
              `UPDATE public.proofstack_release_candidate_resources SET root_candidate_version_id = $3, root_definition_sha256 = $4 WHERE tenant_id = $1 AND candidate_id = $2`,
              [
                h.scope.tenantId,
                h.candidate.candidateId,
                root.candidateVersionId,
                root.definitionSha256,
              ],
            )
          ).rowCount,
        ).toBe(1);
      }, rejectSuccessor);
    }
  });
  it("rejects one unexpected edge on a root with no canonical predecessor", async () => {
    await damaged(
      async (client) => {
        await client.query(
          `INSERT INTO public.proofstack_release_candidate_lineage (tenant_id, project_id, environment_id, child_candidate_version_id, child_definition_sha256, parent_candidate_version_id, parent_definition_sha256) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            h.scope.tenantId,
            h.scope.projectId,
            h.scope.environmentId,
            h.candidate.candidateVersionId,
            h.candidate.definitionSha256,
            h.successor.candidateVersionId,
            h.successor.definitionSha256,
          ],
        );
      },
      async (client) => {
        await expect(
          readPostgresReleaseCandidateOnClient(client, h.scope, h.candidate.candidateVersionId),
        ).rejects.toBeInstanceOf(ReleaseCandidateRepositoryContractError);
      },
    );
  });
  it("reconciles absent bodies with each owned normalized metadata witness", async () => {
    for (const witness of ["registry", "lineage", "root_resource"] as const) {
      await damaged(
        async (client) => {
          const root = witness === "root_resource";
          const id = root ? h.candidate.candidateVersionId : h.successor.candidateVersionId;
          await remove(client, "proofstack_release_candidates", "candidate_version_id", id);
          if (witness !== "registry")
            await remove(
              client,
              "proofstack_release_candidate_registry",
              "candidate_version_id",
              id,
            );
        },
        async (client) => {
          const id =
            witness === "root_resource"
              ? h.candidate.candidateVersionId
              : h.successor.candidateVersionId;
          await expect(
            readPostgresReleaseCandidateOnClient(client, h.scope, id),
          ).rejects.toBeInstanceOf(ReleaseCandidateRepositoryContractError);
        },
      );
    }
  });
  it("keeps outside storage damage opaque in all three scope dimensions", async () => {
    for (const dimension of ["tenantId", "projectId", "environmentId"] as const) {
      const scope = { ...h.scope, [dimension]: "scope_other" };
      await damaged(
        (client) =>
          remove(
            client,
            "proofstack_release_candidate_registry",
            "candidate_version_id",
            h.successor.candidateVersionId,
          ),
        async (client) => {
          await expect(
            readPostgresReleaseCandidateOnClient(client, scope, h.successor.candidateVersionId),
          ).resolves.toBeNull();
        },
        scope,
      );
    }
  });
  it("does not turn outbox delivery metadata into a different canonical intent", async () => {
    const before = await fingerprint();
    await withExactScopeTransaction(admin, h.scope, async (client) => {
      await client.query("SAVEPOINT delivery_metadata");
      try {
        // Normal triggers remain enabled for this legitimate delivery-state mutation.
        await client.query(
          "UPDATE public.proofstack_outbox SET attempt_count = attempt_count + 1 WHERE tenant_id = $1 AND aggregate_id = $2",
          [h.scope.tenantId, h.successor.candidateVersionId],
        );
        await client.query(`SET LOCAL ROLE "${credentials.api.name}"`);
        await expect(
          readPostgresReleaseCandidateOnClient(client, h.scope, h.successor.candidateVersionId),
        ).resolves.toEqual(h.successor);
      } finally {
        await client.query("ROLLBACK TO SAVEPOINT delivery_metadata");
      }
    });
    expect(await fingerprint()).toBe(before);
  });
});
