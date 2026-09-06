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
import { PostgresReleaseCandidateRepository } from "./postgres-release-candidate-repository.js";

interface FakeStoredRow {
  readonly candidate_id: string;
  readonly candidate_version_id: string;
  readonly created_at_lexical: string;
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
