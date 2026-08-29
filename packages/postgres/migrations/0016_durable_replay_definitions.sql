CREATE FUNCTION public.proofstack_replay_publication_intent_status(
  expected_tenant_id text,
  expected_event_type text,
  expected_aggregate_type text,
  expected_aggregate_id text,
  expected_schema_version text,
  expected_payload jsonb,
  expected_created_at timestamptz
)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT CASE
    WHEN expected_tenant_id IS DISTINCT FROM
      NULLIF(current_setting('proofstack.tenant_id', true), '')
      THEN 'absent'
    WHEN expected_tenant_id IS NULL
      OR expected_tenant_id !~ '^[a-z][a-z0-9_]{2,63}$'
      OR expected_schema_version IS DISTINCT FROM '0.1'
      OR expected_created_at IS NULL
      OR NOT isfinite(expected_created_at)
      THEN 'absent'
    WHEN (
      (
        expected_event_type = 'replay.target-release.published'
        AND expected_aggregate_type = 'replay.target-release'
        AND jsonb_typeof(expected_payload) = 'object'
        AND expected_payload ?& ARRAY[
          'definitionSha256',
          'environmentId',
          'projectId',
          'targetId',
          'targetReleaseId'
        ]::text[]
        AND expected_payload - ARRAY[
          'definitionSha256',
          'environmentId',
          'projectId',
          'targetId',
          'targetReleaseId'
        ]::text[] = '{}'::jsonb
        AND expected_payload ->> 'definitionSha256' ~ '^[0-9a-f]{64}$'
        AND expected_payload ->> 'environmentId' ~ '^[a-z][a-z0-9_]{2,63}$'
        AND expected_payload ->> 'projectId' ~ '^[a-z][a-z0-9_]{2,63}$'
        AND expected_payload ->> 'targetId' ~ '^[a-z][a-z0-9_]{2,63}$'
        AND expected_payload ->> 'targetReleaseId' ~ '^[a-z][a-z0-9_]{2,63}$'
        AND expected_aggregate_id = expected_payload ->> 'targetReleaseId'
      )
      OR (
        expected_event_type = 'replay.plan.published'
        AND expected_aggregate_type = 'replay.plan'
        AND jsonb_typeof(expected_payload) = 'object'
        AND expected_payload ?& ARRAY[
          'definitionSha256',
          'environmentId',
          'planId',
          'planVersionId',
          'projectId',
          'targetReleaseId'
        ]::text[]
        AND expected_payload - ARRAY[
          'definitionSha256',
          'environmentId',
          'planId',
          'planVersionId',
          'projectId',
          'targetReleaseId'
        ]::text[] = '{}'::jsonb
        AND expected_payload ->> 'definitionSha256' ~ '^[0-9a-f]{64}$'
        AND expected_payload ->> 'environmentId' ~ '^[a-z][a-z0-9_]{2,63}$'
        AND expected_payload ->> 'planId' ~ '^[a-z][a-z0-9_]{2,63}$'
        AND expected_payload ->> 'planVersionId' ~ '^[a-z][a-z0-9_]{2,63}$'
        AND expected_payload ->> 'projectId' ~ '^[a-z][a-z0-9_]{2,63}$'
        AND expected_payload ->> 'targetReleaseId' ~ '^[a-z][a-z0-9_]{2,63}$'
        AND expected_aggregate_id = expected_payload ->> 'planVersionId'
      )
    ) IS NOT TRUE
      THEN 'absent'
    WHEN NOT EXISTS (
      SELECT 1
      FROM public.proofstack_outbox
      WHERE tenant_id = expected_tenant_id
        AND event_type = expected_event_type
        AND aggregate_type = expected_aggregate_type
        AND aggregate_id = expected_aggregate_id
    )
      THEN 'absent'
    WHEN EXISTS (
      SELECT 1
      FROM public.proofstack_outbox
      WHERE tenant_id = expected_tenant_id
        AND event_type = expected_event_type
        AND aggregate_type = expected_aggregate_type
        AND aggregate_id = expected_aggregate_id
        AND schema_version = expected_schema_version
        AND payload = expected_payload
        AND created_at = expected_created_at
    )
      THEN 'canonical'
    ELSE 'conflict'
  END;
$$;

REVOKE ALL ON FUNCTION public.proofstack_replay_publication_intent_status(
  text,
  text,
  text,
  text,
  text,
  jsonb,
  timestamptz
) FROM PUBLIC;

CREATE TABLE public.proofstack_replay_targets (
  tenant_id varchar(64) NOT NULL,
  project_id varchar(64) NOT NULL,
  environment_id varchar(64) NOT NULL,
  target_id varchar(64) NOT NULL,

  CONSTRAINT proofstack_replay_targets_pk PRIMARY KEY (tenant_id, target_id),
  CONSTRAINT proofstack_replay_targets_scope_unique UNIQUE (
    tenant_id,
    project_id,
    environment_id,
    target_id
  ),
  CONSTRAINT proofstack_replay_targets_tenant_format CHECK (
    tenant_id ~ '^[a-z][a-z0-9_]{2,63}$'
  ),
  CONSTRAINT proofstack_replay_targets_project_format CHECK (
    project_id ~ '^[a-z][a-z0-9_]{2,63}$'
  ),
  CONSTRAINT proofstack_replay_targets_environment_format CHECK (
    environment_id ~ '^[a-z][a-z0-9_]{2,63}$'
  ),
  CONSTRAINT proofstack_replay_targets_id_format CHECK (
    target_id ~ '^[a-z][a-z0-9_]{2,63}$'
  )
);

