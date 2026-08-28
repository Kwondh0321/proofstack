import { type ArtifactCatalogEntry, ArtifactConflictError } from "@proofstack/artifacts";
import { artifactCatalogRepositoryConformanceCases } from "@proofstack/artifacts/testing";
import type { ArtifactTombstone } from "@proofstack/contracts";
import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import {
  PostgresArtifactCatalogRepository,
  PostgresArtifactDataIntegrityError,
} from "./postgres-artifact-catalog-repository.js";

interface StoredRow extends Record<string, unknown> {
  artifact_id?: unknown;
  available_at?: unknown;
  created_at?: unknown;
  environment_id?: unknown;
  expires_at?: unknown;
  object_receipt_sha256?: unknown;
  object_receipt_size_bytes?: unknown;
  project_id?: unknown;
  purged_at?: unknown;
  retention_mode?: unknown;
  state?: unknown;
  tenant_id?: unknown;
  tombstoned_at?: unknown;
}

interface StoredArtifact {
  row: StoredRow;
}

function normalized(timestamp: unknown): string | null {
  return typeof timestamp === "string" ? new Date(timestamp).toISOString() : null;
}

function artifactKey(tenantId: unknown, artifactId: unknown): string {
  return `${String(tenantId)}:${String(artifactId)}`;
}

function scopeMatches(row: StoredRow, values: readonly unknown[]): boolean {
  return (
    row.tenant_id === values[0] && row.project_id === values[1] && row.environment_id === values[2]
  );
}

class ArtifactCatalogFakeClient {
  private readonly artifacts = new Map<string, StoredArtifact>();
  private readonly purgeReceipts = new Set<string>();
  private readonly tombstones = new Map<string, StoredRow>();
  readonly queries: Array<{ readonly text: string; readonly values?: readonly unknown[] }> = [];
  readonly releaseArguments: Array<boolean | undefined> = [];
  nextTombstoneInsertError?: unknown;

  async query(text: string, values: readonly unknown[] = []): Promise<{ rows: StoredRow[] }> {
    this.queries.push({ text, ...(values.length > 0 ? { values } : {}) });
    if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return { rows: [] };
    if (text.includes("set_config('proofstack.tenant_id'")) return { rows: [] };

    if (text.includes("INSERT INTO public.proofstack_artifact_catalog")) {
      const key = artifactKey(values[0], values[3]);
      if (this.artifacts.has(key)) return { rows: [] };
      this.artifacts.set(key, {
        row: {
          artifact_id: values[3],
          available_at: null,
          classification: values[6],
          content_nonce: values[17],
          content_sha256: values[8],
          content_size_bytes: values[9],
          created_at: normalized(values[13]),
          created_by_principal_id: values[14],
          encryption_version: values[16],
          environment_id: values[2],
          expires_at: normalized(values[12]),
          media_type: values[7],
          object_key: values[15],
          object_receipt_sha256: null,
          object_receipt_size_bytes: null,
          project_id: values[1],
          purged_at: null,
          redaction: JSON.parse(String(values[10])),
          retention_mode: values[11],
          schema_version: values[4],
          state: values[5],
          tenant_id: values[0],
          tombstoned_at: null,
          wrapped_key_algorithm: values[18],
          wrapped_key_ciphertext: values[20],
          wrapped_key_id: values[19],
          wrapped_key_nonce: values[21],
          wrapped_key_tag: values[22],
        },
      });
      return { rows: [{ artifact_id: values[3] }] };
    }

    if (text.includes("INSERT INTO public.proofstack_artifact_tombstones")) {
      if (this.nextTombstoneInsertError !== undefined) {
        const error = this.nextTombstoneInsertError;
        this.nextTombstoneInsertError = undefined;
        throw error;
      }
      const key = artifactKey(values[0], values[1]);
      this.tombstones.set(key, {
        actor_principal_id: values[3],
        artifact_id: values[1],
        occurred_at: normalized(values[6]),
        reason: values[5],
        tombstone_id: values[2],
        tombstone_trigger: values[4],
      });
      return { rows: [] };
    }

    if (text.includes("INSERT INTO public.proofstack_artifact_purge_receipts")) {
      this.purgeReceipts.add(artifactKey(values[0], values[1]));
      return { rows: [] };
    }

    if (text.includes("SELECT EXISTS") && text.includes("artifact_purge_receipts")) {
      return { rows: [{ present: this.purgeReceipts.has(artifactKey(values[0], values[1])) }] };
    }

    if (text.includes("FROM public.proofstack_artifact_tombstones")) {
      const row = this.tombstones.get(artifactKey(values[0], values[1]));
      return { rows: row ? [structuredClone(row)] : [] };
    }

    if (text.includes("UPDATE public.proofstack_artifact_catalog")) {
      const stored = this.artifacts.get(artifactKey(values[0], values[3]));
      if (!stored || !scopeMatches(stored.row, values)) return { rows: [] };
      if (text.includes("state = 'available'")) {
        stored.row.state = "available";
        stored.row.available_at = normalized(values[4]);
        stored.row.object_receipt_sha256 = values[5];
        stored.row.object_receipt_size_bytes = values[6];
      } else if (text.includes("state = 'tombstoned'")) {
        stored.row.state = "tombstoned";
        stored.row.tombstoned_at = normalized(values[4]);
      } else if (text.includes("state = 'purged'")) {
        stored.row.state = "purged";
        stored.row.purged_at = normalized(values[4]);
      }
      return { rows: [] };
    }

    if (text.includes("FROM public.proofstack_artifact_catalog")) {
      if (text.includes("state = 'available'") && text.includes("expires_at <=")) {
        return {
          rows: this.list(
            values,
            (row) => {
              const expiresAt = row.expires_at;
              return (
                row.state === "available" &&
                row.retention_mode === "expire" &&
                typeof expiresAt === "string" &&
                Date.parse(expiresAt) <= Date.parse(String(values[3]))
              );
            },
            "expires_at",
            Number(values[4]),
          ),
        };
      }
      if (text.includes("state = 'reserved'") && text.includes("created_at <=")) {
        return {
          rows: this.list(
            values,
            (row) => {
              const createdAt = row.created_at;
              return (
                row.state === "reserved" &&
                typeof createdAt === "string" &&
                Date.parse(createdAt) <= Date.parse(String(values[3]))
              );
            },
            "created_at",
            Number(values[4]),
          ),
        };
      }
      if (text.includes("state = 'tombstoned'")) {
        return {
          rows: this.list(
            values,
            (row) => row.state === "tombstoned",
            "tombstoned_at",
            Number(values[3]),
          ),
        };
      }

      const stored = this.artifacts.get(artifactKey(values[0], values.at(-1)));
      if (!stored) return { rows: [] };
      if (values.length === 4 && !scopeMatches(stored.row, values)) return { rows: [] };
      return { rows: [structuredClone(stored.row)] };
    }

    throw new Error(`Unexpected SQL in artifact catalog fake: ${text}`);
  }

