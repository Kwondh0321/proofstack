import {
  OpaqueIdSchema,
  PolicyEvaluationTimeSchema,
  type EvidenceScope,
  type PolicyInstallationBinding,
} from "@proofstack/contracts";
import {
  StaticEndpointProfileCatalogue,
  StaticEvaluationImplementationRegistrationCatalogue,
  StaticPolicyInstallationBindingResolver,
  StaticProtocolDefinitionCatalogue,
  StaticQualificationPolicyCatalogue,
  StaticRuntimeDefinitionCatalogue,
} from "@proofstack/core";
import {
  PolicyEvaluationSourceRecheckError,
  type PolicyEvaluationSourceRecheckPorts,
} from "@proofstack/policy-evaluation";
import type { PoolClient } from "pg";
import { assertMigrationsCurrentOnClient } from "./migration-runner.js";
import type { Migration } from "./migrations.js";
import { readPostgresArtifactCatalogOnClient } from "./postgres-artifact-catalog-repository.js";
import {
  listPostgresCriterionSetStatusesOnClient,
  readPostgresEvaluationRecordOnClient,
} from "./postgres-evaluation-repository.js";
import {
  createPostgresPolicyMetadataPorts,
  type PolicySourceTransactionCall,
} from "./postgres-policy-metadata-ports.js";
import {
  listPostgresReleasePolicyLifecycleEventsOnClient,
  readPostgresReleasePolicyOnClient,
} from "./postgres-release-policy-repository.js";

export const MAX_POLICY_METADATA_INSTALLATION_BINDINGS = 256;
export interface PostgresPolicyMetadataCatalogues {
  readonly installationBindings?: readonly PolicyInstallationBinding[];
  readonly runtimeDefinitions?: readonly unknown[];
  readonly implementationRegistrations?: readonly unknown[];
  readonly qualificationPolicies?: readonly unknown[];
  readonly endpointProfiles?: readonly unknown[];
  readonly protocolDefinitions?: readonly unknown[];
}
export function copyPostgresPolicyMetadataCatalogues(catalogues: PostgresPolicyMetadataCatalogues) {
  const bindings =
    catalogues.installationBindings === undefined ? [] : catalogues.installationBindings;
  if (!Array.isArray(bindings) || bindings.length > MAX_POLICY_METADATA_INSTALLATION_BINDINGS)
    throw new TypeError("Policy metadata installation catalogue exceeds its entry limit");
  return {
    protocolDefinitions: new StaticProtocolDefinitionCatalogue(
      catalogues.protocolDefinitions === undefined ? [] : catalogues.protocolDefinitions,
    ),
    endpointProfiles: new StaticEndpointProfileCatalogue(
      catalogues.endpointProfiles === undefined ? [] : catalogues.endpointProfiles,
    ),
    installationBinding: new StaticPolicyInstallationBindingResolver(bindings),
    runtimeDefinitions: new StaticRuntimeDefinitionCatalogue(
      catalogues.runtimeDefinitions === undefined ? [] : catalogues.runtimeDefinitions,
    ),
    implementationRegistrations: new StaticEvaluationImplementationRegistrationCatalogue(
      catalogues.implementationRegistrations === undefined
        ? []
        : catalogues.implementationRegistrations,
    ),
    qualificationPolicies: new StaticQualificationPolicyCatalogue(
      catalogues.qualificationPolicies === undefined ? [] : catalogues.qualificationPolicies,
    ),
  };
}

/** Internal same-client construction. The owning transaction supplies lifetime, taint and drain. */
export function createPostgresPolicySourcePorts(
  client: PoolClient,
  exact: EvidenceScope,
  call: PolicySourceTransactionCall,
  catalogues: ReturnType<typeof copyPostgresPolicyMetadataCatalogues>,
  migrations: readonly Migration[],
) {
  const id = (value: string) => OpaqueIdSchema.parse(value);
  let metadataGuarded = false;
  const requireMetadataGuard = () => {
    if (!metadataGuarded)
      throw new PolicyEvaluationSourceRecheckError("guard_unavailable", "metadata");
  };
  const sources: PolicyEvaluationSourceRecheckPorts = {
    tryMetadataGuard: () =>
      call(async () => {
        const result = await client.query<{ acquired: unknown }>(
          "SELECT public.proofstack_try_lock_policy_evaluation_metadata() AS acquired",
        );
        const acquired = result.rows.length === 1 ? result.rows[0]?.acquired : undefined;
        if (acquired !== true)
          throw new PolicyEvaluationSourceRecheckError(
            acquired === false ? "guard_unavailable" : "guard_invalid",
            "metadata",
          );
        await assertMigrationsCurrentOnClient(client, migrations);
        metadataGuarded = true;
        return true;
      }),
    findCriterion: (value) =>
      call(async () => {
        requireMetadataGuard();
        return readPostgresEvaluationRecordOnClient(client, exact, "criterion_set", id(value));
      }),
    listCriterionSetStatuses: (limits) =>
      call(async () => {
        requireMetadataGuard();
        return listPostgresCriterionSetStatusesOnClient(client, exact, limits);
      }),
    tryGuard: (kind, value) =>
      call(async () => {
        if (kind !== "artifact" && kind !== "release_policy")
          throw new TypeError("Unsupported policy source guard kind");
        const resourceId = id(value);
        const result = await client.query<{ acquired: unknown }>(
          "SELECT public.proofstack_try_lock_policy_evaluation_source($1, $2) AS acquired",
          [kind, resourceId],
        );
        const acquired = result.rows.length === 1 ? result.rows[0]?.acquired : undefined;
        if (acquired !== true)
          throw new PolicyEvaluationSourceRecheckError(
            acquired === false ? "guard_unavailable" : "guard_invalid",
            JSON.stringify([kind, resourceId]),
          );
        return true;
      }),
    findArtifact: (value) =>
      call(async () => readPostgresArtifactCatalogOnClient(client, exact, id(value))),
    findPolicy: (value) =>
      call(async () => readPostgresReleasePolicyOnClient(client, exact, id(value))),
    listPolicyHistory: (value) =>
      call(async () => listPostgresReleasePolicyLifecycleEventsOnClient(client, exact, id(value))),
    observationTime: () =>
      call(async () => {
        const result = await client.query<{
          observed_at: unknown;
        }>(`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS observed_at`);
        return PolicyEvaluationTimeSchema.parse(
          result.rows.length === 1 ? result.rows[0]?.observed_at : undefined,
        );
      }),
  };
  return {
    sources,
    createMetadata: () => {
      requireMetadataGuard();
      return createPostgresPolicyMetadataPorts(client, exact, call, catalogues);
    },
  };
}
