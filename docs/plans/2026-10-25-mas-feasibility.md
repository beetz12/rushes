# Rushes Mac App Store sandbox feasibility - Implementation Plan

## 0. For the executing agent

You are executing this plan autonomously. The author is not watching and cannot
answer questions mid-run. This document is the contract and the state file.

1. Work one task at a time: pick the single highest-priority task whose Status
   is pending and whose dependencies are done. Complete it, verify it, commit,
   update its Status, then take the next.
2. Keep going until every task is done and the Final gate (section 3) passes.
   Do not stop at analysis, partial fixes, or a plan. Never end a session with
   a promise of future work - do the work first.
3. You may edit ONLY: task Status fields, the progress file, and the Decision
   Log. Never edit, remove, or weaken acceptance criteria, Verify commands,
   tests, invariants, or this preamble.
4. Full implementations only. No placeholders, stubs, mocks-as-implementation,
   or TODO comments. If tests unrelated to your change break, fixing them is
   part of your task.
5. Do the simplest thing that meets the acceptance criteria. No unrequested
   refactors, features, abstractions, or defensive code for impossible cases.
6. Before reporting progress, audit each claim against a tool result from this
   session. Only report work you can point to evidence for.
7. If uncertain, make the most reasonable assumption, record it in the Decision
   Log, and continue. Mark a task blocked(<reason + question>) ONLY for:
   destructive or irreversible actions not covered by this plan, a material
   scope change, or information only the author can provide - then continue
   with the next unblocked task. If ALL remaining tasks are blocked, write a
   BLOCKED summary with targeted questions in the progress file, then stop.
8. Session start ritual: read the progress file, run `git log --oneline -20`,
   re-read this plan; run the smoke check (section 8); only then start work.

## 1. Mission

- **Goal:** Produce a reproducible sandbox feasibility decision for the existing native recorder and Electron Store distribution path, with the actual evidence and next release conditions.
- **Why / who for:** David approved the October25 market/App Store plan and asked to start with the feasibility spike before paid cloud and Store purchases.
- **Specs:** The current market assessment at /Users/dave/Work/rushes-market-review-20261025/market-and-app-store-review.md; Apple App Sandbox documentation and Electron MAS submission guide.
- **Authority:** User request in this chat authorizes preparation, implementation and tests. It does not authorize purchase of membership, use of another company's team, production deployment, default-branch merge or App Store submission.

## 2. Context and orientation

- **Repo layout:** Shared native Swift source in Sources, desktop Electron shell in shell, first-party diagnostic scripts in scripts, independent verifiers in verification.
- **Key files and interfaces:** Sources/rushcore-engine/main.swift accepts explicit socket, recordings and index paths plus generated capture. shell/src/main/engine.ts launches the engine and connects NDJSON over a Unix socket. Re-read these interfaces before editing.
- **Exemplars:** scripts/app-intents for native helper packaging; verification/process_contracts.py for request and lifecycle checks. These are patterns, not evidence of Store compatibility.
- **Commands:** build/test `bash scripts/check-mac-web.sh`; diagnostic umbrella `bash scripts/check.sh`; native helper `swift build`.
- **Environment:** Per-package .nvmrc pins the Node runtime; actual available pinned Node22.22.0. Read Xcode/Swift and signing capabilities again at execution.
- **Conventions:** User AGENTS rules and CONTRIBUTING.md. No project AGENTS/CLAUDE file found in this worktree on intake.
- **Worktree:** /Users/dave/Work/rushes-mas-feasibility-20261025 on codex/mas-feasibility-20261025, clean public base23ab6d6.
- **Evidence:** /Users/dave/.goal-loop/loom-clone/host/2026-10-25-mas-feasibility, retained outside automatically purged loop state.

## 3. Definition of done

- Runnable bounded native-parent sandbox probe tests inherited unchanged real helper IPC, container writes, generated take and separate/combined export decode, repeat and clean retirement where signing permits execution.
- Sandbox assertion uses signed entitlement read-back and an actual denied out-of-container write, with an allowed container-write positive control. Renderer sandbox:true is never substituted for Apple App Sandbox.
- A failed launch, unavailable profile or unsupported path produces retained raw evidence and a precise blocking condition. No check is marked passed without observation.
- Electron MAS feasibility is separately measured or explicitly unrun on a named prerequisite. Native adhoc success cannot qualify the full MAS app.
- The report maps storage/import/bookmarks, automation/hotkeys, updater, capture permissions, helper signing and shutdown to actual source paths and required follow-up.
- Independent command verification and a non-writer review accept the evidence and limits. Source gates remain green; installed0.1.3 and personal recordings stay untouched.
- **Final gate:** Run the declared Mac/web umbrella, diagnostic receipt self-checks and a fresh independently launched bounded probe, then review the complete diff. A complete spike may conclude conditional/no-go; this is not production acceptance.
- **Final gate command:** `python3 scripts/mas-spike/check.py`

