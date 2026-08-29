import { describe, expect, it } from "vitest";
import { InvalidRegressionVersionInputError } from "./errors.js";
import { SecureInteractionFixtureRevocationIdentityGenerator } from "./interaction-fixture-revocation-identifiers.js";

describe("SecureInteractionFixtureRevocationIdentityGenerator", () => {
  it("generates domain-prefixed opaque identities from independent entropy", () => {
    let invocation = 0;
    const identities = new SecureInteractionFixtureRevocationIdentityGenerator((size) => {
      invocation += 1;
      return Uint8Array.from({ length: size }, (_, index) => index + invocation);
    });

    expect(identities.generateRevocationId()).toBe(
      "rev_0102030405060708090a0b0c0d0e0f101112131415161718",
    );
    expect(identities.generateArtifactTombstoneId("art_ignored_by_design")).toBe(
      "del_02030405060708090a0b0c0d0e0f10111213141516171819",
    );
  });

  it.each([
    { source: () => new Uint8Array(23) },
    { source: () => new Uint8Array(25) },
    { source: () => "not-bytes" as unknown as Uint8Array },
  ])("rejects invalid random-source output %#", ({ source }) => {
    const identities = new SecureInteractionFixtureRevocationIdentityGenerator(source);
    expect(() => identities.generateRevocationId()).toThrow(InvalidRegressionVersionInputError);
  });

  it("does not expose random-source failures", () => {
    const identities = new SecureInteractionFixtureRevocationIdentityGenerator(() => {
      throw new Error("entropy backend detail");
    });

    expect(() => identities.generateArtifactTombstoneId("art_example")).toThrow(
      expect.objectContaining({
        cause: expect.objectContaining({ message: "entropy backend detail" }),
        code: "regression_version_input_invalid",
      }),
    );
  });
});
