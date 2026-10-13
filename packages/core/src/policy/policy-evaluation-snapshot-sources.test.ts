import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type {
  PolicyEvaluationManifestEntry,
  PolicyEvaluationSnapshotSourceInputs,
} from "@proofstack/contracts";
import { assemblePolicyEvaluationManifest } from "./policy-evaluation-manifest.js";
import { validatePolicyEvaluationSnapshotSources } from "./policy-evaluation-snapshot-sources.js";

const document = JSON.parse(
  readFileSync(
    new URL(
      "../../../contracts/vectors/policy-evaluation-snapshot-sources-v1.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as { vectors: { input: PolicyEvaluationSnapshotSourceInputs }[] };
const vector = document.vectors[0];
if (!vector) throw new Error("Missing snapshot source vector");
const requiredVector = vector;
function fixture(count = 2) {
  const sources = structuredClone(requiredVector.input);
  for (let index = 2; index < count; index++)
    sources.records.records.push({
      entry: {
        source: {
          kind: "protocol_definition",
          reference: {
            protocolDefinitionId: `protocol_sources_z${String(index).padStart(6, "0")}`,
            definitionSha256: "b".repeat(64),
          },
        },
        observation: { status: "unavailable", reason: "record_invalid" },
      },
      storage: null,
      origins: [{ kind: "stored_node", nodeIndex: index }],
    });
  const pageSet = assemble(
    sources,
    sources.records.records.map(({ entry }) => entry),
  );
  return {
    sources,
    pageSet,
    expected: {
      request: sources.records.request,
      scope: sources.records.scope,
      evaluationTime: sources.records.evaluationTime,
      manifest: {
        manifestId: pageSet.manifest.manifestId,
        definitionSha256: pageSet.manifest.definitionSha256,
      },
    },
  };
}
function assemble(
  sources: PolicyEvaluationSnapshotSourceInputs,
  entries: PolicyEvaluationManifestEntry[],
) {
  return assemblePolicyEvaluationManifest({
    manifestId: "manifest_sources",
    request: sources.records.request,
    scope: sources.records.scope,
    entries,
  });
}
function replaceManifest(
  value: ReturnType<typeof fixture>,
  entries: PolicyEvaluationManifestEntry[],
) {
  value.pageSet = assemble(value.sources, entries);
  value.expected.manifest.definitionSha256 = value.pageSet.manifest.definitionSha256;
}

describe("snapshot witnesses joined to complete fixed-page manifests", () => {
  it.each([2, 129, 256])(
    "binds all %i original source observations across page boundaries",
    (count) => {
      const value = fixture(count);
      const result = validatePolicyEvaluationSnapshotSources(value);
      expect(result).toEqual(value.sources);
      expect(result).not.toBe(value.sources);
    },
  );
  it("rejects removal followed by internally consistent page/root rehashing", () => {
    const value = fixture(129);
    replaceManifest(
      value,
      value.sources.records.records.slice(0, -1).map(({ entry }) => entry),
    );
    expect(() => validatePolicyEvaluationSnapshotSources(value)).toThrow("source_closure_mismatch");
  });
  it("rejects source substitution even when new page/root hashes are valid", () => {
    const value = fixture();
    const entries = structuredClone(value.sources.records.records.map(({ entry }) => entry));
    Reflect.set(entries[1]!.source.reference, "definitionSha256", "b".repeat(64));
    replaceManifest(value, entries);
    expect(() => validatePolicyEvaluationSnapshotSources(value)).toThrow("source_closure_mismatch");
  });
  it.each(["missing_to_verified", "verified_hash", "missing_to_invalid"] as const)(
    "rejects rehashed observation substitution: %s",
    (mutation) => {
      const value = fixture();
      const entries = structuredClone(value.sources.records.records.map(({ entry }) => entry));
      if (mutation === "verified_hash")
        entries[0]!.observation = { status: "verified", recordSha256: "b".repeat(64) };
      else if (mutation === "missing_to_verified")
        entries[1]!.observation = { status: "verified", recordSha256: "b".repeat(64) };
      else entries[1]!.observation = { status: "unavailable", reason: "record_invalid" };
      replaceManifest(value, entries);
      expect(() => validatePolicyEvaluationSnapshotSources(value)).toThrow("observation_mismatch");
    },
  );
  it.each(["tenantId", "projectId", "environmentId"] as const)(
    "rejects expected %s substitution",
    (key) => {
      const value = fixture();
      value.expected.scope = { ...value.expected.scope, [key]: "scope_other" };
      expect(() => validatePolicyEvaluationSnapshotSources(value)).toThrow("reference_mismatch");
    },
  );
  it.each(["request", "cut"] as const)("rejects expected %s substitution", (key) => {
    const value = fixture();
    if (key === "request")
      value.expected.request = { ...value.expected.request, evaluationRequestId: "request_other" };
    else value.expected.evaluationTime = "2026-10-03T00:00:00.000000000000000000000000000002Z";
    expect(() => validatePolicyEvaluationSnapshotSources(value)).toThrow("reference_mismatch");
  });
  it.each(["sources", "cut"] as const)("rejects malformed %s before manifest joining", (key) => {
    const value = fixture();
    if (key === "sources") value.sources.storedMappings[0]!.parentRecordSha256 = "b".repeat(64);
    else value.expected.evaluationTime = "not_a_time";
    expect(() => validatePolicyEvaluationSnapshotSources(value)).toThrow("invalid_sources");
  });
  it("rejects a manifest reference that differs from the retained exact root", () => {
    const value = fixture();
    value.expected.manifest.definitionSha256 = "b".repeat(64);
    expect(() => validatePolicyEvaluationSnapshotSources(value)).toThrow("reference_mismatch");
  });
});
