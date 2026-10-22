import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  ReleaseApprovalSubjectSchema,
  type Capability,
  type ReleaseDecisionIdentityGrant,
  type ReleaseDecisionSessionState,
  type ReleaseApprovalPublicationMaterial,
  ReleasePolicyDefinitionSchema,
  ReleasePolicySchema,
} from "@proofstack/contracts";
import {
  releasePolicySelectionReference,
  releaseApprovalReference,
  releasePolicyReference,
  digestReleasePolicyDefinition,
} from "@proofstack/core";
import {
  createMemoryPolicySnapshotResultHarness,
  policySnapshotRepositoryFixture,
  MemoryPolicyEvaluationJobRepository,
  MemoryReleaseCandidateRepository,
  MemoryReleaseApprovalRepository,
  MemoryReleasePolicyRepository,
  MemoryReleasePolicySelectionRepository,
  MemoryReleaseReviewerAuthorityRepository,
  releasePolicySelectionRepositoryFixture,
  releaseReviewerAuthorityRepositoryFixture,
} from "@proofstack/core/testing";
import {
  MemoryArtifactCatalogRepository,
  MemoryArtifactObjectStore,
} from "@proofstack/artifacts/testing";
import { MemoryReleaseSelectionInstallerReference } from "./memory-release-selection-installer.js";

const captured = policySnapshotRepositoryFixture();
afterEach(() => vi.restoreAllMocks());
let jobs: MemoryPolicyEvaluationJobRepository;
let subject: ReturnType<typeof ReleaseApprovalSubjectSchema.parse>;
beforeAll(async () => {
  const h = createMemoryPolicySnapshotResultHarness();
  const f = await h.seed();
  await h.worker.startComputation({ scope: f.scope, fence: f.fence });
  await h.worker.reserveWork({
    scope: f.scope,
    fence: f.fence,
    reservationId: "reservation_normal_approval_fixture",
    delta: {
      reads: 0,
      records: 0,
      recordBytes: 0,
      references: 0,
      referenceBytes: 0,
      artifactReadBytes: 0,
      ruleEvaluations: captured.inputs.rules.ruleCount,
    },
  });
  const result = await h.results.publishResult({
    scope: f.scope,
    fence: f.fence,
    evaluationId: f.evaluationId,
    pageSet: f.pageSet,
  });
  jobs = h.control as MemoryPolicyEvaluationJobRepository;
  subject = ReleaseApprovalSubjectSchema.parse({
    scope: f.scope,
    selection: releasePolicySelectionReference(
      releasePolicySelectionRepositoryFixture("normal").original,
    ),
    candidate: captured.request.candidate,
    policy: captured.request.policy,
    request: result.snapshot.job.request,
    snapshot: result.snapshot.job.snapshot,
    evaluation: result.snapshot.job.result,
    jobId: f.jobId,
    ruleId: "approval_gate",
  });
});

