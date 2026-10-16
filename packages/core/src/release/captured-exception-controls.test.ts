import { readFileSync } from "node:fs";
import {
  type ReleaseApproval,
  ReleaseApprovalDefinitionSchema,
  ReleaseApprovalSchema,
  ReleaseDecisionControlObservationSchema,
  type ReleaseDecisionVerificationLimits,
} from "@proofstack/contracts";
import { describe, expect, it } from "vitest";
import {
  InvalidCapturedExceptionControlsError,
  inspectCapturedExceptionControls,
} from "./captured-exception-controls.js";
import {
  digestReleaseApprovalDefinition,
  releaseApprovalReference,
} from "./release-authority-record-validation.js";
import {
  ReleaseDecisionVerificationBudget,
  ReleaseDecisionVerificationBudgetError,
} from "./release-decision-verification-budget.js";

const limits: ReleaseDecisionVerificationLimits = {
  maxAcquisitionRecords: 100_000,
  maxAcquisitionRecordBytes: 64 * 1024 * 1024,
  maxApprovalRecords: 4096,
};
function fixture(count = 1) {
  const original = JSON.parse(
    readFileSync(
      new URL("../../../contracts/vectors/release-approval-definition-v1.json", import.meta.url),
      "utf8",
    ),
  ).vectors[2].input.definition;
  const references = Array.from({ length: count }, (_, index) => ({
    artifactId: `artifact_control_${index.toString().padStart(2, "0")}`,
    classification: "internal" as const,
    mediaType: "application/json",
    sha256: "a".repeat(64),
    sizeBytes: 10,
  }));
  const definition = ReleaseApprovalDefinitionSchema.parse({
    ...original,
    recordedAt: "2026-10-15T10:10:00.000001Z",
    compensatingControls: references,
  });
  const approval = ReleaseApprovalSchema.parse({
    ...definition,
    schemaVersion: "0.1",
    definitionSha256: digestReleaseApprovalDefinition(definition.subject.scope, definition),
  });
  const observations = references.map((reference, controlIndex) => {
    const catalog = {
      metadata: {
        schemaVersion: "0.1",
        scope: approval.subject.scope,
        contentReference: reference,
        state: "available",
        createdAt: "2026-10-15T08:00:00.000001Z",
        availableAt: "2026-10-15T09:00:00.000001Z",
        redaction: { status: "not_required" },
        retention: { mode: "expire", expiresAt: "2026-10-15T11:00:00.000001Z" },
      },
      ownership: null,
      recordSha256: "b".repeat(64),
    };
    return ReleaseDecisionControlObservationSchema.parse({
      approval: releaseApprovalReference(approval),
      controlIndex,
      scope: approval.subject.scope,
      reference,
      content: {
        state: "captured",
        startedAt: "2026-10-15T10:11:00.000001Z",
        completedAt: "2026-10-15T10:12:00.000001Z",
        catalog,
        observation: {
          status: "verified",
          sha256: reference.sha256,
          sizeBytes: reference.sizeBytes,
        },
      },
      underGuards: { state: "observed", record: catalog },
    });
  });
  return {
    approval,
    observations,
    capturedAt: "2026-10-15T10:20:00.000001Z",
    budget: new ReleaseDecisionVerificationBudget(limits),
  };
}
function captured(value: ReturnType<typeof fixture>, index = 0) {
  const source = value.observations[index];
  if (
    source?.content.state !== "captured" ||
    source.content.catalog === null ||
    source.underGuards.state !== "observed"
  )
    throw new Error("Missing captured fixture catalog");
  return { source, content: source.content, catalog: source.underGuards.record };
}
function resign(record: ReleaseApproval) {
  const { schemaVersion: _version, definitionSha256: _digest, ...definition } = record;
  const parsed = ReleaseApprovalDefinitionSchema.parse(definition);
  return ReleaseApprovalSchema.parse({
    ...parsed,
    schemaVersion: "0.1",
    definitionSha256: digestReleaseApprovalDefinition(parsed.subject.scope, parsed),
  });
}

