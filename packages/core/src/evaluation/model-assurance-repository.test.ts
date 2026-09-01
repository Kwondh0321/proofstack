import type { EvidenceScope } from "@proofstack/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  AuthoritySplitModelAssuranceRepository,
  type ModelAssuranceRecordByKind,
  type ModelAssuranceRecordKind,
  type ModelAssuranceRepository,
} from "./model-assurance-repository.js";

function repository(name: string) {
  const find = vi.fn(async () => null);
  const publish = vi.fn(async (_kind: ModelAssuranceRecordKind, candidate: unknown) => ({
    created: true,
    record: candidate,
  }));
  return { find, name, publish };
}

describe("AuthoritySplitModelAssuranceRepository", () => {
  it("routes every write authority and all reads explicitly", async () => {
    const control = repository("control");
    const execution = repository("execution");
    const humanReview = repository("human-review");
    const read = repository("read");
    const routed = new AuthoritySplitModelAssuranceRepository({
      control: control as unknown as ModelAssuranceRepository,
      execution: execution as unknown as ModelAssuranceRepository,
      humanReview: humanReview as unknown as ModelAssuranceRepository,
      read: read as unknown as ModelAssuranceRepository,
    });
    const scope = {
      environmentId: "env_authority",
      projectId: "prj_authority",
      tenantId: "ten_authority",
    } satisfies EvidenceScope;

    await routed.find(scope, "model_evaluator_profile", "mep_authority");
    expect(read.find).toHaveBeenCalledWith(scope, "model_evaluator_profile", "mep_authority");

    const cases: ReadonlyArray<
      readonly [ModelAssuranceRecordKind, "control" | "execution" | "human-review"]
    > = [
      ["model_evaluator_profile", "control"],
      ["model_qualification_suite", "control"],
      ["model_assisted_evaluator", "control"],
      ["blinded_evaluation_plan", "control"],
      ["calibration_report", "control"],
      ["independence_declaration", "control"],
      ["human_review_protocol", "control"],
      ["human_reviewer_independence", "control"],
      ["model_assurance_assessment", "control"],
      ["model_qualification_report", "execution"],
      ["blinded_evaluation_result", "execution"],
      ["independent_critique", "execution"],
      ["human_review_record", "human-review"],
    ];

    for (const [kind, authority] of cases) {
      const candidate = { kind } as unknown as ModelAssuranceRecordByKind[typeof kind];
      await routed.publish(kind, candidate);
      const selected = { control, execution, "human-review": humanReview }[authority];
      expect(selected.publish).toHaveBeenCalledWith(kind, candidate);
    }

    expect(control.publish).toHaveBeenCalledTimes(9);
    expect(execution.publish).toHaveBeenCalledTimes(3);
    expect(humanReview.publish).toHaveBeenCalledTimes(1);
  });

  it("uses the control repository for reads when no read authority is supplied", async () => {
    const control = repository("control");
    const routed = new AuthoritySplitModelAssuranceRepository({
      control: control as unknown as ModelAssuranceRepository,
      execution: repository("execution") as unknown as ModelAssuranceRepository,
      humanReview: repository("human-review") as unknown as ModelAssuranceRepository,
    });
    const scope = {
      environmentId: "env_default_read",
      projectId: "prj_default_read",
      tenantId: "ten_default_read",
    } satisfies EvidenceScope;

    await routed.find(scope, "human_review_record", "hrr_default_read");
    expect(control.find).toHaveBeenCalledWith(scope, "human_review_record", "hrr_default_read");
  });
});
