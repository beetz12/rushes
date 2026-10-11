# Active capture geometry

Original metadata adapter using the current repository's source model. No
reference clone source read. A read-only rig hook provides mode, optional
displayID, and rect{x,y,width,height} in global top-left screen points for bubble
normalization. Output pixel dimensions do not change this rectangle.

Display mode reads the selected active display bounds. Area returns the exact
preflight-selected global area. Window mode reads the selected current window
bounds on each request so motion/resizing are visible; a vanished source returns
nil rather than switching to another display. Camera-only returns nil. Production
callers require an active recording. Diagnostic rigs return only synthetic
geometry and never access native window metadata. No capture or permission API
is called and no UI is opened. Tests inject rectangles, including negative
monitor origins, moved/resized windows, and nonfinite/empty bounds.

Primary SDK contracts: [CGDisplayBounds](https://developer.apple.com/documentation/coregraphics/cgdisplaybounds(_:))
and [kCGWindowBounds](https://developer.apple.com/documentation/coregraphics/kcgwindowbounds).
