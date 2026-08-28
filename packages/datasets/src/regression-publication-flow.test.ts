import {
  EVIDENCE_SCHEMA_VERSION,
  type EvidenceEnvelope,
  type EvidenceScope,
  PrincipalContextSchema,
} from "@proofstack/contracts";
import { FixedClock, MemoryEvidenceRepository } from "@proofstack/core/testing";
import { describe, expect, it } from "vitest";
import { PublishRegressionDatasetVersion, PublishRegressionFixtureVersion } from "./index.js";
import { MemoryRegressionVersionRepository } from "./testing/index.js";

const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const scope: EvidenceScope = {
  environmentId: "env_production",
  projectId: "prj_checkout_agent",
  tenantId: "ten_acme",
};
const principal = PrincipalContextSchema.parse({
  authentication: {
    authenticatedAt: "2026-08-29T02:00:00.000Z",
    method: "development",
  },
  capabilities: ["dataset:manage", "evidence:read"],
  principalId: "usr_regression_owner",
  principalType: "user",
  requestId: "req_regression_flow_001",
  resourceScope: { mode: "tenant" },
  roles: ["owner"],
  tenantId: scope.tenantId,
});

function envelope(eventId: string, startedAt: string): EvidenceEnvelope {
  return {
    evidence: {
      attributes: {},
      contentReferences: [],
      eventId,
      extensions: {},
      kind: "agent.run",
      name: "checkout-agent",
      source: {
        sdkName: "@proofstack/testkit",
        sdkVersion: "0.0.0",
        serviceName: "checkout-agent",
      },
      spanId: "00f067aa0ba902b7",
      startedAt,
      status: "error",
      traceId: TRACE_ID,
    },
    receivedAt: "2026-08-29T02:01:00.000Z",
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    scope,
  };
}

describe("regression publication memory flow", () => {
  it("freezes an observed trace, advances by a new version, and publishes exact dataset membership", async () => {
    const evidenceRepository = new MemoryEvidenceRepository();
    const versionRepository = new MemoryRegressionVersionRepository();
    const clock = new FixedClock(new Date("2026-08-29T02:02:00.000Z"));
    const fixturePublisher = new PublishRegressionFixtureVersion({
      clock,
      evidenceRepository,
      versionRepository,
    });
    const datasetPublisher = new PublishRegressionDatasetVersion({ clock, versionRepository });
    await evidenceRepository.append([
      envelope("evt_checkout_started", "2026-08-29T01:59:58.000Z"),
      envelope("evt_checkout_failed", "2026-08-29T01:59:59.000Z"),
    ]);

    const firstFixture = await fixturePublisher.execute({
      environmentId: scope.environmentId,
      fixtureId: "fix_checkout_timeout",
      principal,
      projectId: scope.projectId,
      request: {
        fixtureVersionId: "fixv_checkout_timeout_001",
        name: "Checkout timeout",
        source: { kind: "trace_snapshot", traceId: TRACE_ID },
      },
    });
    await evidenceRepository.append([
      envelope("evt_checkout_recovered", "2026-08-29T02:00:00.000Z"),
    ]);
    const firstRetry = await fixturePublisher.execute({
      environmentId: scope.environmentId,
      fixtureId: "fix_checkout_timeout",
      principal,
      projectId: scope.projectId,
      request: {
        fixtureVersionId: "fixv_checkout_timeout_001",
        name: "Checkout timeout",
        source: { kind: "trace_snapshot", traceId: TRACE_ID },
      },
    });
    const advancedFixture = await fixturePublisher.execute({
      environmentId: scope.environmentId,
      fixtureId: "fix_checkout_timeout",
      principal,
      projectId: scope.projectId,
      request: {
        fixtureVersionId: "fixv_checkout_timeout_002",
        name: "Checkout timeout after recovery evidence",
        predecessorVersionId: firstFixture.version.fixtureVersionId,
        source: { kind: "trace_snapshot", traceId: TRACE_ID },
      },
    });
    const dataset = await datasetPublisher.execute({
      datasetId: "dat_checkout_regressions",
      environmentId: scope.environmentId,
      principal,
      projectId: scope.projectId,
      request: {
        datasetVersionId: "datv_checkout_regressions_001",
        fixtureVersions: [
          {
            fixtureId: advancedFixture.version.fixtureId,
            fixtureVersionId: advancedFixture.version.fixtureVersionId,
          },
        ],
        name: "Checkout regressions",
      },
    });
    const datasetRetry = await datasetPublisher.execute({
      datasetId: "dat_checkout_regressions",
      environmentId: scope.environmentId,
      principal,
      projectId: scope.projectId,
      request: {
        datasetVersionId: "datv_checkout_regressions_001",
        fixtureVersions: [
          {
            fixtureId: advancedFixture.version.fixtureId,
            fixtureVersionId: advancedFixture.version.fixtureVersionId,
          },
        ],
        name: "Checkout regressions",
      },
    });

    expect(firstFixture).toMatchObject({
      created: true,
      version: {
        source: { eventIds: ["evt_checkout_started", "evt_checkout_failed"] },
      },
    });
    expect(firstRetry).toEqual({ created: false, version: firstFixture.version });
    expect(advancedFixture).toMatchObject({
      created: true,
      version: {
        predecessor: {
          definitionSha256: firstFixture.version.definitionSha256,
          fixtureVersionId: firstFixture.version.fixtureVersionId,
        },
        source: {
          eventIds: ["evt_checkout_started", "evt_checkout_failed", "evt_checkout_recovered"],
        },
      },
    });
    expect(dataset.version.fixtureVersions).toEqual([
      {
        definitionSha256: advancedFixture.version.definitionSha256,
        fixtureId: advancedFixture.version.fixtureId,
        fixtureVersionId: advancedFixture.version.fixtureVersionId,
      },
    ]);
    expect(datasetRetry).toEqual({ created: false, version: dataset.version });
    expect(await versionRepository.publishedIntents(scope.tenantId)).toHaveLength(3);
  });
});
