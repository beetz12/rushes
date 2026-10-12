# Browser build evidence log

Current continuation (2026-10-12, supersedes earlier publication/run holds):
David approved publishing the two reviewed public snapshots, exact draft PRs and
generated Windows/Mac CI. Root created and attached draft PR8 (desktop de6658d)
and PR9 (browser520dfdb) as beetz12. A narrow workflow-context repair3ba35ea moved
runner.temp proof paths into step env; actionlint passed, approved PR bodies stayed
unchanged. No merge, deployment, private footage upload or live charge occurred.
Desktop installed physical acceptance remains complete; hosted native gate is
still pending. Browser hosted3ba checks failed on Mac155 initialization10s and
Mac154 cold timing/recovered download, while Windows jobs remain running.

The completed private eb47 default180s/full-five-reader buffer arm passed31/31
and all100ms/250ms assertions under122 observed-unlocked samples. No qualifying
stall occurred, so its conditional alternate arm was not run; pair actual exit2
is INCONCLUSIVE. The earlier9c full run still stalled at122.8s despite110 observed
unlocked samples. No cause or M1 acceptance is established.

Investigation confirmed a separate test precondition defect: appended capture
and matrix fixture routes follow Vite SPA fallback and serve App HTML/root/main,
instead of their intended blank fixtures. Root HTTP probe and private a7bea5a
matrix HTTP proof establish that fact, not that App boot caused either stall or
hosted timing failure. Root's QA-only repair installs pre-configureServer routes
and asserts fixture identity/no App/API requests. The UI recovery test now proves
actual durable camera bytes before reload and matches the downloaded byte prefix.
Independent read-only reviews qualified all three QA changes; product capture
hashes remain5f76b32. Node22 build/syntax/scanner0 and full local72/72 test exit0
(135.449s) passed. Its capture runtime was155.0.8059.39, but the later UI process
reported155.0.8059.40 after the system Chrome bundle updated; both are recorded.

A separate corrected-route short matrix on the fixed official Chrome for Testing
155.0.8059.39 exited1: three videos fully decoded240frames/~7.968s/maxgap63ms,
manifest complete8015ms, fixture title/root guard correct and no App/API requests.
The sync oracle then failed its exact audio upper bracket (ordinal2 versus3),
before recovery/fault cases ran. Preserve that failure and100ms/250ms guards;
bounded offline generated-media analysis is next. Longer capture/Pause-only runs
remain held. Neither QA repair is asserted to cure product timing or source stalls.

Private Pause-only preparationa7bea5a and premise correction8d27ca6 passed24
non-media checks/build/syntax/scanner, but no Pause-only take ran. The route and
browser-version premises invalidated the intended comparison. A new corrected
fixture/fixed-binary reference requires root review and release after sync review;
no automatic600s retry or alternate backend experiment follows.
Primary configuration sources: https://vite.dev/guide/api-plugin#configureserver
and https://developer.chrome.com/docs/automation-and-testing/chrome-for-testing.

Credential rotation completed at21:35UTC: David supplied the replacement JSON
and confirmed the original was disabled/deleted. Root privately validated exact
project/client/origin/callback and that the secret differs from the quarantined
original, moved the supplied download into the0700 host configuration directory
with0600 mode, and displayed no credential values. After a provider-page reload,
Google shows exactly one enabled secret, created2026-10-12 at17:31:15 EDT, and no
old/disabled row. This resolves the earlier rotation hold below. The replacement
is not yet bound to a deployed Worker or used for an application login; those
provider/release gates remain separate. Chrome's stale extension connection was
recovered with a new official connected Chrome tab, without an update, alternate
profile, native fallback or raw-CDP use.

