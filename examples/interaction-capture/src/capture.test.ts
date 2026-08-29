import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createProviderNeutralCapture } from "./capture.js";

function sha256(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

describe("provider-neutral interaction capture", () => {
  it("builds a complete failed model and tool sequence with exact retained bytes", () => {
    const capture = createProviderNeutralCapture(
      "012345abcdef",
      new Date("2026-08-29T07:00:00.000Z"),
    );

    expect(capture.manifest.interactions).toMatchObject([
      { kind: "model", sequence: 0, terminalOutcome: "succeeded" },
      { kind: "tool", sequence: 1, terminalOutcome: "failed" },
    ]);
    expect(capture.manifest.source.completeness).toEqual({
      limitations: [
        "transport_metadata_excluded",
        "provider_internal_state_unobserved",
        "hidden_reasoning_excluded",
        "uninstrumented_subprocesses_unobserved",
        "undeclared_side_effects_unobserved",
      ],
      status: "complete_for_declared_boundary",
    });
    expect(capture.manifest.artifacts).toHaveLength(11);
    expect(
      capture.manifest.artifacts.map(({ contentReference }) => contentReference.artifactId),
    ).toEqual([...capture.contentByArtifactId.keys()].sort());
    for (const binding of capture.manifest.artifacts) {
      const content = capture.contentByArtifactId.get(binding.contentReference.artifactId);
      expect(content).toBeDefined();
      expect(binding).toMatchObject({
        contentReference: { classification: "confidential", sizeBytes: content?.byteLength },
        redaction: { status: "not_required" },
        retention: { mode: "retain" },
      });
      expect(binding.contentReference.sha256).toBe(sha256(content ?? new Uint8Array()));
    }
    const capturedPlaintext = [...capture.contentByArtifactId.values()]
      .map((content) => Buffer.from(content).toString("utf8"))
      .join("\n");
    for (const marker of capture.sensitiveMarkers) expect(capturedPlaintext).toContain(marker);
  });

  it("derives independent identifiers and content digests for each capture", () => {
    const first = createProviderNeutralCapture("012345abcdef");
    const second = createProviderNeutralCapture("fedcba543210");

    expect([...first.contentByArtifactId.keys()]).not.toEqual([
      ...second.contentByArtifactId.keys(),
    ]);
    expect(
      first.manifest.artifacts.map((artifact) => artifact.contentReference.sha256),
    ).not.toEqual(second.manifest.artifacts.map((artifact) => artifact.contentReference.sha256));
  });

  it.each(["", "012345ABCDE", "012345abcdef0", "not-hex-value"])(
    "rejects an unsafe capture suffix %j",
    (suffix) => {
      expect(() => createProviderNeutralCapture(suffix)).toThrow(
        "exactly 12 lowercase hexadecimal characters",
      );
    },
  );
});
