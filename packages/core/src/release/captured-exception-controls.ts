import {
  PolicyEvaluationTimeSchema,
  policyEvaluationTimestampOrderKey,
  type ReleaseApproval,
  ReleaseApprovalSchema,
  type ReleaseDecisionControlObservation,
  ReleaseDecisionControlObservationSchema,
  serializeEvaluationCanonicalJson,
} from "@proofstack/contracts";
import {
  releaseApprovalReference,
  validateReleaseApprovalRecord,
} from "./release-authority-record-validation.js";
import {
  ReleaseDecisionVerificationBudget,
  ReleaseDecisionVerificationBudgetError,
} from "./release-decision-verification-budget.js";

export class InvalidCapturedExceptionControlsError extends Error {
  readonly code = "captured_exception_controls_invalid";
  constructor(options?: ErrorOptions) {
    super("Invalid complete captured exception control observations", options);
    this.name = "InvalidCapturedExceptionControlsError";
  }
}

export interface CapturedExceptionControls {
  readonly state: "retained" | "unavailable";
  readonly observations: readonly {
    readonly controlIndex: number;
    readonly reference: ReleaseApproval["compensatingControls"][number];
    readonly state:
      | "retained"
      | "missing"
      | "not_inspected"
      | "unverified"
      | "changed"
      | "expired"
      | "unavailable";
  }[];
  readonly expiresAt: string | null;
}

const same = (a: unknown, b: unknown) =>
  serializeEvaluationCanonicalJson(a) === serializeEvaluationCanonicalJson(b);

/**
 * Captured byte/catalog consistency only. No authentication, held guard, control effectiveness,
 * rule waiver, quorum or decision authority is established by a retained observation.
 */
export function inspectCapturedExceptionControls(input: {
  readonly approval: ReleaseApproval;
  readonly observations: readonly unknown[];
  readonly capturedAt: string;
  readonly budget: ReleaseDecisionVerificationBudget;
}): CapturedExceptionControls {
  try {
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Object.keys(input).length !== 4 ||
      !["approval", "observations", "capturedAt", "budget"].every((key) =>
        Object.hasOwn(input, key),
      ) ||
      !(input.budget instanceof ReleaseDecisionVerificationBudget)
    )
      throw new InvalidCapturedExceptionControlsError();
    const parsed = ReleaseApprovalSchema.parse(input.approval);
    const reference = releaseApprovalReference(parsed);
    const approval = validateReleaseApprovalRecord({
      expected: { scope: parsed.subject.scope, reference },
      record: parsed,
    });
    const at = PolicyEvaluationTimeSchema.parse(input.capturedAt);
    const order = policyEvaluationTimestampOrderKey;
    const cut = order(at);
    if (
      approval.kind !== "rule_exception" ||
      order(approval.recordedAt) > cut ||
      !Array.isArray(input.observations) ||
      input.observations.length > 16
    )
      throw new InvalidCapturedExceptionControlsError();
    // This is retained-observation admission. Owning ports must additionally charge every actual
    // failed, discarded, repeated and relationship read to this same original server-owned meter.
    input.budget.observe(approval, "approval");
    const observed = new Map<number, ReleaseDecisionControlObservation>();
    const currentCatalogs = new Map<string, string>();
    for (const raw of input.observations) {
      input.budget.observe(raw);
      const source = ReleaseDecisionControlObservationSchema.parse(raw);
      input.budget.observe(source.content);
      input.budget.observe(source.underGuards);
      const expected = approval.compensatingControls[source.controlIndex];
      if (
        !expected ||
        observed.has(source.controlIndex) ||
        !same(source.approval, reference) ||
        !same(source.scope, approval.subject.scope) ||
        !same(source.reference, expected)
      )
        throw new InvalidCapturedExceptionControlsError();
      if (source.content.state === "captured" && order(source.content.completedAt) > cut)
        throw new InvalidCapturedExceptionControlsError();
      const physical = source.reference.artifactId;
      const current = serializeEvaluationCanonicalJson(source.underGuards);
      const previous = currentCatalogs.get(physical);
      if (previous !== undefined && previous !== current)
        throw new InvalidCapturedExceptionControlsError();
      currentCatalogs.set(physical, current);
      observed.set(source.controlIndex, source);
    }
    let expiresAt: string | null = null;
    const observations = approval.compensatingControls.map((expected, controlIndex) => {
      const source = observed.get(controlIndex);
      const row = (state: CapturedExceptionControls["observations"][number]["state"]) => ({
        controlIndex,
        reference: structuredClone(expected),
        state,
      });
      if (!source) return row("missing");
      if (source.content.state === "not_inspected") return row("not_inspected");
      if (source.content.observation.status !== "verified" || source.content.catalog === null)
        return row("unverified");
      if (source.underGuards.state !== "observed") return row("unavailable");
      const catalog = source.underGuards.record;
      if (!same(catalog, source.content.catalog)) return row("changed");
      const metadata = catalog.metadata;
      if (
        metadata.state !== "available" ||
        metadata.availableAt === undefined ||
        order(metadata.createdAt) > order(source.content.completedAt) ||
        order(metadata.availableAt) > order(source.content.completedAt) ||
        (catalog.ownership !== null &&
          order(catalog.ownership.boundAt) > order(source.content.completedAt))
      )
        return row("unavailable");
      if (metadata.retention.mode === "expire") {
        const expiry = metadata.retention.expiresAt;
        if (order(expiry) <= cut) return row("expired");
        if (expiresAt === null || order(expiry) < order(expiresAt)) expiresAt = expiry;
      }
      return row("retained");
    });
    const retained =
      observations.length > 0 && observations.every((row) => row.state === "retained");
    return {
      state: retained ? "retained" : "unavailable",
      observations,
      expiresAt: retained ? expiresAt : null,
    };
  } catch (cause) {
    if (
      cause instanceof InvalidCapturedExceptionControlsError ||
      cause instanceof ReleaseDecisionVerificationBudgetError
    )
      throw cause;
    throw new InvalidCapturedExceptionControlsError({ cause });
  }
}
