import assert from "node:assert/strict";
import type {
  Capability,
  EvidenceScope,
  PublishReleasePolicySelectionRequest,
  ReleasePolicySelection,
  ReleaseSelectionPublicationMaterial,
} from "@proofstack/contracts";
import {
  releasePolicySelectionReference,
  ReleaseDecisionVerificationBudget,
  validateReleaseSelectionPublicationMaterial,
} from "@proofstack/core";
import type { ReleaseBrowserMutationCredentials } from "../release-mutation-authentication.js";
import type { ReleaseSelectionInstaller } from "../release-selection-installer.js";

export interface ReleaseSelectionInstallerConformanceHarness {
  readonly service: ReleaseSelectionInstaller;
  readonly scope: EvidenceScope;
  readonly credentials: ReleaseBrowserMutationCredentials;
  readonly intent: PublishReleasePolicySelectionRequest;
  readonly principalId: string;
  login(requestId: string): Promise<ReleaseBrowserMutationCredentials>;
  changeCapabilities(capabilities: readonly Capability[]): Promise<void>;
  readOriginal(versionId: string): Promise<ReleasePolicySelection | null>;
  readPublication(
    kind: ReleaseSelectionPublicationMaterial["source"]["kind"],
    id: string,
  ): Promise<ReleaseSelectionPublicationMaterial | null>;
}
export type ReleaseSelectionInstallerConformanceFactory = (
  namespace: string,
) => Promise<ReleaseSelectionInstallerConformanceHarness>;
interface Case {
  readonly name: string;
  readonly run: (factory: ReleaseSelectionInstallerConformanceFactory) => Promise<void>;
}
const meter = () =>
  new ReleaseDecisionVerificationBudget({
    maxAcquisitionRecords: 10000,
    maxAcquisitionRecordBytes: 16 * 1024 * 1024,
    maxApprovalRecords: 0,
  });
