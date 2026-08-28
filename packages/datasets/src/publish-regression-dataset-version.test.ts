import type {
  EvidenceScope,
  PrincipalContext,
  PublishRegressionDatasetVersionRequest,
  RegressionDatasetVersion,
  RegressionDatasetVersionDefinition,
  RegressionFixtureVersion,
  RegressionFixtureVersionReference,
  RequestedRegressionFixtureVersionReference,
} from "@proofstack/contracts";
import { type Clock, ForbiddenError } from "@proofstack/core";
import { describe, expect, it } from "vitest";
import {
  InvalidRegressionVersionInputError,
  RegressionRepositoryContractError,
  RegressionVersionConflictError,
  RegressionVersionLineageError,
  RegressionVersionNotFoundError,
} from "./errors.js";
import { PublishRegressionDatasetVersion } from "./publish-regression-dataset-version.js";
import { digestRegressionDatasetVersionDefinition } from "./regression-definition-digest.js";
import { projectRegressionDatasetVersionDefinition } from "./regression-version-definition.js";
import type {
  PublishRegressionVersionResult,
  RegressionVersionRepository,
  ResolveRegressionFixtureVersionReferencesResult,
} from "./regression-version-repository.js";

const scope: EvidenceScope = {
  environmentId: "env_production",
  projectId: "prj_agent",
  tenantId: "ten_acme",
};
const fixtureVersions = [
  {
    definitionSha256: "a".repeat(64),
    fixtureId: "fix_checkout_timeout",
    fixtureVersionId: "fixv_checkout_timeout_001",
  },
  {
    definitionSha256: "b".repeat(64),
    fixtureId: "fix_checkout_decline",
    fixtureVersionId: "fixv_checkout_decline_001",
  },
] as const satisfies readonly RegressionFixtureVersionReference[];

function principal(overrides: Partial<PrincipalContext> = {}): PrincipalContext {
  return {
    authentication: {
      authenticatedAt: "2026-08-29T01:00:00.000Z",
      credentialId: "ses_dataset_owner",
      method: "oidc",
    },
    capabilities: ["dataset:manage"],
    principalId: "usr_dataset_owner",
    principalType: "user",
    requestId: "req_publish_dataset_version",
    resourceScope: { mode: "tenant" },
    roles: ["owner"],
    tenantId: scope.tenantId,
    ...overrides,
  };
}

function request(
  overrides: Partial<PublishRegressionDatasetVersionRequest> = {},
): PublishRegressionDatasetVersionRequest {
  return {
    datasetVersionId: "datv_checkout_001",
    description: "Pinned checkout incidents.",
    fixtureVersions: fixtureVersions.map(({ fixtureId, fixtureVersionId }) => ({
      fixtureId,
      fixtureVersionId,
    })),
    name: "Checkout regressions",
    ...overrides,
  };
}

interface VersionOptions {
  readonly createdAt?: string;
  readonly createdByPrincipalId?: string;
  readonly datasetId?: string;
  readonly datasetVersionId?: string;
  readonly description?: string;
  readonly fixtureVersions?: readonly RegressionFixtureVersionReference[];
  readonly name?: string;
  readonly predecessor?: RegressionDatasetVersion["predecessor"];
  readonly scope?: EvidenceScope;
}

function version(options: VersionOptions = {}): RegressionDatasetVersion {
  const definition: RegressionDatasetVersionDefinition = {
    datasetId: options.datasetId ?? "dat_checkout",
    datasetVersionId: options.datasetVersionId ?? "datv_checkout_001",
    description: options.description ?? "Pinned checkout incidents.",
    fixtureVersions: [...(options.fixtureVersions ?? fixtureVersions)],
    name: options.name ?? "Checkout regressions",
    ...(options.predecessor === undefined ? {} : { predecessor: options.predecessor }),
    schemaVersion: "0.1",
    scope: options.scope ?? scope,
  };
  return {
    createdAt: options.createdAt ?? "2026-08-29T01:10:00.000Z",
    createdByPrincipalId: options.createdByPrincipalId ?? "usr_original_author",
    definitionSha256: digestRegressionDatasetVersionDefinition(definition),
    ...definition,
  };
}

type UnknownPublication = unknown;

class StubRepository implements RegressionVersionRepository {
  readonly calls: string[] = [];
  readonly datasets = new Map<string, unknown>();
  resourceExists: unknown = false;
  resolution: unknown = fixtureVersions.map((reference) => ({ ...reference }));
  publication: (candidate: RegressionDatasetVersion) => Promise<UnknownPublication> = async (
    candidate,
  ) => ({ created: true, version: candidate });
  publishedCandidate?: RegressionDatasetVersion;

