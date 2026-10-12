---
node: N4
skill: graph-design
graph: rushes-first-use-cloud
run: 2026-10-12
inputs: [graph.md, facts.md, sources.md, research-onboarding.md, docs/PLAN.md, README.md, cloud/README.md, worker/README.md, cloud/src/types.ts, cloud/src/worker-provider.ts, worker/src/bindings.ts, worker/src/index.ts, viewer/src/viewer.ts, primary sources S-N4-7 through S-N4-37, root live health observation]
status: passed
---

# Paid Rushes in the browser: proposed launch contract

**Recommendation:** build a separate browser recorder for short walkthroughs, using Chrome on desktop, with private account libraries and an optional paid hosting subscription. Keep the existing Mac recorder and personal share service working. Prove browser composition, recovery, tenant isolation and cost controls before selling access. This is a plan for review; no service purchase, billing activation, account provisioning or deployment is authorized by this artifact.

All product limits, pricing, thresholds and milestones below are **proposals**, not existing behavior or tested guarantees. Vendor prices were opened on **2026-10-12**, are in USD, and need rechecking before purchase. Source coverage is the listed local surfaces and official documentation; there was no private capture, customer-account audit or credential inspection in this research lane.

## 1. What exists and what is missing

The repository describes a local macOS recorder with separate screen, camera, microphone and system-audio originals; sharing sends an exported MP4 and selected sidecars. The SDK's inputs are filesystem paths and its Worker provider uses a single owner bearer credential. It cannot be dropped into a public web client as an account SDK. [S-N4-1] [S-N4-3]

The existing Worker stores share manifests in D1 and media under `s/<share-id>/` in R2. Owner-authenticated routes reserve, upload, publish, edit policy and delete. Upload parts already use expiring capabilities scoped to a share, upload, part, MIME type and byte count. Password unlock, expiry checks, feedback and media range responses are useful foundations. Its ownership model is one `OWNER_TOKEN`; share lookup has no account predicate. A per-file maximum is not a tenant storage or subscription quota. [S-N4-4] [S-N4-5]

The viewer plays a prepared MP4 with optional captions, transcript and chapters. It is a viewer, not a recorder or signed-in library. The old Phase 7 sketch proposed accounts, tenant storage, a dashboard and quotas, and explicitly excluded billing. This new proposal adds browser capture and billing without rewriting that historical scope. [S-N4-2] [S-N4-6]

| Term | Meaning here | Current evidence |
|---|---|---|
| Cloud sharing | A local app uploads a derived video; another person watches a web link. | Implemented in these source files; live root verification is recorded separately. |
| Browser-only recording | A website requests browser capture permission, encodes locally, then uploads; no app or extension installation. | New capture pipeline required. |
| Server recording | A server records a remote stream, meeting bot or remote browser. | Outside this MVP; a server does not gain access to a visitor's screen simply because the visitor signed in. |

**Personal deployment:** root's fresh `GET https://rushes-share.nexai-rushes.workers.dev/health` at **2026-10-12T11:20:19.729Z** returned HTTP 200 and `{ok:true,service:"rushes-share"}`. This establishes endpoint reachability only. It does not establish fresh authenticated R2/D1 read-back, browser recording, billing, multi-tenancy or successful recent publication. Those product gaps are grounded in the inspected implementation above. [S-N4-LIVE-health]

## 2. Product evidence and the first recording

Loom documents a desktop app and a Chrome extension. The extension lets a user choose full screen, window, current tab or camera only, check the camera and microphone, and start recording. Its documented camera-bubble limitations include other applications and PDFs. Its system-audio guide distinguishes tab audio in the extension from other application audio in the desktop app. These sources do not establish an ordinary standalone Loom website recorder. [S-N4-7] [S-N4-8]

There is separate official evidence for **embedded** browser capture: Loom's recordSDK documents screen/camera recording inside third-party sites without a user install. That documented SDK is limited to selected desktop browsers, 720p and a bubble visible only on the source tab. This supports the feasibility of a web product, not native feature parity or a recommendation to depend on Loom's account, storage and licensing model. Rushes should use its own browser APIs. [S-N4-9]

