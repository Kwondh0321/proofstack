import {
  EnqueuePolicyEvaluationJobResponseSchema,
  EnqueuePolicyEvaluationRequestSchema,
  encodePolicyEvaluationRequestDefinition,
  MAX_POLICY_EVALUATION_CANCELLATION_REQUEST_BYTES,
  MAX_POLICY_EVALUATION_HISTORY_HEAD_RESPONSE_BYTES,
  MAX_POLICY_EVALUATION_JOB_HISTORY_PAGE_BYTES,
  MAX_POLICY_EVALUATION_JOB_RESPONSE_BYTES,
  MAX_POLICY_EVALUATION_REQUEST_BYTES,
  MAX_POLICY_EVALUATION_REQUEST_RESPONSE_BYTES,
  MAX_POLICY_EVALUATION_RESULT_RESPONSE_BYTES,
  MAX_POLICY_EVALUATION_SNAPSHOT_INPUT_BYTES,
  MAX_POLICY_EVALUATION_SNAPSHOT_PAGE_RESPONSE_BYTES,
  MAX_POLICY_EVALUATION_SNAPSHOT_RESPONSE_BYTES,
  POLICY_EVALUATION_JOB_HISTORY_PAGE_SIZE,
  PolicyEvaluationJobHistoryEntrySchema,
  PolicyEvaluationJobHistoryPageIndexSchema,
  PolicyEvaluationSnapshotPageIndexSchema,
  ReadPolicyEvaluationJobHistoryHeadResponseSchema,
  ReadPolicyEvaluationJobHistoryPageResponseSchema,
  ReadPolicyEvaluationJobResponseSchema,
  ReadPolicyEvaluationRequestResponseSchema,
  ReadPolicyEvaluationResponseSchema,
  ReadPolicyEvaluationSnapshotPageResponseSchema,
  ReadPolicyEvaluationSnapshotResponseSchema,
  RequestPolicyEvaluationCancellationSchema,
  encodePolicyEvaluationJobHistoryEntry,
  type EnqueuePolicyEvaluationRequest,
  type EvidenceScope,
  type PolicyEvaluationJobHistoryEntry,
  type PolicyEvaluationJobHistoryHead,
  type PolicyEvaluationJobReference,
  type PolicyEvaluationSnapshot,
  type RequestPolicyEvaluationCancellation,
} from "@proofstack/contracts";
import { ProofStackApiError } from "./regression-client.js";
import {
  PolicyEvaluationTransport,
  type PolicyEvaluationTransportOptions,
  type PolicyEvaluationOperation,
} from "./policy-evaluation-http.js";
import {
  policyCompleteSnapshot,
  policyJobReference,
  policyParsed,
  policySame,
  policySha256,
  policyVerifiedHeader,
  policyVerifiedHistoryHead,
  policyVerifiedHistoryPage,
  policyVerifiedJob,
  policyVerifiedPage,
  policyVerifiedRequest,
  policyVerifiedResult,
  policyVerifiedSealingAttempt,
  type PolicyEvaluationCompleteSnapshot,
} from "./policy-evaluation-integrity.js";

export type { ProofStackPolicyEvaluationAuthentication } from "./policy-evaluation-http.js";
export type { PolicyEvaluationCompleteSnapshot } from "./policy-evaluation-integrity.js";
export interface ProofStackPolicyEvaluationClientOptions extends PolicyEvaluationTransportOptions {
  readonly maxSnapshotInputBytes?: number;
}
interface ReadJobInput {
  readonly job: PolicyEvaluationJobReference;
  readonly signal?: AbortSignal;
}
export const MAX_POLICY_EVALUATION_REDIRECTS = 0;

