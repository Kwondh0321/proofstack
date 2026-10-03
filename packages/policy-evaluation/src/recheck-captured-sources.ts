import {
  inspectPolicyEvaluationArtifactCatalog,
  MAX_ENCRYPTED_ARTIFACT_OBJECT_BYTES,
} from "@proofstack/artifacts";
import {
  ArtifactContentReferenceSchema,
  type EvidenceScope,
  encodeEvaluationCanonicalJson,
  PolicyEvaluationTimeSchema,
  type PrincipalContext,
  type ReleasePolicy,
  type ReleasePolicyLifecycleEvent,
  policyEvaluationTimestampOrderKey,
} from "@proofstack/contracts";
import { inspectPolicyEvaluationControlRecord } from "@proofstack/core";
import { AcquisitionBudget } from "./acquisition-budget.js";
import { observeCapturedPolicyLifecycle } from "./capture-policy-lifecycle.js";
import { deriveCapturedPolicySourceGuards } from "./derive-source-guards.js";

/** Trusted same-connection ports; no content/key I/O, caller SQL or publication operation. */
export interface PolicyEvaluationSourceRecheckPorts {
  tryGuard(kind: "artifact" | "release_policy", id: string): Promise<boolean>;
  findArtifact(id: string): Promise<unknown>;
  findPolicy(id: string): Promise<unknown>;
  listPolicyHistory(id: string): Promise<unknown>;
  observationTime(): Promise<string>;
}

/** The adapter owns exact scope, READ COMMITTED, whole rollback and connection lifetime. */
export interface PolicyEvaluationSourceTransactions {
  run<T>(
    scope: EvidenceScope,
    operation: (ports: PolicyEvaluationSourceRecheckPorts) => Promise<T>,
  ): Promise<T>;
}

export interface PolicyEvaluationSourceRecheck {
  readonly status: "observations_rechecked";
  /** Database-owned exact time under guards, not a seal or a post-transaction freshness token. */
  readonly observedAt: string;
  readonly guards: number;
  readonly artifactReads: number;
  readonly policyReads: number;
}

export class PolicyEvaluationSourceRecheckError extends Error {
  readonly code = "policy_evaluation_source_recheck_failed";
  constructor(
    readonly reason:
      | "guard_unavailable"
      | "guard_invalid"
      | "source_revision_changed"
      | "clock_invalid",
    readonly identity?: string,
  ) {
    super(`Policy source recheck: ${reason}${identity ? ` (${identity})` : ""}`);
    this.name = "PolicyEvaluationSourceRecheckError";
  }
}

function canonical(value: unknown): string {
  return Buffer.from(encodeEvaluationCanonicalJson(value)).toString("utf8");
}