type Physical = {
  policies: MemoryReleasePolicyRepository;
  selections: MemoryReleasePolicySelectionRepository;
  reviewers: MemoryReleaseReviewerAuthorityRepository;
  approvals: MemoryReleaseApprovalRepository;
  jobs: MemoryPolicyEvaluationJobRepository;
  candidates: MemoryReleaseCandidateRepository;
  catalog: MemoryArtifactCatalogRepository;
  objects: MemoryArtifactObjectStore;
  approvalPublications: Map<string, ReleaseApprovalPublicationMaterial>;
  intents: Map<string, unknown>;
  grants: Map<string, ReleaseDecisionIdentityGrant>;
  sessions: Map<string, { credential: ReleaseDecisionSessionState }>;
};
async function fixture(
  options: {
    reviewer?: Record<string, unknown>;
    selection?: Record<string, unknown>;
    principalId?: string;
    basisExpiresAt?: string;
    contentBytes?: number;
  } = {},
) {
  let now = "2026-10-19T12:00:00.000Z";
  const clock = { now: () => new Date(now) };
  const reference = new MemoryReleaseSelectionInstallerReference(clock);
  const scope = captured.scope;
  const physical = () =>
    (reference as unknown as { tenants: Map<string, Physical> }).tenants.get(scope.tenantId)!;
  const grant = (
    principalId: string,
    bindingId: string,
    capabilities: Capability[],
  ): ReleaseDecisionIdentityGrant => ({
    identity: { kind: "oidc_binding", principalId, bindingId },
    tenantId: scope.tenantId,
    state: "active",
    capabilities: [...capabilities].sort(),
    roles: ["member"],
    resourceScope: { mode: "tenant" },
    revision: 1,
    updatedAt: "2026-10-19T11:59:00.000Z",
  });
  const administrator = grant("user_normal_administrator", "binding_normal_administrator", [
    "release:selection:manage",
    "approval:authority:manage",
  ]);
  const reviewer = grant(options.principalId ?? "user_normal_reviewer", "binding_normal_reviewer", [
    "approval:decide",
    "artifact:read",
  ]);
  reference.writeSyntheticGrant(administrator);
  reference.writeSyntheticGrant(reviewer);
  const administratorCredentials = reference.createSyntheticSession({
    scope,
    bindingId: "binding_normal_administrator",
    sessionId: "session_normal_administrator",
    requestId: "request_normal_administrator",
  });
  let sessionCount = 0;
  const login = (requestId: string) =>
    reference.createSyntheticSession({
      scope,
      bindingId: "binding_normal_reviewer",
      sessionId: `session_normal_reviewer_${++sessionCount}`,
      requestId,
    });
  const credentials = login("request_normal_review");
  const candidates = new MemoryReleaseCandidateRepository();
  await candidates.publishReleaseCandidate(captured.inputs.roots.candidate);
  reference.seedSyntheticApprovalSubjectSources({ scope, candidates, jobs });
  await reference.seedSyntheticPolicy(captured.inputs.roots.policy);
  const evidence = await reference.seedSyntheticApprovalEvidence({
    scope,
    artifactId: "artifact_normal_basis",
    content:
      options.contentBytes === undefined
        ? Buffer.from('{"basis":"synthetic reviewer qualification"}')
        : Buffer.from(`"${"a".repeat(options.contentBytes - 2)}"`),
    ...(options.basisExpiresAt ? { expiresAt: options.basisExpiresAt } : {}),
  });
  const selectionBase = releasePolicySelectionRepositoryFixture("normal").original;
  const {
    scope: _s,
    issuerPrincipalId: _i,
    schemaVersion: _v,
    definitionSha256: _h,
    publishedAt: _at,
    publishedByPrincipalId: _by,
    ...selectionDefinition
  } = selectionBase;
  const installed = await reference.publishSelection(administratorCredentials, {
    ...selectionDefinition,
    installationId: captured.inputs.roots.policy.installationBinding.installationId,
    candidateTarget: captured.inputs.roots.candidate.target,
    authorityEvidence: evidence,
    policies: [{ policy: captured.request.policy, mode: captured.inputs.roots.policy.mode }],
    mode: captured.inputs.roots.policy.mode === "mandatory" ? "enforce" : "observation_only",
    effectiveAt: "2026-10-19T00:00:00Z",
    expiresAt: "2026-12-01T00:00:00Z",
    ...options.selection,
  });
  const selection = installed.record;
  if (!("selectionVersionId" in selection)) throw new Error("Selection fixture kind");
  const reviewerBase = releaseReviewerAuthorityRepositoryFixture("normal").original;
  const {
    scope: _rs,
    issuerPrincipalId: _ri,
    schemaVersion: _rv,
    definitionSha256: _rh,
    publishedAt: _rat,
    publishedByPrincipalId: _rby,
    ...reviewerDefinition
  } = reviewerBase;
  const reviewerIntent = {
    ...reviewerDefinition,
    installationId: selection.installationId,
    gateTargetId: selection.gateTargetId,
    reviewerPrincipalId: reviewer.identity.principalId,
    roleIds: ["release_reviewer"],
    independenceGroupIds: ["group_release_review"],
    reviewBasis: [evidence],
    assurance: "synthetic_reference",
    status: "verified",
    conflicts: [],
    effectiveAt: "2026-10-19T00:00:00Z",
    expiresAt: "2026-12-01T00:00:00Z",
    ...options.reviewer,
  };
  const publishedReviewer = await reference.publishReviewerAuthority(
    administratorCredentials,
    reviewerIntent,
  );
  const intent = {
    approvalId: "approval_normal_current",
    kind: "normal_approval" as const,
    action: "approve" as const,
    subject: { ...subject, selection: releasePolicySelectionReference(selection) },
    rationale: "An attributable synthetic normal review of the original approval prerequisite.",
    conditions: [],
    compensatingControls: [],
    declaredConflicts: [],
    expiresAt: "2026-10-20T00:00:00Z",
  };
  return {
    clock,
    reference,
    scope,
    credentials,
    administratorCredentials,
    intent,
    reviewer,
    evidence,
    selection,
    publishedReviewer,
    reviewerIntent,
    login,
    physical,
    setTime(value: string) {
      now = value;
    },
    async unchanged() {
      expect(await reference.readSyntheticApproval(scope, intent.approvalId)).toBeNull();
      expect(physical().approvalPublications.size).toBe(0);
    },
  };
}

