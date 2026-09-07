import { describe, expect, it } from "vitest";
import {
  ReadPolicyEvaluationManifestResponseSchema,
  ReadPolicyEvaluationManifestPageResponseSchema,
} from "./policy-evaluation-manifest-api.js";
import {
  MAX_POLICY_EVALUATION_MANIFEST_ENTRIES,
  MAX_POLICY_EVALUATION_MANIFEST_PAGES,
  MAX_POLICY_EVALUATION_MANIFEST_RESPONSE_BYTES,
  MAX_POLICY_EVALUATION_MANIFEST_PAGE_RESPONSE_BYTES,
  PolicyEvaluationManifestDefinitionSchema,
  PolicyEvaluationManifestPageDefinitionSchema,
  PolicyEvaluationManifestPageDescriptorSchema,
  PolicyEvaluationManifestEntrySchema,
  PolicyEvaluationSourceObservationSchema,
  PolicyEvaluationExpectedSourcesSchema,
  PolicyEvaluationManifestPageSetSchema,
  type PolicyEvaluationManifestPageSet,
} from "./policy-evaluation-manifest.js";
import {
  PolicyEvaluationSourceKeySchema,
  type PolicyEvaluationSourceReference,
} from "./policy-evaluation-source-reference.js";

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected manifest fixture member");
  return value;
}
const hash = "f".repeat(64);
const id = (index = 0) => `id_${String(index).padStart(61, "0")}`;
const request = { definitionSha256: hash, evaluationRequestId: id() };
const scope = { tenantId: id(), projectId: id(), environmentId: id() };
function source(index = 0): PolicyEvaluationSourceReference {
  return { kind: "assessment", reference: { assessmentId: id(index), definitionSha256: hash } };
}
function entries(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    source: source(index),
    observation: { status: "verified" as const, recordSha256: hash },
  }));
}
function page(count = 128, pageIndex = 0, entryCount = count) {
  return { entries: entries(count), entryCount, manifestId: id(), pageIndex, request };
}
function descriptor(index = 0, count = 128) {
  return {
    definitionSha256: hash,
    entryCount: count,
    firstKey: `assessment:${id(index * 128)}`,
    lastKey: `assessment:${id(index * 128 + count - 1)}`,
    pageIndex: index,
  };
}
function manifest(count = 129) {
  return {
    entryCount: count,
    manifestId: id(),
    request,
    pages: Array.from({ length: Math.ceil(count / 128) }, (_, index) =>
      descriptor(index, Math.min(128, count - index * 128)),
    ),
  };
}

function pageSet(): PolicyEvaluationManifestPageSet {
  const root = manifest(257);
  return {
    manifest: { ...root, definitionSha256: hash, schemaVersion: "0.1", scope: { ...scope } },
    pages: root.pages.map((item) => ({
      ...page(item.entryCount, item.pageIndex, root.entryCount),
      entries: Array.from({ length: item.entryCount }, (_, index) => ({
        source: source(item.pageIndex * 128 + index),
        observation: { status: "missing" as const },
      })),
      definitionSha256: hash,
      schemaVersion: "0.1",
      scope: { ...scope },
      request: { ...request },
    })),
  };
}

describe("structural complete-page binding", () => {
  it("retains every page and separates structural success from hash verification", () => {
    const input = pageSet();
    expect(PolicyEvaluationManifestPageSetSchema.parse(input)).toEqual(input);
  });
  it("rejects a missing page even though each remaining page is structurally valid", () => {
    const input = pageSet();
    input.pages.pop();
    expect(PolicyEvaluationManifestPageSetSchema.safeParse(input).success).toBe(false);
  });
  it.each([
    "pageIndex",
    "manifestId",
    "entryCount",
    "digest",
    "requestId",
    "requestDigest",
    "tenantId",
    "projectId",
    "environmentId",
    "firstKey",
    "lastKey",
  ])("rejects structurally valid page substitution at %s", (field) => {
    const input = pageSet();
    const first = required(input.pages[0]);
    switch (field) {
      case "pageIndex":
        first.pageIndex = 1;
        break;
      case "manifestId":
        first.manifestId = "manifest_other";
        break;
      case "entryCount":
        first.entryCount = 258;
        break;
      case "digest":
        first.definitionSha256 = "a".repeat(64);
        break;
      case "requestId":
        first.request.evaluationRequestId = "request_other";
        break;
      case "requestDigest":
        first.request.definitionSha256 = "a".repeat(64);
        break;
      case "tenantId":
        first.scope.tenantId = "tenant_other";
        break;
      case "projectId":
        first.scope.projectId = "project_other";
        break;
      case "environmentId":
        first.scope.environmentId = "environment_other";
        break;
      case "firstKey":
        required(input.manifest.pages[0]).firstKey = `assessment:${id(1)}`;
        break;
      case "lastKey":
        required(input.manifest.pages[0]).lastKey = `assessment:${id(126)}`;
        break;
    }
    const parsed = PolicyEvaluationManifestPageSetSchema.safeParse(input);
    expect(parsed.success).toBe(false);
    if (!parsed.success)
      expect(
        parsed.error.issues.some(
          (issue) =>
            issue.message ===
            "Page does not match its exact scoped manifest descriptor and request",
        ),
      ).toBe(true);
  });
  it("reports child validation failures without traversing an invalid binding", () => {
    const input = pageSet();
    required(input.pages[0]).definitionSha256 = "invalid";
    expect(PolicyEvaluationManifestPageSetSchema.safeParse(input).success).toBe(false);
    expect(
      PolicyEvaluationManifestPageDescriptorSchema.safeParse({
        ...descriptor(),
        definitionSha256: "invalid",
      }).success,
    ).toBe(false);
  });
});

