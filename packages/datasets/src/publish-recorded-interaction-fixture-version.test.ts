import { readFileSync } from "node:fs";
import type {
  ArtifactOwnership,
  EvidenceScope,
  InteractionCaptureManifest,
  PrincipalContext,
  PublishInteractionFixtureVersionRequest,
  RecordedInteractionFixtureVersion,
  RecordedInteractionFixtureVersionDefinition,
  RegressionFixtureVersion,
} from "@proofstack/contracts";
import {
  PrincipalContextSchema,
  RecordedInteractionFixtureVersionDefinitionSchema,
  RecordedInteractionFixtureVersionSchema,
  RegressionFixtureVersionDefinitionSchema,
  RegressionFixtureVersionSchema,
} from "@proofstack/contracts";
import { type Clock, ForbiddenError } from "@proofstack/core";
import { describe, expect, it, vi } from "vitest";
import {
  RegressionArtifactBindingError,
  RegressionRepositoryContractError,
  RegressionVersionConflictError,
  RegressionVersionLineageError,
} from "./errors.js";
import { digestRecordedInteractionFixtureVersionDefinition } from "./interaction-fixture-definition-digest.js";
import {
  PublishRecordedInteractionFixtureVersion,
  type PublishRecordedInteractionFixtureVersionCommand,
} from "./publish-recorded-interaction-fixture-version.js";
import { digestRegressionFixtureVersionDefinition } from "./regression-definition-digest.js";
import type { InteractionFixtureVersionRepository } from "./regression-version-repository.js";

const CREATED_AT = "2026-08-29T04:00:00.000Z";
const CAPTURED_AT = "2026-08-29T03:30:00.000Z";
const FIXTURE_ID = "fix_checkout_failure";
const PREDECESSOR_VERSION_ID = "fxv_checkout_failure_evidence";
const TARGET_VERSION_ID = "fxv_checkout_failure_interactions";
const SCOPE: EvidenceScope = {
  environmentId: "env_production",
  projectId: "prj_checkout_agent",
  tenantId: "ten_acme",
};

const vectorDocument = JSON.parse(
  readFileSync(
    new URL("../vectors/interaction-fixture-definition-v2.json", import.meta.url),
    "utf8",
  ),
) as {
  readonly vectors: readonly {
    readonly input: RecordedInteractionFixtureVersionDefinition;
  }[];
};

function capture(): InteractionCaptureManifest {
  const value = vectorDocument.vectors[0]?.input.interactionCapture;
  if (!value) throw new Error("The recorded interaction fixture vector is missing");
  return structuredClone(value);
}

function principal(overrides: Partial<PrincipalContext> = {}): PrincipalContext {
  return PrincipalContextSchema.parse({
    authentication: {
      authenticatedAt: "2026-08-29T03:00:00.000Z",
      method: "development",
    },
    capabilities: ["dataset:manage"],
    principalId: "usr_dataset_manager",
    principalType: "user",
    requestId: "req_publish_interaction_fixture",
    resourceScope: { mode: "tenant" },
    roles: ["owner"],
    tenantId: SCOPE.tenantId,
    ...overrides,
  });
}

function request(
  overrides: Partial<PublishInteractionFixtureVersionRequest> = {},
): PublishInteractionFixtureVersionRequest {
  return {
    description: "Recorded checkout failure sequence",
    fixtureVersionId: TARGET_VERSION_ID,
    interactionCapture: capture(),
    name: "Checkout failure interactions",
    predecessorVersionId: PREDECESSOR_VERSION_ID,
    ...overrides,
  };
}

function command(
  overrides: Partial<PublishRecordedInteractionFixtureVersionCommand> = {},
): PublishRecordedInteractionFixtureVersionCommand {
  return {
    environmentId: SCOPE.environmentId,
    fixtureId: FIXTURE_ID,
    principal: principal(),
    projectId: SCOPE.projectId,
    request: request(),
    ...overrides,
  };
}