## 4. Non-goals

- No StoreKit, paid backend, new prices, live charges or third-party account provisioning in this spike.
- No installation over /Applications/Rushes.app, migration/deletion of real originals or implicit Keychain changes.
- No browser/Windows recording, lowering OS floor without audit, distribution release or automatic updater rollout.
- Do not refactor, add features, or introduce abstractions beyond what the tasks require, even where the code invites it. Note such opportunities in the progress file instead.

## 5. Invariants

- I-1: Shared source and CI belong to PUBLIC beetz12/rushes. Private backend/history remain PRIVATE; no private Actions execution or credits.
- I-2: No fabricated certificate/profile/team, broad sandbox exception or weakening of a check to turn a failed experiment green.
- I-3: Acceptance criteria, Verify commands, tests and this section are protected artifacts; only Status, progress and Decision Log may change without human amendment.
- I-4: All spike bundles live outside Applications under a .noindex directory, with separate bundle IDs, runtime paths and owned-process cleanup. Never terminate another session's app/engine.
- I-5: Missing paid Apple identity/profile can block provisioned acceptance, not the rest of safe local investigation. No Apple purchase or account change is inferred.
- I-6: Real screen/camera/microphone tests need available unlocked UI and existing explicit authority; no personal footage upload/publication. Generated media are identified as such.
- I-7: Source gates and actual logs are preserved. Do not weaken existing timing/decoder/recovery criteria or reinterpret old failed runs as passing.

## 6. Task breakdown

### Phase 1: Feasibility experiment

#### T-1: Reproduce sandbox mechanics around the real engine
- **Files:** scripts/mas-spike/; verification/mas-spike/; docs/distribution/mas-feasibility.md.
- **Depends on:** -
- **Acceptance:** WHEN the diagnostic is run THE SYSTEM SHALL produce source-bound raw results for native sandbox entitlement/enforcement, inherited helper requests, generated-media/export/cleanup and the Electron/signing prerequisites, separating observed passes from blocked or unrun checks.
- **Verify:** `python3 scripts/mas-spike/run.py --output /Users/dave/.goal-loop/loom-clone/host/2026-10-25-mas-feasibility/maker-probe` ->0 only for a complete bounded experiment; `python3 verification/mas-spike/verify.py /Users/dave/.goal-loop/loom-clone/host/2026-10-25-mas-feasibility/maker-probe/receipt.json` ->0 with explicit scope and verdict.
- **Status:** done

#### T-2: Independently validate the decision and preserve regression coverage
- **Files:** scripts/mas-spike/check.py; verification/mas-spike/; .github/workflows/mas-feasibility.yml; docs/plans/2026-10-25-mas-feasibility.progress.md; docs/plans/2026-10-25-mas-feasibility.review.md.
- **Depends on:** T-1
- **Acceptance:** WHEN the whole spike is reviewed THE SYSTEM SHALL pass the declared source gate, independently rerun the observable probes and reject falsified acceptance/cleanup/entitlement evidence. The report must state the exact next condition for any full-MAS or physical test not performed.
- **Verify:** `python3 scripts/mas-spike/check.py` ->0 for source/tests/independent receipt verification; fresh non-writer review ->ACCEPT or ACCEPT-WITH-NOTES, preserving remaining Store gates.
- **Status:** done

### Phase 2: Hosted gate qualification after the diagnostic checkpoint

#### T-3: Preserve the real writer response bound on the hosted runner
- **Files:** Tests/RushCoreTests/WriterFinalizeBudgetTests.swift; Sources/RushCore/Writers/WriterFinalization.swift and TrackWriter.swift only if a causal production defect is demonstrated; docs/plans/2026-10-25-mas-feasibility.progress.md; bounded diagnostic evidence outside Git.
- **Depends on:** T-2
- **Acceptance:** WHEN the public source gate runs THE SYSTEM SHALL preserve its actual100ms finalize budget,250ms caller-response assertions, original/media ownership and cleanup assertions. Retain run40261473389's actual254.802041ms failure. Diagnose against unchanged source and primary runtime guidance before edits. A demonstrably blocking fixture must use an appropriate execution context without increasing thresholds, deleting assertions, skipping checks or using a global environment workaround. Production changes require causal evidence. Both the source/diagnostic union and the exact new-head public hosted workflow must pass before hosted qualification is claimed; any residual historical cause uncertainty remains explicit.
- **Verify:** `python3 scripts/mas-spike/check.py` ->0; targeted original/fixed supported-configuration controls with real exits and executed test counts; exact-head `gh run view` ->completed/success with the actual gate step successful; fresh non-writer review ->ACCEPT or ACCEPT-WITH-NOTES without altered bounds.
- **Status:** in_progress

