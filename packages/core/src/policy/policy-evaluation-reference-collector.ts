import {
  ArtifactContentReferenceSchema,
  type Assessment,
  type CriterionVersionSelector,
  CriterionVersionSelectorSchema,
  type EvaluationRun,
  encodeEvaluationCanonicalJson,
  MAX_POLICY_EVALUATION_ACQUISITION_RECORD_BYTES,
  MAX_POLICY_EVALUATION_ACQUISITION_RECORDS,
  type ModelEvaluatorSelector,
  ModelEvaluatorSelectorSchema,
  type OracleSpec,
  type PolicyEvaluationSourceReference,
  PolicyEvaluationSourceReferenceSchema,
  policyEvaluationSourceReferenceKey,
  type QualificationReport,
  type SourceSnapshot,
} from "@proofstack/contracts";

type ArtifactReference = SourceSnapshot["content"];
type SourceKind = PolicyEvaluationSourceReference["kind"];
type SourceReferences = {
  readonly [Source in PolicyEvaluationSourceReference as Source["kind"]]: Source["reference"];
};

/** Paths are JSON pointers into the validated parent record, never fetch URLs. */
export type PolicyEvaluationEvidenceReference = { readonly path: string } & (
  | { readonly kind: "record"; readonly source: PolicyEvaluationSourceReference }
  | { readonly kind: "artifact"; readonly reference: ArtifactReference }
  | { readonly kind: "criterion_selector"; readonly selector: CriterionVersionSelector }
  | { readonly kind: "model_evaluator_selector"; readonly selector: ModelEvaluatorSelector }
  | { readonly kind: "evaluation_run_identity"; readonly evaluationRunId: string }
  | { readonly kind: "qualification_policy"; readonly reference: QualificationReport["policy"] }
  | { readonly kind: "registered_implementation"; readonly reference: OracleSpec["implementation"] }
);

/** Limits apply to reference occurrences and their canonical UTF-8 bytes, not unique records. */
export interface PolicyEvaluationEvidenceReferenceLimits {
  readonly maxReferences: number;
  readonly maxReferenceBytes: number;
}

export class PolicyEvaluationEvidenceReferenceError extends Error {
  readonly code = "policy_evaluation_evidence_references_invalid";

  constructor(
    readonly reason:
      | "input_invalid"
      | "evidence_unverified"
      | "observation_mismatch"
      | "reference_conflict"
      | "reference_limit_exceeded"
      | "reference_bytes_exceeded",
    options?: ErrorOptions,
  ) {
    super(`Policy evaluation evidence references: ${reason}`, options);
    this.name = "PolicyEvaluationEvidenceReferenceError";
  }
}

function canonical(value: unknown): string {
  return Buffer.from(encodeEvaluationCanonicalJson(value)).toString("utf8");
}

/** Internal, single-parent builder. The graph capture must additionally enforce cumulative limits. */
export class PolicyEvaluationReferenceCollector {
  private readonly limits: PolicyEvaluationEvidenceReferenceLimits;
  private readonly references: PolicyEvaluationEvidenceReference[] = [];
  private readonly identities = new Map<string, string>();
  private referenceBytes = 0;

  constructor(limits: PolicyEvaluationEvidenceReferenceLimits) {
    const maxReferences = limits?.maxReferences;
    const maxReferenceBytes = limits?.maxReferenceBytes;
    if (
      !limits ||
      Object.keys(limits).some((key) => key !== "maxReferences" && key !== "maxReferenceBytes") ||
      !Number.isSafeInteger(maxReferences) ||
      maxReferences < 0 ||
      maxReferences > MAX_POLICY_EVALUATION_ACQUISITION_RECORDS ||
      !Number.isSafeInteger(maxReferenceBytes) ||
      maxReferenceBytes < 0 ||
      maxReferenceBytes > MAX_POLICY_EVALUATION_ACQUISITION_RECORD_BYTES
    ) {
      throw new PolicyEvaluationEvidenceReferenceError("input_invalid");
    }
    this.limits = { maxReferenceBytes, maxReferences };
  }

