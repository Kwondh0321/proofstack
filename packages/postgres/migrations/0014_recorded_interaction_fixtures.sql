ALTER TABLE public.proofstack_regression_fixture_versions
  DROP CONSTRAINT proofstack_regression_fixture_versions_schema,
  DROP CONSTRAINT proofstack_regression_fixture_versions_replayability,
  ADD CONSTRAINT proofstack_regression_fixture_versions_schema CHECK (
    schema_version IN ('0.1', '0.2')
  ),
  ADD CONSTRAINT proofstack_regression_fixture_versions_replayability CHECK (
    (schema_version = '0.1' AND replayability = 'evidence_only')
    OR (schema_version = '0.2' AND replayability = 'recorded_interactions')
  );

ALTER TABLE public.proofstack_artifact_catalog
  ADD CONSTRAINT proofstack_artifact_catalog_scope_unique UNIQUE (
    tenant_id,
    project_id,
    environment_id,
    artifact_id
  );

ALTER TABLE public.proofstack_artifact_tombstones
  DROP CONSTRAINT proofstack_artifact_tombstone_trigger,
  ADD CONSTRAINT proofstack_artifact_tombstone_trigger CHECK (
    tombstone_trigger IN ('manual', 'retention', 'abandoned', 'fixture_revocation')
  );

CREATE TABLE public.proofstack_recorded_interaction_fixture_versions (
  tenant_id varchar(64) NOT NULL,
  project_id varchar(64) NOT NULL,
  environment_id varchar(64) NOT NULL,
  fixture_id varchar(64) NOT NULL,
  fixture_version_id varchar(64) NOT NULL,
  interaction_capture jsonb NOT NULL,

  CONSTRAINT proofstack_recorded_interaction_fixture_versions_pk PRIMARY KEY (
    tenant_id,
    fixture_version_id
  ),
  CONSTRAINT proofstack_recorded_interaction_fixture_versions_scope_unique UNIQUE (
    tenant_id,
    project_id,
    environment_id,
    fixture_id,
    fixture_version_id
  ),
  CONSTRAINT proofstack_recorded_interaction_fixture_versions_header_fk FOREIGN KEY (
    tenant_id,
    project_id,
    environment_id,
    fixture_id,
    fixture_version_id
  ) REFERENCES public.proofstack_regression_fixture_versions (
    tenant_id,
    project_id,
    environment_id,
    fixture_id,
    fixture_version_id
  ),
  CONSTRAINT proofstack_recorded_interaction_fixture_versions_tenant_format CHECK (
    tenant_id ~ '^[a-z][a-z0-9_]{2,63}$'
  ),
  CONSTRAINT proofstack_recorded_interaction_fixture_versions_project_format CHECK (
    project_id ~ '^[a-z][a-z0-9_]{2,63}$'
  ),
  CONSTRAINT proofstack_recorded_fixture_versions_environment_format CHECK (
    environment_id ~ '^[a-z][a-z0-9_]{2,63}$'
  ),
  CONSTRAINT proofstack_recorded_interaction_fixture_versions_fixture_format CHECK (
    fixture_id ~ '^[a-z][a-z0-9_]{2,63}$'
  ),
  CONSTRAINT proofstack_recorded_interaction_fixture_versions_id_format CHECK (
    fixture_version_id ~ '^[a-z][a-z0-9_]{2,63}$'
  ),
  CONSTRAINT proofstack_recorded_interaction_fixture_versions_manifest_shape CHECK (
    (
      jsonb_typeof(interaction_capture) = 'object'
      AND interaction_capture - ARRAY['artifacts', 'interactions', 'schemaVersion', 'source'] =
        '{}'::jsonb
      AND interaction_capture ->> 'schemaVersion' = '0.1'
      AND jsonb_typeof(interaction_capture -> 'artifacts') = 'array'
      AND jsonb_array_length(interaction_capture -> 'artifacts') BETWEEN 1 AND 2048
      AND jsonb_typeof(interaction_capture -> 'interactions') = 'array'
      AND jsonb_array_length(interaction_capture -> 'interactions') BETWEEN 1 AND 512
      AND jsonb_typeof(interaction_capture -> 'source') = 'object'
    ) IS TRUE
  )
);

