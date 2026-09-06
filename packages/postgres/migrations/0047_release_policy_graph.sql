CREATE TABLE public.proofstack_release_policy_registry (
  tenant_id varchar(64) NOT NULL,
  project_id varchar(64) NOT NULL,
  environment_id varchar(64) NOT NULL,
  policy_version_id varchar(64) NOT NULL,
  schema_version varchar(16) NOT NULL,
  definition_sha256 character(64) NOT NULL,

  CONSTRAINT proofstack_release_policy_registry_pk PRIMARY KEY (
    tenant_id, policy_version_id
  ),
  CONSTRAINT proofstack_release_policy_registry_scope_digest_unique UNIQUE (
    tenant_id, project_id, environment_id, policy_version_id, definition_sha256
  ),
  CONSTRAINT proofstack_release_policy_registry_tenant_format CHECK (
    tenant_id ~ '^[a-z][a-z0-9_]{2,63}$'
  ),
  CONSTRAINT proofstack_release_policy_registry_project_format CHECK (
    project_id ~ '^[a-z][a-z0-9_]{2,63}$'
  ),
  CONSTRAINT proofstack_release_policy_registry_environment_format CHECK (
    environment_id ~ '^[a-z][a-z0-9_]{2,63}$'
  ),
  CONSTRAINT proofstack_release_policy_registry_id_format CHECK (
    policy_version_id ~ '^[a-z][a-z0-9_]{2,63}$'
  ),
  CONSTRAINT proofstack_release_policy_registry_version CHECK (
    schema_version = '0.1'
  ),
  CONSTRAINT proofstack_release_policy_registry_digest CHECK (
    definition_sha256 ~ '^[0-9a-f]{64}$'
  )
);

CREATE TABLE public.proofstack_release_policy_resources (
  tenant_id varchar(64) NOT NULL,
  project_id varchar(64) NOT NULL,
  environment_id varchar(64) NOT NULL,
  policy_id varchar(64) NOT NULL,
  root_policy_version_id varchar(64) NOT NULL,
  root_definition_sha256 character(64) NOT NULL,

  CONSTRAINT proofstack_release_policy_resources_pk PRIMARY KEY (tenant_id, policy_id),
  CONSTRAINT proofstack_release_policy_resources_scope_unique UNIQUE (
    tenant_id, project_id, environment_id, policy_id
  ),
  CONSTRAINT proofstack_release_policy_resources_root_fk FOREIGN KEY (
    tenant_id,
    project_id,
    environment_id,
    root_policy_version_id,
    root_definition_sha256
  ) REFERENCES public.proofstack_release_policy_registry (
    tenant_id,
    project_id,
    environment_id,
    policy_version_id,
    definition_sha256
  ) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT proofstack_release_policy_resources_id_format CHECK (
    policy_id ~ '^[a-z][a-z0-9_]{2,63}$'
  )
);

CREATE TABLE public.proofstack_release_policy_lineage (
  tenant_id varchar(64) NOT NULL,
  project_id varchar(64) NOT NULL,
  environment_id varchar(64) NOT NULL,
  child_policy_version_id varchar(64) NOT NULL,
  child_definition_sha256 character(64) NOT NULL,
  parent_policy_version_id varchar(64) NOT NULL,
  parent_definition_sha256 character(64) NOT NULL,

  CONSTRAINT proofstack_release_policy_lineage_pk PRIMARY KEY (
    tenant_id, child_policy_version_id
  ),
  CONSTRAINT proofstack_release_policy_lineage_child_fk FOREIGN KEY (
    tenant_id,
    project_id,
    environment_id,
    child_policy_version_id,
    child_definition_sha256
  ) REFERENCES public.proofstack_release_policy_registry (
    tenant_id,
    project_id,
    environment_id,
    policy_version_id,
    definition_sha256
  ) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT proofstack_release_policy_lineage_parent_fk FOREIGN KEY (
    tenant_id,
    project_id,
    environment_id,
    parent_policy_version_id,
    parent_definition_sha256
  ) REFERENCES public.proofstack_release_policy_registry (
    tenant_id,
    project_id,
    environment_id,
    policy_version_id,
    definition_sha256
  ) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT proofstack_release_policy_lineage_not_self CHECK (
    child_policy_version_id IS DISTINCT FROM parent_policy_version_id
  )
);

CREATE INDEX proofstack_release_policy_lineage_parent_idx
  ON public.proofstack_release_policy_lineage (tenant_id, parent_policy_version_id);

