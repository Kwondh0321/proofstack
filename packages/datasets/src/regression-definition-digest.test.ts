import { readFileSync } from "node:fs";
import type {
  RegressionDatasetVersionDefinition,
  RegressionFixtureVersionDefinition,
} from "@proofstack/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  digestRegressionDatasetVersionDefinition,
  digestRegressionFixtureVersionDefinition,
  encodeRegressionDatasetVersionDefinition,
  encodeRegressionFixtureVersionDefinition,
  REGRESSION_DATASET_DEFINITION_DOMAIN,
  REGRESSION_FIXTURE_DEFINITION_DOMAIN,
} from "./regression-definition-digest.js";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const TRACE_A = "4bf92f3577b34da6a3ce929d0e0e4736";
const TRACE_B = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

interface StaticVectorBase {
  readonly encodedByteLength: number;
  readonly encodedHex: string;
  readonly name: string;
  readonly sha256: string;
}

interface FixtureStaticVector extends StaticVectorBase {
  readonly input: RegressionFixtureVersionDefinition;
  readonly kind: "fixture";
}

interface DatasetStaticVector extends StaticVectorBase {
  readonly input: RegressionDatasetVersionDefinition;
  readonly kind: "dataset";
}

type StaticVector = DatasetStaticVector | FixtureStaticVector;

const vectorsDocument = JSON.parse(
  readFileSync(new URL("../vectors/regression-definition-v1.json", import.meta.url), "utf8"),
) as {
  readonly format: string;
  readonly vectors: readonly StaticVector[];
};

function fixture(
  overrides: Partial<RegressionFixtureVersionDefinition> = {},
): RegressionFixtureVersionDefinition {
  return {
    fixtureId: "fix_checkout",
    fixtureVersionId: "fiv_checkout_001",
    name: "Checkout incident",
    replayability: "evidence_only",
    schemaVersion: "0.1",
    scope: {
      environmentId: "env_prod",
      projectId: "prj_agent",
      tenantId: "ten_acme",
    },
    source: {
      eventIds: ["evt_run_001"],
      kind: "trace_snapshot",
      observedEventCount: 1,
      sourceCompleteness: "observed_snapshot",
      traceId: TRACE_A,
    },
    ...overrides,
  };
}

function dataset(
  overrides: Partial<RegressionDatasetVersionDefinition> = {},
): RegressionDatasetVersionDefinition {
  return {
    datasetId: "dst_checkout",
    datasetVersionId: "dsv_checkout_001",
    fixtureVersions: [
      {
        definitionSha256: SHA_A,
        fixtureId: "fix_checkout",
        fixtureVersionId: "fiv_checkout_001",
      },
      {
        definitionSha256: SHA_B,
        fixtureId: "fix_search",
        fixtureVersionId: "fiv_search_001",
      },
    ],
    name: "Checkout regressions",
    schemaVersion: "0.1",
    scope: {
      environmentId: "env_prod",
      projectId: "prj_agent",
      tenantId: "ten_acme",
    },
    ...overrides,
  };
}

const hex = (value: Uint8Array): string => Buffer.from(value).toString("hex");

