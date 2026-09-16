import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  comparisonDefinitionFixture,
  comparisonFixtureScope,
  comparisonResultFixture,
  comparisonSnapshotFixture,
} from "../testing/comparison-repository-fixtures.js";
import { MemoryComparisonRepository } from "../testing/memory-comparison-repository.js";
import { MemoryReleaseCandidateRepository } from "../testing/memory-release-candidate-repository.js";
import { MemoryReleasePolicyRepository } from "../testing/memory-release-policy-repository.js";
import { releaseCandidateFixture } from "../testing/release-candidate-repository-fixtures.js";
import { policyAuthorityFixture } from "../testing/release-policy-fixtures.js";
import {
  inspectPolicyEvaluationControlRecord,
  type PolicyEvaluationControlReaderDependencies,
  type PolicyEvaluationControlRecord,
  type PolicyEvaluationControlSource,
  readPolicyEvaluationControlRecord,
} from "./policy-evaluation-control-record-reader.js";
import { PolicyEvaluationDefinitionReadInputError } from "./policy-evaluation-definition-reader.js";
import { StaticPolicyInstallationBindingResolver } from "./release-policy-authority-resolver.js";

const scope = comparisonFixtureScope("control_reader");
const time = "2026-09-08T00:00:00.000000000000000000000000000001Z";
const definition = comparisonDefinitionFixture("control_reader", scope);
const baseline = comparisonSnapshotFixture("control_reader", scope, definition, "baseline");
const candidate = comparisonSnapshotFixture("control_reader", scope, definition, "candidate");
const result = comparisonResultFixture("control_reader", scope, definition, baseline, candidate);
const release = releaseCandidateFixture("control_reader", scope);
const { policy, binding } = policyAuthorityFixture({ scope });

interface Case {
  readonly source: PolicyEvaluationControlSource;
  readonly record: PolicyEvaluationControlRecord;
  readonly receipt: "createdAt" | "publishedAt" | "registeredAt";
  readonly port: number;
  readonly query: unknown[];
}
const cases: readonly Case[] = [
  {
    source: {
      kind: "comparison_definition",
      reference: {
        comparisonId: definition.comparisonId,
        comparisonVersionId: definition.comparisonVersionId,
        definitionSha256: definition.definitionSha256,
      },
    },
    record: definition,
    receipt: "createdAt",
    port: 0,
    query: [scope, definition.comparisonVersionId],
  },
  {
    source: {
      kind: "comparison_snapshot",
      reference: {
        snapshotId: baseline.snapshotId,
        role: baseline.role,
        definitionSha256: baseline.definitionSha256,
      },
    },
    record: baseline,
    receipt: "createdAt",
    port: 1,
    query: [scope, baseline.snapshotId],
  },
  {
    source: {
      kind: "comparison_result",
      reference: {
        resultId: result.resultId,
        definitionSha256: result.definitionSha256,
      },
    },
    record: result,
    receipt: "createdAt",
    port: 2,
    query: [scope, result.resultId],
  },
  {
    source: {
      kind: "release_candidate",
      reference: {
        candidateId: release.candidateId,
        candidateVersionId: release.candidateVersionId,
        definitionSha256: release.definitionSha256,
      },
    },
    record: release,
    receipt: "createdAt",
    port: 3,
    query: [scope, release.candidateVersionId],
  },
  {
    source: {
      kind: "release_policy",
      reference: {
        policyId: policy.policyId,
        policyVersionId: policy.policyVersionId,
        definitionSha256: policy.definitionSha256,
      },
    },
    record: policy,
    receipt: "publishedAt",
    port: 4,
    query: [scope, policy.policyVersionId],
  },
  {
    source: {
      kind: "policy_installation_binding",
      reference: {
        bindingVersionId: binding.bindingVersionId,
        installationId: binding.installationId,
        definitionSha256: binding.definitionSha256,
      },
    },
    record: binding,
    receipt: "registeredAt",
    port: 5,
    query: [
      {
        scope,
        reference: {
          bindingVersionId: binding.bindingVersionId,
          installationId: binding.installationId,
          definitionSha256: binding.definitionSha256,
        },
      },
    ],
  },
];