Research reassessment after the bounded180s diagnostic: the same retained native
MJPEG file and unchanged565fdf4 production source completed19 protected diagnostic
checks with zero extra readers. Three video decodes were179.964s with gaps<=95ms;
all102 sampled host reads were unlocked. The native counters were available,
but the drop histogram was unavailable throughout; allocation attribution stays
inconclusive. The observed28 display-link stderr errors also occurred in this
successful run, so that message alone cannot establish recording failure. This
does not resolve earlier stalls or establish an unobserved lock timeline.

Historical preparation authorization (its later9c run failed; current holds
above govern): root authorized one full600s acceptance experiment at the
current reviewed capture source5f76b32, with original ordinal-sync observers,
five pauses, five-minute offline interval, exact source media/default Chrome flags
and unchanged100ms/250ms limits. The new controlled prerequisite is a Mac lock
read immediately before launch/start and about every2s through the run: missing
or locked reads stop/fail the experiment instead of being inferred after capture.
Only the existing matrix fixture and evidence may change; production stays
read-only. The isolated probe checkout must snapshot the root integration trees
exactly before instrumentation. Root holds actual capture until desktop packaging,
installed read-back/preview release and all native media/compile jobs are quiet.
This is not a blind repeat of either confounded earlier attempt: the research
pass establishes sustained input beyond the prior boundary under observed
unlocked conditions, and the next experiment tests the complete reviewed product
requirements without attributing the old failures to lock or changing assertions.
No physical background, Windows, provider or release pass follows automatically.

Current provider update (2026-10-12, supersedes older pending-branding/client
statements below): David approved the Google policy and branding action, then the
specific client origin/callback and his sole test access. Rushes branding is
External/Testing in the separate unbilled project nexai-rushes-20261012. The saved
Rushes Browser web client has only https://rushes-browser.nexai-rushes.workers.dev
as its JavaScript origin and that origin plus /auth/google/callback as redirect.
The vendor JSON read-back confirms those fields; saved proof records the client
table and sole David test user. No Worker deployment or real app login is implied.

Credential incident: the Google creation dialog exposes its Copy-button secret
inside an aria-label. A root button-label inspection printed that secret into tool
output. Root acknowledged the mistake and requested that David add/download a
replacement, then disable/delete the original in Google. Computer-use credential
changes require human takeover; the existing downloaded JSON is private0600 and
explicitly quarantined as unrotated. No secret is committed, bound to a provider
or used for deployment. Rotation and sign-in validation remain release gates.
The connected Chrome extension subsequently requested an update before further
browser control; no raw-CDP, alternate profile or credential workaround is used.

The two authorized installed desktop tests are now complete: camera-only14.726s
and screen/camera/microphone26.165s, all five raw tracks fully software-decode0 and
both separate exports hash-match their masters. Those media stay local, AutoShare
Off. A bounded desktop transport/renderer recovery repair is undergoing final
acceptance separately. The prior native locked-host and input-timer holds below
are historical. Root released exactly one180s observer-free browser allocation
diagnostic after observing an unlocked idle host and finishing all real media
decodes, with full native/media gates held until the diagnostic decode finishes.
That is an investigation, not M1 completion or permission for blind long retries.

