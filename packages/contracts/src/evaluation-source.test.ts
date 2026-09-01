import { describe, expect, it } from "vitest";
import {
  DISCOVERY_RECORD_SCHEMA_VERSION,
  type DiscoveryRecordDefinition,
  DiscoveryRecordDefinitionSchema,
  DiscoveryRecordSchema,
  SOURCE_REVIEW_SCHEMA_VERSION,
  SOURCE_SNAPSHOT_SCHEMA_VERSION,
  type SourceApplicabilityScope,
  SourceReviewDefinitionSchema,
  SourceReviewRecordSchema,
  SourceSnapshotDefinitionSchema,
  SourceSnapshotSchema,
} from "./evaluation-source.js";

const scope = {
  environmentId: "env_local",
  projectId: "prj_local",
  tenantId: "ten_local",
} as const;

const sha = (character: string) => character.repeat(64);

const artifact = (artifactId: string, character: string) => ({
  artifactId,
  classification: "internal" as const,
  mediaType: "application/pdf",
  sha256: sha(character),
  sizeBytes: 1_024,
});

const applicabilityScope = (): SourceApplicabilityScope => ({
  environments: { mode: "include" as const, values: ["env_local"] },
  exclusions: [],
  jurisdictions: { mode: "include" as const, values: ["kr"] },
  locales: { mode: "include" as const, values: ["en", "ko-kr"] },
  populations: { mode: "include" as const, values: ["adult users"] },
  riskTiers: { mode: "include" as const, values: ["high"] },
  taskKinds: { mode: "include" as const, values: ["task_support"] },
});

const sourceReference = (sourceSnapshotId: string, character: string) => ({
  definitionSha256: sha(character),
  sourceSnapshotId,
});

function discoveryDefinition(): DiscoveryRecordDefinition {
  return {
    candidates: [
      {
        canonicalUri: "https://standards.example.test/v1",
        displayedPublisher: "Example Standards Body",
        displayedTitle: "Example primary standard",
        rank: 1,
        selection: { decision: "selected" as const, reason: "Exact primary document" },
      },
      {
        canonicalUri: "https://commentary.example.test/standard",
        displayedTitle: "Secondary commentary",
        rank: 2,
        selection: { decision: "excluded" as const, reason: "Not a primary source" },
      },
    ],
    discoveryId: "dsc_standard",
    filters: { domain: "example.test", primaryOnly: true },
    locale: "en-us",
    providerName: "Example Search",
    query: "example primary standard v1",
    resultLimit: 2,
    toolVersion: "search-1.0.0",
  };
}

function sourceDefinition() {
  return {
    applicabilityScope: applicabilityScope(),
    canonicalUri: "https://standards.example.test/v1",
    conflictsWith: [sourceReference("src_conflict", "c")],
    content: artifact("art_source", "1"),
    discovery: {
      candidateRank: 1,
      definitionSha256: sha("2"),
      discoveryId: "dsc_standard",
    },
    documentVersion: "1.0",
    effectiveAt: "2026-02-01T00:00:00Z",
    expiresAt: "2027-01-01T00:00:00Z",
    identityVerification: {
      evidence: [artifact("art_identity", "3")],
      method: "digital_signature" as const,
      status: "verified" as const,
      verifiedAt: "2026-01-04T00:00:00Z",
      verifierPrincipalId: "usr_reviewer",
    },
    knownLimitations: ["Does not define organization-specific risk tolerance"],
    license: {
      expression: "CC-BY-4.0",
      status: "declared" as const,
      termsUri: "https://standards.example.test/license",
    },
    publishedAt: "2026-01-01T00:00:00Z",
    publisher: {
      canonicalName: "Example Standards Body",
      identifier: "https://standards.example.test/",
    },
    retrievedAt: "2026-01-03T00:00:00Z",
    sourceKind: "standard" as const,
    sourceSnapshotId: "src_standard",
    supersedes: [sourceReference("src_previous", "b")],
  };
}

