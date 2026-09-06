import type { EvidenceScope, PolicyInstallationBinding } from "@proofstack/contracts";
import { describe, expect, it, vi } from "vitest";
import { policyAuthorityFixture } from "../testing/release-policy-fixtures.js";
import { validateReleasePolicyAuthority } from "./release-policy-authority.js";
import {
  type PolicyInstallationBindingResolver,
  type ReleasePolicyAuthorityArtifactResolver,
  type ReleasePolicySourceAuthorityRepository,
  RepositoryReleasePolicyAuthorityResolver,
  StaticPolicyInstallationBindingResolver,
} from "./release-policy-authority-resolver.js";
import {
  InvalidReleasePolicyAuthorityInputError,
  ReleasePolicyAuthorityResolutionError,
  ReleasePolicyAuthorityResolverContractError,
} from "./release-policy-errors.js";

function clone<Value>(value: Value): Value {
  return structuredClone(value);
}

function sourceRepository(fixture: ReturnType<typeof policyAuthorityFixture>): {
  readonly findSourceReview: ReturnType<
    typeof vi.fn<ReleasePolicySourceAuthorityRepository["findSourceReview"]>
  >;
  readonly findSourceReviewerQualification: ReturnType<
    typeof vi.fn<ReleasePolicySourceAuthorityRepository["findSourceReviewerQualification"]>
  >;
  readonly findSourceSnapshot: ReturnType<
    typeof vi.fn<ReleasePolicySourceAuthorityRepository["findSourceSnapshot"]>
  >;
} {
  return {
    findSourceReview: vi.fn(async (_scope: EvidenceScope, id: string) =>
      id === fixture.review.sourceReviewId ? clone(fixture.review) : null,
    ),
    findSourceReviewerQualification: vi.fn(async (_scope: EvidenceScope, id: string) =>
      id === fixture.reviewer.qualificationId ? clone(fixture.reviewer) : null,
    ),
    findSourceSnapshot: vi.fn(async (_scope: EvidenceScope, id: string) =>
      id === fixture.source.sourceSnapshotId ? clone(fixture.source) : null,
    ),
  };
}

function setup() {
  const fixture = policyAuthorityFixture();
  const repository = sourceRepository(fixture);
  const artifactResolver = {
    resolve: vi.fn<ReleasePolicyAuthorityArtifactResolver["resolve"]>(async ({ references }) =>
      references.map((reference) => ({ ...reference, state: "available" as const })),
    ),
  };
  const installationBindingResolver = new StaticPolicyInstallationBindingResolver([
    fixture.binding,
  ]);
  const resolver = new RepositoryReleasePolicyAuthorityResolver({
    artifactResolver,
    installationBindingResolver,
    sourceRepository: repository,
  });
  return { artifactResolver, fixture, installationBindingResolver, repository, resolver };
}

