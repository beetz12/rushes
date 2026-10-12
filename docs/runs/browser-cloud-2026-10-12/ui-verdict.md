# Independent browser UI and uploader verdict

Current slice verdict: **PASS after consolidated repair**, reassessed below. The
initial FAIL and its exact failure evidence are retained as history. Overall
browser release and M1–M5 acceptance remain separately pending.

**FAIL for UI/uploader contract acceptance at `c7a73dbe4c88731fd288b5a88a2f8308453d6615`.**
The declared build and 26 UI tests pass, but four additional probes establish
consequential permission, privacy and cloud-upload gaps. These need the one
coordinated consolidated UI repair and independent reassessment. This verdict
neither alters protected acceptance nor establishes the full M1–M5 gates.

Reviewer: browser_ui_checker, 2026-10-12. Own checkout:
`/Users/dave/Work/rushes-browser-ui-review`, branch
`codex/rushes-browser-ui-review`. Reviewed integrated UI maker `8aec89a`, capture
`70ec921`, and service `fb998e8`; service's separate pending repair is outside this
snapshot. The reviewer wrote none of that implementation. Only this verdict is
changed in tracked source. No real devices, authenticated Chrome profile, shared
GUI, provider account, payment, upload, deployment or Beads mutation was used.

Inputs opened: immutable run contract, paid cloud plan and plan verdict; all UI,
API and uploader source, shared capture contracts, Capture session/storage source
and capture verdict; UI design/evidence and both `ui*.mjs` tests. Relevant actual
Worker route/CSRF/finalize/read-back code and its SQLite/R2 fixture were opened to
check the seams that the UI's mocked responses do not enforce.

## U1 — Raw backup omits the CSRF header required by the actual service

**P1, confidence 100, reproduced.** `browser/src/upload.ts:99–104`;
`browser/src/api.ts:19–35`; `browser-worker/src/index.ts:95–98,122–125`;
`browser-worker/src/auth.ts:107–111`.

The raw PUT uses same-origin cookies and an Upload capability but sends only
Authorization and Content-Type. The service authenticates and applies CSRF to
all API mutations before dispatching the raw route. Every raw PUT therefore gets
403 `CSRF`. Requesting another capability cannot repair the missing session
header. Both live backup and final stopped-take upload use this same raw lane.

Independent reproduction bundled the actual client API/uploader, compiled the
actual Worker, used its real SQLite schema and in-memory R2 fixture, and added
only Cookie/Origin transport metadata a same-origin browser ordinarily sends.
No CSRF header was injected. `/api/session`, create, chunks and grant returned
200; all three PUT retries returned 403 with `hasCSRF:false`; no R2 object was
stored. Exact script/output: private `ui/independent/service-seam.{mjs,log}`.
The existing UI upload fixture accepts raw PUT without enforcing this header;
service `storedChunk` supplies it independently. Their green results leave this
cross-package seam uncovered.

ISSUE: a binary mutation bypasses the API client's session-header mechanism.
IMPACT: configured cloud backup and composed hosting fail for every take needing
raw transfer; local bytes survive, but refreshing the account cannot fix it.
COUNTERARGUMENT: an Upload capability is scoped authority, but the immutable
contract also requires CSRF on same-origin mutations and the actual service does
not exempt raw upload. Weakening that service rule would hide the mismatch.
CLASS: every authenticated same-origin mutation must obtain current session CSRF
from one API-owned mechanism, including binary bodies; JSON alone is not the
complete class. The sibling caller is `backupDraft`, reused by `uploadDraft` and
`createLiveBackup`. Provider tus HEAD/PATCH must continue to omit those headers
and account cookies.
VERDICT: FIX.
ACTION: add an API-owned binary upload operation/current session-header seam,
use it for raw PUT, retain the capability and origin check, and cover the client
against the actual service/SQLite fixture. Prove accepted raw bytes, expiry/retry,
missing-CSRF rejection and no CSRF/cookie forwarding to tus.

## U2 — A delayed device change turns a device back on after Turn off

**P2, confidence 100, reproduced.** `browser/src/components/Studio.tsx:67–84`,
`171–172`.

