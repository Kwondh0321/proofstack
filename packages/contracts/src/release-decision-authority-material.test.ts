import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PolicyEvaluationSchema } from "./policy-evaluation-result.js";
import {
  ReleaseDecisionAuthorityMaterialSchema,
  ReleaseDecisionIdentityGrantSchema,
  ReleaseDecisionIdentityReferenceSchema,
} from "./release-decision-authority-material.js";

const vectors = JSON.parse(
  readFileSync(
    new URL("../vectors/release-decision-authority-snapshot-v1.json", import.meta.url),
    "utf8",
  ),
) as { vectors: { name: string; material: unknown }[] };
function material(index = 0) {
  return ReleaseDecisionAuthorityMaterialSchema.parse(
    structuredClone(vectors.vectors[index]?.material),
  );
}

/** Synthetic structural graph only; one-byte seal descriptors are not retained source evidence. */
function completedMaterial() {
  const value = material();
  const source = value.policies[0];
  const planned = value.input.evaluations[0];
  if (!source || !planned) throw new Error("Missing planned request");
  const receipt = { schemaVersion: "0.1" as const, scope: value.scope };
  const fence = {
    jobId: "job_original",
    attemptId: "attempt_original",
    workerId: "worker_original",
    leaseId: "lease_original",
    fencingToken: 2,
    recoveryEpoch: 1,
  };
  const snapshotReference = { snapshotId: "snapshot_original", definitionSha256: "a".repeat(64) };
  const completedAt = "2026-10-15T12:02:00.000001Z";
  const startedAt = "2026-10-15T12:01:00.000001Z";
  const sealedAt = "2026-10-15T12:00:30.000001Z";
  const deadlineAt = "2026-10-15T12:10:00.000001Z";
  const usage = {
    reads: 0,
    records: 0,
    recordBytes: 0,
    references: 0,
    referenceBytes: 0,
    artifactReadBytes: 0,
    ruleEvaluations: 0,
  };
  const definition = JSON.parse(
    readFileSync(new URL("../vectors/policy-evaluation-result-v1.json", import.meta.url), "utf8"),
  ).definition;
  const evaluation = PolicyEvaluationSchema.parse({
    ...definition,
    ...receipt,
    ...fence,
    request: source.request,
    snapshot: snapshotReference,
    candidate: planned.request.candidate,
    policy: planned.request.policy,
    algorithm: planned.request.algorithm,
    evaluationTime: planned.request.evaluationTime,
    recordedAt: completedAt,
    recordedByPrincipalId: fence.workerId,
    definitionSha256: "b".repeat(64),
  });
  source.original = {
    state: "complete",
    request: {
      ...structuredClone(planned.request),
      ...receipt,
      definitionSha256: planned.requestSha256,
      createdAt: "2026-10-15T12:00:00.001Z",
      createdByPrincipalId: "principal_enqueue",
    },
    job: {
      ...receipt,
      jobId: fence.jobId,
      request: source.request,
      definitionSha256: "c".repeat(64),
      createdAt: value.input.createdAt,
      createdByPrincipalId: "principal_enqueue",
      deadlineAt,
      updatedAt: completedAt,
      stateVersion: 5,
      recoveryEpoch: 1,
      lastFencingToken: 2,
      attemptCount: 2,
      status: "completed",
      currentLease: null,
      snapshot: snapshotReference,
      result: {
        evaluationId: evaluation.evaluationId,
        definitionSha256: evaluation.definitionSha256,
      },
      retryAt: null,
      terminal: {
        status: "completed",
        code: "evaluation_completed",
        attemptId: fence.attemptId,
        committedAt: completedAt,
      },
    },
    attempt: {
      ...receipt,
      mutationFence: fence,
      attemptSequence: 1,
      startedAt,
      deadlineAt,
      phase: "computing",
      snapshot: snapshotReference,
      usageAtStart: usage,
      usageAtClose: usage,
      closure: { status: "completed", committedAt: completedAt },
    },
    snapshot: {
      ...receipt,
      ...fence,
      ...snapshotReference,
      // The earlier worker sealed once. A later computing attempt reuses its immutable seal.
      attemptId: "attempt_sealing",
      workerId: "worker_sealing",
      leaseId: "lease_sealing",
      fencingToken: 1,
      recoveryEpoch: 0,
      sealedByPrincipalId: "worker_sealing",
      request: source.request,
      candidate: planned.request.candidate,
      policy: planned.request.policy,
      algorithm: planned.request.algorithm,
      evaluationTime: planned.request.evaluationTime,
      capturedAt: sealedAt,
      sealedAt,
      recordedAt: sealedAt,
      manifest: { manifestId: "manifest_original", definitionSha256: "d".repeat(64) },
      inputSha256: "e".repeat(64),
      inputByteLength: 1,
      frameCount: 1,
      pages: [
        { pageIndex: 0, definitionSha256: "f".repeat(64), firstFrameIndex: 0, frameCount: 1 },
      ],
    },
    evaluation,
  };
  value.usage.records = value.input.verificationLimits.maxAcquisitionRecords;
  value.usage.recordBytes = value.input.verificationLimits.maxAcquisitionRecordBytes;
  return value;
}