CREATE TABLE public.proofstack_interaction_fixture_artifact_ownerships (
  tenant_id varchar(64) NOT NULL,
  project_id varchar(64) NOT NULL,
  environment_id varchar(64) NOT NULL,
  artifact_id varchar(64) NOT NULL,
  fixture_id varchar(64) NOT NULL,
  fixture_version_id varchar(64) NOT NULL,
  artifact_position smallint NOT NULL,
  schema_version varchar(16) NOT NULL,
  bound_at timestamptz NOT NULL,
  bound_at_lexical text NOT NULL,
  bound_by_principal_id varchar(64) NOT NULL,

  CONSTRAINT proofstack_interaction_fixture_artifact_ownerships_pk PRIMARY KEY (
    tenant_id,
    artifact_id
  ),
  CONSTRAINT proofstack_interaction_ownerships_position_unique UNIQUE (
    tenant_id,
    fixture_version_id,
    artifact_position
  ),
  CONSTRAINT proofstack_interaction_fixture_artifact_ownerships_scope_unique UNIQUE (
    tenant_id,
    project_id,
    environment_id,
    fixture_id,
    fixture_version_id,
    artifact_id
  ),
  CONSTRAINT proofstack_interaction_fixture_artifact_ownerships_fixture_fk FOREIGN KEY (
    tenant_id,
    project_id,
    environment_id,
    fixture_id,
    fixture_version_id
  ) REFERENCES public.proofstack_recorded_interaction_fixture_versions (
    tenant_id,
    project_id,
    environment_id,
    fixture_id,
    fixture_version_id
  ),
  CONSTRAINT proofstack_interaction_fixture_artifact_ownerships_catalog_fk FOREIGN KEY (
    tenant_id,
    project_id,
    environment_id,
    artifact_id
  ) REFERENCES public.proofstack_artifact_catalog (
    tenant_id,
    project_id,
    environment_id,
    artifact_id
  ),
  CONSTRAINT proofstack_interaction_ownerships_tenant_format CHECK (
    tenant_id ~ '^[a-z][a-z0-9_]{2,63}$'
  ),
  CONSTRAINT proofstack_interaction_ownerships_project_format CHECK (
    project_id ~ '^[a-z][a-z0-9_]{2,63}$'
  ),
  CONSTRAINT proofstack_interaction_ownerships_environment_format CHECK (
    environment_id ~ '^[a-z][a-z0-9_]{2,63}$'
  ),
  CONSTRAINT proofstack_interaction_ownerships_artifact_format CHECK (
    artifact_id ~ '^[a-z][a-z0-9_]{2,63}$'
  ),
  CONSTRAINT proofstack_interaction_ownerships_fixture_format CHECK (
    fixture_id ~ '^[a-z][a-z0-9_]{2,63}$'
  ),
  CONSTRAINT proofstack_interaction_ownerships_version_format CHECK (
    fixture_version_id ~ '^[a-z][a-z0-9_]{2,63}$'
  ),
  CONSTRAINT proofstack_interaction_fixture_artifact_ownerships_position CHECK (
    artifact_position BETWEEN 0 AND 2047
  ),
  CONSTRAINT proofstack_interaction_fixture_artifact_ownerships_schema CHECK (
    schema_version = '0.1'
  ),
  CONSTRAINT proofstack_interaction_fixture_artifact_ownerships_time CHECK (
    isfinite(bound_at)
    AND bound_at_lexical ~
      '^[0-9]{4}-(0[1-9]|1[0-2])-([0-2][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\.[0-9]{3}Z$'
    AND bound_at_lexical !~ '^0000-'
    AND bound_at = bound_at_lexical::timestamptz
  ),
  CONSTRAINT proofstack_interaction_fixture_artifact_ownerships_actor_format CHECK (
    bound_by_principal_id ~ '^[a-z][a-z0-9_]{2,63}$'
  )
);

