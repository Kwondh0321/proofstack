import {
  ArtifactOwnershipSchema,
  ArtifactTombstoneSchema,
  type EvidenceScope,
  InteractionFixtureContentAvailabilitySchema,
  InteractionFixtureContentRevocationSchema,
} from "@proofstack/contracts";
import { RegressionRepositoryContractError } from "./errors.js";
import { validateAndProjectRecordedInteractionFixtureVersion } from "./regression-version-definition.js";
import type { StoredInteractionFixtureContent } from "./regression-version-repository.js";

function sameScope(left: EvidenceScope, right: EvidenceScope): boolean {
  return (
    left.tenantId === right.tenantId &&
    left.projectId === right.projectId &&
    left.environmentId === right.environmentId
  );
}

function exactKeys(input: object, expected: readonly string[], message: string): boolean {
  try {
    const keys = Reflect.ownKeys(input);
    return keys.length === expected.length && expected.every((key) => keys.includes(key));
  } catch (cause) {
    throw new RegressionRepositoryContractError(message, { cause });
  }
}

function properties(input: object, keys: readonly string[], message: string): readonly unknown[] {
  try {
    return keys.map((key) => Reflect.get(input, key));
  } catch (cause) {
    throw new RegressionRepositoryContractError(message, { cause });
  }
}

/** Validates and detaches the complete metadata-only view returned by a repository adapter. */
export function validateStoredInteractionFixtureContent(
  input: unknown,
  scope: EvidenceScope,
  expectedVersionId: string,
  message: string,
): StoredInteractionFixtureContent {
  const keys = ["contentAvailability", "ownerships", "revocation", "tombstones", "version"];
  if (typeof input !== "object" || input === null || !exactKeys(input, keys, message)) {
    throw new RegressionRepositoryContractError(message);
  }
  const [availabilityInput, ownershipsInput, revocationInput, tombstonesInput, versionInput] =
    properties(input, keys, message);
  const availability = InteractionFixtureContentAvailabilitySchema.safeParse(availabilityInput);
  let validatedVersion: ReturnType<typeof validateAndProjectRecordedInteractionFixtureVersion>;
  try {
    validatedVersion = validateAndProjectRecordedInteractionFixtureVersion(versionInput);
  } catch (cause) {
    throw new RegressionRepositoryContractError(message, { cause });
  }
  const version = validatedVersion.version;
  if (
    !availability.success ||
    version.fixtureVersionId !== expectedVersionId ||
    !sameScope(version.scope, scope) ||
    !Array.isArray(ownershipsInput) ||
    ownershipsInput.length !== version.interactionCapture.artifacts.length ||
    !Array.isArray(tombstonesInput)
  ) {
    throw new RegressionRepositoryContractError(message);
  }
  const ownerships = ownershipsInput.map((inputOwnership, index) => {
    const ownership = ArtifactOwnershipSchema.safeParse(inputOwnership);
    const artifact = version.interactionCapture.artifacts[index];
    if (
      !ownership.success ||
      artifact === undefined ||
      ownership.data.artifactId !== artifact.contentReference.artifactId ||
      ownership.data.owner.fixtureId !== version.fixtureId ||
      ownership.data.owner.fixtureVersionId !== version.fixtureVersionId ||
      !sameScope(ownership.data.scope, version.scope)
    ) {
      throw new RegressionRepositoryContractError(message, {
        ...(ownership.success ? {} : { cause: ownership.error }),
      });
    }
    return ownership.data;
  });

  const revocation =
    revocationInput === null
      ? null
      : InteractionFixtureContentRevocationSchema.safeParse(revocationInput);
  if (revocation !== null && !revocation.success) {
    throw new RegressionRepositoryContractError(message, { cause: revocation.error });
  }
  const parsedRevocation = revocation === null ? null : revocation.data;
  if (
    parsedRevocation !== null &&
    (parsedRevocation.fixtureId !== version.fixtureId ||
      parsedRevocation.fixtureVersionId !== version.fixtureVersionId ||
      !sameScope(parsedRevocation.scope, version.scope))
  ) {
    throw new RegressionRepositoryContractError(message);
  }

  const tombstones = tombstonesInput.map((inputTombstone) => {
    const result = ArtifactTombstoneSchema.safeParse(inputTombstone);
    if (!result.success) {
      throw new RegressionRepositoryContractError(message, { cause: result.error });
    }
    return result.data;
  });
  if (availability.data === "revoked") {
    if (parsedRevocation === null || tombstones.length !== ownerships.length) {
      throw new RegressionRepositoryContractError(message);
    }
    for (const [index, tombstone] of tombstones.entries()) {
      const ownership = ownerships[index];
      if (
        ownership === undefined ||
        tombstone.artifactId !== ownership.artifactId ||
        tombstone.actorPrincipalId !== parsedRevocation.revokedByPrincipalId ||
        tombstone.occurredAt !== parsedRevocation.revokedAt ||
        tombstone.reason !== parsedRevocation.reason ||
        tombstone.trigger !== "fixture_revocation"
      ) {
        throw new RegressionRepositoryContractError(message);
      }
    }
  } else if (parsedRevocation !== null || tombstones.length !== 0) {
    throw new RegressionRepositoryContractError(message);
  }
  return {
    contentAvailability: availability.data,
    ownerships,
    revocation: parsedRevocation,
    tombstones,
    version,
  };
}
