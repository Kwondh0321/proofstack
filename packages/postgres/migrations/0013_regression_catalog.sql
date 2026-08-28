CREATE FUNCTION public.proofstack_valid_regression_text(value text, maximum_length integer)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
STRICT
SET search_path = pg_catalog
AS $$
  SELECT
    maximum_length > 0
    AND char_length(value) BETWEEN 1 AND maximum_length
    AND value = normalize(value, NFC)
    AND value = btrim(
      value,
      U&'\0020\0009\000A\000B\000C\000D\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'
    )
    AND NOT EXISTS (
      SELECT 1
      FROM regexp_split_to_table(value, '') AS scalar(scalar_value)
      WHERE ascii(scalar_value) BETWEEN 0 AND 31
        OR ascii(scalar_value) BETWEEN 127 AND 159
        OR ascii(scalar_value) IN (1564, 8206, 8207)
        OR ascii(scalar_value) BETWEEN 8232 AND 8238
        OR ascii(scalar_value) BETWEEN 8294 AND 8297
    );
$$;

REVOKE ALL ON FUNCTION public.proofstack_valid_regression_text(text, integer) FROM PUBLIC;

CREATE FUNCTION public.proofstack_regression_publication_intent_status(
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
        expected_event_type = 'regression.fixture-version.published'
        AND expected_aggregate_type = 'regression.fixture-version'
        AND jsonb_typeof(expected_payload) = 'object'
        AND expected_payload ?& ARRAY[
          'definitionSha256',
          'environmentId',
          'fixtureId',
          'fixtureVersionId',
          'projectId'
        ]::text[]
        AND expected_payload - ARRAY[
          'definitionSha256',
          'environmentId',
          'fixtureId',
          'fixtureVersionId',
          'projectId'
        ]::text[] = '{}'::jsonb
        AND jsonb_typeof(expected_payload -> 'definitionSha256') = 'string'
        AND jsonb_typeof(expected_payload -> 'environmentId') = 'string'
        AND jsonb_typeof(expected_payload -> 'fixtureId') = 'string'
        AND jsonb_typeof(expected_payload -> 'fixtureVersionId') = 'string'
        AND jsonb_typeof(expected_payload -> 'projectId') = 'string'
        AND expected_payload ->> 'definitionSha256' ~ '^[0-9a-f]{64}$'
        AND expected_payload ->> 'environmentId' ~ '^[a-z][a-z0-9_]{2,63}$'
        AND expected_payload ->> 'fixtureId' ~ '^[a-z][a-z0-9_]{2,63}$'
        AND expected_payload ->> 'fixtureVersionId' ~ '^[a-z][a-z0-9_]{2,63}$'
        AND expected_payload ->> 'projectId' ~ '^[a-z][a-z0-9_]{2,63}$'
        AND expected_aggregate_id = expected_payload ->> 'fixtureVersionId'
      )
      OR (
        expected_event_type = 'regression.dataset-version.published'
        AND expected_aggregate_type = 'regression.dataset-version'
        AND jsonb_typeof(expected_payload) = 'object'
        AND expected_payload ?& ARRAY[
          'datasetId',
          'datasetVersionId',
          'definitionSha256',
          'environmentId',
          'projectId'
        ]::text[]
        AND expected_payload - ARRAY[
          'datasetId',
          'datasetVersionId',
          'definitionSha256',
          'environmentId',
          'projectId'
        ]::text[] = '{}'::jsonb
        AND jsonb_typeof(expected_payload -> 'datasetId') = 'string'
        AND jsonb_typeof(expected_payload -> 'datasetVersionId') = 'string'
        AND jsonb_typeof(expected_payload -> 'definitionSha256') = 'string'
        AND jsonb_typeof(expected_payload -> 'environmentId') = 'string'
        AND jsonb_typeof(expected_payload -> 'projectId') = 'string'
        AND expected_payload ->> 'datasetId' ~ '^[a-z][a-z0-9_]{2,63}$'
        AND expected_payload ->> 'datasetVersionId' ~ '^[a-z][a-z0-9_]{2,63}$'
        AND expected_payload ->> 'definitionSha256' ~ '^[0-9a-f]{64}$'
        AND expected_payload ->> 'environmentId' ~ '^[a-z][a-z0-9_]{2,63}$'
        AND expected_payload ->> 'projectId' ~ '^[a-z][a-z0-9_]{2,63}$'
        AND expected_aggregate_id = expected_payload ->> 'datasetVersionId'
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

REVOKE ALL ON FUNCTION public.proofstack_regression_publication_intent_status(
  text,
  text,
  text,
  text,
  text,
  jsonb,
  timestamptz
) FROM PUBLIC;

CREATE TABLE public.proofstack_regression_fixtures (
  tenant_id varchar(64) NOT NULL,
  project_id varchar(64) NOT NULL,
  environment_id varchar(64) NOT NULL,
  fixture_id varchar(64) NOT NULL,
  root_fixture_version_id varchar(64) NOT NULL,
  root_definition_sha256 character(64) NOT NULL,

  CONSTRAINT proofstack_regression_fixtures_pk PRIMARY KEY (tenant_id, fixture_id),
  CONSTRAINT proofstack_regression_fixtures_scope_unique UNIQUE (
    tenant_id,
    project_id,
    environment_id,
    fixture_id
  ),
  CONSTRAINT proofstack_regression_fixtures_root_unique UNIQUE (
    tenant_id,
    project_id,
    environment_id,
    fixture_id,
    root_fixture_version_id,
    root_definition_sha256
  ),
  CONSTRAINT proofstack_regression_fixtures_tenant_format CHECK (
    tenant_id ~ '^[a-z][a-z0-9_]{2,63}$'
  ),
  CONSTRAINT proofstack_regression_fixtures_project_format CHECK (
    project_id ~ '^[a-z][a-z0-9_]{2,63}$'
  ),
  CONSTRAINT proofstack_regression_fixtures_environment_format CHECK (
    environment_id ~ '^[a-z][a-z0-9_]{2,63}$'
  ),
  CONSTRAINT proofstack_regression_fixtures_id_format CHECK (
    fixture_id ~ '^[a-z][a-z0-9_]{2,63}$'
  ),
  CONSTRAINT proofstack_regression_fixtures_root_format CHECK (
    root_fixture_version_id ~ '^[a-z][a-z0-9_]{2,63}$'
  ),
  CONSTRAINT proofstack_regression_fixtures_root_digest CHECK (
    root_definition_sha256 ~ '^[0-9a-f]{64}$'
  )
);

CREATE TABLE public.proofstack_regression_fixture_versions (
  tenant_id varchar(64) NOT NULL,
  project_id varchar(64) NOT NULL,
  environment_id varchar(64) NOT NULL,
  fixture_id varchar(64) NOT NULL,
  root_fixture_version_id varchar(64) NOT NULL,
  root_definition_sha256 character(64) NOT NULL,
  fixture_version_id varchar(64) NOT NULL,
  schema_version varchar(16) NOT NULL,
  name varchar(128) NOT NULL,
  description varchar(2048),
  predecessor_fixture_version_id varchar(64),
  predecessor_definition_sha256 character(64),
  replayability varchar(32) NOT NULL,
  source_kind varchar(32) NOT NULL,
  source_trace_id character(32) NOT NULL,
  source_event_count smallint NOT NULL,
  source_completeness varchar(32) NOT NULL,
  source_captured_at timestamptz NOT NULL,
  source_captured_at_lexical text NOT NULL,
  created_at timestamptz NOT NULL,
  created_at_lexical text NOT NULL,
  created_by_principal_id varchar(64) NOT NULL,
  definition_sha256 character(64) NOT NULL,

  CONSTRAINT proofstack_regression_fixture_versions_pk PRIMARY KEY (
    tenant_id,
    fixture_version_id
  ),
  CONSTRAINT proofstack_regression_fixture_versions_scope_unique UNIQUE (
    tenant_id,
    project_id,
    environment_id,
    fixture_id,
    fixture_version_id
  ),
  CONSTRAINT proofstack_regression_fixture_versions_digest_unique UNIQUE (
    tenant_id,
    project_id,
    environment_id,
    fixture_id,
    fixture_version_id,
    definition_sha256
  ),
  CONSTRAINT proofstack_regression_fixture_versions_events_unique UNIQUE (
    tenant_id,
    project_id,
    environment_id,
    fixture_id,
    fixture_version_id,
    source_trace_id,
    source_event_count
  ),
  CONSTRAINT proofstack_regression_fixture_versions_resource_fk FOREIGN KEY (
    tenant_id,
    project_id,
    environment_id,
    fixture_id,
    root_fixture_version_id,
    root_definition_sha256
  ) REFERENCES public.proofstack_regression_fixtures (
    tenant_id,
    project_id,
    environment_id,
    fixture_id,
    root_fixture_version_id,
    root_definition_sha256
  ),
  CONSTRAINT proofstack_regression_fixture_versions_predecessor_fk FOREIGN KEY (
    tenant_id,
    project_id,
    environment_id,
    fixture_id,
    predecessor_fixture_version_id,
    predecessor_definition_sha256
  ) REFERENCES public.proofstack_regression_fixture_versions (
    tenant_id,
    project_id,
    environment_id,
    fixture_id,
    fixture_version_id,
    definition_sha256
  ),
  CONSTRAINT proofstack_regression_fixture_versions_tenant_format CHECK (
    tenant_id ~ '^[a-z][a-z0-9_]{2,63}$'
  ),
  CONSTRAINT proofstack_regression_fixture_versions_project_format CHECK (
    project_id ~ '^[a-z][a-z0-9_]{2,63}$'
  ),
  CONSTRAINT proofstack_regression_fixture_versions_environment_format CHECK (
    environment_id ~ '^[a-z][a-z0-9_]{2,63}$'
  ),
  CONSTRAINT proofstack_regression_fixture_versions_fixture_format CHECK (
    fixture_id ~ '^[a-z][a-z0-9_]{2,63}$'
  ),
  CONSTRAINT proofstack_regression_fixture_versions_root_format CHECK (
    root_fixture_version_id ~ '^[a-z][a-z0-9_]{2,63}$'
  ),
  CONSTRAINT proofstack_regression_fixture_versions_root_digest CHECK (
    root_definition_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT proofstack_regression_fixture_versions_id_format CHECK (
    fixture_version_id ~ '^[a-z][a-z0-9_]{2,63}$'
  ),
  CONSTRAINT proofstack_regression_fixture_versions_schema CHECK (
    schema_version = '0.1'
  ),
  CONSTRAINT proofstack_regression_fixture_versions_name CHECK (
    public.proofstack_valid_regression_text(name, 128)
  ),
  CONSTRAINT proofstack_regression_fixture_versions_description CHECK (
    description IS NULL
    OR public.proofstack_valid_regression_text(description, 2048)
  ),
  CONSTRAINT proofstack_regression_fixture_versions_predecessor_shape CHECK (
    (predecessor_fixture_version_id IS NULL) = (predecessor_definition_sha256 IS NULL)
  ),
  CONSTRAINT proofstack_regression_fixture_versions_predecessor_format CHECK (
    predecessor_fixture_version_id IS NULL
    OR predecessor_fixture_version_id ~ '^[a-z][a-z0-9_]{2,63}$'
  ),
  CONSTRAINT proofstack_regression_fixture_versions_predecessor_digest CHECK (
    predecessor_definition_sha256 IS NULL
    OR predecessor_definition_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT proofstack_regression_fixture_versions_lineage CHECK (
    (fixture_version_id = root_fixture_version_id) =
      (predecessor_fixture_version_id IS NULL)
    AND predecessor_fixture_version_id IS DISTINCT FROM fixture_version_id
    AND (fixture_version_id <> root_fixture_version_id OR definition_sha256 = root_definition_sha256)
  ),
  CONSTRAINT proofstack_regression_fixture_versions_replayability CHECK (
    replayability = 'evidence_only'
  ),
  CONSTRAINT proofstack_regression_fixture_versions_source_kind CHECK (
    source_kind = 'trace_snapshot'
  ),
  CONSTRAINT proofstack_regression_fixture_versions_trace_format CHECK (
    source_trace_id ~ '^(?!0{32}$)[0-9a-f]{32}$'
  ),
  CONSTRAINT proofstack_regression_fixture_versions_event_count CHECK (
    source_event_count BETWEEN 1 AND 1000
  ),
  CONSTRAINT proofstack_regression_fixture_versions_completeness CHECK (
    source_completeness = 'observed_snapshot'
  ),
  CONSTRAINT proofstack_regression_fixture_versions_capture_time CHECK (
    isfinite(source_captured_at)
    AND isfinite(created_at)
    AND source_captured_at_lexical ~
      '^[0-9]{4}-(0[1-9]|1[0-2])-([0-2][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.[0-9]{1,30})?(Z|[+-](0[0-9]|1[0-5]):[0-5][0-9])$'
    AND source_captured_at_lexical !~ '^0000-'
    AND created_at_lexical ~
      '^[0-9]{4}-(0[1-9]|1[0-2])-([0-2][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\.[0-9]{3}Z$'
    AND created_at_lexical !~ '^0000-'
    AND source_captured_at <= created_at
    AND source_captured_at = source_captured_at_lexical::timestamptz
    AND created_at = created_at_lexical::timestamptz
  ),
  CONSTRAINT proofstack_regression_fixture_versions_creator_format CHECK (
    created_by_principal_id ~ '^[a-z][a-z0-9_]{2,63}$'
  ),
  CONSTRAINT proofstack_regression_fixture_versions_digest_format CHECK (
    definition_sha256 ~ '^[0-9a-f]{64}$'
  )
);

ALTER TABLE public.proofstack_regression_fixtures
  ADD CONSTRAINT proofstack_regression_fixtures_root_fk FOREIGN KEY (
    tenant_id,
    project_id,
    environment_id,
    fixture_id,
    root_fixture_version_id,
    root_definition_sha256
  ) REFERENCES public.proofstack_regression_fixture_versions (
    tenant_id,
    project_id,
    environment_id,
    fixture_id,
    fixture_version_id,
    definition_sha256
  ) DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE public.proofstack_regression_fixture_events (
  tenant_id varchar(64) NOT NULL,
  project_id varchar(64) NOT NULL,
  environment_id varchar(64) NOT NULL,
  fixture_id varchar(64) NOT NULL,
  fixture_version_id varchar(64) NOT NULL,
  source_trace_id character(32) NOT NULL,
  source_event_count smallint NOT NULL,
  event_position smallint NOT NULL,
  event_id varchar(64) NOT NULL,

  CONSTRAINT proofstack_regression_fixture_events_pk PRIMARY KEY (
    tenant_id,
    fixture_version_id,
    event_position
  ),
  CONSTRAINT proofstack_regression_fixture_events_id_unique UNIQUE (
    tenant_id,
    fixture_version_id,
    event_id
  ),
  CONSTRAINT proofstack_regression_fixture_events_version_fk FOREIGN KEY (
    tenant_id,
    project_id,
    environment_id,
    fixture_id,
    fixture_version_id,
    source_trace_id,
    source_event_count
  ) REFERENCES public.proofstack_regression_fixture_versions (
    tenant_id,
    project_id,
    environment_id,
    fixture_id,
    fixture_version_id,
    source_trace_id,
    source_event_count
  ),
  CONSTRAINT proofstack_regression_fixture_events_position CHECK (
    event_position BETWEEN 0 AND source_event_count - 1
  ),
  CONSTRAINT proofstack_regression_fixture_events_event_format CHECK (
    event_id ~ '^[a-z][a-z0-9_]{2,63}$'
  )
);

CREATE TABLE public.proofstack_regression_datasets (
  tenant_id varchar(64) NOT NULL,
  project_id varchar(64) NOT NULL,
  environment_id varchar(64) NOT NULL,
  dataset_id varchar(64) NOT NULL,
  root_dataset_version_id varchar(64) NOT NULL,
  root_definition_sha256 character(64) NOT NULL,

  CONSTRAINT proofstack_regression_datasets_pk PRIMARY KEY (tenant_id, dataset_id),
  CONSTRAINT proofstack_regression_datasets_scope_unique UNIQUE (
    tenant_id,
    project_id,
    environment_id,
    dataset_id
  ),
  CONSTRAINT proofstack_regression_datasets_root_unique UNIQUE (
    tenant_id,
    project_id,
    environment_id,
    dataset_id,
    root_dataset_version_id,
    root_definition_sha256
  ),
  CONSTRAINT proofstack_regression_datasets_tenant_format CHECK (
    tenant_id ~ '^[a-z][a-z0-9_]{2,63}$'
  ),
  CONSTRAINT proofstack_regression_datasets_project_format CHECK (
    project_id ~ '^[a-z][a-z0-9_]{2,63}$'
  ),
  CONSTRAINT proofstack_regression_datasets_environment_format CHECK (
    environment_id ~ '^[a-z][a-z0-9_]{2,63}$'
  ),
  CONSTRAINT proofstack_regression_datasets_id_format CHECK (
    dataset_id ~ '^[a-z][a-z0-9_]{2,63}$'
  ),
  CONSTRAINT proofstack_regression_datasets_root_format CHECK (
    root_dataset_version_id ~ '^[a-z][a-z0-9_]{2,63}$'
  ),
  CONSTRAINT proofstack_regression_datasets_root_digest CHECK (
    root_definition_sha256 ~ '^[0-9a-f]{64}$'
  )
);

CREATE TABLE public.proofstack_regression_dataset_versions (
  tenant_id varchar(64) NOT NULL,
  project_id varchar(64) NOT NULL,
  environment_id varchar(64) NOT NULL,
  dataset_id varchar(64) NOT NULL,
  root_dataset_version_id varchar(64) NOT NULL,
  root_definition_sha256 character(64) NOT NULL,
  dataset_version_id varchar(64) NOT NULL,
  schema_version varchar(16) NOT NULL,
  name varchar(128) NOT NULL,
  description varchar(2048),
  predecessor_dataset_version_id varchar(64),
  predecessor_definition_sha256 character(64),
  fixture_version_count smallint NOT NULL,
  created_at timestamptz NOT NULL,
  created_at_lexical text NOT NULL,
  created_by_principal_id varchar(64) NOT NULL,
  definition_sha256 character(64) NOT NULL,

  CONSTRAINT proofstack_regression_dataset_versions_pk PRIMARY KEY (
    tenant_id,
    dataset_version_id
  ),
  CONSTRAINT proofstack_regression_dataset_versions_scope_unique UNIQUE (
    tenant_id,
    project_id,
    environment_id,
    dataset_id,
    dataset_version_id
  ),
  CONSTRAINT proofstack_regression_dataset_versions_digest_unique UNIQUE (
    tenant_id,
    project_id,
    environment_id,
    dataset_id,
    dataset_version_id,
    definition_sha256
  ),
  CONSTRAINT proofstack_regression_dataset_versions_members_unique UNIQUE (
    tenant_id,
    project_id,
    environment_id,
    dataset_id,
    dataset_version_id,
    fixture_version_count
  ),
  CONSTRAINT proofstack_regression_dataset_versions_resource_fk FOREIGN KEY (
    tenant_id,
    project_id,
    environment_id,
    dataset_id,
    root_dataset_version_id,
    root_definition_sha256
  ) REFERENCES public.proofstack_regression_datasets (
    tenant_id,
    project_id,
    environment_id,
    dataset_id,
    root_dataset_version_id,
    root_definition_sha256
  ),
  CONSTRAINT proofstack_regression_dataset_versions_predecessor_fk FOREIGN KEY (
    tenant_id,
    project_id,
    environment_id,
    dataset_id,
    predecessor_dataset_version_id,
    predecessor_definition_sha256
  ) REFERENCES public.proofstack_regression_dataset_versions (
    tenant_id,
    project_id,
    environment_id,
    dataset_id,
    dataset_version_id,
    definition_sha256
  ),
  CONSTRAINT proofstack_regression_dataset_versions_tenant_format CHECK (
    tenant_id ~ '^[a-z][a-z0-9_]{2,63}$'
  ),
  CONSTRAINT proofstack_regression_dataset_versions_project_format CHECK (
    project_id ~ '^[a-z][a-z0-9_]{2,63}$'
  ),
  CONSTRAINT proofstack_regression_dataset_versions_environment_format CHECK (
    environment_id ~ '^[a-z][a-z0-9_]{2,63}$'
  ),
  CONSTRAINT proofstack_regression_dataset_versions_dataset_format CHECK (
    dataset_id ~ '^[a-z][a-z0-9_]{2,63}$'
  ),
  CONSTRAINT proofstack_regression_dataset_versions_root_format CHECK (
    root_dataset_version_id ~ '^[a-z][a-z0-9_]{2,63}$'
  ),
  CONSTRAINT proofstack_regression_dataset_versions_root_digest CHECK (
    root_definition_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT proofstack_regression_dataset_versions_id_format CHECK (
    dataset_version_id ~ '^[a-z][a-z0-9_]{2,63}$'
  ),
  CONSTRAINT proofstack_regression_dataset_versions_schema CHECK (
    schema_version = '0.1'
  ),
  CONSTRAINT proofstack_regression_dataset_versions_name CHECK (
    public.proofstack_valid_regression_text(name, 128)
  ),
  CONSTRAINT proofstack_regression_dataset_versions_description CHECK (
    description IS NULL
    OR public.proofstack_valid_regression_text(description, 2048)
  ),
  CONSTRAINT proofstack_regression_dataset_versions_predecessor_shape CHECK (
    (predecessor_dataset_version_id IS NULL) = (predecessor_definition_sha256 IS NULL)
  ),
  CONSTRAINT proofstack_regression_dataset_versions_predecessor_format CHECK (
    predecessor_dataset_version_id IS NULL
    OR predecessor_dataset_version_id ~ '^[a-z][a-z0-9_]{2,63}$'
  ),
  CONSTRAINT proofstack_regression_dataset_versions_predecessor_digest CHECK (
    predecessor_definition_sha256 IS NULL
    OR predecessor_definition_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT proofstack_regression_dataset_versions_lineage CHECK (
    (dataset_version_id = root_dataset_version_id) =
      (predecessor_dataset_version_id IS NULL)
    AND predecessor_dataset_version_id IS DISTINCT FROM dataset_version_id
    AND (dataset_version_id <> root_dataset_version_id OR definition_sha256 = root_definition_sha256)
  ),
  CONSTRAINT proofstack_regression_dataset_versions_member_count CHECK (
    fixture_version_count BETWEEN 1 AND 500
  ),
  CONSTRAINT proofstack_regression_dataset_versions_creator_format CHECK (
    created_by_principal_id ~ '^[a-z][a-z0-9_]{2,63}$'
  ),
  CONSTRAINT proofstack_regression_dataset_versions_created_at CHECK (
    isfinite(created_at)
    AND created_at_lexical ~
      '^[0-9]{4}-(0[1-9]|1[0-2])-([0-2][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\.[0-9]{3}Z$'
    AND created_at_lexical !~ '^0000-'
    AND created_at = created_at_lexical::timestamptz
  ),
  CONSTRAINT proofstack_regression_dataset_versions_digest_format CHECK (
    definition_sha256 ~ '^[0-9a-f]{64}$'
  )
);

ALTER TABLE public.proofstack_regression_datasets
  ADD CONSTRAINT proofstack_regression_datasets_root_fk FOREIGN KEY (
    tenant_id,
    project_id,
    environment_id,
    dataset_id,
    root_dataset_version_id,
    root_definition_sha256
  ) REFERENCES public.proofstack_regression_dataset_versions (
    tenant_id,
    project_id,
    environment_id,
    dataset_id,
    dataset_version_id,
    definition_sha256
  ) DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE public.proofstack_regression_dataset_members (
  tenant_id varchar(64) NOT NULL,
  project_id varchar(64) NOT NULL,
  environment_id varchar(64) NOT NULL,
  dataset_id varchar(64) NOT NULL,
  dataset_version_id varchar(64) NOT NULL,
  fixture_version_count smallint NOT NULL,
  member_position smallint NOT NULL,
  fixture_id varchar(64) NOT NULL,
  fixture_version_id varchar(64) NOT NULL,
  fixture_definition_sha256 character(64) NOT NULL,

  CONSTRAINT proofstack_regression_dataset_members_pk PRIMARY KEY (
    tenant_id,
    dataset_version_id,
    member_position
  ),
  CONSTRAINT proofstack_regression_dataset_members_fixture_unique UNIQUE (
    tenant_id,
    dataset_version_id,
    fixture_id
  ),
  CONSTRAINT proofstack_regression_dataset_members_version_unique UNIQUE (
    tenant_id,
    dataset_version_id,
    fixture_version_id
  ),
  CONSTRAINT proofstack_regression_dataset_members_dataset_fk FOREIGN KEY (
    tenant_id,
    project_id,
    environment_id,
    dataset_id,
    dataset_version_id,
    fixture_version_count
  ) REFERENCES public.proofstack_regression_dataset_versions (
    tenant_id,
    project_id,
    environment_id,
    dataset_id,
    dataset_version_id,
    fixture_version_count
  ),
  CONSTRAINT proofstack_regression_dataset_members_fixture_fk FOREIGN KEY (
    tenant_id,
    project_id,
    environment_id,
    fixture_id,
    fixture_version_id,
    fixture_definition_sha256
  ) REFERENCES public.proofstack_regression_fixture_versions (
    tenant_id,
    project_id,
    environment_id,
    fixture_id,
    fixture_version_id,
    definition_sha256
  ),
  CONSTRAINT proofstack_regression_dataset_members_position CHECK (
    member_position BETWEEN 0 AND fixture_version_count - 1
  ),
  CONSTRAINT proofstack_regression_dataset_members_digest_format CHECK (
    fixture_definition_sha256 ~ '^[0-9a-f]{64}$'
  )
);

CREATE FUNCTION public.proofstack_verify_regression_fixture_event_count()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  actual_count integer;
BEGIN
  SELECT count(*)::integer
  INTO actual_count
  FROM public.proofstack_regression_fixture_events
  WHERE tenant_id = NEW.tenant_id
    AND fixture_version_id = NEW.fixture_version_id;

  IF actual_count <> NEW.source_event_count THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Regression fixture event membership is incomplete';
  END IF;

  RETURN NULL;
END;
$$;

CREATE FUNCTION public.proofstack_verify_regression_dataset_member_count()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  actual_count integer;
BEGIN
  SELECT count(*)::integer
  INTO actual_count
  FROM public.proofstack_regression_dataset_members
  WHERE tenant_id = NEW.tenant_id
    AND dataset_version_id = NEW.dataset_version_id;

  IF actual_count <> NEW.fixture_version_count THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Regression dataset membership is incomplete';
  END IF;

  RETURN NULL;
END;
$$;

CREATE FUNCTION public.proofstack_reject_append_only_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '55000',
    MESSAGE = format('ProofStack append-only records in %s cannot be changed', TG_TABLE_NAME);
END;
$$;

REVOKE ALL ON FUNCTION public.proofstack_verify_regression_fixture_event_count() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.proofstack_verify_regression_dataset_member_count() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.proofstack_reject_append_only_mutation() FROM PUBLIC;

CREATE CONSTRAINT TRIGGER proofstack_regression_fixture_event_count
  AFTER INSERT ON public.proofstack_regression_fixture_versions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION public.proofstack_verify_regression_fixture_event_count();

CREATE CONSTRAINT TRIGGER proofstack_regression_dataset_member_count
  AFTER INSERT ON public.proofstack_regression_dataset_versions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION public.proofstack_verify_regression_dataset_member_count();

ALTER TABLE public.proofstack_regression_fixtures ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.proofstack_regression_fixtures FORCE ROW LEVEL SECURITY;
ALTER TABLE public.proofstack_regression_fixture_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.proofstack_regression_fixture_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE public.proofstack_regression_fixture_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.proofstack_regression_fixture_events FORCE ROW LEVEL SECURITY;
ALTER TABLE public.proofstack_regression_datasets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.proofstack_regression_datasets FORCE ROW LEVEL SECURITY;
ALTER TABLE public.proofstack_regression_dataset_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.proofstack_regression_dataset_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE public.proofstack_regression_dataset_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.proofstack_regression_dataset_members FORCE ROW LEVEL SECURITY;

CREATE POLICY proofstack_regression_fixtures_tenant_select
  ON public.proofstack_regression_fixtures
  FOR SELECT
  USING (tenant_id = NULLIF(current_setting('proofstack.tenant_id', true), ''));

CREATE POLICY proofstack_regression_fixtures_tenant_insert
  ON public.proofstack_regression_fixtures
  FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('proofstack.tenant_id', true), ''));

CREATE POLICY proofstack_regression_fixture_versions_tenant_select
  ON public.proofstack_regression_fixture_versions
  FOR SELECT
  USING (tenant_id = NULLIF(current_setting('proofstack.tenant_id', true), ''));

CREATE POLICY proofstack_regression_fixture_versions_tenant_insert
  ON public.proofstack_regression_fixture_versions
  FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('proofstack.tenant_id', true), ''));

CREATE POLICY proofstack_regression_fixture_events_tenant_select
  ON public.proofstack_regression_fixture_events
  FOR SELECT
  USING (tenant_id = NULLIF(current_setting('proofstack.tenant_id', true), ''));

CREATE POLICY proofstack_regression_fixture_events_tenant_insert
  ON public.proofstack_regression_fixture_events
  FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('proofstack.tenant_id', true), ''));

