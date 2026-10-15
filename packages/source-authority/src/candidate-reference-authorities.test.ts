import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { EvidenceScope } from "@proofstack/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  ReleaseCandidateRevisionReference,
  ReleaseCandidateRuntimeReference,
} from "@proofstack/core";
import {
  createConfiguredCandidateReferenceAuthorities,
  LocalGitReleaseCandidateRevisionAuthority,
  StaticReleaseCandidateRuntimeAuthority,
} from "./candidate-reference-authorities.js";

const execFileAsync = promisify(execFile);
const repositoryUrl = "https://github.com/example/proofstack-authority-fixture";
const scope: EvidenceScope = {
  environmentId: "env_candidate_authority",
  projectId: "prj_candidate_authority",
  tenantId: "ten_candidate_authority",
};
const otherScope: EvidenceScope = { ...scope, tenantId: "ten_candidate_authority_other" };
const adapter = {
  adapterId: "adapter_candidate_authority",
  adapterVersionId: "adapter_candidate_authority_v1",
  definitionSha256: "a".repeat(64),
};
const resolution = {
  declaredAlias: "model-stable",
  limitation: "The provider exposes a stable alias but no immutable model version.",
  status: "provider_alias_only" as const,
};

let checkoutPath = "";
let firstCommit = "";
let firstTree = "";
let secondTree = "";
let objectFormat = "";

async function git(...arguments_: string[]): Promise<string> {
  const result = await execFileAsync("git", ["-C", checkoutPath, ...arguments_], {
    encoding: "utf8",
  });
  return result.stdout.trim();
}

function revisionReference(
  overrides: Partial<ReleaseCandidateRevisionReference["source"]> = {},
): ReleaseCandidateRevisionReference {
  return {
    kind: "source_revision",
    source: {
      commit: { algorithm: objectFormat as "sha1" | "sha256", value: firstCommit },
      repositoryUrl,
      tree: { algorithm: objectFormat as "sha1" | "sha256", value: firstTree },
      ...overrides,
    },
  };
}

beforeAll(async () => {
  checkoutPath = await mkdtemp(join(tmpdir(), "proofstack-git-authority-"));
  await execFileAsync("git", ["-C", checkoutPath, "init", "--quiet"]);
  await writeFile(join(checkoutPath, "fixture.txt"), "first\n", "utf8");
  await git("add", "fixture.txt");
  await git(
    "-c",
    "user.name=ProofStack Tests",
    "-c",
    "user.email=proofstack@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "first",
  );
  objectFormat = await git("rev-parse", "--show-object-format");
  firstCommit = await git("rev-parse", "HEAD");
  firstTree = await git("show", "--no-patch", "--format=%T", "HEAD");

  await writeFile(join(checkoutPath, "fixture.txt"), "second\n", "utf8");
  await git("add", "fixture.txt");
  await git(
    "-c",
    "user.name=ProofStack Tests",
    "-c",
    "user.email=proofstack@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "second",
  );
  secondTree = await git("show", "--no-patch", "--format=%T", "HEAD");
});

afterAll(async () => {
  if (checkoutPath) await rm(checkoutPath, { force: true, recursive: true });
});

