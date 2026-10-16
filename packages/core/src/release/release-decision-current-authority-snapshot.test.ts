import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  ReleaseDecisionCurrentAuthorityMaterialSchema,
  encodeReleaseDecisionCurrentAuthoritySnapshotDefinition,
  encodeReleaseDecisionCurrentAuthorityPageDefinition,
  RELEASE_DECISION_AUTHORITY_FRAME_BYTES,
  RELEASE_DECISION_AUTHORITY_PAGE_SIZE,
  type ReleaseDecisionCurrentAuthoritySnapshot,
  type ReleaseDecisionCurrentAuthorityPage,
  encodeEvaluationCanonicalJson,
  encodeReleaseDecisionInputDefinition,
  ReleaseEvaluationActorProvenanceSchema,
  RELEASE_EVALUATION_SOURCE_ACTOR_FIELDS,
  policyEvaluationSourceReferenceKey,
} from "@proofstack/contracts";
import { describe, expect, it } from "vitest";
import {
  prepareReleaseDecisionCurrentAuthoritySnapshot,
  decodeReleaseDecisionCurrentAuthoritySnapshot,
} from "./release-decision-current-authority-snapshot.js";
import {
  decodeReleaseDecisionAuthoritySnapshot,
  ReleaseDecisionAuthorityIntegrityError,
} from "./release-decision-authority-snapshot.js";
import {
  digestReleaseReviewerAuthorityDefinition,
  releaseReviewerAuthorityReference,
} from "./release-authority-record-validation.js";
import { ownedPolicyEvaluationFixture } from "../testing/owned-policy-evaluation-fixture.js";
import { inspectOwnedPolicyEvaluation } from "./owned-policy-evaluation.js";
import { digestPolicyEvaluationDefinition } from "../policy/policy-evaluation-result-record-validation.js";

