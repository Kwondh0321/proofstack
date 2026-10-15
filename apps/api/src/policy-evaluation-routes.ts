import {
  EnqueuePolicyEvaluationJobResponseSchema,
  MAX_POLICY_EVALUATION_CANCELLATION_REQUEST_BYTES,
  MAX_POLICY_EVALUATION_HISTORY_HEAD_RESPONSE_BYTES,
  MAX_POLICY_EVALUATION_JOB_HISTORY_PAGE_BYTES,
  MAX_POLICY_EVALUATION_JOB_RESPONSE_BYTES,
  MAX_POLICY_EVALUATION_REQUEST_BYTES,
  MAX_POLICY_EVALUATION_REQUEST_RESPONSE_BYTES,
  MAX_POLICY_EVALUATION_RESULT_RESPONSE_BYTES,
  MAX_POLICY_EVALUATION_SNAPSHOT_PAGE_RESPONSE_BYTES,
  MAX_POLICY_EVALUATION_SNAPSHOT_RESPONSE_BYTES,
  OpaqueIdSchema,
  PolicyEvaluationJobHistoryHeadSchema,
  PolicyEvaluationJobHistoryPageIndexSchema,
  PolicyEvaluationSnapshotPageIndexSchema,
  PrincipalContextSchema,
  ReadPolicyEvaluationJobHistoryHeadResponseSchema,
  ReadPolicyEvaluationJobHistoryPageResponseSchema,
  ReadPolicyEvaluationJobResponseSchema,
  ReadPolicyEvaluationRequestResponseSchema,
  ReadPolicyEvaluationResponseSchema,
  ReadPolicyEvaluationSnapshotPageResponseSchema,
  ReadPolicyEvaluationSnapshotResponseSchema,
  Sha256Schema,
  type PrincipalContext,
} from "@proofstack/contracts";
import {
  cancelPolicyEvaluationJobRequest,
  enqueuePolicyEvaluationJob,
  PolicyEvaluationJobNotFoundError,
  readPolicyEvaluationJob,
  readPolicyEvaluationJobHistoryHead,
  readPolicyEvaluationJobHistoryPage,
  readPolicyEvaluationResultRequest,
  readPolicyEvaluationSnapshotHeaderRequest,
  readPolicyEvaluationSnapshotPageRequest,
  requireCapability,
  requireEnvironmentAccess,
  type Clock,
  type PolicyEvaluationJobControlRepository,
  type PolicyEvaluationResultReader,
  type PolicyEvaluationSnapshotReader,
} from "@proofstack/core";
import type {
  FastifyInstance,
  FastifyRequest,
  onRequestAsyncHookHandler,
  onSendAsyncHookHandler,
} from "fastify";
import { z } from "zod";
import type { Authenticator } from "./auth.js";

export interface PolicyEvaluationRouteDependencies {
  readonly authenticator: Authenticator;
  readonly control: PolicyEvaluationJobControlRepository;
  readonly snapshots: PolicyEvaluationSnapshotReader;
  readonly results: PolicyEvaluationResultReader;
  readonly clock: Clock;
  readonly newJobId: () => string;
  readonly newCancellationId: () => string;
}
const ScopePath = z.object({ projectId: OpaqueIdSchema, environmentId: OpaqueIdSchema }).strict();
const JobPath = ScopePath.extend({ jobId: OpaqueIdSchema }).strict();
const PagePath = JobPath.extend({ pageIndex: z.string().regex(/^(0|[1-9][0-9]{0,3})$/) }).strict();
const SnapshotQuery = z
  .object({ snapshotId: OpaqueIdSchema, definitionSha256: Sha256Schema })
  .strict();
const HistoryQuery = z
  .object({
    jobDefinitionSha256: Sha256Schema,
    sequence: z.string().regex(/^(0|[1-9][0-9]{0,5})$/),
    entrySha256: Sha256Schema,
    graphSha256: Sha256Schema,
  })
  .strict();
