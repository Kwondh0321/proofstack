import { readFileSync } from "node:fs";
import type {
  ArtifactOwnership,
  ArtifactTombstone,
  EvidenceScope,
  InteractionFixtureContentRevocation,
  PrincipalContext,
  RecordedInteractionFixtureVersion,
  RecordedInteractionFixtureVersionDefinition,
  RegressionFixtureVersionDefinition,
} from "@proofstack/contracts";
import {
  PrincipalContextSchema,
  RecordedInteractionFixtureVersionDefinitionSchema,
  RecordedInteractionFixtureVersionSchema,
  RegressionFixtureVersionSchema,
} from "@proofstack/contracts";
import { type Clock, ForbiddenError } from "@proofstack/core";
import { describe, expect, it, vi } from "vitest";
import {
  RegressionFixtureContentRevocationConflictError,
  RegressionRepositoryContractError,
  RegressionVersionConflictError,
  RegressionVersionNotFoundError,
} from "./errors.js";
import { digestRecordedInteractionFixtureVersionDefinition } from "./interaction-fixture-definition-digest.js";
import { digestRegressionFixtureVersionDefinition } from "./regression-definition-digest.js";
import type { InteractionFixtureVersionRepository } from "./regression-version-repository.js";
import {
  RevokeRecordedInteractionFixtureContent,
  type RevokeRecordedInteractionFixtureContentCommand,
} from "./revoke-recorded-interaction-fixture-content.js";

const SCOPE: EvidenceScope = {
  environmentId: "env_production",
  projectId: "prj_checkout_agent",
  tenantId: "ten_acme",
};
const FIXTURE_ID = "fix_checkout_failure";
const VERSION_ID = "fixv_checkout_failure_recorded";
const REVOKED_AT = "2026-08-29T06:00:00.000Z";
const REASON = "Remove the complete captured interaction content set";

const vector = RecordedInteractionFixtureVersionDefinitionSchema.parse(
  (
    JSON.parse(
      readFileSync(
        new URL("../vectors/interaction-fixture-definition-v2.json", import.meta.url),
        "utf8",
      ),
    ) as {
      readonly vectors: readonly { readonly input: RecordedInteractionFixtureVersionDefinition }[];
    }
  ).vectors[0]?.input,
);

function principal(overrides: Partial<PrincipalContext> = {}): PrincipalContext {
  return PrincipalContextSchema.parse({
    authentication: { authenticatedAt: "2026-08-29T05:00:00.000Z", method: "development" },
    capabilities: ["dataset:manage", "artifact:delete"],
    principalId: "usr_privacy_operator",
    principalType: "user",
    requestId: "req_revoke_interaction_fixture",
    resourceScope: { mode: "tenant" },
    roles: ["owner"],
    tenantId: SCOPE.tenantId,
    ...overrides,
  });
}

function command(
  overrides: Partial<RevokeRecordedInteractionFixtureContentCommand> = {},
): RevokeRecordedInteractionFixtureContentCommand {
  return {
    environmentId: SCOPE.environmentId,
    fixtureId: FIXTURE_ID,
    fixtureVersionId: VERSION_ID,
    principal: principal(),
    projectId: SCOPE.projectId,
    request: { reason: REASON },
    ...overrides,
  };
}

