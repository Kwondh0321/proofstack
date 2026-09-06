import { execFile } from "node:child_process";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";
import {
  EvidenceScopeSchema,
  ReleaseCandidateAdapterReferenceSchema,
  ReleaseCandidateModelDeclarationSchema,
  ReleaseCandidateSourceSchema,
  type EvidenceScope,
  type ReleaseCandidateAdapterReference,
  type ReleaseCandidateModelDeclaration,
} from "@proofstack/contracts";
import { z } from "zod";
import type {
  ReleaseCandidateRevisionAuthority,
  ReleaseCandidateRevisionReference,
  ReleaseCandidateRuntimeAuthority,
  ReleaseCandidateRuntimeReference,
} from "./repository-release-candidate-source-resolver.js";

const execFileAsync = promisify(execFile);
const MAX_AUTHORITY_ENTRIES = 256;

const LocalGitRepositoryRegistrationSchema = z
  .object({
    checkoutPath: z
      .string()
      .min(1)
      .max(4_096)
      .refine(isAbsolute, "Git authority checkout path must be absolute"),
    repositoryUrl: ReleaseCandidateSourceSchema.shape.repositoryUrl,
    scope: EvidenceScopeSchema,
  })
  .strict();

const StaticModelDeclarationRegistrationSchema = z
  .object({
    declaration: ReleaseCandidateModelDeclarationSchema,
    scope: EvidenceScopeSchema,
  })
  .strict();

const StaticRuntimeAdapterRegistrationSchema = z
  .object({
    adapter: ReleaseCandidateAdapterReferenceSchema,
    scope: EvidenceScopeSchema,
  })
  .strict();

export type LocalGitRepositoryRegistration = z.infer<typeof LocalGitRepositoryRegistrationSchema>;
export type StaticModelDeclarationRegistration = z.infer<
  typeof StaticModelDeclarationRegistrationSchema
>;
export type StaticRuntimeAdapterRegistration = z.infer<
  typeof StaticRuntimeAdapterRegistrationSchema
>;

export interface LocalGitReleaseCandidateRevisionAuthorityOptions {
  readonly repositories: readonly LocalGitRepositoryRegistration[];
}

export interface StaticReleaseCandidateRuntimeAuthorityOptions {
  readonly modelDeclarations: readonly StaticModelDeclarationRegistration[];
  readonly runtimeAdapters: readonly StaticRuntimeAdapterRegistration[];
}

interface GitCommandRunner {
  run(checkoutPath: string, arguments_: readonly string[]): Promise<string>;
}

const processGitCommandRunner: GitCommandRunner = {
  async run(checkoutPath, arguments_) {
    const result = await execFileAsync("git", ["-C", checkoutPath, ...arguments_], {
      encoding: "utf8",
      maxBuffer: 64 * 1_024,
      timeout: 5_000,
      windowsHide: true,
    });
    return result.stdout;
  },
};

function scopeKey(scope: EvidenceScope): string {
  return JSON.stringify([scope.tenantId, scope.projectId, scope.environmentId]);
}

function repositoryKey(scope: EvidenceScope, repositoryUrl: string): string {
  return JSON.stringify([scopeKey(scope), repositoryUrl]);
}

function modelKey(scope: EvidenceScope, declaration: ReleaseCandidateModelDeclaration): string {
  return JSON.stringify([scopeKey(scope), declaration]);
}

function adapterKey(scope: EvidenceScope, adapter: ReleaseCandidateAdapterReference): string {
  return JSON.stringify([scopeKey(scope), adapter]);
}

function parseBoundedUnique<Schema extends z.ZodType>(
  schema: Schema,
  values: readonly z.input<Schema>[],
  keyFor: (value: z.output<Schema>) => string,
  label: string,
): z.output<Schema>[] {
  if (values.length > MAX_AUTHORITY_ENTRIES) {
    throw new TypeError(`${label} cannot exceed ${MAX_AUTHORITY_ENTRIES} entries`);
  }
  const parsed = values.map((value) => schema.parse(value));
  const keys = new Set<string>();
  for (const value of parsed) {
    const key = keyFor(value);
    if (keys.has(key)) throw new TypeError(`${label} must not contain duplicate bindings`);
    keys.add(key);
  }
  return parsed;
}