Device-switch `enable` stores only the global generation. `disable` stops the
current stream without invalidating that generation, and its Turn off buttons
remain enabled while `working` is true. A pending device result therefore passes
the revision check and installs a new stream after the user's later Turn off.

Probe: explicitly enable a real synthetic Chrome camera; delay only the returned
result of a second real getUserMedia call made by the device select; click the
still-enabled Turn camera off; confirm Enable camera appears; resolve the pending
result. Observed `cameraOn:1,lateTracksEnded:false`, contrary to the off choice.
The microphone has the same code path. This probe used no physical device.
Exact test/log: private `ui/independent/review-probes.{mjs,log}`.

ISSUE: an older device request may override a later explicit off decision.
IMPACT: the camera indicator and stream restart unexpectedly; the corresponding
microphone path can retain audio access after the user turned it off.
COUNTERARGUMENT: disabling Turn off while switching would avoid this particular
button ordering, but a general request-lifetime repair also protects late results
on teardown. An explicit off choice should win.
CLASS: pending per-device acquisition must be invalidated on disable, replacement
and unmount, and stale tracks must be stopped. Camera and microphone share this
class; a camera-only patch would leave the sibling live.
VERDICT: FIX.
ACTION: use owned request revisions/cancellation semantics for both devices;
prevent stale completion/finally handlers from clearing newer busy state. Add the
actual delayed-switch/off probe for both devices and a late-result/unmount probe.
Existing explicit-click, mode change and normal teardown tests must still pass.

## U3 — A late session refresh repopulates private state after sign-out

**P2, confidence 100, reproduced.** `browser/src/main.tsx:48,78,127–132`;
`browser/src/api.ts:38`; `browser/src/components/Cloud.tsx:11,13`.

`refresh` commits its session response without an auth revision check. After
Sign out clears parent state, an older session response can set the old user back
and load the private library. Guarding only the subsequent library response by
user id cannot help: the older response has itself restored that id. API.session
also restores its CSRF state before returning to the caller.

Probe: open the signed-in fixture account; hold the Refresh account session
response; complete Sign out and observe the Sign in link; release the older
signed-in response. Observed `signOutVisible:1,privateNameVisible:1`; the private
Sam Taylor account and collection were restored. The route fixture intentionally
models a request that authenticated before logout but whose response arrived
later, rather than claiming the server session remains valid after revocation.
Exact test/log: private `ui/independent/review-probes.{mjs,log}`.

ISSUE: outdated auth reads can undo a newer explicit session transition.
IMPACT: private names/library metadata reappear in the signed-out browser UI.
This is a privacy/UI-state defect; it does not establish cross-tenant server
access or revival of a revoked session cookie.
COUNTERARGUMENT: subsequent mutations still fail server authorization, and reload
would re-query the actual signed-out state. Those protections do not satisfy the
contract and slice claim that late responses cannot repopulate signed-out state.
CLASS: all auth-derived async reads/writes need a session transition epoch, not
just equality of user id. Search results include initial/session refresh, API
CSRF mutation, private library pagination and the post-upload refresh path.
VERDICT: FIX.
ACTION: invalidate prior auth work before sign-out starts and on completed
transitions; apply only matching-epoch responses and CSRF changes. Preserve
failures visibly and do not falsely claim successful logout on a rejected server
request. Add held session and held library/page responses around logout, plus a
same-user new-session control; confirm no private state or token resurrects.

## U4 — Retry/check reports failure for a video already ready on the server

**P2, confidence 100, reproduced.** `browser/src/upload.ts:124–137,177–178`;
`browser/src/components/Review.tsx:46`; `browser/src/main.tsx:88–92`;
`browser-worker/src/records.ts:705–706`.

A local completed draft retains its cloud id and continues to expose Retry /
check cloud upload after successful hosting. uploadDraft always asks finalize;
the actual service returns `ALREADY_READY` 409 for a ready resource. The client
therefore reports “Upload needs attention” even when the server-confirmed video
is complete. The same precondition occurs if the process response is lost after
the server commits ready and the user resumes upload.