  async datasetResourceExists(_scope: EvidenceScope, datasetId: string): Promise<boolean> {
    this.calls.push(`exists:${datasetId}`);
    return this.resourceExists as boolean;
  }

  async findDatasetVersion(
    _scope: EvidenceScope,
    datasetVersionId: string,
  ): Promise<RegressionDatasetVersion | null> {
    this.calls.push(`find:${datasetVersionId}`);
    return (this.datasets.get(datasetVersionId) ?? null) as RegressionDatasetVersion | null;
  }

  async findFixtureVersion(): Promise<RegressionFixtureVersion | null> {
    throw new Error("Unexpected fixture lookup");
  }

  async fixtureResourceExists(): Promise<boolean> {
    throw new Error("Unexpected fixture resource lookup");
  }

  async publishDatasetVersion(
    candidate: RegressionDatasetVersion,
  ): Promise<PublishRegressionVersionResult<RegressionDatasetVersion>> {
    this.calls.push("publish");
    this.publishedCandidate = candidate;
    return (await this.publication(
      candidate,
    )) as PublishRegressionVersionResult<RegressionDatasetVersion>;
  }

  async publishFixtureVersion(): Promise<PublishRegressionVersionResult<RegressionFixtureVersion>> {
    throw new Error("Unexpected fixture publication");
  }

  async resolveFixtureVersionReferences(
    _scope: EvidenceScope,
    references: readonly RequestedRegressionFixtureVersionReference[],
  ): Promise<ResolveRegressionFixtureVersionReferencesResult> {
    this.calls.push(
      `resolve:${references.map(({ fixtureId, fixtureVersionId }) => `${fixtureId}/${fixtureVersionId}`).join(",")}`,
    );
    return this.resolution as ResolveRegressionFixtureVersionReferencesResult;
  }
}

function command(
  overrides: Partial<Parameters<PublishRegressionDatasetVersion["execute"]>[0]> = {},
) {
  return {
    datasetId: "dat_checkout",
    environmentId: scope.environmentId,
    principal: principal(),
    projectId: scope.projectId,
    request: request(),
    ...overrides,
  };
}

function harness(options: { readonly now?: Date } = {}) {
  const repository = new StubRepository();
  const calls = repository.calls;
  let clockCalls = 0;
  const clock: Clock = {
    now: () => {
      clockCalls += 1;
      calls.push("clock");
      return options.now ?? new Date("2026-08-29T01:12:00.000Z");
    },
  };
  return {
    clockCalls: () => clockCalls,
    publisher: new PublishRegressionDatasetVersion({ clock, versionRepository: repository }),
    repository,
  };
}