function evidenceVersion(
  overrides: Partial<RegressionFixtureVersion> = {},
): RegressionFixtureVersion {
  const {
    createdAt,
    createdByPrincipalId,
    definitionSha256,
    source: sourceOverride,
    ...definitionOverrides
  } = overrides;
  const sourceDefinition = {
    eventIds: sourceOverride?.eventIds ?? ["evt_checkout_failure"],
    kind: sourceOverride?.kind ?? ("trace_snapshot" as const),
    observedEventCount: sourceOverride?.observedEventCount ?? 1,
    sourceCompleteness: sourceOverride?.sourceCompleteness ?? ("observed_snapshot" as const),
    traceId: sourceOverride?.traceId ?? "4bf92f3577b34da6a3ce929d0e0e4736",
  };
  const definition = RegressionFixtureVersionDefinitionSchema.parse({
    description: "Observed checkout failure",
    fixtureId: FIXTURE_ID,
    fixtureVersionId: PREDECESSOR_VERSION_ID,
    name: "Checkout failure evidence",
    replayability: "evidence_only",
    schemaVersion: "0.1",
    scope: SCOPE,
    source: sourceDefinition,
    ...definitionOverrides,
  });
  return RegressionFixtureVersionSchema.parse({
    ...definition,
    createdAt: createdAt ?? CAPTURED_AT,
    createdByPrincipalId: createdByPrincipalId ?? "usr_incident_manager",
    definitionSha256: definitionSha256 ?? digestRegressionFixtureVersionDefinition(definition),
    source: {
      ...definition.source,
      capturedAt: sourceOverride?.capturedAt ?? CAPTURED_AT,
    },
  });
}

function recordedVersion(
  overrides: Partial<RecordedInteractionFixtureVersion> = {},
): RecordedInteractionFixtureVersion {
  const predecessor = evidenceVersion();
  const {
    createdAt,
    createdByPrincipalId,
    definitionSha256,
    source: sourceOverride,
    ...definitionOverrides
  } = overrides;
  const definition = RecordedInteractionFixtureVersionDefinitionSchema.parse({
    description: "Recorded checkout failure sequence",
    fixtureId: FIXTURE_ID,
    fixtureVersionId: TARGET_VERSION_ID,
    interactionCapture: capture(),
    name: "Checkout failure interactions",
    predecessor: {
      definitionSha256: predecessor.definitionSha256,
      fixtureVersionId: predecessor.fixtureVersionId,
    },
    replayability: "recorded_interactions",
    schemaVersion: "0.2",
    scope: SCOPE,
    ...definitionOverrides,
    source:
      sourceOverride === undefined
        ? {
            eventIds: predecessor.source.eventIds,
            kind: predecessor.source.kind,
            observedEventCount: predecessor.source.observedEventCount,
            sourceCompleteness: predecessor.source.sourceCompleteness,
            traceId: predecessor.source.traceId,
          }
        : {
            eventIds: sourceOverride.eventIds,
            kind: sourceOverride.kind,
            observedEventCount: sourceOverride.observedEventCount,
            sourceCompleteness: sourceOverride.sourceCompleteness,
            traceId: sourceOverride.traceId,
          },
  });
  return RecordedInteractionFixtureVersionSchema.parse({
    ...definition,
    createdAt: createdAt ?? CREATED_AT,
    createdByPrincipalId: createdByPrincipalId ?? "usr_dataset_manager",
    definitionSha256:
      definitionSha256 ?? digestRecordedInteractionFixtureVersionDefinition(definition),
    source: {
      ...definition.source,
      capturedAt: sourceOverride?.capturedAt ?? predecessor.source.capturedAt,
    },
  });
}

function ownerships(version: RecordedInteractionFixtureVersion): readonly ArtifactOwnership[] {
  return version.interactionCapture.artifacts.map(({ contentReference }) => ({
    artifactId: contentReference.artifactId,
    boundAt: version.createdAt,
    boundByPrincipalId: version.createdByPrincipalId,
    owner: {
      fixtureId: version.fixtureId,
      fixtureVersionId: version.fixtureVersionId,
      kind: "regression_fixture_version",
    },
    schemaVersion: "0.1",
    scope: version.scope,
  }));
}

function firstOwnership(items: readonly ArtifactOwnership[]): ArtifactOwnership {
  const first = items[0];
  if (!first) throw new Error("Expected at least one interaction artifact ownership");
  return first;
}

