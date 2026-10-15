# Native policy worker candidate reference authority

[English](workflow-2-policy-worker-authorities.md) | [한국어](workflow-2-policy-worker-authorities.ko.md)

Status: implementation prerequisite; Workflow 2 checkpoint 3 remains open (2/7 accepted).

The [separate worker](workflow-2-policy-worker-executable.md) can now supply the existing capture
composer's operator-owned candidate revision/runtime authority ports. These are reference checks,
separate from source content, semantic qualification, worker execution authority and release approval.
Without configuration, candidate authority remains unavailable and relevant outcomes indeterminate.
The worker must not turn its zero operational exit code into policy satisfaction.

Set optional `PROOFSTACK_POLICY_WORKER_AUTHORITIES_FILE` to an absolute private JSON file. The same
owner-only regular-file/no-follow/nonblocking/size/encoding/metadata checks as worker credentials
apply; use a private operator directory and mode `0600`. The ceiling is 16 MiB. It is read only after
actual service-token verification and exact execution scope authorization. Configuration and errors
are not printed. This reference POSIX composition is not a production secret store or OS sandbox.

The strict root contains three required arrays:

```json
{
  "repositories": [],
  "modelDeclarations": [],
  "runtimeAdapters": []
}
```

Empty arrays admit no references. Each array allows at most 256 entries. A repository entry is
`{ checkoutPath, repositoryUrl, scope }`, with an absolute allowlisted local checkout and the exact
tenant/project/environment. A model entry is `{ declaration, scope }` using the existing strict
`ReleaseCandidateModelDeclaration` fields. An adapter entry is `{ adapter, scope }` using the exact
`ReleaseCandidateAdapterReference`. Unknown fields, duplicate bindings and invalid whole-file data
fail initialization. Scope is never inferred from a candidate or broadened from a delivery.

The shared workspace-only `@proofstack/source-authority` adapters retain the API's exact semantics.
Local Git checks the configured object format, full commit/tree IDs, object existence and exact
commit-to-tree relation with fixed bounded commands and no network fetch. Models/adapters match
complete copied declarations within the exact configured scope. Reusing an ID, changing a digest,
switching a tenant or mutating the original options cannot add authority. The native runtime copies
the admitted port set once; initial capture and held reinspection use that same set. No HTTP
request or CLI delivery selects a repository, path, callback or command.

Replacing the file configures the next invocation. An already admitted immutable declaration set
is not a live revocation feed; its reinspection does not reread that file or attest an operator's
later configuration. Existing job cancellation, database lease/fence/expiry and explicit installed
authority contracts retain their separate roles.

Existing authority tests move with their actual temporary Git repositories and unchanged assertions.
Worker tests cover private configuration, invalid permissions/data, admission copying, CLI forwarding
and authentication precedence. The native PostgreSQL/S3 test starts the actual worker process with
a current-checkout Git subject and copied synthetic declarations, verifies both retained authority
observations, and reads back the original snapshot/result after process restart. Other missing
policy/runtime-definition prerequisites remain indeterminate: this case does not establish complete
policy satisfaction, real provider authority or loaded-code identity.

The old policy contributor's withdrawal remains required. A distinct active policy, complete real
retained graph, all seven predicate kinds/four outcomes, public SDK composition and independent exit
audit still precede checkpoint acceptance. See [ADR-0035](../architecture/0035-share-scoped-candidate-reference-authorities.md)
and the [entry audit](workflow-2-policy-evaluation-entry-audit.md).
