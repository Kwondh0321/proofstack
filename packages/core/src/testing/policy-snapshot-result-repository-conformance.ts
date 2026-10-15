import {
  serializeEvaluationCanonicalJson,
  POLICY_EVALUATION_JOB_HISTORY_PAGE_SIZE,
  type EvidenceScope,
  type PolicyEvaluationSnapshot,
  type PolicyEvaluationSnapshotPageSet,
  type PolicyEvaluationWorkerMutationFence,
} from "@proofstack/contracts";
import type {
  PolicyEvaluationJobControlRepository,
  PolicyEvaluationJobWorkerRepository,
  PolicyEvaluationJobComputationRepository,
} from "../policy/policy-evaluation-job-repository.js";
import type {
  PolicyEvaluationSnapshotReader,
  PolicyEvaluationSnapshotReadIdentity,
} from "../policy/policy-evaluation-snapshot-repository.js";
import { readCompletePolicyEvaluationSnapshot } from "../policy/policy-evaluation-snapshot-repository.js";
import type {
  PolicyEvaluationResultPublisher,
  PolicyEvaluationResultReader,
} from "../policy/policy-evaluation-result-repository.js";
import { validatePolicyEvaluationSnapshotRecord } from "../policy/policy-evaluation-snapshot-record-validation.js";

