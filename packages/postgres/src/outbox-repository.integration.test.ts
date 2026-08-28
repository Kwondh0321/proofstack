import type { EvidenceEnvelope } from "@proofstack/contracts";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateDatabase } from "./migration-runner.js";
import { PostgresEvidenceRepository } from "./postgres-evidence-repository.js";
import { PostgresOutboxRepository } from "./postgres-outbox-repository.js";

const { PROOFSTACK_TEST_DATABASE_URL: databaseUrl } = process.env;
if (!databaseUrl) {
  throw new Error("PROOFSTACK_TEST_DATABASE_URL is required for PostgreSQL integration tests");
}

const producerRole = "proofstack_test_runtime";
const producerPassword = "proofstack_test_runtime";
const workerRole = "proofstack_test_outbox_worker";
const workerPassword = "proofstack_test_outbox_worker";
const adminPool = new Pool({ connectionString: databaseUrl, max: 4 });

function connectionStringFor(role: string, password: string): string {
  const result = new URL(databaseUrl as string);
  result.username = role;
  result.password = password;
  return result.toString();
}

const producerPool = new Pool({
  connectionString: connectionStringFor(producerRole, producerPassword),
  max: 4,
});
const workerPool = new Pool({
  connectionString: connectionStringFor(workerRole, workerPassword),
  max: 4,
});
const runKey = Date.now().toString();
const alphaTenant = `ten_outbox_alpha_${runKey}`;
const betaTenant = `ten_outbox_beta_${runKey}`;

function envelope(tenantId: string, eventId: string, spanId: string): EvidenceEnvelope {
  return {
    evidence: {
      attributes: {},
      contentReferences: [],
      eventId,
      extensions: {},
      kind: "agent.run",
      name: "outbox-delivery-contract",
      source: {
        sdkName: "@proofstack/testkit",
        sdkVersion: "0.0.0",
        serviceName: "outbox-delivery-contract",
      },
      spanId,
      startedAt: "2026-08-28T03:00:00.000Z",
      status: "ok",
      traceId: "8bf92f3577b34da6a3ce929d0e0e4736",
    },
    receivedAt: "2026-08-28T03:00:01.000Z",
    schemaVersion: "0.1",
    scope: {
      environmentId: "env_outbox",
      projectId: "prj_outbox",
      tenantId,
    },
  };
}

function tokens(...values: readonly string[]): () => string {
  const remaining = [...values];
  return () => {
    const value = remaining.shift();
    if (!value) throw new Error("The integration test exhausted its lease tokens");
    return value;
  };
}

beforeAll(async () => {
  await migrateDatabase(adminPool);
  await adminPool.query(`
    DO $$
    BEGIN
      CREATE ROLE ${producerRole} LOGIN PASSWORD '${producerPassword}';
    EXCEPTION
      WHEN duplicate_object THEN NULL;
    END
    $$
  `);
  await adminPool.query(`
    DO $$
    BEGIN
      CREATE ROLE ${workerRole} LOGIN PASSWORD '${workerPassword}';
    EXCEPTION
      WHEN duplicate_object THEN NULL;
    END
    $$
  `);
  await adminPool.query(`ALTER ROLE ${producerRole} LOGIN PASSWORD '${producerPassword}'`);
  await adminPool.query(`ALTER ROLE ${workerRole} LOGIN PASSWORD '${workerPassword}'`);
  await adminPool.query(`GRANT USAGE ON SCHEMA public TO ${producerRole}, ${workerRole}`);
  await adminPool.query(
    `GRANT SELECT, INSERT ON public.proofstack_evidence_events TO ${producerRole}`,
  );
  await adminPool.query(`GRANT INSERT ON public.proofstack_outbox TO ${producerRole}`);
  await adminPool.query(`GRANT SELECT, UPDATE ON public.proofstack_outbox TO ${workerRole}`);
});

afterAll(async () => {
  await Promise.all([producerPool.end(), workerPool.end(), adminPool.end()]);
});

