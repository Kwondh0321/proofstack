import {
  EVIDENCE_SCHEMA_VERSION,
  type EvidenceEnvelope,
  type EvidenceScope,
  type PrincipalContext,
  PrincipalContextSchema,
  type PublishRegressionFixtureVersionRequest,
  type RegressionFixtureVersion,
  RegressionFixtureVersionDefinitionSchema,
  RegressionFixtureVersionSchema,
} from "@proofstack/contracts";
import { type Clock, type EvidenceRepository, ForbiddenError } from "@proofstack/core";
import { describe, expect, it, vi } from "vitest";
import {
  InvalidRegressionVersionInputError,
  RegressionRepositoryContractError,
  RegressionVersionConflictError,
  RegressionVersionLineageError,
} from "./errors.js";
import {
  PublishRegressionFixtureVersion,
  type PublishRegressionFixtureVersionCommand,
} from "./publish-regression-fixture-version.js";
import { digestRegressionFixtureVersionDefinition } from "./regression-definition-digest.js";
import { projectRegressionFixtureVersionDefinition } from "./regression-version-definition.js";
import type { RegressionVersionRepository } from "./regression-version-repository.js";

const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const OTHER_TRACE_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const CREATED_AT = "2026-08-29T00:00:00.000Z";
const SCOPE: EvidenceScope = {
  environmentId: "env_production",
  projectId: "prj_checkout_agent",
  tenantId: "ten_acme",
};

function principal(overrides: Partial<PrincipalContext> = {}): PrincipalContext {
  return PrincipalContextSchema.parse({
    authentication: {
      authenticatedAt: "2026-08-28T23:00:00.000Z",
      method: "development",
    },
    capabilities: ["dataset:manage", "evidence:read"],
    principalId: "usr_operator",
    principalType: "user",
    requestId: "req_publish_fixture_001",
    resourceScope: { mode: "tenant" },
    roles: ["owner"],
    tenantId: SCOPE.tenantId,
    ...overrides,
  });
}

function request(
  overrides: Partial<PublishRegressionFixtureVersionRequest> = {},
): PublishRegressionFixtureVersionRequest {
  return {
    description: "Checkout timeout incident",
    fixtureVersionId: "fixv_checkout_timeout_001",
    name: "Checkout timeout",
    source: { kind: "trace_snapshot", traceId: TRACE_ID },
    ...overrides,
  };
}

function command(
  overrides: Partial<PublishRegressionFixtureVersionCommand> = {},
): PublishRegressionFixtureVersionCommand {
  return {
    environmentId: SCOPE.environmentId,
    fixtureId: "fix_checkout_timeout",
    principal: principal(),
    projectId: SCOPE.projectId,
    request: request(),
    ...overrides,
  };
}

function envelope(
  eventId: string,
  overrides: Partial<EvidenceEnvelope["evidence"]> = {},
): EvidenceEnvelope {
  return {
    evidence: {
      attributes: {},
      contentReferences: [],
      eventId,
      extensions: {},
      kind: "agent.run",
      name: "checkout-agent",
      source: {
        sdkName: "@proofstack/testkit",
        sdkVersion: "0.0.0",
        serviceName: "checkout-agent",
      },
      spanId: "00f067aa0ba902b7",
      startedAt: "2026-08-28T23:59:59.000Z",
      status: "ok",
      traceId: TRACE_ID,
      ...overrides,
    },
    receivedAt: CREATED_AT,
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    scope: SCOPE,
  };
}

interface FixtureVersionOptions {
  readonly capturedAt?: string;
  readonly createdAt?: string;
  readonly createdByPrincipalId?: string;
  readonly description?: string;
  readonly eventIds?: readonly string[];
  readonly fixtureId?: string;
  readonly fixtureVersionId?: string;
  readonly name?: string;
  readonly predecessor?: RegressionFixtureVersion["predecessor"];
  readonly scope?: EvidenceScope;
  readonly traceId?: string;
}

