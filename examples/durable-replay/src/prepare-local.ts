import {
  createLocalBucketClient,
  parseLocalArtifactStorageEnvironment,
  prepareLocalArtifactBucket,
} from "./local-storage.js";

const clientConfig = parseLocalArtifactStorageEnvironment(process.env);
const client = createLocalBucketClient(clientConfig);

try {
  const status = await prepareLocalArtifactBucket(clientConfig, client);
  process.stdout.write(
    `${JSON.stringify({ bucket: clientConfig.bucket, endpoint: clientConfig.endpoint, status })}\n`,
  );
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : "The local artifact bucket setup failed closed"}\n`,
  );
  process.exitCode = 1;
} finally {
  client.destroy();
}
