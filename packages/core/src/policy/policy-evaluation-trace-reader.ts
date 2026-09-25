import { createHash } from "node:crypto";
import {
  type EvidenceEnvelope,
  EvidenceEnvelopeSchema,
  type EvidenceScope,
  EvidenceScopeSchema,
  encodeEvaluationCanonicalJson,
  PolicyEvaluationTimeSchema,
  policyEvaluationTimestampOrderKey,
  type RegressionTraceSnapshot,
  RegressionTraceSnapshotSchema,
} from "@proofstack/contracts";
import type { ExactEvidenceRepository } from "../evidence/evidence-repository.js";

export interface PolicyEvaluationTraceReadInput {
  readonly scope: EvidenceScope;
  readonly evaluationTime: string;
  readonly selector: RegressionTraceSnapshot;
}

export type PolicyEvaluationTraceRead = {
  readonly scope: EvidenceScope;
  readonly selector: RegressionTraceSnapshot;
} & (
  | {
      readonly events: readonly EvidenceEnvelope[];
      readonly observation: {
        readonly status: "verified";
        /** Canonical complete envelopes, including receipts, in the selector's exact order. */
        readonly eventsSha256: string;
        readonly eventSha256: readonly string[];
      };
    }
  | {
      readonly events: null;
      readonly observation:
        | { readonly status: "missing" }
        | {
            readonly status: "unavailable";
            readonly reason:
              | "record_invalid"
              | "reference_mismatch"
              | "not_yet_available"
              | "snapshot_cut_mismatch";
          };
    }
);

export class PolicyEvaluationTraceReadInputError extends TypeError {
  readonly code = "policy_evaluation_trace_read_input_invalid";
  constructor(options?: ErrorOptions) {
    super(
      "Trace acquisition requires an exact scope, bounded snapshot selector and UTC evaluation time",
      options,
    );
    this.name = "PolicyEvaluationTraceReadInputError";
  }
}

function capture(input: PolicyEvaluationTraceReadInput): PolicyEvaluationTraceReadInput {
  try {
    if (
      !input ||
      Object.keys(input).some((key) => !["scope", "evaluationTime", "selector"].includes(key))
    )
      throw new TypeError("Unexpected trace acquisition input field");
    return {
      scope: EvidenceScopeSchema.parse(input.scope),
      evaluationTime: PolicyEvaluationTimeSchema.parse(input.evaluationTime),
      selector: RegressionTraceSnapshotSchema.parse(input.selector),
    };
  } catch (cause) {
    throw new PolicyEvaluationTraceReadInputError({ cause });
  }
}

function digest(value: unknown): string {
  return createHash("sha256").update(encodeEvaluationCanonicalJson(value)).digest("hex");
}

function inspect(input: PolicyEvaluationTraceReadInput, raw: unknown): PolicyEvaluationTraceRead {
  const { scope, selector, evaluationTime } = input;
  const unavailable = (
    reason: "record_invalid" | "reference_mismatch" | "not_yet_available" | "snapshot_cut_mismatch",
  ): PolicyEvaluationTraceRead => ({
    scope,
    selector,
    events: null,
    observation: { status: "unavailable", reason },
  });
  const cut = policyEvaluationTimestampOrderKey(selector.capturedAt);
  const evaluation = policyEvaluationTimestampOrderKey(evaluationTime);
  if (cut > evaluation) return unavailable("not_yet_available");
  if (raw === null) return { scope, selector, events: null, observation: { status: "missing" } };
  if (!Array.isArray(raw)) return unavailable("record_invalid");
  if (raw.length !== selector.eventIds.length) return unavailable("reference_mismatch");
  const events: EvidenceEnvelope[] = [];
  for (let index = 0; index < raw.length; index++) {
    const parsed = EvidenceEnvelopeSchema.safeParse(raw[index]);
    if (!parsed.success) return unavailable("record_invalid");
    // Only schema-admitted optional undefined values disappear; unknown fields were rejected first.
    const event = JSON.parse(JSON.stringify(parsed.data)) as EvidenceEnvelope;
    if (
      event.scope.tenantId !== scope.tenantId ||
      event.scope.projectId !== scope.projectId ||
      event.scope.environmentId !== scope.environmentId ||
      event.evidence.traceId !== selector.traceId ||
      event.evidence.eventId !== selector.eventIds[index]
    )
      return unavailable("reference_mismatch");
    const received = policyEvaluationTimestampOrderKey(event.receivedAt);
    if (received > evaluation) return unavailable("not_yet_available");
    if (received > cut) return unavailable("snapshot_cut_mismatch");
    events.push(event);
  }
  return {
    scope,
    selector,
    events,
    observation: {
      status: "verified",
      eventsSha256: digest(events),
      eventSha256: events.map(digest),
    },
  };
}

/** Fixed reinspection only; a supplied null cannot establish authoritative absence. */
export function inspectPolicyEvaluationTrace(
  input: PolicyEvaluationTraceReadInput,
  raw: unknown,
): PolicyEvaluationTraceRead {
  return inspect(capture(input), raw);
}

/**
 * Reads only the immutable selector's ordered IDs, never a current trace page. The caller must bind
 * the selector to a verified parent, authorize the port and meter response bytes/event rows. This
 * establishes neither complete-trace coverage, artifact availability nor a sealed observation cut.
 */
export async function readPolicyEvaluationTrace(
  input: PolicyEvaluationTraceReadInput,
  repository: Pick<ExactEvidenceRepository, "resolveExactEvents">,
): Promise<PolicyEvaluationTraceRead> {
  const fixed = capture(input);
  if (
    policyEvaluationTimestampOrderKey(fixed.selector.capturedAt) >
    policyEvaluationTimestampOrderKey(fixed.evaluationTime)
  )
    return inspect(fixed, null);
  const raw = await repository.resolveExactEvents(
    structuredClone(fixed.scope),
    fixed.selector.traceId,
    [...fixed.selector.eventIds],
  );
  return inspect(fixed, raw);
}