function version(): RecordedInteractionFixtureVersion {
  const predecessorDefinition: RegressionFixtureVersionDefinition = {
    fixtureId: FIXTURE_ID,
    fixtureVersionId: "fixv_checkout_failure_evidence",
    name: "Checkout failure evidence",
    replayability: "evidence_only",
    schemaVersion: "0.1",
    scope: SCOPE,
    source: {
      eventIds: ["evt_checkout_failure"],
      kind: "trace_snapshot",
      observedEventCount: 1,
      sourceCompleteness: "observed_snapshot",
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
    },
  };
  const predecessor = RegressionFixtureVersionSchema.parse({
    ...predecessorDefinition,
    createdAt: "2026-08-29T05:30:00.000Z",
    createdByPrincipalId: "usr_observer",
    definitionSha256: digestRegressionFixtureVersionDefinition(predecessorDefinition),
    source: { ...predecessorDefinition.source, capturedAt: "2026-08-29T05:29:00.000Z" },
  });
  const definition = RecordedInteractionFixtureVersionDefinitionSchema.parse({
    ...vector,
    fixtureId: FIXTURE_ID,
    fixtureVersionId: VERSION_ID,
    predecessor: {
      definitionSha256: predecessor.definitionSha256,
      fixtureVersionId: predecessor.fixtureVersionId,
    },
    scope: SCOPE,
    source: predecessorDefinition.source,
  });
  return RecordedInteractionFixtureVersionSchema.parse({
    ...definition,
    createdAt: "2026-08-29T05:31:00.000Z",
    createdByPrincipalId: "usr_dataset_manager",
    definitionSha256: digestRecordedInteractionFixtureVersionDefinition(definition),
    source: predecessor.source,
  });
}

function ownerships(value = version()): readonly ArtifactOwnership[] {
  return value.interactionCapture.artifacts.map(({ contentReference }) => ({
    artifactId: contentReference.artifactId,
    boundAt: value.createdAt,
    boundByPrincipalId: value.createdByPrincipalId,
    owner: {
      fixtureId: value.fixtureId,
      fixtureVersionId: value.fixtureVersionId,
      kind: "regression_fixture_version",
    },
    schemaVersion: "0.1",
    scope: value.scope,
  }));
}

function revocation(overrides: Partial<InteractionFixtureContentRevocation> = {}) {
  return {
    fixtureId: FIXTURE_ID,
    fixtureVersionId: VERSION_ID,
    reason: REASON,
    revocationId: "rev_checkout_failure",
    revokedAt: REVOKED_AT,
    revokedByPrincipalId: "usr_privacy_operator",
    schemaVersion: "0.1" as const,
    scope: SCOPE,
    ...overrides,
  };
}

function tombstones(value = revocation(), items = ownerships()): readonly ArtifactTombstone[] {
  return items.map((ownership, index) => ({
    actorPrincipalId: value.revokedByPrincipalId,
    artifactId: ownership.artifactId,
    occurredAt: value.revokedAt,
    reason: value.reason,
    tombstoneId: `del_interaction_${index}`,
    trigger: "fixture_revocation",
  }));
}

function availableState() {
  return {
    contentAvailability: "available" as const,
    ownerships: ownerships(),
    revocation: null,
    tombstones: [],
    version: version(),
  };
}

function revokedState(value = revocation(), items = tombstones(value)) {
  return {
    contentAvailability: "revoked" as const,
    ownerships: ownerships(),
    revocation: value,
    tombstones: items,
    version: version(),
  };
}

interface Harness {
  readonly clockNow: ReturnType<typeof vi.fn<Clock["now"]>>;
  readonly findContent: ReturnType<
    typeof vi.fn<InteractionFixtureVersionRepository["findRecordedInteractionFixtureContent"]>
  >;
  readonly generateRevocationId: ReturnType<typeof vi.fn<() => string>>;
  readonly generateTombstoneId: ReturnType<typeof vi.fn<(artifactId: string) => string>>;
  readonly repository: InteractionFixtureVersionRepository;
  readonly revokeContent: ReturnType<
    typeof vi.fn<InteractionFixtureVersionRepository["revokeRecordedInteractionFixtureContent"]>
  >;
  readonly service: RevokeRecordedInteractionFixtureContent;
}

