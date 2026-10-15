import { StringDecoder } from "node:string_decoder";
import { constants } from "node:fs";
import { open } from "node:fs/promises";

export const WORKFLOW_ACCEPTANCE_RECEIPT_PREFIX = "PROOFSTACK_ACCEPTANCE_RECEIPT ";
const fields = [
  "workflow1",
  "releaseCandidate",
  "releasePolicy",
  "canonicalPolicyInputs",
  "policyEvaluation",
];
const keys = ["schemaVersion", ...fields].sort().join(",");
const maxLineCharacters = 4096;

/** Bounded completion evidence; a green child that skipped its requested mode must fail. */
export function createWorkflowAcceptanceReceiptVerifier(expected) {
  if (
    expected === null ||
    typeof expected !== "object" ||
    Object.keys(expected).sort().join(",") !== [...fields].sort().join(",") ||
    fields.some((field) => typeof expected[field] !== "boolean")
  )
    throw new TypeError("Workflow acceptance receipt expectations are invalid");
  const admitted = { ...expected };
  const decoder = new StringDecoder("utf8");
  let line = "",
    overflow = false,
    count = 0,
    failure,
    receipt;
  const consumeLine = () => {
    if (line.startsWith(WORKFLOW_ACCEPTANCE_RECEIPT_PREFIX)) {
      count++;
      if (overflow) failure = "Workflow acceptance receipt exceeds its line bound";
      else {
        try {
          const value = JSON.parse(line.slice(WORKFLOW_ACCEPTANCE_RECEIPT_PREFIX.length));
          if (
            value === null ||
            typeof value !== "object" ||
            Array.isArray(value) ||
            Object.keys(value).sort().join(",") !== keys ||
            value.schemaVersion !== "0.2" ||
            fields.some(
              (field) => typeof value[field] !== "boolean" || value[field] !== admitted[field],
            )
          )
            failure = "Workflow acceptance receipt did not complete the exact requested modes";
          else receipt = value;
        } catch {
          failure = "Workflow acceptance receipt is malformed";
        }
      }
    }
    line = "";
    overflow = false;
  };
  const consume = (text) => {
    const parts = text.split("\n");
    for (const [index, part] of parts.entries()) {
      const remaining = maxLineCharacters - line.length;
      if (part.length > remaining) overflow = true;
      line += part.slice(0, remaining);
      if (index < parts.length - 1) consumeLine();
    }
  };
  return {
    write(chunk) {
      consume(decoder.write(typeof chunk === "string" ? Buffer.from(chunk) : chunk));
    },
    finish() {
      consume(decoder.end());
      if (line.length) consumeLine();
      if (failure) throw new Error(failure);
      if (count !== 1) throw new Error("Expected exactly one workflow acceptance receipt");
      return receipt;
    },
  };
}

/** Read only the invocation's private, exclusively created, bounded regular-file receipt. */
export async function verifyWorkflowAcceptanceReceiptFile(filename, expected, openFile = open) {
  const handle = await openFile(
    filename,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  let failed = false,
    failure,
    receipt;
  try {
    if (!(await handle.stat()).isFile())
      throw new Error("Workflow acceptance receipt is not a regular file");
    const buffer = Buffer.alloc(4097);
    let bytes = 0;
    while (bytes < buffer.length) {
      const read = await handle.read(buffer, bytes, buffer.length - bytes, null);
      if (read.bytesRead === 0) break;
      bytes += read.bytesRead;
    }
    if (bytes > 4096) throw new Error("Workflow acceptance receipt file exceeds its byte bound");
    const verifier = createWorkflowAcceptanceReceiptVerifier(expected);
    verifier.write(WORKFLOW_ACCEPTANCE_RECEIPT_PREFIX);
    verifier.write(
      JSON.stringify(
        JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(buffer.subarray(0, bytes))),
      ),
    );
    receipt = verifier.finish();
  } catch (error) {
    failed = true;
    failure = error;
  }
  try {
    await handle.close();
  } catch (error) {
    if (failed)
      throw new AggregateError([failure, error], "Receipt verification and cleanup failed");
    throw error;
  }
  if (failed) throw failure;
  return receipt;
}
