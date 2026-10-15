import { randomUUID } from "node:crypto";
import type { PolicyEvaluation } from "@proofstack/contracts";
import { ServiceTokenAuthenticator } from "@proofstack/identity";
import { FilePolicyWorkerCredentials } from "./file-credentials.js";
import { loadPolicyWorkerAuthentication, loadPolicyWorkerRuntimeConfig } from "./config.js";
import {
  createPostgresPolicyWorkerRuntime,
  createS3PolicyWorkerArtifacts,
} from "./postgres-runtime.js";
import { runPolicyWorkerAttempt } from "./attempt.js";

interface CliDependencies {
  readonly environment: NodeJS.ProcessEnv;
  readonly execute: typeof runPolicyWorkerAttempt;
  readonly createRuntime: typeof createPostgresPolicyWorkerRuntime;
  readonly writeOutput: (value: string) => void;
  readonly writeError: (value: string) => void;
}
const defaults: CliDependencies = {
  environment: process.env,
  execute: runPolicyWorkerAttempt,
  createRuntime: createPostgresPolicyWorkerRuntime,
  writeOutput: (value) => {
    process.stdout.write(value);
  },
  writeError: (value) => {
    process.stderr.write(value);
  },
};
function countOutcomes(evaluation: PolicyEvaluation | null) {
  if (evaluation === null) return null;
  const counts = { satisfied: 0, violated: 0, indeterminate: 0, not_applicable: 0 };
  for (const rule of evaluation.rules) counts[rule.outcome]++;
  return counts;
}

/** One finite authenticated delivery. A zero exit is an operational completion, never approval. */
export async function runPolicyWorkerCli(
  arguments_: readonly string[],
  overrides: Partial<CliDependencies> = {},
): Promise<number> {
  const dependencies = { ...defaults, ...overrides };
  if (arguments_.length !== 4 || arguments_[0] !== "execute") {
    dependencies.writeError(
      "Usage: proofstack-policy-worker execute <project-id> <environment-id> <job-id>\n",
    );
    return 64;
  }
  try {
    const authentication = loadPolicyWorkerAuthentication(dependencies.environment);
    let idleFailure = false;
    const result = await dependencies.execute(
      {
        serviceToken: authentication.token,
        requestId: `request_policy_${randomUUID().replaceAll("-", "")}`,
        delivery: {
          schemaVersion: "0.1",
          projectId: arguments_[1],
          environmentId: arguments_[2],
          jobId: arguments_[3],
        },
      },
      {
        authenticator: new ServiceTokenAuthenticator(
          new FilePolicyWorkerCredentials(authentication.credentialsFile),
        ),
        nextId: (kind) => `${kind}_${randomUUID().replaceAll("-", "")}`,
        createRuntime: async (scope, principal) => {
          const config = await loadPolicyWorkerRuntimeConfig(dependencies.environment);
          return dependencies.createRuntime(
            { scope, principal },
            {
              databaseUrl: config.databaseUrl,
              ...(config.databaseRole === undefined ? {} : { databaseRole: config.databaseRole }),
              allowPlaintextLoopback: true,
              catalogues: config.catalogues,
              ...(config.candidateAuthorities === undefined
                ? {}
                : { candidateAuthorities: config.candidateAuthorities }),
              onIdleError: () => {
                idleFailure = true;
              },
              openArtifacts: async () =>
                createS3PolicyWorkerArtifacts(config.objects, config.encryption),
            },
          );
        },
      },
    );
    if (idleFailure) throw new Error("Policy worker pool reported an idle failure");
    dependencies.writeOutput(
      JSON.stringify({
        schemaVersion: "0.1",
        disposition: result.disposition,
        scope: result.job.request.scope,
        job: {
          jobId: result.job.job.jobId,
          definitionSha256: result.job.job.definitionSha256,
          status: result.job.job.status,
        },
        snapshot: result.job.job.snapshot,
        result: result.job.job.result,
        ruleOutcomes: countOutcomes(result.evaluation),
      }) + "\n",
    );
    return result.job.job.status === "completed" ? 0 : 2;
  } catch {
    // Causes can contain credentials, key material, paths or provider responses. Never print them.
    dependencies.writeError(
      "Policy worker command failed; inspect the exact job and private configuration.\n",
    );
    return 1;
  }
}
