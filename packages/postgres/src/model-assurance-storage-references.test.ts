import { ModelAssuranceRepositoryContractError } from "@proofstack/core";
import { describe, expect, it } from "vitest";
import { modelAssuranceStorageReferences } from "./model-assurance-storage-references.js";

const digest = "a".repeat(64);
const profile = (id: string, hash = digest) => ({
  modelProfileVersionId: id,
  definitionSha256: hash,
});

describe("private model-assurance storage reference derivation", () => {
  it("preserves full distinct tuples through repeated object and array occurrences", () => {
    const refs = modelAssuranceStorageReferences("calibration_report", "cal_root", {
      modelProfileVersionId: "mdl_root_ignored",
      definitionSha256: digest,
      nested: [
        profile("mdl_shared"),
        profile("mdl_shared"),
        profile("mdl_shared", "b".repeat(64)),
        { evaluatorVersionId: "mdl_shared", definitionSha256: digest },
      ],
      unrelated: { oracleVersionId: "orc_unselected", definitionSha256: digest },
      absentDigest: { modelProfileVersionId: "mdl_absent" },
      absentId: { definitionSha256: digest },
      nullId: { modelProfileVersionId: null, definitionSha256: digest },
      primitives: [null, true, "text", 4],
    });
    expect(new Set(refs.map((r) => JSON.stringify(r)))).toEqual(
      new Set([
        JSON.stringify({
          recordKind: "model_evaluator_profile",
          recordId: "mdl_shared",
          definitionSha256: digest,
        }),
        JSON.stringify({
          recordKind: "model_evaluator_profile",
          recordId: "mdl_shared",
          definitionSha256: "b".repeat(64),
        }),
        JSON.stringify({
          recordKind: "model_assisted_evaluator",
          recordId: "mdl_shared",
          definitionSha256: digest,
        }),
      ]),
    );
  });

  it("excludes only the root kind and ID, even when its digest differs", () => {
    expect(
      modelAssuranceStorageReferences("model_evaluator_profile", "mdl_root", {
        self: profile("mdl_root", "b".repeat(64)),
        predecessor: profile("mdl_prior"),
      }),
    ).toEqual([
      { recordKind: "model_evaluator_profile", recordId: "mdl_prior", definitionSha256: digest },
    ]);
  });

  it("includes the cross-domain criterion reference in a human protocol", () => {
    expect(
      modelAssuranceStorageReferences("human_review_protocol", "hrp_root", {
        criterion: { criterionSetVersionId: "crt_exact", definitionSha256: digest },
        unrelated: { oracleVersionId: "orc_unselected", definitionSha256: digest },
      }),
    ).toEqual([{ recordKind: "criterion_set", recordId: "crt_exact", definitionSha256: digest }]);
  });

  it("counts depth 64 and excludes depth 65 like the original SQL recursion", () => {
    const nested = (depth: number) => {
      let value: unknown = profile("mdl_depth");
      for (let i = 0; i < depth; i++) value = { nested: value };
      return value;
    };
    expect(
      modelAssuranceStorageReferences("model_evaluator_profile", "mdl_root", nested(64)),
    ).toHaveLength(1);
    expect(
      modelAssuranceStorageReferences("model_evaluator_profile", "mdl_root", nested(65)),
    ).toEqual([]);
  });

  it.each([undefined, null, false, 1, "text"])("has no object references in %s", (value) => {
    expect(modelAssuranceStorageReferences("model_evaluator_profile", "mdl_root", value)).toEqual(
      [],
    );
  });

  it.each([
    { modelProfileVersionId: 1, definitionSha256: digest },
    { modelProfileVersionId: "mdl_bad", definitionSha256: null },
  ])("rejects malformed selected storage tuples instead of ignoring them", (value) => {
    expect(() =>
      modelAssuranceStorageReferences("model_evaluator_profile", "mdl_root", { value }),
    ).toThrow(ModelAssuranceRepositoryContractError);
  });

  it("allows exactly 4096 distinct references and fails one over without truncation", () => {
    const refs = Array.from({ length: 4097 }, (_, index) => profile(`mdl_${index}`));
    expect(
      modelAssuranceStorageReferences("model_evaluator_profile", "mdl_root", {
        refs: refs.slice(0, 4096),
      }),
    ).toHaveLength(4096);
    expect(() =>
      modelAssuranceStorageReferences("model_evaluator_profile", "mdl_root", { refs }),
    ).toThrow(ModelAssuranceRepositoryContractError);
    expect(
      modelAssuranceStorageReferences("model_evaluator_profile", "mdl_root", {
        refs: Array.from({ length: 4097 }, () => profile("mdl_repeat")),
      }),
    ).toHaveLength(1);
  });
});
