# Rushes browser upload client

Original design recorded before implementation, 2026-10-12. Inputs: the reviewed
Rushes paid cloud plan, shared browser contract, and the official tus 1.0 core
protocol at https://tus.io/protocols/resumable-upload (opened this turn). No
reference application source was inspected or copied.

Capture commits bytes through DraftStore independently of network work. Upload
is a later explicit action on a stopped recording. A local manifest journals its
server recording identifier before sending any bytes. Retry asks the server for
acknowledged track/sequence/digest tuples and never replaces local originals.
For missing chunks, the server grants a scoped PUT capability. The client checks
its local byte count and digest, and advances only on a positive acknowledgement.
A differing acknowledged digest is a conflict, not permission to overwrite.

After original backup, the client hashes the composed file incrementally using
fixed-size reads. Finalize selects the provider resource on the server and returns
an expiring upload URL. The manifest saves its UID, URL, expiry and offset before
transmission. HEAD establishes the authoritative remote offset after every retry;
a local offset is only a checkpoint. Sequential PATCH bodies are at most 8 MiB.
A successful response must acknowledge the exact next offset. Network failure or
409 causes another HEAD rather than blindly repeating bytes. URL expiry returns
to authenticated finalize; it never invents a provider URL or provider identity.
Provider requests carry no account cookies or CSRF token. Shared API mutations
carry the session CSRF header and never accept a client-selected tenant or price.

Pause aborts pending network work but keeps local chunks and journals. Resume
restarts the same idempotent operation. Retry is bounded within one invocation;
errors remain visible and require Retry if exhausted. Process readiness comes
from the server, never from completing PATCH or a payment redirect. Raw backup,
composed transfer and provider processing have distinct progress states. A cloud
failure does not end capture or delete its local data.

Tests will use isolated synthetic network routes: accepted raw chunks surviving
retry, partial provider receipt before disconnection, lost responses, invalid
acknowledgements, digest disagreement, URL expiry and pause. These tests establish
client protocol behavior only, not provider deployment or real processing.

Live backup uses the same raw protocol after an explicit unchecked-by-default
choice. Start initiates a trusted server reservation; screen selection still runs
in the same user gesture without awaiting the network. Encoding waits for both
permission and reservation. Capture receives the cloud identifier in its initial
manifest, so checkpoints retain the trusted association without racing core saves.
One running raw sync and one boolean pending checkpoint coalesce updates; media
bytes stay in DraftStore, never in an upload queue. Failure pauses this network
lane, not capture. Online/explicit retry continues from server acknowledgements.
Stop flushes that lane and reuses the same id for composed upload. Empty cancelled
reservations are journaled locally before DELETE, with owner-bound reload/online
retry. Saved encoded bytes keep their cloud association and recovery path.
