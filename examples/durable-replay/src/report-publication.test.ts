import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  DurableReplayReportPublicationAcknowledgementSchema,
  requestDurableReplayReportPublication,
} from "./report-publication.js";

const contentReference = {
  artifactId: "art_report_protocol",
  classification: "internal" as const,
  mediaType: "application/vnd.proofstack.replay-attempt-report+json",
  sha256: "a".repeat(64),
  sizeBytes: 64,
};
const scope = {
  environmentId: "env_report_protocol",
  projectId: "prj_report_protocol",
  tenantId: "ten_report_protocol",
};

function acknowledgement(override: Readonly<Record<string, unknown>> = {}): string {
  return `${JSON.stringify({
    artifactId: contentReference.artifactId,
    command: "report_publication_accepted",
    sha256: contentReference.sha256,
    ...override,
  })}\n`;
}

describe("durable replay report publication protocol", () => {
  it("emits one strict descriptor and accepts the matching bounded acknowledgement", async () => {
    const input = new PassThrough();
    const emit = vi.fn(() => {
      input.write(acknowledgement().slice(0, 20));
      input.end(acknowledgement().slice(20));
    });
    await expect(
      requestDurableReplayReportPublication({
        contentReference,
        emit,
        input,
        scope,
        signal: new AbortController().signal,
      }),
    ).resolves.toBeUndefined();
    expect(emit).toHaveBeenCalledWith({
      contentReference,
      event: "report_publication_requested",
      scope,
    });
    expect(
      DurableReplayReportPublicationAcknowledgementSchema.parse(JSON.parse(acknowledgement())),
    ).toMatchObject({ artifactId: contentReference.artifactId });
  });

  it.each([
    ["mismatched artifact", acknowledgement({ artifactId: "art_wrong" }), "did not match"],
    ["unknown field", acknowledgement({ unknown: true }), "unrecognized"],
    ["invalid JSON", "{invalid}\n", "valid JSON"],
    ["trailing data", `${acknowledgement()}extra`, "trailing data"],
    ["oversized input", "x".repeat(4_097), "exceeded"],
  ])("rejects %s", async (_label, response, message) => {
    const input = new PassThrough();
    await expect(
      requestDurableReplayReportPublication({
        contentReference,
        emit: () => input.end(response),
        input,
        scope,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(message);
  });

  it("rejects cancellation, timeout, channel closure, and channel errors", async () => {
    const cancelledInput = new PassThrough();
    const cancellation = new AbortController();
    cancellation.abort();
    await expect(
      requestDurableReplayReportPublication({
        contentReference,
        emit: () => undefined,
        input: cancelledInput,
        scope,
        signal: cancellation.signal,
      }),
    ).rejects.toThrow("cancelled");
    const timeoutInput = new PassThrough();
    await expect(
      requestDurableReplayReportPublication({
        contentReference,
        emit: () => undefined,
        input: timeoutInput,
        scope,
        signal: new AbortController().signal,
        timeoutMilliseconds: 1,
      }),
    ).rejects.toThrow("timed out");
    const closedInput = new PassThrough();
    await expect(
      requestDurableReplayReportPublication({
        contentReference,
        emit: () => closedInput.end(),
        input: closedInput,
        scope,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("closed early");
    const failedInput = new PassThrough();
    await expect(
      requestDurableReplayReportPublication({
        contentReference,
        emit: () => failedInput.emit("error", new Error("hidden")),
        input: failedInput,
        scope,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("channel failed");
  });
});