describe("public regression definition v1 vectors", () => {
  it("publishes the immutable vector format and both domains", () => {
    expect(vectorsDocument.format).toBe("proofstack.regression-definition-vectors.v1");
    expect(vectorsDocument.vectors.map(({ name }) => name)).toEqual([
      "minimal fixture",
      "fixture with Unicode and lineage",
      "minimal dataset",
      "dataset with Unicode and lineage",
    ]);
    expect(REGRESSION_FIXTURE_DEFINITION_DOMAIN).toBe("proofstack.fixture-version.v1");
    expect(REGRESSION_DATASET_DEFINITION_DOMAIN).toBe("proofstack.dataset-version.v1");
  });

  it.each(vectorsDocument.vectors)("matches static bytes and SHA-256 for $name", (vector) => {
    const encoded =
      vector.kind === "fixture"
        ? encodeRegressionFixtureVersionDefinition(vector.input)
        : encodeRegressionDatasetVersionDefinition(vector.input);
    const digest =
      vector.kind === "fixture"
        ? digestRegressionFixtureVersionDefinition(vector.input)
        : digestRegressionDatasetVersionDefinition(vector.input);

    expect(encoded.byteLength).toBe(vector.encodedByteLength);
    expect(hex(encoded)).toBe(vector.encodedHex);
    expect(digest).toBe(vector.sha256);
  });

  it("keeps the independently audited minimal fixture anchor stable", () => {
    const anchor = vectorsDocument.vectors[0];
    expect(anchor).toMatchObject({
      encodedByteLength: 229,
      kind: "fixture",
      sha256: "1244c8b017449db95c7854b033597b29c83f05aaa1a690c1768cf643128c412a",
    });
  });

  it("matches independently audited lineage and ordering mutation hashes", () => {
    const richFixture = vectorsDocument.vectors.find(
      ({ name }) => name === "fixture with Unicode and lineage",
    );
    const richDataset = vectorsDocument.vectors.find(
      ({ name }) => name === "dataset with Unicode and lineage",
    );
    if (
      richFixture?.kind !== "fixture" ||
      richDataset?.kind !== "dataset" ||
      !richFixture.input.predecessor ||
      !richDataset.input.predecessor
    ) {
      throw new Error("The rich public regression vectors are missing");
    }

    expect(
      digestRegressionFixtureVersionDefinition({
        ...richFixture.input,
        source: {
          ...richFixture.input.source,
          eventIds: [...richFixture.input.source.eventIds].reverse(),
        },
      }),
    ).toBe("e0e057fa805cfecf325e8dd592ba2c3f862af1db4d791657e2f18b5560076935");
    expect(
      digestRegressionFixtureVersionDefinition({
        ...richFixture.input,
        predecessor: {
          definitionSha256: "2".repeat(64),
          fixtureVersionId: richFixture.input.predecessor.fixtureVersionId,
        },
      }),
    ).toBe("d19c7bb1cae2df5be79bf68c44abec031c0f9f2e27c572f7e75bdb5cdb4e48c8");
    expect(
      digestRegressionDatasetVersionDefinition({
        ...richDataset.input,
        fixtureVersions: [...richDataset.input.fixtureVersions].reverse(),
      }),
    ).toBe("7fa81bcdba98a288cc29e9f828f3ef7cc25486991ed66778adbada8e1f68dc81");
    expect(
      digestRegressionDatasetVersionDefinition({
        ...richDataset.input,
        predecessor: {
          datasetVersionId: "dsv_checkout_000",
          definitionSha256: richDataset.input.predecessor.definitionSha256,
        },
      }),
    ).toBe("eff02954d3dd54290960988cb726c2d48fe02b98c984698e790105233fb408ec");
  });
});

