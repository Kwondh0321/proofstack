import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { ProofStackApiError, ProofStackRegressionClient } from "./regression-client.js";

async function listen(server: Server): Promise<string> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing disposable server address");
  return `http://127.0.0.1:${address.port}`;
}
async function close(server: Server) {
  if (!server.listening) return;
  const closing = new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  server.closeAllConnections();
  await closing;
}
const operations = [
  "fixture_publication",
  "artifact_upload",
  "fixture_read",
  "artifact_content",
] as const;
const cases = [301, 302, 303, 307, 308].flatMap((status) =>
  ["same_origin", "other_origin"].flatMap((target) =>
    operations.map((operation) => ({ status, target, operation })),
  ),
);

describe("regression and classified artifact SDK redirect boundary", () => {
  it.each(
    ["fixture_read", "artifact_content"].flatMap((operation) =>
      ["redirected", "opaque", "status"].flatMap((kind) =>
        ["stream", "no_body", "cancel_failure"].map((body) => ({ operation, kind, body })),
      ),
    ),
  )(
    "rejects $kind $body $operation before reading redirected content and closes its stream",
    async ({ operation, kind, body }) => {
      let reads = 0,
        cancelled = 0;
      const response = new Response(
        body === "no_body"
          ? null
          : new ReadableStream<Uint8Array>(
              {
                pull() {
                  reads++;
                },
                cancel() {
                  cancelled++;
                  if (body === "cancel_failure") throw new Error("Synthetic cancellation failure");
                },
              },
              { highWaterMark: 0 },
            ),
        { status: kind === "status" ? 307 : 200 },
      );
      if (kind === "redirected") Object.defineProperty(response, "redirected", { value: true });
      if (kind === "opaque") {
        Object.defineProperty(response, "type", { value: "opaqueredirect" });
        Object.defineProperty(response, "status", { value: 0 });
      }
      let calls = 0;
      const sdk = new ProofStackRegressionClient({
        endpoint: "http://127.0.0.1:1234",
        projectId: "project_redirect",
        environmentId: "env_redirect",
        authentication: { mode: "development" },
        fetch: async (_url, init) => {
          calls++;
          expect(init?.redirect).toBe("manual");
          return response;
        },
      });
      await expect(
        operation === "fixture_read"
          ? sdk.readFixtureVersion({
              fixtureId: "fixture_redirect",
              fixtureVersionId: "fixture_version_redirect",
            })
          : sdk.readArtifactContent({ artifactId: "artifact_redirect" }),
      ).rejects.toBeInstanceOf(ProofStackApiError);
      expect(calls).toBe(1);
      expect(reads).toBe(0);
      expect(cancelled).toBe(body === "no_body" ? 0 : 1);
    },
  );
  it.each(cases)(
    "rejects actual $status $target $operation before delivering any destination request",
    async ({ status, target, operation }) => {
      let sourceRequests = 0,
        sourceBytes = 0,
        destinationRequests = 0,
        destinationBytes = 0,
        destinationCredentials = 0;
      const receive = async (request: IncomingMessage, response: ServerResponse) => {
        destinationRequests++;
        if (request.headers["authorization"] || request.headers["x-proofstack-csrf"])
          destinationCredentials++;
        for await (const chunk of request) destinationBytes += chunk.length;
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{}");
      };
      const destination = createServer((request, response) => {
        void receive(request, response);
      });
      let destinationUrl = "";
      const source = createServer(async (request, response) => {
        if (request.url === "/redirect-destination") {
          await receive(request, response);
          return;
        }
        sourceRequests++;
        for await (const chunk of request) sourceBytes += chunk.length;
        response.writeHead(status, {
          location: target === "same_origin" ? "/redirect-destination" : destinationUrl,
        });
        response.end();
      });
      const failures: unknown[] = [];
      try {
        destinationUrl = await listen(destination);
        const sdk = new ProofStackRegressionClient({
          endpoint: await listen(source),
          projectId: "project_redirect",
          environmentId: "env_redirect",
          timeoutMs: 2000,
          authentication:
            operation === "fixture_publication" || operation === "artifact_upload"
              ? { mode: "browser", csrfToken: `psc_v1_${"E".repeat(43)}` }
              : { mode: "workload", apiKey: `psk_v1_ABCDEFGHIJKL_${"A".repeat(43)}` },
        });
        const request =
          operation === "fixture_publication"
            ? sdk.publishFixtureVersion({
                fixtureId: "fixture_redirect",
                request: {
                  fixtureVersionId: "fixture_version_redirect",
                  name: "Synthetic redirect control",
                  source: { kind: "trace_snapshot", traceId: "4bf92f3577b34da6a3ce929d0e0e4736" },
                },
              })
            : operation === "artifact_upload"
              ? sdk.uploadArtifactContent({
                  artifactId: "artifact_redirect",
                  content: new Uint8Array(64).fill(7),
                })
              : operation === "fixture_read"
                ? sdk.readFixtureVersion({
                    fixtureId: "fixture_redirect",
                    fixtureVersionId: "fixture_version_redirect",
                  })
                : sdk.readArtifactContent({ artifactId: "artifact_redirect" });
        await expect(request).rejects.toBeInstanceOf(ProofStackApiError);
        expect(sourceRequests).toBe(1);
        expect(sourceBytes).toBe(
          operation === "artifact_upload"
            ? 64
            : operation === "fixture_publication"
              ? Buffer.byteLength(
                  JSON.stringify({
                    fixtureVersionId: "fixture_version_redirect",
                    name: "Synthetic redirect control",
                    source: { kind: "trace_snapshot", traceId: "4bf92f3577b34da6a3ce929d0e0e4736" },
                  }),
                )
              : 0,
        );
        expect(destinationRequests).toBe(0);
        expect(destinationBytes).toBe(0);
        expect(destinationCredentials).toBe(0);
      } catch (error) {
        failures.push(error);
      } finally {
        for (const result of await Promise.allSettled([close(source), close(destination)]))
          if (result.status === "rejected") failures.push(result.reason);
      }
      if (failures.length)
        throw new AggregateError(failures, "Actual regression SDK redirect boundary failed");
    },
  );
});