Independent probe used the actual service's authenticated ready fixture and
stored raw acknowledgement. Direct authenticated recording read-back was
`ready`; the actual uploadDraft retry returned `ALREADY_READY`/409 instead of a
ready detail. No missing-CSRF raw PUT was needed in this probe. Exact script/log:
private `ui/independent/ready-retry.{mjs,log}`.

ISSUE: idempotent retry does not reconcile an already-terminal successful result.
IMPACT: a successful cloud recording is presented as a failed upload; retry is
stuck until the person separately discovers it in Cloud library. Local data is
preserved and the successful server object remains available.
COUNTERARGUMENT: the error message itself mentions the ready library, so this is
recoverable manually. It still conflicts with the exposed check/retry behavior
and network-loss recovery contract.
CLASS: re-entry after uncertain transport outcome must read authoritative state
before starting/repeating a state transition; raw/tus acknowledgements already
follow that rule, while finalization/processing does not.
VERDICT: FIX.
ACTION: reconcile via authenticated recording/process read-back and return a
verified ready detail. Do not turn arbitrary 409 or redirect into success. Test
ready re-entry and lost process response, with failed/deleted/wrong-owner controls
and unchanged local bytes/cloud id.

## Executed gates and visual inspection

Node **22.22.0**, macOS **27.0 (26A428)**. Own unchanged reviewer checkout:

| Command or probe | Observed evidence |
|---|---|
| `npm ci --prefix browser` with pinned Node PATH | Exit 0, 32 packages, audit zero reported vulnerabilities. |
| `npm --prefix browser run build` | Exit 0; strict TypeScript and Vite production build. |
| `node --test browser/test/ui*.mjs` | Own exit 0; 26 pass, zero failed/cancelled/skipped, 16.433 seconds; isolated Playwright Chromium **149.0.7827.55**, no physical permission grants. Log `ui/independent-tests.log`. |
| `npm ci --prefix browser-worker`, `npm --prefix browser-worker run build` | Exit 0; dependency install and actual Worker build used only for seam probes. The full service gate is owned separately. |
| `node --test ui/independent/review-probes.mjs` | Own exit 1; two failed independent race assertions (U2/U3), one passed layout capture. Isolated installed Chrome **155.0.8059.39**, fake device only. |
| `node ui/independent/service-seam.mjs` | Exit 0 means the probe ran and retained the expected observed defect, not that backup passed. Actual client→Worker produced three CSRF 403s and zero raw objects. |
| `node ui/independent/ready-retry.mjs` | Exit 0 means the probe ran and retained the observed defect; direct read-back ready versus client ALREADY_READY/409. |

Private proof root:
`/Users/dave/.goal-loop/loom-clone/host/2026-10-12-browser/ui/independent`.
The independent files retain the literal reproduction and output, not production
secrets. The probes close their contexts/browser/server and SQLite fixture.

Fresh screenshots were actually opened and visually inspected, rather than
merely reported present: studio and account at **1440/1024/768/390**, scrolled
preview/controls at 1024/768/390, private video at 1440/390. All four viewport
widths also captured cloud detail and asserted no horizontal document overflow.
Desktop uses a sidebar and two-column setup; 768 stacks preview beneath setup;
390 uses compact navigation and stacked account/detail cards. Controls, permission
copy, cloud consent, pricing and downloads inspected fit their available width.
No material collision or horizontal overflow was found in those states.

Some unscrolled Chrome155 viewport images repeat a bottom compositor tile despite
one `.app` DOM node; subsequent scrolled preview images render that content
correctly. This instrument limit is retained and is not attributed to a second
app instance or accepted as evidence of real layout duplication. No mobile
recording support is inferred from compact-width layout checks. The cloud iframe
is synthetic and proves placement only, not actual private Stream playback.

## Coverage and retained release limits

The passing supplied fixtures exercise actual MediaRecorder/capture worker/OPFS
for short camera takes, countdown cancel, source loss, reload recovery and byte
fallback; explicit click permissions, guide skip/persist/replay, drag/keyboard
bubble, configuration disables, private pagination, title/share/revoke/pending
export, test Checkout without entitlement from redirect, live backup consent and
offline retry are covered. SHA read boundaries, partial tus receipt followed by
HEAD, pause, mismatched raw digest, invalid provider offset and coalesced live raw
work have meaningful assertions. The failed seam shows why independent UI and
service green suites alone are not end-to-end proof.

