import type { PolicyEvaluationRequest } from "@proofstack/contracts";
import { digestPolicyEvaluationRequestDefinition } from "../policy/policy-evaluation-request-record-validation.js";
import type { PolicyEvaluationJobRepository } from "../policy/policy-evaluation-job-repository.js";
import { policyJobRepositoryRequestFixture } from "./policy-evaluation-job-repository-fixture.js";

export function policyJobConformanceRequest(
  scope = policyJobRepositoryRequestFixture.scope,
): PolicyEvaluationRequest {
  const request = structuredClone(policyJobRepositoryRequestFixture);
  request.scope = { ...scope };
  const {
    createdAt: _at,
    createdByPrincipalId: _by,
    definitionSha256: _sha,
    schemaVersion: _version,
    scope: _scope,
    ...definition
  } = request;
  request.definitionSha256 = digestPolicyEvaluationRequestDefinition(scope, definition);
  return request;
}
export interface PolicyJobConformanceHarness {
  readonly repository: PolicyEvaluationJobRepository;
  readonly setTime: (value: string) => Promise<void>;
}
export interface PolicyJobConformanceCase {
  readonly name: string;
  readonly run: (harness: PolicyJobConformanceHarness) => Promise<void>;
}
function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
export const policyJobRepositoryConformanceCases: readonly PolicyJobConformanceCase[] = [
  {
    name: "concurrent identical cancellation retains one original intent and state change",
    async run({ repository }) {
      const request = policyJobConformanceRequest();
      await repository.createJob({ request, jobId: "job_conformance" });
      const base = {
        scope: request.scope,
        jobId: "job_conformance",
        principalId: "principal_operator",
        reason: "operator_requested" as const,
      };
      const results = await Promise.all([
        repository.cancelJob({ ...base, cancellationId: "cancel_first" }),
        repository.cancelJob({ ...base, cancellationId: "cancel_second" }),
      ]);
      check(
        results[0]!.cancellation?.cancellationId === "cancel_first",
        "Original intent was lost",
      );
      check(
        results[1]!.cancellation?.cancellationId === results[0]!.cancellation?.cancellationId,
        "Duplicate cancellation changed intent",
      );
      check(
        results[0]!.job.stateVersion === results[1]!.job.stateVersion,
        "Duplicate cancellation appended another transition",
      );
    },
  },
  {
    name: "creates exact immutable request and detached scheduler records",
    async run({ repository }) {
      const request = policyJobConformanceRequest();
      const created = await repository.createJob({ request, jobId: "job_conformance" });
      check(created.created, "Expected a fresh job");
      created.snapshot.job.status = "failed";
      const retained = await repository.findJob(request.scope, "job_conformance");
      check(retained?.job.status === "queued", "Caller mutation changed retained state");
      check(
        retained.request.definitionSha256 === request.definitionSha256,
        "Request identity changed",
      );
    },
  },
  {
    name: "idempotent request retry preserves original job and receipts",
    async run({ repository, setTime }) {
      const request = policyJobConformanceRequest();
      const first = await repository.createJob({ request, jobId: "job_conformance" });
      await setTime("2026-09-07T12:00:01.000000Z");
      const retry = await repository.createJob({
        request: { ...request, createdAt: "2026-09-07T12:00:01.000Z" },
        jobId: "job_ignored_retry",
      });
      check(
        !retry.created && retry.snapshot.job.jobId === first.snapshot.job.jobId,
        "Retry changed job identity",
      );
      check(
        retry.snapshot.job.createdAt === first.snapshot.job.createdAt &&
          retry.snapshot.request.createdAt === first.snapshot.request.createdAt,
        "Retry changed original receipts",
      );
      check(
        (await repository.findJob(request.scope, "job_ignored_retry")) === null,
        "Retry created an extra job",
      );
    },
  },
  {
    name: "changed semantic request conflicts without overwriting original",
    async run({ repository }) {
      const request = policyJobConformanceRequest();
      await repository.createJob({ request, jobId: "job_conformance" });
      const changed = policyJobConformanceRequest();
      changed.evaluationTime = "2026-09-07T11:59:58.000Z";
      const {
        createdAt: _a,
        createdByPrincipalId: _b,
        definitionSha256: _c,
        schemaVersion: _d,
        scope: _e,
        ...definition
      } = changed;
      changed.definitionSha256 = digestPolicyEvaluationRequestDefinition(changed.scope, definition);
      let failed = false;
      try {
        await repository.createJob({ request: changed, jobId: "job_other" });
      } catch {
        failed = true;
      }
      check(failed, "Changed request was silently accepted");
      check(
        (await repository.findJob(request.scope, "job_conformance"))?.request.definitionSha256 ===
          request.definitionSha256,
        "Conflict overwrote original",
      );
      check(
        (await repository.findJob(request.scope, "job_other")) === null,
        "Conflict partially created a job",
      );
    },
  },
  {
    name: "three tenant collisions retain exact-scope opacity",
    async run({ repository }) {
      const scopes = ["tenant_first", "tenant_second", "tenant_third"].map((tenantId) => ({
        ...policyJobRepositoryRequestFixture.scope,
        tenantId,
      }));
      for (const scope of scopes)
        await repository.createJob({
          request: policyJobConformanceRequest(scope),
          jobId: "job_conformance",
        });
      for (const scope of scopes)
        check(
          (await repository.findJob(scope, "job_conformance"))?.job.scope.tenantId ===
            scope.tenantId,
          "Tenant collision changed ownership",
        );
      check(
        (await repository.findJob(
          { ...scopes[0]!, projectId: "project_outside" },
          "job_conformance",
        )) === null,
        "Outside project was disclosed",
      );
      check(
        (await repository.findJob(
          { ...scopes[0]!, environmentId: "environment_outside" },
          "job_conformance",
        )) === null,
        "Outside environment was disclosed",
      );
    },
  },
  {
    name: "concurrent duplicate claims admit exactly one live fence",
    async run({ repository, setTime }) {
      const request = policyJobConformanceRequest();
      await repository.createJob({ request, jobId: "job_conformance" });
      await setTime("2026-09-07T12:00:01.000000Z");
      const base = {
        scope: request.scope,
        jobId: "job_conformance",
        workerId: "worker_conformance",
      };
      const results = await Promise.allSettled([
        repository.claimJob({ ...base, attemptId: "attempt_first", leaseId: "lease_first" }),
        repository.claimJob({ ...base, attemptId: "attempt_second", leaseId: "lease_second" }),
      ]);
      check(
        results.filter((result) => result.status === "fulfilled").length === 1,
        "Duplicate claim issued two live leases",
      );
      const retained = await repository.findJob(request.scope, "job_conformance");
      check(
        retained?.attempts.length === 1 && retained.job.lastFencingToken === 1,
        "Duplicate claim partially mutated history",
      );
    },
  },
  {
    name: "over-budget reservation rolls back wholly",
    async run({ repository, setTime }) {
      const request = policyJobConformanceRequest();
      await repository.createJob({ request, jobId: "job_conformance" });
      await setTime("2026-09-07T12:00:01.000000Z");
      const claimed = await repository.claimJob({
        scope: request.scope,
        jobId: "job_conformance",
        workerId: "worker_conformance",
        attemptId: "attempt_first",
        leaseId: "lease_first",
      });
      let failed = false;
      try {
        await repository.reserveUsage({
          scope: request.scope,
          fence: claimed.job.currentLease!.mutationFence,
          delta: {
            reads: 0,
            records: request.limits.maxAcquisitionRecords + 1,
            recordBytes: 0,
            references: 0,
            referenceBytes: 0,
            artifactReadBytes: 0,
            ruleEvaluations: 0,
          },
        });
      } catch {
        failed = true;
      }
      check(failed, "Over-budget reservation was admitted");
      const retained = await repository.findJob(request.scope, "job_conformance");
      check(
        retained?.usage.records === 0 && retained.job.stateVersion === claimed.job.stateVersion,
        "Rejected reservation partially committed",
      );
    },
  },
  {
    name: "queued cancellation is idempotent and prevents subsequent claim",
    async run({ repository, setTime }) {
      const request = policyJobConformanceRequest();
      await repository.createJob({ request, jobId: "job_conformance" });
      await setTime("2026-09-07T12:00:00.234567Z");
      const command = {
        scope: request.scope,
        jobId: "job_conformance",
        cancellationId: "cancel_conformance",
        principalId: "principal_operator",
        reason: "operator_requested" as const,
      };
      const cancelled = await repository.cancelJob(command);
      await setTime("2026-09-07T12:00:01.000000Z");
      const repeated = await repository.cancelJob(command);
      check(
        repeated.cancellation?.requestedAt === cancelled.cancellation?.requestedAt &&
          repeated.job.stateVersion === cancelled.job.stateVersion,
        "Cancellation retry changed receipt or state",
      );
      let failed = false;
      try {
        await repository.claimJob({
          scope: request.scope,
          jobId: command.jobId,
          workerId: "worker_conformance",
          attemptId: "attempt_after_cancel",
          leaseId: "lease_after_cancel",
        });
      } catch {
        failed = true;
      }
      check(failed && repeated.attempts.length === 0, "Cancelled queued job fabricated an attempt");
    },
  },
];
