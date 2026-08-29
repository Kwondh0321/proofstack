import { ProofStackClient, ProofStackRegressionClient, createTraceId } from "@proofstack/sdk";

const { PROOFSTACK_API_URL, PROOFSTACK_ENVIRONMENT_ID, PROOFSTACK_PROJECT_ID } = process.env;

const endpoint = PROOFSTACK_API_URL ?? "http://127.0.0.1:4318";
const environmentId = PROOFSTACK_ENVIRONMENT_ID ?? "env_local";
const projectId = PROOFSTACK_PROJECT_ID ?? "prj_local";
const traceId = createTraceId();
const versionSuffix = traceId.slice(0, 24);
const fixtureId = "fix_checkout_incident";
const fixtureVersionId = `fixv_${versionSuffix}`;
const datasetId = "dat_checkout_regressions";
const datasetVersionId = `datv_${versionSuffix}`;

const telemetry = new ProofStackClient({
  endpoint,
  environmentId,
  failOpen: false,
  flushIntervalMs: 0,
  projectId,
  source: {
    serviceName: "incident-to-regression-example",
    serviceVersion: "0.0.0",
  },
});

telemetry.emit({
  attributes: {
    "example.failure_class": "checkout_inventory_mismatch",
    "example.input": "redacted",
  },
  kind: "agent.run",
  name: "checkout-agent.failed-run",
  sequence: 0,
  startedAt: new Date().toISOString(),
  status: "error",
  traceId,
});

const delivery = await telemetry.close();
if (!delivery.success) {
  throw new Error(`Evidence delivery failed with ${delivery.pendingCount} event(s) pending`);
}

const regression = new ProofStackRegressionClient({
  authentication: { mode: "development" },
  endpoint,
  environmentId,
  projectId,
});

const publishedFixture = await regression.publishFixtureVersion({
  fixtureId,
  request: {
    fixtureVersionId,
    name: "Checkout inventory mismatch incident",
    source: { kind: "trace_snapshot", traceId },
  },
});
const exactFixture = await regression.readFixtureVersion({ fixtureId, fixtureVersionId });

const publishedDataset = await regression.publishDatasetVersion({
  datasetId,
  request: {
    datasetVersionId,
    fixtureVersions: [{ fixtureId, fixtureVersionId }],
    name: "Checkout regression incidents",
  },
});
const exactDataset = await regression.readDatasetVersion({ datasetId, datasetVersionId });

if (
  exactFixture.version.definitionSha256 !== publishedFixture.version.definitionSha256 ||
  exactDataset.version.definitionSha256 !== publishedDataset.version.definitionSha256
) {
  throw new Error("Exact-version readback did not preserve the published definition digest");
}

console.log(
  JSON.stringify(
    {
      dataset: {
        created: publishedDataset.created,
        datasetId,
        datasetVersionId,
        definitionSha256: exactDataset.version.definitionSha256,
        fixtureVersions: exactDataset.version.fixtureVersions,
      },
      fixture: {
        created: publishedFixture.created,
        definitionSha256: exactFixture.version.definitionSha256,
        fixtureId,
        fixtureVersionId,
        replayability: exactFixture.version.replayability,
        sourceCompleteness: exactFixture.version.source.sourceCompleteness,
        sourceEventIds: exactFixture.version.source.eventIds,
      },
      traceId,
      warning:
        "This fixture freezes observed evidence only; it is not an executable replay transcript.",
    },
    null,
    2,
  ),
);
