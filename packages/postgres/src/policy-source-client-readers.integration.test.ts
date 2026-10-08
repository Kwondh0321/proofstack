import { randomUUID } from "node:crypto";
import type { EvidenceEnvelope, EvidenceScope, ReleaseCandidate } from "@proofstack/contracts";
import {
  CreateModelAssuranceAssessment,
  comparisonRecordId,
  type EvaluationRecordKind,
  evaluationRecordId,
  modelAssuranceRecordId,
} from "@proofstack/core";
import {
  createComparisonRepositoryTestHarness,
  createModelAssuranceRepositoryTestHarness,
  createReleaseCandidateRepositoryTestHarness,
  FixedClock,
  publishComparisonFixture,
  publishEvaluationFixture,
} from "@proofstack/core/testing";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateDatabase } from "./migration-runner.js";
import {
  PostgresComparisonRepository,
  readPostgresComparisonRecordOnClient,
} from "./postgres-comparison-repository.js";
import {
  PostgresEvaluationRepository,
  readPostgresEvaluationRecordOnClient,
} from "./postgres-evaluation-repository.js";
import {
  listPostgresTraceEvidenceOnClient,
  PostgresEvidenceRepository,
  resolvePostgresExactEventsOnClient,
} from "./postgres-evidence-repository.js";
import {
  PostgresModelAssuranceRepository,
  readPostgresModelAssuranceRecordOnClient,
} from "./postgres-model-assurance-repository.js";
import { PostgresPolicySourceTransactions } from "./postgres-policy-source-transactions.js";
import {
  readPostgresDatasetVersionOnClient,
  readPostgresFixtureVersionOnClient,
  readPostgresRecordedInteractionFixtureContentOnClient,
  readPostgresRecordedInteractionFixtureVersionOnClient,
} from "./postgres-regression-version-repository.js";
import {
  PostgresReleaseCandidateRepository,
  readPostgresReleaseCandidateOnClient,
} from "./postgres-release-candidate-repository.js";
import {
  readPostgresReplayPlanOnClient,
  readPostgresTargetReleaseOnClient,
} from "./postgres-replay-definition-repository.js";
import { readPostgresReplayJobSnapshotOnClient } from "./postgres-replay-job-snapshot.js";
import { provisionRuntimeRoles, type RuntimeRoleProvisioningOptions } from "./runtime-roles.js";
import { withExactReadCommittedScopeTransaction } from "./tenant-transaction.js";

const { PROOFSTACK_TEST_DATABASE_URL: databaseUrl } = process.env;
if (!databaseUrl) throw new Error("PROOFSTACK_TEST_DATABASE_URL is required");
const runKey = randomUUID().replaceAll("-", "").slice(0, 12);
const credentials = Object.fromEntries(
  [
    "api",
    "artifact",
    "consumer",
    "evaluationWorker",
    "humanReviewer",
    "identity",
    "modelEvaluationWorker",
    "policyAuthor",
    "publisher",
    "replayWorker",
  ].map((kind) => [
    kind,
    {
      name: `ps_read_${kind.toLowerCase()}_${runKey}`,
      password: `proofstack-source-read-test-${kind}-${runKey}`,
    },
  ]),
) as unknown as RuntimeRoleProvisioningOptions;
const admin = new Pool({ connectionString: databaseUrl, max: 4 });
const candidate = createReleaseCandidateRepositoryTestHarness(`read_${runKey}`);
const comparison = createComparisonRepositoryTestHarness(`read_${runKey}`);
let assurance: Awaited<ReturnType<typeof createModelAssuranceRepositoryTestHarness>>;
const acquireSql = "SELECT public.proofstack_try_lock_policy_evaluation_metadata() AS acquired";

