# Recording setup and finish flow

2026-10-15. Original Rushes design; no Loom source or assets are copied.

The current Mac [Loom guide](https://support.atlassian.com/loom/docs/get-started-with-loom-for-macos/)
places capture mode and device choice before Record, hides the toolbar during
capture and offers preview and sharing after Stop. Its [defaults guide](https://support.atlassian.com/loom/docs/understand-your-default-recording-settings/)
documents remembered capture mode, camera and audio source. These are documented
workflows, not proof of every behavior in the installed build.

Loom 0.379.4 arm64 was installed from Atlassian's official download link and its
notarized Developer ID verified. It launched to a sign-in screen. REA 6.5.0 was
installed from npm, alongside a clone of morluto/rea at c7f6b8bad1a34d5efb30ff2a017672dea1fcdabb.
The complete ASAR exceeded REA's header budget. A selected, extracted five-module
scope (recorder, pre-recording panel, control menu, permission onboarding,
countdown) parsed successfully: 5 JavaScript files, 306 recovered bundled modules,
no parse failures. Evidence ev_160b117416be4850ee9f730aee9f8e05a9d359d47f97c0185b27ddffdc98ec53.
It reports incomplete graph coverage and unresolved dynamic IPC; it establishes
static structure only, not live defaults, source enforcement or end-to-end capture.
Analysis artifacts remain private outside this repository. No analysis engine,
client MCP registration, Loom account, recording upload or paid plan was created.

Rushes adapts the general sequence to its existing local-first architecture:

- Choose Screen + camera, Screen only or Camera only. Switching back from camera
  restores this session's previous screen selection. Device dropdowns remain the
  source of truth; microphone and system audio stay explicit choices.
- Choose the actual display, window or area. Show its name or dimensions.
  An unselected area/window and missing access explain why Start is disabled.
  Apply the same readiness check to the renderer's shortcut-start path.
- Put preview beside devices so Start fits the default 1120 by 780 window.
  Keep saved setups collapsed. Show the enabled original tracks and explicitly
  warn when voice capture is off. Preserve existing countdown/minimize controls.
- Reflect Auto-share accurately. Local-only language must not appear when the
  option will automatically upload the finished take.
- After Stop, preserve local review. Promote Save video (combined share MP4) and
  Save separate tracks (unaltered originals) beside the title. Sharing explains
  its upload and sits before optional layout/export details. Keep destructive
  and diagnostic tools in More actions; background jobs stay expandable.
- Guide the first take through capture choice, source, required access, devices
  and Start. Preserve durable Skip and manual replay. Explain export at review.

This is a desktop UX improvement. It does not resolve the separate draft browser
recorder's sustained capture/synchronization gates or verify paid cloud auth,
billing, quotas, delivery cost controls, notarization or Windows desktop support.
