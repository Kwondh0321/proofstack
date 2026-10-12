import {
  encodeEvaluationCanonicalJson,
  type EvidenceScope,
  type EndpointProfileRecord,
  EvidenceScopeSchema,
  type PolicyEvaluationManifestEntry,
  PolicyEvaluationManifestEntrySchema,
  type PolicyEvaluationSourceReference,
  policyEvaluationSourceReferenceKey,
  PolicyEvaluationTimeSchema,
  serializeEvaluationCanonicalJson,
  type RegressionDatasetVersion,
  type ReplayPlan,
  type RuntimeDefinitionRecord,
  type TargetRelease,
} from "@proofstack/contracts";
import {
  inspectPolicyEvaluationRuntimeRecord,
  inspectPolicyEvaluationRuntimeCapture,
  inspectPolicyEvaluationEndpointProfileRecord,
  inspectPolicyEvaluationEndpointProfileCapture,
  type PolicyEvaluationEndpointProfileCapture,
  type PolicyEvaluationDefinitionCapture,
  type PolicyEvaluationEndpointProfileRead,
  type PolicyEvaluationDefinitionRead,
  type PolicyEvaluationDefinitionReadInput,
  PolicyEvaluationEvidenceReferenceError,
  type PolicyEvaluationEvidenceReferenceLimits,
  PolicyEvaluationReferenceCollector,
  type PolicyEvaluationRuntimeRead,
  type PolicyEvaluationRuntimeCapture,
  revalidatePolicyEvaluationCapturedRecord,
  revalidatePolicyEvaluationCapturedStorage,
} from "@proofstack/core";
import {
  inspectPolicyEvaluationDataset,
  inspectPolicyEvaluationDatasetCapture,
  type PolicyEvaluationDatasetCapture,
  type PolicyEvaluationDatasetRead,
  type PolicyEvaluationDatasetRecord,
} from "@proofstack/datasets";
import {
  inspectPolicyEvaluationReplayDefinition,
  inspectPolicyEvaluationReplayDefinitionCapture,
  type PolicyEvaluationReplayDefinitionCapture,
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
      | "replay_isolation_profile"
      | "endpoint_profile";
  }
>;
type RecordBody =
  | EndpointProfileRecord
  | ReplayPlan
  | TargetRelease
  | PolicyEvaluationDatasetRecord
  | RuntimeDefinitionRecord;
type Read = PolicyEvaluationDefinitionRead<RecordBody, Source>;
type Capture = PolicyEvaluationDefinitionCapture<RecordBody, Source>;
type Context = { readonly scope: EvidenceScope; readonly evaluationTime: string };

function sameCanonicalValue(left: unknown, right: unknown): boolean {
  return Buffer.from(encodeEvaluationCanonicalJson(left)).equals(
    encodeEvaluationCanonicalJson(right),
  );
}

export type PolicyReplayPlanBindingRead =
  | PolicyEvaluationEndpointProfileRead
  | PolicyEvaluationReplayDefinitionRead
  | PolicyEvaluationDatasetRead
  | PolicyEvaluationRuntimeRead;

export type PolicyStoredReplayPlanBindingCapture =
  | PolicyEvaluationEndpointProfileCapture
  | PolicyEvaluationReplayDefinitionCapture
  | PolicyEvaluationDatasetCapture
  | PolicyEvaluationRuntimeCapture;

export interface PolicyReplayPlanCheck {
  readonly path: string;
  readonly kind:
    | "runtime_family"
    | "runtime_configuration"
    | "boundary_kind"
    | "boundary_mode"
    | "invocation_digest"
    | "fixture_membership"
    | "fixture_format"
    | "endpoint_destination"
    | "endpoint_operation"
    | "endpoint_boundary_kind";
  readonly observation:
    | { readonly status: "matched" }
    | { readonly status: "unavailable" }
    | { readonly status: "mismatch" };
}

