import { randomUUID } from "node:crypto";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import {
  ArtifactConflictError,
  ArtifactContentInspectionUnavailableError,
  type ArtifactContentInspector,
  ArtifactContentMismatchError,
  ArtifactContentRejectedError,
  ArtifactIdentifierGenerationError,
  ArtifactNotFoundError,
  ArtifactObjectConflictError,
  ArtifactObjectMissingError,
  ArtifactOwnedDeletionError,
  ArtifactOwnershipConflictError,
  ArtifactProtectionError,
  ArtifactStateTransitionError,
  ArtifactUnavailableError,
  InvalidArtifactLifecycleInputError,
  PurgeArtifact,
  ReadArtifact,
  ReadArtifactMetadata,
  ReserveArtifact,
  StrictArtifactContentInspector,
  TombstoneArtifact,
  UploadArtifact,
} from "@proofstack/artifacts";
import {
  type Clock,
  type ComparisonEvidenceResolver,
  ComparisonLineageError,
  ComparisonRecordConflictError,
  ComparisonRecordNotFoundError,
  type ComparisonRepository,
  ComparisonRepositoryContractError,
  ComparisonResourceConflictError,
  ComparisonSourceUnavailableError,
  CreateAssessment,
  CreateComparisonEvidenceSnapshot,
  CreateModelAssuranceAssessment,
  DeriveComparisonResult,
  EvaluationLineageError,
  EvaluationRecordConflictError,
  EvaluationRecordNotFoundError,
  type EvaluationRepository,
  EvaluationRepositoryContractError,
  EvaluationResourceConflictError,
  EvidenceConflictError,
  type EvidenceRepository,
  ForbiddenError,
  IngestEvidence,
  InvalidComparisonRecordInputError,
  InvalidEvaluationRecordInputError,
  InvalidModelAssuranceRecordInputError,
  InvalidTraceCursorError,
  ListTraceEvidence,
  ModelAssuranceDependencyError,
  ModelAssuranceLineageError,
  ModelAssuranceRecordConflictError,
  ModelAssuranceRecordNotFoundError,
  type ModelAssuranceRepository,
  ModelAssuranceRepositoryContractError,
  PublishComparisonDefinition,
  PublishEvaluationDefinition,
  PublishModelAssuranceDefinition,
  ReadComparisonRecord,
  ReadEvaluationRecord,
  ReadModelAssuranceRecord,
  RecordCriterionSetStatus,
  RecordEvaluationRunDecision,
  RecordHumanReview,
  RecordModelAssuranceExecution,
  SystemClock,
  TraceNotFoundError,
} from "@proofstack/core";
import {
  InvalidRegressionVersionInputError,
  PublishRecordedInteractionFixtureVersion,
  PublishRegressionDatasetVersion,
  PublishRegressionFixtureVersion,
  ReadRecordedInteractionFixtureMetadata,
  ReadRegressionDatasetVersion,
  ReadRegressionFixtureVersion,
  RegressionArtifactBindingError,
  RegressionFixtureContentRevocationConflictError,
  RegressionVersionConflictError,
  RegressionVersionLineageError,
  RegressionVersionNotFoundError,
  type RegressionVersionRepository,
  RevokeRecordedInteractionFixtureContent,
  SecureInteractionFixtureRevocationIdentityGenerator,
} from "@proofstack/datasets";
import {
  ApiKeyCredentialNotActiveError,
  ApiKeyCredentialNotFoundError,
  ApiKeyGenerationError,
  ApiKeyLifecycle,
  InvalidApiKeyLifecycleInputError,
  InvalidOidcLoginError,
  OidcLoginGenerationError,
} from "@proofstack/identity";
import {
  CreateDurableReplayJob,
  InvalidReplayDefinitionInputError,
  InvalidReplayJobInputError,
  PublishReplayPlan,
  PublishTargetRelease,
  ReadReplayJob,
  ReadReplayPlan,
  ReadTargetRelease,
  ReplayDefinitionConflictError,
  ReplayDefinitionLineageError,
  ReplayDefinitionNotFoundError,
  type ReplayDefinitionRepository,
  ReplayJobConflictError,
  type ReplayJobControlRepository,
  ReplayJobNotFoundError,
  RequestDurableReplayCancellation,
} from "@proofstack/replay";
import { S3ArtifactObjectStoreError } from "@proofstack/s3";
import Fastify, { type FastifyInstance, LogController } from "fastify";
import { ZodError } from "zod";
import { registerArtifactRoutes } from "./artifact-routes.js";
import {
  AuthenticationRequiredError,
  type Authenticator,
  BrowserRequestRejectedError,
  createAuthenticator,
} from "./auth.js";
import { registerComparisonRoutes } from "./comparison-routes.js";
import type { ApiConfig } from "./config.js";
import { registerEvaluationRoutes } from "./evaluation-routes.js";
import {
  type ApiKeyLifecycleService,
  IdentityManagementUnavailableError,
  registerIdentityRoutes,
} from "./identity-routes.js";
import { createIdentityStorage, type IdentityStorage } from "./identity-storage.js";
import {
  ExportRecordedInteractionFixtureContent,
  ExportRecordedInteractionFixtureMetadata,
  InteractionContentExportTooLargeError,
  InteractionExportStateChangedError,
} from "./interaction-export.js";
import { registerModelAssuranceRoutes } from "./model-assurance-routes.js";
import { registerOidcRoutes } from "./oidc-routes.js";
import { createOidcRuntime, type OidcRuntime } from "./oidc-runtime.js";
import { registerOtlpRoutes } from "./otlp-routes.js";
import { sendProblem } from "./problem.js";
import { registerInteractionFixtureRoutes, registerRegressionRoutes } from "./regression-routes.js";
import { registerReplayRoutes } from "./replay-routes.js";
import {
  isExactEvidenceRepository,
  RepositoryComparisonEvidenceResolver,
} from "./repository-comparison-evidence-resolver.js";
import { registerRoutes } from "./routes.js";
import { type ApiArtifactStorage, createApiStorage } from "./storage.js";

