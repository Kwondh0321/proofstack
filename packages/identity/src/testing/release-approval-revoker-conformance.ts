import assert from "node:assert/strict";
import type {
  Capability,
  ReleaseApproval,
  ReleaseApprovalPublicationMaterial,
  ReleaseApprovalRevocationIntent,
  ReleaseApprovalRevocation,
} from "@proofstack/contracts";
import type { ReleaseBrowserMutationCredentials } from "../release-mutation-authentication.js";
import type { ReleaseApprovalRevoker } from "../release-approval-revoker.js";

export interface ReleaseApprovalRevokerConformanceHarness {
  readonly service: ReleaseApprovalRevoker;
  readonly credentials: ReleaseBrowserMutationCredentials;
  readonly original: ReleaseApproval;
  readonly intent: ReleaseApprovalRevocationIntent;
  login(requestId: string): Promise<ReleaseBrowserMutationCredentials>;
  changeCapabilities(capabilities: readonly Capability[]): Promise<void>;
  readRevocation(id: string): Promise<ReleaseApprovalRevocation | null>;
  readPublication(id: string): Promise<ReleaseApprovalPublicationMaterial | null>;
}
export type ReleaseApprovalRevokerConformanceFactory = (
  namespace: string,
) => Promise<ReleaseApprovalRevokerConformanceHarness>;
export const releaseApprovalRevokerConformanceCases: readonly {
  name: string;
  run(factory: ReleaseApprovalRevokerConformanceFactory): Promise<void>;
}[] = [
  {
    name: "binds actual current authentication and atomically retains source and safe original provenance",
    async run(factory) {
      const f = await factory("revoker_original"),
        result = await f.service.revokeApproval(f.credentials, f.intent);
      assert.equal(result.created, true);
      assert.equal(result.record.reviewer.principalId, f.original.reviewer.principalId);
      assert.equal(result.record.reviewer.requestId, f.credentials.requestId);
      assert.equal(result.record.reviewer.principalType, "user");
      assert.deepEqual(result.record.approval, f.intent.approval);
      assert.deepEqual(await f.readRevocation(f.intent.eventId), result.record);
      const material = await f.readPublication(f.intent.eventId);
      assert.deepEqual(material?.source.record, result.record);
      assert.deepEqual(material?.publication, result.publication);
      assert.equal(result.publication.issuedAt, result.record.occurredAt);
      assert.ok(result.usage.records > 0);
      assert.ok(result.usage.approvalRecords > 0);
      for (const key of ["sessionToken", "csrfToken", "sessionDigest", "csrfDigest"])
        assert.ok(!JSON.stringify(material).includes(`\"${key}\"`));
    },
  },
  {
    name: "equal retries and a new current login preserve the exact first actor, cut, source and profile",
    async run(factory) {
      const f = await factory("revoker_retry"),
        first = await f.service.revokeApproval(f.credentials, f.intent);
      const credentials = await f.login("request_second_revocation_login");
      const retry = await f.service.revokeApproval(credentials, f.intent);
      assert.equal(retry.created, false);
      assert.deepEqual(retry.record, first.record);
      assert.deepEqual(retry.publication, first.publication);
      retry.record.reason = "Mutated response";
      assert.deepEqual(await f.readRevocation(f.intent.eventId), first.record);
    },
  },
  {
    name: "authenticates and authorizes before interpreting or looking up the mutation body",
    async run(factory) {
      const f = await factory("revoker_authorization");
      let touched = 0;
      const body = Object.defineProperty({}, "eventId", {
        enumerable: true,
        get() {
          touched++;
          throw new Error("Unauthorized body lookup");
        },
      });
      for (const credentials of [
        { ...f.credentials, sessionToken: "invalid_cookie" },
        { ...f.credentials, csrfToken: "invalid_csrf" },
        { ...f.credentials, scope: { ...f.credentials.scope, tenantId: "other_tenant" } },
      ])
        await assert.rejects(f.service.revokeApproval(credentials, body));
      await f.changeCapabilities(["approval:authority:manage"]);
      await assert.rejects(f.service.revokeApproval(f.credentials, body));
      assert.equal(touched, 0);
      await f.changeCapabilities(["approval:decide"]);
      await assert.rejects(f.service.revokeApproval(f.credentials, body));
      assert.equal(touched, 1);
      assert.equal(await f.readRevocation(f.intent.eventId), null);
    },
  },
  {
    name: "rejects changed intents and a second revocation ID without replacing the first original",
    async run(factory) {
      const f = await factory("revoker_conflict"),
        first = await f.service.revokeApproval(f.credentials, f.intent);
      for (const patch of [
        { reason: "A changed revocation rationale" },
        { eventId: "event_another_revocation" },
        { approval: { ...f.intent.approval, definitionSha256: "e".repeat(64) } },
      ])
        await assert.rejects(f.service.revokeApproval(f.credentials, { ...f.intent, ...patch }));
      assert.deepEqual(await f.readRevocation(f.intent.eventId), first.record);
      assert.equal(await f.readRevocation("event_another_revocation"), null);
    },
  },
  {
    name: "new actions and equal retries require current approval power",
    async run(factory) {
      const f = await factory("revoker_current_power");
      await f.changeCapabilities([]);
      await assert.rejects(f.service.revokeApproval(f.credentials, f.intent));
      assert.equal(await f.readRevocation(f.intent.eventId), null);
      await f.changeCapabilities(["approval:decide"]);
      const first = await f.service.revokeApproval(f.credentials, f.intent);
      await f.changeCapabilities([]);
      await assert.rejects(f.service.revokeApproval(f.credentials, f.intent));
      assert.deepEqual(await f.readRevocation(f.intent.eventId), first.record);
    },
  },
  ...["scope", "reviewer", "occurredAt", "schemaVersion", "authority", "recordSha256"].map(
    (key) => ({
      name: `rejects caller-owned ${key} smuggling before any publication`,
      async run(factory: ReleaseApprovalRevokerConformanceFactory) {
        const f = await factory(`revoker_injected_${key}`);
        await assert.rejects(
          f.service.revokeApproval(f.credentials, { ...f.intent, [key]: "caller_value" }),
        );
        assert.equal(await f.readRevocation(f.intent.eventId), null);
        assert.equal(await f.readPublication(f.intent.eventId), null);
      },
    }),
  ),
];
