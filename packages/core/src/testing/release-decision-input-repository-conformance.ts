import assert from "node:assert/strict";
import { encodeReleasePolicySelectionDefinition } from "@proofstack/contracts";
import { createHash } from "node:crypto";
import {
  ReleaseDecisionInputRepositoryError,
  type ReleaseDecisionInputRepository,
  type ReleaseDecisionInputGraph,
} from "../release/release-decision-input-repository.js";
import { validateReleaseDecisionInputGraph } from "../release/release-decision-input-graph-validation.js";
import {
  ReleaseDecisionVerificationBudget,
  ReleaseDecisionVerificationBudgetError,
} from "../release/release-decision-verification-budget.js";
import {
  decisionInputVersion,
  releaseDecisionInputRepositoryFixture,
} from "./release-decision-input-repository-fixtures.js";

export interface ReleaseDecisionInputRepositoryTestHarness {
  readonly repository: ReleaseDecisionInputRepository;
  readonly graph: ReleaseDecisionInputGraph;
  readonly dispose?: () => Promise<void>;
}
export type ReleaseDecisionInputRepositoryTestFactory = (
  namespace: string,
) => ReleaseDecisionInputRepositoryTestHarness | Promise<ReleaseDecisionInputRepositoryTestHarness>;
type Case = {
  readonly name: string;
  readonly run: (factory: ReleaseDecisionInputRepositoryTestFactory) => Promise<void>;
};
const limits = {
  maxAcquisitionRecords: 100000,
  maxAcquisitionRecordBytes: 64 * 1024 * 1024,
  maxApprovalRecords: 0,
};
const meter = () => new ReleaseDecisionVerificationBudget(limits);
const reason = (expected: ReleaseDecisionInputRepositoryError["reason"]) => (error: unknown) =>
  error instanceof ReleaseDecisionInputRepositoryError && error.reason === expected;