CREATE TABLE public.proofstack_release_policies (
  tenant_id varchar(64) NOT NULL,
  project_id varchar(64) NOT NULL,
  environment_id varchar(64) NOT NULL,
  policy_id varchar(64) NOT NULL,
  policy_version_id varchar(64) NOT NULL,
  schema_version varchar(16) NOT NULL,
  definition_sha256 character(64) NOT NULL,
  semantic_version varchar(128) NOT NULL,
  mode varchar(16) NOT NULL,
  effective_at timestamptz NOT NULL,
  effective_at_lexical text NOT NULL,
  expires_at timestamptz NOT NULL,
  expires_at_lexical text NOT NULL,
  published_at timestamptz NOT NULL,
  published_at_lexical text NOT NULL,
  published_by_principal_id varchar(64) NOT NULL,
  source_count smallint NOT NULL,
  counterevidence_count smallint NOT NULL,
  rule_count smallint NOT NULL,
  lineage_count smallint NOT NULL,
  record jsonb NOT NULL,

  CONSTRAINT proofstack_release_policies_pk PRIMARY KEY (tenant_id, policy_version_id),
  CONSTRAINT proofstack_release_policies_registry_fk FOREIGN KEY (
    tenant_id,
    project_id,
    environment_id,
    policy_version_id,
    definition_sha256
  ) REFERENCES public.proofstack_release_policy_registry (
    tenant_id,
    project_id,
    environment_id,
    policy_version_id,
    definition_sha256
  ) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT proofstack_release_policies_common_projection CHECK (
    jsonb_typeof(record) = 'object'
    AND record ->> 'policyId' = policy_id
    AND record ->> 'policyVersionId' = policy_version_id
    AND record ->> 'schemaVersion' = schema_version
    AND record ->> 'definitionSha256' = definition_sha256
    AND record ->> 'semanticVersion' = semantic_version
    AND record ->> 'mode' = mode
    AND jsonb_typeof(record -> 'scope') = 'object'
    AND record #>> '{scope,tenantId}' = tenant_id
    AND record #>> '{scope,projectId}' = project_id
    AND record #>> '{scope,environmentId}' = environment_id
    AND record ->> 'effectiveAt' = effective_at_lexical
    AND record ->> 'expiresAt' = expires_at_lexical
    AND record ->> 'publishedAt' = published_at_lexical
    AND record ->> 'publishedByPrincipalId' = published_by_principal_id
    AND record ->> 'issuerPrincipalId' = published_by_principal_id
    AND jsonb_typeof(record -> 'sources') = 'array'
    AND jsonb_typeof(record -> 'counterevidence') = 'array'
    AND jsonb_typeof(record -> 'rules') = 'array'
  ),
  CONSTRAINT proofstack_release_policies_time_projection CHECK (
    isfinite(effective_at)
    AND isfinite(expires_at)
    AND isfinite(published_at)
    AND effective_at_lexical ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
    AND expires_at_lexical ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
    AND published_at_lexical ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
    AND effective_at = effective_at_lexical::timestamptz
    AND expires_at = expires_at_lexical::timestamptz
    AND published_at = published_at_lexical::timestamptz
    AND effective_at < expires_at
    AND published_at < expires_at
  ),
  CONSTRAINT proofstack_release_policies_policy_id_format CHECK (
    policy_id ~ '^[a-z][a-z0-9_]{2,63}$'
  ),
  CONSTRAINT proofstack_release_policies_principal_format CHECK (
    published_by_principal_id ~ '^[a-z][a-z0-9_]{2,63}$'
  ),
  CONSTRAINT proofstack_release_policies_semantic_version_format CHECK (
    semantic_version ~ '^(0|[1-9][0-9]*)[.](0|[1-9][0-9]*)[.](0|[1-9][0-9]*)(-[0-9a-z-]+([.][0-9a-z-]+)*)?$'
  ),
  CONSTRAINT proofstack_release_policies_mode CHECK (mode IN ('advisory', 'mandatory')),
  CONSTRAINT proofstack_release_policies_projection_counts CHECK (
    source_count BETWEEN 1 AND 64
    AND source_count = jsonb_array_length(record -> 'sources')
    AND counterevidence_count BETWEEN 0 AND 64
    AND counterevidence_count = jsonb_array_length(record -> 'counterevidence')
    AND rule_count BETWEEN 1 AND 128
    AND rule_count = jsonb_array_length(record -> 'rules')
    AND lineage_count IN (0, 1)
    AND lineage_count = CASE WHEN record ? 'predecessor' THEN 1 ELSE 0 END
  ),
  CONSTRAINT proofstack_release_policies_predecessor_identity CHECK (
    NOT (record ? 'predecessor') OR record #>> '{predecessor,policyId}' = policy_id
  )
);

CREATE TABLE public.proofstack_release_policy_sources (
  tenant_id varchar(64) NOT NULL,
  project_id varchar(64) NOT NULL,
  environment_id varchar(64) NOT NULL,
  policy_version_id varchar(64) NOT NULL,
  policy_definition_sha256 character(64) NOT NULL,
  collection varchar(32) NOT NULL,
  source_position smallint NOT NULL,
  source_snapshot_id varchar(64) NOT NULL,
  source_definition_sha256 character(64) NOT NULL,
  source_review_id varchar(64) NOT NULL,
  review_definition_sha256 character(64) NOT NULL,
  reference jsonb NOT NULL,

  CONSTRAINT proofstack_release_policy_sources_pk PRIMARY KEY (
    tenant_id, policy_version_id, collection, source_position
  ),
  CONSTRAINT proofstack_release_policy_sources_registry_fk FOREIGN KEY (
    tenant_id,
    project_id,
    environment_id,
    policy_version_id,
    policy_definition_sha256
  ) REFERENCES public.proofstack_release_policy_registry (
    tenant_id,
    project_id,
    environment_id,
    policy_version_id,
    definition_sha256
  ) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT proofstack_release_policy_sources_collection CHECK (
    collection IN ('sources', 'counterevidence')
  ),
  CONSTRAINT proofstack_release_policy_sources_position CHECK (
    source_position BETWEEN 1 AND 64
  ),
  CONSTRAINT proofstack_release_policy_sources_reference CHECK (
    jsonb_typeof(reference) = 'object'
    AND reference #>> '{source,sourceSnapshotId}' = source_snapshot_id
    AND reference #>> '{source,definitionSha256}' = source_definition_sha256
    AND reference #>> '{review,sourceReviewId}' = source_review_id
    AND reference #>> '{review,definitionSha256}' = review_definition_sha256
  ),
  CONSTRAINT proofstack_release_policy_sources_ids CHECK (
    source_snapshot_id ~ '^[a-z][a-z0-9_]{2,63}$'
    AND source_review_id ~ '^[a-z][a-z0-9_]{2,63}$'
    AND source_definition_sha256 ~ '^[0-9a-f]{64}$'
    AND review_definition_sha256 ~ '^[0-9a-f]{64}$'
  )
);

