import { describe, expect, it } from "vitest";
import {
  type ArtifactIdentityRandomSource,
  SecureArtifactIdentityGenerator,
} from "./artifact-identifiers.js";
import { ArtifactIdentifierGenerationError } from "./errors.js";

function sequenceSource(): ArtifactIdentityRandomSource {
  let seed = 0;
  return (size) => {
    const value = Uint8Array.from({ length: size }, (_, index) => (seed + index) % 256);
    seed += size;
    return value;
  };
}

describe("SecureArtifactIdentityGenerator", () => {
  it("generates opaque lifecycle identifiers and non-identifying sharded object keys", () => {
    const generator = new SecureArtifactIdentityGenerator(sequenceSource());

    expect(generator.generateLifecycleId("tombstone")).toMatch(/^del_[0-9a-f]{48}$/);
    expect(generator.generateLifecycleId("purge")).toMatch(/^pur_[0-9a-f]{48}$/);
    expect(generator.generateObjectKey()).toMatch(
      /^objects\/v1\/[A-Za-z0-9_-]{2}\/[A-Za-z0-9_-]{32}$/,
    );
  });

  it("uses independent entropy for every generated identity", () => {
    const generator = new SecureArtifactIdentityGenerator(sequenceSource());
    const values = new Set([
      generator.generateObjectKey(),
      generator.generateObjectKey(),
      generator.generateLifecycleId("purge"),
      generator.generateLifecycleId("purge"),
    ]);
    expect(values.size).toBe(4);
  });

  it.each([
    () => new Uint8Array(23),
    () => ({}) as Uint8Array,
    () => {
      throw new Error("random detail");
    },
  ])("normalizes an invalid random source %#", (randomSource) => {
    const generator = new SecureArtifactIdentityGenerator(randomSource);
    expect(() => generator.generateObjectKey()).toThrow(ArtifactIdentifierGenerationError);
  });

  it("supports the operating-system random source", () => {
    expect(new SecureArtifactIdentityGenerator().generateObjectKey()).toMatch(
      /^objects\/v1\/[A-Za-z0-9_-]{2}\/[A-Za-z0-9_-]{32}$/,
    );
  });
});
