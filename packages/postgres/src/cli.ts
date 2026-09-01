#!/usr/bin/env node

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type Capability,
  CapabilitySchema,
  type ResourceScope,
  ResourceScopeSchema,
  type Role,
  RoleSchema,
  type WorkloadCapability,
  WorkloadCapabilitySchema,
} from "@proofstack/contracts";
import type { Pool } from "pg";
import { validatePostgresConnectionString } from "./connection-string.js";
import { createPostgresPool } from "./database.js";
import {
  type BootstrapApiKeyOptions,
  bootstrapApiKey,
  type CreateOidcBindingOptions,
  createOidcBinding,
  type DisableOidcBindingOptions,
  disableOidcBinding,
  inspectIdentityCredentials,
  type UpdateOidcBindingOptions,
  updateOidcBinding,
} from "./identity-administration.js";
import { inspectMigrations, migrateDatabase } from "./migration-runner.js";
import {
  DEFAULT_RUNTIME_ROLE_NAMES,
  provisionRuntimeRoles,
  type RuntimeRoleProvisioningOptions,
} from "./runtime-roles.js";

interface DatabaseCliEnvironment extends NodeJS.ProcessEnv {
  readonly PROOFSTACK_API_DATABASE_PASSWORD?: string;
  readonly PROOFSTACK_API_DATABASE_ROLE?: string;
  readonly PROOFSTACK_ARTIFACT_DATABASE_PASSWORD?: string;
  readonly PROOFSTACK_ARTIFACT_DATABASE_ROLE?: string;
  readonly PROOFSTACK_CONSUMER_DATABASE_PASSWORD?: string;
  readonly PROOFSTACK_CONSUMER_DATABASE_ROLE?: string;
  readonly PROOFSTACK_DATABASE_URL?: string;
  readonly PROOFSTACK_ENV?: string;
  readonly PROOFSTACK_EVALUATION_WORKER_DATABASE_PASSWORD?: string;
  readonly PROOFSTACK_EVALUATION_WORKER_DATABASE_ROLE?: string;
  readonly PROOFSTACK_IDENTITY_DATABASE_PASSWORD?: string;
  readonly PROOFSTACK_IDENTITY_DATABASE_ROLE?: string;
  readonly PROOFSTACK_IDENTITY_TENANT_ID?: string;
  readonly PROOFSTACK_MIGRATION_DATABASE_URL?: string;
  readonly PROOFSTACK_PUBLISHER_DATABASE_PASSWORD?: string;
  readonly PROOFSTACK_PUBLISHER_DATABASE_ROLE?: string;
  readonly PROOFSTACK_REPLAY_WORKER_DATABASE_PASSWORD?: string;
  readonly PROOFSTACK_REPLAY_WORKER_DATABASE_ROLE?: string;
  readonly PROOFSTACK_BOOTSTRAP_ACTOR_PRINCIPAL_ID?: string;
  readonly PROOFSTACK_BOOTSTRAP_KEY_CAPABILITIES?: string;
  readonly PROOFSTACK_BOOTSTRAP_KEY_EXPIRES_AT?: string;
  readonly PROOFSTACK_BOOTSTRAP_KEY_NAME?: string;
  readonly PROOFSTACK_BOOTSTRAP_KEY_RESOURCE_SCOPE?: string;
  readonly PROOFSTACK_OIDC_BINDING_ID?: string;
  readonly PROOFSTACK_OIDC_CAPABILITIES?: string;
  readonly PROOFSTACK_OIDC_DISABLE_REASON?: string;
  readonly PROOFSTACK_OIDC_ISSUER?: string;
  readonly PROOFSTACK_OIDC_PRINCIPAL_ID?: string;
  readonly PROOFSTACK_OIDC_RESOURCE_SCOPE?: string;
  readonly PROOFSTACK_OIDC_ROLES?: string;
  readonly PROOFSTACK_OIDC_SUBJECT?: string;
}

export interface DatabaseCliIo {
  readonly error: (message: string) => void;
  readonly output: (message: string) => void;
}