CREATE TABLE public.proofstack_release_policy_rules (
  tenant_id varchar(64) NOT NULL,
  project_id varchar(64) NOT NULL,
  environment_id varchar(64) NOT NULL,
  policy_version_id varchar(64) NOT NULL,
  policy_definition_sha256 character(64) NOT NULL,
  rule_position smallint NOT NULL,
  rule_id varchar(64) NOT NULL,
  predicate_kind varchar(64) NOT NULL,
  severity varchar(16) NOT NULL,
  non_waivable boolean NOT NULL,
  source_count smallint NOT NULL,
  rule jsonb NOT NULL,

  CONSTRAINT proofstack_release_policy_rules_pk PRIMARY KEY (
    tenant_id, policy_version_id, rule_position
  ),
  CONSTRAINT proofstack_release_policy_rules_identity_unique UNIQUE (
    tenant_id, policy_version_id, rule_id
  ),
  CONSTRAINT proofstack_release_policy_rules_registry_fk FOREIGN KEY (
    tenant_id,
    project_id,
    environment_id,
    policy_version_id,
    policy_definition_sha256
  ) REFERENCES public.proofstack_release_policy_registry (
    tenant_id,
    project_id,
    environment_id,
    policy_version_id,
    definition_sha256
  ) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT proofstack_release_policy_rules_position CHECK (rule_position BETWEEN 1 AND 128),
  CONSTRAINT proofstack_release_policy_rules_projection CHECK (
    jsonb_typeof(rule) = 'object'
    AND rule ->> 'ruleId' = rule_id
    AND rule #>> '{predicate,kind}' = predicate_kind
    AND rule ->> 'severity' = severity
    AND (rule ->> 'nonWaivable')::boolean = non_waivable
    AND jsonb_typeof(rule -> 'sources') = 'array'
    AND source_count BETWEEN 1 AND 64
    AND source_count = jsonb_array_length(rule -> 'sources')
  ),
  CONSTRAINT proofstack_release_policy_rules_values CHECK (
    rule_id ~ '^[a-z][a-z0-9_]{2,63}$'
    AND predicate_kind ~ '^[a-z][a-z0-9_]{2,63}$'
    AND severity IN ('info', 'low', 'medium', 'high', 'critical')
  )
);

CREATE TABLE public.proofstack_release_policy_rule_sources (
  tenant_id varchar(64) NOT NULL,
  project_id varchar(64) NOT NULL,
  environment_id varchar(64) NOT NULL,
  policy_version_id varchar(64) NOT NULL,
  policy_definition_sha256 character(64) NOT NULL,
  rule_position smallint NOT NULL,
  source_position smallint NOT NULL,
  source_snapshot_id varchar(64) NOT NULL,
  source_definition_sha256 character(64) NOT NULL,
  source_review_id varchar(64) NOT NULL,
  review_definition_sha256 character(64) NOT NULL,
  reference jsonb NOT NULL,

  CONSTRAINT proofstack_release_policy_rule_sources_pk PRIMARY KEY (
    tenant_id, policy_version_id, rule_position, source_position
  ),
  CONSTRAINT proofstack_release_policy_rule_sources_rule_fk FOREIGN KEY (
    tenant_id, policy_version_id, rule_position
  ) REFERENCES public.proofstack_release_policy_rules (
    tenant_id, policy_version_id, rule_position
  ) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT proofstack_release_policy_rule_sources_registry_fk FOREIGN KEY (
    tenant_id,
    project_id,
    environment_id,
    policy_version_id,
    policy_definition_sha256
  ) REFERENCES public.proofstack_release_policy_registry (
    tenant_id,
    project_id,
    environment_id,
    policy_version_id,
    definition_sha256
  ) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT proofstack_release_policy_rule_sources_position CHECK (
    rule_position BETWEEN 1 AND 128 AND source_position BETWEEN 1 AND 64
  ),
  CONSTRAINT proofstack_release_policy_rule_sources_reference CHECK (
    jsonb_typeof(reference) = 'object'
    AND reference #>> '{source,sourceSnapshotId}' = source_snapshot_id
    AND reference #>> '{source,definitionSha256}' = source_definition_sha256
    AND reference #>> '{review,sourceReviewId}' = source_review_id
    AND reference #>> '{review,definitionSha256}' = review_definition_sha256
  ),
  CONSTRAINT proofstack_release_policy_rule_sources_ids CHECK (
    source_snapshot_id ~ '^[a-z][a-z0-9_]{2,63}$'
    AND source_review_id ~ '^[a-z][a-z0-9_]{2,63}$'
    AND source_definition_sha256 ~ '^[0-9a-f]{64}$'
    AND review_definition_sha256 ~ '^[0-9a-f]{64}$'
  )
);

