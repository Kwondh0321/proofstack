import { randomBytes } from "node:crypto";
import { ArtifactIdentifierGenerationError } from "./errors.js";

const ARTIFACT_IDENTITY_BYTES = 24;
const OBJECT_KEY_VERSION = "v1";

export type ArtifactIdentityRandomSource = (size: number) => Uint8Array;
export type ArtifactLifecycleIdKind = "purge" | "tombstone";

export interface ArtifactIdentityGenerator {
  generateLifecycleId(kind: ArtifactLifecycleIdKind): string;
  generateObjectKey(): string;
}

function randomIdentity(source: ArtifactIdentityRandomSource): Buffer {
  let value: Uint8Array;
  try {
    value = source(ARTIFACT_IDENTITY_BYTES);
  } catch (error) {
    throw new ArtifactIdentifierGenerationError({ cause: error });
  }
  if (!(value instanceof Uint8Array) || value.byteLength !== ARTIFACT_IDENTITY_BYTES) {
    throw new ArtifactIdentifierGenerationError();
  }
  return Buffer.from(value);
}

export class SecureArtifactIdentityGenerator implements ArtifactIdentityGenerator {
  constructor(private readonly randomSource: ArtifactIdentityRandomSource = randomBytes) {}

  generateLifecycleId(kind: ArtifactLifecycleIdKind): string {
    const prefix = kind === "tombstone" ? "del" : "pur";
    return `${prefix}_${randomIdentity(this.randomSource).toString("hex")}`;
  }

  generateObjectKey(): string {
    const token = randomIdentity(this.randomSource).toString("base64url");
    return `objects/${OBJECT_KEY_VERSION}/${token.slice(0, 2)}/${token}`;
  }
}