interface DatabaseCliDependencies {
  readonly createPool: (connectionString: string, onIdleError: (error: Error) => void) => Pool;
  readonly bootstrap: typeof bootstrapApiKey;
  readonly inspect: typeof inspectMigrations;
  readonly inspectIdentity: typeof inspectIdentityCredentials;
  readonly migrate: typeof migrateDatabase;
  readonly oidcCreate: typeof createOidcBinding;
  readonly oidcDisable: typeof disableOidcBinding;
  readonly oidcUpdate: typeof updateOidcBinding;
  readonly provision: typeof provisionRuntimeRoles;
}

const defaultDependencies: DatabaseCliDependencies = {
  bootstrap: bootstrapApiKey,
  createPool: (connectionString, onIdleError) =>
    createPostgresPool({
      applicationName: "proofstack-migrations",
      connectionString,
      maxConnections: 1,
      onIdleError,
    }),
  inspect: inspectMigrations,
  inspectIdentity: inspectIdentityCredentials,
  migrate: migrateDatabase,
  oidcCreate: createOidcBinding,
  oidcDisable: disableOidcBinding,
  oidcUpdate: updateOidcBinding,
  provision: provisionRuntimeRoles,
};

export class DatabaseCliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatabaseCliUsageError";
  }
}

function requiredEnvironmentValue(
  environment: DatabaseCliEnvironment,
  name: keyof DatabaseCliEnvironment,
): string {
  const value = environment[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new DatabaseCliUsageError(`Set ${name} before running this command`);
  }
  return value;
}

function bootstrapCapabilities(environment: DatabaseCliEnvironment): readonly WorkloadCapability[] {
  const raw = requiredEnvironmentValue(environment, "PROOFSTACK_BOOTSTRAP_KEY_CAPABILITIES");
  const values = raw.split(",").map((value) => value.trim());
  const parsed = WorkloadCapabilitySchema.array().min(1).safeParse(values);
  if (!parsed.success || new Set(parsed.data).size !== parsed.data.length) {
    throw new DatabaseCliUsageError(
      "PROOFSTACK_BOOTSTRAP_KEY_CAPABILITIES must be a unique comma-separated workload capability list",
    );
  }
  return parsed.data;
}

function bootstrapResourceScope(environment: DatabaseCliEnvironment): ResourceScope {
  const raw = requiredEnvironmentValue(environment, "PROOFSTACK_BOOTSTRAP_KEY_RESOURCE_SCOPE");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new DatabaseCliUsageError("PROOFSTACK_BOOTSTRAP_KEY_RESOURCE_SCOPE must be valid JSON");
  }
  const parsed = ResourceScopeSchema.safeParse(value);
  if (!parsed.success) {
    throw new DatabaseCliUsageError(
      "PROOFSTACK_BOOTSTRAP_KEY_RESOURCE_SCOPE must be a valid resource scope",
    );
  }
  return parsed.data;
}

function uniqueList<Value extends string>(
  environment: DatabaseCliEnvironment,
  name: keyof DatabaseCliEnvironment,
  parse: (values: readonly string[]) => readonly Value[] | null,
): readonly Value[] {
  const raw = requiredEnvironmentValue(environment, name);
  const values = raw.split(",").map((value) => value.trim());
  const parsed = parse(values);
  if (!parsed || new Set(parsed).size !== parsed.length) {
    throw new DatabaseCliUsageError(`${name} must be a unique comma-separated value list`);
  }
  return parsed;
}

function oidcCapabilities(environment: DatabaseCliEnvironment): readonly Capability[] {
  const raw = environment.PROOFSTACK_OIDC_CAPABILITIES;
  if (typeof raw !== "string") {
    throw new DatabaseCliUsageError("Set PROOFSTACK_OIDC_CAPABILITIES before running this command");
  }
  const values = raw.length === 0 ? [] : raw.split(",").map((value) => value.trim());
  const parsed = CapabilitySchema.array().max(CapabilitySchema.options.length).safeParse(values);
  if (!parsed.success || new Set(parsed.data).size !== parsed.data.length) {
    throw new DatabaseCliUsageError(
      "PROOFSTACK_OIDC_CAPABILITIES must be a unique comma-separated capability list",
    );
  }
  return parsed.data;
}

function oidcRoles(environment: DatabaseCliEnvironment): readonly Role[] {
  return uniqueList(environment, "PROOFSTACK_OIDC_ROLES", (values) => {
    const parsed = RoleSchema.array().min(1).max(RoleSchema.options.length).safeParse(values);
    return parsed.success ? parsed.data : null;
  });
}

