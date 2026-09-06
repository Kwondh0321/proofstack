import { createHash } from "node:crypto";
import { type ApiConfig, createApp } from "@proofstack/api/composition";
import type {
  EvaluationRecordEnvelope,
  EvaluationRecordKind,
  PrincipalContext,
  PublishEvaluationRecordResponse,
} from "@proofstack/contracts";
import { ArtifactContentReferenceSchema, PrincipalContextSchema } from "@proofstack/contracts";
import { MemoryEvaluationRepository } from "@proofstack/core";
import { createEvaluationWorkerBoundary } from "@proofstack/evaluation-worker";
import { ProofStackEvaluationClient, ProofStackRegressionClient } from "@proofstack/sdk";
import { describe, expect, it } from "vitest";
import { EvaluationScenario } from "./scenario.js";

type EnvelopeFor<Kind extends EvaluationRecordKind> = Extract<
  EvaluationRecordEnvelope,
  { readonly kind: Kind }
>;

type ArtifactContentReference = ReturnType<typeof ArtifactContentReferenceSchema.parse>;

interface RetainedArtifact {
  readonly bytes: Uint8Array;
  readonly reference: ArtifactContentReference;
}

const scope = {
  environmentId: "env_criteria_service",
  projectId: "prj_criteria_service",
  tenantId: "ten_criteria_service",
} as const;

const config: ApiConfig = {
  authMode: "development",
  environment: "test",
  host: "127.0.0.1",
  logLevel: "silent",
  otlp: { compressedBodyLimitBytes: 1_048_576, decompressedBodyLimitBytes: 1_048_576 },
  port: 4318,
  storage: { mode: "memory" },
};

function principal(
  principalId: string,
  capabilities: PrincipalContext["capabilities"],
  options: {
    readonly authentication?: PrincipalContext["authentication"];
    readonly principalType?: PrincipalContext["principalType"];
  } = {},
): PrincipalContext {
  return PrincipalContextSchema.parse({
    authentication: options.authentication ?? {
      authenticatedAt: "2026-09-02T11:59:00.000Z",
      method: "development",
    },
    capabilities,
    principalId,
    principalType: options.principalType ?? "user",
    requestId: `req_${principalId}`,
    resourceScope: {
      mode: "restricted",
      projects: [{ environmentIds: [scope.environmentId], projectId: scope.projectId }],
    },
    roles: ["member"],
    tenantId: scope.tenantId,
  });
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function retainedDefinition<Definition>(
  input: Definition,
  artifacts: Map<string, RetainedArtifact>,
): Definition {
  const definition = structuredClone(input);
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (typeof value !== "object" || value === null) return;
    const candidate = value as Record<string, unknown>;
    const parsedReference = ArtifactContentReferenceSchema.safeParse(candidate);
    if (parsedReference.success) {
      const bytes = Buffer.from(
        JSON.stringify({
          artifactId: parsedReference.data.artifactId,
          evidence: "retained exact bytes",
        }),
        "utf8",
      );
      Object.assign(candidate, { sha256: sha256(bytes), sizeBytes: bytes.byteLength });
      const reference = ArtifactContentReferenceSchema.parse(candidate);
      const existing = artifacts.get(reference.artifactId);
      if (
        existing &&
        (existing.reference.sha256 !== reference.sha256 ||
          existing.reference.sizeBytes !== reference.sizeBytes)
      ) {
        throw new TypeError(`Artifact ${reference.artifactId} has contradictory content bindings`);
      }
      artifacts.set(reference.artifactId, { bytes, reference: structuredClone(reference) });
    }
    for (const child of Object.values(candidate)) visit(child);
  };
  visit(definition);
  return definition;
}

function responseRecord<Kind extends EvaluationRecordKind>(
  response: PublishEvaluationRecordResponse,
  kind: Kind,
): EnvelopeFor<Kind>["record"] {
  if (response.result.kind !== kind) {
    throw new TypeError(`Expected ${kind}, received ${response.result.kind}`);
  }
  return response.result.record as EnvelopeFor<Kind>["record"];
}

