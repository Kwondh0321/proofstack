import { isIP } from "node:net";

/** Optional operator-owned private bridge; Docker still rejects overlap with existing networks. */
export function createWorkflowAcceptanceNetwork(subnet) {
  const invalid = () =>
    new TypeError(
      "Acceptance subnet must be an aligned private IPv4 CIDR with prefix 8 through 29",
    );
  if (typeof subnet !== "string") throw invalid();
  const match = /^([^/]+)\/([1-9][0-9]?)$/.exec(subnet);
  if (!match || match[0] !== subnet || isIP(match[1]) !== 4) throw invalid();
  const prefix = Number(match[2]);
  if (prefix < 8 || prefix > 29) throw invalid();
  const bytes = match[1].split(".").map(Number);
  const privateAddress =
    bytes[0] === 10 ||
    (bytes[0] === 172 && bytes[1] >= 16 && bytes[1] <= 31) ||
    (bytes[0] === 192 && bytes[1] === 168);
  const address = bytes.reduce((value, byte) => value * 256 + byte, 0);
  if (!privateAddress || address % 2 ** (32 - prefix) !== 0) throw invalid();
  return { networks: { default: { ipam: { config: [{ subnet }] } } } };
}
