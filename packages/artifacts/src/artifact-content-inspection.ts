import type { ArtifactMetadata } from "@proofstack/contracts";
import {
  ArtifactContentInspectionConfigurationError,
  ArtifactContentInspectionUnavailableError,
  ArtifactContentRejectedError,
} from "./errors.js";

const INSPECTOR_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const FORBIDDEN_STRUCTURED_CREDENTIAL_FIELDS = new Set([
  "accesstoken",
  "apikey",
  "authorization",
  "clientsecret",
  "cookie",
  "idtoken",
  "passphrase",
  "password",
  "privatekey",
  "refreshtoken",
  "secretaccesskey",
  "setcookie",
]);

export interface ArtifactSecretFinding {
  readonly ruleId: string;
}

export interface ArtifactSecretScanInput {
  readonly content: Uint8Array;
  readonly metadata: ArtifactMetadata;
}

export interface ArtifactSecretScanner {
  readonly name: string;
  readonly version: string;
  scan(input: ArtifactSecretScanInput): Promise<readonly ArtifactSecretFinding[]>;
}

export interface ArtifactContentInspectionInput {
  readonly content: Uint8Array;
  readonly metadata: ArtifactMetadata;
}

export interface ArtifactContentInspector {
  inspect(input: ArtifactContentInspectionInput): Promise<void>;
}

function normalizedFieldName(value: string): string {
  return value.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
}

function isJsonMediaType(mediaType: string): boolean {
  const subtype = mediaType.split("/", 2)[1];
  return subtype === "json" || subtype?.endsWith("+json") === true;
}

function decodeJson(content: Uint8Array): unknown {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch (cause) {
    throw new ArtifactContentRejectedError({ cause });
  }
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new ArtifactContentRejectedError({ cause });
  }
}

function containsForbiddenStructuredCredential(value: unknown): boolean {
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current !== "object" || current === null) continue;
    if (Array.isArray(current)) {
      pending.push(...current);
      continue;
    }
    for (const [key, child] of Object.entries(current)) {
      if (FORBIDDEN_STRUCTURED_CREDENTIAL_FIELDS.has(normalizedFieldName(key))) return true;
      pending.push(child);
    }
  }
  return false;
}

function validatedScanners(
  scanners: readonly ArtifactSecretScanner[],
): readonly ArtifactSecretScanner[] {
  const identities = new Set<string>();
  for (const scanner of scanners) {
    if (!INSPECTOR_TOKEN.test(scanner.name) || !INSPECTOR_TOKEN.test(scanner.version)) {
      throw new ArtifactContentInspectionConfigurationError();
    }
    const identity = `${scanner.name}\u0000${scanner.version}`;
    if (identities.has(identity)) throw new ArtifactContentInspectionConfigurationError();
    identities.add(identity);
  }
  return [...scanners];
}

/**
 * Fail-closed pre-storage inspection for exact artifact plaintext.
 *
 * JSON media types reject malformed UTF-8, malformed JSON, and structured credential fields.
 * Deployment-provided scanners receive defensive copies and any finding rejects the upload. The
 * absence of findings is not a proof that opaque content is secret-free.
 */
export class StrictArtifactContentInspector implements ArtifactContentInspector {
  private readonly scanners: readonly ArtifactSecretScanner[];

  constructor(scanners: readonly ArtifactSecretScanner[] = []) {
    this.scanners = validatedScanners(scanners);
  }

  async inspect(input: ArtifactContentInspectionInput): Promise<void> {
    if (isJsonMediaType(input.metadata.contentReference.mediaType)) {
      const value = decodeJson(input.content);
      if (containsForbiddenStructuredCredential(value)) {
        throw new ArtifactContentRejectedError();
      }
    }

    for (const scanner of this.scanners) {
      let findings: readonly ArtifactSecretFinding[];
      try {
        findings = await scanner.scan({
          content: Uint8Array.from(input.content),
          metadata: structuredClone(input.metadata),
        });
      } catch (cause) {
        throw new ArtifactContentInspectionUnavailableError({ cause });
      }
      if (!Array.isArray(findings)) {
        throw new ArtifactContentInspectionUnavailableError();
      }
      if (findings.length > 0) throw new ArtifactContentRejectedError();
    }
  }
}
