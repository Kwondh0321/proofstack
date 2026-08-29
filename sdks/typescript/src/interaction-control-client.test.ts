import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  MAX_ARTIFACT_CONTENT_BYTES,
  type RecordedInteractionFixtureVersionDefinition,
  RecordedInteractionFixtureVersionDefinitionSchema,
  RecordedInteractionFixtureVersionSchema,
} from "@proofstack/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  ProofStackApiError,
  ProofStackRegressionClient,
  type ProofStackRegressionClientOptions,
} from "./regression-client.js";

const csrfToken = `psc_v1_${"E".repeat(43)}`;
const apiKey = `psk_v1_ABCDEFGHIJKL_${"A".repeat(43)}`;
const content = Buffer.from('{"captured":true}', "utf8");
const contentDigest = createHash("sha256").update(content).digest("hex");
const artifactId = "art_sdk_content";
const scope = {
  environmentId: "env_prod",
  projectId: "prj_agent",
  tenantId: "ten_acme",
} as const;
const reservation = {
  artifactId,
  classification: "confidential",
  mediaType: "application/json",
  redaction: { status: "not_required" },
  retention: { mode: "retain" },
  sha256: contentDigest,
  sizeBytes: content.byteLength,
} as const;
const reservedMetadata = {
  contentReference: {
    artifactId,
    classification: reservation.classification,
    mediaType: reservation.mediaType,
    sha256: reservation.sha256,
    sizeBytes: reservation.sizeBytes,
  },
  createdAt: "2026-08-29T05:00:00.000Z",
  redaction: reservation.redaction,
  retention: reservation.retention,
  schemaVersion: "0.1",
  scope,
  state: "reserved",
} as const;
const availableMetadata = {
  ...reservedMetadata,
  availableAt: "2026-08-29T05:00:01.000Z",
  state: "available",
} as const;
const tombstonedMetadata = {
  ...availableMetadata,
  state: "tombstoned",
  tombstonedAt: "2026-08-29T05:00:02.000Z",
} as const;
const purgedMetadata = {
  ...tombstonedMetadata,
  purgedAt: "2026-08-29T05:00:03.000Z",
  state: "purged",
} as const;
const artifactOwnership = {
  artifactId,
  boundAt: "2026-08-29T05:00:01.500Z",
  boundByPrincipalId: "usr_sdk_operator",
  owner: {
    fixtureId: "fix_sdk_capture",
    fixtureVersionId: "fixv_sdk_capture_002",
    kind: "regression_fixture_version",
  },
  schemaVersion: "0.1",
  scope,
} as const;
const artifactTombstone = {
  actorPrincipalId: "usr_sdk_operator",
  artifactId,
  occurredAt: tombstonedMetadata.tombstonedAt,
  reason: "Remove obsolete SDK content",
  tombstoneId: "del_sdk_content",
  trigger: "manual",
} as const;