describe("captured exact exception controls, never effectiveness or publication authority", () => {
  it("retains every one of sixteen original numeric occurrences regardless of input order", () => {
    const value = fixture(16);
    value.observations.reverse();
    const result = inspectCapturedExceptionControls(value);
    expect(result.state).toBe("retained");
    expect(result.observations.map(({ controlIndex }) => controlIndex)).toEqual(
      Array.from({ length: 16 }, (_, index) => index),
    );
    expect(result.observations.map(({ reference }) => reference)).toEqual(
      value.approval.compensatingControls,
    );
    expect(result.expiresAt).toBe("2026-10-15T11:00:00.000001Z");
    expect(value.budget.snapshot().approvalRecords).toBe(1);
    expect(value.budget.snapshot().records).toBe(49);
  });
  it("retains a missing final occurrence rather than returning a favorable prefix", () => {
    const value = fixture(16);
    value.observations.pop();
    const result = inspectCapturedExceptionControls(value);
    expect(result.state).toBe("unavailable");
    expect(result.observations).toHaveLength(16);
    expect(result.observations.at(-1)?.state).toBe("missing");
    expect(result.expiresAt).toBeNull();
  });
  it.each(["missing", "unavailable", "invalid"] as const)(
    "retains a %s under-guard catalog",
    (state) => {
      const value = fixture();
      captured(value).source.underGuards =
        state === "invalid" ? { state, observedRecordSha256: "c".repeat(64) } : { state };
      expect(inspectCapturedExceptionControls(value)).toMatchObject({
        state: "unavailable",
        observations: [{ state: "unavailable" }],
      });
    },
  );
  it("retains uninspected controls without inventing an attempt or verified condition", () => {
    const value = fixture();
    captured(value).source.content = { state: "not_inspected", reason: "acquisition_unavailable" };
    expect(inspectCapturedExceptionControls(value)).toMatchObject({
      state: "unavailable",
      observations: [{ state: "not_inspected" }],
    });
  });
  it("does not substitute retained catalogs for failed content verification", () => {
    const value = fixture();
    captured(value).content.observation = {
      status: "unavailable",
      reason: "content_integrity_failed",
    };
    expect(inspectCapturedExceptionControls(value)).toMatchObject({
      state: "unavailable",
      observations: [{ state: "unverified" }],
    });
  });
  it.each(["digest", "metadata", "tombstone"] as const)(
    "retains an intervening %s change even after verified bytes",
    (kind) => {
      const value = fixture();
      const { catalog } = captured(value);
      if (kind === "digest") catalog.recordSha256 = "c".repeat(64);
      if (kind === "metadata") catalog.metadata.retention = { mode: "retain" };
      if (kind === "tombstone") {
        catalog.metadata.state = "tombstoned";
        catalog.metadata.tombstonedAt = "2026-10-15T10:19:00.000001Z";
      }
      expect(inspectCapturedExceptionControls(value)).toMatchObject({
        state: "unavailable",
        observations: [{ state: "changed" }],
      });
    },
  );
  it.each([
    ["2026-10-15T11:00:00.000000999999Z", "retained"],
    ["2026-10-15T11:00:00.000001Z", "expired"],
    ["2026-10-15T11:00:00.000001000001Z", "expired"],
  ])("compares exact native expiry against full-precision cut %s", (capturedAt, state) => {
    const value = fixture();
    value.capturedAt = capturedAt;
    expect(inspectCapturedExceptionControls(value).observations[0]?.state).toBe(state);
  });
  it("retains indefinite catalog storage without inventing a future deadline", () => {
    const value = fixture();
    const { catalog, content } = captured(value);
    catalog.metadata.retention = { mode: "retain" };
    content.catalog = structuredClone(catalog);
    expect(inspectCapturedExceptionControls(value)).toMatchObject({
      state: "retained",
      expiresAt: null,
    });
  });
  it("keeps the earliest real catalog expiry across every original occurrence", () => {
    const value = fixture(2);
    const { catalog, content } = captured(value, 1);
    catalog.metadata.retention = { mode: "expire", expiresAt: "2026-10-15T10:30:00.000001Z" };
    content.catalog = structuredClone(catalog);
    expect(inspectCapturedExceptionControls(value).expiresAt).toBe("2026-10-15T10:30:00.000001Z");
  });
  it.each(["created", "available"] as const)(
    "rejects a catalog whose %s receipt postdates its alleged successful capture",
    (kind) => {
      const value = fixture();
      const { catalog, content } = captured(value);
      if (kind === "created") catalog.metadata.createdAt = "2026-10-15T10:13:00.000001Z";
      catalog.metadata.availableAt = "2026-10-15T10:13:00.000001Z";
      content.catalog = structuredClone(catalog);
      expect(inspectCapturedExceptionControls(value).state).toBe("unavailable");
    },
  );
  it.each([
    "digest",
    "scope",
    "reference",
    "index",
    "duplicate",
    "future_content",
    "future_action",
    "kind",
    "unknown",
    "extra",
  ] as const)("rejects substituted %s without a partial result", (kind) => {
    const value = fixture();
    const { source, content } = captured(value);
    if (kind === "digest") value.approval.definitionSha256 = "c".repeat(64);
    if (kind === "scope") source.scope = { ...source.scope, environmentId: "environment_other" };
    if (kind === "reference") source.approval.definitionSha256 = "c".repeat(64);
    if (kind === "index") source.controlIndex = 1;
    if (kind === "duplicate") value.observations.push(structuredClone(source));
    if (kind === "future_content") content.completedAt = "2026-10-15T10:21:00.000001Z";
    if (kind === "future_action") value.capturedAt = "2026-10-15T10:09:00.000001Z";
    if (kind === "kind") {
      value.approval.kind = "normal_approval";
      value.approval.compensatingControls = [];
      value.approval = resign(value.approval);
    }
    if (kind === "unknown") Reflect.set(source, "matched", true);
    if (kind === "extra")
      value.observations = Array.from({ length: 17 }, () => structuredClone(source));
    expect(() => inspectCapturedExceptionControls(value)).toThrow(
      InvalidCapturedExceptionControlsError,
    );
  });
  it.each(["records", "recordBytes", "approvalRecords"] as const)(
    "admits exact %s and taints an original meter one unit below",
    (kind) => {
      const probe = fixture(16);
      inspectCapturedExceptionControls(probe);
      const usage = probe.budget.snapshot();
      const exact = {
        maxAcquisitionRecords: usage.records,
        maxAcquisitionRecordBytes: usage.recordBytes,
        maxApprovalRecords: usage.approvalRecords,
      };
      const value = fixture(16);
      value.budget = new ReleaseDecisionVerificationBudget(exact);
      expect(inspectCapturedExceptionControls(value).state).toBe("retained");
      const short = { ...exact };
      if (kind === "records") short.maxAcquisitionRecords--;
      if (kind === "recordBytes") short.maxAcquisitionRecordBytes--;
      if (kind === "approvalRecords") short.maxApprovalRecords--;
      const rejected = fixture(16);
      rejected.budget = new ReleaseDecisionVerificationBudget(short);
      expect(() => inspectCapturedExceptionControls(rejected)).toThrow(
        ReleaseDecisionVerificationBudgetError,
      );
      expect(() => rejected.budget.snapshot()).toThrow(ReleaseDecisionVerificationBudgetError);
    },
  );
  it("returns owned references without changing the approval or observations", () => {
    const value = fixture();
    const before = structuredClone({ approval: value.approval, observations: value.observations });
    const result = inspectCapturedExceptionControls(value);
    expect({ approval: value.approval, observations: value.observations }).toEqual(before);
    const reference = result.observations[0]?.reference;
    if (!reference) throw new Error("Missing returned reference");
    reference.artifactId = "artifact_changed";
    expect(value.approval.compensatingControls[0]?.artifactId).toBe("artifact_control_00");
  });
  it("rejects outer authority fields before consuming an original meter", () => {
    const value = fixture();
    Reflect.set(value, "matched", true);
    expect(() => inspectCapturedExceptionControls(value)).toThrow(
      InvalidCapturedExceptionControlsError,
    );
    expect(value.budget.snapshot().records).toBe(0);
  });
  it("rejects a caller callback disguised as the original admission meter", () => {
    const value = fixture();
    let called = false;
    Reflect.set(value, "budget", {
      observe: () => {
        called = true;
      },
    });
    expect(() => inspectCapturedExceptionControls(value)).toThrow(
      InvalidCapturedExceptionControlsError,
    );
    expect(called).toBe(false);
  });
  it("rejects conflicting under-guard observations for one physical artifact across two exact references", () => {
    const value = fixture(2);
    const first = value.approval.compensatingControls[0];
    const second = value.approval.compensatingControls[1];
    if (!first || !second) throw new Error("Missing two-control fixture");
    second.artifactId = first.artifactId;
    second.sha256 = "c".repeat(64);
    value.approval = resign(value.approval);
    for (const source of value.observations)
      source.approval = releaseApprovalReference(value.approval);
    const { source, content, catalog } = captured(value, 1);
    source.reference = structuredClone(second);
    catalog.metadata.contentReference = structuredClone(second);
    if (!content.catalog) throw new Error("Missing original content catalog");
    content.catalog.metadata.contentReference = structuredClone(second);
    content.observation = {
      status: "verified",
      sha256: second.sha256,
      sizeBytes: second.sizeBytes,
    };
    expect(() => inspectCapturedExceptionControls(value)).toThrow(
      InvalidCapturedExceptionControlsError,
    );
  });
  it("does not call an empty control inventory retained evidence", () => {
    const value = fixture();
    value.approval.action = "abstain";
    value.approval.compensatingControls = [];
    value.approval = resign(value.approval);
    value.observations = [];
    expect(inspectCapturedExceptionControls(value)).toEqual({
      state: "unavailable",
      observations: [],
      expiresAt: null,
    });
  });
  it("retains an original missing-content attempt without inventing verified bytes from a later catalog", () => {
    const value = fixture();
    const { content } = captured(value);
    content.catalog = null;
    content.observation = { status: "missing" };
    expect(inspectCapturedExceptionControls(value)).toMatchObject({
      state: "unavailable",
      observations: [{ state: "unverified" }],
    });
  });
  it("retained control evidence cannot turn an opposing review into approval", () => {
    const value = fixture();
    value.approval.action = "oppose";
    value.approval = resign(value.approval);
    const source = value.observations[0];
    if (!source) throw new Error("Missing control observation");
    source.approval = releaseApprovalReference(value.approval);
    const result = inspectCapturedExceptionControls(value);
    expect(result.state).toBe("retained");
    expect(value.approval.action).toBe("oppose");
    expect(Object.keys(result).sort()).toEqual(["expiresAt", "observations", "state"]);
  });
});