function test(
  name: string,
  namespace: string,
  run: (h: ReleaseDecisionInputRepositoryTestHarness) => Promise<void>,
): Case {
  return {
    name,
    async run(factory) {
      const h = await factory(namespace);
      try {
        await run(h);
      } finally {
        await h.dispose?.();
      }
    },
  };
}
function replan(g: ReleaseDecisionInputGraph, id: string) {
  return { ...g, request: decisionInputVersion(g.request, { decisionInputRequestId: id }) };
}
export const releaseDecisionInputRepositoryConformanceCases: readonly Case[] = [
  test(
    "retains an explicit empty observation inventory without inventing planned jobs",
    "empty",
    async (h) => {
      const changed: ReleaseDecisionInputGraph = {
        ...h.graph,
        policies: [],
        selection: { ...h.graph.selection, mode: "observation_only", policies: [] },
        request: decisionInputVersion(h.graph.request, {
          mode: "observation_only",
          evaluations: [],
        }),
      };
      const graph = await alternateGraph(changed, h.graph.request.decisionInputRequestId);
      assert.deepEqual(await h.repository.publishReleaseDecisionInput(graph), {
        created: true,
        graph,
      });
      assert.deepEqual(
        await h.repository.findReleaseDecisionInput(
          graph.request.scope,
          graph.request.decisionInputRequestId,
        ),
        graph,
      );
    },
  ),
  test(
    "does not equate human and service publisher receipts for the same principal ID",
    "principal_type",
    async (h) => {
      await h.repository.publishReleaseDecisionInput(h.graph);
      const changed = {
        ...h.graph,
        request: decisionInputVersion(h.graph.request, {
          publisher: {
            ...h.graph.request.publisher,
            principalType: "user",
            authenticationMethod: "oidc",
          },
        }),
      };
      await assert.rejects(
        h.repository.publishReleaseDecisionInput(changed),
        reason("input_conflict"),
      );
    },
  ),
  test("charges exact input absence without inventing a plan", "missing", async (h) => {
    const budget = meter();
    assert.equal(
      await h.repository.findReleaseDecisionInput(
        h.graph.request.scope,
        h.graph.request.decisionInputRequestId,
        budget,
      ),
      null,
    );
    assert.equal(budget.snapshot().records, 1);
  }),
  test(
    "persists every original source and ordered mandatory/advisory plan",
    "original",
    async (h) => {
      assert.deepEqual(await h.repository.publishReleaseDecisionInput(h.graph), {
        created: true,
        graph: h.graph,
      });
      const found = await h.repository.findReleaseDecisionInput(
        h.graph.request.scope,
        h.graph.request.decisionInputRequestId,
      );
      assert.deepEqual(found, h.graph);
      assert.deepEqual(
        found?.request.evaluations.map((p) => p.mode),
        ["mandatory", "advisory"],
      );
    },
  ),
  test(
    "retains the first complete graph across new login, native cut, limits and replanning",
    "retry",
    async (h) => {
      await h.repository.publishReleaseDecisionInput(h.graph);
      const original = h.graph.request;
      const retried = {
        ...h.graph,
        request: decisionInputVersion(original, {
          createdAt: "2026-10-15T12:15:00.000002Z",
          expiresAt: "2026-10-15T12:25:00.000002Z",
          publisher: {
            ...original.publisher,
            credentialId: "credential_new_login",
            requestId: "request-new-login",
            authenticatedAt: "2026-10-15T12:15:00.000Z",
          },
          verificationLimits: { ...original.verificationLimits, maxAcquisitionRecords: 2000 },
          evaluations: original.evaluations.map((p, index) => ({
            ...p,
            request: { ...p.request, evaluationRequestId: `replanned_retry_${index}` },
          })),
        }),
      };
      validateReleaseDecisionInputGraph(retried);
      assert.notEqual(retried.request.definitionSha256, original.definitionSha256);
      assert.deepEqual(await h.repository.publishReleaseDecisionInput(retried), {
        created: false,
        graph: h.graph,
      });
      assert.deepEqual(
        await h.repository.findReleaseDecisionInput(
          original.scope,
          original.decisionInputRequestId,
        ),
        h.graph,
      );
    },
  ),
  ...(["publisher", "rationale", "candidate", "selection", "scope"] as const).map((kind) =>
    test(`rejects changed original ${kind} intent wholly`, `conflict_${kind}`, async (h) => {
      await h.repository.publishReleaseDecisionInput(h.graph);
      let other: ReleaseDecisionInputGraph;
      if (kind === "rationale")
        other = {
          ...h.graph,
          request: decisionInputVersion(h.graph.request, {
            rationale: "A different original user intent.",
          }),
        };
      else if (kind === "publisher") {
        // A different valid independent service principal is installed by the original fixture's
        // immutable selection witness below, then the complete alternate graph is re-encoded.
        const next = structuredClone(h.graph);
        next.request.publisher.principalId = "principal_other_publisher";
        next.selection.authorizedPublisherPrincipalIds = [next.request.publisher.principalId];
        other = await alternateGraph(next, h.graph.request.decisionInputRequestId);
      } else {
        const source = h.graph;
        const namespace = `alternate_${kind}`;
        const nextScope =
          kind === "scope"
            ? { ...source.request.scope, projectId: "project_other" }
            : source.request.scope;
        other = releaseDecisionInputRepositoryFixture(namespace, nextScope);
        other = replan(other, source.request.decisionInputRequestId);
      }
      await assert.rejects(
        h.repository.publishReleaseDecisionInput(other),
        reason("input_conflict"),
      );
      assert.deepEqual(
        await h.repository.findReleaseDecisionInput(
          h.graph.request.scope,
          h.graph.request.decisionInputRequestId,
        ),
        h.graph,
      );
    }),
  ),
  test(
    "rejects another input claiming an original planned request ID without partial publication",
    "plan_conflict",
    async (h) => {
      await h.repository.publishReleaseDecisionInput(h.graph);
      const next = replan(h.graph, "input_other_owner");
      await assert.rejects(
        h.repository.publishReleaseDecisionInput(next),
        reason("planned_request_conflict"),
      );
      assert.equal(
        await h.repository.findReleaseDecisionInput(
          next.request.scope,
          next.request.decisionInputRequestId,
        ),
        null,
      );
    },
  ),
  test("does not capture newly derived plan IDs from an equal retry", "retry_plans", async (h) => {
    await h.repository.publishReleaseDecisionInput(h.graph);
    const derived = {
      ...h.graph,
      request: decisionInputVersion(h.graph.request, {
        evaluations: h.graph.request.evaluations.map((p, i) => ({
          ...p,
          request: { ...p.request, evaluationRequestId: `unused_retry_plan_${i}` },
        })),
      }),
    };
    assert.equal((await h.repository.publishReleaseDecisionInput(derived)).created, false);
    const independent = replan(derived, "input_unused_plan_owner");
    assert.equal((await h.repository.publishReleaseDecisionInput(independent)).created, true);
  }),
  test(
    "commits one concurrent identical original and preserves all first receipts",
    "concurrent",
    async (h) => {
      const results = await Promise.all([
        h.repository.publishReleaseDecisionInput(h.graph),
        h.repository.publishReleaseDecisionInput(structuredClone(h.graph)),
      ]);
      assert.deepEqual(results.map((x) => x.created).sort(), [false, true]);
      for (const result of results) assert.deepEqual(result.graph, h.graph);
    },
  ),
  test("isolates returned and proposed copies from stored state", "copies", async (h) => {
    const proposed = structuredClone(h.graph),
      result = await h.repository.publishReleaseDecisionInput(proposed);
    proposed.request.rationale = "Mutated proposed object.";
    result.graph.request.rationale = "Mutated returned object.";
    const read = await h.repository.findReleaseDecisionInput(
      h.graph.request.scope,
      h.graph.request.decisionInputRequestId,
    );
    assert.deepEqual(read, h.graph);
    if (!read) throw new Error("Missing original graph");
    read.policies[0]?.rules.splice(0);
    assert.deepEqual(
      await h.repository.findReleaseDecisionInput(
        h.graph.request.scope,
        h.graph.request.decisionInputRequestId,
      ),
      h.graph,
    );
  }),
  ...(["tenantId", "projectId", "environmentId"] as const).map((field) =>
    test(
      `hides original input outside exact ${field}`,
      `scope_${field.toLowerCase()}`,
      async (h) => {
        await h.repository.publishReleaseDecisionInput(h.graph);
        const scope = { ...h.graph.request.scope, [field]: "scope_foreign" };
        assert.equal(
          await h.repository.findReleaseDecisionInput(
            scope,
            h.graph.request.decisionInputRequestId,
          ),
          null,
        );
      },
    ),
  ),
  test(
    "isolates colliding input/plan/source IDs across three tenants and rechecks all originals",
    "three_tenants",
    async (h) => {
      const namespace = `coll_${createHash("sha256").update(h.graph.request.decisionInputRequestId).digest("hex").slice(0, 8)}`;
      const graphs = ["a", "b", "c"].map((suffix) =>
        releaseDecisionInputRepositoryFixture(namespace, {
          ...h.graph.request.scope,
          tenantId: `tenant_input_collision_${suffix}`,
        }),
      );
      for (const graph of graphs)
        assert.equal((await h.repository.publishReleaseDecisionInput(graph)).created, true);
      assert.equal(new Set(graphs.map((g) => g.request.decisionInputRequestId)).size, 1);
      for (const graph of graphs)
        assert.deepEqual(
          await h.repository.findReleaseDecisionInput(
            graph.request.scope,
            graph.request.decisionInputRequestId,
          ),
          graph,
        );
    },
  ),
  test(
    "rejects a damaged original graph without writing its input or plans",
    "damaged",
    async (h) => {
      const bad = structuredClone(h.graph);
      bad.request.definitionSha256 = "0".repeat(64);
      await assert.rejects(
        h.repository.publishReleaseDecisionInput(bad),
        reason("storage_invalid"),
      );
      assert.equal(
        await h.repository.findReleaseDecisionInput(
          h.graph.request.scope,
          h.graph.request.decisionInputRequestId,
        ),
        null,
      );
      assert.equal((await h.repository.publishReleaseDecisionInput(h.graph)).created, true);
    },
  ),
  test(
    "admits exact aggregate records/bytes and rejects one below without a partial graph",
    "budgets",
    async (h) => {
      await h.repository.publishReleaseDecisionInput(h.graph);
      const budget = meter();
      await h.repository.findReleaseDecisionInput(
        h.graph.request.scope,
        h.graph.request.decisionInputRequestId,
        budget,
      );
      const used = budget.snapshot();
      assert(used.records >= h.graph.request.evaluations.length + 3 + h.graph.policies.length);
      const exact = new ReleaseDecisionVerificationBudget({
        ...limits,
        maxAcquisitionRecords: used.records,
        maxAcquisitionRecordBytes: used.recordBytes,
      });
      assert.deepEqual(
        await h.repository.findReleaseDecisionInput(
          h.graph.request.scope,
          h.graph.request.decisionInputRequestId,
          exact,
        ),
        h.graph,
      );
      for (const patch of [
        { maxAcquisitionRecords: used.records - 1 },
        { maxAcquisitionRecordBytes: used.recordBytes - 1 },
      ]) {
        const below = new ReleaseDecisionVerificationBudget({ ...limits, ...patch });
        await assert.rejects(
          h.repository.findReleaseDecisionInput(
            h.graph.request.scope,
            h.graph.request.decisionInputRequestId,
            below,
          ),
          ReleaseDecisionVerificationBudgetError,
        );
        assert.throws(() => below.snapshot(), ReleaseDecisionVerificationBudgetError);
      }
    },
  ),
];

async function alternateGraph(input: ReleaseDecisionInputGraph, id: string) {
  const {
    schemaVersion: _v,
    definitionSha256: _sha,
    publishedAt: _at,
    publishedByPrincipalId: _by,
    ...definition
  } = input.selection;
  const selection = {
    ...input.selection,
    definitionSha256: createHash("sha256")
      .update(encodeReleasePolicySelectionDefinition({ scope: definition.scope, definition }))
      .digest("hex"),
  };
  const request = decisionInputVersion(input.request, {
    decisionInputRequestId: id,
    selection: { ...input.request.selection, definitionSha256: selection.definitionSha256 },
  });
  return { ...input, selection, request };
}