describe("PostgresOutboxRepository delivery contract", () => {
  it("keeps producer and publisher database capabilities separate", async () => {
    await expect(
      producerPool.query("UPDATE public.proofstack_outbox SET last_error = NULL WHERE false"),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      workerPool.query(`
        INSERT INTO public.proofstack_outbox (
          tenant_id,
          event_type,
          aggregate_type,
          aggregate_id,
          schema_version,
          payload,
          created_at
        ) VALUES (
          'ten_forbidden',
          'evidence.appended',
          'evidence',
          'evt_forbidden',
          '0.1',
          '{}'::jsonb,
          clock_timestamp()
        )
      `),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("leases, acknowledges, retries, and recovers messages without crossing tenants", async () => {
    const alphaEventOne = `evt_alpha_${runKey}_001`;
    const alphaEventTwo = `evt_alpha_${runKey}_002`;
    const betaEvent = `evt_beta_${runKey}_001`;
    const producer = new PostgresEvidenceRepository(producerPool);
    await producer.append([
      envelope(alphaTenant, alphaEventOne, "10f067aa0ba902b7"),
      envelope(alphaTenant, alphaEventTwo, "20f067aa0ba902b7"),
    ]);
    await producer.append([envelope(betaTenant, betaEvent, "30f067aa0ba902b7")]);

    const firstToken = "10000000-0000-4000-8000-000000000001";
    const secondToken = "10000000-0000-4000-8000-000000000002";
    const firstWorker = new PostgresOutboxRepository(workerPool, tokens(firstToken));
    const secondWorker = new PostgresOutboxRepository(workerPool, tokens(secondToken));
    const claims = await Promise.all([
      firstWorker.claim(alphaTenant, {
        leaseDurationMs: 60_000,
        limit: 1,
        workerId: "wrk_alpha_one",
      }),
      secondWorker.claim(alphaTenant, {
        leaseDurationMs: 60_000,
        limit: 1,
        workerId: "wrk_alpha_two",
      }),
    ]);
    const claimed = claims.flat();
    expect(claimed).toHaveLength(2);
    expect(claimed.map(({ aggregateId }) => aggregateId).sort()).toEqual([
      alphaEventOne,
      alphaEventTwo,
    ]);
    expect(new Set(claimed.map(({ outboxId }) => outboxId)).size).toBe(2);
    expect(
      claimed.every(({ attemptCount, tenantId }) => attemptCount === 1 && tenantId === alphaTenant),
    ).toBe(true);

    const noDuplicateClaim = new PostgresOutboxRepository(
      workerPool,
      tokens("10000000-0000-4000-8000-000000000003"),
    );
    await expect(
      noDuplicateClaim.claim(alphaTenant, {
        leaseDurationMs: 60_000,
        limit: 10,
        workerId: "wrk_alpha_three",
      }),
    ).resolves.toEqual([]);

    const first = claimed[0];
    const second = claimed[1];
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (!first || !second) throw new Error("Expected two claimed outbox records");

    await expect(
      firstWorker.acknowledge(betaTenant, {
        leaseToken: first.lease.token,
        outboxId: first.outboxId,
      }),
    ).resolves.toBe(false);
    await expect(
      firstWorker.acknowledge(alphaTenant, {
        leaseToken: "10000000-0000-4000-8000-000000000099",
        outboxId: first.outboxId,
      }),
    ).resolves.toBe(false);
    await expect(
      firstWorker.acknowledge(alphaTenant, {
        leaseToken: first.lease.token,
        outboxId: first.outboxId,
      }),
    ).resolves.toBe(true);
    await expect(
      firstWorker.acknowledge(alphaTenant, {
        leaseToken: first.lease.token,
        outboxId: first.outboxId,
      }),
    ).resolves.toBe(false);

    await expect(
      secondWorker.retry(alphaTenant, {
        error: "simulated publisher failure",
        leaseToken: second.lease.token,
        outboxId: second.outboxId,
        retryDelayMs: 0,
      }),
    ).resolves.toBe(true);
    await expect(
      secondWorker.retry(alphaTenant, {
        error: "stale retry",
        leaseToken: second.lease.token,
        outboxId: second.outboxId,
        retryDelayMs: 0,
      }),
    ).resolves.toBe(false);

    const retryToken = "10000000-0000-4000-8000-000000000004";
    const retryWorker = new PostgresOutboxRepository(workerPool, tokens(retryToken));
    const retried = await retryWorker.claim(alphaTenant, {
      leaseDurationMs: 60_000,
      limit: 10,
      workerId: "wrk_alpha_retry",
    });
    expect(retried).toHaveLength(1);
    expect(retried[0]).toMatchObject({
      aggregateId: second.aggregateId,
      attemptCount: 2,
      lease: { token: retryToken },
      outboxId: second.outboxId,
    });
    await expect(
      retryWorker.acknowledge(alphaTenant, {
        leaseToken: retryToken,
        outboxId: second.outboxId,
      }),
    ).resolves.toBe(true);

    const betaToken = "10000000-0000-4000-8000-000000000005";
    const betaWorker = new PostgresOutboxRepository(workerPool, tokens(betaToken));
    const betaClaim = await betaWorker.claim(betaTenant, {
      leaseDurationMs: 60_000,
      limit: 10,
      workerId: "wrk_beta_one",
    });
    expect(betaClaim).toHaveLength(1);
    expect(betaClaim[0]).toMatchObject({ aggregateId: betaEvent, attemptCount: 1 });
    const betaMessage = betaClaim[0];
    if (!betaMessage) throw new Error("Expected the beta tenant outbox record");

    await adminPool.query(
      `
        UPDATE public.proofstack_outbox
        SET lease_expires_at = clock_timestamp() - interval '1 second'
        WHERE tenant_id = $1 AND outbox_id = $2::bigint
      `,
      [betaTenant, betaMessage.outboxId],
    );
    await expect(
      betaWorker.acknowledge(betaTenant, {
        leaseToken: betaToken,
        outboxId: betaMessage.outboxId,
      }),
    ).resolves.toBe(false);

    const recoveredToken = "10000000-0000-4000-8000-000000000006";
    const recoveryWorker = new PostgresOutboxRepository(workerPool, tokens(recoveredToken));
    const recovered = await recoveryWorker.claim(betaTenant, {
      leaseDurationMs: 60_000,
      limit: 10,
      workerId: "wrk_beta_recovery",
    });
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({
      aggregateId: betaEvent,
      attemptCount: 2,
      lease: { token: recoveredToken },
    });
    await expect(
      recoveryWorker.acknowledge(betaTenant, {
        leaseToken: recoveredToken,
        outboxId: betaMessage.outboxId,
      }),
    ).resolves.toBe(true);

    const finalWorker = new PostgresOutboxRepository(
      workerPool,
      tokens("10000000-0000-4000-8000-000000000007", "10000000-0000-4000-8000-000000000008"),
    );
    await expect(
      finalWorker.claim(alphaTenant, {
        leaseDurationMs: 60_000,
        limit: 10,
        workerId: "wrk_alpha_final",
      }),
    ).resolves.toEqual([]);
    await expect(
      finalWorker.claim(betaTenant, {
        leaseDurationMs: 60_000,
        limit: 10,
        workerId: "wrk_beta_final",
      }),
    ).resolves.toEqual([]);

    const finalState = await adminPool.query<{
      readonly attempt_count: number;
      readonly last_error: string | null;
      readonly published: boolean;
      readonly tenant_id: string;
    }>(
      `
        SELECT
          tenant_id,
          attempt_count,
          last_error,
          published_at IS NOT NULL AS published
        FROM public.proofstack_outbox
        WHERE tenant_id = ANY($1::varchar[])
        ORDER BY tenant_id, outbox_id
      `,
      [[alphaTenant, betaTenant]],
    );
    expect(finalState.rows).toHaveLength(3);
    expect(finalState.rows.every(({ published }) => published)).toBe(true);
    expect(finalState.rows.map(({ attempt_count }) => attempt_count).sort()).toEqual([1, 2, 2]);
    expect(finalState.rows.every(({ last_error }) => last_error === null)).toBe(true);
  });
});
