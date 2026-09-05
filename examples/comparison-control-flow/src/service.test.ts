import { afterEach, describe, expect, it } from "vitest";
import { createComparisonDemoApp, seedComparisonDemo } from "./service.js";

const openApps: Awaited<ReturnType<typeof createComparisonDemoApp>>[] = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map(({ app }) => app.close()));
});

describe("comparison service demo", () => {
  it("crosses real HTTP routes and preserves idempotent server-derived evidence", async () => {
    const demo = await createComparisonDemoApp({
      baselineMilliseconds: 125,
      candidateMilliseconds: 100,
      namespace: "service",
    });
    openApps.push(demo);

    await expect(seedComparisonDemo(demo)).resolves.toEqual({
      created: true,
      resultId: "result_latency_service",
    });
    await expect(seedComparisonDemo(demo)).resolves.toEqual({
      created: false,
      resultId: "result_latency_service",
    });

    const read = await demo.app.inject({
      method: "GET",
      url: "/v1/projects/prj_local/environments/env_local/comparisons/records/comparison_result/result_latency_service",
    });
    expect(read.statusCode).toBe(200);
    expect(read.headers["cache-control"]).toBe("no-store");
    expect(read.json()).toMatchObject({
      result: {
        kind: "comparison_result",
        record: {
          metricResults: [
            {
              metricId: "metric_elapsed",
              value: {
                delta: { denominator: "1", numerator: "-25", unit: "milliseconds" },
                direction: "decreased",
                status: "available",
              },
            },
            { metricId: "metric_trace_events" },
          ],
          resultId: "result_latency_service",
        },
      },
    });
  });

  it("surfaces route publication failures instead of starting with partial data", async () => {
    const demo = await createComparisonDemoApp({
      baselineMilliseconds: 125,
      candidateMilliseconds: 100,
      namespace: "failure",
    });
    openApps.push(demo);
    await demo.app.close();
    openApps.pop();

    await expect(seedComparisonDemo(demo)).rejects.toThrow();
  });
});
