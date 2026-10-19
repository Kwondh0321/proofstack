import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { EvidenceScopeSchema, OpaqueIdSchema, type EvidenceScope } from "@proofstack/contracts";
import { ReleaseDecisionVerificationBudget } from "@proofstack/core";
import type { PoolClient, QueryResultRow } from "pg";

export type InstallerProjection =
  | "policy_record"
  | "policy_presence"
  | "policy_lifecycle"
  | "policy_events"
  | "selection_view"
  | "selection_event_view";
export interface InstallerReadContext {
  readonly scope: EvidenceScope;
  readonly budget: ReleaseDecisionVerificationBudget;
}
export class InstallerProjectionError extends Error {
  readonly code = "release_installer_projection_invalid";
  constructor() {
    super("Owning installer source projection was rejected");
    this.name = "InstallerProjectionError";
  }
}

/** Fixed source projection transport only. Every raw fragment and repeated normalized source
 * observation is admitted before assembling/parsing; no SQL text or arbitrary query port is accepted.
 * Transport hashes detect damaged fragments, not authentication or current publication authority.
 */
export async function readInstallerRowsOnClient<Row extends QueryResultRow>(
  client: Pick<PoolClient, "query">,
  context: InstallerReadContext,
  projection: InstallerProjection,
  id: string,
): Promise<Row[]> {
  const budget = context.budget;
  if (!(budget instanceof ReleaseDecisionVerificationBudget)) throw new InstallerProjectionError();
  budget.snapshot();
  try {
    const scope = EvidenceScopeSchema.parse(context.scope);
    OpaqueIdSchema.parse(id);
    if (
      ![
        "policy_record",
        "policy_presence",
        "policy_lifecycle",
        "policy_events",
        "selection_view",
        "selection_event_view",
      ].includes(projection)
    )
      throw new InstallerProjectionError();
    const response = await client.query<{ value: unknown }>(
      "SELECT public.proofstack_read_installer_projection($1::jsonb,$2,$3) AS value",
      [JSON.stringify(scope), projection, id],
    );
    const fail = (): never => {
      throw new InstallerProjectionError();
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
      value.length > 1 ||
      value.some((row) => !row || typeof row !== "object" || Array.isArray(row))
    )
      fail();
    return value as Row[];
  } catch (cause) {
    return budget.rejectSourceRead(cause);
  }
}