describe("criteria trust service boundary", () => {
  it("derives trust from independently authored records and exact retained bytes", async () => {
    const repository = new MemoryEvaluationRepository();
    const clock = { now: () => new Date("2026-09-02T12:00:00.000Z") };
    let activePrincipal = principal("usr_bootstrap", ["evaluation:read"]);
    const app = await createApp(config, {
      authenticator: { authenticate: async () => structuredClone(activePrincipal) },
      clock,
      evaluationRepository: repository,
    });
    const endpoint = await app.listen({ host: "127.0.0.1", port: 0 });
    try {
      const evaluation = new ProofStackEvaluationClient({
        authentication: { mode: "development" },
        endpoint,
        environmentId: scope.environmentId,
        projectId: scope.projectId,
      });
      const regression = new ProofStackRegressionClient({
        authentication: { mode: "development" },
        endpoint,
        environmentId: scope.environmentId,
        projectId: scope.projectId,
      });
      const scenario = new EvaluationScenario({
        environmentId: scope.environmentId,
        namespace: "trustservice",
      });
      const artifacts = new Map<string, RetainedArtifact>();
      const unqualifiedIds = {
        approvedStatus: "csr_unqualified_approved_trustservice",
        criterionSet: "criteria_unqualified_trustservice",
        criterionSetVersion: "csv_unqualified_trustservice",
        draftStatus: "csr_unqualified_draft_trustservice",
        qualification: "srq_unqualified_trustservice",
        review: "srv_unqualified_trustservice",
      } as const;
      const manager = (principalId: string): void => {
        activePrincipal = principal(principalId, ["evaluation:manage", "evaluation:read"]);
      };

      manager("usr_discovery_operator");
      const discovery = responseRecord(
        await evaluation.publishDefinition({
          recordId: "dsc_primary_trustservice",
          request: {
            definition: scenario.discovery(),
            kind: "discovery_record",
          },
        }),
        "discovery_record",
      );

      manager("usr_source_publisher");
      const source = responseRecord(
        await evaluation.publishDefinition({
          recordId: scenario.ids.sourcePrimary,
          request: {
            definition: retainedDefinition(scenario.authoritativeSource(discovery), artifacts),
            kind: "source_snapshot",
          },
        }),
        "source_snapshot",
      );

      manager("usr_credential_authority");
      const reviewerQualification = responseRecord(
        await evaluation.publishDefinition({
          recordId: scenario.ids.sourceReviewerQualification,
          request: {
            definition: retainedDefinition(scenario.sourceReviewerQualification(), artifacts),
            kind: "source_reviewer_qualification",
          },
        }),
        "source_reviewer_qualification",
      );

      manager("usr_source_reviewer");
      const sourceReview = responseRecord(
        await evaluation.publishDefinition({
          recordId: scenario.ids.sourceReviewPrimary,
          request: {
            definition: retainedDefinition(
              scenario.qualifiedSourceReview(source, reviewerQualification),
              artifacts,
            ),
            kind: "source_review",
          },
        }),
        "source_review",
      );

      manager("usr_fixture_curator");
      const fixtureSet = responseRecord(
        await evaluation.publishDefinition({
          recordId: scenario.ids.fixtureSetVersion,
          request: {
            definition: retainedDefinition(scenario.qualificationFixtureSet(), artifacts),
            kind: "qualification_fixture_set",
          },
        }),
        "qualification_fixture_set",
      );

      manager("usr_oracle_author");
      const oracle = responseRecord(
        await evaluation.publishDefinition({
          recordId: scenario.ids.oracleVersion,
          request: {
            definition: retainedDefinition(scenario.oracle(fixtureSet), artifacts),
            kind: "oracle_spec",
          },
        }),
        "oracle_spec",
      );

      manager("usr_evaluator_author");
      const evaluator = responseRecord(
        await evaluation.publishDefinition({
          recordId: scenario.ids.evaluatorVersion,
          request: {
            definition: retainedDefinition(scenario.evaluator(fixtureSet, oracle), artifacts),
            kind: "evaluator_spec",
          },
        }),
        "evaluator_spec",
      );

      manager("usr_criterion_issuer");
      const criterionSet = responseRecord(
        await evaluation.publishDefinition({
          recordId: scenario.ids.criterionSetVersion,
          request: {
            definition: scenario.qualifiedCriterionSet({
              evaluator,
              oracle,
              review: sourceReview,
              source,
            }),
            kind: "criterion_set",
          },
        }),
        "criterion_set",
      );
      const draftStatus = responseRecord(
        await evaluation.recordCriterionSetStatus({
          recordId: scenario.ids.statusDraft,
          request: {
            definition: scenario.draftStatus(criterionSet),
            kind: "criterion_set_status",
          },
        }),
        "criterion_set_status",
      );
      const approvedStatus = responseRecord(
        await evaluation.recordCriterionSetStatus({
          recordId: scenario.ids.statusApproved,
          request: {
            definition: scenario.approvedStatus(criterionSet, draftStatus),
            kind: "criterion_set_status",
          },
        }),
        "criterion_set_status",
      );

      manager("usr_credential_authority");
      const unqualifiedDefinition = structuredClone(scenario.sourceReviewerQualification());
      Object.assign(unqualifiedDefinition, {
        qualificationId: unqualifiedIds.qualification,
        status: "unqualified",
        statusReasons: ["Required source-domain expertise was not demonstrated"],
      });
      const unqualifiedReviewer = responseRecord(
        await evaluation.publishDefinition({
          recordId: unqualifiedIds.qualification,
          request: {
            definition: retainedDefinition(unqualifiedDefinition, artifacts),
            kind: "source_reviewer_qualification",
          },
        }),
        "source_reviewer_qualification",
      );

      manager("usr_source_reviewer");
      const unqualifiedReviewDefinition = structuredClone(
        scenario.qualifiedSourceReview(source, unqualifiedReviewer),
      );
      unqualifiedReviewDefinition.sourceReviewId = unqualifiedIds.review;
      const unqualifiedReview = responseRecord(
        await evaluation.publishDefinition({
          recordId: unqualifiedIds.review,
          request: {
            definition: retainedDefinition(unqualifiedReviewDefinition, artifacts),
            kind: "source_review",
          },
        }),
        "source_review",
      );

      manager("usr_criterion_issuer");
      const unqualifiedCriterionDefinition = structuredClone(
        scenario.qualifiedCriterionSet({
          evaluator,
          oracle,
          review: unqualifiedReview,
          source,
        }),
      );
      Object.assign(unqualifiedCriterionDefinition, {
        criterionSetId: unqualifiedIds.criterionSet,
        criterionSetVersionId: unqualifiedIds.criterionSetVersion,
      });
      const unqualifiedCriterionSet = responseRecord(
        await evaluation.publishDefinition({
          recordId: unqualifiedIds.criterionSetVersion,
          request: { definition: unqualifiedCriterionDefinition, kind: "criterion_set" },
        }),
        "criterion_set",
      );
      const unqualifiedDraftDefinition = structuredClone(
        scenario.draftStatus(unqualifiedCriterionSet),
      );
      unqualifiedDraftDefinition.statusRecordId = unqualifiedIds.draftStatus;
      const unqualifiedDraft = responseRecord(
        await evaluation.recordCriterionSetStatus({
          recordId: unqualifiedIds.draftStatus,
          request: {
            definition: unqualifiedDraftDefinition,
            kind: "criterion_set_status",
          },
        }),
        "criterion_set_status",
      );
      const unqualifiedApprovedDefinition = structuredClone(
        scenario.approvedStatus(unqualifiedCriterionSet, unqualifiedDraft),
      );
      unqualifiedApprovedDefinition.statusRecordId = unqualifiedIds.approvedStatus;
      const unqualifiedApproved = responseRecord(
        await evaluation.recordCriterionSetStatus({
          recordId: unqualifiedIds.approvedStatus,
          request: {
            definition: unqualifiedApprovedDefinition,
            kind: "criterion_set_status",
          },
        }),
        "criterion_set_status",
      );

      const qualificationPrincipal = principal("svc_qualification_executor", ["evaluation:run"], {
        authentication: {
          authenticatedAt: "2026-09-02T11:59:30.000Z",
          credentialId: "cred_qualification_executor",
          method: "service_token",
        },
        principalType: "service",
      });
      const worker = createEvaluationWorkerBoundary({ clock, repository });
      const report = async (subject: typeof oracle | typeof evaluator, recordId: string) =>
        (
          await worker.recordQualificationReport({
            definition: retainedDefinition(
              scenario.qualificationReport(subject, fixtureSet),
              artifacts,
            ),
            environmentId: scope.environmentId,
            kind: "qualification_report",
            principal: qualificationPrincipal,
            projectId: scope.projectId,
            recordId,
          })
        ).record;
      const oracleReport = await report(oracle, "qlr_oracle_trustservice");
      const evaluatorReport = await report(evaluator, "qlr_evaluator_trustservice");

      activePrincipal = principal("usr_artifact_custodian", ["artifact:write"]);
      for (const { bytes, reference } of artifacts.values()) {
        await regression.reserveArtifact({
          request: {
            artifactId: reference.artifactId,
            classification: reference.classification,
            mediaType: reference.mediaType,
            redaction: { status: "not_required" },
            retention: { mode: "retain" },
            sha256: reference.sha256,
            sizeBytes: reference.sizeBytes,
          },
        });
        await regression.uploadArtifactContent({
          artifactId: reference.artifactId,
          content: bytes,
        });
      }

      const trustRequest = {
        context: {
          environmentId: scope.environmentId,
          jurisdiction: "kr",
          locale: "ko-kr",
          populationTags: ["adult users"],
          riskTier: "high" as const,
          taskKind: "task_support",
        },
        criterionStatusRecordId: approvedStatus.statusRecordId,
        qualificationReportIds: [
          evaluatorReport.qualificationReportId,
          oracleReport.qualificationReportId,
        ].sort(),
      };
      activePrincipal = principal("usr_task_requester", ["evaluation:read"]);
      const trusted = await evaluation.evaluateCriteriaTrust({
        criterionSetVersionId: criterionSet.criterionSetVersionId,
        request: trustRequest,
      });
      expect(trusted.result).toEqual({
        evaluatedAt: "2026-09-02T12:00:00.000Z",
        reasons: [],
        status: "eligible",
      });

      activePrincipal = principal("usr_source_reviewer", ["evaluation:read"]);
      const requesterOnly = await evaluation.evaluateCriteriaTrust({
        criterionSetVersionId: criterionSet.criterionSetVersionId,
        request: trustRequest,
      });
      expect(requesterOnly.result).toMatchObject({
        reasons: expect.arrayContaining(["requester_only_review"]),
        status: "require_approval",
      });

      activePrincipal = principal("usr_task_requester", ["evaluation:read"]);
      const missingQualification = await evaluation.evaluateCriteriaTrust({
        criterionSetVersionId: criterionSet.criterionSetVersionId,
        request: { ...trustRequest, qualificationReportIds: [] },
      });
      expect(missingQualification.result).toMatchObject({
        reasons: expect.arrayContaining(["qualification_report_unavailable"]),
        status: "unverifiable",
      });
      const scopeMismatch = await evaluation.evaluateCriteriaTrust({
        criterionSetVersionId: criterionSet.criterionSetVersionId,
        request: {
          ...trustRequest,
          context: { ...trustRequest.context, locale: "fr" },
        },
      });
      expect(scopeMismatch.result).toMatchObject({
        reasons: expect.arrayContaining(["source_scope_mismatch"]),
        status: "ineligible",
      });
      const unqualified = await evaluation.evaluateCriteriaTrust({
        criterionSetVersionId: unqualifiedCriterionSet.criterionSetVersionId,
        request: {
          ...trustRequest,
          criterionStatusRecordId: unqualifiedApproved.statusRecordId,
        },
      });
      expect(unqualified.result).toMatchObject({
        reasons: expect.arrayContaining(["reviewer_unqualified"]),
        status: "ineligible",
      });

      activePrincipal = principal("usr_artifact_custodian", ["artifact:delete"]);
      await regression.tombstoneArtifact({
        artifactId: source.content.artifactId,
        request: { reason: "Exercise fail-closed criteria trust after source-byte revocation" },
      });
      activePrincipal = principal("usr_task_requester", ["evaluation:read"]);
      const unavailableSource = await evaluation.evaluateCriteriaTrust({
        criterionSetVersionId: criterionSet.criterionSetVersionId,
        request: trustRequest,
      });
      expect(unavailableSource.result).toMatchObject({
        reasons: expect.arrayContaining(["source_content_unavailable"]),
        status: "unverifiable",
      });
    } finally {
      await app.close();
    }
  }, 30_000);
});
