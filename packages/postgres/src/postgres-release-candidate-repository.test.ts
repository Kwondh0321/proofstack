import type { ReleaseCandidate } from "@proofstack/contracts";
import {
  InvalidReleaseCandidateRecordInputError,
  ReleaseCandidateLineageError,
  ReleaseCandidateRepositoryContractError,
  ReleaseCandidateResourceConflictError,
  ReleaseCandidateVersionConflictError,
} from "@proofstack/core";
import { createReleaseCandidateRepositoryTestHarness } from "@proofstack/core/testing";
import type { Pool, PoolClient } from "pg";
import { describe, expect, it } from "vitest";
import {
  PostgresReleaseCandidateRepository,
  readPostgresReleaseCandidateOnClient,
} from "./postgres-release-candidate-repository.js";

interface FakeStoredRow {
  readonly candidate_id: string;
  readonly candidate_version_id: string;
  readonly created_at_lexical: string;
  readonly created_at_matches: boolean;
  readonly created_by_principal_id: string;
  readonly definition_sha256: string;
  readonly environment_id: string;
  readonly lineage_count: number;
  readonly project_id: string;
  readonly record: unknown;
  readonly schema_version: string;
  readonly tenant_id: string;
}

function storedRow(candidate: ReleaseCandidate): FakeStoredRow {
  return {
    candidate_id: candidate.candidateId,
    candidate_version_id: candidate.candidateVersionId,
    created_at_lexical: candidate.createdAt,
    created_at_matches: true,
    created_by_principal_id: candidate.createdByPrincipalId,
    definition_sha256: candidate.definitionSha256,
    environment_id: candidate.scope.environmentId,
    lineage_count: Number(candidate.predecessor !== undefined),
    project_id: candidate.scope.projectId,
    record: structuredClone(candidate),
    schema_version: candidate.schemaVersion,
    tenant_id: candidate.scope.tenantId,
  };
}

function postgresError(code: string, message: string): Error & { readonly code: string } {
  return Object.assign(new Error(message), { code });
}

class FakeClient {
  readonly records = new Map<string, FakeStoredRow>();
  readonly releases: (boolean | undefined)[] = [];
  readonly statements: string[] = [];
  intentStatus = "canonical";
  publishError: unknown;
  retainAfterPublish = true;

  async query(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ readonly rows: readonly unknown[] }> {
    this.statements.push(text.trim());
    if (text.includes("AS retained_candidate_storage")) {
      return { rows: [{ retained_candidate_storage: false }] };
    }
    if (text.includes("FROM public.proofstack_release_candidate_resources AS binding")) {
      const root = [...this.records.values()].find(
        (row) =>
          row.tenant_id === values?.[0] &&
          row.candidate_id === values?.[1] &&
          !(row.record as ReleaseCandidate).predecessor,
      );
      return {
        rows: root
          ? [
              {
                ...root,
                root_candidate_version_id: root.candidate_version_id,
                root_definition_sha256: root.definition_sha256,
                root_matches: true,
              },
            ]
          : [],
      };
    }
    if (text.includes("FROM public.proofstack_release_candidate_lineage AS edge")) {
      const row = this.records.get(`${String(values?.[0])}:${String(values?.[1])}`);
      const predecessor = (row?.record as ReleaseCandidate | undefined)?.predecessor;
      return {
        rows: predecessor
          ? [
              {
                parent_candidate_version_id: predecessor.candidateVersionId,
                parent_definition_sha256: predecessor.definitionSha256,
                child_matches: true,
                parent_matches: true,
              },
            ]
          : [],
      };
    }
    if (text.includes("FROM public.proofstack_release_candidate_registry")) {
      const row = this.records.get(`${String(values?.[0])}:${String(values?.[1])}`);
      return { rows: row ? [structuredClone(row)] : [] };
    }
    if (text.includes("FROM public.proofstack_release_candidates")) {
      const key = `${String(values?.[0])}:${String(values?.[1])}`;
      const row = this.records.get(key);
      return { rows: row ? [structuredClone(row)] : [] };
    }
    if (text.includes("proofstack_release_candidate_intent_status")) {
      return { rows: [{ status: this.intentStatus }] };
    }
    if (text.includes("proofstack_publish_release_candidate")) {
      if (this.publishError !== undefined) throw this.publishError;
      if (this.retainAfterPublish) {
        const command = JSON.parse(String(values?.[0])) as { readonly record: ReleaseCandidate };
        const row = storedRow(command.record);
        this.records.set(`${row.tenant_id}:${row.candidate_version_id}`, row);
      }
    }
    return { rows: [] };
  }

