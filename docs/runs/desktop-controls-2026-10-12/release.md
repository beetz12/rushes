# Desktop controls release evidence

Source candidate: e766577; independent review integrated at6fec100.

The five requested behaviors are implemented and the independent bounded review
found no supported blocker. Its117 shell tests,8 native state tests and generated
original export with matching master hashes are recorded in verdict.md. Root's
fresh production Swift build completed successfully in26.63s; the retained
release-build.log contains the actual completion output.

Root is preparing a development-signed package with the same existing Apple
Development identity used by the installed app. The package includes the current
native engine and CLI, current shell, cloud/viewer assets and the native automation
helper. Preparation does not replace or launch the installed application.

At18:46UTC the host read-back reports CGSSessionScreenIsLocked=Yes. A fresh
unlocked-host full release gate and installed checks remain required. Root asked
David to unlock and leave input idle; no physical recording or installed-app
replacement occurred during this locked-host preparation. Existing settings and
recording masters must be preserved, and engine status must be idle immediately
before a safe replacement.

Installed acceptance must demonstrate camera-only capture, restored camera
preview without a toggle, countdown behavior, main-window minimize after actual
start with bubble/control bar remaining, and separate original exports. Retain
decode/metadata/hash evidence and distinguish physical results from mock/state
tests. No public source push or provider deployment is authorized by this local
release evidence.

Unlocked-host full native gate on c8ee107: actual exit1,327 tests/one issue,
15.661s. The existing "active CLI camera" test did not request a camera: its
shared start helper supplies only display and microphone, while the mock rig can
publish arbitrary JPEG callbacks. The new intentional camera-less token guard
correctly rejects that callback. Root corrects this fixture to request its named
synthetic camera and asserts acknowledgment/frame token agreement, retaining the
existing JPEG/subscription/device-lifetime assertions. A separate camera-less
request must continue to reject the mock's unexpected frame. Production code is
unchanged; the failed gate remains retained and the repaired full gate is due.
