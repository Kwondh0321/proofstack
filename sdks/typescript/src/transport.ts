import {
  EVIDENCE_SCHEMA_VERSION,
  type EvidenceRecord,
  type IngestEvidenceRequest,
} from "@proofstack/contracts";

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
    const basePath = baseUrl.pathname.replace(/\/$/, "");
    baseUrl.pathname = `${basePath}/v1/projects/${encodeURIComponent(
      options.projectId,
    )}/environments/${encodeURIComponent(options.environmentId)}/evidence`;
    this.url = baseUrl;
  }

  async send(events: readonly EvidenceRecord[]): Promise<void> {
    const request: IngestEvidenceRequest = {
      events: [...events],
      schemaVersion: EVIDENCE_SCHEMA_VERSION,
    };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImplementation(this.url, {
        body: JSON.stringify(request),
        headers: {
          ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {}),
          "content-type": "application/json",
        },
        method: "POST",
        signal: controller.signal,
      });

      if (!response.ok) {
        const detail = (await response.text()).slice(0, 512);
        throw new TransportError(
          `ProofStack ingestion failed with HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
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