function fixtureVersion(options: FixtureVersionOptions = {}): RegressionFixtureVersion {
  const eventIds = options.eventIds ?? ["evt_checkout_a", "evt_checkout_b"];
  const definition = RegressionFixtureVersionDefinitionSchema.parse({
    ...(options.description === undefined
      ? { description: "Checkout timeout incident" }
      : { description: options.description }),
    fixtureId: options.fixtureId ?? "fix_checkout_timeout",
    fixtureVersionId: options.fixtureVersionId ?? "fixv_checkout_timeout_001",
    name: options.name ?? "Checkout timeout",
    ...(options.predecessor ? { predecessor: options.predecessor } : {}),
    replayability: "evidence_only",
    schemaVersion: "0.1",
    scope: options.scope ?? SCOPE,
    source: {
      eventIds,
      kind: "trace_snapshot",
      observedEventCount: eventIds.length,
      sourceCompleteness: "observed_snapshot",
      traceId: options.traceId ?? TRACE_ID,
    },
  });
  return RegressionFixtureVersionSchema.parse({
    ...definition,
    createdAt: options.createdAt ?? CREATED_AT,
    createdByPrincipalId: options.createdByPrincipalId ?? "usr_original",
    definitionSha256: digestRegressionFixtureVersionDefinition(definition),
    source: { ...definition.source, capturedAt: options.capturedAt ?? CREATED_AT },
  });
}

interface Harness {
  readonly clockNow: ReturnType<typeof vi.fn<Clock["now"]>>;
  readonly evidenceList: ReturnType<typeof vi.fn<EvidenceRepository["listByTrace"]>>;
  readonly fixtureExists: ReturnType<
    typeof vi.fn<RegressionVersionRepository["fixtureResourceExists"]>
  >;
  readonly findFixture: ReturnType<typeof vi.fn<RegressionVersionRepository["findFixtureVersion"]>>;
  readonly publishFixture: ReturnType<
    typeof vi.fn<RegressionVersionRepository["publishFixtureVersion"]>
  >;
  readonly service: PublishRegressionFixtureVersion;
}

function harness(
  events: readonly EvidenceEnvelope[] = [envelope("evt_checkout_a"), envelope("evt_checkout_b")],
): Harness {
  const clockNow = vi.fn<Clock["now"]>().mockReturnValue(new Date(CREATED_AT));
  const evidenceList = vi
    .fn<EvidenceRepository["listByTrace"]>()
    .mockResolvedValue({ cursorFound: true, events, hasMore: false });
  const findFixture = vi
    .fn<RegressionVersionRepository["findFixtureVersion"]>()
    .mockResolvedValue(null);
  const fixtureExists = vi
    .fn<RegressionVersionRepository["fixtureResourceExists"]>()
    .mockResolvedValue(false);
  const publishFixture = vi
    .fn<RegressionVersionRepository["publishFixtureVersion"]>()
    .mockImplementation((version) => Promise.resolve({ created: true, version }));
  const versionRepository: RegressionVersionRepository = {
    datasetResourceExists: vi.fn().mockResolvedValue(false),
    findDatasetVersion: vi.fn().mockResolvedValue(null),
    findFixtureVersion: findFixture,
    fixtureResourceExists: fixtureExists,
    publishDatasetVersion: vi.fn(),
    publishFixtureVersion: publishFixture,
    resolveFixtureVersionReferences: vi.fn().mockResolvedValue(null),
  };
  const evidenceRepository: EvidenceRepository = {
    append: vi.fn(),
    listByTrace: evidenceList,
  };
  return {
    clockNow,
    evidenceList,
    fixtureExists,
    findFixture,
    publishFixture,
    service: new PublishRegressionFixtureVersion({
      clock: { now: clockNow },
      evidenceRepository,
      versionRepository,
    }),
  };
}

