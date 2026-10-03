import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { ArtifactCipher, LocalArtifactKeyring } from "@proofstack/artifacts";
import { MemoryArtifactObjectStore } from "@proofstack/artifacts/testing";
import {
  type ArtifactMetadata,
  type ContentReference,
  type PolicyEvaluationRequestDefinition,
  PrincipalContextSchema,
} from "@proofstack/contracts";
import {
  digestPolicyEvaluationRequestDefinition,
  digestReleaseCandidateDefinition,
  releaseCandidateReference,
  releasePolicyReference,
} from "@proofstack/core";
import {
  MemoryEvidenceRepository,
  MemoryReleaseCandidateRepository,
  releaseCandidateFixture,
  releasePolicyFixtureScope,
  releasePolicyLifecycleFixture,
  releasePolicyRepositoryFixture,
} from "@proofstack/core/testing";
import {
  capturePolicyArtifactEvidence,
  type PolicyArtifactEvidenceRepositories,
  type PolicyEvaluationSourceRecheckPorts,
  type PolicyEvaluationSourceTransactions,
} from "@proofstack/policy-evaluation";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateDatabase } from "./migration-runner.js";
import { PostgresArtifactCatalogRepository } from "./postgres-artifact-catalog-repository.js";
import { PostgresPolicySourceTransactions } from "./postgres-policy-source-transactions.js";
import { PostgresReleasePolicyRepository } from "./postgres-release-policy-repository.js";
import { provisionRuntimeRoles, type RuntimeRoleProvisioningOptions } from "./runtime-roles.js";
import { withExactScopeTransaction } from "./tenant-transaction.js";

const databaseUrl = process.env["PROOFSTACK_TEST_DATABASE_URL"];
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
      name: `ps_recheck_${kind.toLowerCase()}_${runKey}`,
      password: `source-recheck-${kind}-${runKey}`,
    },
  ]),
) as unknown as RuntimeRoleProvisioningOptions;
const admin = new Pool({ connectionString: databaseUrl, max: 8 });
function runtime(kind: keyof RuntimeRoleProvisioningOptions) {
  const url = new URL(databaseUrl as string);
  url.username = credentials[kind].name;
  url.password = credentials[kind].password;
  return new Pool({ connectionString: url.toString(), max: 4 });
}
const api = runtime("api");
const maintainer = runtime("artifact");
const author = runtime("policyAuthor");
const catalog = new PostgresArtifactCatalogRepository(api);
const maintenance = new PostgresArtifactCatalogRepository(maintainer);
const policies = new PostgresReleasePolicyRepository(author);
const observedPools: Pool[] = [];
beforeAll(async () => {
  await migrateDatabase(admin);
  await provisionRuntimeRoles(admin, credentials);
});
afterAll(async () => {
  await Promise.all([
    api.end(),
    maintainer.end(),
    author.end(),
    ...observedPools.map((pool) => pool.end()),
  ]);
  for (const { name } of Object.values(credentials)) {
    await admin.query(`DROP OWNED BY "${name}"`);
    await admin.query(`DROP ROLE "${name}"`);
  }
  await admin.end();
});

