import { afterEach, describe, expect, it, vi } from "vitest";
import { createPostgresPool } from "./database.js";

const pools: Array<ReturnType<typeof createPostgresPool>> = [];

afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.end()));
});

describe("createPostgresPool", () => {
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
});
