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