function reviewDefinition() {
  return {
    applicabilityConclusion: "approved" as const,
    approvedScope: applicabilityScope(),
    authorityConclusion: "accepted" as const,
    criticalConflictStatus: "resolved" as const,
    declaredRelationships: ["member of adopting organization"],
    freshnessConclusion: "current" as const,
    licensingConclusion: "usable" as const,
    outcome: "approved" as const,
    rationale: "The primary publisher and exact version apply to the declared bounded scope.",
    reviewBasis: [artifact("art_review_basis", "4")],
    reviewedConflicts: [sourceReference("src_conflict", "c")],
    source: sourceReference("src_standard", "d"),
    sourceReviewId: "srv_standard",
    validFrom: "2026-01-05T00:00:00Z",
    validUntil: "2026-12-31T00:00:00Z",
  };
}

describe("discovery source contracts", () => {
  it("preserves the complete ranked candidate list without granting authority", () => {
    const definition = discoveryDefinition();
    expect(DiscoveryRecordDefinitionSchema.parse(definition)).toEqual(definition);

    const record = {
      ...definition,
      definitionSha256: sha("a"),
      recordedAt: "2026-01-03T00:00:01.000Z",
      recordedByPrincipalId: "usr_reviewer",
      schemaVersion: DISCOVERY_RECORD_SCHEMA_VERSION,
      scope,
    };
    expect(DiscoveryRecordSchema.parse(record)).toEqual(record);
    expect(SourceSnapshotDefinitionSchema.safeParse(record).success).toBe(false);
  });

  it.each([
    ["non-HTTPS URI", { canonicalUri: "http://standards.example.test/v1" }],
    ["unknown candidate field", { hiddenAuthority: true }],
  ])("rejects %s", (_label, candidateOverride) => {
    const value = discoveryDefinition();
    value.candidates[0] = { ...value.candidates[0], ...candidateOverride } as never;
    expect(DiscoveryRecordDefinitionSchema.safeParse(value).success).toBe(false);
  });

  it("rejects incomplete ranks, duplicate URIs, and candidates beyond the declared bound", () => {
    const incomplete = discoveryDefinition();
    incomplete.candidates[1] = { ...incomplete.candidates[1]!, rank: 3 };
    expect(DiscoveryRecordDefinitionSchema.safeParse(incomplete).success).toBe(false);

    const duplicate = discoveryDefinition();
    duplicate.candidates[1] = {
      ...duplicate.candidates[1]!,
      canonicalUri: duplicate.candidates[0]?.canonicalUri ?? "",
    };
    expect(DiscoveryRecordDefinitionSchema.safeParse(duplicate).success).toBe(false);

    const beyondLimit = { ...discoveryDefinition(), resultLimit: 1 };
    expect(DiscoveryRecordDefinitionSchema.safeParse(beyondLimit).success).toBe(false);
  });

  it.each([" leading", "trailing ", "unsafe\u202Econtrol", "e\u0301"])(
    "rejects non-canonical discovery text %j",
    (query) => {
      expect(
        DiscoveryRecordDefinitionSchema.safeParse({ ...discoveryDefinition(), query }).success,
      ).toBe(false);
    },
  );

  it("supports an undecided empty bounded search without inventing selection", () => {
    const value = {
      ...discoveryDefinition(),
      candidates: [],
      filters: {},
      resultLimit: 10,
    };
    expect(DiscoveryRecordDefinitionSchema.parse(value).candidates).toEqual([]);

    const pending = discoveryDefinition();
    pending.candidates[0] = {
      ...pending.candidates[0]!,
      selection: { decision: "pending" },
    };
    expect(DiscoveryRecordDefinitionSchema.safeParse(pending).success).toBe(true);
  });
});

