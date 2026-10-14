import { afterEach, describe, expect, it, vi } from "vitest";
import { createPolicyPostgresPool, createPostgresPool } from "./database.js";

const pools: Array<ReturnType<typeof createPostgresPool>> = [];

afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.end()));
});

describe("createPostgresPool", () => {
  it("creates a dedicated policy driver without mutating general options or defaults", () => {
    const options = {
      connectionString: "postgresql://runtime@127.0.0.1:5432/proofstack",
      onIdleError: vi.fn(),
      maxConnections: 1,
    };
    const pool = createPolicyPostgresPool(options);
    pools.push(pool);
    expect(pool.options.connectionTimeoutMillis).toBe(500);
    expect(pool.options.Client?.name).toBe("PolicyWireClient");
    expect(options).not.toHaveProperty("connectionTimeoutMilliseconds");
  });
  it.each([501, 5001, 0, -1, 1.5])("rejects invalid policy checkout %s", (timeout) => {
    expect(() =>
      createPolicyPostgresPool({
        connectionString: "postgresql://runtime@127.0.0.1:5432/proofstack",
        onIdleError: vi.fn(),
        connectionTimeoutMilliseconds: timeout,
      }),
    ).toThrow(RangeError);
  });
  it.each([0, -1, 1.5, 17])("rejects invalid policy pool size %s", (maximum) => {
    expect(() =>
      createPolicyPostgresPool({
        connectionString: "postgresql://runtime@127.0.0.1:5432/proofstack",
        onIdleError: vi.fn(),
        maxConnections: maximum,
      }),
    ).toThrow(RangeError);
  });
  it("creates a bounded named pool with an idle error observer", () => {
    const onIdleError = vi.fn();
    const pool = createPostgresPool({
      applicationName: "proofstack-test",
      connectionString: "postgresql://runtime@127.0.0.1:5432/proofstack",
      maxConnections: 3,
      onIdleError,
    });
    pools.push(pool);

    expect(pool.options).toMatchObject({
      application_name: "proofstack-test",
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
      max: 3,
    });
    expect(pool.listenerCount("error")).toBe(1);
  });

  it("uses conservative defaults", () => {
    const pool = createPostgresPool({
      connectionString: "postgresql://runtime@127.0.0.1:5432/proofstack",
      onIdleError: vi.fn(),
    });
    pools.push(pool);

    expect(pool.options.application_name).toBe("proofstack");
    expect(pool.options.max).toBe(10);
  });
  it("supports an explicit finite policy checkout without changing the default", () => {
    const pool = createPostgresPool({
      connectionString: "postgresql://runtime@127.0.0.1:5432/proofstack",
      onIdleError: vi.fn(),
      connectionTimeoutMilliseconds: 500,
    });
    pools.push(pool);
    expect(pool.options.connectionTimeoutMillis).toBe(500);
  });
  it.each([0, -1, 1.5, 5001])(
    "rejects invalid explicit connection timeout %s before creating a pool",
    (value) => {
      expect(() =>
        createPostgresPool({
          connectionString: "postgresql://runtime@127.0.0.1:5432/proofstack",
          onIdleError: vi.fn(),
          connectionTimeoutMilliseconds: value,
        }),
      ).toThrow(RangeError);
    },
  );
});