- 2026-10-12: User authorized browser build from reviewed paid plan; selected NexAI Stripe test mode and dedicated NexAI Google OAuth app. Central epic openbrain-4pyn, slice issues .1 capture/.2 service/.3 UI.
- Shared contract/build scaffold f40c8c9 compiled under Node22.22.0, clean scan0, dependency notice checker36 directdeps and negativecontrols4pass. Three isolated writer worktrees share that exact ancestor.
- Read-only Cloudflare identity: david@nexaiadvisors.com, account2c4f33400a9a986505f6491b2fa3fa66, subdomainnexai-rushes, personal R2 rushes-media and D1 rushes-share. OAuth Stream storage read denied HTTP403/code10000; this token does not establish Stream access or activation. No resources mutated.
- Pre-change umbrella baseline stalled in unchanged native VideoToolbox finalization for more than8min. Sample from own testing helper22514 shows VTCompressionSessionCompleteFrames/RemoteVideoEncoder_CompleteFrames plus AVAssetWriter.endSessionAtSourceTime waiting. By the cleanup check all three recorded children had already exited, so no signals were sent. The baseline command eventually returned exit1: 319 tests / 31 issues, including native finalization/codec/damaged-media failures after 554.399s; retained log/sample in private evidence. Baseline is NOT passing. Earlier area task gate passed at the same source, but that does not replace fresh final verification. Browser-only builds passed; final native/full gate remains required.
- Integrated Capture 54153e7, Service 7304afb and UI 6f92d59. Root's service49 and UI26 tests passed; independent reviews then found four service and four UI failures. Makers are repairing those exact findings in one consolidated pass; no M1 or release pass is inferred from these local results.
- M1 fixture d023ba4 retained both long failures. Native input stopped at approximately16.37s without a playing preview and140.658s with the app preview; the second recording safely interrupted at156.064 effective seconds. Short matrix31 checks passed. Ten-minute capture, five-minute offline operation and physical background/minimization remain unverified. These headless pages reported visible/focused even after virtual tab activation.
- CONSTRAINT (research break after two matching native-input stalls): Do not repeat the fully instrumented600s test unchanged. The source-only65s control has one reader; the failing matrix adds five processor observers to production's two readers, five recorders and GPU drawing. Thus the control does not refute source-frame pool/backpressure pressure. Production has bounded normal-path frame ownership; no accumulating leak was established. The ordinal observer lacks a per-frame finally and durable post-initialization error reporting. The [W3C draft](https://www.w3.org/TR/mediacapture-transform/#handling-interaction-with-the-track) states that unreleased source-backed frames can stop source emission. Chrome's [documented processing workflow](https://developer.chrome.com/docs/web-platform/best-practices/webcodecs) supports the processing shape, not a guarantee for this entire load. Next diagnostic: one bounded240s run with unchanged production, five recorders, durable stores and playing preview; constant-tone AudioWorklet; no extra processor observers or tab activation. Completion would support an observer-effect hypothesis, never count as ten-minute or sync acceptance. Failure requires production writer/browser resource investigation before another long run.
- Verified Google CLI and Console identity david@nexaiadvisors.com. Existing gws-nexaiadvisors project shares the consent branding nex-cli; preserve existing clients and branding. The request to use a separate unbilled Rushes project under NexAI is pending David's preference.
- Integrated consolidated UI c762bfd and Service5c11c83; root5cef240. Root fresh service67/67 and currentChrome155 capture16/16 passed. Independent service replays and UI reassessment are passing so far; final artifacts pending. Numbered deployment now lists0001/0002/0003, verifies the remote ledger and rejects an unknown baseline. Dry-run verified the selected Cloudflare identity and created no resources. Fresh Stripe read-back identifies NexAI Advisors acct_1TwDR17fdq4Gx9wR, active test-only1500USD monthly price_1UPlW17fdq4Gx9wRoVuVGRdg. Preflight now matches the service's supported sk_ credential shape.
- Observer-free240s diagnostic failed: videos146.401s originals/146.367s composition, audible audio161.04s, watchdog interruption161.067s; append queue max2.331MB with p99~47.7ms and no source-observer errors. The actual native source independently decodes18,900720p frames/ordinals0..1259 (630s at configured30fps), so a146s source-file truncation was not established. Current host lock was observed Yes at17:10:29UTC; its start time is unknown, not a diagnosis. Earlier No snapshots do not establish unlocked status throughout earlier takes. Extra observer fan-out alone does not explain the stall.
- Research clue, not proven cause: exact [Chrome155 fake-device source](https://raw.githubusercontent.com/chromium/chromium/155.0.8059.39/media/capture/video/file_video_capture_device.cc) returns after a mappable-frame buffer reservation failure before scheduling the next capture task (lines632–644 and692–709). This warrants native capture/GPU logging rather than assuming canvas.captureStream or browser background throttling. No third full600s retry or production repair is authorized from this clue alone.
- Previous officialChrome154.0.8037.92 short capture gate exited1,15/16pass. First composition start was1627.4ms after the epoch versus~50ms originals/audio; total duration5943ms for the intended4300ms. The current ready message precedes first output. Keep the ≤100ms start/sync and original duration assertions protected while researching an output-readiness barrier. Evidence retained capture-root-repair-previous.log.
- Independent repaired UI78d7efe and Service dc218b9 verdict artifacts integrated. Root fresh UI36/36 passed on explicitly selectedChrome155; scanner first0 and notices36deps/5negativecontrols passed. Targeted UI/service PASS does not satisfy M1–M5.
- Fresh GitHub metadata at17:17UTC reports beetz12/rushes isPUBLIC. An earlier handoff's private-repository assertion was incorrect. No new browser push, CI artifact upload, draft PR or commercial deployment occurred. Obtain explicit approval for the concrete reviewed public source/PR publication before pushing this browser work. The final human gate is amended by this evidence; do not change repository visibility or assume public QA artifacts are private.
- CONSTRAINT (second research break): observer removal did not prevent native input stall. ExactChrome155 video processors use a per-chunk transfer optimizer, weakening the generic structured-clone/GC leak hypothesis; preserve that correction in M1 evidence. A single next180s diagnostic may poll existing native track statistics and isolated-browser frame-drop histogram buckets (feature-detected), with continuous lock samples and unchanged production, observer-free five-recorder load. Reservation drop reasons15/16 at source cessation would support the native allocation path, not establish why capacity was exhausted. No extra frame reader, production GPU-disable flag, background acceptance or full600s retry follows from this authorization. Missing counters make the probe inconclusive rather than a pass.
- C3 readiness follow-up ownership amendment: root owns the next change to browser/src/capture/composition.worker.ts, browser/test/capture-fixture.mjs, browser/test/capture.test.mjs and the original design note after the prior Capture maker completed. Inventory: ready is currently sent before consume/render; Window awaits that message before start; individual MediaRecorder start offsets are relative to one epoch. The first successful output must precede readiness, with existing initialization timeout/source-loss cleanup intact. Add a delayed-camera/first-output regression; keep original duration and ≤100ms offset checks. This is a separately justified startup repair, not a claim to fix the sustained native-source stall. M1's current diagnostic keeps its old source revision read-only.
- C3 inventory refinement assigns browser/src/capture/index.ts to root for the initialization abort seam: source ending before first output must reject the readiness promise immediately, cancel its timeout and release inputs/worker; late readiness cannot return a released session. Researcher's exact-generator-sink note distinguishes successful write from an encoded-frame guarantee. Native-drop recording is held until the host is unlocked; no lock/security setting is changed.
- C3 implemented: readiness follows first successful generated-frame write; preflight source failure cancels initialization and late readiness cannot return a released session. A delayed-camera regression and pre-output loss/release/no-draft regression preserve original timing assertions. Root Node22 build0, capture18/18 on installedChrome155 and officialChrome154, clean first0 and whitespace0. PreviousChrome cold first test now passes without relaxing duration/start offsets. Fresh native build0 (3.29s) but the complete native test gate remains pending an unlocked host. Independent C3/whole-candidate review is next; this startup result does not resolve M1's sustained source stall.
- Reviewer ownership: a fresh C3 reviewer owns only docs/runs/browser-cloud-2026-10-12/capture-readiness-verdict.md in its isolated checkout; a fresh final candidate reviewer owns only verdict.md/results.json. All business files are read-only to those reviewers. They may verify local fixtures, never sharedGUI, real devices, provider accounts, sharedBeads or source publication. Scope includes full contract/diff with explicit remaining M1/provider/publication gates.
- Fresh candidate reviewer found a Windows test-path defect: three UI fixtures use file URL pathname directly for Vite/esbuild filesystem arguments, retaining /D:/ and encoded spaces. Root owns a targeted portability repair to browser/test/ui-studio.test.mjs, ui-upload.test.mjs and ui-service.test.mjs after the UI maker completed: use Node fileURLToPath for filesystem arguments, retaining URL pathname for HTTP routing. This fixes the gate setup, never substitutes for actual Windows execution.
- Final reviewer found Windows PowerShell native-exit masking in multi-command steps; root split each install/build/check into a separate CI step (bb1d818), preserving failure exits. A bounded one-second capture analog also showed complete elapsed1016.9ms versus decoded969ms; strict service metadata rejects600016.9ms. Root owns the next index.ts boundary repair: dedicated active deadline and redundant worker/periodic stop 200ms before600s, preserving protected±250ms target, genuine elapsed metadata and strict server/provider/reservation limits. Over-ceiling delayed event loops must produce interrupted saved takes, never clamp time or grant cloud completion. Add normal/paused/delayed-loop short analogs before independent recheck; no long pass inferred.
- David approved the separate unbilled Rushes project and the real local Chrome screen/camera/microphone test. Created nexai-rushes-20261012, number346393733800, under verified NexAI organization999266641468; Resource Manager read-back ACTIVE/Rushes/expectedparent. Cloud Billing API read-back billingEnabled=false and no billingAccountName. Existing gws-nexaiadvisors branding/clients and CLI default project remain unchanged. Camera permission approved only for this test; local browser preview becomes active. Native installed engine read-back idle88091 before testing; no active take was interrupted. No local test footage is uploaded.
- Latest user requested five desktop control/export/preview/countdown/minimize fixes alongside the browser build. Central native child openbrain-v05d.1 claimed; isolated766434f contract in /Users/dave/Work/rushes-desktop-controls assigns shell/src to one writer, backend/otherpackages read-only. Root owns installed device checks and release; no source publication occurs without concrete approval.
- R3 bounded normal/pause/delayed-loop analog passed at the strict one-second ceiling after dedicated deadline repair: actual elapsed remains genuine; ordinary/paused take completes below the ceiling and delayed controls retain an interrupted take. Build0 and scanner first0. Server manifest/provider/reservations remain600s, no metadata clamp or widened limit. Full changed browser gate and independent R3 replay are next.
- Real Chrome155 screen+MacBookProCamera+MacBookProMicrophone test finalized complete at181954.9ms with4 separate tracks. It ran longer than the intended brief test while root handled the picker; root stopped it and disclosed the overrun, rather than recategorizing it as planned M1. All4 files were exported through actual buttons and every ordered closed-chunk digest matched exported bytes. Full software decode0 for each; screen1112x720/5279frames/~29.01fps/maxgap61ms, camera1280x720/5458/~30fps/maxgap42ms, composition1280x720/5338/~29.34fps/maxgap68ms. Microphone Opus48kmono RMS~-49.99dB; composition Opus48kstereo RMS~-49.98dB, nonzero recorded signal. Start-offset spread48.7ms. This establishes the local three-minute path, not voice intelligibility, quantified long sync, ten minutes, five pauses/offline/background or Windows. Actual private files stay under real-device/0700 and Downloads; no upload.
- Mac locked again after the real test and file verification; no physical capture remains. Native-drop instrumentation ef90278 is integrated but has NOT run; it remains held for an unlocked host. Native five controls377b518 and strict preview-lifetime seam e766577 are committed separately,117shell+8native state tests pass in the maker checkout; fresh independent native review is running. Native installed app remains unchanged pending its gates.
- R3 review caught a late worker-limit/cancel rejection; c196cee uses the existing guarded stop helper. Review also caught TypeScript narrowing at the post-start watchdog predicate. An earlier redirected build followed by git-diff incorrectly exposed only the final command's exit; its retained log contains TS2367 and is not a passing build. 7d12f9a moves the active-state predicate into a real helper; fresh standalone declared build exits0 with substantive Vite/typecheck output. Preserve both failures and exact repair history. The combined browser test command has completed capture19 assertions but remains running without a suite total; it is not an integrated PASS.
- The combined parallel-file browser gate remained running >10min after capture19 assertions, with live test Node/Vite handles but no test Chrome processes observed at the later sample. Root terminated only its verified85160/85163 descendants (85168/85175 had already exited by their signal checks); retained command exits1, no suite total, no PASS. Exact shutdown cause remains unproved. Browser tests share host media resources and Vite caches, so root serializes file-level execution for the next controlled gate; no assertion or product behavior is weakened and no force-exit flag is used. A repeated shutdown signature requires a research break, not another blind gate retry.
- The controlled serialized browser gate at e99cc35 completed with actual exit0 and a complete TAP footer:64/64 passed, no cancellations/skips,93.486s on Node22.22/installedChrome155. Retained browser-serialized-gate.log. This is a local source gate, not Windows, long-take M1, deployed OAuth/billing or public CI evidence. Native five-control independent review found no supported blockers;117shell/8native state checks and generated original-export hashes passed. Release native build completed0 in26.63s; installed app remains the preceding version while locked-host/full-media checks are pending. No Google policy was accepted: the dedicated testing branding form is prepared and awaits action-time confirmation.
- Independent R3 recheck passed both19-test capture versions and five deadline/cancel cases, then found an early-Pause startup race: the first recording save may still be pending after public state becomes recording; a valid Pause changes the state before watcher installation and the recording-only predicate skips it permanently. Root owns the narrow index/test/design repair: watcher installation follows unreleased/non-ending take ownership, callback actions and take deadlines remain recording-only. The new regression holds that save, pauses before start resolves, then verifies one live watcher across Resume and release on Cancel. No long-take success follows from this correction.
- baa7275's new watcher regression passed, but the full currentChrome gate retained a calibration failure:screen15.1ms/composition119.1ms, spread104ms versus the unchanged100ms target;64/65 pass, actual exit1,96.011s. Inserting the new capture test first also changed the protected original cold-first measurement. Read-only primary-source research requires restoring original test ordering without claiming that cures the failure. It additionally confirmed cancel never awaited the asynchronous MediaRecorder terminal events. Root owns a narrow cancellation completion repair using the existing15s bound and one shared promise; immediate release and discarded-draft cleanup remain, including timeout reporting. This is not evidence that delayed encoder shutdown caused the spread or that stop events prove native GPU resources are freed. Preserve the failed log and validate cold-first and cancel-then-next-take separately.
- The first cancellation-repair full gate exited1 with65/66 passed in94.460s. Original cold-first calibration passed at22.3ms start spread; the new cancel probe failed in its own finally because it cleaned the same fixture AudioContext twice. Root repaired that probe to clean it once, preserving every assertion and both production cancellation behaviors. A focused fresh probe then passed: both cancel callers wait for delayed terminal events; devices release immediately; the following five-track take fully decodes with <=100ms starts; a synthetic shortened15s deadline reports unconfirmed encoder stop while still removing the explicitly discarded draft. This focused pass is not the unfinished full gate or long-take proof.
- Root's repaired full currentChrome gate at5f76b32 completed actual exit0:66/66 passed in94.912s, no skipped/canceled tests. The original first-cold calibration and new early-Pause, concurrent-cancel, subsequent-take and timeout-cleanup assertions remain intact. Build0 and changed-source scanner first0. Independent final review is released for its bounded new-source oracles and previousChrome21-test capture gate; the root current gate does not replace that review, M1, Windows or provider launch checks. Desktop candidate c8ee107 is fast-forwarded onto clean local release main, matching its signed staged source; no remote push. Staged signature0, five packaged shell file hashes match source dist, native engine/CLI Mach-O UUIDs match the fresh release products, automation helper is embedded and verified. The installed app remains873f588; the locked Mac still blocks full native media and physical install tests.
