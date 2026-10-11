import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  type EndpointProfileDefinition,
  type EndpointProfileRecord,
  encodeEvaluationCanonicalJson,
  type ModelInteraction,
  type RecordedInteractionFixtureVersion,
  type RecordedInteractionFixtureVersionDefinition,
  type RegressionFixtureVersion,
} from "@proofstack/contracts";
import * as core from "@proofstack/core";
import {
  digestEndpointProfile,
  InvalidEndpointProfileRecordError,
  StaticEndpointProfileCatalogue,
} from "@proofstack/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { digestRecordedInteractionFixtureVersionDefinition } from "./interaction-fixture-definition-digest.js";
import {
  inspectPolicyEvaluationDataset,
  inspectPolicyEvaluationDatasetCapture,
} from "./policy-evaluation-dataset-reader.js";
import * as references from "./policy-evaluation-dataset-references.js";
import {
  inspectPolicyEvaluationModelEndpointResolution as inspect,
  inspectPolicyEvaluationStoredModelEndpointResolution as inspectStored,
  PolicyEvaluationModelEndpointInputError,
  readPolicyEvaluationModelEndpointResolution as read,
  readPolicyEvaluationStoredModelEndpointResolution as readStored,
} from "./policy-evaluation-model-endpoint-resolution.js";

const fixtureVector = JSON.parse(
  readFileSync(
    new URL("../vectors/interaction-fixture-definition-v2.json", import.meta.url),
    "utf8",
  ),
) as { vectors: { input: RecordedInteractionFixtureVersionDefinition }[] };
const endpointVector = JSON.parse(
  readFileSync(
    new URL("../../contracts/vectors/endpoint-profile-v1.json", import.meta.url),
    "utf8",
  ),
) as { vectors: { input: { definition: EndpointProfileDefinition } }[] };
const limits = { maxReferences: 1000, maxReferenceBytes: 1_000_000 };
const evaluationTime = "2026-10-01T00:00:00.000000Z";
const hash = (value: unknown) =>
  createHash("sha256").update(encodeEvaluationCanonicalJson(value)).digest("hex");

function rehash(record: EndpointProfileRecord) {
  const {
    registeredAt: _at,
    registeredByPrincipalId: _by,
    definitionSha256: _sha,
    schemaVersion: _version,
    scope,
    ...definition
  } = record;
  record.definitionSha256 = digestEndpointProfile(scope, definition);
  return record;
}

