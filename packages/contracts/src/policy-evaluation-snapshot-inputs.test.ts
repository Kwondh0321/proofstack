import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  PolicyEvaluationSnapshotInputsSchema,
  type PolicyEvaluationSnapshotInputs,
} from "./policy-evaluation-snapshot-inputs.js";
import {
  PolicyEvaluationSnapshotArtifactSchema,
  PolicyEvaluationSnapshotTraceSchema,
} from "./policy-evaluation-snapshot-content.js";
import { PolicyEvaluationSnapshotApplicabilitySchema } from "./policy-evaluation-snapshot-applicability.js";

const raw = JSON.parse(
  readFileSync(
    new URL("../vectors/policy-evaluation-snapshot-inputs-v1.fixture.json", import.meta.url),
    "utf8",
  ),
) as PolicyEvaluationSnapshotInputs;
function input() {
  return structuredClone(raw);
}
describe("whole strict snapshot input bindings", () => {
  it("retains root definitions and every typed domain without classified event bodies", () => {
    const value = input();
    expect(PolicyEvaluationSnapshotInputsSchema.parse(value)).toEqual(value);
    expect(value.traces.every((trace) => !Object.hasOwn(trace, "events"))).toBe(true);
  });
  it.each([
    "scope",
    "request",
    "cut",
    "capture",
    "root",
    "rules",
    "authority_scope",
    "authority_time",
    "authority_end",
    "artifact_scope",
    "artifact_time",
    "artifact_end",
    "trace_scope",
    "event",
    "event_hash",
    "trace_index",
  ] as const)("rejects substituted input %s", (field) => {
    const value = input();
    if (field === "scope") value.sources.records.scope.tenantId = "tenant_other";
    else if (field === "request") value.rules.request.evaluationRequestId = "request_other";
    else if (field === "cut")
      value.rules.evaluationTime = "2026-10-01T00:00:00.000000000000000000000000000001Z";
    else if (field === "capture") value.capturedAt = "2026-09-01T00:00:00.000Z";
    else if (field === "root") value.roots.candidate.candidateVersionId = "candidate_other";
    else if (field === "rules")
      value.roots.policy.rules[0]!.rationale = "Substituted original rule";
    else if (field === "authority_scope")
      value.policyLifecycle.afterArtifacts.scope.tenantId = "tenant_other";
    else if (field === "authority_time")
      value.policyLifecycle.afterArtifacts.evaluationTime = "2026-09-01T00:00:00.000Z";
    else if (field === "authority_end")
      value.policyLifecycle.afterArtifacts.completedAt = "2026-10-04T00:00:00.000Z";
    else if (field === "artifact_scope") value.artifacts[0]!.scope.projectId = "project_other";
    else if (field === "artifact_time")
      value.artifacts[0]!.evaluationTime = "2026-09-01T00:00:00.000Z";
    else if (field === "artifact_end") value.artifacts[0]!.completedAt = "2026-10-04T00:00:00.000Z";
    else if (field === "trace_scope") value.traces[0]!.scope.environmentId = "env_other";
    else if (field === "event") value.traceArtifactReferences[0]!.eventId = "event_other";
    else if (field === "event_hash")
      value.traceArtifactReferences[0]!.eventRecordSha256 = "b".repeat(64);
    else value.traceArtifactReferences[0]!.traceCaptureIndex = 999;
    expect(PolicyEvaluationSnapshotInputsSchema.safeParse(value).success).toBe(false);
  });
  it("rejects total input overflow before inspecting artifact/root material", () => {
    const value = input();
    value.artifacts = Array.from({ length: 100000 }, () => value.artifacts[0]!);
    Object.defineProperty(value.roots, "candidate", {
      get() {
        throw new Error("Root material read before admission");
      },
    });
    expect(PolicyEvaluationSnapshotInputsSchema.safeParse(value).success).toBe(false);
  });
  it("rejects a trace fingerprint list that omits an original selected event", () => {
    const value = input().traces[0]!;
    if (value.observation.status !== "verified") throw new Error("Missing verified trace fixture");
    value.observation.eventSha256 = [];
    expect(PolicyEvaluationSnapshotTraceSchema.safeParse(value).success).toBe(false);
  });
  it.each([
    "catalog",
    "descriptor",
    "ownership",
    "state",
    "expiry",
    "sha",
    "size",
    "clock",
    "plaintext",
  ] as const)("rejects invalid artifact %s", (field) => {
    const value = input().artifacts.find((a) => a.observation.status === "verified")!;
    if (!value?.catalog || value.observation.status !== "verified")
      throw new Error("Missing verified artifact fixture");
    if (field === "catalog") value.catalog = null;
    else if (field === "descriptor")
      value.catalog.metadata.contentReference.sha256 = "b".repeat(64);
    else if (field === "ownership")
      value.catalog.ownership = {
        artifactId: "artifact_other",
        boundAt: value.completedAt,
        boundByPrincipalId: "principal_owner",
        schemaVersion: "0.1",
        scope: value.scope,
        owner: {
          kind: "regression_fixture_version",
          fixtureId: "fixture_owner",
          fixtureVersionId: "fixture_owner_v1",
        },
      };
    else if (field === "state") {
      value.catalog.metadata.state = "tombstoned";
      value.catalog.metadata.tombstonedAt = value.completedAt;
    } else if (field === "expiry")
      value.catalog.metadata.retention = { mode: "expire", expiresAt: value.completedAt };
    else if (field === "sha") value.observation.sha256 = "b".repeat(64);
    else if (field === "size") value.observation.sizeBytes++;
    else if (field === "clock") value.startedAt = "2026-09-01T00:00:00.000Z";
    else Reflect.set(value, "plaintext", "caller_content");
    expect(PolicyEvaluationSnapshotArtifactSchema.safeParse(value).success).toBe(false);
  });
  it("retains an unsupported content descriptor without upgrading it to an artifact", () => {
    const value = input().artifacts[0]!;
    value.reference.mediaType = "unsupported provider media type";
    value.reference.sizeBytes = 0;
    value.catalog = null;
    value.observation = { status: "unavailable", reason: "reference_unsupported" };
    expect(PolicyEvaluationSnapshotArtifactSchema.parse(value)).toEqual(value);
  });
  it.each(["conjunction", "dimension", "policy", "scope", "cut"] as const)(
    "rejects changed applicability %s",
    (field) => {
      const value = input().applicability;
      if (field === "conjunction") value.conjunction = "match";
      else if (field === "dimension") value.dimensions[0].status = "match";
      else if (field === "policy") value.policy.recordSha256 = "b".repeat(64);
      else if (field === "scope") value.lifecycle.scope.tenantId = "tenant_other";
      else value.lifecycle.evaluationTime = "2026-09-01T00:00:00.000Z";
      expect(PolicyEvaluationSnapshotApplicabilitySchema.safeParse(value).success).toBe(false);
    },
  );
});
