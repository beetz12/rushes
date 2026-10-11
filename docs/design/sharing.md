# Original sharing services (2026-10-11)

This implementation is written from docs/PLAN.md and official HTTP/API documentation. No reference clone code was opened or copied. The file-per-share layout, early processing page, resume concept and secret-free logs follow the plan. The upload implementation is original.

The desktop main process owns credentials, decrypted from its secure store only when needed. The SDK takes credentials in memory, and writes only upload identifiers, part sizes, checksums, ETags and stable share metadata to private atomic job files. Each package receives one stable random 22-character link ID. A crashed upload keeps completed part evidence; retries first reconcile the server's part list. Four bounded readers send ten-MiB chunks and persist each successful part before continuing. Exhausted retries abort the upload; interrupted processes leave resumable jobs. Completion checks the server's object length before publishing a ready manifest.

A bucket provider uploads a processing manifest and page before media. Hashed asset names allow long media caching while the page and manifest remain uncached. All page interpolation is escaped. Deletion follows the exact share prefix, includes the page object, and confirms empty storage. Setup probes public access and range response before deletion and checks that public root does not reveal a listing.

The Worker provider speaks the same reserve/upload/publish/update/delete protocol. Worker mutations require an owner bearer token, or a short-lived upload capability tied to one exact share, exact filename, content type and byte count. R2 owns object bytes and D1 owns manifests, multipart sessions, comments, rate counters, view deduplication and password credentials. Passwords use random salts, PBKDF2-SHA256 and constant-work comparison; unlock grants are HMAC-authenticated, short lived and scoped to the share. Password responses and media use private no-store caching. All routes apply one configured origin policy and fail closed on rate-store errors. Scheduled deletion removes expired shares and their objects. Page/data fetches never count views; explicit playback events count once per client playback session.

Unverified until real configured provider QA: public reachability, cloud deployment, stop-to-link latency, browser playback on Safari/iOS, genuine social previews and expiry execution on Cloudflare. Local controlled HTTP fixtures prove protocol and security behavior only.

Primary API references opened this turn:
- https://docs.aws.amazon.com/AmazonS3/latest/API/API_CreateMultipartUpload.html
- https://docs.aws.amazon.com/AmazonS3/latest/API/API_CompleteMultipartUpload.html
- https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html
- https://developers.cloudflare.com/r2/api/workers/workers-api-reference/
- https://developers.cloudflare.com/d1/worker-api/prepared-statements/
- https://developers.cloudflare.com/workers/runtime-apis/web-crypto/
- https://docs.aws.amazon.com/AmazonS3/latest/developerguide/sig-v4-header-based-auth.html (published positive vector)
- https://developers.cloudflare.com/api/resources/workers/subresources/subdomains/methods/update/ (create absent selected account subdomain only)

The prepared existing-OAuth deploy wrapper defaults to read-only. It verifies an explicit account/email, reports missing workers.dev and disabled R2 state, and requires a selected public subdomain before apply. It never renames an existing account subdomain. Before any cloud mutations, a running app can retain the owner token through its current-user mode0600 socket, with a distinct read-back reopening encrypted settings. If the app is unavailable, AES-GCM bootstrap ciphertext authenticates its resource metadata and its key is verified in macOS Keychain; no plaintext token file is written. Real Keychain and account writes belong to root's authorized apply stage, not local fixture tests.
