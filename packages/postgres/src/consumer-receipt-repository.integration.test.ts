import { ConsumerReceiptConflictError, processConsumerMessage } from "@proofstack/core";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateDatabase } from "./migration-runner.js";
import { PostgresConsumerReceiptRepository } from "./postgres-consumer-receipt-repository.js";

const { PROOFSTACK_TEST_DATABASE_URL: databaseUrl } = process.env;
if (!databaseUrl) {
  throw new Error("PROOFSTACK_TEST_DATABASE_URL is required for PostgreSQL integration tests");
}

const consumerRole = "proofstack_test_consumer_worker";
const consumerPassword = "proofstack_test_consumer_worker";
const adminPool = new Pool({ connectionString: databaseUrl, max: 4 });
const consumerDatabaseUrl = new URL(databaseUrl);
consumerDatabaseUrl.username = consumerRole;
consumerDatabaseUrl.password = consumerPassword;
const consumerPool = new Pool({ connectionString: consumerDatabaseUrl.toString(), max: 4 });
const runKey = Date.now().toString();
const tenantId = `ten_receipt_${runKey}`;
const otherTenantId = `ten_receipt_other_${runKey}`;
const payloadSha256 = "c".repeat(64);

function token(value: string): () => string {
  return () => value;
}

beforeAll(async () => {
  await migrateDatabase(adminPool);
  await adminPool.query(`
    DO $$
    BEGIN
      CREATE ROLE ${consumerRole} LOGIN PASSWORD '${consumerPassword}';
    EXCEPTION
      WHEN duplicate_object THEN NULL;
    END
    $$
  `);
  await adminPool.query(`ALTER ROLE ${consumerRole} LOGIN PASSWORD '${consumerPassword}'`);
  await adminPool.query(`GRANT USAGE ON SCHEMA public TO ${consumerRole}`);
  await adminPool.query(
    `GRANT SELECT, INSERT, UPDATE ON public.proofstack_consumer_receipts TO ${consumerRole}`,
  );
});

afterAll(async () => {
  await Promise.all([consumerPool.end(), adminPool.end()]);
});

