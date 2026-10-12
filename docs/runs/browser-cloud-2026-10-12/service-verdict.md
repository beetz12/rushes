# Independent commercial service verdict

**Current code disposition: PASS for the consolidated F1–F4 repair reassessment of service `5c11c834577d9af4e5b783412f5a829e6874732e`.** Paid launch remains blocked by capture feasibility and external outcome gates. The independently rerun evidence and precise scope appear in the reassessment below; the original failure history is retained.

**Initial candidate: FAIL.** Four reproduced failures broke verified provider cleanup, the atomic budget ledger or logout revocation. A passing repair review cannot establish live M2–M5 provider, billing or launch gates.

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

### F4 · P1 · Successful logout leaves an overlapping rotated session authenticated

Confidence: 100. Relevant source: `browser-worker/src/auth.ts:113–157`, `browser-worker/src/auth.ts:183–189`.

Root requested this additional server probe after the independent UI checker found a late session-response race. Client generation guards alone cannot revoke a cookie already issued by the server. Rotation inserts an unrelated replacement token and revokes the old hash; logout revokes only the hash its request authenticated. If logout authenticates first, then a concurrent aged `/api/session` rotates before logout's UPDATE executes, logout returns 200 while that replacement token remains live. Its late Set-Cookie can restore authenticated authority even when the client discards the response DTO.

Independent reproduction uses the normal seven-hour-old session, pauses logout at its old-token UPDATE **after ordinary authentication and CSRF have passed**, completes the session refresh with two replacement cookies, then resumes logout. Observed: logout **200**, refreshed-cookie `/api/session` returns `account-alpha`, and the protected library returns **200** rather than 401. The old token is revoked but the replacement is live. The control in which logout commits before a new refresh passes: no replacement cookies, `user:null`.

Repair must atomically revoke the applicable session lineage/generation, and prevent an in-flight refresh authenticated against an earlier generation from creating fresh authority after revocation. An account revocation epoch is an alternative only if stale-auth insertion is gated too and an explicit fresh Google login can create a new valid session. Include the proven overlap and the ordering where rotation commits before logout authenticates with the ancestor cookie; the existing router currently rejects that logout while the new session can remain live. Preserve CSRF checking for logout and reject arbitrary revoked tokens on ordinary authenticated routes. Add a real SQLite interleaving regression; client response-discard assertions do not prove this server property.

## Verification and bounded findings

| Command/probe | Actual result |
|---|---|
| Pinned Node 22.22.0 `npm ci --prefix browser-worker` | Exit 0; dependency install completed. |
| `npm --prefix browser-worker run check` in the same pinned runtime | Exit 0; typecheck/build, **49 tests passed, 0 failed**. Independently rerun and retained in `check.log`. |
| `python3 -I tools/checks/check_clean.py browser-worker/src browser-worker/schema.sql browser-worker/migrations browser-worker/test/fixtures.mjs browser-worker/test/service.test.mjs docs/design/browser-service-tenancy.md` | Exit 0; first stdout line **0**, inspected. |
| `cmp browser-worker/schema.sql browser-worker/migrations/0001_browser_service.sql` | Exit 0; equal before repair. |
| Independent `node --test .../service-review/probe.mjs` | **Exit 1: 1 pass, 3 fail**. The three failures are F1–F3 above; they are not a passing acceptance suite. |
| Additional directed `node --test .../service-review/logout-race.mjs` | **Exit 1: 1 pass, 1 fail**. F4 restores server authority after successful logout; committed-logout-first control passes. |
| Additional browser-header control in that independent probe | Valid authenticated GET playback succeeds without an Origin header when `Sec-Fetch-Site: same-origin`; the same request with `cross-site` is rejected 403. No Origin regression found. |

The supplied tests exercise real SQLite transactions/foreign keys/triggers and actual RSA/HMAC checks, while provider/R2/clock behavior remains fixture-controlled. Their passing paths, together with source inspection, support tenant predicates on recording routes, server-built raw prefixes, raw capability/body/digest checks, one-isolate raw PUT admission and durable write leases, OIDC signature/claims/one-use state, ordinary sequential session rotation/revocation, invite/account cap, CSRF mutation checks, private initial tus metadata, provider readiness/duration/creator checks, subscription reconciliation instead of redirect/event-order authority, refund/dispute/operator suspension, explicit policy-bound password shares, delivery/concurrency checks, owner individual export grace, bounded pagination and ordinary retention/read-back cleanup. These are code-level propositions with the F1–F4 exceptions above; this report does not claim exhaustive absence of other defects.