Clipchamp is the second concrete first-use reference. Microsoft separates persistent camera/microphone site permission from screen selection on every recording, and explains the browser's macOS screen-recording permission plus restart. Its browser recording guide places preview and permission before capture, and documents capture/audio constraints. Reuse that explanatory sequence, with original Rushes copy and UI. [S-N4-10] [S-N4-11]

Proposed flow: sign in → private library → **New recording** → optional skippable guide → choose Screen, Camera or Both → explicit **Enable camera** / **Enable microphone** buttons → device preview and level meter → **Choose screen** opens the browser picker → confirm actual available audio → countdown → Record / Pause / Resume / Stop → local review → upload/processing state → ready private video → explicit share action. Save guide dismissal/completion and offer replay in Help. Do not prompt on mount, silently start a device, or turn a dismissed tour into a capture trigger.

## 3. Bounded browser MVP

Proposed first release supports the current stable desktop Chrome and preceding major on macOS and Windows, tested versions named in the release checklist. Edge follows only after its matrix passes; Safari, Firefox, mobile and extensions are later work. Capability detection also gates capture, codecs and storage. This is a support choice, not a claim that every browser lacks the APIs.

Initial limit: **10 minutes per take, target 720p/30 fps**, screen-only, camera-only or screen plus optional camera; optional microphone and available tab audio. Record camera as a separate original and composite it into the resulting video even when the user records another app. Its preview stays within the Rushes page/window; no arbitrary native always-on-top overlay is promised. Full-screen/window choices come from the browser picker. Custom screen regions, drawing across apps, global hotkeys, cursor/keystroke telemetry, native auto-zoom, background blur, transcript editing and advanced exports are excluded initially.

The constraints have direct design consequences:

| Browser evidence | Required behavior |
|---|---|
| `getDisplayMedia` requires a user gesture, presents user-selected sources and cannot persist the capture grant. [S-N4-12] | Invoke it directly from a click after other setup work; cancellation returns to setup. Ask again for each new take. A saved preset is a preference, not permission. |
| `getUserMedia` requires permission and secure context. [S-N4-13] | HTTPS production origin; explicit device buttons; recover from denial, missing/busy devices and OS restrictions without a permission loop. |
| Display audio depends on browser/OS/source; an audio request can return no track. [S-N4-12] | Inspect actual tracks. Label tab audio only when present; do not advertise universal system audio. Offer microphone-only or silent capture. |
| Capture controls are browser hints; source choices remain user controlled. [S-N4-14] | Suggest excluding the recorder tab to avoid recursive capture, but verify returned settings and show the chosen source. |
| Recorder MIME support is detected at runtime and can still fail from resource shortage. [S-N4-15] | Prefer a tested WebM/VP8+Opus path for Chrome; record actual codec. Failed negotiation disables Record with an actionable message. Never rename WebM to MP4. |

The 720p target and short-take limit are launch hypotheses intended to reduce client encoding/storage pressure; they must earn support through milestone M1. Open review and playback can be available beyond the recording support matrix after independent player tests.

## 4. Media pipeline, shared time and recovery

**Chosen composition path:** browser capture produces separate original streams plus a concurrently recorded composed stream. Draw selected screen and optional camera into a canvas; use its captured video stream with a Web Audio mix of available microphone/tab audio for the share recording. `canvas.captureStream` provides a browser media stream; it does not establish performance, background reliability or timestamp precision. [S-N4-16]

Do not assume starting several MediaRecorders makes them sample-synchronous. Create one session epoch from a monotonic clock, store each track's start event/offset, MIME type, sequence, byte count, digest, pause intervals and any mute/end events in a versioned manifest. Use one coordinator for pause/resume/stop across originals and composition. Keep source streams fixed within a take; changing a device ends the take cleanly. The rendered video's media timeline, original offsets and manifest intervals must reconcile against a visible/audio calibration fixture.

Request approximately two-second data callbacks, but derive duration from the session clock and decoded media, never chunk count. Callback timing is inexact. Individual recorder blobs need not be playable; the recording specification guarantees playability of the combined blobs of a **completed** recording. It does not guarantee salvage after killing a tab. [S-N4-17] [S-N4-18]