  private add(value: PolicyEvaluationEvidenceReference, identity?: string, exact?: unknown): void {
    if (this.references.length >= this.limits.maxReferences) {
      throw new PolicyEvaluationEvidenceReferenceError("reference_limit_exceeded");
    }
    const bytes = encodeEvaluationCanonicalJson(value).byteLength;
    if (bytes > this.limits.maxReferenceBytes - this.referenceBytes) {
      throw new PolicyEvaluationEvidenceReferenceError("reference_bytes_exceeded");
    }
    if (identity !== undefined) {
      const encoded = canonical(exact);
      const previous = this.identities.get(identity);
      if (previous !== undefined && previous !== encoded) {
        throw new PolicyEvaluationEvidenceReferenceError("reference_conflict");
      }
      this.identities.set(identity, encoded);
    }
    this.references.push(structuredClone(value));
    this.referenceBytes += bytes;
  }

  record<K extends SourceKind>(path: string, kind: K, reference: SourceReferences[K]): void {
    const source = PolicyEvaluationSourceReferenceSchema.parse({ kind, reference });
    this.add({ kind: "record", path, source }, policyEvaluationSourceReferenceKey(source), source);
  }

  optionalRecord<K extends SourceKind>(
    path: string,
    kind: K,
    reference: SourceReferences[K] | undefined,
  ): void {
    if (reference) this.record<K>(path, kind, reference);
  }

  records<K extends SourceKind>(
    path: string,
    kind: K,
    references: readonly SourceReferences[K][],
  ): void {
    references.forEach((reference, index) => {
      this.record<K>(`${path}/${index}`, kind, reference);
    });
  }

  artifact(path: string, reference: ArtifactReference): void {
    const parsed = ArtifactContentReferenceSchema.parse(reference);
    this.add(
      { kind: "artifact", path, reference: parsed },
      `artifact:${parsed.artifactId}`,
      parsed,
    );
  }

  artifacts(path: string, references: readonly ArtifactReference[]): void {
    references.forEach((reference, index) => {
      this.artifact(`${path}/${index}`, reference);
    });
  }

  criterion(path: string, criterion: EvaluationRun["criterion"]): void {
    this.record(`${path}/criterionSet`, "criterion_set", criterion.criterionSet);
  }

  criteria(path: string, criteria: readonly EvaluationRun["criterion"][]): void {
    criteria.forEach((criterion, index) => {
      this.criterion(`${path}/${index}`, criterion);
    });
  }

  criterionSelector(path: string, selector: CriterionVersionSelector): void {
    this.add({
      kind: "criterion_selector",
      path,
      selector: CriterionVersionSelectorSchema.parse(selector),
    });
  }

  criterionSelectors(path: string, selectors: readonly CriterionVersionSelector[]): void {
    selectors.forEach((selector, index) => {
      this.criterionSelector(`${path}/${index}`, selector);
    });
  }

  modelEvaluatorSelector(path: string, selector: ModelEvaluatorSelector): void {
    this.add({
      kind: "model_evaluator_selector",
      path,
      selector: ModelEvaluatorSelectorSchema.parse(selector),
    });
  }

  runIdentity(path: string, evaluationRunId: string): void {
    this.add({ evaluationRunId, kind: "evaluation_run_identity", path });
  }

  qualificationPolicy(path: string, reference: QualificationReport["policy"]): void {
    // This is not an aggregation or release policy. No retained authority is invented here.
    this.add({ kind: "qualification_policy", path, reference });
  }

  implementation(path: string, reference: OracleSpec["implementation"]): void {
    this.add({ kind: "registered_implementation", path, reference });
  }

  replay(path: string, reference: EvaluationRun["replay"]): void {
    this.record(path, "replay_result", reference);
    this.record(`${path}/plan`, "replay_plan", reference.plan);
    this.artifact(`${path}/result`, reference.result);
    this.record(`${path}/targetRelease`, "target_release", reference.targetRelease);
  }

  evidence(path: string, references: Assessment["counterevidence"]): void {
    references.forEach((reference, index) => {
      const location = `${path}/${index}`;
      switch (reference.kind) {
        case "artifact":
          this.artifact(`${location}/artifact`, reference.artifact);
          break;
        case "source_snapshot":
          this.record(`${location}/source`, "source_snapshot", reference.source);
          break;
        case "replay_result":
          this.replay(`${location}/replay`, reference.replay);
          break;
      }
    });
  }

  result(): {
    readonly referenceBytes: number;
    readonly references: readonly PolicyEvaluationEvidenceReference[];
  } {
    return { referenceBytes: this.referenceBytes, references: structuredClone(this.references) };
  }
}