export interface PolicyReplayPlanBindings {
  /** Repeated plan inputs, to be admitted by the request-owning composition. */
  readonly inspectionUsage: { readonly references: number; readonly referenceBytes: number };
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

export interface PolicyStoredReplayPlanBindings {
  readonly authorityBoundary: "stored_relationships_only";
  readonly scope: EvidenceScope;
  readonly evaluationTime: string;
  readonly plans: readonly {
    readonly source: Extract<Source, { kind: "replay_plan" }>;
    readonly recordSha256: string;
    readonly receiptTime: string;
    readonly recordObservation: Observation;
    readonly dependencies: readonly (PolicyReplayPlanBindings["plans"][number]["dependencies"][number] & {
      readonly storage: { readonly recordSha256: string; readonly receiptTime: string } | null;
    })[];
    readonly checks: readonly PolicyReplayPlanCheck[];
  }[];
  readonly unavailablePlans: PolicyReplayPlanBindings["unavailablePlans"];
  readonly inspectionUsage: { readonly references: number; readonly referenceBytes: number };
}

function inspectStorage(input: PolicyEvaluationDefinitionReadInput<Source>, raw: unknown): Capture {
  const { source, ...context } = input;
  switch (source.kind) {
    case "endpoint_profile":
      return inspectPolicyEvaluationEndpointProfileCapture({ ...context, source }, raw);
    case "replay_plan":
    case "target_release":
      return inspectPolicyEvaluationReplayDefinitionCapture({ ...context, source }, raw);
    case "dataset_version":
    case "regression_fixture_version":
      return inspectPolicyEvaluationDatasetCapture({ ...context, source }, raw);
    case "replay_runtime_profile":
    case "replay_isolation_profile":
      return inspectPolicyEvaluationRuntimeCapture({ ...context, source }, raw) as Capture;
  }
}

function inspect(input: PolicyEvaluationDefinitionReadInput<Source>, raw: unknown): Read {
  const { source, ...context } = input;
  switch (source.kind) {
    case "endpoint_profile":
      return inspectPolicyEvaluationEndpointProfileRecord({ ...context, source }, raw);
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
      source.kind !== "replay_isolation_profile" &&
      source.kind !== "endpoint_profile"
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
      const checks = inspectPlanChecks(plan, resolve);
      plans.push({
        source: read.source,
        recordSha256: read.observation.recordSha256,
        dependencies,
        checks,
      });
    }
    const usage = out.result();
    return {
      plans,
      unavailablePlans,
      inspectionUsage: {
        references: usage.references.length,
        referenceBytes: usage.referenceBytes,
      },
    };
  } catch (cause) {
    if (cause instanceof PolicyEvaluationEvidenceReferenceError) throw cause;
    throw new PolicyEvaluationEvidenceReferenceError("input_invalid", { cause });
  }
}