CREATE TABLE public.proofstack_target_releases (
  tenant_id varchar(64) NOT NULL,
  project_id varchar(64) NOT NULL,
  environment_id varchar(64) NOT NULL,
  target_id varchar(64) NOT NULL,
  target_release_id varchar(64) NOT NULL,
  schema_version varchar(16) NOT NULL,
  definition_sha256 character(64) NOT NULL,
  target_adapter_name varchar(256) NOT NULL,
  target_adapter_version varchar(64) NOT NULL,
  target_adapter_protocol_version varchar(64) NOT NULL,
  worker_protocol_name varchar(256) NOT NULL,
  worker_protocol_version varchar(64) NOT NULL,
  execution_kind varchar(16) NOT NULL,
  provenance_artifact_id varchar(64) NOT NULL,
  execution_artifact_id varchar(64),
  emitted_artifact_bytes bigint NOT NULL,
  stderr_bytes bigint NOT NULL,
  stdout_bytes bigint NOT NULL,
  created_at timestamptz NOT NULL,
  created_at_lexical text NOT NULL,
  created_by_principal_id varchar(64) NOT NULL,
  release jsonb NOT NULL,

  CONSTRAINT proofstack_target_releases_pk PRIMARY KEY (tenant_id, target_release_id),
  CONSTRAINT proofstack_target_releases_scope_unique UNIQUE (
    tenant_id,
    project_id,
    environment_id,
    target_id,
    target_release_id
  ),
  CONSTRAINT proofstack_target_releases_digest_unique UNIQUE (
    tenant_id,
    project_id,
    environment_id,
    target_id,
    target_release_id,
    definition_sha256
  ),
  CONSTRAINT proofstack_target_releases_reference_unique UNIQUE (
    tenant_id,
    project_id,
    environment_id,
    target_id,
    target_release_id,
    definition_sha256,
    target_adapter_name,
    target_adapter_version,
    target_adapter_protocol_version,
    worker_protocol_name,
    worker_protocol_version
  ),
  CONSTRAINT proofstack_target_releases_target_fk FOREIGN KEY (
    tenant_id,
    project_id,
    environment_id,
    target_id
  ) REFERENCES public.proofstack_replay_targets (
    tenant_id,
    project_id,
    environment_id,
    target_id
  ),
  CONSTRAINT proofstack_target_releases_provenance_fk FOREIGN KEY (
    tenant_id,
    project_id,
    environment_id,
    provenance_artifact_id
  ) REFERENCES public.proofstack_artifact_catalog (
    tenant_id,
    project_id,
    environment_id,
    artifact_id
  ),
  CONSTRAINT proofstack_target_releases_execution_artifact_fk FOREIGN KEY (
    tenant_id,
    project_id,
    environment_id,
    execution_artifact_id
  ) REFERENCES public.proofstack_artifact_catalog (
    tenant_id,
    project_id,
    environment_id,
    artifact_id
  ),
  CONSTRAINT proofstack_target_releases_schema CHECK (schema_version = '0.1'),
  CONSTRAINT proofstack_target_releases_id_format CHECK (
    target_release_id ~ '^[a-z][a-z0-9_]{2,63}$'
  ),
  CONSTRAINT proofstack_target_releases_digest CHECK (
    definition_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT proofstack_target_releases_protocols CHECK (
    target_adapter_name ~ '^[A-Za-z0-9][A-Za-z0-9._+:/@-]{0,255}$'
    AND target_adapter_version ~ '^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$'
    AND target_adapter_protocol_version ~ '^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$'
    AND worker_protocol_name ~ '^[A-Za-z0-9][A-Za-z0-9._+:/@-]{0,255}$'
    AND worker_protocol_version ~ '^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$'
  ),
  CONSTRAINT proofstack_target_releases_execution_shape CHECK (
    (execution_kind = 'artifact' AND execution_artifact_id IS NOT NULL)
    OR (execution_kind = 'preinstalled' AND execution_artifact_id IS NULL)
  ),
  CONSTRAINT proofstack_target_releases_output_limits CHECK (
    emitted_artifact_bytes BETWEEN 1 AND 9007199254740991
    AND stderr_bytes BETWEEN 1 AND 9007199254740991
    AND stdout_bytes BETWEEN 1 AND 9007199254740991
  ),
  CONSTRAINT proofstack_target_releases_time CHECK (
    isfinite(created_at)
    AND created_at_lexical ~
      '^[0-9]{4}-(0[1-9]|1[0-2])-([0-2][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\.[0-9]{3}Z$'
    AND created_at_lexical !~ '^0000-'
    AND created_at = created_at_lexical::timestamptz
  ),
  CONSTRAINT proofstack_target_releases_creator_format CHECK (
    created_by_principal_id ~ '^[a-z][a-z0-9_]{2,63}$'
  ),
  CONSTRAINT proofstack_target_releases_payload CHECK (
    (
      jsonb_typeof(release) = 'object'
      AND release ->> 'schemaVersion' = schema_version
      AND release ->> 'targetId' = target_id
      AND release ->> 'targetReleaseId' = target_release_id
      AND release ->> 'definitionSha256' = definition_sha256
      AND release ->> 'createdAt' = created_at_lexical
      AND release ->> 'createdByPrincipalId' = created_by_principal_id
      AND release #>> '{scope,tenantId}' = tenant_id
      AND release #>> '{scope,projectId}' = project_id
      AND release #>> '{scope,environmentId}' = environment_id
      AND release #>> '{targetAdapter,name}' = target_adapter_name
      AND release #>> '{targetAdapter,version}' = target_adapter_version
      AND release #>> '{targetAdapter,protocolVersion}' = target_adapter_protocol_version
      AND release #>> '{workerProtocol,name}' = worker_protocol_name
      AND release #>> '{workerProtocol,version}' = worker_protocol_version
      AND release #>> '{execution,kind}' = execution_kind
      AND release #>> '{build,provenance,artifactId}' = provenance_artifact_id
      AND (release #>> '{execution,artifact,artifactId}') IS NOT DISTINCT FROM execution_artifact_id
      AND (release #>> '{outputLimits,emittedArtifactBytes}')::bigint = emitted_artifact_bytes
      AND (release #>> '{outputLimits,stderrBytes}')::bigint = stderr_bytes
      AND (release #>> '{outputLimits,stdoutBytes}')::bigint = stdout_bytes
      AND pg_column_size(release) <= 1048576
    ) IS TRUE
  )
);

CREATE TABLE public.proofstack_replay_plan_resources (
  tenant_id varchar(64) NOT NULL,
  project_id varchar(64) NOT NULL,
  environment_id varchar(64) NOT NULL,
  plan_id varchar(64) NOT NULL,

  CONSTRAINT proofstack_replay_plan_resources_pk PRIMARY KEY (tenant_id, plan_id),
  CONSTRAINT proofstack_replay_plan_resources_scope_unique UNIQUE (
    tenant_id,
    project_id,
    environment_id,
    plan_id
  ),
  CONSTRAINT proofstack_replay_plan_resources_tenant_format CHECK (
    tenant_id ~ '^[a-z][a-z0-9_]{2,63}$'
  ),
  CONSTRAINT proofstack_replay_plan_resources_project_format CHECK (
    project_id ~ '^[a-z][a-z0-9_]{2,63}$'
  ),
  CONSTRAINT proofstack_replay_plan_resources_environment_format CHECK (
    environment_id ~ '^[a-z][a-z0-9_]{2,63}$'
  ),
  CONSTRAINT proofstack_replay_plan_resources_id_format CHECK (
    plan_id ~ '^[a-z][a-z0-9_]{2,63}$'
  )
);

CREATE TABLE public.proofstack_replay_plans (
  tenant_id varchar(64) NOT NULL,
  project_id varchar(64) NOT NULL,
  environment_id varchar(64) NOT NULL,
  plan_id varchar(64) NOT NULL,
  plan_version_id varchar(64) NOT NULL,
  schema_version varchar(16) NOT NULL,
  definition_sha256 character(64) NOT NULL,
  target_id varchar(64) NOT NULL,
  target_release_id varchar(64) NOT NULL,
  target_definition_sha256 character(64) NOT NULL,
  target_adapter_name varchar(256) NOT NULL,
  target_adapter_version varchar(64) NOT NULL,
  target_adapter_protocol_version varchar(64) NOT NULL,
  worker_protocol_name varchar(256) NOT NULL,
  worker_protocol_version varchar(64) NOT NULL,
  dataset_id varchar(64) NOT NULL,
  dataset_version_id varchar(64) NOT NULL,
  dataset_definition_sha256 character(64) NOT NULL,
  runtime_profile_id varchar(64) NOT NULL,
  runtime_profile_version varchar(64) NOT NULL,
  runtime_profile_definition_sha256 character(64) NOT NULL,
  isolation_profile_id varchar(64) NOT NULL,
  isolation_profile_version varchar(64) NOT NULL,
  isolation_profile_definition_sha256 character(64) NOT NULL,
  boundary_count smallint NOT NULL,
  retry_automatic boolean NOT NULL,
  retry_max_attempts smallint NOT NULL,
  retry_per_attempt_timeout_milliseconds bigint NOT NULL,
  retry_total_deadline_milliseconds bigint NOT NULL,
  created_at timestamptz NOT NULL,
  created_at_lexical text NOT NULL,
  created_by_principal_id varchar(64) NOT NULL,
  plan jsonb NOT NULL,

  CONSTRAINT proofstack_replay_plans_pk PRIMARY KEY (tenant_id, plan_version_id),
  CONSTRAINT proofstack_replay_plans_scope_unique UNIQUE (
    tenant_id,
    project_id,
    environment_id,
    plan_id,
    plan_version_id
  ),
  CONSTRAINT proofstack_replay_plans_digest_unique UNIQUE (
    tenant_id,
    project_id,
    environment_id,
    plan_id,
    plan_version_id,
    definition_sha256
  ),
  CONSTRAINT proofstack_replay_plans_resource_fk FOREIGN KEY (
    tenant_id,
    project_id,
    environment_id,
    plan_id
  ) REFERENCES public.proofstack_replay_plan_resources (
    tenant_id,
    project_id,
    environment_id,
    plan_id
  ),
  CONSTRAINT proofstack_replay_plans_target_fk FOREIGN KEY (
    tenant_id,
    project_id,
    environment_id,
    target_id,
    target_release_id,
    target_definition_sha256,
    target_adapter_name,
    target_adapter_version,
    target_adapter_protocol_version,
    worker_protocol_name,
    worker_protocol_version
  ) REFERENCES public.proofstack_target_releases (
    tenant_id,
    project_id,
    environment_id,
    target_id,
    target_release_id,
    definition_sha256,
    target_adapter_name,
    target_adapter_version,
    target_adapter_protocol_version,
    worker_protocol_name,
    worker_protocol_version
  ),
  CONSTRAINT proofstack_replay_plans_dataset_fk FOREIGN KEY (
    tenant_id,
    project_id,
    environment_id,
    dataset_id,
    dataset_version_id,
    dataset_definition_sha256
  ) REFERENCES public.proofstack_regression_dataset_versions (
    tenant_id,
    project_id,
    environment_id,
    dataset_id,
    dataset_version_id,
    definition_sha256
  ),
  CONSTRAINT proofstack_replay_plans_schema CHECK (schema_version = '0.1'),
  CONSTRAINT proofstack_replay_plans_id_format CHECK (
    plan_version_id ~ '^[a-z][a-z0-9_]{2,63}$'
    AND runtime_profile_id ~ '^[a-z][a-z0-9_]{2,63}$'
    AND isolation_profile_id ~ '^[a-z][a-z0-9_]{2,63}$'
    AND runtime_profile_version ~ '^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$'
    AND isolation_profile_version ~ '^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$'
  ),
  CONSTRAINT proofstack_replay_plans_digest CHECK (
    definition_sha256 ~ '^[0-9a-f]{64}$'
    AND target_definition_sha256 ~ '^[0-9a-f]{64}$'
    AND dataset_definition_sha256 ~ '^[0-9a-f]{64}$'
    AND runtime_profile_definition_sha256 ~ '^[0-9a-f]{64}$'
    AND isolation_profile_definition_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT proofstack_replay_plans_counts CHECK (
    boundary_count BETWEEN 1 AND 64
    AND retry_max_attempts BETWEEN 1 AND 32
    AND retry_per_attempt_timeout_milliseconds BETWEEN 1 AND 9007199254740991
    AND retry_total_deadline_milliseconds BETWEEN 1 AND 9007199254740991
    AND retry_per_attempt_timeout_milliseconds <= retry_total_deadline_milliseconds
  ),
  CONSTRAINT proofstack_replay_plans_time CHECK (
    isfinite(created_at)
    AND created_at_lexical ~
      '^[0-9]{4}-(0[1-9]|1[0-2])-([0-2][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\.[0-9]{3}Z$'
    AND created_at_lexical !~ '^0000-'
    AND created_at = created_at_lexical::timestamptz
  ),
  CONSTRAINT proofstack_replay_plans_creator_format CHECK (
    created_by_principal_id ~ '^[a-z][a-z0-9_]{2,63}$'
  ),
  CONSTRAINT proofstack_replay_plans_payload CHECK (
    (
      jsonb_typeof(plan) = 'object'
      AND plan ->> 'schemaVersion' = schema_version
      AND plan ->> 'planId' = plan_id
      AND plan ->> 'planVersionId' = plan_version_id
      AND plan ->> 'definitionSha256' = definition_sha256
      AND plan ->> 'createdAt' = created_at_lexical
      AND plan ->> 'createdByPrincipalId' = created_by_principal_id
      AND plan #>> '{scope,tenantId}' = tenant_id
      AND plan #>> '{scope,projectId}' = project_id
      AND plan #>> '{scope,environmentId}' = environment_id
      AND plan #>> '{targetRelease,targetId}' = target_id
      AND plan #>> '{targetRelease,targetReleaseId}' = target_release_id
      AND plan #>> '{targetRelease,definitionSha256}' = target_definition_sha256
      AND plan #>> '{targetRelease,targetAdapter,name}' = target_adapter_name
      AND plan #>> '{targetRelease,targetAdapter,version}' = target_adapter_version
      AND plan #>> '{targetRelease,targetAdapter,protocolVersion}' =
        target_adapter_protocol_version
      AND plan #>> '{workerProtocol,name}' = worker_protocol_name
      AND plan #>> '{workerProtocol,version}' = worker_protocol_version
      AND plan #>> '{dataset,datasetId}' = dataset_id
      AND plan #>> '{dataset,datasetVersionId}' = dataset_version_id
      AND plan #>> '{dataset,definitionSha256}' = dataset_definition_sha256
      AND plan #>> '{runtimeProfile,id}' = runtime_profile_id
      AND plan #>> '{runtimeProfile,version}' = runtime_profile_version
      AND plan #>> '{runtimeProfile,definitionSha256}' = runtime_profile_definition_sha256
      AND plan #>> '{isolationProfile,id}' = isolation_profile_id
      AND plan #>> '{isolationProfile,version}' = isolation_profile_version
      AND plan #>> '{isolationProfile,definitionSha256}' = isolation_profile_definition_sha256
      AND jsonb_array_length(plan -> 'boundaries') = boundary_count
      AND (plan #>> '{retryPolicy,automatic}')::boolean = retry_automatic
      AND (plan #>> '{retryPolicy,maxAttempts}')::smallint = retry_max_attempts
      AND (plan #>> '{retryPolicy,perAttemptTimeoutMilliseconds}')::bigint =
        retry_per_attempt_timeout_milliseconds
      AND (plan #>> '{retryPolicy,totalDeadlineMilliseconds}')::bigint =
        retry_total_deadline_milliseconds
      AND pg_column_size(plan) <= 2097152
    ) IS TRUE
  )
);

CREATE TABLE public.proofstack_replay_plan_budgets (
  tenant_id varchar(64) NOT NULL,
  project_id varchar(64) NOT NULL,
  environment_id varchar(64) NOT NULL,
  plan_id varchar(64) NOT NULL,
  plan_version_id varchar(64) NOT NULL,
  dimension varchar(64) NOT NULL,
  limit_value bigint NOT NULL,
  measurement varchar(32) NOT NULL,

  CONSTRAINT proofstack_replay_plan_budgets_pk PRIMARY KEY (
    tenant_id,
    plan_version_id,
    dimension
  ),
  CONSTRAINT proofstack_replay_plan_budgets_plan_fk FOREIGN KEY (
    tenant_id,
    project_id,
    environment_id,
    plan_id,
    plan_version_id
  ) REFERENCES public.proofstack_replay_plans (
    tenant_id,
    project_id,
    environment_id,
    plan_id,
    plan_version_id
  ),
  CONSTRAINT proofstack_replay_plan_budgets_dimension CHECK (
    dimension IN (
      'concurrentInteractions',
      'elapsedMilliseconds',
      'emittedArtifactBytes',
      'inputTokens',
      'jobAttempts',
      'modelRequests',
      'outputTokens',
      'providerCostMicrounits',
      'retrievedBytes',
      'toolCalls'
    )
  ),
  CONSTRAINT proofstack_replay_plan_budgets_limit CHECK (
    limit_value BETWEEN 1 AND 9007199254740991
  ),
  CONSTRAINT proofstack_replay_plan_budgets_measurement CHECK (
    measurement IN ('estimated', 'measured', 'provider_reported', 'unavailable')
  )
);

CREATE TABLE public.proofstack_replay_plan_boundaries (
  tenant_id varchar(64) NOT NULL,
  project_id varchar(64) NOT NULL,
  environment_id varchar(64) NOT NULL,
  plan_id varchar(64) NOT NULL,
  plan_version_id varchar(64) NOT NULL,
  boundary_position smallint NOT NULL,
  boundary_id varchar(64) NOT NULL,
  boundary_kind varchar(16) NOT NULL,
  boundary_mode varchar(24) NOT NULL,
  recorded_fixture_id varchar(64),
  recorded_fixture_version_id varchar(64),
  recorded_fixture_definition_sha256 character(64),
  recorded_invocation_definition_sha256 character(64),
  simulator_target_id varchar(64),
  simulator_target_release_id varchar(64),
  simulator_definition_sha256 character(64),
  simulator_target_adapter_name varchar(256),
  simulator_target_adapter_version varchar(64),
  simulator_target_adapter_protocol_version varchar(64),
  simulator_worker_protocol_name varchar(256),
  simulator_worker_protocol_version varchar(64),
  qualification_artifact_id varchar(64),
  credential_id varchar(64),
  credential_version_id varchar(64),
  endpoint_profile_id varchar(64),
  endpoint_profile_version varchar(64),
  endpoint_profile_definition_sha256 character(64),
  destination_hostname varchar(253),
  destination_port integer,
  destination_scheme varchar(8),
  operation varchar(256),
  request_bytes bigint,
  response_bytes bigint,
  side_effect_kind varchar(32),
  risk_acceptance_artifact_id varchar(64),
  declaration jsonb NOT NULL,

  CONSTRAINT proofstack_replay_plan_boundaries_pk PRIMARY KEY (
    tenant_id,
    plan_version_id,
    boundary_position
  ),
  CONSTRAINT proofstack_replay_plan_boundaries_id_unique UNIQUE (
    tenant_id,
    plan_version_id,
    boundary_id
  ),
  CONSTRAINT proofstack_replay_plan_boundaries_plan_fk FOREIGN KEY (
    tenant_id,
    project_id,
    environment_id,
    plan_id,
    plan_version_id
  ) REFERENCES public.proofstack_replay_plans (
    tenant_id,
    project_id,
    environment_id,
    plan_id,
    plan_version_id
  ),
  CONSTRAINT proofstack_replay_plan_boundaries_recorded_fixture_fk FOREIGN KEY (
    tenant_id,
    project_id,
    environment_id,
    recorded_fixture_id,
    recorded_fixture_version_id,
    recorded_fixture_definition_sha256
  ) REFERENCES public.proofstack_regression_fixture_versions (
    tenant_id,
    project_id,
    environment_id,
    fixture_id,
    fixture_version_id,
    definition_sha256
  ),
  CONSTRAINT proofstack_replay_plan_boundaries_simulator_fk FOREIGN KEY (
    tenant_id,
    project_id,
    environment_id,
    simulator_target_id,
    simulator_target_release_id,
    simulator_definition_sha256,
    simulator_target_adapter_name,
    simulator_target_adapter_version,
    simulator_target_adapter_protocol_version,
    simulator_worker_protocol_name,
    simulator_worker_protocol_version
  ) REFERENCES public.proofstack_target_releases (
    tenant_id,
    project_id,
    environment_id,
    target_id,
    target_release_id,
    definition_sha256,
    target_adapter_name,
    target_adapter_version,
    target_adapter_protocol_version,
    worker_protocol_name,
    worker_protocol_version
  ),
  CONSTRAINT proofstack_replay_plan_boundaries_qualification_fk FOREIGN KEY (
    tenant_id,
    project_id,
    environment_id,
    qualification_artifact_id
  ) REFERENCES public.proofstack_artifact_catalog (
    tenant_id,
    project_id,
    environment_id,
    artifact_id
  ),
  CONSTRAINT proofstack_replay_plan_boundaries_risk_fk FOREIGN KEY (
    tenant_id,
    project_id,
    environment_id,
    risk_acceptance_artifact_id
  ) REFERENCES public.proofstack_artifact_catalog (
    tenant_id,
    project_id,
    environment_id,
    artifact_id
  ),
  CONSTRAINT proofstack_replay_plan_boundaries_position CHECK (
    boundary_position BETWEEN 0 AND 63
  ),
  CONSTRAINT proofstack_replay_plan_boundaries_id_format CHECK (
    boundary_id ~ '^[a-z][a-z0-9_]{2,63}$'
    AND (credential_id IS NULL OR credential_id ~ '^[a-z][a-z0-9_]{2,63}$')
    AND (
      credential_version_id IS NULL
      OR credential_version_id ~ '^[a-z][a-z0-9_]{2,63}$'
    )
    AND (
      endpoint_profile_id IS NULL
      OR endpoint_profile_id ~ '^[a-z][a-z0-9_]{2,63}$'
    )
  ),
  CONSTRAINT proofstack_replay_plan_boundaries_live_format CHECK (
    endpoint_profile_version IS NULL
    OR endpoint_profile_version ~ '^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$'
  ),
  CONSTRAINT proofstack_replay_plan_boundaries_kind CHECK (
    boundary_kind IN ('data', 'model', 'retrieval', 'tool')
  ),
  CONSTRAINT proofstack_replay_plan_boundaries_mode CHECK (
    boundary_mode IN ('live_provider', 'recorded_stub', 'simulation')
  ),
  CONSTRAINT proofstack_replay_plan_boundaries_mode_shape CHECK (
    (
      boundary_mode = 'recorded_stub'
      AND recorded_fixture_id IS NOT NULL
      AND recorded_fixture_version_id IS NOT NULL
      AND recorded_fixture_definition_sha256 IS NOT NULL
      AND recorded_invocation_definition_sha256 IS NOT NULL
      AND simulator_target_release_id IS NULL
      AND qualification_artifact_id IS NULL
      AND credential_version_id IS NULL
      AND risk_acceptance_artifact_id IS NULL
    ) OR (
      boundary_mode = 'simulation'
      AND recorded_fixture_version_id IS NULL
      AND simulator_target_id IS NOT NULL
      AND simulator_target_release_id IS NOT NULL
      AND simulator_definition_sha256 IS NOT NULL
      AND qualification_artifact_id IS NOT NULL
      AND credential_version_id IS NULL
      AND risk_acceptance_artifact_id IS NULL
    ) OR (
      boundary_mode = 'live_provider'
      AND recorded_fixture_version_id IS NULL
      AND simulator_target_release_id IS NULL
      AND qualification_artifact_id IS NULL
      AND credential_id IS NOT NULL
      AND credential_version_id IS NOT NULL
      AND endpoint_profile_id IS NOT NULL
      AND endpoint_profile_definition_sha256 IS NOT NULL
      AND destination_hostname IS NOT NULL
      AND destination_port = 443
      AND destination_scheme = 'https'
      AND operation IS NOT NULL
      AND request_bytes BETWEEN 1 AND 9007199254740991
      AND response_bytes BETWEEN 1 AND 9007199254740991
      AND side_effect_kind IN ('read_only', 'idempotent_write', 'non_idempotent_write')
      AND (risk_acceptance_artifact_id IS NOT NULL) =
        (side_effect_kind = 'non_idempotent_write')
    )
  ),
  CONSTRAINT proofstack_replay_plan_boundaries_payload CHECK (
    (
      jsonb_typeof(declaration) = 'object'
      AND declaration ->> 'boundaryId' = boundary_id
      AND declaration ->> 'kind' = boundary_kind
      AND declaration ->> 'mode' = boundary_mode
      AND (declaration #>> '{invocation,fixture,fixtureId}') IS NOT DISTINCT FROM
        recorded_fixture_id
      AND (declaration #>> '{invocation,fixture,fixtureVersionId}') IS NOT DISTINCT FROM
        recorded_fixture_version_id
      AND (declaration #>> '{invocation,fixture,definitionSha256}') IS NOT DISTINCT FROM
        recorded_fixture_definition_sha256
      AND (declaration ->> 'invocationDefinitionSha256') IS NOT DISTINCT FROM
        recorded_invocation_definition_sha256
      AND (declaration #>> '{simulatorRelease,targetId}') IS NOT DISTINCT FROM
        simulator_target_id
      AND (declaration #>> '{simulatorRelease,targetReleaseId}') IS NOT DISTINCT FROM
        simulator_target_release_id
      AND (declaration #>> '{simulatorRelease,definitionSha256}') IS NOT DISTINCT FROM
        simulator_definition_sha256
      AND (declaration #>> '{qualification,artifactId}') IS NOT DISTINCT FROM
        qualification_artifact_id
      AND (declaration #>> '{credential,credentialId}') IS NOT DISTINCT FROM credential_id
      AND (declaration #>> '{credential,credentialVersionId}') IS NOT DISTINCT FROM
        credential_version_id
      AND (declaration #>> '{endpointProfile,endpointProfileId}') IS NOT DISTINCT FROM
        endpoint_profile_id
      AND (declaration #>> '{endpointProfile,endpointProfileVersion}') IS NOT DISTINCT FROM
        endpoint_profile_version
      AND (declaration #>> '{endpointProfile,definitionSha256}') IS NOT DISTINCT FROM
        endpoint_profile_definition_sha256
      AND (declaration #>> '{destination,hostname}') IS NOT DISTINCT FROM destination_hostname
      AND (declaration #>> '{destination,port}')::integer IS NOT DISTINCT FROM destination_port
      AND (declaration #>> '{destination,scheme}') IS NOT DISTINCT FROM destination_scheme
      AND (declaration ->> 'operation') IS NOT DISTINCT FROM operation
      AND (declaration #>> '{requestLimits,requestBytes}')::bigint IS NOT DISTINCT FROM
        request_bytes
      AND (declaration #>> '{requestLimits,responseBytes}')::bigint IS NOT DISTINCT FROM
        response_bytes
      AND (declaration #>> '{sideEffect,kind}') IS NOT DISTINCT FROM side_effect_kind
      AND (declaration #>> '{sideEffect,riskAcceptance,artifactId}') IS NOT DISTINCT FROM
        risk_acceptance_artifact_id
      AND pg_column_size(declaration) <= 1048576
    ) IS TRUE
  )
);

CREATE FUNCTION public.proofstack_guard_target_release_artifacts()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  artifact public.proofstack_artifact_catalog%ROWTYPE;
  reference jsonb;
BEGIN
  reference := NEW.release #> '{build,provenance}';
  SELECT * INTO artifact
  FROM public.proofstack_artifact_catalog AS candidate
  WHERE candidate.tenant_id = NEW.tenant_id
    AND candidate.project_id = NEW.project_id
    AND candidate.environment_id = NEW.environment_id
    AND candidate.artifact_id = NEW.provenance_artifact_id
  FOR KEY SHARE;

  IF NOT FOUND
    OR artifact.state <> 'available'
    OR artifact.retention_mode <> 'retain'
    OR artifact.classification IS DISTINCT FROM reference ->> 'classification'
    OR artifact.media_type IS DISTINCT FROM reference ->> 'mediaType'
    OR artifact.content_sha256 IS DISTINCT FROM reference ->> 'sha256'
    OR artifact.content_size_bytes::text IS DISTINCT FROM reference ->> 'sizeBytes'
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Target release build provenance is not an exact retained artifact';
  END IF;

  IF NEW.execution_artifact_id IS NOT NULL THEN
    reference := NEW.release #> '{execution,artifact}';
    SELECT * INTO artifact
    FROM public.proofstack_artifact_catalog AS candidate
    WHERE candidate.tenant_id = NEW.tenant_id
      AND candidate.project_id = NEW.project_id
      AND candidate.environment_id = NEW.environment_id
      AND candidate.artifact_id = NEW.execution_artifact_id
    FOR KEY SHARE;

    IF NOT FOUND
      OR artifact.state <> 'available'
      OR artifact.retention_mode <> 'retain'
      OR artifact.classification IS DISTINCT FROM reference ->> 'classification'
      OR artifact.media_type IS DISTINCT FROM reference ->> 'mediaType'
      OR artifact.content_sha256 IS DISTINCT FROM reference ->> 'sha256'
      OR artifact.content_size_bytes::text IS DISTINCT FROM reference ->> 'sizeBytes'
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'Target release executable is not an exact retained artifact';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE FUNCTION public.proofstack_guard_replay_boundary_artifacts()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  artifact public.proofstack_artifact_catalog%ROWTYPE;
  referenced_artifact_id text;
  reference jsonb;
BEGIN
  IF NEW.qualification_artifact_id IS NOT NULL THEN
    referenced_artifact_id := NEW.qualification_artifact_id;
    reference := NEW.declaration -> 'qualification';
  ELSIF NEW.risk_acceptance_artifact_id IS NOT NULL THEN
    referenced_artifact_id := NEW.risk_acceptance_artifact_id;
    reference := NEW.declaration #> '{sideEffect,riskAcceptance}';
  ELSE
    RETURN NEW;
  END IF;

  SELECT * INTO artifact
  FROM public.proofstack_artifact_catalog AS candidate
  WHERE candidate.tenant_id = NEW.tenant_id
    AND candidate.project_id = NEW.project_id
    AND candidate.environment_id = NEW.environment_id
    AND candidate.artifact_id = referenced_artifact_id
  FOR KEY SHARE;

  IF NOT FOUND
    OR artifact.state <> 'available'
    OR artifact.retention_mode <> 'retain'
    OR artifact.classification IS DISTINCT FROM reference ->> 'classification'
    OR artifact.media_type IS DISTINCT FROM reference ->> 'mediaType'
    OR artifact.content_sha256 IS DISTINCT FROM reference ->> 'sha256'
    OR artifact.content_size_bytes::text IS DISTINCT FROM reference ->> 'sizeBytes'
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Replay boundary assurance is not an exact retained artifact';
  END IF;

  RETURN NEW;
END;
$$;

CREATE FUNCTION public.proofstack_verify_replay_plan_rows()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  actual_boundary_count integer;
  actual_budget_count integer;
  boundaries_match boolean;
  budgets_match boolean;
BEGIN
  SELECT count(*)::integer, bool_and(
    boundary.declaration = NEW.plan -> 'boundaries' -> boundary.boundary_position
  )
  INTO actual_boundary_count, boundaries_match
  FROM public.proofstack_replay_plan_boundaries AS boundary
  WHERE boundary.tenant_id = NEW.tenant_id
    AND boundary.plan_version_id = NEW.plan_version_id;

  SELECT count(*)::integer, bool_and(
    budget.limit_value = (NEW.plan #>> ARRAY['budget', budget.dimension, 'limit'])::bigint
    AND budget.measurement = NEW.plan #>> ARRAY['budget', budget.dimension, 'measurement']
  )
  INTO actual_budget_count, budgets_match
  FROM public.proofstack_replay_plan_budgets AS budget
  WHERE budget.tenant_id = NEW.tenant_id
    AND budget.plan_version_id = NEW.plan_version_id;

  IF actual_boundary_count <> NEW.boundary_count
    OR boundaries_match IS NOT TRUE
    OR actual_budget_count <> 10
    OR budgets_match IS NOT TRUE
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Replay plan normalized rows do not exactly match its immutable definition';
  END IF;

  RETURN NULL;
END;
$$;

CREATE FUNCTION public.proofstack_guard_replay_artifact_tombstone()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.proofstack_target_releases AS release
    WHERE release.tenant_id = NEW.tenant_id
      AND NEW.artifact_id IN (release.provenance_artifact_id, release.execution_artifact_id)
  ) OR EXISTS (
    SELECT 1
    FROM public.proofstack_replay_plan_boundaries AS boundary
    WHERE boundary.tenant_id = NEW.tenant_id
      AND NEW.artifact_id IN (
        boundary.qualification_artifact_id,
        boundary.risk_acceptance_artifact_id
      )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'Published replay definitions require retained assurance and executable artifacts';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.proofstack_guard_target_release_artifacts() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.proofstack_guard_replay_boundary_artifacts() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.proofstack_verify_replay_plan_rows() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.proofstack_guard_replay_artifact_tombstone() FROM PUBLIC;

CREATE TRIGGER proofstack_target_releases_artifact_guard
  BEFORE INSERT ON public.proofstack_target_releases
  FOR EACH ROW
  EXECUTE FUNCTION public.proofstack_guard_target_release_artifacts();

CREATE TRIGGER proofstack_replay_plan_boundaries_artifact_guard
  BEFORE INSERT ON public.proofstack_replay_plan_boundaries
  FOR EACH ROW
  EXECUTE FUNCTION public.proofstack_guard_replay_boundary_artifacts();

CREATE CONSTRAINT TRIGGER proofstack_replay_plans_rows_complete
  AFTER INSERT ON public.proofstack_replay_plans
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION public.proofstack_verify_replay_plan_rows();

CREATE TRIGGER proofstack_replay_artifact_tombstone_guard
  BEFORE INSERT ON public.proofstack_artifact_tombstones
  FOR EACH ROW
  EXECUTE FUNCTION public.proofstack_guard_replay_artifact_tombstone();

CREATE TRIGGER proofstack_replay_targets_append_only
  BEFORE UPDATE OR DELETE ON public.proofstack_replay_targets
  FOR EACH ROW
  EXECUTE FUNCTION public.proofstack_reject_append_only_mutation();

CREATE TRIGGER proofstack_target_releases_append_only
  BEFORE UPDATE OR DELETE ON public.proofstack_target_releases
  FOR EACH ROW
  EXECUTE FUNCTION public.proofstack_reject_append_only_mutation();

CREATE TRIGGER proofstack_replay_plan_resources_append_only
  BEFORE UPDATE OR DELETE ON public.proofstack_replay_plan_resources
  FOR EACH ROW
  EXECUTE FUNCTION public.proofstack_reject_append_only_mutation();

CREATE TRIGGER proofstack_replay_plans_append_only
  BEFORE UPDATE OR DELETE ON public.proofstack_replay_plans
  FOR EACH ROW
  EXECUTE FUNCTION public.proofstack_reject_append_only_mutation();

CREATE TRIGGER proofstack_replay_plan_budgets_append_only
  BEFORE UPDATE OR DELETE ON public.proofstack_replay_plan_budgets
  FOR EACH ROW
  EXECUTE FUNCTION public.proofstack_reject_append_only_mutation();

CREATE TRIGGER proofstack_replay_plan_boundaries_append_only
  BEFORE UPDATE OR DELETE ON public.proofstack_replay_plan_boundaries
  FOR EACH ROW
  EXECUTE FUNCTION public.proofstack_reject_append_only_mutation();

ALTER TABLE public.proofstack_replay_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.proofstack_replay_targets FORCE ROW LEVEL SECURITY;
ALTER TABLE public.proofstack_target_releases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.proofstack_target_releases FORCE ROW LEVEL SECURITY;
ALTER TABLE public.proofstack_replay_plan_resources ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.proofstack_replay_plan_resources FORCE ROW LEVEL SECURITY;
ALTER TABLE public.proofstack_replay_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.proofstack_replay_plans FORCE ROW LEVEL SECURITY;
ALTER TABLE public.proofstack_replay_plan_budgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.proofstack_replay_plan_budgets FORCE ROW LEVEL SECURITY;
ALTER TABLE public.proofstack_replay_plan_boundaries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.proofstack_replay_plan_boundaries FORCE ROW LEVEL SECURITY;

CREATE POLICY proofstack_replay_targets_tenant_select
  ON public.proofstack_replay_targets FOR SELECT
  USING (tenant_id = NULLIF(current_setting('proofstack.tenant_id', true), ''));
CREATE POLICY proofstack_replay_targets_tenant_insert
  ON public.proofstack_replay_targets FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('proofstack.tenant_id', true), ''));
CREATE POLICY proofstack_target_releases_tenant_select
  ON public.proofstack_target_releases FOR SELECT
  USING (tenant_id = NULLIF(current_setting('proofstack.tenant_id', true), ''));
CREATE POLICY proofstack_target_releases_tenant_insert
  ON public.proofstack_target_releases FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('proofstack.tenant_id', true), ''));
CREATE POLICY proofstack_replay_plan_resources_tenant_select
  ON public.proofstack_replay_plan_resources FOR SELECT
  USING (tenant_id = NULLIF(current_setting('proofstack.tenant_id', true), ''));
CREATE POLICY proofstack_replay_plan_resources_tenant_insert
  ON public.proofstack_replay_plan_resources FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('proofstack.tenant_id', true), ''));
CREATE POLICY proofstack_replay_plans_tenant_select
  ON public.proofstack_replay_plans FOR SELECT
  USING (tenant_id = NULLIF(current_setting('proofstack.tenant_id', true), ''));
CREATE POLICY proofstack_replay_plans_tenant_insert
  ON public.proofstack_replay_plans FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('proofstack.tenant_id', true), ''));
CREATE POLICY proofstack_replay_plan_budgets_tenant_select
  ON public.proofstack_replay_plan_budgets FOR SELECT
  USING (tenant_id = NULLIF(current_setting('proofstack.tenant_id', true), ''));
CREATE POLICY proofstack_replay_plan_budgets_tenant_insert
  ON public.proofstack_replay_plan_budgets FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('proofstack.tenant_id', true), ''));
CREATE POLICY proofstack_replay_plan_boundaries_tenant_select
  ON public.proofstack_replay_plan_boundaries FOR SELECT
  USING (tenant_id = NULLIF(current_setting('proofstack.tenant_id', true), ''));
CREATE POLICY proofstack_replay_plan_boundaries_tenant_insert
  ON public.proofstack_replay_plan_boundaries FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('proofstack.tenant_id', true), ''));

REVOKE ALL ON TABLE
  public.proofstack_replay_targets,
  public.proofstack_target_releases,
  public.proofstack_replay_plan_resources,
  public.proofstack_replay_plans,
  public.proofstack_replay_plan_budgets,
  public.proofstack_replay_plan_boundaries
FROM PUBLIC;