describe("PostgresConsumerReceiptRepository contract", () => {
  it("suppresses concurrent handling and preserves terminal completion", async () => {
    const key = {
      consumerName: "trace.projector",
      messageId: `message-main-${runKey}`,
    };
    const firstToken = "30000000-0000-4000-8000-000000000001";
    const secondToken = "30000000-0000-4000-8000-000000000002";
    const first = new PostgresConsumerReceiptRepository(consumerPool, token(firstToken));
    const second = new PostgresConsumerReceiptRepository(consumerPool, token(secondToken));
    const options = {
      ...key,
      leaseDurationMs: 60_000,
      payloadSha256,
      workerId: "wrk_receipt_primary",
    };

    const claims = await Promise.all([
      first.claim(tenantId, options),
      second.claim(tenantId, { ...options, workerId: "wrk_receipt_secondary" }),
    ]);
    expect(claims.map(({ status }) => status).sort()).toEqual(["acquired", "busy"]);
    const acquired = claims.find(({ status }) => status === "acquired");
    const busy = claims.find(({ status }) => status === "busy");
    expect(acquired).toBeDefined();
    expect(busy).toBeDefined();
    if (!acquired || !busy) throw new Error("Expected one acquired and one busy receipt claim");
    expect(busy.receipt.lease?.token).toBe(acquired.receipt.lease?.token);

    const activeToken = acquired.receipt.lease?.token;
    if (!activeToken) throw new Error("Expected an active consumer receipt lease");
    await expect(first.complete(otherTenantId, { ...key, leaseToken: activeToken })).resolves.toBe(
      false,
    );
    await expect(
      first.complete(tenantId, {
        ...key,
        leaseToken: "30000000-0000-4000-8000-000000000099",
      }),
    ).resolves.toBe(false);
    await expect(
      first.release(tenantId, {
        ...key,
        error: "simulated handler failure",
        leaseToken: activeToken,
        retryDelayMs: 0,
      }),
    ).resolves.toBe(true);
    await expect(first.get(tenantId, key)).resolves.toMatchObject({
      attemptCount: 1,
      lastError: "simulated handler failure",
      lease: null,
      state: "available",
    });

    const retryToken = "30000000-0000-4000-8000-000000000003";
    const retry = new PostgresConsumerReceiptRepository(consumerPool, token(retryToken));
    const retried = await retry.claim(tenantId, {
      ...options,
      workerId: "wrk_receipt_retry",
    });
    expect(retried).toMatchObject({
      receipt: {
        attemptCount: 2,
        lastError: "simulated handler failure",
        lease: { token: retryToken },
        state: "processing",
      },
      status: "acquired",
    });
    await expect(retry.complete(tenantId, { ...key, leaseToken: retryToken })).resolves.toBe(true);
    await expect(retry.complete(tenantId, { ...key, leaseToken: retryToken })).resolves.toBe(false);

    const completedReader = new PostgresConsumerReceiptRepository(
      consumerPool,
      token("30000000-0000-4000-8000-000000000004"),
    );
    await expect(completedReader.claim(tenantId, options)).resolves.toMatchObject({
      receipt: { attemptCount: 2, lastError: null, lease: null, state: "completed" },
      status: "completed",
    });
    await expect(completedReader.get(otherTenantId, key)).resolves.toBeNull();
    await expect(
      completedReader.claim(tenantId, {
        ...options,
        payloadSha256: "d".repeat(64),
      }),
    ).rejects.toBeInstanceOf(ConsumerReceiptConflictError);
  });

  it("recovers an expired processing lease", async () => {
    const key = {
      consumerName: "evaluation.projector",
      messageId: `message-expired-${runKey}`,
    };
    const abandoned = new PostgresConsumerReceiptRepository(
      consumerPool,
      token("30000000-0000-4000-8000-000000000005"),
    );
    await expect(
      abandoned.claim(tenantId, {
        ...key,
        leaseDurationMs: 1,
        payloadSha256,
        workerId: "wrk_receipt_abandoned",
      }),
    ).resolves.toMatchObject({ status: "acquired" });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const recoveredToken = "30000000-0000-4000-8000-000000000006";
    const recovered = new PostgresConsumerReceiptRepository(consumerPool, token(recoveredToken));
    await expect(
      recovered.claim(tenantId, {
        ...key,
        leaseDurationMs: 60_000,
        payloadSha256,
        workerId: "wrk_receipt_recovery",
      }),
    ).resolves.toMatchObject({
      receipt: { attemptCount: 2, lease: { token: recoveredToken } },
      status: "acquired",
    });
    await expect(
      recovered.complete(tenantId, { ...key, leaseToken: recoveredToken }),
    ).resolves.toBe(true);
  });

  it("distinguishes retry backoff from active contention", async () => {
    const key = {
      consumerName: "policy.projector",
      messageId: `message-deferred-${runKey}`,
    };
    const activeToken = "30000000-0000-4000-8000-000000000007";
    const active = new PostgresConsumerReceiptRepository(consumerPool, token(activeToken));
    const options = {
      ...key,
      leaseDurationMs: 60_000,
      payloadSha256,
      workerId: "wrk_receipt_backoff",
    };
    await active.claim(tenantId, options);
    await active.release(tenantId, {
      ...key,
      error: "retry later",
      leaseToken: activeToken,
      retryDelayMs: 60_000,
    });

    const deferred = new PostgresConsumerReceiptRepository(
      consumerPool,
      token("30000000-0000-4000-8000-000000000008"),
    );
    await expect(deferred.claim(tenantId, options)).resolves.toMatchObject({
      receipt: { lastError: "retry later", state: "available" },
      status: "deferred",
    });
  });

  it("lets the shared harness invoke only one concurrent handler", async () => {
    const key = {
      consumerName: "export.projector",
      messageId: `message-harness-${runKey}`,
    };
    const firstRepository = new PostgresConsumerReceiptRepository(
      consumerPool,
      token("30000000-0000-4000-8000-000000000009"),
    );
    const secondRepository = new PostgresConsumerReceiptRepository(
      consumerPool,
      token("30000000-0000-4000-8000-000000000010"),
    );
    let releaseHandler: (() => void) | undefined;
    let reportStarted: (() => void) | undefined;
    const handlerGate = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    const handlerStarted = new Promise<void>((resolve) => {
      reportStarted = resolve;
    });
    let handlerCalls = 0;
    const common = {
      consumerName: key.consumerName,
      leaseDurationMs: 60_000,
      message: { eventId: "evt_harness_001" },
      messageId: key.messageId,
      payloadSha256,
      retryDelayMs: 0,
      tenantId,
    };
    const firstProcessing = processConsumerMessage({
      ...common,
      handler: async () => {
        handlerCalls += 1;
        reportStarted?.();
        await handlerGate;
        return "projected";
      },
      repository: firstRepository,
      workerId: "wrk_harness_primary",
    });
    await handlerStarted;

    await expect(
      processConsumerMessage({
        ...common,
        handler: async () => {
          handlerCalls += 1;
          return "duplicate";
        },
        repository: secondRepository,
        workerId: "wrk_harness_secondary",
      }),
    ).resolves.toMatchObject({ status: "busy" });
    releaseHandler?.();
    await expect(firstProcessing).resolves.toEqual({ status: "processed", value: "projected" });
    expect(handlerCalls).toBe(1);

    await expect(
      processConsumerMessage({
        ...common,
        handler: async () => {
          handlerCalls += 1;
          return "duplicate";
        },
        repository: secondRepository,
        workerId: "wrk_harness_secondary",
      }),
    ).resolves.toMatchObject({ status: "completed" });
    expect(handlerCalls).toBe(1);
  });

  it("does not grant the consumer access to authoritative evidence", async () => {
    await expect(
      consumerPool.query("SELECT count(*) FROM public.proofstack_evidence_events"),
    ).rejects.toMatchObject({ code: "42501" });
  });
});