function oidcResourceScope(environment: DatabaseCliEnvironment): ResourceScope {
  const raw = requiredEnvironmentValue(environment, "PROOFSTACK_OIDC_RESOURCE_SCOPE");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new DatabaseCliUsageError("PROOFSTACK_OIDC_RESOURCE_SCOPE must be valid JSON");
  }
  const parsed = ResourceScopeSchema.safeParse(value);
  if (!parsed.success) {
    throw new DatabaseCliUsageError(
      "PROOFSTACK_OIDC_RESOURCE_SCOPE must be a valid resource scope",
    );
  }
  return parsed.data;
}

function identityTenantId(environment: DatabaseCliEnvironment): string {
  return requiredEnvironmentValue(environment, "PROOFSTACK_IDENTITY_TENANT_ID");
}

function bootstrapOptions(environment: DatabaseCliEnvironment): BootstrapApiKeyOptions {
  return {
    actorPrincipalId: requiredEnvironmentValue(
      environment,
      "PROOFSTACK_BOOTSTRAP_ACTOR_PRINCIPAL_ID",
    ),
    capabilities: bootstrapCapabilities(environment),
    ...(environment.PROOFSTACK_BOOTSTRAP_KEY_EXPIRES_AT
      ? { expiresAt: environment.PROOFSTACK_BOOTSTRAP_KEY_EXPIRES_AT }
      : {}),
    name: requiredEnvironmentValue(environment, "PROOFSTACK_BOOTSTRAP_KEY_NAME"),
    resourceScope: bootstrapResourceScope(environment),
    tenantId: identityTenantId(environment),
  };
}

function oidcCreateOptions(environment: DatabaseCliEnvironment): CreateOidcBindingOptions {
  return {
    actorPrincipalId: requiredEnvironmentValue(
      environment,
      "PROOFSTACK_BOOTSTRAP_ACTOR_PRINCIPAL_ID",
    ),
    bindingId: requiredEnvironmentValue(environment, "PROOFSTACK_OIDC_BINDING_ID"),
    capabilities: oidcCapabilities(environment),
    issuer: requiredEnvironmentValue(environment, "PROOFSTACK_OIDC_ISSUER"),
    principalId: requiredEnvironmentValue(environment, "PROOFSTACK_OIDC_PRINCIPAL_ID"),
    resourceScope: oidcResourceScope(environment),
    roles: oidcRoles(environment),
    subject: requiredEnvironmentValue(environment, "PROOFSTACK_OIDC_SUBJECT"),
    tenantId: identityTenantId(environment),
  };
}

function oidcUpdateOptions(environment: DatabaseCliEnvironment): UpdateOidcBindingOptions {
  return {
    actorPrincipalId: requiredEnvironmentValue(
      environment,
      "PROOFSTACK_BOOTSTRAP_ACTOR_PRINCIPAL_ID",
    ),
    bindingId: requiredEnvironmentValue(environment, "PROOFSTACK_OIDC_BINDING_ID"),
    capabilities: oidcCapabilities(environment),
    resourceScope: oidcResourceScope(environment),
    roles: oidcRoles(environment),
    tenantId: identityTenantId(environment),
  };
}

function oidcDisableOptions(environment: DatabaseCliEnvironment): DisableOidcBindingOptions {
  return {
    actorPrincipalId: requiredEnvironmentValue(
      environment,
      "PROOFSTACK_BOOTSTRAP_ACTOR_PRINCIPAL_ID",
    ),
    bindingId: requiredEnvironmentValue(environment, "PROOFSTACK_OIDC_BINDING_ID"),
    reason: requiredEnvironmentValue(environment, "PROOFSTACK_OIDC_DISABLE_REASON"),
    tenantId: identityTenantId(environment),
  };
}