describe("bounded policy evaluation manifest contracts", () => {
  it.each([127, 128, 129])("preserves exact inventory count %i and fixed-size pages", (count) => {
    expect(PolicyEvaluationManifestDefinitionSchema.safeParse(manifest(count)).success).toBe(true);
  });
  it.each([0, 1, -1, 1.5, 100001, Infinity, NaN, "2", null])(
    "rejects invalid manifest count %s before count arithmetic",
    (entryCount) => {
      expect(
        PolicyEvaluationManifestDefinitionSchema.safeParse({ ...manifest(2), entryCount }).success,
      ).toBe(false);
      expect(
        PolicyEvaluationManifestPageDefinitionSchema.safeParse({ ...page(2), entryCount }).success,
      ).toBe(false);
    },
  );
  it.each([0, 1, 127, 129])("rejects page length %i when 128 entries are required", (count) => {
    expect(
      PolicyEvaluationManifestPageDefinitionSchema.safeParse(page(count, 0, 129)).success,
    ).toBe(false);
  });
  it.each([-1, 1.5, 1, 782, 9007199254740991])("rejects unavailable page index %i", (index) => {
    expect(PolicyEvaluationManifestPageDefinitionSchema.safeParse(page(2, index, 2)).success).toBe(
      false,
    );
  });
  it("requires the final page to carry all remaining entries, with no empty page", () => {
    expect(PolicyEvaluationManifestPageDefinitionSchema.safeParse(page(1, 1, 129)).success).toBe(
      true,
    );
    expect(PolicyEvaluationManifestPageDefinitionSchema.safeParse(page(0, 1, 129)).success).toBe(
      false,
    );
    expect(PolicyEvaluationManifestPageDefinitionSchema.safeParse(page(2, 1, 129)).success).toBe(
      false,
    );
  });
  it.each(["gap", "overlap", "reverse", "extra", "missing", "count"])(
    "rejects root page descriptor %s",
    (mode) => {
      const value = manifest();
      switch (mode) {
        case "gap":
          required(value.pages[1]).pageIndex = 2;
          break;
        case "overlap":
          required(value.pages[1]).firstKey = required(value.pages[0]).lastKey;
          required(value.pages[1]).lastKey = required(value.pages[0]).lastKey;
          break;
        case "reverse":
          value.pages.reverse();
          break;
        case "extra":
          value.pages.push(descriptor(2, 1));
          break;
        case "missing":
          value.pages.pop();
          break;
        case "count":
          required(value.pages[0]).entryCount = 127;
          break;
      }
      expect(PolicyEvaluationManifestDefinitionSchema.safeParse(value).success).toBe(false);
    },
  );
  it("distinguishes singleton from non-singleton descriptor ranges", () => {
    expect(PolicyEvaluationManifestPageDescriptorSchema.safeParse(descriptor(0, 1)).success).toBe(
      true,
    );
    expect(
      PolicyEvaluationManifestPageDescriptorSchema.safeParse({
        ...descriptor(0, 1),
        lastKey: `assessment:${id(1)}`,
      }).success,
    ).toBe(false);
    expect(
      PolicyEvaluationManifestPageDescriptorSchema.safeParse({
        ...descriptor(0, 2),
        lastKey: `assessment:${id(0)}`,
      }).success,
    ).toBe(false);
  });
  it.each([
    "unknown:record_one",
    "assessment:record_one:1",
    "assessment:Invalid",
    "replay_runtime_profile:record_one",
    "replay_runtime_profile:record_one:1:2",
    `replay_runtime_profile:${id()}:${"a".repeat(65)}`,
    "x".repeat(161),
  ])("rejects impossible source key %s", (key) => {
    expect(PolicyEvaluationSourceKeySchema.safeParse(key).success).toBe(false);
  });
  it("keeps complete expected references bounded at the acquisition ceiling", () => {
    const values = Array.from({ length: MAX_POLICY_EVALUATION_MANIFEST_ENTRIES }, (_, index) =>
      source(index),
    );
    expect(PolicyEvaluationExpectedSourcesSchema.safeParse(values).success).toBe(true);
    expect(
      PolicyEvaluationExpectedSourcesSchema.safeParse([...values, source(values.length)]).success,
    ).toBe(false);
  }, 15000);
  it.each(["record_invalid", "reference_mismatch", "not_yet_available"])(
    "retains explicit unavailable reason %s without a verified digest",
    (reason) => {
      expect(
        PolicyEvaluationSourceObservationSchema.safeParse({ status: "unavailable", reason })
          .success,
      ).toBe(true);
      expect(
        PolicyEvaluationSourceObservationSchema.safeParse({
          status: "unavailable",
          reason,
          recordSha256: hash,
        }).success,
      ).toBe(false);
    },
  );
  it.each(["temporary_network_failure", "worker_interrupted", "allowed", "passed"])(
    "does not encode operational or decision status %s as source evidence",
    (status) => {
      expect(PolicyEvaluationSourceObservationSchema.safeParse({ status }).success).toBe(false);
    },
  );
  it("rejects credentials, raw content, decisions and unknown fields at every entry boundary", () => {
    for (const field of ["credential", "rawContent", "approval", "decision", "sourceUrl"]) {
      const entry = required(entries(1)[0]);
      expect(
        PolicyEvaluationManifestEntrySchema.safeParse({ ...entry, [field]: "forged" }).success,
      ).toBe(false);
      expect(
        PolicyEvaluationManifestEntrySchema.safeParse({
          ...entry,
          observation: { ...entry.observation, [field]: "forged" },
        }).success,
      ).toBe(false);
    }
  });
});