function harness(
  options: {
    repeated?: boolean;
    tool?: boolean;
    operation?: ModelInteraction["attempts"][number]["provider"]["operation"];
  } = {},
) {
  // Independent operator data is defined first. Publish a NEW synthetic fixture afterwards;
  // no old placeholder hashes, historical receipts or actual provider execution are invented.
  const definition = structuredClone(endpointVector.vectors[0]?.input.definition);
  if (!definition) throw new Error("Missing independent endpoint vector");
  definition.operations = ["chat", "generate_content", "text_completion"];
  const fixtureDefinition = structuredClone(fixtureVector.vectors[0]?.input);
  if (!fixtureDefinition) throw new Error("Missing independent capture vector");
  const endpoint: EndpointProfileRecord = {
    ...definition,
    scope: structuredClone(fixtureDefinition.scope),
    schemaVersion: "0.1",
    definitionSha256: digestEndpointProfile(fixtureDefinition.scope, definition),
    registeredAt: "2026-09-01T00:00:00.001Z",
    registeredByPrincipalId: "operator_endpoint",
  };
  const model = fixtureDefinition.interactionCapture.interactions[0];
  if (model?.kind !== "model") throw new Error("Expected original model vector");
  const attempt = model.attempts[0];
  if (!attempt) throw new Error("Missing original attempt");
  const configuration = fixtureDefinition.interactionCapture.artifacts.find(
    (a) => a.contentReference.artifactId === attempt.artifacts.providerConfigurationArtifactId,
  );
  if (!configuration) throw new Error("Missing original configuration binding");
  configuration.contentReference = structuredClone(endpoint.configuration);
  configuration.redaction = {
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
  attempt.artifacts.providerConfigurationArtifactId = endpoint.configuration.artifactId;
  attempt.provider = {
    ...attempt.provider,
    endpointProfileId: endpoint.endpointProfileId,
    endpointProfileVersion: endpoint.endpointProfileVersion,
    name: endpoint.provider,
    operation: options.operation ?? attempt.provider.operation,
  };
  if (options.repeated) {
    model.attempts.push({
      ...structuredClone(attempt),
      attemptId: "attempt_repeated",
      sequence: 1,
    });
  }
  if (options.tool) {
    for (const [artifactId, role] of [
      ["tool_arguments", "tool.arguments"],
      ["tool_contract", "tool.contract"],
      ["tool_normalized", "tool.normalized_request"],
      ["tool_result", "tool.result"],
    ] as const)
      fixtureDefinition.interactionCapture.artifacts.push({
        contentReference: {
          artifactId,
          classification: "confidential",
          mediaType: "application/json",
          sha256: "b".repeat(64),
          sizeBytes: 32,
        },
        redaction: { status: "not_required" },
        retention: { mode: "retain" },
        role,
      });
    fixtureDefinition.interactionCapture.interactions.push({
      kind: "tool",
      interactionId: "interaction_tool",
      callId: "call_tool",
      sequence: 1,
      terminalOutcome: "succeeded",
      tool: {
        toolId: "tool_one",
        toolVersion: "1",
        artifactId: "tool_contract",
        definitionSha256: "b".repeat(64),
      },
      attempts: [
        {
          attemptId: "attempt_tool",
          sequence: 0,
          outcome: "succeeded",
          startedAt: attempt.endedAt,
          endedAt: attempt.endedAt,
          sideEffect: "read_only",
          effectMayHaveOccurred: false,
          normalizedRequest: {
            adapterName: "tool.json",
            adapterVersion: "1",
            artifactId: "tool_normalized",
            sha256: "b".repeat(64),
          },
          artifacts: { argumentsArtifactId: "tool_arguments", resultArtifactId: "tool_result" },
        },
      ],
    });
  }
  fixtureDefinition.interactionCapture.artifacts.sort((a, b) =>
    a.contentReference.artifactId < b.contentReference.artifactId ? -1 : 1,
  );
  const fixture: RecordedInteractionFixtureVersion = {
    ...fixtureDefinition,
    definitionSha256: digestRecordedInteractionFixtureVersionDefinition(fixtureDefinition),
    createdAt: "2026-09-08T00:00:00.123Z",
    createdByPrincipalId: "principal_fixture",
    source: { ...fixtureDefinition.source, capturedAt: "2026-09-08T00:00:00.000Z" },
  };
  const source = {
    kind: "regression_fixture_version" as const,
    reference: {
      fixtureId: fixture.fixtureId,
      fixtureVersionId: fixture.fixtureVersionId,
      definitionSha256: fixture.definitionSha256,
    },
  };
  const input = {
    source,
    scope: structuredClone(fixture.scope),
    evaluationTime,
    path: "/interactionCapture/interactions/0/attempts/0/provider",
    limits,
  };
  const evidence = inspectPolicyEvaluationDataset(
    { source, scope: input.scope, evaluationTime },
    fixture,
  );
  expect(evidence.observation.status).toBe("verified");
  const catalogue = new StaticEndpointProfileCatalogue([endpoint]);
  const reader = { findEndpointProfile: vi.fn(catalogue.findEndpointProfile.bind(catalogue)) };
  return { input, evidence, fixture, endpoint, reader };
}

afterEach(() => vi.restoreAllMocks());

function storedHarness(parentFuture = false, childFuture = false, repeated = false) {
  const h = harness({ repeated });
  h.fixture.createdAt = parentFuture ? "2026-10-01T00:00:00.001Z" : "2026-10-01T00:00:00.000Z";
  h.endpoint.registeredAt = childFuture ? "2026-10-01T00:00:00.001Z" : "2026-10-01T00:00:00.000Z";
  return {
    ...h,
    capture: inspectPolicyEvaluationDatasetCapture(
      { source: h.input.source, scope: h.input.scope, evaluationTime: h.input.evaluationTime },
      h.fixture,
    ),
    reader: {
      findEndpointProfile: vi.fn(async () => structuredClone(h.endpoint)),
    },
  };
}

function independentRecordHash(value: unknown): string {
  const ordered = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(ordered);
    if (v !== null && typeof v === "object")
      return Object.fromEntries(
        Object.entries(v)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, x]) => [k, ordered(x)]),
      );
    return v;
  };
  return createHash("sha256")
    .update(JSON.stringify(ordered(value)))
    .digest("hex");
}

