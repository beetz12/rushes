# Recorder timing checks

The matrix uses generated media in an isolated Chrome profile. It never boots the Rushes application page or requests a real screen. Supply the executable from `scripts/install-test-chrome.mjs` through `RUSHES_CAPTURE_BROWSER_EXECUTABLE` when qualifying a named Chrome version. Each command should use a fresh proof directory; omitting `RUSHES_M1_PROOF` creates one automatically.

The existing default is headless Chrome with the browser's default video buffer. Explicit test options are:

- `RUSHES_M1_BROWSER_MODE=headful` shows the test browser; `headless` preserves the default.
- `RUSHES_M1_VIDEO_BUFFER=cpu` selects shared-memory FileFake video on Mac in `native-reference` mode. Other platform/source combinations fail before launch. `default` preserves existing buffering.

For the visible Mac FileFake configuration:

```sh
RUSHES_M1_SOURCE_MODE=native-reference RUSHES_M1_BROWSER_MODE=headful RUSHES_M1_VIDEO_BUFFER=cpu node browser/test/matrix.mjs
RUSHES_M1_SOURCE_MODE=native-reference RUSHES_M1_BROWSER_MODE=headful RUSHES_M1_VIDEO_BUFFER=cpu RUSHES_M1_REFERENCE=1 node browser/test/matrix.mjs
```

Qualify the fresh short run and 180-second reference, including the actual supplied PCM and optical phase, before considering `RUSHES_M1_LONG=1`. That mode still requires 600 seconds, five pauses, five minutes offline and every existing source, decoded-media, recovery and failure-handling check. Timing limits are unchanged: 100 ms including uncertainty and 250 ms continuity/duration agreement.

A mode selection is a test configuration, not a recording fix or qualification. Keep historical failures. FileFake delivery faults, consumer queue losses and encoded-output faults need separate evidence; a passing visible-browser run does not establish the cause of a headless failure. Tab activation alone does not prove physical minimization. Camera/screen hardware, Windows, other Chrome versions and the private cloud service require their own acceptance.
