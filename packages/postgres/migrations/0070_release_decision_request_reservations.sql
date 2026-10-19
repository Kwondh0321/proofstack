-- Native pre-outcome reservations. Legacy plans remain explicitly unreserved.
ALTER TABLE public.proofstack_release_decision_input_plans
  ADD COLUMN reservation_profile smallint,
  ADD COLUMN reserved_at_lexical text,
  ADD COLUMN reserved_at_key numeric(50,0),
  ADD CONSTRAINT proofstack_decision_plan_reservation_receipt CHECK (
    (reservation_profile IS NULL AND reserved_at_lexical IS NULL AND reserved_at_key IS NULL)
    OR (reservation_profile=1 AND reserved_at_lexical IS NOT NULL AND reserved_at_key IS NOT NULL
      AND reserved_at_key=public.proofstack_release_authority_time_key(reserved_at_lexical)) IS TRUE
  );

CREATE FUNCTION public.proofstack_reserve_release_decision_request()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE scoped jsonb:=jsonb_build_object('tenantId',NEW.tenant_id,'projectId',NEW.project_id,'environmentId',NEW.environment_id);
BEGIN
  IF scoped IS DISTINCT FROM public.proofstack_release_selection_scope() THEN
    RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Exact decision reservation scope is required';
  END IF;
  IF current_setting('transaction_isolation')<>'read committed' THEN
    RAISE EXCEPTION USING ERRCODE='0A000',MESSAGE='Decision reservations require READ COMMITTED';
  END IF;
  -- Keep the input-domain order even for direct child writes. Never wait for a C3
  -- request writer while a future publisher may hold metadata source guards.
  PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array('proofstack.release-decision-input.v1',NEW.tenant_id)::text,0));
  IF NOT pg_try_advisory_xact_lock(hashtextextended(jsonb_build_array('proofstack.policy-job-request.v1',scoped,NEW.request_id)::text,0)) THEN
    RAISE EXCEPTION USING ERRCODE='55P03',MESSAGE='Decision request reservation is contended';
  END IF;
  IF EXISTS(SELECT 1 FROM public.proofstack_policy_evaluation_requests r
    WHERE r.tenant_id=NEW.tenant_id AND r.project_id=NEW.project_id
      AND r.environment_id=NEW.environment_id AND r.request_id=NEW.request_id) THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='release_decision_input:planned_request_conflict';
  END IF;
  NEW.reservation_profile:=1;
  NEW.reserved_at_lexical:=public.proofstack_policy_evaluation_utc(clock_timestamp());
  NEW.reserved_at_key:=public.proofstack_release_authority_time_key(NEW.reserved_at_lexical);
  RETURN NEW;
END; $$;

CREATE FUNCTION public.proofstack_enforce_release_decision_request_reservation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE scoped jsonb:=jsonb_build_object('tenantId',NEW.tenant_id,'projectId',NEW.project_id,'environmentId',NEW.environment_id);
  planned public.proofstack_release_decision_input_plans;
BEGIN
  IF scoped IS DISTINCT FROM public.proofstack_policy_evaluation_scope() THEN
    RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Exact reserved policy request scope is required';
  END IF;
  IF current_setting('transaction_isolation')<>'read committed' THEN
    RAISE EXCEPTION USING ERRCODE='0A000',MESSAGE='Reserved policy requests require READ COMMITTED';
  END IF;
  -- Mandatory for every INSERT, including writers that bypass the job function.
  PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array('proofstack.policy-job-request.v1',scoped,NEW.request_id)::text,0));
  SELECT * INTO planned FROM public.proofstack_release_decision_input_plans p
    WHERE p.tenant_id=NEW.tenant_id AND p.project_id=NEW.project_id
      AND p.environment_id=NEW.environment_id AND p.request_id=NEW.request_id;
  IF FOUND AND planned.reservation_profile=1 AND
    (planned.request_sha256 IS DISTINCT FROM NEW.definition_sha256
      OR planned.planned->'request' IS DISTINCT FROM NEW.request-ARRAY['createdAt','createdByPrincipalId','definitionSha256','schemaVersion','scope']) THEN
    RAISE EXCEPTION USING ERRCODE='23505',MESSAGE='Policy request conflicts with its original decision reservation';
  END IF;
  RETURN NEW;
END; $$;

CREATE TRIGGER proofstack_release_decision_input_plan_reservation
  BEFORE INSERT ON public.proofstack_release_decision_input_plans
  FOR EACH ROW EXECUTE FUNCTION public.proofstack_reserve_release_decision_request();
CREATE TRIGGER proofstack_policy_evaluation_request_reservation
  BEFORE INSERT ON public.proofstack_policy_evaluation_requests
  FOR EACH ROW EXECUTE FUNCTION public.proofstack_enforce_release_decision_request_reservation();

REVOKE ALL ON FUNCTION public.proofstack_reserve_release_decision_request() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.proofstack_enforce_release_decision_request_reservation() FROM PUBLIC;
