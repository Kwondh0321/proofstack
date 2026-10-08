import { readFileSync } from "node:fs";
import type { EvidenceScope } from "@proofstack/contracts";
import {
  MAX_FIXTURE_SOURCE_EVENTS,
  type RuntimeDefinition,
  type RuntimeDefinitionRecord,
} from "@proofstack/contracts";
import type { ModelAssuranceRecordKind } from "@proofstack/core";
import { policyAuthorityFixture } from "@proofstack/core/testing";
import type {
  PolicyEvaluationMetadataPorts,
  PolicyEvaluationSourceRecheckPorts,
} from "@proofstack/policy-evaluation";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { loadBundledMigrations } from "./migrations.js";
import {
  MAX_POLICY_METADATA_INSTALLATION_BINDINGS,
  PostgresPolicySourceTransactions,
} from "./postgres-policy-source-transactions.js";
import { PostgresTransactionCleanupError } from "./tenant-transaction.js";

const scope: EvidenceScope = {
  tenantId: "tenant_guard",
  projectId: "project_guard",
  environmentId: "environment_guard",
};
const at = "2026-10-01T02:00:00.000001Z";
type Rows = { rows: Record<string, unknown>[] };
const migrationRows = (await loadBundledMigrations()).map(({ id, checksum }) => ({ id, checksum }));
const historyLimits = { maxRecords: 10, maxRecordBytes: 100_000 };

function fixture() {
  const queries: { text: string; values?: readonly unknown[] }[] = [];
  const release = vi.fn();
  const response = vi.fn(
    async (text: string): Promise<Rows> =>
      text.includes("try_lock_policy")
        ? { rows: [{ acquired: true }] }
        : text.includes("clock_timestamp")
          ? { rows: [{ observed_at: at }] }
          : text.includes("to_regclass")
            ? { rows: [{ ledger: "proofstack_schema_migrations" }] }
            : text.includes("SELECT id, checksum")
              ? { rows: migrationRows }
              : text.includes("AS retained_candidate_storage")
                ? { rows: [{ retained_candidate_body: false, retained_candidate_storage: false }] }
                : text.includes("AS retained_evaluation_storage")
                  ? {
                      rows: [
                        { retained_evaluation_body: false, retained_evaluation_storage: false },
                      ],
                    }
                  : text.includes("AS retained_comparison_storage")
                    ? {
                        rows: [
                          { retained_comparison_body: false, retained_comparison_storage: false },
                        ],
                      }
                    : text.includes("proofstack_read_replay_job_snapshot")
                      ? { rows: [{ snapshot: null }] }
                      : { rows: [] },
  );
  const client = {
    query: async (text: string, values?: readonly unknown[]) => {
      queries.push({ text, ...(values ? { values } : {}) });
      return response(text);
    },
    release,
  };
  const connect = vi.fn(async () => client);
  const adapter = new PostgresPolicySourceTransactions({ connect } as unknown as Pick<
    Pool,
    "connect"
  >);
  return { queries, release, response, connect, adapter };
}

const traceId = "5bf92f3577b34da6a3ce929d0e0e4736";
const bindingReference = {
  bindingVersionId: "binding_one",
  definitionSha256: "1".repeat(64),
  installationId: "installation_one",
};
const modelKinds: readonly ModelAssuranceRecordKind[] = [
  "blinded_evaluation_plan",
  "blinded_evaluation_result",
  "calibration_report",
  "human_review_protocol",
  "human_review_record",
  "human_reviewer_independence",
  "independence_declaration",
  "independent_critique",
  "model_assisted_evaluator",
  "model_assurance_assessment",
  "model_evaluator_profile",
  "model_qualification_report",
  "model_qualification_suite",
];

