---
node: C2
skill: graph-design
graph: rushes-first-use-cloud
run: 2026-10-12
inputs:
  - docs/product/first-use-cloud-2026-10-12/cloud-plan.md
  - docs/product/first-use-cloud-2026-10-12/sources.md
  - docs/product/first-use-cloud-2026-10-12/graph.md
  - docs/product/first-use-cloud-2026-10-12/facts.md
  - README.md
  - docs/PLAN.md
  - cloud/README.md
  - cloud/src/types.ts
  - cloud/src/worker-provider.ts
  - worker/README.md
  - worker/src/bindings.ts
  - worker/src/index.ts
  - viewer/src/viewer.ts
  - docs/agent/SKILL.md
status: passed
target: docs/product/first-use-cloud-2026-10-12/cloud-plan.md
attempt: 1
target_sha256: 5040a45b3a12ac3adfb53406a18ac78985b39756e4cf1660456baa9de5b1b60b
---

# Independent plan verdict

**PASS for David's planning review.** No blocking factual, arithmetic or architectural contradiction was found in the reviewed plan. This verdict does not establish browser reliability, production isolation, provider cleanup, working billing or a hard invoice ceiling. Those remain the plan's M1–M5 outcome gates. It authorizes no implementation, purchase, account change or deployment.

The checker did not write the plan. Review used the exact local inputs above, source excerpts covering the relevant implementations, primary documentation reopened on **2026-10-12**, and independent arithmetic. No app/device/GUI interaction, authenticated cloud request, capture test, billing experiment, deployment or paid API was performed. The dated health result is root's supplied observation; C2 did not independently repeat it. Its narrow reachability interpretation is correct.

## Findings

