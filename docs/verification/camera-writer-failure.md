# Camera writer correction — source evidence

2026-10-12 UTC; worktree `codex/rushes-final-camera`, starting at `07d8683`.
The parent owns the installed application retest and assembled release gates.

## Observed failure

Only metadata was read from the user's `01M4PWQHXMCKZ6GKMTRSQXAEP5` package.
At 01:48 UTC its manifest reported duration 259,996,750 ns, camera absent with
three drops and an `ended-early` camera writer error. Screen, microphone and
system audio were present. The take was incorrectly marked complete and verified
successfully with the camera skipped. No camera/screen pixels, audio or transcript
were opened by this lane.

## Supported findings and remaining uncertainty

`RecordingSession` classified success from any footage, clearing a failed camera
track's presence. This directly explains the false successful status. Fatal early
stops and writer errors now fail the take independently of retained footage.
Partial accepted camera bytes stay present; healthy screen/audio remain intact.
An empty camera after explicit disconnection remains a warning-only continuation.
An input failure followed by clean finalization also fails, avoiding a Stop versus
health-poll race.

`CameraSource` used an empty video settings dictionary. The installed macOS 27
SDK documents this as requesting device-native samples. It now chooses from the
connected output's supported eight-bit formats, in order 420v, 420f, BGRA. The
selection follows Apple's [video settings contract](https://developer.apple.com/documentation/avfoundation/avcapturevideodataoutput/videosettings).
This removes an unbounded native-format compatibility assumption. The original
error contained no native codes or pixel-format metadata, so the installed
encoder cause is still unproven until the parent's physical retest.

New writer diagnostics retain a bounded chain of NSError domains/codes and the
first attempted video's FourCC/numeric format and dimensions. Arbitrary user-info
keys and values are excluded. Existing HEVC start-time fallback stays intact;
no append retry rewrites a file that already accepted footage.

## Verification

Runtime: Apple Swift 6.4, arm64, macOS 27 SDK; package minimum macOS 26.4.

- The four focused session contracts ran against the old implementation first:
  15 expected failures exposed complete status, hidden partial camera and falsely
  successful verification. Healthy four-track and empty camera-loss controls
  passed. Log `/tmp/rush-camera-session-baseline.log`.
- The changed-surface Swift target passed 45 tests in five suites, including
  capture preview/clock tests, writer backpressure/pause/finalization, native MOV
  timestamp/recovery, failure regressions and normal four-track decoding. One
  existing opt-in live-capture test remained disabled under its unchanged gate.
  Log `/tmp/rush-camera-changed-surfaces.log`.
- Six real AVAssetWriter cases encoded and fully decoded generated 1920×1080
  inputs: 420v, 420f and BGRA, each with HEVC and H.264. Every case required five
  decoded frames, time zero, correct dimensions and actual requested codec.
- The error fixture confirmed AVFoundation/OSStatus domain and code retention
  while excluding unrelated private user-info values. Partial-camera fixtures
  required byte-for-byte preservation, including failure after accepted frames.
- Explicit changed-source/test/design contamination scan printed `0` on its
  first line; the scanner and assertions were not weakened.
- `swift build -c release` passed in 25.08 seconds, exit 0. Log
  `/tmp/rush-camera-release.log`.

The camera lane opened no physical devices and made no GUI, provider or installed
application changes. Source verification is not a claim of live capture recovery.