CREATE TABLE public.proofstack_interaction_fixture_content_revocations (
  tenant_id varchar(64) NOT NULL,
  project_id varchar(64) NOT NULL,
  environment_id varchar(64) NOT NULL,
  fixture_id varchar(64) NOT NULL,
  fixture_version_id varchar(64) NOT NULL,
  revocation_id varchar(64) NOT NULL,
  schema_version varchar(16) NOT NULL,
  reason varchar(512) NOT NULL,
  revoked_at timestamptz NOT NULL,
  revoked_at_lexical text NOT NULL,
  revoked_by_principal_id varchar(64) NOT NULL,

  CONSTRAINT proofstack_interaction_fixture_content_revocations_pk PRIMARY KEY (
    tenant_id,
    fixture_version_id
  ),
  CONSTRAINT proofstack_interaction_fixture_content_revocations_id_unique UNIQUE (
    tenant_id,
    revocation_id
  ),
  CONSTRAINT proofstack_interaction_fixture_content_revocations_scope_unique UNIQUE (
    tenant_id,
    project_id,
    environment_id,
    fixture_id,
    fixture_version_id
  ),
  CONSTRAINT proofstack_interaction_fixture_content_revocations_fixture_fk FOREIGN KEY (
    tenant_id,
    project_id,
    environment_id,
    fixture_id,
    fixture_version_id
  ) REFERENCES public.proofstack_recorded_interaction_fixture_versions (
    tenant_id,
    project_id,
    environment_id,
    fixture_id,
    fixture_version_id
  ),
  CONSTRAINT proofstack_fixture_revocations_tenant_format CHECK (
    tenant_id ~ '^[a-z][a-z0-9_]{2,63}$'
  ),
  CONSTRAINT proofstack_fixture_revocations_project_format CHECK (
    project_id ~ '^[a-z][a-z0-9_]{2,63}$'
  ),
  CONSTRAINT proofstack_fixture_revocations_environment_format CHECK (
    environment_id ~ '^[a-z][a-z0-9_]{2,63}$'
  ),
  CONSTRAINT proofstack_fixture_revocations_fixture_format CHECK (
    fixture_id ~ '^[a-z][a-z0-9_]{2,63}$'
  ),
  CONSTRAINT proofstack_fixture_revocations_version_format CHECK (
    fixture_version_id ~ '^[a-z][a-z0-9_]{2,63}$'
  ),
  CONSTRAINT proofstack_interaction_fixture_content_revocations_id_format CHECK (
    revocation_id ~ '^[a-z][a-z0-9_]{2,63}$'
  ),
  CONSTRAINT proofstack_interaction_fixture_content_revocations_schema CHECK (
    schema_version = '0.1'
  ),
  CONSTRAINT proofstack_interaction_fixture_content_revocations_reason CHECK (
    length(reason) BETWEEN 1 AND 512
    AND reason = btrim(reason)
    AND reason !~ '[[:cntrl:]]'
  ),
  CONSTRAINT proofstack_interaction_fixture_content_revocations_time CHECK (
    isfinite(revoked_at)
    AND revoked_at_lexical ~
      '^[0-9]{4}-(0[1-9]|1[0-2])-([0-2][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\.[0-9]{3}Z$'
    AND revoked_at_lexical !~ '^0000-'
    AND revoked_at = revoked_at_lexical::timestamptz
  ),
  CONSTRAINT proofstack_interaction_fixture_content_revocations_actor_format CHECK (
    revoked_by_principal_id ~ '^[a-z][a-z0-9_]{2,63}$'
  )
);

CREATE FUNCTION public.proofstack_guard_interaction_fixture_ownership()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  artifact public.proofstack_artifact_catalog%ROWTYPE;
  expected_binding jsonb;
  fixture_created_at_lexical text;
  fixture_creator text;
  manifest jsonb;