Static review found same-origin JSON CSRF and no-store requests, raw origin
checks, provider tus omission of session credentials, bounded body/PATCH sizes,
checkpoint/offset journaling and retained local byte fallback. Grant expiry is
reissued through authenticated API routes; HEAD remains authoritative. Fetch
signals carry 30-second API, 60-second raw and 120-second tus deadlines; their
wall-clock expiry was not waited out by this review. None of these observations
waives the four failures or claims a provider operation succeeded.

Full M1 maximum/background/minimized/five-pause/offline/process-kill/external-folder
and physical Windows/Mac picker/audio matrix remain separate acceptance.
M2–M5 live auth, processing/tenant/privacy, billing/cost operations, exact hosted
assets/CSP and paid pilot approval remain pending independently; provider/test
account fixtures cannot pass those gates. Root owns the pending static assets/CSP
configuration and the separate Service repair. No public readiness, real Google
sign-in, Stream ingestion/playback or Stripe subscription is established here.

## Reviewed file identities

Working tree was clean at the start and business source remained unchanged.

| File | SHA-256 |
|---|---|
| `browser/src/main.tsx` | `4e26616eac9773b55dec6d469ce1867d72d2be7f1ea512ed9a4233d4b8072526` |
| `browser/src/api.ts` | `60cfcef3803dd7908b78ee53d7a5e9de3ed091d76cd6e73017670ceef5dfaff5` |
| `browser/src/upload.ts` | `4e3dba856fa16fa428b9a759e58a75a09c621b7798c68bc6519c54954a061e6c` |
| `browser/src/components/Studio.tsx` | `7da2b63a8522d32cd370b428896326f769bd079799ead332bbf120ec7e2ad363` |
| `browser/src/components/Cloud.tsx` | `85572be49475f7fe83aff4d96038da84b94fe46cdeb94b519c513576d2c5e72f` |
| `browser/src/components/Review.tsx` | `e28e79327e4e961ec9e68515802f68135fb6ae0dcceb15abffec34d192f2dc82` |
| `browser/src/components/Guide.tsx` | `9f06eaa84b2155998c13acaa6cad81ddc4d0868360e0df4e833ce6fea40ef99c` |
| `browser/src/components/common.tsx` | `01b8a705b5bb35e4189cf3fa41a0f1e00184a5afdb27ebb2b79e31f4475dc6f7` |
| `browser/src/style.css` | `f36d5195bb4b86963f045a334d0f88637c3d827e9f0b5d19e1b9695e2563fa63` |
| `browser/src/contracts.ts` | `755bdb16861c9216a8a97ab7050c94f214db3b5954515a3ddb9ef9a86f4f828b` |
| `browser/test/ui-studio.test.mjs` | `586183d3768cba6530a6c68405ab47f98898cb8d142f28720495fc8e6ee07564` |
| `browser/test/ui-upload.test.mjs` | `c86724c80670c080c7ca0e2bc5fe806edf5395941b2a9179c71722abb0ea3337` |
| `docs/runs/browser-cloud-2026-10-12/contract.md` | `972f6ff0809592797c5f5d819dbc09c484d2ed74628a5ec8313b76d72424665c` |
| `docs/product/first-use-cloud-2026-10-12/cloud-plan.md` | `d789f4289b68a93e64224ce19691a0f667ac51283d25e827593b52317caa3bae` |

Review complete: findings require attention.

## Fresh reassessment after the single consolidated repair

**PASS for targeted UI/uploader slice completeness after `c762bfd68a2347f9884defda2e3b02ae3b929d20`, with overall browser release CONCERNS/PENDING.**
No blocking UI repair defect remains in the reviewed scope. The historical U1–U4
observations and failed logs above remain unchanged. Protected acceptance,
physical M1 capture reliability and the M2–M5 live provider/paid-release gates
have not been passed or weakened by this slice result.