  release(argument?: boolean): void {
    this.releaseArguments.push(argument);
  }

  corrupt(tenantId: string, artifactId: string, changes: StoredRow): void {
    const stored = this.artifacts.get(artifactKey(tenantId, artifactId));
    if (!stored) throw new Error("Artifact to corrupt was not found");
    Object.assign(stored.row, changes);
  }

  forgetPurgeReceipt(tenantId: string, artifactId: string): void {
    this.purgeReceipts.delete(artifactKey(tenantId, artifactId));
  }

  private list(
    values: readonly unknown[],
    predicate: (row: StoredRow) => boolean,
    timestampColumn: string,
    limit: number,
  ): StoredRow[] {
    return [...this.artifacts.values()]
      .map(({ row }) => row)
      .filter((row) => scopeMatches(row, values) && predicate(row))
      .sort((left, right) => {
        const timeOrder =
          Date.parse(String(left[timestampColumn])) - Date.parse(String(right[timestampColumn]));
        return timeOrder || String(left.artifact_id).localeCompare(String(right.artifact_id));
      })
      .slice(0, limit)
      .map((row) => structuredClone(row));
  }
}

function poolWith(client: ArtifactCatalogFakeClient): Pick<Pool, "connect"> {
  return {
    connect: async () => client,
  } as unknown as Pick<Pool, "connect">;
}

function candidate(
  overrides: Partial<ArtifactCatalogEntry["metadata"]> = {},
): ArtifactCatalogEntry {
  return {
    createdByPrincipalId: "usr_postgres_catalog",
    encryption: {
      contentNonce: Buffer.alloc(12, 1).toString("base64url"),
      version: "a256gcm-v1",
      wrappedDataKey: {
        algorithm: "A256GCM",
        ciphertext: Buffer.alloc(32, 2).toString("base64url"),
        keyId: "key_postgres_catalog",
        nonce: Buffer.alloc(12, 3).toString("base64url"),
        tag: Buffer.alloc(16, 4).toString("base64url"),
      },
    },
    metadata: {
      contentReference: {
        artifactId: "art_postgres_catalog",
        classification: "confidential",
        mediaType: "application/json",
        sha256: "1".repeat(64),
        sizeBytes: 18,
      },
      createdAt: "2026-08-28T03:00:00.000Z",
      redaction: { status: "not_required" },
      retention: { expiresAt: "2026-09-28T03:00:00.000Z", mode: "expire" },
      schemaVersion: "0.1",
      scope: {
        environmentId: "env_postgres_catalog",
        projectId: "prj_postgres_catalog",
        tenantId: "ten_postgres_catalog",
      },
      state: "reserved",
      ...overrides,
    },
    objectKey: "objects/v1/pc/postgres-catalog",
  };
}