BEGIN
  SELECT
    recorded.interaction_capture,
    version.created_at_lexical,
    version.created_by_principal_id
  INTO manifest, fixture_created_at_lexical, fixture_creator
  FROM public.proofstack_recorded_interaction_fixture_versions AS recorded
  JOIN public.proofstack_regression_fixture_versions AS version
    ON version.tenant_id = recorded.tenant_id
    AND version.project_id = recorded.project_id
    AND version.environment_id = recorded.environment_id
    AND version.fixture_id = recorded.fixture_id
    AND version.fixture_version_id = recorded.fixture_version_id
  WHERE recorded.tenant_id = NEW.tenant_id
    AND recorded.project_id = NEW.project_id
    AND recorded.environment_id = NEW.environment_id
    AND recorded.fixture_id = NEW.fixture_id
    AND recorded.fixture_version_id = NEW.fixture_version_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Interaction fixture ownership requires an exact recorded fixture version';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.proofstack_interaction_fixture_content_revocations AS revocation
    WHERE revocation.tenant_id = NEW.tenant_id
      AND revocation.fixture_version_id = NEW.fixture_version_id
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'Revoked interaction fixture ownership cannot be extended';
  END IF;

  expected_binding := manifest -> 'artifacts' -> NEW.artifact_position;
  IF expected_binding IS NULL
    OR jsonb_typeof(expected_binding) <> 'object'
    OR expected_binding #>> '{contentReference,artifactId}' IS DISTINCT FROM NEW.artifact_id
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Interaction fixture ownership does not match the ordered manifest';
  END IF;

  SELECT * INTO artifact
  FROM public.proofstack_artifact_catalog AS candidate
  WHERE candidate.tenant_id = NEW.tenant_id
    AND candidate.project_id = NEW.project_id
    AND candidate.environment_id = NEW.environment_id
    AND candidate.artifact_id = NEW.artifact_id
  FOR UPDATE;

  IF NOT FOUND
    OR artifact.state <> 'available'
    OR artifact.retention_mode <> 'retain'
    OR artifact.classification IS DISTINCT FROM
      expected_binding #>> '{contentReference,classification}'
    OR artifact.media_type IS DISTINCT FROM expected_binding #>> '{contentReference,mediaType}'
    OR artifact.content_sha256 IS DISTINCT FROM expected_binding #>> '{contentReference,sha256}'
    OR artifact.content_size_bytes::text IS DISTINCT FROM
      expected_binding #>> '{contentReference,sizeBytes}'
    OR artifact.redaction IS DISTINCT FROM expected_binding -> 'redaction'
    OR NEW.bound_at_lexical IS DISTINCT FROM fixture_created_at_lexical
    OR NEW.bound_by_principal_id IS DISTINCT FROM fixture_creator
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Interaction fixture ownership does not match the authoritative artifact';
  END IF;

  RETURN NEW;
END;
$$;

CREATE FUNCTION public.proofstack_verify_recorded_interaction_fixture()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  actual_ownership_count integer;
  expected_ownership_count integer;
  valid_predecessor boolean;
BEGIN
  IF NEW.replayability <> 'recorded_interactions' THEN
    RETURN NULL;
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.proofstack_regression_fixture_versions AS predecessor
    WHERE predecessor.tenant_id = NEW.tenant_id
      AND predecessor.project_id = NEW.project_id
      AND predecessor.environment_id = NEW.environment_id
      AND predecessor.fixture_id = NEW.fixture_id
      AND predecessor.fixture_version_id = NEW.predecessor_fixture_version_id
      AND predecessor.definition_sha256 = NEW.predecessor_definition_sha256
      AND predecessor.replayability = 'evidence_only'
      AND predecessor.schema_version = '0.1'
  ) INTO valid_predecessor;

  IF NOT valid_predecessor THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Recorded interaction fixture requires an exact evidence-only predecessor';
  END IF;

  SELECT jsonb_array_length(recorded.interaction_capture -> 'artifacts')
  INTO expected_ownership_count
  FROM public.proofstack_recorded_interaction_fixture_versions AS recorded
  WHERE recorded.tenant_id = NEW.tenant_id
    AND recorded.project_id = NEW.project_id
    AND recorded.environment_id = NEW.environment_id
    AND recorded.fixture_id = NEW.fixture_id
    AND recorded.fixture_version_id = NEW.fixture_version_id;

  IF expected_ownership_count IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Recorded interaction fixture is missing its manifest';
  END IF;

  SELECT count(*)::integer INTO actual_ownership_count
  FROM public.proofstack_interaction_fixture_artifact_ownerships AS ownership
  WHERE ownership.tenant_id = NEW.tenant_id
    AND ownership.project_id = NEW.project_id
    AND ownership.environment_id = NEW.environment_id
    AND ownership.fixture_id = NEW.fixture_id
    AND ownership.fixture_version_id = NEW.fixture_version_id;

  IF actual_ownership_count <> expected_ownership_count THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Recorded interaction fixture ownership is incomplete';
  END IF;

  RETURN NULL;