beforeAll(async () => {
  expect((await admin.query("SELECT current_database() AS name")).rows[0]?.name).toBe(
    "proofstack_test",
  );
  await migrateDatabase(admin);
  await provisionRuntimeRoles(admin, credentials);
  assurance = await createModelAssuranceRepositoryTestHarness(`read_${runKey}`);
  const evaluations = new PostgresEvaluationRepository(admin);
  for (const fixture of assurance.evaluation.records)
    await publishEvaluationFixture(evaluations, fixture);
  const models = new PostgresModelAssuranceRepository(admin);
  for (const fixture of assurance.records) await models.publish(fixture.kind, fixture.record);
  const assessment = await new CreateModelAssuranceAssessment({
    clock: new FixedClock(new Date("2026-09-02T06:00:00.000Z")),
    evaluationRepository: evaluations,
    modelAssuranceRepository: models,
  }).execute(assurance.command);
  assurance = {
    ...assurance,
    records: [
      ...assurance.records,
      { kind: "model_assurance_assessment", record: assessment.record },
    ],
  };
  const comparisons = new PostgresComparisonRepository(admin);
  for (const fixture of comparison.records) await publishComparisonFixture(comparisons, fixture);
});

afterAll(async () => {
  for (const { name } of Object.values(credentials)) {
    await admin.query(`DROP OWNED BY "${name}"`);
    await admin.query(`DROP ROLE "${name}"`);
  }
  await admin.end();
});

async function guardedRead(
  scope: EvidenceScope,
  inspect: (client: Pick<PoolClient, "query">) => Promise<void>,
) {
  await withExactReadCommittedScopeTransaction(admin, scope, async (client) => {
    expect((await client.query(acquireSql)).rows).toEqual([{ acquired: true }]);
    const before = (
      await client.query("SELECT pg_backend_pid() AS pid, txid_current()::text AS xid")
    ).rows;
    await client.query("SAVEPOINT caller_owned");
    await client.query(`SET LOCAL ROLE "${credentials.api.name}"`);
    // Real queries on the supplied backend; the view has no pool, release, or transaction API.
    const view = {
      query: (sql: string, values?: unknown[]) => {
        expect(sql.trim()).toMatch(/^SELECT\b/);
        return client.query(sql, values);
      },
    } as Pick<PoolClient, "query">;
    await inspect(view);
    expect(
      (await client.query("SELECT pg_backend_pid() AS pid, txid_current()::text AS xid")).rows,
    ).toEqual(before);
    await client.query("ROLLBACK TO SAVEPOINT caller_owned");
    await expect(
      withExactReadCommittedScopeTransaction(admin, scope, async (other) => {
        expect((await other.query(acquireSql)).rows).toEqual([{ acquired: false }]);
        // Always abandon partial guards on failed acquisition.
        throw new Error("Abandon probe transaction");
      }),
    ).rejects.toThrow("Abandon probe transaction");
  });
}

function wrongScopes(scope: EvidenceScope): EvidenceScope[] {
  return ["tenantId", "projectId", "environmentId"].map((key) => ({
    ...scope,
    [key]: "other_scope",
  }));
}

function metadataAdapter() {
  const statements: string[] = [];
  let pid: number | undefined;
  let connections = 0;
  const pool = {
    connect: async () => {
      connections++;
      const client = await admin.connect();
      pid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
      return {
        query: async (sql: string, values?: unknown[]) => {
          statements.push(sql);
          const result = await client.query(sql, values);
          if (sql.includes("SELECT id, checksum")) {
            // The isolated admin fixture acquires private guards first. All metadata reads then
            // execute with the existing API role and forced RLS, without granting it the guard.
            await client.query(`SET LOCAL ROLE "${credentials.api.name}"`);
          }
          return result;
        },
        release: (destroy?: boolean) => client.release(destroy),
      };
    },
  } as unknown as Pick<Pool, "connect">;
  return {
    adapter: new PostgresPolicySourceTransactions(pool),
    statements,
    get pid() {
      return pid;
    },
    get connections() {
      return connections;
    },
  };
}

const evaluationMethods = {
  aggregation_policy: "findAggregationPolicy",
  assessment: "findAssessment",
  criterion_set: "findCriterionSet",
  criterion_set_status: "findCriterionSetStatus",
  discovery_record: "findDiscoveryRecord",
  evaluation_aggregate: "findEvaluationAggregate",
  evaluation_run: "findEvaluationRun",
  evaluation_run_rejection: "findEvaluationRunRejection",
  evaluation_run_result: "findEvaluationRunResult",
  evaluator_spec: "findEvaluatorSpec",
  oracle_spec: "findOracleSpec",
  qualification_fixture_set: "findQualificationFixtureSet",
  qualification_report: "findQualificationReport",
  raw_observation: "findRawObservation",
  source_review: "findSourceReview",
  source_reviewer_qualification: "findSourceReviewerQualification",
  source_snapshot: "findSourceSnapshot",
} as const satisfies Record<EvaluationRecordKind, string>;