interface Harness {
  readonly clockNow: ReturnType<typeof vi.fn<Clock["now"]>>;
  readonly findEvidence: ReturnType<
    typeof vi.fn<InteractionFixtureVersionRepository["findFixtureVersion"]>
  >;
  readonly findRecorded: ReturnType<
    typeof vi.fn<InteractionFixtureVersionRepository["findRecordedInteractionFixtureVersion"]>
  >;
  readonly publishRecorded: ReturnType<
    typeof vi.fn<InteractionFixtureVersionRepository["publishRecordedInteractionFixtureVersion"]>
  >;
  readonly repository: InteractionFixtureVersionRepository;
  readonly service: PublishRecordedInteractionFixtureVersion;
}

function harness(): Harness {
  const clockNow = vi.fn<Clock["now"]>().mockReturnValue(new Date(CREATED_AT));
  const findRecorded = vi
    .fn<InteractionFixtureVersionRepository["findRecordedInteractionFixtureVersion"]>()
    .mockResolvedValue(null);
  const findEvidence = vi
    .fn<InteractionFixtureVersionRepository["findFixtureVersion"]>()
    .mockImplementation((_scope, fixtureVersionId) =>
      Promise.resolve(fixtureVersionId === PREDECESSOR_VERSION_ID ? evidenceVersion() : null),
    );
  const publishRecorded = vi
    .fn<InteractionFixtureVersionRepository["publishRecordedInteractionFixtureVersion"]>()
    .mockImplementation((version) =>
      Promise.resolve({ created: true, ownerships: ownerships(version), version }),
    );
  const repository: InteractionFixtureVersionRepository = {
    datasetResourceExists: vi.fn().mockResolvedValue(false),
    findDatasetVersion: vi.fn().mockResolvedValue(null),
    findFixtureVersion: findEvidence,
    findRecordedInteractionFixtureVersion: findRecorded,
    fixtureResourceExists: vi.fn().mockResolvedValue(true),
    publishDatasetVersion: vi.fn(),
    publishFixtureVersion: vi.fn(),
    publishRecordedInteractionFixtureVersion: publishRecorded,
    resolveFixtureVersionReferences: vi.fn().mockResolvedValue(null),
  };
  return {
    clockNow,
    findEvidence,
    findRecorded,
    publishRecorded,
    repository,
    service: new PublishRecordedInteractionFixtureVersion({
      clock: { now: clockNow },
      versionRepository: repository,
    }),
  };
}

