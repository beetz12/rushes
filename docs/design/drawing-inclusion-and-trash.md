# Drawing inclusion and undoable library trash

Original implementation from PLAN.md. No reference clone code read.

The shell owns one dedicated drawing window titled exactly Rushes Drawing. The
engine can explicitly exempt only that exact window from its own-app exclusion,
after checking window ID, shell bundle identity and title. Regular bar, bubble,
teleprompter and onboarding stay excluded. Desktop-independent window capture
cannot combine a second overlay; display and area modes support this filter seam.
No validation or service construction opens a window or capture device.

Library trash refuses active/interrupted packages and canonical/symlink escapes.
The whole package moves using the native Trash API, preserving its media. A random
local undo token remembers original and trashed paths for five seconds. Undo never
overwrites a new item at the original path. Expiry removes only the token, never
permanently deletes footage. Tests inject an owned scratch trash directory and a
controlled clock; native macOS Trash and user files are never touched by tests.