export interface AppDependencies {
  readonly artifactContentInspector?: ArtifactContentInspector;
  readonly artifactStorage?: ApiArtifactStorage;
  readonly apiKeyLifecycle?: ApiKeyLifecycleService;
  readonly authenticator?: Authenticator;
  readonly checkReadiness?: () => Promise<void>;
  readonly clock?: Clock;
  readonly comparisonEvidenceResolver?: ComparisonEvidenceResolver;
  readonly comparisonRepository?: ComparisonRepository;
  readonly evaluationRepository?: EvaluationRepository;
  readonly identityStorage?: IdentityStorage;
  readonly modelAssuranceRepository?: ModelAssuranceRepository;
  readonly oidcRuntime?: OidcRuntime;
  readonly regressionVersionRepository?: RegressionVersionRepository;
  readonly repository?: EvidenceRepository;
  readonly replayDefinitionRepository?: ReplayDefinitionRepository;
  readonly replayJobControlRepository?: ReplayJobControlRepository;
}

function clientErrorStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("statusCode" in error)) return undefined;
  const statusCode = error.statusCode;
  if (typeof statusCode !== "number" || statusCode < 400 || statusCode >= 500) return undefined;
  return statusCode;
}

export async function createApp(
  config: ApiConfig,
  dependencies: AppDependencies = {},
): Promise<FastifyInstance> {
  const clock = dependencies.clock ?? new SystemClock();

  const app = Fastify({
    bodyLimit: 1024 * 1024,
    genReqId: () => randomUUID(),
    logController: new LogController({
      disableRequestLogging: config.environment === "test",
    }),
    logger:
      config.environment === "test"
        ? false
        : {
            level: config.logLevel,
            redact: {
              censor: "[Redacted]",
              paths: ["req.headers.authorization", "req.headers.cookie"],
            },
          },
    trustProxy: false,
  });
  try {
    const defaultStorage = await createApiStorage(config.storage, (error) => {
      app.log.error({ error }, "Idle PostgreSQL connection failed");
    });
    const storage =
      dependencies.repository ||
      dependencies.comparisonRepository ||
      dependencies.evaluationRepository ||
      dependencies.modelAssuranceRepository ||
      dependencies.regressionVersionRepository ||
      dependencies.artifactStorage ||
      dependencies.replayDefinitionRepository ||
      dependencies.replayJobControlRepository
        ? {
            ...defaultStorage,
            ...(dependencies.artifactStorage ? { artifacts: dependencies.artifactStorage } : {}),
            checkReadiness: dependencies.checkReadiness ?? defaultStorage.checkReadiness,
            comparisonRepository:
              dependencies.comparisonRepository ?? defaultStorage.comparisonRepository,
            evaluationRepository:
              dependencies.evaluationRepository ?? defaultStorage.evaluationRepository,
            modelAssuranceRepository:
              dependencies.modelAssuranceRepository ?? defaultStorage.modelAssuranceRepository,
            evidenceRepository: dependencies.repository ?? defaultStorage.evidenceRepository,
            ...(dependencies.regressionVersionRepository
              ? {
                  interactionFixtureVersionRepository: undefined,
                  regressionVersionRepository: dependencies.regressionVersionRepository,
                }
              : {}),
            replayDefinitionRepository:
              dependencies.replayDefinitionRepository ?? defaultStorage.replayDefinitionRepository,
            replayJobControlRepository:
              dependencies.replayJobControlRepository ?? defaultStorage.replayJobControlRepository,
          }
        : defaultStorage;
    app.addHook("onClose", storage.close);

    let identityStorage: IdentityStorage | undefined;
    if (dependencies.identityStorage) {
      identityStorage = dependencies.identityStorage;
    } else if (config.identityDatabaseUrl) {
      identityStorage = await createIdentityStorage(config.identityDatabaseUrl, (error) => {
        app.log.error({ error }, "Idle identity PostgreSQL connection failed");
      });
      app.addHook("onClose", identityStorage.close);
    }
    const usesOidc = config.authMode === "oidc" || config.authMode === "combined";
    let oidcRuntime = dependencies.oidcRuntime;
    if (usesOidc) {
      if (!config.oidc || !identityStorage) {
        throw new Error("OIDC identity storage is not configured; startup refused");
      }
      oidcRuntime ??= await createOidcRuntime(
        {
          ...config.oidc,
          browserOrigin: config.corsOrigin ?? new URL(config.oidc.redirectUri).origin,
        },
        identityStorage.oidcRepository,
      );
    }
    const authenticator =
      dependencies.authenticator ??
      createAuthenticator(config, {
        ...(identityStorage ? { apiKeyCredentials: identityStorage.repository } : {}),
        ...(oidcRuntime ? { browserAuthenticator: oidcRuntime.browserSessions } : {}),
      });
    const comparisonEvidenceResolver =
      dependencies.comparisonEvidenceResolver ??
      (storage.interactionFixtureVersionRepository &&
      isExactEvidenceRepository(storage.evidenceRepository)
        ? new RepositoryComparisonEvidenceResolver({
            ...(storage.artifacts ? { artifactCatalog: storage.artifacts.catalog } : {}),
            evidenceRepository: storage.evidenceRepository,
            evaluationRepository: storage.evaluationRepository,
            interactionRepository: storage.interactionFixtureVersionRepository,
            modelAssuranceRepository: storage.modelAssuranceRepository,
            replayRepository: storage.replayJobControlRepository,
          })
        : ({
            resolve: async ({ comparison, role }) => {
              const subject = comparison[role];
              throw new ComparisonSourceUnavailableError(
                "comparison_evidence_projection",
                `${subject.dataset.datasetVersionId}:${role}`,
              );
            },
          } satisfies ComparisonEvidenceResolver));

    await app.register(helmet, {
      contentSecurityPolicy: false,
    });
    await app.register(cors, {
      credentials: usesOidc,
      origin: config.corsOrigin ?? false,
    });
    await app.register(rateLimit, {
      global: false,
    });

    if (config.oidc && oidcRuntime) {
      await registerOidcRoutes(app, {
        browserSessions: oidcRuntime.browserSessions,
        login: oidcRuntime.login,
        redirectUri: config.oidc.redirectUri,
        sessionLifecycle: oidcRuntime.sessionLifecycle,
      });
    }

    const ingestEvidence = new IngestEvidence(storage.evidenceRepository, clock);
    await registerRoutes(app, {
      authenticator,
      checkReadiness: async () => {
        await storage.checkReadiness();
        await identityStorage?.checkReadiness();
      },
      ingestEvidence,
      listTraceEvidence: new ListTraceEvidence(storage.evidenceRepository),
    });
    await registerRegressionRoutes(app, {
      authenticator,
      publishDatasetVersion: new PublishRegressionDatasetVersion({
        clock,
        versionRepository: storage.regressionVersionRepository,
      }),
      publishFixtureVersion: new PublishRegressionFixtureVersion({
        clock,
        evidenceRepository: storage.evidenceRepository,
        versionRepository: storage.regressionVersionRepository,
      }),
      readDatasetVersion: new ReadRegressionDatasetVersion(storage.regressionVersionRepository),
      readFixtureVersion: new ReadRegressionFixtureVersion(storage.regressionVersionRepository),
    });
    await registerEvaluationRoutes(app, {
      authenticator,
      createAssessment: new CreateAssessment({
        clock,
        repository: storage.evaluationRepository,
      }),
      publishDefinition: new PublishEvaluationDefinition({
        clock,
        repository: storage.evaluationRepository,
      }),
      readRecord: new ReadEvaluationRecord(storage.evaluationRepository),
      recordCriterionSetStatus: new RecordCriterionSetStatus({
        clock,
        repository: storage.evaluationRepository,
      }),
      recordRunDecision: new RecordEvaluationRunDecision({
        clock,
        repository: storage.evaluationRepository,
      }),
    });
    await registerComparisonRoutes(app, {
      authenticator,
      createSnapshot: new CreateComparisonEvidenceSnapshot({
        clock,
        evidenceResolver: comparisonEvidenceResolver,
        repository: storage.comparisonRepository,
      }),
      deriveResult: new DeriveComparisonResult({
        clock,
        repository: storage.comparisonRepository,
      }),
      publishDefinition: new PublishComparisonDefinition({
        clock,
        repository: storage.comparisonRepository,
      }),
      readRecord: new ReadComparisonRecord(storage.comparisonRepository),
    });
    await registerModelAssuranceRoutes(app, {
      authenticator,
      createAssessment: new CreateModelAssuranceAssessment({
        clock,
        evaluationRepository: storage.evaluationRepository,
        modelAssuranceRepository: storage.modelAssuranceRepository,
      }),
      publishDefinition: new PublishModelAssuranceDefinition({
        clock,
        repository: storage.modelAssuranceRepository,
      }),
      readRecord: new ReadModelAssuranceRecord(storage.modelAssuranceRepository),
      recordExecution: new RecordModelAssuranceExecution({
        clock,
        repository: storage.modelAssuranceRepository,
      }),
      recordHumanReview: new RecordHumanReview({
        clock,
        repository: storage.modelAssuranceRepository,
      }),
    });
    await registerReplayRoutes(app, {
      authenticator,
      createJob: new CreateDurableReplayJob(storage.replayJobControlRepository),
      publishPlan: new PublishReplayPlan({
        clock,
        repository: storage.replayDefinitionRepository,
      }),
      publishTargetRelease: new PublishTargetRelease({
        clock,
        repository: storage.replayDefinitionRepository,
      }),
      readJob: new ReadReplayJob(storage.replayJobControlRepository),
      readPlan: new ReadReplayPlan(storage.replayDefinitionRepository),
      readTargetRelease: new ReadTargetRelease(storage.replayDefinitionRepository),
      requestCancellation: new RequestDurableReplayCancellation(storage.replayJobControlRepository),
    });
    if (storage.artifacts) {
      await registerArtifactRoutes(app, {
        authenticator,
        purgeArtifact: new PurgeArtifact({
          catalog: storage.artifacts.catalog,
          clock,
          identities: storage.artifacts.identities,
          objects: storage.artifacts.objects,
        }),
        readArtifact: new ReadArtifact({
          catalog: storage.artifacts.catalog,
          encryption: storage.artifacts.encryption,
          objects: storage.artifacts.objects,
        }),
        readArtifactMetadata: new ReadArtifactMetadata(storage.artifacts.catalog),
        reserveArtifact: new ReserveArtifact({
          catalog: storage.artifacts.catalog,
          clock,
          encryption: storage.artifacts.encryption,
          identities: storage.artifacts.identities,
        }),
        tombstoneArtifact: new TombstoneArtifact({
          catalog: storage.artifacts.catalog,
          clock,
          identities: storage.artifacts.identities,
        }),
        uploadArtifact: new UploadArtifact({
          catalog: storage.artifacts.catalog,
          clock,
          encryption: storage.artifacts.encryption,
          inspection: dependencies.artifactContentInspector ?? new StrictArtifactContentInspector(),
          objects: storage.artifacts.objects,
        }),
      });
    }
    if (storage.artifacts && storage.interactionFixtureVersionRepository) {
      const readRecordedFixtureMetadata = new ReadRecordedInteractionFixtureMetadata(
        storage.interactionFixtureVersionRepository,
      );
      await registerInteractionFixtureRoutes(app, {
        authenticator,
        exportRecordedFixtureContent: new ExportRecordedInteractionFixtureContent({
          catalog: storage.artifacts.catalog,
          readArtifact: new ReadArtifact({
            catalog: storage.artifacts.catalog,
            encryption: storage.artifacts.encryption,
            objects: storage.artifacts.objects,
          }),
          readRecordedFixtureMetadata,
        }),
        exportRecordedFixtureMetadata: new ExportRecordedInteractionFixtureMetadata({
          catalog: storage.artifacts.catalog,
          readRecordedFixtureMetadata,
        }),
        publishRecordedFixtureVersion: new PublishRecordedInteractionFixtureVersion({
          clock,
          versionRepository: storage.interactionFixtureVersionRepository,
        }),
        readRecordedFixtureMetadata,
        revokeRecordedFixtureContent: new RevokeRecordedInteractionFixtureContent({
          clock,
          identities: new SecureInteractionFixtureRevocationIdentityGenerator(),
          versionRepository: storage.interactionFixtureVersionRepository,
        }),
      });
    }
    const apiKeyLifecycle =
      dependencies.apiKeyLifecycle ??
      (identityStorage ? new ApiKeyLifecycle(identityStorage.repository) : undefined);
    await registerIdentityRoutes(app, {
      ...(apiKeyLifecycle ? { apiKeyLifecycle } : {}),
      authenticator,
    });

    app.setNotFoundHandler((request, reply) =>
      sendProblem(reply, {
        code: "route_not_found",
        detail: `No route matches ${request.method} ${request.url}`,
        requestId: request.id,
        status: 404,
        title: "Route not found",
        type: "https://proofstack.dev/problems/route-not-found",
      }),
    );

    app.setErrorHandler((error, request, reply) => {
      if (error instanceof ZodError) {
        return sendProblem(reply, {
          code: "invalid_request",
          detail: "The request does not match the required contract",
          issues: error.issues.map((issue) => ({
            message: issue.message,
            path: issue.path.join("."),
          })),
          requestId: request.id,
          status: 400,
          title: "Invalid request",
          type: "https://proofstack.dev/problems/invalid-request",
        });
      }

      if (error instanceof AuthenticationRequiredError) {
        if (config.authMode === "api_key" || config.authMode === "combined") {
          reply.header("www-authenticate", 'Bearer realm="proofstack"');
        }
        return sendProblem(reply, {
          code: "unauthenticated",
          detail: error.message,
          requestId: request.id,
          status: 401,
          title: "Authentication required",
          type: "https://proofstack.dev/problems/unauthenticated",
        });
      }

      if (error instanceof BrowserRequestRejectedError) {
        return sendProblem(reply, {
          code: "browser_request_rejected",
          detail: "Browser request origin or CSRF verification failed",
          requestId: request.id,
          status: 403,
          title: "Browser request rejected",
          type: "https://proofstack.dev/problems/browser-request-rejected",
        });
      }

      if (error instanceof InvalidOidcLoginError) {
        return sendProblem(reply, {
          code: "invalid_oidc_login",
          detail: "OIDC login is invalid or expired",
          requestId: request.id,
          status: 400,
          title: "Invalid OIDC login",
          type: "https://proofstack.dev/problems/invalid-oidc-login",
        });
      }

      if (error instanceof InvalidApiKeyLifecycleInputError) {
        return sendProblem(reply, {
          code: "invalid_api_key_request",
          detail: error.message,
          requestId: request.id,
          status: 400,
          title: "Invalid API key request",
          type: "https://proofstack.dev/problems/invalid-api-key-request",
        });
      }

      if (error instanceof ForbiddenError) {
        return sendProblem(reply, {
          code: error.code,
          detail: error.message,
          requestId: request.id,
          status: 403,
          title: "Forbidden",
          type: "https://proofstack.dev/problems/forbidden",
        });
      }

      if (error instanceof EvidenceConflictError) {
        return sendProblem(reply, {
          code: error.code,
          detail: error.message,
          requestId: request.id,
          status: 409,
          title: "Evidence conflict",
          type: "https://proofstack.dev/problems/evidence-conflict",
        });
      }

      if (error instanceof InvalidEvaluationRecordInputError) {
        return sendProblem(reply, {
          code: error.code,
          detail: "The evaluation request does not match the required immutable contract",
          requestId: request.id,
          status: 400,
          title: "Invalid evaluation request",
          type: "https://proofstack.dev/problems/evaluation-record-input-invalid",
        });
      }

      if (error instanceof EvaluationRecordNotFoundError) {
        return sendProblem(reply, {
          code: error.code,
          detail: error.message,
          requestId: request.id,
          status: 404,
          title: "Evaluation record not found",
          type: "https://proofstack.dev/problems/evaluation-record-not-found",
        });
      }

      if (
        error instanceof EvaluationLineageError ||
        error instanceof EvaluationRecordConflictError ||
        error instanceof EvaluationResourceConflictError
      ) {
        return sendProblem(reply, {
          code: error.code,
          detail: error.message,
          requestId: request.id,
          status: 409,
          title: "Evaluation graph conflict",
          type: `https://proofstack.dev/problems/${error.code.replaceAll("_", "-")}`,
        });
      }

      if (error instanceof EvaluationRepositoryContractError) {
        return sendProblem(reply, {
          code: "evaluation_storage_unavailable",
          detail: "Evaluation storage is unavailable",
          requestId: request.id,
          status: 503,
          title: "Evaluation storage unavailable",
          type: "https://proofstack.dev/problems/evaluation-storage-unavailable",
        });
      }

      if (error instanceof InvalidComparisonRecordInputError) {
        return sendProblem(reply, {
          code: error.code,
          detail: "The comparison request does not match the required immutable contract",
          requestId: request.id,
          status: 400,
          title: "Invalid comparison request",
          type: "https://proofstack.dev/problems/comparison-record-input-invalid",
        });
      }

      if (error instanceof ComparisonRecordNotFoundError) {
        return sendProblem(reply, {
          code: error.code,
          detail: error.message,
          requestId: request.id,
          status: 404,
          title: "Comparison record not found",
          type: "https://proofstack.dev/problems/comparison-record-not-found",
        });
      }

      if (
        error instanceof ComparisonLineageError ||
        error instanceof ComparisonRecordConflictError ||
        error instanceof ComparisonResourceConflictError ||
        error instanceof ComparisonSourceUnavailableError
      ) {
        return sendProblem(reply, {
          code: error.code,
          detail: error.message,
          requestId: request.id,
          status: 409,
          title: "Comparison graph conflict",
          type: `https://proofstack.dev/problems/${error.code.replaceAll("_", "-")}`,
        });
      }

      if (error instanceof ComparisonRepositoryContractError) {
        return sendProblem(reply, {
          code: "comparison_storage_unavailable",
          detail: "Comparison storage is unavailable",
          requestId: request.id,
          status: 503,
          title: "Comparison storage unavailable",
          type: "https://proofstack.dev/problems/comparison-storage-unavailable",
        });
      }

      if (error instanceof InvalidModelAssuranceRecordInputError) {
        return sendProblem(reply, {
          code: error.code,
          detail: "The model-assurance request does not match the required immutable contract",
          requestId: request.id,
          status: 400,
          title: "Invalid model-assurance request",
          type: "https://proofstack.dev/problems/model-assurance-record-input-invalid",
        });
      }

      if (error instanceof ModelAssuranceRecordNotFoundError) {
        return sendProblem(reply, {
          code: error.code,
          detail: error.message,
          requestId: request.id,
          status: 404,
          title: "Model-assurance record not found",
          type: "https://proofstack.dev/problems/model-assurance-record-not-found",
        });
      }

      if (
        error instanceof ModelAssuranceDependencyError ||
        error instanceof ModelAssuranceLineageError ||
        error instanceof ModelAssuranceRecordConflictError
      ) {
        return sendProblem(reply, {
          code: error.code,
          detail: error.message,
          requestId: request.id,
          status: 409,
          title: "Model-assurance graph conflict",
          type: `https://proofstack.dev/problems/${error.code.replaceAll("_", "-")}`,
        });
      }

      if (error instanceof ModelAssuranceRepositoryContractError) {
        return sendProblem(reply, {
          code: "model_assurance_storage_unavailable",
          detail: "Model-assurance storage is unavailable",
          requestId: request.id,
          status: 503,
          title: "Model-assurance storage unavailable",
          type: "https://proofstack.dev/problems/model-assurance-storage-unavailable",
        });
      }

      if (error instanceof InvalidArtifactLifecycleInputError) {
        return sendProblem(reply, {
          code: error.code,
          detail: "The artifact request does not match the required contract",
          requestId: request.id,
          status: 400,
          title: "Invalid artifact request",
          type: "https://proofstack.dev/problems/artifact-lifecycle-input-invalid",
        });
      }

      if (error instanceof ArtifactNotFoundError) {
        return sendProblem(reply, {
          code: error.code,
          detail: error.message,
          requestId: request.id,
          status: 404,
          title: "Artifact not found",
          type: "https://proofstack.dev/problems/artifact-not-found",
        });
      }

      if (
        error instanceof ArtifactConflictError ||
        error instanceof ArtifactObjectConflictError ||
        error instanceof ArtifactOwnedDeletionError ||
        error instanceof ArtifactOwnershipConflictError ||
        error instanceof ArtifactStateTransitionError ||
        error instanceof ArtifactUnavailableError
      ) {
        return sendProblem(reply, {
          code: error.code,
          detail: error.message,
          requestId: request.id,
          status: 409,
          title: "Artifact lifecycle conflict",
          type: `https://proofstack.dev/problems/${error.code.replaceAll("_", "-")}`,
        });
      }

      if (error instanceof ArtifactContentMismatchError) {
        return sendProblem(reply, {
          code: error.code,
          detail: error.message,
          requestId: request.id,
          status: 422,
          title: "Artifact content mismatch",
          type: "https://proofstack.dev/problems/artifact-content-mismatch",
        });
      }

      if (error instanceof ArtifactContentRejectedError) {
        return sendProblem(reply, {
          code: error.code,
          detail: error.message,
          requestId: request.id,
          status: 422,
          title: "Artifact content rejected",
          type: "https://proofstack.dev/problems/artifact-content-rejected",
        });
      }

      if (error instanceof InteractionContentExportTooLargeError) {
        return sendProblem(reply, {
          code: error.code,
          detail: error.message,
          requestId: request.id,
          status: 413,
          title: "Interaction content export too large",
          type: "https://proofstack.dev/problems/interaction-content-export-too-large",
        });
      }

      if (error instanceof InteractionExportStateChangedError) {
        return sendProblem(reply, {
          code: error.code,
          detail: error.message,
          requestId: request.id,
          status: 409,
          title: "Interaction export state changed",
          type: "https://proofstack.dev/problems/interaction-export-state-changed",
        });
      }

      if (
        error instanceof ArtifactIdentifierGenerationError ||
        error instanceof ArtifactContentInspectionUnavailableError ||
        error instanceof ArtifactObjectMissingError ||
        error instanceof ArtifactProtectionError ||
        error instanceof S3ArtifactObjectStoreError
      ) {
        return sendProblem(reply, {
          code: "artifact_storage_unavailable",
          detail: "Artifact storage is unavailable",
          requestId: request.id,
          status: 503,
          title: "Artifact storage unavailable",
          type: "https://proofstack.dev/problems/artifact-storage-unavailable",
        });
      }

      if (error instanceof InvalidRegressionVersionInputError) {
        return sendProblem(reply, {
          code: error.code,
          detail: "The regression version request does not match the required contract",
          requestId: request.id,
          status: 400,
          title: "Invalid regression version request",
          type: "https://proofstack.dev/problems/regression-version-input-invalid",
        });
      }

      if (
        error instanceof InvalidReplayDefinitionInputError ||
        error instanceof InvalidReplayJobInputError
      ) {
        return sendProblem(reply, {
          code: error.code,
          detail: "The replay request does not match the required contract",
          requestId: request.id,
          status: 400,
          title: "Invalid replay request",
          type: `https://proofstack.dev/problems/${error.code.replaceAll("_", "-")}`,
        });
      }

      if (
        error instanceof ReplayDefinitionNotFoundError ||
        error instanceof ReplayJobNotFoundError
      ) {
        return sendProblem(reply, {
          code: error.code,
          detail: error.message,
          requestId: request.id,
          status: 404,
          title: "Replay resource not found",
          type: `https://proofstack.dev/problems/${error.code.replaceAll("_", "-")}`,
        });
      }

      if (
        error instanceof ReplayDefinitionConflictError ||
        error instanceof ReplayDefinitionLineageError ||
        error instanceof ReplayJobConflictError
      ) {
        return sendProblem(reply, {
          code: error.code,
          detail: error.message,
          requestId: request.id,
          status: 409,
          title: "Replay control-plane conflict",
          type: `https://proofstack.dev/problems/${error.code.replaceAll("_", "-")}`,
        });
      }

      if (error instanceof RegressionVersionNotFoundError) {
        return sendProblem(reply, {
          code: error.code,
          detail: error.message,
          requestId: request.id,
          status: 404,
          title: "Regression version not found",
          type: "https://proofstack.dev/problems/regression-version-not-found",
        });
      }

      if (
        error instanceof RegressionVersionConflictError ||
        error instanceof RegressionVersionLineageError ||
        error instanceof RegressionArtifactBindingError ||
        error instanceof RegressionFixtureContentRevocationConflictError
      ) {
        return sendProblem(reply, {
          code: error.code,
          detail: error.message,
          requestId: request.id,
          status: 409,
          title: "Regression fixture conflict",
          type: `https://proofstack.dev/problems/${error.code.replaceAll("_", "-")}`,
        });
      }

      if (error instanceof ApiKeyCredentialNotFoundError) {
        return sendProblem(reply, {
          code: "api_key_not_found",
          detail: "The API key credential was not found",
          requestId: request.id,
          status: 404,
          title: "API key not found",
          type: "https://proofstack.dev/problems/api-key-not-found",
        });
      }

      if (error instanceof ApiKeyCredentialNotActiveError) {
        return sendProblem(reply, {
          code: "api_key_not_active",
          detail: "The API key credential is not active",
          requestId: request.id,
          status: 409,
          title: "API key not active",
          type: "https://proofstack.dev/problems/api-key-not-active",
        });
      }

      if (
        error instanceof ApiKeyGenerationError ||
        error instanceof OidcLoginGenerationError ||
        error instanceof IdentityManagementUnavailableError
      ) {
        return sendProblem(reply, {
          code: "identity_unavailable",
          detail: "Identity management is unavailable",
          requestId: request.id,
          status: 503,
          title: "Identity unavailable",
          type: "https://proofstack.dev/problems/identity-unavailable",
        });
      }

      if (error instanceof TraceNotFoundError) {
        return sendProblem(reply, {
          code: error.code,
          detail: error.message,
          requestId: request.id,
          status: 404,
          title: "Trace not found",
          type: "https://proofstack.dev/problems/trace-not-found",
        });
      }

      if (error instanceof InvalidTraceCursorError) {
        return sendProblem(reply, {
          code: error.code,
          detail: error.message,
          requestId: request.id,
          status: 400,
          title: "Invalid trace cursor",
          type: "https://proofstack.dev/problems/invalid-trace-cursor",
        });
      }

      const statusCode = clientErrorStatus(error);
      if (statusCode) {
        return sendProblem(reply, {
          code: `http_${statusCode}`,
          detail:
            statusCode === 413
              ? "The request body exceeds the configured size limit"
              : "The HTTP request was rejected",
          requestId: request.id,
          status: statusCode,
          title: "Request rejected",
          type: `https://proofstack.dev/problems/http-${statusCode}`,
        });
      }

      request.log.error({ error }, "Unhandled request error");
      return sendProblem(reply, {
        code: "internal_error",
        detail: "An unexpected error occurred",
        requestId: request.id,
        status: 500,
        title: "Internal server error",
        type: "https://proofstack.dev/problems/internal-error",
      });
    });

    await registerOtlpRoutes(app, {
      authenticator,
      compressedBodyLimitBytes: config.otlp.compressedBodyLimitBytes,
      decompressedBodyLimitBytes: config.otlp.decompressedBodyLimitBytes,
      ingestEvidence,
    });

    return app;
  } catch (error) {
    await app.close();
    throw error;
  }
}