describe("PublishRegressionFixtureVersion authorization and validation", () => {
  it("requires dataset management before evidence read and any dependency access", async () => {
    const value = harness();

    await expect(
      value.service.execute(command({ principal: principal({ capabilities: ["evidence:read"] }) })),
    ).rejects.toMatchObject({
      code: "forbidden",
      message: "Missing required capability: dataset:manage",
    });
    expect(value.findFixture).not.toHaveBeenCalled();
    expect(value.evidenceList).not.toHaveBeenCalled();
    expect(value.clockNow).not.toHaveBeenCalled();
  });

  it("requires evidence read after dataset management", async () => {
    const value = harness();

    await expect(
      value.service.execute(
        command({ principal: principal({ capabilities: ["dataset:manage"] }) }),
      ),
    ).rejects.toMatchObject({
      code: "forbidden",
      message: "Missing required capability: evidence:read",
    });
    expect(value.findFixture).not.toHaveBeenCalled();
  });

  it.each([
    {
      resourceScope: {
        mode: "restricted" as const,
        projects: [{ projectId: "prj_other" }],
      },
    },
    {
      resourceScope: {
        mode: "restricted" as const,
        projects: [{ environmentIds: ["env_other"], projectId: SCOPE.projectId }],
      },
    },
  ])("authorizes the exact environment before validating attacker input %#", async (override) => {
    const value = harness();
    const invalidRequest = { ...request(), unexpected: true } as never;

    await expect(
      value.service.execute(command({ principal: principal(override), request: invalidRequest })),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(value.findFixture).not.toHaveBeenCalled();
  });

  it("uses one immutable principal and route snapshot for authorization and repository scope", async () => {
    const value = harness();
    const allowedPrincipal = principal({
      resourceScope: {
        mode: "restricted",
        projects: [{ environmentIds: [SCOPE.environmentId], projectId: SCOPE.projectId }],
      },
    });
    const otherTenantPrincipal = principal({ tenantId: "ten_other" });
    let environmentReads = 0;
    let principalReads = 0;
    let projectReads = 0;
    const input = {
      get environmentId() {
        environmentReads += 1;
        return environmentReads === 1 ? SCOPE.environmentId : "env_other";
      },
      fixtureId: "fix_checkout_timeout",
      get principal() {
        principalReads += 1;
        return principalReads <= 3 ? allowedPrincipal : otherTenantPrincipal;
      },
      get projectId() {
        projectReads += 1;
        return projectReads === 1 ? SCOPE.projectId : "prj_other";
      },
      request: request(),
    } satisfies PublishRegressionFixtureVersionCommand;
    value.findFixture.mockImplementation(async (repositoryScope) => {
      expect(repositoryScope).toEqual(SCOPE);
      return null;
    });

    const result = await value.service.execute(input);

    expect(result.version.scope).toEqual(SCOPE);
    expect([principalReads, projectReads, environmentReads]).toEqual([1, 1, 1]);
  });

  it.each([
    {
      expected: "Regression fixture publication scope is invalid",
      override: { environmentId: "x" },
    },
    {
      expected: "Regression fixture publication route is invalid",
      override: { fixtureId: "x" },
    },
    {
      expected: "Regression fixture publication request is invalid",
      override: { request: { ...request(), unexpected: true } as never },
    },
  ])(
    "rejects strict invalid input before repository access: $expected",
    async ({ expected, override }) => {
      const value = harness();

      await expect(value.service.execute(command(override))).rejects.toMatchObject({
        code: "regression_version_input_invalid",
        message: expected,
      });
      expect(value.findFixture).not.toHaveBeenCalled();
    },
  );
});

describe("PublishRegressionFixtureVersion root publication", () => {
  it("publishes one bounded ordered snapshot with server provenance and one clock reading", async () => {
    const calls: string[] = [];
    const value = harness();
    value.findFixture.mockImplementation(async () => {
      calls.push("find-target");
      return null;
    });
    value.fixtureExists.mockImplementation(async () => {
      calls.push("find-root");
      return false;
    });
    value.evidenceList.mockImplementation(async () => {
      calls.push("snapshot");
      return {
        cursorFound: true,
        events: [envelope("evt_checkout_a"), envelope("evt_checkout_b")],
        hasMore: false,
      };
    });
    value.clockNow.mockImplementation(() => {
      calls.push("clock");
      return new Date(CREATED_AT);
    });
    value.publishFixture.mockImplementation(async (version) => {
      calls.push("publish");
      return { created: true, version };
    });

    const result = await value.service.execute(command());

    expect(calls).toEqual(["find-target", "find-root", "snapshot", "clock", "publish"]);
    expect(value.clockNow).toHaveBeenCalledTimes(1);
    expect(value.evidenceList).toHaveBeenCalledWith(SCOPE, TRACE_ID, { limit: 1_000 });
    expect(result).toEqual({
      created: true,
      version: expect.objectContaining({
        createdAt: CREATED_AT,
        createdByPrincipalId: "usr_operator",
        description: "Checkout timeout incident",
        fixtureId: "fix_checkout_timeout",
        fixtureVersionId: "fixv_checkout_timeout_001",
        replayability: "evidence_only",
        schemaVersion: "0.1",
        scope: SCOPE,
        source: {
          capturedAt: CREATED_AT,
          eventIds: ["evt_checkout_a", "evt_checkout_b"],
          kind: "trace_snapshot",
          observedEventCount: 2,
          sourceCompleteness: "observed_snapshot",
          traceId: TRACE_ID,
        },
      }),
    });
    expect(result.version.definitionSha256).toBe(
      digestRegressionFixtureVersionDefinition(
        projectRegressionFixtureVersionDefinition(result.version),
      ),
    );
  });

  it("omits an absent optional description from the immutable version", async () => {
    const value = harness();
    const input = request();
    const { description: _description, ...withoutDescription } = input;

    const result = await value.service.execute(command({ request: withoutDescription }));

    expect(result.version).not.toHaveProperty("description");
  });

  it("retains authoritative local values when adapters mutate their detached inputs", async () => {
    const value = harness();
    value.findFixture.mockImplementation(async (scope) => {
      (scope as { projectId: string }).projectId = "prj_mutated_find";
      return null;
    });
    value.fixtureExists.mockImplementation(async (scope) => {
      (scope as { environmentId: string }).environmentId = "env_mutated_exists";
      return false;
    });
    value.publishFixture.mockImplementation(async (version) => {
      const original = structuredClone(version);
      (version as { createdByPrincipalId: string }).createdByPrincipalId = "usr_mutated_adapter";
      return { created: true, version: original };
    });

    const result = await value.service.execute(command());

    expect(result.version.scope).toEqual(SCOPE);
    expect(result.version.createdByPrincipalId).toBe("usr_operator");
    expect(value.evidenceList).toHaveBeenCalledWith(SCOPE, TRACE_ID, { limit: 1_000 });
  });

  it("snapshots command identity and semantics before the first asynchronous boundary", async () => {
    const value = harness();
    const input = command();
    value.findFixture.mockImplementation(async () => {
      const mutable = input as unknown as {
        fixtureId: string;
        principal: { principalId: string };
        request: { name: string; source: { traceId: string } };
      };
      mutable.fixtureId = "fix_mutated_command";
      mutable.principal.principalId = "usr_mutated_command";
      mutable.request.name = "Mutated command";
      mutable.request.source.traceId = OTHER_TRACE_ID;
      return null;
    });

    const result = await value.service.execute(input);

    expect(result.version.fixtureId).toBe("fix_checkout_timeout");
    expect(result.version.createdByPrincipalId).toBe("usr_operator");
    expect(result.version.name).toBe("Checkout timeout");
    expect(result.version.source.traceId).toBe(TRACE_ID);
  });

  it("rejects a second root before snapshot or clock access", async () => {
    const value = harness();
    value.fixtureExists.mockResolvedValue(true);

    await expect(value.service.execute(command())).rejects.toBeInstanceOf(
      RegressionVersionLineageError,
    );
    expect(value.evidenceList).not.toHaveBeenCalled();
    expect(value.clockNow).not.toHaveBeenCalled();
    expect(value.publishFixture).not.toHaveBeenCalled();
  });

  it.each([undefined, "false", 0])(
    "fails closed when root existence is not exactly boolean: %s",
    async (result) => {
      const value = harness();
      value.fixtureExists.mockResolvedValue(result as never);

      await expect(value.service.execute(command())).rejects.toBeInstanceOf(
        RegressionRepositoryContractError,
      );
      expect(value.evidenceList).not.toHaveBeenCalled();
    },
  );

  it("maps an absent trace to TraceNotFoundError without reading the clock", async () => {
    const value = harness([]);

    await expect(value.service.execute(command())).rejects.toMatchObject({
      code: "trace_not_found",
      traceId: TRACE_ID,
    });
    expect(value.clockNow).not.toHaveBeenCalled();
    expect(value.publishFixture).not.toHaveBeenCalled();
  });

  it("rejects an oversized trace without leaking its identifier", async () => {
    const events = Array.from({ length: 1_000 }, (_, index) =>
      envelope(`evt_${index.toString().padStart(4, "0")}`),
    );
    const value = harness(events);
    value.evidenceList.mockResolvedValue({ cursorFound: true, events, hasMore: true });

    const rejection = value.service.execute(command());
    await expect(rejection).rejects.toBeInstanceOf(InvalidRegressionVersionInputError);
    await expect(rejection).rejects.not.toThrow(TRACE_ID);
    expect(value.clockNow).not.toHaveBeenCalled();
  });

  it("classifies invalid snapshot identifiers as an evidence repository contract violation", async () => {
    const value = harness([envelope("INVALID")]);

    await expect(value.service.execute(command())).rejects.toMatchObject({
      code: "evidence_repository_contract_violation",
      message: "The evidence repository returned an invalid trace event",
    });
    expect(value.clockNow).not.toHaveBeenCalled();
    expect(value.publishFixture).not.toHaveBeenCalled();
  });

  it("rejects invalid server provenance through the strict version contract", async () => {
    const value = harness();
    const invalidActor = { ...principal(), principalId: "x" } as PrincipalContext;

    await expect(value.service.execute(command({ principal: invalidActor }))).rejects.toMatchObject(
      {
        code: "regression_version_input_invalid",
        message: "Regression fixture publication principal is invalid",
      },
    );
    expect(value.findFixture).not.toHaveBeenCalled();
    expect(value.publishFixture).not.toHaveBeenCalled();
  });

  it("wraps an invalid clock without publishing", async () => {
    const value = harness();
    value.clockNow.mockReturnValue(new Date(Number.NaN));

    await expect(value.service.execute(command())).rejects.toMatchObject({
      cause: expect.any(RangeError),
      code: "regression_version_input_invalid",
      message: "Regression fixture publication clock is invalid",
    });
    expect(value.publishFixture).not.toHaveBeenCalled();
  });

  it("rejects a clock instant outside the published timestamp grammar", async () => {
    const value = harness();
    value.clockNow.mockReturnValue(new Date(253_402_300_800_000));

    await expect(value.service.execute(command())).rejects.toMatchObject({
      cause: expect.anything(),
      code: "regression_version_input_invalid",
      message: "Regression fixture publication clock is invalid",
    });
    expect(value.publishFixture).not.toHaveBeenCalled();
  });
});

describe("PublishRegressionFixtureVersion lineage", () => {
  it("binds a child to the authoritative predecessor digest", async () => {
    const predecessor = fixtureVersion({ fixtureVersionId: "fixv_checkout_timeout_000" });
    const value = harness();
    value.findFixture.mockResolvedValueOnce(null).mockResolvedValueOnce(predecessor);

    const result = await value.service.execute(
      command({ request: request({ predecessorVersionId: predecessor.fixtureVersionId }) }),
    );

    expect(value.findFixture).toHaveBeenNthCalledWith(1, SCOPE, "fixv_checkout_timeout_001");
    expect(value.findFixture).toHaveBeenNthCalledWith(2, SCOPE, "fixv_checkout_timeout_000");
    expect(value.fixtureExists).not.toHaveBeenCalled();
    expect(result.version.predecessor).toEqual({
      definitionSha256: predecessor.definitionSha256,
      fixtureVersionId: predecessor.fixtureVersionId,
    });
  });

  it("rejects a missing predecessor before snapshot capture", async () => {
    const value = harness();

    await expect(
      value.service.execute(
        command({ request: request({ predecessorVersionId: "fixv_missing_000" }) }),
      ),
    ).rejects.toBeInstanceOf(RegressionVersionLineageError);
    expect(value.evidenceList).not.toHaveBeenCalled();
  });

  it("rejects a predecessor from another logical fixture", async () => {
    const predecessor = fixtureVersion({
      fixtureId: "fix_other",
      fixtureVersionId: "fixv_other_000",
    });
    const value = harness();
    value.findFixture.mockResolvedValueOnce(null).mockResolvedValueOnce(predecessor);

    await expect(
      value.service.execute(
        command({ request: request({ predecessorVersionId: predecessor.fixtureVersionId }) }),
      ),
    ).rejects.toBeInstanceOf(RegressionVersionLineageError);
    expect(value.evidenceList).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "malformed",
      predecessor: {
        ...fixtureVersion({ fixtureVersionId: "fixv_expected_000" }),
        unexpected: true,
      },
    },
    {
      label: "wrong identifier",
      predecessor: fixtureVersion({ fixtureVersionId: "fixv_other_000" }),
    },
    {
      label: "wrong tenant",
      predecessor: fixtureVersion({
        fixtureVersionId: "fixv_expected_000",
        scope: { ...SCOPE, tenantId: "ten_other" },
      }),
    },
    {
      label: "wrong project",
      predecessor: fixtureVersion({
        fixtureVersionId: "fixv_expected_000",
        scope: { ...SCOPE, projectId: "prj_other" },
      }),
    },
    {
      label: "wrong environment",
      predecessor: fixtureVersion({
        fixtureVersionId: "fixv_expected_000",
        scope: { ...SCOPE, environmentId: "env_other" },
      }),
    },
  ])("fails closed for a $label predecessor repository result", async ({ predecessor }) => {
    const value = harness();
    value.findFixture.mockResolvedValueOnce(null).mockResolvedValueOnce(predecessor as never);

    await expect(
      value.service.execute(
        command({ request: request({ predecessorVersionId: "fixv_expected_000" }) }),
      ),
    ).rejects.toBeInstanceOf(RegressionRepositoryContractError);
    expect(value.evidenceList).not.toHaveBeenCalled();
  });
});

