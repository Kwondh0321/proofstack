import { ProofStackClient, createTraceId } from "@proofstack/sdk";

const { PROOFSTACK_API_KEY, PROOFSTACK_API_URL, PROOFSTACK_ENVIRONMENT_ID, PROOFSTACK_PROJECT_ID } =
  process.env;

const client = new ProofStackClient({
  ...(PROOFSTACK_API_KEY ? { apiKey: PROOFSTACK_API_KEY } : {}),
  endpoint: PROOFSTACK_API_URL ?? "http://127.0.0.1:4318",
  environmentId: PROOFSTACK_ENVIRONMENT_ID ?? "env_local",
  failOpen: false,
  flushIntervalMs: 0,
  projectId: PROOFSTACK_PROJECT_ID ?? "prj_local",
  source: {
    serviceName: "basic-agent-example",
    serviceVersion: "0.0.0",
  },
});

const traceId = createTraceId();
const startedAt = new Date().toISOString();
const run = client.emit({
  attributes: { "example.input": "redacted", "proofstack.example": true },
  kind: "agent.run",
  name: "basic-agent.run",
  sequence: 0,
  startedAt,
  status: "ok",
  traceId,
});

client.emit({
  attributes: { "tool.result_count": 1 },
  kind: "tool.execute",
  name: "knowledge.lookup",
  parentSpanId: run.spanId,
  sequence: 1,
  startedAt,
  status: "ok",
  traceId,
});

const result = await client.close();
if (!result.success) {
  throw new Error(`Evidence delivery failed with ${result.pendingCount} event(s) pending`);
}

console.log(
  JSON.stringify(
    {
      eventCount: result.sentCount,
      traceId,
      traceUrl: `http://127.0.0.1:3000/traces/${traceId}`,
    },
    null,
    2,
  ),
);
