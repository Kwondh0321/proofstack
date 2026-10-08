import { readFileSync } from "node:fs";
import {
  type EvaluationImplementationRegistrationDefinition,
  type EvaluationImplementationRegistrationRecord,
  type EvidenceScope,
} from "@proofstack/contracts";
import { describe, expect, it } from "vitest";
import {
  digestEvaluationImplementationRegistration,
  InvalidEvaluationImplementationRegistrationError,
  MAX_STATIC_EVALUATION_IMPLEMENTATION_REGISTRATIONS,
  StaticEvaluationImplementationRegistrationCatalogue,
  validateEvaluationImplementationRegistrationRecord,
} from "./evaluation-implementation-registration.js";

const vectors = (
  JSON.parse(
    readFileSync(
      new URL(
        "../../../contracts/vectors/evaluation-implementation-registration-v1.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as {
    vectors: {
      input: { definition: EvaluationImplementationRegistrationDefinition; scope: EvidenceScope };
      sha256: string;
    }[];
  }
).vectors;

function registration(index = 0): EvaluationImplementationRegistrationRecord {
  const vector = vectors[index];
  if (!vector) throw new Error("Missing fixed registration vector");
  return structuredClone({
    ...vector.input.definition,
    scope: vector.input.scope,
    schemaVersion: "0.1" as const,
    registeredAt: "2026-10-08T00:00:00.000Z",
    registeredByPrincipalId: "operator_registration",
    definitionSha256: vector.sha256,
  });
}

function rehash(record: EvaluationImplementationRegistrationRecord) {
  record.definitionSha256 = digestEvaluationImplementationRegistration(record.scope, {
    implementation: record.implementation,
    recordKind: record.recordKind,
  });
  return record;
}

describe("installation-owned implementation registration data", () => {
  it("rejects malformed lookup coordinates rather than admitting coercible identities", async () => {
    const record = registration();
    const catalogue = new StaticEvaluationImplementationRegistrationCatalogue([record]);
    for (const scope of [
      { ...record.scope, tenantId: "" },
      { ...record.scope, projectId: "" },
      { ...record.scope, environmentId: "" },
      { ...record.scope, approved: true },
    ])
      await expect(
        catalogue.findEvaluationImplementationRegistration(
          scope,
          record.implementation.implementationId,
          record.implementation.implementationVersionId,
        ),
      ).rejects.toThrow();
    let coerced = false;
    const coercible = {
      toString: () => {
        coerced = true;
        return record.implementation.implementationId;
      },
    };
    for (const [id, version] of [
      ["", record.implementation.implementationVersionId],
      [record.implementation.implementationId, ""],
      [coercible, record.implementation.implementationVersionId],
    ])
      await expect(
        catalogue.findEvaluationImplementationRegistration(
          record.scope,
          id as string,
          version as string,
        ),
      ).rejects.toThrow();
    expect(coerced).toBe(false);
    expect(new InvalidEvaluationImplementationRegistrationError().code).toBe(
      "evaluation_implementation_registration_invalid",
    );
  });

  it("looks up exact scope/id/version and keeps colliding tenant identities distinct", async () => {
    const records = [registration(), registration(1), registration(2)];
    const later = rehash({
      ...registration(),
      implementation: {
        ...registration().implementation,
        implementationVersionId: "impv_exact_v2",
      },
    });
    const catalogue = new StaticEvaluationImplementationRegistrationCatalogue([...records, later]);
    for (const record of [...records, later])
      await expect(
        catalogue.findEvaluationImplementationRegistration(
          record.scope,
          record.implementation.implementationId,
          record.implementation.implementationVersionId,
        ),
      ).resolves.toEqual(record);
    const original = registration();
    for (const dimension of ["tenantId", "projectId", "environmentId"] as const)
      await expect(
        catalogue.findEvaluationImplementationRegistration(
          { ...original.scope, [dimension]: "outside_scope" },
          original.implementation.implementationId,
          original.implementation.implementationVersionId,
        ),
      ).resolves.toBeNull();
    await expect(
      catalogue.findEvaluationImplementationRegistration(
        original.scope,
        "impl_missing",
        original.implementation.implementationVersionId,
      ),
    ).resolves.toBeNull();
    await expect(
      catalogue.findEvaluationImplementationRegistration(
        original.scope,
        original.implementation.implementationId,
        "impv_missing",
      ),
    ).resolves.toBeNull();
    await expect(
      new StaticEvaluationImplementationRegistrationCatalogue(
        [],
      ).findEvaluationImplementationRegistration(
        original.scope,
        original.implementation.implementationId,
        original.implementation.implementationVersionId,
      ),
    ).resolves.toBeNull();
  });

  it("copies operator inputs and detaches every returned record while preserving original receipts", async () => {
    const record = registration();
    const original = structuredClone(record);
    const input = [record];
    const catalogue = new StaticEvaluationImplementationRegistrationCatalogue(input);
    record.scope.tenantId = "tenant_changed";
    record.implementation.runtime.version = "changed";
    record.registeredByPrincipalId = "operator_changed";
    input.length = 0;
    const read = () =>
      catalogue.findEvaluationImplementationRegistration(
        original.scope,
        original.implementation.implementationId,
        original.implementation.implementationVersionId,
      );
    const first = await read();
    expect(first).toEqual(original);
    if (!first) throw new Error("Expected retained registration");
    first.implementation.implementationSha256 = "e".repeat(64);
    first.scope.projectId = "project_changed";
    first.registeredAt = "2026-10-09T00:00:00.000Z";
    await expect(read()).resolves.toEqual(original);
  });

  it("rejects identical and conflicting duplicate identities instead of choosing a latest registration", () => {
    const record = registration();
    expect(
      () =>
        new StaticEvaluationImplementationRegistrationCatalogue([record, structuredClone(record)]),
    ).toThrow("Duplicate");
    const conflicting = structuredClone(record);
    conflicting.implementation.runtime.version = "24.19.0";
    expect(
      () => new StaticEvaluationImplementationRegistrationCatalogue([record, rehash(conflicting)]),
    ).toThrow("Duplicate");
  });

  it("admits the exact catalogue limit and rejects overflow before visiting entries", async () => {
    const rows = Array.from(
      { length: MAX_STATIC_EVALUATION_IMPLEMENTATION_REGISTRATIONS },
      (_, i) =>
        rehash({
          ...registration(),
          implementation: {
            ...registration().implementation,
            implementationVersionId: `impv_limit_${i}`,
          },
        }),
    );
    const catalogue = new StaticEvaluationImplementationRegistrationCatalogue(rows);
    const last = rows.at(-1);
    if (!last) throw new Error("Expected limit registration");
    await expect(
      catalogue.findEvaluationImplementationRegistration(
        last.scope,
        last.implementation.implementationId,
        last.implementation.implementationVersionId,
      ),
    ).resolves.toEqual(last);
    let visited = false;
    const tooMany = Array(MAX_STATIC_EVALUATION_IMPLEMENTATION_REGISTRATIONS + 1);
    Object.defineProperty(tooMany, "0", {
      get: () => {
        visited = true;
        throw new Error("Must reject before visiting");
      },
    });
    expect(() => new StaticEvaluationImplementationRegistrationCatalogue(tooMany)).toThrow(
      "entry limit",
    );
    expect(visited).toBe(false);
    for (const invalid of [undefined, null, {}, "records"])
      expect(
        () => new StaticEvaluationImplementationRegistrationCatalogue(invalid as never),
      ).toThrow("entry limit");
  });

  it("validates all fixed records, preserves receipts and owns nested input data", () => {
    for (const index of [0, 1, 2]) {
      const input = registration(index);
      const actual = validateEvaluationImplementationRegistrationRecord(input);
      expect(actual).toEqual(input);
      expect(actual).not.toBe(input);
      expect(actual.implementation.runtime).not.toBe(input.implementation.runtime);
      const vector = vectors[index];
      if (!vector) throw new Error("Missing fixed registration vector");
      expect(
        digestEvaluationImplementationRegistration(actual.scope, vector.input.definition),
      ).toBe(input.definitionSha256);
      const later = {
        ...input,
        registeredAt: "2026-10-09T00:00:00.000Z",
        registeredByPrincipalId: "operator_other",
      };
      expect(validateEvaluationImplementationRegistrationRecord(later)).toEqual(later);
    }
  });

  it("rejects forged digests, changed descriptor/scope and data-shaped execution or approval", () => {
    const original = registration();
    let executed = false;
    const execute = () => {
      executed = true;
      return original;
    };
    const changed = structuredClone(original);
    changed.implementation.runtime.version = "24.19.0";
    for (const raw of [
      null,
      { ...original, definitionSha256: "d".repeat(64) },
      changed,
      { ...original, scope: { ...original.scope, projectId: "project_other" } },
      { ...original, qualified: true },
      {
        ...original,
        execute,
      },
    ]) {
      expect(() => validateEvaluationImplementationRegistrationRecord(raw)).toThrow(
        InvalidEvaluationImplementationRegistrationError,
      );
      expect(() => new StaticEvaluationImplementationRegistrationCatalogue([raw])).toThrow(
        InvalidEvaluationImplementationRegistrationError,
      );
    }
    expect(executed).toBe(false);
  });
});
