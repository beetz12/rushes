# Independent commercial service verdict

**FAIL for this code candidate.** Three reproduced failures break verified provider cleanup or the atomic budget ledger. Repair the consolidated set below before accepting the service slice. A passing repair review still cannot establish live M2–M5 provider, billing or launch gates.

Reviewed candidate: `fb998e846e0a8a2816397b3c49de740d91551956`, branch `codex/rushes-browser-service-review`, independently checked on 2026-10-12 in `/Users/dave/Work/rushes-browser-service-review`. Review type: implementation against the paid plan and immutable browser contract, base `853ff16`. One independent service reviewer; this reviewer wrote no business code. This report owns only this artifact. No provider/account mutation, credentials, deployment, GUI action, recording or shared task-tracker write occurred.

Inputs opened: `docs/runs/browser-cloud-2026-10-12/contract.md`, paid cloud plan and its independent plan verdict, service slice evidence, original service design, `browser-worker/README.md`, all ten `browser-worker/src/*.ts`, schema/forward/manual rollback migration, build/package/config surfaces, shared browser contracts, service fixtures and tests. The service checkout contains the capture/scaffold candidate, not the final integrated UI. Therefore the static-header findings below are source-level evidence, not a deployed Vite/iframe end-to-end result. No forbidden/copyleft reference code was opened.

## Required repairs — one consolidated maker pass

### F1 · P1 · A database failure after provider creation leaves an orphan and false completed deletion

Confidence: 100. Relevant source: `browser-worker/src/records.ts:816–821`, `browser-worker/src/cleanup.ts:45–59`, `browser-worker/src/cleanup.ts:73–77`.

The provisioning lease is persisted before Stream creation, but mapping the successful provider response is outside the creation error handler. If that database write throws, the recording remains `uploading` with `stream_uid=NULL`, `error=NULL` and a durable `provision_id`. After the lease and abandonment window, cleanup only reconciles creator-associated assets when `error==='STREAM_CREATE_UNCERTAIN'`. It therefore skips the actual provider asset, reports maintenance `complete:1,pending:0`, marks the recording `deleted` and releases the upload/library reservation.

Independent reproduction uses the normal authenticated raw/finalize flow, injects one exception at the UID-mapping database write after the provider fixture has created its asset, then advances the clock 25 hours and **awaits the scheduled maintenance promise**. Observed row before maintenance: `uploading`, null UID/error, lease present. Observed after maintenance: `deleted`, null cleanup error, **one provider asset still present**. The cleanup invariant assertion fails `1 !== 0`.

Repair must recover from the durable provision marker even if the worker stops or the attempt to record an error also fails. Preserve quarantine and the allowance until exact trusted creator/UID association and provider absence are verified. Do not rely only on a catch block successfully setting an error string, infer absence from a lost response, or declare cleanup complete while recovery is unproven. Exercise a true post-create/pre-mapping interruption, failed mapping, and failed cleanup read-back. The fixture does not prove this orphan contains recorded footage or persists past the real provider's expiry; the supported failure is missing provider read-back and premature `deleted`/reservation release.

### F2 · P1 · An upstream HTTP 5xx is treated as a definite non-creation and retry duplicates assets

Confidence: 99. Relevant source: `browser-worker/src/providers.ts:70–75`, `browser-worker/src/records.ts:798–808`.

Every unsuccessful HTTP status from the non-idempotent create request becomes `STREAM_CREATE`. Finalization treats that code as definite, clears the provision lease and allows another create. An HTTP 5xx is insufficient proof that a remote creation had no side effect. This undermines the contract's uncertain-creation quarantine and can hold provider capacity outside the application's single reserved slot.

Independent reproduction lets the normal provider fixture create its private asset, then substitutes an HTTP 503 response. First finalize returns 503 with `state='failed',error='STREAM_CREATE',has_lease=0`; retry returns 200. Observed **two creation attempts and two provider assets**, while the recording maps only the second UID. The no-duplicate assertion fails `2 !== 1`.

Classify transient/ambiguous create outcomes as uncertain, retain durable quarantine and reconcile the exact creator association before retry or deletion. Only a documented definitely rejected request may clear that state. Change the existing definite-failure fixture accordingly; retain separate negative coverage for 5xx, transport loss, incomplete headers and interruption after successful creation. An idempotency guarantee must come from the actual provider API rather than a locally invented key.

### F3 · P1 · Calendar rollover charges one month and releases another

Confidence: 100. Relevant source: `browser-worker/schema.sql:156–167` (same forward migration), `browser-worker/src/shares.ts:251–269`, `browser-worker/src/budget.ts:14`.

Delivery insertion records an immutable `budget_month`, but its reserve trigger increments the mutable global `budget_settings.month_start`. A concurrent new-month request advances that settings row while an old-month request waits. If the old request's provider token mint fails, `undelivered_released` subtracts from its immutable old month, which was never charged. The old ledger becomes negative and the new month retains an unissued reservation. The operation reserve and delivery reserve also land in different months.

