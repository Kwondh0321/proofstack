import { randomUUID } from "node:crypto";
import {
  EvidenceScopeSchema,
  OpaqueIdSchema,
  PolicyEvaluationTimeSchema,
  PolicyEvaluationRequestReferenceSchema,
  PolicyEvaluationJobSnapshotSchema,
  serializeEvaluationCanonicalJson,
  type EvidenceScope,
  type PolicyEvaluationJobSnapshot,
  type PolicyEvaluationJobHistoryEntry,
  type PolicyEvaluationJobHistoryEntryDefinition,
  type PolicyEvaluationJobHistoryHead,
  PolicyEvaluationJobHistoryHeadSchema,
  POLICY_EVALUATION_JOB_HISTORY_PAGE_SIZE,
  MAX_POLICY_EVALUATION_JOB_HISTORY_ENTRIES,
  PolicyEvaluationUsageSchema,
  PolicyEvaluationSnapshotSchema,
  PolicyEvaluationSnapshotPageSetSchema,
  PolicyEvaluationWorkerMutationFenceSchema,
  PolicyEvaluationSchema,
  type PolicyEvaluationSnapshot,
  type PolicyEvaluationSnapshotPageSet,
  type PolicyEvaluation,
  type PolicyEvaluationWorkerMutationFence,
  policyEvaluationTimestampOrderKey,
} from "@proofstack/contracts";
import {
  type PolicyEvaluationJobRepository,
  type PolicyEvaluationRequestJobReader,
  type PolicyEvaluationAcquisitionRepository,
  type PolicyEvaluationJobComputationRepository,
  PolicyEvaluationJobNotFoundError,
  PolicyEvaluationRequestConflictError,
} from "../policy/policy-evaluation-job-repository.js";
import { validatePolicyEvaluationRequestRecord } from "../policy/policy-evaluation-request-record-validation.js";
import {
  digestPolicyEvaluationJobDefinition,
  InvalidPolicyEvaluationJobGraphError,
  validatePolicyEvaluationJobSnapshotRecord,
} from "../policy/policy-evaluation-job-record-validation.js";
import { addPolicyEvaluationMilliseconds } from "../policy/policy-evaluation-scheduler-time.js";
import {
  claimPolicyEvaluationJob,
  heartbeatPolicyEvaluationJob,
} from "../policy/policy-evaluation-scheduler-claim.js";
import { reservePolicyEvaluationUsage } from "../policy/policy-evaluation-scheduler-budget.js";
import {
  reservePolicyEvaluationAcquisition,
  settlePolicyEvaluationAcquisition,
} from "../policy/policy-evaluation-acquisition-allowance.js";
import { cancelPolicyEvaluationJob } from "../policy/policy-evaluation-scheduler-cancel.js";
import { interruptPolicyEvaluationJob } from "../policy/policy-evaluation-scheduler-interrupt.js";
import { reclaimPolicyEvaluationJob } from "../policy/policy-evaluation-scheduler-reclaim.js";
import {
  createPolicyEvaluationJobHistoryEntry,
  digestPolicyEvaluationJobGraph,
  policyEvaluationJobHistoryHead,
  validatePolicyEvaluationJobHistoryPage,
  PolicyEvaluationJobHistoryError,
} from "../policy/policy-evaluation-job-history.js";
import {
  buildPolicyEvaluationJobOutboxIntents,
  type PolicyEvaluationJobOutboxIntent,
} from "../policy/policy-evaluation-job-outbox.js";
import { replayPolicyEvaluationJobHistoryEntry } from "../policy/policy-evaluation-job-history-replay.js";
import { exhaustPolicyEvaluationJobHistory } from "../policy/policy-evaluation-history-limit.js";
import { requirePolicyEvaluationLiveFence } from "../policy/policy-evaluation-live-fence.js";
import {
  sealPolicyEvaluationJob,
  startPolicyEvaluationComputation,
} from "../policy/policy-evaluation-scheduler-seal.js";
import { completePolicyEvaluationJob } from "../policy/policy-evaluation-scheduler-complete.js";
import { prepareSealedPolicyEvaluation } from "../policy/compute-sealed-policy-evaluation.js";
import { validatePolicyEvaluationSnapshotRecord } from "../policy/policy-evaluation-snapshot-record-validation.js";
import {
  validatePolicyEvaluationResultRecord,
  digestPolicyEvaluationDefinition,
} from "../policy/policy-evaluation-result-record-validation.js";
import {
  policyEvaluationSnapshotReadIdentity,
  requirePolicyEvaluationSnapshotPageIndex,
  validatePolicyEvaluationStoredSnapshotJob,
  validatePolicyEvaluationStoredSnapshotPage,
  type PolicyEvaluationSnapshotReader,
  type PolicyEvaluationSnapshotPublisher,
  type PolicyEvaluationSnapshotReadIdentity,
} from "../policy/policy-evaluation-snapshot-repository.js";
import type {
  PolicyEvaluationResultPublisher,
  PolicyEvaluationResultReader,
} from "../policy/policy-evaluation-result-repository.js";