const recordedDefinition = RecordedInteractionFixtureVersionDefinitionSchema.parse(
  (
    JSON.parse(
      readFileSync(
        new URL(
          "../../../packages/datasets/vectors/interaction-fixture-definition-v2.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as {
      readonly vectors: readonly {
        readonly input: RecordedInteractionFixtureVersionDefinition;
      }[];
    }
  ).vectors[0]?.input,
);
const recordedVersion = RecordedInteractionFixtureVersionSchema.parse({
  ...recordedDefinition,
  createdAt: "2026-08-29T05:05:00.000Z",
  createdByPrincipalId: "usr_sdk_operator",
  definitionSha256: "a".repeat(64),
  source: {
    ...recordedDefinition.source,
    capturedAt: "2026-08-29T05:04:00.000Z",
  },
});
const recordedRequest = {
  fixtureVersionId: recordedVersion.fixtureVersionId,
  interactionCapture: recordedVersion.interactionCapture,
  name: recordedVersion.name,
  predecessorVersionId: recordedVersion.predecessor.fixtureVersionId,
} as const;
const recordedOwnerships = recordedVersion.interactionCapture.artifacts.map((binding) => ({
  artifactId: binding.contentReference.artifactId,
  boundAt: recordedVersion.createdAt,
  boundByPrincipalId: recordedVersion.createdByPrincipalId,
  owner: {
    fixtureId: recordedVersion.fixtureId,
    fixtureVersionId: recordedVersion.fixtureVersionId,
    kind: "regression_fixture_version" as const,
  },
  schemaVersion: "0.1" as const,
  scope: recordedVersion.scope,
}));
const revocation = {
  fixtureId: recordedVersion.fixtureId,
  fixtureVersionId: recordedVersion.fixtureVersionId,
  reason: "Remove captured provider content",
  revocationId: "rev_sdk_capture",
  revokedAt: "2026-08-29T05:10:00.000Z",
  revokedByPrincipalId: "usr_sdk_operator",
  schemaVersion: "0.1",
  scope: recordedVersion.scope,
} as const;
const revocationTombstones = recordedOwnerships.map((ownership, index) => ({
  actorPrincipalId: revocation.revokedByPrincipalId,
  artifactId: ownership.artifactId,
  occurredAt: revocation.revokedAt,
  reason: revocation.reason,
  tombstoneId: `del_sdk_capture_${index}`,
  trigger: "fixture_revocation" as const,
}));

function client(
  fetch: typeof globalThis.fetch,
  overrides: Partial<ProofStackRegressionClientOptions> = {},
) {
  return new ProofStackRegressionClient({
    authentication: { csrfToken, mode: "browser" },
    endpoint: "https://proofstack.example",
    environmentId: scope.environmentId,
    fetch,
    projectId: scope.projectId,
    ...overrides,
  });
}

function binaryResponse(
  body: BodyInit | null = content,
  headerOverrides: Record<string, string> = {},
): Response {
  return new Response(body, {
    headers: {
      "content-type": reservation.mediaType,
      "x-proofstack-artifact-classification": reservation.classification,
      "x-proofstack-artifact-redaction-status": reservation.redaction.status,
      "x-proofstack-artifact-sha256": contentDigest,
      "x-proofstack-request-id": "req_sdk_content",
      ...headerOverrides,
    },
    status: 200,
  });
}

describe("ProofStack interaction control client", () => {
  it("executes the complete artifact and recorded-interaction lifecycle", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        Response.json(
          { created: true, metadata: reservedMetadata, requestId: "req_sdk_reserve" },
          { status: 201 },
        ),
      )
      .mockResolvedValueOnce(
        Response.json({ metadata: availableMetadata, requestId: "req_sdk_upload" }),
      )
      .mockResolvedValueOnce(
        Response.json({
          metadata: availableMetadata,
          ownership: artifactOwnership,
          requestId: "req_sdk_metadata",
        }),
      )
      .mockResolvedValueOnce(binaryResponse())
      .mockResolvedValueOnce(
        Response.json(
          {
            created: true,
            metadata: tombstonedMetadata,
            requestId: "req_sdk_tombstone",
            tombstone: artifactTombstone,
          },
          { status: 201 },
        ),
      )
      .mockResolvedValueOnce(
        Response.json({ metadata: purgedMetadata, requestId: "req_sdk_purge" }),
      )
      .mockResolvedValueOnce(
        Response.json(
          {
            created: true,
            ownerships: recordedOwnerships,
            requestId: "req_sdk_recorded_publish",
            version: recordedVersion,
          },
          { status: 201 },
        ),
      )
      .mockResolvedValueOnce(
        Response.json({
          contentAvailability: "available",
          ownerships: recordedOwnerships,
          requestId: "req_sdk_recorded_read",
          revocation: null,
          tombstones: [],
          version: recordedVersion,
        }),
      )
      .mockResolvedValueOnce(
        Response.json(
          {
            contentAvailability: "revoked",
            created: true,
            ownerships: recordedOwnerships,
            requestId: "req_sdk_recorded_revoke",
            revocation,
            tombstones: revocationTombstones,
            version: recordedVersion,
          },
          { status: 201 },
        ),
      );
    const sdk = client(fetch);

    await expect(sdk.reserveArtifact({ request: reservation })).resolves.toMatchObject({
      created: true,
    });
    await expect(sdk.uploadArtifactContent({ artifactId, content })).resolves.toMatchObject({
      metadata: availableMetadata,
    });
    await expect(sdk.readArtifactMetadata({ artifactId })).resolves.toMatchObject({
      ownership: artifactOwnership,
    });
    await expect(sdk.readArtifactContent({ artifactId })).resolves.toMatchObject({
      classification: reservation.classification,
      content: Uint8Array.from(content),
      mediaType: reservation.mediaType,
      redactionStatus: reservation.redaction.status,
      sha256: contentDigest,
    });
    await expect(
      sdk.tombstoneArtifact({ artifactId, request: { reason: artifactTombstone.reason } }),
    ).resolves.toMatchObject({ created: true });
    await expect(sdk.purgeArtifact({ artifactId })).resolves.toMatchObject({
      metadata: purgedMetadata,
    });
    await expect(
      sdk.publishRecordedInteractionFixtureVersion({
        fixtureId: recordedVersion.fixtureId,
        request: recordedRequest,
      }),
    ).resolves.toMatchObject({ created: true, version: recordedVersion });
    await expect(
      sdk.readRecordedInteractionFixtureMetadata({
        fixtureId: recordedVersion.fixtureId,
        fixtureVersionId: recordedVersion.fixtureVersionId,
      }),
    ).resolves.toMatchObject({ contentAvailability: "available" });
    await expect(
      sdk.revokeRecordedInteractionFixtureContent({
        fixtureId: recordedVersion.fixtureId,
        fixtureVersionId: recordedVersion.fixtureVersionId,
        request: { reason: revocation.reason },
      }),
    ).resolves.toMatchObject({ contentAvailability: "revoked", created: true });

    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
      "https://proofstack.example/v1/projects/prj_agent/environments/env_prod/artifacts",
      `https://proofstack.example/v1/projects/prj_agent/environments/env_prod/artifacts/${artifactId}/content`,
      `https://proofstack.example/v1/projects/prj_agent/environments/env_prod/artifacts/${artifactId}`,
      `https://proofstack.example/v1/projects/prj_agent/environments/env_prod/artifacts/${artifactId}/content`,
      `https://proofstack.example/v1/projects/prj_agent/environments/env_prod/artifacts/${artifactId}`,
      `https://proofstack.example/v1/projects/prj_agent/environments/env_prod/artifacts/${artifactId}/purge`,
      "https://proofstack.example/v1/projects/prj_agent/environments/env_prod/regression-fixtures/fix_checkout/interaction-versions",
      "https://proofstack.example/v1/projects/prj_agent/environments/env_prod/regression-fixtures/fix_checkout/interaction-versions/fiv_checkout_002",
      "https://proofstack.example/v1/projects/prj_agent/environments/env_prod/regression-fixtures/fix_checkout/interaction-versions/fiv_checkout_002/revocation",
    ]);
    expect(fetch.mock.calls.map(([, init]) => init?.method)).toEqual([
      "POST",
      "PUT",
      "GET",
      "GET",
      "DELETE",
      "POST",
      "POST",
      "GET",
      "POST",
    ]);
    for (const index of [0, 1, 4, 5, 6, 8]) {
      expect(fetch.mock.calls[index]?.[1]?.headers).toMatchObject({
        "x-proofstack-csrf": csrfToken,
      });
    }
    expect(fetch.mock.calls[1]?.[1]).toMatchObject({
      body: Uint8Array.from(content),
      headers: { "content-type": "application/octet-stream" },
    });
  });

  it("permits workload artifact writes and reads but rejects administrative mutations", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        Response.json(
          { created: false, metadata: reservedMetadata, requestId: "req_workload_reserve" },
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        Response.json({ metadata: availableMetadata, requestId: "req_workload_read" }),
      );
    const sdk = client(fetch, { authentication: { apiKey, mode: "workload" } });

    await sdk.reserveArtifact({ request: reservation });
    await sdk.readArtifactMetadata({ artifactId });
    await expect(sdk.purgeArtifact({ artifactId })).rejects.toThrow("user management authority");
    await expect(
      sdk.publishRecordedInteractionFixtureVersion({
        fixtureId: recordedVersion.fixtureId,
        request: recordedRequest,
      }),
    ).rejects.toThrow("user management authority");

    expect(fetch).toHaveBeenCalledTimes(2);
    for (const call of fetch.mock.calls) {
      expect(call[1]?.headers).toMatchObject({ authorization: `Bearer ${apiKey}` });
      expect(call[1]?.headers).not.toHaveProperty("x-proofstack-csrf");
      expect(call[1]?.credentials).toBe("omit");
    }
  });

  it("rejects invalid interaction inputs before network access", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const sdk = client(fetch);

    await expect(
      sdk.reserveArtifact({ request: { ...reservation, extra: true } as never }),
    ).rejects.toThrow("reservation failed local validation");
    await expect(sdk.uploadArtifactContent({ artifactId: "INVALID", content })).rejects.toThrow(
      "artifactId failed local validation",
    );
    await expect(
      sdk.uploadArtifactContent({ artifactId, content: new Uint8Array() }),
    ).rejects.toThrow("non-empty Uint8Array");
    await expect(
      sdk.uploadArtifactContent({
        artifactId,
        content: new Uint8Array(MAX_ARTIFACT_CONTENT_BYTES + 1),
      }),
    ).rejects.toThrow("exceeds 16777216 bytes");
    await expect(
      sdk.tombstoneArtifact({ artifactId, request: { reason: " bad " } }),
    ).rejects.toThrow("tombstone request failed local validation");
    await expect(
      sdk.publishRecordedInteractionFixtureVersion({
        fixtureId: recordedVersion.fixtureId,
        request: { ...recordedRequest, interactionCapture: { artifacts: [] } } as never,
      }),
    ).rejects.toThrow("publication failed local validation");
    await expect(
      sdk.revokeRecordedInteractionFixtureContent({
        fixtureId: recordedVersion.fixtureId,
        fixtureVersionId: "INVALID",
        request: { reason: revocation.reason },
      }),
    ).rejects.toThrow("fixtureVersionId failed local validation");
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["classification", { "x-proofstack-artifact-classification": "unknown" }],
    ["redaction", { "x-proofstack-artifact-redaction-status": "unknown" }],
    ["digest header", { "x-proofstack-artifact-sha256": "invalid" }],
    ["request identifier", { "x-proofstack-request-id": "" }],
  ])("rejects a contract-breaking artifact %s header", async (_name, headers) => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(binaryResponse(content, headers));
    const sdk = client(fetch);

    await expect(sdk.readArtifactContent({ artifactId })).rejects.toThrow(
      "violates the published contract",
    );
  });

  it("rejects artifact content whose bytes do not match the declared digest", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(binaryResponse(Buffer.from("different", "utf8")));
    const sdk = client(fetch);

    await expect(sdk.readArtifactContent({ artifactId })).rejects.toThrow("digest does not match");
  });

  it("rejects empty and oversized artifact content responses", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(binaryResponse(null))
      .mockResolvedValueOnce(binaryResponse(new Uint8Array(MAX_ARTIFACT_CONTENT_BYTES + 1)));
    const sdk = client(fetch);

    await expect(sdk.readArtifactContent({ artifactId })).rejects.toThrow("empty artifact content");
    await expect(sdk.readArtifactContent({ artifactId })).rejects.toThrow(
      "exceeded 16777216 bytes",
    );
  });

  it("rejects artifact and interaction creation markers that contradict HTTP status", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        Response.json(
          { created: true, metadata: reservedMetadata, requestId: "req_wrong_reserve" },
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        Response.json(
          {
            created: false,
            ownerships: recordedOwnerships,
            requestId: "req_wrong_publish",
            version: recordedVersion,
          },
          { status: 201 },
        ),
      );
    const sdk = client(fetch);

    await expect(sdk.reserveArtifact({ request: reservation })).rejects.toThrow(
      "inconsistent artifact reservation status",
    );
    await expect(
      sdk.publishRecordedInteractionFixtureVersion({
        fixtureId: recordedVersion.fixtureId,
        request: recordedRequest,
      }),
    ).rejects.toThrow("inconsistent recorded interaction publication status");
  });

  it("rejects schema-valid artifact identities and scopes that contradict the request path", async () => {
    const otherArtifactId = "art_sdk_other";
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        Response.json(
          {
            created: true,
            metadata: {
              ...reservedMetadata,
              contentReference: {
                ...reservedMetadata.contentReference,
                artifactId: otherArtifactId,
              },
            },
            requestId: "req_wrong_artifact",
          },
          { status: 201 },
        ),
      )
      .mockResolvedValueOnce(
        Response.json({
          metadata: availableMetadata,
          ownership: { ...artifactOwnership, artifactId: otherArtifactId },
          requestId: "req_wrong_ownership",
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          metadata: {
            ...availableMetadata,
            scope: { ...availableMetadata.scope, environmentId: "env_other" },
          },
          requestId: "req_wrong_scope",
        }),
      );
    const sdk = client(fetch);

    await expect(sdk.reserveArtifact({ request: reservation })).rejects.toThrow(
      "identity that contradicts",
    );
    await expect(sdk.readArtifactMetadata({ artifactId })).rejects.toThrow(
      "ownership that contradicts",
    );
    await expect(sdk.readArtifactMetadata({ artifactId })).rejects.toThrow(
      "scope that contradicts",
    );
  });

  it("reduces binary-route problem responses to the validated structured error", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      Response.json(
        {
          code: "artifact_unavailable",
          detail: "Artifact content is unavailable",
          requestId: "req_sdk_unavailable",
          status: 409,
          title: "Artifact unavailable",
          type: "https://proofstack.dev/problems/artifact-unavailable",
        },
        { status: 409 },
      ),
    );
    const sdk = client(fetch);

    await expect(sdk.readArtifactContent({ artifactId })).rejects.toMatchObject({
      code: "artifact_unavailable",
      requestId: "req_sdk_unavailable",
      status: 409,
    });
  });

  it("rejects an artifact response with an invalid media type", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(binaryResponse(content, { "content-type": "invalid" }));
    const sdk = client(fetch);

    await expect(sdk.readArtifactContent({ artifactId })).rejects.toThrow(
      "media type violates the published contract",
    );
  });

  it("rejects a non-Uint8Array upload body", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const sdk = client(fetch);

    await expect(
      sdk.uploadArtifactContent({ artifactId, content: "not-bytes" as never }),
    ).rejects.toBeInstanceOf(ProofStackApiError);
    expect(fetch).not.toHaveBeenCalled();
  });
});
