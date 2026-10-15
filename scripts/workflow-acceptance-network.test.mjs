import assert from "node:assert/strict";
import { test } from "node:test";
import { createWorkflowAcceptanceNetwork } from "./workflow-acceptance-network.mjs";

test("admits aligned private test bridges without configuring services, ports or the daemon", () => {
  for (const subnet of [
    "10.0.0.0/8",
    "10.253.6.176/28",
    "10.253.6.176/29",
    "172.16.0.0/12",
    "172.31.0.0/24",
    "192.168.0.0/16",
  ])
    assert.deepEqual(createWorkflowAcceptanceNetwork(subnet), {
      networks: { default: { ipam: { config: [{ subnet }] } } },
    });
});
test("rejects malformed, nonprivate, undersized, oversized or nonaligned subnets", () => {
  for (const value of [
    undefined,
    null,
    10,
    "",
    " 10.0.0.0/8",
    "10.0.0.0/08",
    "10.0.0.0/8\n",
    "10.00.0.0/8",
    "::1/24",
    "999.0.0.0/24",
    "10.0.0.0/7",
    "10.0.0.0/30",
    "10.0.0.1/28",
    "8.8.8.0/24",
    "172.15.0.0/24",
    "172.32.0.0/24",
    "192.167.0.0/24",
    "192.169.0.0/24",
  ])
    assert.throws(() => createWorkflowAcceptanceNetwork(value), /aligned private IPv4/);
});
