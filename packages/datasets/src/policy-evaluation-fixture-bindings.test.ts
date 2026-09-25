import { readFileSync } from "node:fs";
import type {
  ArtifactOwnership,
  RecordedInteractionFixtureVersion,
  RecordedInteractionFixtureVersionDefinition,
} from "@proofstack/contracts";
import { describe, expect, it, vi } from "vitest";
import { digestRecordedInteractionFixtureVersionDefinition } from "./interaction-fixture-definition-digest.js";
import { inspectPolicyEvaluationDataset } from "./policy-evaluation-dataset-reader.js";
import {
  inspectPolicyEvaluationFixtureArtifactBindings as inspect,
  type PolicyFixtureArtifactCatalog,
} from "./policy-evaluation-fixture-bindings.js";

const vectors = JSON.parse(
  readFileSync(
    new URL("../vectors/interaction-fixture-definition-v2.json", import.meta.url),
    "utf8",
  ),
) as { vectors: { input: RecordedInteractionFixtureVersionDefinition }[] };
const publishedAt = "2026-09-08T00:00:00.123Z";
const catalogHash = "d".repeat(64);

function harness(applied = false) {
  const definition = structuredClone(
    vectors.vectors[0]?.input,
  ) as RecordedInteractionFixtureVersionDefinition;
  if (applied) {
    for (const binding of definition.interactionCapture.artifacts) {
      binding.contentReference.redactedAt = "source";
      binding.redaction = {
        status: "applied",
        records: [
          {
            stage: "source",
            rulesetId: "rule_private",
            rulesetVersion: "1",
            changedPaths: ["/secret"],
            matchCount: 1,
          },
        ],
      };
    }
  }
  const version: RecordedInteractionFixtureVersion = {
    ...definition,
    createdAt: publishedAt,
    createdByPrincipalId: "principal_publisher",
    definitionSha256: digestRecordedInteractionFixtureVersionDefinition(definition),
    source: { ...definition.source, capturedAt: "2026-09-08T00:00:00.000Z" },
  };
  const input = {
    scope: version.scope,
    evaluationTime: publishedAt,
    source: {
      kind: "regression_fixture_version" as const,
      reference: {
        fixtureId: version.fixtureId,
        fixtureVersionId: version.fixtureVersionId,
        definitionSha256: version.definitionSha256,
      },
    },
  };
  const evidence = inspectPolicyEvaluationDataset(input, version);
  const catalogs: PolicyFixtureArtifactCatalog[] = version.interactionCapture.artifacts.map(
    (binding) => ({
      recordSha256: catalogHash,
      metadata: {
        contentReference: structuredClone(binding.contentReference),
        schemaVersion: "0.1",
        scope: structuredClone(version.scope),
        createdAt: "2026-09-08T00:00:00.122Z",
        availableAt: publishedAt,
        state: "available",
        redaction: structuredClone(binding.redaction),
        retention: { mode: "retain" },
      },
      ownership: {
        artifactId: binding.contentReference.artifactId,
        schemaVersion: "0.1",
        scope: structuredClone(version.scope),
        boundAt: publishedAt,
        boundByPrincipalId: version.createdByPrincipalId,
        owner: {
          kind: "regression_fixture_version",
          fixtureId: version.fixtureId,
          fixtureVersionId: version.fixtureVersionId,
        },
      },
    }),
  );
  const first = catalogs[0] as PolicyFixtureArtifactCatalog;
  return {
    input,
    evidence,
    catalogs,
    first,
    version,
    execute: () => inspect(input, evidence, catalogs),
  };
}

