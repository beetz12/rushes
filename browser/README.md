# Rushes browser recorder

The browser implementation records separate screen, camera, microphone and
available shared-tab audio tracks, plus a composition with a movable camera bubble.
Recordings first save to this browser's local storage. Cloud hosting uses a separate
paid account service. The native Mac app and personal sharing service are independent.

## Local development

Use Node22.22.0 (`.nvmrc`). From the repository root:

```sh
npm --prefix browser-worker ci
npm --prefix browser ci
npm --prefix browser-worker run build
npm --prefix browser run dev
```

Open the displayed localhost URL in desktop Chrome. The first-use guide explains
devices and capture; Skip persists and Guide reopens it. Camera and microphone
permission requests occur on their buttons. Start recording opens Chrome's screen
picker on every screen take. Drag the bubble in the composition preview. Stop opens
review with composition and separate-original downloads.

This development URL has no configured account service. Local recording and downloads
work independently. A supported HTTPS deployment serves assets and the API together.
Cloud backup during recording is explicit, optional and requires an entitled account.
If offline, closed local chunks remain durable and uploads can retry after reconnect.

Keep important originals outside browser storage: choose a backup folder before a take
or download the original tracks afterward. A browser storage clear or profile removal
can erase local drafts. Interrupted recordings retain acknowledged chunks and show
recovery status; an interrupted encoder tail cannot be promised playable.

## Validation and current release limits

```sh
npm --prefix browser-worker run check
npm --prefix browser run build
npm --prefix browser test
node browser/test/matrix.mjs
```

The independent matrix requires `ffmpeg`, `ffprobe` and desktop Chrome. Override the
isolated test browser with `RUSHES_CAPTURE_BROWSER_EXECUTABLE` (and `RUSHES_CHROME`
for UI tests). `scripts/install-test-chrome.mjs` downloads official current/previous
Chrome for Testing into an explicitly supplied isolated directory. It never uses
the user's signed-in profile. CI runs Mac and Windows combinations; a configured
workflow is not proof that its remote run passed.

`RUSHES_M1_LONG=1 node browser/test/matrix.mjs` is the protected ten-minute test.
Two initial long tests failed when native input stalled. Read the retained evidence
in `docs/runs/browser-cloud-2026-10-12/slices/m1.md`; do not infer maximum-duration,
physical background/minimized, Windows device or public paid-launch acceptance from
short fixture passes. Browser capability detection is mandatory. Safari, Firefox and
mobile are outside the first release's tested support target.

See `browser-worker/README.md` for server contracts and numbered database migrations,
and the reviewed `docs/product/first-use-cloud-2026-10-12/cloud-plan.md` for paid limits
and deployment gates. Provider configuration and test-mode acceptance remain required.
