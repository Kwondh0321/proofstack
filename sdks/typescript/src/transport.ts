import {
  EVIDENCE_SCHEMA_VERSION,
  type EvidenceRecord,
  IngestEvidenceRequestSchema,
  IngestEvidenceResponseSchema,
} from "@proofstack/contracts";

const MAX_RESPONSE_BODY_BYTES = 64 * 1024;

export interface EvidenceTransport {
  send(events: readonly EvidenceRecord[]): Promise<void>;
}

export interface HttpEvidenceTransportOptions {
  readonly apiKey?: string;
  readonly endpoint: string | URL;
  readonly environmentId: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly projectId: string;
  readonly timeoutMs?: number;
}

export class TransportError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "TransportError";
  }
}

export class HttpEvidenceTransport implements EvidenceTransport {
  private readonly fetchImplementation: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  private readonly url: URL;

  constructor(private readonly options: HttpEvidenceTransportOptions) {
    this.fetchImplementation = options.fetch ?? globalThis.fetch;
    if (!this.fetchImplementation) throw new TransportError("No fetch implementation is available");

    this.timeoutMs = options.timeoutMs ?? 5_000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new TransportError("timeoutMs must be a positive integer");
    }

    const baseUrl = new URL(options.endpoint);
    if (baseUrl.protocol !== "https:" && baseUrl.protocol !== "http:") {
      throw new TransportError("ProofStack endpoint must use HTTP or HTTPS");
    }
    if (baseUrl.username || baseUrl.password) {
      throw new TransportError("ProofStack endpoint must not contain embedded credentials");
    }
    if (baseUrl.protocol === "http:" && !isLoopbackHostname(baseUrl.hostname)) {
      throw new TransportError(
        "Unencrypted ProofStack endpoints must use an explicit loopback host",
      );
    }

    const basePath = baseUrl.pathname.replace(/\/$/, "");
    baseUrl.pathname = `${basePath}/v1/projects/${encodeURIComponent(
      options.projectId,
    )}/environments/${encodeURIComponent(options.environmentId)}/evidence`;
    baseUrl.search = "";
    baseUrl.hash = "";
    this.url = baseUrl;
  }

  async send(events: readonly EvidenceRecord[]): Promise<void> {
    const request = IngestEvidenceRequestSchema.safeParse({
      events: [...events],
      schemaVersion: EVIDENCE_SCHEMA_VERSION,
    });
    if (!request.success) {
      throw new TransportError("ProofStack evidence batch failed local validation");
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImplementation(this.url, {
        body: JSON.stringify(request.data),
        headers: {
          ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {}),
          "content-type": "application/json",
        },
        method: "POST",
        signal: controller.signal,
      });

      if (!response.ok) {
        const detail = (await readBoundedResponseBody(response)).slice(0, 512);
        throw new TransportError(
          `ProofStack ingestion failed with HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
          response.status,
        );
      }

      const responseText = await readBoundedResponseBody(response);
      let responseBody: unknown;
      try {
        responseBody = JSON.parse(responseText);
      } catch {
        throw new TransportError("ProofStack ingestion returned invalid JSON", response.status);
      }

      const acknowledgement = IngestEvidenceResponseSchema.safeParse(responseBody);
      if (!acknowledgement.success) {
        throw new TransportError(
          "ProofStack ingestion returned an invalid acknowledgement",
          response.status,
        );
      }

      const expectedEventIds = new Set(events.map((event) => event.eventId));
      const acknowledgedEventIds = new Set([
        ...acknowledgement.data.acceptedEventIds,
        ...acknowledgement.data.duplicateEventIds,
      ]);
      if (
        expectedEventIds.size !== acknowledgedEventIds.size ||
        [...expectedEventIds].some((eventId) => !acknowledgedEventIds.has(eventId))
      ) {
        throw new TransportError(
          "ProofStack ingestion acknowledgement does not match the sent batch",
          response.status,
        );
      }
    } catch (error) {
      if (error instanceof TransportError) throw error;
      if (controller.signal.aborted) {
        throw new TransportError(`ProofStack ingestion timed out after ${this.timeoutMs}ms`);
      }
      throw new TransportError(
        `ProofStack ingestion failed: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "localhost";
}

async function readBoundedResponseBody(response: Response): Promise<string> {
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let receivedBytes = 0;

  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      receivedBytes += chunk.value.byteLength;
      if (receivedBytes > MAX_RESPONSE_BODY_BYTES) {
        await reader.cancel();
        throw new TransportError(
          `ProofStack ingestion response exceeded ${MAX_RESPONSE_BODY_BYTES} bytes`,
          response.status,
        );
      }
      chunks.push(decoder.decode(chunk.value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join("");
  } finally {
    reader.releaseLock();
  }
}