describe("source snapshot contracts", () => {
  it("binds retained exact bytes, source identity evidence, scope, conflicts, and lineage", () => {
    const definition = sourceDefinition();
    expect(SourceSnapshotDefinitionSchema.parse(definition)).toEqual(definition);

    const record = {
      ...definition,
      definitionSha256: sha("d"),
      publishedByPrincipalId: "usr_publisher",
      recordedAt: "2026-01-05T00:00:00.000Z",
      schemaVersion: SOURCE_SNAPSHOT_SCHEMA_VERSION,
      scope,
    };
    expect(SourceSnapshotSchema.parse(record)).toEqual(record);
  });

  it("allows identity verification after retrieval because those claims are separate", () => {
    const value = sourceDefinition();
    value.identityVerification.verifiedAt = "2026-01-04T00:00:00Z";
    expect(SourceSnapshotDefinitionSchema.safeParse(value).success).toBe(true);
  });

  it.each([
    ["publication after retrieval", { publishedAt: "2026-01-04T00:00:00Z" }],
    ["expiry at retrieval", { expiresAt: "2026-01-03T00:00:00Z" }],
    ["expiry before effective time", { expiresAt: "2026-01-31T00:00:00Z" }],
    ["non-HTTPS canonical URI", { canonicalUri: "http://standards.example.test/v1" }],
  ])("rejects %s", (_label, override) => {
    expect(
      SourceSnapshotDefinitionSchema.safeParse({ ...sourceDefinition(), ...override }).success,
    ).toBe(false);
  });

  it("rejects self-reference, duplicate relations, and ambiguous conflict lineage", () => {
    const self = { ...sourceDefinition(), supersedes: [sourceReference("src_standard", "b")] };
    expect(SourceSnapshotDefinitionSchema.safeParse(self).success).toBe(false);

    const duplicate = {
      ...sourceDefinition(),
      conflictsWith: [sourceReference("src_conflict", "c"), sourceReference("src_conflict", "c")],
    };
    expect(SourceSnapshotDefinitionSchema.safeParse(duplicate).success).toBe(false);

    const overlap = {
      ...sourceDefinition(),
      supersedes: [sourceReference("src_conflict", "c")],
    };
    expect(SourceSnapshotDefinitionSchema.safeParse(overlap).success).toBe(false);
  });

  it("preserves unknown and disputed identity or licensing states instead of upgrading them", () => {
    const unverified = {
      ...sourceDefinition(),
      identityVerification: { reason: "Publisher identity is unavailable", status: "unverified" },
      license: { reason: "No license statement was found", status: "unknown" },
    };
    expect(SourceSnapshotDefinitionSchema.safeParse(unverified).success).toBe(true);

    const disputed = {
      ...sourceDefinition(),
      identityVerification: {
        evidence: [artifact("art_dispute", "e")],
        reason: "Two registries disagree about the publisher",
        status: "disputed",
      },
      license: {
        reason: "Redistribution is prohibited",
        status: "restricted",
        termsUri: "https://standards.example.test/restricted-terms",
      },
    };
    expect(SourceSnapshotDefinitionSchema.safeParse(disputed).success).toBe(true);
  });

  it("rejects unordered scope and limitation values and server-only fields in definitions", () => {
    const unordered = sourceDefinition();
    unordered.applicabilityScope.locales = { mode: "include", values: ["ko-kr", "en"] };
    expect(SourceSnapshotDefinitionSchema.safeParse(unordered).success).toBe(false);

    const duplicateLimitations = sourceDefinition();
    duplicateLimitations.knownLimitations = ["Repeated", "Repeated"];
    expect(SourceSnapshotDefinitionSchema.safeParse(duplicateLimitations).success).toBe(false);

    expect(
      SourceSnapshotDefinitionSchema.safeParse({
        ...sourceDefinition(),
        publishedByPrincipalId: "usr_attacker",
      }).success,
    ).toBe(false);
  });

  it("requires explicit any or non-empty include scope selectors", () => {
    const anyLocale = sourceDefinition();
    anyLocale.applicabilityScope.locales = { mode: "any" };
    expect(SourceSnapshotDefinitionSchema.safeParse(anyLocale).success).toBe(true);

    const emptyInclude = sourceDefinition();
    emptyInclude.applicabilityScope.locales = { mode: "include", values: [] };
    expect(SourceSnapshotDefinitionSchema.safeParse(emptyInclude).success).toBe(false);
  });

  it("rejects duplicate exact identity evidence", () => {
    const duplicateEvidence = sourceDefinition();
    duplicateEvidence.identityVerification.evidence = [
      artifact("art_identity", "3"),
      artifact("art_identity", "3"),
    ];
    expect(SourceSnapshotDefinitionSchema.safeParse(duplicateEvidence).success).toBe(false);
  });
});