describe("PublishRegressionDatasetVersion", () => {
  it("publishes a root from one exact ordered authoritative resolution", async () => {
    const value = harness();

    const result = await value.publisher.execute(command());

    expect(result).toEqual({ created: true, version: value.repository.publishedCandidate });
    expect(result.version).toMatchObject({
      createdAt: "2026-08-29T01:12:00.000Z",
      createdByPrincipalId: "usr_dataset_owner",
      datasetId: "dat_checkout",
      datasetVersionId: "datv_checkout_001",
      fixtureVersions,
      scope,
    });
    expect(result.version.definitionSha256).toBe(
      digestRegressionDatasetVersionDefinition(
        projectRegressionDatasetVersionDefinition(result.version),
      ),
    );
    expect(value.clockCalls()).toBe(1);
    expect(value.repository.calls).toEqual([
      "find:datv_checkout_001",
      "exists:dat_checkout",
      "resolve:fix_checkout_timeout/fixv_checkout_timeout_001,fix_checkout_decline/fixv_checkout_decline_001",
      "clock",
      "publish",
    ]);
  });

  it("omits absent optional text and binds an authoritative predecessor", async () => {
    const value = harness();
    const predecessor = version({
      datasetVersionId: "datv_checkout_previous",
      description: "Previous selection.",
    });
    value.repository.datasets.set(predecessor.datasetVersionId, predecessor);
    const childRequest = request({
      description: undefined,
      predecessorVersionId: predecessor.datasetVersionId,
    });

    const result = await value.publisher.execute(command({ request: childRequest }));

    expect(result.version).not.toHaveProperty("description");
    expect(result.version.predecessor).toEqual({
      datasetVersionId: predecessor.datasetVersionId,
      definitionSha256: predecessor.definitionSha256,
    });
    expect(value.repository.calls.slice(0, 3)).toEqual([
      "find:datv_checkout_001",
      "find:datv_checkout_previous",
      "resolve:fix_checkout_timeout/fixv_checkout_timeout_001,fix_checkout_decline/fixv_checkout_decline_001",
    ]);
  });

  it("accepts an equivalent publication race while preserving the winner provenance", async () => {
    const value = harness();
    value.repository.publication = async (candidate) => ({
      created: false,
      version: {
        ...candidate,
        createdAt: "2026-08-29T01:11:59.000Z",
        createdByPrincipalId: "usr_race_winner",
      },
    });

    const result = await value.publisher.execute(command());

    expect(result).toMatchObject({
      created: false,
      version: {
        createdAt: "2026-08-29T01:11:59.000Z",
        createdByPrincipalId: "usr_race_winner",
      },
    });
  });

  it("retains authoritative scope and requested members when an adapter mutates its inputs", async () => {
    const value = harness();
    value.repository.findDatasetVersion = async (repositoryScope) => {
      (repositoryScope as { environmentId: string }).environmentId = "env_mutated";
      return null;
    };
    value.repository.datasetResourceExists = async (repositoryScope) => {
      expect(repositoryScope).toEqual(scope);
      (repositoryScope as { projectId: string }).projectId = "prj_mutated";
      return false;
    };
    value.repository.resolveFixtureVersionReferences = async (repositoryScope, references) => {
      expect(repositoryScope).toEqual(scope);
      expect(references).toEqual(request().fixtureVersions);
      (repositoryScope as { tenantId: string }).tenantId = "ten_mutated";
      (references[0] as { fixtureId: string }).fixtureId = "fix_mutated";
      return fixtureVersions.map((reference) => ({ ...reference }));
    };

    const result = await value.publisher.execute(command());

    expect(result.version.scope).toEqual(scope);
    expect(result.version.fixtureVersions).toEqual(fixtureVersions);
  });

  it("snapshots logical and creator identities before the first dependency await", async () => {
    const value = harness();
    const mutableCommand = command();
    value.repository.findDatasetVersion = async () => {
      mutableCommand.datasetId = "dat_mutated";
      mutableCommand.principal.principalId = "usr_mutated";
      return null;
    };
    value.repository.datasetResourceExists = async (_repositoryScope, datasetId) => {
      expect(datasetId).toBe("dat_checkout");
      return false;
    };

    const result = await value.publisher.execute(mutableCommand);

    expect(result.version).toMatchObject({
      createdByPrincipalId: "usr_dataset_owner",
      datasetId: "dat_checkout",
    });
  });

  it("rejects semantic drift when an adapter mutates the detached publication candidate", async () => {
    const value = harness();
    value.repository.publication = async (candidate) => {
      const definition = {
        ...projectRegressionDatasetVersionDefinition(candidate),
        name: "Adapter-mutated regressions",
      };
      (candidate as { name: string }).name = definition.name;
      (candidate as { definitionSha256: string }).definitionSha256 =
        digestRegressionDatasetVersionDefinition(definition);
      return { created: true, version: candidate };
    };

    await expect(value.publisher.execute(command())).rejects.toBeInstanceOf(
      RegressionRepositoryContractError,
    );
  });

  it("re-enters the atomic boundary for an identical target retry without new resolution", async () => {
    const value = harness();
    const stored = version();
    value.repository.datasets.set(stored.datasetVersionId, stored);
    value.repository.publication = async () => ({ created: false, version: stored });

    const result = await value.publisher.execute(command());

    expect(result).toEqual({ created: false, version: stored });
    expect(value.repository.publishedCandidate).toEqual(stored);
    expect(value.repository.publishedCandidate).not.toBe(stored);
    expect(value.repository.calls).toEqual(["find:datv_checkout_001", "publish"]);
    expect(value.clockCalls()).toBe(0);
  });

  it.each([
    ["logical resource", version({ datasetId: "dat_other" }), request()],
    ["name", version(), request({ name: "Different regressions" })],
    ["description", version(), request({ description: "Different incidents." })],
    [
      "predecessor",
      version({
        predecessor: {
          datasetVersionId: "datv_checkout_previous",
          definitionSha256: "c".repeat(64),
        },
      }),
      request(),
    ],
    ["member count", version({ fixtureVersions: fixtureVersions.slice(0, 1) }), request()],
    ["member order", version({ fixtureVersions: [...fixtureVersions].reverse() }), request()],
    [
      "fixture identity",
      version(),
      request({
        fixtureVersions: [
          { fixtureId: "fix_other", fixtureVersionId: fixtureVersions[0].fixtureVersionId },
          request().fixtureVersions[1] as RequestedRegressionFixtureVersionReference,
        ],
      }),
    ],
    [
      "version identity",
      version(),
      request({
        fixtureVersions: [
          { fixtureId: fixtureVersions[0].fixtureId, fixtureVersionId: "fixv_other_001" },
          request().fixtureVersions[1] as RequestedRegressionFixtureVersionReference,
        ],
      }),
    ],
  ])(
    "conflicts on an existing target with different %s semantics",
    async (_label, stored, body) => {
      const value = harness();
      value.repository.datasets.set("datv_checkout_001", stored);

      await expect(value.publisher.execute(command({ request: body }))).rejects.toBeInstanceOf(
        RegressionVersionConflictError,
      );
      expect(value.repository.calls).toEqual(["find:datv_checkout_001"]);
    },
  );

  it.each([
    command({ principal: principal({ capabilities: [] }) }),
    command({
      principal: principal({
        resourceScope: {
          mode: "restricted",
          projects: [{ environmentIds: ["env_staging"], projectId: scope.projectId }],
        },
      }),
    }),
  ])("authorizes before validation and repository access %#", async (unauthorized) => {
    const value = harness();
    const invalid = { ...unauthorized, datasetId: "bad-id", request: {} } as never;
    await expect(value.publisher.execute(invalid)).rejects.toBeInstanceOf(ForbiddenError);
    expect(value.repository.calls).toEqual([]);
    expect(value.clockCalls()).toBe(0);
  });

  it("uses one immutable principal and route snapshot for authorization and repository scope", async () => {
    const value = harness();
    const allowedPrincipal = principal({
      resourceScope: {
        mode: "restricted",
        projects: [{ environmentIds: [scope.environmentId], projectId: scope.projectId }],
      },
    });
    const otherTenantPrincipal = principal({ tenantId: "ten_other" });
    let environmentReads = 0;
    let principalReads = 0;
    let projectReads = 0;
    const input = {
      datasetId: "dat_checkout",
      get environmentId() {
        environmentReads += 1;
        return environmentReads === 1 ? scope.environmentId : "env_other";
      },
      get principal() {
        principalReads += 1;
        return principalReads <= 2 ? allowedPrincipal : otherTenantPrincipal;
      },
      get projectId() {
        projectReads += 1;
        return projectReads === 1 ? scope.projectId : "prj_other";
      },
      request: request(),
    } satisfies Parameters<PublishRegressionDatasetVersion["execute"]>[0];
    value.repository.findDatasetVersion = async (repositoryScope, datasetVersionId) => {
      value.repository.calls.push(`find:${datasetVersionId}`);
      expect(repositoryScope).toEqual(scope);
      return null;
    };

    const result = await value.publisher.execute(input);

    expect(result.version.scope).toEqual(scope);
    expect([principalReads, projectReads, environmentReads]).toEqual([1, 1, 1]);
  });

  it.each([
    command({ datasetId: "bad-id" }),
    command({ request: { ...request(), unexpected: true } as never }),
    command({ environmentId: "bad-id" }),
  ])("rejects invalid route, body, or scope input before repository access %#", async (invalid) => {
    const value = harness();
    await expect(value.publisher.execute(invalid)).rejects.toBeInstanceOf(
      InvalidRegressionVersionInputError,
    );
    expect(value.repository.calls).toEqual([]);
  });

  it("rejects an invalid principal snapshot before repository access", async () => {
    const value = harness();
    await expect(
      value.publisher.execute(command({ principal: principal({ principalId: "bad-id" }) })),
    ).rejects.toBeInstanceOf(InvalidRegressionVersionInputError);
    expect(value.repository.calls).toEqual([]);
  });

  it("normalizes an invalid publication clock after member resolution", async () => {
    const value = harness({ now: new Date(Number.NaN) });
    await expect(value.publisher.execute(command())).rejects.toBeInstanceOf(
      InvalidRegressionVersionInputError,
    );
    expect(value.repository.calls.at(-1)).toBe("clock");
  });

  it("normalizes a clock string outside the stored timestamp contract", async () => {
    const value = harness({
      now: { toISOString: () => "not-a-timestamp" } as Date,
    });

    await expect(value.publisher.execute(command())).rejects.toBeInstanceOf(
      InvalidRegressionVersionInputError,
    );
    expect(value.repository.calls.at(-1)).toBe("clock");
    expect(value.repository.calls).not.toContain("publish");
  });

  it.each([
    ["invalid version", {}],
    ["invalid digest", { ...version(), definitionSha256: "f".repeat(64) }],
    ["substituted identifier", version({ datasetVersionId: "datv_other_001" })],
    ["substituted environment", version({ scope: { ...scope, environmentId: "env_other" } })],
    ["substituted project", version({ scope: { ...scope, projectId: "prj_other" } })],
    ["substituted tenant", version({ scope: { ...scope, tenantId: "ten_other" } })],
  ])("rejects a target lookup with %s", async (_label, stored) => {
    const value = harness();
    value.repository.datasets.set("datv_checkout_001", stored);
    await expect(value.publisher.execute(command())).rejects.toBeInstanceOf(
      RegressionRepositoryContractError,
    );
    expect(value.repository.calls).toEqual(["find:datv_checkout_001"]);
  });

  it("rejects a missing or cross-resource predecessor before fixture resolution", async () => {
    const missing = harness();
    const childRequest = request({ predecessorVersionId: "datv_checkout_previous" });
    await expect(
      missing.publisher.execute(command({ request: childRequest })),
    ).rejects.toBeInstanceOf(RegressionVersionLineageError);
    expect(missing.repository.calls).toEqual([
      "find:datv_checkout_001",
      "find:datv_checkout_previous",
    ]);

    const wrongResource = harness();
    wrongResource.repository.datasets.set(
      "datv_checkout_previous",
      version({ datasetId: "dat_other", datasetVersionId: "datv_checkout_previous" }),
    );
    await expect(
      wrongResource.publisher.execute(command({ request: childRequest })),
    ).rejects.toBeInstanceOf(RegressionVersionLineageError);
  });

  it.each([
    ["invalid predecessor", {}],
    ["substituted predecessor", version({ datasetVersionId: "datv_unrequested_previous" })],
    [
      "cross-scope predecessor",
      version({
        datasetVersionId: "datv_checkout_previous",
        scope: { ...scope, environmentId: "env_other" },
      }),
    ],
  ])("rejects an adapter %s result", async (_label, stored) => {
    const value = harness();
    value.repository.datasets.set("datv_checkout_previous", stored);
    await expect(
      value.publisher.execute(
        command({ request: request({ predecessorVersionId: "datv_checkout_previous" }) }),
      ),
    ).rejects.toBeInstanceOf(RegressionRepositoryContractError);
  });

  it("requires a predecessor when the logical resource already exists", async () => {
    const value = harness();
    value.repository.resourceExists = true;
    await expect(value.publisher.execute(command())).rejects.toBeInstanceOf(
      RegressionVersionLineageError,
    );
    expect(value.repository.calls).toEqual(["find:datv_checkout_001", "exists:dat_checkout"]);
  });

  it("rejects a malformed resource existence response", async () => {
    const value = harness();
    value.repository.resourceExists = "false";
    await expect(value.publisher.execute(command())).rejects.toBeInstanceOf(
      RegressionRepositoryContractError,
    );
  });

  it("maps an all-or-nothing resolution miss to a scope-safe not-found", async () => {
    const value = harness();
    value.repository.resolution = null;
    await expect(value.publisher.execute(command())).rejects.toBeInstanceOf(
      RegressionVersionNotFoundError,
    );
    expect(value.repository.calls).not.toContain("clock");
  });

  it.each([
    ["non-array", {}],
    ["wrong length", fixtureVersions.slice(0, 1)],
    ["sparse array", new Array(2)],
    ["invalid digest", [{ ...fixtureVersions[0], definitionSha256: "bad" }, fixtureVersions[1]]],
    [
      "substituted fixture",
      [{ ...fixtureVersions[0], fixtureId: "fix_other" }, fixtureVersions[1]],
    ],
    [
      "substituted version",
      [fixtureVersions[0], { ...fixtureVersions[1], fixtureVersionId: "fixv_other_001" }],
    ],
    ["reordered references", [...fixtureVersions].reverse()],
  ])("rejects a malformed %s resolution without publishing", async (_label, resolution) => {
    const value = harness();
    value.repository.resolution = resolution;
    await expect(value.publisher.execute(command())).rejects.toBeInstanceOf(
      RegressionRepositoryContractError,
    );
    expect(value.repository.calls).not.toContain("clock");
    expect(value.repository.calls).not.toContain("publish");
  });

  it("normalizes a hostile fixture resolution array", async () => {
    const value = harness();
    value.repository.resolution = new Proxy([...fixtureVersions], {
      get: (target, property, receiver) => {
        if (property === "length") throw new Error("unreadable resolution");
        return Reflect.get(target, property, receiver);
      },
    });
    await expect(value.publisher.execute(command())).rejects.toBeInstanceOf(
      RegressionRepositoryContractError,
    );
    expect(value.repository.calls).not.toContain("clock");
  });

  it("resolves every fixed array index without trusting an overridden iterator", async () => {
    const value = harness();
    const resolution = fixtureVersions.map((reference) => ({ ...reference }));
    Object.defineProperty(resolution, Symbol.iterator, {
      value: function* truncatedIterator() {
        yield resolution[0];
      },
    });
    value.repository.resolution = resolution;

    const result = await value.publisher.execute(command());

    expect(result.version.fixtureVersions).toEqual(fixtureVersions);
    expect(value.repository.calls).toContain("publish");
  });

  it.each([
    ["null", null],
    ["extra field", { created: false, extra: true, version: version() }],
    ["invalid marker", { created: "false", version: version() }],
    ["invalid version", { created: false, version: {} }],
    ["new marker", { created: true, version: version() }],
    [
      "different provenance",
      {
        created: false,
        version: version({ createdAt: "2026-08-29T01:10:01.000Z" }),
      },
    ],
  ])("rejects an invalid identical-retry publication result: %s", async (_label, output) => {
    const value = harness();
    const stored = version();
    value.repository.datasets.set(stored.datasetVersionId, stored);
    value.repository.publication = async () => output;
    await expect(value.publisher.execute(command())).rejects.toBeInstanceOf(
      RegressionRepositoryContractError,
    );
  });

  it("rejects publication results whose shape or fields cannot be read", async () => {
    const stored = version();
    const ownKeysFailure = harness();
    ownKeysFailure.repository.datasets.set(stored.datasetVersionId, stored);
    ownKeysFailure.repository.publication = async () =>
      new Proxy(
        { created: false, version: stored },
        {
          ownKeys: () => {
            throw new Error("unreadable keys");
          },
        },
      );
    await expect(ownKeysFailure.publisher.execute(command())).rejects.toBeInstanceOf(
      RegressionRepositoryContractError,
    );

    const getterFailure = harness();
    getterFailure.repository.datasets.set(stored.datasetVersionId, stored);
    getterFailure.repository.publication = async () => {
      const output = { version: stored } as { created: boolean; version: RegressionDatasetVersion };
      Object.defineProperty(output, "created", {
        enumerable: true,
        get: () => {
          throw new Error("unreadable marker");
        },
      });
      return output;
    };
    await expect(getterFailure.publisher.execute(command())).rejects.toBeInstanceOf(
      RegressionRepositoryContractError,
    );
  });

  it.each([
    [
      "wrong logical resource",
      (candidate: RegressionDatasetVersion) =>
        version({
          createdAt: candidate.createdAt,
          createdByPrincipalId: candidate.createdByPrincipalId,
          datasetId: "dat_other",
          datasetVersionId: candidate.datasetVersionId,
        }),
      false,
    ],
    [
      "different semantics",
      (candidate: RegressionDatasetVersion) => {
        const definition = {
          ...projectRegressionDatasetVersionDefinition(candidate),
          name: "Substituted regressions",
        };
        return {
          createdAt: candidate.createdAt,
          createdByPrincipalId: candidate.createdByPrincipalId,
          definitionSha256: digestRegressionDatasetVersionDefinition(definition),
          ...definition,
        };
      },
      false,
    ],
    [
      "different provenance on created result",
      (candidate: RegressionDatasetVersion) => ({
        ...candidate,
        createdByPrincipalId: "usr_substituted_author",
      }),
      true,
    ],
  ])("rejects a new publication result with %s", async (_label, mutate, created) => {
    const value = harness();
    value.repository.publication = async (candidate) => ({
      created,
      version: mutate(candidate),
    });
    await expect(value.publisher.execute(command())).rejects.toBeInstanceOf(
      RegressionRepositoryContractError,
    );
  });

  it("preserves adapter errors rather than relabeling them as contract failures", async () => {
    const value = harness();
    const adapterFailure = new Error("database unavailable");
    value.repository.findDatasetVersion = async () => {
      throw adapterFailure;
    };
    await expect(value.publisher.execute(command())).rejects.toBe(adapterFailure);
  });
});