describe("release policy authority evidence resolution", () => {
  it("rejects invalid commands before consulting any authority dependency", async () => {
    const value = setup();
    await expect(
      value.resolver.resolve({
        definition: {
          ...value.fixture.input.definition,
          policyVersionId: "invalid ID",
        },
        scope: value.fixture.input.scope,
      } as never),
    ).rejects.toBeInstanceOf(InvalidReleasePolicyAuthorityInputError);
    await expect(
      value.resolver.resolve({
        definition: value.fixture.input.definition,
        scope: { ...value.fixture.input.scope, tenantId: "invalid ID" },
      } as never),
    ).rejects.toBeInstanceOf(InvalidReleasePolicyAuthorityInputError);

    expect(value.repository.findSourceSnapshot).not.toHaveBeenCalled();
    expect(value.repository.findSourceReview).not.toHaveBeenCalled();
    expect(value.repository.findSourceReviewerQualification).not.toHaveBeenCalled();
    expect(value.artifactResolver.resolve).not.toHaveBeenCalled();
  });

  it("resolves one exact operator binding, qualified source chain, and retained-byte set", async () => {
    const value = setup();
    const evidence = await value.resolver.resolve({
      definition: value.fixture.input.definition,
      scope: value.fixture.input.scope,
    });

    expect(evidence.installationBinding).toEqual(value.fixture.binding);
    expect(evidence.sources).toEqual(value.fixture.input.sources);
    expect(evidence.artifacts).toEqual(
      [...value.fixture.input.artifacts].sort((left, right) =>
        `${left.artifactId}:${left.sha256}`.localeCompare(`${right.artifactId}:${right.sha256}`),
      ),
    );
    expect(
      validateReleasePolicyAuthority({
        ...evidence,
        at: value.fixture.input.at,
        definition: value.fixture.input.definition,
        publisherPrincipalId: value.fixture.input.publisherPrincipalId,
        scope: value.fixture.input.scope,
      }),
    ).toEqual({ findings: [], status: "valid" });
    expect(value.repository.findSourceSnapshot).toHaveBeenCalledWith(
      value.fixture.input.scope,
      value.fixture.source.sourceSnapshotId,
    );
    expect(value.repository.findSourceReview).toHaveBeenCalledWith(
      value.fixture.input.scope,
      value.fixture.review.sourceReviewId,
    );
    expect(value.repository.findSourceReviewerQualification).toHaveBeenCalledWith(
      value.fixture.input.scope,
      value.fixture.reviewer.qualificationId,
    );
  });

  it("represents missing records and missing availability facts as explicit fail-closed evidence", async () => {
    const value = setup();
    value.repository.findSourceSnapshot.mockResolvedValue(null);
    value.repository.findSourceReview.mockResolvedValue(null);
    value.artifactResolver.resolve.mockResolvedValue([]);
    const evidence = await value.resolver.resolve({
      definition: value.fixture.input.definition,
      scope: value.fixture.input.scope,
    });

    expect(evidence.sources).toEqual([
      {
        reference: value.fixture.input.definition.sources[0],
        review: null,
        reviewerQualification: null,
        source: null,
      },
    ]);
    expect(evidence.artifacts).toEqual([
      { ...value.fixture.binding.authorityEvidence, state: "unavailable" },
    ]);
    expect(
      validateReleasePolicyAuthority({
        ...evidence,
        at: value.fixture.input.at,
        definition: value.fixture.input.definition,
        publisherPrincipalId: value.fixture.input.publisherPrincipalId,
        scope: value.fixture.input.scope,
      }).findings.map(({ reason }) => reason),
    ).toEqual([
      "installation_authority_evidence_unavailable",
      "source_review_unavailable",
      "source_snapshot_unavailable",
    ]);
  });

  it("preserves semantic mismatches for deterministic authority findings", async () => {
    const value = setup();
    const definition = clone(value.fixture.input.definition);
    const expected = definition.sources[0];
    if (!expected) throw new Error("Expected policy source reference");
    const mismatched = {
      ...expected,
      source: { ...expected.source, definitionSha256: "9".repeat(64) },
    };
    definition.sources = [mismatched];
    definition.rules = definition.rules.map((rule) => ({ ...rule, sources: [mismatched] }));
    const evidence = await value.resolver.resolve({ definition, scope: value.fixture.input.scope });
    expect(
      validateReleasePolicyAuthority({
        ...evidence,
        at: value.fixture.input.at,
        definition,
        publisherPrincipalId: value.fixture.input.publisherPrincipalId,
        scope: value.fixture.input.scope,
      }).findings.map(({ reason }) => reason),
    ).toContain("source_reference_mismatch");
  });

  it("rejects corrupt or substituted source repository records", async () => {
    const value = setup();
    value.repository.findSourceSnapshot.mockResolvedValue({
      ...value.fixture.source,
      definitionSha256: "0".repeat(64),
    });
    await expect(
      value.resolver.resolve({
        definition: value.fixture.input.definition,
        scope: value.fixture.input.scope,
      }),
    ).rejects.toBeInstanceOf(ReleasePolicyAuthorityResolverContractError);

    const substituted = setup();
    const other = policyAuthorityFixture({
      mutateSource: (source) => {
        source.sourceSnapshotId = "source_substituted";
      },
    });
    substituted.repository.findSourceSnapshot.mockResolvedValue(other.source);
    await expect(
      substituted.resolver.resolve({
        definition: substituted.fixture.input.definition,
        scope: substituted.fixture.input.scope,
      }),
    ).rejects.toBeInstanceOf(ReleasePolicyAuthorityResolverContractError);
  });

  it("rejects malformed, duplicate, or unrequested artifact resolver claims", async () => {
    for (const output of [
      "not-an-array",
      [{ artifactId: "artifact_unknown", sha256: "1".repeat(64), state: "available" }],
    ]) {
      const value = setup();
      value.artifactResolver.resolve.mockResolvedValue(output as never);
      await expect(
        value.resolver.resolve({
          definition: value.fixture.input.definition,
          scope: value.fixture.input.scope,
        }),
      ).rejects.toBeInstanceOf(ReleasePolicyAuthorityResolverContractError);
    }

    const duplicate = setup();
    const artifact = duplicate.fixture.input.artifacts[0];
    if (!artifact) throw new Error("Expected policy authority artifact");
    duplicate.artifactResolver.resolve.mockResolvedValue([artifact, artifact]);
    await expect(
      duplicate.resolver.resolve({
        definition: duplicate.fixture.input.definition,
        scope: duplicate.fixture.input.scope,
      }),
    ).rejects.toBeInstanceOf(ReleasePolicyAuthorityResolverContractError);
  });

  it("distinguishes backend unavailability from invalid resolver output", async () => {
    const sourceFailure = setup();
    sourceFailure.repository.findSourceSnapshot.mockRejectedValue(
      new Error("database unavailable"),
    );
    await expect(
      sourceFailure.resolver.resolve({
        definition: sourceFailure.fixture.input.definition,
        scope: sourceFailure.fixture.input.scope,
      }),
    ).rejects.toBeInstanceOf(ReleasePolicyAuthorityResolutionError);

    const artifactFailure = setup();
    artifactFailure.artifactResolver.resolve.mockRejectedValue(
      new Error("artifact store unavailable"),
    );
    await expect(
      artifactFailure.resolver.resolve({
        definition: artifactFailure.fixture.input.definition,
        scope: artifactFailure.fixture.input.scope,
      }),
    ).rejects.toBeInstanceOf(ReleasePolicyAuthorityResolutionError);

    const bindingFailure = setup();
    const installationBindingResolver: PolicyInstallationBindingResolver = {
      resolve: vi.fn(async () => {
        throw new Error("operator registry unavailable");
      }),
    };
    const resolver = new RepositoryReleasePolicyAuthorityResolver({
      artifactResolver: bindingFailure.artifactResolver,
      installationBindingResolver,
      sourceRepository: bindingFailure.repository,
    });
    await expect(
      resolver.resolve({
        definition: bindingFailure.fixture.input.definition,
        scope: bindingFailure.fixture.input.scope,
      }),
    ).rejects.toBeInstanceOf(ReleasePolicyAuthorityResolutionError);
  });
});

