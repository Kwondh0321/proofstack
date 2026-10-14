# Bounded object reads for policy worker composition

[English](workflow-2-policy-bounded-object-reads.md) | [한국어](workflow-2-policy-bounded-object-reads.ko.md)

Status: adapter prerequisite; Workflow 2 checkpoint 3 remains open (2/7 accepted).

`createS3BoundedArtifactReader` creates a dedicated read-only object port with SDK
`maxAttempts=1`. Ordinary S3 stores retain their default three attempts. An explicit general
client attempt option accepts only integers 1–3; the dedicated factory always forces one.
The reader exposes `get` and `destroy`, without object publication or deletion methods.

Trusted composition supplies the validated reference's expected encrypted byte length and an
abort signal. Inputs are checked before sending and copied before awaiting the response. The
request uses `Range: bytes=0-(expectedBytes-1)`. The response must declare exactly that length;
if ContentRange is present, it must also declare the complete object with exactly that total.
A valid prefix of a larger object is rejected. Only HTTP 200/206 are accepted, and a partial
206 response must include the complete range. Malformed or oversized metadata is rejected
before body allocation or consumption. The existing stream reader rejects excess, truncated
or non-byte chunks, releases rejected responses and validates an available SHA-256 checksum.

The existing finite connect/request/socket timeouts apply. An already aborted read does not
send; a response arriving after abort is released. Abort during an unfinished HTTP body closes
the actual connection. A failed/missing read does not authorize an implicit retry. Each later
physical read still needs fresh [durable admission](workflow-2-policy-artifact-admission.md).

Unit checks cover exact and invalid bounds, whole-object geometry, option mutation, abort
cleanup and unchanged legacy operations. A disposable HTTP endpoint proves one request for
a retryable 503 response and socket closure before fixture cleanup. Pinned SeaweedFS integration
covers exact, shorter/longer expected lengths, missing objects and all existing store cases.
These checks do not establish provider honesty or production authorization.

This adapter does not independently validate artifact ciphertext identity, AAD, retention,
worker scope, lease or publication authority; owning artifact readers and repositories still
provide those checks. Optional trusted `artifactByteAdmission.objectReader` accepts this port.
Its owning acknowledgement binds the native lease/attempt/job cut. The composition floors remaining
milliseconds and subtracts monotonic time starting before reservation; it refuses expired reads,
aborts cooperative reads at expiry and rejects late or incorrectly sized responses. Charges remain.
It requires a cooperative bounded reader; arbitrary callbacks ignoring abort are not certified.
The factory alone does not establish that worker composition. It does not measure every partial
network byte or hidden transport allocation;
rejected chunks may already have arrived before stream validation. Full worker-wide metadata,
record, reference and guarded reinspection admission remains open. Neither this adapter nor
a completed read is a policy verdict, approval, release authority or checkpoint acceptance.