const EmptyQuery = z.object({}).strict();
const readRateLimit = { max: 600, timeWindow: "1 minute" } as const;
const mutationRateLimit = { max: 60, timeWindow: "1 minute" } as const;
const preventCaching: onSendAsyncHookHandler = async (_request, reply, payload) => {
  reply.header("cache-control", "no-store");
  return payload;
};
function response<Schema extends z.ZodType>(
  schema: Schema,
  input: unknown,
  maximum: number,
): z.output<Schema> {
  const parsed = schema.safeParse(input);
  if (!parsed.success)
    throw new Error("Policy evaluation response violates its public contract", {
      cause: parsed.error,
    });
  if (Buffer.byteLength(JSON.stringify(parsed.data), "utf8") > maximum)
    throw new Error("Policy evaluation response exceeds its public transport budget");
  return parsed.data;
}
function present<T>(value: T | null): T {
  if (value === null) throw new PolicyEvaluationJobNotFoundError();
  return value;
}

/** Control/read ports only. No route, payload or caller identity can publish a computed result. */
export async function registerPolicyEvaluationRoutes(
  app: FastifyInstance,
  dependencies: PolicyEvaluationRouteDependencies,
) {
  const root = "/v1/projects/:projectId/environments/:environmentId/policy-evaluation-jobs";
  const job = `${root}/:jobId`;
  const principals = new WeakMap<FastifyRequest, PrincipalContext>();
  const repositories = {
    jobs: dependencies.control,
    snapshots: dependencies.snapshots,
    results: dependencies.results,
  };
  function authorize(
    capability: "policy:read" | "policy:evaluate" | "policy:evaluation:cancel",
  ): onRequestAsyncHookHandler {
    return async (request) => {
      const parsed = PrincipalContextSchema.safeParse(
        await dependencies.authenticator.authenticate(request),
      );
      if (!parsed.success)
        throw new Error("Policy evaluation authenticator returned an invalid principal", {
          cause: parsed.error,
        });
      const principal = parsed.data;
      requireCapability(principal, capability);
      const path = request.params as { projectId: string; environmentId: string };
      requireEnvironmentAccess(principal, path.projectId, path.environmentId);
      principals.set(request, principal);
    };
  }
  function command(request: FastifyRequest) {
    return { ...JobPath.parse(request.params), principal: principals.get(request)! };
  }
  const reads = {
    onRequest: authorize("policy:read"),
    onSend: preventCaching,
    config: { rateLimit: readRateLimit },
  };
  app.post(
    root,
    {
      bodyLimit: MAX_POLICY_EVALUATION_REQUEST_BYTES,
      onRequest: authorize("policy:evaluate"),
      onSend: preventCaching,
      config: { rateLimit: mutationRateLimit },
    },
    async (request, reply) => {
      EmptyQuery.parse(request.query);
      const path = ScopePath.parse(request.params);
      const result = await enqueuePolicyEvaluationJob(
        { ...path, principal: principals.get(request)!, input: request.body },
        {
          repository: dependencies.control,
          clock: dependencies.clock,
          newJobId: dependencies.newJobId,
        },
      );
      return reply
        .status(result.created ? 201 : 200)
        .send(
          response(
            EnqueuePolicyEvaluationJobResponseSchema,
            { ...result, requestId: request.id },
            MAX_POLICY_EVALUATION_JOB_RESPONSE_BYTES,
          ),
        );
    },
  );
  app.get(job, reads, async (request) => {
    const route = command(request);
    EmptyQuery.parse(request.query);
    const snapshot = present(await readPolicyEvaluationJob(route, dependencies.control));
    return response(
      ReadPolicyEvaluationJobResponseSchema,
      { snapshot, requestId: request.id },
      MAX_POLICY_EVALUATION_JOB_RESPONSE_BYTES,
    );
  });
  app.post(
    `${job}/cancellation`,
    {
      bodyLimit: MAX_POLICY_EVALUATION_CANCELLATION_REQUEST_BYTES,
      onRequest: authorize("policy:evaluation:cancel"),
      onSend: preventCaching,
      config: { rateLimit: mutationRateLimit },
    },
    async (request) => {
      const route = command(request);
      EmptyQuery.parse(request.query);
      const snapshot = await cancelPolicyEvaluationJobRequest(
        { ...route, input: request.body },
        { repository: dependencies.control, newCancellationId: dependencies.newCancellationId },
      );
      return response(
        ReadPolicyEvaluationJobResponseSchema,
        { snapshot, requestId: request.id },
        MAX_POLICY_EVALUATION_JOB_RESPONSE_BYTES,
      );
    },
  );
  app.get(`${job}/request`, reads, async (request) => {
    const route = command(request);
    EmptyQuery.parse(request.query);
    const graph = present(await readPolicyEvaluationJob(route, dependencies.control));
    return response(
      ReadPolicyEvaluationRequestResponseSchema,
      { request: graph.request, requestId: request.id },
      MAX_POLICY_EVALUATION_REQUEST_RESPONSE_BYTES,
    );
  });
  app.get(`${job}/snapshot`, reads, async (request) => {
    const route = command(request);
    EmptyQuery.parse(request.query);
    const snapshot = present(await readPolicyEvaluationSnapshotHeaderRequest(route, repositories));
    return response(
      ReadPolicyEvaluationSnapshotResponseSchema,
      { snapshot, requestId: request.id },
      MAX_POLICY_EVALUATION_SNAPSHOT_RESPONSE_BYTES,
    );
  });
  app.get(`${job}/snapshot/pages/:pageIndex`, reads, async (request) => {
    const path = PagePath.parse(request.params),
      snapshot = SnapshotQuery.parse(request.query);
    const pageIndex = PolicyEvaluationSnapshotPageIndexSchema.parse(Number(path.pageIndex));
    const { pageIndex: _page, ...route } = path;
    const result = present(
      await readPolicyEvaluationSnapshotPageRequest(
        { ...route, principal: principals.get(request)!, snapshot, pageIndex },
        repositories,
      ),
    );
    return response(
      ReadPolicyEvaluationSnapshotPageResponseSchema,
      { ...result, requestId: request.id },
      MAX_POLICY_EVALUATION_SNAPSHOT_PAGE_RESPONSE_BYTES,
    );
  });
  app.get(`${job}/result`, reads, async (request) => {
    const route = command(request);
    EmptyQuery.parse(request.query);
    const evaluation = present(await readPolicyEvaluationResultRequest(route, repositories));
    return response(
      ReadPolicyEvaluationResponseSchema,
      { evaluation, requestId: request.id },
      MAX_POLICY_EVALUATION_RESULT_RESPONSE_BYTES,
    );
  });
  app.get(`${job}/history`, reads, async (request) => {
    const route = command(request);
    EmptyQuery.parse(request.query);
    const head = present(await readPolicyEvaluationJobHistoryHead(route, dependencies.control));
    return response(
      ReadPolicyEvaluationJobHistoryHeadResponseSchema,
      { head, requestId: request.id },
      MAX_POLICY_EVALUATION_HISTORY_HEAD_RESPONSE_BYTES,
    );
  });
  app.get(`${job}/history/pages/:pageIndex`, reads, async (request) => {
    const path = PagePath.parse(request.params),
      query = HistoryQuery.parse(request.query);
    const principal = principals.get(request)!;
    const pageIndex = PolicyEvaluationJobHistoryPageIndexSchema.parse(Number(path.pageIndex));
    const head = PolicyEvaluationJobHistoryHeadSchema.parse({
      scope: {
        tenantId: principal.tenantId,
        projectId: path.projectId,
        environmentId: path.environmentId,
      },
      job: { jobId: path.jobId, definitionSha256: query.jobDefinitionSha256 },
      sequence: Number(query.sequence),
      entrySha256: query.entrySha256,
      graphSha256: query.graphSha256,
    });
    const { pageIndex: _page, ...route } = path;
    const page = await readPolicyEvaluationJobHistoryPage(
      { ...route, principal, head, pageIndex },
      dependencies.control,
    );
    return response(
      ReadPolicyEvaluationJobHistoryPageResponseSchema,
      { page, requestId: request.id },
      MAX_POLICY_EVALUATION_JOB_HISTORY_PAGE_BYTES,
    );
  });
}