  release(destroy?: boolean): void {
    this.releases.push(destroy);
  }
}

function poolWith(client: FakeClient): Pick<Pool, "connect"> {
  return {
    connect: async () => client as unknown as PoolClient,
  } as Pick<Pool, "connect">;
}

function repositoryWith(client: FakeClient): PostgresReleaseCandidateRepository {
  return new PostgresReleaseCandidateRepository(poolWith(client));
}

describe("PostgresReleaseCandidateRepository", () => {
  it.each([false, null, undefined, "true", "false", 1])(
    "rejects non-native or false retained timestamp agreement %s",
    async (flag) => {
      const h = createReleaseCandidateRepositoryTestHarness("candidate_native_receipt");
      const client = new FakeClient();
      client.records.set(`${h.scope.tenantId}:${h.candidate.candidateVersionId}`, {
        ...storedRow(h.candidate),
        created_at_matches: flag as boolean,
      });
      await expect(
        repositoryWith(client).findReleaseCandidate(h.scope, h.candidate.candidateVersionId),
      ).rejects.toBeInstanceOf(ReleaseCandidateRepositoryContractError);
    },
  );

  it.each([
    { name: "missing", rows: [] },
    {
      name: "duplicate",
      rows: [{ retained_candidate_storage: false }, { retained_candidate_storage: false }],
    },
    ...[true, null, undefined, "false", 0].map((flag) => ({
      name: `invalid_${String(flag)}`,
      rows: [{ retained_candidate_storage: flag }],
    })),
  ])("rejects $name absence witnesses without transaction cleanup", async ({ rows }) => {
    const h = createReleaseCandidateRepositoryTestHarness("candidate_absence_witness");
    const client = new FakeClient();
    const view = {
      query: async (sql: string, values?: readonly unknown[]) => {
        const result = await client.query(sql, values);
        return sql.includes("AS retained_candidate_storage") ? { rows } : result;
      },
    } as unknown as Pick<PoolClient, "query">;
    await expect(
      readPostgresReleaseCandidateOnClient(view, h.scope, "candidate_missing"),
    ).rejects.toBeInstanceOf(ReleaseCandidateRepositoryContractError);
    expect(client.releases).toEqual([]);
    expect(client.statements.every((sql) => sql.startsWith("SELECT"))).toBe(true);
  });

  it.each([
    {
      name: "missing registry",
      target: "FROM public.proofstack_release_candidate_registry",
      field: null,
      value: null,
    },
    {
      name: "registry project",
      target: "FROM public.proofstack_release_candidate_registry",
      field: "project_id",
      value: "project_other",
    },
    {
      name: "registry environment",
      target: "FROM public.proofstack_release_candidate_registry",
      field: "environment_id",
      value: "environment_other",
    },
    {
      name: "registry schema",
      target: "FROM public.proofstack_release_candidate_registry",
      field: "schema_version",
      value: "0.2",
    },
    {
      name: "registry digest",
      target: "FROM public.proofstack_release_candidate_registry",
      field: "definition_sha256",
      value: "f".repeat(64),
    },
    {
      name: "missing lineage",
      target: "FROM public.proofstack_release_candidate_lineage AS edge",
      field: null,
      value: null,
    },
    {
      name: "lineage parent",
      target: "FROM public.proofstack_release_candidate_lineage AS edge",
      field: "parent_candidate_version_id",
      value: "candidate_other",
    },
    {
      name: "lineage digest",
      target: "FROM public.proofstack_release_candidate_lineage AS edge",
      field: "parent_definition_sha256",
      value: "f".repeat(64),
    },
    {
      name: "lineage child native flag",
      target: "FROM public.proofstack_release_candidate_lineage AS edge",
      field: "child_matches",
      value: "true",
    },
    {
      name: "lineage parent native flag",
      target: "FROM public.proofstack_release_candidate_lineage AS edge",
      field: "parent_matches",
      value: "true",
    },
    {
      name: "missing binding",
      target: "FROM public.proofstack_release_candidate_resources AS binding",
      field: null,
      value: null,
    },
    {
      name: "binding project",
      target: "FROM public.proofstack_release_candidate_resources AS binding",
      field: "project_id",
      value: "project_other",
    },
    {
      name: "binding environment",
      target: "FROM public.proofstack_release_candidate_resources AS binding",
      field: "environment_id",
      value: "environment_other",
    },
    {
      name: "binding root native flag",
      target: "FROM public.proofstack_release_candidate_resources AS binding",
      field: "root_matches",
      value: "true",
    },
    {
      name: "binding root digest",
      target: "FROM public.proofstack_release_candidate_resources AS binding",
      field: "root_definition_sha256",
      value: "f".repeat(64),
    },
  ])("rejects $name before accepting a canonical successor", async ({ target, field, value }) => {
    const h = createReleaseCandidateRepositoryTestHarness("candidate_physical_unit");
    const client = new FakeClient();
    client.records.set(
      `${h.scope.tenantId}:${h.candidate.candidateVersionId}`,
      storedRow(h.candidate),
    );
    client.records.set(
      `${h.scope.tenantId}:${h.successor.candidateVersionId}`,
      storedRow(h.successor),
    );
    const view = {
      query: async (sql: string, values?: readonly unknown[]) => {
        const result = await client.query(sql, values);
        // Change only the owning child response; nested parent predicates remain actual flags.
        if (!sql.includes(target)) return result;
        return {
          rows:
            field === null
              ? []
              : result.rows.map((row) => ({ ...(row as object), [field]: value })),
        };
      },
    } as unknown as Pick<PoolClient, "query">;
    await expect(
      readPostgresReleaseCandidateOnClient(view, h.scope, h.successor.candidateVersionId),
    ).rejects.toBeInstanceOf(ReleaseCandidateRepositoryContractError);
    expect(client.releases).toEqual([]);
  });

  it("does not accept a successor as a logical root or an extra edge on a root", async () => {
    const h = createReleaseCandidateRepositoryTestHarness("candidate_root_unit");
    for (const failure of ["successor_root", "unexpected_root_edge"] as const) {
      const client = new FakeClient();
      client.records.set(
        `${h.scope.tenantId}:${h.candidate.candidateVersionId}`,
        storedRow(h.candidate),
      );
      client.records.set(
        `${h.scope.tenantId}:${h.successor.candidateVersionId}`,
        storedRow(h.successor),
      );
      const view = {
        query: async (sql: string, values?: readonly unknown[]) => {
          const result = await client.query(sql, values);
          if (
            failure === "successor_root" &&
            sql.includes("FROM public.proofstack_release_candidate_resources AS binding")
          )
            return {
              rows: [
                {
                  project_id: h.scope.projectId,
                  environment_id: h.scope.environmentId,
                  root_candidate_version_id: h.successor.candidateVersionId,
                  root_definition_sha256: h.successor.definitionSha256,
                  root_matches: true,
                },
              ],
            };
          if (
            failure === "unexpected_root_edge" &&
            sql.includes("FROM public.proofstack_release_candidate_lineage AS edge") &&
            values?.[1] === h.candidate.candidateVersionId
          )
            return {
              rows: [
                {
                  parent_candidate_version_id: h.successor.candidateVersionId,
                  parent_definition_sha256: h.successor.definitionSha256,
                  child_matches: true,
                  parent_matches: true,
                },
              ],
            };
          return result;
        },
      } as unknown as Pick<PoolClient, "query">;
      await expect(
        readPostgresReleaseCandidateOnClient(view, h.scope, h.successor.candidateVersionId),
      ).rejects.toBeInstanceOf(ReleaseCandidateRepositoryContractError);
    }
  });

  it("rejects a missing exact logical-root body despite an asserted root registry match", async () => {
    const h = createReleaseCandidateRepositoryTestHarness("candidate_root_missing");
    const client = new FakeClient();
    client.records.set(
      `${h.scope.tenantId}:${h.successor.candidateVersionId}`,
      storedRow(h.successor),
    );
    const view = {
      query: async (sql: string, values?: readonly unknown[]) => {
        const result = await client.query(sql, values);
        if (sql.includes("FROM public.proofstack_release_candidate_resources AS binding"))
          return {
            rows: [
              {
                project_id: h.scope.projectId,
                environment_id: h.scope.environmentId,
                root_candidate_version_id: h.candidate.candidateVersionId,
                root_definition_sha256: h.candidate.definitionSha256,
                root_matches: true,
              },
            ],
          };
        return result;
      },
    } as unknown as Pick<PoolClient, "query">;
    await expect(
      readPostgresReleaseCandidateOnClient(view, h.scope, h.successor.candidateVersionId),
    ).rejects.toThrow("missing its exact body");
  });
  it("owns read scope before awaiting the supplied client or pool", async () => {
    const { candidate } = createReleaseCandidateRepositoryTestHarness("client_scope_copy");
    const scope = { ...candidate.scope };
    const client = new FakeClient();
    client.records.set(`${scope.tenantId}:${candidate.candidateVersionId}`, storedRow(candidate));
    const pending = readPostgresReleaseCandidateOnClient(
      client as unknown as Pick<PoolClient, "query">,
      scope,
      candidate.candidateVersionId,
    );
    scope.environmentId = "env_changed";
    await expect(pending).resolves.toEqual(candidate);
    expect(client.releases).toEqual([]);
    const poolScope = { ...candidate.scope };
    const repository = new PostgresReleaseCandidateRepository({
      connect: async () => {
        poolScope.projectId = "prj_changed";
        return client as unknown as PoolClient;
      },
    });
    await expect(
      repository.findReleaseCandidate(poolScope, candidate.candidateVersionId),
    ).resolves.toEqual(candidate);
  });
  it("publishes, verifies, reads, and isolates one canonical record", async () => {
    const harness = createReleaseCandidateRepositoryTestHarness("postgres_candidate_unit");
    const client = new FakeClient();
    const repository = repositoryWith(client);

    await expect(repository.publishReleaseCandidate(harness.candidate)).resolves.toEqual({
      candidate: harness.candidate,
      created: true,
    });
    await expect(
      repository.findReleaseCandidate(harness.scope, harness.candidate.candidateVersionId),
    ).resolves.toEqual(harness.candidate);
    await expect(
      repository.findReleaseCandidate(harness.scope, "candidate_missing_v1"),
    ).resolves.toBeNull();
    await expect(
      repository.findReleaseCandidate(harness.otherScope, harness.candidate.candidateVersionId),
    ).resolves.toBeNull();
    expect(
      client.statements.filter((statement) => statement.includes("pg_advisory_xact_lock")),
    ).toHaveLength(2);
    expect(client.releases).toEqual([undefined, undefined, undefined, undefined]);
  });

  it("returns the original authoritative receipt on an identical semantic retry", async () => {
    const harness = createReleaseCandidateRepositoryTestHarness("postgres_candidate_retry");
    const client = new FakeClient();
    const repository = repositoryWith(client);
    await repository.publishReleaseCandidate(harness.candidate);
    const retry = structuredClone(harness.candidate);
    retry.createdAt = "2026-09-06T15:00:01.000Z";
    retry.createdByPrincipalId = "principal_retry";

    await expect(repository.publishReleaseCandidate(retry)).resolves.toEqual({
      candidate: harness.candidate,
      created: false,
    });
  });

  it("rejects invalid input and conflicting stored semantics", async () => {
    const harness = createReleaseCandidateRepositoryTestHarness("postgres_candidate_conflict");
    const client = new FakeClient();
    const repository = repositoryWith(client);
    await expect(
      repository.publishReleaseCandidate({
        ...harness.candidate,
        definitionSha256: "0".repeat(64),
      }),
    ).rejects.toBeInstanceOf(InvalidReleaseCandidateRecordInputError);

    client.records.set(
      `${harness.scope.tenantId}:${harness.candidate.candidateVersionId}`,
      storedRow(harness.candidate),
    );
    await expect(repository.publishReleaseCandidate(harness.recordConflict)).rejects.toBeInstanceOf(
      ReleaseCandidateVersionConflictError,
    );
  });

  it("rejects malformed normalized rows and missing publication receipts", async () => {
    const harness = createReleaseCandidateRepositoryTestHarness("postgres_candidate_contract");
    const client = new FakeClient();
    const repository = repositoryWith(client);
    const malformed = {
      ...storedRow(harness.candidate),
      created_by_principal_id: "principal_substituted",
    };
    client.records.set(
      `${harness.scope.tenantId}:${harness.candidate.candidateVersionId}`,
      malformed,
    );
    await expect(
      repository.findReleaseCandidate(harness.scope, harness.candidate.candidateVersionId),
    ).rejects.toBeInstanceOf(ReleaseCandidateRepositoryContractError);

    client.records.set(
      `${harness.scope.tenantId}:${harness.candidate.candidateVersionId}`,
      storedRow(harness.candidate),
    );
    client.intentStatus = "conflict";
    await expect(
      repository.publishReleaseCandidate(structuredClone(harness.candidate)),
    ).rejects.toBeInstanceOf(ReleaseCandidateRepositoryContractError);
  });

  it("rejects persistence that reports success without retaining a record", async () => {
    const harness = createReleaseCandidateRepositoryTestHarness("postgres_candidate_missing");
    const client = new FakeClient();
    client.retainAfterPublish = false;
    await expect(
      repositoryWith(client).publishReleaseCandidate(harness.candidate),
    ).rejects.toBeInstanceOf(ReleaseCandidateRepositoryContractError);
  });

  it.each([
    {
      code: "23503",
      error: ReleaseCandidateLineageError,
      message: "missing predecessor",
    },
    {
      code: "23514",
      error: ReleaseCandidateLineageError,
      message: "lineage does not match",
    },
    {
      code: "23505",
      error: ReleaseCandidateResourceConflictError,
      message: "release candidate resource already bound",
    },
    {
      code: "23505",
      error: ReleaseCandidateVersionConflictError,
      message: "duplicate version",
    },
    {
      code: "23514",
      error: ReleaseCandidateRepositoryContractError,
      message: "normalized check failed",
    },
    {
      code: "22007",
      error: ReleaseCandidateRepositoryContractError,
      message: "invalid timestamp",
    },
    {
      code: "22P02",
      error: ReleaseCandidateRepositoryContractError,
      message: "invalid json representation",
    },
  ])("maps PostgreSQL $code failures to domain errors", async ({ code, error, message }) => {
    const harness = createReleaseCandidateRepositoryTestHarness(
      `postgres_candidate_${code.toLowerCase()}`,
    );
    const client = new FakeClient();
    client.publishError = postgresError(code, message);
    await expect(
      repositoryWith(client).publishReleaseCandidate(harness.candidate),
    ).rejects.toBeInstanceOf(error);
  });

  it("preserves authorization and unknown infrastructure failures", async () => {
    const harness = createReleaseCandidateRepositoryTestHarness("postgres_candidate_passthrough");
    for (const failure of [
      postgresError("42501", "permission denied"),
      new Error("connection interrupted"),
    ]) {
      const client = new FakeClient();
      client.publishError = failure;
      await expect(repositoryWith(client).publishReleaseCandidate(harness.candidate)).rejects.toBe(
        failure,
      );
    }
  });

  it("reports invalid retained JSON as a repository contract violation", async () => {
    const harness = createReleaseCandidateRepositoryTestHarness("postgres_candidate_invalid_json");
    const client = new FakeClient();
    client.records.set(`${harness.scope.tenantId}:${harness.candidate.candidateVersionId}`, {
      ...storedRow(harness.candidate),
      record: { candidateId: harness.candidate.candidateId },
    });
    await expect(
      repositoryWith(client).findReleaseCandidate(
        harness.scope,
        harness.candidate.candidateVersionId,
      ),
    ).rejects.toBeInstanceOf(ReleaseCandidateRepositoryContractError);
  });
});
