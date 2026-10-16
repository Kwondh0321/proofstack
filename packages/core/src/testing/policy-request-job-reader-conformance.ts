import {
  serializeEvaluationCanonicalJson,
  type EvidenceScope,
  type PolicyEvaluationRequest,
  type PolicyEvaluationRequestReference,
} from "@proofstack/contracts";
import {
  PolicyEvaluationRequestConflictError,
  type PolicyEvaluationJobControlRepository,
  type PolicyEvaluationRequestJobReader,
} from "../policy/policy-evaluation-job-repository.js";
import { policyJobConformanceRequest } from "./policy-evaluation-job-repository-conformance.js";

interface Harness {
  readonly control: Pick<
    PolicyEvaluationJobControlRepository,
    "createJob" | "cancelJob" | "findHistoryHead"
  >;
  readonly reader: PolicyEvaluationRequestJobReader;
}
function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function same(a: unknown, b: unknown) {
  return serializeEvaluationCanonicalJson(a) === serializeEvaluationCanonicalJson(b);
}
function reference(request: PolicyEvaluationRequest): PolicyEvaluationRequestReference {
  return {
    evaluationRequestId: request.evaluationRequestId,
    definitionSha256: request.definitionSha256,
  };
}
export function createPolicyRequestJobReaderConformanceCases(
  fixture: (scope?: EvidenceScope) => PolicyEvaluationRequest = policyJobConformanceRequest,
): readonly { readonly name: string; readonly run: (harness: Harness) => Promise<void> }[] {
  return [
    {
      name: "missing original request is absent without fabricating a job",
      async run({ reader }) {
        const request = fixture();
        check(
          (await reader.findJobForRequest(request.scope, reference(request))) === null,
          "Missing original request acquired a job",
        );
      },
    },
    {
      name: "exact original request returns its owning graph without appending history",
      async run({ control, reader }) {
        const request = fixture();
        const first = await control.createJob({ request, jobId: "job_request_owner" });
        const before = await control.findHistoryHead(request.scope, first.snapshot.job.jobId);
        check(
          same(await reader.findJobForRequest(request.scope, reference(request)), first.snapshot),
          "Original request did not recover its exact owning graph",
        );
        check(
          same(await control.findHistoryHead(request.scope, first.snapshot.job.jobId), before),
          "Original request read appended history",
        );
      },
    },
    {
      name: "idempotent enqueue with another proposed job retains the first owning receipt",
      async run({ control, reader }) {
        const request = fixture();
        const first = await control.createJob({ request, jobId: "job_request_owner" });
        const retry = await control.createJob({ request, jobId: "job_favorable_other" });
        check(
          !retry.created && same(retry.snapshot, first.snapshot),
          "Enqueue changed original job ownership",
        );
        check(
          same(await reader.findJobForRequest(request.scope, reference(request)), first.snapshot),
          "Reader selected a later proposed job",
        );
      },
    },
    {
      name: "existing request identity with a different digest is conflict rather than a latest lookup",
      async run({ control, reader }) {
        const request = fixture();
        const first = await control.createJob({ request, jobId: "job_request_owner" });
        let failure: unknown;
        try {
          await reader.findJobForRequest(request.scope, {
            ...reference(request),
            definitionSha256:
              request.definitionSha256 === "0".repeat(64) ? "1".repeat(64) : "0".repeat(64),
          });
        } catch (error) {
          failure = error;
        }
        check(
          failure instanceof PolicyEvaluationRequestConflictError,
          "Wrong request digest was not a conflict",
        );
        check(
          same(await reader.findJobForRequest(request.scope, reference(request)), first.snapshot),
          "Conflicting read altered the original graph",
        );
      },
    },
    {
      name: "original lookup retains a cancelled owning job rather than hiding terminal state",
      async run({ control, reader }) {
        const request = fixture();
        const first = await control.createJob({ request, jobId: "job_request_owner" });
        const cancelled = await control.cancelJob({
          scope: request.scope,
          jobId: first.snapshot.job.jobId,
          cancellationId: "cancel_request_owner",
          principalId: "principal_operator",
          reason: "operator_requested",
        });
        check(
          same(await reader.findJobForRequest(request.scope, reference(request)), cancelled),
          "Original lookup hid or replaced the cancelled job",
        );
      },
    },
    {
      name: "three tenants retain colliding request and job IDs and reject wrong project or environment",
      async run({ control, reader }) {
        const base = fixture();
        const requests = [
          base,
          ...["b", "c"].map((suffix) =>
            fixture({ ...base.scope, tenantId: "ten_request_owner_" + suffix }),
          ),
        ];
        const originals = [];
        for (const request of requests)
          originals.push(await control.createJob({ request, jobId: "job_request_owner" }));
        for (let index = 0; index < requests.length; index++) {
          const request = requests[index];
          const original = originals[index];
          check(request && original, "Missing colliding tenant fixture");
          check(
            same(
              await reader.findJobForRequest(request.scope, reference(request)),
              original.snapshot,
            ),
            "Original request crossed a tenant boundary",
          );
        }
        for (const key of ["tenantId", "projectId", "environmentId"] as const)
          check(
            (await reader.findJobForRequest(
              { ...base.scope, [key]: "scope_other" },
              reference(base),
            )) === null,
            "Original request crossed an exact scope component",
          );
      },
    },
    {
      name: "materialized original graph cannot mutate the retained owner",
      async run({ control, reader }) {
        const request = fixture();
        const first = await control.createJob({ request, jobId: "job_request_owner" });
        const observed = await reader.findJobForRequest(request.scope, reference(request));
        check(observed, "Missing original owner");
        observed.job.jobId = "job_substituted";
        observed.request.createdByPrincipalId = "principal_substituted";
        check(
          same(await reader.findJobForRequest(request.scope, reference(request)), first.snapshot),
          "Materialized graph rewrote retained ownership",
        );
      },
    },
  ];
}