export const releaseSelectionInstallerConformanceCases: readonly Case[] = [
  {
    name: "keeps stored original and provenance independent from caller mutations of returned objects",
    async run(factory) {
      const f = await factory("shared_returned_copy");
      const first = await f.service.publishSelection(f.credentials, f.intent);
      const expected = structuredClone(first);
      (first.record as ReleasePolicySelection).rationale = "Caller changed their returned copy.";
      first.publication.actor.requestId = "request_changed_by_caller";
      const again = await f.service.publishSelection(f.credentials, f.intent);
      assert.deepEqual(again.record, expected.record);
      assert.deepEqual(again.publication, expected.publication);
      const material = await f.readPublication(
        "release_policy_selection",
        f.intent.selectionVersionId,
      );
      assert.deepEqual(
        validateReleaseSelectionPublicationMaterial(material, meter()).publication,
        expected.publication,
      );
    },
  },
  {
    name: "publishes actual user authentication bound to the complete original and safe preimages",
    async run(factory) {
      const f = await factory("shared_original");
      const result = await f.service.publishSelection(f.credentials, f.intent);
      assert.equal(result.created, true);
      assert.deepEqual(await f.readOriginal(f.intent.selectionVersionId), result.record);
      const material = await f.readPublication(
        "release_policy_selection",
        f.intent.selectionVersionId,
      );
      assert.deepEqual(
        validateReleaseSelectionPublicationMaterial(material, meter()).publication,
        result.publication,
      );
      assert.equal(result.publication.actor.principalId, f.principalId);
      assert.equal(result.publication.actor.authenticationMethod, "oidc");
      assert.equal(result.publication.actor.requestId, f.credentials.requestId);
      assert.equal(JSON.stringify(result).includes(f.credentials.sessionToken), false);
      assert.equal(JSON.stringify(result).includes(f.credentials.csrfToken), false);
      assert.ok(result.usage.records > 0);
    },
  },
  {
    name: "preserves the original actor, request, native cut and complete profile across another login",
    async run(factory) {
      const f = await factory("shared_login");
      const first = await f.service.publishSelection(f.credentials, f.intent);
      const credentials = await f.login("request_shared_second_login");
      assert.notEqual(credentials.sessionToken, f.credentials.sessionToken);
      const again = await f.service.publishSelection(credentials, f.intent);
      assert.equal(again.created, false);
      assert.deepEqual(again.record, first.record);
      assert.deepEqual(again.publication, first.publication);
    },
  },
  ...["cookie", "csrf", "capability", "tenant"].map(
    (kind): Case => ({
      name: `rejects invalid ${kind} before interpreting a publication body`,
      async run(factory) {
        const f = await factory(`shared_auth_${kind}`);
        const credentials = { ...f.credentials };
        if (kind === "cookie") credentials.sessionToken = "invalid";
        if (kind === "csrf") credentials.csrfToken = "invalid";
        if (kind === "capability") await f.changeCapabilities([]);
        if (kind === "tenant")
          credentials.scope = { ...credentials.scope, tenantId: "tenant_outside" };
        let interpreted = false;
        const body = new Proxy(
          {},
          {
            get() {
              interpreted = true;
              throw new Error("Body inspected before authentication");
            },
            ownKeys() {
              interpreted = true;
              throw new Error("Body inspected before authentication");
            },
          },
        );
        await assert.rejects(f.service.publishSelection(credentials, body));
        assert.equal(interpreted, false);
        assert.equal(await f.readOriginal(f.intent.selectionVersionId), null);
        assert.equal(
          await f.readPublication("release_policy_selection", f.intent.selectionVersionId),
          null,
        );
      },
    }),
  ),
  ...["issuerPrincipalId", "scope", "publishedAt", "publication", "definitionSha256"].map(
    (field): Case => ({
      name: `rejects caller-owned ${field} without committing a source or provenance`,
      async run(factory) {
        const f = await factory(`shared_inject_${field.toLowerCase()}`);
        await assert.rejects(
          f.service.publishSelection(f.credentials, { ...f.intent, [field]: "caller_supplied" }),
        );
        assert.equal(await f.readOriginal(f.intent.selectionVersionId), null);
        assert.equal(
          await f.readPublication("release_policy_selection", f.intent.selectionVersionId),
          null,
        );
      },
    }),
  ),
  {
    name: "rejects substituted retry bodies while retaining the entire first publication",
    async run(factory) {
      const f = await factory("shared_retry_body");
      const first = await f.service.publishSelection(f.credentials, f.intent);
      await assert.rejects(
        f.service.publishSelection(f.credentials, {
          ...f.intent,
          rationale: "Substituted original request body.",
        }),
      );
      assert.deepEqual(await f.readOriginal(f.intent.selectionVersionId), first.record);
      assert.deepEqual(
        (await f.readPublication("release_policy_selection", f.intent.selectionVersionId))
          ?.publication,
        first.publication,
      );
    },
  },
  {
    name: "requires current authority even for an identical historical retry",
    async run(factory) {
      const f = await factory("shared_retry_grant");
      const first = await f.service.publishSelection(f.credentials, f.intent);
      await f.changeCapabilities([]);
      await assert.rejects(f.service.publishSelection(f.credentials, f.intent));
      assert.deepEqual(await f.readOriginal(f.intent.selectionVersionId), first.record);
      assert.deepEqual(
        (await f.readPublication("release_policy_selection", f.intent.selectionVersionId))
          ?.publication,
        first.publication,
      );
    },
  },
  {
    name: "records an exact authenticated withdrawal and preserves its original receipt on retry",
    async run(factory) {
      const f = await factory("shared_withdrawal");
      const root = await f.service.publishSelection(f.credentials, f.intent);
      const intent = {
        eventId: "event_shared_withdrawal",
        kind: "withdrawn" as const,
        selection: releasePolicySelectionReference(root.record as ReleasePolicySelection),
        reason: "Withdraw the exact original installed selection.",
      };
      const first = await f.service.publishLifecycle(f.credentials, intent);
      const again = await f.service.publishLifecycle(
        await f.login("request_shared_withdrawal_retry"),
        intent,
      );
      assert.equal(first.created, true);
      assert.equal(again.created, false);
      assert.deepEqual(again.record, first.record);
      assert.deepEqual(again.publication, first.publication);
      const material = await f.readPublication(
        "release_policy_selection_lifecycle",
        intent.eventId,
      );
      assert.deepEqual(
        validateReleaseSelectionPublicationMaterial(material, meter()).publication,
        first.publication,
      );
    },
  },
  {
    name: "cannot omit an explicit mandatory policy whose exact source is missing",
    async run(factory) {
      const f = await factory("shared_missing_policy");
      await assert.rejects(
        f.service.publishSelection(f.credentials, {
          ...f.intent,
          mode: "enforce",
          policies: [
            {
              policy: {
                policyId: "policy_missing",
                policyVersionId: "version_missing",
                definitionSha256: "a".repeat(64),
              },
              mode: "mandatory",
            },
          ],
        }),
      );
      assert.equal(await f.readOriginal(f.intent.selectionVersionId), null);
      assert.equal(
        await f.readPublication("release_policy_selection", f.intent.selectionVersionId),
        null,
      );
    },
  },
  {
    name: "isolates colliding source and target IDs across three populated tenants",
    async run(factory) {
      const a = await factory("shared_tenant_a"),
        b = await factory("shared_tenant_b"),
        c = await factory("shared_tenant_c");
      const results = await Promise.all(
        [a, b, c].map((f) => f.service.publishSelection(f.credentials, a.intent)),
      );
      for (const [index, f] of [a, b, c].entries()) {
        const result = results[index];
        assert.ok(result);
        assert.deepEqual(result.record.scope, f.scope);
        assert.deepEqual(await f.readOriginal(a.intent.selectionVersionId), result.record);
        assert.equal(
          (await f.readPublication("release_policy_selection", a.intent.selectionVersionId))
            ?.publication.actor.principalId,
          f.principalId,
        );
      }
      assert.equal(new Set(results.map((result) => result.publication.definitionSha256)).size, 3);
    },
  },
];
