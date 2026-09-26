import {
  encodeEvaluationCanonicalJson,
  type EvidenceScope,
  EvidenceScopeSchema,
  type PolicyEvaluationManifestEntry,
  PolicyEvaluationManifestEntrySchema,
  type PolicyEvaluationSourceReference,
  policyEvaluationSourceReferenceKey,
  PolicyEvaluationTimeSchema,
  type RegressionDatasetVersion,
  type ReplayPlan,
  type RuntimeDefinitionRecord,
  type TargetRelease,
} from "@proofstack/contracts";
import {
  inspectPolicyEvaluationRuntimeRecord,
  type PolicyEvaluationDefinitionRead,
  type PolicyEvaluationDefinitionReadInput,
  PolicyEvaluationEvidenceReferenceError,
  type PolicyEvaluationEvidenceReferenceLimits,
  PolicyEvaluationReferenceCollector,
  type PolicyEvaluationRuntimeRead,
  revalidatePolicyEvaluationCapturedRecord,
} from "@proofstack/core";
import {
  inspectPolicyEvaluationDataset,
  type PolicyEvaluationDatasetRead,
  type PolicyEvaluationDatasetRecord,
} from "@proofstack/datasets";
import {
  inspectPolicyEvaluationReplayDefinition,
  type PolicyEvaluationReplayDefinitionRead,
} from "./policy-evaluation-replay-definition-reader.js";
import { digestRecordedBoundaryReplayInvocationDefinition } from "./replay-digest.js";

type Observation = PolicyEvaluationManifestEntry["observation"];
type Source = Extract<
  PolicyEvaluationSourceReference,
  {
    kind:
      | "replay_plan"
      | "target_release"
      | "dataset_version"
      | "regression_fixture_version"
      | "replay_runtime_profile"
      | "replay_isolation_profile";
  }
>;
type RecordBody =
  | ReplayPlan
  | TargetRelease
  | PolicyEvaluationDatasetRecord
  | RuntimeDefinitionRecord;
type Read = PolicyEvaluationDefinitionRead<RecordBody, Source>;
type Context = { readonly scope: EvidenceScope; readonly evaluationTime: string };

function sameCanonicalValue(left: unknown, right: unknown): boolean {
  return Buffer.from(encodeEvaluationCanonicalJson(left)).equals(
    encodeEvaluationCanonicalJson(right),
  );
}

export type PolicyReplayPlanBindingRead =
  | PolicyEvaluationReplayDefinitionRead
  | PolicyEvaluationDatasetRead
  | PolicyEvaluationRuntimeRead;

export interface PolicyReplayPlanCheck {
  readonly path: string;
  readonly kind:
    | "runtime_family"
    | "runtime_configuration"
    | "boundary_kind"
    | "boundary_mode"
    | "invocation_digest"
    | "fixture_membership"
    | "fixture_format";
  readonly observation:
    | { readonly status: "matched" }
    | { readonly status: "unavailable" }
    | { readonly status: "mismatch" };
}

export interface PolicyReplayPlanBindings {
  readonly plans: readonly {
    readonly source: Extract<Source, { kind: "replay_plan" }>;
    readonly recordSha256: string;
    readonly dependencies: readonly {
      readonly path: string;
      readonly source: Source;
      readonly recordObservation: Observation;
    }[];
    readonly checks: readonly PolicyReplayPlanCheck[];
  }[];
  readonly unavailablePlans: readonly {
    readonly source: Extract<Source, { kind: "replay_plan" }>;
    readonly observation: Exclude<Observation, { status: "verified" }>;
  }[];
}

function inspect(input: PolicyEvaluationDefinitionReadInput<Source>, raw: unknown): Read {
  const { source, ...context } = input;
  switch (source.kind) {
    case "replay_plan":
    case "target_release":
      return inspectPolicyEvaluationReplayDefinition({ ...context, source }, raw);
    case "dataset_version":
    case "regression_fixture_version":
      return inspectPolicyEvaluationDataset({ ...context, source }, raw);
    case "replay_runtime_profile":
    case "replay_isolation_profile":
      return inspectPolicyEvaluationRuntimeRecord({ ...context, source }, raw) as Read;
  }
}

function inventory(
  context: Context,
  evidence: readonly PolicyReplayPlanBindingRead[],
): Map<string, Read> {
  const records = new Map<string, Read>();
  for (const read of evidence) {
    if (
      !read ||
      Reflect.ownKeys(read).length !== 3 ||
      !["record", "source", "observation"].every((key) => {
        const property = Object.getOwnPropertyDescriptor(read, key);
        return property?.enumerable && "value" in property;
      })
    )
      throw new PolicyEvaluationEvidenceReferenceError("input_invalid");
    const entry = PolicyEvaluationManifestEntrySchema.parse({
      source: read.source,
      observation: read.observation,
    });
    const { source } = entry;
    if (
      source.kind !== "replay_plan" &&
      source.kind !== "target_release" &&
      source.kind !== "dataset_version" &&
      source.kind !== "regression_fixture_version" &&
      source.kind !== "replay_runtime_profile" &&
      source.kind !== "replay_isolation_profile"
    )
      throw new PolicyEvaluationEvidenceReferenceError("input_invalid");
    const key = policyEvaluationSourceReferenceKey(source);
    if (records.has(key)) throw new PolicyEvaluationEvidenceReferenceError("observation_mismatch");
    if (entry.observation.status === "verified") {
      records.set(
        key,
        revalidatePolicyEvaluationCapturedRecord<
          PolicyEvaluationDefinitionReadInput<Source>,
          RecordBody,
          Source
        >({ ...context, source }, read as Read, inspect),
      );
    } else {
      if (read.record !== null)
        throw new PolicyEvaluationEvidenceReferenceError("observation_mismatch");
      records.set(key, { source, observation: entry.observation, record: null });
    }
  }
  return records;
}

