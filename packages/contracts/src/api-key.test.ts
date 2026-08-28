import { describe, expect, it } from "vitest";
import {
  ApiKeyCredentialSchema,
  IssueApiKeyRequestSchema,
  IssueApiKeyResponseSchema,
  RevokeApiKeyRequestSchema,
  RotateApiKeyRequestSchema,
} from "./api-key.js";

const prefix = "abcdefghijkl";
const value = ["psk", "v1", prefix, "abcdefghijklmnopqrstuvwxyzABCDEFGH123456788"].join("_");
const credential = {
  capabilities: ["evidence:ingest", "evidence:read"],
  createdAt: "2026-08-28T04:00:00.000Z",
  credentialId: "key_contract_test",
  expiresAt: "2026-11-26T04:00:00.000Z",
  name: "agent-ingestion",
  prefix,
  principalId: "wrk_contract_test",
  resourceScope: {
    mode: "restricted",
    projects: [{ environmentIds: ["env_prod"], projectId: "prj_agents" }],
  },
  revokedAt: null,
  rotatedFromCredentialId: null,
  tenantId: "ten_acme",
};

describe("API key management contracts", () => {
  it("validates bounded issue, rotation, and revocation inputs", () => {
    expect(
      IssueApiKeyRequestSchema.safeParse({
        capabilities: credential.capabilities,
        expiresAt: credential.expiresAt,
        name: credential.name,
        resourceScope: credential.resourceScope,
      }).success,
    ).toBe(true);
    expect(RotateApiKeyRequestSchema.safeParse({}).success).toBe(true);
    expect(RevokeApiKeyRequestSchema.safeParse({ reason: "workload retired" }).success).toBe(true);
  });

  it("rejects nondelegable, duplicate, and empty capability sets", () => {
    for (const capabilities of [[], ["evidence:ingest", "evidence:ingest"], ["identity:manage"]]) {
      expect(
        IssueApiKeyRequestSchema.safeParse({
          capabilities,
          name: credential.name,
          resourceScope: { mode: "tenant" },
        }).success,
      ).toBe(false);
    }
  });

  it("validates sanitized credential metadata without hash material", () => {
    expect(ApiKeyCredentialSchema.safeParse(credential).success).toBe(true);
    expect(
      ApiKeyCredentialSchema.safeParse({ ...credential, passwordHash: "hidden" }).success,
    ).toBe(false);
  });

  it("binds the one-time value to the public credential prefix", () => {
    const response = { credential, requestId: "req_contract_test", value };
    expect(IssueApiKeyResponseSchema.safeParse(response).success).toBe(true);
    expect(
      IssueApiKeyResponseSchema.safeParse({
        ...response,
        credential: { ...credential, prefix: "mnopqrstuvwx" },
      }).success,
    ).toBe(false);
  });

  it("rejects control characters, unknown fields, and malformed key values", () => {
    expect(
      IssueApiKeyRequestSchema.safeParse({
        capabilities: ["evidence:ingest"],
        name: "bad\nname",
        resourceScope: { mode: "tenant" },
      }).success,
    ).toBe(false);
    expect(RotateApiKeyRequestSchema.safeParse({ preserve: true }).success).toBe(false);
    expect(
      IssueApiKeyResponseSchema.safeParse({
        credential,
        requestId: "req_contract_test",
        value: "not-a-key",
      }).success,
    ).toBe(false);
  });
});