describe("fixture definition encoding", () => {
  it("ignores JavaScript property insertion order, including nested properties", () => {
    const original = fixture();
    const reordered: RegressionFixtureVersionDefinition = {
      source: {
        traceId: original.source.traceId,
        sourceCompleteness: original.source.sourceCompleteness,
        observedEventCount: original.source.observedEventCount,
        kind: original.source.kind,
        eventIds: original.source.eventIds,
      },
      scope: {
        tenantId: original.scope.tenantId,
        environmentId: original.scope.environmentId,
        projectId: original.scope.projectId,
      },
      schemaVersion: original.schemaVersion,
      replayability: original.replayability,
      name: original.name,
      fixtureVersionId: original.fixtureVersionId,
      fixtureId: original.fixtureId,
    };

    expect(encodeRegressionFixtureVersionDefinition(reordered)).toEqual(
      encodeRegressionFixtureVersionDefinition(original),
    );
  });

  it("preserves event order without sorting", () => {
    const forward = fixture({
      source: {
        ...fixture().source,
        eventIds: ["evt_run_002", "evt_run_010"],
        observedEventCount: 2,
      },
    });
    const reversed = fixture({
      source: { ...forward.source, eventIds: [...forward.source.eventIds].reverse() },
    });

    expect(digestRegressionFixtureVersionDefinition(forward)).not.toBe(
      digestRegressionFixtureVersionDefinition(reversed),
    );
  });

  it("makes every variable semantic field digest-significant", () => {
    const predecessor = { definitionSha256: SHA_A, fixtureVersionId: "fiv_checkout_000" };
    const base = fixture({
      description: "Original description",
      predecessor,
      source: {
        ...fixture().source,
        eventIds: ["evt_run_001", "evt_run_002"],
        observedEventCount: 2,
      },
    });
    const mutations: RegressionFixtureVersionDefinition[] = [
      { ...base, scope: { ...base.scope, tenantId: "ten_other" } },
      { ...base, scope: { ...base.scope, projectId: "prj_other" } },
      { ...base, scope: { ...base.scope, environmentId: "env_other" } },
      { ...base, fixtureId: "fix_other" },
      { ...base, fixtureVersionId: "fiv_checkout_999" },
      { ...base, name: "Another incident" },
      { ...base, description: "Another description" },
      {
        ...base,
        predecessor: { ...predecessor, fixtureVersionId: "fiv_checkout_998" },
      },
      { ...base, predecessor: { ...predecessor, definitionSha256: SHA_B } },
      { ...base, source: { ...base.source, traceId: TRACE_B } },
      {
        ...base,
        source: { ...base.source, eventIds: ["evt_run_001", "evt_run_003"] },
      },
      {
        ...base,
        source: { ...base.source, eventIds: ["evt_run_001"], observedEventCount: 1 },
      },
    ];
    const { description: _description, ...withoutDescription } = base;
    const { predecessor: _predecessor, ...withoutPredecessor } = base;
    mutations.push(withoutDescription, withoutPredecessor);
    const digest = digestRegressionFixtureVersionDefinition(base);

    for (const mutation of mutations) {
      expect(digestRegressionFixtureVersionDefinition(mutation)).not.toBe(digest);
    }
  });

  it("accepts the exact 1,000-event contract boundary without truncating", () => {
    const eventIds = Array.from(
      { length: 1_000 },
      (_, index) => `evt_${index.toString().padStart(4, "0")}`,
    );
    const encoded = encodeRegressionFixtureVersionDefinition(
      fixture({ source: { ...fixture().source, eventIds, observedEventCount: eventIds.length } }),
    );

    expect(encoded).toBeInstanceOf(Uint8Array);
    expect(encoded.byteLength).toBeGreaterThan(1_000);
  });
});

