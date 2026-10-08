-- Keep 0041 and all retained records unchanged. Validate existing partitions wholly;
-- a historical mismatch aborts the migration rather than silently repairing evidence.
ALTER TABLE public.proofstack_model_assurance_records
  ADD CONSTRAINT proofstack_model_assurance_records_scalar_integrity CHECK (
    (
      jsonb_typeof(record) = 'object'
      AND record ->> 'schemaVersion' = schema_version
      AND record ->> 'definitionSha256' = definition_sha256
      AND record #>> '{scope,tenantId}' = tenant_id
      AND record #>> '{scope,projectId}' = project_id
      AND record #>> '{scope,environmentId}' = environment_id
      AND record_id = record ->> CASE record_kind
        WHEN 'blinded_evaluation_plan' THEN 'blindedPlanVersionId'
        WHEN 'blinded_evaluation_result' THEN 'resultId'
        WHEN 'calibration_report' THEN 'calibrationReportId'
        WHEN 'human_review_protocol' THEN 'protocolVersionId'
        WHEN 'human_review_record' THEN 'reviewId'
        WHEN 'human_reviewer_independence' THEN 'declarationId'
        WHEN 'independence_declaration' THEN 'independenceDeclarationId'
        WHEN 'independent_critique' THEN 'critiqueId'
        WHEN 'model_assisted_evaluator' THEN 'evaluatorVersionId'
        WHEN 'model_assurance_assessment' THEN 'assessmentExtensionId'
        WHEN 'model_evaluator_profile' THEN 'modelProfileVersionId'
        WHEN 'model_qualification_report' THEN 'reportId'
        WHEN 'model_qualification_suite' THEN 'suiteVersionId'
      END
      AND recorded_at_lexical = record ->> CASE
        WHEN record_kind IN (
          'blinded_evaluation_plan', 'human_review_protocol',
          'model_assisted_evaluator', 'model_evaluator_profile', 'model_qualification_suite'
        ) THEN 'publishedAt'
        ELSE 'recordedAt'
      END
      AND actor_principal_id IS NOT DISTINCT FROM CASE
        WHEN record_kind IN (
          'blinded_evaluation_plan', 'human_review_protocol',
          'model_assisted_evaluator', 'model_evaluator_profile', 'model_qualification_suite'
        ) THEN record ->> 'publishedByPrincipalId'
        WHEN record_kind IN ('blinded_evaluation_result', 'independent_critique')
          THEN record ->> 'recordedByPrincipalId'
        WHEN record_kind IN ('calibration_report', 'model_qualification_report')
          THEN record ->> 'executedByPrincipalId'
        WHEN record_kind IN ('human_reviewer_independence', 'independence_declaration')
          THEN record ->> 'reviewedByPrincipalId'
        WHEN record_kind = 'human_review_record' THEN record #>> '{reviewer,principalId}'
        WHEN record_kind = 'model_assurance_assessment' THEN NULL
      END
      AND (actor_principal_id IS NOT NULL OR record_kind = 'model_assurance_assessment')
      AND lifecycle_state IS NOT DISTINCT FROM CASE record_kind
        WHEN 'blinded_evaluation_result' THEN record ->> 'status'
        WHEN 'calibration_report' THEN record ->> 'status'
        WHEN 'human_review_record' THEN record ->> 'action'
        WHEN 'human_reviewer_independence' THEN record ->> 'status'
        WHEN 'independence_declaration' THEN record ->> 'reviewStatus'
        WHEN 'independent_critique' THEN record #>> '{outcome,status}'
        WHEN 'model_assurance_assessment' THEN record ->> 'eligibility'
        WHEN 'model_qualification_report' THEN record ->> 'status'
        ELSE NULL
      END
      AND (
        lifecycle_state IS NOT NULL OR record_kind IN (
          'blinded_evaluation_plan', 'human_review_protocol',
          'model_assisted_evaluator', 'model_evaluator_profile', 'model_qualification_suite'
        )
      )
    ) IS TRUE
  );