describe("manifest response representation headroom", () => {
  it("bounds the largest complete root descriptor table including escaped correlation metadata", () => {
    const value = manifest(MAX_POLICY_EVALUATION_MANIFEST_ENTRIES);
    expect(value.pages).toHaveLength(MAX_POLICY_EVALUATION_MANIFEST_PAGES);
    for (const [index, item] of value.pages.entries()) {
      item.firstKey = `replay_isolation_profile:${id(index * 128)}:${"v".repeat(64)}`;
      item.lastKey = `replay_isolation_profile:${id(index * 128 + item.entryCount - 1)}:${"v".repeat(64)}`;
    }
    const result = ReadPolicyEvaluationManifestResponseSchema.parse({
      manifest: { ...value, definitionSha256: hash, schemaVersion: "0.1", scope },
      requestId: "\u0000".repeat(128),
    });
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(
      MAX_POLICY_EVALUATION_MANIFEST_RESPONSE_BYTES,
    );
  });

  it.each([
    "한".repeat(128),
    "😀".repeat(64),
    "\u0000".repeat(128),
    "\ud800".repeat(128),
    "\\".repeat(128),
    '"'.repeat(128),
  ])(
    "bounds a full page of maximal replay references with correlation metadata %#",
    (requestId) => {
      const value = page(128, 780, 100000);
      value.entries = Array.from({ length: 128 }, (_, index) => ({
        observation: { status: "verified", recordSha256: hash },
        source: {
          kind: "replay_result",
          reference: {
            attemptId: id(index),
            completedAt: "9999-12-31T23:59:59.999999999999999999999999999999+15:59",
            jobId: id(),
            plan: { definitionSha256: hash, planId: id(), planVersionId: id() },
            result: {
              artifactId: id(),
              classification: "confidential",
              mediaType: `${"x".repeat(127)}/${"x".repeat(127)}`,
              redactedAt: "retention",
              sha256: hash,
              sizeBytes: 16777216,
            },
            targetRelease: {
              definitionSha256: hash,
              targetId: id(),
              targetReleaseId: id(),
              targetAdapter: {
                name: "n".repeat(256),
                version: "v".repeat(64),
                protocolVersion: "v".repeat(64),
              },
              workerProtocol: { name: "n".repeat(256), version: "v".repeat(64) },
            },
            terminalCode: "completed",
            terminalStatus: "succeeded",
          },
        },
      })) as never;
      const result = ReadPolicyEvaluationManifestPageResponseSchema.parse({
        manifest: { manifestId: id(), definitionSha256: hash },
        page: { ...value, definitionSha256: hash, schemaVersion: "0.1", scope },
        requestId,
      });
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(
        MAX_POLICY_EVALUATION_MANIFEST_PAGE_RESPONSE_BYTES,
      );
      const compact = JSON.stringify(result).replaceAll('"sizeBytes":16777216', '"sizeBytes":1e7');
      const expanded = JSON.stringify(
        ReadPolicyEvaluationManifestPageResponseSchema.parse(JSON.parse(compact)),
      );
      expect(Buffer.byteLength(expanded) - Buffer.byteLength(compact)).toBe(5 * 128);
      expect(Buffer.byteLength(expanded)).toBeLessThan(
        MAX_POLICY_EVALUATION_MANIFEST_PAGE_RESPONSE_BYTES,
      );
      expect(
        ReadPolicyEvaluationManifestPageResponseSchema.safeParse({
          ...result,
          manifest: { ...result.manifest, manifestId: "manifest_other" },
        }).success,
      ).toBe(false);
    },
  );
});