CREATE TABLE public.proofstack_release_policy_lifecycle_events (
  tenant_id varchar(64) NOT NULL,
  project_id varchar(64) NOT NULL,
  environment_id varchar(64) NOT NULL,
  event_id varchar(64) NOT NULL,
  schema_version varchar(16) NOT NULL,
  kind varchar(16) NOT NULL,
  policy_id varchar(64) NOT NULL,
  policy_version_id varchar(64) NOT NULL,
  policy_definition_sha256 character(64) NOT NULL,
  successor_policy_id varchar(64),
  successor_policy_version_id varchar(64),
  successor_definition_sha256 character(64),
  actor_principal_id varchar(64) NOT NULL,
  occurred_at timestamptz NOT NULL,
  occurred_at_lexical text NOT NULL,
  reason text NOT NULL,
  record jsonb NOT NULL,

  CONSTRAINT proofstack_release_policy_lifecycle_events_pk PRIMARY KEY (tenant_id, event_id),
  CONSTRAINT proofstack_release_policy_lifecycle_events_terminal_unique UNIQUE (
    tenant_id, policy_version_id
  ),
  CONSTRAINT proofstack_release_policy_lifecycle_events_policy_fk FOREIGN KEY (
    tenant_id,
    project_id,
    environment_id,
    policy_version_id,
    policy_definition_sha256
  ) REFERENCES public.proofstack_release_policy_registry (
    tenant_id,
    project_id,
    environment_id,
    policy_version_id,
    definition_sha256
  ) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT proofstack_release_policy_lifecycle_events_successor_fk FOREIGN KEY (
    tenant_id,
    project_id,
    environment_id,
    successor_policy_version_id,
    successor_definition_sha256
  ) REFERENCES public.proofstack_release_policy_registry (
    tenant_id,
    project_id,
    environment_id,
    policy_version_id,
    definition_sha256
  ) MATCH FULL DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT proofstack_release_policy_lifecycle_events_projection CHECK (
    jsonb_typeof(record) = 'object'
    AND record ->> 'eventId' = event_id
    AND record ->> 'schemaVersion' = schema_version
    AND record ->> 'kind' = kind
    AND record #>> '{scope,tenantId}' = tenant_id
    AND record #>> '{scope,projectId}' = project_id
    AND record #>> '{scope,environmentId}' = environment_id
    AND record #>> '{policy,policyId}' = policy_id
    AND record #>> '{policy,policyVersionId}' = policy_version_id
    AND record #>> '{policy,definitionSha256}' = policy_definition_sha256
    AND record ->> 'actorPrincipalId' = actor_principal_id
    AND record ->> 'occurredAt' = occurred_at_lexical
    AND record ->> 'reason' = reason
  ),
  CONSTRAINT proofstack_release_policy_lifecycle_events_successor CHECK (
    (
      kind = 'withdrawn'
      AND successor_policy_id IS NULL
      AND successor_policy_version_id IS NULL
      AND successor_definition_sha256 IS NULL
      AND NOT (record ? 'successor')
    )
    OR (
      kind = 'superseded'
      AND successor_policy_id IS NOT NULL
      AND successor_policy_version_id IS NOT NULL
      AND successor_definition_sha256 IS NOT NULL
      AND record #>> '{successor,policyId}' = successor_policy_id
      AND record #>> '{successor,policyVersionId}' = successor_policy_version_id
      AND record #>> '{successor,definitionSha256}' = successor_definition_sha256
      AND successor_policy_id = policy_id
      AND successor_policy_version_id IS DISTINCT FROM policy_version_id
    )
  ),
  CONSTRAINT proofstack_release_policy_lifecycle_events_values CHECK (
    schema_version = '0.1'
    AND event_id ~ '^[a-z][a-z0-9_]{2,63}$'
    AND policy_id ~ '^[a-z][a-z0-9_]{2,63}$'
    AND actor_principal_id ~ '^[a-z][a-z0-9_]{2,63}$'
    AND policy_definition_sha256 ~ '^[0-9a-f]{64}$'
    AND (successor_definition_sha256 IS NULL OR successor_definition_sha256 ~ '^[0-9a-f]{64}$')
    AND char_length(reason) BETWEEN 1 AND 2048
  ),
  CONSTRAINT proofstack_release_policy_lifecycle_events_time CHECK (
    isfinite(occurred_at)
    AND occurred_at_lexical ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
    AND occurred_at = occurred_at_lexical::timestamptz
  )
);

CREATE INDEX proofstack_release_policy_lifecycle_events_order_idx
  ON public.proofstack_release_policy_lifecycle_events (
    tenant_id, project_id, environment_id, policy_version_id, occurred_at, event_id
  );

CREATE FUNCTION public.proofstack_verify_release_policy_graph()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  body jsonb;
  expected_lineage_count integer;
  policy_digest text;
