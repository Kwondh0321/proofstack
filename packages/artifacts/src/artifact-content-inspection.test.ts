import { createHash } from "node:crypto";
import type { ArtifactMetadata } from "@proofstack/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  type ArtifactSecretScanner,
  StrictArtifactContentInspector,
} from "./artifact-content-inspection.js";
import {
  ArtifactContentInspectionConfigurationError,
  ArtifactContentInspectionUnavailableError,
  ArtifactContentRejectedError,
} from "./errors.js";

const content = Buffer.from('{"items":[null,1,{"safe":true}]}', "utf8");

function metadata(mediaType = "application/json"): ArtifactMetadata {
  return {
    contentReference: {
      artifactId: "art_inspection_test",
      classification: "confidential",
      mediaType,
      sha256: createHash("sha256").update(content).digest("hex"),
      sizeBytes: content.byteLength,
    },
    createdAt: "2026-08-29T08:00:00.000Z",
    redaction: { status: "not_required" },
    retention: { mode: "retain" },
    schemaVersion: "0.1",
    scope: {
      environmentId: "env_inspection",
      projectId: "prj_inspection",
      tenantId: "ten_inspection",
    },
    state: "reserved",
  };
}

function scanner(
  scan: ArtifactSecretScanner["scan"],
  overrides: Partial<Pick<ArtifactSecretScanner, "name" | "version">> = {},
): ArtifactSecretScanner {
  return {
    name: overrides.name ?? "reference-scanner",
    scan,
    version: overrides.version ?? "1.0.0",
  };
}

describe("StrictArtifactContentInspector", () => {
  it("accepts safe structured content and gives scanners defensive copies", async () => {
    const scan = vi.fn<ArtifactSecretScanner["scan"]>(async (input) => {
      input.content[0] = 0;
      input.metadata.scope.projectId = "prj_mutated";
      return [];
    });
    const inspector = new StrictArtifactContentInspector([scanner(scan)]);
    const originalMetadata = metadata("application/vnd.proofstack+json");
    const originalContent = Uint8Array.from(content);

    await expect(
      inspector.inspect({ content: originalContent, metadata: originalMetadata }),
    ).resolves.toBeUndefined();
    expect(originalContent).toEqual(Uint8Array.from(content));
    expect(originalMetadata.scope.projectId).toBe("prj_inspection");
    expect(scan).toHaveBeenCalledOnce();
  });

  it("allows non-JSON opaque bytes while still invoking configured scanners", async () => {
    const scan = vi.fn<ArtifactSecretScanner["scan"]>(async () => []);
    const inspector = new StrictArtifactContentInspector([scanner(scan)]);

    await expect(
      inspector.inspect({ content: Uint8Array.from([0xff]), metadata: metadata("text/plain") }),
    ).resolves.toBeUndefined();
    expect(scan).toHaveBeenCalledOnce();
  });

  it.each([
    "access_token",
    "api-key",
    "Authorization",
    "clientSecret",
    "cookie",
    "id_token",
    "passphrase",
    "password",
    "private_key",
    "refreshToken",
    "secret_access_key",
    "set-cookie",
  ])("rejects the structured credential field %s", async (field) => {
    const candidate = Buffer.from(JSON.stringify({ nested: [{ [field]: "value" }] }), "utf8");
    await expect(
      new StrictArtifactContentInspector().inspect({
        content: candidate,
        metadata: metadata(),
      }),
    ).rejects.toBeInstanceOf(ArtifactContentRejectedError);
  });

  it.each([Buffer.from("not-json", "utf8"), Uint8Array.from([0xc3, 0x28])])(
    "rejects malformed declared JSON %#",
    async (candidate) => {
      await expect(
        new StrictArtifactContentInspector().inspect({
          content: candidate,
          metadata: metadata(),
        }),
      ).rejects.toBeInstanceOf(ArtifactContentRejectedError);
    },
  );

  it("rejects any configured scanner finding", async () => {
    const inspector = new StrictArtifactContentInspector([
      scanner(async () => [{ ruleId: "example-secret" }]),
    ]);

    await expect(inspector.inspect({ content, metadata: metadata() })).rejects.toBeInstanceOf(
      ArtifactContentRejectedError,
    );
  });

  it.each([
    scanner(async () => {
      throw new Error("scanner offline");
    }),
    scanner(async () => undefined as never),
  ])("fails closed when a configured scanner violates its contract", async (configuredScanner) => {
    const inspector = new StrictArtifactContentInspector([configuredScanner]);

    await expect(inspector.inspect({ content, metadata: metadata() })).rejects.toBeInstanceOf(
      ArtifactContentInspectionUnavailableError,
    );
  });

  it.each([
    { scanners: [scanner(async () => [], { name: "bad scanner" })] },
    { scanners: [scanner(async () => [], { version: "" })] },
    { scanners: [scanner(async () => []), scanner(async () => [])] },
  ])("rejects invalid or duplicate scanner identities %#", ({ scanners }) => {
    expect(() => new StrictArtifactContentInspector(scanners)).toThrow(
      ArtifactContentInspectionConfigurationError,
    );
  });
});
