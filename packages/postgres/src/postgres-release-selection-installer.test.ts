import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import {
  serializeEvaluationCanonicalJson,
  type EvidenceScope,
  type ReleaseApprovalReviewerReceipt,
} from "@proofstack/contracts";
import {
  generateBrowserSessionCredentials,
  OidcSessionAuthenticator,
  ReleaseMutationAuthenticator,
} from "@proofstack/identity";
import type { PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import type { PolicyTransactionPool } from "./bounded-policy-transaction.js";
import { loadBundledMigrations } from "./migrations.js";
import { prepareReleaseInstallerSchema } from "./release-installer-schema.js";
import {
  PostgresReleaseSelectionInstaller,
  type PostgresReleaseSelectionInstallerResult,
} from "./postgres-release-selection-installer.js";

const transaction = vi.hoisted(() => ({ client: undefined as unknown, calls: [] as unknown[] }));
// Only the transaction harness is simulated here. Actual PostgreSQL tests independently cover
// wire admission, roles, mandatory guards, deferred rollback and source/profile/intent atomicity.
vi.mock("./bounded-policy-transaction.js", () => ({
  withBoundedPolicyTransaction: async (
    _pool: unknown,
    work: (client: unknown) => Promise<unknown>,
    options: unknown,
  ) => {
    transaction.calls.push(options);
    return work(transaction.client);
  },
}));
interface Observation {
  sql: string;
  values?: unknown[];
  rows: Record<string, unknown>[];
}
interface Case {
  name: string;
  operation: "selection" | "lifecycle";
  scope: EvidenceScope;
  requestId: string;
  intent: unknown;
  queries: number[];
  result: PostgresReleaseSelectionInstallerResult;
}
const wire = JSON.parse(
  readFileSync(
    new URL("./fixtures/selection-installer-native-wire-v1.json", import.meta.url),
    "utf8",
  ),
) as {
  format: string;
  serverVersion: string;
  actor: ReleaseApprovalReviewerReceipt;
  cases: Case[];
  observations: Observation[];
};
if (
  wire.format !== "proofstack.release-selection-installer-native-wire.v1" ||
  wire.serverVersion !== "16.15"
)
  throw new Error("Invalid actual native fixture");
// Original immutable source/authentication observations remain byte-identical. Only the
// independently recorded current readiness query is overlaid; native integration tests cover
// the complete current transaction. This unit composition is not a live authority transcript.
const currentReadiness = JSON.parse(
  readFileSync(
    new URL("./fixtures/installer-role-readiness-native-v1.json", import.meta.url),
    "utf8",
  ),
) as { format: string; serverVersion: string; observation: Observation };
if (
  currentReadiness.format !== "proofstack.release-installer-role-readiness-native.v1" ||
  currentReadiness.serverVersion !== "16.15" ||
  currentReadiness.observation.rows.length !== 0
)
  throw new Error("Invalid native readiness fixture");
const currentSchema = JSON.parse(
  readFileSync(
    new URL("./fixtures/installer-schema-readiness-native-v1.json", import.meta.url),
    "utf8",
  ),
) as {
  format: string;
  serverVersion: string;
  migrations: Record<string, unknown>[];
  observations: Observation[];
};
if (
  currentSchema.format !== "proofstack.release-installer-current-schema-native.v1" ||
  currentSchema.serverVersion !== "16.15" ||
  currentSchema.observations.length !== 3
)
  throw new Error("Invalid current native schema fixture");
function fixture(name = "selection_new") {
  const captured = wire.cases.find((value) => value.name === name);
  if (!captured) throw new Error("Missing native case");
  const example = structuredClone(captured),
    observations = example.queries.map((index) => {
      const observation = wire.observations[index];
      if (!observation) throw new Error("Missing native observation index");
      if (observation.sql.startsWith("SELECT 'table' AS kind"))
        return structuredClone(currentReadiness.observation);
      if (
        observation.sql ===
        "SELECT id, checksum FROM public.proofstack_schema_migrations ORDER BY id"
      )
        return { ...structuredClone(observation), rows: structuredClone(currentSchema.migrations) };
      const current = currentSchema.observations.find(
        (item) =>
          item.sql.slice(0, item.sql.indexOf("FROM")) ===
          observation.sql.slice(0, observation.sql.indexOf("FROM")),
      );
      if (current) return structuredClone(current);
      return structuredClone(observation);
    });
  // Only current catalog bodies change this composed unit transcript's byte admission.
  // Keep original immutable result receipts and the independently captured transcript intact.
  const originalRoutine = wire.observations.find((item) => item.sql.includes("FROM pg_proc p"));
  const currentRoutine = currentSchema.observations.find((item) =>
    item.sql.includes("FROM pg_catalog.pg_proc p"),
  );
  if (!originalRoutine || !currentRoutine) throw new Error("Missing actual catalog observations");
  const bytes = (rows: Record<string, unknown>[]) =>
    rows.reduce((sum, row) => sum + Buffer.byteLength(serializeEvaluationCanonicalJson(row)), 0);
  const expectedResult = {
    ...example.result,
    usage: {
      ...example.result.usage,
      recordBytes:
        example.result.usage.recordBytes + bytes(currentRoutine.rows) - bytes(originalRoutine.rows),
    },
  };
  const secret = generateBrowserSessionCredentials(),
    actor = wire.actor;
  const lookup = {
    active: true,
    calls: 0,
    async findAndTouchActive(digest: string) {
      this.calls++;
      if (!this.active || digest !== secret.sessionDigest) return null;
      return {
        csrfDigest: secret.csrfDigest,
        sessionDigest: secret.sessionDigest,
        capabilities: ["release:selection:manage" as const],
        createdAt: actor.authenticatedAt,
        principalId: actor.principalId,
        resourceScope: { mode: "tenant" as const },
        roles: ["member" as const],
        sessionId: actor.credentialId,
        tenantId: example.scope.tenantId,
      };
    },
  };
  const auth = new ReleaseMutationAuthenticator(new OidcSessionAuthenticator(lookup));
  const credentials = {
    scope: example.scope,
    requestId: example.requestId,
    sessionToken: secret.sessionToken,
    csrfToken: secret.csrfToken,
  };
  const calls: Observation[] = [];
  let position = 0;
  const client = {
    async query(sql: string, values?: unknown[]) {
      const next = observations[position++];
      calls.push({ sql, ...(values === undefined ? {} : { values }), rows: [] });
      if (!next || sql !== next.sql || !isDeepStrictEqual(values, next.values))
        throw new Error("Unexpected owning service query");
      return { rows: structuredClone(next.rows) };
    },
  } as unknown as PoolClient;
  transaction.client = client;
  transaction.calls = [];
  const service = new PostgresReleaseSelectionInstaller({} as PolicyTransactionPool, auth);
  return {
    example,
    expectedResult,
    observations,
    lookup,
    credentials,
    service,
    calls,
    run: () =>
      example.operation === "selection"
        ? service.publishSelection(credentials, example.intent)
        : service.publishLifecycle(credentials, example.intent),
    consumed: () => position,
  };
}
describe("installer owning composition against actual native observations", () => {
  it("rejects missing or ambiguous bundled native authority definitions before a transaction", async () => {
    const migrations = await loadBundledMigrations();
    expect(() => prepareReleaseInstallerSchema([])).toThrow();
    const index = migrations.findIndex(
        (item) => item.id === "0071_authenticated_release_selection_publication",
      ),
      original = migrations[index];
    if (!original) throw new Error("Missing bundled migration");
    for (const sql of ["-- Missing definitions", original.sql + original.sql]) {
      const damaged = migrations.map((item, n) => (n === index ? { ...item, sql } : item));
      expect(() => prepareReleaseInstallerSchema(damaged)).toThrow();
    }
    const repair = migrations.find((item) => item.id === "0072_qualify_installer_role_catalogs");
    if (!repair) throw new Error("Missing forward repair");
    expect(() =>
      prepareReleaseInstallerSchema(migrations.filter((item) => item !== repair)),
    ).toThrow();
    for (const sql of ["-- Missing current definition", repair.sql + repair.sql]) {
      expect(() =>
        prepareReleaseInstallerSchema(
          migrations.map((item) => (item === repair ? { ...item, sql } : item)),
        ),
      ).toThrow();
    }
  });
  it.each(wire.cases)(
    "retains $name original receipts with current recorded readiness",
    (example) => {
      const f = fixture(example.name);
      return f.run().then((result) => {
        expect(result).toEqual(f.expectedResult);
        expect(f.consumed()).toBe(f.observations.length);
        expect(transaction.calls).toEqual([{ scope: example.scope, requireWire: true }]);
      });
    },
  );
  it("rejects a principal-shaped authenticator during composition", () => {
    expect(
      () =>
        new PostgresReleaseSelectionInstaller(
          {} as PolicyTransactionPool,
          {} as ReleaseMutationAuthenticator,
        ),
    ).toThrow();
  });
  it("authenticates cookie possession before touching a malformed mutation body or database", async () => {
    const f = fixture();
    f.lookup.active = false;
    let reads = 0;
    const raw = Object.defineProperty({}, "selectionId", {
      enumerable: true,
      get() {
        reads++;
        throw new Error("Body touched before authentication");
      },
    });
    await expect(f.service.publishSelection(f.credentials, raw)).rejects.toBeDefined();
    expect(reads).toBe(0);
    expect(f.calls).toHaveLength(0);
    expect(transaction.calls).toHaveLength(0);
  });
  it.each(["issuerPrincipalId", "scope", "publishedAt", "publication"])(
    "rejects caller %s before native I/O",
    async (key) => {
      const f = fixture();
      await expect(
        f.service.publishSelection(f.credentials, {
          ...(f.example.intent as object),
          [key]: "caller",
        }),
      ).rejects.toBeDefined();
      expect(f.calls).toHaveLength(0);
    },
  );
  it.each([
    "body",
    "config",
    "definer",
    "language",
    "volatility",
    "missing",
    "duplicate",
    "rls",
    "trigger",
    "trigger_events",
    "trigger_condition",
    "trigger_columns",
    "trigger_arguments",
    "trigger_schema",
  ])("rejects %s schema damage before original source creation", async (change) => {
    const f = fixture(),
      routine = f.observations.find((q) => q.sql.includes("FROM pg_catalog.pg_proc p"));
    if (!routine?.rows[0]) throw new Error("Native schema fixture missing");
    const row = routine.rows[0];
    if (change === "body") row["body"] += "\n-- changed";
    if (change === "config") row["config"] = ["search_path=public"];
    if (change === "definer") row["definer"] = !row["definer"];
    if (change === "language") row["language"] = "sql";
    if (change === "volatility") row["volatility"] = "s";
    if (change === "missing") routine.rows.shift();
    if (change === "duplicate") routine.rows.push(structuredClone(row));
    if (change === "rls") {
      const q = f.observations.find((q) => q.sql.includes("relforcerowsecurity"));
      if (!q?.rows[0]) throw new Error("Fixture missing");
      q.rows[0]["forced"] = false;
    }
    if (change === "trigger") {
      const q = f.observations.find((q) => q.sql.includes("FROM pg_catalog.pg_trigger t"));
      if (!q?.rows[0]) throw new Error("Fixture missing");
      q.rows[0]["enabled"] = "D";
    }
    if (change.startsWith("trigger_")) {
      const q = f.observations.find((q) => q.sql.includes("FROM pg_catalog.pg_trigger t"));
      if (!q?.rows[0]) throw new Error("Fixture missing");
      if (change === "trigger_events") q.rows[0]["type"] = 9;
      if (change === "trigger_condition") q.rows[0]["unconditional"] = false;
      if (change === "trigger_columns") q.rows[0]["columns"] = "12";
      if (change === "trigger_arguments") q.rows[0]["arguments"] = 1;
      if (change === "trigger_schema") q.rows[0]["function_schema"] = "untrusted";
    }
    await expect(f.run()).rejects.toBeDefined();
    expect(
      f.calls.some((q) =>
        q.sql.startsWith("SELECT public.proofstack_begin_authenticated_selection"),
      ),
    ).toBe(false);
  });
  it.each(["table", "column", "sequence", "schema", "database", "function", "identity"])(
    "rejects effective %s power before any source is created",
    async (kind) => {
      const f = fixture();
      const q = f.observations.find((q) => q.sql.includes("has_table_privilege(session_user"));
      if (!q) throw new Error("Missing actual native effective-grant observation");
      q.rows = [{ kind, name: "unexpected_power", privilege: "unexpected" }];
      await expect(f.run()).rejects.toBeDefined();
      expect(
        f.calls.some((q) =>
          q.sql.startsWith("SELECT public.proofstack_begin_authenticated_selection"),
        ),
      ).toBe(false);
    },
  );
  it.each([
    "context",
    "identity",
    "begin",
    "incomplete",
    "preimage",
    "intent",
    "encoding",
    "finish",
  ])("rejects damaged native %s without exposing a successful receipt", async (damage) => {
    const f = fixture();
    const first = (text: string) => {
      const q = f.observations.find((q) => q.sql.startsWith(`SELECT public.${text}`));
      if (!q) throw new Error("Fixture missing");
      return q;
    };
    if (damage === "context") first("proofstack_release_installer_context").rows = [{ value: 1 }];
    if (damage === "identity") {
      const q = first("proofstack_recheck_release_installer");
      const value = q.rows[0]?.["value"] as Record<string, unknown>;
      value["actor"] = {};
    }
    if (damage === "begin")
      first("proofstack_begin_authenticated_selection").rows = [{ value: { created: "true" } }];
    if (damage === "finish")
      first("proofstack_finish_selection_publication").rows = [{ value: {} }];
    if (damage === "preimage") {
      const q = f.observations.find((q) => q.values?.[3] === "grant");
      if (!q) throw new Error("Fixture missing");
      q.rows = [{ value: {} }];
    }
    if (damage === "incomplete" || damage === "intent") {
      const q = f.observations.find(
        (q) =>
          q.values?.[3] === "header" &&
          (q.rows[0]?.["value"] as Record<string, unknown> | null)?.["completed"] === true,
      );
      if (!q) throw new Error("Fixture missing");
      const row = q.rows[0]?.["value"] as Record<string, unknown>;
      row[damage === "intent" ? "canonicalIntent" : "completed"] = false;
    }
    if (damage === "encoding") {
      const q = f.observations.find((q) => q.values?.[3] === "source_encoding");
      if (!q) throw new Error("Fixture missing");
      q.rows = [{ value: "{}" }];
    }
    await expect(f.run()).rejects.toBeDefined();
  });
});