CREATE POLICY proofstack_regression_datasets_tenant_select
  ON public.proofstack_regression_datasets
  FOR SELECT
  USING (tenant_id = NULLIF(current_setting('proofstack.tenant_id', true), ''));

CREATE POLICY proofstack_regression_datasets_tenant_insert
  ON public.proofstack_regression_datasets
  FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('proofstack.tenant_id', true), ''));

CREATE POLICY proofstack_regression_dataset_versions_tenant_select
  ON public.proofstack_regression_dataset_versions
  FOR SELECT
  USING (tenant_id = NULLIF(current_setting('proofstack.tenant_id', true), ''));

CREATE POLICY proofstack_regression_dataset_versions_tenant_insert
  ON public.proofstack_regression_dataset_versions
  FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('proofstack.tenant_id', true), ''));

CREATE POLICY proofstack_regression_dataset_members_tenant_select
  ON public.proofstack_regression_dataset_members
  FOR SELECT
  USING (tenant_id = NULLIF(current_setting('proofstack.tenant_id', true), ''));

CREATE POLICY proofstack_regression_dataset_members_tenant_insert
  ON public.proofstack_regression_dataset_members
  FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('proofstack.tenant_id', true), ''));

CREATE TRIGGER proofstack_regression_fixtures_append_only
  BEFORE UPDATE OR DELETE ON public.proofstack_regression_fixtures
  FOR EACH ROW
  EXECUTE FUNCTION public.proofstack_reject_append_only_mutation();

