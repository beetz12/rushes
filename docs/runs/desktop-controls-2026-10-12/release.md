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

## Current release state after unlocked installed checks

The earlier locked-host and input-timer holds above are historical. David
unlocked the host, authorized a bounded display-awake hold, and explicitly
overrode the three-second input rule for two local recordings. The signed
e766577 production candidate is installed at `/Applications/Rushes.app`; the
previous application and recording/settings stores remain preserved. AutoShare
was observed Off in the installed Settings. No test recording was uploaded.

The corrected merged-tree gate on4237969 exited0: 328 native tests,5 Intents,
117 shell,16 cloud,4 viewer and18 worker tests; clean/notices checks passed.
Independent fixture review f84a178 was integrated at5932dad and confirmed that
the production trees matched e766577. The original failing gate is retained.

Two real installed recordings completed and native verification returned
`ok:true` for each:

| Take | Actual duration | Saved masters | Export result |
| --- | --- | --- | --- |
| 01M4RWRSAZT6FHTHC3G2EQY9Z8 | 14.726475s | camera.mov, mic.mov; camera-only source, no screen, system audio Off | Both separate exported files equal their master SHA-256 hashes. |
| 01M4RX2TSZJVPKZJEW6WJC09R4 | 26.165008s | screen.mov, camera.mov, mic.mov; display source, system audio Off | All three separate exported files equal their master SHA-256 hashes; edit/offset sidecars are present. |

Root fully software-decoded all five movies with ffmpeg, actual exit0 for each.
ffprobe counted440/783 camera frames at1920x1080,1226 screen frames at3456x2234,
and mono48kHz AAC in both microphone tracks. These checks establish valid
encoded media and preserved exports, not intelligible speech or acoustic sync.
Private evidence is in the owned0700 host directory
`~/.goal-loop/loom-clone/host/2026-10-12-desktop-controls`: physical-decode.json,
physical-camera-export-hashes.json and physical-screen-export-hashes.json.

The restored selected camera preview appeared automatically on launch and again
on recorder entry without an Off/On toggle. The inspected automatic-preview.png
records a live camera image. Main-window OS controls disappeared at the recording
gate and returned after Stop; the source/state checks cover actual minimize and
independent overlay lifetimes. CUA did not expose a reliable floating-window
inventory, and root could not hear playback. David's confirmation of countdown
sound and visible bubble while minimized remains requested; do not label either
as physically verified from those instrumentation limits.

After the second Stop, the installed UI showed invalid-json and then connection
restored notices despite valid media. A generated-byte probe independently
reproduced a terminal socket-write corruption defect, repaired ine98c3d7. That
does not prove the installed incident's exact cause or explain a prior native PID
change. Independent review found a separate renderer latch gap inApp.run;
f42f59b authorizes its bounded repair. Initial review/failure history is retained
in transport-verdict.md. The repaired source still needs independent renderer
acceptance, fresh full release verification, packaging and installed read-back.
No additional real recording is required solely to verify unchanged media code.

The desktop issue remains in progress for that repair/install and the pending
physical feedback. The commercial browser long-capture/provider/Windows gates
remain separate. No public code push, commercial deployment or live charge is
claimed by these local results.

## Completed repaired installation

The preceding repair/install hold is superseded. The independent source
reassessment at71535da passed; its artifact9ef1ee8 was integrated as9584ed7.
Root fast-forwarded the candidate onto clean local default main and ran the
declared `/bin/bash scripts/check.sh` at787d8eb: actual exit0,5 Intents tests,
330 native tests in55 suites,128 shell tests in18 files,16 cloud,4 viewer and18
worker tests, plus clean/notices. Native tests completed in14.654s. The retained
transport-release-gate.log includes the substantive counts and final success.
Subsequent9584ed7 changes only the independent evidence artifact.

Fresh production `swift build -c release` exited0 in29.52s. Electron packaging,
automation helper embedding/metadata/signature, and the containing app's strict
deep signature all passed using the same existing development identity. Five
packaged shell files match the verified source dist hashes; both signed native
products have matching Mach-O UUIDs. The source package is at
`/Users/dave/Work/loom-clone/shell/release/mac-arm64/Rushes.app` and carries
build-provenance.json identifying business71535da and the actual release gate.

Root read native state idle/no warnings, quit the installed app using its normal
Quit Rushes control, verified its processes exited, then installed the signed
candidate. The preceding app is preserved at
`/Applications/Rushes-before-transport.previous`; the earlier backups also remain.
The reopened installed app has mainPID38833 and nativePID38862 at this read-back.
Its app.asar, engine, CLI and provenance hashes all equal the staged candidate;
native status is idle/no warnings with screen, camera and microphone granted.
The selected camera preview reappeared automatically without any toggle or new
recording. Root then opened My recordings, observed both completed test takes
and the preserved library, and left that view open to release the idle preview.
The inspected repaired-installed-library.png records the connected library.

No third real recording was made after the transport-only repair. The writer,
capture clock and media implementation stayed unchanged; the two real takes,
all-five decode and export hashes remain the media evidence. The new native
socketpair, client recovery and actual-renderer synthetic probes verify the
changed transport/error seams. Audible countdown and floating-bubble physical
feedback from David remains pending, and no public source push is authorized.