Independent reproduction pauses the October playback database batch, advances two seconds across November UTC midnight, issues a successful ten-second beta playback, then resumes the October alpha batch with a failed token mint. Tenant fixtures use valid extended sessions/entitlements; no authentication bypass is added to the service. Observed global ledgers: **October `delivery_seconds=-10`; November `delivery_seconds=20`** although November has only one successful ten-second grant. The assertion for the failed October grant fails `-10 !== 0`.

Charge, cap-check and release the same immutable month in a single atomic reservation. Ensure that month's ledger exists, add nonnegative ledger constraints, and cover both successful and failed old-month/new-month interleavings. Apply an equivalent correction to schema and forward migrations; already-created databases require an explicit upgrade rather than an `IF NOT EXISTS` trigger silently remaining old.

## Verification and bounded findings

| Command/probe | Actual result |
|---|---|
| Pinned Node 22.22.0 `npm ci --prefix browser-worker` | Exit 0; dependency install completed. |
| `npm --prefix browser-worker run check` in the same pinned runtime | Exit 0; typecheck/build, **49 tests passed, 0 failed**. Independently rerun and retained in `check.log`. |
| `python3 -I tools/checks/check_clean.py browser-worker/src browser-worker/schema.sql browser-worker/migrations browser-worker/test/fixtures.mjs browser-worker/test/service.test.mjs docs/design/browser-service-tenancy.md` | Exit 0; first stdout line **0**, inspected. |
| `cmp browser-worker/schema.sql browser-worker/migrations/0001_browser_service.sql` | Exit 0; equal before repair. |
| Independent `node --test .../service-review/probe.mjs` | **Exit 1: 1 pass, 3 fail**. The three failures are F1–F3 above; they are not a passing acceptance suite. |
| Additional browser-header control in that independent probe | Valid authenticated GET playback succeeds without an Origin header when `Sec-Fetch-Site: same-origin`; the same request with `cross-site` is rejected 403. No Origin regression found. |

The supplied tests exercise real SQLite transactions/foreign keys/triggers and actual RSA/HMAC checks, while provider/R2/clock behavior remains fixture-controlled. Their passing paths, together with source inspection, support tenant predicates on recording routes, server-built raw prefixes, raw capability/body/digest checks, one-isolate raw PUT admission and durable write leases, OIDC signature/claims/one-use state, session rotation/revocation, invite/account cap, CSRF mutation checks, private initial tus metadata, provider readiness/duration/creator checks, subscription reconciliation instead of redirect/event-order authority, refund/dispute/operator suspension, explicit policy-bound password shares, delivery/concurrency checks, owner individual export grace, bounded pagination and ordinary retention/read-back cleanup. These are code-level propositions with the F1–F3 exceptions above; this report does not claim exhaustive absence of other defects.

The generic response wrapper strips caching, sets no-referrer, HTTPS/HSTS, nosniff and a CSP allowing same-origin module workers/blob media plus the Stream iframe/upload hosts (`platform.ts:227–241`). Secrets are read from server bindings, absent from static browser contracts, and no request query/body/credential logger is present in these service sources; the one maintenance log emits aggregate counts (`index.ts:258–261`). Fixture success does not establish provider-origin anonymity, actual iframe playback, a working production OAuth app, test-mode Stripe identity, or that Vite assets match the deployed API revision.

## Evidence identity

Private proof directory: `/Users/dave/.goal-loop/loom-clone/host/2026-10-12-browser/service-review` (0700). `probe.mjs` contains the exact original fault/interleaving reproductions; `probe.log` contains their substantive output and failed contract assertions. An initial attempt at F1 did not await the scheduled job; it was corrected before the retained final log and before any finding was issued as final. The retained result above includes `deleted` and completed maintenance, with no asynchronous-after-test error.

| Artifact | SHA-256 |
|---|---|
| Independent probe | `4ddd4828f0b4c22229457b7eb4bd4c75d3ddc4910b9ba06495cd39e3d3e8340b` |
| Independent final probe log | `edf78c89ea71792d4173ea1d546f1937016e235695812b1a6c30cd5d5085e317` |
| Contract | `972f6ff0809592797c5f5d819dbc09c484d2ed74628a5ec8313b76d72424665c` |
| Schema/forward migration, each | `f2644a43028410e1e053a90d900d35a29f38c5c66fd98163bb62aeff6f0b3038` |
| `records.ts` | `325155e5081cb2de4db34bf47751fdfdfd30e0bd014288dc21f44498229df507` |
| `providers.ts` | `adafe4dd88d294b42db0861eb2996462c5283d7a5de0d23a142024eadaaa97b1` |
| `cleanup.ts` | `79f3c99c30f9bd156a6ca4bef03b0231620e7242d63c0009ad86e23be75f70e3` |
| `shares.ts` | `d29b2f3f3618c84a7f1ddfce7d3df08f9a390692feda849b6b7d087cadb2f0ba` |

Required disposition: one consolidated service maker repair and fresh independent replay against the resulting exact revision. No live provider gate or paid-launch criterion is relaxed by these fixes. Missing real configured auth/library, private Stream ingestion/read-back/playback, NexAI Stripe test-mode read-back, provider-metrics reconciliation, practical replay exposure, alert/restore exercise and separately approved M5 audience/live mode/spend remain root-owned external conditions.
