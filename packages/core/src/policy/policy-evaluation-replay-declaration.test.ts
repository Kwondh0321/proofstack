import { describe, expect, it } from "vitest";
import { PolicyEvaluationReferenceCollector } from "./policy-evaluation-reference-collector.js";
import type { PolicyEvaluationReplayDeclaration } from "./policy-evaluation-replay-declaration.js";

const sha = "a".repeat(64);
const limits = { maxReferences: 100, maxReferenceBytes: 100000 };
const cases: PolicyEvaluationReplayDeclaration[] = [
  { kind: "artifact_identity", reference: "art_not_yet_resolved" },
  {
    kind: "credential_selector",
    reference: { credentialId: "credential_one", credentialVersionId: "version_one" },
  },
  { kind: "digest", reference: sha },
  {
    kind: "endpoint_profile",
    reference: {
      definitionSha256: sha,
      endpointProfileId: "endpoint_one",
      endpointProfileVersion: "1.0.0",
    },
  },
  {
    kind: "preinstalled_target",
    reference: {
      kind: "preinstalled",
      implementationId: "implementation_one",
      implementationSha256: sha,
    },
  },
  { kind: "recorded_adapter", reference: { name: "recorded.adapter", version: "1.0.0" } },
  {
    kind: "subprocess_implementation",
    reference: { executableSha256: sha, implementationId: "implementation_two" },
  },
  {
    kind: "target_adapter",
    reference: { name: "target.adapter", version: "1.0.0", protocolVersion: "2.0.0" },
  },
  { kind: "worker_protocol", reference: { name: "worker.protocol", version: "1.0.0" } },
];

describe.each(cases)("replay declaration: $kind", (declaration) => {
  it("validates its owning contract and retains every occurrence without granting record authority", () => {
    const collector = new PolicyEvaluationReferenceCollector(limits);
    const original = structuredClone(declaration);
    collector.replayDeclaration("/first", declaration);
    collector.replayDeclaration("/second", declaration);
    if (typeof declaration.reference === "object")
      Reflect.set(declaration.reference, "mutated", true);
    expect(collector.result().references).toEqual([
      { kind: "replay_declaration", path: "/first", declaration: original },
      { kind: "replay_declaration", path: "/second", declaration: original },
    ]);
    // Cases are reused by the parameterized invalid-input test below.
    Object.assign(declaration, original);
  });
  it("rejects malformed scalar identities and unknown fields in structured references", () => {
    const collector = new PolicyEvaluationReferenceCollector(limits);
    const reference =
      typeof declaration.reference === "string" ? "" : { ...declaration.reference, granted: true };
    expect(() =>
      collector.replayDeclaration("/invalid", { ...declaration, reference } as never),
    ).toThrow();
    expect(collector.result().references).toEqual([]);
  });
});

describe("versioned replay declaration conflicts", () => {
  it("rejects different digests for the same endpoint profile identity and version", () => {
    const collector = new PolicyEvaluationReferenceCollector(limits);
    const reference = {
      definitionSha256: sha,
      endpointProfileId: "endpoint_one",
      endpointProfileVersion: "1.0.0",
    };
    collector.replayDeclaration("/first", { kind: "endpoint_profile", reference });
    expect(() =>
      collector.replayDeclaration("/conflict", {
        kind: "endpoint_profile",
        reference: { ...reference, definitionSha256: "b".repeat(64) },
      }),
    ).toThrow(expect.objectContaining({ reason: "reference_conflict" }));
  });
  it("rejects a credential version that changes its parent credential but permits different versions", () => {
    const collector = new PolicyEvaluationReferenceCollector(limits);
    const reference = { credentialId: "credential_one", credentialVersionId: "version_one" };
    collector.replayDeclaration("/first", { kind: "credential_selector", reference });
    collector.replayDeclaration("/version_two", {
      kind: "credential_selector",
      reference: { ...reference, credentialVersionId: "version_two" },
    });
    expect(() =>
      collector.replayDeclaration("/conflict", {
        kind: "credential_selector",
        reference: { ...reference, credentialId: "credential_other" },
      }),
    ).toThrow(expect.objectContaining({ reason: "reference_conflict" }));
  });
});
