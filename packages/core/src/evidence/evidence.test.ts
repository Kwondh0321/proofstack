import {
  EVIDENCE_SCHEMA_VERSION,
  type EvidenceRecord,
  IngestEvidenceRequestSchema,
  type PrincipalContext,
  PrincipalContextSchema,
} from "@proofstack/contracts";
import { describe, expect, it } from "vitest";
import { EvidenceConflictError, ForbiddenError, TraceNotFoundError } from "../errors.js";
import { FixedClock } from "../testing/fixed-clock.js";
import { MemoryEvidenceRepository } from "../testing/memory-evidence-repository.js";
import { IngestEvidence } from "./ingest-evidence.js";
import { ListTraceEvidence } from "./list-trace-evidence.js";

const clock = new FixedClock(new Date("2026-08-28T03:00:00.000Z"));

const baseEvidence: EvidenceRecord = {
  attributes: {},
  contentReferences: [],
  eventId: "evt_01k3t5d7h9m2p4r6s8v0w2y4z6",
  extensions: {},
  kind: "agent.run",
  name: "support-agent",
  source: {
    sdkName: "@proofstack/sdk",
    sdkVersion: "0.0.0",
    serviceName: "support-agent",
  },
  spanId: "00f067aa0ba902b7",
  startedAt: "2026-08-28T02:59:59.000Z",
  status: "ok",
  traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
};

function principal(overrides: Partial<PrincipalContext> = {}): PrincipalContext {
  return PrincipalContextSchema.parse({
    authentication: {
      authenticatedAt: "2026-08-28T02:00:00.000Z",
      method: "development",
    },
    capabilities: ["evidence:ingest", "evidence:read"],
    principalId: "usr_local",
    principalType: "user",
    requestId: "req_local_001",
    resourceScope: { mode: "tenant" },
    roles: ["owner"],
    tenantId: "ten_local",
    ...overrides,
  });
}

function request(evidence: EvidenceRecord = baseEvidence) {
  return IngestEvidenceRequestSchema.parse({
    events: [evidence],
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
  });
}

function command(actor: PrincipalContext = principal()) {
  return {
    environmentId: "env_local",
    principal: actor,
    projectId: "prj_local",
    request: request(),
  };
}

