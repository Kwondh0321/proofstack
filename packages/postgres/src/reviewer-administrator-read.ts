import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { EvidenceScopeSchema, OpaqueIdSchema, type EvidenceScope } from "@proofstack/contracts";
import { ReleaseDecisionVerificationBudget } from "@proofstack/core";
import type { PoolClient, QueryResultRow } from "pg";

export type ReviewerAdministratorProjection =
  | "authority_view"
  | "authority_event_view"
  | "authority_root"
  | "authority_versions"
  | "authority_events";
export interface ReviewerAdministratorReadContext {
  readonly scope: EvidenceScope;
  readonly budget: ReleaseDecisionVerificationBudget;
}
export class ReviewerAdministratorProjectionError extends Error {
  readonly code = "release_reviewer_administrator_projection_invalid";
  constructor() {
    super("Owning reviewer administrator source projection was rejected");
    this.name = "ReviewerAdministratorProjectionError";
  }
}

/** Fixed source projection transport only. Every raw fragment and repeated normalized source
 * observation is admitted before assembling/parsing; no SQL text or arbitrary query port is accepted.
 * Transport hashes detect damaged fragments, not authentication or current publication authority.
 */
export async function readReviewerAdministratorRowsOnClient<Row extends QueryResultRow>(
  client: Pick<PoolClient, "query">,
  context: ReviewerAdministratorReadContext,
  projection: ReviewerAdministratorProjection,
  id: string,
  secondary = "",
  tertiary = "",
): Promise<Row[]> {
  const budget = context.budget;
  if (!(budget instanceof ReleaseDecisionVerificationBudget))
    throw new ReviewerAdministratorProjectionError();
  budget.snapshot();
  try {
    const scope = EvidenceScopeSchema.parse(context.scope);
    OpaqueIdSchema.parse(id);
    if (
      ![
        "authority_view",
        "authority_event_view",
        "authority_root",
        "authority_versions",
        "authority_events",
      ].includes(projection)
    )
      throw new ReviewerAdministratorProjectionError();
    if (projection === "authority_root") {
      OpaqueIdSchema.parse(secondary);
      OpaqueIdSchema.parse(tertiary);
    } else {
      if (tertiary !== "") throw new ReviewerAdministratorProjectionError();
      if (projection === "authority_versions" || projection === "authority_events") {
        if (secondary !== "") OpaqueIdSchema.parse(secondary);
      } else if (secondary !== "") throw new ReviewerAdministratorProjectionError();
    }
    const response = await client.query<{ value: unknown }>(
      "SELECT public.proofstack_read_reviewer_administrator_projection($1::jsonb,$2,$3,$4,$5) AS value",
      [JSON.stringify(scope), projection, id, secondary, tertiary],
    );
    const fail = (): never => {
      throw new ReviewerAdministratorProjectionError();
    };
    if (response.rows.length < 1 || response.rows.length > 256) fail();
    const chunks: Buffer[] = [];
    let offset = 0;
    let total: number | undefined;
    let sha: string | undefined;
    for (const item of response.rows) {
      const raw = item.value;
      const row =
        raw && typeof raw === "object" && !Array.isArray(raw)
          ? (raw as Record<string, unknown>)
          : {};
      const records = row["records"];
      budget.observe(
        item,
        "metadata",
        typeof records === "number" && Number.isSafeInteger(records) && records >= 0
          ? Math.max(1, records)
          : 1,
      );
      if (!isDeepStrictEqual(Object.keys(item), ["value"])) fail();
      if (
        !isDeepStrictEqual(Object.keys(row).sort(), [
          "chunkBase64",
          "offset",
          "projection",
          "records",
          "scope",
          "sha256",
          "totalBytes",
        ]) ||
        row["projection"] !== projection ||
        !isDeepStrictEqual(row["scope"], scope) ||
        row["offset"] !== offset ||
        typeof row["totalBytes"] !== "number" ||
        !Number.isSafeInteger(row["totalBytes"]) ||
        row["totalBytes"] < 2 ||
        row["totalBytes"] > 16 * 1024 * 1024 ||
        typeof row["sha256"] !== "string" ||
        !/^[0-9a-f]{64}$/.test(row["sha256"]) ||
        typeof row["chunkBase64"] !== "string" ||
        row["chunkBase64"].length > 87384 ||
        typeof records !== "number" ||
        !Number.isSafeInteger(records) ||
        records < 0 ||
        records > 10000 ||
        (offset === 0 ? records < 1 : records !== 0)
      )
        fail();
      const encoded = row["chunkBase64"] as string;
      const bytes = Buffer.from(encoded, "base64");
      if (bytes.toString("base64") !== encoded || bytes.length < 1 || bytes.length > 65536) fail();
      total ??= row["totalBytes"] as number;
      sha ??= row["sha256"] as string;
      if (
        row["totalBytes"] !== total ||
        row["sha256"] !== sha ||
        bytes.length !== Math.min(65536, total - offset)
      )
        fail();
      chunks.push(bytes);
      offset += bytes.length;
    }
    if (total === undefined || offset !== total) fail();
    const bytes = Buffer.concat(chunks, offset);
    if (createHash("sha256").update(bytes).digest("hex") !== sha) fail();
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (
      !Array.isArray(value) ||
      value.length >
        (projection === "authority_versions" || projection === "authority_events" ? 16 : 1) ||
      value.some((row) => !row || typeof row !== "object" || Array.isArray(row))
    )
      fail();
    return value as Row[];
  } catch (cause) {
    return budget.rejectSourceRead(cause);
  }
}
