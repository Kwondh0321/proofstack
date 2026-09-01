import type { Readable } from "node:stream";
import { ArtifactContentReferenceSchema, EvidenceScopeSchema } from "@proofstack/contracts";
import { z } from "zod";

const MAX_ACKNOWLEDGEMENT_BYTES = 4_096;

export const DurableReplayReportPublicationRequestSchema = z
  .object({
    contentReference: ArtifactContentReferenceSchema,
    event: z.literal("report_publication_requested"),
    scope: EvidenceScopeSchema,
  })
  .strict();

export const DurableReplayReportPublicationAcknowledgementSchema = z
  .object({
    artifactId: ArtifactContentReferenceSchema.shape.artifactId,
    command: z.literal("report_publication_accepted"),
    sha256: ArtifactContentReferenceSchema.shape.sha256,
  })
  .strict();

export type DurableReplayReportPublicationRequest = z.infer<
  typeof DurableReplayReportPublicationRequestSchema
>;

function readAcknowledgement(options: {
  readonly input: Readable;
  readonly signal: AbortSignal;
  readonly timeoutMilliseconds: number;
}): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    let settled = false;
    const finish = (error: Error | undefined, value?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal.removeEventListener("abort", onAbort);
      options.input.off("data", onData);
      options.input.off("end", onEnd);
      options.input.off("error", onError);
      if (error) reject(error);
      else resolve(value);
    };
    const onAbort = (): void =>
      finish(new Error("Report publication acknowledgement was cancelled"));
    const onEnd = (): void =>
      finish(new Error("Report publication acknowledgement channel closed early"));
    const onError = (): void =>
      finish(new Error("Report publication acknowledgement channel failed"));
    const onData = (chunk: Buffer | string): void => {
      buffer += chunk.toString();
      if (Buffer.byteLength(buffer, "utf8") > MAX_ACKNOWLEDGEMENT_BYTES) {
        finish(new Error("Report publication acknowledgement exceeded its limit"));
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      if (buffer.slice(newline + 1).length > 0) {
        finish(new Error("Report publication acknowledgement contained trailing data"));
        return;
      }
      try {
        finish(undefined, JSON.parse(buffer.slice(0, newline)));
      } catch {
        finish(new Error("Report publication acknowledgement was not valid JSON"));
      }
    };
    const timer = setTimeout(
      () => finish(new Error("Report publication acknowledgement timed out")),
      options.timeoutMilliseconds,
    );
    options.signal.addEventListener("abort", onAbort, { once: true });
    options.input.on("data", onData);
    options.input.once("end", onEnd);
    options.input.once("error", onError);
    if (options.signal.aborted) onAbort();
  });
}

export async function requestDurableReplayReportPublication(options: {
  readonly contentReference: z.infer<typeof ArtifactContentReferenceSchema>;
  readonly emit: (request: DurableReplayReportPublicationRequest) => void;
  readonly input: Readable;
  readonly scope: z.infer<typeof EvidenceScopeSchema>;
  readonly signal: AbortSignal;
  readonly timeoutMilliseconds?: number;
}): Promise<void> {
  const request = DurableReplayReportPublicationRequestSchema.parse({
    contentReference: options.contentReference,
    event: "report_publication_requested",
    scope: options.scope,
  });
  const response = readAcknowledgement({
    input: options.input,
    signal: options.signal,
    timeoutMilliseconds: options.timeoutMilliseconds ?? 10_000,
  });
  options.emit(request);
  const acknowledgement = DurableReplayReportPublicationAcknowledgementSchema.parse(await response);
  if (
    acknowledgement.artifactId !== request.contentReference.artifactId ||
    acknowledgement.sha256 !== request.contentReference.sha256
  ) {
    throw new Error("Report publication acknowledgement did not match the immutable report");
  }
}
