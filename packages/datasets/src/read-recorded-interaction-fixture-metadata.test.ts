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
import { ForbiddenError } from "@proofstack/core";
import { describe, expect, it, vi } from "vitest";
import {
  InvalidRegressionVersionInputError,
  RegressionRepositoryContractError,
  RegressionVersionNotFoundError,
} from "./errors.js";
import { digestRecordedInteractionFixtureVersionDefinition } from "./interaction-fixture-definition-digest.js";
import {
  ReadRecordedInteractionFixtureMetadata,
  type ReadRecordedInteractionFixtureMetadataCommand,
} from "./read-recorded-interaction-fixture-metadata.js";
import { digestRegressionFixtureVersionDefinition } from "./regression-definition-digest.js";
import type {
  InteractionFixtureVersionRepository,
  StoredInteractionFixtureContent,
} from "./regression-version-repository.js";

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
    capabilities: ["dataset:read"],
    principalId: "usr_dataset_reader",
    principalType: "user",
    requestId: "req_read_interaction_fixture",
    resourceScope: { mode: "tenant" },
    roles: ["viewer"],
    tenantId: SCOPE.tenantId,
    ...overrides,
  });
}

function command(
  overrides: Partial<ReadRecordedInteractionFixtureMetadataCommand> = {},
): ReadRecordedInteractionFixtureMetadataCommand {
  return {
    environmentId: SCOPE.environmentId,
    fixtureId: FIXTURE_ID,
    fixtureVersionId: VERSION_ID,
    principal: principal(),
    projectId: SCOPE.projectId,
    ...overrides,
  };
}

function version(
  overrides: Partial<RecordedInteractionFixtureVersion> = {},
): RecordedInteractionFixtureVersion {
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
    fixtureId: overrides.fixtureId ?? FIXTURE_ID,
    fixtureVersionId: overrides.fixtureVersionId ?? VERSION_ID,
    predecessor: {
      definitionSha256: predecessor.definitionSha256,
      fixtureVersionId: predecessor.fixtureVersionId,
    },
    scope: overrides.scope ?? SCOPE,
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

function revocation(): InteractionFixtureContentRevocation {
  return {
    fixtureId: FIXTURE_ID,
    fixtureVersionId: VERSION_ID,
    reason: REASON,
    revocationId: "rev_checkout_failure",
    revokedAt: REVOKED_AT,
    revokedByPrincipalId: "usr_privacy_operator",
    schemaVersion: "0.1",
    scope: SCOPE,
  };
}

function tombstones(value = revocation()): readonly ArtifactTombstone[] {
  return ownerships().map((ownership, index) => ({
    actorPrincipalId: value.revokedByPrincipalId,
    artifactId: ownership.artifactId,
    occurredAt: value.revokedAt,
    reason: value.reason,
    tombstoneId: `del_interaction_${index}`,
    trigger: "fixture_revocation",
  }));
}

function state(
  contentAvailability: "available" | "revoked" | "unavailable" = "available",
): StoredInteractionFixtureContent {
  const revoked = contentAvailability === "revoked";
  return {
    contentAvailability,
    ownerships: ownerships(),
    revocation: revoked ? revocation() : null,
    tombstones: revoked ? tombstones() : [],
    version: version(),
  };
}

interface Harness {
  readonly findContent: ReturnType<
    typeof vi.fn<InteractionFixtureVersionRepository["findRecordedInteractionFixtureContent"]>
  >;
  readonly reader: ReadRecordedInteractionFixtureMetadata;
}

function harness(stored: unknown = state()): Harness {
  const findContent = vi
    .fn<InteractionFixtureVersionRepository["findRecordedInteractionFixtureContent"]>()
    .mockResolvedValue(stored as StoredInteractionFixtureContent | null);
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
    revokeRecordedInteractionFixtureContent: vi.fn(),
  };
  return { findContent, reader: new ReadRecordedInteractionFixtureMetadata(repository) };
}

describe("ReadRecordedInteractionFixtureMetadata", () => {
  it.each(["available", "unavailable", "revoked"] as const)(
    "returns the exact metadata-only %s state with dataset read authority",
    async (availability) => {
      const stored = state(availability);
      const value = harness(stored);
      const result = await value.reader.execute(command());

      expect(result).toEqual(stored);
      expect(value.findContent).toHaveBeenCalledWith(SCOPE, VERSION_ID);
      expect(JSON.stringify(result)).not.toContain("plaintext");
      expect(JSON.stringify(result)).not.toContain("ciphertext");
    },
  );

  it("requires dataset read authority before repository access", async () => {
    const value = harness();
    await expect(
      value.reader.execute(command({ principal: principal({ capabilities: ["artifact:read"] }) })),
    ).rejects.toMatchObject({
      code: "forbidden",
      message: "Missing required capability: dataset:read",
    });
    expect(value.findContent).not.toHaveBeenCalled();
  });

  it("authorizes the environment before validating attacker-controlled route identifiers", async () => {
    const value = harness();
    await expect(
      value.reader.execute(
        command({
          fixtureId: "bad id",
          principal: principal({
            resourceScope: { mode: "restricted", projects: [{ projectId: "prj_other" }] },
          }),
        }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(value.findContent).not.toHaveBeenCalled();
  });

  it.each([
    { expected: "principal", override: { principal: { ...principal(), extra: true } as never } },
    { expected: "scope", override: { projectId: "x" } },
    { expected: "fixtureId", override: { fixtureId: "x" } },
    { expected: "fixtureVersionId", override: { fixtureVersionId: "x" } },
  ])("rejects invalid $expected input before repository access", async ({ override }) => {
    const value = harness();
    await expect(value.reader.execute(command(override))).rejects.toBeInstanceOf(
      InvalidRegressionVersionInputError,
    );
    expect(value.findContent).not.toHaveBeenCalled();
  });

  it("uses the same not-found surface for missing and cross-resource versions", async () => {
    const missing = harness(null);
    await expect(missing.reader.execute(command())).rejects.toBeInstanceOf(
      RegressionVersionNotFoundError,
    );

    const otherVersion = version({ fixtureId: "fix_other" });
    const crossResource = harness({
      ...state(),
      ownerships: ownerships(otherVersion),
      version: otherVersion,
    });
    await expect(crossResource.reader.execute(command())).rejects.toBeInstanceOf(
      RegressionVersionNotFoundError,
    );
  });

  it.each([
    {},
    { ...state(), contentAvailability: "invalid" },
    { ...state(), version: version({ fixtureVersionId: "fixv_other" }) },
    { ...state(), version: version({ scope: { ...SCOPE, projectId: "prj_other" } }) },
  ])("rejects substituted or malformed repository state %#", async (stored) => {
    const value = harness(stored);
    await expect(value.reader.execute(command())).rejects.toBeInstanceOf(
      RegressionRepositoryContractError,
    );
  });

  it("returns detached metadata and preserves adapter failures", async () => {
    const stored = state();
    const detached = harness(stored);
    const result = await detached.reader.execute(command());
    (result.version as { name: string }).name = "Mutated caller copy";
    expect(stored.version.name).toBe("Checkout interaction");

    const failed = harness();
    const adapterFailure = new Error("database unavailable");
    failed.findContent.mockRejectedValue(adapterFailure);
    await expect(failed.reader.execute(command())).rejects.toBe(adapterFailure);
  });
});