describe("static policy installation binding registry", () => {
  it("isolates identical installation identifiers by exact tenant scope and returned value", async () => {
    const primary = policyAuthorityFixture();
    const secondary = policyAuthorityFixture({
      mutateBinding: (binding) => {
        binding.scope = {
          environmentId: "env_secondary",
          projectId: "project_secondary",
          tenantId: "tenant_secondary",
        };
      },
    });
    const registry = new StaticPolicyInstallationBindingResolver([
      primary.binding,
      secondary.binding,
    ]);
    const reference = primary.input.definition.installationBinding;
    const first = await registry.resolve({ reference, scope: primary.input.scope });
    const second = await registry.resolve({ reference, scope: secondary.binding.scope });
    expect(first).toEqual(primary.binding);
    expect(second).toEqual(secondary.binding);
    if (!first) throw new Error("Expected registered binding");
    (first as { authorizedIssuerPrincipalIds: string[] }).authorizedIssuerPrincipalIds.push(
      "principal_mutation",
    );
    expect(await registry.resolve({ reference, scope: primary.input.scope })).toEqual(
      primary.binding,
    );
    expect(
      await registry.resolve({
        reference,
        scope: { ...primary.input.scope, environmentId: "env_unknown" },
      }),
    ).toBeNull();
  });

  it("rejects duplicate, corrupt, or malformed registry configuration and queries", async () => {
    const fixture = policyAuthorityFixture();
    expect(
      () => new StaticPolicyInstallationBindingResolver([fixture.binding, fixture.binding]),
    ).toThrow(ReleasePolicyAuthorityResolverContractError);
    expect(
      () =>
        new StaticPolicyInstallationBindingResolver([
          { ...fixture.binding, definitionSha256: "0".repeat(64) },
        ]),
    ).toThrow(ReleasePolicyAuthorityResolverContractError);
    expect(() => new StaticPolicyInstallationBindingResolver("invalid" as never)).toThrow(
      ReleasePolicyAuthorityResolverContractError,
    );

    const registry = new StaticPolicyInstallationBindingResolver([fixture.binding]);
    await expect(
      registry.resolve({
        reference: {
          ...fixture.input.definition.installationBinding,
          installationId: "invalid ID",
        },
        scope: fixture.input.scope,
      }),
    ).rejects.toBeInstanceOf(InvalidReleasePolicyAuthorityInputError);
  });

  it("rejects an exact-query substitution from a custom installation resolver", async () => {
    const fixture = policyAuthorityFixture();
    const other = policyAuthorityFixture({
      mutateBinding: (binding) => {
        binding.bindingVersionId = "binding_substituted";
      },
    });
    const installationBindingResolver: PolicyInstallationBindingResolver = {
      resolve: vi.fn(async () => clone(other.binding as PolicyInstallationBinding)),
    };
    const resolver = new RepositoryReleasePolicyAuthorityResolver({
      artifactResolver: { resolve: vi.fn(async () => []) },
      installationBindingResolver,
      sourceRepository: sourceRepository(fixture),
    });
    await expect(
      resolver.resolve({ definition: fixture.input.definition, scope: fixture.input.scope }),
    ).rejects.toBeInstanceOf(ReleasePolicyAuthorityResolverContractError);
  });
});
