import { createHash } from "node:crypto";
import { ReleaseDecisionVerificationBudget } from "@proofstack/core";
import type { PoolClient } from "pg";
import { describe, expect, it } from "vitest";
import { readInstallerRowsOnClient, type InstallerProjection } from "./release-installer-read.js";

const scope = {
  tenantId: "tenant_installer",
  projectId: "project_installer",
  environmentId: "env_installer",
};
const meter = (records = 1000, bytes = 4 * 1024 * 1024) =>
  new ReleaseDecisionVerificationBudget({
    maxAcquisitionRecords: records,
    maxAcquisitionRecordBytes: bytes,
    maxApprovalRecords: 0,
  });
function frames(value: unknown, records = 1) {
  const bytes = Buffer.from(JSON.stringify(value)),
    sha256 = createHash("sha256").update(bytes).digest("hex");
  const result: { value: Record<string, unknown> }[] = [];
  for (let offset = 0; offset < bytes.length; offset += 65536)
    result.push({
      value: {
        scope,
        projection: "selection_view",
        offset,
        totalBytes: bytes.length,
        sha256,
        records: offset === 0 ? records : 0,
        chunkBase64: bytes.subarray(offset, offset + 65536).toString("base64"),
      },
    });
  return result;
}
function client(rows: unknown[]) {
  const queries: { sql: string; values: unknown }[] = [];
  return {
    queries,
    port: {
      query: async (sql: string, values: unknown) => {
        queries.push({ sql, values });
        return { rows };
      },
    } as unknown as Pick<PoolClient, "query">,
  };
}
describe("fixed bounded installer projection transport", () => {
  it("reassembles a Unicode record across byte boundaries without exposing an arbitrary SQL port", async () => {
    const record = { label: "검증😀".repeat(20000) },
      c = client(frames([record], 7)),
      budget = meter();
    expect(
      await readInstallerRowsOnClient(
        c.port,
        { scope, budget },
        "selection_view",
        "version_installer",
      ),
    ).toEqual([record]);
    expect(c.queries).toHaveLength(1);
    expect(c.queries[0]?.sql).toBe(
      "SELECT public.proofstack_read_installer_projection($1::jsonb,$2,$3) AS value",
    );
    const parameters = c.queries[0]?.values as unknown[];
    expect(JSON.parse(String(parameters[0]))).toEqual(scope);
    expect(parameters.slice(1)).toEqual(["selection_view", "version_installer"]);
    expect(budget.snapshot().records).toBe(7 + frames([record]).length - 1);
  });
  it("counts a guarded absence and retains the original exact byte/record admission", async () => {
    const rows = frames([], 2),
      initial = meter(),
      c = client(rows);
    expect(
      await readInstallerRowsOnClient(
        c.port,
        { scope, budget: initial },
        "selection_view",
        "version_installer",
      ),
    ).toEqual([]);
    const usage = initial.snapshot(),
      exact = meter(usage.records, usage.recordBytes);
    await expect(
      readInstallerRowsOnClient(
        c.port,
        { scope, budget: exact },
        "selection_view",
        "version_installer",
      ),
    ).resolves.toEqual([]);
    const short = meter(usage.records, usage.recordBytes - 1);
    await expect(
      readInstallerRowsOnClient(
        c.port,
        { scope, budget: short },
        "selection_view",
        "version_installer",
      ),
    ).rejects.toBeDefined();
    expect(() => short.snapshot()).toThrow();
  });
  it.each([
    "scope",
    "projection",
    "offset",
    "total",
    "hash",
    "base64",
    "records",
    "shape",
    "truncated",
    "duplicate",
    "json",
    "array",
  ])("taints the same original meter after %s damage", async (damage) => {
    const rows = frames([{ label: "original" }]),
      first = rows[0];
    if (!first) throw new Error("Fixture frame missing");
    if (damage === "scope") first.value["scope"] = { ...scope, tenantId: "tenant_foreign" };
    if (damage === "projection") first.value["projection"] = "policy_record";
    if (damage === "offset") first.value["offset"] = 1;
    if (damage === "total") first.value["totalBytes"] = 16 * 1024 * 1024 + 1;
    if (damage === "hash") first.value["sha256"] = "0".repeat(64);
    if (damage === "base64") first.value["chunkBase64"] += "\n";
    if (damage === "records") first.value["records"] = 0;
    if (damage === "shape") first.value["extra"] = true;
    if (damage === "truncated") first.value["totalBytes"] = 65537;
    if (damage === "duplicate") rows.push(structuredClone(first));
    if (damage === "json") {
      const bytes = Buffer.from("[invalid]");
      first.value["chunkBase64"] = bytes.toString("base64");
      first.value["totalBytes"] = bytes.length;
      first.value["sha256"] = createHash("sha256").update(bytes).digest("hex");
    }
    if (damage === "array") rows.splice(0, rows.length, ...frames([{}, {}]));
    const budget = meter(),
      c = client(rows);
    await expect(
      readInstallerRowsOnClient(c.port, { scope, budget }, "selection_view", "version_installer"),
    ).rejects.toBeDefined();
    expect(() => budget.snapshot()).toThrow();
    await expect(
      readInstallerRowsOnClient(c.port, { scope, budget }, "selection_view", "version_installer"),
    ).rejects.toBeDefined();
    expect(c.queries).toHaveLength(1);
  });
  it.each(["kind", "id", "scope"])("rejects invalid %s before database I/O", async (invalid) => {
    const c = client(frames([])),
      budget = meter();
    await expect(
      readInstallerRowsOnClient(
        c.port,
        { scope: invalid === "scope" ? { ...scope, tenantId: "" } : scope, budget },
        invalid === "kind" ? ("untrusted" as InstallerProjection) : "selection_view",
        invalid === "id" ? "invalid;sql" : "version_installer",
      ),
    ).rejects.toBeDefined();
    expect(c.queries).toHaveLength(0);
    expect(() => budget.snapshot()).toThrow();
  });
});
