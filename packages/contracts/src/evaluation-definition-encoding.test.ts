import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  encodeDiscoveryRecordDefinition,
  encodeEvaluationCanonicalJson,
  encodeSourceReviewDefinition,
  encodeSourceReviewerQualificationDefinition,
  encodeSourceSnapshotDefinition,
  type ScopedEvaluationDefinition,
  serializeEvaluationCanonicalJson,
} from "./evaluation-definition-encoding.js";
import type {
  DiscoveryRecordDefinition,
  SourceReviewDefinition,
  SourceReviewerQualificationDefinition,
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

interface SourceReviewerQualificationVector extends StaticVectorBase {
  readonly input: ScopedEvaluationDefinition<SourceReviewerQualificationDefinition>;
  readonly kind: "source_reviewer_qualification";
}

type StaticVector =
  | DiscoveryVector
  | SourceReviewVector
  | SourceReviewerQualificationVector
  | SourceSnapshotVector;

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
    case "source_reviewer_qualification":
      return encodeSourceReviewerQualificationDefinition(vector.input);
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
      "source_reviewer_qualification",
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
  it.each(Array.from({ length: 32 }, (_, block) => block * 2048))(
    "matches independent native UTF-8 admission for UTF-16 units from %i",
    (start) => {
      for (let unit = start; unit < start + 2048; unit++) {
        const text = String.fromCharCode(unit);
        const scalar = Buffer.from(text, "utf8").toString("utf8") === text;
        for (const value of [text, { [text]: 1 }]) {
          if (!scalar) {
            expect(() => serializeEvaluationCanonicalJson(value)).toThrow(/Unicode scalar/);
            expect(() => encodeEvaluationCanonicalJson(value)).toThrow(/Unicode scalar/);
          } else {
            const expected = JSON.stringify(value);
            expect(serializeEvaluationCanonicalJson(value)).toBe(expected);
            expect(encodeEvaluationCanonicalJson(value)).toEqual(
              Uint8Array.from(Buffer.from(expected, "utf8")),
            );
          }
        }
      }
    },
  );

  it("preserves paired boundaries and rejects malformed mixed surrogate sequences", () => {
    const units = [0x41, 0xd800, 0xdbff, 0xdc00, 0xdfff, 0xfffd];
    for (const first of units) {
      for (const second of units) {
        for (const third of units) {
          const text = String.fromCharCode(first, second, third);
          const scalar = Buffer.from(text, "utf8").toString("utf8") === text;
          for (const value of [text, { [text]: 1 }]) {
            if (!scalar) {
              expect(() => serializeEvaluationCanonicalJson(value)).toThrow(/Unicode scalar/);
              expect(() => encodeEvaluationCanonicalJson(value)).toThrow(/Unicode scalar/);
            } else {
              const expected = JSON.stringify(value);
              expect(serializeEvaluationCanonicalJson(value)).toBe(expected);
              expect(encodeEvaluationCanonicalJson(value)).toEqual(
                Uint8Array.from(Buffer.from(expected, "utf8")),
              );
            }
          }
        }
      }
    }
  });

  it.each([
    ["\u007f", [0x7f]],
    ["\u0080", [0xc2, 0x80]],
    ["\u07ff", [0xdf, 0xbf]],
    ["\u0800", [0xe0, 0xa0, 0x80]],
    ["\ud7ff", [0xed, 0x9f, 0xbf]],
    ["\ue000", [0xee, 0x80, 0x80]],
    ["\uffff", [0xef, 0xbf, 0xbf]],
    ["\u{10000}", [0xf0, 0x90, 0x80, 0x80]],
    ["\u{10ffff}", [0xf4, 0x8f, 0xbf, 0xbf]],
  ] as const)("preserves exact scalar UTF-8 bytes for %j", (text, bytes) => {
    expect(encodeEvaluationCanonicalJson(text)).toEqual(Uint8Array.from([0x22, ...bytes, 0x22]));
  });

  it("uses deterministic JCS ordering, JSON scalar forms, and exact UTF-8", () => {
    const expected = '{"a":"é한😀","z":[null,false,true,0,1.5,1e+30]}';
    const encoded = encodeEvaluationCanonicalJson({
      z: [null, false, true, -0, 1.5, 1e30],
      a: "é한😀",
    });
    expect(Buffer.from(encoded).toString("utf8")).toBe(expected);
    expect(encoded).toEqual(Uint8Array.from(Buffer.from(expected)));
    expect(
      serializeEvaluationCanonicalJson({
        z: [null, false, true, -0, 1.5, 1e30],
        a: "é한😀",
      }),
    ).toBe(expected);
  });

  it("retains mixed-width scalar offsets and independent output across a large canonical body", () => {
    const value = { text: "ASCII\u007fé한😀A\u{10000}B\u{10ffff}C\u0000".repeat(1024) };
    const expected = Uint8Array.from(Buffer.from(JSON.stringify(value), "utf8"));
    const first = encodeEvaluationCanonicalJson(value);
    expect(first).toEqual(expected);
    expect(serializeEvaluationCanonicalJson(value)).toBe(JSON.stringify(value));
    first.fill(0);
    expect(encodeEvaluationCanonicalJson(value)).toEqual(expected);
  });

  it("retains exact ordered key bytes and strict value admission across repeated and diverse keys", () => {
    const keys = Array.from(
      { length: 320 },
      (_, index) => `key_${index.toString().padStart(4, "0")}`,
    );
    const row = Object.fromEntries(keys.map((key, index) => [key, index]));
    const value = [row, { ...row, "é한😀": "mixed", 'quote"\\': "escaped" }];
    const expectedRows = value.map((item) =>
      Object.fromEntries(
        Object.keys(item)
          .sort()
          .map((key) => [key, item[key as keyof typeof item]]),
      ),
    );
    const expected = JSON.stringify(expectedRows);
    expect(serializeEvaluationCanonicalJson(value)).toBe(expected);
    expect(encodeEvaluationCanonicalJson(value)).toEqual(
      Uint8Array.from(Buffer.from(expected, "utf8")),
    );
    for (const invalid of [
      [row, { ...row, "\ud800": true }],
      [row, { ...row, key_0000: "\udc00" }],
      [row, { ...row, key_0000: Number.NaN }],
      [row, { ...row, [Symbol("hidden")]: true }],
    ]) {
      expect(() => serializeEvaluationCanonicalJson(invalid)).toThrow(TypeError);
      expect(() => encodeEvaluationCanonicalJson(invalid)).toThrow(TypeError);
    }
    const changed = [row, { ...row, key_0000: -1 }];
    expect(serializeEvaluationCanonicalJson(changed)).not.toBe(expected);
    expect(serializeEvaluationCanonicalJson(value)).toBe(expected);
  });

  it("retains the same strict JSON admission for canonical text without encoding bytes", () => {
    const circular: { self?: unknown } = {};
    circular.self = circular;
    const sparse: unknown[] = [];
    sparse.length = 1;
    let deep: unknown = null;
    for (let depth = 0; depth < 66; depth += 1) deep = [deep];
    for (const value of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      undefined,
      1n,
      Symbol("unsupported"),
      () => undefined,
      circular,
      sparse,
      new Date(0),
      { [Symbol("hidden")]: true },
      "\ud800",
      "\udc00",
      { "\ud800": true },
    ]) {
      expect(() => serializeEvaluationCanonicalJson(value)).toThrow(TypeError);
      expect(() => encodeEvaluationCanonicalJson(value)).toThrow(TypeError);
    }
    expect(() => serializeEvaluationCanonicalJson(deep)).toThrow(RangeError);
    expect(() => encodeEvaluationCanonicalJson(deep)).toThrow(RangeError);
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
