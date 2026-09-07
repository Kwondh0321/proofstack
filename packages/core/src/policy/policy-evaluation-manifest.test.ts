import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  encodePolicyEvaluationManifestDefinition,
  type PolicyEvaluationManifestEntry,
  type PolicyEvaluationManifestPageSet,
  PolicyEvaluationManifestPageSetSchema,
  type PolicyEvaluationManifestVerification,
} from "@proofstack/contracts";
import {
  assemblePolicyEvaluationManifest,
  validatePolicyEvaluationManifest,
  PolicyEvaluationManifestIntegrityError,
} from "./policy-evaluation-manifest.js";

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected manifest fixture member");
  return value;
}
const scope = {
  tenantId: "tenant_one",
  projectId: "project_one",
  environmentId: "environment_one",
};
const request = { evaluationRequestId: "request_one", definitionSha256: "a".repeat(64) };

function entries(count: number): PolicyEvaluationManifestEntry[] {
  return Array.from({ length: count }, (_, index) => ({
    observation:
      index % 3 === 0
        ? { status: "verified", recordSha256: "b".repeat(64) }
        : index % 3 === 1
          ? { status: "missing" }
          : { status: "unavailable", reason: "record_invalid" },
    source: {
      kind: "assessment",
      reference: {
        assessmentId: `assessment_${String(index).padStart(6, "0")}`,
        definitionSha256: "c".repeat(64),
      },
    },
  }));
}

function assembly(count = 129) {
  return { entries: entries(count), manifestId: "manifest_one", request, scope };
}
function verification(count = 129): PolicyEvaluationManifestVerification {
  const input = assembly(count);
  const pageSet = assemblePolicyEvaluationManifest(input);
  return {
    expected: {
      manifest: {
        manifestId: pageSet.manifest.manifestId,
        definitionSha256: pageSet.manifest.definitionSha256,
      },
      request,
      scope,
      sources: input.entries.map(({ source }) => source),
    },
    pageSet,
  };
}
function rehashManifest(pageSet: PolicyEvaluationManifestPageSet): void {
  const {
    definitionSha256: _digest,
    schemaVersion: _version,
    scope: recordScope,
    ...definition
  } = pageSet.manifest;
  pageSet.manifest.definitionSha256 = createHash("sha256")
    .update(encodePolicyEvaluationManifestDefinition({ definition, scope: recordScope }))
    .digest("hex");
}
function expectFailure(
  input: PolicyEvaluationManifestVerification,
  code: PolicyEvaluationManifestIntegrityError["code"],
): void {
  try {
    validatePolicyEvaluationManifest(input);
    throw new Error("Expected manifest rejection");
  } catch (error) {
    expect(error).toBeInstanceOf(PolicyEvaluationManifestIntegrityError);
    expect((error as PolicyEvaluationManifestIntegrityError).code).toBe(code);
  }
}