describe("PublishRegressionFixtureVersion idempotent target handling", () => {
  it("revalidates an equivalent stored target without recapturing or replacing provenance", async () => {
    const stored = fixtureVersion({
      capturedAt: "2026-08-28T23:30:00.000Z",
      createdAt: "2026-08-28T23:31:00.000Z",
      createdByPrincipalId: "usr_original",
    });
    const value = harness();
    value.findFixture.mockResolvedValue(stored);
    value.publishFixture.mockResolvedValue({ created: false, version: stored });

    const result = await value.service.execute(command());

    expect(value.publishFixture).toHaveBeenCalledWith(stored);
    expect(result).toEqual({ created: false, version: stored });
    expect(value.fixtureExists).not.toHaveBeenCalled();
    expect(value.evidenceList).not.toHaveBeenCalled();
    expect(value.clockNow).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "logical fixture",
      route: { fixtureId: "fix_other" },
      stored: fixtureVersion(),
    },
    {
      label: "name",
      route: {},
      stored: fixtureVersion({ name: "Different name" }),
    },
    {
      label: "description",
      route: {},
      stored: fixtureVersion({ description: "Different description" }),
    },
    {
      label: "predecessor",
      route: {},
      stored: fixtureVersion({
        predecessor: {
          definitionSha256: "a".repeat(64),
          fixtureVersionId: "fixv_checkout_timeout_000",
        },
      }),
    },
    {
      label: "trace",
      route: {},
      stored: fixtureVersion({ traceId: OTHER_TRACE_ID }),
    },
  ])("rejects target reuse with a different $label before recapture", async ({ route, stored }) => {
    const value = harness();
    value.findFixture.mockResolvedValue(stored);

    await expect(value.service.execute(command(route))).rejects.toBeInstanceOf(
      RegressionVersionConflictError,
    );
    expect(value.publishFixture).not.toHaveBeenCalled();
    expect(value.evidenceList).not.toHaveBeenCalled();
    expect(value.clockNow).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "malformed schema",
      stored: { ...fixtureVersion(), unexpected: true },
    },
    {
      label: "mismatched self digest",
      stored: { ...fixtureVersion(), definitionSha256: "f".repeat(64) },
    },
    {
      label: "wrong returned identifier",
      stored: fixtureVersion({ fixtureVersionId: "fixv_other_001" }),
    },
    {
      label: "wrong returned scope",
      stored: fixtureVersion({ scope: { ...SCOPE, projectId: "prj_other" } }),
    },
  ])("fails closed for a $label target repository result", async ({ stored }) => {
    const value = harness();
    value.findFixture.mockResolvedValue(stored as never);

    await expect(value.service.execute(command())).rejects.toBeInstanceOf(
      RegressionRepositoryContractError,
    );
    expect(value.publishFixture).not.toHaveBeenCalled();
  });

  it("requires retry publication to report created false", async () => {
    const stored = fixtureVersion();
    const value = harness();
    value.findFixture.mockResolvedValue(stored);
    value.publishFixture.mockResolvedValue({ created: true, version: stored });

    await expect(value.service.execute(command())).rejects.toBeInstanceOf(
      RegressionRepositoryContractError,
    );
  });

  it("requires retry publication to return the exact original provenance", async () => {
    const stored = fixtureVersion();
    const changed = fixtureVersion({ createdByPrincipalId: "usr_changed" });
    const value = harness();
    value.findFixture.mockResolvedValue(stored);
    value.publishFixture.mockResolvedValue({ created: false, version: changed });

    await expect(value.service.execute(command())).rejects.toBeInstanceOf(
      RegressionRepositoryContractError,
    );
  });
});

