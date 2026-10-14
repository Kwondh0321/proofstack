# Policy job history, reservations and atomic intents

[English](workflow-2-policy-job-history.md) | [한국어](workflow-2-policy-job-history.ko.md)

Status: memory scheduler prerequisite. Workflow 2 checkpoint 3 remains open (2/7 accepted).

Each committed memory job version retains one append-only entry with exact scope/job reference,
native UTC receipt, fixed operation facts, predecessor entry/graph hashes and resulting graph hash.
Owning request and job digests are revalidated before graph hashing. Transition replay independently
derives claim, heartbeat, reservation, interruption, reclaim, cancellation and history exhaustion
from the preceding graph; a correctly rehashed but substituted delta, scope, fence or resulting
graph is rejected. History integrity does not establish current database authority or revive a lease.

The fixed history domain is `proofstack.policy-evaluation-job-history.v1`. Independent Python
JSON/UTF-8/hashlib vectors use ASCII keys/strings and exact safe integers, with no floating-point
or provider assertions. Creation is 667 bytes
(`6bd5b8248282337bfabb3202885abb74298986f8ff44fcf71da15401aba36736`), claim 943 bytes
(`617cda6ee3df6e0e90b62e9d590b3a8f9f874cf103416655ee93258ba6206c2a`) and reservation 1,111
bytes (`af2b01862c3f24a8bd37ef985e2600d190c69bb55d3d5101f511bda4eeb25249`). These are synthetic
metadata, not an executed native worker, source-authority proof or sealed snapshot.

History has a fixed 100,000-entry ceiling, separate from the original request's cumulative work
limits. The final slot is reserved for operational terminal state. If an otherwise admitted
operation would consume that slot while leaving the job active, the store instead retains
`history_limit` and `budget_exhausted` / `budget_limit_reached`, closes any open latest attempt,
preserves spent work/request/snapshot and adds the canonical terminal intent. It starts no new
attempt or physical reservation. Invalid or stale operations still fail before this transition.
An ordinary terminal cancellation or timeout may use the last slot directly.

History pages retain an independently requested exact head, contiguous original sequence and
predecessor links, with 100 entries per page, 4 KiB per entry and a 512 KiB page ceiling. Oversized
arrays are rejected before child inspection. A retained older head continues to return its original
prefix after later transitions; reads never silently substitute the current head. The compact job
response remains separate and bounded at 64 KiB. Native SQL/wire/read admission and job-wide charging
for history reads are still required; materialized page checks do not interrupt pending I/O.

`reserveWork` binds a server-runtime reservation identity to exact job/scope/live worker fence and
delta. An identical retry returns `created: false` and the original reservation; changed work
conflicts wholly. Scope plus job identity separates equal IDs in different jobs. The live fence,
current epoch and strict expiry check precede even an idempotent lookup. A retained receipt cannot
revive an expired worker. Every new physical work occurrence needs a fresh reservation and
`created: true`; an ambiguous acknowledgement conservatively leaves its charge in place. The
runtime must not start another physical I/O operation from an existing receipt. The older
`reserveUsage` port creates and charges a fresh occurrence on every call.

The memory repository commits graph, fixed history page/head and canonical outbox intents together
after all validation and deterministic replay. A request retry or repeated cancellation appends
nothing and preserves original receipts. Creation, cancellation request and terminal intents contain
bounded identities, digests, actor/reason/status and original receipts; they contain no classified
artifact bytes, credentials, policy disposition, approval or release action. Missing or conflicting
canonical intent and substituted final history scope/job/page are rejected on reads and retries.
Reservation lookup indexes update synchronously with the same in-memory mutation, with no await or
external I/O between validated writes. Memory restart still loses these records.

Control and worker use cases depend on separate repository interfaces. This type separation does
not substitute for authentication: internal history head/page reads require `policy:read` before
body parsing or repository access, bind the head to the authorized route's exact scope/job and
reject substituted heads or page indexes. HTTP/SDK history transport remains unimplemented.
Interface separation alone does not enforce database grants. The subsequent
[PostgreSQL operational ledger](workflow-2-policy-job-postgres.md) adds normalized storage,
separate optional role grants and owner recovery at a forward store epoch. Held snapshot publication,
pure predicates, immutable result and
atomic result/outbox commit, authenticated API/SDK history transport and a physical worker remain
open. No caller snapshot/result save, public worker identity or publication from an ended read-only
recheck is introduced. Continue the [entry audit](workflow-2-policy-evaluation-entry-audit.md),
[job contract](workflow-2-policy-job-contract.md) and
[memory scheduler](workflow-2-policy-memory-scheduler.md) before independent checkpoint exit.
