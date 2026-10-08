import { createHash } from "node:crypto";
import {
  type EvaluationImplementationRegistrationRecord,
  type EvidenceScope,
  encodeEvaluationCanonicalJson,
  PolicyEvaluationSourceReferenceSchema,
} from "@proofstack/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  digestEvaluationImplementationRegistration,
  InvalidEvaluationImplementationRegistrationError,
  StaticEvaluationImplementationRegistrationCatalogue,
} from "../evaluation/evaluation-implementation-registration.js";
import { createEvaluationRepositoryTestHarness } from "../testing/evaluation-repository-fixtures.js";
import { inspectPolicyEvaluationEvidenceRecord } from "./policy-evaluation-evidence-reader.js";
import { enumeratePolicyEvaluationEvidenceReferences } from "./policy-evaluation-evidence-references.js";
import {
  enumeratePolicyEvaluationImplementationReferences,
  inspectPolicyEvaluationImplementationRecord,
  readPolicyEvaluationImplementationRecord,
} from "./policy-evaluation-implementation-reader.js";
import {
  inspectPolicyEvaluationImplementationResolution,
  type PolicyEvaluationImplementationParentSource,
  PolicyEvaluationImplementationResolutionInputError,
  readPolicyEvaluationImplementationResolution,
} from "./policy-evaluation-implementation-resolution.js";

const kinds = [
  "oracle_spec",
  "evaluator_spec",
  "evaluation_run",
  "evaluation_run_rejection",
] as const;
const harness = createEvaluationRepositoryTestHarness("reg_resolution");
const evaluationTime = "2026-10-01T00:00:00.000001Z";
const limits = { maxReferences: 10_000, maxReferenceBytes: 4_000_000 };
type Fields = Record<string, unknown>;
function rehash(record: EvaluationImplementationRegistrationRecord) {
  record.definitionSha256 = digestEvaluationImplementationRegistration(record.scope, {
    recordKind: record.recordKind,
    implementation: record.implementation,
  });
  return record;
}
function scenario(kind: (typeof kinds)[number] = "oracle_spec") {
  const item = harness.records.find((value) => value.kind === kind);
  if (!item) throw new Error("Missing evaluation parent");
  const body = structuredClone(item.record) as unknown as Fields;
  const option = PolicyEvaluationSourceReferenceSchema.options.find(
    ({ shape }) => shape.kind.value === kind,
  );
  if (!option) throw new Error("Missing source schema");
  const source = PolicyEvaluationSourceReferenceSchema.parse({
    kind,
    reference: Object.fromEntries(
      Object.keys(option.shape.reference.shape).map((key) => [key, body[key]]),
    ),
  }) as PolicyEvaluationImplementationParentSource;
  const input = {
    source,
    scope: structuredClone(body["scope"]) as EvidenceScope,
    evaluationTime,
    path: kind.endsWith("spec") ? "/implementation" : "/applicability/interpreter",
    limits: structuredClone(limits),
  };
  const evidence = inspectPolicyEvaluationEvidenceRecord(
    { source, scope: input.scope, evaluationTime },
    body,
  );
  expect(evidence.observation.status).toBe("verified");
  const implementation = kind.endsWith("spec")
    ? body["implementation"]
    : (body["applicability"] as Fields)["interpreter"];
  const record = rehash({
    recordKind: "evaluation_implementation_registration",
    implementation: structuredClone(
      implementation,
    ) as EvaluationImplementationRegistrationRecord["implementation"],
    scope: structuredClone(input.scope),
    schemaVersion: "0.1",
    definitionSha256: "f".repeat(64),
    registeredAt: "2026-09-02T00:00:00.000Z",
    registeredByPrincipalId: "operator_retained",
  });
  const childSource = {
    kind: "evaluation_implementation_registration" as const,
    reference: {
      implementationId: record.implementation.implementationId,
      implementationVersionId: record.implementation.implementationVersionId,
      definitionSha256: record.definitionSha256,
    },
  };
  return {
    input,
    evidence,
    record,
    childInput: { source: childSource, scope: input.scope, evaluationTime },
  };
}