describe("strict operator-owned reference configuration", () => {
  function configuration() {
    return {
      repositories: [{ checkoutPath, repositoryUrl, scope: { ...scope } }],
      modelDeclarations: [
        {
          scope: { ...scope },
          declaration: {
            providerId: "provider_candidate_authority",
            providerModelId: "model-stable",
            resolution: { ...resolution },
          },
        },
      ],
      runtimeAdapters: [{ adapter: { ...adapter }, scope: { ...scope } }],
    };
  }
  it("uses actual allowlisted Git objects and copied exact model/adapter declarations", async () => {
    const raw = configuration();
    const authorities = createConfiguredCandidateReferenceAuthorities(raw);
    raw.repositories[0]!.scope.tenantId = otherScope.tenantId;
    raw.modelDeclarations[0]!.declaration.providerModelId = "changed-after-admission";
    raw.runtimeAdapters[0]!.adapter.definitionSha256 = "f".repeat(64);
    await expect(authorities.revision.isAvailable(scope, revisionReference())).resolves.toBe(true);
    await expect(authorities.revision.isAvailable(otherScope, revisionReference())).resolves.toBe(
      false,
    );
    await expect(
      authorities.runtime.isAvailable(scope, {
        kind: "model_declaration",
        role: "primary_model",
        providerId: "provider_candidate_authority",
        providerModelId: "model-stable",
        resolution,
      }),
    ).resolves.toBe(true);
    await expect(
      authorities.runtime.isAvailable(scope, {
        kind: "runtime_adapter",
        role: "primary_model",
        adapter,
      }),
    ).resolves.toBe(true);
  });
  it("keeps explicitly empty operator catalogues unavailable", async () => {
    const authorities = createConfiguredCandidateReferenceAuthorities({
      repositories: [],
      modelDeclarations: [],
      runtimeAdapters: [],
    });
    await expect(authorities.revision.isAvailable(scope, revisionReference())).resolves.toBe(false);
    await expect(
      authorities.runtime.isAvailable(scope, {
        kind: "runtime_adapter",
        role: "primary_model",
        adapter,
      }),
    ).resolves.toBe(false);
  });
  it.each([
    "unknown",
    "missing",
    "relative",
    "wrong_scope",
    "duplicate_repository",
    "duplicate_model",
    "duplicate_adapter",
    "repositories_over",
    "models_over",
    "adapters_over",
  ])("rejects malformed/ambiguous/over-limit whole configuration: %s", (fault) => {
    const raw: Record<string, unknown> = configuration();
    if (fault === "unknown") raw["command"] = "git fetch";
    if (fault === "missing") delete raw["repositories"];
    if (fault === "relative")
      raw["repositories"] = [{ checkoutPath: "relative", repositoryUrl, scope }];
    if (fault === "wrong_scope")
      raw["runtimeAdapters"] = [{ adapter, scope: { ...scope, tenantId: "invalid scope" } }];
    if (fault === "duplicate_repository")
      raw["repositories"] = [...configuration().repositories, ...configuration().repositories];
    if (fault === "duplicate_model")
      raw["modelDeclarations"] = [
        ...configuration().modelDeclarations,
        ...configuration().modelDeclarations,
      ];
    if (fault === "duplicate_adapter")
      raw["runtimeAdapters"] = [
        ...configuration().runtimeAdapters,
        ...configuration().runtimeAdapters,
      ];
    if (fault === "repositories_over")
      raw["repositories"] = Array(257).fill(configuration().repositories[0]);
    if (fault === "models_over")
      raw["modelDeclarations"] = Array(257).fill(configuration().modelDeclarations[0]);
    if (fault === "adapters_over")
      raw["runtimeAdapters"] = Array(257).fill(configuration().runtimeAdapters[0]);
    expect(() => createConfiguredCandidateReferenceAuthorities(raw)).toThrow();
  });
});

describe("LocalGitReleaseCandidateRevisionAuthority", () => {
  it("verifies an allowlisted exact commit-to-tree relationship", async () => {
    const authority = new LocalGitReleaseCandidateRevisionAuthority({
      repositories: [{ checkoutPath, repositoryUrl, scope }],
    });

    await expect(authority.isAvailable(scope, revisionReference())).resolves.toBe(true);
  });

  it("fails closed for cross-scope, unlisted, missing, and mismatched objects", async () => {
    const authority = new LocalGitReleaseCandidateRevisionAuthority({
      repositories: [{ checkoutPath, repositoryUrl, scope }],
    });

    await expect(authority.isAvailable(otherScope, revisionReference())).resolves.toBe(false);
    await expect(
      authority.isAvailable(
        scope,
        revisionReference({ repositoryUrl: "https://github.com/example/not-allowlisted" }),
      ),
    ).resolves.toBe(false);
    await expect(
      authority.isAvailable(
        scope,
        revisionReference({
          tree: { algorithm: "sha256", value: "0".repeat(64) },
        }),
      ),
    ).resolves.toBe(false);
    await expect(
      authority.isAvailable(
        scope,
        revisionReference({
          commit: { algorithm: objectFormat as "sha1" | "sha256", value: "0".repeat(40) },
        }),
      ),
    ).resolves.toBe(false);
    await expect(
      authority.isAvailable(
        scope,
        revisionReference({
          tree: { algorithm: objectFormat as "sha1" | "sha256", value: secondTree },
        }),
      ),
    ).resolves.toBe(false);
  });

  it("rejects ambiguous or unsafe operator configuration", () => {
    expect(
      () =>
        new LocalGitReleaseCandidateRevisionAuthority({
          repositories: [
            { checkoutPath, repositoryUrl, scope },
            { checkoutPath, repositoryUrl, scope },
          ],
        }),
    ).toThrow("duplicate bindings");
    expect(
      () =>
        new LocalGitReleaseCandidateRevisionAuthority({
          repositories: [{ checkoutPath: "relative/path", repositoryUrl, scope }],
        }),
    ).toThrow("checkout path must be absolute");
    expect(
      () =>
        new LocalGitReleaseCandidateRevisionAuthority({
          repositories: Array.from({ length: 257 }, (_, index) => ({
            checkoutPath,
            repositoryUrl: `https://github.com/example/authority-fixture-${index}`,
            scope,
          })),
        }),
    ).toThrow("cannot exceed 256 entries");
  });
});

