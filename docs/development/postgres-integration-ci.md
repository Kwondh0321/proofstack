# PostgreSQL integration build handoff

[English](postgres-integration-ci.md) | [한국어](postgres-integration-ci.ko.md)

The independent PostgreSQL CI uses a separate **PostgreSQL integration build** job so dependency
compilation does not consume the native test job's original 15-minute allowance. Both jobs remain
required. The exact seven preparation filters, bounded build concurrency, frozen installation,
pinned services, seven serial integration targets, assertions and test timeouts are unchanged.
The full quality job still builds and checks the complete workspace separately.

Preparation packs only generated `dist` directories under the workspace package/application roots
plus the source SHA. It excludes dependency trees and Next caches. An immutable, attempt-specific
artifact is passed by its exact numeric ID through the required job output, within the same run.
The test job checks the archive's SHA-256 against the preparation job output before extraction and
requires the embedded source SHA to equal its checkout. Missing output, altered bytes or a wrong
source fail the job. A failed-job rerun can consume the original successful preparation output;
it does not select a mutable latest artifact or overwrite an earlier build artifact.

Upload/download actions are pinned to reviewed Node 24 action commits. The build artifact contains
no installed dependencies, runtime credential files, operating databases or test service volumes.
This transfer is CI build preparation, not a product backup, snapshot publication or release seal.
It adds no test retries and does not turn a cancelled run into a successful result.