export interface PolicySnapshotResultRepositoryHarness {
  /** Prepare through the owning backend. Source guard/publication proof remains backend-specific. */
  seed(): Promise<{
    scope: EvidenceScope;
    jobId: string;
    fence: PolicyEvaluationWorkerMutationFence;
    expected: PolicyEvaluationSnapshotReadIdentity;
    snapshot: PolicyEvaluationSnapshot;
    pageSet: PolicyEvaluationSnapshotPageSet;
    evaluationId: string;
  }>;
  readonly control: Pick<
    PolicyEvaluationJobControlRepository,
    "findJob" | "findHistoryHead" | "readHistoryPage" | "cancelJob"
  >;
  readonly worker: Pick<PolicyEvaluationJobWorkerRepository, "reserveWork"> &
    PolicyEvaluationJobComputationRepository &
    Pick<PolicyEvaluationJobWorkerRepository, "claimJob" | "interruptJob">;
  readonly snapshots: PolicyEvaluationSnapshotReader;
  readonly results: PolicyEvaluationResultPublisher & PolicyEvaluationResultReader;
  waitForRetry(retryAt: string): Promise<void>;
}
function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function same(a: unknown, b: unknown) {
  return serializeEvaluationCanonicalJson(a) === serializeEvaluationCanonicalJson(b);
}
async function reject(operation: () => Promise<unknown>, message: string) {
  let rejected = false;
  try {
    await operation();
  } catch {
    rejected = true;
  }
  check(rejected, message);
}
async function ready(
  h: PolicySnapshotResultRepositoryHarness,
  seed: Awaited<ReturnType<typeof h.seed>>,
  paid = true,
  reservationId = "reservation_shared_rules",
) {
  const admitted = await h.control.findJob(seed.scope, seed.jobId);
  if (admitted?.job.status === "sealed")
    await h.worker.startComputation({ scope: seed.scope, fence: seed.fence });
  else check(admitted?.job.status === "running", "Expected sealed or reclaimed running job");
  if (paid) {
    const { inputs } = validatePolicyEvaluationSnapshotRecord({
      expected: { ...seed.expected, jobId: seed.jobId },
      record: seed.snapshot,
      pageSet: seed.pageSet,
    });
    await h.worker.reserveWork({
      scope: seed.scope,
      fence: seed.fence,
      reservationId,
      delta: {
        reads: 0,
        records: 0,
        references: 0,
        recordBytes: 0,
        referenceBytes: 0,
        artifactReadBytes: 0,
        ruleEvaluations: inputs.rules.ruleCount,
      },
    });
  }
  return {
    scope: seed.scope,
    fence: seed.fence,
    evaluationId: seed.evaluationId,
    pageSet: seed.pageSet,
  };
}
export const policySnapshotResultRepositoryConformanceCases: readonly {
  readonly name: string;
  run(h: PolicySnapshotResultRepositoryHarness): Promise<void>;
}[] = [
  {
    name: "reclaimed attempts reuse the original seal, retain prior work and reject the stale worker",
    async run(h) {
      const f = await h.seed();
      await ready(h, f);
      const closed = await h.worker.interruptJob({
        scope: f.scope,
        fence: f.fence,
        reason: "worker_interrupted",
      });
      check(
        closed.job.status === "retry_ready" && closed.job.retryAt,
        "Fixture must permit its fixed operational retry",
      );
      await h.waitForRetry(closed.job.retryAt);
      const claimed = await h.worker.claimJob({
        scope: f.scope,
        jobId: f.jobId,
        workerId: "worker_shared_retry",
        attemptId: "attempt_shared_retry",
        leaseId: "lease_shared_retry",
      });
      const fence = claimed.job.currentLease?.mutationFence;
      check(
        fence && fence.fencingToken > f.fence.fencingToken,
        "Reclaim did not fence the old worker",
      );
      check(same(claimed.job.snapshot, f.expected.snapshot), "Retry changed original snapshot");
      const command = await ready(h, { ...f, fence }, true, "reservation_shared_retry");
      const before = await h.control.findJob(f.scope, f.jobId);
      await reject(
        () => h.results.publishResult({ ...command, fence: f.fence }),
        "Old worker published after reclaim",
      );
      check(
        same(await h.control.findJob(f.scope, f.jobId), before),
        "Stale worker changed the new attempt",
      );
      const result = await h.results.publishResult(command);
      check(
        result.evaluation.workerId === fence.workerId &&
          result.evaluation.fencingToken === fence.fencingToken,
        "Result lost its deciding new fence",
      );
      check(
        result.snapshot.usage.ruleEvaluations === closed.usage.ruleEvaluations * 2,
        "Retry refunded old work or omitted its fresh complete charge",
      );
      check(
        same(await readCompletePolicyEvaluationSnapshot(h.snapshots, f.expected), {
          snapshot: f.snapshot,
          pageSet: f.pageSet,
        }),
        "Retry refreshed or relabeled original inputs",
      );
    },
  },
  {
    name: "exact original header/pages remain complete and copied, with no latest substitution",
    async run(h) {
      const f = await h.seed();
      check(
        same(await readCompletePolicyEvaluationSnapshot(h.snapshots, f.expected), {
          snapshot: f.snapshot,
          pageSet: f.pageSet,
        }),
        "Original retained page set changed",
      );
      const root = (await h.snapshots.findSnapshot(f.expected))!;
      root.sealedByPrincipalId = "changed_client_copy";
      const page = (await h.snapshots.readSnapshotPage(f.expected, 0))!;
      page.frames[0]!.dataBase64url = "e30";
      check(
        same(await readCompletePolicyEvaluationSnapshot(h.snapshots, f.expected), {
          snapshot: f.snapshot,
          pageSet: f.pageSet,
        }),
        "Client mutation changed retained material",
      );
      check(
        (await h.snapshots.findSnapshot({
          ...f.expected,
          snapshot: { ...f.expected.snapshot, snapshotId: "snapshot_absent_shared" },
        })) === null,
        "Missing exact reference selected a latest seal",
      );
      await reject(
        () => h.snapshots.readSnapshotPage(f.expected, f.snapshot.pages.length),
        "Out-of-range page was accepted",
      );
    },
  },
  {
    name: "whole paid result closes its deciding attempt/job/history without changing original seal",
    async run(h) {
      const f = await h.seed();
      const command = await ready(h, f);
      const result = await h.results.publishResult(command);
      check(
        result.created &&
          result.snapshot.job.status === "completed" &&
          result.snapshot.job.currentLease === null,
        "Result lacks one terminal owning job",
      );
      check(
        same(result.snapshot.job.snapshot, f.expected.snapshot),
        "Completion changed the original snapshot reference",
      );
      check(
        same(await h.results.findResult(f.scope, f.jobId, f.pageSet), result.evaluation),
        "Authoritative read substituted result evidence",
      );
      const head = (await h.control.findHistoryHead(f.scope, f.jobId))!;
      const page = await h.control.readHistoryPage(
        head,
        Math.floor(head.sequence / POLICY_EVALUATION_JOB_HISTORY_PAGE_SIZE),
      );
      check(
        page.entries.at(-1)?.definition.operation.kind === "complete",
        "Completion has no atomic final history transition",
      );
      check(
        same(await readCompletePolicyEvaluationSnapshot(h.snapshots, f.expected), {
          snapshot: f.snapshot,
          pageSet: f.pageSet,
        }),
        "Completion relabeled original seal receipts",
      );
    },
  },
  {
    name: "exact completed retry preserves receipts/history and rejects new result or worker identity",
    async run(h) {
      const f = await h.seed();
      const command = await ready(h, f);
      const first = await h.results.publishResult(command);
      const head = await h.control.findHistoryHead(f.scope, f.jobId);
      const retry = await h.results.publishResult(command);
      check(
        !retry.created && same({ ...retry, created: true }, first),
        "Retry changed original result or receipts",
      );
      check(
        same(await h.control.findHistoryHead(f.scope, f.jobId), head),
        "Retry appended history",
      );
      await reject(
        () => h.results.publishResult({ ...command, evaluationId: "evaluation_other_shared" }),
        "Completed result identity could change",
      );
      await reject(
        () =>
          h.results.publishResult({
            ...command,
            fence: { ...f.fence, workerId: "worker_other_shared" },
          }),
        "Historical retry accepted another worker",
      );
    },
  },
  {
    name: "unpaid rule work leaves the running graph/history/result wholly unchanged",
    async run(h) {
      const f = await h.seed();
      const command = await ready(h, f, false);
      const before = await h.control.findJob(f.scope, f.jobId),
        head = await h.control.findHistoryHead(f.scope, f.jobId);
      await reject(() => h.results.publishResult(command), "Unpaid computation was accepted");
      check(
        same(await h.control.findJob(f.scope, f.jobId), before),
        "Unpaid computation changed graph",
      );
      check(
        same(await h.control.findHistoryHead(f.scope, f.jobId), head),
        "Unpaid computation changed history",
      );
      check(
        (await h.results.findResult(f.scope, f.jobId, f.pageSet)) === null,
        "Unpaid computation wrote a result",
      );
    },
  },
  {
    name: "forged caller pages cannot replace the retained seal or partially publish a paid result",
    async run(h) {
      const f = await h.seed();
      const command = await ready(h, f);
      const forged = structuredClone(f.pageSet);
      forged.pages[0]!.frames[0]!.dataBase64url = "e30";
      const before = await h.control.findJob(f.scope, f.jobId),
        head = await h.control.findHistoryHead(f.scope, f.jobId);
      await reject(
        () => h.results.publishResult({ ...command, pageSet: forged }),
        "Caller substituted sealed pages",
      );
      check(
        same(await h.control.findJob(f.scope, f.jobId), before),
        "Forged pages partially changed graph",
      );
      check(
        same(await h.control.findHistoryHead(f.scope, f.jobId), head),
        "Forged pages partially changed history",
      );
      check(
        (await h.results.findResult(f.scope, f.jobId, f.pageSet)) === null,
        "Forged pages wrote a result",
      );
    },
  },
  {
    name: "cancellation retains original material and prevents result publication",
    async run(h) {
      const f = await h.seed();
      const command = await ready(h, f);
      await h.control.cancelJob({
        scope: f.scope,
        jobId: f.jobId,
        cancellationId: "cancellation_shared_store",
        principalId: "operator_shared_store",
        reason: "operator_requested",
      });
      const before = await h.control.findJob(f.scope, f.jobId),
        head = await h.control.findHistoryHead(f.scope, f.jobId);
      await reject(() => h.results.publishResult(command), "Cancelled attempt published result");
      check(
        same(await h.control.findJob(f.scope, f.jobId), before),
        "Publication changed cancelled graph",
      );
      check(
        same(await h.control.findHistoryHead(f.scope, f.jobId), head),
        "Publication changed cancelled history",
      );
      check(
        same(await readCompletePolicyEvaluationSnapshot(h.snapshots, f.expected), {
          snapshot: f.snapshot,
          pageSet: f.pageSet,
        }),
        "Cancellation erased original seal",
      );
    },
  },
];
