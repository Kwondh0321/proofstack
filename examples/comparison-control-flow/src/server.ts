import { createComparisonLab } from "./lab-app.js";

const host = "127.0.0.1";
const port = 3010;

const server = createComparisonLab();
server.listen(port, host, () => {
  process.stdout.write(`ProofStack comparison lab: http://${host}:${port}\n`);
});