/** Internal request-owning composition. Never accepts a precomputed guard subset or public graph. */
export async function deriveAndRecheckCapturedPolicySources(
  input: Parameters<typeof deriveCapturedPolicySourceGuards>[0],
  budget: AcquisitionBudget,
  principal: PrincipalContext,
  captureCompletedAt: string,
  transactions?: PolicyEvaluationSourceTransactions,
) {
  const plan = deriveCapturedPolicySourceGuards(input, budget);
  if (!transactions) return plan;
  const { request, graph, artifacts, lifecycle } = input;
  const recheck = await transactions.run(structuredClone(request.scope), async (supplied) => {
    const ports = budget.wrap(supplied);
    for (const { kind, id } of plan.guards) {
      const acquired: unknown = await ports.tryGuard(kind, id);
      if (acquired !== true)
        throw new PolicyEvaluationSourceRecheckError(
          acquired === false ? "guard_unavailable" : "guard_invalid",
          JSON.stringify([kind, id]),
        );
    }
    // No authoritative read is allowed until the entire required guard set has succeeded.
    const policyRecords = new Map<string, unknown>();
    const artifactRecords = new Map<string, unknown>();
    for (const { kind, id, origins } of plan.guards) {
      if (kind === "release_policy") policyRecords.set(id, await ports.findPolicy(id));
      else {
        const origin = origins.find((origin) => origin.kind === "artifact_capture");
        const captured =
          origin?.kind === "artifact_capture" ? artifacts[origin.captureIndex] : undefined;
        // Derivation established complete origins. Unsupported references deliberately remain
        // unqueried, but their known IDs are still guarded; never waive other known coordinates.
        if (!captured) throw new PolicyEvaluationSourceRecheckError("source_revision_changed");
        if (ArtifactContentReferenceSchema.safeParse(captured.read.reference).success)
          artifactRecords.set(id, await ports.findArtifact(id));
      }
    }
    const history = await ports.listPolicyHistory(request.policy.policyVersionId);
    const observedAt = PolicyEvaluationTimeSchema.safeParse(await ports.observationTime());
    if (
      !observedAt.success ||
      policyEvaluationTimestampOrderKey(observedAt.data) <
        policyEvaluationTimestampOrderKey(captureCompletedAt)
    )
      throw new PolicyEvaluationSourceRecheckError("clock_invalid");
    for (const { read } of graph.nodes) {
      if (read.source.kind !== "release_policy") continue;
      const current = inspectPolicyEvaluationControlRecord(
        { source: read.source, scope: request.scope, evaluationTime: request.evaluationTime },
        policyRecords.get(read.source.reference.policyVersionId),
      );
      if (canonical(current.observation) !== canonical(read.observation))
        throw new PolicyEvaluationSourceRecheckError("source_revision_changed");
    }
    for (const { read } of artifacts) {
      const current = inspectPolicyEvaluationArtifactCatalog(
        {
          scope: request.scope,
          principal,
          reference: read.reference,
          evaluationTime: request.evaluationTime,
          maxReadBytes: MAX_ENCRYPTED_ARTIFACT_OBJECT_BYTES,
        },
        artifactRecords.has(read.reference.artifactId)
          ? artifactRecords.get(read.reference.artifactId)
          : null,
        observedAt.data,
      );
      const contentWasAttempted =
        read.observation.status === "verified" ||
        (read.observation.status === "unavailable" &&
          (read.observation.reason === "object_missing" ||
            read.observation.reason === "content_integrity_failed"));
      if (
        canonical(current.catalog) !== canonical(read.catalog) ||
        (contentWasAttempted
          ? current.observation.status !== "content_pending"
          : canonical(current.observation) !== canonical(read.observation))
      )
        throw new PolicyEvaluationSourceRecheckError("source_revision_changed");
    }
    // Compare complete history before resolving any successor. A newly introduced successor
    // cannot be queried under a guard set that did not contain its identity.
    if (canonical(history) !== canonical(lifecycle.history.map(({ record }) => record)))
      throw new PolicyEvaluationSourceRecheckError("source_revision_changed");
    // Policy/event receipt contracts are milliseconds. Retain the full DB cut for artifact
    // receipt/expiry comparison; a Date here is only the owning lifecycle reader's clock port.
    const currentLifecycle = await observeCapturedPolicyLifecycle(
      graph,
      {
        findReleasePolicy: async (_scope, id) =>
          structuredClone(policyRecords.get(id)) as ReleasePolicy | null,
        listReleasePolicyLifecycleEvents: async () =>
          structuredClone(history) as ReleasePolicyLifecycleEvent[],
      },
      { now: () => new Date(observedAt.data) },
    );
    if (currentLifecycle.observationSha256 !== lifecycle.observationSha256)
      throw new PolicyEvaluationSourceRecheckError("source_revision_changed");
    return {
      status: "observations_rechecked" as const,
      observedAt: observedAt.data,
      guards: plan.guards.length,
      artifactReads: artifactRecords.size,
      policyReads: policyRecords.size,
    } satisfies PolicyEvaluationSourceRecheck;
  });
  // The read transaction has ended here. This observation report is NOT a publication authority.
  return { ...plan, recheck };
}