END;
$$;

CREATE FUNCTION public.proofstack_guard_interaction_fixture_tombstone()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  ownership public.proofstack_interaction_fixture_artifact_ownerships%ROWTYPE;
  revocation public.proofstack_interaction_fixture_content_revocations%ROWTYPE;
BEGIN
  SELECT * INTO ownership
  FROM public.proofstack_interaction_fixture_artifact_ownerships AS candidate
  WHERE candidate.tenant_id = NEW.tenant_id
    AND candidate.artifact_id = NEW.artifact_id;

  IF FOUND THEN
    IF NEW.tombstone_trigger <> 'fixture_revocation' THEN
      RAISE EXCEPTION USING
        ERRCODE = '55000',
        MESSAGE = 'Fixture-owned content requires coordinated fixture revocation';
    END IF;

    SELECT * INTO revocation
    FROM public.proofstack_interaction_fixture_content_revocations AS candidate
    WHERE candidate.tenant_id = ownership.tenant_id
      AND candidate.project_id = ownership.project_id
      AND candidate.environment_id = ownership.environment_id
      AND candidate.fixture_id = ownership.fixture_id
      AND candidate.fixture_version_id = ownership.fixture_version_id;

    IF NOT FOUND
      OR NEW.actor_principal_id IS DISTINCT FROM revocation.revoked_by_principal_id
      OR NEW.occurred_at IS DISTINCT FROM revocation.revoked_at
      OR NEW.reason IS DISTINCT FROM revocation.reason
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'Fixture revocation tombstone does not match immutable revocation provenance';
    END IF;
  ELSIF NEW.tombstone_trigger = 'fixture_revocation' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Fixture revocation tombstone requires recorded fixture ownership';
  END IF;

  RETURN NULL;
END;
$$;

CREATE FUNCTION public.proofstack_verify_interaction_fixture_revocation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  matching_tombstones integer;
  ownership_count integer;
BEGIN
  SELECT count(*)::integer INTO ownership_count
  FROM public.proofstack_interaction_fixture_artifact_ownerships AS ownership
  WHERE ownership.tenant_id = NEW.tenant_id
    AND ownership.project_id = NEW.project_id
    AND ownership.environment_id = NEW.environment_id
    AND ownership.fixture_id = NEW.fixture_id
    AND ownership.fixture_version_id = NEW.fixture_version_id;

  SELECT count(*)::integer INTO matching_tombstones
  FROM public.proofstack_interaction_fixture_artifact_ownerships AS ownership
  JOIN public.proofstack_artifact_tombstones AS tombstone
    ON tombstone.tenant_id = ownership.tenant_id
    AND tombstone.artifact_id = ownership.artifact_id
  JOIN public.proofstack_artifact_catalog AS artifact
    ON artifact.tenant_id = ownership.tenant_id
    AND artifact.artifact_id = ownership.artifact_id
  WHERE ownership.tenant_id = NEW.tenant_id
    AND ownership.project_id = NEW.project_id
    AND ownership.environment_id = NEW.environment_id
    AND ownership.fixture_id = NEW.fixture_id
    AND ownership.fixture_version_id = NEW.fixture_version_id
    AND tombstone.tombstone_trigger = 'fixture_revocation'
    AND tombstone.actor_principal_id = NEW.revoked_by_principal_id
    AND tombstone.occurred_at = NEW.revoked_at
    AND tombstone.reason = NEW.reason
    AND artifact.state IN ('tombstoned', 'purged')
    AND artifact.tombstoned_at = NEW.revoked_at;

  IF ownership_count = 0 OR matching_tombstones <> ownership_count THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Interaction fixture revocation must tombstone the complete owned content set';
  END IF;

  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.proofstack_guard_interaction_fixture_ownership() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.proofstack_verify_recorded_interaction_fixture() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.proofstack_guard_interaction_fixture_tombstone() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.proofstack_verify_interaction_fixture_revocation() FROM PUBLIC;

