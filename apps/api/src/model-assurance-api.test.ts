import { readFileSync } from "node:fs";
import { type PrincipalContext, PrincipalContextSchema } from "@proofstack/contracts";
import { MemoryModelAssuranceRepository } from "@proofstack/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import { AuthenticationRequiredError, type Authenticator } from "./auth.js";
import { loadConfig } from "./config.js";

interface StoredVector {
  readonly input: { readonly definition: Record<string, unknown> };
}

function definition(filename: string): Record<string, unknown> {
  const document = JSON.parse(
    readFileSync(
      new URL(`../../../packages/contracts/vectors/${filename}`, import.meta.url),
      "utf8",
    ),
  ) as { readonly vectors: readonly StoredVector[] };
  const value = document.vectors[0];
  if (!value) throw new Error(`Expected ${filename}`);
  return value.input.definition;
}

const config = loadConfig({ PROOFSTACK_ENV: "test", PROOFSTACK_LOG_LEVEL: "silent" });
const apps: Awaited<ReturnType<typeof createApp>>[] = [];
const profileDefinition = definition("evaluation-model-assurance-definition-v1.json");
const evaluatorDefinition = definition("evaluation-model-assisted-spec-definition-v1.json");
const scopeUrl = "/v1/projects/prj_assurance/environments/env_assurance/model-assurance";
const profileUrl = `${scopeUrl}/definitions/mpv_safety_v1`;
const profileReadUrl = `${scopeUrl}/records/model_evaluator_profile/mpv_safety_v1`;

function principal(capabilities: PrincipalContext["capabilities"]): PrincipalContext {
  return PrincipalContextSchema.parse({
    authentication: { authenticatedAt: "2026-09-01T23:59:00.000Z", method: "development" },
    capabilities,
    principalId: "usr_assurance_api",
    principalType: "user",
    requestId: "req_assurance_api",
    resourceScope: { mode: "tenant" },
    roles: ["owner"],
    tenantId: "ten_assurance",
  });
}

async function testApp(
  dependencies: Parameters<typeof createApp>[1] = {},
): Promise<Awaited<ReturnType<typeof createApp>>> {
  const app = await createApp(config, {
    clock: { now: () => new Date("2026-09-01T23:59:59.000Z") },
    ...dependencies,
  });
  apps.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("model assurance control-plane API", () => {
  it("publishes, retries, and reads one exact immutable profile", async () => {
    const app = await testApp();
    const body = { definition: profileDefinition, kind: "model_evaluator_profile" };

    const publication = await app.inject({ body, method: "POST", url: profileUrl });
    const retry = await app.inject({ body, method: "POST", url: profileUrl });
    const read = await app.inject({ method: "GET", url: profileReadUrl });

    expect(publication.statusCode).toBe(201);
    expect(publication.headers["cache-control"]).toBe("no-store");
    expect(publication.json()).toMatchObject({
      created: true,
      result: {
        kind: "model_evaluator_profile",
        record: {
          modelProfileVersionId: "mpv_safety_v1",
          publishedByPrincipalId: "usr_local",
          scope: {
            environmentId: "env_assurance",
            projectId: "prj_assurance",
            tenantId: "ten_local",
          },
        },
      },
    });
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toMatchObject({ created: false });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toMatchObject({
      result: {
        kind: "model_evaluator_profile",
        record: { modelProfileVersionId: "mpv_safety_v1" },
      },
    });
  });

  it("maps malformed, missing, lineage, route-binding, and semantic conflicts distinctly", async () => {
    const app = await testApp();
    const malformed = await app.inject({
      body: { definition: profileDefinition, extra: true, kind: "model_evaluator_profile" },
      method: "POST",
      url: profileUrl,
    });
    const missing = await app.inject({
      method: "GET",
      url: `${scopeUrl}/records/model_evaluator_profile/mpv_missing`,
    });
    const routeMismatch = await app.inject({
      body: { definition: profileDefinition, kind: "model_evaluator_profile" },
      method: "POST",
      url: `${scopeUrl}/definitions/mpv_other`,
    });
    const lineage = await app.inject({
      body: { definition: evaluatorDefinition, kind: "model_assisted_evaluator" },
      method: "POST",
      url: `${scopeUrl}/definitions/evv_model_safety_v1`,
    });
    await app.inject({
      body: { definition: profileDefinition, kind: "model_evaluator_profile" },
      method: "POST",
      url: profileUrl,
    });
    const conflict = await app.inject({
      body: {
        definition: { ...profileDefinition, changeRationale: "Different immutable profile" },
        kind: "model_evaluator_profile",
      },
      method: "POST",
      url: profileUrl,
    });

    expect(malformed.json()).toMatchObject({ code: "invalid_request", status: 400 });
    expect(missing.json()).toMatchObject({
      code: "model_assurance_record_not_found",
      status: 404,
    });
    expect(routeMismatch.json()).toMatchObject({
      code: "model_assurance_record_input_invalid",
      status: 400,
    });
    expect(lineage.json()).toMatchObject({ code: "model_assurance_lineage_invalid", status: 409 });
    expect(conflict.json()).toMatchObject({
      code: "model_assurance_record_conflict",
      status: 409,
    });
  });

  it("authenticates and authorizes before protected model-assurance work", async () => {
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
      body: { definition: profileDefinition, kind: "model_evaluator_profile" },
      method: "POST",
      url: profileUrl,
    });

    expect(unauthenticatedResponse.json()).toMatchObject({ code: "unauthenticated", status: 401 });
    expect(forbidden.json()).toMatchObject({ code: "forbidden", status: 403 });
  });

  it("fails closed when model-assurance storage violates its read contract", async () => {
    const repository = new MemoryModelAssuranceRepository();
    vi.spyOn(repository, "find").mockResolvedValue({ secret: "corrupt-row" } as never);
    const app = await testApp({ modelAssuranceRepository: repository });

    const response = await app.inject({ method: "GET", url: profileReadUrl });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      code: "model_assurance_storage_unavailable",
      detail: "Model-assurance storage is unavailable",
      status: 503,
    });
    expect(JSON.stringify(response.json())).not.toContain("corrupt-row");
  });
});