describe("PublishRecordedInteractionFixtureVersion authorization and input", () => {
  it("requires only dataset management before any dependency access", async () => {
    const value = harness();

    await expect(
      value.service.execute(command({ principal: principal({ capabilities: [] }) })),
    ).rejects.toMatchObject({
      code: "forbidden",
      message: "Missing required capability: dataset:manage",
    });
    expect(value.findRecorded).not.toHaveBeenCalled();
    expect(value.findEvidence).not.toHaveBeenCalled();
    expect(value.clockNow).not.toHaveBeenCalled();
  });

  it("does not require evidence or artifact plaintext authority", async () => {
    const value = harness();

    await expect(value.service.execute(command())).resolves.toMatchObject({ created: true });
    expect(command().principal.capabilities).toEqual(["dataset:manage"]);
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
  ])("authorizes the exact scope before validating attacker input %#", async (override) => {
    const value = harness();
    const invalidRequest = { ...request(), unexpected: true } as never;

    await expect(
      value.service.execute(command({ principal: principal(override), request: invalidRequest })),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(value.findRecorded).not.toHaveBeenCalled();
  });

  it.each([
    {
      expected: "Recorded interaction fixture publication principal is invalid",
      override: { principal: { ...principal(), unexpected: true } as never },
    },
    {
      expected: "Recorded interaction fixture publication scope is invalid",
      override: { environmentId: "x" },
    },
    {
      expected: "Recorded interaction fixture publication route is invalid",
      override: { fixtureId: "x" },
    },
    {
      expected: "Recorded interaction fixture publication request is invalid",
      override: { request: { ...request(), unexpected: true } as never },
    },
  ])("rejects strict invalid input: $expected", async ({ expected, override }) => {
    const value = harness();

    await expect(value.service.execute(command(override))).rejects.toMatchObject({
      code: "regression_version_input_invalid",
      message: expected,
    });
    expect(value.findRecorded).not.toHaveBeenCalled();
  });

  it("snapshots identity, route, and request values before repository access", async () => {
    const value = harness();
    const input = command();
    value.findRecorded.mockImplementation(async () => {
      const mutable = input as unknown as {
        fixtureId: string;
        principal: { principalId: string };
        request: { name: string };
      };
      mutable.fixtureId = "fix_mutated";
      mutable.principal.principalId = "usr_mutated";
      mutable.request.name = "Mutated name";
      return null;
    });

    const result = await value.service.execute(input);

    expect(result.version.fixtureId).toBe(FIXTURE_ID);
    expect(result.version.createdByPrincipalId).toBe("usr_dataset_manager");
    expect(result.version.name).toBe("Checkout failure interactions");
  });
});

describe("PublishRecordedInteractionFixtureVersion new publication", () => {
  it("publishes one exact successor with copied evidence provenance and ownerships", async () => {
    const calls: string[] = [];
    const value = harness();
    value.findRecorded.mockImplementation(async () => {
      calls.push("find-recorded-target");
      return null;
    });
    value.findEvidence.mockImplementation(async (_scope, versionId) => {
      calls.push(versionId === TARGET_VERSION_ID ? "find-evidence-target" : "find-predecessor");
      return versionId === PREDECESSOR_VERSION_ID ? evidenceVersion() : null;
    });
    value.clockNow.mockImplementation(() => {
      calls.push("clock");
      return new Date(CREATED_AT);
    });
    value.publishRecorded.mockImplementation(async (version) => {
      calls.push("publish");
      return { created: true, ownerships: ownerships(version), version };
    });

    const result = await value.service.execute(command());
    const predecessor = evidenceVersion();

    expect(calls).toEqual([
      "find-recorded-target",
      "find-evidence-target",
      "find-predecessor",
      "clock",
      "publish",
    ]);
    expect(result.version).toMatchObject({
      createdAt: CREATED_AT,
      createdByPrincipalId: "usr_dataset_manager",
      fixtureId: FIXTURE_ID,
      fixtureVersionId: TARGET_VERSION_ID,
      predecessor: {
        definitionSha256: predecessor.definitionSha256,
        fixtureVersionId: PREDECESSOR_VERSION_ID,
      },
      replayability: "recorded_interactions",
      schemaVersion: "0.2",
      source: predecessor.source,
    });
    expect(result.ownerships).toEqual(ownerships(result.version));
    expect(value.clockNow).toHaveBeenCalledTimes(1);
  });

  it("omits an absent optional description", async () => {
    const value = harness();
    const { description: _description, ...withoutDescription } = request();

    const result = await value.service.execute(command({ request: withoutDescription }));

    expect(result.version).not.toHaveProperty("description");
  });

  it("retains local values when repository methods mutate detached inputs", async () => {
    const value = harness();
    value.findRecorded.mockImplementation(async (scope) => {
      (scope as { projectId: string }).projectId = "prj_mutated";
      return null;
    });
    value.findEvidence.mockImplementation(async (scope, versionId) => {
      (scope as { environmentId: string }).environmentId = "env_mutated";
      return versionId === PREDECESSOR_VERSION_ID ? evidenceVersion() : null;
    });
    value.publishRecorded.mockImplementation(async (version) => {
      const original = structuredClone(version);
      (version as { createdByPrincipalId: string }).createdByPrincipalId = "usr_mutated";
      return { created: true, ownerships: ownerships(original), version: original };
    });

    const result = await value.service.execute(command());

    expect(result.version.scope).toEqual(SCOPE);
    expect(result.version.createdByPrincipalId).toBe("usr_dataset_manager");
  });

  it("accepts an identical concurrent winner with its original server provenance", async () => {
    const value = harness();
    value.publishRecorded.mockImplementation(async (candidate) => {
      const winner = recordedVersion({
        createdAt: "2026-08-29T04:00:01.000Z",
        createdByPrincipalId: "usr_concurrent_manager",
      });
      expect(candidate.definitionSha256).toBe(winner.definitionSha256);
      return { created: false, ownerships: ownerships(winner), version: winner };
    });

    await expect(value.service.execute(command())).resolves.toMatchObject({
      created: false,
      version: {
        createdAt: "2026-08-29T04:00:01.000Z",
        createdByPrincipalId: "usr_concurrent_manager",
      },
    });
  });

  it("rejects evidence-version identifier collisions before predecessor or clock access", async () => {
    const value = harness();
    value.findEvidence.mockResolvedValue(evidenceVersion({ fixtureVersionId: TARGET_VERSION_ID }));

    await expect(value.service.execute(command())).rejects.toBeInstanceOf(
      RegressionVersionConflictError,
    );
    expect(value.findEvidence).toHaveBeenCalledTimes(1);
    expect(value.clockNow).not.toHaveBeenCalled();
    expect(value.publishRecorded).not.toHaveBeenCalled();
  });

  it.each([
    { label: "missing", predecessor: null },
    {
      label: "other logical fixture",
      predecessor: evidenceVersion({ fixtureId: "fix_other" }),
    },
  ])("rejects a $label evidence predecessor", async ({ predecessor }) => {
    const value = harness();
    value.findEvidence.mockImplementation((_scope, versionId) =>
      Promise.resolve(versionId === PREDECESSOR_VERSION_ID ? predecessor : null),
    );

    await expect(value.service.execute(command())).rejects.toBeInstanceOf(
      RegressionVersionLineageError,
    );
    expect(value.clockNow).not.toHaveBeenCalled();
  });

  it.each([
    {
      clock: { now: () => new Date(Number.NaN) },
      expected: "Recorded interaction fixture publication clock is invalid",
    },
    {
      clock: { now: () => ({ toISOString: () => "invalid" }) as Date },
      expected: "Recorded interaction fixture publication clock is invalid",
    },
    {
      clock: { now: () => new Date("2026-08-29T03:29:59.999Z") },
      expected: "Recorded interaction fixture publication candidate is invalid",
    },
  ])("rejects an unusable server clock %#", async ({ clock, expected }) => {
    const value = harness();
    const service = new PublishRecordedInteractionFixtureVersion({
      clock,
      versionRepository: value.repository,
    });

    await expect(service.execute(command())).rejects.toMatchObject({
      code: "regression_version_input_invalid",
      message: expected,
    });
    expect(value.publishRecorded).not.toHaveBeenCalled();
  });
});

describe("PublishRecordedInteractionFixtureVersion retries", () => {
  it("returns exact stored provenance without predecessor or clock access", async () => {
    const value = harness();
    const stored = recordedVersion({
      createdAt: "2026-08-29T03:59:00.000Z",
      createdByPrincipalId: "usr_original_manager",
    });
    const storedOwnerships = ownerships(stored);
    value.findRecorded.mockResolvedValue({ ownerships: storedOwnerships, version: stored });
    value.publishRecorded.mockResolvedValue({
      created: false,
      ownerships: storedOwnerships,
      version: stored,
    });

    await expect(value.service.execute(command())).resolves.toEqual({
      created: false,
      ownerships: storedOwnerships,
      version: stored,
    });
    expect(value.findEvidence).not.toHaveBeenCalled();
    expect(value.clockNow).not.toHaveBeenCalled();
    expect(value.publishRecorded).toHaveBeenCalledWith(stored);
  });

  it.each([
    { fixtureId: "fix_other" },
    { name: "Other name" },
    { description: "Other description" },
    { predecessor: { ...recordedVersion().predecessor, fixtureVersionId: "fxv_other" } },
    {
      interactionCapture: {
        ...capture(),
        source: {
          ...capture().source,
          captureAdapter: { ...capture().source.captureAdapter, version: "9.9.9" },
        },
      },
    },
  ])("rejects a target identifier rebound to different request semantics %#", async (override) => {
    const value = harness();
    const stored = recordedVersion(override as Partial<RecordedInteractionFixtureVersion>);
    value.findRecorded.mockResolvedValue({ ownerships: ownerships(stored), version: stored });

    await expect(value.service.execute(command())).rejects.toBeInstanceOf(
      RegressionVersionConflictError,
    );
    expect(value.publishRecorded).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "created retry",
      mutate: (
        stored: RecordedInteractionFixtureVersion,
        storedOwnerships: readonly ArtifactOwnership[],
      ) => ({
        created: true,
        ownerships: storedOwnerships,
        version: stored,
      }),
    },
    {
      label: "changed provenance",
      mutate: (
        stored: RecordedInteractionFixtureVersion,
        storedOwnerships: readonly ArtifactOwnership[],
      ) => ({
        created: false,
        ownerships: storedOwnerships,
        version: { ...stored, createdByPrincipalId: "usr_changed" },
      }),
    },
    {
      label: "changed ownership provenance",
      mutate: (
        stored: RecordedInteractionFixtureVersion,
        storedOwnerships: readonly ArtifactOwnership[],
      ) => ({
        created: false,
        ownerships: [
          { ...firstOwnership(storedOwnerships), boundByPrincipalId: "usr_changed" },
          ...storedOwnerships.slice(1),
        ],
        version: stored,
      }),
    },
  ])("rejects a repository $label result", async ({ mutate }) => {
    const value = harness();
    const stored = recordedVersion();
    const storedOwnerships = ownerships(stored);
    value.findRecorded.mockResolvedValue({ ownerships: storedOwnerships, version: stored });
    value.publishRecorded.mockResolvedValue(mutate(stored, storedOwnerships));

    await expect(value.service.execute(command())).rejects.toBeInstanceOf(
      RegressionRepositoryContractError,
    );
  });
});

