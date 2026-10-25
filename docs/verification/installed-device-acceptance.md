# Installed-device acceptance

Use the pinned shell Node runtime. The installed app, current product sources,
passing source-union receipt and independent media probe are bound in the report.
Packaged main/renderer, SDK/viewer and normalized native executable content must
match the source-gated build outputs. A co-recorded source hash alone is insufficient.
No provider credential or user recording library is loaded. Use a new private
output directory for each attempt; failed roots are retained.

```
node verification/installed-recording.mjs --exercise --allow-local-physical \
  --app /Applications/Rushes.app --evidence-root /absolute/new/private/evidence \
  --source-proof /absolute/passing-source-union.json
```

This explicit exercise opens one isolated app profile, generates a separately
identified test window and quiet coded tones, then captures brief real display,
window, drawn area and camera-only takes. Display captures include real camera,
microphone and system audio as separate originals. A native preview composition
is independently decoded. No upload is made. Existing OS permissions are required;
the runner does not grant them. Follow the workspace's input/GUI policy. Only
with explicit user authorization may `--input-override` bypass the idle timer.
Keep the display awake through the authorized temporary test assertion.

The helper reuses the existing selftest tone transport and schedules visual
markers on the same host clock. It never runs `selftest sync`, writes the user's
latency store, or applies latency/clock corrections. The source is armed after
capture starts; all six non-periodic cues have head/tail room. Source schedules,
actual selected source/device IDs, exact separate roles, decoded stream types,
starts/tails, gaps, non-silent finite PCM and coded content
onsets are checked independently. The microphone floor establishes non-silent PCM;
it does not establish speech intelligibility or a listening-quality assessment.
All six scheduled cues must have head/tail room and be observed in both tracks.
Bounds remain100ms for content/timeline sync
and250ms for decoded gaps. An unavailable reference or mismatched pulse is
unqualified; successful file finalization alone does not establish timing.

`--calibration-only` generates/decodes the source file without OS/device capture.
`--signal-only` records just the generated screen/system-audio transport. Their
reports have distinct scopes and cannot satisfy full installed acceptance.

```
node verification/installed-recording.mjs --recheck --evidence-root /absolute/private/evidence
```

Recheck opens the saved originals, recomputes hashes, independently decodes them,
remeasures the actual installed signature/payload/source identity, and checks
content sync. It does not launch an app, record, upload, alter settings or install
an update. Source preparation and generated controls are not a real device pass.
Production Developer ID/notarization and signed updates remain separate checks.
