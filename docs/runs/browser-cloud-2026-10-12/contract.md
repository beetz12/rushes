# Rushes browser cloud implementation contract

Owner: root. Tracker: central Bead openbrain-4pyn. Base: 853ff16.
User authorized building the reviewed paid browser plan on 2026-10-12.
Plan: docs/product/first-use-cloud-2026-10-12/cloud-plan.md and plan-verdict.md.

## Outcome

People on desktop Chrome on Windows and Mac can record a screen, camera or both
without downloading an application, review/download separate originals, recover
durable local chunks, and use a private paid account library with resumable cloud
upload, explicit sharing and server-enforced subscription/usage controls.
The personal Worker and installed native Mac recorder remain independent.

Implementation proceeds in this chat. Capturing and local download work even
before provider configuration; hosting requires a signed-in entitled account.
This follows the reviewed optional paid hosting model, and is not a free cloud tier.
No live payment, vendor purchase or public paid launch is implied by a passing
local fixture. Those actions require the concrete M5 review and approval.

## Inventory and ownership

The existing personal worker/src/index.ts uses OWNER_TOKEN and share lookup by
id only. cloud/src/types.ts accepts filesystem paths. Neither is a tenant/browser
SDK. New browser/ and browser-worker/ packages are required. worker/test/fixtures.mjs
uses actual SQLite for D1 and is an exemplar, not an auth environment to inherit.
Existing viewer/ assumes prepared MP4 playback. Native capture is Apple-specific.
Root inventoried package/config/build/notices references: scripts/check.sh,
tools/checks/check_notices.py, its negative-control tests, THIRD_PARTY_NOTICES.md,
licenses/ and .github/workflows/ci.yml need new-surface coverage or a browser CI job.