Each callback must durably save its chunk before showing a checkpoint, then enqueue cloud backup to a private raw prefix. Keep chunks, initialization data and manifest ordered and checksummed; bounded memory holds only the current write/upload batch. On Stop, wait for the final data event, close all recorders, verify sequence/digests, assemble the composed Blob from persisted data and run a decode/playback check. Resume uploads from acknowledged sequences and tus offsets. A failed upload preserves local data and offers Retry and Download backup. It never marks a video ready.

Use OPFS for local chunk storage plus a metadata journal, request persistent storage and inspect the result. Browser storage is subject to quotas and clearing; a persistence request can be denied. [S-N4-19] [S-N4-20] Also offer **Choose backup folder** using Chrome's File System Access API. Write and **close each chunk file**, followed by a versioned manifest checkpoint; keeping one writable file open for an entire take would not establish durable writes because changes are committed at close. This backup contains recording data, not an installed application. [S-N4-21]

On reload, recover saved bytes into an interrupted draft and attempt tested reconstruction. Reacquiring screen/camera requires an explicit action; recovery never secretly resumes live capture. Retain original bytes even if salvage fails. Display the last durable checkpoint and measured salvage limitations. Do not promise zero-loss or “crashproof”: queued encoder data can be lost. If persistence is denied and a backup folder is not selected, clearly identify reduced protection and allow a deliberate short-take choice.

Chrome documents hidden/frozen/discarded page states that can suspend JS and callbacks. Therefore the feasibility matrix must cover another tab, another app, minimized browser and memory pressure. A page warning or service worker does not establish continued composition. If screen-plus-camera composition freezes in these conditions, restrict capture to a tested visible recorder arrangement or stop the browser launch and price a separate container compositor. Do not sell background camera composition based only on foreground tests. [S-N4-22]

## 5. Hosting and accounts

Use a **new commercial Worker/D1/R2 deployment** with a new app origin; preserve the personal Worker. Serve a TypeScript/React capture and library app through static assets, with Worker API/session authorization, D1 metadata/quotas and private R2 raw recovery objects. Propose Google OpenID Connect as the only pilot login method to avoid inventing password recovery/email infrastructure. Verify issuer, audience, signature, expiry, state and nonce server-side; use stable provider subject for identity rather than trusting a submitted email. Store opaque session identifiers in Secure HttpOnly SameSite cookies, with rotation/revocation and CSRF checks. [S-N4-23]

**Video service:** use Cloudflare Stream for encoding and adaptive playback after the browser has created one composed file. It documents automatic H.264 adaptive outputs from 360p to 1080p. R2 is an object store, not a transcoder; Stream is not the planned camera compositor or a guarantee that arbitrary incomplete WebM will ingest. Test actual finalized and recovered fixtures. [S-N4-24]

After final file size is known and server quotas reserved, issue a constrained direct tus upload URL with an expiry and duration maximum. Keep Cloudflare API credentials on the server. Stream documents resumable creator uploads and requires tus above 200 MB. Browser originals remain in R2; only the composed video goes to Stream. Confirm processing readiness and measured duration from the service before committing `ready`. Handle duplicates, errors and cleanup idempotently. [S-N4-25]

Use ordinary Workers for authorization, metadata, streaming uploads and state transitions. A standard Worker isolate has 128 MB memory and paid CPU limits, so a full-file ffmpeg encode/compositor inside the share request is a poor unproved architecture. If browser composition or salvage fails M1, price an isolated media container and queue separately; its compute, retries, temporary disks and transfer are **not included** in this model and require another scope/spend decision. [S-N4-26]

### Ownership invariants

Every recording, upload, asset, share, processing job, entitlement and usage row carries `tenant_id`; an initial tenant has one owner. Storage keys are server-built `t/<tenant-id>/r/<recording-id>/...`. Never accept an object key or tenant identity from a request as authority. Library queries and every read/write/delete/retry/download/feedback endpoint scope by authenticated tenant, including existing-style IDs and tus-status lookup. Composite foreign keys or equivalent validation prevent cross-tenant associations. No `OWNER_TOKEN`, Cloudflare token, signing key or Stripe secret enters browser bundles, storage or logs.