function metadataReads(ports: PolicyEvaluationMetadataPorts, input = scope) {
  const { records } = ports;
  return [
    ...Object.values(records.evidence.evaluation).map((read) => () => read(input, "record_one")),
    ...modelKinds.map(
      (kind) => () => records.evidence.modelAssurance.find(input, kind, "record_one"),
    ),
    ...Object.values(records.control.comparison).map((read) => () => read(input, "record_one")),
    () => records.control.releaseCandidate.findReleaseCandidate(input, "record_one"),
    () => records.control.releasePolicy.findReleasePolicy(input, "record_one"),
    () =>
      records.control.installationBinding.resolve({ scope: input, reference: bindingReference }),
    ...Object.values(records.datasets).map((read) => () => read(input, "record_one")),
    ...Object.values(records.replayDefinitions).map((read) => () => read(input, "record_one")),
    () => records.replayResults.findJob(input, "record_one"),
    () => records.runtimeDefinitions.findRuntimeProfile(input, "runtime_one", "1.0.0"),
    () => records.runtimeDefinitions.findIsolationProfile(input, "isolation_one", "1.0.0"),
    () => records.runtimeDefinitions.findRuntimeAdapter(input, "adapter_one"),
    () => ports.evidence.resolveExactEvents(input, traceId, ["event_one"]),
    () => ports.criterionStatusHistory.listCriterionSetStatuses(input, historyLimits),
    () => ports.fixtureContent.findRecordedInteractionFixtureContent(input, "record_one"),
  ];
}

