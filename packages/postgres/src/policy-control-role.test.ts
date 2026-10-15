import { describe, expect, it, vi } from "vitest";
import type { createPolicyPostgresPool } from "./database.js";
import { assertPostgresPolicyControlRole as assertPolicyControlDatabaseRole } from "./policy-control-role.js";
import { withBoundedPolicyTransaction } from "./bounded-policy-transaction.js";

vi.mock("./bounded-policy-transaction.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./bounded-policy-transaction.js")>()),
  withBoundedPolicyTransaction: vi.fn(async (pool, work) => work(pool)),
}));

const url = "postgresql://policy%5Fcontrol@127.0.0.1:5432/proofstack_test";
const control = {
  identity: "policy_control",
  restricted: true,
  enqueue: true,
  cancel: true,
  read: true,
  publish: false,
};
function pool(rows: unknown[]) {
  const query = vi.fn(async () => ({ rows }));
  return { query, value: { query } as unknown as ReturnType<typeof createPolicyPostgresPool> };
}
describe("actual policy control database role admission", () => {
  it("admits only the exact decoded role with restricted control grants", async () => {
    const p = pool([control]);
    await expect(assertPolicyControlDatabaseRole(p.value, url)).resolves.toBeUndefined();
    expect(p.query).toHaveBeenCalledOnce();
    expect(p.query.mock.calls[0]).toEqual([expect.any(String)]);
    expect(withBoundedPolicyTransaction).toHaveBeenCalledWith(p.value, expect.any(Function), {
      requireWire: true,
    });
  });
  it.each(
    [
      [],
      [control, control],
      [{ ...control, identity: "other" }],
      ...["restricted", "enqueue", "cancel", "read"].flatMap((key) => [
        [{ ...control, [key]: false }],
        [{ ...control, [key]: "true" }],
        [{ ...control, [key]: null }],
      ]),
      [{ ...control, publish: true }],
      [{ ...control, publish: "false" }],
      [{ ...control, publish: null }],
    ].map((rows, index) => ({ rows, index })),
  )("rejects missing, excessive or malformed effective authority $index", async ({ rows }) => {
    await expect(assertPolicyControlDatabaseRole(pool(rows).value, url)).rejects.toThrow(
      "dedicated restricted control role",
    );
  });
  it("preserves the original catalog-query failure", async () => {
    const p = pool([]),
      failure = new Error("test catalog unavailable");
    p.query.mockRejectedValue(failure);
    await expect(assertPolicyControlDatabaseRole(p.value, url)).rejects.toBe(failure);
  });
});