function migrationDatabaseUrl(environment: DatabaseCliEnvironment): string {
  const dedicatedUrl = environment.PROOFSTACK_MIGRATION_DATABASE_URL;
  if (dedicatedUrl) {
    return validatePostgresConnectionString(dedicatedUrl, {
      allowPlaintextLoopback: environment.PROOFSTACK_ENV !== "production",
    });
  }
  if (environment.PROOFSTACK_ENV === "production") {
    throw new DatabaseCliUsageError("PROOFSTACK_MIGRATION_DATABASE_URL is required in production");
  }
  if (environment.PROOFSTACK_DATABASE_URL) {
    return validatePostgresConnectionString(environment.PROOFSTACK_DATABASE_URL, {
      allowPlaintextLoopback: true,
    });
  }
  throw new DatabaseCliUsageError(
    "Set PROOFSTACK_MIGRATION_DATABASE_URL before running database commands",
  );
}

function runtimeRoleOptions(environment: DatabaseCliEnvironment): RuntimeRoleProvisioningOptions {
  const apiPassword = environment.PROOFSTACK_API_DATABASE_PASSWORD;
  const artifactPassword = environment.PROOFSTACK_ARTIFACT_DATABASE_PASSWORD;
  const publisherPassword = environment.PROOFSTACK_PUBLISHER_DATABASE_PASSWORD;
  const consumerPassword = environment.PROOFSTACK_CONSUMER_DATABASE_PASSWORD;
  const identityPassword = environment.PROOFSTACK_IDENTITY_DATABASE_PASSWORD;
  const evaluationWorkerPassword = environment.PROOFSTACK_EVALUATION_WORKER_DATABASE_PASSWORD;
  const replayWorkerPassword = environment.PROOFSTACK_REPLAY_WORKER_DATABASE_PASSWORD;
  if (
    !apiPassword ||
    !artifactPassword ||
    !publisherPassword ||
    !consumerPassword ||
    !evaluationWorkerPassword ||
    !identityPassword ||
    !replayWorkerPassword
  ) {
    throw new DatabaseCliUsageError(
      "Set PROOFSTACK_API_DATABASE_PASSWORD, PROOFSTACK_ARTIFACT_DATABASE_PASSWORD, PROOFSTACK_IDENTITY_DATABASE_PASSWORD, PROOFSTACK_EVALUATION_WORKER_DATABASE_PASSWORD, PROOFSTACK_REPLAY_WORKER_DATABASE_PASSWORD, PROOFSTACK_PUBLISHER_DATABASE_PASSWORD, and PROOFSTACK_CONSUMER_DATABASE_PASSWORD before provisioning runtime roles",
    );
  }
  return {
    api: {
      name: environment.PROOFSTACK_API_DATABASE_ROLE ?? DEFAULT_RUNTIME_ROLE_NAMES.api,
      password: apiPassword,
    },
    artifact: {
      name: environment.PROOFSTACK_ARTIFACT_DATABASE_ROLE ?? DEFAULT_RUNTIME_ROLE_NAMES.artifact,
      password: artifactPassword,
    },
    consumer: {
      name: environment.PROOFSTACK_CONSUMER_DATABASE_ROLE ?? DEFAULT_RUNTIME_ROLE_NAMES.consumer,
      password: consumerPassword,
    },
    evaluationWorker: {
      name:
        environment.PROOFSTACK_EVALUATION_WORKER_DATABASE_ROLE ??
        DEFAULT_RUNTIME_ROLE_NAMES.evaluationWorker,
      password: evaluationWorkerPassword,
    },
    identity: {
      name: environment.PROOFSTACK_IDENTITY_DATABASE_ROLE ?? DEFAULT_RUNTIME_ROLE_NAMES.identity,
      password: identityPassword,
    },
    publisher: {
      name: environment.PROOFSTACK_PUBLISHER_DATABASE_ROLE ?? DEFAULT_RUNTIME_ROLE_NAMES.publisher,
      password: publisherPassword,
    },
    replayWorker: {
      name:
        environment.PROOFSTACK_REPLAY_WORKER_DATABASE_ROLE ??
        DEFAULT_RUNTIME_ROLE_NAMES.replayWorker,
      password: replayWorkerPassword,
    },
  };
}