describe("stored model endpoint occurrence resolution", () => {
  it.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ])(
    "retains original receipts with parent future=%s and child future=%s",
    async (parentFuture, childFuture) => {
      const h = storedHarness(parentFuture, childFuture);
      const catalogue = new StaticEndpointProfileCatalogue([h.endpoint]);
      const reader = { findEndpointProfile: vi.fn(catalogue.findEndpointProfile.bind(catalogue)) };
      const result = await readStored(h.input, h.capture, reader);
      expect(result).toEqual(inspectStored(h.input, h.capture, h.endpoint));
      expect(reader.findEndpointProfile).toHaveBeenCalledTimes(1);
      expect(reader.findEndpointProfile).toHaveBeenCalledWith(
        h.input.scope,
        h.endpoint.endpointProfileId,
        h.endpoint.endpointProfileVersion,
      );
      expect(result.parentStorage).toEqual({
        source: h.input.source,
        recordSha256: independentRecordHash(h.fixture),
        receiptTime: h.fixture.createdAt,
      });
      expect(result.parentSemanticObservation.status).toBe(
        parentFuture ? "unavailable" : "verified",
      );
      expect(result.childResolution.status).toBe(childFuture ? "unavailable" : "resolved");
      expect(result.childCapture?.storage).toEqual({
        record: h.endpoint,
        recordSha256: independentRecordHash(h.endpoint),
        receiptTime: h.endpoint.registeredAt,
      });
      expect(result.storageChecks.map((c) => c.observation.status)).toEqual(
        Array(4).fill("matched"),
      );
      expect(result.semanticChecks.map((c) => c.observation.status)).toEqual(
        Array(4).fill(parentFuture || childFuture ? "unavailable" : "matched"),
      );
      if (!parentFuture) {
        const ordinary = inspect(h.input, h.capture.read, h.endpoint);
        const {
          parent: _parent,
          reference: _ref,
          inspectionUsage: _usage,
          checks,
          ...resolution
        } = ordinary;
        expect(result.childResolution).toEqual(resolution);
        expect(result.semanticChecks).toEqual(checks);
      }
    },
  );

  it.each(["provider", "operations", "boundaryKinds", "configuration"] as const)(
    "keeps valid future %s conflicts distinct from semantic unavailability",
    (field) => {
      const h = storedHarness(true, true);
      const endpoint = structuredClone(h.endpoint);
      if (field === "provider") endpoint.provider = "other/provider";
      else if (field === "operations") endpoint.operations = ["unsupported_operation"];
      else if (field === "boundaryKinds") endpoint.boundaryKinds = ["tool"];
      else endpoint.configuration.sha256 = "b".repeat(64);
      rehash(endpoint);
      const result = inspectStored(h.input, h.capture, endpoint);
      expect(result.childCapture?.storage?.record).toEqual(endpoint);
      expect(result.childCapture?.storage?.recordSha256).toBe(independentRecordHash(endpoint));
      expect(
        result.storageChecks.filter((c) => c.observation.status === "mismatch").map((c) => c.kind),
      ).toEqual([
        field === "provider"
          ? "provider_name"
          : field === "operations"
            ? "operation"
            : field === "boundaryKinds"
              ? "boundary_kind"
              : "configuration",
      ]);
      expect(result.semanticChecks.every((c) => c.observation.status === "unavailable")).toBe(true);
    },
  );

  it.each(["tenantId", "projectId", "environmentId"] as const)(
    "rejects a valid substituted %s without retaining foreign storage",
    (key) => {
      const h = storedHarness(true, true);
      const endpoint = structuredClone(h.endpoint);
      endpoint.scope[key] = "outside_scope";
      const result = inspectStored(h.input, h.capture, rehash(endpoint));
      expect(result.childResolution).toEqual({
        status: "unavailable",
        reason: "reference_mismatch",
        evidence: null,
      });
      expect(result.childCapture?.storage).toBeNull();
      expect(result.storageChecks.every((c) => c.observation.status === "unavailable")).toBe(true);
    },
  );

  it("preserves missing and invalid observations and unchanged owning failures", async () => {
    const h = storedHarness(true, true);
    for (const [raw, status, reason] of [
      [null, "missing", undefined],
      [{}, "unavailable", "record_invalid"],
    ] as const) {
      const result = inspectStored(h.input, h.capture, raw);
      expect(result.childResolution).toEqual(
        reason ? { status, reason, evidence: null } : { status, evidence: null },
      );
      expect(result.childCapture).toBeNull();
      expect(result.storageChecks.every((c) => c.observation.status === "unavailable")).toBe(true);
    }
    for (const error of [
      new Error("owning lookup failure"),
      new InvalidEndpointProfileRecordError(),
    ]) {
      const reader = {
        findEndpointProfile: vi.fn(async () => {
          throw error;
        }),
      };
      await expect(readStored(h.input, h.capture, reader)).rejects.toBe(error);
    }
  });

  it("admits the entire repeated parent before every exact lookup", async () => {
    const h = storedHarness(true, true, true);
    const whole = references.enumeratePolicyEvaluationStoredDatasetReferences(
      { source: h.input.source, scope: h.input.scope, evaluationTime: h.input.evaluationTime },
      h.capture,
      limits,
    );
    const exact = {
      maxReferences: whole.references.length,
      maxReferenceBytes: whole.referenceBytes,
    };
    for (const index of [0, 1]) {
      const path = "/interactionCapture/interactions/0/attempts/" + index + "/provider";
      const result = await readStored({ ...h.input, path, limits: exact }, h.capture, h.reader);
      expect(result.reference.path).toBe(path);
      expect(result.inspectionUsage).toEqual({
        references: exact.maxReferences,
        referenceBytes: exact.maxReferenceBytes,
      });
    }
    expect(h.reader.findEndpointProfile).toHaveBeenCalledTimes(2);
    h.reader.findEndpointProfile.mockClear();
    for (const patch of [
      { maxReferences: exact.maxReferences - 1 },
      { maxReferenceBytes: exact.maxReferenceBytes - 1 },
    ])
      await expect(
        readStored({ ...h.input, limits: { ...exact, ...patch } }, h.capture, h.reader),
      ).rejects.toThrow();
    expect(h.reader.findEndpointProfile).not.toHaveBeenCalled();
  });

  it("owns input before parent getters and output across awaited port mutations", async () => {
    const h = storedHarness(true, true);
    const input = structuredClone(h.input);
    const original = structuredClone(h.capture);
    const captured = {
      ...h.capture,
      get storage() {
        input.scope.tenantId = "mutated_scope";
        input.evaluationTime = "2026-11-01T00:00:00.000Z";
        return original.storage;
      },
    };
    const reader = {
      findEndpointProfile: vi.fn(async (scope: typeof input.scope) => {
        expect(scope).toEqual(h.input.scope);
        scope.projectId = "mutated_scope";
        Reflect.set(h.capture, "storage", null);
        await Promise.resolve();
        return h.endpoint;
      }),
    };
    const result = await readStored(input, captured, reader);
    const expected = structuredClone(result);
    h.endpoint.registeredByPrincipalId = "mutated_operator";
    Reflect.set(original.storage ?? {}, "recordSha256", "0".repeat(64));
    expect(result).toEqual(expected);
    expect(result.parentSemanticObservation).toMatchObject({
      status: "unavailable",
      reason: "not_yet_available",
    });
  });

  it("rejects substituted parent witnesses and noncanonical paths before lookup", async () => {
    const h = storedHarness(true, true);
    for (const field of ["recordSha256", "receiptTime", "record"] as const) {
      const capture = structuredClone(h.capture);
      if (!capture.storage) throw new Error("Expected retained fixture");
      Reflect.set(
        capture.storage,
        field,
        field === "record"
          ? { ...h.fixture, createdByPrincipalId: "substituted_operator" }
          : field === "receiptTime"
            ? "2026-10-01T00:00:00.002Z"
            : "0".repeat(64),
      );
      await expect(readStored(h.input, capture, h.reader)).rejects.toThrow();
    }
    for (const path of [
      "/source",
      "/interactionCapture/interactions/0/attempts/01/provider",
      "/interactionCapture/interactions/99/attempts/0/provider",
    ])
      await expect(readStored({ ...h.input, path }, h.capture, h.reader)).rejects.toThrow();
    expect(h.reader.findEndpointProfile).not.toHaveBeenCalled();
  });
});