CREATE TRIGGER proofstack_regression_fixture_versions_append_only
  BEFORE UPDATE OR DELETE ON public.proofstack_regression_fixture_versions
  FOR EACH ROW
  EXECUTE FUNCTION public.proofstack_reject_append_only_mutation();

CREATE TRIGGER proofstack_regression_fixture_events_append_only
  BEFORE UPDATE OR DELETE ON public.proofstack_regression_fixture_events
  FOR EACH ROW
  EXECUTE FUNCTION public.proofstack_reject_append_only_mutation();

CREATE TRIGGER proofstack_regression_datasets_append_only
  BEFORE UPDATE OR DELETE ON public.proofstack_regression_datasets
  FOR EACH ROW
  EXECUTE FUNCTION public.proofstack_reject_append_only_mutation();

CREATE TRIGGER proofstack_regression_dataset_versions_append_only
  BEFORE UPDATE OR DELETE ON public.proofstack_regression_dataset_versions
  FOR EACH ROW
  EXECUTE FUNCTION public.proofstack_reject_append_only_mutation();

CREATE TRIGGER proofstack_regression_dataset_members_append_only
  BEFORE UPDATE OR DELETE ON public.proofstack_regression_dataset_members
  FOR EACH ROW
  EXECUTE FUNCTION public.proofstack_reject_append_only_mutation();

REVOKE ALL ON TABLE
  public.proofstack_regression_fixtures,
  public.proofstack_regression_fixture_versions,
  public.proofstack_regression_fixture_events,
  public.proofstack_regression_datasets,
  public.proofstack_regression_dataset_versions,
  public.proofstack_regression_dataset_members
FROM PUBLIC;