function harness(): Harness {
  const clockNow = vi.fn<Clock["now"]>().mockReturnValue(new Date(REVOKED_AT));
  const findContent = vi
    .fn<InteractionFixtureVersionRepository["findRecordedInteractionFixtureContent"]>()
    .mockResolvedValue(availableState());
  const generateRevocationId = vi.fn<() => string>().mockReturnValue("rev_checkout_failure");
  const generateTombstoneId = vi
    .fn<(artifactId: string) => string>()
    .mockImplementation((artifactId) => `del_${artifactId}`);
  const revokeContent = vi
    .fn<InteractionFixtureVersionRepository["revokeRecordedInteractionFixtureContent"]>()
    .mockImplementation((candidate) =>
      Promise.resolve({
        ...revokedState(candidate.revocation, candidate.tombstones),
        created: true,
      }),
    );
  const repository: InteractionFixtureVersionRepository = {
    datasetResourceExists: vi.fn().mockResolvedValue(false),
    findDatasetVersion: vi.fn().mockResolvedValue(null),
    findFixtureVersion: vi.fn().mockResolvedValue(null),
    findRecordedInteractionFixtureContent: findContent,
    findRecordedInteractionFixtureVersion: vi.fn().mockResolvedValue(null),
    fixtureResourceExists: vi.fn().mockResolvedValue(false),
    publishDatasetVersion: vi.fn(),
    publishFixtureVersion: vi.fn(),
    publishRecordedInteractionFixtureVersion: vi.fn(),
    resolveFixtureVersionReferences: vi.fn().mockResolvedValue(null),
    revokeRecordedInteractionFixtureContent: revokeContent,
  };
  return {
    clockNow,
    findContent,
    generateRevocationId,
    generateTombstoneId,
    repository,
    revokeContent,
    service: new RevokeRecordedInteractionFixtureContent({
      clock: { now: clockNow },
      identities: {
        generateArtifactTombstoneId: generateTombstoneId,
        generateRevocationId,
      },
      versionRepository: repository,
    }),
  };
}