describe("owning hashless model endpoint resolution", () => {
  it("derives exact expected data from independent original records and checks every original context", async () => {
    const h = harness();
    const result = await read(h.input, h.evidence, h.reader);
    expect(h.reader.findEndpointProfile).toHaveBeenCalledExactlyOnceWith(
      h.input.scope,
      h.endpoint.endpointProfileId,
      h.endpoint.endpointProfileVersion,
    );
    expect(result).toEqual(inspect(h.input, h.evidence, h.endpoint));
    expect(result.parent).toEqual({ source: h.input.source, recordSha256: hash(h.fixture) });
    expect(result.reference).toEqual({
      kind: "endpoint_profile_selector",
      path: h.input.path,
      selector: {
        endpointProfileId: h.endpoint.endpointProfileId,
        endpointProfileVersion: h.endpoint.endpointProfileVersion,
      },
    });
    expect(result.checks).toEqual(
      ["provider_name", "operation", "boundary_kind", "configuration"].map((kind) => ({
        kind,
        observation: { status: "matched" },
      })),
    );
    expect(result).toMatchObject({
      status: "resolved",
      evidence: {
        record: h.endpoint,
        observation: { status: "verified", recordSha256: hash(h.endpoint) },
        source: {
          kind: "endpoint_profile",
          reference: {
            endpointProfileId: h.endpoint.endpointProfileId,
            endpointProfileVersion: h.endpoint.endpointProfileVersion,
            definitionSha256: h.endpoint.definitionSha256,
          },
        },
      },
    });
    expect(result).not.toHaveProperty("sealed");
    expect(result).not.toHaveProperty("authority");
  });

  it.each([
    "provider",
    "operations",
    "boundaryKinds",
    "artifactId",
    "sha256",
    "sizeBytes",
    "mediaType",
    "classification",
    "redactedAt",
  ] as const)(
    "retains independently valid conflicting %s data with explicit contextual mismatch",
    (field) => {
      const h = harness();
      const changed = structuredClone(h.endpoint);
      if (field === "provider") changed.provider = "other/provider";
      else if (field === "operations") changed.operations = ["unsupported_operation"];
      else if (field === "boundaryKinds") changed.boundaryKinds = ["tool"];
      else if (field === "artifactId") changed.configuration.artifactId = "artifact_other";
      else if (field === "sha256") changed.configuration.sha256 = "b".repeat(64);
      else if (field === "sizeBytes") changed.configuration.sizeBytes++;
      else if (field === "mediaType") changed.configuration.mediaType = "application/octet-stream";
      else if (field === "classification") changed.configuration.classification = "internal";
      else delete changed.configuration.redactedAt;
      const result = inspect(h.input, h.evidence, rehash(changed));
      expect(result.status).toBe("resolved");
      expect(result.evidence?.record).toEqual(changed);
      expect(
        result.checks.filter((c) => c.observation.status === "mismatch").map((c) => c.kind),
      ).toEqual([
        field === "provider"
          ? "provider_name"
          : field === "operations"
            ? "operation"
            : field === "boundaryKinds"
              ? "boundary_kind"
              : "configuration",
      ]);
      expect(result.checks.filter((c) => c.observation.status === "matched")).toHaveLength(3);
    },
  );

  it("retains every original repeated attempt and each whole-parent admission", async () => {
    const h = harness({ repeated: true });
    for (const index of [0, 1]) {
      const input = {
        ...h.input,
        path: `/interactionCapture/interactions/0/attempts/${index}/provider`,
      };
      const result = await read(input, h.evidence, h.reader);
      expect(result.status).toBe("resolved");
      expect(result.reference.path).toBe(input.path);
      const whole = references.enumeratePolicyEvaluationDatasetReferences(
        { source: h.input.source, scope: h.input.scope, evaluationTime },
        h.evidence,
        limits,
      );
      expect(result.inspectionUsage).toEqual({
        references: whole.references.length,
        referenceBytes: whole.referenceBytes,
      });
    }
    expect(h.reader.findEndpointProfile).toHaveBeenCalledTimes(2);
  });

  it.each(["chat", "generate_content", "text_completion"] as const)(
    "checks original %s operations without narrowing live operation declarations",
    (operation) => {
      const h = harness({ operation });
      const result = inspect(h.input, h.evidence, h.endpoint);
      expect(result.status).toBe("resolved");
      expect(result.checks.find((c) => c.kind === "operation")?.observation.status).toBe("matched");
    },
  );

  it.each(["digest", "extra", "configuration_extra"] as const)(
    "rejects independently invalid %s bodies rather than deriving an invented digest",
    (field) => {
      const h = harness();
      const record = structuredClone(h.endpoint);
      if (field === "digest") record.definitionSha256 = "0".repeat(64);
      else if (field === "extra") Object.assign(record, { authority: true });
      else Object.assign(record.configuration, { secret: "synthetic" });
      expect(inspect(h.input, h.evidence, record)).toMatchObject({
        status: "unavailable",
        reason: "record_invalid",
        evidence: null,
      });
    },
  );

  it.each([null, undefined, {}, { approved: true }])(
    "keeps absent/invalid %j independent data explicit without inventing a digest",
    (raw) => {
      const h = harness();
      const result = inspect(h.input, h.evidence, raw);
      expect(result).toMatchObject(
        raw === null
          ? { status: "missing", evidence: null }
          : { status: "unavailable", reason: "record_invalid", evidence: null },
      );
      expect(result.checks.every((c) => c.observation.status === "unavailable")).toBe(true);
      expect(result.reference).not.toHaveProperty("definitionSha256");
    },
  );

  it.each([
    "tenantId",
    "projectId",
    "environmentId",
    "endpointProfileId",
    "endpointProfileVersion",
  ] as const)("checks exact original %s even when independent data has a valid digest", (field) => {
    const h = harness();
    const changed = structuredClone(h.endpoint);
    if (field === "endpointProfileId") changed.endpointProfileId = "endpoint_other";
    else if (field === "endpointProfileVersion")
      changed.endpointProfileVersion = changed.endpointProfileVersion.toLowerCase();
    else changed.scope[field] = "scope_other";
    expect(inspect(h.input, h.evidence, rehash(changed))).toMatchObject({
      status: "unavailable",
      reason: "reference_mismatch",
      evidence: null,
    });
  });

  it("uses original endpoint receipts at exact native cuts and retains changed full observations", () => {
    const h = harness();
    h.endpoint.registeredAt = "2026-09-08T00:00:00.124Z";
    expect(
      inspect(
        { ...h.input, evaluationTime: "2026-09-08T00:00:00.123999Z" },
        h.evidence,
        h.endpoint,
      ),
    ).toMatchObject({ status: "unavailable", reason: "not_yet_available", evidence: null });
    for (const time of [
      "2026-09-08T00:00:00.124Z",
      "2026-09-08T00:00:00.124000Z",
      "2026-09-08T00:00:00.124001Z",
    ])
      expect(inspect({ ...h.input, evaluationTime: time }, h.evidence, h.endpoint).status).toBe(
        "resolved",
      );
    const original = inspect(h.input, h.evidence, h.endpoint);
    const changed = inspect(h.input, h.evidence, {
      ...h.endpoint,
      registeredByPrincipalId: "operator_changed",
    });
    expect(changed.evidence?.source).toEqual(original.evidence?.source);
    expect(changed.evidence?.observation).not.toEqual(original.evidence?.observation);
  });

  it("requires complete original parent admission before exact independent I/O", async () => {
    const h = harness();
    const whole = references.enumeratePolicyEvaluationDatasetReferences(
      { source: h.input.source, scope: h.input.scope, evaluationTime },
      h.evidence,
      limits,
    );
    const exact = {
      maxReferences: whole.references.length,
      maxReferenceBytes: whole.referenceBytes,
    };
    const result = await read({ ...h.input, limits: exact }, h.evidence, h.reader);
    expect(result.inspectionUsage).toEqual({
      references: exact.maxReferences,
      referenceBytes: exact.maxReferenceBytes,
    });
    h.reader.findEndpointProfile.mockClear();
    for (const patch of [
      { maxReferences: exact.maxReferences - 1 },
      { maxReferenceBytes: exact.maxReferenceBytes - 1 },
    ])
      await expect(
        read({ ...h.input, limits: { ...exact, ...patch } }, h.evidence, h.reader),
      ).rejects.toThrow();
    expect(h.reader.findEndpointProfile).not.toHaveBeenCalled();
  });

  it.each([
    "/source",
    "/interactionCapture/interactions/0/prompt",
    "/interactionCapture/interactions/0/attempts/0/artifacts/providerConfigurationArtifactId",
    "/interactionCapture/interactions/0/attempts/01/provider",
    "/interactionCapture/interactions/99/attempts/0/provider",
    "/interactionCapture/interactions/0/attempts/99/provider",
    "/interactionCapture/interactions/1/attempts/0/provider",
  ])("rejects non-original provider occurrence %s before I/O", async (path) => {
    const h = harness({ tool: true });
    await expect(read({ ...h.input, path }, h.evidence, h.reader)).rejects.toBeInstanceOf(
      PolicyEvaluationModelEndpointInputError,
    );
    expect(h.reader.findEndpointProfile).not.toHaveBeenCalled();
  });

  it.each([
    "null",
    "extra",
    "source",
    "path_type",
    "path_relative",
    "path_limit",
    "scope",
    "time",
  ] as const)("rejects malformed %s input before I/O", async (field) => {
    const h = harness();
    const input = structuredClone(h.input);
    if (field === "extra") Object.assign(input, { selector: h.endpoint });
    else if (field === "source")
      Reflect.set(input, "source", {
        kind: "endpoint_profile",
        reference: {
          endpointProfileId: h.endpoint.endpointProfileId,
          endpointProfileVersion: h.endpoint.endpointProfileVersion,
          definitionSha256: h.endpoint.definitionSha256,
        },
      });
    else if (field === "path_type") Reflect.set(input, "path", null);
    else if (field === "path_relative") input.path = "provider";
    else if (field === "path_limit") input.path = `/${"a".repeat(1024)}`;
    else if (field === "scope") input.scope.tenantId = "";
    else if (field === "time") input.evaluationTime = "tomorrow";
    await expect(
      read(field === "null" ? (null as never) : input, h.evidence, h.reader),
    ).rejects.toBeInstanceOf(PolicyEvaluationModelEndpointInputError);
    expect(h.reader.findEndpointProfile).not.toHaveBeenCalled();
  });

  it.each(["source", "hash", "receipt", "definition", "missing", "scope", "future"] as const)(
    "rejects changed/unavailable original parent %s before I/O",
    async (field) => {
      const h = harness();
      const evidence = structuredClone(h.evidence);
      if (field === "source") evidence.source.reference.definitionSha256 = "0".repeat(64);
      else if (field === "hash") Reflect.set(evidence.observation, "recordSha256", "0".repeat(64));
      else if (field === "missing")
        Object.assign(evidence, { record: null, observation: { status: "missing" } });
      else if (evidence.record) {
        if (field === "receipt") evidence.record.createdByPrincipalId = "principal_changed";
        else if (field === "definition") evidence.record.definitionSha256 = "0".repeat(64);
        else if (field === "scope") evidence.record.scope.tenantId = "scope_other";
        else evidence.record.createdAt = "2026-10-02T00:00:00.000Z";
      }
      await expect(read(h.input, evidence, h.reader)).rejects.toThrow();
      expect(h.reader.findEndpointProfile).not.toHaveBeenCalled();
    },
  );

  it("captures parent/context before I/O even if a repository mutates caller inputs", async () => {
    const h = harness();
    const expected = inspect(h.input, h.evidence, h.endpoint);
    const result = await read(h.input, h.evidence, {
      findEndpointProfile: async (scope) => {
        scope.tenantId = "port_scope_mutation";
        h.input.scope.tenantId = "input_scope_mutation";
        const model = h.fixture.interactionCapture.interactions[0] as ModelInteraction;
        if (!model.attempts[0]) throw new Error("Missing mutation fixture");
        model.attempts[0].provider.name = "input_provider_mutation";
        if (h.evidence.record?.schemaVersion !== "0.2") throw new Error("Missing captured fixture");
        const captured = h.evidence.record.interactionCapture.interactions[0];
        if (captured?.kind !== "model" || !captured.attempts[0])
          throw new Error("Missing captured attempt");
        captured.attempts[0].provider.name = "captured_provider_mutation";
        h.evidence.source.reference.definitionSha256 = "0".repeat(64);
        Reflect.set(h.evidence.observation, "recordSha256", "0".repeat(64));
        return h.endpoint;
      },
    });
    expect(result).toEqual(expected);
  });

  it("propagates operational storage and unexpected validator errors unchanged", async () => {
    const h = harness();
    for (const failure of [new Error("storage failure"), new InvalidEndpointProfileRecordError()])
      await expect(
        read(h.input, h.evidence, {
          findEndpointProfile: async () => {
            throw failure;
          },
        }),
      ).rejects.toBe(failure);
    const failure = new Error("unexpected validator defect");
    vi.spyOn(core, "validateEndpointProfileRecord").mockImplementation(() => {
      throw failure;
    });
    expect(() => inspect(h.input, h.evidence, h.endpoint)).toThrow(failure);
  });

  it.each(["missing_interaction", "tool", "missing_attempt", "id", "version"] as const)(
    "fails before I/O if the owning enumerator regresses its original %s binding",
    async (fault) => {
      const h = harness({ tool: true });
      const context = { source: h.input.source, scope: h.input.scope, evaluationTime };
      const frontier = references.enumeratePolicyEvaluationDatasetReferences(
        context,
        h.evidence,
        limits,
      );
      const reference = frontier.references.find((r) => r.path === h.input.path);
      if (reference?.kind !== "endpoint_profile_selector") throw new Error("Missing selector");
      // Fault-injected owner output is not an admitted fixture. Refuse its broken join
      // even if a future enumerator defect reports it as the selected occurrence.
      if (fault === "missing_interaction")
        Reflect.set(reference, "path", "/interactionCapture/interactions/99/attempts/0/provider");
      else if (fault === "tool")
        Reflect.set(reference, "path", "/interactionCapture/interactions/1/attempts/0/provider");
      else if (fault === "missing_attempt")
        Reflect.set(reference, "path", "/interactionCapture/interactions/0/attempts/99/provider");
      else if (fault === "id") reference.selector.endpointProfileId = "endpoint_other";
      else reference.selector.endpointProfileVersion = "Other+Version";
      vi.spyOn(references, "enumeratePolicyEvaluationDatasetReferences").mockReturnValue(frontier);
      await expect(
        read({ ...h.input, path: reference.path }, h.evidence, h.reader),
      ).rejects.toBeInstanceOf(PolicyEvaluationModelEndpointInputError);
      expect(h.reader.findEndpointProfile).not.toHaveBeenCalled();
    },
  );

  it.each(["missing", "verified_null"] as const)(
    "throws on an unexpected %s result from the trusted endpoint inspector",
    (fault) => {
      const h = harness();
      const source = {
        kind: "endpoint_profile" as const,
        reference: {
          endpointProfileId: h.endpoint.endpointProfileId,
          endpointProfileVersion: h.endpoint.endpointProfileVersion,
          definitionSha256: h.endpoint.definitionSha256,
        },
      };
      // A strict non-null record cannot legitimately become absent after validation.
      const corrupted = core.inspectPolicyEvaluationEndpointProfileRecord(
        { source, scope: h.input.scope, evaluationTime },
        h.endpoint,
      );
      Reflect.set(corrupted, "record", null);
      if (fault === "missing") Reflect.set(corrupted, "observation", { status: "missing" });
      vi.spyOn(core, "inspectPolicyEvaluationEndpointProfileRecord").mockReturnValue(corrupted);
      expect(() => inspect(h.input, h.evidence, h.endpoint)).toThrow(
        "Validated model endpoint lost its record",
      );
    },
  );

  it("rejects evidence-only fixtures without inventing a model provider occurrence", async () => {
    const h = harness();
    const vectors = JSON.parse(
      readFileSync(new URL("../vectors/regression-definition-v1.json", import.meta.url), "utf8"),
    ) as { vectors: { input: RegressionFixtureVersion; sha256: string }[] };
    const vector = vectors.vectors[0];
    if (!vector) throw new Error("Missing evidence-only fixture vector");
    const fixture: RegressionFixtureVersion = {
      ...structuredClone(vector.input),
      definitionSha256: vector.sha256,
      createdAt: "2026-09-08T00:00:00.123Z",
      createdByPrincipalId: "principal_fixture",
      source: { ...vector.input.source, capturedAt: "2026-09-08T00:00:00.000Z" },
    };
    const source = {
      kind: "regression_fixture_version" as const,
      reference: {
        fixtureId: fixture.fixtureId,
        fixtureVersionId: fixture.fixtureVersionId,
        definitionSha256: fixture.definitionSha256,
      },
    };
    const input = { ...h.input, source, scope: fixture.scope };
    const evidence = inspectPolicyEvaluationDataset(
      { source, scope: fixture.scope, evaluationTime },
      fixture,
    );
    expect(evidence.observation.status).toBe("verified");
    await expect(read(input, evidence, h.reader)).rejects.toBeInstanceOf(
      PolicyEvaluationModelEndpointInputError,
    );
    expect(h.reader.findEndpointProfile).not.toHaveBeenCalled();
  });
});
