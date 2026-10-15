import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createWorkflowAcceptanceReceiptVerifier,
  verifyWorkflowAcceptanceReceiptFile,
  WORKFLOW_ACCEPTANCE_RECEIPT_PREFIX as prefix,
} from "./workflow-acceptance-receipt.mjs";

const expected = {
  workflow1: true,
  releaseCandidate: true,
  releasePolicy: true,
  canonicalPolicyInputs: false,
  policyEvaluation: false,
};
const receipt = { schemaVersion: "0.2", ...expected };
const line = (value = receipt) => prefix + JSON.stringify(value) + "\n";

test("accepts one exact receipt across arbitrary byte chunks and Unicode test output", () => {
  const verifier = createWorkflowAcceptanceReceiptVerifier(expected);
  const bytes = Buffer.from("검사 출력\n" + line());
  for (const byte of bytes) verifier.write(Buffer.from([byte]));
  assert.deepEqual(verifier.finish(), receipt);
});
test("copies admitted expectations and accepts a final receipt without LF", () => {
  const options = { ...expected };
  const verifier = createWorkflowAcceptanceReceiptVerifier(options);
  options.releasePolicy = false;
  verifier.write(line().trimEnd());
  assert.deepEqual(verifier.finish(), receipt);
});
test("requires the actual policy evaluation flow when every prerequisite was requested", () => {
  const full = { ...expected, canonicalPolicyInputs: true, policyEvaluation: true };
  const fullReceipt = { schemaVersion: "0.2", ...full };
  const complete = createWorkflowAcceptanceReceiptVerifier(full);
  complete.write(line(fullReceipt));
  assert.deepEqual(complete.finish(), fullReceipt);
  const skipped = createWorkflowAcceptanceReceiptVerifier(full);
  skipped.write(line({ ...fullReceipt, policyEvaluation: false }));
  assert.throws(() => skipped.finish(), /exact requested modes/);
});
test("bounds unrelated lines and preserves the next exact receipt", () => {
  const verifier = createWorkflowAcceptanceReceiptVerifier(expected);
  verifier.write("x".repeat(5000));
  verifier.write("ignored\n" + line());
  assert.deepEqual(verifier.finish(), receipt);
});
test("accepts the exact receipt line ceiling and rejects one character over it", () => {
  const bare = line().trimEnd();
  const exact = bare + " ".repeat(4096 - bare.length);
  const valid = createWorkflowAcceptanceReceiptVerifier(expected);
  valid.write(exact + "\n");
  assert.deepEqual(valid.finish(), receipt);
  const over = createWorkflowAcceptanceReceiptVerifier(expected);
  over.write(exact + " ");
  assert.throws(() => over.finish(), /exceeds/);
});
test("rejects green output with missing or duplicated completion evidence", () => {
  const missing = createWorkflowAcceptanceReceiptVerifier(expected);
  missing.write("Tests passed\n");
  assert.throws(() => missing.finish(), /exactly one/);
  const empty = createWorkflowAcceptanceReceiptVerifier(expected);
  assert.throws(() => empty.finish(), /exactly one/);
  const duplicate = createWorkflowAcceptanceReceiptVerifier(expected);
  duplicate.write(line() + line());
  assert.throws(() => duplicate.finish(), /exactly one/);
});
test("rejects skipped, substituted, malformed and expanded mode receipts", () => {
  const values = [
    null,
    [],
    true,
    { ...receipt, schemaVersion: "0.1" },
    { ...receipt, worker: true },
    { ...receipt, releasePolicy: false },
    { ...receipt, releasePolicy: "true" },
    { ...receipt, canonicalPolicyInputs: true },
    { ...receipt, policyEvaluation: true },
    { workflow1: true },
  ];
  for (const value of values) {
    const verifier = createWorkflowAcceptanceReceiptVerifier(expected);
    verifier.write(line(value));
    assert.throws(() => verifier.finish(), /exact requested modes/);
  }
  const malformed = createWorkflowAcceptanceReceiptVerifier(expected);
  malformed.write(prefix + "{invalid\n");
  assert.throws(() => malformed.finish(), /malformed/);
});
test("requires exact boolean mode expectations", () => {
  for (const value of [
    null,
    false,
    {},
    { ...expected, extra: true },
    { ...expected, releasePolicy: "true" },
  ])
    assert.throws(() => createWorkflowAcceptanceReceiptVerifier(value), /expectations/);
});

test("reads only one bounded regular receipt and rejects missing, linked, malformed or over-byte files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "proofstack-receipt-reader-test-"));
  try {
    const filename = join(directory, "completion.json");
    const body = JSON.stringify(receipt);
    await writeFile(filename, body, { mode: 0o600, flag: "wx" });
    assert.deepEqual(await verifyWorkflowAcceptanceReceiptFile(filename, expected), receipt);
    await writeFile(filename, body + " ".repeat(4096 - Buffer.byteLength(body)));
    assert.deepEqual(await verifyWorkflowAcceptanceReceiptFile(filename, expected), receipt);
    await writeFile(filename, body + " ".repeat(4097 - Buffer.byteLength(body)));
    await assert.rejects(verifyWorkflowAcceptanceReceiptFile(filename, expected), /byte bound/);
    await writeFile(filename, "{bad");
    await assert.rejects(verifyWorkflowAcceptanceReceiptFile(filename, expected), SyntaxError);
    await writeFile(filename, Buffer.from([0xff]));
    await assert.rejects(verifyWorkflowAcceptanceReceiptFile(filename, expected), TypeError);
    await assert.rejects(verifyWorkflowAcceptanceReceiptFile(directory, expected), /regular file/);
    await assert.rejects(verifyWorkflowAcceptanceReceiptFile(join(directory, "absent"), expected), {
      code: "ENOENT",
    });
    const linked = join(directory, "linked");
    await symlink(filename, linked);
    await assert.rejects(verifyWorkflowAcceptanceReceiptFile(linked, expected), { code: "ELOOP" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("drains partial reads and preserves original and descriptor cleanup failures", async () => {
  const bytes = Buffer.from(JSON.stringify(receipt));
  const handle = () => {
    let position = 0;
    return {
      stat: async () => ({ isFile: () => true }),
      read: async (buffer, offset) => {
        if (position === bytes.length) return { bytesRead: 0 };
        buffer[offset] = bytes[position++];
        return { bytesRead: 1 };
      },
      close: async () => {},
    };
  };
  assert.deepEqual(
    await verifyWorkflowAcceptanceReceiptFile("fixture", expected, async () => handle()),
    receipt,
  );
  const cleanup = new Error("descriptor cleanup failed"),
    original = new Error("receipt read failed");
  const closeFailure = handle();
  closeFailure.close = async () => {
    throw cleanup;
  };
  await assert.rejects(
    verifyWorkflowAcceptanceReceiptFile("fixture", expected, async () => closeFailure),
    (error) => error === cleanup,
  );
  const both = handle();
  both.read = async () => {
    throw original;
  };
  both.close = async () => {
    throw cleanup;
  };
  await assert.rejects(
    verifyWorkflowAcceptanceReceiptFile("fixture", expected, async () => both),
    (error) => {
      assert.deepEqual(error.errors, [original, cleanup]);
      return true;
    },
  );
});