/** Original plan relationships at the unchanged semantic cut; never execution or a seal. */
export function inspectPolicyEvaluationStoredReplayPlanBindings(
  input: Context,
  evidence: readonly PolicyStoredReplayPlanBindingCapture[],
  limits: PolicyEvaluationEvidenceReferenceLimits,
): PolicyStoredReplayPlanBindings {
  try {
    new PolicyEvaluationReferenceCollector(limits);
    if (!input || Reflect.ownKeys(input).length !== 2 || !Array.isArray(evidence))
      throw new PolicyEvaluationEvidenceReferenceError("input_invalid");
    const context = {
      scope: EvidenceScopeSchema.parse(input.scope),
      evaluationTime: PolicyEvaluationTimeSchema.parse(input.evaluationTime),
    };
    let references = 0;
    let referenceBytes = 0;
    const admit = (value: unknown, count: number) => {
      if (count > limits.maxReferences - references)
        throw new PolicyEvaluationEvidenceReferenceError("reference_limit_exceeded");
      const bytes = Buffer.byteLength(serializeEvaluationCanonicalJson(value), "utf8");
      if (bytes > limits.maxReferenceBytes - referenceBytes)
        throw new PolicyEvaluationEvidenceReferenceError("reference_bytes_exceeded");
      references += count;
      referenceBytes += bytes;
    };
    admit(context, 1);
    if (evidence.length > limits.maxReferences - references)
      throw new PolicyEvaluationEvidenceReferenceError("reference_limit_exceeded");
    const records = new Map<string, Capture>();
    for (let index = 0; index < evidence.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(evidence, index);
      if (!descriptor?.enumerable || !("value" in descriptor))
        throw new PolicyEvaluationEvidenceReferenceError("input_invalid");
      const capture = descriptor.value as Capture;
      if (
        !capture ||
        Reflect.ownKeys(capture).length !== 2 ||
        !["read", "storage"].every((key) => {
          const property = Object.getOwnPropertyDescriptor(capture, key);
          return property?.enumerable && "value" in property;
        }) ||
        !capture.read ||
        Reflect.ownKeys(capture.read).length !== 3
      )
        throw new PolicyEvaluationEvidenceReferenceError("input_invalid");
      admit(capture, 1);
      const entry = PolicyEvaluationManifestEntrySchema.parse({
        source: capture.read.source,
        observation: capture.read.observation,
      });
      const { source } = entry;
      if (
        source.kind !== "replay_plan" &&
        source.kind !== "target_release" &&
        source.kind !== "dataset_version" &&
        source.kind !== "regression_fixture_version" &&
        source.kind !== "replay_runtime_profile" &&
        source.kind !== "replay_isolation_profile" &&
        source.kind !== "endpoint_profile"
      )
        throw new PolicyEvaluationEvidenceReferenceError("input_invalid");
      const key = policyEvaluationSourceReferenceKey(source);
      if (records.has(key))
        throw new PolicyEvaluationEvidenceReferenceError("observation_mismatch");
      if (capture.storage === null) {
        if (
          capture.read.record !== null ||
          entry.observation.status === "verified" ||
          (entry.observation.status === "unavailable" &&
            entry.observation.reason === "not_yet_available")
        )
          throw new PolicyEvaluationEvidenceReferenceError("observation_mismatch");
        records.set(key, structuredClone(capture));
      } else {
        records.set(
          key,
          revalidatePolicyEvaluationCapturedStorage(
            { ...context, source },
            capture,
            inspectStorage,
          ),
        );
      }
    }
    const out = new PolicyEvaluationReferenceCollector({
      maxReferences: limits.maxReferences - references,
      maxReferenceBytes: limits.maxReferenceBytes - referenceBytes,
    });
    const plans: PolicyStoredReplayPlanBindings["plans"][number][] = [];
    const unavailablePlans: PolicyStoredReplayPlanBindings["unavailablePlans"][number][] = [];
    const ordered = [...records.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
    for (const [, capture] of ordered) {
      if (capture.read.source.kind !== "replay_plan") continue;
      if (capture.storage === null) {
        unavailablePlans.push({
          source: capture.read.source,
          observation: capture.read.observation as Exclude<Observation, { status: "verified" }>,
        });
        continue;
      }
      const dependencies: PolicyStoredReplayPlanBindings["plans"][number]["dependencies"][number][] =
        [];
      const resolve = (path: string, source: Source): RecordBody | null => {
        out.record(path, source.kind, source.reference);
        const child = records.get(policyEvaluationSourceReferenceKey(source));
        if (!child || !sameCanonicalValue(child.read.source, source))
          throw new PolicyEvaluationEvidenceReferenceError("observation_mismatch");
        dependencies.push({
          path,
          source,
          recordObservation: child.read.observation,
          storage: child.storage
            ? { recordSha256: child.storage.recordSha256, receiptTime: child.storage.receiptTime }
            : null,
        });
        return child.storage?.record ?? null;
      };
      const checks = inspectPlanChecks(capture.storage.record as ReplayPlan, resolve);
      plans.push({
        source: capture.read.source,
        recordSha256: capture.storage.recordSha256,
        receiptTime: capture.storage.receiptTime,
        recordObservation: capture.read.observation,
        dependencies,
        checks,
      });
    }
    const usage = out.result();
    references += usage.references.length;
    referenceBytes += usage.referenceBytes;
    const report = {
      authorityBoundary: "stored_relationships_only" as const,
      ...context,
      plans,
      unavailablePlans,
    };
    admit(report, 0);
    return structuredClone({ ...report, inspectionUsage: { references, referenceBytes } });
  } catch (cause) {
    if (cause instanceof PolicyEvaluationEvidenceReferenceError) throw cause;
    throw new PolicyEvaluationEvidenceReferenceError("input_invalid", { cause });
  }
}

/** Shared original-body relationship rules; no time selection or availability promotion. */
function inspectPlanChecks(
  plan: ReplayPlan,
  resolve: (path: string, source: Source) => RecordBody | null,
): PolicyReplayPlanCheck[] {
  const checks: PolicyReplayPlanCheck[] = [];
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
    if (boundary.mode === "live_provider") {
      const endpoint = resolve(`${path}/endpointProfile`, {
        kind: "endpoint_profile",
        reference: boundary.endpointProfile,
      }) as EndpointProfileRecord | null;
      check(
        "endpoint_destination",
        `${path}/destination`,
        endpoint ? sameCanonicalValue(endpoint.destination, boundary.destination) : null,
      );
      check(
        "endpoint_operation",
        `${path}/operation`,
        endpoint ? endpoint.operations.includes(boundary.operation) : null,
      );
      check(
        "endpoint_boundary_kind",
        `${path}/kind`,
        endpoint ? endpoint.boundaryKinds.includes(boundary.kind) : null,
      );
    } else if (boundary.mode === "simulation") {
      resolve(`${path}/simulatorRelease`, {
        kind: "target_release",
        reference: boundary.simulatorRelease,
      });
    } else {
      // The owning strict union has exactly three modes. This exhaustive remaining branch
      // keeps a future mode addition a type error until its bindings are handled explicitly.
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
  return checks;
}
