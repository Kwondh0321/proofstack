import { readFileSync } from "node:fs";
import { type PrincipalContext, PrincipalContextSchema } from "@proofstack/contracts";
import { MemoryEvaluationRepository } from "@proofstack/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import { AuthenticationRequiredError, type Authenticator } from "./auth.js";
import { loadConfig } from "./config.js";

interface SourceVector {
  readonly input: { readonly definition: Record<string, unknown> };
  readonly kind: "discovery_record" | "source_review" | "source_snapshot";
}

const config = loadConfig({ PROOFSTACK_ENV: "test", PROOFSTACK_LOG_LEVEL: "silent" });
const apps: Awaited<ReturnType<typeof createApp>>[] = [];
const vectors = (
  JSON.parse(
    readFileSync(
      new URL(
        "../../../packages/contracts/vectors/evaluation-source-definition-v1.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as { readonly vectors: readonly SourceVector[] }
).vectors;
const discoveryVector = vectors.find(({ kind }) => kind === "discovery_record");
const sourceVector = vectors.find(({ kind }) => kind === "source_snapshot");
if (!discoveryVector || !sourceVector) {
  throw new Error("Evaluation source vectors are incomplete");
}

const discoveryDefinition = discoveryVector.input.definition;
const sourceDefinition = sourceVector.input.definition;
const scopeUrl = "/v1/projects/prj_local/environments/env_local/evaluations";
const discoveryUrl = `${scopeUrl}/definitions/dsc_standard`;
const discoveryReadUrl = `${scopeUrl}/records/discovery_record/dsc_standard`;

function principal(capabilities: PrincipalContext["capabilities"]): PrincipalContext {
  return PrincipalContextSchema.parse({
    authentication: {
      authenticatedAt: "2026-09-02T01:10:00.000Z",
      method: "development",
    },
    capabilities,
    principalId: "usr_local",
    principalType: "user",
    requestId: "req_evaluation_api",
    resourceScope: { mode: "tenant" },
    roles: ["owner"],
    tenantId: "ten_local",
  });
}

async function testApp(
  dependencies: Parameters<typeof createApp>[1] = {},
): Promise<Awaited<ReturnType<typeof createApp>>> {
  const app = await createApp(config, {
    clock: { now: () => new Date("2026-09-02T01:10:00.000Z") },
    ...dependencies,
  });
  apps.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("evaluation control-plane API", () => {
  it("publishes, retries, and reads one exact immutable record", async () => {
    const app = await testApp();
    const body = { definition: discoveryDefinition, kind: "discovery_record" };

    const publication = await app.inject({ body, method: "POST", url: discoveryUrl });
    const retry = await app.inject({ body, method: "POST", url: discoveryUrl });
    const read = await app.inject({ method: "GET", url: discoveryReadUrl });

    expect(publication.statusCode).toBe(201);
    expect(publication.headers["cache-control"]).toBe("no-store");
    expect(publication.json()).toMatchObject({
      created: true,
      result: {
        kind: "discovery_record",
        record: {
          discoveryId: "dsc_standard",
          recordedByPrincipalId: "usr_local",
          scope: {
            environmentId: "env_local",
            projectId: "prj_local",
            tenantId: "ten_local",
          },
        },
      },
    });
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toMatchObject({ created: false });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toMatchObject({
      result: { kind: "discovery_record", record: { discoveryId: "dsc_standard" } },
    });
  });

  it("maps malformed, missing, lineage, route-binding, and semantic conflicts distinctly", async () => {
    const app = await testApp();
    const malformed = await app.inject({
      body: { definition: discoveryDefinition, extra: true, kind: "discovery_record" },
      method: "POST",
      url: discoveryUrl,
    });
    const missing = await app.inject({
      method: "GET",
      url: `${scopeUrl}/records/discovery_record/dsc_missing`,
    });
    const routeMismatch = await app.inject({
      body: { definition: discoveryDefinition, kind: "discovery_record" },
      method: "POST",
      url: `${scopeUrl}/definitions/dsc_other`,
    });
    const lineage = await app.inject({
      body: { definition: sourceDefinition, kind: "source_snapshot" },
      method: "POST",
      url: `${scopeUrl}/definitions/src_standard`,
    });
    await app.inject({
      body: { definition: discoveryDefinition, kind: "discovery_record" },
      method: "POST",
      url: discoveryUrl,
    });
    const conflict = await app.inject({
      body: {
        definition: { ...discoveryDefinition, query: "different immutable discovery" },
        kind: "discovery_record",
      },
      method: "POST",
      url: discoveryUrl,
    });

    expect(malformed.json()).toMatchObject({ code: "invalid_request", status: 400 });
    expect(missing.json()).toMatchObject({ code: "evaluation_record_not_found", status: 404 });
    expect(routeMismatch.json()).toMatchObject({
      code: "evaluation_record_input_invalid",
      status: 400,
    });
    expect(lineage.json()).toMatchObject({ code: "evaluation_lineage_invalid", status: 409 });
    expect(conflict.json()).toMatchObject({ code: "evaluation_record_conflict", status: 409 });
  });

  it("authenticates and authorizes before protected evaluation work", async () => {
    const unavailable: Authenticator = {
      authenticate: vi.fn(async () => {
        throw new AuthenticationRequiredError();
      }),
    };
    const unauthenticated = await testApp({ authenticator: unavailable });
    const unauthenticatedResponse = await unauthenticated.inject({
      body: { malformed: true },
      method: "POST",
      url: `${scopeUrl}/definitions/INVALID`,
    });
    const reader = await testApp({
      authenticator: { authenticate: async () => principal(["evaluation:read"]) },
    });
    const forbidden = await reader.inject({
      body: { definition: discoveryDefinition, kind: "discovery_record" },
      method: "POST",
      url: discoveryUrl,
    });

    expect(unauthenticatedResponse.json()).toMatchObject({ code: "unauthenticated", status: 401 });
    expect(forbidden.json()).toMatchObject({ code: "forbidden", status: 403 });
  });

  it("fails closed when an evaluation repository violates its read contract", async () => {
    const repository = new MemoryEvaluationRepository();
    vi.spyOn(repository, "findDiscoveryRecord").mockResolvedValue({
      secret: "corrupt-row",
    } as never);
    const app = await testApp({ evaluationRepository: repository });

    const response = await app.inject({ method: "GET", url: discoveryReadUrl });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      code: "evaluation_storage_unavailable",
      detail: "Evaluation storage is unavailable",
      status: 503,
    });
    expect(JSON.stringify(response.json())).not.toContain("corrupt-row");
  });
});
