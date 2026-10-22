import { createHash } from "node:crypto";
import { ReleaseDecisionVerificationBudget } from "@proofstack/core";
import type { PoolClient } from "pg";
import { describe, expect, it } from "vitest";
import {
  readReviewerAdministratorRowsOnClient,
  type ReviewerAdministratorProjection,
} from "./reviewer-administrator-read.js";

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
        projection: "authority_view",
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
  it.each(["authority_versions", "authority_events"] as const)(
    "accepts exactly one bounded %s page and rejects a seventeenth row",
    async (projection) => {
      for (const count of [0, 16, 17]) {
        const rows = frames(
          Array.from({ length: count }, (_, index) => ({ id: `id_${index}` })),
          Math.max(1, count),
        );
        for (const row of rows) row.value["projection"] = projection;
        const c = client(rows),
          budget = meter();
        const result = readReviewerAdministratorRowsOnClient(
          c.port,
          { scope, budget },
          projection,
          "authority_page",
          "version_after",
        );
        if (count === 17) {
          await expect(result).rejects.toBeDefined();
          expect(() => budget.snapshot()).toThrow();
        } else expect(await result).toHaveLength(count);
      }
    },
  );
  it("binds all three target identifiers without accepting a source-read selector", async () => {
    const rows = frames([{ value: { root: null, orphan: false } }]);
    for (const row of rows) row.value["projection"] = "authority_root";
    const c = client(rows);
    expect(
      await readReviewerAdministratorRowsOnClient(
        c.port,
        { scope, budget: meter() },
        "authority_root",
        "installation_test",
        "gate_test",
        "reviewer_test",
      ),
    ).toEqual([{ value: { root: null, orphan: false } }]);
    const parameters = c.queries[0]?.values;
    if (!Array.isArray(parameters)) throw new Error("Missing target parameters");
    expect(parameters.slice(1)).toEqual([
      "authority_root",
      "installation_test",
      "gate_test",
      "reviewer_test",
    ]);
  });
  it.each([
    { kind: "authority_root", second: "", third: "reviewer_test" },
    { kind: "authority_root", second: "gate_test", third: "" },
    { kind: "authority_versions", second: "cursor;sql", third: "" },
    { kind: "authority_events", second: "", third: "reviewer_test" },
    { kind: "authority_view", second: "gate_test", third: "" },
    { kind: "authority_event_view", second: "", third: "reviewer_test" },
  ])("rejects mixed $kind selector parts before a native read", async ({ kind, second, third }) => {
    const c = client(frames([])),
      budget = meter();
    await expect(
      readReviewerAdministratorRowsOnClient(
        c.port,
        { scope, budget },
        kind as ReviewerAdministratorProjection,
        "authority_test",
        second,
        third,
      ),
    ).rejects.toBeDefined();
    expect(c.queries).toHaveLength(0);
    expect(() => budget.snapshot()).toThrow();
  });
  it("reassembles a Unicode record across byte boundaries without exposing an arbitrary SQL port", async () => {
    const record = { label: "검증😀".repeat(20000) },
      c = client(frames([record], 7)),
      budget = meter();
    expect(
      await readReviewerAdministratorRowsOnClient(
        c.port,
        { scope, budget },
        "authority_view",
        "version_installer",
      ),
    ).toEqual([record]);
    expect(c.queries).toHaveLength(1);
    expect(c.queries[0]?.sql).toBe(
      "SELECT public.proofstack_read_reviewer_administrator_projection($1::jsonb,$2,$3,$4,$5) AS value",
    );
    const parameters = c.queries[0]?.values as unknown[];
    expect(JSON.parse(String(parameters[0]))).toEqual(scope);
    expect(parameters.slice(1)).toEqual(["authority_view", "version_installer", "", ""]);
    expect(budget.snapshot().records).toBe(7 + frames([record]).length - 1);
  });
  it("counts a guarded absence and retains the original exact byte/record admission", async () => {
    const rows = frames([], 2),
      initial = meter(),
      c = client(rows);
    expect(
      await readReviewerAdministratorRowsOnClient(
        c.port,
        { scope, budget: initial },
        "authority_view",
        "version_installer",
      ),
    ).toEqual([]);
    const usage = initial.snapshot(),
      exact = meter(usage.records, usage.recordBytes);
    await expect(
      readReviewerAdministratorRowsOnClient(
        c.port,
        { scope, budget: exact },
        "authority_view",
        "version_installer",
      ),
    ).resolves.toEqual([]);
    const short = meter(usage.records, usage.recordBytes - 1);
    await expect(
      readReviewerAdministratorRowsOnClient(
        c.port,
        { scope, budget: short },
        "authority_view",
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
      readReviewerAdministratorRowsOnClient(
        c.port,
        { scope, budget },
        "authority_view",
        "version_installer",
      ),
    ).rejects.toBeDefined();
    expect(() => budget.snapshot()).toThrow();
    await expect(
      readReviewerAdministratorRowsOnClient(
        c.port,
        { scope, budget },
        "authority_view",
        "version_installer",
      ),
    ).rejects.toBeDefined();
    expect(c.queries).toHaveLength(1);
  });
  it.each(["kind", "id", "scope"])("rejects invalid %s before database I/O", async (invalid) => {
    const c = client(frames([])),
      budget = meter();
    await expect(
      readReviewerAdministratorRowsOnClient(
        c.port,
        { scope: invalid === "scope" ? { ...scope, tenantId: "" } : scope, budget },
        invalid === "kind" ? ("untrusted" as ReviewerAdministratorProjection) : "authority_view",
        invalid === "id" ? "invalid;sql" : "version_installer",
      ),
    ).rejects.toBeDefined();
    expect(c.queries).toHaveLength(0);
    expect(() => budget.snapshot()).toThrow();
  });
});
