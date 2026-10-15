# ADR-0035: Share scoped candidate reference authorities

Status: accepted implementation boundary; Workflow 2 checkpoint 3 remains open (2/7 accepted).

## Context

Candidate publication already checks operator-owned local Git and declared model/adapter references.
The policy capture composer supports reinspection of the same reference authorities, but the native
worker did not supply them. Operational completion therefore retained unavailable candidate
authority, independently of any other missing evidence. A positive rule result must not bypass it.
The worker cannot depend on the API executable, and the core ports and policy acquisition package
must retain their existing dependency boundaries.

## Decision

Move the existing adapters and their unchanged real-Git tests into the workspace-only infrastructure
package `@proofstack/source-authority`. Keep the API composition facade and exported names stable.
The new package depends on contracts/core and the existing pinned Zod version; production external
imports are restricted to Zod and Node process/path/util. API and worker depend on this package;
there is no reverse edge, SQL/object/key/publication port or generic shell execution interface.
Keep the adapter's measured 100% coverage thresholds in its new package.

The optional operator-owned `PROOFSTACK_POLICY_WORKER_AUTHORITIES_FILE` is read only after actual
service-token scope/execution authorization. Reuse the private bounded POSIX file reader. Strict
data contains at most 256 repositories, model declarations and adapters each, with exact nested
schemas/scopes and duplicate rejection. The native runtime copies the admitted port set once and
forwards it to the existing capture/sealing composer, including held reinspection. A delivery cannot
select a path, repository URL, command, callback or authority configuration. Missing configuration
retains unavailable authority and indeterminate results; nothing grants new execution capability.

## Alternatives

- Importing API composition into the worker would couple separate executables and expose unrelated
  application composition to a worker that only needs reference ports.
- Duplicating the adapters would require parallel fixes and security tests for the same semantics.
- Moving Git process spawning into core or the policy acquisition package would erode their
  application/port and production-import boundaries. The narrow infrastructure package preserves them.

## Consequences

The dependency graph gains one small package and two explicit acyclic workspace edges; frozen
installation and contributor builds must include it. Git reads remain local, fixed, time/output
bounded and exact commit-to-tree checks. Static declarations prove configured reference availability,
not loaded executable bytes, provider identity, reviewer expertise or production isolation. References
are observed again under the existing sealing transaction; historical observations do not authorize
later source publication, approval, release or deployment. Full contributor/exit gates remain open.
