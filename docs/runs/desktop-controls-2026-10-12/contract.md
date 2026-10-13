# Rushes desktop control repairs

User authorized these five installed-app repairs on 2026-10-12. Central tracker:
openbrain-v05d.1. Base853ff16. The browser/cloud work continues separately.

Outcome: users can choose camera-only without a screen target, choose a combined
export or separate original files, get the selected live camera preview without
an Off/On workaround, hear generated countdown ticks, and have the main window
minimize after recording really starts while bubble/control windows remain usable.

Existing backend supports nil screen for camera-only (SessionRequest), camera-only
edit layout, original tracks and editor handoff. Inventory found native countdown
events and shell shared start schemas; inspect renderer, preload, main/engine,
camera-overlay and editor-handoff before changing their contracts.

Single writer owns shell/src/** and docs/runs/desktop-controls-2026-10-12/slice.md.
Root owns this contract, packaging/install tools and root release integration.
Swift Sources/Tests, browser/**, browser-worker/**, cloud/viewer/worker, scripts,
package/lock/notices are read-only unless root explicitly amends ownership after
the writer reports a demonstrated need. One declaration owner: shell shared
contracts. Renderer/main/preload must consume its names, never duplicate schemas.
No camera/recording or shared GUI by the writer. Use pure mocks/tests or isolated
headless synthetic UI only; root owns physical installed tests after fresh input
idle >=3s and confirmed non-recording state for replacement. Never quit an active
take, disable finalization holds, delete masters or expose original private media.

Verify Node22.22 shell build/typecheck/tests, changed-surface clean scan first0,
whitespace and original export contents/checksums with generated nonsensitive
fixtures. Tests should exercise asynchronous preview start/stop/switch/stale
frames, camera-only request shaping, cancel/fail/countdown0/3/5 transitions,
one tick per actual positive countdown step and no tick after cancel/stop, one
minimize after the real active gate (no minimize on failed/canceled startup), and
separate-original choice through existing handoff with preserved source hashes.
Generated audio cues must be original, short and modest; do not copy Apple's
Photo Booth assets or use unlicensed sources. Existing settings/permissions,
recording bar, bubble close/drag, native recovery and archive semantics remain.

Commit only owned paths in this isolated branch. Fresh read-only independent
review follows before root packages and updates the app. User account/keychain
input is human-only if prompted. GitHub repo is public: no push/PR/publication
without root's concrete review and David approval. No shared Beads write by agents.

Preview-tail amendment approved by root after the writer inspected both queues:
source JPEG work and SocketLineIO's pending preview mailbox can outlive a warm
acknowledgment. One writer additionally owns EngineController.swift, a narrowly
scoped PreviewPublication helper under Sources/RushCore/Control if needed,
CameraSource.swift only if needed for stop ownership, and targeted native tests.
Keep all other Swift business files read-only; report any further prerequisite.
The exact additional seam is an opaque previewToken in camera.preview.start and
camera.preview.subscribe results and every camera-preview result. Controller
captures a token per idle warm/recording rig; publication drops superseded tokens.
Shell's shared contracts own the declaration, install the acknowledged token for
idle or recording preview, and discard mismatched JPEGs even if socket ordering
delivers an old frame after a new acknowledgment. This is lifecycle correlation,
not a secret or authority token. Preserve original image/device/recording behavior
and handle missing/obsolete acknowledgments without showing a stale preview.
Document the original design before coding, test old/new callback and transport
orders without hardware, and do not claim a source-queue drain alone fixes it.

Transport amendment after installed checks: root observed an invalid-json banner
after a successful26s screen/camera/microphone take. The writer independently
reproduced a truncated generated JSON prefix followed by another event after a
250ms socket send timeout. This demonstrates a transport defect, without proving
its attribution to that installed incident or a cause of the earlier PID change.
The same writer additionally owns Sources/RushCore/Control/ControlServer.swift,
narrow generated-byte transport tests, shell/src/main/engine.ts and its connection
error classification/helper tests. Atomically mark/shutdown a failed connection
while the write lock is held, so no new line can append after a truncated prefix.
Malformed client NDJSON terminates only that socket; preserve the native process,
active take and existing fresh-status recovery. Clear invalid-json only after that
verified recovery, not merely on a parsed line or reconnect attempt. Keep payloads,
schema/token validation, media/scheduling behavior and ownership rules intact.
Retain safe lengths/error codes rather than private JPEGs or message contents.
No hardware/shared GUI/provider/public action by the writer. Root owns integration,
independent review, full release, packaging and installed verification.

Renderer recovery amendment: the independent e98 review proved that App.run
clears invalid-json before a Show-preview action, with zero completed fresh-status
responses or verified-reconnected events. A pending request also legitimately
rejects with engine-disconnected; generic catches must not erase the connection
latch. The writer additionally owns renderer/main.tsx and a narrow shared error
state helper/regression if needed. Keep connection errors latched separately from
ordinary action errors until the existing verified recovery event. Action start,
dismissal and success may clear ordinary errors; unrelated failures must remain
visible and remain after connection recovery. Use pure or isolated synthetic
renderer tests, no hardware/shared GUI. Preserve capture and every other user flow.