| Slice | Owned files | Read-only inputs |
|---|---|---|
| Root/shared/integration | browser/src/contracts.ts, browser/package*.json, browser/.nvmrc, browser/tsconfig.json, browser/vite.config.ts, browser/index.html, browser/test/contracts.test.mjs; browser-worker/package*.json, browser-worker/.nvmrc, browser-worker/tsconfig.json, browser-worker/build.mjs, browser-worker/test/contracts.test.mjs, browser-worker/scripts/**, browser-worker/wrangler.jsonc; scripts/**, tools/checks/**, THIRD_PARTY_NOTICES.md, licenses/**, .gitignore, .github/**, docs/runs/browser-cloud-2026-10-12/**, browser/README.md | Existing native/personal packages |
| Capture | browser/src/capture/**, browser/test/capture*.mjs; docs/runs/browser-cloud-2026-10-12/slices/capture.md | Shared contracts, package/config, paid plan |
| Service | browser-worker/src/**, browser-worker/schema.sql, browser-worker/migrations/**, browser-worker/test/** except contracts.test.mjs, browser-worker/README.md, browser-worker/.env.example; docs/runs/browser-cloud-2026-10-12/slices/service.md | Shared browser contracts, package/config, personal Worker exemplars |
| UI | browser/src/main.tsx, browser/src/components/**, browser/src/api.ts, browser/src/upload.ts, browser/src/style.css, browser/test/ui*.mjs; docs/runs/browser-cloud-2026-10-12/slices/ui.md | Shared contracts and capture APIs |

Every added helper stays under its slice prefix. Contract or ownership changes
require root coordination. Writers use separate worktrees from the exact wave-zero
commit; cherry-pick integration. Never edit a sibling checkout or shared Beads DB.

## Shared seams

The single browser-safe type owner is browser/src/contracts.ts. All consumers
import it. Times in manifests are milliseconds; quota durations are seconds;
storage is bytes. IDs are opaque strings. API errors are `{error:{code,message}}`.
Dates are ISO UTC strings. No vendor/owner credential or arbitrary tenant/object
key is accepted as browser authority. A cloud recording id is separate from the
local draft id. The browser persists local manifests before remote acknowledgments.

Capture exports from browser/src/capture/index.ts:
`createCaptureSession(inputs: CaptureInputs): Promise<CaptureSession>`.
Inputs contain already granted streams; permission requests belong to explicit UI
clicks. Session exposes composed preview, start/pause/resume/stop/cancel/setBubble.
Capture exports storage from browser/src/capture/storage.ts:
`createDraftStore(backup?: FileSystemDirectoryHandle): Promise<DraftStore>`.
The optional backup handle is chosen only by an explicit Choose backup folder click.
Chunk append acknowledges only after durable write/close and digest verification.
Wave-zero throw-only seams are replaced by Capture before any final acceptance.

Same-origin API (JSON unless stated). Session cookies are HttpOnly/Secure/SameSite,
mutation requests use `X-CSRF-Token`; external webhooks are separately verified.
Auth endpoints: GET /auth/google/start, GET /auth/google/callback.

| Route | Input | Success shape |
|---|---|---|
| GET /api/config | none | BrowserConfig |
| GET /api/session | none | SessionResponse |
| POST /api/logout | {} | {ok:true} |
| GET /api/recordings | none | LibraryResponse |
| POST /api/recordings | CreateRecordingInput | RecordingDetail |
| GET /api/recordings/:id | none | RecordingDetail |
| PATCH /api/recordings/:id | {title:string} | RecordingDetail |
| DELETE /api/recordings/:id | none | {state:'deleting'|'deleted'} |
| POST /api/recordings/:id/chunks/grant | ChunkGrantInput | ChunkGrant |
| PUT /api/recordings/:id/chunks/:track/:sequence | bytes with Authorization: Upload <token> | {acknowledged:true} |
| GET /api/recordings/:id/chunks | none | {chunks:ChunkDescriptor[]} |
| POST /api/recordings/:id/finalize | FinalizeInput | {upload:UploadGrant,state:'uploading'} |
| POST /api/recordings/:id/process | {} | RecordingDetail |
| GET /api/recordings/:id/playback | none | PlaybackGrant |
| POST /api/recordings/:id/share | ShareInput | {id:string,url:string,expiresAt:string|null} |
| DELETE /api/recordings/:id/share | none | {ok:true} |
| GET /api/shares/:id | none | {id,title,durationMs,passwordRequired:boolean,expiresAt:string|null} |
| POST /api/shares/:id/unlock | {password:string} | {ok:true} with short policy-bound cookie |
| POST /api/shares/:id/playback | {} | PlaybackGrant |
| POST /api/billing/checkout | {} | {url:string} |
| POST /api/billing/portal | {} | {url:string} |
| POST /api/billing/webhook | Stripe raw body + signature | {received:true} |

## Invariants and protected acceptance

- 10-minute/720p/30 target; Chrome desktop first; no claimed Safari/Firefox/mobile
  support. Runtime capability detection and actual tested versions are recorded.
- Device permission only on explicit click; browser screen picker on every take.
  Denial/cancel returns to setup. Streams released after stop/error/cancel/unmount.
- Separate originals plus composed recording with one epoch/offset/pause manifest.
  Background composition uses frame-driven worker processing, not suspended rAF.
  Chrome's Window processor/generator streams are transferred to a dedicated
  OffscreenCanvas worker; other APIs require detected support, not assumed names.
- OPFS journal with ordered/digested chunks; optional each-chunk closed backup
  files; reload recovers interrupted drafts without silently resuming capture.
  Storage/encoder failure stops safely and preserves saved bytes. Normal finalized
  files decode; interrupted bytes are retained even when reconstruction fails.
- All server resources/keys/jobs are tenant scoped; wrong-tenant IDs return 404.
  Sessions rotate/revoke; OIDC issuer/audience/signature/state/nonce/expiry verified.
  Invitation allowlist and account cap. No production test-login/provider bypass.
- Atomic idempotent reservations enforce 100 upload/300 retained/1000 delivery
  minutes/month and 2 GB active raw ceiling. No silent overage charges.
- Stream assets private from creation; server binds UID before tus URL return.
  Provider readiness/duration decides ready. Raw uploads hash/size/scope verified;
  duplicate sequence with different digest conflicts. No anonymous upload/import.
- Stripe server-selected $15 monthly price and hosted Checkout/portal. Raw-body
  signature and idempotent retries; reconcile current subscriptions despite
  duplicate/out-of-order events. Redirect never grants entitlement.
- Private first; explicit password/expiry share; playback token lifetime bounded,
  delivery reserve and kill switch; no advertised hard provider invoice cap.
  Deletion revokes immediately, provider cleanup completes only after read-back.
  Raw seven-day/abandoned 24-hour/account export grace policies have clock tests.
- Personal worker/cloud/viewer APIs, URLs and desktop capture remain unchanged.
  Do not copy/open forbidden reference code. Only permitted dependency licences.

## Waves and done commands

Wave zero: root commits contracts/scaffolding; both new package builds succeed.
Wave one: [P] Capture, Service, UI each implements and tests owned paths and commits.
UI consumes scaffold names, never fake runtime capture; its actual acceptance waits
for Capture integration. M1 failure blocks external account/billing launch, even if
independent service design/code is complete. No maker grades its own outcome.

Capture Verify: Node 22.22.0 `npm --prefix browser run build` and
`npm --prefix browser run test:capture`; actual Chromium MediaRecorder, worker
composition, OPFS/reload, controls, source loss/no audio, and synthetic sync media.
Root separately runs maximum take with five pauses, offline/background/minimized
checks, decode probe and measured limits. Windows/Mac CI runs the same browser
fixture; physical screen-picker validation is recorded separately, never inferred.

Service Verify: Node 22.22.0 `npm --prefix browser-worker run check`; actual SQLite
schema/two tenants, swapped-ID attacks on every applicable route, CSRF/revocation,
concurrent last-quota, grants/replay/digest/oversize, provider failures/readiness,
Stripe signatures/duplicates/out-of-order/retry, cleanup clock/read-back fixtures.

UI Verify: Node 22.22.0 `npm --prefix browser run build` and
`node --test browser/test/ui*.mjs`; walkthrough skip/persist/replay, explicit media
buttons/cancel/setup, draggable composition bubble, controls/review/download,
upload pause/resume/retry, account/library/payment paths and responsive inspection.

Final gate command: `/bin/bash scripts/check.sh` after root extends it for both
new packages. Preserve failed logs outside run state. Root reruns every slice Verify,
then fresh read-only per-slice reviewers and one complete base..HEAD adversarial
review. At most one targeted slice repair pass before integration reassessment;
two identical failing approaches trigger research, not weakened tests.

## Provisioning and live gates

Root prepares a separate rushes-browser Worker, rushes-browser-data D1 and
rushes-browser-raw private R2 using David's verified Cloudflare account. Reverify
Wrangler email/account before mutations. No change to rushes-share resources.
Google OAuth/Stripe account choices are pending user input; local capture and
test-mode integration proceed independently. Secrets stay in private local files
or provider secret bindings. Exact Stream/Workers paid activation and live Stripe
mode are final M5 approval artifacts, including spend, audience and residual risk.

Deployment acceptance: exact Worker/assets revision, HTTPS config/session/page,
real configured auth plus data-backed private library, upload/processing/playback
and billing test-mode provider read-back after restart. Fixtures cannot satisfy
missing production credentials. If a provider gate is pending, retain/ship all
completed independent work and name the precise release condition honestly.

## State

Task statuses live solely in central Beads. This file is the immutable contract;
slice evidence and run-log are proof records, not a duplicate task tracker.
Private proof root: ~/.goal-loop/loom-clone/host/2026-10-12-browser (0700).
Agent runtime uses native collaboration tools; no detached runner or user chat
creation. Root serializes shared tracker writes, integrates commits, runs gates,
ships under the repository default-branch release policy and syncs verified output.
