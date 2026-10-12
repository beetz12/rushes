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

Final installed acceptance is pending.