describe("recorded-fixture policy artifact binding inspection", () => {
  it.each([false, true])(
    "retains every binding and full observed hashes with applied redaction=%s",
    (applied) => {
      const h = harness(applied);
      expect(h.execute()).toEqual({
        source: h.input.source,
        recordSha256:
          h.evidence.observation.status === "verified" ? h.evidence.observation.recordSha256 : null,
        artifacts: h.version.interactionCapture.artifacts.map(
          ({ contentReference }, bindingIndex) => ({
            artifactId: contentReference.artifactId,
            bindingIndex,
            catalogRecordSha256: catalogHash,
            observation: { status: "matched" },
          }),
        ),
      });
    },
  );

  it("keeps null catalog observations unavailable rather than a proven missing owner", () => {
    const h = harness();
    const result = inspect(
      h.input,
      h.evidence,
      h.catalogs.map(() => null),
    );
    expect(
      result.artifacts.every(
        (binding) =>
          binding.catalogRecordSha256 === null && binding.observation.status === "unavailable",
      ),
    ).toBe(true);
  });

  it.each(["tenantId", "projectId", "environmentId"] as const)(
    "rejects catalog %s mismatches",
    (field) => {
      const h = harness();
      h.first.metadata.scope[field] = "foreign_scope";
      expect(h.execute().artifacts[0]?.observation).toEqual({
        status: "mismatch",
        reason: "scope_mismatch",
      });
    },
  );

  it.each(["artifactId", "sha256", "mediaType", "classification", "sizeBytes"] as const)(
    "rejects descriptor %s mismatches",
    (field) => {
      const h = harness();
      Object.assign(h.first.metadata.contentReference, {
        [field]: {
          artifactId: "artifact_wrong",
          sha256: "f".repeat(64),
          mediaType: "text/plain",
          classification: "internal",
          sizeBytes: 1,
        }[field],
      });
      expect(h.execute().artifacts[0]?.observation).toEqual({
        status: "mismatch",
        reason: "descriptor_mismatch",
      });
    },
  );

  it("does not substitute expiry for the publication's retain requirement", () => {
    const h = harness();
    h.first.metadata.retention = { mode: "expire", expiresAt: "2027-01-01T00:00:00.000Z" };
    expect(h.execute().artifacts[0]?.observation).toEqual({
      status: "mismatch",
      reason: "retention_mismatch",
    });
  });

  it.each(["status", "stage", "rulesetId", "rulesetVersion", "changedPaths", "matchCount"])(
    "rejects redaction %s substitution",
    (field) => {
      const h = harness(field !== "status");
      if (field === "status") h.first.metadata.redaction = { status: "not_performed" };
      else if (h.first.metadata.redaction.status === "applied")
        Object.assign(h.first.metadata.redaction.records[0] as object, {
          [field]: {
            stage: "ingest",
            rulesetId: "rule_other",
            rulesetVersion: "2",
            changedPaths: ["/other"],
            matchCount: 2,
          }[field],
        });
      if (field === "stage") h.first.metadata.contentReference.redactedAt = "ingest";
      expect(h.execute().artifacts[0]?.observation).toEqual({
        status: "mismatch",
        reason: field === "stage" ? "descriptor_mismatch" : "redaction_mismatch",
      });
    },
  );

  it.each(["unavailable_at_publication", "creation_after", "activation_after"])(
    "rejects %s without rounding away a late receipt",
    (kind) => {
      const h = harness();
      if (kind === "unavailable_at_publication") {
        h.first.metadata.state = "reserved";
        delete h.first.metadata.availableAt;
      } else {
        h.first.metadata.availableAt = "2026-09-08T00:00:00.123000000000000000000000000001Z";
        if (kind === "creation_after") h.first.metadata.createdAt = h.first.metadata.availableAt;
      }
      expect(h.execute().artifacts[0]?.observation).toEqual({
        status: "mismatch",
        reason: "publication_time_mismatch",
      });
    },
  );

  it("accepts equality and the last instant before publication, preserving lexical catalog receipts", () => {
    const h = harness();
    h.first.metadata.availableAt = "2026-09-08T00:00:00.122999999999999999999999999999Z";
    expect(h.execute().artifacts[0]?.observation).toEqual({ status: "matched" });
  });

  it("does not confuse a retained immutable binding with current byte availability after tombstoning", () => {
    const h = harness();
    h.first.metadata.state = "tombstoned";
    h.first.metadata.tombstonedAt = "2026-09-09T00:00:00.000Z";
    expect(h.execute().artifacts[0]?.observation).toEqual({ status: "matched" });
  });

  it("reports a missing owner on a known catalog", () => {
    const h = harness();
    Object.assign(h.first, { ownership: null });
    expect(h.execute().artifacts[0]?.observation).toEqual({
      status: "mismatch",
      reason: "ownership_missing",
    });
  });

  it.each([
    "artifactId",
    "fixtureId",
    "fixtureVersionId",
    "boundAt",
    "boundByPrincipalId",
    "tenantId",
    "projectId",
    "environmentId",
  ])("rejects substituted ownership %s", (field) => {
    const h = harness();
    const owner = h.first.ownership as ArtifactOwnership;
    if (field === "fixtureId" || field === "fixtureVersionId") owner.owner[field] = "other_fixture";
    else if (field === "tenantId" || field === "projectId" || field === "environmentId")
      owner.scope[field] = "other_scope";
    else
      Object.assign(owner, {
        [field]: field === "boundAt" ? "2026-09-08T00:00:00.124Z" : "other_principal_or_artifact",
      });
    expect(h.execute().artifacts[0]?.observation).toEqual({
      status: "mismatch",
      reason: "ownership_mismatch",
    });
  });

  it.each([
    "short",
    "extra",
    "not_array",
    "hole",
    "extra_property",
    "hidden",
    "missing",
    "getter",
    "bad_metadata",
    "bad_owner",
    "bad_hash",
  ])("rejects malformed projection inventory: %s", (kind) => {
    const h = harness();
    let catalogs: unknown = h.catalogs;
    const getter = vi.fn(() => h.first.metadata);
    if (kind === "short") h.catalogs.pop();
    if (kind === "extra") h.catalogs.push(h.first);
    if (kind === "not_array") catalogs = {};
    if (kind === "hole") delete h.catalogs[0];
    if (kind === "extra_property") Object.assign(h.first, { extra: true });
    if (kind === "hidden") Object.defineProperty(h.first, "metadata", { enumerable: false });
    if (kind === "missing") {
      Reflect.deleteProperty(h.first, "metadata");
      Object.assign(h.first, { other: true });
    }
    if (kind === "getter")
      Object.defineProperty(h.first, "metadata", { enumerable: true, get: getter });
    if (kind === "bad_metadata") Object.assign(h.first.metadata, { extra: true });
    if (kind === "bad_owner") Object.assign(h.first.ownership as object, { boundAt: "yesterday" });
    if (kind === "bad_hash") Object.assign(h.first, { recordSha256: "bad" });
    expect(() =>
      inspect(h.input, h.evidence, catalogs as PolicyFixtureArtifactCatalog[]),
    ).toThrowError(expect.objectContaining({ reason: "input_invalid" }));
    expect(getter).not.toHaveBeenCalled();
  });

  it.each(["digest", "receipt", "source", "cut", "unverified"])(
    "revalidates immutable parent %s before matching catalogs",
    (kind) => {
      const h = harness();
      if (kind === "digest" && h.evidence.record) h.evidence.record.name = "tampered";
      if (kind === "receipt" && h.evidence.record)
        h.evidence.record.createdByPrincipalId = "principal_other";
      if (kind === "source") h.evidence.source.reference.definitionSha256 = "f".repeat(64);
      if (kind === "cut") h.input.evaluationTime = "2026-09-08T00:00:00.122Z";
      if (kind === "unverified") Object.assign(h.evidence, { observation: { status: "missing" } });
      expect(h.execute).toThrow();
    },
  );

  it("rejects evidence-only fixtures and datasets, rather than imposing ownership on ordinary evidence", () => {
    const document = JSON.parse(
      readFileSync(new URL("../vectors/regression-definition-v1.json", import.meta.url), "utf8"),
    ) as { vectors: { input: Record<string, unknown>; sha256: string }[] };
    for (const vector of document.vectors) {
      const body: Record<string, unknown> = {
        ...vector.input,
        createdAt: publishedAt,
        createdByPrincipalId: "principal_source",
        definitionSha256: vector.sha256,
        ...(vector.input["source"]
          ? { source: { ...(vector.input["source"] as object), capturedAt: publishedAt } }
          : {}),
      };
      const input = {
        scope: vector.input["scope"],
        evaluationTime: publishedAt,
        source:
          "datasetVersionId" in body
            ? {
                kind: "dataset_version",
                reference: {
                  datasetId: body["datasetId"],
                  datasetVersionId: body["datasetVersionId"],
                  definitionSha256: vector.sha256,
                },
              }
            : {
                kind: "regression_fixture_version",
                reference: {
                  fixtureId: body["fixtureId"],
                  fixtureVersionId: body["fixtureVersionId"],
                  definitionSha256: vector.sha256,
                },
              },
      } as Parameters<typeof inspect>[0];
      const evidence = inspectPolicyEvaluationDataset(input, body);
      expect(evidence.observation.status).toBe("verified");
      expect(() => inspect(input, evidence, [])).toThrowError(
        expect.objectContaining({ reason: "input_invalid" }),
      );
    }
  });

  it("returns detached provenance and never changes input observations", () => {
    const h = harness();
    const before = structuredClone({ input: h.input, evidence: h.evidence, catalogs: h.catalogs });
    const result = h.execute();
    result.source.reference.definitionSha256 = "f".repeat(64);
    Object.assign(result.artifacts[0] as object, { artifactId: "changed" });
    expect({ input: h.input, evidence: h.evidence, catalogs: h.catalogs }).toEqual(before);
    expect(h.execute().artifacts[0]?.artifactId).not.toBe("changed");
  });
});