describe("authenticated normal approval owning reference", () => {
  it("authenticates actual review and encrypts/reads exact current basis without changing the original result", async () => {
    const f = await fixture();
    const originalResult = await jobs.findResult(f.scope, captured.jobId, captured.pageSet);
    const result = await f.reference.recordNormalApproval(f.credentials, f.intent);
    expect(result.created).toBe(true);
    expect(result.record).toMatchObject({
      ...f.intent,
      reviewer: {
        principalId: f.reviewer.identity.principalId,
        requestId: f.credentials.requestId,
        principalType: "user",
        authenticationMethod: "oidc",
      },
      recordedAt: "2026-10-19T12:00:00.000Z",
    });
    expect(result.record.authority).toMatchObject({
      authorityVersionId: f.reviewerIntent.authorityVersionId,
    });
    expect(result.usage.records).toBeGreaterThan(0);
    expect(result.usage.approvalRecords).toBeGreaterThan(0);
    expect(result.publication.issuedAt).toBe(result.record.recordedAt);
    expect(await f.reference.readSyntheticApproval(f.scope, f.intent.approvalId)).toEqual(
      result.record,
    );
    expect((await jobs.findJobForRequest(f.scope, subject.request))?.job.status).toBe("completed");
    expect(await jobs.findResult(f.scope, captured.jobId, captured.pageSet)).toEqual(
      originalResult,
    );
    expect(originalResult?.rules.find(({ ruleId }) => ruleId === "approval_gate")).toMatchObject({
      outcome: "indeterminate",
      evidence: { kind: "not_evaluated", reason: "approval_not_evaluated" },
    });
    const material = await f.reference.readSyntheticApprovalPublication(
      f.scope,
      "release_approval",
      f.intent.approvalId,
    );
    expect(material?.source.record).toEqual(result.record);
    for (const key of ["sessionToken", "csrfToken", "plaintext", "objectKey", "wrappedDataKey"])
      expect(JSON.stringify(material)).not.toContain(`"${key}"`);
  });
  it.each(["approve", "oppose", "escalate", "abstain"] as const)(
    "retains the %s disposition and declared conditions/conflicts",
    async (action) => {
      const f = await fixture();
      const intent = {
        ...f.intent,
        action,
        conditions: ["Independent operational sign-off remains required."],
        declaredConflicts: ["Declared relationship for later quorum assessment."],
      };
      const result = await f.reference.recordNormalApproval(f.credentials, intent);
      expect(result.record).toMatchObject(intent);
    },
  );
  it("authenticates and authorizes before touching the body", async () => {
    const f = await fixture();
    let touched = 0;
    const raw = Object.defineProperty({}, "approvalId", {
      enumerable: true,
      get() {
        touched++;
        throw new Error("Body read");
      },
    });
    for (const credentials of [
      { ...f.credentials, csrfToken: "bad" },
      { ...f.credentials, sessionToken: "bad" },
      { ...f.credentials, scope: { ...f.scope, tenantId: "foreign" } },
    ])
      await expect(f.reference.recordNormalApproval(credentials, raw)).rejects.toThrow();
    f.reference.writeSyntheticGrant({
      ...f.reviewer,
      revision: 2,
      capabilities: ["artifact:read"],
    });
    await expect(f.reference.recordNormalApproval(f.credentials, raw)).rejects.toThrow();
    expect(touched).toBe(0);
    f.reference.writeSyntheticGrant({ ...f.reviewer, revision: 3 });
    await expect(f.reference.recordNormalApproval(f.credentials, raw)).rejects.toThrow();
    expect(touched).toBe(1);
    await f.unchanged();
  });
  it("preserves first receipt across equal retries and another login even after authority expires", async () => {
    const f = await fixture();
    const first = await f.reference.recordNormalApproval(f.credentials, f.intent);
    f.setTime("2026-12-02T12:00:00.000Z");
    const credentials = f.login("request_later_normal_retry");
    const retry = await f.reference.recordNormalApproval(credentials, f.intent);
    expect(retry).toMatchObject({
      created: false,
      record: first.record,
      publication: first.publication,
    });
    retry.record.rationale = "Changed returned copy";
    expect(await f.reference.readSyntheticApproval(f.scope, f.intent.approvalId)).toEqual(
      first.record,
    );
    await expect(
      f.reference.recordNormalApproval(credentials, { ...f.intent, rationale: "Changed intent" }),
    ).rejects.toThrow();
    f.reference.writeSyntheticGrant({ ...f.reviewer, revision: 2, capabilities: [] });
    await expect(f.reference.recordNormalApproval(credentials, f.intent)).rejects.toThrow();
  });
  it("requires the actual artifact-read grant and never elevates approval capability", async () => {
    const f = await fixture();
    f.reference.writeSyntheticGrant({
      ...f.reviewer,
      revision: 2,
      capabilities: ["approval:decide"],
    });
    const objectRead = vi.spyOn(MemoryArtifactObjectStore.prototype, "get");
    const reads = objectRead.mock.calls.length;
    await expect(f.reference.recordNormalApproval(f.credentials, f.intent)).rejects.toMatchObject({
      cause: { code: "forbidden" },
    });
    expect(objectRead.mock.calls.length).toBe(reads);
    objectRead.mockRestore();
    await f.unchanged();
  });
  it("withdraws an actually recorded normal approval through the original-reviewer service", async () => {
    const f = await fixture();
    const approval = await f.reference.recordNormalApproval(f.credentials, f.intent);
    const revoked = await f.reference.revokeApproval(f.credentials, {
      eventId: "event_recorded_approval_withdrawn",
      approval: releaseApprovalReference(approval.record),
      reason: "Withdraw my actual prior action.",
    });
    expect(revoked.record.approval).toEqual(releaseApprovalReference(approval.record));
    expect(revoked.record.reviewer.principalId).toBe(approval.record.reviewer.principalId);
  });
  it.each(["authority", "reviewer", "recordedAt", "schemaVersion", "definitionSha256"])(
    "rejects server-owned %s fields",
    async (key) => {
      const f = await fixture();
      await expect(
        f.reference.recordNormalApproval(f.credentials, { ...f.intent, [key]: "caller" }),
      ).rejects.toThrow();
      await f.unchanged();
    },
  );
  it("does not authorize an exception from a normal review or an arbitrary original rule", async () => {
    const f = await fixture();
    for (const intent of [
      { ...f.intent, kind: "rule_exception", action: "oppose" },
      { ...f.intent, subject: { ...f.intent.subject, ruleId: "artifact_bundle" } },
      {
        ...f.intent,
        subject: { ...f.intent.subject, scope: { ...f.scope, projectId: "foreign" } },
      },
    ])
      await expect(f.reference.recordNormalApproval(f.credentials, intent)).rejects.toThrow();
    await f.unchanged();
  });
  it.each([
    ["role", { roleIds: ["unrelated_role"] }],
    ["group", { independenceGroupIds: ["unrelated_group"] }],
    [
      "unverified",
      { status: "unverifiable", statusReasons: ["Qualification not independently established."] },
    ],
    [
      "conflicted",
      {
        status: "rejected",
        statusReasons: ["Conflict prevents qualification."],
        conflicts: ["Authority administrator disclosed a disqualifying conflict."],
      },
    ],
    ["operator assurance", { assurance: "operator_verified" }],
    ["future authority", { effectiveAt: "2026-10-20T00:00:00Z" }],
  ] as const)("rejects actually published %s reviewer authority", async (_name, reviewer) => {
    const f = await fixture({ reviewer });
    await expect(f.reference.recordNormalApproval(f.credentials, f.intent)).rejects.toThrow();
    await f.unchanged();
  });
  it("excludes the actual original policy/candidate author", async () => {
    const f = await fixture({ principalId: captured.inputs.roots.policy.publishedByPrincipalId });
    await expect(f.reference.recordNormalApproval(f.credentials, f.intent)).rejects.toThrow();
    await f.unchanged();
  });
  it("requires the exact selected candidate target", async () => {
    const f = await fixture({
      selection: {
        candidateTarget: {
          ...captured.inputs.roots.candidate.target,
          purpose: "A different retained target description.",
        },
      },
    });
    await expect(f.reference.recordNormalApproval(f.credentials, f.intent)).rejects.toThrow();
    await f.unchanged();
  });
  it("rejects a withdrawn selection through its actual administrator port", async () => {
    const f = await fixture();
    await f.reference.publishLifecycle(f.administratorCredentials, {
      eventId: "event_normal_selection_withdrawn",
      kind: "withdrawn",
      selection: f.intent.subject.selection,
      reason: "This selected gate is withdrawn.",
    });
    await expect(f.reference.recordNormalApproval(f.credentials, f.intent)).rejects.toThrow();
    await f.unchanged();
  });
  it("rejects actual reviewer revocation and keeps its original provenance", async () => {
    const f = await fixture();
    const row = f.publishedReviewer.record;
    if (!("authorityVersionId" in row)) throw new Error("Fixture reviewer kind");
    await f.reference.publishReviewerAuthorityLifecycle(f.administratorCredentials, {
      eventId: "event_normal_reviewer_revoked",
      kind: "revoked",
      authority: {
        authorityId: row.authorityId,
        authorityVersionId: row.authorityVersionId,
        definitionSha256: row.definitionSha256,
        installationId: row.installationId,
        gateTargetId: row.gateTargetId,
        reviewerPrincipalId: row.reviewerPrincipalId,
      },
      reason: "The original administrator revoked this expertise declaration.",
    });
    await expect(f.reference.recordNormalApproval(f.credentials, f.intent)).rejects.toThrow();
    await f.unchanged();
  });
  it("rejects a policy withdrawn after the original evaluation", async () => {
    const f = await fixture();
    await f.reference.seedSyntheticPolicyLifecycle({
      schemaVersion: "0.1",
      scope: f.scope,
      eventId: "event_normal_policy_withdrawn",
      kind: "withdrawn",
      policy: f.intent.subject.policy,
      occurredAt: "2026-10-19T12:00:00.000Z",
      actorPrincipalId: captured.inputs.roots.policy.publishedByPrincipalId,
      reason: "The original evaluation remains historical after withdrawal.",
    });
    await expect(f.reference.recordNormalApproval(f.credentials, f.intent)).rejects.toThrow();
    await f.unchanged();
  });
  it.each([
    ["expired intent", "2026-10-19T12:00:00Z"],
    ["selection window", "2026-12-01T00:00:00.000001Z"],
  ])("rejects an approval outside its %s", async (_name, expiresAt) => {
    const f = await fixture();
    await expect(
      f.reference.recordNormalApproval(f.credentials, { ...f.intent, expiresAt }),
    ).rejects.toThrow();
    await f.unchanged();
  });
  it("bounds approval validity by actual encrypted basis retention", async () => {
    const f = await fixture({ basisExpiresAt: "2026-10-19T12:30:00Z" });
    await expect(f.reference.recordNormalApproval(f.credentials, f.intent)).rejects.toThrow();
    await f.unchanged();
    const valid = await f.reference.recordNormalApproval(f.credentials, {
      ...f.intent,
      expiresAt: "2026-10-19T12:30:00Z",
    });
    expect(valid.created).toBe(true);
  });
  it.each(["missing", "corrupt", "failed"] as const)(
    "rolls back after %s encrypted content",
    async (state) => {
      const f = await fixture();
      const read = vi.spyOn(MemoryArtifactObjectStore.prototype, "get");
      if (state === "failed") read.mockRejectedValueOnce(new Error("Owning object read failed"));
      else read.mockResolvedValueOnce(state === "missing" ? null : Uint8Array.of(1, 2, 3));
      await expect(f.reference.recordNormalApproval(f.credentials, f.intent)).rejects.toThrow();
      await f.unchanged();
    },
  );
  it("rejects an intervening actual grant change instead of rebasing onto newer state", async () => {
    const f = await fixture();
    const get = MemoryArtifactObjectStore.prototype.get;
    vi.spyOn(MemoryArtifactObjectStore.prototype, "get").mockImplementationOnce(async function (
      this: MemoryArtifactObjectStore,
      key,
    ) {
      const bytes = await get.call(this, key);
      f.reference.writeSyntheticGrant({ ...f.reviewer, revision: 2, capabilities: [] });
      return bytes;
    });
    await expect(f.reference.recordNormalApproval(f.credentials, f.intent)).rejects.toThrow();
    await f.unchanged();
    expect(f.physical().grants.get("binding_normal_reviewer")?.capabilities).toEqual([]);
  });
  it("rejects expiry during actual content I/O and retains no partial approval", async () => {
    const f = await fixture({ basisExpiresAt: "2026-10-19T12:01:00Z" });
    const get = MemoryArtifactObjectStore.prototype.get;
    vi.spyOn(MemoryArtifactObjectStore.prototype, "get").mockImplementationOnce(async function (
      this: MemoryArtifactObjectStore,
      key,
    ) {
      const bytes = await get.call(this, key);
      f.setTime("2026-10-19T12:01:00.000Z");
      return bytes;
    });
    await expect(
      f.reference.recordNormalApproval(f.credentials, {
        ...f.intent,
        expiresAt: "2026-10-19T12:01:00Z",
      }),
    ).rejects.toThrow();
    await f.unchanged();
  });
  it("rolls back the source/profile/intent bundle when the owning source write fails", async () => {
    const f = await fixture();
    vi.spyOn(
      MemoryReleaseApprovalRepository.prototype,
      "publishReleaseApproval",
    ).mockRejectedValueOnce(new Error("Owning approval writer failed"));
    const before = structuredClone(f.physical().intents);
    await expect(f.reference.recordNormalApproval(f.credentials, f.intent)).rejects.toThrow();
    await f.unchanged();
    expect(f.physical().intents).toEqual(before);
  });
  it("refuses an unproven legacy approval instead of repairing its original publication", async () => {
    const f = await fixture();
    const first = await f.reference.recordNormalApproval(f.credentials, f.intent);
    f.physical().approvalPublications.clear();
    await expect(f.reference.recordNormalApproval(f.credentials, f.intent)).rejects.toThrow();
    expect(await f.reference.readSyntheticApproval(f.scope, f.intent.approvalId)).toEqual(
      first.record,
    );
    expect(f.physical().approvalPublications.size).toBe(0);
  });
  it.each(["candidates", "policies", "selections", "reviewers"] as const)(
    "requires the actual owning %s store",
    async (kind) => {
      const f = await fixture();
      const empty = {
        candidates: new MemoryReleaseCandidateRepository(),
        policies: new MemoryReleasePolicyRepository(),
        selections: new MemoryReleasePolicySelectionRepository(),
        reviewers: new MemoryReleaseReviewerAuthorityRepository(),
      };
      Object.assign(f.physical(), { [kind]: empty[kind] });
      await expect(f.reference.recordNormalApproval(f.credentials, f.intent)).rejects.toThrow();
      await f.unchanged();
    },
  );
  it("does not approve a policy omitted by the actual complete selection", async () => {
    const f = await fixture({ selection: { policies: [], mode: "observation_only" } });
    await expect(f.reference.recordNormalApproval(f.credentials, f.intent)).rejects.toThrow();
    await f.unchanged();
  });
  it("retains full original policy successor reads and rejects superseded authority", async () => {
    const f = await fixture();
    const {
      schemaVersion: _v,
      scope: _s,
      definitionSha256: _h,
      publishedAt: _at,
      publishedByPrincipalId: _by,
      ...base
    } = captured.inputs.roots.policy;
    const definition = ReleasePolicyDefinitionSchema.parse({
      ...base,
      policyVersionId: "policy_normal_successor",
      semanticVersion: "2.0.0",
      predecessor: captured.request.policy,
      changeRationale: "Replace the exact original policy.",
    });
    const successor = ReleasePolicySchema.parse({
      ...definition,
      scope: f.scope,
      schemaVersion: "0.1",
      publishedAt: "2026-10-19T12:00:00.000Z",
      publishedByPrincipalId: definition.issuerPrincipalId,
      definitionSha256: digestReleasePolicyDefinition(f.scope, definition),
    });
    await f.reference.seedSyntheticPolicy(successor);
    await f.reference.seedSyntheticPolicyLifecycle({
      schemaVersion: "0.1",
      scope: f.scope,
      eventId: "event_normal_policy_superseded",
      kind: "superseded",
      policy: f.intent.subject.policy,
      successor: releasePolicyReference(successor),
      occurredAt: "2026-10-19T12:00:00.000Z",
      actorPrincipalId: definition.issuerPrincipalId,
      reason: "Retain the full successor lineage.",
    });
    await expect(f.reference.recordNormalApproval(f.credentials, f.intent)).rejects.toThrow();
    await f.unchanged();
  });
  it("reuses the injected server clock when constructing a private original job store", async () => {
    const f = await fixture();
    const at = new Date(captured.request.createdAt);
    const reference = new MemoryReleaseSelectionInstallerReference({ now: () => at });
    reference.writeSyntheticGrant(f.reviewer);
    const state = (reference as unknown as { tenants: Map<string, Physical> }).tenants.get(
      f.scope.tenantId,
    )!;
    const result = await state.jobs.createJob({
      request: captured.request,
      jobId: "job_owned_clock",
    });
    expect(result.snapshot.job.createdAt).toBe(at.toISOString());
  });
  it.each(["selection", "reviewer"] as const)(
    "binds every %s census row to its actual original authenticated source",
    async (kind) => {
      const f = await fixture();
      if (kind === "selection") {
        const read =
          MemoryReleasePolicySelectionRepository.prototype.readReleasePolicySelectionTarget;
        vi.spyOn(
          MemoryReleasePolicySelectionRepository.prototype,
          "readReleasePolicySelectionTarget",
        ).mockImplementationOnce(async function (
          this: MemoryReleasePolicySelectionRepository,
          ...args
        ) {
          const value = await read.apply(this, args);
          if (!value.root) throw new Error("Expected an actual owned selection root");
          return {
            ...value,
            records: value.records.map((row) => ({
              ...row,
              rationale: "Substituted census projection.",
            })),
          };
        });
      } else {
        const read =
          MemoryReleaseReviewerAuthorityRepository.prototype.readReleaseReviewerAuthorityTarget;
        vi.spyOn(
          MemoryReleaseReviewerAuthorityRepository.prototype,
          "readReleaseReviewerAuthorityTarget",
        ).mockImplementationOnce(async function (
          this: MemoryReleaseReviewerAuthorityRepository,
          ...args
        ) {
          const value = await read.apply(this, args);
          if (!value.root) throw new Error("Expected an actual owned reviewer root");
          return {
            ...value,
            records: value.records.map((row) => ({
              ...row,
              rationale: "Substituted census projection.",
            })),
          };
        });
      }
      await expect(f.reference.recordNormalApproval(f.credentials, f.intent)).rejects.toThrow();
      await f.unchanged();
    },
  );
  it("keeps exact original supersession and revocation history when another normal review is recorded", async () => {
    const f = await fixture();
    const first = await f.reference.recordNormalApproval(f.credentials, f.intent);
    await f.reference.revokeApproval(f.credentials, {
      eventId: "event_normal_prior_withdrawn",
      approval: releaseApprovalReference(first.record),
      reason: "Withdraw this earlier normal review.",
    });
    const second = await f.reference.recordNormalApproval(f.credentials, {
      ...f.intent,
      approvalId: "approval_normal_successor",
      supersedes: releaseApprovalReference(first.record),
    });
    expect(second.record.supersedes).toEqual(releaseApprovalReference(first.record));
    expect(await f.reference.readSyntheticApproval(f.scope, first.record.approvalId)).toEqual(
      first.record,
    );
    expect(
      await f.reference.readSyntheticApprovalRevocation(f.scope, "event_normal_prior_withdrawn"),
    ).not.toBeNull();
  });
  it.each([-1, 0, 1])(
    "admits repeated encrypted bytes at the aggregate boundary offset %i",
    async (offset) => {
      const f = await fixture({ contentBytes: 8 * 1024 * 1024 - 20 + offset });
      const read = vi.spyOn(MemoryArtifactObjectStore.prototype, "get");
      if (offset > 0) {
        await expect(f.reference.recordNormalApproval(f.credentials, f.intent)).rejects.toThrow();
        expect(read).toHaveBeenCalledTimes(1);
        await f.unchanged();
      } else {
        expect((await f.reference.recordNormalApproval(f.credentials, f.intent)).created).toBe(
          true,
        );
        expect(read).toHaveBeenCalledTimes(2);
      }
    },
  );
  it("permits fixture ownership before any login while preserving independent imported stores", async () => {
    const candidates = new MemoryReleaseCandidateRepository();
    await candidates.publishReleaseCandidate(captured.inputs.roots.candidate);
    const reference = new MemoryReleaseSelectionInstallerReference({
      now: () => new Date("2026-10-19T12:00:00Z"),
    });
    reference.seedSyntheticApprovalSubjectSources({ scope: captured.scope, candidates, jobs });
    const imported = (reference as unknown as { tenants: Map<string, Physical> }).tenants.get(
      captured.scope.tenantId,
    )!;
    expect(imported.candidates).not.toBe(candidates);
    expect(imported.jobs).not.toBe(jobs);
    expect(await imported.jobs.findJobForRequest(captured.scope, subject.request)).toEqual(
      await jobs.findJobForRequest(captured.scope, subject.request),
    );
    const empty = new MemoryReleaseSelectionInstallerReference({
      now: () => new Date("2026-10-19T12:00:00Z"),
    });
    const basis = await empty.seedSyntheticApprovalEvidence({
      scope: captured.scope,
      artifactId: "artifact_before_login",
      content: Buffer.from('{"basis":"fixture"}'),
    });
    expect(basis.artifactId).toBe("artifact_before_login");
  });
  it("does not replace existing encrypted fixture evidence through repeated seeding", async () => {
    const f = await fixture();
    const before = await f.physical().catalog.find(f.scope, f.evidence.artifactId);
    await expect(
      f.reference.seedSyntheticApprovalEvidence({
        scope: f.scope,
        artifactId: f.evidence.artifactId,
        content: Buffer.from('{"basis":"synthetic reviewer qualification"}'),
      }),
    ).rejects.toThrow();
    expect(await f.physical().catalog.find(f.scope, f.evidence.artifactId)).toEqual(before);
  });
  it.each(["selection", "reviewer"] as const)(
    "binds every %s lifecycle row to original authenticated content",
    async (kind) => {
      const f = await fixture();
      if (kind === "selection") {
        await f.reference.publishLifecycle(f.administratorCredentials, {
          eventId: "event_projection_selection",
          kind: "withdrawn",
          selection: f.intent.subject.selection,
          reason: "Retain the original reason.",
        });
        const read =
          MemoryReleasePolicySelectionRepository.prototype.readReleasePolicySelectionTarget;
        vi.spyOn(
          MemoryReleasePolicySelectionRepository.prototype,
          "readReleasePolicySelectionTarget",
        ).mockImplementationOnce(async function (
          this: MemoryReleasePolicySelectionRepository,
          ...args
        ) {
          const value = await read.apply(this, args);
          if (!value.root) throw new Error("Expected original root");
          return {
            ...value,
            lifecycle: value.lifecycle.map((row) => ({ ...row, reason: "Substituted history." })),
          };
        });
      } else {
        const row = f.publishedReviewer.record;
        if (!("authorityVersionId" in row)) throw new Error("Fixture reviewer kind");
        await f.reference.publishReviewerAuthorityLifecycle(f.administratorCredentials, {
          eventId: "event_projection_reviewer",
          kind: "revoked",
          authority: {
            authorityId: row.authorityId,
            authorityVersionId: row.authorityVersionId,
            definitionSha256: row.definitionSha256,
            installationId: row.installationId,
            gateTargetId: row.gateTargetId,
            reviewerPrincipalId: row.reviewerPrincipalId,
          },
          reason: "Retain the original reason.",
        });
        const read =
          MemoryReleaseReviewerAuthorityRepository.prototype.readReleaseReviewerAuthorityTarget;
        vi.spyOn(
          MemoryReleaseReviewerAuthorityRepository.prototype,
          "readReleaseReviewerAuthorityTarget",
        ).mockImplementationOnce(async function (
          this: MemoryReleaseReviewerAuthorityRepository,
          ...args
        ) {
          const value = await read.apply(this, args);
          if (!value.root) throw new Error("Expected original root");
          return {
            ...value,
            lifecycle: value.lifecycle.map((row) => ({ ...row, reason: "Substituted history." })),
          };
        });
      }
      await expect(f.reference.recordNormalApproval(f.credentials, f.intent)).rejects.toThrow();
      await f.unchanged();
    },
  );
  it("does not return a retry receipt across a regressing final clock", async () => {
    const f = await fixture();
    const first = await f.reference.recordNormalApproval(f.credentials, f.intent);
    const read = MemoryReleaseApprovalRepository.prototype.findReleaseApproval;
    vi.spyOn(
      MemoryReleaseApprovalRepository.prototype,
      "findReleaseApproval",
    ).mockImplementationOnce(async function (this: MemoryReleaseApprovalRepository, ...args) {
      const value = await read.apply(this, args);
      f.setTime("2026-10-19T11:59:59.999Z");
      return value;
    });
    await expect(f.reference.recordNormalApproval(f.credentials, f.intent)).rejects.toThrow();
    expect(await f.reference.readSyntheticApproval(f.scope, f.intent.approvalId)).toEqual(
      first.record,
    );
  });
  it.each(["before start", "before content completion"] as const)(
    "rejects a publication cut %s",
    async (state) => {
      const f = await fixture();
      const read = MemoryArtifactObjectStore.prototype.get;
      let objects = 0;
      vi.spyOn(MemoryArtifactObjectStore.prototype, "get").mockImplementation(async function (
        this: MemoryArtifactObjectStore,
        key,
      ) {
        const value = await read.call(this, key);
        if (++objects === 2)
          vi.spyOn(f.clock, "now")
            .mockReturnValueOnce(
              new Date(
                state === "before start" ? "2026-10-19T12:00:00Z" : "2026-10-19T12:00:00.001Z",
              ),
            )
            .mockReturnValueOnce(
              new Date(
                state === "before start" ? "2026-10-19T11:59:59.999Z" : "2026-10-19T12:00:00Z",
              ),
            );
        return value;
      });
      await expect(f.reference.recordNormalApproval(f.credentials, f.intent)).rejects.toThrow();
      await f.unchanged();
    },
  );
  it("rejects a different time-effective reviewer version after content acquisition", async () => {
    const f = await fixture({ reviewer: { expiresAt: "2026-10-19T12:00:01Z" } });
    const row = f.publishedReviewer.record;
    if (!("authorityVersionId" in row)) throw new Error("Fixture reviewer kind");
    await f.reference.publishReviewerAuthority(f.administratorCredentials, {
      ...f.reviewerIntent,
      authorityVersionId: "version_normal_future",
      effectiveAt: "2026-10-19T12:00:01Z",
      expiresAt: "2026-12-01T00:00:00Z",
      predecessor: {
        authorityId: row.authorityId,
        authorityVersionId: row.authorityVersionId,
        definitionSha256: row.definitionSha256,
        installationId: row.installationId,
        gateTargetId: row.gateTargetId,
        reviewerPrincipalId: row.reviewerPrincipalId,
      },
    });
    const get = MemoryArtifactObjectStore.prototype.get;
    vi.spyOn(MemoryArtifactObjectStore.prototype, "get").mockImplementationOnce(async function (
      this: MemoryArtifactObjectStore,
      key,
    ) {
      const value = await get.call(this, key);
      f.setTime("2026-10-19T12:00:01.000Z");
      return value;
    });
    await expect(
      f.reference.recordNormalApproval(f.credentials, {
        ...f.intent,
        expiresAt: "2026-10-19T12:00:01Z",
      }),
    ).rejects.toThrow();
    await f.unchanged();
  });
  it.each(["missing", "changed"] as const)(
    "rejects a final %s catalog after content is verified",
    async (state) => {
      const f = await fixture();
      const find = MemoryArtifactCatalogRepository.prototype.find;
      let reads = 0;
      vi.spyOn(MemoryArtifactCatalogRepository.prototype, "find").mockImplementation(
        async function (this: MemoryArtifactCatalogRepository, ...args) {
          const value = await find.apply(this, args);
          if (++reads === 5)
            return state === "missing"
              ? null
              : { ...value!, createdByPrincipalId: "principal_substituted" };
          return value;
        },
      );
      await expect(f.reference.recordNormalApproval(f.credentials, f.intent)).rejects.toThrow();
      expect(reads).toBe(5);
      await f.unchanged();
    },
  );
  it("rejects a persistence reply that claims a competing original after a tentative source write", async () => {
    const f = await fixture();
    const publish = MemoryReleaseApprovalRepository.prototype.publishReleaseApproval;
    vi.spyOn(
      MemoryReleaseApprovalRepository.prototype,
      "publishReleaseApproval",
    ).mockImplementationOnce(async function (this: MemoryReleaseApprovalRepository, ...args) {
      const value = await publish.apply(this, args);
      return { ...value, created: false };
    });
    await expect(f.reference.recordNormalApproval(f.credentials, f.intent)).rejects.toThrow();
    await f.unchanged();
  });
  it.each(["expired", "backward"] as const)(
    "rolls back the whole bundle when the final cut is %s",
    async (state) => {
      const f = await fixture();
      const publish = MemoryReleaseApprovalRepository.prototype.publishReleaseApproval;
      vi.spyOn(
        MemoryReleaseApprovalRepository.prototype,
        "publishReleaseApproval",
      ).mockImplementationOnce(async function (this: MemoryReleaseApprovalRepository, ...args) {
        const value = await publish.apply(this, args);
        f.setTime(state === "expired" ? "2026-10-20T00:00:00.000Z" : "2026-10-19T11:59:59.999Z");
        return value;
      });
      await expect(f.reference.recordNormalApproval(f.credentials, f.intent)).rejects.toThrow();
      await f.unchanged();
    },
  );
});