describe("parent-bound retained implementation registration", () => {
  it.each(kinds)(
    "joins %s through exact independent data lookup and retains both original hashes",
    async (kind) => {
      const s = scenario(kind);
      const catalogue = new StaticEvaluationImplementationRegistrationCatalogue([s.record]);
      const read = vi.fn(
        (...args: Parameters<typeof catalogue.findEvaluationImplementationRegistration>) =>
          catalogue.findEvaluationImplementationRegistration(...args),
      );
      const result = await readPolicyEvaluationImplementationResolution(s.input, s.evidence, {
        findEvaluationImplementationRegistration: read,
      });
      expect(result.status).toBe("resolved");
      expect(result.parent).toEqual({
        source: s.input.source,
        recordSha256:
          s.evidence.observation.status === "verified"
            ? s.evidence.observation.recordSha256
            : "missing",
      });
      expect(read).toHaveBeenCalledExactlyOnceWith(
        s.input.scope,
        s.record.implementation.implementationId,
        s.record.implementation.implementationVersionId,
      );
      if (result.status !== "resolved") throw new Error("Expected registration");
      expect(result.evidence.record).toEqual(s.record);
      expect(result.evidence.observation.recordSha256).toBe(
        createHash("sha256").update(encodeEvaluationCanonicalJson(s.record)).digest("hex"),
      );
      expect(result).toEqual(
        inspectPolicyEvaluationImplementationResolution(s.input, s.evidence, s.record),
      );
      const frontier = enumeratePolicyEvaluationEvidenceReferences(
        { source: s.input.source, scope: s.input.scope, evaluationTime },
        s.evidence,
        limits,
      );
      expect(result.inspectionUsage).toEqual({
        references: frontier.references.length,
        referenceBytes: frontier.referenceBytes,
      });
      const child = await readPolicyEvaluationImplementationRecord(s.childInput, catalogue);
      expect(child).toEqual(result.evidence);
      expect(
        enumeratePolicyEvaluationImplementationReferences(s.childInput, child, limits).references,
      ).toEqual([]);
      const changed = structuredClone(child);
      if (changed.observation.status !== "verified")
        throw new Error("Missing original observation");
      expect(Reflect.set(changed.observation, "recordSha256", "0".repeat(64))).toBe(true);
      expect(() =>
        enumeratePolicyEvaluationImplementationReferences(s.childInput, changed, limits),
      ).toThrow();
    },
  );

  it("retains missingness without deriving a source from the parent or a null response", async () => {
    const s = scenario();
    for (const value of [
      null,
      undefined,
      { ...s.record, definitionSha256: "d".repeat(64) },
      { ...s.record, approved: true },
    ]) {
      const reader = { findEvaluationImplementationRegistration: async () => value };
      const result = await readPolicyEvaluationImplementationResolution(
        s.input,
        s.evidence,
        reader,
      );
      expect(result).toMatchObject(
        value === null
          ? { status: "missing", evidence: null }
          : { status: "unavailable", reason: "record_invalid", evidence: null },
      );
      expect(result.reference).toMatchObject({
        kind: "registered_implementation",
        path: s.input.path,
        reference: s.record.implementation,
      });
      expect(Object.hasOwn(result, "source")).toBe(false);
      expect(
        (await readPolicyEvaluationImplementationRecord(s.childInput, reader)).record,
      ).toBeNull();
    }
  });

  it("compares every descriptor leaf and exact scope even when each changed registration has a valid digest", () => {
    const s = scenario();
    const changes = [
      { dependencySnapshotSha256: "d".repeat(64) },
      { entryPointId: "entry_other" },
      { implementationId: "implementation_other" },
      { implementationVersionId: "version_other" },
      { implementationSha256: "d".repeat(64) },
      { sourceRevision: "d".repeat(s.record.implementation.sourceRevision.length) },
      {
        runtime: {
          ...s.record.implementation.runtime,
          architecture: s.record.implementation.runtime.architecture === "x64" ? "arm64" : "x64",
        },
      },
      {
        runtime: {
          ...s.record.implementation.runtime,
          family: s.record.implementation.runtime.family === "node" ? "python" : "node",
        },
      },
      {
        runtime: {
          ...s.record.implementation.runtime,
          platform: s.record.implementation.runtime.platform === "linux" ? "portable" : "linux",
        },
      },
      { runtime: { ...s.record.implementation.runtime, version: "different_version" } },
    ];
    for (const patch of changes) {
      const changed = rehash({
        ...structuredClone(s.record),
        implementation: { ...s.record.implementation, ...patch },
      } as EvaluationImplementationRegistrationRecord);
      expect(
        inspectPolicyEvaluationImplementationResolution(s.input, s.evidence, changed),
      ).toMatchObject({ status: "unavailable", reason: "reference_mismatch", evidence: null });
    }
    for (const key of ["tenantId", "projectId", "environmentId"] as const) {
      const changed = rehash({
        ...structuredClone(s.record),
        scope: { ...s.record.scope, [key]: "outside_scope" },
      });
      expect(
        inspectPolicyEvaluationImplementationResolution(s.input, s.evidence, changed),
      ).toMatchObject({ status: "unavailable", reason: "reference_mismatch" });
    }
    for (const key of [
      "definitionSha256",
      "implementationId",
      "implementationVersionId",
    ] as const) {
      const input = structuredClone(s.childInput);
      input.source.reference[key] =
        key === "definitionSha256" ? "d".repeat(64) : "other_coordinate";
      expect(inspectPolicyEvaluationImplementationRecord(input, s.record)).toMatchObject({
        observation: { status: "unavailable", reason: "reference_mismatch" },
      });
    }
  });

  it("uses the exact policy cut and preserves receipt-bearing observation changes", () => {
    const s = scenario();
    const later = {
      ...s.record,
      registeredAt: "2026-10-01T00:00:00.001Z",
      registeredByPrincipalId: "operator_other",
    };
    const before = {
      ...s.input,
      evaluationTime: "2026-10-01T00:00:00.000999999999999999999999999999Z",
    };
    const at = {
      ...s.input,
      evaluationTime: "2026-10-01T00:00:00.001000000000000000000000000000Z",
    };
    expect(
      inspectPolicyEvaluationImplementationResolution(before, s.evidence, later),
    ).toMatchObject({ status: "unavailable", reason: "not_yet_available" });
    const original = inspectPolicyEvaluationImplementationResolution(at, s.evidence, s.record);
    const result = inspectPolicyEvaluationImplementationResolution(at, s.evidence, later);
    expect(result.status).toBe("resolved");
    if (result.status !== "resolved" || original.status !== "resolved")
      throw new Error("Expected registrations");
    expect(result.evidence.source).toEqual(original.evidence.source);
    expect(result.evidence.observation.recordSha256).not.toBe(
      original.evidence.observation.recordSha256,
    );
    expect(result.evidence.record.registeredAt).toBe(later.registeredAt);
    expect(Object.hasOwn(result, "qualified")).toBe(false);
  });

  it("admits the whole parent frontier before any lookup and accepts exact limits", async () => {
    const s = scenario("evaluator_spec");
    const frontier = enumeratePolicyEvaluationEvidenceReferences(
      { source: s.input.source, scope: s.input.scope, evaluationTime },
      s.evidence,
      limits,
    );
    const read = vi.fn(async () => s.record);
    for (const bounded of [
      { maxReferences: frontier.references.length - 1, maxReferenceBytes: frontier.referenceBytes },
      { maxReferences: frontier.references.length, maxReferenceBytes: frontier.referenceBytes - 1 },
    ])
      await expect(
        readPolicyEvaluationImplementationResolution({ ...s.input, limits: bounded }, s.evidence, {
          findEvaluationImplementationRegistration: read,
        }),
      ).rejects.toThrow();
    expect(read).not.toHaveBeenCalled();
    expect(
      (
        await readPolicyEvaluationImplementationResolution(
          {
            ...s.input,
            limits: {
              maxReferences: frontier.references.length,
              maxReferenceBytes: frontier.referenceBytes,
            },
          },
          s.evidence,
          { findEvaluationImplementationRegistration: read },
        )
      ).status,
    ).toBe("resolved");
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("rejects substituted paths, unsupported input and forged parent observations before I/O", async () => {
    const s = scenario();
    const read = vi.fn(async () => s.record);
    for (const input of [
      null,
      { ...s.input, approved: true },
      { ...s.input, path: "/missing" },
      { ...s.input, path: "/inputSchema" },
      { ...s.input, path: "implementation" },
      { ...s.input, path: "/" + "x".repeat(1024) },
      { ...s.input, evaluationTime: "invalid" },
      { ...s.input, scope: { ...s.input.scope, tenantId: "" } },
    ])
      await expect(
        readPolicyEvaluationImplementationResolution(input as typeof s.input, s.evidence, {
          findEvaluationImplementationRegistration: read,
        }),
      ).rejects.toThrow(PolicyEvaluationImplementationResolutionInputError);
    const changed = structuredClone(s.evidence);
    if (changed.observation.status !== "verified") throw new Error("Missing parent");
    expect(Reflect.set(changed.observation, "recordSha256", "0".repeat(64))).toBe(true);
    await expect(
      readPolicyEvaluationImplementationResolution(s.input, changed, {
        findEvaluationImplementationRegistration: read,
      }),
    ).rejects.toThrow();
    expect(read).not.toHaveBeenCalled();
    expect(new PolicyEvaluationImplementationResolutionInputError().code).toBe(
      "policy_evaluation_implementation_resolution_input_invalid",
    );
    for (const input of [
      null,
      { ...s.childInput, approved: true },
      { ...s.childInput, evaluationTime: "invalid" },
      { ...s.childInput, source: s.input.source },
    ])
      await expect(
        readPolicyEvaluationImplementationRecord(input as typeof s.childInput, {
          findEvaluationImplementationRegistration: read,
        }),
      ).rejects.toThrow();
    expect(read).not.toHaveBeenCalled();
  });

  it("propagates operational failures, including validation-shaped storage failures", async () => {
    const s = scenario();
    for (const failure of [
      new Error("storage unavailable"),
      new InvalidEvaluationImplementationRegistrationError(),
    ]) {
      const reader = {
        findEvaluationImplementationRegistration: async () => {
          throw failure;
        },
      };
      await expect(
        readPolicyEvaluationImplementationResolution(s.input, s.evidence, reader),
      ).rejects.toBe(failure);
      await expect(readPolicyEvaluationImplementationRecord(s.childInput, reader)).rejects.toBe(
        failure,
      );
    }
  });

  it("owns the original parent occurrence and exact context across reader mutation", async () => {
    const s = scenario();
    const original = structuredClone(s);
    const result = await readPolicyEvaluationImplementationResolution(s.input, s.evidence, {
      findEvaluationImplementationRegistration: async (scope) => {
        scope.tenantId = "port_mutation";
        s.input.scope.projectId = "caller_mutation";
        s.input.source.reference.definitionSha256 = "d".repeat(64);
        s.input.path = "/missing";
        return original.record;
      },
    });
    expect(result).toEqual(
      inspectPolicyEvaluationImplementationResolution(
        original.input,
        original.evidence,
        original.record,
      ),
    );
    const input = structuredClone(original.childInput);
    const child = await readPolicyEvaluationImplementationRecord(input, {
      findEvaluationImplementationRegistration: async (scope) => {
        scope.environmentId = "port_mutation";
        input.scope.tenantId = "caller_mutation";
        input.source.reference.implementationVersionId = "version_changed";
        return original.record;
      },
    });
    expect(child).toEqual(
      inspectPolicyEvaluationImplementationRecord(original.childInput, original.record),
    );
  });
});