function input(testCase: Case) {
  return {
    evaluationTime: time,
    scope: structuredClone(scope),
    source: structuredClone(testCase.source),
  };
}

// Independent sorted-JSON oracle for these JSON fixtures; does not call the production encoder.
function sortedJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(sortedJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, field]) => field !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, field]) => `${JSON.stringify(key)}:${sortedJson(field)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
function hash(value: unknown) {
  return createHash("sha256").update(sortedJson(value)).digest("hex");
}

function ports(raw: unknown) {
  const reads = Array.from({ length: 6 }, () => vi.fn(async (..._args: unknown[]) => raw));
  const [
    findComparisonDefinition,
    findComparisonEvidenceSnapshot,
    findComparisonResult,
    findReleaseCandidate,
    findReleasePolicy,
    resolve,
  ] = reads;
  // Deliberately dishonest transport implementations test the runtime boundary, not the port types.
  const dependencies = {
    comparison: { findComparisonDefinition, findComparisonEvidenceSnapshot, findComparisonResult },
    releaseCandidate: { findReleaseCandidate },
    releasePolicy: {
      findReleasePolicy,
    },
    installationBinding: { resolve },
  } as unknown as PolicyEvaluationControlReaderDependencies;
  return { dependencies, reads };
}
function unavailable(reason: string) {
  return { reason, status: "unavailable" };
}

describe("exact control-record acquisition and reinspection", () => {
  for (const testCase of cases) {
    describe(testCase.source.kind, () => {
      it("reads exactly one typed port and hashes the full record independently", async () => {
        const { dependencies, reads } = ports(structuredClone(testCase.record));
        const expected = {
          source: testCase.source,
          record: testCase.record,
          observation: { status: "verified", recordSha256: hash(testCase.record) },
        };
        expect(await readPolicyEvaluationControlRecord(input(testCase), dependencies)).toEqual(
          expected,
        );
        expect(inspectPolicyEvaluationControlRecord(input(testCase), testCase.record)).toEqual(
          expected,
        );
        for (const [index, read] of reads.entries()) {
          if (index === testCase.port)
            expect(read).toHaveBeenCalledExactlyOnceWith(...testCase.query);
          else expect(read).not.toHaveBeenCalled();
        }
      });

      for (const raw of [undefined, false, 0, "invalid", [], {}]) {
        it(`does not turn malformed ${JSON.stringify(raw)} into missing evidence`, async () => {
          const { dependencies } = ports(raw);
          expect(
            (await readPolicyEvaluationControlRecord(input(testCase), dependencies)).observation,
          ).toEqual(unavailable("record_invalid"));
        });
      }
      it("only reports missing when the exact read returns null", async () => {
        expect(
          await readPolicyEvaluationControlRecord(input(testCase), ports(null).dependencies),
        ).toEqual({ source: testCase.source, record: null, observation: { status: "missing" } });
      });
      it("rejects a corrupt digest and unknown fields before JSON normalization", () => {
        for (const raw of [
          { ...testCase.record, definitionSha256: "f".repeat(64) },
          { ...testCase.record, approved: undefined },
          { ...testCase.record, approved: true },
        ])
          expect(inspectPolicyEvaluationControlRecord(input(testCase), raw).observation).toEqual(
            unavailable("record_invalid"),
          );
      });
      for (const key of ["tenantId", "projectId", "environmentId"] as const) {
        it(`compares the requested ${key} against a valid record`, () => {
          const command = input(testCase);
          command.scope[key] = "foreign_scope";
          expect(
            inspectPolicyEvaluationControlRecord(command, testCase.record).observation,
          ).toEqual(unavailable("reference_mismatch"));
        });
      }
      for (const key of Object.keys(testCase.source.reference)) {
        it(`compares the exact ${key} reference, including snapshot role`, () => {
          const command = input(testCase);
          Object.assign(command.source.reference, {
            [key]:
              key === "definitionSha256"
                ? "f".repeat(64)
                : key === "role"
                  ? "candidate"
                  : "other_version",
          });
          expect(
            inspectPolicyEvaluationControlRecord(command, testCase.record).observation,
          ).toEqual(unavailable("reference_mismatch"));
        });
      }
      it("uses its real receipt field, preserving sub-millisecond ordering and the original hash", () => {
        // Stored receipts are canonical millisecond timestamps. Evaluation cuts retain finer
        // precision; do not widen a domain record's receipt schema to exercise that boundary.
        const equal = { ...testCase.record, [testCase.receipt]: "2026-09-08T00:00:00.000Z" };
        const after = { ...equal, [testCase.receipt]: "2026-09-08T00:00:00.001Z" };
        const before = { ...equal, [testCase.receipt]: "2026-09-07T23:59:59.999Z" };
        expect(
          inspectPolicyEvaluationControlRecord(
            { ...input(testCase), evaluationTime: "2026-09-08T00:00:00.000Z" },
            equal,
          ).observation.status,
        ).toBe("verified");
        expect(inspectPolicyEvaluationControlRecord(input(testCase), equal).observation).toEqual({
          status: "verified",
          recordSha256: hash(equal),
        });
        expect(inspectPolicyEvaluationControlRecord(input(testCase), after).observation).toEqual(
          unavailable("not_yet_available"),
        );
        expect(inspectPolicyEvaluationControlRecord(input(testCase), before).observation).toEqual({
          status: "verified",
          recordSha256: hash(before),
        });
        expect(hash(equal)).not.toBe(hash(before));
      });
      it("propagates the original storage failure instead of fabricating absence", async () => {
        const failure = new Error("store unavailable");
        const { dependencies, reads } = ports(null);
        for (const read of reads) read.mockRejectedValue(failure);
        await expect(readPolicyEvaluationControlRecord(input(testCase), dependencies)).rejects.toBe(
          failure,
        );
      });
      it("rejects noncanonical stored receipts without loosening the domain schema", () => {
        for (const receipt of [time, "2026-09-08T00:00:00Z", "invalid", undefined]) {
          const raw = { ...testCase.record, [testCase.receipt]: receipt };
          expect(inspectPolicyEvaluationControlRecord(input(testCase), raw).observation).toEqual(
            unavailable("record_invalid"),
          );
        }
      });
      it("rejects every other control-record family without retrying another reader", async () => {
        for (const other of cases.filter((item) => item.source.kind !== testCase.source.kind)) {
          const { dependencies, reads } = ports(other.record);
          expect(
            (await readPolicyEvaluationControlRecord(input(testCase), dependencies)).observation,
          ).toEqual(unavailable("record_invalid"));
          for (const [index, read] of reads.entries()) {
            expect(read).toHaveBeenCalledTimes(index === testCase.port ? 1 : 0);
          }
        }
      });
      it("captures reinspection context before a record accessor mutates the caller", () => {
        const command = input(testCase);
        const raw = structuredClone(testCase.record);
        Object.defineProperty(raw, "scope", {
          enumerable: true,
          get: () => {
            command.scope.tenantId = "changed_by_accessor";
            command.evaluationTime = "2000-01-01T00:00:00Z";
            Object.assign(command.source.reference, { definitionSha256: "f".repeat(64) });
            return structuredClone(scope);
          },
        });
        expect(inspectPolicyEvaluationControlRecord(command, raw)).toEqual({
          source: testCase.source,
          record: testCase.record,
          observation: { status: "verified", recordSha256: hash(testCase.record) },
        });
      });
      it("captures context before I/O and isolates returned values", async () => {
        const raw = structuredClone(testCase.record);
        const command = input(testCase);
        const { dependencies, reads } = ports(raw);
        for (const read of reads)
          read.mockImplementation(async (...args) => {
            command.scope.tenantId = "mutated_tenant";
            command.evaluationTime = "2000-01-01T00:00:00Z";
            Object.assign(command.source.reference, { definitionSha256: "f".repeat(64) });
            const first = args[0] as Record<string, unknown>;
            Object.assign(
              first,
              testCase.port === 5
                ? {
                    scope: { tenantId: "changed" },
                    reference: {},
                  }
                : { tenantId: "changed" },
            );
            return raw;
          });
        const observed = await readPolicyEvaluationControlRecord(command, dependencies);
        expect(observed.observation).toEqual({
          status: "verified",
          recordSha256: hash(testCase.record),
        });
        expect(observed.source).toEqual(testCase.source);
        if (!observed.record) throw new Error("Expected a record");
        observed.record.scope.tenantId = "output_mutation";
        Object.assign(observed.source.reference, { definitionSha256: "b".repeat(64) });
        expect(raw).toEqual(testCase.record);
        expect(testCase.source.reference.definitionSha256).toBe(testCase.record.definitionSha256);
      });
      it("rejects bad context before repository I/O", async () => {
        for (const command of [
          { ...input(testCase), evaluationTime: "invalid" },
          { ...input(testCase), approval: true },
          {
            ...input(testCase),
            source: {
              kind: "dataset_version",
              reference: {
                datasetId: "dataset_other",
                datasetVersionId: "version_other",
                definitionSha256: "a".repeat(64),
              },
            },
          },
        ]) {
          const { dependencies, reads } = ports(testCase.record);
          await expect(
            readPolicyEvaluationControlRecord(command as ReturnType<typeof input>, dependencies),
          ).rejects.toBeInstanceOf(PolicyEvaluationDefinitionReadInputError);
          for (const read of reads) expect(read).not.toHaveBeenCalled();
        }
      });
    });
  }

  it("integrates all six exact reads with existing memory stores and the installation-owned resolver", async () => {
    const comparison = new MemoryComparisonRepository();
    await comparison.publishComparisonDefinition(definition);
    await comparison.publishComparisonEvidenceSnapshot(baseline);
    await comparison.publishComparisonEvidenceSnapshot(candidate);
    await comparison.publishComparisonResult(result);
    const releaseCandidate = new MemoryReleaseCandidateRepository();
    await releaseCandidate.publishReleaseCandidate(release);
    const releasePolicy = new MemoryReleasePolicyRepository();
    await releasePolicy.publishReleasePolicy(policy);
    const dependencies = {
      comparison,
      releaseCandidate,
      releasePolicy,
      installationBinding: new StaticPolicyInstallationBindingResolver([binding]),
    };
    for (const testCase of cases) {
      expect(await readPolicyEvaluationControlRecord(input(testCase), dependencies)).toEqual(
        inspectPolicyEvaluationControlRecord(input(testCase), testCase.record),
      );
      const foreign = input(testCase);
      foreign.scope.tenantId = "foreign_tenant";
      expect((await readPolicyEvaluationControlRecord(foreign, dependencies)).observation).toEqual({
        status: "missing",
      });
    }
  });
  it("does not hide undefined semantic fields rejected by the domain canonical encoder", () => {
    for (const testCase of cases.filter((c) =>
      ["comparison_definition", "release_candidate", "release_policy"].includes(c.source.kind),
    )) {
      const raw = { ...testCase.record, predecessor: undefined };
      expect(inspectPolicyEvaluationControlRecord(input(testCase), raw).observation).toEqual(
        unavailable("record_invalid"),
      );
    }
  });
  it("does not replace publication receipt with semantic policy effectiveness", () => {
    const testCase = cases.find((c) => c.source.kind === "release_policy");
    if (!testCase) throw new Error("Missing policy case");
    const command = { ...input(testCase), evaluationTime: policy.publishedAt };
    expect(policy.effectiveAt > policy.publishedAt).toBe(true);
    expect(inspectPolicyEvaluationControlRecord(command, policy).observation.status).toBe(
      "verified",
    );
    expect(inspectPolicyEvaluationControlRecord(command, policy).record).not.toHaveProperty(
      "createdAt",
    );
  });
});