describe("captured release authority material", () => {
  it("retains a completed original graph including a seal reused after a worker/epoch change", () => {
    const value = completedMaterial();
    expect(ReleaseDecisionAuthorityMaterialSchema.parse(value)).toEqual(value);
  });

  it.each([
    "request_body",
    "seal_owner",
    "seal_ref",
    "result_ref",
    "attempt",
    "worker",
    "fence",
    "subject",
    "cut",
    "completion",
  ])("rejects a substituted completed original %s", (kind) => {
    const value = completedMaterial();
    const original = value.policies[0]?.original;
    if (original?.state !== "complete") throw new Error("Missing complete graph");
    if (kind === "request_body") original.request.limits.maxAttempts += 1;
    if (kind === "seal_owner") original.snapshot.jobId = "job_other";
    if (kind === "seal_ref") original.evaluation.snapshot.definitionSha256 = "0".repeat(64);
    if (kind === "result_ref" && original.job.result)
      original.job.result.evaluationId = "result_other";
    if (kind === "attempt") original.attempt.mutationFence.attemptId = "attempt_other";
    if (kind === "worker") original.evaluation.workerId = "worker_other";
    if (kind === "fence") original.snapshot.fencingToken = 3;
    if (kind === "subject") original.evaluation.policy.policyVersionId = "policy_other";
    if (kind === "cut") value.capturedAt = "2026-10-15T12:01:30.000001Z";
    if (kind === "completion")
      original.attempt.closure = {
        status: "completed",
        committedAt: "2026-10-15T12:02:00.000002Z",
      };
    expect(ReleaseDecisionAuthorityMaterialSchema.safeParse(value).success).toBe(false);
  });
  it.each(vectors.vectors.map((value, index) => ({ ...value, index })))(
    "retains $name without granting authentication",
    (value) => {
      expect(ReleaseDecisionAuthorityMaterialSchema.parse(material(value.index))).toEqual(
        value.material,
      );
    },
  );

  it.each(["token", "sessionDigest", "csrfDigest", "credentialHash", "password", "privateKey"])(
    "excludes private %s from retained identity views",
    (field) => {
      const value = material();
      const identity = value.identities[0];
      if (identity?.state !== "observed") throw new Error("Missing public identity fixture");
      expect(
        ReleaseDecisionIdentityGrantSchema.safeParse({ ...identity.record, [field]: "private" })
          .success,
      ).toBe(false);
      expect(
        ReleaseDecisionIdentityReferenceSchema.safeParse({
          ...identity.reference,
          [field]: "private",
        }).success,
      ).toBe(false);
      expect(
        ReleaseDecisionAuthorityMaterialSchema.safeParse({ ...value, [field]: "private" }).success,
      ).toBe(false);
    },
  );

  it.each(["tenantId", "projectId", "environmentId"] as const)(
    "retains exact %s for all captured domain records",
    (field) => {
      const value = material();
      value.scope[field] = "scope_changed";
      expect(ReleaseDecisionAuthorityMaterialSchema.safeParse(value).success).toBe(false);
    },
  );

  it("rejects omitted/advisory/reordered planned requests and substituted candidate/policy references", () => {
    const value = material();
    const first = value.policies[0];
    if (!first) throw new Error("Missing planned policy");
    for (const policies of [[], [first], [...value.policies].reverse()])
      expect(ReleaseDecisionAuthorityMaterialSchema.safeParse({ ...value, policies }).success).toBe(
        false,
      );
    first.policy.reference.policyVersionId = "policy_substituted";
    expect(ReleaseDecisionAuthorityMaterialSchema.safeParse(value).success).toBe(false);
    const candidate = material();
    candidate.candidate.reference.candidateVersionId = "candidate_substituted";
    expect(ReleaseDecisionAuthorityMaterialSchema.safeParse(candidate).success).toBe(false);
  });

  it("binds publisher identity to the actual principal, authentication kind and service credential", () => {
    const value = material();
    for (const publisherIdentity of [
      { ...value.publisherIdentity, principalId: "principal_other" },
      { ...value.publisherIdentity, credentialId: "credential_other" },
      {
        kind: "oidc_binding",
        principalId: value.publisher.principalId,
        bindingId: "binding_other",
      },
    ])
      expect(
        ReleaseDecisionAuthorityMaterialSchema.safeParse({ ...value, publisherIdentity }).success,
      ).toBe(false);
  });

  it("preserves native cut/epoch and rejects source actions or input captures outside their exact window", () => {
    const value = material();
    for (const capturedAt of ["2026-10-15T12:00:00.000Z", value.input.expiresAt])
      expect(
        ReleaseDecisionAuthorityMaterialSchema.safeParse({ ...value, capturedAt }).success,
      ).toBe(false);
    expect(
      ReleaseDecisionAuthorityMaterialSchema.safeParse({ ...value, recoveryEpoch: -1 }).success,
    ).toBe(false);
    const approval = material(3);
    const record = approval.approvals.records[0];
    if (!record) throw new Error("Missing review fixture");
    record.recordedAt = "2026-10-15T12:03:00.000002Z";
    expect(ReleaseDecisionAuthorityMaterialSchema.safeParse(approval).success).toBe(false);
  });

  it("retains explicit original reviewer bindings instead of adopting another login or authority", () => {
    const value = material(3);
    const actor = value.approvals.actors[0];
    if (!actor) throw new Error("Missing original actor");
    actor.identity.principalId = "principal_another";
    expect(ReleaseDecisionAuthorityMaterialSchema.safeParse(value).success).toBe(false);
    const missing = material(3);
    missing.approvals.actors = [];
    expect(ReleaseDecisionAuthorityMaterialSchema.safeParse(missing).success).toBe(false);
    const authority = material(3);
    authority.authorities.records = [];
    expect(ReleaseDecisionAuthorityMaterialSchema.safeParse(authority).success).toBe(false);
    const identities = material(3);
    identities.identities.pop();
    expect(ReleaseDecisionAuthorityMaterialSchema.safeParse(identities).success).toBe(false);
  });

  it("rejects cross-input approvals and duplicate identity/authority observations", () => {
    const value = material(3);
    const approval = value.approvals.records[0];
    if (!approval) throw new Error("Missing approval fixture");
    approval.subject.request.evaluationRequestId = "request_other";
    expect(ReleaseDecisionAuthorityMaterialSchema.safeParse(value).success).toBe(false);
    const duplicate = material(3);
    const identity = duplicate.identities[0];
    const authority = duplicate.authorities.records[0];
    if (!identity || !authority) throw new Error("Missing source fixtures");
    expect(
      ReleaseDecisionAuthorityMaterialSchema.safeParse({
        ...duplicate,
        identities: [...duplicate.identities, identity],
      }).success,
    ).toBe(false);
    expect(
      ReleaseDecisionAuthorityMaterialSchema.safeParse({
        ...duplicate,
        authorities: {
          ...duplicate.authorities,
          records: [...duplicate.authorities.records, authority],
        },
      }).success,
    ).toBe(false);
  });

  it("charges retained and repeated observations against original aggregate byte/record/approval limits", () => {
    const value = material(3);
    for (const usage of [
      { ...value.usage, records: value.usage.records - 1 },
      { ...value.usage, recordBytes: value.usage.recordBytes - 1 },
      { ...value.usage, approvalRecords: 0 },
      { ...value.usage, records: 100001 },
      { ...value.usage, recordBytes: 67108865 },
      { ...value.usage, approvalRecords: 4097 },
    ])
      expect(ReleaseDecisionAuthorityMaterialSchema.safeParse({ ...value, usage }).success).toBe(
        false,
      );
    const smaller = material(3);
    smaller.input.verificationLimits.maxAcquisitionRecordBytes = smaller.usage.recordBytes - 1;
    expect(ReleaseDecisionAuthorityMaterialSchema.safeParse(smaller).success).toBe(false);
  });

  it("does not convert missing originals into invented jobs or source bodies", () => {
    const value = material();
    const source = value.policies[0];
    const planned = value.input.evaluations[0];
    if (!source || !planned || source.original.state !== "unresolved")
      throw new Error("Missing original unresolved fixture");
    source.original.knownRequest = {
      ...planned.request,
      scope: value.scope,
      schemaVersion: "0.1",
      definitionSha256: planned.requestSha256,
      createdAt: "2026-10-15T12:00:00.000Z",
      createdByPrincipalId: "workload_reference",
    };
    expect(ReleaseDecisionAuthorityMaterialSchema.safeParse(value).success).toBe(false);
  });

  it("keeps unavailable and invalid observations explicit and rejects receipt/proof shortcuts", () => {
    const value = material(2);
    expect(value.authorities.records[0]?.state).toBe("unavailable");
    expect(
      ReleaseDecisionAuthorityMaterialSchema.safeParse({ ...value, currentAuthorization: true })
        .success,
    ).toBe(false);
    const identity = value.identities[0];
    if (!identity) throw new Error("Missing identity source");
    expect(
      ReleaseDecisionAuthorityMaterialSchema.safeParse({
        ...value,
        identities: [{ ...identity, verified: true }],
      }).success,
    ).toBe(false);
    const wrong = material();
    wrong.identities = [];
    expect(ReleaseDecisionAuthorityMaterialSchema.safeParse(wrong).success).toBe(false);
  });
});