The generic response wrapper strips caching, sets no-referrer, HTTPS/HSTS, nosniff and a CSP allowing same-origin module workers/blob media plus the Stream iframe/upload hosts (`platform.ts:227–241`). Secrets are read from server bindings, absent from static browser contracts, and no request query/body/credential logger is present in these service sources; the one maintenance log emits aggregate counts (`index.ts:258–261`). Fixture success does not establish provider-origin anonymity, actual iframe playback, a working production OAuth app, test-mode Stripe identity, or that Vite assets match the deployed API revision.

## Evidence identity

Private proof directory: `/Users/dave/.goal-loop/loom-clone/host/2026-10-12-browser/service-review` (0700). `probe.mjs` contains the exact original fault/interleaving reproductions; `probe.log` contains their substantive output and failed contract assertions. An initial attempt at F1 did not await the scheduled job; it was corrected before the retained final log and before any finding was issued as final. The retained result above includes `deleted` and completed maintenance, with no asynchronous-after-test error.

| Artifact | SHA-256 |
|---|---|
| Independent probe | `4ddd4828f0b4c22229457b7eb4bd4c75d3ddc4910b9ba06495cd39e3d3e8340b` |
| Independent final probe log | `edf78c89ea71792d4173ea1d546f1937016e235695812b1a6c30cd5d5085e317` |
| Additional logout-race probe | `6b4ff967e1d75ebe2fbcaa2cfe5887173c61617663f0788ccb7c783d0e1e2f80` |
| Additional logout-race log | `edf0a5e43e07a5443c495fbaa41169e4c7f78e5f3c7bf97a1d85c595d93ff0ea` |
| Contract | `972f6ff0809592797c5f5d819dbc09c484d2ed74628a5ec8313b76d72424665c` |
| Schema/forward migration, each | `f2644a43028410e1e053a90d900d35a29f38c5c66fd98163bb62aeff6f0b3038` |
| `records.ts` | `325155e5081cb2de4db34bf47751fdfdfd30e0bd014288dc21f44498229df507` |
| `providers.ts` | `adafe4dd88d294b42db0861eb2996462c5283d7a5de0d23a142024eadaaa97b1` |
| `cleanup.ts` | `79f3c99c30f9bd156a6ca4bef03b0231620e7242d63c0009ad86e23be75f70e3` |
| `shares.ts` | `d29b2f3f3618c84a7f1ddfce7d3df08f9a390692feda849b6b7d087cadb2f0ba` |

Required disposition: one consolidated service maker repair and fresh independent replay against the resulting exact revision. No live provider gate or paid-launch criterion is relaxed by these fixes. Missing real configured auth/library, private Stream ingestion/read-back/playback, NexAI Stripe test-mode read-back, provider-metrics reconciliation, practical replay exposure, alert/restore exercise and separately approved M5 audience/live mode/spend remain root-owned external conditions.

## Consolidated repair reassessment — 2026-10-12

**PASS for the bounded service code repair.** No unresolved F1–F4 reproduction remains against the reviewed revision. This is not a browser recorder, deployment, live account/provider or paid-launch pass.

Exact maker revision: `5c11c834577d9af4e5b783412f5a829e6874732e`; root reports integration at `5cef240`. On the independent review branch, shared root seam `68c6844` was cherry-picked as `a6d1288`, then **only** the service repair was cherry-picked as `41d3481703850f5d44d879b9a5709f56562c98d1`. A direct `git diff 5c11c834 HEAD -- browser-worker/src browser-worker/schema.sql browser-worker/migrations browser-worker/test browser-worker/README.md` was empty, establishing equality of reviewed service paths despite different commit ancestry. Initial FAIL artifacts `b6558f8` / `1c3c4c3` and private failing probes/logs remain unchanged. This reviewer made no business-code edits.