/**
 * Inspects captured plan bindings without executing a target, resolving credentials, or rereading
 * repositories. Each unique body is revalidated once. Direct matches are not full lineage,
 * installed runtime authority, historical execution proof, or policy satisfaction.
 */
export function inspectPolicyEvaluationReplayPlanBindings(
  input: Context,
  evidence: readonly PolicyReplayPlanBindingRead[],
  limits: PolicyEvaluationEvidenceReferenceLimits,
): PolicyReplayPlanBindings {
  try {
    const out = new PolicyEvaluationReferenceCollector(limits);
    if (
      !input ||
      Object.keys(input).some((key) => key !== "scope" && key !== "evaluationTime") ||
      !Array.isArray(evidence)
    )
      throw new PolicyEvaluationEvidenceReferenceError("input_invalid");
    if (evidence.length > limits.maxReferences)
      throw new PolicyEvaluationEvidenceReferenceError("reference_limit_exceeded");
    const context = {
      scope: EvidenceScopeSchema.parse(input.scope),
      evaluationTime: PolicyEvaluationTimeSchema.parse(input.evaluationTime),
    };
    const records = inventory(context, evidence);
    const plans: PolicyReplayPlanBindings["plans"][number][] = [];
    const unavailablePlans: PolicyReplayPlanBindings["unavailablePlans"][number][] = [];
    const ordered = [...records.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
    for (const [, read] of ordered) {
      if (read.source.kind !== "replay_plan") continue;
      if (read.observation.status !== "verified") {
        unavailablePlans.push({ source: read.source, observation: read.observation });
        continue;
      }
      const plan = read.record as ReplayPlan;
      const dependencies: PolicyReplayPlanBindings["plans"][number]["dependencies"][number][] = [];
      const checks: PolicyReplayPlanCheck[] = [];
      const resolve = (path: string, source: Source): RecordBody | null => {
        out.record(path, source.kind, source.reference);
        const captured = records.get(policyEvaluationSourceReferenceKey(source));
        if (!captured || !sameCanonicalValue(captured.source, source))
          throw new PolicyEvaluationEvidenceReferenceError("observation_mismatch");
        dependencies.push({
          path,
          source,
          recordObservation: structuredClone(captured.observation),
        });
        return captured.record;
      };
      const check = (kind: PolicyReplayPlanCheck["kind"], path: string, match: boolean | null) => {
        checks.push({
          kind,
          path,
          observation: { status: match === null ? "unavailable" : match ? "matched" : "mismatch" },
        });
      };
      const dataset = resolve("/dataset", {
        kind: "dataset_version",
        reference: plan.dataset,
      }) as RegressionDatasetVersion | null;
      const runtime = resolve("/runtimeProfile", {
        kind: "replay_runtime_profile",
        reference: plan.runtimeProfile,
      }) as Extract<RuntimeDefinitionRecord, { recordKind: "replay_runtime_profile" }> | null;
      resolve("/isolationProfile", {
        kind: "replay_isolation_profile",
        reference: plan.isolationProfile,
      });
      const target = resolve("/targetRelease", {
        kind: "target_release",
        reference: plan.targetRelease,
      }) as TargetRelease | null;
      check(
        "runtime_family",
        "/runtimeProfile/family",
        target ? plan.runtimeProfile.family === target.runtime.family : null,
      );
      check(
        "runtime_configuration",
        "/runtimeProfile",
        target && runtime
          ? sameCanonicalValue(runtime.runtime, {
              architecture: target.runtime.architecture,
              platform: target.runtime.platform,
              version: target.runtime.version,
            })
          : null,
      );
      for (const [index, boundary] of plan.boundaries.entries()) {
        const path = `/boundaries/${index}`;
        check(
          "boundary_kind",
          `${path}/kind`,
          target ? target.supportedBoundaryKinds.includes(boundary.kind) : null,
        );
        check(
          "boundary_mode",
          `${path}/mode`,
          target ? target.supportedBoundaryModes.includes(boundary.mode) : null,
        );
        if (boundary.mode === "simulation") {
          resolve(`${path}/simulatorRelease`, {
            kind: "target_release",
            reference: boundary.simulatorRelease,
          });
        } else if (boundary.mode === "recorded_stub") {
          check(
            "invocation_digest",
            `${path}/invocationDefinitionSha256`,
            digestRecordedBoundaryReplayInvocationDefinition(boundary.invocation) ===
              boundary.invocationDefinitionSha256,
          );
          const fixture = resolve(`${path}/invocation/fixture`, {
            kind: "regression_fixture_version",
            reference: boundary.invocation.fixture,
          }) as PolicyEvaluationDatasetRecord | null;
          check(
            "fixture_membership",
            `${path}/invocation/fixture`,
            dataset
              ? dataset.fixtureVersions.some((member) =>
                  sameCanonicalValue(member, boundary.invocation.fixture),
                )
              : null,
          );
          check(
            "fixture_format",
            `${path}/invocation/fixture`,
            fixture ? fixture.schemaVersion === "0.2" : null,
          );
        }
      }
      plans.push({
        source: read.source,
        recordSha256: read.observation.recordSha256,
        dependencies,
        checks,
      });
    }
    return { plans, unavailablePlans };
  } catch (cause) {
    if (cause instanceof PolicyEvaluationEvidenceReferenceError) throw cause;
    throw new PolicyEvaluationEvidenceReferenceError("input_invalid", { cause });
  }
}