CREATE TRIGGER proofstack_interaction_fixture_ownership_guard
  BEFORE INSERT ON public.proofstack_interaction_fixture_artifact_ownerships
  FOR EACH ROW
  EXECUTE FUNCTION public.proofstack_guard_interaction_fixture_ownership();

CREATE CONSTRAINT TRIGGER proofstack_recorded_interaction_fixture_complete
  AFTER INSERT ON public.proofstack_regression_fixture_versions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION public.proofstack_verify_recorded_interaction_fixture();

CREATE CONSTRAINT TRIGGER proofstack_interaction_fixture_tombstone_guard
  AFTER INSERT ON public.proofstack_artifact_tombstones
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION public.proofstack_guard_interaction_fixture_tombstone();

CREATE CONSTRAINT TRIGGER proofstack_interaction_fixture_revocation_complete
  AFTER INSERT ON public.proofstack_interaction_fixture_content_revocations
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION public.proofstack_verify_interaction_fixture_revocation();

CREATE TRIGGER proofstack_recorded_interaction_fixture_versions_append_only
  BEFORE UPDATE OR DELETE ON public.proofstack_recorded_interaction_fixture_versions
  FOR EACH ROW
  EXECUTE FUNCTION public.proofstack_reject_append_only_mutation();

CREATE TRIGGER proofstack_interaction_fixture_artifact_ownerships_append_only
  BEFORE UPDATE OR DELETE ON public.proofstack_interaction_fixture_artifact_ownerships
  FOR EACH ROW
  EXECUTE FUNCTION public.proofstack_reject_append_only_mutation();

CREATE TRIGGER proofstack_interaction_fixture_content_revocations_append_only
  BEFORE UPDATE OR DELETE ON public.proofstack_interaction_fixture_content_revocations
  FOR EACH ROW
  EXECUTE FUNCTION public.proofstack_reject_append_only_mutation();

ALTER TABLE public.proofstack_recorded_interaction_fixture_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.proofstack_recorded_interaction_fixture_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE public.proofstack_interaction_fixture_artifact_ownerships ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.proofstack_interaction_fixture_artifact_ownerships FORCE ROW LEVEL SECURITY;
ALTER TABLE public.proofstack_interaction_fixture_content_revocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.proofstack_interaction_fixture_content_revocations FORCE ROW LEVEL SECURITY;

CREATE POLICY proofstack_recorded_interaction_fixture_versions_tenant_select
  ON public.proofstack_recorded_interaction_fixture_versions
  FOR SELECT
  USING (tenant_id = NULLIF(current_setting('proofstack.tenant_id', true), ''));

CREATE POLICY proofstack_recorded_interaction_fixture_versions_tenant_insert
  ON public.proofstack_recorded_interaction_fixture_versions
  FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('proofstack.tenant_id', true), ''));

CREATE POLICY proofstack_interaction_ownerships_tenant_select
  ON public.proofstack_interaction_fixture_artifact_ownerships
  FOR SELECT
  USING (tenant_id = NULLIF(current_setting('proofstack.tenant_id', true), ''));

CREATE POLICY proofstack_interaction_ownerships_tenant_insert
  ON public.proofstack_interaction_fixture_artifact_ownerships
  FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('proofstack.tenant_id', true), ''));

CREATE POLICY proofstack_fixture_revocations_tenant_select
  ON public.proofstack_interaction_fixture_content_revocations
  FOR SELECT
  USING (tenant_id = NULLIF(current_setting('proofstack.tenant_id', true), ''));

CREATE POLICY proofstack_fixture_revocations_tenant_insert
  ON public.proofstack_interaction_fixture_content_revocations
  FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('proofstack.tenant_id', true), ''));

REVOKE ALL ON TABLE
  public.proofstack_recorded_interaction_fixture_versions,
  public.proofstack_interaction_fixture_artifact_ownerships,
  public.proofstack_interaction_fixture_content_revocations
FROM PUBLIC;