| Finding | Independent corrected result and source |
|---|---|
| F1: post-create mapping/crash uncertainty | Original injected mapping failure now retains UID/lease plus uncertainty; verified maintenance removes its creator-associated provider asset before `deleted`, with zero assets remaining. The service's new tests additionally pass mapping **and error-write** failure, a real child `SIGKILL` between provider creation and mapping, failed provider deletion/read-back, and incomplete creator-list coverage. `records.ts:711–715` rejects another create while a durable provision marker exists; `cleanup.ts:44–69` reloads persisted ownership and reconciles marker/uncertainty/unmapped finalization rather than relying on an error-write succeeding. `providers.ts:172–210` checks exact creator and complete counts. New creator keys are 64 hex characters, versioned by the stored finalization marker; legacy associations keep their original key. |
| F2: HTTP failure ambiguity | Original side-effect-then-503 probe now returns uncertainty on both attempts, **one create and one provider asset**. Source only treats explicit structured validation/auth rejection as definite; 5xx, transport loss and malformed mapping remain quarantined. Service regression tests pass each outcome and exact cleanup before allowance release. |
| F3: immutable budget month | Original paused October batch / successful November mint / failed October mint now leaves **October 0 seconds, November 10 seconds**. Source captures one reservation timestamp and charges/checks/releases its immutable month (`shares.ts:236–269`, `schema.sql:161–182`). Service tests also pass the inverse failure ordering. Upgrade `0002` explicitly replaces the old trigger, reconstructs the reserve from durable delivery rows and rejects negative counters. |
| F4: logout versus session rotation | Original success-logout/late-cookie reproduction now yields `user:null` and protected library **401**. Rotation CAS, successor insertion and ancestor revocation share a SQLite transaction (`auth.ts:133–176`); authentication requires an unrevoked current family (`auth.ts:84–90`). CSRF-valid ancestor logout revokes the whole applicable family (`auth.ts:213–227`) while ordinary routes still reject revoked ancestors. Extra original reviewer probes independently pass ancestor logout after committed rotation, wrong-CSRF rejection, stale-auth insertion blocked after committed logout, a fresh RSA-verified Google login after revocation, and preservation of a separately verified device login family. |

The first independent repair replay had **6 tests, 6 pass, 0 fail**: all original provider/month/control probes plus both logout schedules. Its only test-harness adaptations are extending the newly required family's absolute expiry alongside sessions in the controlled month-boundary fixture, and pausing the new observed family-revocation SQL instead of the removed token-only update. No security outcome assertion was relaxed. The original failing scripts/logs remain untouched; adapted copies are `repaired-probe.mjs` and `repaired-logout-race.mjs`.

The additional independent `family-migration-probe.mjs` has **5 tests, 5 pass, 0 fail**, with real SQLite and RSA signing. It runs the five behaviors in the F4 table row and the migration check below. Google provider exchange/certs remain controlled fixtures: this proves server claim/signature handling, not a real Google account login.

### Upgrade and fresh-schema checks

The extra independent probe applied the actual top-level `0001` → `0002` → `0003` files to SQLite. A seeded pre-family session was revoked with `family_id=NULL`; inserts lacking a verified family are rejected. The resulting named tables/indexes/views/triggers match the latest fresh schema, and every normalized trigger body is equal. Negative insert/update counters are rejected in both paths. Against the upgraded database, real API session rotation, CSRF-valid ancestor logout, invalid successor authority and a fresh verified OIDC login all pass; `PRAGMA foreign_key_check` is empty.

This is behavioral/object/trigger parity, **not byte-identical table declarations**: the upgraded family column remains nullable for the deliberately revoked legacy rows, while the fresh schema uses NOT NULL; the required-family trigger protects subsequent inserts in both. Fresh budget tables add CHECK clauses while upgraded tables obtain the equivalent tested trigger guards. Migration `0003` is intentionally applied once through the migration ledger, not rerun as a bootstrap schema.