BEGIN
  policy_digest := COALESCE(
    to_jsonb(NEW) ->> 'policy_definition_sha256',
    to_jsonb(NEW) ->> 'definition_sha256'
  );

  SELECT policy.record, policy.lineage_count
  INTO body, expected_lineage_count
  FROM public.proofstack_release_policies AS policy
  WHERE policy.tenant_id = NEW.tenant_id
    AND policy.project_id = NEW.project_id
    AND policy.environment_id = NEW.environment_id
    AND policy.policy_version_id = NEW.policy_version_id
    AND policy.definition_sha256 = policy_digest;

  IF body IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Release policy graph requires one exact canonical body';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.proofstack_release_policy_registry AS registry
    WHERE registry.tenant_id = NEW.tenant_id
      AND registry.project_id = NEW.project_id
      AND registry.environment_id = NEW.environment_id
      AND registry.policy_version_id = NEW.policy_version_id
      AND registry.definition_sha256 = policy_digest
  ) OR NOT EXISTS (
    SELECT 1
    FROM public.proofstack_release_policy_resources AS resource
    WHERE resource.tenant_id = NEW.tenant_id
      AND resource.project_id = NEW.project_id
      AND resource.environment_id = NEW.environment_id
      AND resource.policy_id = body ->> 'policyId'
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Release policy registry or resource projection is incomplete';
  END IF;

  IF (SELECT count(*) FROM public.proofstack_release_policy_lineage AS edge
      WHERE edge.tenant_id = NEW.tenant_id
        AND edge.child_policy_version_id = NEW.policy_version_id) IS DISTINCT FROM expected_lineage_count
    OR (
      body ? 'predecessor'
      AND NOT EXISTS (
        SELECT 1
        FROM public.proofstack_release_policy_lineage AS edge
        WHERE edge.tenant_id = NEW.tenant_id
          AND edge.project_id = NEW.project_id
          AND edge.environment_id = NEW.environment_id
          AND edge.child_policy_version_id = NEW.policy_version_id
          AND edge.child_definition_sha256 = policy_digest
          AND edge.parent_policy_version_id = body #>> '{predecessor,policyVersionId}'
          AND edge.parent_definition_sha256 = body #>> '{predecessor,definitionSha256}'
      )
    )
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Release policy lineage projection is incomplete or conflicting';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      SELECT 'sources'::text AS collection, reference, position
      FROM jsonb_array_elements(body -> 'sources') WITH ORDINALITY AS item(reference, position)
      UNION ALL
      SELECT 'counterevidence'::text AS collection, reference, position
      FROM jsonb_array_elements(body -> 'counterevidence')
        WITH ORDINALITY AS item(reference, position)
    ) AS expected
    FULL JOIN (
      SELECT *
      FROM public.proofstack_release_policy_sources AS projection
      WHERE projection.tenant_id = NEW.tenant_id
        AND projection.policy_version_id = NEW.policy_version_id
    ) AS actual
      ON actual.collection = expected.collection
      AND actual.source_position = expected.position
    WHERE expected.reference IS DISTINCT FROM actual.reference
      OR actual.project_id IS DISTINCT FROM NEW.project_id
      OR actual.environment_id IS DISTINCT FROM NEW.environment_id
      OR actual.policy_definition_sha256 IS DISTINCT FROM policy_digest
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Release policy source projection is incomplete or conflicting';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(body -> 'rules') WITH ORDINALITY AS expected(rule, position)
    FULL JOIN (
      SELECT *
      FROM public.proofstack_release_policy_rules AS projection
      WHERE projection.tenant_id = NEW.tenant_id
        AND projection.policy_version_id = NEW.policy_version_id
    ) AS actual
      ON actual.rule_position = expected.position
    WHERE expected.rule IS DISTINCT FROM actual.rule
      OR actual.project_id IS DISTINCT FROM NEW.project_id
      OR actual.environment_id IS DISTINCT FROM NEW.environment_id
      OR actual.policy_definition_sha256 IS DISTINCT FROM policy_digest
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Release policy rule projection is incomplete or conflicting';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(body -> 'rules') WITH ORDINALITY AS policy_rule(rule, rule_position)
    CROSS JOIN LATERAL jsonb_array_elements(policy_rule.rule -> 'sources')
      WITH ORDINALITY AS expected(reference, source_position)
    FULL JOIN (
      SELECT *
      FROM public.proofstack_release_policy_rule_sources AS projection
      WHERE projection.tenant_id = NEW.tenant_id
        AND projection.policy_version_id = NEW.policy_version_id
    ) AS actual
      ON actual.rule_position = policy_rule.rule_position
      AND actual.source_position = expected.source_position
    WHERE expected.reference IS DISTINCT FROM actual.reference
      OR actual.project_id IS DISTINCT FROM NEW.project_id
      OR actual.environment_id IS DISTINCT FROM NEW.environment_id
      OR actual.policy_definition_sha256 IS DISTINCT FROM policy_digest
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Release policy rule source projection is incomplete or conflicting';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.proofstack_outbox AS intent
    WHERE intent.tenant_id = NEW.tenant_id
      AND intent.event_type = 'policy.definition.published'
      AND intent.aggregate_type = 'release_policy'
      AND intent.aggregate_id = NEW.policy_version_id
      AND intent.schema_version = body ->> 'schemaVersion'
      AND intent.payload = jsonb_build_object('recordKind', 'release_policy', 'record', body)
      AND intent.created_at = (body ->> 'publishedAt')::timestamptz
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Release policy graph requires one canonical publication intent';
  END IF;
  RETURN NULL;
END;
$$;

CREATE FUNCTION public.proofstack_verify_release_policy_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  target public.proofstack_release_policies%ROWTYPE;
  successor public.proofstack_release_policies%ROWTYPE;
BEGIN
  SELECT * INTO target
  FROM public.proofstack_release_policies AS policy
  WHERE policy.tenant_id = NEW.tenant_id
    AND policy.project_id = NEW.project_id
    AND policy.environment_id = NEW.environment_id
    AND policy.policy_id = NEW.policy_id
    AND policy.policy_version_id = NEW.policy_version_id
    AND policy.definition_sha256 = NEW.policy_definition_sha256;
  IF NOT FOUND OR NEW.occurred_at < target.published_at THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Release policy lifecycle target or timeline is invalid';
  END IF;

  IF NEW.kind = 'superseded' THEN
    SELECT * INTO successor
    FROM public.proofstack_release_policies AS policy
    WHERE policy.tenant_id = NEW.tenant_id
      AND policy.project_id = NEW.project_id
      AND policy.environment_id = NEW.environment_id
      AND policy.policy_id = NEW.successor_policy_id
      AND policy.policy_version_id = NEW.successor_policy_version_id
      AND policy.definition_sha256 = NEW.successor_definition_sha256;
    IF NOT FOUND
      OR NEW.occurred_at < successor.published_at
      OR successor.record #>> '{predecessor,policyId}' IS DISTINCT FROM NEW.policy_id
      OR successor.record #>> '{predecessor,policyVersionId}' IS DISTINCT FROM NEW.policy_version_id
      OR successor.record #>> '{predecessor,definitionSha256}' IS DISTINCT FROM NEW.policy_definition_sha256
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'Release policy lifecycle successor lineage is invalid';
    END IF;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.proofstack_outbox AS intent
    WHERE intent.tenant_id = NEW.tenant_id
      AND intent.event_type = 'policy.lifecycle.recorded'
      AND intent.aggregate_type = 'release_policy_lifecycle'
      AND intent.aggregate_id = NEW.event_id
      AND intent.schema_version = NEW.schema_version
      AND intent.payload = jsonb_build_object(
        'recordKind', 'release_policy_lifecycle', 'record', NEW.record
      )
      AND intent.created_at = NEW.occurred_at
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Release policy lifecycle requires one canonical publication intent';
  END IF;
  RETURN NULL;
