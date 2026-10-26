# Rushes MAS sandbox feasibility independent source review

Verdict: **ACCEPT-WITH-NOTES** for the feasibility tooling and the bounded diagnostic decision. This does not accept the Electron MAS product, physical capture, paid cloud or App Store submission.

Reviewed the frozen implementation in `scripts/mas-spike`, `verification/mas-spike`, the additive public workflow, the feasibility report and the governing plan. The source hash manifest is in `source-review.json`; Git HEAD at review is the public base23ab6d6, with new files still awaiting the parent's checkpoint/publication.

## Evidence personally checked

- Final `python3 scripts/mas-spike/check.py` gate receipt has actual0 for source,29 receipt controls,clean-room,fresh native probe and independent receipt verification. The raw source log ends with the real success marker after414native+5Intents,231shell,44cloud,10viewer,18worker,389web+15shipped-boundary and42Node verifier tests. This review did not rerun a competing install/probe while the parent's gate was active.
- Independently ran29 verifier self-checks: actual0, `Ran 29 tests ... OK`. Independently ran actionlint on the new workflow: actual0. The workflow job requires exact public `beetz12/rushes` and `private == false`; no private backend workflow or publication is added.
- Independently verified the fresh final native receipt. It accepts two generated native lifecycles, actual runtime sandbox entitlement, denied outside write with an unsandboxed positive control, inherited unchanged helper IPC, four finalized original tracks, separately decoded combined/original outputs and retired native sessions/sockets. It keeps full MAS/provisioned/physical/Store fields false.
- Independently altered actual generated original, copied original and combined MP4 bytes, then attempted verification both with the recorded mapping and with that individual file's hash entry omitted. All six cases reject. Restored every named file byte-for-byte in `finally`, rehashed it and confirmed baseline acceptance after each restore. Also independently rejected forged true values for all four full-MAS/physical/Store acceptance flags. Raw results and errors are retained in `review-controls-final.json`.
- The initial combined-file omission control reproduced a real verifier hole. It is fixed by exact required-media hash coverage; the retained initial failure is `review-combined-controls-initial.json`. The final control now rejects with `Saved media hash coverage is incomplete or contains unexpected paths`.
- Personally read the official Electron MAS guide and Apple's archived sandbox/inheritance reference. The full MAS profile/application-group requirement and export-grant follow-up are consistent with those sources. No permissive sandbox exception is used.
- Read the separate actual pinned MAS bootstrap output: `mas:true`, version44.7.0, then actual signal5/MachPortRendezvousServer bootstrap_check_in permission denial1100 before readiness. Rehashed the129454448-byte archive and matched its retained official checksum entry, SHA256a9bfda0de8836d8a1db337d8f11b7c3baee800d9c144ae429d8cb6a169023ae7. The bootstrap used ad-hoc signing without a profile/registered group and retired its owned session; it is correctly a failed incomplete-config experiment, not a proper-MAS or native-recording failure verdict.
- Compared the saved before controls with current installed ASAR and Info.plist hashes: both unchanged. Compared private backend HEAD/status with the before control: unchanged and clean. This is bounded preservation evidence for those exact checks, not a full machine audit.

## Resolved review findings

Actual media and manifest bytes are reopened; raw decoder argv names the expected originals and combined file. Recomputed original/signed Mach-O loadable sections bind unchanged helper code. Failure branches cannot skip external session/socket retirement checks. Exact media hash-set coverage prevents omitting combined output. The runtime no longer unconditionally asserts a missing profile from an unclassified inventory.

## Remaining limits and next condition

The small native parent's generated-video/silence acceptance does not transfer to the real Electron windows, physical screen/camera/mic/system capture, area picker, user-selected folder exports or migration. The existing standard-directory inventory is a local capability observation, not proof of paid Apple membership status or remote certificate absence. The supported next full-MAS attempt requires the owner's legitimate profile/signing/application-group configuration, a dedicated MAS build and actual capture/export/restart/Quit acceptance. The file-access, updater and automation changes listed in the report remain work to do. Paid cloud and Apple purchases remain later independent gates.