export async function runDatabaseCli(
  arguments_: readonly string[],
  environment: DatabaseCliEnvironment,
  io: DatabaseCliIo,
  dependencies: DatabaseCliDependencies = defaultDependencies,
): Promise<number> {
  const command = arguments_[0];
  if (
    command !== "identity-bootstrap" &&
    command !== "identity-status" &&
    command !== "migrate" &&
    command !== "oidc-binding-create" &&
    command !== "oidc-binding-disable" &&
    command !== "oidc-binding-update" &&
    command !== "provision" &&
    command !== "status"
  ) {
    throw new DatabaseCliUsageError(
      "Usage: proofstack-db <migrate|provision|status|identity-bootstrap|identity-status|oidc-binding-create|oidc-binding-update|oidc-binding-disable>",
    );
  }

  const provisioningOptions = command === "provision" ? runtimeRoleOptions(environment) : undefined;
  const identityBootstrapOptions =
    command === "identity-bootstrap" ? bootstrapOptions(environment) : undefined;
  const identityStatusTenantId =
    command === "identity-status" ? identityTenantId(environment) : undefined;
  const createBindingOptions =
    command === "oidc-binding-create" ? oidcCreateOptions(environment) : undefined;
  const updateBindingOptions =
    command === "oidc-binding-update" ? oidcUpdateOptions(environment) : undefined;
  const disableBindingOptions =
    command === "oidc-binding-disable" ? oidcDisableOptions(environment) : undefined;
  const connectionString = migrationDatabaseUrl(environment);
  let idleError: Error | undefined;
  const pool = dependencies.createPool(connectionString, (error) => {
    idleError = error;
    io.error(`Idle PostgreSQL connection failed: ${error.message}`);
  });

  try {
    if (command === "migrate") {
      const result = await dependencies.migrate(pool);
      io.output(
        JSON.stringify({
          appliedIds: result.appliedIds,
          newlyAppliedIds: result.newlyAppliedIds,
          status: "current",
        }),
      );
      return idleError ? 1 : 0;
    }

    if (command === "provision" && provisioningOptions) {
      const result = await dependencies.provision(pool, provisioningOptions);
      io.output(
        JSON.stringify({
          createdRoles: result.createdRoles,
          status: "provisioned",
          updatedRoles: result.updatedRoles,
        }),
      );
      return idleError ? 1 : 0;
    }

    if (command === "identity-bootstrap" && identityBootstrapOptions) {
      const result = await dependencies.bootstrap(pool, identityBootstrapOptions);
      io.output(
        JSON.stringify({
          credential: result.credential,
          status: "created",
          value: result.value,
        }),
      );
      return idleError ? 1 : 0;
    }

    if (command === "identity-status" && identityStatusTenantId) {
      const result = await dependencies.inspectIdentity(pool, identityStatusTenantId);
      io.output(JSON.stringify({ ...result, status: "current" }));
      return idleError ? 1 : 0;
    }

    if (command === "oidc-binding-create" && createBindingOptions) {
      const result = await dependencies.oidcCreate(pool, createBindingOptions);
      io.output(JSON.stringify({ ...result, status: "created" }));
      return idleError ? 1 : 0;
    }

    if (command === "oidc-binding-update" && updateBindingOptions) {
      const result = await dependencies.oidcUpdate(pool, updateBindingOptions);
      io.output(JSON.stringify({ ...result, status: "updated" }));
      return idleError ? 1 : 0;
    }

    if (command === "oidc-binding-disable" && disableBindingOptions) {
      const disabled = await dependencies.oidcDisable(pool, disableBindingOptions);
      io.output(
        JSON.stringify({
          bindingId: disableBindingOptions.bindingId,
          status: disabled ? "disabled" : "unchanged",
          tenantId: disableBindingOptions.tenantId,
        }),
      );
      return idleError ? 1 : 0;
    }

    const status = await dependencies.inspect(pool);
    io.output(
      JSON.stringify({
        appliedIds: status.appliedIds,
        ledgerExists: status.ledgerExists,
        pendingIds: status.pendingIds,
        status: status.ledgerExists && status.pendingIds.length === 0 ? "current" : "pending",
      }),
    );
    return idleError || !status.ledgerExists || status.pendingIds.length > 0 ? 1 : 0;
  } finally {
    await pool.end();
  }
}

const entrypoint = process.argv[1];
if (entrypoint && fileURLToPath(import.meta.url) === resolve(entrypoint)) {
  try {
    process.exitCode = await runDatabaseCli(process.argv.slice(2), process.env, {
      error: (message) => console.error(message),
      output: (message) => console.log(message),
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Database command failed");
    process.exitCode = 1;
  }
}
