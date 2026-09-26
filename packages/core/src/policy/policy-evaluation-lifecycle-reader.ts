import { createHash } from "node:crypto";
import {
  type EvidenceScope,
  encodeEvaluationCanonicalJson,
  policyEvaluationTimestampOrderKey,
  type ReleasePolicy,
  type ReleasePolicyLifecycleEvent,
  type ReleasePolicyReference,
} from "@proofstack/contracts";
import type { Clock } from "../clock.js";
import {
  inspectPolicyEvaluationControlRecord,
  type PolicyEvaluationControlRead,
} from "./policy-evaluation-control-record-reader.js";
import { ReleasePolicyRepositoryContractError } from "./release-policy-errors.js";
import {
  releasePolicyReference,
  validateReleasePolicyLifecycleEvent,
  validateReleasePolicyRecord,
} from "./release-policy-record-validation.js";
import type { ReleasePolicyRepository } from "./release-policy-repository.js";

export type PolicyLifecycleReadRepository = Pick<
  ReleasePolicyRepository,
  "findReleasePolicy" | "listReleasePolicyLifecycleEvents"
>;

export interface PolicyLifecycleObservation {
  readonly scope: EvidenceScope;
  readonly policy: ReleasePolicyReference;
  readonly policyRecordSha256: string;
  readonly evaluationTime: string;
  readonly startedAt: string;
  readonly completedAt: string;
  /** Fingerprint of observed records, NOT an atomic database revision or a sealed snapshot. */
  readonly observationSha256: string;
  readonly state:
    | "no_terminal_event_at_evaluation"
    | "withdrawn_at_evaluation"
    | "superseded_at_evaluation";
  readonly history: readonly {
    readonly record: ReleasePolicyLifecycleEvent;
    readonly recordSha256: string;
    /** Lineage evidence only; never a replacement evaluation-policy root. */
    readonly successor: { readonly record: ReleasePolicy; readonly recordSha256: string } | null;
  }[];
}

function canonical(value: unknown): string {
  return Buffer.from(encodeEvaluationCanonicalJson(value)).toString("utf8");
}

function digest(value: unknown): string {
  return createHash("sha256").update(encodeEvaluationCanonicalJson(value)).digest("hex");
}

function invalid(message: string, cause?: unknown): ReleasePolicyRepositoryContractError {
  return new ReleasePolicyRepositoryContractError(
    message,
    cause === undefined ? undefined : { cause },
  );
}

/** Owning-domain observation. Its trusted caller owns authorization, clock and I/O admission. */
export async function readPolicyEvaluationLifecycle(
  input: {
    readonly scope: EvidenceScope;
    readonly evaluationTime: string;
    readonly policy: ReleasePolicyReference;
  },
  captured: PolicyEvaluationControlRead,
  repository: PolicyLifecycleReadRepository,
  clock: Clock,
): Promise<PolicyLifecycleObservation> {
  const context = structuredClone(input);
  const root = { kind: "release_policy" as const, reference: context.policy };
  const parent = inspectPolicyEvaluationControlRecord(
    { scope: context.scope, evaluationTime: context.evaluationTime, source: root },
    captured.record,
  );
  if (
    captured.observation.status !== "verified" ||
    parent.observation.status !== "verified" ||
    canonical(captured.source) !== canonical(root) ||
    parent.observation.recordSha256 !== captured.observation.recordSha256
  )
    throw invalid("Policy lifecycle requires the exact verified policy observation");
  const policy = parent.record as ReleasePolicy;
  const startedAt = clock.now().toISOString();
  if (
    policyEvaluationTimestampOrderKey(context.evaluationTime) >
    policyEvaluationTimestampOrderKey(startedAt)
  )
    throw invalid("Policy lifecycle observation precedes the requested evaluation time");
  const historyInput: unknown = await repository.listReleasePolicyLifecycleEvents(
    structuredClone(context.scope),
    policy.policyVersionId,
  );
  if (!Array.isArray(historyInput) || historyInput.length > 1)
    throw invalid(
      "Policy lifecycle observation requires the complete zero-or-one terminal history",
    );
  const history: PolicyLifecycleObservation["history"][number][] = [];
  for (const raw of historyInput) {
    let event: ReleasePolicyLifecycleEvent;
    try {
      event = validateReleasePolicyLifecycleEvent(raw);
    } catch (cause) {
      throw invalid("Policy lifecycle observation contains an invalid event", cause);
    }
    if (
      canonical(event.scope) !== canonical(context.scope) ||
      canonical(event.policy) !== canonical(root.reference)
    )
      throw invalid("Policy lifecycle observation substituted another scope or exact policy");
    if (
      policyEvaluationTimestampOrderKey(event.occurredAt) <
      policyEvaluationTimestampOrderKey(policy.publishedAt)
    )
      throw invalid("Policy lifecycle event predates its policy publication");
    let successor: PolicyLifecycleObservation["history"][number]["successor"] = null;
    if (event.kind === "superseded") {
      // Later terminal history is retained as capture-cut control evidence, not policy-time rule
      // evidence. Its successor may legitimately have been published after evaluationTime.
      const rawSuccessor = await repository.findReleasePolicy(
        structuredClone(context.scope),
        event.successor.policyVersionId,
      );
      let record: ReleasePolicy;
      try {
        record = validateReleasePolicyRecord(rawSuccessor);
      } catch (cause) {
        throw invalid("Policy lifecycle successor is missing or invalid", cause);
      }
      if (
        canonical(record.scope) !== canonical(context.scope) ||
        canonical(releasePolicyReference(record)) !== canonical(event.successor) ||
        !record.predecessor ||
        canonical(record.predecessor) !== canonical(root.reference)
      )
        throw invalid("Policy lifecycle successor does not preserve exact predecessor lineage");
      if (
        policyEvaluationTimestampOrderKey(record.publishedAt) >
        policyEvaluationTimestampOrderKey(event.occurredAt)
      )
        throw invalid("Policy lifecycle event predates its successor publication");
      const retained = JSON.parse(JSON.stringify(record)) as ReleasePolicy;
      successor = { record: retained, recordSha256: digest(retained) };
    }
    history.push({ record: event, recordSha256: digest(event), successor });
  }
  const completedAt = clock.now().toISOString();
  if (
    history.some(
      ({ record }) =>
        policyEvaluationTimestampOrderKey(record.occurredAt) >
        policyEvaluationTimestampOrderKey(completedAt),
    )
  )
    throw invalid("Policy lifecycle event has a future authoritative receipt");
  const terminal = history.find(
    ({ record }) =>
      policyEvaluationTimestampOrderKey(record.occurredAt) <=
      policyEvaluationTimestampOrderKey(context.evaluationTime),
  );
  const state =
    terminal?.record.kind === "withdrawn"
      ? "withdrawn_at_evaluation"
      : terminal?.record.kind === "superseded"
        ? "superseded_at_evaluation"
        : "no_terminal_event_at_evaluation";
  const observed = {
    scope: context.scope,
    policy: root.reference,
    policyRecordSha256: parent.observation.recordSha256,
    evaluationTime: context.evaluationTime,
    history,
  };
  return structuredClone({
    ...observed,
    startedAt,
    completedAt,
    state,
    observationSha256: digest({
      format: "proofstack.policy-lifecycle-observation.v1",
      ...observed,
    }),
  });
}