describe("lifetime-bound policy metadata repository ports", () => {
  it("routes all 17 evaluation and 13 model/human kinds on one guarded backend under forced RLS", async () => {
    const observed = metadataAdapter();
    await observed.adapter.runMetadata(assurance.evaluation.scope, async (ports) => {
      for (const { kind, record } of assurance.evaluation.records) {
        const actual = await ports.records.evidence.evaluation[evaluationMethods[kind]](
          record.scope,
          evaluationRecordId(kind, record),
        );
        expect(actual).toEqual(record);
        expect(actual).not.toBe(record);
      }
      for (const { kind, record } of assurance.records) {
        const actual = await ports.records.evidence.modelAssurance.find(
          record.scope,
          kind,
          modelAssuranceRecordId(kind, record),
        );
        expect(actual).toEqual(record);
        expect(actual).not.toBe(record);
      }
      const limits = { maxRecords: 100, maxRecordBytes: 100_000 };
      await expect(
        ports.criterionStatusHistory.listCriterionSetStatuses(assurance.evaluation.scope, limits),
      ).resolves.toEqual(
        await new PostgresEvaluationRepository(admin).listCriterionSetStatuses(
          assurance.evaluation.scope,
          limits,
        ),
      );
      await expect(ports.sources.observationTime()).resolves.toMatch(/Z$/);
    });
    expect(observed.connections).toBe(1);
    expect(observed.statements.filter((sql) => sql.startsWith("BEGIN"))).toHaveLength(1);
    expect(observed.statements.at(-1)).toBe("COMMIT");
  });

  it("routes all comparison records through the same guarded connection", async () => {
    const observed = metadataAdapter();
    await observed.adapter.runMetadata(comparison.scope, async (ports) => {
      const methods = {
        comparison_definition: "findComparisonDefinition",
        comparison_evidence_snapshot: "findComparisonEvidenceSnapshot",
        comparison_result: "findComparisonResult",
      } as const;
      for (const { kind, record } of comparison.records) {
        await expect(
          ports.records.control.comparison[methods[kind]](
            record.scope,
            comparisonRecordId(kind, record),
          ),
        ).resolves.toEqual(record);
      }
    });
    expect(observed.connections).toBe(1);
  });

  it("keeps absent dataset, both fixture formats, content, plan, target and replay history guarded", async () => {
    const observed = metadataAdapter();
    await observed.adapter.runMetadata(candidate.scope, async (ports) => {
      for (const read of [
        ...Object.values(ports.records.datasets),
        ...Object.values(ports.records.replayDefinitions),
        ports.records.replayResults.findJob,
        ports.fixtureContent.findRecordedInteractionFixtureContent,
      ])
        await expect(read(candidate.scope, "missing_source")).resolves.toBeNull();
      await expect(
        ports.evidence.resolveExactEvents(candidate.scope, "5bf92f3577b34da6a3ce929d0e0e4736", [
          "missing_event",
        ]),
      ).resolves.toBeNull();
    });
    expect(observed.connections).toBe(1);
  });

  it("rejects scope escape before SQL and rolls back even when the callback catches it", async () => {
    const observed = metadataAdapter();
    let before = 0;
    let failure: unknown;
    await expect(
      observed.adapter.runMetadata(candidate.scope, async (ports) => {
        before = observed.statements.length;
        try {
          await ports.records.control.releaseCandidate.findReleaseCandidate(
            { ...candidate.scope, projectId: "foreign_project" },
            candidate.candidate.candidateVersionId,
          );
        } catch (error) {
          failure = error;
        }
        await expect(
          ports.records.datasets.findDatasetVersion(candidate.scope, "missing_source"),
        ).rejects.toBe(failure);
        return "must_not_commit";
      }),
    ).rejects.toThrow("scope differs");
    expect(observed.statements).toHaveLength(before + 1);
    expect(observed.statements.at(-1)).toBe("ROLLBACK");
  });

  it("reads complete evidence envelopes in the requested order through guarded exact trace ports", async () => {
    const scope = { ...candidate.scope, tenantId: `ten_meta_trace_${runKey}` };
    const first: EvidenceEnvelope = {
      schemaVersion: "0.1",
      scope,
      receivedAt: "2026-10-03T00:00:01.000Z",
      evidence: {
        attributes: {},
        contentReferences: [],
        extensions: {},
        eventId: "evt_meta_first",
        kind: "agent.run",
        name: "guarded source read fixture",
        status: "ok",
        source: { sdkName: "test", sdkVersion: "1.0.0", serviceName: "test" },
        spanId: "40f067aa0ba902b7",
        traceId: "5bf92f3577b34da6a3ce929d0e0e4736",
        startedAt: "2026-10-03T00:00:00.000Z",
      },
    };
    const second = { ...first, evidence: { ...first.evidence, eventId: "evt_meta_second" } };
    const url = new URL(databaseUrl as string);
    url.username = credentials.api.name;
    url.password = credentials.api.password;
    const writerPool = new Pool({ connectionString: url.toString(), max: 1 });
    try {
      await new PostgresEvidenceRepository(writerPool).append([first, second]);
    } finally {
      await writerPool.end();
    }
    const observed = metadataAdapter();
    const retained = await observed.adapter.runMetadata(scope, async (ports) => {
      await expect(
        ports.evidence.resolveExactEvents(scope, first.evidence.traceId, [
          second.evidence.eventId,
          first.evidence.eventId,
        ]),
      ).resolves.toEqual([second, first]);
      await expect(
        ports.evidence.resolveExactEvents(scope, first.evidence.traceId, [
          first.evidence.eventId,
          "missing_event",
        ]),
      ).resolves.toBeNull();
      return ports.evidence;
    });
    const before = observed.statements.length;
    await expect(
      retained.resolveExactEvents(scope, first.evidence.traceId, [first.evidence.eventId]),
    ).rejects.toThrow("expired");
    expect(observed.statements).toHaveLength(before);
  });

  it("prevents an absent candidate from appearing until the complete metadata transaction ends", async () => {
    const h = createReleaseCandidateRepositoryTestHarness(`meta_${runKey}`);
    const observed = metadataAdapter();
    const writer = new PostgresReleaseCandidateRepository(admin);
    let pending: Promise<unknown> | undefined;
    let failed = false;
    let failure: unknown;
    try {
      await observed.adapter.runMetadata(h.scope, async (ports) => {
        await expect(
          ports.records.control.releaseCandidate.findReleaseCandidate(
            h.scope,
            h.candidate.candidateVersionId,
          ),
        ).resolves.toBeNull();
        pending = writer.publishReleaseCandidate(h.candidate).catch((error: unknown) => {
          failed = true;
          failure = error;
        });
        await expect
          .poll(
            async () => {
              if (failed) throw failure;
              return (
                await admin.query<{ count: number }>(
                  "SELECT count(*)::int AS count FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid)) AND wait_event = 'advisory'",
                  [observed.pid],
                )
              ).rows[0]?.count;
            },
            { timeout: 5_000, interval: 20 },
          )
          .toBeGreaterThan(0);
        await expect(
          ports.records.control.releaseCandidate.findReleaseCandidate(
            h.scope,
            h.candidate.candidateVersionId,
          ),
        ).resolves.toBeNull();
      });
    } finally {
      await pending;
    }
    if (failed) throw failure;
    await expect(
      observed.adapter.runMetadata(h.scope, (ports) =>
        ports.records.control.releaseCandidate.findReleaseCandidate(
          h.scope,
          h.candidate.candidateVersionId,
        ),
      ),
    ).resolves.toEqual(h.candidate);
  });
});