describe("guarded policy metadata transaction ports", () => {
  it("acquires metadata and verifies the ledger before exposing only fixed owning reads", async () => {
    const f = fixture();
    await f.adapter.runMetadata(scope, async (ports) => {
      const statements = f.queries.map(({ text }) => text);
      expect(statements.some((text) => text.includes("try_lock_policy_evaluation_metadata"))).toBe(
        true,
      );
      expect(statements.some((text) => text.includes("SELECT id, checksum"))).toBe(true);
      expect(Object.keys(ports).sort()).toEqual([
        "criterionStatusHistory",
        "evidence",
        "fixtureContent",
        "records",
        "sources",
      ]);
      expect(Object.keys(ports.records).sort()).toEqual([
        "control",
        "datasets",
        "evidence",
        "replayDefinitions",
        "replayResults",
        "runtimeDefinitions",
      ]);
      expect(Object.keys(ports.records.evidence.evaluation)).toHaveLength(17);
      for (const read of metadataReads(ports)) await read();
    });
    expect(f.connect).toHaveBeenCalledTimes(1);
    expect(f.queries.filter(({ text }) => text.startsWith("BEGIN"))).toHaveLength(1);
    expect(f.queries.at(-1)?.text).toBe("COMMIT");
    expect(
      f.queries.filter(({ text }) => text.includes("proofstack_evaluation_records")),
    ).toHaveLength(18);
    expect(
      f.queries.filter(({ text }) => text.includes("proofstack_model_assurance_records")),
    ).toHaveLength(13);
  });

  it.each(["guard", "ledger"])("never invokes the callback after a %s failure", async (kind) => {
    const f = fixture();
    const original = f.response.getMockImplementation();
    if (!original) throw new Error("Missing query response");
    f.response.mockImplementation(async (text) =>
      kind === "guard" && text.includes("try_lock_policy_evaluation_metadata")
        ? { rows: [{ acquired: false }] }
        : kind === "ledger" && text.includes("SELECT id, checksum")
          ? { rows: migrationRows.slice(0, -1) }
          : original(text),
    );
    const callback = vi.fn(async () => null);
    await expect(f.adapter.runMetadata(scope, callback)).rejects.toThrow();
    expect(callback).not.toHaveBeenCalled();
    expect(f.queries.at(-1)?.text).toBe("ROLLBACK");
  });

  it("expires every nested read when its guarded transaction returns", async () => {
    const f = fixture();
    const retained = await f.adapter.runMetadata(scope, async (ports) => ports);
    const before = f.queries.length;
    for (const read of metadataReads(retained)) await expect(read()).rejects.toThrow("expired");
    await expect(retained.sources.observationTime()).rejects.toThrow("expired");
    expect(f.queries).toHaveLength(before);
  });

  for (const fail of [false, true]) {
    it(`drains an unawaited nested ${fail ? "failed" : "successful"} read before cleanup`, async () => {
      const f = fixture();
      const original = f.response.getMockImplementation();
      if (!original) throw new Error("Missing query response");
      let finish!: (value: Rows) => void;
      let reject!: (error: Error) => void;
      const read = new Promise<Rows>((resolve, failure) => {
        finish = resolve;
        reject = failure;
      });
      let notice!: () => void;
      const started = new Promise<void>((resolve) => {
        notice = resolve;
      });
      f.response.mockImplementation(async (sql) =>
        sql.includes("FROM public.proofstack_evaluation_records") ? read : original(sql),
      );
      const failure = new Error("nested source read failed");
      const running = f.adapter.runMetadata(scope, async (ports) => {
        void ports.records.evidence.evaluation
          .findCriterionSet(scope, "criterion_one")
          .catch(() => undefined);
        notice();
        return "done";
      });
      const outcome = running.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      await started;
      expect(f.release).not.toHaveBeenCalled();
      expect(f.queries.map(({ text }) => text)).not.toContain("COMMIT");
      if (fail) reject(failure);
      else
        finish({ rows: [{ retained_evaluation_body: false, retained_evaluation_storage: false }] });
      expect(await outcome).toEqual(fail ? { error: failure } : { value: "done" });
      expect(f.queries.at(-1)?.text).toBe(fail ? "ROLLBACK" : "COMMIT");
      expect(f.release).toHaveBeenCalledTimes(1);
    });
  }

  it.each(["model kind", "record ID", "trace ID"])(
    "rejects invalid %s routing before SQL",
    async (kind) => {
      const f = fixture();
      let before = 0;
      await expect(
        f.adapter.runMetadata(scope, async (ports) => {
          before = f.queries.length;
          if (kind === "model kind")
            return ports.records.evidence.modelAssurance.find(
              scope,
              "unsupported" as ModelAssuranceRecordKind,
              "record_one",
            );
          if (kind === "record ID")
            return ports.records.evidence.evaluation.findCriterionSet(scope, "invalid id");
          return ports.evidence.resolveExactEvents(scope, "00000000000000000000000000000000", [
            "event_one",
          ]);
        }),
      ).rejects.toThrow();
      expect(f.queries).toHaveLength(before + 1);
      expect(f.queries.at(-1)?.text).toBe("ROLLBACK");
    },
  );

  it.each(["tenantId", "projectId", "environmentId"] as const)(
    "taints a caught %s scope escape before SQL",
    async (field) => {
      const f = fixture();
      let failure: unknown;
      let before = 0;
      await expect(
        f.adapter.runMetadata(scope, async (ports) => {
          before = f.queries.length;
          try {
            await ports.records.evidence.evaluation.findCriterionSet(
              { ...scope, [field]: "foreign_scope" },
              "criterion_one",
            );
          } catch (error) {
            failure = error;
          }
          for (const read of metadataReads(ports)) await expect(read()).rejects.toBe(failure);
          return "must_not_commit";
        }),
      ).rejects.toThrow("scope differs");
      expect(f.queries).toHaveLength(before + 1);
      expect(f.queries.at(-1)?.text).toBe("ROLLBACK");
    },
  );

  it.each(
    [
      [],
      ["event_one", "event_one"],
      ["invalid id"],
      Array.from({ length: MAX_FIXTURE_SOURCE_EVENTS + 1 }, (_, index) => `event_${index}`),
    ].map((eventIds) => [eventIds]),
  )("rejects invalid or oversized exact event input before SQL", async (eventIds) => {
    const f = fixture();
    let before = 0;
    await expect(
      f.adapter.runMetadata(scope, async (ports) => {
        before = f.queries.length;
        return ports.evidence.resolveExactEvents(scope, traceId, eventIds as string[]);
      }),
    ).rejects.toThrow();
    expect(f.queries).toHaveLength(before + 1);
    expect(f.queries.at(-1)?.text).toBe("ROLLBACK");
  });

  it("preserves immutable installation catalogue records and detached results without external reads", async () => {
    const f = fixture();
    const { binding } = policyAuthorityFixture();
    const original = structuredClone(binding);
    const adapter = new PostgresPolicySourceTransactions(
      { connect: f.connect } as unknown as Pick<Pool, "connect">,
      { installationBindings: [binding] },
    );
    binding.registeredByPrincipalId = "mutated_operator";
    const reference = {
      installationId: original.installationId,
      bindingVersionId: original.bindingVersionId,
      definitionSha256: original.definitionSha256,
    };
    await adapter.runMetadata(original.scope, async (ports) => {
      const before = f.queries.length;
      const result = await ports.records.control.installationBinding.resolve({
        scope: original.scope,
        reference,
      });
      expect(result).toEqual(original);
      if (!result) throw new Error("Missing catalogue record");
      result.registeredByPrincipalId = "mutated_result";
      await expect(
        ports.records.control.installationBinding.resolve({ scope: original.scope, reference }),
      ).resolves.toEqual(original);
      expect(f.queries).toHaveLength(before);
    });
  });

  it("copies all three runtime definition kinds before guards and returns detached exact versions", async () => {
    const f = fixture();
    const document = JSON.parse(
      readFileSync(
        new URL("../../contracts/vectors/runtime-definition-v1.json", import.meta.url),
        "utf8",
      ),
    ) as {
      vectors: { input: { definition: RuntimeDefinition; scope: EvidenceScope }; sha256: string }[];
    };
    const records: RuntimeDefinitionRecord[] = document.vectors.map(({ input, sha256 }) => ({
      ...input.definition,
      scope: input.scope,
      definitionSha256: sha256,
      schemaVersion: "0.1",
      registeredAt: "2026-09-26T00:00:00.000Z",
      registeredByPrincipalId: "operator_runtime",
    }));
    const originals = structuredClone(records);
    const adapter = new PostgresPolicySourceTransactions(
      { connect: f.connect } as unknown as Pick<Pool, "connect">,
      { runtimeDefinitions: records },
    );
    for (const record of records) record.registeredByPrincipalId = "changed_operator";
    for (const record of originals)
      await adapter.runMetadata(record.scope, async (ports) => {
        const before = f.queries.length;
        const runtime = ports.records.runtimeDefinitions;
        const read = () =>
          record.recordKind === "runtime_adapter"
            ? runtime.findRuntimeAdapter(record.scope, record.adapterVersionId)
            : record.recordKind === "replay_runtime_profile"
              ? runtime.findRuntimeProfile(record.scope, record.id, record.version)
              : runtime.findIsolationProfile(record.scope, record.id, record.version);
        const result = (await read()) as RuntimeDefinitionRecord;
        expect(result).toEqual(record);
        result.registeredByPrincipalId = "changed_result";
        await expect(read()).resolves.toEqual(record);
        expect(f.queries).toHaveLength(before);
      });
  });

  it("owns exact scope and ordered event IDs before asynchronous database work", async () => {
    const f = fixture();
    const original = f.response.getMockImplementation();
    if (!original) throw new Error("Missing query response");
    const input = { ...scope };
    const eventIds = ["event_second", "event_first"];
    f.response.mockImplementation(async (sql) => {
      if (sql.includes("proofstack_evidence_events")) {
        input.projectId = "mutated_project";
        eventIds.reverse();
      }
      return original(sql);
    });
    await f.adapter.runMetadata(scope, (ports) =>
      ports.evidence.resolveExactEvents(input, traceId, eventIds),
    );
    const query = f.queries.find(({ text }) => text.includes("proofstack_evidence_events"));
    expect(query?.values).toEqual([
      scope.tenantId,
      scope.projectId,
      scope.environmentId,
      traceId,
      ["event_second", "event_first"],
    ]);
  });

  it("rejects invalid and oversized operator catalogues before connecting", () => {
    const f = fixture();
    for (const catalogues of [
      { installationBindings: Array(MAX_POLICY_METADATA_INSTALLATION_BINDINGS + 1).fill(null) },
      { installationBindings: [null] },
      { installationBindings: null },
      { runtimeDefinitions: [null] },
      { runtimeDefinitions: null },
      { runtimeDefinitions: Array(257).fill(null) },
    ])
      expect(
        () =>
          new PostgresPolicySourceTransactions(
            { connect: f.connect } as unknown as Pick<Pool, "connect">,
            catalogues as never,
          ),
      ).toThrow();
    expect(f.connect).not.toHaveBeenCalled();
  });
});