/**
 * Resolves immutable Git subjects from operator-allowlisted local repositories without network
 * access. The requested commit and tree must both exist, use the repository's object format, and
 * have an exact commit-to-tree relationship. A branch, tag, abbreviated object ID, or URL alone is
 * never authoritative.
 */
export class LocalGitReleaseCandidateRevisionAuthority
  implements ReleaseCandidateRevisionAuthority
{
  readonly #repositories: ReadonlyMap<string, string>;
  readonly #runner: GitCommandRunner;

  constructor(
    options: LocalGitReleaseCandidateRevisionAuthorityOptions,
    runner: GitCommandRunner = processGitCommandRunner,
  ) {
    const registrations = parseBoundedUnique(
      LocalGitRepositoryRegistrationSchema,
      options.repositories,
      ({ repositoryUrl, scope }) => repositoryKey(scope, repositoryUrl),
      "Git authority repositories",
    );
    this.#repositories = new Map(
      registrations.map(({ checkoutPath, repositoryUrl, scope }) => [
        repositoryKey(scope, repositoryUrl),
        checkoutPath,
      ]),
    );
    this.#runner = runner;
  }

  async isAvailable(
    scopeInput: EvidenceScope,
    reference: ReleaseCandidateRevisionReference,
  ): Promise<boolean> {
    try {
      const scope = EvidenceScopeSchema.parse(scopeInput);
      const source = ReleaseCandidateSourceSchema.parse(reference.source);
      const checkoutPath = this.#repositories.get(repositoryKey(scope, source.repositoryUrl));
      if (!checkoutPath) return false;

      const objectFormat = (
        await this.#runner.run(checkoutPath, ["rev-parse", "--show-object-format"])
      ).trim();
      if (objectFormat !== source.commit.algorithm || objectFormat !== source.tree.algorithm) {
        return false;
      }

      const commit = (
        await this.#runner.run(checkoutPath, [
          "rev-parse",
          "--verify",
          `${source.commit.value}^{commit}`,
        ])
      ).trim();
      const tree = (
        await this.#runner.run(checkoutPath, [
          "rev-parse",
          "--verify",
          `${source.tree.value}^{tree}`,
        ])
      ).trim();
      const commitTree = (
        await this.#runner.run(checkoutPath, [
          "show",
          "--no-patch",
          "--format=%T",
          source.commit.value,
        ])
      ).trim();

      return commit === source.commit.value && tree === source.tree.value && commitTree === tree;
    } catch {
      return false;
    }
  }
}

/**
 * Resolves model declarations and adapter definitions from an immutable copy of operator-owned
 * configuration. Candidate-authored roles are intentionally not registry authority; scope and the
 * full provider, resolution, adapter version, and definition digest must match exactly.
 */
export class StaticReleaseCandidateRuntimeAuthority implements ReleaseCandidateRuntimeAuthority {
  readonly #adapters: ReadonlySet<string>;
  readonly #models: ReadonlySet<string>;

  constructor(options: StaticReleaseCandidateRuntimeAuthorityOptions) {
    const models = parseBoundedUnique(
      StaticModelDeclarationRegistrationSchema,
      options.modelDeclarations,
      ({ declaration, scope }) => modelKey(scope, declaration),
      "Runtime authority model declarations",
    );
    const adapters = parseBoundedUnique(
      StaticRuntimeAdapterRegistrationSchema,
      options.runtimeAdapters,
      ({ adapter, scope }) => adapterKey(scope, adapter),
      "Runtime authority adapters",
    );
    this.#models = new Set(models.map(({ declaration, scope }) => modelKey(scope, declaration)));
    this.#adapters = new Set(adapters.map(({ adapter, scope }) => adapterKey(scope, adapter)));
  }

  async isAvailable(
    scopeInput: EvidenceScope,
    reference: ReleaseCandidateRuntimeReference,
  ): Promise<boolean> {
    try {
      const scope = EvidenceScopeSchema.parse(scopeInput);
      if (reference.kind === "model_declaration") {
        const declaration = ReleaseCandidateModelDeclarationSchema.parse({
          providerId: reference.providerId,
          providerModelId: reference.providerModelId,
          resolution: reference.resolution,
        });
        return this.#models.has(modelKey(scope, declaration));
      }
      const adapter = ReleaseCandidateAdapterReferenceSchema.parse(reference.adapter);
      return this.#adapters.has(adapterKey(scope, adapter));
    } catch {
      return false;
    }
  }
}
