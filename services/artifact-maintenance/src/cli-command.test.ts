import type { ArtifactMaintenanceConfig } from "./config.js";
import type { ArtifactMaintenanceRunResult } from "./runtime.js";
import { describe, expect, it, vi } from "vitest";
import {
  type ArtifactMaintenanceCliDependencies,
  runArtifactMaintenanceCli,
} from "./cli-command.js";

const CONFIG: ArtifactMaintenanceConfig = {
  batchLimit: 10,
  command: "key-status",
  databaseUrl: "postgresql://artifact@127.0.0.1:5432/proofstack",
  deploymentEnvironment: "test",
  keyring: {
    activeKeyId: "key_primary",
    keys: { key_primary: new Uint8Array(32).fill(1) },
  },
  scope: {
    environmentId: "env_test",
    operatorPrincipalId: "svc_artifact_maintenance",
    projectId: "prj_test",
    tenantId: "ten_test",
  },
};

const OK_OUTCOME: ArtifactMaintenanceRunResult = {
  command: "key-status",
  result: { activeKeyId: "key_primary", keys: [] },
  status: "ok",
};

function dependencies(
  overrides: Partial<ArtifactMaintenanceCliDependencies> = {},
): ArtifactMaintenanceCliDependencies {
  return {
    loadConfig: vi.fn(() => CONFIG),
    run: vi.fn(async () => OK_OUTCOME),
    writeError: vi.fn(),
    writeOutput: vi.fn(),
    ...overrides,
  };
}

describe("artifact maintenance CLI", () => {
  it.each([[[]], [["unknown"]], [["retention", "extra"]]] as const)(
    "returns usage error for arguments %#",
    async (arguments_) => {
      const runtime = dependencies();

      await expect(runArtifactMaintenanceCli(arguments_, runtime)).resolves.toBe(64);
      expect(runtime.writeError).toHaveBeenCalledWith(expect.stringContaining("Usage:"));
      expect(runtime.loadConfig).not.toHaveBeenCalled();
      expect(runtime.run).not.toHaveBeenCalled();
    },
  );

  it("prints one stable JSON line and returns zero for success", async () => {
    const runtime = dependencies();

    await expect(runArtifactMaintenanceCli(["key-status"], runtime)).resolves.toBe(0);
    expect(runtime.loadConfig).toHaveBeenCalledWith("key-status");
    expect(runtime.run).toHaveBeenCalledWith(CONFIG);
    expect(runtime.writeOutput).toHaveBeenCalledWith(`${JSON.stringify(OK_OUTCOME)}\n`);
    expect(runtime.writeError).not.toHaveBeenCalled();
  });

  it("prints the result and returns two when operator attention is required", async () => {
    const outcome: ArtifactMaintenanceRunResult = { ...OK_OUTCOME, status: "attention" };
    const runtime = dependencies({ run: vi.fn(async () => outcome) });

    await expect(runArtifactMaintenanceCli(["key-status"], runtime)).resolves.toBe(2);
    expect(runtime.writeOutput).toHaveBeenCalledWith(`${JSON.stringify(outcome)}\n`);
  });

  it("returns one and reports a bounded error path", async () => {
    const runtime = dependencies({
      run: vi.fn(async () => {
        throw new Error("migrations are pending");
      }),
    });

    await expect(runArtifactMaintenanceCli(["key-status"], runtime)).resolves.toBe(1);
    expect(runtime.writeError).toHaveBeenCalledWith(
      "Artifact maintenance failed: migrations are pending\n",
    );
    expect(runtime.writeOutput).not.toHaveBeenCalled();
  });

  it("does not stringify unknown thrown values", async () => {
    const runtime = dependencies({
      loadConfig: vi.fn(() => {
        throw { secret: "must-not-be-printed" };
      }),
    });

    await expect(runArtifactMaintenanceCli(["key-status"], runtime)).resolves.toBe(1);
    expect(runtime.writeError).toHaveBeenCalledWith(
      "Artifact maintenance failed: Artifact maintenance failed\n",
    );
  });
});