/** Exact historical verification and control only; never computes or publishes policy results. */
export class ProofStackPolicyEvaluationClient {
  private readonly transport: PolicyEvaluationTransport;
  private readonly scope: EvidenceScope;
  private readonly maximumInput: number;
  constructor(options: ProofStackPolicyEvaluationClientOptions) {
    this.transport = new PolicyEvaluationTransport(options);
    this.scope = this.transport.scope;
    this.maximumInput = options.maxSnapshotInputBytes ?? MAX_POLICY_EVALUATION_SNAPSHOT_INPUT_BYTES;
    if (
      !Number.isSafeInteger(this.maximumInput) ||
      this.maximumInput < 1 ||
      this.maximumInput > MAX_POLICY_EVALUATION_SNAPSHOT_INPUT_BYTES
    )
      throw new ProofStackApiError("Policy snapshot input budget is outside the installed bounds");
  }
  async enqueue(input: {
    readonly request: EnqueuePolicyEvaluationRequest;
    readonly signal?: AbortSignal;
  }) {
    const definition = policyParsed(EnqueuePolicyEvaluationRequestSchema, input.request);
    return this.transport.run(input.signal, async (operation) => {
      const { status, value } = await operation.request(
        [],
        undefined,
        "POST",
        definition,
        MAX_POLICY_EVALUATION_REQUEST_BYTES,
        MAX_POLICY_EVALUATION_JOB_RESPONSE_BYTES,
        EnqueuePolicyEvaluationJobResponseSchema,
        [200, 201],
      );
      if (status !== (value.created ? 201 : 200))
        throw new ProofStackApiError(
          "Policy evaluation creation flag contradicts its HTTP status",
          status,
        );
      const graph = await policyVerifiedJob(value.snapshot, this.scope);
      const digest = await policySha256(
        encodePolicyEvaluationRequestDefinition({ scope: this.scope, definition }),
      );
      if (
        graph.request.definitionSha256 !== digest ||
        graph.request.evaluationRequestId !== definition.evaluationRequestId ||
        (value.created && graph.job.status !== "queued")
      )
        throw new ProofStackApiError(
          "Policy evaluation enqueue substituted the immutable requested input or creation state",
        );
      operation.check();
      return { ...value, snapshot: graph };
    });
  }
  async readJob(input: ReadJobInput) {
    const job = policyJobReference(input.job);
    return this.transport.run(input.signal, (operation) => this.job(operation, job));
  }
  async readRequest(input: ReadJobInput) {
    const job = policyJobReference(input.job);
    return this.transport.run(input.signal, async (operation) => {
      const { value } = await operation.request(
        [job.jobId, "request"],
        undefined,
        "GET",
        undefined,
        0,
        MAX_POLICY_EVALUATION_REQUEST_RESPONSE_BYTES,
        ReadPolicyEvaluationRequestResponseSchema,
        [200],
      );
      const request = await policyVerifiedRequest(value.request, this.scope, job);
      return { ...value, request };
    });
  }
  async cancel(input: ReadJobInput & { readonly request: RequestPolicyEvaluationCancellation }) {
    const job = policyJobReference(input.job),
      request = policyParsed(RequestPolicyEvaluationCancellationSchema, input.request);
    return this.transport.run(input.signal, async (operation) => {
      const { value } = await operation.request(
        [job.jobId, "cancellation"],
        undefined,
        "POST",
        request,
        MAX_POLICY_EVALUATION_CANCELLATION_REQUEST_BYTES,
        MAX_POLICY_EVALUATION_JOB_RESPONSE_BYTES,
        ReadPolicyEvaluationJobResponseSchema,
        [200],
      );
      const graph = await policyVerifiedJob(value.snapshot, this.scope, job);
      if (graph.job.status !== "cancelled" || graph.cancellation?.reason !== request.reason)
        throw new ProofStackApiError(
          "Policy evaluation cancellation did not retain the requested reason and terminal state",
        );
      return { ...value, snapshot: graph };
    });
  }
  async readSnapshot(input: ReadJobInput) {
    const job = policyJobReference(input.job);
    return this.transport.run(input.signal, (operation) => this.header(operation, job));
  }
  async readSnapshotPage(
    input: ReadJobInput & {
      readonly snapshot: PolicyEvaluationSnapshot;
      readonly pageIndex: number;
    },
  ) {
    const job = policyJobReference(input.job),
      pageIndex = policyParsed(PolicyEvaluationSnapshotPageIndexSchema, input.pageIndex);
    return this.transport.run(input.signal, async (operation) => {
      const { snapshot } = await policyVerifiedHeader(input.snapshot, this.scope, job);
      return this.page(operation, job, snapshot, pageIndex);
    });
  }
  async readCompleteSnapshot(input: ReadJobInput): Promise<PolicyEvaluationCompleteSnapshot> {
    const job = policyJobReference(input.job);
    return this.transport.run(input.signal, (operation) => this.complete(operation, job));
  }
  async readResult(input: ReadJobInput) {
    const job = policyJobReference(input.job);
    return this.transport.run(input.signal, async (operation) => {
      const material = await this.complete(operation, job);
      const { value } = await operation.request(
        [job.jobId, "result"],
        undefined,
        "GET",
        undefined,
        0,
        MAX_POLICY_EVALUATION_RESULT_RESPONSE_BYTES,
        ReadPolicyEvaluationResponseSchema,
        [200],
      );
      // Result existence precedes this owning completed graph read. Terminal state and original
      // sealing material are immutable, unlike an earlier independently observed active graph.
      const graph = await this.job(operation, job);
      const evaluation = await policyVerifiedResult(
        value.evaluation,
        material,
        this.scope,
        job,
        graph.snapshot,
      );
      return { ...value, evaluation };
    });
  }
  async readHistoryHead(input: ReadJobInput) {
    const job = policyJobReference(input.job);
    return this.transport.run(input.signal, async (operation) => {
      const { value } = await operation.request(
        [job.jobId, "history"],
        undefined,
        "GET",
        undefined,
        0,
        MAX_POLICY_EVALUATION_HISTORY_HEAD_RESPONSE_BYTES,
        ReadPolicyEvaluationJobHistoryHeadResponseSchema,
        [200],
      );
      return { ...value, head: policyVerifiedHistoryHead(value.head, this.scope, job) };
    });
  }
  async readHistoryPage(
    input: ReadJobInput & {
      readonly head: PolicyEvaluationJobHistoryHead;
      readonly pageIndex: number;
      readonly predecessor?: PolicyEvaluationJobHistoryEntry;
    },
  ) {
    const job = policyJobReference(input.job),
      head = policyVerifiedHistoryHead(input.head, this.scope, job),
      pageIndex = policyParsed(PolicyEvaluationJobHistoryPageIndexSchema, input.pageIndex);
    if (pageIndex * POLICY_EVALUATION_JOB_HISTORY_PAGE_SIZE > head.sequence)
      throw new ProofStackApiError("Policy history page is outside the retained exact head");
    return this.transport.run(input.signal, async (operation) => {
      const query = new URLSearchParams({
        jobDefinitionSha256: head.job.definitionSha256,
        sequence: String(head.sequence),
        entrySha256: head.entrySha256,
        graphSha256: head.graphSha256,
      });
      const { value } = await operation.request(
        [job.jobId, "history", "pages", String(pageIndex)],
        query,
        "GET",
        undefined,
        0,
        MAX_POLICY_EVALUATION_JOB_HISTORY_PAGE_BYTES,
        ReadPolicyEvaluationJobHistoryPageResponseSchema,
        [200],
      );
      const page = await policyVerifiedHistoryPage(value.page, head, pageIndex);
      if (input.predecessor !== undefined) {
        const predecessor = policyParsed(PolicyEvaluationJobHistoryEntrySchema, input.predecessor);
        const first = page.entries[0]!;
        if (
          !policySame(predecessor.definition.scope, this.scope) ||
          !policySame(predecessor.definition.job, job) ||
          predecessor.definition.sequence + 1 !== first.definition.sequence ||
          predecessor.entrySha256 !== first.definition.predecessorEntrySha256 ||
          predecessor.definition.graphSha256 !== first.definition.previousGraphSha256 ||
          predecessor.definition.status !== first.definition.previousStatus ||
          (await policySha256(encodePolicyEvaluationJobHistoryEntry(predecessor.definition))) !==
            predecessor.entrySha256
        )
          throw new ProofStackApiError(
            "Policy history page does not follow the retained predecessor",
          );
      }
      return { ...value, page };
    });
  }
  private async job(operation: PolicyEvaluationOperation, job: PolicyEvaluationJobReference) {
    const { value } = await operation.request(
      [job.jobId],
      undefined,
      "GET",
      undefined,
      0,
      MAX_POLICY_EVALUATION_JOB_RESPONSE_BYTES,
      ReadPolicyEvaluationJobResponseSchema,
      [200],
    );
    const snapshot = await policyVerifiedJob(value.snapshot, this.scope, job);
    operation.check();
    return { ...value, snapshot };
  }
  private async header(operation: PolicyEvaluationOperation, job: PolicyEvaluationJobReference) {
    const { value } = await operation.request(
      [job.jobId, "snapshot"],
      undefined,
      "GET",
      undefined,
      0,
      MAX_POLICY_EVALUATION_SNAPSHOT_RESPONSE_BYTES,
      ReadPolicyEvaluationSnapshotResponseSchema,
      [200],
    );
    const { snapshot } = await policyVerifiedHeader(value.snapshot, this.scope, job);
    const graph = await this.job(operation, job);
    policyVerifiedSealingAttempt(snapshot, graph.snapshot);
    return { ...value, snapshot };
  }
  private async page(
    operation: PolicyEvaluationOperation,
    job: PolicyEvaluationJobReference,
    snapshot: PolicyEvaluationSnapshot,
    pageIndex: number,
  ) {
    if (!snapshot.pages[pageIndex])
      throw new ProofStackApiError("Policy snapshot page is outside its exact header");
    const reference = {
      snapshotId: snapshot.snapshotId,
      definitionSha256: snapshot.definitionSha256,
    };
    const query = new URLSearchParams(reference);
    const { value } = await operation.request(
      [job.jobId, "snapshot", "pages", String(pageIndex)],
      query,
      "GET",
      undefined,
      0,
      MAX_POLICY_EVALUATION_SNAPSHOT_PAGE_RESPONSE_BYTES,
      ReadPolicyEvaluationSnapshotPageResponseSchema,
      [200],
    );
    if (!policySame(value.snapshot, reference))
      throw new ProofStackApiError(
        "Policy snapshot page response substituted its exact header reference",
      );
    const page = await policyVerifiedPage(value.page, snapshot, pageIndex);
    operation.check();
    return { ...value, page };
  }
  private async complete(operation: PolicyEvaluationOperation, job: PolicyEvaluationJobReference) {
    const { snapshot } = await this.header(operation, job);
    if (snapshot.inputByteLength > this.maximumInput)
      throw new ProofStackApiError(
        "Policy snapshot exceeds the admitted complete-input byte budget",
      );
    const pages = [];
    for (const descriptor of snapshot.pages)
      pages.push((await this.page(operation, job, snapshot, descriptor.pageIndex)).page);
    const material = await policyCompleteSnapshot(
      snapshot,
      pages,
      this.scope,
      job,
      this.maximumInput,
    );
    operation.check();
    return material;
  }
}
