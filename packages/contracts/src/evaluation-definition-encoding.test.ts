import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  encodeDiscoveryRecordDefinition,
  encodeEvaluationCanonicalJson,
  encodeSourceReviewDefinition,
  encodeSourceSnapshotDefinition,
  type ScopedEvaluationDefinition,
} from "./evaluation-definition-encoding.js";
import type {
  DiscoveryRecordDefinition,
  SourceReviewDefinition,
  SourceSnapshotDefinition,
} from "./evaluation-source.js";

interface StaticVectorBase {
  readonly encodedByteLength: number;
  readonly name: string;
  readonly sha256: string;
}

interface DiscoveryVector extends StaticVectorBase {
  readonly input: ScopedEvaluationDefinition<DiscoveryRecordDefinition>;
  readonly kind: "discovery_record";
}

interface SourceReviewVector extends StaticVectorBase {
  readonly input: ScopedEvaluationDefinition<SourceReviewDefinition>;
  readonly kind: "source_review";
}

interface SourceSnapshotVector extends StaticVectorBase {
  readonly input: ScopedEvaluationDefinition<SourceSnapshotDefinition>;
  readonly kind: "source_snapshot";
}

type StaticVector = DiscoveryVector | SourceReviewVector | SourceSnapshotVector;

const vectorsDocument = JSON.parse(
  readFileSync(new URL("../vectors/evaluation-source-definition-v1.json", import.meta.url), "utf8"),
) as {
  readonly format: string;
  readonly vectors: readonly StaticVector[];
};