describe("IngestEvidence", () => {
  it("adds server-owned scope and receipt time", async () => {
    const repository = new MemoryEvidenceRepository();
    const ingest = new IngestEvidence(repository, clock);

    const result = await ingest.execute(command());
    const stored = await repository.listByTrace(
      { environmentId: "env_local", projectId: "prj_local", tenantId: "ten_local" },
      baseEvidence.traceId,
    );

    expect(result.acceptedEventIds).toEqual([baseEvidence.eventId]);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.receivedAt).toBe("2026-08-28T03:00:00.000Z");
    expect(stored[0]?.scope.tenantId).toBe("ten_local");
  });

  it("is idempotent for identical evidence", async () => {
    const repository = new MemoryEvidenceRepository();
    const ingest = new IngestEvidence(repository, clock);

    await ingest.execute(command());
    const second = await ingest.execute(command());

    expect(second).toEqual({
      acceptedEventIds: [],
      duplicateEventIds: [baseEvidence.eventId],
    });
  });

  it("treats reordered JSON object keys as the same evidence", async () => {
    const repository = new MemoryEvidenceRepository();
    const ingest = new IngestEvidence(repository, clock);
    const first = { ...baseEvidence, attributes: { alpha: 1, beta: 2 } };
    const retry = { ...baseEvidence, attributes: { beta: 2, alpha: 1 } };

    await ingest.execute({ ...command(), request: request(first) });
    const result = await ingest.execute({ ...command(), request: request(retry) });

    expect(result).toEqual({
      acceptedEventIds: [],
      duplicateEventIds: [baseEvidence.eventId],
    });
  });

  it("rejects reuse of an event identifier in a different resource scope", async () => {
    const repository = new MemoryEvidenceRepository();
    const ingest = new IngestEvidence(repository, clock);

    await ingest.execute(command());

    await expect(
      ingest.execute({ ...command(), environmentId: "env_other" }),
    ).rejects.toBeInstanceOf(EvidenceConflictError);
  });

  it("rejects reuse of an event identifier with different evidence", async () => {
    const repository = new MemoryEvidenceRepository();
    const ingest = new IngestEvidence(repository, clock);

    await ingest.execute(command());

    await expect(
      ingest.execute({ ...command(), request: request({ ...baseEvidence, name: "changed" }) }),
    ).rejects.toBeInstanceOf(EvidenceConflictError);
  });

  it("does not partially append a conflicting batch", async () => {
    const repository = new MemoryEvidenceRepository();
    const ingest = new IngestEvidence(repository, clock);
    await ingest.execute(command());

    const newEvidence = {
      ...baseEvidence,
      eventId: "evt_01k3t5d7h9m2p4r6s8v0w2y4z7",
      spanId: "10f067aa0ba902b7",
    };
    const conflictingEvidence = { ...baseEvidence, name: "changed" };

    await expect(
      ingest.execute({
        ...command(),
        request: IngestEvidenceRequestSchema.parse({
          events: [newEvidence, conflictingEvidence],
          schemaVersion: EVIDENCE_SCHEMA_VERSION,
        }),
      }),
    ).rejects.toBeInstanceOf(EvidenceConflictError);

    const stored = await repository.listByTrace(
      { environmentId: "env_local", projectId: "prj_local", tenantId: "ten_local" },
      baseEvidence.traceId,
    );
    expect(stored).toHaveLength(1);
  });

  it("requires the ingestion capability", async () => {
    const ingest = new IngestEvidence(new MemoryEvidenceRepository(), clock);

    await expect(
      ingest.execute(command(principal({ capabilities: ["evidence:read"] }))),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("enforces a restricted project scope", async () => {
    const ingest = new IngestEvidence(new MemoryEvidenceRepository(), clock);

    await expect(
      ingest.execute(
        command(
          principal({
            resourceScope: { mode: "restricted", projects: [{ projectId: "prj_other" }] },
          }),
        ),
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("enforces a restricted environment scope", async () => {
    const ingest = new IngestEvidence(new MemoryEvidenceRepository(), clock);

    await expect(
      ingest.execute(
        command(
          principal({
            resourceScope: {
              mode: "restricted",
              projects: [{ environmentIds: ["env_other"], projectId: "prj_local" }],
            },
          }),
        ),
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("ListTraceEvidence", () => {
  it("returns only evidence inside the authenticated tenant", async () => {
    const repository = new MemoryEvidenceRepository();
    const ingest = new IngestEvidence(repository, clock);
    const list = new ListTraceEvidence(repository);

    await ingest.execute(command(principal({ tenantId: "ten_local" })));
    await ingest.execute(
      command(
        principal({
          principalId: "usr_other",
          requestId: "req_other_001",
          tenantId: "ten_other",
        }),
      ),
    );

    const result = await list.execute({
      environmentId: "env_local",
      principal: principal({ tenantId: "ten_local" }),
      projectId: "prj_local",
      traceId: baseEvidence.traceId,
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.scope.tenantId).toBe("ten_local");
  });

  it("requires read capability", async () => {
    const list = new ListTraceEvidence(new MemoryEvidenceRepository());

    await expect(
      list.execute({
        environmentId: "env_local",
        principal: principal({ capabilities: ["evidence:ingest"] }),
        projectId: "prj_local",
        traceId: baseEvidence.traceId,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("allows reads inside an explicit environment scope", async () => {
    const repository = new MemoryEvidenceRepository();
    const ingest = new IngestEvidence(repository, clock);
    const list = new ListTraceEvidence(repository);
    const actor = principal({
      resourceScope: {
        mode: "restricted",
        projects: [{ environmentIds: ["env_local"], projectId: "prj_local" }],
      },
    });
    await ingest.execute(command(actor));

    await expect(
      list.execute({
        environmentId: "env_local",
        principal: actor,
        projectId: "prj_local",
        traceId: baseEvidence.traceId,
      }),
    ).resolves.toHaveLength(1);
  });

  it("reports an unknown trace after authorization succeeds", async () => {
    const list = new ListTraceEvidence(new MemoryEvidenceRepository());

    await expect(
      list.execute({
        environmentId: "env_local",
        principal: principal(),
        projectId: "prj_local",
        traceId: baseEvidence.traceId,
      }),
    ).rejects.toBeInstanceOf(TraceNotFoundError);
  });
});