Source, evidence and scope are acceptable for checkpointing the completed feasibility diagnostic. Parent remains responsible for task status integration, exact-source checkpoint/publication and any hosted CI conclusion; none is inferred here.


## Addendum - October25,2026 Eastern: CI clean-room stream handling

Verdict remains **ACCEPT-WITH-NOTES** for the diagnostic and this targeted logging correction. The earlier accepted local run did not exercise the CI-only absent-reference warning. Its current-stream limitation is corrected without changing the scanner, reference allowlists, clone policy or the zero-hit acceptance criterion.

Read the actual `check_clean.py` writer: it emits the permitted absent-reference warning on stderr and the numerical hit count on stdout. The gate now captures those streams separately for this metric, preserves both files and requires both actual exit0 and first stdout line exactly`0`. Warnings cannot replace or masquerade as the metric.

Personally exercised the production `logged_step` helper with five real Python child processes:

- warning on stderr + stdout0 + exit0: accepted; both exact streams preserved.
- warning + stdout1 + exit0: rejected.
- warning + stdout0 + exit9: rejected.
- warning + empty stdout + exit0: rejected.
- warning incorrectly preceding0 on stdout + exit0: rejected.

Independently ran all32 controls: actual0, `Ran 32 tests ... OK`; actionlint: actual0. Independently verified the new maker native receipt: native mechanics accepted, full MAS and Store readiness false. The media verifier was unchanged, so the six earlier real-file mutation/omission controls are preserved and not needlessly repeated. The parent retains the actual pre-fix warning/zero regression failure in `logs/clean-room-streams-red.log`.

Own controls, command exits and preserved streams are in `review/streams-fix/results.json` and its named subdirectories. Updated source hashes are recorded in the JSON addendum. The parent is running the new full union gate at `final-gate-streams-fix`; this review does not infer its eventual result or a hosted CI conclusion. Parent must inspect that actual result before checkpoint/publication, as already planned.


## Final addendum - October25,2026 Eastern: completed union gate and final CI artifact scope

Verdict: **ACCEPT-WITH-NOTES**, frozen for the current feasibility source. Personally read `final-gate-streams-fix/gate.json` and the named nonempty raw logs: all five steps have actual exit0 and acceptedtrue. The32-controls log ends in `Ran 32 tests ... OK`; the fresh independent-receipt log accepts two native lifecycles with Electron MAS and Store readinessfalse. Personally reran the strict verifier against that exact fresh final receipt: actual0 with the same limited native acceptance.

Read the final workflow after the upload-path change. It still permits only public `beetz12/rushes`, retains read-only repository permissions, the pinned checkout/uploader/nvm bootstrap, the same source gate command and45-minute bound. Artifact upload now includes only JSON,log,stdout andstderr files under the generated diagnostic evidence directory; compiled app bundles and generated media files are excluded. This changes upload scope, not the checks or sandbox permissions. Personally reran actionlint: actual0. Current workflow SHA256 is `0a44d61f259387b22f07b29acbf3fd60567a78427e92a80ca496a8c7cc0fec5a`.

The JSON review preserves the earlier snapshots and now includes `current_reviewed_source_hashes`. Source review is complete; no further code change is requested. The parent owns the final named-path commit, public feature-branch push and actual hosted CI result. No default-branch merge, deployment, private push or Store acceptance is implied.


### Correction - extra receipt recheck after the parent checkpoint

The preceding final addendum incorrectly says my extra strict final receipt recheck returned0. Its actual exit was1, with `Source revision changed`: the parent checkpoint advanced HEAD while the receipt still names the pre-commit revision. This is the verifier's expected rejection of stale revision evidence, not a new native recording failure. The observed completed union gate still has all five actual0 results. A new post-commit receipt must be generated before claiming another strict0 recheck at the new HEAD. No source code change is requested. The JSON addendum now records the actual1 and both revision identities.