describe("source review contracts", () => {
  it("approves only an exact independently reviewable source conclusion", () => {
    const definition = reviewDefinition();
    expect(SourceReviewDefinitionSchema.parse(definition)).toEqual(definition);

    const record = {
      ...definition,
      definitionSha256: sha("f"),
      reviewedAt: "2026-01-05T00:00:01.000Z",
      reviewedByPrincipalId: "usr_reviewer",
      reviewerRole: "Risk standards reviewer",
      schemaVersion: SOURCE_REVIEW_SCHEMA_VERSION,
      scope,
    };
    expect(SourceReviewRecordSchema.parse(record)).toEqual(record);
    expect(SourceSnapshotDefinitionSchema.safeParse(record).success).toBe(false);
  });

  it.each([
    ["uncertain authority", { authorityConclusion: "uncertain" }],
    ["undetermined applicability", { applicabilityConclusion: "undetermined" }],
    ["expired source", { freshnessConclusion: "expired" }],
    ["unknown licensing", { licensingConclusion: "unknown" }],
    ["unresolved conflict", { criticalConflictStatus: "unresolved" }],
  ])("does not permit approved outcome with %s", (_label, override) => {
    expect(
      SourceReviewDefinitionSchema.safeParse({ ...reviewDefinition(), ...override }).success,
    ).toBe(false);
  });

  it("preserves unverifiable and approval-required outcomes without fabricating approval", () => {
    const unverifiable = {
      ...reviewDefinition(),
      applicabilityConclusion: "undetermined",
      authorityConclusion: "uncertain",
      freshnessConclusion: "unknown",
      licensingConclusion: "unknown",
      outcome: "unverifiable",
    };
    expect(SourceReviewDefinitionSchema.safeParse(unverifiable).success).toBe(true);

    const requireApproval = {
      ...reviewDefinition(),
      outcome: "require_approval",
    };
    expect(SourceReviewDefinitionSchema.safeParse(requireApproval).success).toBe(true);
  });

  it("requires explicit reasons for rejection and exact conflict review", () => {
    expect(
      SourceReviewDefinitionSchema.safeParse({ ...reviewDefinition(), outcome: "rejected" })
        .success,
    ).toBe(false);

    const rejected = {
      ...reviewDefinition(),
      applicabilityConclusion: "rejected",
      outcome: "rejected",
    };
    expect(SourceReviewDefinitionSchema.safeParse(rejected).success).toBe(true);

    expect(
      SourceReviewDefinitionSchema.safeParse({
        ...reviewDefinition(),
        criticalConflictStatus: "none",
      }).success,
    ).toBe(false);
    expect(
      SourceReviewDefinitionSchema.safeParse({
        ...reviewDefinition(),
        criticalConflictStatus: "resolved",
        reviewedConflicts: [],
      }).success,
    ).toBe(false);
  });

  it("rejects non-positive validity, self-supersession, and caller-owned server provenance", () => {
    expect(
      SourceReviewDefinitionSchema.safeParse({
        ...reviewDefinition(),
        validUntil: "2026-01-05T00:00:00Z",
      }).success,
    ).toBe(false);
    expect(
      SourceReviewDefinitionSchema.safeParse({
        ...reviewDefinition(),
        supersedesReview: {
          definitionSha256: sha("9"),
          sourceReviewId: "srv_standard",
        },
      }).success,
    ).toBe(false);
    expect(
      SourceReviewDefinitionSchema.safeParse({
        ...reviewDefinition(),
        reviewedByPrincipalId: "usr_attacker",
      }).success,
    ).toBe(false);
  });

  it("rejects duplicate exact review basis artifacts", () => {
    const value = reviewDefinition();
    value.reviewBasis = [artifact("art_review_basis", "4"), artifact("art_review_basis", "4")];
    expect(SourceReviewDefinitionSchema.safeParse(value).success).toBe(false);
  });
});
