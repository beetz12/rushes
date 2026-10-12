---
node: N1
skill: graph-design
graph: rushes-first-use-cloud
run: 2026-10-12
inputs: [sources.md, facts.md, shell/src/renderer/main.tsx]
status: draft
---

Loom's official guide takes users through capture choice, camera/microphone checks, start and pause/stop controls, then review and sharing. Its camera bubble is repositionable. This is evidence for the setup sequence, not proof that Loom uses the exact interactive spotlight proposed here. [S1]

Sendspark's official getting-started guide also moves from setup into a first test video, capture mode and camera/microphone settings, movable bubble, then the review/share page. Its documented setup uses a Chrome extension; it separately offers guest video-request links without installation. This supports a short path to a successful first recording and separating desktop capture from browser guest capture. [S6]

Rushes will implement an original spotlight guide around its existing controls: welcome; explicit Screen/Camera/Microphone permissions; source selection; optional camera, microphone and system audio choices; countdown and Start; bubble movement and closing; original tracks versus combined export and sharing. [S3] [S5]

The permission step must call the real native permission routes only after the user clicks each request button. Denied access explains the relevant System Settings route and relaunch requirement. Normal recording does not require Accessibility/Input Monitoring; those belong to optional advanced tracking. No device opens or recording begins merely because a guide step appears.

Skip persists as dismissed and never auto-shows again. Finish persists as completed. An explicit Recording guide button replays it. A real recording hides the guide without altering the active take. Spotlights use actual DOM bounds, adapt to scroll/resize, keep controls usable, and provide Back/Next/Skip and keyboard access.

Parent-provided contract: `api.onboarding('get' | 'dismiss' | 'complete' | 'reset')` returns `{version:1,status:'unseen'|'dismissed'|'completed'}`. `reset` is explicit replay only. Parent owns shared types, preload and main-process persistence. The renderer maker owns renderer main/style and its guide component. It may add `api.window('hide-bubble')` to the bubble's no-drag close control, and visible `api.window('quit')` controls to the normal shell; parent owns those handlers.
