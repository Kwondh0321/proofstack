import { randomBytes } from "node:crypto";
import { InvalidRegressionVersionInputError } from "./errors.js";
import type { InteractionFixtureRevocationIdentityGenerator } from "./revoke-recorded-interaction-fixture-content.js";

const INTERACTION_REVOCATION_IDENTITY_BYTES = 24;

export type InteractionRevocationIdentityRandomSource = (size: number) => Uint8Array;

function randomIdentity(source: InteractionRevocationIdentityRandomSource): string {
  let value: Uint8Array;
  try {
    value = source(INTERACTION_REVOCATION_IDENTITY_BYTES);
  } catch (cause) {
    throw new InvalidRegressionVersionInputError(
      "Interaction fixture content revocation identity generation failed",
      { cause },
    );
  }
  if (
    !(value instanceof Uint8Array) ||
    value.byteLength !== INTERACTION_REVOCATION_IDENTITY_BYTES
  ) {
    throw new InvalidRegressionVersionInputError(
      "Interaction fixture content revocation identity generation failed",
    );
  }
  return Buffer.from(value).toString("hex");
}

/** Generates opaque, non-sequential identifiers for fixture content revocations. */
export class SecureInteractionFixtureRevocationIdentityGenerator
  implements InteractionFixtureRevocationIdentityGenerator
{
  constructor(
    private readonly randomSource: InteractionRevocationIdentityRandomSource = randomBytes,
  ) {}

  generateArtifactTombstoneId(_artifactId: string): string {
    return `del_${randomIdentity(this.randomSource)}`;
  }

  generateRevocationId(): string {
    return `rev_${randomIdentity(this.randomSource)}`;
  }
}