describe("RevokeRecordedInteractionFixtureContent authorization and input", () => {
  it.each([
    { capabilities: [] as PrincipalContext["capabilities"], missing: "dataset:manage" },
    {
      capabilities: ["dataset:manage"] as PrincipalContext["capabilities"],
      missing: "artifact:delete",
    },
  ])("requires both non-delegable authorities before repository access %#", async (input) => {
    const value = harness();
    await expect(
      value.service.execute(
        command({ principal: principal({ capabilities: input.capabilities }) }),
      ),
    ).rejects.toMatchObject({
      code: "forbidden",
      message: `Missing required capability: ${input.missing}`,
    });
    expect(value.findContent).not.toHaveBeenCalled();
    expect(value.clockNow).not.toHaveBeenCalled();
  });

  it("authorizes scope before validating attacker-controlled input", async () => {
    const value = harness();
    await expect(
      value.service.execute(
        command({
          principal: principal({
            resourceScope: { mode: "restricted", projects: [{ projectId: "prj_other" }] },
          }),
          request: { reason: " bad " },
        }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(value.findContent).not.toHaveBeenCalled();
  });

  it.each([
    {
      expected: "principal is invalid",
      override: { principal: { ...principal(), extra: true } as never },
    },
    { expected: "scope is invalid", override: { environmentId: "x" } },
    { expected: "route is invalid", override: { fixtureId: "x" } },
    { expected: "route is invalid", override: { fixtureVersionId: "x" } },
    { expected: "request is invalid", override: { request: { reason: " bad " } } },
  ])("rejects strict invalid input: $expected", async ({ expected, override }) => {
    const value = harness();
    await expect(value.service.execute(command(override))).rejects.toMatchObject({
      code: "regression_version_input_invalid",
      message: expect.stringContaining(expected),
    });
    expect(value.findContent).not.toHaveBeenCalled();
  });
});

describe("RevokeRecordedInteractionFixtureContent lifecycle", () => {
  it("creates one full-set revocation and canonical fixture tombstones", async () => {
    const value = harness();
    const result = await value.service.execute(command());

    expect(result).toMatchObject({
      contentAvailability: "revoked",
      created: true,
      revocation: revocation(),
    });
    expect(result.tombstones).toHaveLength(ownerships().length);
    expect(result.tombstones.map(({ artifactId }) => artifactId)).toEqual(
      ownerships().map(({ artifactId }) => artifactId),
    );
    expect(result.tombstones.every(({ trigger }) => trigger === "fixture_revocation")).toBe(true);
    expect(value.clockNow).toHaveBeenCalledTimes(1);
    expect(value.generateRevocationId).toHaveBeenCalledTimes(1);
    expect(value.generateTombstoneId).toHaveBeenCalledTimes(ownerships().length);
  });

  it("retries an identical revocation without generating new provenance", async () => {
    const value = harness();
    const stored = revokedState();
    value.findContent.mockResolvedValue(stored);
    value.revokeContent.mockResolvedValue({ ...stored, created: false });

    await expect(value.service.execute(command())).resolves.toEqual({ ...stored, created: false });
    expect(value.clockNow).not.toHaveBeenCalled();
    expect(value.generateRevocationId).not.toHaveBeenCalled();
    expect(value.generateTombstoneId).not.toHaveBeenCalled();
  });

  it("rejects a different reason after immutable revocation", async () => {
    const value = harness();
    value.findContent.mockResolvedValue(revokedState());
    await expect(
      value.service.execute(command({ request: { reason: "A different decision" } })),
    ).rejects.toBeInstanceOf(RegressionFixtureContentRevocationConflictError);
    expect(value.revokeContent).not.toHaveBeenCalled();
  });

  it("uses one not-found surface and rejects a logical route mismatch", async () => {
    const missing = harness();
    missing.findContent.mockResolvedValue(null);
    await expect(missing.service.execute(command())).rejects.toBeInstanceOf(
      RegressionVersionNotFoundError,
    );

    const conflict = harness();
    await expect(
      conflict.service.execute(command({ fixtureId: "fix_other" })),
    ).rejects.toBeInstanceOf(RegressionVersionConflictError);
    expect(conflict.clockNow).not.toHaveBeenCalled();
  });

  it.each([
    { clock: { now: () => new Date(Number.NaN) }, identity: undefined },
    { clock: { now: () => ({ toISOString: () => "invalid" }) as Date }, identity: undefined },
    { clock: { now: () => new Date(REVOKED_AT) }, identity: "bad id" },
  ])("rejects invalid server clock or generated identity %#", async ({ clock, identity }) => {
    const value = harness();
    const service = new RevokeRecordedInteractionFixtureContent({
      clock,
      identities: {
        generateArtifactTombstoneId: () => identity ?? "del_valid",
        generateRevocationId: () => identity ?? "rev_valid",
      },
      versionRepository: value.repository,
    });
    await expect(service.execute(command())).rejects.toMatchObject({
      code: "regression_version_input_invalid",
    });
    expect(value.revokeContent).not.toHaveBeenCalled();
  });

  it("accepts an identical concurrent winner with original revocation provenance", async () => {
    const value = harness();
    const winner = revocation({
      revocationId: "rev_concurrent",
      revokedAt: "2026-08-29T06:00:01.000Z",
      revokedByPrincipalId: "usr_concurrent",
    });
    value.revokeContent.mockResolvedValue({
      ...revokedState(winner, tombstones(winner)),
      created: false,
    });
    await expect(value.service.execute(command())).resolves.toMatchObject({
      created: false,
      revocation: winner,
    });
  });
});

describe("RevokeRecordedInteractionFixtureContent repository contracts", () => {
  it("translates reflective stored-state failures to repository contract errors", async () => {
    const ownKeysFailure = harness();
    ownKeysFailure.findContent.mockResolvedValue(
      new Proxy(availableState(), {
        ownKeys: () => {
          throw new Error("untrusted ownKeys trap");
        },
      }),
    );
    await expect(ownKeysFailure.service.execute(command())).rejects.toMatchObject({
      cause: expect.objectContaining({ message: "untrusted ownKeys trap" }),
      code: "regression_repository_contract_violation",
    });

    const propertyFailure = harness();
    propertyFailure.findContent.mockResolvedValue(
      new Proxy(availableState(), {
        get: (target, property, receiver) => {
          if (property === "ownerships") throw new Error("untrusted property trap");
          return Reflect.get(target, property, receiver);
        },
      }),
    );
    await expect(propertyFailure.service.execute(command())).rejects.toMatchObject({
      cause: expect.objectContaining({ message: "untrusted property trap" }),
      code: "regression_repository_contract_violation",
    });
  });

  it("translates reflective revocation-result failures to repository contract errors", async () => {
    const validResult = { ...revokedState(), created: true };
    const ownKeysFailure = harness();
    ownKeysFailure.revokeContent.mockResolvedValue(
      new Proxy(validResult, {
        ownKeys: () => {
          throw new Error("untrusted result ownKeys trap");
        },
      }),
    );
    await expect(ownKeysFailure.service.execute(command())).rejects.toMatchObject({
      cause: expect.objectContaining({ message: "untrusted result ownKeys trap" }),
      code: "regression_repository_contract_violation",
    });

    const propertyFailure = harness();
    propertyFailure.revokeContent.mockResolvedValue(
      new Proxy(validResult, {
        get: (target, property, receiver) => {
          if (property === "ownerships") throw new Error("untrusted result property trap");
          return Reflect.get(target, property, receiver);
        },
      }),
    );
    await expect(propertyFailure.service.execute(command())).rejects.toMatchObject({
      cause: expect.objectContaining({ message: "untrusted result property trap" }),
      code: "regression_repository_contract_violation",
    });
  });

  it.each([
    undefined,
    {},
    { ...availableState(), extra: true },
    { ...availableState(), contentAvailability: "invalid" },
    { ...availableState(), ownerships: [] },
    {
      ...availableState(),
      ownerships: [{ ...ownerships()[0], schemaVersion: "9" }, ...ownerships().slice(1)],
    },
    {
      ...availableState(),
      ownerships: [
        { ...ownerships()[0], artifactId: "art_semantically_wrong" },
        ...ownerships().slice(1),
      ],
    },
    { ...availableState(), version: { ...version(), definitionSha256: "f".repeat(64) } },
    { ...availableState(), revocation: revocation() },
    { ...availableState(), tombstones: [tombstones()[0]] },
  ])("rejects malformed stored content state %#", async (stored) => {
    const value = harness();
    value.findContent.mockResolvedValue(stored as never);
    await expect(value.service.execute(command())).rejects.toBeInstanceOf(
      RegressionRepositoryContractError,
    );
  });

  it.each([
    { ...revokedState(), revocation: null },
    { ...revokedState(), tombstones: [] },
    { ...revokedState(), revocation: { ...revocation(), fixtureId: "fix_other" } },
    { ...revokedState(), revocation: { ...revocation(), schemaVersion: "9" } },
    {
      ...revokedState(),
      tombstones: [{ ...tombstones()[0], tombstoneId: "bad id" }, ...tombstones().slice(1)],
    },
    {
      ...revokedState(),
      tombstones: [{ ...tombstones()[0], artifactId: "art_other" }, ...tombstones().slice(1)],
    },
    {
      ...revokedState(),
      tombstones: [{ ...tombstones()[0], trigger: "manual" }, ...tombstones().slice(1)],
    },
  ])("rejects inconsistent revoked content state %#", async (stored) => {
    const value = harness();
    value.findContent.mockResolvedValue(stored as never);
    await expect(value.service.execute(command())).rejects.toBeInstanceOf(
      RegressionRepositoryContractError,
    );
  });

  it.each([
    null,
    {},
    { ...revokedState(), created: "true" },
    { ...revokedState(), created: true, extra: true },
    { ...availableState(), created: true },
  ])("rejects malformed repository revocation results %#", async (result) => {
    const value = harness();
    value.revokeContent.mockResolvedValue(result as never);
    await expect(value.service.execute(command())).rejects.toBeInstanceOf(
      RegressionRepositoryContractError,
    );
  });

  it("rejects a changed claimed-new revocation and a changed retry", async () => {
    const changedNew = harness();
    const changed = revocation({ reason: "Changed by repository" });
    changedNew.revokeContent.mockResolvedValue({
      ...revokedState(changed, tombstones(changed)),
      created: true,
    });
    await expect(changedNew.service.execute(command())).rejects.toBeInstanceOf(
      RegressionRepositoryContractError,
    );

    const changedRetry = harness();
    const stored = revokedState();
    changedRetry.findContent.mockResolvedValue(stored);
    changedRetry.revokeContent.mockResolvedValue({ ...stored, created: true });
    await expect(changedRetry.service.execute(command())).rejects.toBeInstanceOf(
      RegressionRepositoryContractError,
    );
  });
});