Root's deployment script at `5cef240:browser-worker/scripts/deploy.mjs` was read, without executing it. It enumerates top-level numbered SQL files, rejects an existing database without an understood ledger, uses Wrangler `d1 migrations apply`, verifies every expected migration in remote ledger read-back before deploying and then checks revision/config. This supports the deployment design only; no actual remote migration/restore/deployment was performed by this reviewer. One integration configuration caveat was sent to root: the deployment preflight permits `rk_` Stripe credentials while the service config accepts `sk_`; use the accepted credential type or align that preflight before enabling hosting. It does not alter this service repair disposition.

### Fresh commands and evidence identity

| Command | Actual result and retained file |
|---|---|
| Pinned Node 22.22.0 `npm --prefix browser-worker run check` | Exit **0**, typecheck/build and **67/67 tests**, including the real process interruption and independent-family/fresh-login cases; `repair-check.log`. |
| Pinned `node --test repaired-probe.mjs repaired-logout-race.mjs` | Exit **0**, **6/6**; `repaired-originals.log`. |
| Pinned `node --test family-migration-probe.mjs` | Exit **0**, **5/5**; `family-migration-probe.log`. |
| Clean scanner on repaired service source, schema/migrations, fixtures, old/new service tests, crash fixture and original design | Exit **0**, first stdout line **0** inspected; `repair-clean.log`. |
| Exact service-path diff against maker `5c11c834` | Exit **0**, empty output. |

All private repair proof is in the existing 0700 `.../2026-10-12-browser/service-review` directory; proof files are 0600. SHA-256 identities:

| Artifact | SHA-256 |
|---|---|
| `repair-check.log` | `cf5e241569202b7ced5bb09aa6f982dda691a53e2c6a97b9b7e6d3587c49d995` |
| `repair-clean.log` | `9a271f2a916b0b6ee6cecb2426f0b3206ef074578be55d9bc94f6f3fe3ab86aa` |
| `repaired-probe.mjs` | `0177cbef15822e0d1556833bc3c45e8246b20b4fe7c1c17010c3ec3e6d0d9e46` |
| `repaired-logout-race.mjs` | `dbdecab5f19eb4d4dd51c9f11b115d6f514acc06918bc9131d2c677b5ccc0926` |
| `repaired-originals.log` | `28356a22d301a8911cae14430866c1bd32c10293cf7496e13454c31a0b189bff` |
| `family-migration-probe.mjs` | `1587f0683273f43aff5f097bfea3301ea4efee9b6433740a05da14aa44af8f03` |
| `family-migration-probe.log` | `c70943fc23c483a34cf03ccb4bf5009a190155a960011d7c1411d5defccd46c2` |
| Repaired `auth.ts` | `66b6d89a5d2e51ba5b886eab88e4f679fba61ec7f4dccb863e6a9cf3c23efddf` |
| Repaired `records.ts` | `85c9913a7871f8116f5d51cd9fca6ca2ede539c492b84824fd6bb42a265e2b3a` |
| Repaired `cleanup.ts` | `871e3f169bda83361d19b4c937c264ed0bc992f2d60c135d95599f3029a0945a` |
| Repaired `providers.ts` | `3df0ea69a35b399d30927632a1bbaad8ad439ba7396c4191c8896fb1e699de0f` |
| Fresh cumulative `schema.sql` | `4418d962f49aee9b22db6ccf099c4a8dc897a00cbd95e4965899b158754d288b` |
| Upgrade `0002` | `8d5753b46233d5d962d22192c81b30c7d4be061e56610b3bdc557461ac9d7d87` |
| Upgrade `0003` | `3229673ced41e892e8373b588bb3a814072ed4ba083598cf581a19c72277bc66` |

**Release boundary unchanged.** Root reports a capture M1 diagnostic failure at 146 seconds; this service lane did not run or independently verify that capture diagnostic and does not issue an M1 pass. The reviewed paid plan forbids selling or treating provider/account progress as capture-feasibility evidence. Real configured account/library isolation, private Stream origin/ingestion/playback/export read-back, NexAI Stripe test-mode/provider read-back, provider invoice/metrics and replay exposure, operational alerts/restore, exact deployed assets/revision and separately approved audience/live mode/spend still require their own fresh outcome evidence. Code fixture PASS does not permit a paid launch or relax any of those criteria.