describe("PublishRegressionFixtureVersion repository result validation", () => {
  it.each([
    { label: "null", result: null },
    { label: "primitive", result: "invalid" },
    { label: "extra field", result: { created: true, extra: true, version: fixtureVersion() } },
    { label: "missing created", result: { version: fixtureVersion() } },
    { label: "missing version", result: { created: true, other: fixtureVersion() } },
    { label: "non-boolean created", result: { created: "true", version: fixtureVersion() } },
    { label: "malformed version", result: { created: true, version: {} } },
    {
      label: "wrong version scope",
      result: {
        created: true,
        version: fixtureVersion({ scope: { ...SCOPE, environmentId: "env_other" } }),
      },
    },
  ])("rejects a $label publication result", async ({ result }) => {
    const value = harness();
    value.publishFixture.mockResolvedValue(result as never);

    await expect(value.service.execute(command())).rejects.toBeInstanceOf(
      RegressionRepositoryContractError,
    );
  });

  it("wraps a throwing result accessor as a contract violation", async () => {
    const value = harness();
    const result = Object.defineProperties(
      {},
      {
        created: {
          enumerable: true,
          get() {
            throw new Error("invalid result getter");
          },
        },
        version: { enumerable: true, value: fixtureVersion() },
      },
    );
    value.publishFixture.mockResolvedValue(result as never);

    await expect(value.service.execute(command())).rejects.toMatchObject({
      cause: expect.objectContaining({ message: "invalid result getter" }),
      code: "regression_repository_contract_violation",
    });
  });

  it("wraps a throwing result key inspection as a contract violation", async () => {
    const value = harness();
    const failure = new Error("invalid own keys");
    value.publishFixture.mockResolvedValue(
      new Proxy(
        {},
        {
          ownKeys() {
            throw failure;
          },
        },
      ) as never,
    );

    await expect(value.service.execute(command())).rejects.toMatchObject({
      cause: failure,
      code: "regression_repository_contract_violation",
    });
  });

  it("accepts a racing equivalent publication with its original provenance", async () => {
    const value = harness();
    value.publishFixture.mockImplementation(async (candidate) => ({
      created: false,
      version: fixtureVersion({
        capturedAt: "2026-08-28T23:40:00.000Z",
        createdAt: "2026-08-28T23:41:00.000Z",
        createdByPrincipalId: "usr_race_winner",
        ...(candidate.description === undefined ? {} : { description: candidate.description }),
        eventIds: candidate.source.eventIds,
        fixtureId: candidate.fixtureId,
        fixtureVersionId: candidate.fixtureVersionId,
        name: candidate.name,
        ...(candidate.predecessor === undefined ? {} : { predecessor: candidate.predecessor }),
        scope: candidate.scope,
        traceId: candidate.source.traceId,
      }),
    }));

    const result = await value.service.execute(command());

    expect(result.created).toBe(false);
    expect(result.version.createdByPrincipalId).toBe("usr_race_winner");
    expect(result.version.createdAt).toBe("2026-08-28T23:41:00.000Z");
  });

  it("rejects an equivalent created result that changes server provenance", async () => {
    const value = harness();
    value.publishFixture.mockImplementation(async (candidate) => ({
      created: true,
      version: { ...candidate, createdByPrincipalId: "usr_changed" },
    }));

    await expect(value.service.execute(command())).rejects.toBeInstanceOf(
      RegressionRepositoryContractError,
    );
  });

  it("rejects a semantically different racing publication", async () => {
    const value = harness();
    value.publishFixture.mockImplementation(async (candidate) => ({
      created: false,
      version: fixtureVersion({
        createdAt: candidate.createdAt,
        fixtureVersionId: candidate.fixtureVersionId,
        name: "Different semantics",
      }),
    }));

    await expect(value.service.execute(command())).rejects.toBeInstanceOf(
      RegressionRepositoryContractError,
    );
  });

  it.each(["find", "root", "evidence", "publish"])(
    "preserves a dependency failure from %s",
    async (boundary) => {
      const failure = new Error(`${boundary} unavailable`);
      const value = harness();
      if (boundary === "find") value.findFixture.mockRejectedValue(failure);
      if (boundary === "root") value.fixtureExists.mockRejectedValue(failure);
      if (boundary === "evidence") value.evidenceList.mockRejectedValue(failure);
      if (boundary === "publish") value.publishFixture.mockRejectedValue(failure);

      await expect(value.service.execute(command())).rejects.toBe(failure);
    },
  );
});