## 7. Verification protocol

- Per task: run Verify before flipping Status to done and paste actual output/tallies into progress. Preserve complete raw failed and passing logs under durable evidence.
- Per phase: a fresh non-writer checks the phase diff against this plan and the disproof predicate: any passed sandbox/capture/MAS claim without the corresponding enforced runtime observation rejects the report.
- Final: all tasks done, source gate green, fresh diagnostic validation and adversarial review of the complete base-to-HEAD diff.
- Controls must fail when app-sandbox, denied-write evidence, source binding or process cleanup evidence is removed or falsified. A report that marks provisioned-MAS acceptance from an adhoc native result must be rejected.
- A diagnostic outcome and a working Store app are different propositions. The final report must preserve that distinction even when the feasibility artifact itself passes.

## 8. State and checkpoint protocol

- **Progress file:** docs/plans/2026-10-25-mas-feasibility.progress.md. Append evidence and corrections after each task.
- **Smoke check:** `git status --short --branch` followed by the current declared source gate before implementation. Parent started the stronger full diagnostic baseline before code changes.
- **Commits:** Named owned paths only after green gates and inspection of staged diff. Never include private backend, real footage, credentials or previous session changes. Draft PR only under applicable publication rules; no default-branch push/merge/deploy.
- **Lessons:** Central ~/Work/openbrain/lessons via lesson-learned; no local lessons copies.
- **Loop:** Fresh in-session host-subagent run, at most12 passes and4hours from actual runner creation. Two same failure signatures require supported-configuration research before a third attempt. Missing external prerequisites halt dependent acceptance, not a false success.

## 9. Completion

Done means both spike tasks are done, the final gate passed and the evidence review accepted. This completes the feasibility decision only. A paid Store launch remains incomplete until the following order is qualified:

1. Own publishing enrollment and actual provisioned MAS screen/camera/mic/system/area/save/export/quit acceptance.
2. Genuine private cloud login/native Share/resume/playback/tenant/deletion/cost qualification under a reviewed test deployment.
3. StoreKit purchase/restore/server lifecycle and shared Apple/web entitlement, qualifying Apple login and account deletion.
4. Consumer journey, safe original-library migration and supported OS audit; preserve compact and advanced views.
5. TestFlight physical long takes/recovery, product/privacy/support materials and independent user acceptance, then exact submission approval.

Store edition updates use Apple. The prior direct-download signed installer/updater is a separate optional channel, not a substitute or prerequisite for MAS acceptance. The earlier spent Mac/web loop remains closed/incomplete; its tests and failures are not reset.

## 10. Decision log

- D-1: David authorized the market assessment's Store-first sequence on2026-10-25. This new contract starts with feasibility; it does not alter completed native tasks or silently qualify old cloud/release failures.
- D-2: Recipe search returned cold-load-trimmer solely on the word app; its byte-reduction/visual contract is unrelated. Use the test-until-green archetype with objective sandbox and request-layer controls instead.
- D-3: Current machine verified Davids-M5-Max.local, userdave. This is not the retired M3 or migrated Mac Studio; all current files/probes are on the verified M5.
- D-4: No app UI changes planned. Diagnostic bundles may use AppKit only to exercise sandbox boundaries, without redesigning the product or copying Loom assets.

- D-5 (author, same user authority,2026-10-25): The explicit shared-code/CI-public requirement is implemented with a dedicated public-repository-only macOS feasibility workflow, reusing existing pinned actions. It runs the same final command with generated media and no signing secrets; it cannot qualify provisioned MAS or physical capture. Additive T-2 Files coverage includes .github/workflows, already scanned by the declared umbrella clean-room gate. No acceptance or stop bound changed; private Actions remain disabled.

- D-6 (integration follow-up under existing test-everything/public-CI authority,2026-10-25): Public run40261473389 failed BEFOREthe new sandbox probe in an unchanged writer-budget test:254.802041ms vs250ms,419native/Intents cases withoneissue. T1/T2 local diagnostic evidence stays accepted, but public hosted acceptance is open. Add T3 to diagnose the actual source gate without weakening its bounds. Keep original failures and the original four-hour horizon; the purged completed local artifact run is not recreated or reset.
