import {
  type PolicyEvaluationRequest,
  serializeEvaluationCanonicalJson,
} from "@proofstack/contracts";
import type { PolicyEvaluationJobRepository } from "../policy/policy-evaluation-job-repository.js";
import { digestPolicyEvaluationRequestDefinition } from "../policy/policy-evaluation-request-record-validation.js";
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
export function createPolicyJobRepositoryConformanceCases(
  requestFixture = policyJobConformanceRequest,
): readonly PolicyJobConformanceCase[] {
  return [
    {
      name: "exact earlier history head survives a later claim without substitution",
      async run({ repository, setTime }) {
        const request = requestFixture();
        await repository.createJob({ request, jobId: "job_conformance" });
        const initial = await repository.findHistoryHead(request.scope, "job_conformance");
        check(initial !== null && initial.sequence === 0, "Creation has no exact history head");
        await setTime("2026-09-07T12:00:01.000000Z");
        await repository.claimJob({
          scope: request.scope,
          jobId: "job_conformance",
          workerId: "worker_conformance",
          attemptId: "attempt_first",
          leaseId: "lease_first",
        });
        const current = await repository.findHistoryHead(request.scope, "job_conformance");
        check(
          current?.sequence === 1 && current.entrySha256 !== initial.entrySha256,
          "Claim did not atomically append history",
        );
        const old = await repository.readHistoryPage(initial, 0);
        check(
          old.entries.length === 1 && old.head.entrySha256 === initial.entrySha256,
          "Current head replaced original prefix",
        );
      },
    },
    {
      name: "identical reservation retries retain original receipt and charge once",
      async run({ repository }) {
        const request = requestFixture();
        await repository.createJob({ request, jobId: "job_conformance" });
        const claimed = await repository.claimJob({
          scope: request.scope,
          jobId: "job_conformance",
          workerId: "worker_conformance",
          attemptId: "attempt_first",
          leaseId: "lease_first",
        });
        const command = {
          scope: request.scope,
          fence: claimed.job.currentLease!.mutationFence,
          reservationId: "reservation_conformance",
          delta: { ...claimed.usage, reads: 1, recordBytes: 128 },
        };
        const first = await repository.reserveWork(command);
        const second = await repository.reserveWork(command);
        check(
          first.created &&
            !second.created &&
            first.reservation?.entrySha256 === second.reservation?.entrySha256,
          "Reservation retry lost original receipt or charged twice",
        );
        check(
          second.snapshot.usage.reads === 1 && second.snapshot.usage.recordBytes === 128,
          "Repeated acknowledgement changed original charge",
        );
      },
    },
    {
      name: "changed reservation conflicts without partial graph or history change",
      async run({ repository }) {
        const request = requestFixture();
        await repository.createJob({ request, jobId: "job_conformance" });
        const claimed = await repository.claimJob({
          scope: request.scope,
          jobId: "job_conformance",
          workerId: "worker_conformance",
          attemptId: "attempt_first",
          leaseId: "lease_first",
        });
        const command = {
          scope: request.scope,
          fence: claimed.job.currentLease!.mutationFence,
          reservationId: "reservation_conformance",
          delta: { ...claimed.usage, records: 1 },
        };
        const first = await repository.reserveWork(command);
        const head = await repository.findHistoryHead(request.scope, "job_conformance");
        let failed = false;
        try {
          await repository.reserveWork({ ...command, delta: { ...command.delta, records: 2 } });
        } catch {
          failed = true;
        }
        check(failed, "Changed reservation was accepted");
        const retained = await repository.findJob(request.scope, "job_conformance");
        const retainedHead = await repository.findHistoryHead(request.scope, "job_conformance");
        check(
          retained?.job.stateVersion === first.snapshot.job.stateVersion &&
            retained.usage.records === 1 &&
            retainedHead?.entrySha256 === head?.entrySha256,
          "Changed reservation partially committed",
        );
      },
    },
    {
      name: "concurrent identical cancellation retains one original intent and state change",
      async run({ repository }) {
        const request = requestFixture();
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
          results[0]!.cancellation !== null &&
            ["cancel_first", "cancel_second"].includes(results[0]!.cancellation.cancellationId),
          "Cancellation did not retain either admitted original intent",
        );
        check(
          results[1]!.cancellation?.cancellationId === results[0]!.cancellation?.cancellationId,
          "Duplicate cancellation changed intent",
        );
        check(
          results[0]!.job.stateVersion === results[1]!.job.stateVersion,
          "Duplicate cancellation appended another transition",
        );
        check(
          serializeEvaluationCanonicalJson(results[0]) ===
            serializeEvaluationCanonicalJson(results[1]),
          "Concurrent cancellation returned different original graphs or receipts",
        );
        const head = await repository.findHistoryHead(request.scope, "job_conformance");
        check(
          head?.sequence === 1,
          "Concurrent cancellation did not retain exactly one transition",
        );
        const page = await repository.readHistoryPage(head, 0);
        check(
          page.entries.length === 2 && page.entries[1]!.definition.operation.kind === "cancel",
          "Concurrent cancellation history omitted or duplicated the original event",
        );
      },
    },
    {
      name: "creates exact immutable request and detached scheduler records",
      async run({ repository }) {
        const request = requestFixture();
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
        const request = requestFixture();
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
        const request = requestFixture();
        await repository.createJob({ request, jobId: "job_conformance" });
        const changed = requestFixture();
        changed.evaluationTime = "2026-09-07T11:59:58.000Z";
        const {
          createdAt: _a,
          createdByPrincipalId: _b,
          definitionSha256: _c,
          schemaVersion: _d,
          scope: _e,
          ...definition
        } = changed;
        changed.definitionSha256 = digestPolicyEvaluationRequestDefinition(
          changed.scope,
          definition,
        );
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
          ...requestFixture().scope,
          tenantId,
        }));
        for (const scope of scopes)
          await repository.createJob({
            request: requestFixture(scope),
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
        const request = requestFixture();
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
        const request = requestFixture();
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
        const request = requestFixture();
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
        check(
          failed && repeated.attempts.length === 0,
          "Cancelled queued job fabricated an attempt",
        );
      },
    },
  ];
}
export const policyJobRepositoryConformanceCases = createPolicyJobRepositoryConformanceCases();