| Area attacked | Result and concrete evidence |
|---|---|
| Existing service versus paid product | Correctly separated. `WorkerProvider` imports Node crypto/filesystem helpers and sends an owner bearer token; `shareRow` queries only a share ID; the viewer consumes prepared MP4/sidecars. Accounts, browser capture and billing cannot be claimed from those surfaces. README preserves free local capture/self-hosting; historical PLAN Phase 7 excluded billing. The new commercial deployment and reversible, explicitly mapped import preserve that boundary. |
| Loom website claim | Supported distinction. The extension guide requires its extension and documents bubble restrictions outside Chrome/PDFs; its audio guide limits extension audio to a selected tab. Separate recordSDK documentation establishes embedded no-install recording with desktop-browser, 720p and source-tab bubble limitations. The plan does not confuse these with evidence of a standalone Loom website recorder or native parity. [Extension](https://support.atlassian.com/loom/docs/get-started-with-the-loom-chrome-extension/), [audio](https://support.atlassian.com/loom/docs/capture-internal-audio-system-audio), [recordSDK](https://dev.loom.com/docs/record-sdk/sdk-standard). |
| Capture permissions and sources | Correct. W3C requires transient activation, user source selection each call, no persisted grant, and permits a video-only result despite requesting audio. The plan's explicit Choose screen action, HTTPS origin, actual-track inspection and cancellation/OS-error handling follow that boundary. Microsoft separately documents macOS browser permission/restart and screen selection on every recording. [Screen Capture specification](https://www.w3.org/TR/screen-capture/), [MDN](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia), [Microsoft permissions](https://support.microsoft.com/en-us/clipchamp/troubleshoot-camera-microphone-and-screen-recording-permissions-in-clipchamp). |
| Originals, composition and alignment | Adequately bounded hypothesis. Separate recorders are not claimed sample-synchronous; the monotonic epoch, per-track offsets, pause/mute/end journal and decoded calibration are explicit. Canvas/Web Audio composition is a chosen spike, not a proven background engine. M1 tests the completed composite and originals across pauses, tab/app switching, minimization and device loss before support claims. |
| Chunks, recovery and quota | Correctly avoids guaranteed salvage. W3C guarantees combined-blob playability for a completed recording, not every chunk or a killed tab. Callback intervals can drift or create larger chunks. The plan waits for final data, persists ordered chunks/checkpoints, retains unsalvageable bytes and measures crash-tail loss. Persistence may be denied, and folder writes must close before disk commit. Frozen/discarded pages cannot be rescued by a page warning or assumed service-worker composition. [Recording specification](https://w3c.github.io/mediacapture-record/), [chunk timing](https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder/dataavailable_event), [persistence](https://developer.mozilla.org/en-US/docs/Web/API/StorageManager/persist), [file close](https://developer.chrome.com/docs/capabilities/web-apis/file-system-access), [lifecycle](https://developer.chrome.com/docs/web-platform/page-lifecycle-api). |
| Tenant authorization and private delivery | Sound proposed invariants. All resource/job/usage rows carry tenant identity; server-derived keys, tenant-scoped reads/mutations, constrained raw grants, aggregate byte accounting and atomic reservations cover more than the upload route. Private originals and sidecars plus signed Stream delivery prevent ID obscurity from being treated as authorization. The old owner-token Worker remains separate. Two-tenant swapped-ID tests and provider-origin anonymity checks are launch blockers, not asserted results. [Private Stream](https://developers.cloudflare.com/stream/viewing-videos/securing-your-stream/). |
| Payment entitlement | Correct trust boundary. The server chooses price/customer/tenant mapping and grants access from reconciled paid subscription state. Raw-body signature verification, durable event deduplication, current-state reconciliation, authentication/failure/cancellation/refund/dispute fixtures and no redirect entitlement match Stripe's unordered, retryable webhook model. This requires idempotent state transitions even when two distinct event IDs describe the same resource transition. [Stripe webhooks](https://docs.stripe.com/webhooks), [subscription lifecycle](https://docs.stripe.com/billing/subscriptions/webhooks). |
| Processing and spend | Stream encoding is included; it is not camera composition or proof of incomplete-WebM ingestion. Server container composition remains separately priced if M1 fails. Signed playback tokens can be reused during validity; segment delivery/buffering/downloads, not a browser play event, drive the bill. The plan expressly blocks strict quota advertising until its abuse/spend gate passes and calls the $100 budget an operating target with residual invoice exposure. [Stream uploads](https://developers.cloudflare.com/stream/uploading-videos/direct-creator-uploads/), [pricing](https://developers.cloudflare.com/stream/pricing/). |

## Independent cost recomputation

The dated prices match the opened [Stream](https://developers.cloudflare.com/stream/pricing/), [R2](https://developers.cloudflare.com/r2/pricing/), [Workers](https://developers.cloudflare.com/workers/platform/pricing/), [D1](https://developers.cloudflare.com/d1/platform/pricing/), [Stripe Payments](https://stripe.com/pricing) and [Stripe Billing](https://stripe.com/billing/pricing) pages. Encoding/ingress is included in Stream; incomplete creator/tus duration reservations consume Stream capacity until completion/expiry. R2 egress is free while storage and operations remain billable.

At the plan's assumed rates: `9.756 Mbps × 60 / 8 / 1000 = 0.07317 GB/minute`; five two-second streams produce `5 × 30 = 150` writes/minute. Seven-day steady retention gives 42.6825 and 170.73 GB-month. With unused account allowances and R2 rounding, storage is `33 × $0.015 = $0.495` and `161 × $0.015 = $2.415`, displayed as $0.50/$2.42. At 1.5 million Class A operations, the charge above the free million rounds to one million: $4.50.

| Recomputed scenario | Stream storage | Stream delivery | R2 storage | R2 A | Workers base | Cloud subtotal | Payments + Billing |
|---|---:|---:|---:|---:|---:|---:|---:|
| 25 owners, stated ordinary workload | $25 | $12.50 | $0.50 | $0 | $5 | **$43.00** | $21 |
| 100 owners, stated ordinary workload | $100 | $50 | $2.42 | $4.50 | $5 | **$161.92** | $84 |
| 100 owners, stated retained/delivery ceilings | $150 | $100 | $2.42 | $4.50 | $5 | **$261.92** | $84 |

Stripe arithmetic is `15 × (0.029 + 0.007) + 0.30 = $0.84` per successful domestic-card monthly payment. The tables reproduce the plan's assumptions, not a measured workload, profit forecast or worst-case bill. Provider reservations, retry/metadata operations, consumed shared allowances, cancellation/export retention, overhead and any additional compositor still need measured budgeting before spend approval.

## Concrete implementation cautions retained by the pass

These clarify already-required gates; they are not findings that the plan falsely claims working behavior.

1. **Create Stream videos private immediately.** The backend's initial tus request must set `Upload-Length`, duration, expiry and `requiresignedurls`; later client metadata is ignored by Stream. Turning privacy on only after processing would violate private-first. Bind the returned provider UID to the trusted tenant/recording before issuing the upload URL, and reject unmapped callbacks/status requests. Test this at M2/M3. [Direct creator uploads](https://developers.cloudflare.com/stream/uploading-videos/direct-creator-uploads/).
2. **Make cleanup and migration honor tenant scope too.** Scheduled deletion/reconciliation lacks an end-user session, so trusted jobs must derive tenant/resource associations from server state and narrow exact prefixes/provider UIDs. Import must use the explicit legacy owner mapping. Shared viewers/comments need a validated share-policy grant bound to that same tenant/recording; an arbitrary tenant header or share ID must not suffice. Include wrong-tenant job/import/provider-UID fixtures alongside endpoint attacks.
3. **Do not inherit R2's default incomplete-upload lifetime as the proposed policy.** Cloudflare documents a default seven-day multipart expiry and typical lifecycle deletion within 24 hours after expiration, with possible delays. The proposed 24-hour abandoned-upload cleanup and 24-hour voluntary-delete completion need explicit application cleanup, provider read-back and tested ownership; lifecycle rules are supplementary protection. Daily peak storage and deletion lag can raise the steady-state table. [R2 lifecycle](https://developers.cloudflare.com/r2/buckets/object-lifecycles/).
4. **Measure finalization memory as well as recording memory.** Blob assembly/decode/upload after Stop must be tested at the maximum take, and a suspended callback can deliver more than a two-second chunk. The bounded-memory acceptance cannot rely solely on the requested timeslice. Recording protection also needs explicit behavior when local storage or the cloud raw-byte reservation fills.
5. **Keep the pilot budget's assumptions visible.** For illustration, the 25-owner retained/delivery ceilings alone produce $40 Stream storage plus $25 delivery, about $70.50 total using the same raw/Workers assumptions. An outstanding 250-minute reservation over the ordinary 5,000 retained minutes instead requires another $5 capacity block. Neither scenario accounts for token replay or an alternate metered proxy/container; M4 and renewed approval remain necessary.

No repair cycle was needed for this plan-only verdict. Do not convert this pass into M1–M5 evidence or a public product guarantee.