interface StoredPolicyJob {
  readonly snapshot: PolicyEvaluationJobSnapshot;
  readonly latest: PolicyEvaluationJobHistoryEntry;
  readonly pages: Readonly<Record<number, readonly PolicyEvaluationJobHistoryEntry[]>>;
  readonly outbox: readonly PolicyEvaluationJobOutboxIntent[];
  readonly sealedInput?: {
    readonly record: PolicyEvaluationSnapshot;
    readonly pageSet: PolicyEvaluationSnapshotPageSet;
  };
  readonly evaluation?: PolicyEvaluation;
}

/** Atomic synchronous map commit, inside async ports. No I/O/await occurs between read and swap. */
export class MemoryPolicyEvaluationJobRepository
  implements
    PolicyEvaluationJobRepository,
    PolicyEvaluationRequestJobReader,
    PolicyEvaluationAcquisitionRepository,
    PolicyEvaluationJobComputationRepository,
    PolicyEvaluationSnapshotReader,
    PolicyEvaluationSnapshotPublisher,
    PolicyEvaluationResultPublisher,
    PolicyEvaluationResultReader
{
  private readonly records = new Map<string, StoredPolicyJob>();
  private readonly requests = new Map<string, string>();
  private readonly reservations = new Map<string, PolicyEvaluationJobHistoryEntry>();
  private readonly snapshotOwners = new Map<string, string>();
  private readonly resultOwners = new Map<string, string>();
  private recoveryEpoch = 0;
  constructor(private readonly clock: { now(): string }) {}
  /** Preserve every original graph/index/epoch while isolating tentative writes. The owning
   * reference retains its server clock and must compare its whole authority state at commit.
   */
  fork(): MemoryPolicyEvaluationJobRepository {
    const next = new MemoryPolicyEvaluationJobRepository(this.clock);
    for (const [key, value] of this.records) next.records.set(key, structuredClone(value));
    for (const [key, value] of this.requests) next.requests.set(key, value);
    for (const [key, value] of this.reservations)
      next.reservations.set(key, structuredClone(value));
    for (const [key, value] of this.snapshotOwners) next.snapshotOwners.set(key, value);
    for (const [key, value] of this.resultOwners) next.resultOwners.set(key, value);
    next.recoveryEpoch = this.recoveryEpoch;
    return next;
  }
  private key(scope: EvidenceScope, id: string): string {
    return serializeEvaluationCanonicalJson([
      EvidenceScopeSchema.parse(scope),
      OpaqueIdSchema.parse(id),
    ]);
  }
  private reservationKey(scope: EvidenceScope, jobId: string, reservationId: string) {
    return serializeEvaluationCanonicalJson([
      this.key(scope, jobId),
      OpaqueIdSchema.parse(reservationId),
    ]);
  }
  private inspect(
    snapshot: PolicyEvaluationJobSnapshot,
    scope = snapshot.job.scope,
    id = snapshot.job.jobId,
  ) {
    return validatePolicyEvaluationJobSnapshotRecord({
      expected: {
        scope,
        job: { jobId: id, definitionSha256: snapshot.job.definitionSha256 },
      },
      snapshot,
    });
  }
  private read(scope: EvidenceScope, id: string) {
    const key = this.key(scope, id);
    const record = this.records.get(key);
    if (!record) throw new PolicyEvaluationJobNotFoundError();
    return { key, stored: record, snapshot: this.inspectStored(record, scope, id) };
  }
  private inspectStored(stored: StoredPolicyJob, scope: EvidenceScope, id: string) {
    const snapshot = this.inspect(stored.snapshot, scope, id);
    const head = policyEvaluationJobHistoryHead(stored.latest);
    const lastPage =
      stored.pages[Math.floor(head.sequence / POLICY_EVALUATION_JOB_HISTORY_PAGE_SIZE)];
    if (
      serializeEvaluationCanonicalJson(head.scope) !== serializeEvaluationCanonicalJson(scope) ||
      head.job.jobId !== id ||
      head.job.definitionSha256 !== snapshot.job.definitionSha256 ||
      lastPage?.length !== (head.sequence % POLICY_EVALUATION_JOB_HISTORY_PAGE_SIZE) + 1 ||
      serializeEvaluationCanonicalJson(lastPage.at(-1)) !==
        serializeEvaluationCanonicalJson(stored.latest)
    )
      throw new PolicyEvaluationJobHistoryError(
        "Stored history head differs from exact scope/job or retained final page",
      );
    if (
      head.graphSha256 !== digestPolicyEvaluationJobGraph(snapshot) ||
      head.sequence + 1 !== snapshot.job.stateVersion
    )
      throw new PolicyEvaluationJobHistoryError(
        "Stored graph differs from its exact retained history head",
      );
    if (
      serializeEvaluationCanonicalJson(stored.outbox) !==
      serializeEvaluationCanonicalJson(buildPolicyEvaluationJobOutboxIntents(null, snapshot))
    )
      throw new PolicyEvaluationJobHistoryError(
        "Stored job is missing its canonical atomic outbox intent",
      );
    if (stored.sealedInput) {
      if (!snapshot.job.snapshot)
        throw new PolicyEvaluationJobHistoryError("Stored seal has no owning job reference");
      validatePolicyEvaluationStoredSnapshotJob(
        {
          scope,
          job: { jobId: id, definitionSha256: snapshot.job.definitionSha256 },
          request: snapshot.job.request,
          snapshot: snapshot.job.snapshot,
        },
        stored.sealedInput.record,
        snapshot,
      );
    }
    return snapshot;
  }
  async createJob(command: Parameters<PolicyEvaluationJobRepository["createJob"]>[0]) {
    const request = validatePolicyEvaluationRequestRecord(command.request);
    const jobId = OpaqueIdSchema.parse(command.jobId);
    const requestKey = this.key(request.scope, request.evaluationRequestId);
    const existing = this.requests.get(requestKey);
    if (existing) {
      const record = this.records.get(existing);
      if (!record) throw new Error("Stored request has no atomic job binding");
      const snapshot = this.inspectStored(record, request.scope, record.snapshot.job.jobId);
      if (snapshot.request.definitionSha256 !== request.definitionSha256)
        throw new PolicyEvaluationRequestConflictError();
      return { created: false, snapshot };
    }
    const key = this.key(request.scope, jobId);
    if (this.records.has(key)) throw new PolicyEvaluationRequestConflictError();
    const now = PolicyEvaluationTimeSchema.parse(this.clock.now());
    const reference = {
      evaluationRequestId: request.evaluationRequestId,
      definitionSha256: request.definitionSha256,
    };
    const snapshot = PolicyEvaluationJobSnapshotSchema.parse({
      request,
      attempts: [],
      cancellation: null,
      usage: {
        reads: 0,
        records: 0,
        recordBytes: 0,
        references: 0,
        referenceBytes: 0,
        artifactReadBytes: 0,
        ruleEvaluations: 0,
      },
      job: {
        schemaVersion: "0.1",
        jobId,
        scope: request.scope,
        request: reference,
        definitionSha256: digestPolicyEvaluationJobDefinition(request.scope, {
          jobId,
          request: reference,
        }),
        createdAt: now,
        createdByPrincipalId: request.createdByPrincipalId,
        updatedAt: now,
        deadlineAt: addPolicyEvaluationMilliseconds(
          request.createdAt,
          request.limits.totalDeadlineMilliseconds,
        ),
        stateVersion: 1,
        recoveryEpoch: this.recoveryEpoch,
        lastFencingToken: 0,
        attemptCount: 0,
        status: "queued",
        currentLease: null,
        snapshot: null,
        result: null,
        retryAt: null,
        terminal: null,
      },
    });
    const admitted = this.inspect(snapshot);
    const entry = createPolicyEvaluationJobHistoryEntry({
      previous: null,
      previousEntry: null,
      next: admitted,
      operation: { kind: "created" },
    });
    const stored: StoredPolicyJob = {
      snapshot: admitted,
      latest: entry,
      pages: { 0: [entry] },
      outbox: buildPolicyEvaluationJobOutboxIntents(null, admitted),
    };
    this.inspectStored(stored, request.scope, jobId);
    this.records.set(key, stored);
    this.requests.set(requestKey, key);
    return { created: true, snapshot: structuredClone(admitted) };
  }
  async findJob(scope: EvidenceScope, jobId: string) {
    const record = this.records.get(this.key(scope, jobId));
    return record ? this.inspectStored(record, scope, jobId) : null;
  }
  async findJobForRequest(
    input: EvidenceScope,
    reference: Parameters<PolicyEvaluationRequestJobReader["findJobForRequest"]>[1],
  ) {
    const scope = EvidenceScopeSchema.parse(input);
    const request = PolicyEvaluationRequestReferenceSchema.parse(reference);
    const key = this.requests.get(this.key(scope, request.evaluationRequestId));
    if (key === undefined) return null;
    const stored = this.records.get(key);
    if (!stored)
      throw new InvalidPolicyEvaluationJobGraphError("Original request has no owning job");
    const snapshot = this.inspectStored(stored, scope, stored.snapshot.job.jobId);
    if (snapshot.request.evaluationRequestId !== request.evaluationRequestId)
      throw new InvalidPolicyEvaluationJobGraphError("Original request binding was substituted");
    if (snapshot.request.definitionSha256 !== request.definitionSha256)
      throw new PolicyEvaluationRequestConflictError();
    return snapshot;
  }
  async findHistoryHead(scope: EvidenceScope, jobId: string) {
    const stored = this.records.get(this.key(scope, jobId));
    if (!stored) return null;
    this.inspectStored(stored, scope, jobId);
    return policyEvaluationJobHistoryHead(stored.latest);
  }
  async readHistoryPage(headInput: PolicyEvaluationJobHistoryHead, pageIndex: number) {
    const head = PolicyEvaluationJobHistoryHeadSchema.parse(headInput);
    const { stored } = this.read(head.scope, head.job.jobId);
    const anchor =
      stored.pages[Math.floor(head.sequence / POLICY_EVALUATION_JOB_HISTORY_PAGE_SIZE)]?.[
        head.sequence % POLICY_EVALUATION_JOB_HISTORY_PAGE_SIZE
      ];
    if (
      !anchor ||
      serializeEvaluationCanonicalJson(policyEvaluationJobHistoryHead(anchor)) !==
        serializeEvaluationCanonicalJson(head)
    )
      throw new PolicyEvaluationJobHistoryError(
        "Requested history head is not an exact retained prefix",
      );
    const entries =
      stored.pages[pageIndex]?.slice(
        0,
        Math.min(
          POLICY_EVALUATION_JOB_HISTORY_PAGE_SIZE,
          head.sequence + 1 - pageIndex * POLICY_EVALUATION_JOB_HISTORY_PAGE_SIZE,
        ),
      ) ?? [];
    return validatePolicyEvaluationJobHistoryPage({
      expected: head,
      page: { head, pageIndex, entries },
    });
  }
  async findOutboxIntents(scope: EvidenceScope, jobId: string) {
    const stored = this.records.get(this.key(scope, jobId));
    if (!stored) return null;
    this.inspectStored(stored, scope, jobId);
    return structuredClone(stored.outbox);
  }
  private storedSeal(input: PolicyEvaluationSnapshotReadIdentity) {
    const expected = policyEvaluationSnapshotReadIdentity(input);
    const owner = this.snapshotOwners.get(this.key(expected.scope, expected.snapshot.snapshotId));
    if (owner === undefined) {
      const known = this.records.get(this.key(expected.scope, expected.job.jobId));
      if (known?.snapshot.job.snapshot?.snapshotId === expected.snapshot.snapshotId)
        throw new PolicyEvaluationJobHistoryError("Owning snapshot material/index is missing");
      return null;
    }
    const { snapshot: job, stored } = this.read(expected.scope, owner);
    if (!stored.sealedInput)
      throw new PolicyEvaluationJobHistoryError("Snapshot index has no retained material");
    const { root } = validatePolicyEvaluationStoredSnapshotJob(
      expected,
      stored.sealedInput.record,
      job,
    );
    return { expected, root, job, stored };
  }
  async findSnapshot(expected: PolicyEvaluationSnapshotReadIdentity) {
    const retained = this.storedSeal(expected);
    return retained === null ? null : structuredClone(retained.root);
  }
  async readSnapshotPage(expected: PolicyEvaluationSnapshotReadIdentity, indexInput: number) {
    const index = requirePolicyEvaluationSnapshotPageIndex(indexInput);
    const retained = this.storedSeal(expected);
    if (retained === null) return null;
    const page = retained.stored.sealedInput!.pageSet.pages[index];
    return validatePolicyEvaluationStoredSnapshotPage(
      retained.expected,
      retained.root,
      index,
      page,
    );
  }
  async publishSnapshot(
    command: Parameters<PolicyEvaluationSnapshotPublisher["publishSnapshot"]>[0],
  ) {
    const fence = PolicyEvaluationWorkerMutationFenceSchema.parse(command.fence);
    if (OpaqueIdSchema.parse(command.principalId) !== fence.workerId)
      throw new PolicyEvaluationRequestConflictError();
    const prior = this.read(command.scope, fence.jobId).snapshot;
    requirePolicyEvaluationLiveFence({
      snapshot: prior,
      now: PolicyEvaluationTimeSchema.parse(this.clock.now()),
      recoveryEpoch: this.recoveryEpoch,
      fence,
    });
    if (prior.job.status !== "acquiring" || prior.job.snapshot !== null)
      throw new PolicyEvaluationJobHistoryError(
        "Snapshot publication requires an unsealed acquiring attempt",
      );
    const pageSet = PolicyEvaluationSnapshotPageSetSchema.parse(command.pageSet);
    const reference = {
      snapshotId: pageSet.definition.snapshotId,
      definitionSha256: pageSet.definitionSha256,
    };
    const ownerKey = this.key(command.scope, reference.snapshotId);
    if (this.snapshotOwners.has(ownerKey)) throw new PolicyEvaluationRequestConflictError();
    let published: PolicyEvaluationSnapshot | undefined;
    const job = this.mutate(
      command.scope,
      fence.jobId,
      (before, now) => {
        requirePolicyEvaluationLiveFence({
          snapshot: before,
          now,
          recoveryEpoch: this.recoveryEpoch,
          fence,
        });
        if (
          before.job.stateVersion >= MAX_POLICY_EVALUATION_JOB_HISTORY_ENTRIES - 1 ||
          before.acquisitionAllowance
        )
          throw new PolicyEvaluationJobHistoryError(
            "Snapshot publication has no settled owning history capacity",
          );
        const record = PolicyEvaluationSnapshotSchema.parse({
          ...pageSet.definition,
          scope: before.job.scope,
          schemaVersion: "0.1",
          definitionSha256: pageSet.definitionSha256,
          ...fence,
          sealedAt: now,
          recordedAt: now,
          sealedByPrincipalId: command.principalId,
        });
        const { inputs } = validatePolicyEvaluationSnapshotRecord({
          expected: {
            scope: before.job.scope,
            jobId: fence.jobId,
            request: before.job.request,
            snapshot: reference,
          },
          record,
          pageSet,
        });
        if (
          inputs.schemaVersion !== "0.2" ||
          inputs.sources.logicalRoots.configuration !== "configured" ||
          serializeEvaluationCanonicalJson(inputs.request) !==
            serializeEvaluationCanonicalJson(before.request)
        )
          throw new PolicyEvaluationJobHistoryError(
            "Memory snapshot publication requires complete owning configured input",
          );
        published = record;
        return sealPolicyEvaluationJob({
          snapshot: before,
          now,
          recoveryEpoch: this.recoveryEpoch,
          fence,
          sealedSnapshot: reference,
        });
      },
      () => ({ kind: "seal", fence, snapshot: reference }),
      () => ({ sealedInput: { record: published!, pageSet } }),
      fence,
    );
    this.snapshotOwners.set(ownerKey, fence.jobId);
    return { snapshot: structuredClone(published!), job };
  }
  async startComputation(
    command: Parameters<PolicyEvaluationJobComputationRepository["startComputation"]>[0],
  ) {
    const { stored } = this.read(command.scope, command.fence.jobId);
    if (!stored.sealedInput)
      throw new PolicyEvaluationJobHistoryError("Computation has no retained original seal");
    return this.mutate(
      command.scope,
      command.fence.jobId,
      (snapshot, now) =>
        startPolicyEvaluationComputation({
          snapshot,
          now,
          recoveryEpoch: this.recoveryEpoch,
          fence: command.fence,
        }),
      () => ({ kind: "start_computation", fence: command.fence }),
    );
  }
  private checkedResult(stored: StoredPolicyJob, job: PolicyEvaluationJobSnapshot) {
    const reference = job.job.result,
      terminal = job.job.terminal;
    const attempt = job.attempts.find(
      (value) => value.mutationFence.attemptId === terminal?.attemptId,
    );
    if (
      !reference ||
      job.job.status !== "completed" ||
      !terminal ||
      !attempt ||
      attempt.closure?.status !== "completed" ||
      attempt.closure.committedAt !== terminal.committedAt ||
      !stored.evaluation ||
      !stored.sealedInput ||
      !job.job.snapshot
    )
      throw new PolicyEvaluationJobHistoryError(
        "Completed memory result lacks its original deciding evidence",
      );
    return validatePolicyEvaluationResultRecord({
      expected: {
        scope: job.job.scope,
        jobId: job.job.jobId,
        request: job.job.request,
        snapshot: job.job.snapshot,
        result: reference,
        fence: attempt.mutationFence,
        completedAt: terminal.committedAt,
      },
      record: stored.evaluation,
      snapshotRecord: stored.sealedInput.record,
      pageSet: stored.sealedInput.pageSet,
    });
  }
  async publishResult(command: Parameters<PolicyEvaluationResultPublisher["publishResult"]>[0]) {
    const fence = PolicyEvaluationWorkerMutationFenceSchema.parse(command.fence),
      evaluationId = OpaqueIdSchema.parse(command.evaluationId);
    const { snapshot: before, stored } = this.read(command.scope, fence.jobId);
    if (!stored.sealedInput || !before.job.snapshot)
      throw new PolicyEvaluationJobHistoryError("Result has no original stored seal");
    if (before.job.status !== "completed") {
      requirePolicyEvaluationLiveFence({
        snapshot: before,
        now: PolicyEvaluationTimeSchema.parse(this.clock.now()),
        recoveryEpoch: this.recoveryEpoch,
        fence,
      });
      if (before.job.status !== "running")
        throw new PolicyEvaluationJobHistoryError(
          "Result publication requires its owning running attempt",
        );
    }
    if (
      serializeEvaluationCanonicalJson(command.pageSet) !==
      serializeEvaluationCanonicalJson(stored.sealedInput.pageSet)
    )
      throw new PolicyEvaluationRequestConflictError();
    if (before.job.status === "completed") {
      const original = this.checkedResult(stored, before);
      const originalFence = {
        jobId: original.jobId,
        attemptId: original.attemptId,
        workerId: original.workerId,
        leaseId: original.leaseId,
        fencingToken: original.fencingToken,
        recoveryEpoch: original.recoveryEpoch,
      };
      if (
        original.evaluationId !== evaluationId ||
        serializeEvaluationCanonicalJson(originalFence) !== serializeEvaluationCanonicalJson(fence)
      )
        throw new PolicyEvaluationRequestConflictError();
      return { created: false, evaluation: original, snapshot: before };
    }
    const ownerKey = this.key(command.scope, evaluationId);
    if (this.resultOwners.has(ownerKey)) throw new PolicyEvaluationRequestConflictError();
    let evaluation: PolicyEvaluation | undefined;
    const result = this.mutate(
      command.scope,
      fence.jobId,
      (snapshot, now) => {
        requirePolicyEvaluationLiveFence({
          snapshot,
          now,
          recoveryEpoch: this.recoveryEpoch,
          fence,
        });
        if (snapshot.job.stateVersion >= MAX_POLICY_EVALUATION_JOB_HISTORY_ENTRIES - 1)
          throw new PolicyEvaluationJobHistoryError(
            "Result publication has no operational history headroom",
          );
        const owning = {
          scope: snapshot.job.scope,
          jobId: fence.jobId,
          request: snapshot.job.request,
          snapshot: snapshot.job.snapshot!,
        };
        const computation = prepareSealedPolicyEvaluation({
          evaluationId,
          expected: owning,
          record: stored.sealedInput!.record,
          pageSet: stored.sealedInput!.pageSet,
        });
        const attempt = snapshot.attempts.at(-1);
        if (
          snapshot.job.status !== "running" ||
          !attempt ||
          snapshot.usage.ruleEvaluations - attempt.usageAtStart.ruleEvaluations <
            computation.ruleCount
        )
          throw new PolicyEvaluationJobHistoryError(
            "Result omitted its running attempt or prepaid whole rule work",
          );
        const definition = computation.compute();
        const digest = digestPolicyEvaluationDefinition(snapshot.job.scope, definition);
        evaluation = PolicyEvaluationSchema.parse({
          ...definition,
          scope: snapshot.job.scope,
          schemaVersion: "0.1",
          definitionSha256: digest,
          ...fence,
          recordedAt: now,
          recordedByPrincipalId: fence.workerId,
        });
        return completePolicyEvaluationJob({
          snapshot,
          now,
          recoveryEpoch: this.recoveryEpoch,
          fence,
          result: { evaluationId, definitionSha256: digest },
          ruleCount: definition.ruleCount,
        });
      },
      (next) => ({
        kind: "complete",
        fence,
        result: next.job.result!,
        ruleCount: evaluation!.ruleCount,
      }),
      () => ({ evaluation: evaluation! }),
      fence,
    );
    this.resultOwners.set(ownerKey, fence.jobId);
    // mutate independently validated the complete stored result before its final clock check/swap.
    // Return a copy of that same record; a second post-commit calculation cannot protect the swap.
    return { created: true, evaluation: structuredClone(evaluation!), snapshot: result };
  }
  async findResult(scope: EvidenceScope, jobId: string, pageSet: PolicyEvaluationSnapshotPageSet) {
    const stored = this.records.get(this.key(scope, jobId));
    if (!stored) return null;
    const job = this.inspectStored(stored, scope, jobId);
    if (!job.job.result) return null;
    if (
      !stored.sealedInput ||
      serializeEvaluationCanonicalJson(pageSet) !==
        serializeEvaluationCanonicalJson(stored.sealedInput.pageSet)
    )
      throw new PolicyEvaluationRequestConflictError();
    return this.checkedResult(stored, job);
  }
  private mutate(
    scope: EvidenceScope,
    id: string,
    work: (snapshot: PolicyEvaluationJobSnapshot, now: string) => PolicyEvaluationJobSnapshot,
    operation: (
      next: PolicyEvaluationJobSnapshot,
    ) => PolicyEvaluationJobHistoryEntryDefinition["operation"],
    materialize?: (
      next: PolicyEvaluationJobSnapshot,
      now: string,
    ) => Pick<StoredPolicyJob, "sealedInput" | "evaluation">,
    commitFence?: PolicyEvaluationWorkerMutationFence,
  ) {
    const { key, snapshot, stored } = this.read(scope, id);
    const now = PolicyEvaluationTimeSchema.parse(this.clock.now());
    let result = this.inspect(work(snapshot, now), scope, id);
    if (result.job.stateVersion === snapshot.job.stateVersion) {
      if (serializeEvaluationCanonicalJson(result) !== serializeEvaluationCanonicalJson(snapshot))
        throw new PolicyEvaluationJobHistoryError(
          "Idempotent mutation changed retained graph without a transition",
        );
      return result;
    }
    const historyExhausted =
      result.job.terminal === null &&
      result.job.stateVersion === MAX_POLICY_EVALUATION_JOB_HISTORY_ENTRIES;
    if (historyExhausted)
      result = this.inspect(exhaustPolicyEvaluationJobHistory(snapshot, now), scope, id);
    const entry = createPolicyEvaluationJobHistoryEntry({
      previous: snapshot,
      previousEntry: stored.latest,
      next: result,
      operation: historyExhausted ? { kind: "history_limit" } : operation(result),
    });
    replayPolicyEvaluationJobHistoryEntry(snapshot, entry);
    const page = Math.floor(entry.definition.sequence / POLICY_EVALUATION_JOB_HISTORY_PAGE_SIZE);
    const nextStored: StoredPolicyJob = {
      ...stored,
      ...materialize?.(result, now),
      snapshot: result,
      latest: entry,
      pages: { ...stored.pages, [page]: [...(stored.pages[page] ?? []), entry] },
      outbox: [...stored.outbox, ...buildPolicyEvaluationJobOutboxIntents(snapshot, result)],
    };
    this.inspectStored(nextStored, scope, id);
    if (nextStored.evaluation) this.checkedResult(nextStored, result);
    if (commitFence) {
      const commitNow = PolicyEvaluationTimeSchema.parse(this.clock.now());
      if (policyEvaluationTimestampOrderKey(commitNow) < policyEvaluationTimestampOrderKey(now))
        throw new PolicyEvaluationJobHistoryError(
          "Memory commit clock precedes its contained publication receipt",
        );
      requirePolicyEvaluationLiveFence({
        snapshot,
        now: commitNow,
        recoveryEpoch: this.recoveryEpoch,
        fence: commitFence,
      });
    }
    this.records.set(key, nextStored);
    if (entry.definition.operation.kind === "reserve")
      this.reservations.set(
        this.reservationKey(scope, id, entry.definition.operation.reservationId),
        entry,
      );
    return structuredClone(result);
  }
  async reserveWork(command: Parameters<PolicyEvaluationJobRepository["reserveWork"]>[0]) {
    const reservationId = OpaqueIdSchema.parse(command.reservationId);
    const { snapshot } = this.read(command.scope, command.fence.jobId);
    requirePolicyEvaluationLiveFence({
      snapshot,
      now: PolicyEvaluationTimeSchema.parse(this.clock.now()),
      recoveryEpoch: this.recoveryEpoch,
      fence: command.fence,
    });
    const delta = PolicyEvaluationUsageSchema.parse(command.delta);
    const previous = this.reservations.get(
      this.reservationKey(command.scope, command.fence.jobId, reservationId),
    );
    if (previous) {
      const operation = previous.definition.operation;
      if (
        operation.kind !== "reserve" ||
        serializeEvaluationCanonicalJson(operation.fence) !==
          serializeEvaluationCanonicalJson(command.fence) ||
        serializeEvaluationCanonicalJson(operation.delta) !==
          serializeEvaluationCanonicalJson(delta)
      )
        throw new PolicyEvaluationRequestConflictError();
      return { created: false, snapshot, reservation: structuredClone(previous) };
    }
    const result = this.mutate(
      command.scope,
      command.fence.jobId,
      (current, now) =>
        reservePolicyEvaluationUsage({
          snapshot: current,
          now,
          recoveryEpoch: this.recoveryEpoch,
          fence: command.fence,
          delta,
        }),
      () => ({ kind: "reserve", fence: command.fence, reservationId, delta }),
    );
    const { stored } = this.read(command.scope, command.fence.jobId);
    const reservation =
      stored.latest.definition.operation.kind === "reserve" ? structuredClone(stored.latest) : null;
    return { created: reservation !== null, snapshot: result, reservation };
  }
  async claimJob(command: Parameters<PolicyEvaluationJobRepository["claimJob"]>[0]) {
    return this.mutate(
      command.scope,
      command.jobId,
      (snapshot, now) =>
        claimPolicyEvaluationJob({
          snapshot,
          now,
          recoveryEpoch: this.recoveryEpoch,
          workerId: command.workerId,
          attemptId: command.attemptId,
          leaseId: command.leaseId,
        }),
      (next) => ({ kind: "claim", fence: next.job.currentLease!.mutationFence }),
    );
  }
  async reserveAcquisition(
    command: Parameters<PolicyEvaluationAcquisitionRepository["reserveAcquisition"]>[0],
  ) {
    const allowanceId = OpaqueIdSchema.parse(command.allowanceId);
    const { snapshot, stored } = this.read(command.scope, command.fence.jobId);
    requirePolicyEvaluationLiveFence({
      snapshot,
      now: this.clock.now(),
      recoveryEpoch: this.recoveryEpoch,
      fence: command.fence,
    });
    if (snapshot.acquisitionAllowance) {
      if (snapshot.acquisitionAllowance.allowanceId !== allowanceId)
        throw new PolicyEvaluationRequestConflictError();
      return { created: false, snapshot, allowance: snapshot.acquisitionAllowance };
    }
    for (const page of Object.values(stored.pages))
      for (const entry of page) {
        const operation = entry.definition.operation;
        if (operation.kind === "reserve_acquisition" && operation.allowanceId === allowanceId)
          throw new PolicyEvaluationRequestConflictError();
      }
    const next = await this.mutate(
      command.scope,
      command.fence.jobId,
      (current, now) =>
        reservePolicyEvaluationAcquisition({
          snapshot: current,
          now,
          recoveryEpoch: this.recoveryEpoch,
          fence: command.fence,
          allowanceId,
        }),
      () => ({ kind: "reserve_acquisition", fence: command.fence, allowanceId }),
    );
    return {
      created: next.acquisitionAllowance != null,
      snapshot: next,
      allowance: next.acquisitionAllowance ?? null,
    };
  }
  async settleAcquisition(
    command: Parameters<PolicyEvaluationAcquisitionRepository["settleAcquisition"]>[0],
  ) {
    return this.mutate(
      command.scope,
      command.fence.jobId,
      (snapshot, now) =>
        settlePolicyEvaluationAcquisition({
          ...command,
          snapshot,
          now,
          recoveryEpoch: this.recoveryEpoch,
        }),
      () => ({
        kind: "settle_acquisition",
        fence: command.fence,
        allowanceId: command.allowanceId,
        usage: command.usage,
      }),
    );
  }
  async reclaimJob(command: Parameters<PolicyEvaluationJobRepository["reclaimJob"]>[0]) {
    return this.mutate(
      command.scope,
      command.jobId,
      (snapshot, now) =>
        reclaimPolicyEvaluationJob({ snapshot, now, recoveryEpoch: this.recoveryEpoch }),
      () => ({ kind: "reclaim" }),
    );
  }
  async heartbeatJob(command: Parameters<PolicyEvaluationJobRepository["heartbeatJob"]>[0]) {
    return this.mutate(
      command.scope,
      command.fence.jobId,
      (snapshot, now) =>
        heartbeatPolicyEvaluationJob({
          snapshot,
          now,
          recoveryEpoch: this.recoveryEpoch,
          fence: command.fence,
        }),
      () => ({ kind: "heartbeat", fence: command.fence }),
    );
  }
  async reserveUsage(command: Parameters<PolicyEvaluationJobRepository["reserveUsage"]>[0]) {
    return this.mutate(
      command.scope,
      command.fence.jobId,
      (snapshot, now) =>
        reservePolicyEvaluationUsage({
          snapshot,
          now,
          recoveryEpoch: this.recoveryEpoch,
          fence: command.fence,
          delta: command.delta,
        }),
      () => ({
        kind: "reserve",
        fence: command.fence,
        reservationId: `reservation_${randomUUID().replaceAll("-", "")}`,
        delta: command.delta,
      }),
    );
  }
  async interruptJob(command: Parameters<PolicyEvaluationJobRepository["interruptJob"]>[0]) {
    return this.mutate(
      command.scope,
      command.fence.jobId,
      (snapshot, now) =>
        interruptPolicyEvaluationJob({
          snapshot,
          now,
          recoveryEpoch: this.recoveryEpoch,
          fence: command.fence,
          reason: command.reason,
        }),
      () => ({ kind: "interrupt", fence: command.fence, reason: command.reason }),
    );
  }
  async cancelJob(command: Parameters<PolicyEvaluationJobRepository["cancelJob"]>[0]) {
    return this.mutate(
      command.scope,
      command.jobId,
      (snapshot, now) =>
        cancelPolicyEvaluationJob({
          snapshot,
          intent: {
            jobId: command.jobId,
            scope: command.scope,
            cancellationId: snapshot.cancellation?.cancellationId ?? command.cancellationId,
            requestedAt: now,
            requestedByPrincipalId: command.principalId,
            reason: command.reason,
          },
        }),
      (next) => ({ kind: "cancel", intent: next.cancellation! }),
    );
  }
}
