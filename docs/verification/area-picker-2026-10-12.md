# Area selection over the current desktop

David reported that choosing a recording area opened a black screen instead of
letting him draw over the current desktop.

The investigation compared three causes:

1. **Native fullscreen / a separate macOS Space:** confirmed in the area window
   constructor (`fullscreen: true`). This contradicted the intended overlay.
2. **An opaque renderer:** ruled out by the area view's transparent root CSS and
   partially transparent selection scrim. Both are retained.
3. **Incorrect display bounds:** the selected display's full bounds were already
   passed to the window, and local selections were translated to global points.
   The existing negative-origin geometry tests passed. Geometry is retained.

The original installed app opened the `#area` renderer, with Cancel and aspect
ratio controls visible in accessibility. Its protected-window screenshot could
not establish desktop visibility; it is not evidence of the reported black color.

The fix uses a non-fullscreen, non-fullscreenable, borderless transparent window
covering the display, including the menu-bar area. It hides the visible recorder
and restores that same window on confirmation or cancellation. A destroyed,
replaced or already-hidden recorder is not reopened; quitting or an active take
also prevents restoration. Reopening an existing selector does not add another
restoration callback. Area selection is rejected during an active take.

Reference: [Electron window styles](https://www.electronjs.org/docs/latest/tutorial/custom-window-styles)
and the pinned Electron 44.7.0 constructor declarations. No reference app code
was opened or copied.

Node 22.22.0: shell build/typecheck and all 84 tests passed. Three regression
cases cover the display/Space configuration, crop coordinates, recorder lifetime
and failed creation. The changed-file clean-room scan returned `0`.

The merged-tree umbrella gate passed with exit 0: 319 native tests, 5 Intents
tests, 84 shell tests, 16 cloud tests, 4 viewer tests and 18 Worker tests.

The first installed check verified Cancel restored the recorder. Its rapid drag
produced a zero-size selection: the old handler depended on a move event with
`buttons` set and ignored the release endpoint. The renderer now tracks the
active pointer independently of React's render timing and always uses the
release endpoint. Cancellation clears the unfinished rectangle.

The temporary selection window's content-protection flag also prevented a
desktop screenshot from establishing visibility. Only this transient picker
is now unprotected; it contains selection controls, closes before recording,
and Rushes' own windows are excluded by the native screen capture filter.
Camera and other protected overlays retain their existing behavior. The
picker's specific title is preserved for native window selection.

Final acceptance passed on `/Applications/Rushes.app`, source
`873f588d2e8828815029c7fd05ec48f6678fa4bd`, signed with David's existing Apple
Development identity. Signature and packaged source hashes matched the staged
build. The previous installed app is preserved in the private proof directory.

- The display-sized picker opened as `Rushes — Select recording area` without
  native fullscreen. A drag from screenshot pixels (600,400) to (1800,1300)
  produced a 600 × 450-point rectangle on the Retina display.
- Confirmation restored the recorder and saved exactly
  `{x:300,y:200,width:600,height:450}` on `display-1`.
- Reopening then pressing Escape restored the recorder and preserved that crop.
  The Cancel button also restored the recorder in the preceding installed check.
- Starting from the installed recorder created take
  `01M4R9ABDCCKBTQDD7SMC8JB5J`, duration 9.729 seconds. All four screen, camera,
  microphone and system-audio tracks passed the native decode verification.
- `ffprobe` reported `screen.mov` at 1200 × 900 pixels, HEVC, duration 9.728333
  seconds, matching the selected point area at 2× display scale. An extracted
  frame visibly contained the underlying desktop, rather than a blank image.
- Native status returned idle with no warnings. Rushes was left in the recorder
  with Start recording available. Auto-share was false; the take remains local.

The final merged-tree umbrella gate passed again, exit 0, with the same test
counts. Private logs, original-app backup and test-frame evidence are in
`~/.goal-loop/loom-clone/host/2026-10-12-area-picker/`. Screenshot captures of a
transparent window isolate its own layer; they do not by themselves show the
composited desktop underneath. Crop video verification independently established
that desktop capture was nonblank. No second physical monitor was attached;
negative-origin display coordinates are covered by the geometry regression.