describe("StaticReleaseCandidateRuntimeAuthority", () => {
  type ModelReference = Extract<
    ReleaseCandidateRuntimeReference,
    { readonly kind: "model_declaration" }
  >;
  type AdapterReference = Extract<
    ReleaseCandidateRuntimeReference,
    { readonly kind: "runtime_adapter" }
  >;

  function modelReference(role = "primary_model"): ModelReference {
    return {
      kind: "model_declaration",
      providerId: "provider_candidate_authority",
      providerModelId: "model-stable",
      resolution,
      role,
    };
  }

  function adapterReference(role = "primary_model"): AdapterReference {
    return { adapter, kind: "runtime_adapter", role };
  }

  function authority() {
    return new StaticReleaseCandidateRuntimeAuthority({
      modelDeclarations: [
        {
          declaration: {
            providerId: "provider_candidate_authority",
            providerModelId: "model-stable",
            resolution,
          },
          scope,
        },
      ],
      runtimeAdapters: [{ adapter, scope }],
    });
  }

  it("matches exact scope-bound model and adapter definitions without granting role authority", async () => {
    const registry = authority();

    await expect(registry.isAvailable(scope, modelReference())).resolves.toBe(true);
    await expect(registry.isAvailable(scope, modelReference("secondary_model"))).resolves.toBe(
      true,
    );
    await expect(registry.isAvailable(scope, adapterReference())).resolves.toBe(true);
    await expect(registry.isAvailable(scope, adapterReference("secondary_model"))).resolves.toBe(
      true,
    );
  });

  it("fails closed for another scope or any changed semantic definition", async () => {
    const registry = authority();

    await expect(registry.isAvailable(otherScope, modelReference())).resolves.toBe(false);
    await expect(
      registry.isAvailable(scope, { ...modelReference(), providerModelId: "model-other" }),
    ).resolves.toBe(false);
    await expect(registry.isAvailable(otherScope, adapterReference())).resolves.toBe(false);
    await expect(
      registry.isAvailable(scope, {
        ...adapterReference(),
        adapter: { ...adapter, definitionSha256: "b".repeat(64) },
      }),
    ).resolves.toBe(false);
    await expect(
      registry.isAvailable({ ...scope, tenantId: "invalid tenant" }, modelReference()),
    ).resolves.toBe(false);
  });

  it("copies validated configuration and rejects duplicate bindings", async () => {
    const modelDeclarations = [
      {
        declaration: {
          providerId: "provider_candidate_authority",
          providerModelId: "model-stable",
          resolution,
        },
        scope,
      },
    ];
    const registry = new StaticReleaseCandidateRuntimeAuthority({
      modelDeclarations,
      runtimeAdapters: [{ adapter, scope }],
    });
    const mutableDeclaration = modelDeclarations[0];
    if (!mutableDeclaration) throw new Error("Expected one mutable declaration fixture");
    mutableDeclaration.declaration.providerModelId = "mutated";

    await expect(registry.isAvailable(scope, modelReference())).resolves.toBe(true);
    expect(
      () =>
        new StaticReleaseCandidateRuntimeAuthority({
          modelDeclarations: [
            {
              declaration: {
                providerId: "provider_candidate_authority",
                providerModelId: "model-stable",
                resolution,
              },
              scope,
            },
            {
              declaration: {
                providerId: "provider_candidate_authority",
                providerModelId: "model-stable",
                resolution,
              },
              scope,
            },
          ],
          runtimeAdapters: [],
        }),
    ).toThrow("duplicate bindings");
  });
});