function abandonedTombstone(artifactId: string): ArtifactTombstone {
  return {
    actorPrincipalId: "usr_postgres_catalog",
    artifactId,
    occurredAt: "2026-09-29T03:00:00.000Z",
    reason: "Abandoned reservation cleanup",
    tombstoneId: `del_${artifactId}`,
    trigger: "abandoned",
  };
}

describe("PostgresArtifactCatalogRepository contract", () => {
  for (const testCase of artifactCatalogRepositoryConformanceCases) {
    it(testCase.name, async () => {
      await testCase.run(() => {
        const client = new ArtifactCatalogFakeClient();
        return { repository: new PostgresArtifactCatalogRepository(poolWith(client)) };
      });
    });
  }

  it("reconstructs applied redaction, retained content, and encrypted object receipts", async () => {
    const client = new ArtifactCatalogFakeClient();
    const repository = new PostgresArtifactCatalogRepository(poolWith(client));
    const entry = candidate({
      contentReference: {
        artifactId: "art_postgres_catalog",
        classification: "confidential",
        mediaType: "application/json",
        redactedAt: "source",
        sha256: "1".repeat(64),
        sizeBytes: 18,
      },
      redaction: {
        records: [
          {
            changedPaths: ["/secret"],
            matchCount: 1,
            rulesetId: "rule_postgres_catalog",
            rulesetVersion: "1.0.0",
            stage: "source",
          },
        ],
        status: "applied",
      },
      retention: { mode: "retain" },
    });
    await repository.reserve(entry);
    const activated = await repository.activate(
      entry.metadata.scope,
      entry.metadata.contentReference.artifactId,
      { sha256: "a".repeat(64), sizeBytes: 38 },
      "2026-08-28T03:01:00.000Z",
    );

    await expect(
      repository.find(entry.metadata.scope, entry.metadata.contentReference.artifactId),
    ).resolves.toEqual(activated);
  });

  it.each([
    ["timestamp", { available_at: 42 }],
    ["metadata", { schema_version: "broken" }],
    ["protection", { content_nonce: "not-canonical" }],
    ["object key", { object_key: " unsafe " }],
    ["receipt", { object_receipt_sha256: "a".repeat(64) }],
  ])("fails closed for corrupt stored %s data", async (_label, corruption) => {
    const client = new ArtifactCatalogFakeClient();
    const repository = new PostgresArtifactCatalogRepository(poolWith(client));
    const entry = candidate();
    await repository.reserve(entry);
    client.corrupt(
      entry.metadata.scope.tenantId,
      entry.metadata.contentReference.artifactId,
      corruption,
    );

    await expect(
      repository.find(entry.metadata.scope, entry.metadata.contentReference.artifactId),
    ).rejects.toBeInstanceOf(PostgresArtifactDataIntegrityError);
  });

  it("maps lifecycle receipt uniqueness failures to domain conflicts", async () => {
    const client = new ArtifactCatalogFakeClient();
    const repository = new PostgresArtifactCatalogRepository(poolWith(client));
    const entry = candidate();
    await repository.reserve(entry);
    client.nextTombstoneInsertError = { code: "23505" };

    await expect(
      repository.tombstone(
        entry.metadata.scope,
        abandonedTombstone(entry.metadata.contentReference.artifactId),
      ),
    ).rejects.toBeInstanceOf(ArtifactConflictError);
  });

  it("detects a terminal catalog row without its append-only purge receipt", async () => {
    const client = new ArtifactCatalogFakeClient();
    const repository = new PostgresArtifactCatalogRepository(poolWith(client));
    const entry = candidate();
    const artifactId = entry.metadata.contentReference.artifactId;
    await repository.reserve(entry);
    await repository.tombstone(entry.metadata.scope, abandonedTombstone(artifactId));
    await repository.recordPurge(entry.metadata.scope, {
      artifactId,
      objectWasPresent: false,
      occurredAt: "2026-09-29T03:01:00.000Z",
      purgeId: "purge_postgres_catalog",
    });
    client.forgetPurgeReceipt(entry.metadata.scope.tenantId, artifactId);

    await expect(
      repository.recordPurge(entry.metadata.scope, {
        artifactId,
        objectWasPresent: false,
        occurredAt: "2026-09-29T03:02:00.000Z",
        purgeId: "purge_retry_postgres_catalog",
      }),
    ).rejects.toBeInstanceOf(PostgresArtifactDataIntegrityError);
  });
});