Reassessment 2026-10-12, fresh gate/output observation at 17:13:42 UTC. Own
checkout HEAD `6474865db9c587462a288f94b02ef34a4cc2f9b0` includes read-only,
root-authorized copies of shared `68c6844` (review copy `9d95114`), UI repair
`c762bfd` (`467cc32`) and Service repair `5c11c834577d9af4e5b783412f5a829e6874732e`
(`6474865`). Root integrated equivalents were supplied as `0bb68dd` and
`5cef240`. UI and Service source are those maker revisions, not reviewer edits.
The reviewer still owns only this verdict artifact in tracked source.

| Finding | Fresh independent result and applicable repaired source |
|---|---|
| U1 | `api.ts:40–50` owns binary PUT and obtains current session CSRF, capability and same-origin cookie behavior; `upload.ts:101` calls that method. Repeating the original actual client→compiled Worker/SQLite/R2-fixture lane produced exactly one raw PUT, HTTP200 with CSRF, one object and literal matching bytes. A second backup skipped acknowledged bytes. A missing-CSRF control still returned403 before any object write. The declared integrated seam test additionally exercised expired grant401 then renewed grant200 and a single verified object. Provider tus tests still require credential omission and absence of session CSRF. |
| U2 | `Studio.tsx:38–42,75–90` gives camera and microphone owned request revisions, invalidated by off/replacement/lifetime/unmount. Repeating the original delayed real synthetic camera switch→Turn off→resolve ordering produced `cameraOn:0,lateTracksEnded:true`. The full Chromium suite also passed both device siblings and actual React unmount after a delayed acquisition. Source ownership guards prevent an old end/completion callback from replacing current device/busy state. |
| U3 | `api.ts:17–21,54–55` guards cached CSRF and account reads with auth revision/transition; `main.tsx:25,49–55,79,84–90,131–134` guards parent auth/library/page/post-upload work. The exact original held-session→confirmed logout→release probe produced `signOutVisible:0,privateNameVisible:0`. The suite also passed held private library response, older same-user session and usable-session retention after rejected logout. Additional independent API identity-replacement/pending-logout and actual React logout503 probes passed; the rejected operation retained the signed-in card and showed the error without claiming signed-out success. |
| U4 | `upload.ts:115–122,138–156,193–199` reads authenticated server state, validates matching local id/schema/mode/chunk sequence/digest/bytes, and reconciles ALREADY_READY through a read-back. The original ready fixture retry now returns its verified ready id without another finalize and without changing local metadata/bytes/cloud association. Independent wrong-owner control returned404; tampered local digest returned CLOUD_RECORDING_MISMATCH. Full actual service tests also passed lost committed process response, failed/deleted resources and a transition to ready during provider403/expiry recovery. An error code or redirect alone is never accepted as ready. |

Payment-mode seam was reviewed as well: `Cloud.tsx` derives test/live/unconfigured
wording and action availability from authoritative `billingMode`, exposed by the
Service config route. All three synthetic modes passed without requesting
Checkout or granting entitlement. This does not activate or verify live charges.

Fresh commands used Node **22.22.0** and macOS **27.0 (26A428)**. Every browser
invocation explicitly selected installed headless Chrome **155.0.8059.39** with
`RUSHES_CHROME=/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` or
the equivalent explicit executablePath in the independent script. Only fake
browser devices and isolated localhost contexts were used. Root's M1 diagnostic
hold was respected; media probes began only after root released that hold.