END;
$$;

CREATE FUNCTION public.proofstack_insert_release_policy(command jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  tenant text := command ->> 'tenantId';
  project text := command ->> 'projectId';
  environment text := command ->> 'environmentId';
  policy text := command ->> 'policyId';
  policy_version text := command ->> 'policyVersionId';
  digest text := command ->> 'definitionSha256';
  body jsonb := command -> 'record';
  predecessor_version text := body #>> '{predecessor,policyVersionId}';
  predecessor_digest text := body #>> '{predecessor,definitionSha256}';
  reference_count smallint := CASE WHEN body ? 'predecessor' THEN 1 ELSE 0 END;
BEGIN
  IF jsonb_typeof(command) IS DISTINCT FROM 'object'
    OR tenant IS NULL
    OR tenant IS DISTINCT FROM NULLIF(current_setting('proofstack.tenant_id', true), '')
    OR project IS DISTINCT FROM NULLIF(current_setting('proofstack.project_id', true), '')
    OR environment IS DISTINCT FROM NULLIF(current_setting('proofstack.environment_id', true), '')
    OR jsonb_typeof(body) IS DISTINCT FROM 'object'
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'Release policy persistence command is malformed or outside the active scope';
  END IF;

  INSERT INTO public.proofstack_release_policy_registry (
    tenant_id, project_id, environment_id, policy_version_id, schema_version, definition_sha256
  ) VALUES (
    tenant, project, environment, policy_version, command ->> 'schemaVersion', digest
  );

  IF body ? 'predecessor' AND NOT EXISTS (
    SELECT 1
    FROM public.proofstack_release_policies AS predecessor
    WHERE predecessor.tenant_id = tenant
      AND predecessor.project_id = project
      AND predecessor.environment_id = environment
      AND predecessor.policy_id = policy
      AND predecessor.policy_version_id = predecessor_version
      AND predecessor.definition_sha256 = predecessor_digest
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23503',
      MESSAGE = 'Release policy contains unavailable or conflicting exact lineage';
  END IF;

  IF body ? 'predecessor' THEN
    INSERT INTO public.proofstack_release_policy_lineage (
      tenant_id, project_id, environment_id, child_policy_version_id,
      child_definition_sha256, parent_policy_version_id, parent_definition_sha256
    ) VALUES (
      tenant, project, environment, policy_version, digest,
      predecessor_version, predecessor_digest
    );
  END IF;

  INSERT INTO public.proofstack_release_policies (
    tenant_id, project_id, environment_id, policy_id, policy_version_id,
    schema_version, definition_sha256, semantic_version, mode,
    effective_at, effective_at_lexical, expires_at, expires_at_lexical,
    published_at, published_at_lexical, published_by_principal_id,
    source_count, counterevidence_count, rule_count, lineage_count, record
  ) VALUES (
    tenant, project, environment, policy, policy_version,
    command ->> 'schemaVersion', digest, body ->> 'semanticVersion', body ->> 'mode',
    (body ->> 'effectiveAt')::timestamptz, body ->> 'effectiveAt',
    (body ->> 'expiresAt')::timestamptz, body ->> 'expiresAt',
    (command ->> 'publishedAt')::timestamptz, command ->> 'publishedAt',
    command ->> 'publishedByPrincipalId', jsonb_array_length(body -> 'sources'),
    jsonb_array_length(body -> 'counterevidence'), jsonb_array_length(body -> 'rules'),
    reference_count, body
  );

  INSERT INTO public.proofstack_release_policy_sources (
    tenant_id, project_id, environment_id, policy_version_id,
    policy_definition_sha256, collection, source_position,
    source_snapshot_id, source_definition_sha256, source_review_id,
    review_definition_sha256, reference
  )
  SELECT
    tenant, project, environment, policy_version, digest, source.collection,
    source.position::smallint, source.reference #>> '{source,sourceSnapshotId}',
    source.reference #>> '{source,definitionSha256}',
    source.reference #>> '{review,sourceReviewId}',
    source.reference #>> '{review,definitionSha256}', source.reference
  FROM (
    SELECT 'sources'::text AS collection, reference, position
    FROM jsonb_array_elements(body -> 'sources') WITH ORDINALITY AS item(reference, position)
    UNION ALL
    SELECT 'counterevidence'::text AS collection, reference, position
    FROM jsonb_array_elements(body -> 'counterevidence')
      WITH ORDINALITY AS item(reference, position)
  ) AS source;

  INSERT INTO public.proofstack_release_policy_rules (
    tenant_id, project_id, environment_id, policy_version_id,
    policy_definition_sha256, rule_position, rule_id, predicate_kind,
    severity, non_waivable, source_count, rule
  )
  SELECT
    tenant, project, environment, policy_version, digest, position::smallint,
    rule ->> 'ruleId', rule #>> '{predicate,kind}', rule ->> 'severity',
    (rule ->> 'nonWaivable')::boolean, jsonb_array_length(rule -> 'sources'), rule
  FROM jsonb_array_elements(body -> 'rules') WITH ORDINALITY AS item(rule, position);

  INSERT INTO public.proofstack_release_policy_rule_sources (
    tenant_id, project_id, environment_id, policy_version_id,
    policy_definition_sha256, rule_position, source_position,
    source_snapshot_id, source_definition_sha256, source_review_id,
    review_definition_sha256, reference
  )
  SELECT
    tenant, project, environment, policy_version, digest,
    policy_rule.position::smallint, source.position::smallint,
    source.reference #>> '{source,sourceSnapshotId}',
    source.reference #>> '{source,definitionSha256}',
    source.reference #>> '{review,sourceReviewId}',
    source.reference #>> '{review,definitionSha256}', source.reference
  FROM jsonb_array_elements(body -> 'rules')
    WITH ORDINALITY AS policy_rule(rule, position)
  CROSS JOIN LATERAL jsonb_array_elements(policy_rule.rule -> 'sources')
    WITH ORDINALITY AS source(reference, position);

  INSERT INTO public.proofstack_release_policy_resources (
    tenant_id, project_id, environment_id, policy_id,
    root_policy_version_id, root_definition_sha256
  ) VALUES (
    tenant, project, environment, policy, policy_version, digest
  ) ON CONFLICT (tenant_id, policy_id) DO NOTHING;

  IF NOT EXISTS (
    SELECT 1
    FROM public.proofstack_release_policy_resources AS binding
    WHERE binding.tenant_id = tenant
      AND binding.project_id = project
      AND binding.environment_id = environment
      AND binding.policy_id = policy
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23505',
      MESSAGE = 'Release policy resource is already bound to another exact scope';
  END IF;

  INSERT INTO public.proofstack_outbox (
    tenant_id, event_type, aggregate_type, aggregate_id, schema_version, payload, created_at
  ) VALUES (
    tenant, 'policy.definition.published', 'release_policy', policy_version,
    command ->> 'schemaVersion',
    jsonb_build_object('recordKind', 'release_policy', 'record', body),
    (command ->> 'publishedAt')::timestamptz
  );
END;
$$;

CREATE FUNCTION public.proofstack_publish_release_policy(command jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  PERFORM public.proofstack_insert_release_policy(command);
END;
$$;

CREATE FUNCTION public.proofstack_insert_release_policy_lifecycle(command jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  tenant text := command ->> 'tenantId';
  project text := command ->> 'projectId';
  environment text := command ->> 'environmentId';
  body jsonb := command -> 'record';
BEGIN
  IF jsonb_typeof(command) IS DISTINCT FROM 'object'
    OR tenant IS NULL
    OR tenant IS DISTINCT FROM NULLIF(current_setting('proofstack.tenant_id', true), '')
    OR project IS DISTINCT FROM NULLIF(current_setting('proofstack.project_id', true), '')
    OR environment IS DISTINCT FROM NULLIF(current_setting('proofstack.environment_id', true), '')
    OR jsonb_typeof(body) IS DISTINCT FROM 'object'
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'Release policy lifecycle command is malformed or outside the active scope';
  END IF;

  INSERT INTO public.proofstack_release_policy_lifecycle_events (
    tenant_id, project_id, environment_id, event_id, schema_version, kind,
    policy_id, policy_version_id, policy_definition_sha256,
    successor_policy_id, successor_policy_version_id, successor_definition_sha256,
    actor_principal_id, occurred_at, occurred_at_lexical, reason, record
  ) VALUES (
    tenant, project, environment, command ->> 'eventId', command ->> 'schemaVersion',
    body ->> 'kind', body #>> '{policy,policyId}', body #>> '{policy,policyVersionId}',
    body #>> '{policy,definitionSha256}', body #>> '{successor,policyId}',
    body #>> '{successor,policyVersionId}', body #>> '{successor,definitionSha256}',
    command ->> 'actorPrincipalId', (command ->> 'occurredAt')::timestamptz,
    command ->> 'occurredAt', body ->> 'reason', body
  );

  INSERT INTO public.proofstack_outbox (
    tenant_id, event_type, aggregate_type, aggregate_id, schema_version, payload, created_at
  ) VALUES (
    tenant, 'policy.lifecycle.recorded', 'release_policy_lifecycle', command ->> 'eventId',
    command ->> 'schemaVersion',
    jsonb_build_object('recordKind', 'release_policy_lifecycle', 'record', body),
    (command ->> 'occurredAt')::timestamptz
  );
END;
$$;

CREATE FUNCTION public.proofstack_publish_release_policy_lifecycle(command jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  PERFORM public.proofstack_insert_release_policy_lifecycle(command);
END;
$$;

CREATE FUNCTION public.proofstack_release_policy_intent_status(
  requested_aggregate_id text,
  requested_schema_version text,
  requested_payload jsonb,
  requested_created_at timestamptz
)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT CASE
    WHEN NULLIF(current_setting('proofstack.tenant_id', true), '') IS NULL
      OR NULLIF(current_setting('proofstack.project_id', true), '') IS NULL
      OR NULLIF(current_setting('proofstack.environment_id', true), '') IS NULL
    THEN 'unauthorized'
    WHEN NOT EXISTS (
      SELECT 1 FROM public.proofstack_outbox AS intent
      WHERE intent.tenant_id = NULLIF(current_setting('proofstack.tenant_id', true), '')
        AND intent.event_type = 'policy.definition.published'
        AND intent.aggregate_type = 'release_policy'
        AND intent.aggregate_id = requested_aggregate_id
        AND intent.payload #>> '{record,scope,projectId}' =
          NULLIF(current_setting('proofstack.project_id', true), '')
        AND intent.payload #>> '{record,scope,environmentId}' =
          NULLIF(current_setting('proofstack.environment_id', true), '')
    ) THEN 'absent'
    WHEN EXISTS (
      SELECT 1 FROM public.proofstack_outbox AS intent
      WHERE intent.tenant_id = NULLIF(current_setting('proofstack.tenant_id', true), '')
        AND intent.event_type = 'policy.definition.published'
        AND intent.aggregate_type = 'release_policy'
        AND intent.aggregate_id = requested_aggregate_id
        AND intent.schema_version = requested_schema_version
        AND intent.payload = requested_payload
        AND intent.created_at = requested_created_at
        AND intent.payload #>> '{record,scope,projectId}' =
          NULLIF(current_setting('proofstack.project_id', true), '')
        AND intent.payload #>> '{record,scope,environmentId}' =
          NULLIF(current_setting('proofstack.environment_id', true), '')
    ) THEN 'canonical'
    ELSE 'conflict'
  END
$$;

CREATE FUNCTION public.proofstack_release_policy_lifecycle_intent_status(
  requested_aggregate_id text,
  requested_schema_version text,
  requested_payload jsonb,
  requested_created_at timestamptz
)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT CASE
    WHEN NULLIF(current_setting('proofstack.tenant_id', true), '') IS NULL
      OR NULLIF(current_setting('proofstack.project_id', true), '') IS NULL
      OR NULLIF(current_setting('proofstack.environment_id', true), '') IS NULL
    THEN 'unauthorized'
    WHEN NOT EXISTS (
      SELECT 1 FROM public.proofstack_outbox AS intent
      WHERE intent.tenant_id = NULLIF(current_setting('proofstack.tenant_id', true), '')
        AND intent.event_type = 'policy.lifecycle.recorded'
        AND intent.aggregate_type = 'release_policy_lifecycle'
        AND intent.aggregate_id = requested_aggregate_id
        AND intent.payload #>> '{record,scope,projectId}' =
          NULLIF(current_setting('proofstack.project_id', true), '')
        AND intent.payload #>> '{record,scope,environmentId}' =
          NULLIF(current_setting('proofstack.environment_id', true), '')
    ) THEN 'absent'
    WHEN EXISTS (
      SELECT 1 FROM public.proofstack_outbox AS intent
      WHERE intent.tenant_id = NULLIF(current_setting('proofstack.tenant_id', true), '')
        AND intent.event_type = 'policy.lifecycle.recorded'
        AND intent.aggregate_type = 'release_policy_lifecycle'
        AND intent.aggregate_id = requested_aggregate_id
        AND intent.schema_version = requested_schema_version
        AND intent.payload = requested_payload
        AND intent.created_at = requested_created_at
        AND intent.payload #>> '{record,scope,projectId}' =
          NULLIF(current_setting('proofstack.project_id', true), '')
        AND intent.payload #>> '{record,scope,environmentId}' =
          NULLIF(current_setting('proofstack.environment_id', true), '')
    ) THEN 'canonical'
    ELSE 'conflict'
  END
$$;

REVOKE ALL ON FUNCTION public.proofstack_verify_release_policy_graph() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.proofstack_verify_release_policy_lifecycle() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.proofstack_insert_release_policy(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.proofstack_publish_release_policy(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.proofstack_insert_release_policy_lifecycle(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.proofstack_publish_release_policy_lifecycle(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.proofstack_release_policy_intent_status(
  text, text, jsonb, timestamptz
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.proofstack_release_policy_lifecycle_intent_status(
  text, text, jsonb, timestamptz
) FROM PUBLIC;

CREATE CONSTRAINT TRIGGER proofstack_release_policy_graph_complete
  AFTER INSERT ON public.proofstack_release_policies
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.proofstack_verify_release_policy_graph();
CREATE CONSTRAINT TRIGGER proofstack_release_policy_sources_complete
  AFTER INSERT ON public.proofstack_release_policy_sources
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.proofstack_verify_release_policy_graph();
CREATE CONSTRAINT TRIGGER proofstack_release_policy_rules_complete
  AFTER INSERT ON public.proofstack_release_policy_rules
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.proofstack_verify_release_policy_graph();
CREATE CONSTRAINT TRIGGER proofstack_release_policy_rule_sources_complete
  AFTER INSERT ON public.proofstack_release_policy_rule_sources
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.proofstack_verify_release_policy_graph();
CREATE CONSTRAINT TRIGGER proofstack_release_policy_lifecycle_complete
  AFTER INSERT ON public.proofstack_release_policy_lifecycle_events
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.proofstack_verify_release_policy_lifecycle();

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'proofstack_release_policy_registry',
    'proofstack_release_policy_resources',
    'proofstack_release_policy_lineage',
    'proofstack_release_policies',
    'proofstack_release_policy_sources',
    'proofstack_release_policy_rules',
    'proofstack_release_policy_rule_sources',
    'proofstack_release_policy_lifecycle_events'
  ]
  LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION public.proofstack_reject_append_only_mutation()',
      table_name || '_append_only', table_name
    );
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT USING ('
      'tenant_id = NULLIF(current_setting(''proofstack.tenant_id'', true), '''') AND '
      'project_id = NULLIF(current_setting(''proofstack.project_id'', true), '''') AND '
      'environment_id = NULLIF(current_setting(''proofstack.environment_id'', true), ''''))',
      table_name || '_scope_select', table_name
    );
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR INSERT WITH CHECK ('
      'tenant_id = NULLIF(current_setting(''proofstack.tenant_id'', true), '''') AND '
      'project_id = NULLIF(current_setting(''proofstack.project_id'', true), '''') AND '
      'environment_id = NULLIF(current_setting(''proofstack.environment_id'', true), ''''))',
      table_name || '_scope_insert', table_name
    );
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC', table_name);
  END LOOP;
END;
$$;
