import {
  type EvidenceScope,
  type PolicyEvaluationRequest,
  serializeEvaluationCanonicalJson,
} from "@proofstack/contracts";
import type {
  PolicyEvaluationAcquisitionRepository,
  PolicyEvaluationJobControlRepository,
  PolicyEvaluationJobWorkerRepository,
} from "../policy/policy-evaluation-job-repository.js";
import { policyJobConformanceRequest } from "./policy-evaluation-job-repository-conformance.js";

export interface PolicyAcquisitionConformanceHarness {
  readonly control: PolicyEvaluationJobControlRepository;
  readonly worker: PolicyEvaluationJobWorkerRepository;
  readonly acquisition: PolicyEvaluationAcquisitionRepository;
  request(scope?: EvidenceScope): PolicyEvaluationRequest;
}
function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function same(a: unknown, b: unknown) {
  return serializeEvaluationCanonicalJson(a) === serializeEvaluationCanonicalJson(b);
}
async function start(h: PolicyAcquisitionConformanceHarness) {
  const created = await h.control.createJob({
    request: h.request(),
    jobId: "job_acquisition_conformance",
  });
  const scope = created.snapshot.job.scope;
  const claimed = await h.worker.claimJob({
    scope,
    jobId: created.snapshot.job.jobId,
    workerId: "worker_acquisition",
    attemptId: "attempt_acquisition",
    leaseId: "lease_acquisition",
  });
  const fence = claimed.job.currentLease?.mutationFence;
  check(fence, "Missing acquiring fence");
  return { scope, fence, claimed };
}
export const policyAcquisitionRepositoryConformanceCases: readonly {
  name: string;
  run(h: PolicyAcquisitionConformanceHarness): Promise<void>;
}[] = [
  {
    name: "fresh credit preserves the original lease and duplicate credit creates no history",
    async run(h) {
      const f = await start(h);
      const before = await h.control.findHistoryHead(f.scope, f.fence.jobId);
      const first = await h.acquisition.reserveAcquisition({
        scope: f.scope,
        fence: f.fence,
        allowanceId: "allowance_conformance",
      });
      check(first.created && first.allowance, "Missing fresh committed allowance");
      check(same(first.snapshot.usage, f.claimed.usage), "Unused credit became spent usage");
      check(
        same(first.snapshot.job.currentLease, f.claimed.job.currentLease),
        "Credit extended its lease",
      );
      const head = await h.control.findHistoryHead(f.scope, f.fence.jobId);
      check(
        head?.sequence === (before?.sequence ?? -1) + 1,
        "Credit is missing its one history entry",
      );
      const duplicate = await h.acquisition.reserveAcquisition({
        scope: f.scope,
        fence: f.fence,
        allowanceId: "allowance_conformance",
      });
      check(
        !duplicate.created && same(duplicate.snapshot, first.snapshot),
        "Duplicate changed original credit",
      );
      check(
        same(await h.control.findHistoryHead(f.scope, f.fence.jobId), head),
        "Duplicate appended history",
      );
    },
  },
  {
    name: "observed work settles monotonically and a closed occurrence cannot fund another acquisition",
    async run(h) {
      const f = await start(h);
      await h.acquisition.reserveAcquisition({
        scope: f.scope,
        fence: f.fence,
        allowanceId: "allowance_conformance",
      });
      const usage = { reads: 3, records: 2, references: 1, recordBytes: 17, referenceBytes: 11 };
      const settled = await h.acquisition.settleAcquisition({
        scope: f.scope,
        fence: f.fence,
        allowanceId: "allowance_conformance",
        usage,
      });
      check(
        same(settled.usage, { ...f.claimed.usage, ...usage }),
        "Settlement lost the observed spent counters",
      );
      check(settled.acquisitionAllowance === null, "Settlement left live credit");
      let rejected = false;
      try {
        await h.acquisition.reserveAcquisition({
          scope: f.scope,
          fence: f.fence,
          allowanceId: "allowance_conformance",
        });
      } catch {
        rejected = true;
      }
      check(rejected, "Closed occurrence was reused");
      const second = await h.acquisition.reserveAcquisition({
        scope: f.scope,
        fence: f.fence,
        allowanceId: "allowance_next",
      });
      check(
        second.allowance?.limits.recordAndReferenceBytes ===
          settled.request.limits.maxAcquisitionRecordBytes - 28,
        "Next allowance refunded spent bytes",
      );
    },
  },
  {
    name: "unknown in-flight work consumes its whole frozen credit and closes budget-exhausted",
    async run(h) {
      const f = await start(h);
      await h.acquisition.reserveAcquisition({
        scope: f.scope,
        fence: f.fence,
        allowanceId: "allowance_conformance",
      });
      const settled = await h.acquisition.settleAcquisition({
        scope: f.scope,
        fence: f.fence,
        allowanceId: "allowance_conformance",
        usage: null,
      });
      check(
        settled.job.status === "budget_exhausted" && settled.job.currentLease === null,
        "Unknown work revived authority",
      );
      check(
        settled.usage.reads === settled.request.limits.maxAcquisitionRecords,
        "Unknown read credit disappeared",
      );
      check(
        settled.usage.recordBytes + settled.usage.referenceBytes ===
          settled.request.limits.maxAcquisitionRecordBytes,
        "Unknown byte credit disappeared",
      );
      check(
        same(settled.attempts.at(-1)?.usageAtClose, settled.usage),
        "Closed attempt lost billing",
      );
    },
  },
  {
    name: "scope and fence substitutions preserve the original open allowance",
    async run(h) {
      const f = await start(h);
      const held = await h.acquisition.reserveAcquisition({
        scope: f.scope,
        fence: f.fence,
        allowanceId: "allowance_conformance",
      });
      for (const command of [
        { scope: { ...f.scope, tenantId: "tenant_foreign" }, fence: f.fence },
        { scope: f.scope, fence: { ...f.fence, workerId: "worker_foreign" } },
        { scope: f.scope, fence: { ...f.fence, recoveryEpoch: f.fence.recoveryEpoch + 1 } },
      ]) {
        let rejected = false;
        try {
          await h.acquisition.settleAcquisition({
            ...command,
            allowanceId: "allowance_conformance",
            usage: null,
          });
        } catch {
          rejected = true;
        }
        check(rejected, "Foreign settlement succeeded");
      }
      check(
        same(await h.control.findJob(f.scope, f.fence.jobId), held.snapshot),
        "Rejected settlement changed original credit",
      );
    },
  },
  {
    name: "cancellation preserves uncertain cost and its original idempotent terminal receipt",
    async run(h) {
      const f = await start(h);
      await h.acquisition.reserveAcquisition({
        scope: f.scope,
        fence: f.fence,
        allowanceId: "allowance_conformance",
      });
      const command = {
        scope: f.scope,
        jobId: f.fence.jobId,
        cancellationId: "cancel_acquisition",
        principalId: "operator_acquisition",
        reason: "operator_requested" as const,
      };
      const cancelled = await h.control.cancelJob(command);
      check(
        cancelled.job.status === "cancelled" && cancelled.acquisitionAllowance === null,
        "Cancellation retained live credit",
      );
      check(
        cancelled.usage.records === cancelled.request.limits.maxAcquisitionRecords,
        "Cancellation refunded uncertain records",
      );
      check(
        same(await h.control.cancelJob(command), cancelled),
        "Cancellation retry changed original billing/receipt",
      );
    },
  },
];
export { policyJobConformanceRequest };