Authorize before creating upload grants. Bind raw grants to tenant, recording, track, sequence, method, MIME, maximum bytes and expiry; prevent overwriting an acknowledged different digest. Server checks bounded bodies and aggregates actual accepted bytes, not client-reported duration/size alone. Reserve quota atomically before grants, release abandoned reservations and reconcile actual bytes/duration after processing. Concurrent uploads must not both spend the last quota. A signed capability protects its scope, not all other routes automatically.

### Private first, retention and abuse

New library videos, posters, raw files and transcripts are private. **Create share link** explicitly grants unlisted viewing; password and expiry are optional. Stream assets require signed URLs, since a secret-looking video ID alone is insufficient access control. Mint short-lived viewer tokens only after policy and usage checks. Apply the same policy to manifest, captions, thumbnails and downloads; disable public bucket origins and private CDN caching. Revoke future access immediately and document already-issued token expiry as a short residual window. [S-N4-27]

Proposed policy: raw recovery objects retained for **7 days**, abandoned uploads **24 hours**, originals local until the user deletes them, composed hosted videos retained within the purchased library quota. Account cancellation leaves a **30-day export grace period** then scheduled deletion after clear notice; voluntary delete revokes immediately and completes provider cleanup within **24 hours**. These are proposed promises that require deletion/read-back tests and operating ownership before launch. Keep an audit trail without footage, transcripts, passwords or signed URLs.

Invite-only verified accounts; rate limits on account/session/grant creation, raw bytes and password attempts; per-tenant concurrency and duration limits; content-type/container validation; quarantine failed uploads; abuse reporting and owner suspension; no anonymous upload endpoint or URL-fetch import. Index queries and cap feedback/polling. Use per-tenant usage reconciliation and provider anomaly alerts so a popular or abusive share cannot quietly become unlimited paid delivery.

## 6. Subscription and economic limits

Pilot hypothesis: **$15/month per owner**, no annual commitment initially. Include 100 newly recorded/uploaded minutes per billing month, 300 retained composed minutes, 1,000 viewer-delivery minutes/month, 10-minute takes and a 2 GB active raw-upload reservation limit. Stop new grants on exceeded upload/library quotas, explain deletion/renewal, and allow downloads/deletion. Do not silently charge overages. Validate demand and actual workload before expanding limits or introducing a second plan.

Use Stripe-hosted Checkout in subscription mode and its customer portal for payment changes/cancellation. The server selects the allowed price and maps the Checkout customer/subscription to the tenant; browser-provided price/customer/tenant IDs do not decide entitlement. [S-N4-28] [S-N4-29]

Verify webhook signatures against the raw body; durably record event IDs and process idempotently. Events can arrive duplicated or out of order, so reconcile the current subscription and paid-through state rather than trusting arrival order or a success redirect. Test first-payment authentication/failure, renewal, cancellation at period end, refunds and disputes. Proposed dunning policy: 7-day existing-view/export grace after a failed renewal, no new upload grants until payment recovers; final cancellation follows the export-retention rule. Server checks entitlements when reserving capture/upload quota and publishing. [S-N4-30] [S-N4-31]

**Delivery limitation:** Stream charges delivered segments and MP4 downloads, including buffering; a browser “play” counter is not its bill. Server-reserve a full clip's minutes for each viewer session before issuing a token, limit renewals/concurrency, disable bulk downloads in the pilot, and reconcile Stream delivery metrics. Signed tokens can be replayed while valid and provider analytics can lag. These controls bound ordinary use but do **not** create a guaranteed hard vendor spend cap. Before paid launch, an abuse fixture must demonstrate bounded practical exposure or require an authenticated metered segment proxy / a different delivery design. Advertising a strict delivery quota before that gate passes is prohibited. [S-N4-32] [S-N4-27]

### Vendor unit costs opened 2026-10-12