const vectors = JSON.parse(
  readFileSync(
    new URL(
      "../../../contracts/vectors/release-decision-current-authority-snapshot-v2.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as {
  vectors: {
    name: string;
    material: unknown;
    expected: {
      materialByteLength: number;
      materialSha256: string;
      frameCount: number;
      pageSha256: string[];
      headerSha256: string;
      reviewAuthorityAssurances: string[];
      hasUnavailableReviewerAuthority: boolean;
    };
  }[];
};
function material(index = 0) {
  return ReleaseDecisionCurrentAuthorityMaterialSchema.parse(
    structuredClone(vectors.vectors[index]?.material),
  );
}
/** Fresh standalone model at its own original cut, never retimed captured/native receipts. Missing current authority stays explicit. */
async function observedOriginalMaterial() {
  const fixture = await ownedPolicyEvaluationFixture("new_request_at_capture_cut");
  const owned = inspectOwnedPolicyEvaluation(fixture);
  const value = material();
  const base = value.base;
  const scope = owned.request.scope;
  base.scope = scope;
  base.capturedAt = fixture.capturedAt;
  base.recoveryEpoch = 0;
  base.publisher.authenticatedAt = owned.request.createdAt;
  base.identities = [{ state: "unavailable", reference: base.publisherIdentity }];
  const {
    schemaVersion: _requestVersion,
    definitionSha256: requestSha256,
    scope: _scope,
    createdAt: _createdAt,
    createdByPrincipalId: _requester,
    ...request
  } = owned.request;
  const definition = {
    ...base.input,
    scope,
    candidate: owned.request.candidate,
    mode: owned.policy.mode === "mandatory" ? ("enforce" as const) : ("observation_only" as const),
    publisher: base.publisher,
    createdAt: owned.request.evaluationTime,
    expiresAt: "2026-10-01T02:10:00.000Z",
    evaluations: [{ mode: owned.policy.mode, request, requestSha256 }],
  };
  const {
    schemaVersion: _inputVersion,
    definitionSha256: _inputSha,
    ...inputDefinition
  } = definition;
  base.input = {
    ...inputDefinition,
    schemaVersion: "0.1",
    definitionSha256: createHash("sha256")
      .update(encodeReleaseDecisionInputDefinition({ scope, definition: inputDefinition }))
      .digest("hex"),
  };
  base.candidate = {
    state: "observed",
    reference: owned.request.candidate,
    record: owned.candidate,
  };
  base.selections = { state: "unavailable", records: [], lifecycle: [] };
  const attempt = fixture.jobGraph.attempts.find((row) => row.closure?.status === "completed");
  if (!attempt) throw new Error("Missing actual completed model attempt");
  base.policies = [
    {
      policy: { state: "observed", reference: owned.request.policy, record: owned.policy },
      request: fixture.expected.request,
      original: {
        state: "complete",
        request: owned.request,
        job: fixture.jobGraph.job,
        attempt,
        snapshot: fixture.snapshot,
        evaluation: fixture.evaluation,
      },
      lifecycle: [],
    },
  ];
  base.usage = { records: 10_000, recordBytes: 16 * 1024 * 1024, approvalRecords: 0 };
  const sources = [...owned.originalSourceWitnesses]
    .sort((a, b) => {
      const left = policyEvaluationSourceReferenceKey(a.entry.source);
      const right = policyEvaluationSourceReferenceKey(b.entry.source);
      return left < right ? -1 : left > right ? 1 : 0;
    })
    .map((witness) => {
      const kind = witness.entry.source.kind;
      if (kind === "release_candidate" || kind === "release_policy") {
        const candidate = kind === "release_candidate";
        return {
          state: "observed" as const,
          witness,
          actors: [
            {
              field: candidate ? "/createdByPrincipalId" : "/publishedByPrincipalId",
              role: "source_author",
              principalId: candidate
                ? owned.candidate.createdByPrincipalId
                : owned.policy.publishedByPrincipalId,
            },
          ],
        };
      }
      return {
        state: "unavailable" as const,
        witness,
        reason: "owning_source_unavailable" as const,
      };
    });
  const actors = ReleaseEvaluationActorProvenanceSchema.parse({
    schemaVersion: "0.1",
    authorityBoundary: "original_evaluation_actors_only",
    scope,
    original: {
      request: fixture.expected.request,
      jobId: fixture.jobGraph.job.jobId,
      snapshot: fixture.evaluation.snapshot,
      evaluation: {
        evaluationId: fixture.evaluation.evaluationId,
        definitionSha256: fixture.evaluation.definitionSha256,
      },
      evaluationTime: owned.request.evaluationTime,
      evaluatorPrincipalId: fixture.evaluation.recordedByPrincipalId,
      requesterPrincipalId: owned.request.createdByPrincipalId,
    },
    candidate: {
      reference: owned.request.candidate,
      authorPrincipalId: owned.candidate.createdByPrincipalId,
    },
    policy: {
      reference: owned.request.policy,
      authorPrincipalId: owned.policy.publishedByPrincipalId,
    },
    sources,
    sourceState: sources.every((row) => row.state === "observed") ? "complete" : "unavailable",
    evaluationActorState: sources.some(
      (row) =>
        row.state === "unavailable" &&
        RELEASE_EVALUATION_SOURCE_ACTOR_FIELDS[row.witness.entry.source.kind].some(
          ({ role }) => role === "evaluation_actor",
        ),
    )
      ? "unavailable"
      : "complete",
    evaluatorPrincipalIds: [fixture.evaluation.recordedByPrincipalId],
  });
  value.originals = [
    {
      state: "observed",
      request: fixture.expected.request,
      graph: fixture.jobGraph,
      pageSet: fixture.pageSet,
      actors,
    },
  ];
  return ReleaseDecisionCurrentAuthorityMaterialSchema.parse(value);
}
function owner(snapshot: ReleaseDecisionCurrentAuthoritySnapshot) {
  return {
    scope: snapshot.scope,
    snapshot: {
      authoritySnapshotId: snapshot.authoritySnapshotId,
      definitionSha256: snapshot.definitionSha256,
    },
    decisionId: snapshot.decisionId,
    input: snapshot.input,
  };
}
function rehash(snapshot: ReleaseDecisionCurrentAuthoritySnapshot) {
  const { schemaVersion: _v, definitionSha256: _sha, ...definition } = snapshot;
  snapshot.definitionSha256 = createHash("sha256")
    .update(
      encodeReleaseDecisionCurrentAuthoritySnapshotDefinition({
        scope: snapshot.scope,
        definition,
      }),
    )
    .digest("hex");
}
/** Rebuild every outer digest from malicious bytes; only canonical/domain validation can reject. */
function replaceBytes(bytes: Uint8Array) {
  const original = prepareReleaseDecisionCurrentAuthoritySnapshot(material());
  const snapshot = original.snapshot,
    scope = snapshot.scope;
  snapshot.materialSha256 = createHash("sha256").update(bytes).digest("hex");
  snapshot.materialByteLength = bytes.byteLength;
  const frames = Array.from(
    { length: Math.ceil(bytes.byteLength / RELEASE_DECISION_AUTHORITY_FRAME_BYTES) },
    (_, i) => ({
      frameIndex: i,
      dataBase64url: Buffer.from(
        bytes.subarray(
          i * RELEASE_DECISION_AUTHORITY_FRAME_BYTES,
          (i + 1) * RELEASE_DECISION_AUTHORITY_FRAME_BYTES,
        ),
      ).toString("base64url"),
    }),
  );
  snapshot.frameCount = frames.length;
  const pages: ReleaseDecisionCurrentAuthorityPage[] = [];
  for (let first = 0; first < frames.length; first += RELEASE_DECISION_AUTHORITY_PAGE_SIZE) {
    const definition = {
      authoritySnapshotId: snapshot.authoritySnapshotId,
      decisionId: snapshot.decisionId,
      input: snapshot.input,
      materialSha256: snapshot.materialSha256,
      materialByteLength: bytes.byteLength,
      frameCount: frames.length,
      pageIndex: pages.length,
      frames: frames.slice(first, first + RELEASE_DECISION_AUTHORITY_PAGE_SIZE),
    };
    pages.push({
      ...definition,
      scope,
      schemaVersion: "0.2" as const,
      definitionSha256: createHash("sha256")
        .update(encodeReleaseDecisionCurrentAuthorityPageDefinition({ scope, definition }))
        .digest("hex"),
    });
  }
  snapshot.pages = pages.map((page) => ({
    pageIndex: page.pageIndex,
    definitionSha256: page.definitionSha256,
    firstFrameIndex: page.pageIndex * RELEASE_DECISION_AUTHORITY_PAGE_SIZE,
    frameCount: page.frames.length,
  }));
  rehash(snapshot);
  return { snapshot, pages };
}
describe("complete captured 0.2 transport, not actual authentication or publication", () => {
  it("round-trips a newly completed C3 model with full original graph/pages and explicit unavailable current authority", async () => {
    const value = await observedOriginalMaterial();
    const original = value.originals[0];
    if (original?.state !== "observed") throw new Error("Missing observed original model");
    expect(original.actors.sourceState).toBe("unavailable");
    expect(value.base.selections.state).toBe("unavailable");
    const prepared = prepareReleaseDecisionCurrentAuthoritySnapshot(value);
    expect(
      decodeReleaseDecisionCurrentAuthoritySnapshot({
        expected: owner(prepared.snapshot),
        ...prepared,
      }),
    ).toEqual(value);
  });
  it("rejects substituted actor witnesses after original record shapes are admitted", async () => {
    const value = await observedOriginalMaterial();
    const original = value.originals[0];
    if (original?.state !== "observed") throw new Error("Missing observed original model");
    const source = original.actors.sources.find(
      (row) => row.state === "unavailable" && row.witness.storage !== null,
    );
    if (!source?.witness.storage) throw new Error("Missing non-root owning witness");
    source.witness.storage.recordSha256 = "0".repeat(64);
    if (source.witness.entry.observation.status === "verified")
      source.witness.entry.observation.recordSha256 = "0".repeat(64);
    expect(ReleaseDecisionCurrentAuthorityMaterialSchema.safeParse(value).success).toBe(true);
    expect(() => prepareReleaseDecisionCurrentAuthoritySnapshot(value)).toThrow(
      ReleaseDecisionAuthorityIntegrityError,
    );
  });
  it("recomputes original rule evidence even when the forged result and owning result references are consistently rehashed", async () => {
    const value = await observedOriginalMaterial();
    const prior = value.base.policies[0]?.original;
    const original = value.originals[0];
    if (prior?.state !== "complete" || original?.state !== "observed" || !original.graph.job.result)
      throw new Error("Missing original model result");
    const rule = prior.evaluation.rules.find(
      ({ evidence, predicateKind }) =>
        evidence.kind === "not_evaluated" && predicateKind !== "approval_required",
    );
    if (rule?.evidence.kind !== "not_evaluated")
      throw new Error("Missing unavailable original rule");
    rule.evidence.reason = "source_unavailable";
    const {
      schemaVersion: _v,
      scope,
      definitionSha256: _sha,
      recordedAt: _at,
      recordedByPrincipalId: _by,
      jobId: _job,
      attemptId: _attempt,
      workerId: _worker,
      leaseId: _lease,
      fencingToken: _fence,
      recoveryEpoch: _epoch,
      ...definition
    } = prior.evaluation;
    const sha = digestPolicyEvaluationDefinition(scope, definition);
    prior.evaluation.definitionSha256 = sha;
    if (!prior.job.result) throw new Error("Missing prior owning result");
    prior.job.result.definitionSha256 = sha;
    original.graph.job.result.definitionSha256 = sha;
    original.actors.original.evaluation.definitionSha256 = sha;
    expect(ReleaseDecisionCurrentAuthorityMaterialSchema.safeParse(value).success).toBe(true);
    expect(() => prepareReleaseDecisionCurrentAuthoritySnapshot(value)).toThrow(
      ReleaseDecisionAuthorityIntegrityError,
    );
  });
  it("binds exact canonical logical-root projections while preserving changed selection as captured data", () => {
    const value = material();
    const oldBytes = encodeEvaluationCanonicalJson(value.selectionRoot).byteLength;
    const record = {
      ...value.selectionRoot.reference,
      scope: value.base.scope,
      selectionId: "selection_changed",
    };
    value.selectionRoot = {
      state: "observed",
      reference: value.selectionRoot.reference,
      record,
      recordSha256: createHash("sha256")
        .update(encodeEvaluationCanonicalJson(record))
        .digest("hex"),
    };
    value.base.usage.recordBytes +=
      encodeEvaluationCanonicalJson(value.selectionRoot).byteLength - oldBytes;
    const prepared = prepareReleaseDecisionCurrentAuthoritySnapshot(value);
    expect(
      decodeReleaseDecisionCurrentAuthoritySnapshot({
        expected: owner(prepared.snapshot),
        ...prepared,
      }),
    ).toEqual(value);
    value.selectionRoot.record.selectionId = "selection_mutated";
    expect(() => prepareReleaseDecisionCurrentAuthoritySnapshot(value)).toThrow(
      "binding projection",
    );
  });
  it("separately retains known reviewer catalog/root state and missing actual credentials", () => {
    const value = material(1),
      census = value.reviewerCensuses[0];
    if (!census) throw new Error("Missing synthetic reviewer root");
    const oldBytes =
      encodeEvaluationCanonicalJson(census.binding).byteLength +
      encodeEvaluationCanonicalJson({ reference: census.reference, state: census.state })
        .byteLength;
    const record = {
      ...census.binding.reference,
      scope: value.base.scope,
      authorityId: census.reference.authorityId,
    };
    census.state = "complete";
    census.binding = {
      state: "observed",
      reference: census.binding.reference,
      record,
      recordSha256: createHash("sha256")
        .update(encodeEvaluationCanonicalJson(record))
        .digest("hex"),
    };
    value.base.usage.recordBytes +=
      encodeEvaluationCanonicalJson(census.binding).byteLength +
      encodeEvaluationCanonicalJson({ reference: census.reference, state: census.state })
        .byteLength -
      oldBytes;
    const prepared = prepareReleaseDecisionCurrentAuthoritySnapshot(value);
    expect(prepared.snapshot.hasUnavailableReviewerAuthority).toBe(false);
    expect(value.credentials.every((row) => row.state === "missing")).toBe(true);
    expect(
      decodeReleaseDecisionCurrentAuthoritySnapshot({
        expected: owner(prepared.snapshot),
        ...prepared,
      }),
    ).toEqual(value);
  });
  it.each(["authority", "approval"])(
    "recomputes a retained %s definition rather than trusting its old digest",
    (kind) => {
      const value = material(3);
      if (kind === "authority") {
        const source = value.base.authorities.records[0];
        if (source?.state !== "observed") throw new Error("Missing synthetic observed authority");
        source.record.rationale = "Changed declaration without an original definition hash";
      } else {
        const approval = value.base.approvals.records[0];
        if (!approval) throw new Error("Missing synthetic approval");
        approval.rationale = "Changed original approval receipt body";
      }
      expect(() => prepareReleaseDecisionCurrentAuthoritySnapshot(value)).toThrow(
        ReleaseDecisionAuthorityIntegrityError,
      );
    },
  );
  it("retains every competing synthetic authority version across multiple UTF-8 pages", () => {
    const value = material(1),
      source = value.base.authorities.records[0];
    if (source?.state !== "observed") throw new Error("Missing synthetic authority");
    value.base.authorities.records = Array.from({ length: 200 }, (_, index) => {
      const record = structuredClone(source.record);
      record.authorityVersionId = `authority_transport_${String(index).padStart(4, "0")}`;
      record.rationale = "한글😀".repeat(64);
      const {
        schemaVersion: _v,
        definitionSha256: _sha,
        publishedAt: _at,
        publishedByPrincipalId: _by,
        ...definition
      } = record;
      record.definitionSha256 = digestReleaseReviewerAuthorityDefinition(
        value.base.scope,
        definition,
      );
      return {
        state: "observed" as const,
        reference: releaseReviewerAuthorityReference(record),
        record,
      };
    });
    // Synthetic transport admission, not measured owning-source usage or current reviewer eligibility.
    value.base.usage.records = value.base.input.verificationLimits.maxAcquisitionRecords;
    value.base.usage.recordBytes = value.base.input.verificationLimits.maxAcquisitionRecordBytes;
    const prepared = prepareReleaseDecisionCurrentAuthoritySnapshot(value);
    expect(prepared.pages.length).toBeGreaterThan(1);
    expect(prepared.snapshot.hasUnavailableReviewerAuthority).toBe(true);
    expect(
      decodeReleaseDecisionCurrentAuthoritySnapshot({
        expected: owner(prepared.snapshot),
        ...prepared,
      }),
    ).toEqual(value);
    const reversed = [...prepared.pages].reverse();
    expect(() =>
      decodeReleaseDecisionCurrentAuthoritySnapshot({
        expected: owner(prepared.snapshot),
        snapshot: prepared.snapshot,
        pages: reversed,
      }),
    ).toThrow(ReleaseDecisionAuthorityIntegrityError);
  });
  for (const [index, vector] of vectors.vectors.entries())
    it(vector.name, () => {
      const value = material(index),
        before = structuredClone(value);
      const prepared = prepareReleaseDecisionCurrentAuthoritySnapshot(value);
      expect(prepared.snapshot).toMatchObject({
        schemaVersion: "0.2",
        definitionSha256: vector.expected.headerSha256,
        materialSha256: vector.expected.materialSha256,
        materialByteLength: vector.expected.materialByteLength,
        frameCount: vector.expected.frameCount,
        reviewAuthorityAssurances: vector.expected.reviewAuthorityAssurances,
        hasUnavailableReviewerAuthority: vector.expected.hasUnavailableReviewerAuthority,
      });
      expect(prepared.pages.map((page) => page.definitionSha256)).toEqual(
        vector.expected.pageSha256,
      );
      expect(
        decodeReleaseDecisionCurrentAuthoritySnapshot({
          expected: owner(prepared.snapshot),
          ...prepared,
        }),
      ).toEqual(value);
      expect(value).toEqual(before);
      expect(() =>
        decodeReleaseDecisionAuthoritySnapshot({ expected: owner(prepared.snapshot), ...prepared }),
      ).toThrow(ReleaseDecisionAuthorityIntegrityError);
    });
  it("rejects an input digest whose outer current-cut hashes could otherwise be recalculated", () => {
    const value = material();
    value.base.input.definitionSha256 = "0".repeat(64);
    expect(() => prepareReleaseDecisionCurrentAuthoritySnapshot(value)).toThrow("input digest");
  });
  it("retains unavailable logical reviewer bindings even when every authority record was observed", () => {
    const prepared = prepareReleaseDecisionCurrentAuthoritySnapshot(material(1));
    expect(prepared.snapshot.hasUnavailableReviewerAuthority).toBe(true);
    prepared.snapshot.hasUnavailableReviewerAuthority = false;
    rehash(prepared.snapshot);
    expect(() =>
      decodeReleaseDecisionCurrentAuthoritySnapshot({
        expected: owner(prepared.snapshot),
        ...prepared,
      }),
    ).toThrow("assurance");
  });
  it.each(["scope", "input", "decision", "snapshot"])(
    "rejects another expected %s owner",
    (kind) => {
      const prepared = prepareReleaseDecisionCurrentAuthoritySnapshot(material()),
        expected = owner(prepared.snapshot);
      if (kind === "scope") expected.scope = { ...expected.scope, environmentId: "env_other" };
      if (kind === "input")
        expected.input = { ...expected.input, definitionSha256: "0".repeat(64) };
      if (kind === "decision") expected.decisionId = "decision_other";
      if (kind === "snapshot")
        expected.snapshot = { ...expected.snapshot, definitionSha256: "0".repeat(64) };
      expect(() =>
        decodeReleaseDecisionCurrentAuthoritySnapshot({ expected, ...prepared }),
      ).toThrow("owner");
    },
  );
  it.each(["version", "domain", "encoding", "extra", "whitespace", "utf8"])(
    "rejects coherently rehashed %s bytes",
    (kind) => {
      const original = prepareReleaseDecisionCurrentAuthoritySnapshot(material());
      const wire = Buffer.concat(
        original.pages.flatMap((page) =>
          page.frames.map((frame) => Buffer.from(frame.dataBase64url, "base64url")),
        ),
      );
      const envelope = JSON.parse(wire.toString("utf8"));
      if (kind === "version") envelope.schemaVersion = "0.1";
      if (kind === "domain")
        envelope.definitionDomain = "proofstack.release-decision-authority-material.v1";
      if (kind === "encoding")
        envelope.encodingVersion = "proofstack.release-decision-authority-material-jcs.v1";
      if (kind === "extra") envelope.privateProof = "forbidden";
      let bytes = Buffer.from(JSON.stringify(envelope));
      if (kind === "whitespace") bytes = Buffer.concat([Buffer.from(" "), wire]);
      if (kind === "utf8") bytes = Buffer.from([0xff]);
      const prepared = replaceBytes(bytes);
      expect(() =>
        decodeReleaseDecisionCurrentAuthoritySnapshot({
          expected: owner(prepared.snapshot),
          ...prepared,
        }),
      ).toThrow(ReleaseDecisionAuthorityIntegrityError);
    },
  );
  it("requires every original page and rejects a substituted page version", () => {
    const prepared = prepareReleaseDecisionCurrentAuthoritySnapshot(material());
    expect(() =>
      decodeReleaseDecisionCurrentAuthoritySnapshot({
        expected: owner(prepared.snapshot),
        snapshot: prepared.snapshot,
        pages: [],
      }),
    ).toThrow("pages");
    const pages = structuredClone(prepared.pages);
    if (!pages[0]) throw new Error("Missing vector page");
    Reflect.set(pages[0], "schemaVersion", "0.1");
    expect(() =>
      decodeReleaseDecisionCurrentAuthoritySnapshot({
        expected: owner(prepared.snapshot),
        snapshot: prepared.snapshot,
        pages,
      }),
    ).toThrow(ReleaseDecisionAuthorityIntegrityError);
  });
});