describe("PublishRecordedInteractionFixtureVersion repository contracts", () => {
  it.each([
    null,
    {},
    { ownerships: [], version: recordedVersion(), extra: true },
    { ownerships: [], version: recordedVersion() },
    { ownerships: ownerships(recordedVersion()), version: { ...recordedVersion(), unknown: true } },
  ])("rejects malformed stored interaction records %#", async (stored) => {
    const value = harness();
    value.findRecorded.mockResolvedValue(stored as never);

    if (stored === null) {
      await expect(value.service.execute(command())).resolves.toMatchObject({ created: true });
    } else {
      await expect(value.service.execute(command())).rejects.toBeInstanceOf(
        RegressionRepositoryContractError,
      );
    }
  });

  it("wraps stored validation and reflective access failures", async () => {
    const malformedVersion = { ...recordedVersion(), definitionSha256: "f".repeat(64) };
    for (const stored of [
      { ownerships: ownerships(recordedVersion()), version: malformedVersion },
      new Proxy(
        {},
        {
          ownKeys() {
            throw new Error("ownKeys failed");
          },
        },
      ),
      new Proxy(
        { ownerships: [], version: recordedVersion() },
        {
          get(target, property, receiver) {
            if (property === "ownerships") throw new Error("get failed");
            return Reflect.get(target, property, receiver);
          },
        },
      ),
    ]) {
      const value = harness();
      value.findRecorded.mockResolvedValue(stored as never);
      await expect(value.service.execute(command())).rejects.toBeInstanceOf(
        RegressionRepositoryContractError,
      );
    }
  });

  it.each([
    {
      label: "wrong artifact id",
      mutate: (items: readonly ArtifactOwnership[]) => [
        { ...firstOwnership(items), artifactId: "art_wrong" },
        ...items.slice(1),
      ],
    },
    {
      label: "wrong binding time",
      mutate: (items: readonly ArtifactOwnership[]) => [
        { ...firstOwnership(items), boundAt: "2026-08-29T04:00:01.000Z" },
        ...items.slice(1),
      ],
    },
    {
      label: "wrong binding principal",
      mutate: (items: readonly ArtifactOwnership[]) => [
        { ...firstOwnership(items), boundByPrincipalId: "usr_wrong" },
        ...items.slice(1),
      ],
    },
    {
      label: "wrong logical fixture",
      mutate: (items: readonly ArtifactOwnership[]) => [
        {
          ...firstOwnership(items),
          owner: { ...firstOwnership(items).owner, fixtureId: "fix_wrong" },
        },
        ...items.slice(1),
      ],
    },
    {
      label: "wrong fixture version",
      mutate: (items: readonly ArtifactOwnership[]) => [
        {
          ...firstOwnership(items),
          owner: { ...firstOwnership(items).owner, fixtureVersionId: "fxv_wrong" },
        },
        ...items.slice(1),
      ],
    },
    {
      label: "wrong scope",
      mutate: (items: readonly ArtifactOwnership[]) => [
        {
          ...firstOwnership(items),
          scope: { ...firstOwnership(items).scope, projectId: "prj_wrong" },
        },
        ...items.slice(1),
      ],
    },
    {
      label: "invalid ownership",
      mutate: (items: readonly ArtifactOwnership[]) => [
        { ...firstOwnership(items), schemaVersion: "9.9" },
        ...items.slice(1),
      ],
    },
  ])("rejects $label in repository ownerships", async ({ mutate }) => {
    const value = harness();
    const version = recordedVersion();
    value.findRecorded.mockResolvedValue({
      ownerships: mutate(ownerships(version)) as readonly ArtifactOwnership[],
      version,
    });

    await expect(value.service.execute(command())).rejects.toBeInstanceOf(
      RegressionRepositoryContractError,
    );
  });

  it.each([
    undefined,
    null,
    {},
    { created: "true", ownerships: [], version: recordedVersion() },
    { created: true, ownerships: [], version: recordedVersion(), extra: true },
  ])("rejects malformed publication results %#", async (result) => {
    const value = harness();
    value.publishRecorded.mockResolvedValue(result as never);

    await expect(value.service.execute(command())).rejects.toBeInstanceOf(
      RegressionRepositoryContractError,
    );
  });

  it("wraps publication reflective access failures", async () => {
    for (const result of [
      new Proxy(
        {},
        {
          ownKeys() {
            throw new Error("ownKeys failed");
          },
        },
      ),
      new Proxy(
        { created: true, ownerships: [], version: recordedVersion() },
        {
          get(target, property, receiver) {
            if (property === "created") throw new Error("get failed");
            return Reflect.get(target, property, receiver);
          },
        },
      ),
    ]) {
      const value = harness();
      value.publishRecorded.mockResolvedValue(result as never);
      await expect(value.service.execute(command())).rejects.toBeInstanceOf(
        RegressionRepositoryContractError,
      );
    }
  });

  it("rejects wrong predecessor repository identity, scope, and malformed data", async () => {
    for (const predecessor of [
      evidenceVersion({ fixtureVersionId: "fxv_wrong" }),
      evidenceVersion({ scope: { ...SCOPE, projectId: "prj_wrong" } }),
      { ...evidenceVersion(), definitionSha256: "f".repeat(64) },
    ]) {
      const value = harness();
      value.findEvidence.mockImplementation((_scope, versionId) =>
        Promise.resolve(versionId === PREDECESSOR_VERSION_ID ? (predecessor as never) : null),
      );
      await expect(value.service.execute(command())).rejects.toBeInstanceOf(
        RegressionRepositoryContractError,
      );
    }
  });

  it("rejects changed semantics or provenance from a claimed new publication", async () => {
    for (const version of [
      recordedVersion({ name: "Changed name" }),
      recordedVersion({ createdByPrincipalId: "usr_changed" }),
    ]) {
      const value = harness();
      value.publishRecorded.mockResolvedValue({
        created: true,
        ownerships: ownerships(version),
        version,
      });
      await expect(value.service.execute(command())).rejects.toBeInstanceOf(
        RegressionRepositoryContractError,
      );
    }
  });

  it("preserves the repository's non-leaking artifact eligibility failure", async () => {
    const value = harness();
    const failure = new RegressionArtifactBindingError();
    value.publishRecorded.mockRejectedValue(failure);

    await expect(value.service.execute(command())).rejects.toBe(failure);
    expect(failure).toMatchObject({
      code: "regression_artifact_binding_invalid",
      message:
        "Interaction fixture artifacts are unavailable or ineligible for exclusive ownership",
    });
  });
});