| Actual command/probe | Own process result |
|---|---|
| `npm --prefix browser-worker run build` after the Service copy | Exit0; strict compiler and actual Worker bundle succeeded. |
| `npm --prefix browser run build` after both repairs | Exit0; strict TypeScript and Vite succeeded. |
| `node --test browser/test/ui*.mjs`, explicit installed Chrome and `RUSHES_UI_PROOF=…/independent/repair/fixture` | Exit0; **36/36 pass**, zero failed/skipped/cancelled; 46.851 seconds. `independent/repair-ui-tests.log`. |
| Independent original race/layout probes, `node --test …/repair-review-probes.mjs` | Exit0; **3/3** pass; camera-off/logout expectations unchanged. Only output directory and new shared config field differ from the historical fixture. `independent/repair-review-probes.log`. |
| Independent API identity/transition/origin probes, `node --test …/repair-api-probes.mjs` | Exit0; **3/3** pass. New identity CSRF survives obsolete read; pending logout blocks reads/raw mutations; rejected logout preserves usable state; wrong-origin grant leaks neither capability nor CSRF; false raw acknowledgement is rejected. `independent/repair-api-probes.log`. |
| Independent actual U1/U4 seams, `node --test …/repair-seam-probes.mjs` | Exit0; **2/2** pass, including missing-CSRF/duplicate-byte/other-owner/tampered-local-digest controls. `independent/repair-seam-probes.log`. |
| Independent React logout failure, `node --test …/repair-logout-failure.mjs` | Exit0; **1/1** pass; failure visible and no false signed-out claim. `independent/repair-logout-failure.log`. |

All script/log paths are within the private proof root already named above. These
nine additional independent cases supplement the declared36; the earlier10 API
subset passed during source review and is included in those36, not a distinct
additional acceptance total. Service DB/R2/Stream fixtures remain synthetic;
actual compiled routing, CSRF and state transitions are exercised, but no live
provider writes or playback are asserted. No media/browser process from this
review remains active after these checks.

Fresh repair screenshots were captured under `independent/repair` at all four
widths. The reviewer reopened studio1440, scrolled controls1024/768/390 and
account390. Together with the initial full-width account/detail visual inspection
and unchanged stylesheet, no material collision/overflow was found. The full
suite repeated responsive document bounds at1440/1024/768/390. The earlier
Chrome screenshot/compositor caveat and absence of mobile capture support remain.

Current revised source/test identities (SHA-256):

| File | SHA-256 |
|---|---|
| `browser/src/main.tsx` | `0cb5cd0e1777193a34f51becba714dfed5f26822b1e89a36f42391bca8719a96` |
| `browser/src/api.ts` | `1abd2c112e1fb5c3471b4c5399f363523d5bcda05e40a071454c6667b9735680` |
| `browser/src/upload.ts` | `45773efda1756b18084a4fa2d20bbcd17cdc9a98f427ef161cf339afd48d5de2` |
| `browser/src/components/Studio.tsx` | `eef648d69d9086fcdd3632a12cb8db62c1d7f51356e2fefa45d24818e6e47f50` |
| `browser/src/components/Cloud.tsx` | `855c4a49a3e121da0a3c82746735c90d9eb3e6dfb4d5f2cc8b6dee4941aa84ac` |
| `browser/src/contracts.ts` | `a3077bac2f5017c5c35e763ba7f58249596a9fd71e78ad6df3aea3538ed8c2c6` |
| `browser-worker/src/index.ts` | `d95c52bdcd6e2937d5a699e39edb0a9e81eff68f5064db25923579caf6635b81` |
| `browser-worker/src/auth.ts` | `66b6d89a5d2e51ba5b886eab88e4f679fba61ec7f4dccb863e6a9cf3c23efddf` |
| `browser/test/ui-service.test.mjs` | `b4e0c3bee124460afbd20c4750c82729805a2006f754eb3ce16b9580991b33a1` |
| `browser/test/ui-studio.test.mjs` | `8d951e527e787d0cce57f648f95adf2c341218c3dd8e0700af94eea5f6817118` |
| `browser/test/ui-upload.test.mjs` | `8bc68e83af3940e7742195af6693e68df65d52e2af85969a6d53f5aff593dc83` |

Original Review/Guide/common/CSS hashes above remain unchanged. Contract and paid
plan source/acceptance remain unchanged by this repair. No follow-on feature or
second repair pass was requested. The source-level proof and original failure
probes now agree, but **the full M1 capture matrix, physical Windows/Mac behavior,
current hosted assets/CSP, live Google/Stream/Stripe, operational spending and
M5 paid-pilot approval remain root-owned release conditions.** UI code acceptance
must not be reported as a working paid public browser service.

Review complete: no material findings remain in the targeted repaired UI slice.