describe("dataset definition encoding", () => {
  it("ignores JavaScript property insertion order, including resolved references", () => {
    const original = dataset();
    const reordered: RegressionDatasetVersionDefinition = {
      scope: {
        tenantId: original.scope.tenantId,
        environmentId: original.scope.environmentId,
        projectId: original.scope.projectId,
      },
      schemaVersion: original.schemaVersion,
      name: original.name,
      fixtureVersions: original.fixtureVersions.map((reference) => ({
        fixtureVersionId: reference.fixtureVersionId,
        fixtureId: reference.fixtureId,
        definitionSha256: reference.definitionSha256,
      })),
      datasetVersionId: original.datasetVersionId,
      datasetId: original.datasetId,
    };

    expect(encodeRegressionDatasetVersionDefinition(reordered)).toEqual(
      encodeRegressionDatasetVersionDefinition(original),
    );
  });

  it("preserves membership order without sorting", () => {
    const forward = dataset();
    const reversed = dataset({ fixtureVersions: [...forward.fixtureVersions].reverse() });

    expect(digestRegressionDatasetVersionDefinition(forward)).not.toBe(
      digestRegressionDatasetVersionDefinition(reversed),
    );
  });

  it("makes every variable semantic field digest-significant", () => {
    const predecessor = { datasetVersionId: "dsv_checkout_000", definitionSha256: SHA_A };
    const base = dataset({
      description: "Original description",
      predecessor,
    });
    const first = base.fixtureVersions[0];
    if (!first) throw new Error("The test dataset requires one fixture reference");
    const mutations: RegressionDatasetVersionDefinition[] = [
      { ...base, scope: { ...base.scope, tenantId: "ten_other" } },
      { ...base, scope: { ...base.scope, projectId: "prj_other" } },
      { ...base, scope: { ...base.scope, environmentId: "env_other" } },
      { ...base, datasetId: "dst_other" },
      { ...base, datasetVersionId: "dsv_checkout_999" },
      { ...base, name: "Another dataset" },
      { ...base, description: "Another description" },
      {
        ...base,
        predecessor: { ...predecessor, datasetVersionId: "dsv_checkout_998" },
      },
      { ...base, predecessor: { ...predecessor, definitionSha256: SHA_B } },
      {
        ...base,
        fixtureVersions: [
          { ...first, fixtureId: "fix_alternate" },
          ...base.fixtureVersions.slice(1),
        ],
      },
      {
        ...base,
        fixtureVersions: [
          { ...first, fixtureVersionId: "fiv_alternate_001" },
          ...base.fixtureVersions.slice(1),
        ],
      },
      {
        ...base,
        fixtureVersions: [
          { ...first, definitionSha256: "c".repeat(64) },
          ...base.fixtureVersions.slice(1),
        ],
      },
      { ...base, fixtureVersions: [first] },
    ];
    const { description: _description, ...withoutDescription } = base;
    const { predecessor: _predecessor, ...withoutPredecessor } = base;
    mutations.push(withoutDescription, withoutPredecessor);
    const digest = digestRegressionDatasetVersionDefinition(base);

    for (const mutation of mutations) {
      expect(digestRegressionDatasetVersionDefinition(mutation)).not.toBe(digest);
    }
  });

  it("accepts the exact 500-member contract boundary without truncating", () => {
    const fixtureVersions = Array.from({ length: 500 }, (_, index) => ({
      definitionSha256: index.toString(16).padStart(64, "0"),
      fixtureId: `fix_${index.toString().padStart(4, "0")}`,
      fixtureVersionId: `fiv_${index.toString().padStart(4, "0")}`,
    }));
    const encoded = encodeRegressionDatasetVersionDefinition(dataset({ fixtureVersions }));

    expect(encoded).toBeInstanceOf(Uint8Array);
    expect(encoded.byteLength).toBeGreaterThan(500);
  });
});

describe("canonical definition validation", () => {
  it.each(["e\u0301", "line\nbreak", "\u0085", "\u202e", "\ud800"])(
    "rejects malformed or non-canonical fixture text %j before encoding",
    (name) => {
      const utf8 = vi.spyOn(TextEncoder.prototype, "encode");
      expect(() => encodeRegressionFixtureVersionDefinition(fixture({ name }))).toThrow();
      expect(utf8).not.toHaveBeenCalled();
      utf8.mockRestore();
    },
  );

  it.each([
    null,
    { ...fixture(), unknown: true },
    { ...fixture(), schemaVersion: "0.2" },
    { ...fixture(), replayability: "executable" },
    { ...fixture(), source: { ...fixture().source, kind: "manual" } },
    { ...fixture(), source: { ...fixture().source, observedEventCount: 2 } },
    { ...fixture(), source: { ...fixture().source, sourceCompleteness: "complete" } },
    { ...fixture(), source: { ...fixture().source, capturedAt: "2026-08-29T00:00:00Z" } },
    { ...fixture(), name: 1 },
  ])("strictly rejects malformed, extended, or coerced fixture definitions %#", (value) => {
    expect(() =>
      encodeRegressionFixtureVersionDefinition(
        value as unknown as RegressionFixtureVersionDefinition,
      ),
    ).toThrow();
  });

  it.each([
    null,
    { ...dataset(), unknown: true },
    { ...dataset(), schemaVersion: "0.2" },
    { ...dataset(), fixtureVersions: [] },
    { ...dataset(), fixtureVersions: [dataset().fixtureVersions[0], dataset().fixtureVersions[0]] },
    { ...dataset(), createdAt: "2026-08-29T00:00:00Z" },
    { ...dataset(), name: 1 },
  ])("strictly rejects malformed, extended, or coerced dataset definitions %#", (value) => {
    expect(() =>
      encodeRegressionDatasetVersionDefinition(
        value as unknown as RegressionDatasetVersionDefinition,
      ),
    ).toThrow();
  });
});
