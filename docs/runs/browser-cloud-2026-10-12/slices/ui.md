# Browser studio and upload client evidence

Maker: browser_ui_build. Central tracking is openbrain-4pyn.3; this document is
an evidence record, not a second task list. Base f40c8c9. Shared seams read-only
updated from root74ee968,31b2667 and053402f. Actual capture tested from Capture3364491
plus mandatorya5f5732 and consolidated54153e7; these dependency commits are integrated separately by root.
No sibling checkout, shared task DB, account, deployment or physical device was
operated by this slice. Root owns independent review and release acceptance.

## Implementation

Original Rushes studio uses the existing red wordmark and focused screen/camera/
both setup. A skippable six-step spotlight guide saves permanent skip/finish,
replays from Help, and never grants permissions. Device requests happen on clicks;
camera/microphone previews, device choices and a microphone meter stop on disable,
mode change, cancellation and unmount. getDisplayMedia is invoked immediately in
the Start click, before storage/API awaits. Runtime Capture capability detection
and an explicit deployment capture-disable flag are respected.

The UI consumes the real CaptureSession/DraftStore exports. Countdown, pause,
resume, Stop, source loss, cancel and error lead to truthful local states. Bubble
position is draggable or adjusted by arrow keys, in1280×720 composition pixels;
it is baked into the recording and has no native always-on-top promise. No fake
capture, successful stub fallback or automatic device reacquisition was added.

Local review previews the composed track or each original; downloads keep WebM
extensions and include a timing manifest. Interrupted drafts show checkpoint/tail
loss limitations, retain byte downloads even if decode fails, and cannot be hosted
as completed video. Browser persistence and Choose backup folder are explicit.
The uploader is a separate operation and capture can continue when cloud fails. An unchecked-by-default private cloud backup choice is available only to entitled signed-in accounts with configured hosting. Start requests a server reservation before any encoding, while screen selection remains in the same user gesture without an awaited request. Capture receives the cloud id in its initial durable manifest. Checkpoints feed a single running/coalesced raw lane; offline failure pauses that lane, not capture. Stop automatically reconciles raw acknowledgements and sends the composed file with the existing id. Empty cancelled reservations are journaled by owner before DELETE and retried on reload/reconnection/action; saved encoded bytes and uncertain recovery data are retained.

Cloud UI consumes authoritative session/entitlement/usage responses, serves an
invite-aware Google sign-in, test Checkout/portal, opaque cursor pagination with
id deduplication, title/delete/process retry, explicit private Play, cloud composed
export, password/expiry shares and revoke. Missing configuration is visible and
unavailable actions are disabled. Payment redirects never grant entitlement.
Sign-out resets private collection state; later page responses cannot repopulate a
signed-out account. Composed export grace30days is distinguished from raw cloud
retention7days and local originals until user deletion. Current playback may last
up to12minutes after revocation; explicit Refresh playback requests a new grant.
No automatic playback renewal or unsupported hard provider invoice cap is claimed.