describe("complete policy evaluation manifests", () => {
  it("assembles the independently generated page and root vector digests", () => {
    const document = JSON.parse(
      readFileSync(
        new URL("../../../contracts/vectors/policy-evaluation-manifest-v1.json", import.meta.url),
        "utf8",
      ),
    );
    const pageVector = document.vectors[0];
    const rootVector = document.vectors[1];
    const {
      entries: vectorEntries,
      manifestId,
      request: vectorRequest,
    } = pageVector.input.definition;
    const result = assemblePolicyEvaluationManifest({
      entries: vectorEntries,
      manifestId,
      request: vectorRequest,
      scope: pageVector.input.scope,
    });
    expect(required(result.pages[0]).definitionSha256).toBe(pageVector.sha256);
    expect(result.manifest.definitionSha256).toBe(rootVector.sha256);
  });
  it.each([2, 127, 128, 129, 255, 256, 257, 1025])(
    "assembles and verifies all %i entries without dropping unavailable sources",
    (count) => {
      const input = assembly(count);
      const before = structuredClone(input);
      const pageSet = assemblePolicyEvaluationManifest(input);
      expect(input).toEqual(before);
      expect(pageSet.pages.flatMap(({ entries: values }) => values)).toEqual(input.entries);
      expect(pageSet.pages).toHaveLength(Math.ceil(count / 128));
      expect(validatePolicyEvaluationManifest(verification(count))).toEqual(pageSet);
      expect(assemblePolicyEvaluationManifest(input)).toEqual(pageSet);
    },
  );

  it("returns defensive values rather than sharing input records", () => {
    const input = verification(2);
    const actual = validatePolicyEvaluationManifest(input);
    required(required(actual.pages[0]).entries[0]).observation = { status: "missing" };
    expect(required(required(input.pageSet.pages[0]).entries[0]).observation.status).toBe(
      "verified",
    );
  });

  it("preserves the entire 100000-entry ceiling across all 782 pages", () => {
    const input = verification(100000);
    expect(input.pageSet.pages).toHaveLength(782);
    expect(required(input.pageSet.pages.at(-1)).entries).toHaveLength(32);
    const validated = validatePolicyEvaluationManifest(input);
    expect(validated.pages.reduce((count, page) => count + page.entries.length, 0)).toBe(100000);
    expect(required(required(validated.pages.at(-1)).entries.at(-1)).source).toEqual(
      required(input.expected.sources.at(-1)),
    );
  }, 30000);

  it.each(["tenantId", "projectId", "environmentId"] as const)(
    "rejects expected %s substitution",
    (field) => {
      const input = structuredClone(verification());
      input.expected.scope[field] = "scope_other";
      expectFailure(input, "reference_mismatch");
    },
  );
  it.each(["manifestId", "definitionSha256"] as const)(
    "rejects expected manifest %s substitution",
    (field) => {
      const input = structuredClone(verification());
      input.expected.manifest[field] = field === "manifestId" ? "manifest_other" : "f".repeat(64);
      expectFailure(input, "reference_mismatch");
    },
  );
  it.each(["evaluationRequestId", "definitionSha256"] as const)(
    "rejects expected request %s substitution",
    (field) => {
      const input = structuredClone(verification());
      input.expected.request[field] =
        field === "evaluationRequestId" ? "request_other" : "f".repeat(64);
      expectFailure(input, "reference_mismatch");
    },
  );

  it.each([
    "omit",
    "duplicate",
    "reorder",
    "request",
    "scope",
    "manifest",
    "count",
    "gap",
    "digest",
    "range",
  ])("rejects page-set %s corruption", (mode) => {
    const input = structuredClone(verification());
    const first = required(input.pageSet.pages[0]);
    switch (mode) {
      case "omit":
        input.pageSet.pages.pop();
        break;
      case "duplicate":
        input.pageSet.pages[1] = structuredClone(first);
        break;
      case "reorder":
        input.pageSet.pages.reverse();
        break;
      case "request":
        first.request.evaluationRequestId = "request_other";
        break;
      case "scope":
        first.scope.tenantId = "tenant_other";
        break;
      case "manifest":
        first.manifestId = "manifest_other";
        break;
      case "count":
        first.entries.pop();
        break;
      case "gap":
        first.pageIndex = 1;
        break;
      case "digest":
        first.definitionSha256 = "f".repeat(64);
        break;
      case "range":
        required(input.pageSet.manifest.pages[0]).firstKey = "assessment:assessment_000001";
        break;
    }
    expectFailure(input, "invalid_manifest");
  });

  it("does not treat shape validation or a claimed matching hash as cryptographic verification", () => {
    const input = structuredClone(verification());
    required(required(input.pageSet.pages[0]).entries[3]).observation = { status: "missing" };
    expect(PolicyEvaluationManifestPageSetSchema.safeParse(input.pageSet).success).toBe(true);
    expectFailure(input, "digest_mismatch");
  });

  it("recomputes the root digest even when its declared hash agrees with the expected reference", () => {
    const input = structuredClone(verification());
    input.pageSet.manifest.definitionSha256 = "f".repeat(64);
    input.expected.manifest.definitionSha256 = "f".repeat(64);
    expectFailure(input, "digest_mismatch");
  });

  it("rejects a rehashed root over an altered page with an unrecomputed page digest", () => {
    const input = structuredClone(verification());
    required(input.pageSet.pages[0]).definitionSha256 = "f".repeat(64);
    required(input.pageSet.manifest.pages[0]).definitionSha256 = "f".repeat(64);
    rehashManifest(input.pageSet);
    input.expected.manifest.definitionSha256 = input.pageSet.manifest.definitionSha256;
    expectFailure(input, "digest_mismatch");
  });

  it.each(["omitted", "extra", "digest", "identity", "kind"])(
    "rejects an independently expected source closure that is %s",
    (mode) => {
      const input = structuredClone(verification());
      switch (mode) {
        case "omitted":
          input.expected.sources.pop();
          break;
        case "extra":
          input.expected.sources.push({
            kind: "assessment",
            reference: { assessmentId: "assessment_999999", definitionSha256: "c".repeat(64) },
          });
          break;
        case "digest":
          Object.assign(required(input.expected.sources[1]).reference, {
            definitionSha256: "f".repeat(64),
          });
          break;
        case "identity":
          Object.assign(required(input.expected.sources[128]).reference, {
            assessmentId: "assessment_999999",
          });
          break;
        case "kind":
          input.expected.sources[128] = {
            kind: "comparison_result",
            reference: { resultId: "assessment_000128", definitionSha256: "c".repeat(64) },
          };
          break;
      }
      expectFailure(input, "source_closure_mismatch");
    },
  );

  it("cannot hide an entry by rebuilding and rehashing a smaller otherwise valid manifest", () => {
    const input = verification();
    input.pageSet = assemblePolicyEvaluationManifest(assembly(128));
    input.expected.manifest.definitionSha256 = input.pageSet.manifest.definitionSha256;
    expectFailure(input, "source_closure_mismatch");
  });

  it("rejects a cross-page identity conflict even when different digests could sort independently", () => {
    const input = assembly();
    required(input.entries[128]).source = {
      kind: "assessment",
      reference: { assessmentId: "assessment_000127", definitionSha256: "f".repeat(64) },
    };
    expect(() => assemblePolicyEvaluationManifest(input)).toThrow(
      PolicyEvaluationManifestIntegrityError,
    );
  });

  it("rejects reordered and duplicate expected sources rather than silently normalizing them", () => {
    for (const mode of ["reorder", "duplicate"]) {
      const input = structuredClone(verification());
      if (mode === "reorder") input.expected.sources.reverse();
      else input.expected.sources[1] = required(input.expected.sources[0]);
      expectFailure(input, "invalid_manifest");
    }
  });

  it.each([null, {}, { entries: [] }, { ...assembly(2), approval: true }])(
    "rejects malformed assembly %# with a typed boundary error",
    (input) => {
      expect(() => assemblePolicyEvaluationManifest(input as never)).toThrow(
        PolicyEvaluationManifestIntegrityError,
      );
    },
  );

  it("retains unknown verification fields as validation errors instead of stripping them", () => {
    expectFailure({ ...verification(), worker: "forged" } as never, "invalid_manifest");
  });
});