| Item | Published price used | Model rule |
|---|---|---|
| Stream retained video | $5/month per prepaid 1,000-minute capacity block | `5 × ceil((retained + outstanding reserved minutes)/1000)`; encoding/ingress included. [S-N4-32] |
| Stream delivery | $1 per 1,000 delivered minutes | Count viewing, buffering and any enabled downloads. [S-N4-32] |
| R2 Standard | $0.015/GB-month; 10 GB-month included | Raw recovery and sidecars only; round billable units up. [S-N4-33] |
| R2 operations | Class A $4.50/million above 1 million; B $0.36/million above 10 million | Chunk writes are operations; free egress does not make all hosting free. [S-N4-33] |
| Workers Paid | $5/month; 10 million requests and 30 million CPU-ms included; overage $0.30/million requests and $0.02/million CPU-ms | Shared account allowances may already be consumed by other services. [S-N4-34] |
| D1 on Workers Paid | 25 billion read rows/month, 50 million written rows/month and 5 GB included; overage $0.001/million reads, $1/million writes, $0.75/GB-month | Include index writes/scans; measure rather than count SQL calls. [S-N4-35] |
| Stripe US domestic card + pay-as-you-go Billing | 2.9% + $0.30/transaction plus 0.7% Billing volume | At $15: $0.84 per successful monthly payment. Other methods/countries, tax/refund/dispute costs differ. [S-N4-36] [S-N4-37] |

**Workload assumptions, not forecasts:** each owner uploads 100 minutes/month, retains 200 composed minutes, generates 500 delivered minutes; raw screen 4 Mbps + camera 1.5 Mbps + two audio tracks totaling 0.256 Mbps + composite 4 Mbps = 9.756 Mbps, approximately **0.07317 GB/minute**. Seven-day retention at steady activity yields `new minutes × 0.07317 × 7/30` GB-month. Five streams with two-second callbacks yield approximately **150 Class A writes/minute**, before metadata/retries. Actual MediaRecorder rates/chunk sizes must replace these assumptions after M1. Proposed bitrate caps must be enforced/measured, not presumed from requested settings.

| Monthly scenario | 25-owner pilot | 100 owners | 100 owners at proposed retained/delivery ceilings |
|---|---:|---:|---:|
| New minutes / retained / delivered | 2,500 / 5,000 / 12,500 | 10,000 / 20,000 / 50,000 | 10,000 / 30,000 / 100,000 |
| Stream storage + delivery | $25 + $12.50 | $100 + $50 | $150 + $100 |
| R2 raw GB-month / billed storage | 42.68 / $0.50 | 170.73 / $2.42 | 170.73 / $2.42 |
| R2 A writes / billed operations | ~375,000 / $0 | ~1,500,000 / $4.50 | ~1,500,000 / $4.50 |
| Workers base + modeled D1/B overage | $5 + $0 | $5 + $0 | $5 + $0 |
| Modeled cloud subtotal | **$43.00** | **$161.92** | **$261.92** |
| Hypothetical revenue / Stripe fees | $375 / $21 | $1,500 / $84 | $1,500 / $84 |

The table assumes other R2/Workers/D1 usage does not consume account allowances, fewer than 10 million R2 reads, fewer than 10 million Worker requests, 30 million CPU-ms, 50 million D1 writes and 5 GB D1 storage; no media-container compute. Raw metadata, backups, logs, domain, support, development, monitoring, tax, payment losses and AI are excluded. Outstanding Stream duration reservations, retry amplification and billable R2 rounding can increase costs. This is an infrastructure comparison, **not a profit-margin claim**.

**Spend proposal for a later approval:** invite-only 25-owner, 30-day pilot; $100/month operating budget, $75 warning threshold, and a proposed recurring annual exposure ceiling of $1,200 if later renewed. Review actual usage before the 30-day pilot ends; no automatic expansion or annual purchase. Stop issuing new upload/view grants when the application budget reserve reaches its ceiling; retain deletion/export access where feasible. Provider alerts, short token lifetimes and a kill switch are required, but the budget is not a guaranteed invoice ceiling. No money is spent by accepting this research artifact alone.

## 7. Reuse, milestones and release gates

Reuse manifest concepts, error codes, policy controls, resumable-upload evidence, range handling and viewer transcript/timestamp UI where they survive the new contracts. Extract browser-safe shared types separately; Node filesystem/crypto code and owner-token orchestration stay server/desktop-side. Extend playback for Stream while preserving legacy MP4. New work is capture, local durable store/recovery, library/login, tenant authorization, raw chunk protocol, Stream processing adapter, quota ledger, subscriptions, operations and privacy UI. Native SpeechAnalyzer does not become a browser feature; AI/transcription is optional later with explicit per-recording consent, named processor, retention and a separately priced budget. Preserve the repository's clean-room/source-notice rules; competitor UX is evidence, not copy permission. [S-N4-1] [S-N4-2] [S-N4-3] [S-N4-6]

