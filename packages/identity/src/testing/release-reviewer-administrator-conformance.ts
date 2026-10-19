import assert from "node:assert/strict";
import type {
  Capability,
  EvidenceScope,
  PublishReleaseReviewerAuthorityRequest,
  ReleaseReviewerAuthority,
  ReleaseReviewerPublicationMaterial,
} from "@proofstack/contracts";
import {
  releaseReviewerAuthorityReference,
  ReleaseDecisionVerificationBudget,
  validateReleaseReviewerPublicationMaterial,
} from "@proofstack/core";
import type { ReleaseBrowserMutationCredentials } from "../release-mutation-authentication.js";
import type { ReleaseReviewerAdministrator } from "../release-reviewer-administrator.js";

export interface ReleaseReviewerAdministratorConformanceHarness {
  readonly service: ReleaseReviewerAdministrator;
  readonly scope: EvidenceScope;
  readonly credentials: ReleaseBrowserMutationCredentials;
  readonly intent: PublishReleaseReviewerAuthorityRequest;
  readonly principalId: string;
  login(requestId: string): Promise<ReleaseBrowserMutationCredentials>;
  changeCapabilities(capabilities: readonly Capability[]): Promise<void>;
  readOriginal(versionId: string): Promise<ReleaseReviewerAuthority | null>;
  readPublication(
    kind: ReleaseReviewerPublicationMaterial["source"]["kind"],
    id: string,
  ): Promise<ReleaseReviewerPublicationMaterial | null>;
}
export type ReleaseReviewerAdministratorConformanceFactory = (
  namespace: string,
) => Promise<ReleaseReviewerAdministratorConformanceHarness>;
interface Case {
  readonly name: string;
  readonly run: (factory: ReleaseReviewerAdministratorConformanceFactory) => Promise<void>;
}
const meter = () =>
  new ReleaseDecisionVerificationBudget({
    maxAcquisitionRecords: 10000,
    maxAcquisitionRecordBytes: 16 * 1024 * 1024,
    maxApprovalRecords: 0,
  });
export const releaseReviewerAdministratorConformanceCases: readonly Case[] = [
  {
    name: "keeps stored original and provenance independent from caller mutations of returned objects",
    async run(factory) {
      const f = await factory("shared_returned_copy");
      const first = await f.service.publishReviewerAuthority(f.credentials, f.intent);
      const expected = structuredClone(first);
      (first.record as ReleaseReviewerAuthority).rationale = "Caller changed their returned copy.";
      first.publication.actor.requestId = "request_changed_by_caller";
      const again = await f.service.publishReviewerAuthority(f.credentials, f.intent);
      assert.deepEqual(again.record, expected.record);
      assert.deepEqual(again.publication, expected.publication);
      const material = await f.readPublication(
        "release_reviewer_authority",
        f.intent.authorityVersionId,
      );
      assert.deepEqual(
        validateReleaseReviewerPublicationMaterial(material, meter()).publication,
        expected.publication,
      );
    },
  },
  {
    name: "publishes actual user authentication bound to the complete original and safe preimages",
    async run(factory) {
      const f = await factory("shared_original");
      const result = await f.service.publishReviewerAuthority(f.credentials, f.intent);
      assert.equal(result.created, true);
      assert.deepEqual(await f.readOriginal(f.intent.authorityVersionId), result.record);
      const material = await f.readPublication(
        "release_reviewer_authority",
        f.intent.authorityVersionId,
      );
      assert.deepEqual(
        validateReleaseReviewerPublicationMaterial(material, meter()).publication,
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
      const first = await f.service.publishReviewerAuthority(f.credentials, f.intent);
      const credentials = await f.login("request_shared_second_login");
      assert.notEqual(credentials.sessionToken, f.credentials.sessionToken);
      const again = await f.service.publishReviewerAuthority(credentials, f.intent);
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
        await assert.rejects(f.service.publishReviewerAuthority(credentials, body));
        assert.equal(interpreted, false);
        assert.equal(await f.readOriginal(f.intent.authorityVersionId), null);
        assert.equal(
          await f.readPublication("release_reviewer_authority", f.intent.authorityVersionId),
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
          f.service.publishReviewerAuthority(f.credentials, {
            ...f.intent,
            [field]: "caller_supplied",
          }),
        );
        assert.equal(await f.readOriginal(f.intent.authorityVersionId), null);
        assert.equal(
          await f.readPublication("release_reviewer_authority", f.intent.authorityVersionId),
          null,
        );
      },
    }),
  ),
  {
    name: "rejects substituted retry bodies while retaining the entire first publication",
    async run(factory) {
      const f = await factory("shared_retry_body");
      const first = await f.service.publishReviewerAuthority(f.credentials, f.intent);
      await assert.rejects(
        f.service.publishReviewerAuthority(f.credentials, {
          ...f.intent,
          rationale: "Substituted original request body.",
        }),
      );
      assert.deepEqual(await f.readOriginal(f.intent.authorityVersionId), first.record);
      assert.deepEqual(
        (await f.readPublication("release_reviewer_authority", f.intent.authorityVersionId))
          ?.publication,
        first.publication,
      );
    },
  },
  {
    name: "requires current authority even for an identical historical retry",
    async run(factory) {
      const f = await factory("shared_retry_grant");
      const first = await f.service.publishReviewerAuthority(f.credentials, f.intent);
      await f.changeCapabilities([]);
      await assert.rejects(f.service.publishReviewerAuthority(f.credentials, f.intent));
      assert.deepEqual(await f.readOriginal(f.intent.authorityVersionId), first.record);
      assert.deepEqual(
        (await f.readPublication("release_reviewer_authority", f.intent.authorityVersionId))
          ?.publication,
        first.publication,
      );
    },
  },
  {
    name: "records an exact authenticated revocation and preserves its original receipt on retry",
    async run(factory) {
      const f = await factory("shared_revocation");
      const root = await f.service.publishReviewerAuthority(f.credentials, f.intent);
      const intent = {
        eventId: "event_shared_revocation",
        kind: "revoked" as const,
        authority: releaseReviewerAuthorityReference(root.record as ReleaseReviewerAuthority),
        reason: "Revoke the exact original reviewer authority declaration.",
      };
      const first = await f.service.publishReviewerAuthorityLifecycle(f.credentials, intent);
      const again = await f.service.publishReviewerAuthorityLifecycle(
        await f.login("request_shared_revocation_retry"),
        intent,
      );
      assert.equal(first.created, true);
      assert.equal(again.created, false);
      assert.deepEqual(again.record, first.record);
      assert.deepEqual(again.publication, first.publication);
      const material = await f.readPublication(
        "release_reviewer_authority_lifecycle",
        intent.eventId,
      );
      assert.deepEqual(
        validateReleaseReviewerPublicationMaterial(material, meter()).publication,
        first.publication,
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
        [a, b, c].map((f) => f.service.publishReviewerAuthority(f.credentials, a.intent)),
      );
      for (const [index, f] of [a, b, c].entries()) {
        const result = results[index];
        assert.ok(result);
        assert.deepEqual(result.record.scope, f.scope);
        assert.deepEqual(await f.readOriginal(a.intent.authorityVersionId), result.record);
        assert.equal(
          (await f.readPublication("release_reviewer_authority", a.intent.authorityVersionId))
            ?.publication.actor.principalId,
          f.principalId,
        );
      }
      assert.equal(new Set(results.map((result) => result.publication.definitionSha256)).size, 3);
    },
  },
];