function encode(vector: StaticVector): Uint8Array {
  switch (vector.kind) {
    case "discovery_record":
      return encodeDiscoveryRecordDefinition(vector.input);
    case "source_snapshot":
      return encodeSourceSnapshotDefinition(vector.input);
    case "source_review":
      return encodeSourceReviewDefinition(vector.input);
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function requireVector<Kind extends StaticVector["kind"]>(kind: Kind) {
  const vector = vectorsDocument.vectors.find((candidate) => candidate.kind === kind);
  if (!vector) throw new Error(`Expected a ${kind} vector`);
  return vector as Extract<StaticVector, { readonly kind: Kind }>;
}

describe("canonical evaluation source definition encoding", () => {
  it("matches independent fixed UTF-8 and SHA-256 vectors", () => {
    expect(vectorsDocument.format).toBe("proofstack.evaluation-source-definition.v1");
    expect(vectorsDocument.vectors.map(({ kind }) => kind)).toEqual([
      "discovery_record",
      "source_snapshot",
      "source_review",
    ]);

    for (const vector of vectorsDocument.vectors) {
      const encoded = encode(vector);
      expect(encoded.byteLength, vector.name).toBe(vector.encodedByteLength);
      expect(sha256(encoded), vector.name).toBe(vector.sha256);
    }
  });

  it("normalizes input object insertion order without sorting semantic arrays", () => {
    const vector = requireVector("source_snapshot");
    const reordered = {
      scope: Object.fromEntries(Object.entries(vector.input.scope).reverse()),
      definition: Object.fromEntries(Object.entries(vector.input.definition).reverse()),
    } as unknown as typeof vector.input;
    expect(encodeSourceSnapshotDefinition(reordered)).toEqual(
      encodeSourceSnapshotDefinition(vector.input),
    );

    const reversedLimitations = structuredClone(vector.input);
    reversedLimitations.definition.knownLimitations.push(
      "Requires organization-specific applicability review",
    );
    expect(() => encodeSourceSnapshotDefinition(reversedLimitations)).not.toThrow();
    reversedLimitations.definition.knownLimitations.reverse();
    expect(() => encodeSourceSnapshotDefinition(reversedLimitations)).toThrow();
  });

  it("changes bytes for exact source, review, discovery, and tenant lineage", () => {
    for (const vector of vectorsDocument.vectors) {
      const original = encode(vector);
      const changed = structuredClone(vector);
      changed.input.scope.tenantId = "ten_other";
      expect(encode(changed)).not.toEqual(original);
    }

    const source = structuredClone(requireVector("source_snapshot"));
    source.input.definition.content.sha256 = "f".repeat(64);
    expect(sha256(encode(source))).not.toBe(requireVector("source_snapshot").sha256);

    const review = structuredClone(requireVector("source_review"));
    review.input.definition.outcome = "rejected";
    review.input.definition.authorityConclusion = "rejected";
    expect(sha256(encode(review))).not.toBe(requireVector("source_review").sha256);
  });

  it("rejects metadata smuggling, malformed definitions, and non-scalar JSON strings", () => {
    const vector = requireVector("discovery_record");
    expect(() =>
      encodeDiscoveryRecordDefinition({ ...vector.input, recordedAt: "hidden" } as never),
    ).toThrow();
    expect(() =>
      encodeDiscoveryRecordDefinition({
        ...vector.input,
        definition: { ...vector.input.definition, hiddenAuthority: true },
      } as never),
    ).toThrow();

    const malformedUnicode = structuredClone(vector.input);
    malformedUnicode.definition.filters = { malformed: "\ud800" };
    expect(() => encodeDiscoveryRecordDefinition(malformedUnicode)).toThrow(
      /Unicode scalar strings/,
    );
  });

  it("encodes multilingual canonical text as exact UTF-8", () => {
    const review = structuredClone(requireVector("source_review").input);
    review.definition.rationale = "검증된 출처와 범위에 근거한 독립 검토입니다.";
    const encoded = encodeSourceReviewDefinition(review);
    const decoded = Buffer.from(encoded).toString("utf8");
    expect(decoded).toContain("검증된 출처와 범위에 근거한 독립 검토입니다.");
  });
});

describe("canonical evaluation JSON primitive", () => {
  it("uses deterministic JCS ordering, JSON scalar forms, and exact UTF-8", () => {
    const expected = '{"a":"é한😀","z":[null,false,true,0,1.5,1e+30]}';
    const encoded = encodeEvaluationCanonicalJson({
      z: [null, false, true, -0, 1.5, 1e30],
      a: "é한😀",
    });
    expect(Buffer.from(encoded).toString("utf8")).toBe(expected);
    expect(encoded).toEqual(Uint8Array.from(Buffer.from(expected)));
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "rejects non-finite number %s",
    (value) => {
      expect(() => encodeEvaluationCanonicalJson(value)).toThrow(/finite JSON numbers/);
    },
  );

  it.each([undefined, 1n, Symbol("unsupported"), () => undefined])(
    "rejects non-JSON value %s",
    (value) => {
      expect(() => encodeEvaluationCanonicalJson(value)).toThrow(/JSON values only/);
    },
  );

  it("rejects circular references, sparse arrays, prototypes, symbols, and malformed keys", () => {
    const circular: { self?: unknown } = {};
    circular.self = circular;
    expect(() => encodeEvaluationCanonicalJson(circular)).toThrow(/circular references/);

    const sparse: unknown[] = [];
    sparse.length = 2;
    sparse[1] = "present";
    expect(() => encodeEvaluationCanonicalJson(sparse)).toThrow(/sparse arrays/);

    expect(() => encodeEvaluationCanonicalJson(new Date(0))).toThrow(/plain JSON objects/);

    const symbolKey = { value: true, [Symbol("hidden")]: false };
    expect(() => encodeEvaluationCanonicalJson(symbolKey)).toThrow(/symbol keys/);

    const malformedKey: Record<string, boolean> = {};
    malformedKey["\ud800"] = true;
    expect(() => encodeEvaluationCanonicalJson(malformedKey)).toThrow(
      /keys require Unicode scalars/,
    );
    expect(() => encodeEvaluationCanonicalJson("\udc00")).toThrow(/Unicode scalar strings/);
  });

  it("rejects values beyond the bounded canonical nesting depth", () => {
    let nested: unknown = null;
    for (let depth = 0; depth < 66; depth += 1) nested = [nested];
    expect(() => encodeEvaluationCanonicalJson(nested)).toThrow(/cannot exceed 64 levels/);
  });
});