async function fixture() {
  const namespace = `recheck_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const scope = releasePolicyFixtureScope(namespace);
  const applicationName = `proofstack_${namespace}`;
  const observer = new Pool({
    connectionString: databaseUrl,
    max: 1,
    application_name: applicationName,
  });
  observedPools.push(observer);
  // Prove that the adapter overrides the pool's isolation default without changing that default.
  await observer.query("SET default_transaction_isolation = 'repeatable read'");
  const transactions = new PostgresPolicySourceTransactions(observer);
  const contents = Buffer.from("actual guarded policy source bytes");
  const reference: ContentReference = {
    artifactId: "artifact_recheck",
    mediaType: "text/plain",
    classification: "confidential",
    sizeBytes: contents.byteLength,
    sha256: createHash("sha256").update(contents).digest("hex"),
  };
  const metadata: ArtifactMetadata = {
    schemaVersion: "0.1",
    scope,
    contentReference: reference,
    createdAt: "2026-09-04T00:00:00.000Z",
    state: "reserved",
    retention: { mode: "retain" },
    redaction: { status: "not_required" },
  };
  const encryption = new ArtifactCipher(
    new LocalArtifactKeyring({
      activeKeyId: "key_database_capture",
      keys: { key_database_capture: new Uint8Array(32).fill(5) },
    }),
  );
  const objects = new MemoryArtifactObjectStore();
  const objectKey = `objects/${scope.tenantId}/source`;
  const plan = await encryption.createPlan(metadata);
  await catalog.reserve({
    metadata,
    encryption: plan,
    objectKey,
    createdByPrincipalId: "principal_writer",
  });
  const encrypted = await encryption.encrypt(metadata, plan, contents);
  await objects.putIfAbsent(objectKey, encrypted.bytes);
  await catalog.activate(
    scope,
    reference.artifactId,
    encrypted.receipt,
    "2026-09-04T00:01:00.000001Z",
  );
  const policy = releasePolicyRepositoryFixture(namespace, scope);
  await policies.publishReleasePolicy(policy);
  const candidate = releaseCandidateFixture(namespace, scope);
  const build = candidate.buildArtifacts[0];
  if (!build) throw new Error("Expected build artifact fixture");
  build.artifact = reference;
  const {
    createdAt: _at,
    createdByPrincipalId: _by,
    schemaVersion: _version,
    scope: _scope,
    definitionSha256: _hash,
    ...body
  } = candidate;
  candidate.definitionSha256 = digestReleaseCandidateDefinition(scope, body);
  const candidates = new MemoryReleaseCandidateRepository();
  await candidates.publishReleaseCandidate(candidate);
  // Only candidate and unavailable upstream ports are memory fixtures. The catalog, policy,
  // lifecycle, source guards, normalized rereads and competing writes below are real PostgreSQL.
  const absent = new Proxy({}, { get: () => async () => null });
  const repositories = {
    control: {
      comparison: absent,
      installationBinding: absent,
      releaseCandidate: candidates,
      releasePolicy: policies,
    },
    evidence: { evaluation: absent, modelAssurance: absent },
    datasets: absent,
    replayDefinitions: absent,
    replayResults: absent,
    runtimeDefinitions: absent,
  } as unknown as PolicyArtifactEvidenceRepositories;
  const vector = JSON.parse(
    readFileSync(
      new URL(
        "../../contracts/vectors/policy-evaluation-request-definition-v1.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as { vectors: { input: { definition: PolicyEvaluationRequestDefinition } }[] };
  const base = vector.vectors[0]?.input.definition;
  if (!base) throw new Error("Expected immutable request vector");
  const definition = {
    ...base,
    evaluationRequestId: `request_${namespace}`,
    evaluationTime: "2026-10-01T00:00:00.000Z",
    candidate: releaseCandidateReference(candidate),
    policy: releasePolicyReference(policy),
  };
  const request = {
    ...definition,
    scope,
    schemaVersion: "0.1" as const,
    createdAt: "2026-10-01T01:00:00.000Z",
    createdByPrincipalId: "principal_request",
    definitionSha256: digestPolicyEvaluationRequestDefinition(scope, definition),
  };
  const actor = PrincipalContextSchema.parse({
    authentication: { method: "development", authenticatedAt: "2026-09-01T00:00:00.000Z" },
    capabilities: ["artifact:read"],
    principalId: "principal_capture",
    principalType: "service",
    requestId: "request_capture",
    resourceScope: { mode: "tenant" },
    roles: ["viewer"],
    tenantId: scope.tenantId,
  });
  const hooks: {
    beforeRun?: () => Promise<void>;
    underGuards?: (ports: PolicyEvaluationSourceRecheckPorts) => Promise<void>;
    readContent?: () => Promise<void>;
  } = {};
  const sourceTransactions: PolicyEvaluationSourceTransactions = {
    run: async (exact, operation) => {
      await hooks.beforeRun?.();
      return transactions.run(exact, (ports) =>
        operation({
          ...ports,
          observationTime: async () => {
            await hooks.underGuards?.(ports);
            return ports.observationTime();
          },
        }),
      );
    },
  };
  let objectReads = 0;
  const run = () =>
    capturePolicyArtifactEvidence(request, actor, repositories, new MemoryEvidenceRepository(), {
      catalog,
      objects: {
        get: async (key) => {
          objectReads++;
          await hooks.readContent?.();
          return objects.get(key);
        },
      },
      encryption,
      clock: { now: () => new Date() },
      sourceTransactions,
    });
  const tombstone = () =>
    maintenance.tombstone(scope, {
      artifactId: reference.artifactId,
      tombstoneId: `tombstone_${namespace}`,
      actorPrincipalId: "principal_maintenance",
      trigger: "manual",
      reason: "Exercise source recheck serialization",
      occurredAt: "2026-10-01T02:00:00.000Z",
    });
  const cleanContext = async () => {
    const result = await observer.query(
      "SELECT NULLIF(current_setting('proofstack.tenant_id', true), '') AS tenant, NULLIF(current_setting('proofstack.project_id', true), '') AS project, NULLIF(current_setting('proofstack.environment_id', true), '') AS environment, current_setting('transaction_isolation') AS isolation",
    );
    expect(result.rows).toEqual([
      { tenant: null, project: null, environment: null, isolation: "repeatable read" },
    ]);
  };
  const waitForWriter = () =>
    expect
      .poll(
        async () => {
          const result = await admin.query<{ count: number }>(
            "SELECT count(*)::int AS count FROM pg_stat_activity AS writer JOIN pg_stat_activity AS observer ON observer.pid = ANY(pg_blocking_pids(writer.pid)) WHERE observer.application_name = $1 AND writer.wait_event = 'advisory'",
            [applicationName],
          );
          return result.rows[0]?.count;
        },
        { timeout: 5_000, interval: 20 },
      )
      .toBeGreaterThan(0);
  return {
    namespace,
    scope,
    policy,
    reference,
    metadata,
    encryption,
    hooks,
    run,
    observer,
    transactions,
    tombstone,
    cleanContext,
    waitForWriter,
    objectReads: () => objectReads,
  };
}

describe("request-owned source recheck on actual PostgreSQL", () => {
  it("rechecks real normalized sources under one READ COMMITTED connection with no guard during content I/O", async () => {
    const f = await fixture();
    f.hooks.readContent = () =>
      withExactScopeTransaction(admin, f.scope, async (client) => {
        await client.query("SET LOCAL statement_timeout = '1000ms'");
        // The matching exclusive lock would time out if the capture held a source guard here.
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended(jsonb_build_array('proofstack.policy-evaluation-source.v1', $1::text, 'artifact', $2::text)::text, 0))",
          [f.scope.tenantId, f.reference.artifactId],
        );
      });
    const output = await f.run();
    if (output.status !== "artifacts_captured") throw new Error("Expected acquired observations");
    expect(output.sourceRecheck).toMatchObject({
      status: "observations_rechecked",
      guards: output.sourceGuards.length,
      policyReads: 1,
    });
    expect(output.sourceRecheck?.observedAt).toMatch(/\.\d{6}Z$/);
    expect(
      output.artifacts.find(({ read }) => read.reference.artifactId === f.reference.artifactId)
        ?.read.observation.status,
    ).toBe("verified");
    expect(f.objectReads()).toBe(1);
    expect(output).not.toHaveProperty("sealed");
    await f.cleanContext();
  });

  for (const kind of ["artifact", "policy"] as const)
    it(`blocks actual ${kind} writes through reinspection, then releases the observation guards`, async () => {
      const f = await fixture();
      let pending: Promise<{ value: unknown } | { error: unknown }> | undefined;
      const event = releasePolicyLifecycleFixture(f.namespace, f.policy, {
        occurredAt: "2026-10-01T02:00:00.000Z",
      });
      f.hooks.underGuards = async (ports) => {
        pending = (
          kind === "artifact" ? f.tombstone() : policies.publishReleasePolicyLifecycleEvent(event)
        ).then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
        await f.waitForWriter();
        if (kind === "artifact")
          expect(await ports.findArtifact(f.reference.artifactId)).toMatchObject({
            metadata: { state: "available" },
          });
        else expect(await ports.listPolicyHistory(f.policy.policyVersionId)).toEqual([]);
      };
      try {
        const output = await f.run();
        expect(output.status).toBe("artifacts_captured");
        const result = await pending;
        if (result && "error" in result) throw result.error;
        if (kind === "artifact")
          expect((await catalog.find(f.scope, f.reference.artifactId))?.metadata.state).toBe(
            "tombstoned",
          );
        else
          expect(
            await policies.listReleasePolicyLifecycleEvents(f.scope, f.policy.policyVersionId),
          ).toEqual([event]);
        await f.cleanContext();
      } finally {
        await pending;
      }
    });

  it.each(["artifact", "policy"])(
    "rejects a %s change between capture and guard acquisition",
    async (kind) => {
      const f = await fixture();
      f.hooks.beforeRun = async () => {
        if (kind === "artifact") await f.tombstone();
        else
          await policies.publishReleasePolicyLifecycleEvent(
            releasePolicyLifecycleFixture(f.namespace, f.policy),
          );
      };
      await expect(f.run()).rejects.toMatchObject({ reason: "source_revision_changed" });
      await f.cleanContext();
    },
  );

  it("includes known absent coordinates and rejects their creation before final reinspection", async () => {
    const f = await fixture();
    const baseline = await f.run();
    if (baseline.status !== "artifacts_captured") throw new Error("Expected artifact observations");
    const absent = baseline.artifacts.find(({ read }) => read.observation.status === "missing")
      ?.read.reference;
    if (!absent) throw new Error("Expected known missing artifact");
    expect(
      baseline.sourceGuards.some(({ kind, id }) => kind === "artifact" && id === absent.artifactId),
    ).toBe(true);
    f.hooks.beforeRun = async () => {
      const metadata = { ...f.metadata, contentReference: absent };
      await catalog.reserve({
        metadata,
        encryption: await f.encryption.createPlan(metadata),
        objectKey: `objects/${f.scope.tenantId}/missing`,
        createdByPrincipalId: "principal_writer",
      });
    };
    await expect(f.run()).rejects.toMatchObject({ reason: "source_revision_changed" });
    await f.cleanContext();
  });

  it("rolls back a real later guard conflict and releases earlier guards without authoritative reads", async () => {
    const f = await fixture();
    const baseline = await f.run();
    if (baseline.status !== "artifacts_captured") throw new Error("Expected guard plan");
    const first = baseline.sourceGuards[0];
    if (!first || first.kind !== "artifact") throw new Error("Expected first artifact coordinate");
    const writer = await admin.connect();
    try {
      await writer.query("BEGIN");
      await writer.query(
        "SELECT pg_advisory_xact_lock(hashtextextended(jsonb_build_array('proofstack.policy-evaluation-source.v1', $1::text, 'release_policy', $2::text)::text, 0))",
        [f.scope.tenantId, f.policy.policyVersionId],
      );
      await expect(f.run()).rejects.toMatchObject({ reason: "guard_unavailable" });
      await withExactScopeTransaction(admin, f.scope, async (client) => {
        // Earlier shared guards must have rolled back, even though the later writer still owns its lock.
        expect(
          (
            await client.query<{ acquired: boolean }>(
              "SELECT pg_try_advisory_xact_lock(hashtextextended(jsonb_build_array('proofstack.policy-evaluation-source.v1', $1::text, 'artifact', $2::text)::text, 0)) AS acquired",
              [f.scope.tenantId, first.id],
            )
          ).rows[0]?.acquired,
        ).toBe(true);
      });
      await f.cleanContext();
    } finally {
      await writer.query("ROLLBACK");
      writer.release();
    }
  });

  it("denies existing API runtime credentials instead of granting a new seal or guard authority", async () => {
    const f = await fixture();
    await expect(
      new PostgresPolicySourceTransactions(api).run(f.scope, (ports) =>
        ports.tryGuard("artifact", f.reference.artifactId),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    const context = await api.query(
      "SELECT NULLIF(current_setting('proofstack.tenant_id', true), '') AS tenant",
    );
    expect(context.rows).toEqual([{ tenant: null }]);
  });
});