describe("PostgresPolicySourceTransactions", () => {
  it("sets explicit READ COMMITTED and exact scope before all locks and normalized reads on one connection", async () => {
    const f = fixture();
    const result = await f.adapter.run(scope, async (ports) => {
      expect(Object.keys(ports).sort()).toEqual([
        "findArtifact",
        "findCriterion",
        "findPolicy",
        "listCriterionSetStatuses",
        "listPolicyHistory",
        "observationTime",
        "tryGuard",
        "tryMetadataGuard",
      ]);
      expect(await ports.tryMetadataGuard()).toBe(true);
      expect(await ports.tryGuard("artifact", "artifact_one")).toBe(true);
      expect(await ports.tryGuard("release_policy", "policy_one")).toBe(true);
      expect(await ports.findArtifact("artifact_one")).toBeNull();
      expect(await ports.findPolicy("policy_one")).toBeNull();
      expect(await ports.listPolicyHistory("policy_one")).toEqual([]);
      expect(await ports.findCriterion("criterion_one")).toBeNull();
      expect(await ports.listCriterionSetStatuses(historyLimits)).toEqual([]);
      return ports.observationTime();
    });
    expect(result).toBe(at);
    expect(f.connect).toHaveBeenCalledTimes(1);
    expect(f.queries.slice(0, 4)).toEqual([
      { text: "BEGIN ISOLATION LEVEL READ COMMITTED" },
      { text: "SELECT set_config('proofstack.tenant_id', $1, true)", values: [scope.tenantId] },
      { text: "SELECT set_config('proofstack.project_id', $1, true)", values: [scope.projectId] },
      {
        text: "SELECT set_config('proofstack.environment_id', $1, true)",
        values: [scope.environmentId],
      },
    ]);
    const reads = f.queries.filter(
      ({ text }) =>
        text.includes("FROM public.proofstack_artifact_catalog") ||
        text.includes("FROM public.proofstack_release_policies") ||
        text.includes("FROM public.proofstack_release_policy_lifecycle_events"),
    );
    expect(reads).toHaveLength(3);
    for (const read of reads)
      expect(read.values?.slice(0, 3)).toEqual([
        scope.tenantId,
        scope.projectId,
        scope.environmentId,
      ]);
    const criterionReads = f.queries.filter(({ text }) =>
      text.includes("FROM public.proofstack_evaluation_records"),
    );
    expect(criterionReads.map(({ values }) => values)).toEqual([
      [scope.tenantId, scope.projectId, scope.environmentId, "criterion_set", "criterion_one"],
      [scope.tenantId, scope.projectId, scope.environmentId, historyLimits.maxRecords + 1],
    ]);
    const ledgerIndex = f.queries.findIndex(({ text }) => text.includes("SELECT id, checksum"));
    expect(ledgerIndex).toBeGreaterThan(
      f.queries.findIndex(({ text }) => text.includes("try_lock_policy_evaluation_metadata")),
    );
    expect(ledgerIndex).toBeLessThan(
      f.queries.findIndex(({ text }) => text.includes("FROM public.proofstack_evaluation_records")),
    );
    expect(f.queries.at(-1)?.text).toBe("COMMIT");
    expect(f.release.mock.calls).toEqual([[]]);
  });

  it("owns scope before an asynchronous connection callback can mutate caller input", async () => {
    const f = fixture();
    const input = { ...scope };
    const connect = f.connect.getMockImplementation();
    if (!connect) throw new Error("Expected connection fixture");
    f.connect.mockImplementation(async () => {
      input.tenantId = "tenant_changed";
      return connect();
    });
    await f.adapter.run(input, (ports) => ports.findArtifact("artifact_one"));
    expect(f.queries[1]?.values).toEqual([scope.tenantId]);
    expect(
      f.queries.find(({ text }) => text.includes("FROM public.proofstack_artifact_catalog"))
        ?.values,
    ).toEqual([scope.tenantId, scope.projectId, scope.environmentId, "artifact_one"]);
  });

  it("rolls back all earlier guards and taints even a caught later acquisition failure", async () => {
    const f = fixture();
    let calls = 0;
    f.response.mockImplementation(async (text) =>
      text.includes("try_lock_policy") ? { rows: [{ acquired: ++calls === 1 }] } : { rows: [] },
    );
    let failure: unknown;
    await expect(
      f.adapter.run(scope, async (ports) => {
        await ports.tryGuard("artifact", "artifact_first");
        try {
          await ports.tryGuard("artifact", "artifact_last");
        } catch (error) {
          failure = error;
        }
        await expect(ports.findPolicy("policy_one")).rejects.toBe(failure);
        return "must_not_commit";
      }),
    ).rejects.toMatchObject({ reason: "guard_unavailable" });
    expect(f.queries.map(({ text }) => text)).not.toContain("COMMIT");
    expect(f.queries.at(-1)?.text).toBe("ROLLBACK");
    expect(f.queries.filter(({ text }) => text.includes("try_lock_policy"))).toHaveLength(2);
    expect(
      f.queries.some(({ text }) => text.includes("FROM public.proofstack_release_policies")),
    ).toBe(false);
  });

  it.each([
    { rows: [] },
    { rows: [{ acquired: true }, { acquired: true }] },
    { rows: [{ acquired: "true" }] },
    { rows: [{ acquired: null }] },
  ])("rejects malformed guard rows %j instead of treating them as success", async ({ rows }) => {
    const f = fixture();
    f.response.mockImplementation(async (text) =>
      text.includes("try_lock_policy") ? { rows } : { rows: [] },
    );
    await expect(
      f.adapter.run(scope, (ports) => ports.tryGuard("artifact", "artifact_one")),
    ).rejects.toMatchObject({ reason: "guard_invalid" });
    expect(f.queries.at(-1)?.text).toBe("ROLLBACK");
  });

  it.each(["kind", "id"])("rejects invalid guard %s before its SQL", async (kind) => {
    const f = fixture();
    await expect(
      f.adapter.run(scope, (ports) =>
        ports.tryGuard(
          kind === "kind" ? ("unknown" as "artifact") : "artifact",
          kind === "id" ? "invalid id" : "artifact_one",
        ),
      ),
    ).rejects.toThrow();
    expect(f.queries.some(({ text }) => text.includes("try_lock_policy"))).toBe(false);
    expect(f.queries.at(-1)?.text).toBe("ROLLBACK");
  });

  it.each(["tenantId", "projectId", "environmentId"] as const)(
    "rejects invalid %s before connecting",
    async (field) => {
      const f = fixture();
      await expect(f.adapter.run({ ...scope, [field]: "" }, async () => null)).rejects.toThrow();
      expect(f.connect).not.toHaveBeenCalled();
    },
  );

  it.each([
    { rows: [] },
    { rows: [{ observed_at: at }, { observed_at: at }] },
    { rows: [{ observed_at: "bad" }] },
  ])("rejects malformed database clock rows %j", async ({ rows }) => {
    const f = fixture();
    f.response.mockImplementation(async (text) =>
      text.includes("clock_timestamp") ? { rows } : { rows: [] },
    );
    await expect(f.adapter.run(scope, (ports) => ports.observationTime())).rejects.toThrow();
    expect(f.queries.at(-1)?.text).toBe("ROLLBACK");
  });

  it("expires every read/guard port before releasing the connection", async () => {
    const f = fixture();
    let retained: PolicyEvaluationSourceRecheckPorts | undefined;
    await f.adapter.run(scope, async (ports) => {
      retained = ports;
      return null;
    });
    if (!retained) throw new Error("Expected retained test ports");
    const ports = retained;
    const before = f.queries.length;
    for (const call of [
      () => ports.tryMetadataGuard(),
      () => ports.tryGuard("artifact", "artifact_one"),
      () => ports.findCriterion("criterion_one"),
      () => ports.listCriterionSetStatuses(historyLimits),
      () => ports.findArtifact("artifact_one"),
      () => ports.findPolicy("policy_one"),
      () => ports.listPolicyHistory("policy_one"),
      () => ports.observationTime(),
    ])
      await expect(call()).rejects.toThrow("expired");
    expect(f.queries).toHaveLength(before);
  });

  it.each(["criterion", "history"])(
    "rejects a %s read before metadata acquisition without SQL",
    async (kind) => {
      const f = fixture();
      await expect(
        f.adapter.run(scope, (ports) =>
          kind === "criterion"
            ? ports.findCriterion("criterion_one")
            : ports.listCriterionSetStatuses(historyLimits),
        ),
      ).rejects.toMatchObject({ reason: "guard_unavailable", identity: "metadata" });
      expect(f.queries.some(({ text }) => text.includes("proofstack_evaluation_records"))).toBe(
        false,
      );
      expect(f.queries.at(-1)?.text).toBe("ROLLBACK");
    },
  );

  it.each([
    { rows: [], reason: "guard_invalid" },
    { rows: [{ acquired: false }], reason: "guard_unavailable" },
    { rows: [{ acquired: "true" }], reason: "guard_invalid" },
    { rows: [{ acquired: null }], reason: "guard_invalid" },
    { rows: [{ acquired: true }, { acquired: true }], reason: "guard_invalid" },
  ])("abandons partial metadata guards on $reason response $rows", async ({ rows, reason }) => {
    const f = fixture();
    f.response.mockImplementation(async (text) =>
      text.includes("try_lock_policy_evaluation_metadata") ? { rows } : { rows: [] },
    );
    await expect(f.adapter.run(scope, (ports) => ports.tryMetadataGuard())).rejects.toMatchObject({
      reason,
      identity: "metadata",
    });
    expect(f.queries.some(({ text }) => text.includes("to_regclass"))).toBe(false);
    expect(f.queries.at(-1)?.text).toBe("ROLLBACK");
  });

  it.each(["missing", "pending", "checksum", "unknown"])(
    "taints a caught %s migration ledger failure before source reads",
    async (kind) => {
      const f = fixture();
      const original = f.response.getMockImplementation();
      if (!original) throw new Error("Missing query fixture");
      f.response.mockImplementation(async (text) => {
        if (kind === "missing" && text.includes("to_regclass")) return { rows: [{ ledger: null }] };
        if (text.includes("SELECT id, checksum"))
          return {
            rows:
              kind === "pending"
                ? migrationRows.slice(0, -1)
                : kind === "checksum"
                  ? migrationRows.map((row, index) =>
                      index === 0 ? { ...row, checksum: "0".repeat(64) } : row,
                    )
                  : [...migrationRows, { id: "9999_unknown", checksum: "0".repeat(64) }],
          };
        return original(text);
      });
      let failure: unknown;
      await expect(
        f.adapter.run(scope, async (ports) => {
          try {
            await ports.tryMetadataGuard();
          } catch (error) {
            failure = error;
          }
          await expect(ports.findCriterion("criterion_one")).rejects.toBe(failure);
          await expect(ports.listCriterionSetStatuses(historyLimits)).rejects.toBe(failure);
          return "must_not_commit";
        }),
      ).rejects.toBeDefined();
      expect(failure).toMatchObject({
        name:
          kind === "missing" || kind === "pending"
            ? "MigrationRequiredError"
            : "MigrationIntegrityError",
      });
      expect(f.queries.some(({ text }) => text.includes("proofstack_evaluation_records"))).toBe(
        false,
      );
      expect(f.queries.at(-1)?.text).toBe("ROLLBACK");
    },
  );

  it.each(["id", "limits"])(
    "validates new %s inputs before their SQL and taints the whole operation",
    async (kind) => {
      const f = fixture();
      await expect(
        f.adapter.run(scope, async (ports) => {
          await ports.tryMetadataGuard();
          return kind === "id"
            ? ports.findCriterion("invalid id")
            : ports.listCriterionSetStatuses({ ...historyLimits, maxRecords: -1 });
        }),
      ).rejects.toThrow();
      expect(f.queries.some(({ text }) => text.includes("proofstack_evaluation_records"))).toBe(
        false,
      );
      expect(f.queries.at(-1)?.text).toBe("ROLLBACK");
    },
  );

  for (const fail of [false, true])
    it(`drains an unawaited ${fail ? "failed" : "successful"} read before transaction cleanup`, async () => {
      const f = fixture();
      let finish: (rows: Rows) => void = () => {
        throw new Error("Missing read barrier");
      };
      let reject: (error: Error) => void = () => {
        throw new Error("Missing failure barrier");
      };
      const read = new Promise<Rows>((resolve, fail) => {
        finish = resolve;
        reject = fail;
      });
      let notice: () => void = () => {
        throw new Error("Missing operation barrier");
      };
      const started = new Promise<void>((resolve) => {
        notice = resolve;
      });
      f.response.mockImplementation(async (text) =>
        text.includes("clock_timestamp") ? read : { rows: [] },
      );
      const failure = new Error("late read failed");
      const running = f.adapter.run(scope, async (ports) => {
        void ports.observationTime().catch(() => undefined);
        notice();
        return "done";
      });
      const outcome = running.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      await started;
      expect(f.release).not.toHaveBeenCalled();
      expect(f.queries.map(({ text }) => text)).not.toContain("COMMIT");
      if (fail) reject(failure);
      else finish({ rows: [{ observed_at: at }] });
      expect(await outcome).toEqual(fail ? { error: failure } : { value: "done" });
      expect(f.queries.at(-1)?.text).toBe(fail ? "ROLLBACK" : "COMMIT");
      expect(f.release).toHaveBeenCalledTimes(1);
    });

  it("preserves an operation error and destroys the connection if rollback also fails", async () => {
    const f = fixture();
    const failure = new Error("operation failed");
    const rollback = new Error("rollback failed");
    f.response.mockImplementation(async (text) => {
      if (text === "ROLLBACK") throw rollback;
      return { rows: [] };
    });
    await expect(
      f.adapter.run(scope, async () => {
        throw failure;
      }),
    ).rejects.toMatchObject({
      name: PostgresTransactionCleanupError.name,
      cause: failure,
      rollbackError: rollback,
    });
    expect(f.release.mock.calls).toEqual([[true]]);
  });
});
