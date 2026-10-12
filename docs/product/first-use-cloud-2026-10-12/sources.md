| ID | URL | Accessed | Supports |
|---|---|---|---|
| S1 | https://www.atlassian.com/software/loom/resources/guides/steps-to-get-started-in-loom | 2026-10-12 | Capture choice, device check, record controls, review and sharing sequence; desktop/extension distinction |
| S2 | https://support.atlassian.com/loom/docs/get-started-with-the-loom-chrome-extension/ | 2026-10-12 | Chrome extension capture choices and limitations |
| S3 | repo:shell/src/main/index.ts | 2026-10-12 | Menu-bar app behavior, asynchronous preview/start callbacks and missing idle window-close cleanup |
| S4 | repo:docs/PLAN.md | 2026-10-12 | Local capture/cloud sharing architecture, clean-room rules and deferred Phase 7 |
| S5 | repo:shell/src/renderer/main.tsx | 2026-10-12 | Existing recorder controls and permissions, absent persisted first-use tour |
| S6 | https://blog.sendspark.com/getting-started-guide | 2026-10-12 | Setup and first video flow: screen/face/both, explicit device settings, movable bubble, then review/share; guide updated April 15, 2026 |

| S-N4-1 | repo:README.md | 2026-10-12 | Local macOS capture, separate originals, local-first/open-source boundary and clean-room rules |
| S-N4-2 | repo:docs/PLAN.md#phase-7-saas | 2026-10-12 | Phase 7, SaaS readiness, historical billing exclusion and clean-room/source-notice rules |
| S-N4-3 | repo:cloud/src/worker-provider.ts; repo:cloud/src/types.ts; repo:cloud/README.md | 2026-10-12 | Node/filesystem SDK inputs, owner bearer credential, MP4/sidecar publication and upload job recovery |
| S-N4-4 | repo:worker/src/index.ts; repo:worker/README.md | 2026-10-12 | Single owner authorization, unscoped share lookup, scoped upload capabilities, R2/D1 media, password/expiry and deletion behavior |
| S-N4-5 | repo:worker/src/bindings.ts | 2026-10-12 | R2/D1 bindings and one OWNER_TOKEN configuration |
| S-N4-6 | repo:viewer/src/viewer.ts | 2026-10-12 | Prepared-MP4 playback, transcript/caption/timed-link UI rather than capture/library |
| S-N4-7 | https://support.atlassian.com/loom/docs/get-started-with-the-loom-chrome-extension/ | 2026-10-12 | Loom extension setup, capture modes, microphone indicator and bubble limitations |
| S-N4-8 | https://support.atlassian.com/loom/docs/capture-internal-audio-system-audio | 2026-10-12 | Extension tab audio versus desktop application/system audio |
| S-N4-9 | https://dev.loom.com/docs/record-sdk/sdk-standard | 2026-10-12 | Embedded no-install browser recording; documented resolution/browser/source-tab bubble limits |
| S-N4-10 | https://support.microsoft.com/en-us/clipchamp/troubleshoot-camera-microphone-and-screen-recording-permissions-in-clipchamp | 2026-10-12 | Second product: site permissions, screen selection every take, macOS browser OS permission and restart |
| S-N4-11 | https://support.microsoft.com/en-gb/clipchamp/how-to-make-a-screen-recording | 2026-10-12 | Second product: preview/setup, recording and browser-tab audio constraints |
| S-N4-12 | https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia | 2026-10-12 | Picker, user gesture, each-take grant, chosen-surface and audio limitations |
| S-N4-13 | https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia | 2026-10-12 | HTTPS secure context, input permission and source error/constraints |
| S-N4-14 | https://developer.chrome.com/docs/web-platform/screen-sharing-controls | 2026-10-12 | Browser-controlled display sharing choices and self-capture hints |
| S-N4-15 | https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder/isTypeSupported_static | 2026-10-12 | Runtime MIME detection is necessary and resource errors remain possible |
| S-N4-16 | https://developer.mozilla.org/en-US/docs/Web/API/HTMLCanvasElement/captureStream | 2026-10-12 | Canvas can produce a captured media stream; performance remains a prototype gate |
| S-N4-17 | https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder/dataavailable_event | 2026-10-12 | Inexact callback/timeslice behavior, larger chunks and independent timing requirement |
| S-N4-18 | https://w3c.github.io/mediacapture-record/ | 2026-10-12 | Normative completed recording playability; individual blobs need not play; pause/mute semantics |
| S-N4-19 | https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system | 2026-10-12 | Origin-private storage and quota/clearing boundary |
| S-N4-20 | https://developer.mozilla.org/en-US/docs/Web/API/StorageManager/persist | 2026-10-12 | Persistence request result can be false, storage pressure and explicit clearing caveat |
| S-N4-21 | https://developer.chrome.com/docs/capabilities/web-apis/file-system-access | 2026-10-12 | User-authorized file/directory handles; writes commit to disk when stream closes |
| S-N4-22 | https://developer.chrome.com/docs/web-platform/page-lifecycle-api | 2026-10-12 | Hidden/frozen/discarded states can suspend JavaScript and callbacks; unreliable unload |
| S-N4-23 | https://developers.google.com/identity/openid-connect/openid-connect | 2026-10-12 | OIDC flow and server token/issuer/audience/expiry/nonce validation with stable subject identity |
| S-N4-24 | https://developers.cloudflare.com/stream/ | 2026-10-12 | Managed upload/storage/encoding/delivery and H.264 adaptive outputs 360p-1080p |
| S-N4-25 | https://developers.cloudflare.com/stream/uploading-videos/direct-creator-uploads/ | 2026-10-12 | No exposed vendor token, expiring maximum-duration reservations, tus resumability and >200MB requirement |
| S-N4-26 | https://developers.cloudflare.com/workers/platform/limits/ | 2026-10-12 | Ordinary Worker isolate memory 128MB and paid CPU limits; avoid whole-file encode assumptions |
| S-N4-27 | https://developers.cloudflare.com/stream/viewing-videos/securing-your-stream/ | 2026-10-12 | requireSignedURLs, signed playback tokens and protected provider URLs |
| S-N4-28 | https://docs.stripe.com/api/checkout/sessions/create | 2026-10-12 | Server-created Checkout sessions and subscription mode |
| S-N4-29 | https://docs.stripe.com/customer-management | 2026-10-12 | Hosted customer portal billing/subscription management |
| S-N4-30 | https://docs.stripe.com/webhooks | 2026-10-12 | Raw-body signature verification, replay tolerance, event ID deduplication and unordered delivery |
| S-N4-31 | https://docs.stripe.com/billing/subscriptions/webhooks | 2026-10-12 | Asynchronous subscription/payment lifecycle, entitlements, payment-failure, refund/dispute handling |
| S-N4-32 | https://developers.cloudflare.com/stream/pricing/ | 2026-10-12 | Dated Stream prices: $5/1000 stored-minute capacity/month, $1/1000 delivered minutes, included encoding, reservation and buffering/download billing |
| S-N4-33 | https://developers.cloudflare.com/r2/pricing/ | 2026-10-12 | Dated Standard GB-month/Class A/B rates, included allowances, billing rounding and free direct egress |
| S-N4-34 | https://developers.cloudflare.com/workers/platform/pricing/ | 2026-10-12 | Dated $5 paid subscription, request/CPU allowances and overage prices |
| S-N4-35 | https://developers.cloudflare.com/d1/platform/pricing/ | 2026-10-12 | Dated paid row/storage allowances and prices, index/scanned-row billing |
| S-N4-36 | https://stripe.com/pricing | 2026-10-12 | US standard domestic-card 2.9% + $0.30 successful-transaction pricing and variations |
| S-N4-37 | https://stripe.com/billing/pricing | 2026-10-12 | Pay-as-you-go Billing 0.7% of Billing volume |
| S-N4-LIVE-health | https://rushes-share.nexai-rushes.workers.dev/health | 2026-10-12T11:20:19.729Z | Root observed GET HTTP 200 with {ok:true,service:"rushes-share"}; reachability only, not authenticated storage or paid browser readiness |