Upload implementation follows our pre-code design note and the official tus
core protocol (https://tus.io/protocols/resumable-upload). Raw chunks require local
size/digest checks and server acknowledgements; conflicts never overwrite. Cloud
id and each provider offset are saved locally. Retry trusts HEAD, limits PATCH to
8MiB, hashes the composed file through1MiB reads, refreshes expired grants only
through authenticated finalize, and resets offset when a new server UID is issued.
Pause aborts network work without deleting local bytes. Provider requests omit
cookies and CSRF; same-origin API mutations carry session CSRF. Provider readiness
comes from process API, not PATCH or Checkout. Cloudflare's documented iframe
player is used without a new external SDK dependency; physical provider playback
is not established by the synthetic iframe fixture.

## Verification and durable proof

Runtime: Node22.22.0. Final UI fixture run uses isolated headless Google Chrome
155.0.8059.39 on darwin, fake browser devices only, localhost, actual MediaRecorder,
worker composition and OPFS. It never opens a user's authenticated browser profile.
Earlier compatibility run used Playwright Chromium149.0.7827.55,20/20 passed.

- `npm --prefix browser run build`: TypeScript strict + Vite build exit0.
- `node --test browser/test/ui*.mjs`:26tests,26pass,0fail,0skip; exact final log
  `/Users/dave/.goal-loop/loom-clone/host/2026-10-12-browser/ui/tests-final.log`.
- UI covers guide persistence/replay, explicit devices/denial, live track release,
  keyboard/drag bubble, unconfigured states, title/share/revoke/export pending,
  private pagination, test Checkout/no redirect entitlement, password share,
  actual camera+microphone take/pause/resume/Stop/playable review/three separate
  WebM downloads, countdown cancellation, source-loss finalization, forced reload
  recovery and saved original download, damaged-metadata byte-preserving fallback, explicit cloud consent/raw chunks before Stop/offline retry, pre-encoding reservation denial and durable permission-cancel cleanup, responsive bounds at1440/1024/768/390.
- Uploader/API tests cover SHA padding/read boundaries, partially accepted tus
  request then network loss/HEAD resume, pause with retained raw acknowledgement,
  conflicting digest refusal, invalid provider acknowledgement refusal, CSRF and
  structured service errors, coalesced live checkpoint upload and paused/offline byte-preserving retry. Providers and account responses are synthetic network
  fixtures; these are protocol/UI evidence, never Stripe/Stream deployment proof.
- Screen denial uses a real browser Permissions-Policy restriction. Instrumented
  real getDisplayMedia call confirms user activation. The suite does not operate a
  physical system picker or establish physical Windows/Mac permissions.
- Explicit owned source/test/design-note clean scan first line0. Pre-code design
  scan also0. Standard boilerplate overlaps were rewritten without opening any
  forbidden reference source. No added package dependency.

Durable screenshots in the same private ui directory:studio-1440.png,
studio-1024.png,studio-768.png,studio-390.png, corresponding `-preview.png` viewport
captures, and account1440/1024/768/390. Viewport images avoid Chrome full-page
capture's repeated compositor tiles at narrow width; DOM app count remains1 and
horizontal overflow is asserted absent. Synthetic output files are the composed,
camera and microphone WebM originals named `Synthetic camera take - *.webm`.

Earlier failures are described in private `earlier-attempts.md`: stored native
fetch receiver caused false offline state, disabled anchor lacked explicit link
role, bundled headless-shell denied fake device capture, and a headless physical
picker remained pending. Repairs use bound fetch, semantic disabled link, regular
Chrome/Chromium headless profiles, and explicit browser-policy denial. Counts and
scope in the final log take precedence; no weakened success assertion was added.

## Remaining acceptance boundaries

Root separately owns physical screen selection, Windows/browser matrix, maximum
10-minute/background/5-pause/memory/sync/kill recovery probes, live configured
Google/Stripe/Stream flows, private multi-tenant server attacks, current deployed
revision and M5 spend/audience approval. This maker's26checks do not substitute for
those gates. Local-only takes use OPFS plus any chosen backup folder and retain explicit post-Stop Upload. With the optional cloud choice, each durable checkpoint is backed up during recording and composed upload starts after Stop; no silent upload happens without that choice.

## Consolidated independent-review repair

Independent verdict `2a61ab1` identified U1–U4 despite the original26 green
checks. Its unchanged failed reproductions remain in the private
`ui/independent` directory. This is the single coordinated repair pass, with no
service business-code change. Read-only dependency updates: Service7304afb and
root68c6844 payment-mode/verification-order seam. Root integrates those separately.

- U1: raw PUT now belongs to RushesAPI and obtains its current session CSRF header
  alongside the Upload capability and same-origin cookie semantics. Provider tus
  continues to omit CSRF/cookies. Actual compiled Worker + real SQLite tests show
  missing-CSRF403 with no object, then expired-grant401/fresh-grant200 with exactly
  one verified R2 object. Grant expiration is derived from the returned timestamp.
- U2: both camera/microphone acquisitions have per-device revisions, invalidated
  by explicit off, replacement, mode/start lifetime changes and unmount. Late
  streams stop immediately; stale completion cannot clear a newer busy state.
  End events apply only to the current owned device. Actual synthetic-device
  delayed-switch/off tests cover both devices and genuine React unmount.
- U3: API session reads and its cached CSRF have transition/read revisions; logout
  invalidates older work before sending, clears only on confirmed success, and
  blocks session reads during that transition. React auth epoch guards initial,
  refresh, library/page and post-upload results. Held session/library responses
  cannot restore private Sam metadata after sign-out. An older same-user session
  cannot replace newer CSRF; rejected logout retains the usable current session.
- U4: retry first reads the mapped recording under current authentication. Ready
  requires the local draft id/schema/mode and matching original chunk digests,
  sequences/byte counts. ALREADY_READY, including a provider-expiry race, triggers
  authenticated read-back/process confirmation rather than unconditional success.
  Actual Worker fixtures cover ready re-entry, lost committed process response,
  a ready transition while retrying a provider403, and failed/deleted/wrong-owner
  or mismatched-local-draft controls. Local bytes/cloud id remain unchanged.
- Billing labels follow the authoritative test/live/unconfigured mode; test
  wording appears only in test mode, and unconfigured checkout remains disabled.
  Only synthetic mode cases were exercised; live billing was never activated.

Final maker checks: Node22.22.0 strict browser build0 and owned source/test/doc
clean scan first0. `node --test browser/test/ui*.mjs` actual isolated installed
Chrome155.0.8059.39 on Mac:36/36, zero skipped,45.807s. Complete log
`/Users/dave/.goal-loop/loom-clone/host/2026-10-12-browser/ui/repair-final.log`.
The new UI service seam tests require the browser-worker dependency to be built
first; root's amended umbrella owns that order. Original failed verdict logs and
maker fixture/setup failures (`repair-ui-first.log`, `repair-ui-second.log`,
`repair-service.log`) are retained alongside their successful final probes.
The fixture errors were an unmounted-test widget outside its visible bounds,
Vite's CJS ReactDOM import shape and a15-minute grant TTL; these were corrected
without weakening production authorization or success assertions.

The last full media suite completed at approximately17:03:31UTC on2026-10-12
(log mtime), before root's17:05UTC observer-isolation capture diagnostic. No further
media run was started during that hold. Maker checks still do not establish live
provider operation, Windows physical behavior or independent repair acceptance.