| Milestone | Required artifact and pass/fail acceptance | Blocks |
|---|---|---|
| **M0 Scope decision** | David reviews this plan and C2 verdict: browser/OS matrix, 10-minute/720p limits, private-first policy, Google-only login, $15 hypothesis, Stream choice and pilot budget. Record decision; no timeline guarantee. | Implementation or paid provisioning without an explicit request. |
| **M1 Capture/recovery spike** | Synthetic, nonsensitive fixtures on each named supported browser/OS: denial/cancel, screen/camera combinations, audible levels, no audio track, 10-minute take, ≥5 pauses, app/tab switching, minimized browser, device loss, offline 5 minutes, forced reload/kill and quota exhaustion. Decoded sync drift ≤100 ms at beginning/middle/end; no unexplained gap >250 ms; local memory bounded. Normal Stop produces a playable composite and originals. Recover all acknowledged checkpoints; crash-tail loss measured and disclosed. Folder chunks survive process kill. If composition/salvage misses gates, stop and revise architecture. | Account/billing work must not disguise failed capture feasibility. |
| **M2 Account/library isolation** | Two fixture tenants attack every list, asset, poster, caption, download, upload/tus status, edit, share, feedback, retry and delete route with swapped IDs. None can access the other's private data. CSRF/session revocation tested; browser bundle/log scan finds no owner/vendor secret. Private media fails anonymous requests, including provider origins. | External beta. |
| **M3 Processing, quota and migration** | Interrupt upload at every boundary; resume without duplicates; forged size/duration, expired/replayed grants and concurrent last-quota attempts fail correctly. Provider confirms decoded duration/readiness before ready. Delete/expiry removes Stream and R2 data with read-back. Raw-retention and abandoned-reservation jobs tested with a controlled clock. Legacy URL/password/expiry fixtures stay unchanged. | Public sharing or charging. |
| **M4 Billing/cost/operations** | Stripe test-mode signature, duplicate/out-of-order, authentication failure, renewal/cancel/refund/dispute fixtures; no entitlement from redirect. Reconcile server usage against provider invoices/metrics. Token replay, concurrent viewers, bots and download buffering test practical budget exposure. Fail if the claimed quota/spend bound is unsupported. Exercise restore, alerts, suspension and kill switch; owner accepts documented residual spend risk. | Live charges and paid launch. |
| **M5 Controlled paid pilot** | Fresh independent security/product checker; exact deployed revision and changed behavior verified; reviewed signup/pricing/privacy/retention/refund copy and support owner; separate David approval of public audience, live Stripe mode and exact service spend. 25 invites maximum; measure failures, retention cost and usage against the model before wider release. | Expansion. |

These are sequential outcome gates, not a giant automatic build contract. Run independent capture research and tenant design work in parallel only after scope authorization; give a separate checker each final customer/security/money artifact. No writer marks its own output passed. Two failed repair retries end the lane with its evidence and a narrowed decision for David.

### Personal links and subsequent phases

Keep existing personal share URLs on their current origin and storage/service path. Do not deploy tenancy/billing changes over that Worker. If David later wants personal videos in the commercial library, migrate through an authenticated server import with an explicit owner mapping, checksums, policy preservation and reversible routing; never make old links paywalled or transfer them to an arbitrary signed-in account. Test old link, password, expiry and delete behavior before any cutover. Keep desktop self-hosting and local capture independent of the subscription. [S-N4-2] [S-N4-4]

After the pilot earns a repeatable reliable take: add tested Edge support and original downloads; then optional captions/transcription and simple trim, with renewed compute/AI cost gates. Teams require memberships, roles, invitation consent and share-audience tests. Longer takes, richer editing, native-style overlays and a container compositor require separate product and cost evidence. Public scale, unlimited hosting and AI bundles are not hidden commitments of this MVP.