function publicationCommand(record: ReleaseCandidate) {
  return {
    candidateId: record.candidateId,
    candidateVersionId: record.candidateVersionId,
    createdAt: record.createdAt,
    createdByPrincipalId: record.createdByPrincipalId,
    definitionSha256: record.definitionSha256,
    environmentId: record.scope.environmentId,
    projectId: record.scope.projectId,
    record,
    schemaVersion: record.schemaVersion,
    tenantId: record.scope.tenantId,
  };
}

describe("source reads on one caller-owned guarded PostgreSQL connection", () => {
  it("reads all 17 evaluation kinds with exact scope and detached results under forced RLS", async () => {
    expect(new Set(assurance.evaluation.records.map(({ kind }) => kind)).size).toBe(17);
    await guardedRead(assurance.evaluation.scope, async (client) => {
      for (const { kind, record } of assurance.evaluation.records) {
        const id = evaluationRecordId(kind, record);
        const actual = await readPostgresEvaluationRecordOnClient(client, record.scope, kind, id);
        expect(actual).toEqual(record);
        expect(actual).not.toBe(record);
        for (const wrong of wrongScopes(record.scope)) {
          await expect(
            readPostgresEvaluationRecordOnClient(client, wrong, kind, id),
          ).resolves.toBeNull();
        }
        await expect(
          readPostgresEvaluationRecordOnClient(client, record.scope, kind, "missing_record"),
        ).resolves.toBeNull();
      }
    });
  });

  it("reads all 13 model/human assurance kinds through the same validated path", async () => {
    expect(new Set(assurance.records.map(({ kind }) => kind)).size).toBe(13);
    await guardedRead(assurance.evaluation.scope, async (client) => {
      for (const { kind, record } of assurance.records) {
        const id = modelAssuranceRecordId(kind, record);
        await expect(
          readPostgresModelAssuranceRecordOnClient(client, record.scope, kind, id),
        ).resolves.toEqual(record);
        for (const wrong of wrongScopes(record.scope)) {
          await expect(
            readPostgresModelAssuranceRecordOnClient(client, wrong, kind, id),
          ).resolves.toBeNull();
        }
        await expect(
          readPostgresModelAssuranceRecordOnClient(client, record.scope, kind, "missing_record"),
        ).resolves.toBeNull();
      }
    });
  });

  it("reads definitions, both comparison operands and results without another transaction", async () => {
    expect(new Set(comparison.records.map(({ kind }) => kind)).size).toBe(3);
    await guardedRead(comparison.scope, async (client) => {
      for (const { kind, record } of comparison.records) {
        const id = comparisonRecordId(kind, record);
        await expect(
          readPostgresComparisonRecordOnClient(client, record.scope, kind, id),
        ).resolves.toEqual(record);
        for (const wrong of wrongScopes(record.scope)) {
          await expect(
            readPostgresComparisonRecordOnClient(client, wrong, kind, id),
          ).resolves.toBeNull();
        }
        await expect(
          readPostgresComparisonRecordOnClient(client, record.scope, kind, "missing_record"),
        ).resolves.toBeNull();
      }
    });
  });

  it("observes uncommitted candidate publication and its savepoint rollback on the supplied backend", async () => {
    const { scope, candidate: record } = candidate;
    await withExactReadCommittedScopeTransaction(admin, scope, async (client) => {
      expect((await client.query(acquireSql)).rows).toEqual([{ acquired: true }]);
      await client.query("SAVEPOINT candidate_publication");
      await client.query(`SET LOCAL ROLE "${credentials.api.name}"`);
      await client.query("SELECT public.proofstack_publish_release_candidate($1::jsonb)", [
        JSON.stringify(publicationCommand(record)),
      ]);
      await expect(
        readPostgresReleaseCandidateOnClient(client, scope, record.candidateVersionId),
      ).resolves.toEqual(record);
      for (const wrong of wrongScopes(scope)) {
        await expect(
          readPostgresReleaseCandidateOnClient(client, wrong, record.candidateVersionId),
        ).resolves.toBeNull();
      }
      await withExactReadCommittedScopeTransaction(admin, scope, async (other) => {
        await expect(
          readPostgresReleaseCandidateOnClient(other, scope, record.candidateVersionId),
        ).resolves.toBeNull();
      });
      await client.query("ROLLBACK TO SAVEPOINT candidate_publication");
      await expect(
        readPostgresReleaseCandidateOnClient(client, scope, record.candidateVersionId),
      ).resolves.toBeNull();
    });
  });

  it("keeps absent dataset, fixture and replay reads inside the guarded cut", async () => {
    await guardedRead(candidate.scope, async (client) => {
      for (const read of [
        readPostgresDatasetVersionOnClient,
        readPostgresFixtureVersionOnClient,
        readPostgresRecordedInteractionFixtureVersionOnClient,
        readPostgresRecordedInteractionFixtureContentOnClient,
        readPostgresReplayPlanOnClient,
        readPostgresTargetReleaseOnClient,
        readPostgresReplayJobSnapshotOnClient,
      ]) {
        await expect(read(client, candidate.scope, "missing_source")).resolves.toBeNull();
      }
    });
  });

  it("reads uncommitted trace pages and exact ordered events, then respects caller rollback", async () => {
    const scope = { ...candidate.scope, tenantId: `ten_trace_${runKey}` };
    const first: EvidenceEnvelope = {
      schemaVersion: "0.1",
      scope,
      receivedAt: "2026-10-03T00:00:01.000Z",
      evidence: {
        attributes: {},
        contentReferences: [],
        extensions: {},
        eventId: "evt_source_first",
        kind: "agent.run",
        name: "source read fixture",
        status: "ok",
        source: { sdkName: "test", sdkVersion: "1.0.0", serviceName: "test" },
        spanId: "40f067aa0ba902b7",
        traceId: "5bf92f3577b34da6a3ce929d0e0e4736",
        startedAt: "2026-10-03T00:00:00.000Z",
      },
    };
    const second = { ...first, evidence: { ...first.evidence, eventId: "evt_source_second" } };
    await withExactReadCommittedScopeTransaction(admin, scope, async (client) => {
      expect((await client.query(acquireSql)).rows).toEqual([{ acquired: true }]);
      await client.query("SAVEPOINT trace_capture");
      for (const event of [first, second]) {
        await client.query(
          `INSERT INTO public.proofstack_evidence_events
          (tenant_id, project_id, environment_id, event_id, trace_id, span_id, started_at, sequence, received_at, schema_version, evidence)
          VALUES ($1,$2,$3,$4,$5,$6,$7,0,$8,$9,$10::jsonb)`,
          [
            scope.tenantId,
            scope.projectId,
            scope.environmentId,
            event.evidence.eventId,
            event.evidence.traceId,
            event.evidence.spanId,
            event.evidence.startedAt,
            event.receivedAt,
            event.schemaVersion,
            JSON.stringify(event.evidence),
          ],
        );
      }
      await client.query(`SET LOCAL ROLE "${credentials.api.name}"`);
      const trace = first.evidence.traceId;
      await expect(
        listPostgresTraceEvidenceOnClient(client, scope, trace, { limit: 1 }),
      ).resolves.toEqual({ cursorFound: true, events: [first], hasMore: true });
      await expect(
        listPostgresTraceEvidenceOnClient(client, scope, trace, {
          limit: 1,
          after: {
            eventId: first.evidence.eventId,
            startedAt: first.evidence.startedAt,
            sequence: 0,
          },
        }),
      ).resolves.toEqual({ cursorFound: true, events: [second], hasMore: false });
      await expect(
        resolvePostgresExactEventsOnClient(client, scope, trace, [
          second.evidence.eventId,
          first.evidence.eventId,
        ]),
      ).resolves.toEqual([second, first]);
      for (const wrong of wrongScopes(scope)) {
        await expect(
          resolvePostgresExactEventsOnClient(client, wrong, trace, [first.evidence.eventId]),
        ).resolves.toBeNull();
      }
      await client.query("ROLLBACK TO SAVEPOINT trace_capture");
      await expect(
        resolvePostgresExactEventsOnClient(client, scope, trace, [first.evidence.eventId]),
      ).resolves.toBeNull();
      await expect(
        listPostgresTraceEvidenceOnClient(client, scope, trace, {
          limit: 1,
          after: {
            eventId: first.evidence.eventId,
            startedAt: first.evidence.startedAt,
            sequence: 0,
          },
        }),
      ).resolves.toEqual({ cursorFound: false, events: [], hasMore: false });
    });
  });
});
